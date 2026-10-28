//! Maillage d'une face enregistrée : sa surface, ses boucles de contour, puis la région du plan
//! (u, v) qu'elles délimitent, triangulée et reportée sur la surface (voir `region`).

use anyhow::{Context, Result, ensure};
use rvt::research::native_parameters::ObjectGraph;

use super::graph::{required, target};
use super::loops;
use super::math::{V3, distance, dot, finite, norm, sub};
use super::region::{self, Loop, Uv};
use super::surface::{Shape, Surface};

/// Flèche voulue entre la surface et ses triangles, en pieds : 0,003 pied, un millimètre, à l'échelle d'un bâtiment.
/// C'était 0,001 pied (celle de rvt-rs pour ses cylindres, trois dixièmes de millimètre), appliquée aussi aux détails des
/// familles. Mesuré sur les 32 fichiers d'essai (`viewer-bim-travail/scaling/step8`) : 0,003 pied divise les triangles des
/// fichiers denses par 1,3 (rac, SampleModel) à 3,2 (Vignette-04), 6,7 millions de triangles en tout deviennent 4,3 ; à
/// l'écran, un panneau ondulé de 4 m vu à 1 m et les poteaux de rac_advanced sont identiques à l'œil (captures dans ce
/// dossier). Les cylindres de rvt-rs suivent la même flèche (`faces::mesh_face`).
pub const CHORD_ERROR: f64 = 0.003;

/// Pas angulaire maximal d'une surface qui tourne : trente degrés, pour que les normales
/// interpolées restent fidèles même sur un rayon minuscule.
const MAX_TURN: f64 = std::f64::consts::FRAC_PI_6;

/// Nombre maximal de mailles sur un axe de la grille intérieure (voir `fit_interior` pour le total des deux axes).
const MAX_CELLS: usize = 256;

/// Longueur maximale d'une maille de la grille, en pieds (le plus grand pas d'arête de rvt-rs pour
/// ses cylindres). Même sans courbure, des points intérieurs sont nécessaires : sans eux, la
/// triangulation relie les sommets des deux extrémités d'un tube par de longs triangles qui
/// traversent son intérieur au lieu d'en suivre la paroi.
const MAX_CELL: f64 = 1.0;

/// Le maillage d'une face : sommets, normales (un vecteur nul quand la normale est indéfinie) et
/// triangles, dans le repère du graphe (pieds).
#[derive(Debug, Clone)]
pub struct FaceGeometry {
    /// Le (u, v) de chaque sommet, dans le paramétrage de la surface.
    pub uv: Vec<[f64; 2]>,
    pub vertices: Vec<V3>,
    pub normals: Vec<V3>,
    pub triangles: Vec<[u32; 3]>,
    /// Sens extérieur effectif de la surface : vrai si la normale suit `Su × Sv`.
    pub forward: bool,
}

/// Maille la face d'indice `face` à partir de ses propres données. `Ok(None)` : un plan sans
/// aucun contour, que Revit ne dessine pas (voir `faces::MESH_REFERENCE_FACES`).
pub fn tessellate(graph: &ObjectGraph, face: usize) -> Result<Option<FaceGeometry>> {
    let object = graph.objects.get(face).context("face : objet absent")?;
    ensure!(object.class_name == "Face", "ce n'est pas une face");
    let surface_index = required(graph, face, &object.fields["m_pSurf"], "surface de la face")?;
    let surface = Surface::read(graph, surface_index)?;

    let rings = match loops::read(graph, face, &surface)? {
        Some(rings) => rings,
        // Un plan sans contour n'a aucune région à mailler (voir `faces::MESH_REFERENCE_FACES`). Une
        // surface courbe sans arête (une demi-sphère, un demi-tore) est tout son pavé (u, v).
        None if surface.is_plane() && !super::MESH_REFERENCE_FACES => return Ok(None),
        None => {
            let [[u0, v0], [u1, v1]] = surface.envelope;
            ensure!(u1 > u0 && v1 > v0, "enveloppe dégénérée");
            vec![vec![[u0, v0], [u1, v0], [u1, v1], [u0, v1]]]
        }
    };
    let flags = object.fields["m_faceFlags_v9"].as_u64().context("drapeaux de la face absents")?;
    let forward = surface.orient ^ (flags & 2 != 0);
    Ok(Some(mesh(&surface, &rings, forward)?))
}

/// Triangule `rings` sur `surface`.
pub fn mesh(surface: &Surface, rings: &[Loop], forward: bool) -> Result<FaceGeometry> {
    let (bounds, metric) = {
        let points = rings.iter().flatten();
        let min = |axis: usize| points.clone().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
        let max = |axis: usize| points.clone().map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max);
        let bounds = [[min(0), min(1)], [max(0), max(1)]];
        ensure!(bounds[1][0] > bounds[0][0] && bounds[1][1] > bounds[0][1], "contour sans étendue");
        (bounds, surface.metric(bounds))
    };

    let (us, vs) = match surface.shape {
        Shape::Plane => (Vec::new(), Vec::new()),
        Shape::Ruled { .. } => ruled_knots(surface, bounds),
        Shape::Hermite { .. } => hermite_knots(surface, bounds),
        _ => fit_interior(axis_knots(surface, bounds, 0), axis_knots(surface, bounds, 1)),
    };
    let grid = (!us.is_empty()).then_some((us.as_slice(), vs.as_slice()));
    // Sur une surface courbe, la triangulation voit les mailles de la grille comme des carrés
    // (échelle : une maille = 1) et non les longueurs réelles : sur un tube long et fin, les vraies
    // longueurs la pousseraient à relier des sommets éloignés d'un demi-tour par de longs triangles.
    let metric = match grid {
        Some((us, vs)) => [(us.len() - 1) as f64 / (bounds[1][0] - bounds[0][0]), (vs.len() - 1) as f64 / (bounds[1][1] - bounds[0][1])],
        None => metric,
    };
    // Sur une surface réglée aux isolignes droites, les côtés du contour qui courent le long d'une isoligne reçoivent
    // les points de la grille : sans eux, la première rangée intérieure se relie à des côtés qui n'ont que leurs
    // deux extrémités, et les triangles de bord s'écartent de la surface de bien plus que la flèche voulue.
    let densified;
    let rings = match grid {
        Some((us, vs)) if straight_ruled(surface) => {
            densified = rings.iter().map(|ring| densify_along_isolines(ring, us, vs)).collect::<Vec<_>>();
            densified.as_slice()
        }
        _ => rings,
    };
    let flat = region::triangulate(rings, metric, grid)?;

    let mut vertices = Vec::with_capacity(flat.points.len());
    let mut normals = Vec::with_capacity(flat.points.len());
    for &[u, v] in &flat.points {
        let p = surface.eval(u, v);
        ensure!(finite(p), "sommet non fini");
        vertices.push(p);
        normals.push(match surface.normal(u, v) {
            Some(n) if forward => n,
            Some(n) => [-n[0], -n[1], -n[2]],
            None => [0.0; 3],
        });
    }
    let triangles = flat.triangles.iter().map(|t| if forward { *t } else { [t[0], t[2], t[1]] }).collect();
    Ok(FaceGeometry { uv: flat.points, vertices, normals, triangles, forward })
}

/// Les abscisses (axe 0, u) ou ordonnées (axe 1, v) d'une grille assez fine pour que le milieu de
/// chaque maille reste à moins de `CHORD_ERROR` de la corde, sur cinq lignes d'échantillonnage de
/// l'autre axe. Les surfaces qui tournent ont au moins un pas de trente degrés.
fn axis_knots(surface: &Surface, bounds: [[f64; 2]; 2], axis: usize) -> Vec<f64> {
    let (lo, hi) = (bounds[0][axis], bounds[1][axis]);
    let rotates = axis == 0 && matches!(surface.shape, Shape::Cylinder { .. } | Shape::Cone { .. } | Shape::Revolution { .. });
    let mut cells = if rotates { (((hi - lo) / MAX_TURN).ceil() as usize).max(1) } else { 1 };
    let other = 1 - axis;
    let lines: Vec<f64> = (0..5).map(|k| bounds[0][other] + (bounds[1][other] - bounds[0][other]) * k as f64 / 4.0).collect();
    let point = |value: f64, line: f64| if axis == 0 { surface.eval(value, line) } else { surface.eval(line, value) };
    while cells < MAX_CELLS {
        let mut worst = 0.0f64;
        for &line in &lines {
            for cell in 0..cells {
                let a = lo + (hi - lo) * cell as f64 / cells as f64;
                let b = lo + (hi - lo) * (cell + 1) as f64 / cells as f64;
                let (pa, pb, pm) = (point(a, line), point(b, line), point((a + b) / 2.0, line));
                let deviation = (0..3).map(|k| (pm[k] - (pa[k] + pb[k]) / 2.0).powi(2)).sum::<f64>().sqrt();
                worst = worst.max(deviation);
            }
        }
        if !(worst > CHORD_ERROR) {
            break;
        }
        cells *= 2;
    }
    // Longueur de l'axe sur la surface : le plus long des échantillons.
    let length = lines
        .iter()
        .map(|&line| {
            let samples: Vec<V3> = (0..=32).map(|k| point(lo + (hi - lo) * k as f64 / 32.0, line)).collect();
            samples.windows(2).map(|pair| distance(pair[0], pair[1])).sum::<f64>()
        })
        .fold(0.0, f64::max);
    let cells = cells.max((length / MAX_CELL).ceil() as usize).clamp(1, MAX_CELLS);
    (0..=cells).map(|k| lo + (hi - lo) * k as f64 / cells as f64).collect()
}

/// Ramène une grille de `axis_knots` à `region::MAX_INTERIOR_POINTS` points intérieurs au plus, (mailles de u − 1) ×
/// (mailles de v − 1) : 256 mailles sur chaque axe (un dôme ou une révolution de 40 pieds de rayon et plus) en font 65 025,
/// et la région aurait été semée rangée par rangée jusqu'à la limite, les dernières sans aucun point intérieur (de longs
/// triangles bien au-delà de la flèche). Les deux axes perdent le même nombre de mailles quand ils dépassent tous deux la
/// racine de la limite ; sinon seul le plus fin cède. Les abscisses restent uniformes entre les mêmes bornes.
fn fit_interior(us: Vec<f64>, vs: Vec<f64>) -> (Vec<f64>, Vec<f64>) {
    let (cells_u, cells_v) = (us.len().saturating_sub(1), vs.len().saturating_sub(1));
    if cells_u.saturating_sub(1) * cells_v.saturating_sub(1) <= region::MAX_INTERIOR_POINTS {
        return (us, vs);
    }
    let root = (region::MAX_INTERIOR_POINTS as f64).sqrt().floor() as usize;
    let (cells_u, cells_v) = match (cells_u - 1 > root, cells_v - 1 > root) {
        (true, true) => (root + 1, root + 1),
        (true, false) => (region::MAX_INTERIOR_POINTS / (cells_v - 1).max(1) + 1, cells_v),
        _ => (cells_u, region::MAX_INTERIOR_POINTS / (cells_u - 1).max(1) + 1),
    };
    let uniform = |knots: &[f64], cells: usize| {
        let (lo, hi) = (knots[0], knots[knots.len() - 1]);
        (0..=cells).map(|k| lo + (hi - lo) * k as f64 / cells as f64).collect::<Vec<_>>()
    };
    (uniform(&us, cells_u), uniform(&vs, cells_v))
}

/// Nombre maximal de mailles sur un axe d'une surface réglée : 128 × 128 mailles (32 768 triangles au plus par
/// face) restent sous `region::MAX_INTERIOR_POINTS`, au-delà duquel la grille serait élaguée. Une face qui demande
/// davantage pour sa flèche (un paraboloïde de 100 pieds gauchi de 100 pieds) garde ce plafond.
const MAX_RULED_CELLS: usize = 128;

/// Les pires écarts entre une surface réglée et ses triangles, sur une grille de `nu` × `nv` mailles, en pieds :
/// la flèche des isolignes en u (profils courbes), celle des isolignes en v (droites pour une surface réglée :
/// nulle, par principe), et l'écart de la normale entre le centre d'une maille et le plan de chacun de ses deux
/// découpages en triangles (une surface réglée entre deux droites gauches se gauchit : un paraboloïde
/// hyperbolique). Mesurés sur cinq mailles par axe, comme `axis_knots` le fait sur cinq lignes.
fn ruled_deviation(surface: &Surface, bounds: [[f64; 2]; 2], nu: usize, nv: usize) -> (f64, f64, f64) {
    grid_deviation(surface, bounds, nu, nv, 5)
}

/// `ruled_deviation` sur `samples` × `samples` mailles réparties sur la grille (5 pour une surface réglée), ou sur toutes
/// celles qu'elle a quand elle en a moins.
fn grid_deviation(surface: &Surface, bounds: [[f64; 2]; 2], nu: usize, nv: usize, samples: usize) -> (f64, f64, f64) {
    let pick = |count: usize, k: usize| if count <= 1 { 0 } else { ((count - 1) * k + (samples - 1) / 2) / (samples - 1) };
    let (mut along_u, mut along_v, mut diagonal) = (0.0f64, 0.0f64, 0.0f64);
    let at = |axis: usize, index: usize, count: usize| bounds[0][axis] + (bounds[1][axis] - bounds[0][axis]) * index as f64 / count as f64;
    for ku in 0..samples {
        for kv in 0..samples {
            let (i, j) = (pick(nu, ku), pick(nv, kv));
            let (u0, u1, v0, v1) = (at(0, i, nu), at(0, i + 1, nu), at(1, j, nv), at(1, j + 1, nv));
            let (um, vm) = ((u0 + u1) / 2.0, (v0 + v1) / 2.0);
            let (p00, p10, p01, p11) = (surface.eval(u0, v0), surface.eval(u1, v0), surface.eval(u0, v1), surface.eval(u1, v1));
            let middle = |a: V3, b: V3| [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0, (a[2] + b[2]) / 2.0];
            // La flèche d'une isoligne : le milieu de l'arc contre le milieu de la corde.
            along_u = along_u.max(distance(surface.eval(um, v0), middle(p00, p10))).max(distance(surface.eval(um, v1), middle(p01, p11)));
            along_v = along_v.max(distance(surface.eval(u0, vm), middle(p00, p01))).max(distance(surface.eval(u1, vm), middle(p10, p11)));
            // Le centre contre les deux diagonales, sur la normale (un décalage dans le plan tangent n'est pas
            // un écart de la forme : une surface réglée entre deux droites coplanaires est un plan).
            let center = surface.eval(um, vm);
            let normal = surface.normal(um, vm);
            for diagonal_middle in [middle(p00, p11), middle(p10, p01)] {
                let offset = sub(center, diagonal_middle);
                let gap = match normal {
                    Some(n) => dot(offset, n).abs(),
                    None => norm(offset),
                };
                diagonal = diagonal.max(gap);
            }
        }
    }
    (along_u, along_v, diagonal)
}

/// Les deux profils de la surface sont des droites (ou un point) : toutes ses isolignes sont droites, et des
/// points ajoutés le long d'un côté de contour qui en est une sont alignés avec ses extrémités (aucun écart avec la
/// face voisine, qui garde sa corde).
fn straight_ruled(surface: &Surface) -> bool {
    use super::curve::Curve;
    match &surface.shape {
        Shape::Ruled { first, second } => [first, second].iter().all(|curve| matches!(curve, Curve::Line { .. } | Curve::Point(_))),
        _ => false,
    }
}

/// `ring` avec, sur chacun de ses côtés qui court le long d'une isoligne (u ou v constant), les abscisses de la
/// grille comprises strictement entre ses extrémités.
fn densify_along_isolines(ring: &[Uv], us: &[f64], vs: &[f64]) -> Vec<Uv> {
    let span = |knots: &[f64]| knots.last().unwrap_or(&1.0) - knots.first().unwrap_or(&0.0);
    let (eps_u, eps_v) = (span(us) * 1e-9, span(vs) * 1e-9);
    let mut out = Vec::with_capacity(ring.len() * 2);
    for (i, &a) in ring.iter().enumerate() {
        let b = ring[(i + 1) % ring.len()];
        out.push(a);
        let (knots, axis) = if (a[1] - b[1]).abs() <= eps_v {
            (us, 0)
        } else if (a[0] - b[0]).abs() <= eps_u {
            (vs, 1)
        } else {
            continue;
        };
        let (lo, hi) = (a[axis].min(b[axis]), a[axis].max(b[axis]));
        let mut between: Vec<f64> = knots.iter().copied().filter(|k| *k > lo + span(knots) * 1e-9 && *k < hi - span(knots) * 1e-9).collect();
        if a[axis] > b[axis] {
            between.reverse();
        }
        for k in between {
            out.push(if axis == 0 { [k, a[1]] } else { [a[0], k] });
        }
    }
    out
}

/// La grille d'une surface réglée : la plus grossière dont les triangles restent à `CHORD_ERROR` de la
/// surface. Une surface réglée entre deux droites coplanaires est un plan (deux triangles suffisent, quelle
/// que soit sa taille) ; entre deux droites gauches, la flèche du gauchissement décroît comme 1 / (nu · nv) ;
/// entre des courbes, celle des profils comme 1 / nu². Revit (et rvt-rs, qui prend une maille par pied du plus long
/// profil de toute la composante connexe) en mettait 130 sur 130 pour une dalle de 40 mètres : 33 000 triangles pour
/// une face plane, et 19,6 millions pour les 953 éléments de Vignette-04.
///
/// Un axe ne se double que si cela abaisse l'écart qui le concerne : la flèche des profils ne dépend que de `nu`, celle
/// de la corde d'un profil courbe se retrouve aussi dans l'écart du centre à la diagonale, que `nv` ne change pas (deux
/// demi-cercles de 50 pieds de rayon plafonnent `nu` à 128 avec 3,7 mm de flèche : doubler `nv` jusqu'à 128 aussi
/// aurait mis 32 768 triangles là où 512 donnent le même écart).
fn ruled_knots(surface: &Surface, bounds: [[f64; 2]; 2]) -> (Vec<f64>, Vec<f64>) {
    let (mut nu, mut nv) = (1usize, 1usize);
    loop {
        let (along_u, along_v, diagonal) = ruled_deviation(surface, bounds, nu, nv);
        if !(along_u.max(along_v).max(diagonal) > CHORD_ERROR) {
            break;
        }
        // Les axes à doubler, dans l'ordre : les flèches d'isoligne se résolvent par leur axe ; celle du gauchissement par
        // l'axe qui a le moins de mailles.
        let mut order: Vec<bool> = Vec::with_capacity(4);
        if along_u > CHORD_ERROR {
            order.push(true);
        }
        if along_v > CHORD_ERROR {
            order.push(false);
        }
        order.extend(if nu <= nv { [true, false] } else { [false, true] });
        // Le premier qui peut grossir et dont le doublement abaisse l'écart qui le concerne (celui de son isoligne et
        // celui du gauchissement) ; aucun : la grille ne s'améliore plus, on s'arrête.
        let mut doubled = false;
        for u_axis in order {
            let (next_u, next_v) = if u_axis { (nu * 2, nv) } else { (nu, nv * 2) };
            if (if u_axis { nu } else { nv }) >= MAX_RULED_CELLS {
                continue;
            }
            let after = ruled_deviation(surface, bounds, next_u, next_v);
            let (before_axis, after_axis) = if u_axis { (along_u.max(diagonal), after.0.max(after.2)) } else { (along_v.max(diagonal), after.1.max(after.2)) };
            if after_axis < before_axis * IMPROVES {
                (nu, nv) = (next_u, next_v);
                doubled = true;
                break;
            }
        }
        if !doubled {
            break;
        }
    }
    // Une grille qui n'a qu'une maille sur un axe n'a aucun point intérieur : si l'autre est découpée, on garde une
    // ligne de points au milieu pour que les triangles la suivent.
    if nu > 1 {
        nv = nv.max(2);
    }
    if nv > 1 {
        nu = nu.max(2);
    }
    let knots = |axis: usize, count: usize| (0..=count).map(|k| bounds[0][axis] + (bounds[1][axis] - bounds[0][axis]) * k as f64 / count as f64).collect::<Vec<_>>();
    (knots(0, nu), knots(1, nv))
}

/// Un doublement de mailles « abaisse » l'écart quand il le ramène sous cette part de sa valeur : doubler une flèche de
/// corde la divise par quatre, celle du gauchissement par deux ; moins de 10 % de gain, c'est le bruit de l'échantillon (les
/// cinq mailles mesurées changent avec la grille), non un effet du doublement.
const IMPROVES: f64 = 0.9;

/// Flèche voulue, en pieds, pour une surface d'Hermite (`Shape::Hermite`) : 0,01 pied, trois millimètres. Ces surfaces
/// libres (les panneaux de toiture de Vignette-04, la coque de `ShellFamily.rfa`, les deux sculptures `DirectShape` de
/// `revit-curtainwall-byprofile_v21`) sont courbes dans toute leur étendue : le nombre de mailles croît comme
/// 1 / √flèche sur chaque axe, donc les triangles comme 1 / flèche. Elle reste à 0,01 pied quand `CHORD_ERROR` passe à
/// 0,003 : à cette flèche-là, une sculpture dépasserait le plafond d'un élément. Mesuré sur les fichiers d'essai, à la
/// flèche générale de 0,001 pied d'alors :
///
/// | flèche | sculpture DirectShape (chacune) | Vignette-04 (budget : 3 millions) |
/// | --- | --- | --- |
/// | 0,001 pied (l'ancienne `CHORD_ERROR`) | plus de 250 000 triangles : refusée, montrée par sa boîte | 2,94 millions, et 10 éléments en boîte (garde-fou de 5 millions de triangles maillés) |
/// | 0,005 pied | 232 956 triangles, 93 % du plafond d'un élément | 2,85 millions |
/// | 0,01 pied | 128 000 triangles | 2,75 millions |
///
/// Les normales viennent de la surface, par sommet : l'ombrage reste lisse même avec des facettes à trois millimètres.
pub const HERMITE_CHORD_ERROR: f64 = 0.01;

/// Mailles d'une surface d'Hermite sur chaque axe, au plus `MAX_RULED_CELLS` : le moins de mailles dont les triangles
/// restent à `HERMITE_CHORD_ERROR` de la surface. Les écarts se mesurent sur seize mailles par axe ; chaque axe grossit
/// comme la racine de l'écart qu'il doit rattraper (la flèche d'une corde décroît comme le carré de sa longueur), et ne
/// grossit que si cela abaisse cet écart : un axe dont le grossissement n'y change rien (la flèche vient de l'autre, ou
/// l'autre a atteint son plafond) est figé, au lieu de monter jusqu'à `MAX_RULED_CELLS` pour rien.
fn hermite_knots(surface: &Surface, bounds: [[f64; 2]; 2]) -> (Vec<f64>, Vec<f64>) {
    let Shape::Hermite { us, vs, .. } = &surface.shape else { return (Vec::new(), Vec::new()) };
    // Au départ, une maille par maille de la grille d'Hermite que le contour recouvre.
    let spans = |knots: &[f64], axis: usize| {
        let (lo, hi) = (bounds[0][axis], bounds[1][axis]);
        knots.iter().filter(|k| **k > lo + (hi - lo) * 1e-9 && **k < hi - (hi - lo) * 1e-9).count() + 1
    };
    // Au plus `MAX_RULED_CELLS` : une grille de plus de nœuds ne se maille pas plus finement (et `clamp` plus bas exige min ≤ max).
    let (mut nu, mut nv) = (spans(us, 0).min(MAX_RULED_CELLS), spans(vs, 1).min(MAX_RULED_CELLS));
    let mut frozen = [false; 2];
    let mut deviation = grid_deviation(surface, bounds, nu, nv, 16);
    for _ in 0..16 {
        let (along_u, along_v, diagonal) = deviation;
        let wanted = |current: usize, deviation: f64| if deviation > HERMITE_CHORD_ERROR { ((current as f64) * (deviation / HERMITE_CHORD_ERROR).sqrt() * 1.05).ceil() as usize } else { current };
        // L'écart de la normale au centre d'une maille se résout par les deux axes.
        let next_u = if frozen[0] { nu } else { wanted(nu, along_u.max(diagonal)).clamp(nu, MAX_RULED_CELLS) };
        let next_v = if frozen[1] { nv } else { wanted(nv, along_v.max(diagonal)).clamp(nv, MAX_RULED_CELLS) };
        if (next_u, next_v) == (nu, nv) {
            break;
        }
        // Chaque axe est essayé seul : il est gardé s'il abaisse l'écart qui le concerne, figé sinon.
        let (mut kept_u, mut kept_v) = (nu, nv);
        if next_u != nu {
            let after = grid_deviation(surface, bounds, next_u, nv, 16);
            if after.0.max(after.2) < along_u.max(diagonal) * IMPROVES {
                kept_u = next_u;
            } else {
                frozen[0] = true;
            }
        }
        if next_v != nv {
            let after = grid_deviation(surface, bounds, nu, next_v, 16);
            if after.1.max(after.2) < along_v.max(diagonal) * IMPROVES {
                kept_v = next_v;
            } else {
                frozen[1] = true;
            }
        }
        if (kept_u, kept_v) == (nu, nv) {
            continue;
        }
        (nu, nv) = (kept_u, kept_v);
        deviation = grid_deviation(surface, bounds, nu, nv, 16);
    }
    // Comme pour une surface réglée : jamais une seule maille sur un axe dont l'autre est découpé.
    if nu > 1 {
        nv = nv.max(2);
    }
    if nv > 1 {
        nu = nu.max(2);
    }
    let knots = |axis: usize, count: usize| (0..=count).map(|k| bounds[0][axis] + (bounds[1][axis] - bounds[0][axis]) * k as f64 / count as f64).collect::<Vec<_>>();
    (knots(0, nu), knots(1, nv))
}

/// Vrai si `face` est un plan sans aucune boucle de contour.
pub fn is_unbounded_plane(graph: &ObjectGraph, face: usize) -> bool {
    let fields = &graph.objects[face].fields;
    let no_loop = matches!(target(graph, face, &fields["m_pFirstLoop"]), Ok(None));
    let plane = target(graph, face, &fields["m_pSurf"]).ok().flatten().is_some_and(|surface| graph.objects[surface].class_name == "Plane");
    no_loop && plane
}
