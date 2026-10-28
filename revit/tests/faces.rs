//! Le maillage des faces enregistrées (`geometry::faces`) : évaluateurs de courbes et de surfaces
//! sur des points connus, lecture des boucles, triangulation des régions planes à trous et des
//! régions courbes à contour quelconque, puis, sur le fichier d'essai commité (Revit 2023, licence
//! MIT, voir tests/fixtures) et sur les fichiers publics quand `revit/samples/` existe
//! (scripts/fetch-revit-samples.mjs) : mêmes triangles qu'avec rvt-rs pour les faces qu'il sait
//! mailler, plus toutes les faces qu'il refuse, sens cohérents, formules fidèles aux points de
//! Revit. Sans les fichiers publics, ces derniers essais passent sans rien faire.
//!
//! À lancer avec `cargo test --release`.

use std::collections::HashMap;
use std::f64::consts::{FRAC_PI_2, PI};
use std::path::PathBuf;

use revit::geometry::faces::check::{self, EdgeFit};
use revit::geometry::faces::curve::Curve;
use revit::geometry::faces::math::{cross, distance, dot, norm, sub};
use revit::geometry::faces::refine::{Grid, refine, refine_on};
use revit::geometry::faces::region::{self, Loop};
use revit::geometry::faces::surface::{HermiteNode, Shape, Surface};
use revit::geometry::faces::{self, Outcome, tess};
use revit::geometry::{classes, saved};
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::{native_graphics_traversal, native_saved_mesh};
use serde_json::{Value, json};

fn crate_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn close(a: [f64; 3], b: [f64; 3], tolerance: f64) -> bool {
    distance(a, b) <= tolerance
}

// ---------------------------------------------------------------------------------------------
// Courbes
// ---------------------------------------------------------------------------------------------

#[test]
fn droite_arc_et_ellipse() {
    let line = Curve::Line { origin: [1.0, 2.0, 3.0], direction: [0.0, 0.0, 1.0], range: [0.0, 5.0] };
    assert!(close(line.eval(2.5), [1.0, 2.0, 5.5], 1e-12));
    assert!(close(line.derivative(2.5), [0.0, 0.0, 1.0], 1e-12));

    let arc = Curve::Arc { center: [1.0, 1.0, 0.0], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 2.0, range: [0.0, PI] };
    assert!(close(arc.eval(0.0), [3.0, 1.0, 0.0], 1e-12));
    assert!(close(arc.eval(FRAC_PI_2), [1.0, 3.0, 0.0], 1e-12));
    assert!(close(arc.derivative(0.0), [0.0, 2.0, 0.0], 1e-12));

    let ellipse = Curve::Ellipse { center: [0.0, 0.0, 1.0], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], x_length: 3.0, y_length: 2.0, range: [0.0, 2.0 * PI] };
    assert!(close(ellipse.eval(0.0), [3.0, 0.0, 1.0], 1e-12));
    assert!(close(ellipse.eval(FRAC_PI_2), [0.0, 2.0, 1.0], 1e-12));
    assert!(close(ellipse.derivative(FRAC_PI_2), [-3.0, 0.0, 0.0], 1e-12));
}

#[test]
fn spline_d_hermite_reproduit_un_polynome_cubique() {
    // P(t) = (t, t², t³) : les tangentes sont les dérivées exactes, la spline coïncide partout.
    let nodes = [0.0, 1.0, 3.0];
    let curve = Curve::Hermite {
        params: nodes.to_vec(),
        points: nodes.iter().map(|t| [*t, t * t, t * t * t]).collect(),
        tangents: nodes.iter().map(|t| [1.0, 2.0 * t, 3.0 * t * t]).collect(),
        range: [0.0, 3.0],
    };
    for t in [0.0, 0.3, 1.0, 1.7, 2.9, 3.0] {
        assert!(close(curve.eval(t), [t, t * t, t * t * t], 1e-12), "point en {t}");
        assert!(close(curve.derivative(t), [1.0, 2.0 * t, 3.0 * t * t], 1e-9), "dérivée en {t}");
    }
}

#[test]
fn nurbs_rationnelle_decrit_un_quart_de_cercle_exact() {
    let w = std::f64::consts::FRAC_1_SQRT_2;
    let curve = Curve::Nurbs { degree: 2, knots: vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0], poles: vec![[1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]], weights: vec![1.0, w, 1.0], range: [0.0, 1.0] };
    for k in 0..=10 {
        let t = f64::from(k) / 10.0;
        let p = curve.eval(t);
        assert!((norm(p) - 1.0).abs() < 1e-12, "le point en {t} n'est pas sur le cercle unité : {p:?}");
    }
    assert!(close(curve.eval(0.0), [1.0, 0.0, 0.0], 1e-12));
    assert!(close(curve.eval(1.0), [0.0, 1.0, 0.0], 1e-12));
    assert!(close(curve.eval(0.5), [w, w, 0.0], 1e-12));
    // Tangente au départ : vers +y, de norme 2 × (distance des deux premiers pôles) × poids.
    let d = curve.derivative(0.5);
    assert!(dot(d, [w, w, 0.0]).abs() < 1e-6, "la dérivée est tangente au cercle");
}

#[test]
fn nurbs_non_rationnelle_de_degre_un_est_une_polyligne() {
    let curve = Curve::Nurbs { degree: 1, knots: vec![0.0, 0.0, 1.0, 2.0, 2.0], poles: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 2.0, 0.0]], weights: vec![1.0; 3], range: [0.0, 2.0] };
    assert!(close(curve.eval(0.5), [0.5, 0.0, 0.0], 1e-12));
    assert!(close(curve.eval(1.5), [1.0, 1.0, 0.0], 1e-12));
    assert!(close(curve.eval(2.0), [1.0, 2.0, 0.0], 1e-12));
}

// ---------------------------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------------------------

fn surface(shape: Shape, origin: [f64; 3], basis: [[f64; 3]; 3], envelope: [[f64; 2]; 2]) -> Surface {
    Surface { shape, origin, x: basis[0], y: basis[1], z: basis[2], envelope, orient: true }
}

const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

#[test]
fn plan_et_cylindre() {
    let plane = surface(Shape::Plane, [1.0, 2.0, 3.0], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    assert!(close(plane.eval(2.0, 3.0), [3.0, 5.0, 3.0], 1e-12));
    assert!(close(plane.normal(0.5, 0.5).unwrap(), [0.0, 0.0, 1.0], 1e-12));

    let cylinder = surface(Shape::Cylinder { radius: 2.0 }, [0.0, 0.0, 1.0], IDENTITY, [[0.0, 0.0], [PI, 4.0]]);
    assert!(close(cylinder.eval(0.0, 1.0), [2.0, 0.0, 2.0], 1e-12));
    assert!(close(cylinder.eval(FRAC_PI_2, 0.0), [0.0, 2.0, 1.0], 1e-12));
    // Repère direct : Su × Sv est la normale extérieure.
    assert!(close(cylinder.normal(0.0, 1.0).unwrap(), [1.0, 0.0, 0.0], 1e-12));
    assert!(close(cylinder.normal(FRAC_PI_2, 1.0).unwrap(), [0.0, 1.0, 0.0], 1e-12));

    // Repère gauche (Z opposé à X × Y) : Su × Sv pointe vers l'axe ; les drapeaux de la face
    // décident ensuite du sens à garder.
    let mirrored = surface(Shape::Cylinder { radius: 2.0 }, [0.0; 3], [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, -1.0]], [[0.0, 0.0], [PI, 4.0]]);
    assert!(close(mirrored.eval(0.0, 1.0), [2.0, 0.0, -1.0], 1e-12));
    assert!(close(mirrored.normal(0.0, 1.0).unwrap(), [-1.0, 0.0, 0.0], 1e-12));
}

#[test]
fn cone_sommet_et_generatrice() {
    // Demi-angle 45° : à la distance v du sommet, le rayon vaut v·sin a et la hauteur v·cos a.
    let a = std::f64::consts::FRAC_PI_4;
    let cone = surface(Shape::Cone { half_angle: a }, [0.0, 0.0, 10.0], IDENTITY, [[0.0, 1.0], [2.0 * PI, 3.0]]);
    let s = 2.0f64.sqrt();
    assert!(close(cone.eval(0.0, s), [1.0, 0.0, 11.0], 1e-12));
    assert!(close(cone.eval(FRAC_PI_2, 2.0 * s), [0.0, 2.0, 12.0], 1e-12));
    // Tout point est à la même distance du sommet que son paramètre v.
    for (u, v) in [(0.3, 1.5), (2.0, 2.5), (5.0, 3.0)] {
        assert!((distance(cone.eval(u, v), [0.0, 0.0, 10.0]) - v).abs() < 1e-12);
    }
    // La normale d'un cône est perpendiculaire à sa génératrice, sans composante tangentielle.
    let n = cone.normal(0.0, s).unwrap();
    assert!(dot(n, cone.partials(0.0, s).1).abs() < 1e-12 && dot(n, cone.partials(0.0, s).0).abs() < 1e-12);
    assert!((norm(n) - 1.0).abs() < 1e-12);
}

#[test]
fn revolution_et_surface_reglee() {
    // Profil : le segment x = 1 + v, z = v (un cône évasé). Révolution d'un quart de tour autour de Z.
    let profile = Curve::Line { origin: [1.0, 0.0, 0.0], direction: [1.0, 0.0, 1.0], range: [0.0, 2.0] };
    let revolution = surface(Shape::Revolution { profile }, [0.0, 0.0, 5.0], IDENTITY, [[0.0, 0.0], [FRAC_PI_2, 2.0]]);
    assert!(close(revolution.eval(0.0, 1.0), [2.0, 0.0, 6.0], 1e-12));
    assert!(close(revolution.eval(FRAC_PI_2, 1.0), [0.0, 2.0, 6.0], 1e-12));
    let (su, sv) = revolution.partials(0.0, 1.0);
    assert!(close(su, [0.0, 2.0, 0.0], 1e-12) && close(sv, [1.0, 0.0, 1.0], 1e-12));

    // Surface réglée entre deux segments parallèles : (1 − v)·C₁(t₁) + v·C₂(t₂), t = début + u·(fin − début).
    let first = Curve::Line { origin: [0.0, 0.0, 0.0], direction: [1.0, 0.0, 0.0], range: [0.0, 4.0] };
    let second = Curve::Line { origin: [0.0, 3.0, 1.0], direction: [1.0, 0.0, 0.0], range: [1.0, 3.0] };
    let ruled = surface(Shape::Ruled { first, second }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    assert!(close(ruled.eval(0.0, 0.0), [0.0, 0.0, 0.0], 1e-12));
    assert!(close(ruled.eval(1.0, 1.0), [3.0, 3.0, 1.0], 1e-12));
    assert!(close(ruled.eval(0.5, 0.5), [(2.0 + 2.0) / 2.0, 1.5, 0.5], 1e-12));
    // Une surface réglée en éventail vers un point : tout converge vers lui quand v = 1.
    let fan = surface(Shape::Ruled { first: Curve::Line { origin: [0.0; 3], direction: [1.0, 0.0, 0.0], range: [0.0, 2.0] }, second: Curve::Point([1.0, 1.0, 1.0]) }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    assert!(close(fan.eval(0.3, 1.0), [1.0, 1.0, 1.0], 1e-12));
    assert!(close(fan.eval(1.0, 0.0), [2.0, 0.0, 0.0], 1e-12));
}

/// Le pire écart, en pieds, entre les triangles d'une face réglée et sa surface : le centre de chaque triangle
/// contre le point de la surface au même (u, v), mesuré sur la normale de la surface.
fn worst_sag(surface: &Surface, mesh: &tess::FaceGeometry) -> f64 {
    let mut worst = 0.0f64;
    for t in &mesh.triangles {
        let uv = |k: usize| mesh.uv[t[k] as usize];
        let (u, v) = ((uv(0)[0] + uv(1)[0] + uv(2)[0]) / 3.0, (uv(0)[1] + uv(1)[1] + uv(2)[1]) / 3.0);
        let p = |k: usize| mesh.vertices[t[k] as usize];
        let center = [(p(0)[0] + p(1)[0] + p(2)[0]) / 3.0, (p(0)[1] + p(1)[1] + p(2)[1]) / 3.0, (p(0)[2] + p(1)[2] + p(2)[2]) / 3.0];
        let normal = surface.normal(u, v).expect("normale");
        worst = worst.max(dot(sub(center, surface.eval(u, v)), normal).abs());
    }
    worst
}

fn rectangle() -> Vec<Loop> {
    vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]]
}

/// Une surface réglée entre deux droites coplanaires est un plan : deux triangles, quelle que soit sa taille (rvt-rs
/// en mettait une maille par pied de son plus long profil : 33 000 triangles pour une dalle de 40 mètres).
#[test]
fn une_surface_reglee_plane_n_a_pas_de_maille_interieure() {
    // Un trapèze de 130 pieds sur 60, dont les deux côtés parallèles n'ont pas la même longueur.
    let first = Curve::Line { origin: [0.0, 0.0, 0.0], direction: [1.0, 0.0, 0.0], range: [0.0, 130.0] };
    let second = Curve::Line { origin: [40.0, 60.0, 0.0], direction: [1.0, 0.0, 0.0], range: [0.0, 20.0] };
    let ruled = surface(Shape::Ruled { first, second }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mesh = tess::mesh(&ruled, &rectangle(), true).expect("maillage");
    assert_eq!(mesh.triangles.len(), 2, "triangles d'une surface plane");
    assert!(worst_sag(&ruled, &mesh) < 1e-9);
}

/// Entre deux droites gauches (un paraboloïde hyperbolique), la flèche des triangles reste sous `CHORD_ERROR`, avec bien
/// moins de mailles qu'une par pied.
#[test]
fn une_surface_reglee_gauche_est_a_la_fleche_voulue() {
    // Deux droites de 100 pieds, à 100 pieds l'une de l'autre, dont l'une est tournée de 3° : un gauchissement de 5 pieds.
    let angle = 0.05f64;
    let first = Curve::Line { origin: [0.0, 0.0, 0.0], direction: [1.0, 0.0, 0.0], range: [0.0, 100.0] };
    let second = Curve::Line { origin: [0.0, 100.0, 0.0], direction: [angle.cos(), 0.0, angle.sin()], range: [0.0, 100.0] };
    let ruled = surface(Shape::Ruled { first, second }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mesh = tess::mesh(&ruled, &rectangle(), true).expect("maillage");
    let sag = worst_sag(&ruled, &mesh);
    assert!(sag <= tess::CHORD_ERROR * 1.01, "flèche {sag} pied");
    // 5 pieds de gauchissement : environ sqrt(5 / (4 · 0,001)) = 35 mailles par axe, soit moins de 5 000 triangles ; une
    // maille par pied (rvt-rs, 100 sur 100) en met 20 000.
    assert!(mesh.triangles.len() > 100 && mesh.triangles.len() < 8_000, "triangles : {}", mesh.triangles.len());
    // Une surface deux fois plus gauche demande plus de triangles : la grille suit la flèche.
    let angle = 0.1f64;
    let twisted = surface(
        Shape::Ruled {
            first: Curve::Line { origin: [0.0, 0.0, 0.0], direction: [1.0, 0.0, 0.0], range: [0.0, 100.0] },
            second: Curve::Line { origin: [0.0, 100.0, 0.0], direction: [angle.cos(), 0.0, angle.sin()], range: [0.0, 100.0] },
        },
        [0.0; 3],
        IDENTITY,
        [[0.0, 0.0], [1.0, 1.0]],
    );
    let more = tess::mesh(&twisted, &rectangle(), true).expect("maillage");
    assert!(more.triangles.len() > mesh.triangles.len());
    assert!(worst_sag(&twisted, &more) <= tess::CHORD_ERROR * 1.01);
}

/// Un contour rectangulaire dont les côtés u portent `n` points (Revit enregistre les arcs par points).
fn rectangle_with_points(n: usize) -> Vec<Loop> {
    let mut ring = Vec::new();
    for k in 0..n {
        ring.push([k as f64 / n as f64, 0.0]);
    }
    ring.push([1.0, 0.0]);
    ring.push([1.0, 1.0]);
    for k in (1..n).rev() {
        ring.push([k as f64 / n as f64, 1.0]);
    }
    ring.push([0.0, 1.0]);
    vec![ring]
}

/// Entre deux arcs, la flèche des profils décide du nombre de mailles dans le sens des profils, et les génératrices
/// restent droites dans l'autre.
#[test]
fn une_surface_reglee_entre_deux_arcs_suit_la_fleche_des_profils() {
    let arc = |z: f64| Curve::Arc { center: [0.0, 0.0, z], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 5.0, range: [0.0, PI] };
    let tube = surface(Shape::Ruled { first: arc(0.0), second: arc(20.0) }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    // Les points du contour : un tous les 45° (de quoi Revit enregistre un arc), insuffisants pour la flèche voulue.
    let mesh = tess::mesh(&tube, &rectangle_with_points(4), true).expect("maillage");
    // Un demi-cylindre de rayon 5 pieds : 0,001 pied de flèche donne un pas d'environ 0,063 rad, soit une cinquantaine de
    // mailles sur le demi-tour, deux dans le sens des génératrices.
    assert!(mesh.triangles.len() >= 100 && mesh.triangles.len() <= 1000, "triangles : {}", mesh.triangles.len());
    // La ligne de points du milieu suit la flèche des profils (la grille), non les points du contour.
    let mut abscissas: Vec<f64> = mesh.uv.iter().filter(|uv| uv[1] > 0.0 && uv[1] < 1.0).map(|uv| uv[0]).collect();
    abscissas.sort_by(f64::total_cmp);
    abscissas.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
    assert!(abscissas.len() >= 40, "points intérieurs : {}", abscissas.len());
    // Et chaque arc de la grille est à moins de la flèche voulue de la surface.
    let step = abscissas.windows(2).map(|pair| pair[1] - pair[0]).fold(0.0, f64::max);
    let sagitta = 5.0 * (1.0 - (PI * step / 2.0).cos());
    assert!(sagitta <= tess::CHORD_ERROR * 1.01, "flèche d'une maille : {sagitta}");
}

#[test]
fn la_normale_au_sommet_d_un_cone_se_prend_a_cote() {
    let cone = surface(Shape::Cone { half_angle: 0.3 }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 2.0]]);
    // Au sommet (v = 0), Su s'annule : la normale vient d'un point voisin et reste unitaire.
    let n = cone.normal(1.0, 0.0).expect("normale au sommet");
    assert!((norm(n) - 1.0).abs() < 1e-9);
}

/// Un polynôme bicubique à coefficients vectoriels, `S(u, v) = Σ c[a][b] uᵃ vᵇ` : une surface d'Hermite construite sur ses
/// valeurs et ses dérivées aux nœuds le reproduit exactement partout (le carreau d'Hermite est bicubique).
const BICUBIC: [[[f64; 3]; 4]; 4] = [
    [[1.0, -2.0, 0.5], [3.0, 0.5, -1.0], [-1.5, 2.0, 0.25], [0.4, -0.3, 0.7]],
    [[2.0, 1.0, -3.0], [-0.5, 1.5, 2.5], [1.0, -1.0, 0.5], [-0.2, 0.6, -0.4]],
    [[-1.0, 0.5, 1.5], [0.7, -2.0, 1.0], [2.0, 0.3, -0.6], [0.1, 0.2, 0.3]],
    [[0.3, -0.4, 0.2], [1.1, 0.9, -0.8], [-0.6, 0.4, 1.2], [0.5, -0.7, 0.9]],
];

/// La dérivée d'ordre `order` de `x^exponent`.
fn power(x: f64, exponent: i32, order: u32) -> f64 {
    if exponent < order as i32 {
        return 0.0;
    }
    let factor: f64 = (0..order as i32).map(|k| f64::from(exponent - k)).product();
    factor * x.powi(exponent - order as i32)
}

/// `∂^(du + dv) S / ∂uᵈᵘ ∂vᵈᵛ` du polynôme `BICUBIC` en (u, v).
fn bicubic(u: f64, v: f64, du: u32, dv: u32) -> [f64; 3] {
    let mut out = [0.0; 3];
    for a in 0..4 {
        for b in 0..4 {
            let weight = power(u, a as i32, du) * power(v, b as i32, dv);
            for k in 0..3 {
                out[k] += BICUBIC[a][b][k] * weight;
            }
        }
    }
    out
}

/// Les nœuds d'une grille d'Hermite sur `us` × `vs` pour `value(u, v, du, dv)` : le nœud (i, j) est à l'indice
/// `j · nu + i`, comme dans `m_NodeArray`.
fn hermite_nodes(us: &[f64], vs: &[f64], value: &dyn Fn(f64, f64, u32, u32) -> [f64; 3]) -> Vec<HermiteNode> {
    let mut nodes = Vec::new();
    for &v in vs {
        for &u in us {
            nodes.push(HermiteNode { point: value(u, v, 0, 0), du: value(u, v, 1, 0), dv: value(u, v, 0, 1), duv: value(u, v, 1, 1) });
        }
    }
    nodes
}

/// Une surface d'Hermite construite sur un polynôme bicubique le reproduit exactement (points et dérivées), sur une grille
/// de mailles inégales ; le nœud (i, j) est à l'indice `j · nu + i`.
#[test]
fn une_surface_d_hermite_reproduit_un_polynome_bicubique() {
    let (us, vs) = (vec![0.0, 0.3, 1.0], vec![0.0, 0.25, 0.7, 1.0]);
    let nodes = hermite_nodes(&us, &vs, &bicubic);
    let hermite = surface(Shape::Hermite { us: us.clone(), vs: vs.clone(), nodes }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    // Aux nœuds : la valeur enregistrée.
    for (j, &v) in vs.iter().enumerate() {
        for (i, &u) in us.iter().enumerate() {
            assert!(close(hermite.eval(u, v), bicubic(u, v, 0, 0), 1e-12), "nœud ({i}, {j})");
        }
    }
    // Partout ailleurs : le polynôme et ses dérivées partielles.
    for iu in 0..=20 {
        for iv in 0..=20 {
            let (u, v) = (f64::from(iu) / 20.0, f64::from(iv) / 20.0);
            assert!(close(hermite.eval(u, v), bicubic(u, v, 0, 0), 1e-11), "point ({u}, {v})");
            let (su, sv) = hermite.partials(u, v);
            assert!(close(su, bicubic(u, v, 1, 0), 1e-10), "∂u en ({u}, {v})");
            assert!(close(sv, bicubic(u, v, 0, 1), 1e-10), "∂v en ({u}, {v})");
        }
    }
}

/// Une face d'Hermite se maille à la flèche voulue (`HERMITE_CHORD_ERROR`), avec bien moins de mailles qu'une par pied ni
/// qu'à la flèche de `CHORD_ERROR`, sur tout son contour, et ses normales suivent le sens de ses triangles.
#[test]
fn une_surface_d_hermite_est_maillee_a_la_fleche_voulue() {
    // Une nappe de 40 pieds sur 40, bombée de quelques pieds : x = 40 u, y = 40 v, z = 2 × (composante z du bicubique).
    let sheet = |u: f64, v: f64, du: u32, dv: u32| -> [f64; 3] {
        let z = 2.0 * bicubic(u, v, du, dv)[2];
        match (du, dv) {
            (0, 0) => [40.0 * u, 40.0 * v, z],
            (1, 0) => [40.0, 0.0, z],
            (0, 1) => [0.0, 40.0, z],
            _ => [0.0, 0.0, z],
        }
    };
    let (us, vs) = (vec![0.0, 0.5, 1.0], vec![0.0, 0.5, 1.0]);
    let nodes = hermite_nodes(&us, &vs, &sheet);
    let hermite = surface(Shape::Hermite { us, vs, nodes }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    // Les côtés du contour portent leurs points (Revit enregistre ses arêtes par points) : sans eux, les triangles de bord
    // relient les quatre coins par des cordes qui s'écartent de la surface de plusieurs pieds.
    let side = 64;
    let ring: Loop = (0..side)
        .map(|k| [k as f64 / side as f64, 0.0])
        .chain((0..side).map(|k| [1.0, k as f64 / side as f64]))
        .chain((0..side).map(|k| [1.0 - k as f64 / side as f64, 1.0]))
        .chain((0..side).map(|k| [0.0, 1.0 - k as f64 / side as f64]))
        .collect();
    let mesh = tess::mesh(&hermite, &[ring], true).expect("maillage");
    let sag = worst_sag(&hermite, &mesh);
    assert!(sag <= tess::HERMITE_CHORD_ERROR * 1.5, "flèche {sag} pied");
    // 1 600 mailles à une par pied (3 200 triangles), des dizaines de milliers à la flèche de CHORD_ERROR : quelques
    // centaines à quelques milliers ici.
    assert!(mesh.triangles.len() > 50 && mesh.triangles.len() < 3_000, "triangles : {}", mesh.triangles.len());
    // Le contour est celui du carré unité : l'aire (u, v) maillée est 1.
    let uv_area: f64 = mesh
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|k| mesh.uv[k as usize]);
            ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
        })
        .sum();
    assert!((uv_area - 1.0).abs() < 1e-9, "aire (u, v) : {uv_area}");
    for t in &mesh.triangles {
        let [a, b, c] = t.map(|k| mesh.vertices[k as usize]);
        let geometric = cross(sub(b, a), sub(c, a));
        for &corner in t {
            assert!(dot(geometric, mesh.normals[corner as usize]) > 0.0, "triangle contraire à sa normale");
        }
    }
}

/// Une grille d'Hermite de plus de 128 nœuds sur un axe (plus que le plafond de mailles par axe) se maille sans paniquer.
#[test]
fn une_surface_d_hermite_a_plus_de_128_noeuds_par_axe_se_maille() {
    let flat = |u: f64, v: f64, du: u32, dv: u32| -> [f64; 3] {
        match (du, dv) {
            (0, 0) => [40.0 * u, 40.0 * v, 0.0],
            (1, 0) => [40.0, 0.0, 0.0],
            (0, 1) => [0.0, 40.0, 0.0],
            _ => [0.0; 3],
        }
    };
    let us: Vec<f64> = (0..200).map(|k| f64::from(k) / 199.0).collect();
    let vs = vec![0.0, 1.0];
    let nodes = hermite_nodes(&us, &vs, &flat);
    let hermite = surface(Shape::Hermite { us, vs, nodes }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mesh = tess::mesh(&hermite, &rectangle(), true).expect("maillage");
    assert!(mesh.triangles.len() >= 2);
    assert!(worst_sag(&hermite, &mesh) < 1e-9, "une nappe plane");
}

// ---------------------------------------------------------------------------------------------
// Régions
// ---------------------------------------------------------------------------------------------

fn area_uv(mesh: &region::Mesh2) -> f64 {
    mesh.triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|i| mesh.points[i as usize]);
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0
        })
        .sum()
}

fn square(x0: f64, y0: f64, side: f64) -> Loop {
    vec![[x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side]]
}

#[test]
fn region_plane_a_trou() {
    let loops = vec![square(0.0, 0.0, 10.0), square(4.0, 4.0, 2.0)];
    let mesh = region::triangulate(&loops, [1.0, 1.0], None).unwrap();
    // 100 − 4, sans un triangle de trop dans le trou, tous antihoraires.
    assert!((area_uv(&mesh) - 96.0).abs() < 1e-9, "aire {}", area_uv(&mesh));
    assert!(mesh.triangles.iter().all(|t| {
        let [a, b, c] = t.map(|i| mesh.points[i as usize]);
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0.0
    }));
    // Tous les sommets des contours sont des sommets du maillage : rien n'est perdu sur les bords.
    for ring in &loops {
        for corner in ring {
            assert!(mesh.points.iter().any(|p| p == corner), "sommet {corner:?} perdu");
        }
    }
}

#[test]
fn region_concave_avec_sommets_alignes_sur_les_bords() {
    // Un L dont le grand côté porte des sommets intermédiaires alignés : ils restent des sommets,
    // et aucun triangle plat ne les relie.
    let ring: Loop = vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0], [3.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0], [0.0, 2.0], [0.0, 1.0]];
    let mesh = region::triangulate(&[ring.clone()], [1.0, 1.0], None).unwrap();
    assert!((area_uv(&mesh) - 5.0).abs() < 1e-9, "aire {}", area_uv(&mesh));
    for corner in &ring {
        assert!(mesh.points.iter().any(|p| p == corner), "sommet {corner:?} perdu");
    }
}

#[test]
fn region_courbe_a_contour_non_rectangulaire() {
    // Un demi-cylindre de rayon 2, coupé en haut par un plan oblique : v ≤ 1 + 0,5·sin u (le contour de
    // droite, le tube « biseauté »). Aire exacte de la paroi : R·∫(1 + 0,5·sin u)du sur [0, π] = R·(π + 1).
    let radius = 2.0;
    let steps = 48;
    let top: Vec<[f64; 2]> = (0..=steps).map(|k| { let u = PI * f64::from(k) / f64::from(steps); [u, 1.0 + 0.5 * u.sin()] }).collect();
    // Comme Revit, les bords courbes sont échantillonnés : ici tous les 3,75°.
    let mut ring: Loop = (0..=steps).map(|k| [PI * f64::from(k) / f64::from(steps), 0.0]).collect();
    ring.extend(top.iter().rev().copied());
    let ring = region::clean_loop(&ring, 1e-9);
    let cylinder = surface(Shape::Cylinder { radius }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 1.5]]);
    let geometry = tess::mesh(&cylinder, &[ring], true).unwrap();

    let exact = radius * (PI + 1.0);
    let area: f64 = geometry.triangles.iter().map(|t| { let [a, b, c] = t.map(|i| geometry.vertices[i as usize]); norm(cross(sub(b, a), sub(c, a))) / 2.0 }).sum();
    assert!((area - exact).abs() / exact < 0.005, "aire {area} pour {exact}");
    // Chaque sommet est sur le cylindre, chaque normale est radiale et unitaire, sortante.
    for (vertex, normal) in geometry.vertices.iter().zip(&geometry.normals) {
        assert!((vertex[0].hypot(vertex[1]) - radius).abs() < 1e-9);
        assert!((norm(*normal) - 1.0).abs() < 1e-9 && dot(*normal, [vertex[0], vertex[1], 0.0]) > 0.0);
    }
    // Les triangles tournent dans le sens de leurs normales (vers l'extérieur).
    for t in &geometry.triangles {
        let [a, b, c] = t.map(|i| geometry.vertices[i as usize]);
        let n = cross(sub(b, a), sub(c, a));
        let centre = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, 0.0];
        assert!(dot(n, centre) > 0.0, "triangle retourné");
    }
    // Aucun triangle ne traverse l'intérieur du tube : le centre de chacun est à moins de 1,5 mm de la paroi.
    for t in &geometry.triangles {
        let [a, b, c] = t.map(|i| geometry.vertices[i as usize]);
        let centre = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, 0.0];
        assert!(radius - centre[0].hypot(centre[1]) < 0.0015, "un triangle coupe le tube : {}", radius - centre[0].hypot(centre[1]));
    }
}

#[test]
fn region_courbe_avec_un_trou_circulaire() {
    // Une moitié de cylindre de rayon 3 (u de 0 à π, v de 0 à 4) percée d'un trou circulaire.
    let hole: Loop = (0..24).map(|k| { let t = 2.0 * PI * f64::from(k) / 24.0; [1.5 + 0.4 * t.cos(), 2.0 + 0.9 * t.sin()] }).collect();
    let cylinder = surface(Shape::Cylinder { radius: 3.0 }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 4.0]]);
    let outer: Loop = vec![[0.0, 0.0], [PI, 0.0], [PI, 4.0], [0.0, 4.0]];
    let geometry = tess::mesh(&cylinder, &[outer, hole.clone()], true).unwrap();
    // Aucun triangle dans le trou : le centre de chaque triangle est hors de l'ellipse.
    let mut inside_hole = 0;
    for t in &geometry.triangles {
        let c = [0, 1].map(|k| t.iter().map(|&i| geometry.uv[i as usize][k]).sum::<f64>() / 3.0);
        if region::inside(c, &[hole.clone()]) {
            inside_hole += 1;
        }
    }
    assert_eq!(inside_hole, 0);
    // Les sommets du trou sont des sommets du maillage.
    for p in &hole {
        assert!(geometry.uv.iter().any(|q| distance([q[0], q[1], 0.0], [p[0], p[1], 0.0]) < 1e-12));
    }
}

// ---------------------------------------------------------------------------------------------
// Boucles, sur un graphe d'objets fabriqué à la main
// ---------------------------------------------------------------------------------------------

/// Constructeur d'un petit graphe : une face plane, ses boucles et leurs arêtes, avec les
/// pointeurs que rvt-rs résout (jeton, décalage, arête du graphe).
struct Builder {
    objects: Vec<Value>,
    edges: Vec<Value>,
    offset: usize,
}

impl Builder {
    fn new() -> Self {
        Builder { objects: Vec::new(), edges: Vec::new(), offset: 100 }
    }

    fn add(&mut self, class: &str, class_tag: u16, fields: Value) -> usize {
        self.objects.push(json!({ "class_tag": class_tag, "class_name": class, "token": self.objects.len() + 1, "start": 0, "fields_end": 0, "fields": fields }));
        self.objects.len() - 1
    }

    /// Un pointeur de l'objet `source` vers `target` (`None` : pointeur nul), avec l'arête du graphe.
    fn pointer(&mut self, source: usize, target: Option<usize>) -> Value {
        let Some(target) = target else { return json!({ "class_tag": null, "offset": 1, "pointer_token": 0 }) };
        self.offset += 4;
        let (class_tag, token) = (self.objects[target]["class_tag"].clone(), self.objects[target]["token"].clone());
        self.edges.push(json!({ "source_object_index": source, "pointer_offset": self.offset, "pointer_token": token, "target_object_index": target, "target_class_tag": class_tag }));
        json!({ "class_tag": class_tag, "offset": self.offset, "pointer_token": token })
    }

    fn set(&mut self, object: usize, name: &str, value: Value) {
        self.objects[object]["fields"][name] = value;
    }

    /// Une face plane (plan unité) dont les boucles sont données par leurs polylignes de côtés :
    /// chaque boucle est une liste d'arêtes, chaque arête une liste de points (u, v) du côté de la face.
    fn plane_face(&mut self, loops: &[Vec<Vec<[f64; 2]>>]) -> (usize, Vec<usize>) {
        let plane = self.add("Plane", 584, json!({ "m_Envelope": { "m_corners": [[0.0, 0.0], [100.0, 100.0]] }, "m_orientFlag": true, "m_origin": [0.0, 0.0, 0.0], "m_xVec": [1.0, 0.0, 0.0], "m_yVec": [0.0, 1.0, 0.0] }));
        let face = self.add("Face", 1, json!({ "m_GInfo": { "m_tag": 7 }, "m_faceFlags_v9": 4, "m_faceRegions": [], "m_renderStyleId": { "m_id": { "m_id64": -1 } } }));
        let surface_pointer = self.pointer(face, Some(plane));
        self.set(face, "m_pSurf", surface_pointer);
        let mut loop_ids = Vec::new();
        for edges in loops {
            let loop_id = self.add("EdgeLoop", 1350, json!({ "m_open": false }));
            loop_ids.push(loop_id);
            let ids: Vec<usize> = edges.iter().map(|_| self.add("Edge", 1339, json!({}))).collect();
            let pface = self.pointer(loop_id, Some(face));
            self.set(loop_id, "m_pFace", pface);
            let first = self.pointer(loop_id, Some(ids[0]));
            self.set(loop_id, "m_next", first);
            for (k, (&id, points)) in ids.iter().zip(edges).enumerate() {
                let next = if k + 1 < ids.len() { ids[k + 1] } else { loop_id };
                let (n0, n1) = (self.pointer(id, Some(next)), self.pointer(id, None));
                let (f0, f1) = (self.pointer(id, Some(face)), self.pointer(id, None));
                // Côté 0 : la face ; côté 1 : sans voisine (sa polyligne n'est pas lue).
                self.set(id, "m_next", json!([n0, n1]));
                self.set(id, "m_pFace", json!([f0, f1]));
                let (first, last) = (points[0], *points.last().unwrap());
                let interior: Vec<Value> = points[1..points.len() - 1].iter().map(|p| json!({ "uv": [p, p] })).collect();
                self.set(id, "m_firstAndLastEdgePnts", json!([{ "uv": [first, first] }, { "uv": [last, last] }]));
                self.set(id, "m_interiorEdgePnts", Value::Array(interior));
            }
        }
        for (k, &loop_id) in loop_ids.iter().enumerate() {
            let next = loop_ids.get(k + 1).copied();
            let p = self.pointer(loop_id, next);
            self.set(loop_id, "m_nextLoop", p);
        }
        let first_loop = self.pointer(face, loop_ids.first().copied());
        self.set(face, "m_pFirstLoop", first_loop);
        (face, loop_ids)
    }

    fn graph(self) -> ObjectGraph {
        serde_json::from_value(json!({ "consumed_bytes": 0, "objects": self.objects, "edges": self.edges })).expect("graphe d'essai")
    }
}

impl Builder {
    /// Un cylindre entier (u de 0 à 2π, v de 0 à `height`) : un cercle en bas, un cercle en haut et une
    /// couture dont les deux côtés sont la même face (u = 2π d'un côté, u = 0 de l'autre).
    fn full_cylinder_face(&mut self, radius: f64, height: f64, steps: usize) -> usize {
        let tau = 2.0 * PI;
        let surface = self.add(
            "CylSurf",
            1068,
            json!({ "m_Envelope": { "m_corners": [[0.0, 0.0], [tau, height]] }, "m_orientFlag": true, "m_center": [0.0, 0.0, 0.0], "m_radius": radius, "m_xVec": [1.0, 0.0, 0.0], "m_yVec": [0.0, 1.0, 0.0], "m_zVec": [0.0, 0.0, 1.0] }),
        );
        let face = self.add("Face", 1, json!({ "m_GInfo": { "m_tag": 9 }, "m_faceFlags_v9": 4, "m_faceRegions": [], "m_renderStyleId": { "m_id": { "m_id64": -1 } } }));
        let pointer = self.pointer(face, Some(surface));
        self.set(face, "m_pSurf", pointer);
        let loop_id = self.add("EdgeLoop", 1350, json!({ "m_open": false }));
        let pface = self.pointer(loop_id, Some(face));
        self.set(loop_id, "m_pFace", pface);
        let first_loop = self.pointer(face, Some(loop_id));
        self.set(face, "m_pFirstLoop", first_loop);
        let none = self.pointer(loop_id, None);
        self.set(loop_id, "m_nextLoop", none);

        // Bas, couture, haut, et la couture de nouveau (de l'autre côté).
        let circle = |v: f64| -> Vec<[f64; 2]> { (0..=steps).map(|k| [tau * k as f64 / steps as f64, v]).collect() };
        let ids: Vec<usize> = (0..3).map(|_| self.add("Edge", 1339, json!({}))).collect();
        let (bottom, seam, top) = (ids[0], ids[1], ids[2]);
        let first = self.pointer(loop_id, Some(bottom));
        self.set(loop_id, "m_next", first);
        let uv = |points: &[[f64; 2]]| {
            let interior: Vec<Value> = points[1..points.len() - 1].iter().map(|p| json!({ "uv": [p, p] })).collect();
            (json!([{ "uv": [points[0], points[0]] }, { "uv": [points[points.len() - 1], points[points.len() - 1]] }]), Value::Array(interior))
        };
        // Les arêtes du bas et du haut : un côté seulement (la face), l'autre sans voisine.
        for (id, v) in [(bottom, 0.0), (top, height)] {
            let (ends, interior) = uv(&circle(v));
            let (n0, n1) = (self.pointer(id, Some(seam)), self.pointer(id, None));
            let (f0, f1) = (self.pointer(id, Some(face)), self.pointer(id, None));
            self.set(id, "m_next", json!([n0, n1]));
            self.set(id, "m_pFace", json!([f0, f1]));
            self.set(id, "m_firstAndLastEdgePnts", ends);
            self.set(id, "m_interiorEdgePnts", interior);
        }
        // La couture : côté 0 = (2π, 0 → h), côté 1 = (0, 0 → h), toutes deux de cette même face. La
        // boucle y passe deux fois : bas → couture (côté 0) → haut → couture (côté 1) → retour à la boucle.
        let (to_top, to_loop) = (self.pointer(seam, Some(top)), self.pointer(seam, Some(loop_id)));
        let (f0, f1) = (self.pointer(seam, Some(face)), self.pointer(seam, Some(face)));
        self.set(seam, "m_next", json!([to_top, to_loop]));
        self.set(seam, "m_pFace", json!([f0, f1]));
        self.set(seam, "m_firstAndLastEdgePnts", json!([{ "uv": [[tau, 0.0], [0.0, 0.0]] }, { "uv": [[tau, height], [0.0, height]] }]));
        self.set(seam, "m_interiorEdgePnts", json!([]));
        face
    }
}

fn edge(points: &[[f64; 2]]) -> Vec<[f64; 2]> {
    points.to_vec()
}

#[test]
fn lecture_d_une_face_plane_a_trou() {
    // Contour : carré de 10 en quatre arêtes (dont une avec un point intermédiaire), trou de 2 en deux
    // arêtes dessinées en sens inverse l'une de l'autre.
    let outer = vec![edge(&[[0.0, 0.0], [5.0, 0.0], [10.0, 0.0]]), edge(&[[10.0, 0.0], [10.0, 10.0]]), edge(&[[0.0, 10.0], [10.0, 10.0]]), edge(&[[0.0, 0.0], [0.0, 10.0]])];
    let hole = vec![edge(&[[4.0, 4.0], [6.0, 4.0], [6.0, 6.0]]), edge(&[[4.0, 4.0], [4.0, 6.0], [6.0, 6.0]])];
    let mut builder = Builder::new();
    let (face, _) = builder.plane_face(&[outer, hole]);
    let graph = builder.graph();

    let rings = revit::geometry::faces::loops::read(&graph, face, &Surface::read(&graph, 0).unwrap()).unwrap().expect("la face a des boucles");
    assert_eq!(rings.len(), 2);
    assert_eq!(rings[0].len(), 5, "carré + point intermédiaire : {:?}", rings[0]);
    assert!((region::signed_area(&rings[0]).abs() - 100.0).abs() < 1e-9);
    assert!((region::signed_area(&rings[1]).abs() - 4.0).abs() < 1e-9);

    match faces::mesh_face(&graph, face) {
        Outcome::Own(mesh) | Outcome::Rvt(mesh) => {
            let area: f64 = mesh.triangles.iter().map(|t| { let [a, b, c] = t.map(|i| mesh.vertices[i as usize]); norm(cross(sub(b, a), sub(c, a))) / 2.0 }).sum();
            assert!((area - 96.0).abs() < 1e-9, "aire {area}");
            assert!(mesh.normals.iter().all(|n| close(*n, [0.0, 0.0, 1.0], 1e-12)));
            assert_eq!(mesh.face_tag, 7);
        }
        other => panic!("face non maillée : {other:?}"),
    }
}

#[test]
fn un_cylindre_entier_avec_sa_couture() {
    let (radius, height) = (1.5, 4.0);
    let mut builder = Builder::new();
    let face = builder.full_cylinder_face(radius, height, 72);
    let graph = builder.graph();
    let surface = Surface::read(&graph, 0).unwrap();
    let rings = revit::geometry::faces::loops::read(&graph, face, &surface).unwrap().expect("la face a une boucle");
    assert_eq!(rings.len(), 1);
    // Le contour fait le tour du rectangle (u, v) en entier : 2π sur `height`.
    assert!((region::signed_area(&rings[0]).abs() - 2.0 * PI * height).abs() < 1e-6, "aire du contour {}", region::signed_area(&rings[0]));

    let Outcome::Own(mesh) = faces::mesh_face(&graph, face) else { panic!("face non maillée") };
    let area: f64 = mesh.triangles.iter().map(|t| { let [a, b, c] = t.map(|i| mesh.vertices[i as usize]); norm(cross(sub(b, a), sub(c, a))) / 2.0 }).sum();
    let exact = 2.0 * PI * radius * height;
    assert!((area - exact).abs() / exact < 0.01, "aire {area} pour {exact}");
    // Normales radiales sortantes, et triangles dans leur sens.
    for (vertex, normal) in mesh.vertices.iter().zip(&mesh.normals) {
        assert!((vertex[0].hypot(vertex[1]) - radius).abs() < 1e-9);
        assert!(dot(*normal, [vertex[0], vertex[1], 0.0]) > 0.99 * radius);
    }
    for t in &mesh.triangles {
        let [a, b, c] = t.map(|i| mesh.vertices[i as usize]);
        let centre = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, 0.0];
        assert!(dot(cross(sub(b, a), sub(c, a)), centre) > 0.0, "triangle retourné");
    }
}

#[test]
fn un_plan_sans_boucle_est_une_face_de_reference() {
    let mut builder = Builder::new();
    let (face, _) = builder.plane_face(&[]);
    let graph = builder.graph();
    assert!(tess::is_unbounded_plane(&graph, face));
    if faces::MESH_REFERENCE_FACES {
        // Un rectangle sur le pavé du plan (100 × 100).
        let Outcome::Own(mesh) = faces::mesh_face(&graph, face) else { panic!("face non maillée") };
        assert_eq!(mesh.triangles.len(), 2);
    } else {
        assert!(matches!(faces::mesh_face(&graph, face), Outcome::Reference));
    }
}

#[test]
fn les_extremites_d_arete_decalees_de_quelques_dixiemes_de_millimetre_se_raccordent() {
    // Un carré dont l'arête du haut démarre 1e-4 pied trop haut : au-delà de la tolérance stricte, en deçà de la large.
    let ring = vec![edge(&[[0.0, 0.0], [10.0, 0.0]]), edge(&[[10.0, 0.0], [10.0, 10.0]]), edge(&[[10.0, 10.0001], [0.0, 10.0]]), edge(&[[0.0, 10.0], [0.0, 0.0]])];
    let mut builder = Builder::new();
    let (face, _) = builder.plane_face(&[ring]);
    let graph = builder.graph();
    let rings = revit::geometry::faces::loops::read(&graph, face, &Surface::read(&graph, 0).unwrap()).unwrap().unwrap();
    assert_eq!(rings[0].len(), 4, "contour fermé malgré le décalage : {:?}", rings[0]);
    assert!((region::signed_area(&rings[0]).abs() - 100.0).abs() < 1e-2);
}

// ---------------------------------------------------------------------------------------------
// Affinage des arêtes partagées, pôles
// ---------------------------------------------------------------------------------------------

#[test]
fn un_cercle_entre_cylindre_et_plan_est_affine_des_deux_cotes() {
    // Cylindre de rayon 2 contre le plan z = 0 : le cercle u ∈ [0, π] à v = 0, enregistré tous les 90°
    // (la corde de 90° rentre de 0,59 pied dans le cylindre). Du côté du plan, le même cercle est
    // (2 cos u, 2 sin u).
    let cylinder = surface(Shape::Cylinder { radius: 2.0 }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 1.0]]);
    let plane = surface(Shape::Plane, [0.0; 3], IDENTITY, [[-3.0, -3.0], [3.0, 3.0]]);
    let on_cylinder = [[0.0, 0.0], [FRAC_PI_2, 0.0], [PI, 0.0]];
    let on_plane: Vec<[f64; 2]> = on_cylinder.iter().map(|p| [2.0 * p[0].cos(), 2.0 * p[0].sin()]).collect();

    let refined = refine([(&cylinder, &on_cylinder), (&plane, &on_plane)]).expect("le cercle est affiné");
    assert_eq!(refined[0].len(), refined[1].len());
    assert!(refined[0].len() > 20, "{} points", refined[0].len());
    // Les points enregistrés restent, et à chaque rang les deux faces ont le même point de l'espace.
    assert_eq!(refined[0][0], on_cylinder[0]);
    assert_eq!(*refined[0].last().unwrap(), on_cylinder[2]);
    for (a, b) in refined[0].iter().zip(&refined[1]) {
        assert!(distance(cylinder.eval(a[0], a[1]), plane.eval(b[0], b[1])) < 1e-9, "points différents : {a:?} {b:?}");
    }
    // La corde la plus longue qui reste est assez fine : flèche de `CHORD_ERROR` au plus (un millimètre), à l'arrondi près.
    for pair in refined[0].windows(2) {
        let (p, q) = (cylinder.eval(pair[0][0], pair[0][1]), cylinder.eval(pair[1][0], pair[1][1]));
        let middle = cylinder.eval((pair[0][0] + pair[1][0]) / 2.0, 0.0);
        let sag = distance(middle, [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, (p[2] + q[2]) / 2.0]);
        assert!(sag <= tess::CHORD_ERROR * 1.01, "flèche {sag} pied");
    }
}

#[test]
fn une_arete_deja_fine_ou_droite_n_est_pas_touchee() {
    let a = surface(Shape::Plane, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let b = surface(Shape::Plane, [0.0, 0.0, 0.0], [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], [[0.0, 0.0], [1.0, 1.0]]);
    // Deux plans : l'arête est droite, il n'y a rien à affiner.
    assert!(refine([(&a, &[[0.0, 0.0], [1.0, 0.0]]), (&b, &[[0.0, 0.0], [1.0, 0.0]])]).is_none());
    // Un cercle déjà échantillonné tous les 2° : rien non plus.
    let cylinder = surface(Shape::Cylinder { radius: 2.0 }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 1.0]]);
    let plane = surface(Shape::Plane, [0.0; 3], IDENTITY, [[-3.0, -3.0], [3.0, 3.0]]);
    let fine: Vec<[f64; 2]> = (0..=90).map(|k| [PI * f64::from(k) / 90.0, 0.0]).collect();
    let in_plane: Vec<[f64; 2]> = fine.iter().map(|p| [2.0 * p[0].cos(), 2.0 * p[0].sin()]).collect();
    assert!(refine([(&cylinder, &fine), (&plane, &in_plane)]).is_none());
}

#[test]
fn une_ellipse_n_est_pas_affinee_par_une_droite_du_plan_u_v() {
    // Un cylindre coupé par un plan oblique : l'arête n'est pas une droite du plan (u, v) du cylindre ;
    // un point au milieu du segment (u, v) n'est pas sur le plan, l'arête garde ses points enregistrés.
    let cylinder = surface(Shape::Cylinder { radius: 2.0 }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 4.0]]);
    let slanted = Surface { shape: Shape::Plane, origin: [0.0, 0.0, 2.0], x: [1.0, 0.0, 0.5], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0], envelope: [[-3.0, -3.0], [3.0, 3.0]], orient: true };
    // Points de l'ellipse v = 2 + 0,5·2·cos u, à 90°.
    let on_cylinder: Vec<[f64; 2]> = [0.0, FRAC_PI_2, PI].iter().map(|u: &f64| [*u, 2.0 + u.cos()]).collect();
    let on_plane: Vec<[f64; 2]> = on_cylinder.iter().map(|p| [2.0 * p[0].cos(), 2.0 * p[0].sin()]).collect();
    assert!(refine([(&cylinder, &on_cylinder), (&slanted, &on_plane)]).is_none());
}

#[test]
fn le_u_d_un_pole_est_celui_de_la_generatrice_qui_y_arrive() {
    use revit::geometry::faces::loops::pin_poles;
    // Un éventail : tous les (u, v = 0) sont le sommet ; Revit écrit u = 0 à l'extrémité d'une
    // génératrice qui en réalité est à u = 1.
    let fan = surface(Shape::Ruled { first: Curve::Point([0.0, 0.0, 1.0]), second: Curve::Arc { center: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 1.0, range: [0.0, FRAC_PI_2] } }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mut generatrix = [[0.0, 0.0], [1.0, 1.0]];
    pin_poles(&fan, &mut generatrix);
    assert_eq!(generatrix, [[1.0, 0.0], [1.0, 1.0]]);
    // L'autre extrémité aussi, et une arête hors du pôle ne bouge pas.
    let mut reversed = [[1.0, 1.0], [0.0, 0.0]];
    pin_poles(&fan, &mut reversed);
    assert_eq!(reversed, [[1.0, 1.0], [1.0, 0.0]]);
    let mut arc = [[0.0, 1.0], [0.5, 1.0], [1.0, 1.0]];
    pin_poles(&fan, &mut arc);
    assert_eq!(arc, [[0.0, 1.0], [0.5, 1.0], [1.0, 1.0]]);
}

#[test]
fn un_eventail_se_maille_en_entier() {
    // Le contour de l'éventail du test précédent, tel que le raccordement le rend : l'arc du haut,
    // la génératrice de gauche, le côté sans longueur du sommet, la génératrice de droite.
    let first = Curve::Point([0.0, 0.0, 1.0]);
    let second = Curve::Arc { center: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 1.0, range: [0.0, FRAC_PI_2] };
    let fan = surface(Shape::Ruled { first, second }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mut ring: Loop = (0..=16).map(|k| [1.0 - f64::from(k) / 16.0, 1.0]).collect();
    ring.extend([[0.0, 0.0], [1.0, 0.0]]);
    let geometry = tess::mesh(&fan, &[ring], true).unwrap();
    // Aire exacte du secteur conique : (1/4 du cône de rayon 1 et de génératrice √2) = π·1·√2/4.
    let exact = PI * 2.0f64.sqrt() / 4.0;
    let area: f64 = geometry.triangles.iter().map(|t| { let [a, b, c] = t.map(|i| geometry.vertices[i as usize]); norm(cross(sub(b, a), sub(c, a))) / 2.0 }).sum();
    assert!((area - exact).abs() / exact < 0.02, "aire {area} pour {exact}");
}

// ---------------------------------------------------------------------------------------------
// Sur de vrais fichiers
// ---------------------------------------------------------------------------------------------

fn sample(name: &str) -> Option<PathBuf> {
    let path = crate_path(&format!("samples/{name}"));
    path.exists().then_some(path)
}

fn open(path: &PathBuf) -> rvt::RevitFile {
    rvt::RevitFile::open_bytes(std::fs::read(path).expect("fichier d'essai illisible")).expect("fichier Revit")
}

/// Une clé qui identifie une primitive à ses sommets, normales et triangles exacts.
fn key(primitive: &native_saved_mesh::Primitive) -> (usize, i64, i64, Vec<u64>, Vec<[u32; 3]>) {
    let bits: Vec<u64> = primitive.vertices.iter().chain(&primitive.normals).flatten().map(|v| v.to_bits()).collect();
    (primitive.object_index, primitive.face_tag, primitive.render_style_id, bits, primitive.triangles.clone())
}

struct Run {
    /// Faces maillées par rvt-rs : ses primitives retrouvées à l'identique dans celles du module.
    rvt_primitives: usize,
    identical: usize,
    /// Ses primitives qui n'ont pas de jumelle exacte, classées par leur face.
    replaced: Replaced,
    ours: usize,
    failures: Vec<(String, String)>,
    elements: usize,
    orientation: [check::Orientation; 2],
    fits: std::collections::BTreeMap<String, EdgeFit>,
}

/// Les primitives de rvt-rs que ce module remplace par les siennes ou maille à sa flèche, classées par la face d'origine
/// (voir `faces::mesh_face`) : surfaces réglées et plans qui les touchent (maillés par ce module), cylindres (maillés par
/// rvt-rs à `tess::CHORD_ERROR` au lieu de son profil par défaut de 0,001 pied), plans voisins d'un cylindre (maillés par ce
/// module, sur la grille du cylindre : les deux faces d'une arête partagée y posent les mêmes sommets) ; `other` : ce qui
/// différerait sans raison connue, et doit rester à zéro. Les plans voisins d'un cône ou d'une surface d'Hermite (maillés par
/// ce module aussi) n'y figurent pas : rvt-rs perd tout le nœud `Geometry` d'une face qu'il refuse, ces plans compris.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Replaced {
    ruled: usize,
    by_ruled: usize,
    cylinder: usize,
    by_cylinder: usize,
    other: usize,
}

impl Replaced {
    fn total(self) -> usize {
        self.ruled + self.by_ruled + self.cylinder + self.by_cylinder + self.other
    }

    fn add(&mut self, other: Replaced) {
        self.ruled += other.ruled;
        self.by_ruled += other.by_ruled;
        self.cylinder += other.cylinder;
        self.by_cylinder += other.by_cylinder;
        self.other += other.other;
    }

    /// Note une primitive de rvt-rs sans jumelle exacte : retrouve sa face dans son nœud `Geometry` (`object_index`, dans
    /// le graphe du symbole placé s'il y en a un, `graph`) par son `m_GInfo.m_tag`, puis la classe par sa surface et ses
    /// voisines.
    fn note(&mut self, graph: &ObjectGraph, primitive: &native_saved_mesh::Primitive) {
        let node = primitive.object_index;
        let Some(object) = graph.objects.get(node) else {
            self.other += 1;
            return;
        };
        let face = object.fields["m_pFaces"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| faces::graph::target(graph, node, value).ok().flatten())
            .find(|face| graph.objects[*face].fields["m_GInfo"]["m_tag"].as_i64() == Some(primitive.face_tag));
        let Some(face) = face else {
            self.other += 1;
            return;
        };
        let class = faces::surface_class(graph, face);
        let next_to = |surface: &str| faces::loops::has_neighbour_surface(graph, face, surface);
        if class == "RuledSurf" {
            self.ruled += 1;
        } else if class == "Plane" && next_to("RuledSurf") {
            self.by_ruled += 1;
        } else if class == "CylSurf" {
            self.cylinder += 1;
        } else if next_to("CylSurf") {
            self.by_cylinder += 1;
        } else {
            self.other += 1;
        }
    }
}

/// Compare, pour chaque élément dessiné d'un fichier, les primitives de rvt-rs et celles du module.
fn compare(path: &PathBuf) -> Run {
    compare_except(path, &[])
}

/// [`compare`] sans les éléments `except` : ceux dont rvt-rs lit autrement une liaison de normales (voir
/// `PER_VERTEX_TOPOGRAPHIES`).
fn compare_except(path: &PathBuf, except: &[u64]) -> Run {
    let mut file = open(path);
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
    let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
        let new = faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
        let old = native_saved_mesh::graphics_with_resolver_at_detail(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
        let mut available: HashMap<_, usize> = HashMap::new();
        for (primitive, own) in new.primitives.iter().zip(&new.ours) {
            if !own {
                *available.entry(key(primitive)).or_default() += 1;
            }
        }
        let mut identical = 0;
        let mut replaced = Replaced::default();
        for primitive in &old.primitives {
            if let Some(count) = available.get_mut(&key(primitive)).filter(|count| **count > 0) {
                *count -= 1;
                identical += 1;
            } else {
                // Une primitive d'un symbole placé vit dans le graphe de ce symbole.
                let placed = primitive.source_owner_id.and_then(|owner| scene.symbol(owner));
                replaced.note(placed.unwrap_or(graph), primitive);
            }
        }
        let mut fits = std::collections::BTreeMap::new();
        check::edge_fit(graph, &mut fits);
        let orientation = check::orientation(&new.primitives, &new.ours);
        (old.primitives.len(), identical, replaced, new.ours.iter().filter(|own| **own).count(), new.failures, orientation, fits)
    };
    let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
    let mut run = Run { rvt_primitives: 0, identical: 0, replaced: Replaced::default(), ours: 0, failures: Vec::new(), elements: 0, orientation: Default::default(), fits: Default::default() };
    for graph in scan.scene.symbols.values() {
        check::edge_fit(graph, &mut run.fits);
    }
    for (id, result) in scan.results {
        let Some((old, identical, replaced, ours, failures, orientation, fits)) = result else { continue };
        if except.contains(&id) {
            continue;
        }
        let facts = scan.scene.facts(&scan.scene.infos[&id]);
        if classes::excluded_relation(&facts).is_some() {
            continue;
        }
        run.elements += 1;
        run.rvt_primitives += old;
        run.identical += identical;
        run.replaced.add(replaced);
        run.ours += ours;
        run.failures.extend(failures);
        for k in 0..2 {
            run.orientation[k].opposed += orientation[k].opposed;
            run.orientation[k].same += orientation[k].same;
        }
        for (name, fit) in fits {
            let entry = run.fits.entry(name).or_default();
            entry.samples += fit.samples;
            entry.worst = entry.worst.max(fit.worst);
        }
    }
    run
}

#[test]
fn le_fichier_d_essai_garde_les_triangles_de_rvt_rs() {
    let run = compare(&crate_path("tests/fixtures/Revit_IFC5_Einhoven.rvt"));
    assert!(run.elements > 0 && run.rvt_primitives > 0);
    assert_eq!(run.identical, run.rvt_primitives, "primitives de rvt-rs absentes ou modifiées");
    // rvt-rs maille déjà toutes ses faces : le module n'en ajoute aucune.
    assert_eq!(run.ours, 0);
    assert!(run.failures.is_empty(), "faces non maillées : {:?}", run.failures);
    assert_eq!(run.orientation[0].same, 0, "faces retournées");
}

/// Les éléments dont le GPolyMesh a autant de normales que de points et de facettes (indicateur 0) : rvt-rs lit
/// ces normales par facette, nous par sommet.
const PER_VERTEX_TOPOGRAPHIES: &[u64] = &[21971];

/// Les primitives des fichiers publics que rvt-rs maille et que ce module remplace ou maille à sa flèche (`Replaced`) :
/// dans RE1-Architecture, 6 surfaces réglées et les 12 plans qui les touchent (rvt-rs reporte sur ces plans la grille
/// des surfaces réglées voisines) ; et, depuis la flèche de 0,003 pied (`tess::CHORD_ERROR`, contre 0,001 pour le profil
/// par défaut de rvt-rs), les cylindres : 126 dans RE1 (1 382 primitives de rvt-rs, 1 256 identiques), 71 dans
/// DynamoSample_2024 ; et les plans voisins d'un cylindre (142 dans RE1, 74 dans DynamoSample_2024), que ce module maille
/// sur la grille du cylindre au lieu de celle du profil par défaut de rvt-rs (voir `faces::mesh_face`). Refinery et Core
/// Interior n'ont ni l'un ni l'autre : à l'identique.
const REPLACED: [(&str, Replaced); 4] = [
    ("RefineryPrimer-2024-BuildingGenerator.rvt", Replaced { ruled: 0, by_ruled: 0, cylinder: 0, by_cylinder: 0, other: 0 }),
    ("RE1-Architecture.rvt", Replaced { ruled: 6, by_ruled: 12, cylinder: 126, by_cylinder: 142, other: 0 }),
    ("DynamoSample_2024.rvt", Replaced { ruled: 0, by_ruled: 0, cylinder: 71, by_cylinder: 74, other: 0 }),
    ("2024_Core_Interior.rvt", Replaced { ruled: 0, by_ruled: 0, cylinder: 0, by_cylinder: 0, other: 0 }),
];

/// Les fichiers publics où rvt-rs maille déjà tout ou presque : mêmes primitives, à l'identique.
#[test]
fn les_fichiers_publics_gardent_les_triangles_de_rvt_rs() {
    for (name, expected) in REPLACED {
        let Some(path) = sample(name) else { continue };
        // Les topographies de Core Interior dont le maillage a 10 normales pour 10 points et 10 facettes : rvt-rs
        // les lit par facette (il ne connaît que ce cas), ce lecteur par sommet, comme l'indicateur 0 de tous les
        // autres terrains (voir `la_topographie_a_une_normale_par_sommet`). Sur ces maillages plats (toutes les
        // normales vers le haut) les deux lectures donnent les mêmes triangles et les mêmes normales après
        // soudure ; seules les primitives brutes diffèrent (10 sommets au lieu de 30).
        let run = compare_except(&path, if name.starts_with("2024_Core") { PER_VERTEX_TOPOGRAPHIES } else { &[] });
        // Dans un nœud `Geometry` dont une face échoue, rvt-rs perd toutes les faces : le module en rend
        // donc plus, jamais moins. Une primitive de rvt-rs que le module aurait modifiée ou perdue
        // manquerait ici.
        // Seules exceptions : les surfaces réglées et les plans qui les touchent, que ce module maille lui-même, et les
        // cylindres, maillés à sa flèche, avec les faces qui leur sont voisines (voir `faces::mesh_face`) : chacune est
        // retrouvée et classée par sa face, rien d'autre ne diffère.
        assert_eq!(run.replaced, expected, "{name} : primitives de rvt-rs remplacées");
        assert_eq!(run.identical + run.replaced.total(), run.rvt_primitives, "{name} : primitives de rvt-rs modifiées ou perdues");
        // Refinery et Core Interior n'ont aucune face que rvt-rs refuse : mêmes primitives, rien d'ajouté.
        if name.starts_with("Refinery") || name.starts_with("2024_Core") {
            assert_eq!(run.ours, 0, "{name} : faces ajoutées par le module");
        }
        assert!(run.failures.is_empty(), "{name} : faces non maillées : {:?}", run.failures);
        // Le fond du terrain 21974 de Core Interior (une nappe à normales vers le haut, que Revit écrit ainsi sous
        // une jupe tournée vers l'extérieur) partage 2 arêtes avec elle dans le même sens : une incohérence des
        // octets du fichier, que le lecteur ne corrige pas (il suit les normales de Revit).
        let allowed = if name.starts_with("2024_Core") { 2 } else { 0 };
        assert!(run.orientation[0].same <= allowed, "{name} : triangles voisins dans le même sens : {}", run.orientation[0].same);
    }
}

/// Toutes les faces des fichiers qui en avaient que rvt-rs ne sait pas mailler se maillent, avec des
/// formules qui retombent sur les points d'arêtes de Revit.
#[test]
fn les_faces_que_rvt_rs_refuse_se_maillent_et_collent_aux_points_de_revit() {
    let mut touched = 0;
    for name in ["RE1-Electrical.rvt", "RE1-Architecture.rvt", "DynamoSample_2024.rvt"] {
        let Some(path) = sample(name) else { continue };
        let run = compare(&path);
        assert!(run.failures.is_empty(), "{name} : faces non maillées : {:?}", run.failures);
        assert!(run.ours > 0, "{name} : le module n'a maillé aucune face");
        touched += run.ours;
        assert_eq!(run.orientation[1].same, 0, "{name} : faces du module retournées par rapport à leurs voisines");
        assert!(run.orientation[1].opposed > 0);
        // Chaque couple de surfaces voisines : les deux évaluations d'un point d'arête de Revit se
        // confondent à 0,3 mm près (le pire écart observé est de 9e-5 pied, du fait de Revit).
        for (pair, fit) in &run.fits {
            assert!(fit.samples == 0 || fit.worst < 0.001, "{name} : {pair} : écart {:.2e} pied sur {} points", fit.worst, fit.samples);
        }
    }
    if touched > 0 {
        eprintln!("faces du module : {touched} primitives");
    }
}

/// Les « plans sans contour » ne rendent pas une forme partielle : chaque élément qui en porte est
/// déjà une coque fermée sans eux (voir la doc du module).
#[test]
fn les_plans_sans_contour_sont_des_faces_de_reference() {
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let mut file = open(&path);
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none() && info.class == "SWall";
    let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
        let selection = native_graphics_traversal::select_graphics_with_resolver_at_detail(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
        let meshes = faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
        (selection.selected.len(), meshes.reference_faces, meshes.unbounded_faces)
    };
    let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
    let (mut references, mut missing) = (0, 0);
    for result in scan.results.values().flatten() {
        references += result.1;
        missing += result.2;
    }
    assert!(references > 100, "Core Interior a des centaines de plans sans contour sur ses murs : {references}");
    assert_eq!(missing, 0);
}

// ---------------------------------------------------------------------------------------------
// Graphiques fabriqués à la main : normales des GPolyMesh, miroir d'une instance, boucles sans fin
// ---------------------------------------------------------------------------------------------

/// Un `GElement` d'identifiant 5, sans enfant encore : à ajouter en premier pour être la racine (objet 0)
/// du graphe, puis à relier avec [`link_children`].
fn element_node(builder: &mut Builder) -> usize {
    builder.add("GElement", 11, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": 5 }, "m_elementId": 5, "m_flags": 0, "m_gElemType": 3, "m_subNodes": [] }))
}

/// Donne ses enfants à un nœud (`m_subNodes`).
fn link_children(builder: &mut Builder, node: usize, children: &[usize]) {
    let pointers: Vec<Value> = children.iter().map(|&child| builder.pointer(node, Some(child))).collect();
    builder.set(node, "m_subNodes", Value::Array(pointers));
}

/// Un `GPolyMesh` et sa topologie (`class`, `FacetedTopology0` ou `FacetedTopology8`).
fn poly_mesh_node(builder: &mut Builder, class: &str, points: &[[f64; 3]], normals: &[[f64; 3]], facets: &[Vec<u32>], flag: u64) -> usize {
    let topology = builder.add(class, 3000, json!({ "m_commonNormal": [0.0, 0.0, 0.0], "m_facetsArr": facets, "m_normalsArr": normals, "m_normalsFlag": flag, "m_pointsArr": points }));
    let mesh = builder.add("GPolyMesh", 3001, json!({ "m_GInfo": { "m_flags": 581636, "m_tag": 0 }, "m_interiorGStyleID": { "m_id": { "m_id64": 534 } }, "m_materialID": { "m_id": { "m_id64": -1 } }, "m_polyMeshFlags": 0 }));
    let pointer = builder.pointer(mesh, Some(topology));
    builder.set(mesh, "m_pFacetedTopology", pointer);
    mesh
}

/// Les primitives et diagnostics d'un graphe fabriqué, par `faces::graphics`.
fn graphics_of(builder: Builder) -> faces::Meshes {
    let graph = builder.graph();
    faces::graphics(&graph, &|_| None, 3)
}

/// Un tétraèdre entier de côté 1 : quatre points, quatre facettes tournées vers l'extérieur.
fn tetrahedron() -> ([[f64; 3]; 4], Vec<Vec<u32>>) {
    ([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], vec![vec![0, 2, 1], vec![0, 1, 3], vec![0, 3, 2], vec![1, 2, 3]])
}

/// Normale unitaire de chaque facette, sortante pour un tétraèdre ci-dessus.
fn facet_normals(points: &[[f64; 3]], facets: &[Vec<u32>]) -> Vec<[f64; 3]> {
    facets
        .iter()
        .map(|f| {
            let [a, b, c] = [f[0], f[1], f[2]].map(|i| points[i as usize]);
            let n = cross(sub(b, a), sub(c, a));
            let length = norm(n);
            [n[0] / length, n[1] / length, n[2] / length]
        })
        .collect()
}

#[test]
fn un_poly_mesh_a_normales_par_sommet_garde_ses_sommets_et_ses_normales() {
    // Indicateur 0, autant de normales que de points (4) et pas que de facettes (4 : le cas ambigu est jugé
    // par l'indicateur) : ici 5 points et 4 facettes lèvent le doute, comme les terrains des fichiers d'essai.
    let (mut points, facets) = {
        let (points, facets) = tetrahedron();
        (points.to_vec(), facets)
    };
    points.push([5.0, 5.0, 5.0]);
    let normals: Vec<[f64; 3]> = points.iter().enumerate().map(|(i, _)| [0.0, 0.0, 1.0 + i as f64]).collect();
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 0);
    link_children(&mut builder, root, &[mesh]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    assert_eq!(meshes.primitives.len(), 1);
    let primitive = &meshes.primitives[0];
    // Les sommets ne sont pas dupliqués par facette : 5 points, 5 normales (normalisées), 4 triangles.
    assert_eq!(primitive.vertices.len(), 5);
    assert_eq!(primitive.triangles.len(), 4);
    for normal in &primitive.normals {
        assert!(close(*normal, [0.0, 0.0, 1.0], 1e-12), "{normal:?}");
    }
    assert_eq!(primitive.triangles, vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
}

#[test]
fn un_poly_mesh_a_normales_par_facette_prend_un_sommet_par_coin() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    for class in ["FacetedTopology0", "FacetedTopology8"] {
        let mut builder = Builder::new();
        let root = element_node(&mut builder);
        // L'indicateur 2 : la i-ème normale est celle de la facette i (FacetedTopology8, celle des figurines RPC,
        // porte en plus l'indicateur de visibilité des arêtes, ignoré).
        let mesh = poly_mesh_node(&mut builder, class, &points, &normals, &facets, 2);
        link_children(&mut builder, root, &[mesh]);
        let meshes = graphics_of(builder);
        assert!(meshes.diagnostics.is_empty(), "{class} : {:?}", meshes.diagnostics);
        let primitive = &meshes.primitives[0];
        assert_eq!((primitive.vertices.len(), primitive.triangles.len()), (12, 4), "{class}");
        for (i, triangle) in primitive.triangles.iter().enumerate() {
            for &corner in triangle {
                assert!(close(primitive.normals[corner as usize], normals[i], 1e-12), "{class} : normale de la facette {i}");
            }
        }
    }
}

#[test]
fn un_poly_mesh_sans_normale_prend_celle_de_chaque_triangle() {
    let (points, facets) = tetrahedron();
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &[], &facets, 0);
    link_children(&mut builder, root, &[mesh]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    let primitive = &meshes.primitives[0];
    let expected = facet_normals(&points, &facets);
    for (i, triangle) in primitive.triangles.iter().enumerate() {
        for &corner in triangle {
            assert!(close(primitive.normals[corner as usize], expected[i], 1e-12));
        }
    }
}

/// Un nombre de normales que l'indicateur contredit, une topologie ou une facette inconnues : un
/// diagnostic, jamais une normale devinée ni un élément « lu en entier ».
#[test]
fn un_poly_mesh_incoherent_est_un_diagnostic() {
    let (points, facets) = tetrahedron();
    let three: Vec<[f64; 3]> = vec![[0.0, 0.0, 1.0]; 3];
    let four_per_facet = facet_normals(&points, &facets);
    for (class, normals, flag, expected) in [
        ("FacetedTopology0", three.clone(), 0u64, "liaison des normales"),
        ("FacetedTopology0", four_per_facet.clone(), 1u64, "liaison des normales"),
        ("FacetedTopology0", three.clone(), 2u64, "liaison des normales"),
        ("FacetedTopology3", four_per_facet.clone(), 2u64, "topologie de facettes non prise en charge"),
    ] {
        let mut builder = Builder::new();
        let root = element_node(&mut builder);
        let mesh = poly_mesh_node(&mut builder, class, &points, &normals, &facets, flag);
        link_children(&mut builder, root, &[mesh]);
        let meshes = graphics_of(builder);
        assert!(meshes.primitives.is_empty(), "{class} {flag}");
        assert!(meshes.diagnostics.iter().any(|message| message.contains(expected)), "{class} {flag} : {:?}", meshes.diagnostics);
    }
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &[], &[vec![0, 1, 2, 3]], 0);
    link_children(&mut builder, root, &[mesh]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.iter().any(|message| message.contains("pas un triangle")), "{:?}", meshes.diagnostics);
}

/// Les nœuds que rvt-rs refusait et que les octets des fichiers d'essai montrent sans surface : commande de
/// retournement (aucun enfant), imposteur (actif nul), composant imbriqué (dessiné par son élément).
#[test]
fn les_commandes_les_imposteurs_et_les_composants_ne_sont_pas_des_diagnostics() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let flip = builder.add("GBiFlipControl", 3100, json!({ "m_GInfo": { "m_flags": 557124, "m_tag": 2147483647 }, "m_base": [1.0, 0.0, 0.0], "m_length": 16.0, "m_origin": [0.0, 0.0, 0.0] }));
    let imposter = builder.add("GImposter", 3101, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 }, "m_oAsset": { "class_tag": 413, "offset": 9, "pointer_token": 4294967295u64 }, "m_trf": { "m_3x3": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], "m_or": [0.0, 0.0, 0.0] } }));
    let info = builder.add("InstanceInfo", 3102, json!({ "m_GRepId": 0, "m_cda": { "m_pDoc": { "class_tag": null, "offset": 1, "pointer_token": 1 } }, "m_symbolId": { "m_id": { "m_id64": 777 } }, "m_Trf": { "m_3x3": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], "m_or": [0.0, 0.0, 0.0] } }));
    let component = builder.add("GComponentRef", 3103, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 } }));
    let info_pointer = builder.pointer(component, Some(info));
    builder.set(component, "m_instanceInfo", info_pointer);
    link_children(&mut builder, root, &[mesh, flip, imposter, component]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    assert_eq!(meshes.primitives.len(), 1);
    assert_eq!(meshes.components, vec![777]);

    // Un imposteur dont l'actif est lu en ligne : on ne sait pas ce qu'il contient, c'est un diagnostic.
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let inline = builder.add("GImposter", 3101, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 }, "m_oAsset": { "class_tag": 413, "offset": 9, "pointer_token": 12 } }));
    link_children(&mut builder, root, &[inline]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.iter().any(|message| message.contains("imposteur")), "{:?}", meshes.diagnostics);
}

/// Le graphique d'un symbole de famille d'identifiant 777 : une racine `GElement` (indicateur 2, celui d'un symbole) dont
/// les enfants sont donnés par `children`.
fn symbol_graph(children: &dyn Fn(&mut Builder) -> Vec<usize>) -> ObjectGraph {
    let mut builder = Builder::new();
    let root = builder.add("GElement", 11, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": 777 }, "m_elementId": 777, "m_flags": 2, "m_gElemType": 3, "m_subNodes": [] }));
    let kids = children(&mut builder);
    link_children(&mut builder, root, &kids);
    builder.graph()
}

/// Un symbole fait d'un tétraèdre (4 triangles).
fn tetrahedron_symbol() -> ObjectGraph {
    symbol_graph(&|builder| {
        let (points, facets) = tetrahedron();
        let normals = facet_normals(&points, &facets);
        vec![poly_mesh_node(builder, "FacetedTopology0", &points, &normals, &facets, 2)]
    })
}

/// Un symbole fait d'une seule ligne : rien à dessiner.
fn line_symbol() -> ObjectGraph {
    symbol_graph(&|builder| vec![builder.add("GLine", 1503, json!({ "m_GInfo": { "m_flags": 17334276, "m_tag": -1 }, "m_dirVec": [1.0, 0.0, 0.0], "m_endParams": [0.0, 1.0], "m_origin": [0.0, 0.0, 0.0] }))])
}

/// Un élément dont le graphique est une seule instance (celle des chaises et des coussins : `GElement` → `GInstance`) du
/// symbole 777, avec ces cibles interdites et cet indicateur `m_resolveSymInView` ; `visibility_flags` est `GInfo.m_flags`
/// du nœud. Rend ce que le parcours en tire.
fn place_symbol(symbol: &ObjectGraph, targets: u64, resolve_in_view: bool, visibility_flags: u64) -> faces::Meshes {
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let instance = builder.add(
        "GInstance",
        3200,
        json!({ "m_GInfo": { "m_flags": visibility_flags, "m_tag": 0 }, "m_bHasScale": false, "m_resolveSymInView": resolve_in_view, "m_forbiddenTarget": { "m_targets": targets }, "m_oEmbeddedSymbolGRep": { "class_tag": null, "offset": 1, "pointer_token": 0 } }),
    );
    let info = builder.add(
        "InstanceInfo",
        3102,
        json!({ "m_GRepId": 0, "m_cda": { "m_pDoc": { "class_tag": null, "offset": 1, "pointer_token": 1 } }, "m_symbolId": { "m_id": { "m_id64": 777 } }, "m_Trf": { "m_3x3": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], "m_or": [5.0, 0.0, 0.0] } }),
    );
    let info_pointer = builder.pointer(instance, Some(info));
    builder.set(instance, "m_instanceInfo", info_pointer);
    link_children(&mut builder, root, &[instance]);
    let graph = builder.graph();
    faces::graphics(&graph, &|owner| (owner == 777).then_some(symbol), 3)
}

/// `GInfo.m_flags` d'un nœud visible (visibilité 0) et d'un nœud que seul le mode de dessin spécial montre (visibilité 1).
const VISIBLE: u64 = 557060;
const SPECIAL_MODE_ONLY: u64 = 557060 | 0x20;

/// Les instances à cibles interdites de `10` (les bits 1 et 3) sont des formes visibles : les 880 coussins ETFE de
/// Vignette-04 et les 120 chaises de `rac_advanced` et `mega_advanced`, dont l'élément n'est que cette instance. Un masque qui
/// n'interdit que des cibles de `0b1010` n'interdit pas la vue 3D non plus.
#[test]
fn un_masque_de_cibles_interdites_de_0b1010_ne_retire_rien_a_la_vue_3d() {
    let symbol = tetrahedron_symbol();
    for targets in [0, 2, 8, 10] {
        let meshes = place_symbol(&symbol, targets, false, VISIBLE);
        assert!(meshes.diagnostics.is_empty(), "cibles {targets} : {:?}", meshes.diagnostics);
        assert_eq!(meshes.primitives.len(), 1, "cibles {targets}");
        assert_eq!(meshes.primitives[0].triangles.len(), 4);
        assert_eq!(meshes.primitives[0].source_owner_id, Some(777));
        // L'instance a placé le symbole : décalé de 5 pieds en x.
        assert!(meshes.primitives[0].vertices.iter().all(|v| v[0] >= 5.0 - 1e-12 && v[0] <= 6.0 + 1e-12));
    }
}

/// Les masques qui interdisent presque toutes les cibles (`0xCFFE`, `0x8FFE` : instances de garde-corps de visibilité 1) ne se
/// dessinent pas sur une simple supposition : visibles, avec des surfaces, ils restent un diagnostic ; sans surface, rien à
/// perdre ; et le drapeau de visibilité du nœud les écarte d'abord.
#[test]
fn un_masque_qui_interdit_d_autres_cibles_reste_un_diagnostic() {
    for targets in [0xCFFE, 0x8FFE, 0b1011, 0x10] {
        let with_surfaces = place_symbol(&tetrahedron_symbol(), targets, false, VISIBLE);
        assert!(with_surfaces.primitives.is_empty(), "cibles {targets:#x}");
        assert!(with_surfaces.diagnostics.iter().any(|message| message.contains("cibles interdites")), "cibles {targets:#x} : {:?}", with_surfaces.diagnostics);
        let lines_only = place_symbol(&line_symbol(), targets, false, VISIBLE);
        assert!(lines_only.primitives.is_empty() && lines_only.diagnostics.is_empty(), "cibles {targets:#x} : {:?}", lines_only.diagnostics);
        let hidden = place_symbol(&tetrahedron_symbol(), targets, false, SPECIAL_MODE_ONLY);
        assert!(hidden.primitives.is_empty() && hidden.diagnostics.is_empty(), "cibles {targets:#x} : {:?}", hidden.diagnostics);
    }
}

/// Un symbole « résolu dans la vue » dont le graphique n'a aucune condition n'a rien à résoudre : les 8 murs « Parapet Wall »
/// de `rac_advanced` et de `mega_advanced` placent ainsi leur balayage de mur, qui est un élément à part entière : il se dessine par
/// lui-même (comme un composant imbriqué), le mur ne le redessine pas. Avec une condition, le résultat pourrait dépendre de la vue :
/// un diagnostic, comme avant.
#[test]
fn un_symbole_resolu_dans_la_vue_sans_condition_est_un_composant() {
    let plain = place_symbol(&tetrahedron_symbol(), 0, true, VISIBLE);
    assert!(plain.diagnostics.is_empty(), "{:?}", plain.diagnostics);
    assert!(plain.primitives.is_empty(), "le symbole se dessine par son propre élément");
    assert_eq!(plain.components, vec![777]);

    // Un filtre sans condition laisse tout passer : aucune dépendance à la vue.
    let unconditional = symbol_graph(&|builder| {
        let (points, facets) = tetrahedron();
        let mesh = poly_mesh_node(builder, "FacetedTopology0", &points, &facet_normals(&points, &facets), &facets, 2);
        let filter = builder.add("GFilter", 3300, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 }, "m_bIsNestedDetailFamily": false, "m_oConditions": [], "m_subNodes": [] }));
        link_children(builder, filter, &[mesh]);
        vec![filter]
    });
    let meshes = place_symbol(&unconditional, 0, true, VISIBLE);
    assert!(meshes.diagnostics.is_empty() && meshes.primitives.is_empty() && meshes.components == vec![777], "{:?}", meshes.diagnostics);

    // Un filtre à condition (le niveau de détail) : dépend de la vue.
    let conditional = symbol_graph(&|builder| {
        let (points, facets) = tetrahedron();
        let mesh = poly_mesh_node(builder, "FacetedTopology0", &points, &facet_normals(&points, &facets), &facets, 2);
        let condition = builder.add("GConditionInt", 3301, json!({ "m_comp": -1, "m_param": 3, "m_value": 3 }));
        let filter = builder.add("GFilter", 3300, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 }, "m_bIsNestedDetailFamily": false, "m_oConditions": [], "m_subNodes": [] }));
        let pointer = builder.pointer(filter, Some(condition));
        builder.set(filter, "m_oConditions", json!([pointer]));
        link_children(builder, filter, &[mesh]);
        vec![filter]
    });
    let resolved = place_symbol(&conditional, 0, true, VISIBLE);
    assert!(resolved.primitives.is_empty() && resolved.components.is_empty());
    assert!(resolved.diagnostics.iter().any(|message| message.contains("dépend de la vue")), "{:?}", resolved.diagnostics);
    // Sans l'indicateur, la condition s'évalue comme toujours (niveau de détail 3 : vraie) et la forme se dessine.
    let ordinary = place_symbol(&conditional, 0, false, VISIBLE);
    assert!(ordinary.diagnostics.is_empty() && ordinary.primitives.len() == 1, "{:?}", ordinary.diagnostics);
}

/// Un `GGTag` (groupe étiqueté : poignées de sommets d'une toiture de face, flèches de retournement) se visite comme un groupe :
/// ses surfaces se dessinent, ses pastilles, textes, points et flèches ne sont ni surfaces ni diagnostics, et une classe
/// inconnue y reste un diagnostic.
#[test]
fn un_ggtag_se_visite_comme_un_groupe() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    let tag = |builder: &mut Builder, children: &[usize]| {
        let node = builder.add("GGTag", 1829, json!({ "m_GInfo": { "m_flags": 557248, "m_tag": 188 }, "m_bUseModelTestPoint": true, "m_modelTestPoint": [0.0, 0.0, 0.0], "m_selectByModelTestPoint": false, "m_subNodes": [] }));
        link_children(builder, node, children);
        node
    };

    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let bitmap = builder.add("GBitmap", 1830, json!({ "m_GInfo": { "m_flags": 557088, "m_tag": -1 }, "m_alignment": 0, "m_bitmapType": 78, "m_point": [0.0, 0.0, 0.0], "m_size": [10, 10] }));
    let text = builder.add("GText", 1831, json!({ "m_GInfo": { "m_flags": 557088, "m_tag": -1 } }));
    let point = builder.add("GPoint", 1832, json!({ "m_GInfo": { "m_flags": 558756, "m_tag": 188 }, "m_coord": [0.0, 0.0, 0.0], "m_pointFlags": 0, "m_size": 6 }));
    let flip = builder.add("GBiFlipControl", 3100, json!({ "m_GInfo": { "m_flags": 557124, "m_tag": 40444 }, "m_base": [0.0, 1.0, 0.0], "m_length": 16.0, "m_origin": [0.0, 0.0, 0.0] }));
    let overlay = tag(&mut builder, &[bitmap, text, point, flip]);
    let mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let carrying = tag(&mut builder, &[mesh]);
    link_children(&mut builder, root, &[overlay, carrying]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    assert_eq!(meshes.primitives.len(), 1, "seule la surface du GGTag porteur se dessine");

    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let unknown = builder.add("GInconnu", 1833, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 } }));
    let overlay = tag(&mut builder, &[unknown]);
    link_children(&mut builder, root, &[overlay]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.iter().any(|message| message.contains("GInconnu")), "{:?}", meshes.diagnostics);
}

/// Un `GFilter` sans condition, et ses enfants.
fn filter_node(builder: &mut Builder, children: &[usize]) -> usize {
    let filter = builder.add("GFilter", 3300, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 }, "m_bIsNestedDetailFamily": false, "m_oConditions": [], "m_subNodes": [] }));
    link_children(builder, filter, children);
    filter
}

/// Un `GGroup` de catégorie `category` (un `GStyleElem` : le style d'un calque d'import), et ses enfants.
fn group_node(builder: &mut Builder, category: i64, children: &[usize]) -> usize {
    let group = builder.add("GGroup", 3302, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1, "m_categoryId": { "m_id": { "m_id64": category } } }, "m_subNodes": [] }));
    link_children(builder, group, children);
    group
}

/// Un `GImposter` à actif nul : l'image d'un contenu RPC.
fn imposter_node(builder: &mut Builder) -> usize {
    builder.add("GImposter", 3101, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": -1 }, "m_oAsset": { "class_tag": 413, "offset": 9, "pointer_token": 4294967295u64 }, "m_trf": { "m_3x3": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], "m_or": [0.0, 0.0, 0.0] } }))
}

/// Le `GPolyMesh` voisin d'un `GImposter` (le contenu 3D d'un symbole RPC : silhouette et empreinte au sol) est une surcouche, et
/// lui seul : un `GPolyMesh` d'un autre groupe, d'un autre filtre ou sans imposteur voisin se dessine comme avant. L'imposteur
/// n'est toujours pas une surface ni un diagnostic.
#[test]
fn le_poly_mesh_voisin_d_un_imposteur_est_une_surcouche() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    // Le filtre du symbole RPC : un imposteur, son maillage voisin, et un nœud `Geometry` vide.
    let imposter = imposter_node(&mut builder);
    let stand_in = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let filter = filter_node(&mut builder, &[imposter, stand_in]);
    // Un autre maillage, dans un groupe sans imposteur ; et un maillage à la racine.
    let ordinary = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let group = group_node(&mut builder, -1, &[ordinary]);
    let bare = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    link_children(&mut builder, root, &[filter, group, bare]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    assert_eq!(meshes.primitives.len(), 3);
    assert_eq!(meshes.overlay, vec![true, false, false]);
    // Chaque primitive a son indicateur, comme son indicateur « module » (`ours`).
    assert_eq!(meshes.overlay.len(), meshes.ours.len());
}

/// La surcouche est la même quand le symbole est parcouru pour lui-même (sa forme gardée, puis rejouée pour chaque instance) et
/// quand l'instance le parcourt à travers son graphe.
#[test]
fn la_surcouche_d_un_symbole_rpc_passe_par_sa_forme_et_par_son_graphe() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    let symbol = symbol_graph(&|builder| {
        let imposter = imposter_node(builder);
        let stand_in = poly_mesh_node(builder, "FacetedTopology0", &points, &normals, &facets, 2);
        let filter = filter_node(builder, &[imposter, stand_in]);
        let solid = poly_mesh_node(builder, "FacetedTopology0", &points, &normals, &facets, 2);
        vec![filter, solid]
    });
    // Par le graphe : une instance du symbole.
    let placed = place_symbol(&symbol, 0, false, VISIBLE);
    assert!(placed.diagnostics.is_empty(), "{:?}", placed.diagnostics);
    assert_eq!(placed.overlay, vec![true, false]);
    // Par la forme : le parcours du symbole pour lui-même note la surcouche de chaque nœud, que `place` rejoue.
    let edges = |_owner: u64, graph: &ObjectGraph| std::sync::Arc::new(faces::select::edge_index(graph));
    let shape = faces::select::symbol_shape(&symbol, 777, &|_| None, &edges, &|_| None, 3).expect("forme du symbole");
    let nodes: Vec<bool> = shape.events.iter().filter_map(|event| if let faces::select::ShapeEvent::Node { overlay, .. } = event { Some(*overlay) } else { None }).collect();
    assert_eq!(nodes, vec![true, false]);
}

/// Le style d'un `GPolyMesh` : celui du conteneur le plus proche qui en a un, dans son graphe (le calque d'une DWG importée),
/// `-1` sans conteneur de catégorie ; et `-1` pour un nœud qui n'est pas un `GPolyMesh`.
#[test]
fn un_poly_mesh_retient_le_style_de_son_calque() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let in_layer = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let layer = group_node(&mut builder, 750250, &[in_layer]);
    // Un groupe sans catégorie dans un groupe de catégorie : c'est la catégorie du groupe extérieur qui vaut ; la plus proche l'emporte.
    let nested = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let inner_plain = group_node(&mut builder, -1, &[nested]);
    let inner_layer_mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let inner_layer = group_node(&mut builder, 750252, &[inner_layer_mesh]);
    let outer = group_node(&mut builder, 750251, &[inner_plain, inner_layer]);
    // Sans conteneur de catégorie.
    let bare = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    link_children(&mut builder, root, &[layer, outer, bare]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    assert_eq!(meshes.layers, vec![750250, 750251, 750252, -1]);
    assert_eq!(meshes.layers.len(), meshes.primitives.len());
}

/// Le style ne passe pas d'un graphe à l'autre : le maillage d'un symbole placé par une instance qui est dans un groupe de catégorie
/// n'a pas le style de ce groupe, seulement les siens.
#[test]
fn le_style_d_un_calque_ne_traverse_pas_les_symboles() {
    let symbol = tetrahedron_symbol();
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let instance = builder.add(
        "GInstance",
        3200,
        json!({ "m_GInfo": { "m_flags": VISIBLE, "m_tag": 0 }, "m_bHasScale": false, "m_resolveSymInView": false, "m_forbiddenTarget": { "m_targets": 0 }, "m_oEmbeddedSymbolGRep": { "class_tag": null, "offset": 1, "pointer_token": 0 } }),
    );
    let info = builder.add(
        "InstanceInfo",
        3102,
        json!({ "m_GRepId": 0, "m_cda": { "m_pDoc": { "class_tag": null, "offset": 1, "pointer_token": 1 } }, "m_symbolId": { "m_id": { "m_id64": 777 } }, "m_Trf": { "m_3x3": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], "m_or": [0.0, 0.0, 0.0] } }),
    );
    let info_pointer = builder.pointer(instance, Some(info));
    builder.set(instance, "m_instanceInfo", info_pointer);
    let group = group_node(&mut builder, 4242, &[instance]);
    link_children(&mut builder, root, &[group]);
    let graph = builder.graph();
    let meshes = faces::graphics(&graph, &|owner| (owner == 777).then_some(&symbol), 3);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    assert_eq!(meshes.layers, vec![-1]);
}

/// Un élément dont le graphique est une seule instance du symbole 777, avec la valeur donnée de `m_bHasScale` (absente : `None`) et
/// la matrice 3 × 3 donnée (la translation est nulle). `known` : le symbole est lu avant l'élément ; sinon, avec `defer`, l'instance attend
/// son symbole et se rejoue ensuite.
fn place_with_scale(symbol: &ObjectGraph, scale: Option<bool>, matrix: [[f64; 3]; 3], known: bool, defer: bool) -> faces::Meshes {
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    let mut fields = json!({ "m_GInfo": { "m_flags": VISIBLE, "m_tag": 0 }, "m_resolveSymInView": false, "m_forbiddenTarget": { "m_targets": 0 }, "m_oEmbeddedSymbolGRep": { "class_tag": null, "offset": 1, "pointer_token": 0 } });
    if let Some(scale) = scale {
        fields["m_bHasScale"] = json!(scale);
    }
    let instance = builder.add("GInstance", 3200, fields);
    let info = builder.add(
        "InstanceInfo",
        3102,
        json!({ "m_GRepId": 0, "m_cda": { "m_pDoc": { "class_tag": null, "offset": 1, "pointer_token": 1 } }, "m_symbolId": { "m_id": { "m_id64": 777 } }, "m_Trf": { "m_3x3": matrix, "m_or": [0.0, 0.0, 0.0] } }),
    );
    let info_pointer = builder.pointer(instance, Some(info));
    builder.set(instance, "m_instanceInfo", info_pointer);
    link_children(&mut builder, root, &[instance]);
    let graph = builder.graph();
    let settings = faces::Settings { detail_level: 3, prudent: false, cache: None, defer };
    let mut meshes = faces::graphics_with(&graph, &|owner| (owner == 777 && known).then_some(symbol), &settings);
    if !meshes.pending.is_empty() {
        faces::complete(&mut meshes, &|owner| (owner == 777).then_some(symbol), &faces::Settings { defer: false, ..settings });
    }
    meshes
}

const NO_SCALE: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Un symbole d'import vide, comme les calques `.AVE_RENDER` et `.AVE_GLOBAL` des DWG de `wadduwa.rvt` : un `GElement` sans enfant.
fn empty_symbol() -> ObjectGraph {
    symbol_graph(&|_| Vec::new())
}

/// Les échelles que les octets des fichiers d'essai montrent sont toutes uniformes (rotation ou miroir multipliés par un nombre) :
/// l'identité des roues de la Peugeot de `wadduwa.rvt`, 0,125 des blocs de `rac_advanced`, 25,4 et 2 413,27 de blocs de `wadduwa.rvt`,
/// 0,75 avec miroir. Une échelle non uniforme, un cisaillement ou une matrice nulle n'en sont pas.
#[test]
fn une_echelle_uniforme_se_reconnait_a_ses_colonnes() {
    use faces::select::uniform_scale;
    let matrix = |rows: [[f64; 3]; 3]| {
        let mut m = [[0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
        for i in 0..3 {
            m[i][..3].copy_from_slice(&rows[i]);
        }
        m
    };
    assert_eq!(uniform_scale(&matrix(NO_SCALE)), Some(1.0));
    let scaled = |factor: f64| matrix([[factor, 0.0, 0.0], [0.0, factor, 0.0], [0.0, 0.0, factor]]);
    for factor in [0.125, 25.4, 2413.2730015083343] {
        let found = uniform_scale(&scaled(factor)).expect("échelle uniforme");
        assert!((found - factor).abs() <= 1e-9 * factor, "{factor} : {found}");
    }
    // La matrice de rac_advanced : 0,125 fois une rotation de 90°, avec des 2,8e-17 là où il y a des zéros.
    let rotated = matrix([[-2.7755575615628914e-17, 0.125, 0.0], [-0.125, -2.7755575615628914e-17, 0.0], [0.0, 0.0, 0.125]]);
    assert!((uniform_scale(&rotated).unwrap() - 0.125).abs() < 1e-12);
    // Un miroir à 0,75 (déterminant négatif) : une échelle uniforme aussi.
    let mirrored = matrix([[0.6148631341540776, -0.42946865573429943, 0.0], [-0.42946865573429943, -0.6148631341540776, 0.0], [0.0, 0.0, 0.7500000000000008]]);
    assert!((uniform_scale(&mirrored).unwrap() - 0.75).abs() < 1e-9);
    // Pas uniformes : un étirement, un cisaillement, une matrice nulle, une échelle qui diffère de 1e-6 en valeur relative.
    assert_eq!(uniform_scale(&matrix([[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]])), None);
    assert_eq!(uniform_scale(&matrix([[1.0, 0.5, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])), None);
    assert_eq!(uniform_scale(&matrix([[0.0; 3]; 3])), None);
    assert_eq!(uniform_scale(&matrix([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.000001]])), None);
}

/// Une instance à échelle (`m_bHasScale` vrai) dont la matrice est une échelle uniforme se place comme toute autre : les roues de la Peugeot
/// de `wadduwa.rvt` (identité), les blocs à 0,125 ou 25,4. Les sommets passent par la matrice, les normales restent unitaires et sortantes,
/// et un miroir garde ses triangles vers l'extérieur.
#[test]
fn une_instance_a_echelle_uniforme_se_place_comme_une_autre() {
    // L'identité : le symbole se dessine, tel quel.
    let plain = place_with_scale(&tetrahedron_symbol(), Some(true), NO_SCALE, true, false);
    assert!(plain.diagnostics.is_empty() && plain.primitives.len() == 1, "{:?}", plain.diagnostics);
    assert_eq!(plain.primitives[0].triangles.len(), 4);
    let unscaled = place_with_scale(&tetrahedron_symbol(), Some(false), NO_SCALE, true, false);
    assert_eq!(plain.primitives[0].vertices, unscaled.primitives[0].vertices, "l'identité à échelle vaut l'instance sans échelle");

    // Deux échelles, et la même avec un miroir : les sommets sont ceux du symbole multipliés, les normales unitaires, les triangles sortants.
    for (factor, mirror) in [(0.125, false), (25.4, false), (2413.2730015083343, false), (0.75, true)] {
        let matrix = [[if mirror { -factor } else { factor }, 0.0, 0.0], [0.0, factor, 0.0], [0.0, 0.0, factor]];
        let meshes = place_with_scale(&tetrahedron_symbol(), Some(true), matrix, true, false);
        assert!(meshes.diagnostics.is_empty() && meshes.primitives.len() == 1, "{factor} : {:?}", meshes.diagnostics);
        let primitive = &meshes.primitives[0];
        let reference = &unscaled.primitives[0];
        assert_eq!(primitive.vertices.len(), reference.vertices.len());
        for (placed, origin) in primitive.vertices.iter().zip(&reference.vertices) {
            let expected = [origin[0] * matrix[0][0], origin[1] * factor, origin[2] * factor];
            assert!(close(*placed, expected, 1e-9 * factor.max(1.0)), "{factor} : {placed:?} ≠ {expected:?}");
        }
        for normal in &primitive.normals {
            assert!((norm(*normal) - 1.0).abs() < 1e-9, "{factor} : normale non unitaire {normal:?}");
        }
        // Chaque triangle est tourné vers l'extérieur de la coque (le centroïde est à l'intérieur d'un tétraèdre) et d'accord avec ses normales.
        let centroid = [0, 1, 2].map(|k| primitive.vertices.iter().map(|v| v[k]).sum::<f64>() / primitive.vertices.len() as f64);
        for triangle in &primitive.triangles {
            let [a, b, c] = triangle.map(|corner| primitive.vertices[corner as usize]);
            let geometric = cross(sub(b, a), sub(c, a));
            let middle = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
            assert!(dot(geometric, sub(middle, centroid)) > 0.0, "{factor} : triangle tourné vers l'intérieur");
            let normal = primitive.normals[triangle[0] as usize];
            assert!(dot(geometric, normal) > 0.0, "{factor} : triangle contre sa normale");
        }
    }
}

/// Une matrice qui n'est pas une échelle uniforme (étirement, cisaillement) n'a pas de lecture établie : un symbole qui porte des surfaces reste
/// un diagnostic (« échelle non uniforme »), un symbole vide ou de lignes seulement est sauté sans rien perdre. Un drapeau absent reste refusé.
#[test]
fn une_instance_a_echelle_non_uniforme_garde_son_diagnostic() {
    let stretched = [[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]];
    let sheared = [[1.0, 0.5, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for matrix in [stretched, sheared] {
        let refused = place_with_scale(&tetrahedron_symbol(), Some(true), matrix, true, false);
        assert!(refused.primitives.is_empty());
        assert!(refused.diagnostics.iter().any(|message| message.contains("non uniforme")), "{:?}", refused.diagnostics);
        // Sans l'indicateur d'échelle, la même matrice est celle d'une instance ordinaire : rien ne change pour elle.
        let unflagged = place_with_scale(&tetrahedron_symbol(), Some(false), matrix, true, false);
        assert!(unflagged.diagnostics.is_empty() && unflagged.primitives.len() == 1);
        // Calque vide, symbole de lignes : rien à dessiner, rien de perdu.
        for symbol in [empty_symbol(), line_symbol()] {
            let skipped = place_with_scale(&symbol, Some(true), matrix, true, false);
            assert!(skipped.primitives.is_empty() && skipped.diagnostics.is_empty(), "{:?}", skipped.diagnostics);
        }
    }
    // Un calque vide à échelle uniforme (les neuf instances du Citroën) : rien à dessiner non plus.
    let empty = place_with_scale(&empty_symbol(), Some(true), NO_SCALE, true, false);
    assert!(empty.primitives.is_empty() && empty.diagnostics.is_empty(), "{:?}", empty.diagnostics);
    let missing = place_with_scale(&empty_symbol(), None, NO_SCALE, true, false);
    assert!(missing.diagnostics.iter().any(|message| message.contains("échelle")), "{:?}", missing.diagnostics);
}

/// Le même choix quand le symbole n'est pas encore lu (l'instance attend, `Settings::defer`, puis se rejoue dans `complete`).
#[test]
fn une_instance_a_echelle_qui_attend_son_symbole_se_decide_comme_les_autres() {
    let stretched = [[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]];
    let double = [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]];
    // Non uniforme et vide : après l'achèvement, aucun diagnostic.
    let meshes = place_with_scale(&empty_symbol(), Some(true), stretched, false, true);
    assert!(meshes.pending.is_empty() && meshes.primitives.is_empty() && meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    // Non uniforme avec des surfaces : le diagnostic arrive à la même place.
    let refused = place_with_scale(&tetrahedron_symbol(), Some(true), stretched, false, true);
    assert!(refused.primitives.is_empty());
    assert!(refused.diagnostics.iter().any(|message| message.contains("non uniforme")), "{:?}", refused.diagnostics);
    // Uniforme (identité, ×2) : l'instance qui attendait se dessine à sa place, comme sans attente.
    for matrix in [NO_SCALE, double] {
        let waited = place_with_scale(&tetrahedron_symbol(), Some(true), matrix, false, true);
        let direct = place_with_scale(&tetrahedron_symbol(), Some(true), matrix, true, false);
        assert!(waited.diagnostics.is_empty() && waited.primitives.len() == 1, "{:?}", waited.diagnostics);
        assert_eq!(waited.primitives[0].vertices, direct.primitives[0].vertices);
    }
}

/// Un maillage de tétraèdre entier posé par une instance en miroir (déterminant −1) : ses triangles restent
/// tournés vers l'extérieur et d'accord avec leurs normales, après la transformation.
#[test]
fn une_instance_en_miroir_garde_ses_triangles_vers_l_exterieur() {
    let (points, facets) = tetrahedron();
    let normals = facet_normals(&points, &facets);
    let mut builder = Builder::new();
    let root = element_node(&mut builder);
    // Le symbole incorporé (GElement) de l'instance : le tétraèdre.
    let mesh = poly_mesh_node(&mut builder, "FacetedTopology0", &points, &normals, &facets, 2);
    let embedded = element_node(&mut builder);
    link_children(&mut builder, embedded, &[mesh]);
    let instance = builder.add("GInstance", 3200, json!({ "m_GInfo": { "m_flags": 557060, "m_tag": 1 }, "m_bHasScale": false, "m_resolveSymInView": false, "m_forbiddenTarget": { "m_targets": 0 }, "m_tagId": { "m_id": { "m_id64": -1 } } }));
    // Miroir par rapport au plan x = 0, puis translation : det = −1.
    let info = builder.add("InstanceInfo", 3102, json!({ "m_GRepId": 0, "m_cda": { "m_pDoc": { "class_tag": null, "offset": 1, "pointer_token": 1 } }, "m_symbolId": { "m_id": { "m_id64": 5 } }, "m_Trf": { "m_3x3": [[-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], "m_or": [10.0, 0.0, 0.0] } }));
    let (info_pointer, embedded_pointer) = (builder.pointer(instance, Some(info)), builder.pointer(instance, Some(embedded)));
    builder.set(instance, "m_instanceInfo", info_pointer);
    builder.set(instance, "m_oEmbeddedSymbolGRep", embedded_pointer);
    link_children(&mut builder, root, &[instance]);
    let meshes = graphics_of(builder);
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    let primitive = &meshes.primitives[0];
    // Le miroir envoie (x, y, z) sur (10 − x, y, z).
    assert!(primitive.vertices.iter().all(|v| v[0] >= 9.0 - 1e-12 && v[0] <= 10.0 + 1e-12));
    let centroid = [0, 1, 2].map(|k| primitive.vertices.iter().map(|v| v[k]).sum::<f64>() / primitive.vertices.len() as f64);
    for (i, triangle) in primitive.triangles.iter().enumerate() {
        let [a, b, c] = triangle.map(|corner| primitive.vertices[corner as usize]);
        let geometric = cross(sub(b, a), sub(c, a));
        let middle = [0, 1, 2].map(|k| (a[k] + b[k] + c[k]) / 3.0);
        // Vers l'extérieur de la coque (le centroïde est à l'intérieur d'un tétraèdre), et d'accord avec la
        // normale de chaque sommet, elle-même sortante.
        assert!(dot(geometric, sub(middle, centroid)) > 0.0, "triangle {i} tourné vers l'intérieur");
        for &corner in triangle {
            assert!(dot(geometric, primitive.normals[corner as usize]) > 0.0, "triangle {i} contraire à sa normale");
            assert!(dot(sub(primitive.vertices[corner as usize], centroid), primitive.normals[corner as usize]) > -1e-9, "normale rentrante");
        }
    }
}

/// Une chaîne d'arêtes qui revient sur elle-même (A → B → A) sans retrouver sa boucle est refusée tout de
/// suite, au lieu de tourner jusqu'à la limite de segments.
#[test]
fn une_chaine_d_aretes_qui_tourne_en_rond_est_refusee() {
    let outer = vec![edge(&[[0.0, 0.0], [10.0, 0.0]]), edge(&[[10.0, 0.0], [10.0, 10.0]]), edge(&[[10.0, 10.0], [0.0, 10.0]]), edge(&[[0.0, 10.0], [0.0, 0.0]])];
    let mut builder = Builder::new();
    let (face, _) = builder.plane_face(&[outer]);
    // Objets : 0 plan, 1 face, 2 boucle, 3 à 6 arêtes. La dernière arête revient à la première.
    let (first, last) = (3, 6);
    let back = builder.pointer(last, Some(first));
    let none = builder.pointer(last, None);
    builder.set(last, "m_next", json!([back, none]));
    let graph = builder.graph();
    let surface = Surface::read(&graph, 0).unwrap();
    let started = std::time::Instant::now();
    let error = revit::geometry::faces::loops::read(&graph, face, &surface).expect_err("la boucle ne se ferme pas");
    assert!(format!("{error:#}").contains("boucle sans fin"), "{error:#}");
    assert!(started.elapsed().as_secs_f64() < 1.0, "la chaîne a tourné {:?}", started.elapsed());
    assert!(matches!(faces::mesh_face(&graph, face), Outcome::Failed { .. }));
}

// ---------------------------------------------------------------------------------------------
// Les nœuds des fichiers d'essai
// ---------------------------------------------------------------------------------------------

/// Les primitives et diagnostics d'éléments d'un fichier, par `faces::graphics`.
fn graphics_in(path: &PathBuf, ids: &[u64]) -> HashMap<u64, faces::Meshes> {
    let mut file = open(path);
    let wanted = |scene: &saved::Scene, id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none() && ids.contains(&id);
    let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
    let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
    scan.results.into_iter().filter_map(|(id, result)| result.map(|meshes| (id, meshes))).collect()
}

/// Ce que les octets des fichiers d'essai ont montré de chaque nœud que rvt-rs refusait (voir la
/// documentation de `faces::select`).
#[test]
fn les_noeuds_refuses_par_rvt_rs_se_lisent_dans_les_fichiers_d_essai() {
    // (fichier, élément, ce qu'il porte).
    // - GBiFlipControl : le garde-corps 462556 (RE1-Architecture) et ceux de Dynamo.
    // - GFilter de famille de détail imbriquée : les portes 416703 et 416336.
    // - GImposter et GPolyMesh à normales par facette : l'appareil d'éclairage 446041 (RE1-Electrical) et la
    //   figurine RPC 954992 (Dynamo, FacetedTopology8).
    // - GComponentRef : la semelle sur pieux 767153 (le pieu 767156 est un élément à part) et le boîtier 490193.
    // - GInstance à cibles interdites dont le symbole n'a que des lignes : 490195.
    let cases: [(&str, &[u64]); 4] = [
        ("RE1-Architecture.rvt", &[462556, 416703, 416336]),
        ("RE1-Electrical.rvt", &[446041, 446042, 490193, 490195]),
        ("DynamoSample_2024.rvt", &[567887, 954992, 955125, 767153, 411452, 490318, 523063]),
        ("2024_Core_Interior.rvt", &[21974]),
    ];
    for (name, ids) in cases {
        let Some(path) = sample(name) else { continue };
        let found = graphics_in(&path, ids);
        for id in ids {
            let meshes = found.get(id).unwrap_or_else(|| panic!("{name} : élément {id} sans graphique"));
            assert!(meshes.diagnostics.is_empty(), "{name} {id} : {:?}", meshes.diagnostics);
            assert_eq!(meshes.unbounded_faces, 0, "{name} {id} : faces non maillées {:?}", meshes.failures);
            // Tous sauf 490195 (symbole de lignes) ont des surfaces.
            if *id != 490195 {
                assert!(!meshes.primitives.is_empty(), "{name} {id} : aucune primitive");
            } else {
                assert!(meshes.primitives.is_empty());
            }
        }
        if name == "DynamoSample_2024.rvt" {
            assert_eq!(found[&767153].components, vec![767156], "le pieu est un composant imbriqué");
        }
        if name == "RE1-Electrical.rvt" {
            assert_eq!(found[&490193].components, vec![490195]);
        }
    }
}

/// Toutes les références de composants des éléments dessinés visent un élément dessiné ou une forme sans
/// aucune surface : ne pas les redessiner dans l'hôte ne perd rien.
#[test]
fn chaque_composant_imbrique_est_dessine_ou_sans_surface() {
    use std::collections::BTreeSet;
    for name in ["DynamoSample_2024.rvt", "RE1-Electrical.rvt", "RE1-Architecture.rvt", "2024_Core_Interior.rvt", "rac_advanced_sample_project.rvt", "mega_advanced_sample_file.rvt"] {
        let Some(path) = sample(name) else { continue };
        let bytes = std::fs::read(&path).expect("fichier d'essai");
        let mut file = rvt::RevitFile::open_bytes(bytes.clone()).expect("fichier Revit");
        let mut context = revit::Context::new(file.basic_file_info().ok().map(|info| info.version));
        let built = revit::geometry::build(&mut file, &mut context).expect("géométrie");
        let drawn: BTreeSet<u64> = built.element_ids.iter().copied().collect();

        let mut file = open(&path);
        let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
            let meshes = faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
            (meshes.components, meshes.primitives.len() + meshes.unbounded_faces + meshes.diagnostics.len())
        };
        let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
        let mut targets = 0;
        for (id, result) in &scan.results {
            if !drawn.contains(id) {
                continue;
            }
            for &target in result.iter().flat_map(|(components, _)| components) {
                targets += 1;
                if drawn.contains(&target) {
                    continue;
                }
                // Une forme sans surface : aucune primitive, aucune face manquante, aucun diagnostic.
                let (_, content) = scan.results.get(&target).and_then(Option::as_ref).unwrap_or_else(|| panic!("{name} : le composant {target} de {id} n'a pas de graphique lu"));
                assert_eq!(*content, 0, "{name} : le composant {target} de {id} a des surfaces et n'est pas dessiné");
            }
        }
        eprintln!("{name} : {targets} références de composants");
    }
}

/// Le terrain 21974 de Core Interior (deux GPolyMesh à normales par sommet : jupe et fond) : sommets gardés,
/// normales de Revit, dans les octets du fichier ; et le plan à 558 points et 928 facettes de Dynamo.
#[test]
fn la_topographie_a_une_normale_par_sommet() {
    if let Some(path) = sample("2024_Core_Interior.rvt") {
        let found = graphics_in(&path, &[21974]);
        let meshes = &found[&21974];
        assert!(meshes.diagnostics.is_empty() && meshes.unbounded_faces == 0);
        // Deux maillages : la jupe (14 points, 12 facettes) et le fond (4 points, 2 facettes).
        let mut sizes: Vec<(usize, usize)> = meshes.primitives.iter().map(|p| (p.vertices.len(), p.triangles.len())).collect();
        sizes.sort();
        assert_eq!(sizes, vec![(4, 2), (14, 12)]);
        let skirt = meshes.primitives.iter().find(|p| p.vertices.len() == 14).unwrap();
        // Les 14 normales de la jupe, telles que Revit les a écrites : par exemple la deuxième du mur du fond (x = 167,
        // y = 114) est [0, 1, 0], la troisième est lissée avec le mur voisin.
        assert!(close(skirt.normals[0], [0.0, 1.0, 0.0], 1e-6), "{:?}", skirt.normals[0]);
        assert!(close(skirt.normals[2], [-0.8944271802902222, 0.4472135901451111, 0.0], 1e-6), "{:?}", skirt.normals[2]);
        assert!(close(skirt.vertices[0], [167.0, 114.0, -43.00052261352539], 1e-9));
        assert!(skirt.normals.iter().all(|n| (norm(*n) - 1.0).abs() < 1e-9));
    }
    if let Some(path) = sample("DynamoSample_2024.rvt") {
        let found = graphics_in(&path, &[411452]);
        let meshes = &found[&411452];
        assert!(meshes.diagnostics.is_empty());
        let primitive = &meshes.primitives[0];
        // 558 points et 928 facettes : les sommets sont partagés, pas un par coin (2 784).
        assert_eq!((primitive.vertices.len(), primitive.triangles.len()), (558, 928));
        // Chaque triangle est tourné comme les normales de ses trois sommets.
        let agreeing = primitive
            .triangles
            .iter()
            .filter(|t| {
                let [a, b, c] = t.map(|i| primitive.vertices[i as usize]);
                let geometric = cross(sub(b, a), sub(c, a));
                t.iter().all(|&i| dot(geometric, primitive.normals[i as usize]) > 0.0)
            })
            .count();
        assert!(agreeing >= 920, "triangles d'accord avec leurs normales : {agreeing} sur 928");
    }
}

/// Une figurine RPC (FacetedTopology8, normales par facette) et un appareil d'éclairage (indicateur 2) : la
/// i-ème normale est celle du triangle i.
#[test]
fn les_normales_par_facette_sont_celles_des_triangles() {
    for (name, id) in [("DynamoSample_2024.rvt", 954992u64), ("RE1-Electrical.rvt", 446041)] {
        let Some(path) = sample(name) else { continue };
        let found = graphics_in(&path, &[id]);
        let meshes = &found[&id];
        assert!(meshes.diagnostics.is_empty(), "{name} : {:?}", meshes.diagnostics);
        // Sur les primitives qui viennent d'un GPolyMesh à normales par facette (un sommet par coin), la normale
        // d'un coin est celle de son triangle (à la transformation près : mêmes sens).
        let mut checked = 0;
        for primitive in &meshes.primitives {
            if primitive.vertices.len() != primitive.triangles.len() * 3 {
                continue;
            }
            for triangle in &primitive.triangles {
                let [a, b, c] = triangle.map(|i| primitive.vertices[i as usize]);
                let geometric = cross(sub(b, a), sub(c, a));
                if norm(geometric) < 1e-12 {
                    continue;
                }
                let normal = primitive.normals[triangle[0] as usize];
                assert!(dot(geometric, normal) / norm(geometric) > 0.999, "{name} : normale de la facette non conforme");
                checked += 1;
            }
        }
        assert!(checked > 100, "{name} : {checked} facettes contrôlées");
    }
}

/// Une instance posée par une transformation qui inverse l'espace (le garde-corps 1020391 de Dynamo, quatre
/// nœuds de déterminant négatif) garde des triangles d'accord avec leurs normales, qui sont transformées avec
/// eux : ni retournés, ni rentrants.
#[test]
fn une_instance_en_miroir_des_fichiers_d_essai_garde_son_sens() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let mut file = open(&path);
    let wanted = |scene: &saved::Scene, id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none() && id == 1020391;
    let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
        let selection = faces::select::select(graph, &|owner| scene.symbol(owner), &|_, g| std::sync::Arc::new(faces::select::edge_index(g)), &|owner| scene.cache.shape(owner), saved::DETAIL_LEVEL);
        let mirrored = selection
            .selected
            .iter()
            .filter(|s| {
                let m = s.world_transform;
                m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]) < 0.0
            })
            .count();
        (mirrored, faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL))
    };
    let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
    let (mirrored, meshes) = scan.results[&1020391].as_ref().expect("graphique du garde-corps");
    assert_eq!(*mirrored, 4, "nœuds en miroir");
    assert!(meshes.diagnostics.is_empty(), "{:?}", meshes.diagnostics);
    let (mut agreeing, mut total) = (0usize, 0usize);
    for primitive in &meshes.primitives {
        for triangle in &primitive.triangles {
            let [a, b, c] = triangle.map(|i| primitive.vertices[i as usize]);
            let geometric = cross(sub(b, a), sub(c, a));
            if norm(geometric) < 1e-12 {
                continue;
            }
            let normal = triangle.iter().fold([0.0; 3], |acc, &i| [acc[0] + primitive.normals[i as usize][0], acc[1] + primitive.normals[i as usize][1], acc[2] + primitive.normals[i as usize][2]]);
            total += 1;
            agreeing += usize::from(dot(geometric, normal) > 0.0);
        }
    }
    assert!(total > 100);
    assert_eq!(agreeing, total, "triangles tournés contre leurs normales : {} sur {total}", total - agreeing);
}

/// Le cache des symboles (voir `faces::cache`) ne change rien aux primitives : mêmes sommets, normales et
/// triangles que sans cache, et chaque symbole placé plusieurs fois n'est maillé qu'une fois.
#[test]
fn le_cache_ne_change_pas_les_primitives() {
    for name in ["DynamoSample_2024.rvt", "RE1-Architecture.rvt", "2024_Core_Interior.rvt"] {
        let Some(path) = sample(name) else { continue };
        let mut file = open(&path);
        let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
            let plain = faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
            let cached = faces::graphics_with(graph, &|owner| scene.symbol(owner), &faces::Settings { detail_level: saved::DETAIL_LEVEL, prudent: false, cache: Some(&scene.cache), defer: false });
            let again = faces::graphics_with(graph, &|owner| scene.symbol(owner), &faces::Settings { detail_level: saved::DETAIL_LEVEL, prudent: false, cache: Some(&scene.cache), defer: false });
            let same = |a: &faces::Meshes, b: &faces::Meshes| {
                a.primitives.len() == b.primitives.len()
                    && a.ours == b.ours
                    && a.overlay == b.overlay
                    && a.layers == b.layers
                    && a.diagnostics == b.diagnostics
                    && (a.unbounded_faces, a.reference_faces, a.empty_trim_faces) == (b.unbounded_faces, b.reference_faces, b.empty_trim_faces)
                    && a.primitives.iter().zip(&b.primitives).all(|(p, q)| key(p) == key(q) && p.source_owner_id == q.source_owner_id && p.material_id == q.material_id)
            };
            (same(&plain, &cached), same(&plain, &again))
        };
        let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
        let results: Vec<_> = scan.results.values().flatten().collect();
        assert!(!results.is_empty());
        assert!(results.iter().all(|(first, second)| *first && *second), "{name} : le cache change des primitives");
    }
}

/// Le mode prudent (rvt-rs seul) : mêmes primitives que `native_saved_mesh`, aucune face de ce module.
#[test]
fn le_mode_prudent_est_rvt_rs_seul() {
    let Some(path) = sample("RE1-Architecture.rvt") else { return };
    let mut file = open(&path);
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
    let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
        let prudent = faces::graphics_with(graph, &|owner| scene.symbol(owner), &faces::Settings { detail_level: saved::DETAIL_LEVEL, prudent: true, cache: None, defer: false });
        let old = native_saved_mesh::graphics_with_resolver_at_detail(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
        let same = prudent.primitives.len() == old.primitives.len() && prudent.primitives.iter().zip(&old.primitives).all(|(a, b)| key(a) == key(b));
        (same, prudent.ours.iter().any(|own| *own), prudent.diagnostics == old.diagnostics, prudent.unbounded_faces == old.unbounded_faces)
    };
    let scan = saved::scan(&mut file, &wanted, 1, &work).expect("lecture des graphiques");
    let results: Vec<_> = scan.results.values().flatten().collect();
    // Un balayage qui ne rend rien ferait réussir `all` à vide.
    assert!(!results.is_empty(), "aucun élément lu : l'essai ne vérifie rien");
    assert!(results.iter().all(|(same, own, diagnostics, unbounded)| *same && !*own && *diagnostics && *unbounded));
}

// ---------------------------------------------------------------------------------------------
// Raccords : les deux faces d'une arête partagée y posent les mêmes sommets
// ---------------------------------------------------------------------------------------------
//
// Un contrôle de fissures et de T-jonctions, sur le maillage final de chaque face (`faces::mesh_face`, dans le repère
// de son graphe : les deux faces d'un même nœud reçoivent la même transformation, les sommets qui coïncident avant
// coïncident après). Pour chaque arête du graphe que se partagent deux faces maillées, on lit sur le bord de chaque
// maillage les sommets qui la portent : du sommet qui répond à son premier point enregistré à celui de son dernier, le
// long des côtés que borde un seul triangle (de deux chemins possibles, celui qui passe par les points intérieurs que
// Revit a enregistrés). Les sommets d'un côté doivent tous avoir leur jumeau de l'autre, à `tolerance` près (plus l'écart
// que Revit met lui-même, sur cette arête, entre les évaluations de ses points enregistrés sur les deux surfaces) : un
// sommet sans jumeau mais posé sur la ligne de l'autre côté est une T-jonction alignée (aucune fente), un sommet à l'écart
// de cette ligne est une fissure, dont on garde l'écart. Dans les rapports, un couple « Plane/CylSurf » nomme les classes des
// deux surfaces, une étoile marquant une face maillée par ce module et non par rvt-rs.

type V3 = [f64; 3];

/// Le bord d'un maillage de face : ses sommets soudés à 1e-9 pied (la couture d'un cylindre entier y a deux sommets
/// confondus) et, pour chacun, ses voisins le long des côtés que borde un seul triangle.
struct Rim {
    points: Vec<V3>,
    next: Vec<Vec<usize>>,
    /// Les sommets qui portent au moins un côté de bord.
    on_rim: Vec<usize>,
}

/// Soude les sommets confondus à 1e-9 pied près : l'indice de chacun, et la position de chaque sommet soudé.
fn weld(vertices: &[V3]) -> (Vec<usize>, Vec<V3>) {
    const CELL: f64 = 1e-6;
    let mut cells: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    let (mut ids, mut points): (Vec<usize>, Vec<V3>) = (Vec::with_capacity(vertices.len()), Vec::new());
    for &p in vertices {
        let cell = p.map(|c| (c / CELL).floor() as i64);
        let mut found = None;
        'search: for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    for &id in cells.get(&[cell[0] + dx, cell[1] + dy, cell[2] + dz]).into_iter().flatten() {
                        if distance(points[id], p) <= 1e-9 {
                            found = Some(id);
                            break 'search;
                        }
                    }
                }
            }
        }
        let id = found.unwrap_or_else(|| {
            points.push(p);
            cells.entry(cell).or_default().push(points.len() - 1);
            points.len() - 1
        });
        ids.push(id);
    }
    (ids, points)
}

fn rim_of(mesh: &native_saved_mesh::FaceMesh) -> Rim {
    let (ids, points) = weld(&mesh.vertices);
    let mut count: HashMap<(usize, usize), u32> = HashMap::new();
    for triangle in &mesh.triangles {
        for k in 0..3 {
            let (a, b) = (ids[triangle[k] as usize], ids[triangle[(k + 1) % 3] as usize]);
            if a != b {
                *count.entry((a.min(b), a.max(b))).or_default() += 1;
            }
        }
    }
    let mut next = vec![Vec::new(); points.len()];
    for (&(a, b), &n) in &count {
        if n == 1 {
            next[a].push(b);
            next[b].push(a);
        }
    }
    next.iter_mut().for_each(|list| list.sort_unstable());
    let on_rim = (0..points.len()).filter(|&i| !next[i].is_empty()).collect();
    Rim { points, next, on_rim }
}

/// Distance du point `p` au segment `[a, b]`.
fn segment_distance(p: V3, a: V3, b: V3) -> f64 {
    let ab = sub(b, a);
    let length2 = dot(ab, ab);
    let t = if length2 > 0.0 { (dot(sub(p, a), ab) / length2).clamp(0.0, 1.0) } else { 0.0 };
    distance(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])
}

fn polyline_distance(p: V3, path: &[V3]) -> f64 {
    path.windows(2).map(|pair| segment_distance(p, pair[0], pair[1])).fold(f64::INFINITY, f64::min)
}

/// Les sommets que le bord `rim` pose sur l'arête dont Revit a enregistré les points `saved` (dans l'espace, évalués
/// sur la surface de cette face) : le chemin du bord entre les sommets des deux extrémités ; de deux chemins possibles
/// (une boucle de deux arêtes), celui qui suit les points intérieurs enregistrés (le milieu de la corde, à défaut).
fn walk(rim: &Rim, saved: &[V3]) -> Result<Vec<V3>, &'static str> {
    let (start, end) = (saved[0], saved[saved.len() - 1]);
    let nearest = |p: V3| rim.on_rim.iter().map(|&i| (distance(rim.points[i], p), i)).min_by(|a, b| a.0.total_cmp(&b.0));
    let ((d0, v0), (d1, v1)) = (nearest(start).ok_or("bord vide")?, nearest(end).ok_or("bord vide")?);
    if d0 > 1e-3 || d1 > 1e-3 {
        return Err("extrémité de l'arête hors du bord");
    }
    let mut candidates: Vec<Vec<usize>> = Vec::new();
    for &first in &rim.next[v0] {
        let (mut path, mut previous, mut current) = (vec![v0, first], v0, first);
        let reached = loop {
            if current == v1 {
                break true;
            }
            let options = &rim.next[current];
            let following = match options.as_slice() {
                [a, b] if *a == previous && *b != previous => *b,
                [a, b] if *b == previous && *a != previous => *a,
                _ => break false,
            };
            if (following == v0 && v0 != v1) || path.len() > rim.points.len() {
                break false;
            }
            path.push(following);
            (previous, current) = (current, following);
        };
        if reached {
            candidates.push(path);
        }
    }
    let samples: Vec<V3> = if saved.len() > 2 { saved[1..saved.len() - 1].to_vec() } else { vec![[0, 1, 2].map(|k| (start[k] + end[k]) / 2.0)] };
    let score = |path: &[usize]| {
        let points: Vec<V3> = path.iter().map(|&i| rim.points[i]).collect();
        samples.iter().map(|&s| polyline_distance(s, &points)).fold(0.0, f64::max)
    };
    // Un chemin qui s'éloigne de l'arête enregistrée de plus de 15 % de son plus long côté n'est pas elle (une face à
    // spirale ou à fente de largeur nulle peut ne pas border l'arête sur ce côté) : l'affinage ne dépasse pas la flèche
    // d'une corde de 45°, soit 10 % de sa longueur.
    let band = 0.15 * saved.windows(2).map(|pair| distance(pair[0], pair[1])).fold(0.0, f64::max) + 1e-6;
    let near = |path: &[usize]| path.iter().all(|&i| polyline_distance(rim.points[i], saved) <= band);
    let mut scored: Vec<(f64, Vec<usize>)> = candidates.into_iter().filter(|path| near(path)).map(|path| (score(&path), path)).collect();
    scored.sort_by(|a, b| a.0.total_cmp(&b.0));
    match scored.as_slice() {
        [] => Err("pas de chemin de bord le long de l'arête"),
        [(_, path)] => Ok(path.iter().map(|&i| rim.points[i]).collect()),
        [(best, path), (second, other)] => {
            let (mut a, mut b) = (path.clone(), other.clone());
            (a.sort_unstable(), b.sort_unstable());
            if a == b || *second > 2.0 * best + 1e-9 {
                Ok(path.iter().map(|&i| rim.points[i]).collect())
            } else {
                Err("deux chemins de bord possibles")
            }
        }
        _ => Err("bord ramifié"),
    }
}

/// Les comptes d'un contrôle de raccords.
#[derive(Default)]
struct Seams {
    /// Arêtes partagées par deux faces maillées, et celles dont les deux bords se sont comparés.
    shared: usize,
    compared: usize,
    /// Les arêtes qu'on n'a pas pu lire, par raison.
    skipped: std::collections::BTreeMap<&'static str, usize>,
    /// Sommets sans jumeau, posés sur la ligne de l'autre côté : des T-jonctions sans fente, par couple de classes et de
    /// mailleurs (un `*` marque une face maillée par ce module).
    aligned: std::collections::BTreeMap<String, usize>,
    /// Les fissures : couples de classes, mailleurs, et l'écart du pire sommet.
    cracks: Vec<String>,
    /// Pire écart d'une fissure, en pieds.
    worst: f64,
}

impl Seams {
    fn add(&mut self, other: Seams) {
        self.shared += other.shared;
        self.compared += other.compared;
        for (reason, count) in other.skipped {
            *self.skipped.entry(reason).or_default() += count;
        }
        for (kind, count) in other.aligned {
            *self.aligned.entry(kind).or_default() += count;
        }
        self.cracks.extend(other.cracks);
        self.worst = self.worst.max(other.worst);
    }

    /// Un résumé par couple de classes et de mailleurs.
    fn summary(&self) -> String {
        let mut by_kind: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for crack in &self.cracks {
            *by_kind.entry(crack.split(" : ").next().unwrap_or("").to_string()).or_default() += 1;
        }
        format!("{} arêtes partagées, {} comparées, {} T-jonctions alignées {:?}, {} fissures (pire {:.2e} pied) {:?}, ignorées {:?}", self.shared, self.compared, self.aligned.values().sum::<usize>(), self.aligned, self.cracks.len(), self.worst, by_kind, self.skipped)
    }
}

/// Les points (u, v) enregistrés d'une arête du côté `side` : première extrémité, points intérieurs, dernière.
fn saved_uv(graph: &ObjectGraph, edge: usize, side: usize) -> Option<Vec<[f64; 2]>> {
    let fields = &graph.objects[edge].fields;
    let ends = fields["m_firstAndLastEdgePnts"].as_array().filter(|ends| ends.len() == 2)?;
    let mut points = vec![faces::graph::point2(&ends[0]["uv"][side]).ok()?];
    for sample in fields["m_interiorEdgePnts"].as_array()? {
        points.push(faces::graph::point2(&sample["uv"][side]).ok()?);
    }
    points.push(faces::graph::point2(&ends[1]["uv"][side]).ok()?);
    Some(points)
}

/// Les faces des nœuds `Geometry` de `graph`.
fn geometry_faces(graph: &ObjectGraph) -> Vec<usize> {
    let mut out = Vec::new();
    for (node, object) in graph.objects.iter().enumerate().filter(|(_, object)| object.class_name == "Geometry") {
        let Some(pointers) = object.fields["m_pFaces"].as_array() else { continue };
        out.extend(pointers.iter().filter_map(|value| faces::graph::target(graph, node, value).ok().flatten()));
    }
    out
}

/// Les arêtes que parcourent les boucles de `face`.
fn loop_edges(graph: &ObjectGraph, face: usize) -> std::collections::HashSet<usize> {
    let mut edges = std::collections::HashSet::new();
    let target = |source: usize, value: &Value| faces::graph::target(graph, source, value).ok().flatten();
    let mut current = target(face, &graph.objects[face].fields["m_pFirstLoop"]);
    let mut loops = 0;
    while let Some(ring) = current {
        loops += 1;
        if loops > 1000 {
            break;
        }
        let mut edge = target(ring, &graph.objects[ring].fields["m_next"]);
        let mut walked = std::collections::HashSet::new();
        while let Some(index) = edge.filter(|&index| index != ring) {
            let fields = &graph.objects[index].fields;
            let sides: Vec<usize> = (0..2).filter(|&side| fields["m_pFace"].get(side).and_then(|pointer| target(index, pointer)) == Some(face)).collect();
            // Quand les deux côtés sont la même face (couture), le premier côté qu'on n'a pas parcouru.
            let Some(&side) = sides.iter().find(|&&side| walked.insert((index, side))) else { break };
            edges.insert(index);
            edge = fields["m_next"].get(side).and_then(|pointer| target(index, pointer));
        }
        current = target(ring, &graph.objects[ring].fields["m_nextLoop"]);
    }
    edges
}

/// Les raccords des arêtes que se partagent deux des faces `face_list` de `graph`, à `tolerance` pieds près.
fn seams(graph: &ObjectGraph, face_list: &[usize], tolerance: f64) -> Seams {
    struct Meshed {
        mesh: native_saved_mesh::FaceMesh,
        ours: bool,
        surface: Option<Surface>,
        rim: Option<Rim>,
    }
    let mut meshed: HashMap<usize, Meshed> = HashMap::new();
    for &face in face_list {
        if meshed.contains_key(&face) {
            continue;
        }
        let (mesh, ours) = match faces::mesh_face(graph, face) {
            Outcome::Rvt(mesh) => (mesh, false),
            Outcome::Own(mesh) => (mesh, true),
            _ => continue,
        };
        let surface = faces::graph::target(graph, face, &graph.objects[face].fields["m_pSurf"]).ok().flatten().and_then(|index| Surface::read(graph, index).ok());
        meshed.insert(face, Meshed { mesh, ours, surface, rim: None });
    }
    let in_loops: HashMap<usize, std::collections::HashSet<usize>> = meshed.keys().map(|&face| (face, loop_edges(graph, face))).collect();
    let mut out = Seams::default();
    for (edge, object) in graph.objects.iter().enumerate().filter(|(_, object)| object.class_name == "Edge") {
        let Some(pair) = object.fields["m_pFace"].as_array().filter(|pair| pair.len() == 2) else { continue };
        let faces_of: Vec<Option<usize>> = pair.iter().map(|pointer| faces::graph::target(graph, edge, pointer).ok().flatten()).collect();
        let (Some(a), Some(b)) = (faces_of[0], faces_of[1]) else { continue };
        // Les deux faces sont maillées, et parcourent cette arête dans leurs boucles (Revit en garde qui désignent une face
        // sans que sa boucle les suive).
        if a == b || !meshed.contains_key(&a) || !meshed.contains_key(&b) || !in_loops[&a].contains(&edge) || !in_loops[&b].contains(&edge) {
            continue;
        }
        out.shared += 1;
        let mut skip = |reason: &'static str| *out.skipped.entry(reason).or_default() += 1;
        // Les points enregistrés de l'arête, évalués sur la surface de chaque côté : Revit les écrit à quelques 1e-4 pied près
        // l'un de l'autre, et les sommets d'un maillage ne peuvent pas être plus proches que les points dont ils viennent.
        let mut saved: Vec<Vec<V3>> = Vec::new();
        let mut failed = None;
        for (side, face) in [a, b].into_iter().enumerate() {
            let Some(uv) = saved_uv(graph, edge, side) else {
                failed = Some("points de l'arête illisibles");
                break;
            };
            let Some(surface) = meshed[&face].surface.as_ref() else {
                failed = Some("surface illisible");
                break;
            };
            let points: Vec<V3> = uv.iter().map(|p| surface.eval(p[0], p[1])).collect();
            if points.iter().all(|p| distance(*p, points[0]) < 1e-9) {
                failed = Some("arête réduite à un point");
                break;
            }
            saved.push(points);
        }
        let mut sides: Vec<Vec<V3>> = Vec::new();
        if failed.is_none() {
            for (face, points) in [a, b].into_iter().zip(&saved) {
                let entry = meshed.get_mut(&face).expect("face maillée");
                let rim = entry.rim.get_or_insert_with(|| rim_of(&entry.mesh));
                match walk(rim, points) {
                    Ok(path) => sides.push(path),
                    Err(reason) => {
                        failed = Some(reason);
                        break;
                    }
                }
            }
        }
        if let Some(reason) = failed {
            skip(reason);
            continue;
        }
        let data_gap = saved[0].iter().zip(&saved[1]).map(|(p, q)| distance(*p, *q)).fold(0.0, f64::max);
        let tolerance = tolerance + data_gap;
        out.compared += 1;
        let (path_a, path_b) = (&sides[0], &sides[1]);
        for (from, to) in [(path_a, path_b), (path_b, path_a)] {
            for &p in from {
                if to.iter().any(|&q| distance(p, q) <= tolerance) {
                    continue;
                }
                let gap = polyline_distance(p, to);
                let kind = {
                    let (class_a, class_b) = (faces::surface_class(graph, a), faces::surface_class(graph, b));
                    let kind = |class: &str, ours: bool| format!("{class}{}", if ours { "*" } else { "" });
                    format!("{}/{}", kind(&class_a, meshed[&a].ours), kind(&class_b, meshed[&b].ours))
                };
                if gap <= tolerance {
                    *out.aligned.entry(kind).or_default() += 1;
                } else {
                    out.worst = out.worst.max(gap);
                    out.cracks.push(format!("{kind} : arête {edge}, écart {gap:.2e} pied"));
                }
            }
        }
    }
    out
}

/// Des faces dont les arêtes se partagent : on crée d'abord faces, arêtes et boucles, puis `finish` relie les pointeurs
/// (chaque arête porte, de chaque côté, sa face, sa polyligne (u, v) et l'arête suivante de la boucle de cette face).
struct Solid {
    builder: Builder,
    edges: Vec<SolidEdge>,
    loops: Vec<(usize, usize)>,
    first_loop: HashMap<usize, usize>,
    last_loop: HashMap<usize, usize>,
    chains: HashMap<usize, usize>,
}

struct SolidEdge {
    object: usize,
    faces: [Option<usize>; 2],
    uv: [Vec<[f64; 2]>; 2],
    next: [Option<usize>; 2],
}

impl Solid {
    fn new() -> Self {
        Solid { builder: Builder::new(), edges: Vec::new(), loops: Vec::new(), first_loop: HashMap::new(), last_loop: HashMap::new(), chains: HashMap::new() }
    }

    /// Une face de surface `class` (`fields` : ses champs), d'étiquette `tag`.
    fn face(&mut self, class: &str, class_tag: u16, fields: Value, tag: i64) -> usize {
        let surface = self.builder.add(class, class_tag, fields);
        let face = self.builder.add("Face", 1, json!({ "m_GInfo": { "m_tag": tag }, "m_faceFlags_v9": 4, "m_faceRegions": [], "m_renderStyleId": { "m_id": { "m_id64": -1 } } }));
        let pointer = self.builder.pointer(face, Some(surface));
        self.builder.set(face, "m_pSurf", pointer);
        face
    }

    fn plane(&mut self, origin: V3, half: f64, tag: i64) -> usize {
        self.face("Plane", 584, json!({ "m_Envelope": { "m_corners": [[-half, -half], [half, half]] }, "m_orientFlag": true, "m_origin": origin, "m_xVec": [1.0, 0.0, 0.0], "m_yVec": [0.0, 1.0, 0.0] }), tag)
    }

    fn cone(&mut self, half_angle: f64, u: [f64; 2], v: [f64; 2], tag: i64) -> usize {
        self.face("ConeSurf", 1069, json!({ "m_Envelope": { "m_corners": [[u[0], v[0]], [u[1], v[1]]] }, "m_orientFlag": true, "m_center": [0.0, 0.0, 0.0], "m_halfAngle": half_angle, "m_xVec": [1.0, 0.0, 0.0], "m_yVec": [0.0, 1.0, 0.0], "m_zVec": [0.0, 0.0, 1.0] }), tag)
    }

    fn cylinder(&mut self, radius: f64, u: [f64; 2], v: [f64; 2], tag: i64) -> usize {
        self.face("CylSurf", 1068, json!({ "m_Envelope": { "m_corners": [[u[0], v[0]], [u[1], v[1]]] }, "m_orientFlag": true, "m_center": [0.0, 0.0, 0.0], "m_radius": radius, "m_xVec": [1.0, 0.0, 0.0], "m_yVec": [0.0, 1.0, 0.0], "m_zVec": [0.0, 0.0, 1.0] }), tag)
    }

    /// Une arête entre `faces` (le côté 0 puis le côté 1), de polylignes (u, v) `uv` de leur côté.
    fn edge(&mut self, faces: [Option<usize>; 2], uv: [Vec<[f64; 2]>; 2]) -> usize {
        let object = self.builder.add("Edge", 1339, json!({}));
        self.edges.push(SolidEdge { object, faces, uv, next: [None, None] });
        self.edges.len() - 1
    }

    /// Une boucle de `face` : ses arêtes (indices rendus par `edge`) dans l'ordre.
    fn close(&mut self, face: usize, chain: &[usize]) {
        let loop_object = self.builder.add("EdgeLoop", 1350, json!({ "m_open": false }));
        let pointer = self.builder.pointer(loop_object, Some(face));
        self.builder.set(loop_object, "m_pFace", pointer);
        for (k, &edge) in chain.iter().enumerate() {
            let next = chain.get(k + 1).map_or(loop_object, |&following| self.edges[following].object);
            let side = self.edges[edge].faces.iter().position(|f| *f == Some(face)).expect("l'arête n'est pas à cette face");
            self.edges[edge].next[side] = Some(next);
        }
        self.loops.push((loop_object, self.edges[chain[0]].object));
        if let Some(previous) = self.last_loop.insert(face, loop_object) {
            self.chains.insert(previous, loop_object);
        } else {
            self.first_loop.insert(face, loop_object);
        }
    }

    fn finish(mut self) -> ObjectGraph {
        for (loop_object, first) in std::mem::take(&mut self.loops) {
            let pointer = self.builder.pointer(loop_object, Some(first));
            self.builder.set(loop_object, "m_next", pointer);
            let next = self.builder.pointer(loop_object, self.chains.get(&loop_object).copied());
            self.builder.set(loop_object, "m_nextLoop", next);
        }
        for (&face, &first) in &self.first_loop {
            let pointer = self.builder.pointer(face, Some(first));
            self.builder.set(face, "m_pFirstLoop", pointer);
        }
        for edge in std::mem::take(&mut self.edges) {
            let object = edge.object;
            let faces: Vec<Value> = edge.faces.iter().map(|f| self.builder.pointer(object, *f)).collect();
            let next: Vec<Value> = edge.next.iter().map(|n| self.builder.pointer(object, *n)).collect();
            self.builder.set(object, "m_pFace", Value::Array(faces));
            self.builder.set(object, "m_next", Value::Array(next));
            let point = |k: usize| json!({ "uv": [edge.uv[0][k], edge.uv[1][k]] });
            let last = edge.uv[0].len() - 1;
            self.builder.set(object, "m_firstAndLastEdgePnts", json!([point(0), point(last)]));
            self.builder.set(object, "m_interiorEdgePnts", Value::Array((1..last).map(point).collect()));
        }
        self.builder.graph()
    }
}

/// Les angles de `from` à `to` tous les 15° (le pas des points que Revit enregistre sur un cercle).
fn every_15_degrees(from: f64, to: f64) -> Vec<f64> {
    let n = ((to - from) / (PI / 12.0)).round() as usize;
    (0..=n).map(|k| from + (to - from) * k as f64 / n as f64).collect()
}

/// Une bande d'un solide de révolution (axe z) : un cône de sommet à l'origine (`v` : distance au sommet sur la génératrice) ou
/// un cylindre de l'axe (`z` : hauteur).
enum Band {
    Cone { half_angle: f64, v: [f64; 2] },
    Cylinder { radius: f64, z: [f64; 2] },
}

impl Band {
    /// Le (u, v) du point d'angle `theta` sur le cercle bas (`top` faux) ou haut de la bande.
    fn uv(&self, theta: f64, top: bool) -> [f64; 2] {
        let end = usize::from(top);
        match self {
            Band::Cone { v, .. } => [theta, v[end]],
            Band::Cylinder { z, .. } => [theta, z[end]],
        }
    }

    /// Le rayon et la hauteur du cercle bas ou haut.
    fn circle(&self, top: bool) -> (f64, f64) {
        let end = usize::from(top);
        match self {
            Band::Cone { half_angle, v } => (v[end] * half_angle.sin(), v[end] * half_angle.cos()),
            Band::Cylinder { radius, z } => (*radius, z[end]),
        }
    }
}

/// Un solide de révolution fermé : les `bands` empilées (chacune coupée en deux demi-faces, u de 0 à π puis de π à 2π), un
/// plan en bas et un plan en haut, tous les cercles enregistrés tous les 15°. Les faces rendues : les demi-faces de chaque
/// bande (la première moitié, puis la seconde), le plan du bas, celui du haut.
fn revolved(bands: &[Band]) -> (ObjectGraph, Vec<usize>) {
    let mut solid = Solid::new();
    let mut tag = 0;
    let mut tags = || {
        tag += 1;
        tag
    };
    let halves: Vec<[usize; 2]> = bands
        .iter()
        .map(|band| {
            [0, 1].map(|h| {
                let u = [PI * f64::from(h), PI * f64::from(h + 1)];
                match band {
                    Band::Cone { half_angle, v } => solid.cone(*half_angle, u, *v, tags()),
                    Band::Cylinder { radius, z } => solid.cylinder(*radius, u, *z, tags()),
                }
            })
        })
        .collect();
    let (bottom_circle, top_circle) = (bands[0].circle(false), bands[bands.len() - 1].circle(true));
    let (bottom, top) = (solid.plane([0.0, 0.0, bottom_circle.1], 8.0, tags()), solid.plane([0.0, 0.0, top_circle.1], 8.0, tags()));
    // Les cercles : `levels` + 1, chacun en deux demi-arêtes entre la face dessous et la face dessus.
    let mut circles: Vec<[usize; 2]> = Vec::new();
    for level in 0..=bands.len() {
        let mut pair = [0; 2];
        for h in 0..2 {
            let angles = every_15_degrees(PI * h as f64, PI * (h + 1) as f64);
            let (below, above) = (if level == 0 { bottom } else { halves[level - 1][h] }, if level == bands.len() { top } else { halves[level][h] });
            let side = |face_is_band: Option<(&Band, bool)>, radius: f64| -> Vec<[f64; 2]> {
                match face_is_band {
                    Some((band, top)) => angles.iter().map(|t| band.uv(*t, top)).collect(),
                    None => angles.iter().map(|t| [radius * t.cos(), radius * t.sin()]).collect(),
                }
            };
            let radius = if level == 0 { bottom_circle.0 } else { bands[level - 1].circle(true).0 };
            let below_uv = if level == 0 { side(None, radius) } else { side(Some((&bands[level - 1], true)), radius) };
            let above_uv = if level == bands.len() { side(None, top_circle.0) } else { side(Some((&bands[level], false)), radius) };
            pair[h] = solid.edge([Some(below), Some(above)], [below_uv, above_uv]);
        }
        circles.push(pair);
    }
    // Les génératrices de chaque bande, en u = 0 (la seconde moitié l'atteint à 2π) et u = π.
    let mut loops: Vec<(usize, Vec<usize>)> = Vec::new();
    for (b, band) in bands.iter().enumerate() {
        let at_zero = solid.edge([Some(halves[b][0]), Some(halves[b][1])], [vec![band.uv(0.0, false), band.uv(0.0, true)], vec![band.uv(2.0 * PI, false), band.uv(2.0 * PI, true)]]);
        let at_pi = solid.edge([Some(halves[b][0]), Some(halves[b][1])], [vec![band.uv(PI, false), band.uv(PI, true)], vec![band.uv(PI, false), band.uv(PI, true)]]);
        loops.push((halves[b][0], vec![circles[b][0], at_pi, circles[b + 1][0], at_zero]));
        loops.push((halves[b][1], vec![circles[b][1], at_zero, circles[b + 1][1], at_pi]));
    }
    for (face, chain) in loops {
        solid.close(face, &chain);
    }
    solid.close(bottom, &circles[0]);
    solid.close(top, &circles[bands.len()]);
    let mut faces_of: Vec<usize> = halves.iter().flatten().copied().collect();
    faces_of.extend([bottom, top]);
    (solid.finish(), faces_of)
}

/// Un tronc de cône fermé : deux demi-cônes (sommet à l'origine, demi-angle 30°), un plan en bas (cercle de rayon 1) et un
/// plan en haut (rayon 2).
fn frustum() -> (ObjectGraph, Vec<usize>) {
    let alpha = PI / 6.0;
    revolved(&[Band::Cone { half_angle: alpha, v: [1.0 / alpha.sin(), 2.0 / alpha.sin()] }])
}

/// Un cylindre de rayon 1 et de deux pieds de haut surmonté d'un tronc de cône qui le prolonge (leur cercle commun est le
/// bord d'un cylindre que rvt-rs maille, contre un cône que ce module maille), fermé par deux plans.
fn funnel() -> (ObjectGraph, Vec<usize>) {
    let alpha = PI / 6.0;
    let (v0, v1) = (1.0 / alpha.sin(), 2.0 / alpha.sin());
    let z0 = v0 * alpha.cos();
    revolved(&[Band::Cylinder { radius: 1.0, z: [z0 - 2.0, z0] }, Band::Cone { half_angle: alpha, v: [v0, v1] }])
}

/// Un tuyau : un cylindre de rayon 1,5 et de trois pieds, fermé par deux plans.
fn pipe() -> (ObjectGraph, Vec<usize>) {
    revolved(&[Band::Cylinder { radius: 1.5, z: [0.0, 3.0] }])
}

/// Une dalle de 6 pieds sur 6, épaisse de 1, percée d'un trou rond de rayon 1 (deux demi-cylindres) : le plan du haut et celui
/// du bas (contour carré sans voisin, trou partagé avec les cylindres), puis les deux demi-cylindres. Les cercles sont
/// enregistrés tous les 15°.
fn slab_with_round_hole(radius: f64) -> (ObjectGraph, Vec<usize>) {
    let mut solid = Solid::new();
    let (top, bottom) = (solid.plane([0.0, 0.0, 0.0], 4.0, 1), solid.plane([0.0, 0.0, -1.0], 4.0, 2));
    let wall = [solid.cylinder(radius, [0.0, PI], [-1.0, 0.0], 3), solid.cylinder(radius, [PI, 2.0 * PI], [-1.0, 0.0], 4)];
    let ring = |solid: &mut Solid, cap: usize, z: f64, h: usize, from: f64| {
        let angles = every_15_degrees(from, from + PI);
        solid.edge([Some(cap), Some(wall[h])], [angles.iter().map(|t| [radius * t.cos(), radius * t.sin()]).collect(), angles.iter().map(|t| [*t, z]).collect()])
    };
    let (ht0, ht1) = (ring(&mut solid, top, 0.0, 0, 0.0), ring(&mut solid, top, 0.0, 1, PI));
    let (hb0, hb1) = (ring(&mut solid, bottom, -1.0, 0, 0.0), ring(&mut solid, bottom, -1.0, 1, PI));
    let v0 = solid.edge([Some(wall[0]), Some(wall[1])], [vec![[0.0, -1.0], [0.0, 0.0]], vec![[2.0 * PI, -1.0], [2.0 * PI, 0.0]]]);
    let vp = solid.edge([Some(wall[0]), Some(wall[1])], [vec![[PI, -1.0], [PI, 0.0]], vec![[PI, -1.0], [PI, 0.0]]]);
    solid.close(wall[0], &[hb0, vp, ht0, v0]);
    solid.close(wall[1], &[hb1, v0, ht1, vp]);
    // Le contour carré de chaque plan : quatre arêtes sans voisine.
    for cap in [top, bottom] {
        let corners = [[-3.0, -3.0], [3.0, -3.0], [3.0, 3.0], [-3.0, 3.0]];
        let sides: Vec<usize> = (0..4).map(|k| solid.edge([Some(cap), None], [vec![corners[k], corners[(k + 1) % 4]], vec![corners[k], corners[(k + 1) % 4]]])).collect();
        solid.close(cap, &sides);
        let hole = if cap == top { [ht0, ht1] } else { [hb0, hb1] };
        solid.close(cap, &hole);
    }
    (solid.finish(), vec![top, bottom, wall[0], wall[1]])
}

/// Aucun côté de bord dans l'ensemble des maillages (sommets soudés à 1e-9 pied) : chaque côté de triangle est partagé
/// par exactement deux triangles.
fn open_edges(meshes: &[&native_saved_mesh::FaceMesh]) -> usize {
    let all: Vec<V3> = meshes.iter().flat_map(|mesh| mesh.vertices.iter().copied()).collect();
    let (ids, _) = weld(&all);
    let mut count: HashMap<(usize, usize), u32> = HashMap::new();
    let mut offset = 0;
    for mesh in meshes {
        for triangle in &mesh.triangles {
            for k in 0..3 {
                let (a, b) = (ids[offset + triangle[k] as usize], ids[offset + triangle[(k + 1) % 3] as usize]);
                if a != b {
                    *count.entry((a.min(b), a.max(b))).or_default() += 1;
                }
            }
        }
        offset += mesh.vertices.len();
    }
    count.values().filter(|&&n| n != 2).count()
}

fn meshes_of(graph: &ObjectGraph, faces_of: &[usize]) -> Vec<(native_saved_mesh::FaceMesh, bool)> {
    faces_of
        .iter()
        .map(|&face| match faces::mesh_face(graph, face) {
            Outcome::Rvt(mesh) => (mesh, false),
            Outcome::Own(mesh) => (mesh, true),
            other => panic!("face {face} non maillée : {other:?}"),
        })
        .collect()
}

/// Les deux faces de chaque arête partagée d'un solide de révolution fabriqué posent les mêmes sommets (à 1e-9 pied : les
/// données sont exactes), et le solide est fermé. `shared` : le nombre d'arêtes partagées (un cercle en compte deux, une
/// génératrice une).
fn assert_watertight(name: &str, (graph, faces_of): (ObjectGraph, Vec<usize>), shared: usize) -> Vec<(native_saved_mesh::FaceMesh, bool)> {
    let report = seams(&graph, &faces_of, 1e-9);
    assert_eq!(report.shared, shared, "{name} : {}", report.summary());
    assert_eq!(report.compared, shared, "{name} : {}", report.summary());
    assert!(report.cracks.is_empty() && report.aligned.is_empty(), "{name} : {} : {:?}", report.summary(), &report.cracks[..report.cracks.len().min(5)]);
    let meshes = meshes_of(&graph, &faces_of);
    assert_eq!(open_edges(&meshes.iter().map(|(mesh, _)| mesh).collect::<Vec<_>>()), 0, "{name} : le solide n'est pas fermé");
    meshes
}

#[test]
fn un_tronc_de_cone_et_ses_plans_ont_les_memes_sommets_sur_leurs_cercles() {
    // Quatre demi-cercles, deux génératrices. Le cône est maillé par ce module, et ses plans le sont aussi : rvt-rs garderait
    // aux plans leur polygone enregistré (tous les 15°), à 2,6 mm du cercle du cône pour un pied de rayon.
    let meshes = assert_watertight("tronc de cône", frustum(), 6);
    assert!(meshes.iter().all(|(_, ours)| *ours), "le cône et ses plans se maillent dans ce module : {:?}", meshes.iter().map(|(_, ours)| *ours).collect::<Vec<_>>());
}

#[test]
fn un_cylindre_maille_par_rvt_rs_et_un_cone_voisin_ont_les_memes_sommets() {
    // Le cercle commun : le cylindre est à rvt-rs (grille de `CHORD_ERROR`), le cône à ce module, qui reprend la grille.
    let meshes = assert_watertight("entonnoir", funnel(), 8 + 2);
    let ours: Vec<bool> = meshes.iter().map(|(_, ours)| *ours).collect();
    // Faces : demi-cylindres, demi-cônes, plan du bas, plan du haut.
    assert_eq!(ours, [false, false, true, true, true, true], "mailleurs des faces");
}

#[test]
fn un_cylindre_ferme_par_deux_plans_a_les_memes_sommets_sur_ses_cercles() {
    // Les plans touchent un cylindre : ce module les maille, sur la grille du cylindre (rvt-rs les affinerait sur la grille de
    // son profil par défaut, plus fine).
    let meshes = assert_watertight("tuyau", pipe(), 6);
    let ours: Vec<bool> = meshes.iter().map(|(_, ours)| *ours).collect();
    assert_eq!(ours, [false, false, true, true], "mailleurs des faces");
}

#[test]
fn une_dalle_a_trou_rond_et_son_cylindre_ont_les_memes_sommets_sur_le_trou() {
    for radius in [1.0, 0.3, 2.5] {
        let (graph, faces_of) = slab_with_round_hole(radius);
        let report = seams(&graph, &faces_of, 1e-9);
        // Les quatre demi-cercles, et les deux génératrices que se partagent les demi-cylindres.
        assert_eq!(report.shared, 6, "rayon {radius} : {}", report.summary());
        assert_eq!(report.compared, 6, "rayon {radius} : {}", report.summary());
        assert!(report.cracks.is_empty() && report.aligned.is_empty(), "rayon {radius} : {} : {:?}", report.summary(), &report.cracks[..report.cracks.len().min(5)]);
    }
}

/// Écart toléré entre deux sommets jumeaux des fichiers publics, en plus de celui que Revit met lui-même entre les deux
/// évaluations des points enregistrés de l'arête (jusqu'à 5e-4 pied dans RE1-Architecture : un sommet de maillage ne peut
/// pas être plus près de son jumeau que les points dont il vient) : 3e-4 pied, un dixième de millimètre. Les fentes qu'on
/// cherche se comptent en millimètres (0,003 pied pour la flèche de ce module), dix fois plus.
const SEAM_TOLERANCE: f64 = 3e-4;

/// La tolérance d'un fichier. Deux fichiers de Revit 2012 et 2013 (lus depuis que le lecteur commence à Revit 2012) ont, entre un
/// plan et une surface réglée, des sommets jumeaux à 3,2e-4 à 5,2e-4 pied (0,1 à 0,16 mm) l'un de l'autre :
/// `dynamo-nyc-site-2013.rvt` (une arête, 5,2e-4 pied) et `dynamo-solar-radiation-vasari2012.rvt` (une arête, trois sommets,
/// jusqu'à 4,9e-4 pied). 6e-4 pied pour eux seuls, dix fois moins que les fentes que l'essai cherche (0,003 pied).
fn seam_tolerance(name: &str) -> f64 {
    if matches!(name, "dynamo-nyc-site-2013.rvt" | "dynamo-solar-radiation-vasari2012.rvt") { 6e-4 } else { SEAM_TOLERANCE }
}

/// Les fichiers d'essai présents : les publics de `samples/` et celui de `tests/fixtures`.
fn seam_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(crate_path("samples")).into_iter().flatten().flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "rvt" || ext == "rfa" || ext == "rte") && !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with("._"))).collect();
    files.sort();
    files.push(crate_path("tests/fixtures/Revit_IFC5_Einhoven.rvt"));
    files.into_iter().filter(|path| path.exists()).collect()
}

/// Les raccords de tout un fichier : les nœuds `Geometry` de chaque élément et de chaque symbole de famille ; `None` si
/// le fichier ne se lit pas (Revit antérieur à 2012).
fn seams_of_file(path: &PathBuf, tolerance: f64) -> Option<Seams> {
    let mut file = open(path);
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
    let work = |_scene: &saved::Scene, _id: u64, graph: &ObjectGraph| seams(graph, &geometry_faces(graph), tolerance);
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
    let scan = saved::scan(&mut file, &wanted, threads, &work).ok()?;
    let mut total = Seams::default();
    for graph in scan.scene.symbols.values() {
        total.add(seams(graph, &geometry_faces(graph), tolerance));
    }
    for report in scan.results.into_values().flatten() {
        total.add(report);
    }
    Some(total)
}

/// Un couple de classes (`kind` : « CylSurf/SurfRev », une étoile marquant une face maillée par ce module) où les deux faces
/// sont maillées par rvt-rs seul, chacune sur la grille de sa propre surface : deux révolutions, une révolution et un
/// cylindre. Ce module n'y peut rien (il ne maille que les faces que rvt-rs refuse, et les plans qui les touchent) : le
/// rapport les compte, l'essai les tolère.
fn rvt_rs_grids(kind: &str) -> bool {
    kind.split('/').all(|class| class == "SurfRev" || class == "CylSurf")
}

/// Aucune fissure aux arêtes partagées des fichiers d'essai, entre deux faces dont l'une est maillée par ce module : un
/// plan contre un cylindre, un cône ou une surface d'Hermite contre un plan, une surface réglée contre n'importe quoi,
/// tous posent les mêmes sommets sur leur arête commune (voir `faces::mesh_face`, `refine::Grid`). Les T-jonctions
/// alignées (un sommet de plus d'un côté, sur la ligne de l'autre : aucune fente) ne se trouvent que contre une surface
/// réglée (les points de sa grille le long d'un côté droit, voir `tess::densify_along_isolines`) ou entre deux faces de
/// rvt-rs.
#[test]
fn les_fichiers_d_essai_ne_se_fissurent_pas_aux_aretes_partagees() {
    let (mut files, mut compared, mut theirs) = (0, 0, 0);
    for path in seam_files() {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let Some(report) = seams_of_file(&path, seam_tolerance(&name)) else { continue };
        eprintln!("{name} : {}", report.summary());
        files += 1;
        compared += report.compared;
        let kind_of = |crack: &String| crack.split(" : ").next().unwrap_or("").to_string();
        let ours: Vec<&String> = report.cracks.iter().filter(|crack| !rvt_rs_grids(&kind_of(crack))).collect();
        assert!(ours.is_empty(), "{name} : {} fissures où une face est du module : {:?}", ours.len(), &ours[..ours.len().min(5)]);
        theirs += report.cracks.len();
        let t_junctions: Vec<(&String, &usize)> = report.aligned.iter().filter(|(kind, _)| !rvt_rs_grids(kind) && !kind.contains("RuledSurf")).collect();
        assert!(t_junctions.is_empty(), "{name} : T-jonctions alignées : {t_junctions:?}");
        // Le contrôle lit presque toutes les arêtes : les autres n'ont pas de chemin de bord net (une face à fente de largeur
        // nulle, à spirale) et sont comptées dans `skipped`.
        assert!(report.compared * 100 >= report.shared * 97, "{name} : {}", report.summary());
    }
    if files > 0 {
        assert!(compared > 0);
        eprintln!("{files} fichiers, {compared} arêtes comparées, {theirs} fissures entre deux faces de rvt-rs");
    }
}

/// Les sommets que rvt-rs a posés sur une face sont exactement `grid` évaluée sur sa surface, rangée par rangée en v : la
/// grille que ce module reprend pour les faces voisines est celle des maillages (au bit près, à 1e-9 pied par prudence).
fn grid_is_the_mesh(graph: &ObjectGraph, face: usize, mesh: &native_saved_mesh::FaceMesh, grid: &Grid) -> bool {
    let Some(index) = faces::graph::target(graph, face, &graph.objects[face].fields["m_pSurf"]).ok().flatten() else { return false };
    let Ok(surface) = Surface::read(graph, index) else { return false };
    mesh.vertices.len() == grid.u.len() * grid.v.len() && mesh.vertices.iter().enumerate().all(|(k, vertex)| distance(*vertex, surface.eval(grid.u[k % grid.u.len()], grid.v[k / grid.u.len()])) < 1e-9)
}

/// Compte, dans les nœuds `Geometry` de `graph`, les cylindres et les révolutions maillés par rvt-rs dont la grille reprise est
/// celle du maillage, et ceux dont elle ne l'est pas : `[cylindres, révolutions, écarts]`.
fn grids_checked(graph: &ObjectGraph, face_list: &[usize]) -> [usize; 3] {
    let mut counts = [0; 3];
    for &face in face_list {
        let class = faces::surface_class(graph, face);
        let Outcome::Rvt(mesh) = faces::mesh_face(graph, face) else { continue };
        let grid = match class.as_str() {
            "CylSurf" => faces::cylinder_grid(graph, face),
            "SurfRev" => faces::revolution_grid(graph, face),
            _ => continue,
        };
        let Some(grid) = grid else {
            counts[2] += 1;
            continue;
        };
        counts[usize::from(class == "SurfRev")] += 1;
        counts[2] += usize::from(!grid_is_the_mesh(graph, face, &mesh, &grid));
    }
    counts
}

#[test]
fn la_grille_reprise_d_un_cylindre_est_celle_du_maillage_de_rvt_rs() {
    let (graph, faces_of) = pipe();
    assert_eq!(grids_checked(&graph, &faces_of), [2, 0, 0], "deux demi-cylindres, une grille chacun, égale à leur maillage");
    // Avec d'autres tailles : le pas angulaire, les mailles en hauteur et les points enregistrés changent, la grille les suit.
    for band in [Band::Cylinder { radius: 0.12, z: [0.0, 7.3] }, Band::Cylinder { radius: 40.0, z: [-1.0, 0.4] }] {
        let (graph, faces_of) = revolved(&[band]);
        assert_eq!(grids_checked(&graph, &faces_of), [2, 0, 0]);
    }
}

/// Sur les fichiers d'essai : chaque cylindre et chaque révolution que rvt-rs maille a une grille reprise, égale à son maillage.
#[test]
fn les_grilles_reprises_sont_celles_des_maillages_de_rvt_rs_dans_les_fichiers_d_essai() {
    let mut total = [0; 3];
    for name in ["RE1-Architecture.rvt", "SampleModel.rvt", "ConnectorTestR20.rvt", "DynamoSample_2024.rvt"] {
        let Some(path) = sample(name) else { continue };
        let mut file = open(&path);
        let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let work = |_scene: &saved::Scene, _id: u64, graph: &ObjectGraph| grids_checked(graph, &geometry_faces(graph));
        let Ok(scan) = saved::scan(&mut file, &wanted, 4, &work) else { continue };
        let mut counts = [0; 3];
        for graph in scan.scene.symbols.values() {
            let more = grids_checked(graph, &geometry_faces(graph));
            (0..3).for_each(|k| counts[k] += more[k]);
        }
        for more in scan.results.values().flatten() {
            (0..3).for_each(|k| counts[k] += more[k]);
        }
        assert_eq!(counts[2], 0, "{name} : {} grilles (cylindres, révolutions, écarts) : {counts:?}", counts[0] + counts[1]);
        (0..3).for_each(|k| total[k] += counts[k]);
    }
    if total != [0; 3] {
        assert!(total[0] > 0 && total[1] > 0, "cylindres et révolutions vérifiés : {total:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// Grilles : un axe ne grossit que s'il abaisse l'écart, et la grille intérieure tient toujours dans son plafond
// ---------------------------------------------------------------------------------------------

/// Entre deux demi-cercles de 50 pieds de rayon, la flèche des profils plafonne `nu` à 128 mailles (3,7 mm, un peu au-dessus de
/// `CHORD_ERROR`) ; l'écart du centre à la diagonale vient de la même corde, et doubler `nv` n'y change rien : `nv` reste à
/// une maille (une rangée de points au milieu), 128 × 2 × 2 = 512 triangles, au lieu des 32 768 d'une grille qui montait à
/// 128 sur les deux axes.
#[test]
fn une_surface_reglee_entre_deux_demi_cercles_de_50_pieds_ne_double_pas_v_pour_rien() {
    let arc = |z: f64| Curve::Arc { center: [0.0, 0.0, z], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 50.0, range: [0.0, PI] };
    let tube = surface(Shape::Ruled { first: arc(0.0), second: arc(20.0) }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    // Le contour porte ses points, comme ceux d'arêtes affinées avec leurs voisines (un tous les 1/128 de la demi-tour).
    let mesh = tess::mesh(&tube, &rectangle_with_points(128), true).expect("maillage");
    assert!(mesh.triangles.len() >= 256 && mesh.triangles.len() <= 700, "triangles : {}", mesh.triangles.len());
    // La flèche reste celle du plafond de 128 mailles : celle de la corde d'un arc de 50 pieds de rayon à π/128.
    assert!(worst_sag(&tube, &mesh) < 0.004, "flèche {}", worst_sag(&tube, &mesh));
    // Sans plafond atteint, la grille suit toujours la flèche : un demi-cercle de 5 pieds (voir plus haut) n'a pas changé.
    let small = surface(Shape::Ruled { first: Curve::Arc { center: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 5.0, range: [0.0, PI] }, second: Curve::Arc { center: [0.0, 0.0, 20.0], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], radius: 5.0, range: [0.0, PI] } }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mesh = tess::mesh(&small, &rectangle_with_points(64), true).expect("maillage");
    assert!(worst_sag(&small, &mesh) <= tess::CHORD_ERROR * 1.01, "flèche {}", worst_sag(&small, &mesh));
}

/// Même schéma pour une surface d'Hermite : une demi-sphère de 300 pieds de rayon (un demi-cylindre, ici) plafonne `nu` à 128 ;
/// `nv` ne baisse pas l'écart et reste à une maille (deux avec la rangée du milieu), au lieu de monter à 128.
#[test]
fn une_surface_d_hermite_plafonnee_en_u_ne_double_pas_v_pour_rien() {
    let radius = 300.0;
    let half_cylinder = |u: f64, v: f64, du: u32, dv: u32| -> [f64; 3] {
        let theta = PI * u;
        match (du, dv) {
            (0, 0) => [radius * theta.cos(), radius * theta.sin(), 40.0 * v],
            (1, 0) => [-radius * PI * theta.sin(), radius * PI * theta.cos(), 0.0],
            (0, 1) => [0.0, 0.0, 40.0],
            _ => [0.0; 3],
        }
    };
    let (us, vs) = (vec![0.0, 0.25, 0.5, 0.75, 1.0], vec![0.0, 1.0]);
    let nodes = hermite_nodes(&us, &vs, &half_cylinder);
    let hermite = surface(Shape::Hermite { us, vs, nodes }, [0.0; 3], IDENTITY, [[0.0, 0.0], [1.0, 1.0]]);
    let mesh = tess::mesh(&hermite, &rectangle(), true).expect("maillage");
    assert!(mesh.triangles.len() >= 256 && mesh.triangles.len() <= 1_000, "triangles : {}", mesh.triangles.len());
}

/// Les valeurs distinctes de `axis` des points (u, v) d'un maillage, triées.
fn distinct(uv: &[[f64; 2]], axis: usize) -> Vec<f64> {
    let mut values: Vec<f64> = uv.iter().map(|p| p[axis]).collect();
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    values
}

/// Le plus grand écart entre deux valeurs consécutives, relativement au plus petit.
fn gap_ratio(values: &[f64]) -> f64 {
    let gaps: Vec<f64> = values.windows(2).map(|pair| pair[1] - pair[0]).collect();
    gaps.iter().copied().fold(0.0, f64::max) / gaps.iter().copied().fold(f64::INFINITY, f64::min)
}

/// Un dôme de 200 pieds de rayon demande 256 mailles sur chaque axe : 255² = 65 025 points intérieurs, plus que
/// `MAX_INTERIOR_POINTS`. Le semis, rangée par rangée, s'arrêtait à la limite et laissait les vingt dernières rangées sans point
/// intérieur (des triangles de vingt mailles de long) ; la grille est désormais ramenée d'avance à ce que le plafond permet,
/// avec toutes ses rangées.
#[test]
fn la_grille_interieure_d_un_grand_dome_tient_dans_son_plafond_avec_toutes_ses_rangees() {
    let radius = 200.0;
    let profile = Curve::Arc { center: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 0.0, 1.0], radius, range: [0.0, FRAC_PI_2] };
    let dome = surface(Shape::Revolution { profile }, [0.0; 3], IDENTITY, [[0.0, 0.0], [2.0 * PI, FRAC_PI_2]]);
    let ring: Loop = vec![[0.0, 0.0], [2.0 * PI, 0.0], [2.0 * PI, FRAC_PI_2], [0.0, FRAC_PI_2]];
    let mesh = tess::mesh(&dome, &[ring], true).expect("maillage");
    let interior = mesh.uv.len() - 4;
    assert!(interior <= region::MAX_INTERIOR_POINTS, "points intérieurs : {interior}");
    // Une grille aussi fine : au moins 200 mailles sur chaque axe (le plafond en laisse 245).
    let rows = distinct(&mesh.uv, 1);
    assert!(rows.len() > 200, "rangées : {}", rows.len());
    // Aucune rangée ne manque : les écarts sont tous ceux d'une maille (la dernière rangée, contre le pôle, en est une).
    assert!(gap_ratio(&rows) < 1.5, "écart entre rangées : {} fois la maille", gap_ratio(&rows));
    assert!(rows.last().copied().unwrap_or(0.0) > FRAC_PI_2 - 1e-9);
}

/// `region::triangulate` éclaircit uniformément une grille qui dépasse `MAX_INTERIOR_POINTS` (ici 401 × 401 points), au lieu
/// de s'arrêter à la limite : toutes les rangées gardent leurs points, une sur deux.
#[test]
fn une_grille_trop_fine_est_eclaircie_et_non_coupee() {
    let knots: Vec<f64> = (0..=400).map(|k| f64::from(k) / 400.0).collect();
    let mesh = region::triangulate(&[vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]], [1.0, 1.0], Some((&knots, &knots))).expect("triangulation");
    assert!(mesh.points.len() - 4 <= region::MAX_INTERIOR_POINTS, "points intérieurs : {}", mesh.points.len() - 4);
    let rows = distinct(&mesh.points, 1);
    assert!(rows.len() > 150, "rangées : {}", rows.len());
    assert!(gap_ratio(&rows[..rows.len() - 1]) < 1.5, "écart entre rangées : {}", gap_ratio(&rows[..rows.len() - 1]));
    // La rangée la plus haute est au bord du carré, ou à une maille éclaircie de lui.
    assert!(rows[rows.len() - 2] > 1.0 - 3.0 / 400.0, "dernière rangée intérieure : {}", rows[rows.len() - 2]);
}

/// `refine_on` pose sur l'autre côté tous les points de la grille de rvt-rs, entre les points enregistrés, sans critère de
/// flèche : ceux d'une corde déjà fine aussi (le maillage de rvt-rs les a, l'autre face doit les avoir).
#[test]
fn une_arete_contre_un_cylindre_de_rvt_rs_prend_tous_les_points_de_sa_grille() {
    let cylinder = surface(Shape::Cylinder { radius: 2.0 }, [0.0; 3], IDENTITY, [[0.0, 0.0], [PI, 1.0]]);
    let plane = surface(Shape::Plane, [0.0; 3], IDENTITY, [[-3.0, -3.0], [3.0, 3.0]]);
    let fine: Vec<[f64; 2]> = (0..=90).map(|k| [PI * f64::from(k) / 90.0, 0.0]).collect();
    let in_plane: Vec<[f64; 2]> = fine.iter().map(|p| [2.0 * p[0].cos(), 2.0 * p[0].sin()]).collect();
    // Le contour du cylindre : le rectangle, avec les points enregistrés de son bord bas.
    let trim: Vec<[f64; 2]> = fine.iter().copied().chain([[PI, 1.0], [0.0, 1.0]]).collect();
    let grid = Grid::cylinder(2.0, &trim, tess::CHORD_ERROR, 1.0).expect("grille");
    // `refine` seul ne touche pas une arête déjà fine ; avec la grille, les points du pas de la flèche (7,6° ici) qui tombent
    // entre deux points enregistrés de 2° sont repris.
    assert!(refine([(&cylinder, &fine), (&plane, &in_plane)]).is_none());
    for grids in [[Some(&grid), None], [None, Some(&grid)]] {
        let sides = if grids[0].is_some() { [(&cylinder, fine.as_slice()), (&plane, in_plane.as_slice())] } else { [(&plane, in_plane.as_slice()), (&cylinder, fine.as_slice())] };
        let refined = refine_on(sides, grids).expect("la grille ajoute des points");
        let (on_cylinder, on_plane) = if grids[0].is_some() { (&refined[0], &refined[1]) } else { (&refined[1], &refined[0]) };
        // Tous les points de la grille entre 0 et π, et les enregistrés : rien d'autre.
        let mut expected: Vec<f64> = grid.u.iter().copied().chain(fine.iter().map(|p| p[0])).collect();
        expected.sort_by(f64::total_cmp);
        expected.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
        let got: Vec<f64> = on_cylinder.iter().map(|p| p[0]).collect();
        assert_eq!(got.len(), expected.len(), "points repris");
        assert!(got.iter().zip(&expected).all(|(a, b)| (a - b).abs() < 1e-12));
        for (a, b) in on_cylinder.iter().zip(on_plane) {
            assert!(distance(cylinder.eval(a[0], a[1]), plane.eval(b[0], b[1])) < 1e-9, "points différents : {a:?} {b:?}");
        }
    }
    // Un côté enregistré qui n'est pas une isoligne du cylindre (une ellipse) ne reçoit rien.
    let slanted: Vec<[f64; 2]> = [0.0, FRAC_PI_2, PI].iter().map(|u: &f64| [*u, 0.5 + u.cos() * 0.1]).collect();
    assert!(refine_on([(&cylinder, &slanted), (&plane, &[[2.0, 0.0], [0.0, 2.0], [-2.0, 0.0]])], [Some(&grid), None]).is_none());
}
