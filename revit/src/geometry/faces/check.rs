//! Contrôles de la qualité du maillage des faces, pour les essais et `examples/faces.rs` (rien
//! n'y est appelé par la lecture d'un fichier) :
//!
//! * `edge_fit` : chaque arête enregistrée porte les mêmes points de l'espace vus des deux faces
//!   qu'elle sépare, chacun dans le (u, v) de sa face. Évaluer les deux surfaces à ces (u, v) doit
//!   redonner le même point : c'est la mesure de l'exactitude des formules de surface, contre les
//!   propres points de Revit ;
//! * `orientation` : deux triangles voisins d'une surface orientable parcourent leur arête commune
//!   en sens opposés ; deux parcours dans le même sens trahissent une face retournée.

use std::collections::{BTreeMap, HashMap};

use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_saved_mesh::{Primitive, face as rvt_face, pointer};

use super::graph::{point2, required, target};
use super::math::{cross, distance, dot, norm, sub};
use super::surface::Surface;
use super::tess;

/// Écart entre les deux évaluations d'une arête.
#[derive(Debug, Clone, Default)]
pub struct EdgeFit {
    pub samples: usize,
    /// Plus grand écart, en pieds.
    pub worst: f64,
    /// Échantillons à plus d'un millimètre (0,00328 pied).
    pub over_millimetre: usize,
    pub sum: f64,
}

/// Ajuste les points d'arêtes de `graph`, regroupés par couple de classes de surfaces
/// (`CylSurf/Plane`).
pub fn edge_fit(graph: &ObjectGraph, fits: &mut BTreeMap<String, EdgeFit>) {
    let mut cache: HashMap<usize, Option<Surface>> = HashMap::new();
    let mut surface_of = |face: usize| -> Option<(String, Surface)> {
        let index = target(graph, face, &graph.objects[face].fields["m_pSurf"]).ok().flatten()?;
        let name = graph.objects[index].class_name.clone();
        let surface = cache.entry(index).or_insert_with(|| Surface::read(graph, index).ok()).clone()?;
        Some((name, surface))
    };
    for (edge, object) in graph.objects.iter().enumerate().filter(|(_, o)| o.class_name == "Edge") {
        let Some(pair) = object.fields["m_pFace"].as_array().filter(|p| p.len() == 2) else { continue };
        let faces: Vec<Option<usize>> = pair.iter().map(|p| pointer(graph, edge, p).ok().flatten()).collect();
        let (Some(a), Some(b)) = (faces[0], faces[1]) else { continue };
        let (Some((name_a, surface_a)), Some((name_b, surface_b))) = (surface_of(a), surface_of(b)) else { continue };
        let Some(ends) = object.fields["m_firstAndLastEdgePnts"].as_array().filter(|e| e.len() == 2) else { continue };
        let Some(interior) = object.fields["m_interiorEdgePnts"].as_array() else { continue };
        let key = if name_a <= name_b { format!("{name_a}/{name_b}") } else { format!("{name_b}/{name_a}") };
        let fit = fits.entry(key).or_default();
        for sample in std::iter::once(&ends[0]).chain(interior).chain(std::iter::once(&ends[1])) {
            let (Ok(uv_a), Ok(uv_b)) = (point2(&sample["uv"][0]), point2(&sample["uv"][1])) else { continue };
            let gap = distance(surface_a.eval(uv_a[0], uv_a[1]), surface_b.eval(uv_b[0], uv_b[1]));
            if !gap.is_finite() {
                continue;
            }
            fit.samples += 1;
            fit.worst = fit.worst.max(gap);
            fit.sum += gap;
            fit.over_millimetre += usize::from(gap > 0.00328);
        }
    }
}

/// Parcours d'arêtes dans le même sens, parmi les arêtes partagées par deux triangles.
#[derive(Debug, Clone, Copy, Default)]
pub struct Orientation {
    /// Arêtes parcourues dans les deux sens (une fois chacun) : cohérentes.
    pub opposed: usize,
    /// Arêtes parcourues deux fois dans le même sens : une des deux faces est retournée.
    pub same: usize,
}

/// Compte, entre primitives (`ours[i]` dit si la primitive `i` vient de ce module), les arêtes
/// cohérentes ou non ; `[(toutes), (au moins une primitive de ce module)]`. Les sommets sont
/// soudés au dixième de millimètre. Les arêtes ne sont comparées qu'au sein d'un même corps (même symbole placé, même
/// nœud `Geometry` ou `GPolyMesh`) : c'est là qu'une face retournée se voit. Deux corps qui se touchent ou se recouvrent
/// (une plaque contre un panneau, dans une famille de RE1-Architecture) parcourent leurs arêtes communes comme Revit les
/// a écrites, dans le même sens ou non, et ce n'est pas une faute de maillage ; ces coïncidences changent d'ailleurs
/// avec la flèche des cylindres voisins, qui ajoute ou non un troisième parcours à l'arête.
pub fn orientation(primitives: &[Primitive], ours: &[bool]) -> [Orientation; 2] {
    let key = |p: [f64; 3]| [(p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64, (p[2] * 1e4).round() as i64];
    // (corps, arête non orientée) → [parcours a→b, parcours b→a], avec les primitives concernées.
    let mut edges: HashMap<(Option<u64>, usize, [i64; 3], [i64; 3]), ([u32; 2], bool)> = HashMap::new();
    for (index, primitive) in primitives.iter().enumerate() {
        for triangle in &primitive.triangles {
            let corners = triangle.map(|c| key(primitive.vertices[c as usize]));
            for k in 0..3 {
                let (from, to) = (corners[k], corners[(k + 1) % 3]);
                if from == to {
                    continue;
                }
                let (low, high, direction) = if from < to { (from, to, 0) } else { (to, from, 1) };
                let entry = edges.entry((primitive.source_owner_id, primitive.object_index, low, high)).or_insert(([0, 0], false));
                entry.0[direction] += 1;
                entry.1 |= ours[index];
            }
        }
    }
    let mut result = [Orientation::default(); 2];
    for (forward_backward, ours_here) in edges.into_values() {
        let kind = match forward_backward {
            [1, 1] => 0,
            [forward, 0] | [0, forward] if forward >= 2 => 1,
            _ => continue,
        };
        for (slot, applies) in result.iter_mut().zip([true, ours_here]) {
            if applies {
                if kind == 0 {
                    slot.opposed += 1;
                } else {
                    slot.same += 1;
                }
            }
        }
    }
    result
}

/// Écart entre les triangles d'une face de ce module et sa surface : au centre de chaque
/// triangle, distance, le long de la normale, entre le centre (dans l'espace) et le point de la
/// surface au (u, v) moyen.
/// Rend `(écart maximal, nombre de triangles à plus de 1 mm)` ; `None` si la face ne se maille pas
/// par ce module.
pub fn chord_deviation(graph: &ObjectGraph, face: usize) -> Option<(f64, usize, usize)> {
    let surface_index = required(graph, face, &graph.objects[face].fields["m_pSurf"], "surface").ok()?;
    let surface = Surface::read(graph, surface_index).ok()?;
    let geometry = tess::tessellate(graph, face).ok()??;
    let (mut worst, mut over) = (0.0f64, 0usize);
    for triangle in &geometry.triangles {
        let corners = triangle.map(|c| c as usize);
        let uv = [0, 1].map(|k| corners.iter().map(|&c| geometry.uv[c][k]).sum::<f64>() / 3.0);
        let centre = [0, 1, 2].map(|k| corners.iter().map(|&c| geometry.vertices[c][k]).sum::<f64>() / 3.0);
        // Composante normale de l'écart : le décalage le long de la surface (le centre d'un triangle
        // long et fin ne tombe pas au (u, v) moyen) n'est pas une erreur de forme.
        let on_surface = surface.eval(uv[0], uv[1]);
        let deviation = match surface.normal(uv[0], uv[1]) {
            Some(n) => dot(sub(centre, on_surface), n).abs(),
            None => distance(centre, on_surface),
        };
        worst = worst.max(deviation);
        over += usize::from(deviation > 0.00328);
    }
    Some((worst, over, geometry.triangles.len()))
}

/// Aire d'un maillage (pieds carrés).
fn area(vertices: &[[f64; 3]], triangles: &[[u32; 3]]) -> f64 {
    triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|corner| vertices[corner as usize]);
            norm(cross(sub(b, a), sub(c, a))) / 2.0
        })
        .sum()
}

/// L'aire d'une face vue par ce module et par rvt-rs (quand il la maille) : à comparer pour
/// vérifier la lecture des boucles et la triangulation des régions sur toutes les faces que
/// rvt-rs sait traiter. `(classe de surface, aire du module, aire de rvt-rs)`.
pub fn compare_with_rvt(graph: &ObjectGraph, face: usize) -> Option<(String, f64, f64)> {
    let reference = rvt_face(graph, face).ok()??;
    let ours = tess::tessellate(graph, face).ok()??;
    Some((super::surface_class(graph, face), area(&ours.vertices, &ours.triangles), area(&reference.vertices, &reference.triangles)))
}
