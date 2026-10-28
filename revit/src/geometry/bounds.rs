//! Boîtes englobantes : de quoi montrer, faute de mieux, un élément dont Revit a enregistré la
//! forme mais que ce lecteur ne sait pas lire (source 3, « Inconnue (boîte englobante) »).
//!
//! Les graphiques enregistrés d'un élément (canal 103) s'ouvrent sur un nœud `GElement` qui porte
//! deux boîtes alignées sur les axes : `m_tightbBox`, la plus serrée, et `m_bBox`. Ce sont deux
//! paires de coins `[[xmin, ymin, zmin], [xmax, ymax, zmax]]` en pieds, Z vers le haut, dans le
//! repère du modèle (les transformations des instances sont déjà appliquées), comme les sommets
//! des faces que `saved` maille. Une boîte vide ou absente vaut `±1e30` ou `0` partout.
//!
//! Sur les fichiers d'essai de 2023 et plus, la boîte serrée contient le maillage des éléments
//! dessinés (855 sur 855 pour Core Interior, à 0,004 pied près sur DynamoSample) et l'égale au
//! centième de pied près pour 723 des 855 de Core Interior ; `m_bBox` le contient aussi, en moins
//! serré (mur dont les jonctions dépassent, porte avec son ouverture). La boîte serrée est donc
//! préférée. Le nœud est déjà décodé avec le graphe : lire ses deux champs ne coûte rien, et on ne
//! les lit que pour les éléments sans surface.
//!
//! Pour son export IFC, rvt-rs lit une autre boîte, celle de l'enregistrement d'élément des
//! partitions, par un balayage de tout le fichier (`partition_element_records`) : on ne s'en sert
//! pas.

use rvt::research::native_parameters::ObjectGraph;
use serde_json::Value;

use super::pack::{ElementMesh, Face, Paint};

/// Au-delà, une coordonnée n'est pas une étendue mais un reste de mémoire (même seuil que `pack`).
const LIMIT: f64 = 1e9;

/// Épaisseur minimale, en pieds (3 mm), d'une boîte dessinée : un élément plat (une nappe, une
/// ligne) montrerait des triangles dégénérés, qu'on écarte au maillage.
pub const MIN_SIDE: f64 = 0.01;

/// Boîte alignée sur les axes du modèle, en pieds, Z vers le haut.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub low: [f64; 3],
    pub high: [f64; 3],
}

impl Bounds {
    /// La boîte de coins `low` et `high`. `None` si une coordonnée n'est pas finie ou démesurée, si
    /// un coin est inversé, ou si ce n'est qu'un point (rien à dessiner). Une boîte plate sur un ou
    /// deux axes est épaissie, de part et d'autre, à `MIN_SIDE`.
    pub fn new(low: [f64; 3], high: [f64; 3]) -> Option<Self> {
        if !low.iter().chain(&high).all(|value| value.is_finite() && value.abs() < LIMIT) || (0..3).any(|axis| high[axis] < low[axis]) {
            return None;
        }
        if (0..3).all(|axis| high[axis] - low[axis] < MIN_SIDE) {
            return None;
        }
        let (mut low, mut high) = (low, high);
        for axis in 0..3 {
            if high[axis] - low[axis] < MIN_SIDE {
                let middle = (low[axis] + high[axis]) / 2.0;
                low[axis] = middle - MIN_SIDE / 2.0;
                high[axis] = middle + MIN_SIDE / 2.0;
            }
        }
        Some(Self { low, high })
    }

    /// L'étendue que Revit a enregistrée pour l'élément d'un graphe graphique : sa boîte serrée, à
    /// défaut sa boîte. `None` si le graphe ne s'ouvre pas sur un `GElement` ou si aucune des deux
    /// n'est une étendue (vide, point, valeurs aberrantes).
    pub fn of_graph(graph: &ObjectGraph) -> Option<Self> {
        let root = graph.objects.first().filter(|object| object.class_name == "GElement")?;
        ["m_tightbBox", "m_bBox"].iter().find_map(|name| root.fields.get(*name).and_then(corners).and_then(|(low, high)| Self::new(low, high)))
    }

    /// Le maillage de la boîte : 8 sommets, 12 triangles, antihoraires vus de l'extérieur. Le
    /// changement de repère du document vers la scène est une rotation : il conserve le sens.
    pub fn mesh(&self, paint: Paint) -> ElementMesh {
        let ([x0, y0, z0], [x1, y1, z1]) = (self.low, self.high);
        let vertices = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        ElementMesh::build(&[Face { vertices: &vertices, normals: None, triangles: &TRIANGLES, paint, overlay: false }])
    }
}

/// Les triangles d'une boîte : bas (−Z), haut (+Z), avant (−Y), droite (+X), arrière (+Y), gauche (−X).
const TRIANGLES: [[u32; 3]; 12] = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];

/// `[[x, y, z], [x, y, z]]` d'un graphe : les deux coins, ou rien si la forme est autre.
fn corners(value: &Value) -> Option<([f64; 3], [f64; 3])> {
    let [low, high] = value.as_array()?.as_slice() else { return None };
    let point = |value: &Value| -> Option<[f64; 3]> {
        let [x, y, z] = value.as_array()?.as_slice() else { return None };
        Some([x.as_f64()?, y.as_f64()?, z.as_f64()?])
    };
    Some((point(low)?, point(high)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::pack::{FOOT, to_frame};
    use serde_json::json;

    fn graph(root: Value) -> ObjectGraph {
        serde_json::from_value(json!({
            "consumed_bytes": 0,
            "objects": [{ "class_tag": 1, "class_name": "GElement", "token": 0, "start": 0, "fields_end": 0, "fields": root }],
            "edges": [],
        }))
        .expect("graphe d'essai")
    }

    #[test]
    fn la_boite_serree_passe_avant_la_boite() {
        let loose = json!([[0.0, 0.0, 0.0], [10.0, 10.0, 10.0]]);
        let tight = json!([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]);
        let bounds = Bounds::of_graph(&graph(json!({ "m_bBox": loose, "m_tightbBox": tight }))).unwrap();
        assert_eq!((bounds.low, bounds.high), ([1.0, 2.0, 3.0], [4.0, 5.0, 6.0]));
        // Boîte serrée vide (±1e30, comme Revit l'écrit) : on prend l'autre.
        let empty = json!([[1e30, 1e30, 1e30], [-1e30, -1e30, -1e30]]);
        let bounds = Bounds::of_graph(&graph(json!({ "m_bBox": loose, "m_tightbBox": empty }))).unwrap();
        assert_eq!((bounds.low, bounds.high), ([0.0; 3], [10.0; 3]));
        // Aucune des deux : pas d'étendue.
        assert!(Bounds::of_graph(&graph(json!({ "m_bBox": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0]], "m_tightbBox": empty }))).is_none());
        assert!(Bounds::of_graph(&graph(json!({}))).is_none());
    }

    #[test]
    fn une_etendue_incoherente_n_est_pas_une_boite() {
        let (low, high) = ([0.0; 3], [1.0; 3]);
        assert!(Bounds::new(low, high).is_some());
        assert!(Bounds::new([f64::NAN, 0.0, 0.0], high).is_none());
        assert!(Bounds::new(low, [1.0, f64::INFINITY, 1.0]).is_none());
        assert!(Bounds::new(low, [1.0, 1.0, 1e12]).is_none());
        // Coin inversé, point.
        assert!(Bounds::new(high, low).is_none());
        assert!(Bounds::new([2.0; 3], [2.0; 3]).is_none());
    }

    #[test]
    fn une_boite_plate_est_epaissie() {
        let bounds = Bounds::new([0.0, 0.0, 5.0], [10.0, 20.0, 5.0]).unwrap();
        assert_eq!((bounds.low[2], bounds.high[2]), (5.0 - MIN_SIDE / 2.0, 5.0 + MIN_SIDE / 2.0));
        assert_eq!((bounds.low[0], bounds.high[1]), (0.0, 20.0));
        // Une ligne : deux axes épaissis.
        let line = Bounds::new([0.0; 3], [3.0, 0.0, 0.0]).unwrap();
        assert!((line.high[1] - line.low[1] - MIN_SIDE).abs() < 1e-12 && (line.high[2] - line.low[2] - MIN_SIDE).abs() < 1e-12);
    }

    /// Le produit vectoriel de deux côtés d'un triangle, dans le repère de la scène.
    fn geometric(mesh: &ElementMesh, group: usize, triangle: &[u32]) -> ([f64; 3], [f64; 3]) {
        let start = mesh.groups[group].vertex_start as usize;
        let [a, b, c] = [triangle[0], triangle[1], triangle[2]].map(|index| mesh.positions[start + index as usize]);
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        let centre = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0];
        (normal, centre)
    }

    #[test]
    fn la_boite_a_douze_triangles_sortants_apres_le_changement_de_repere() {
        let bounds = Bounds::new([10.0, -4.0, 2.0], [16.0, 6.0, 9.0]).unwrap();
        let mesh = bounds.mesh(Paint::NEUTRAL);
        assert_eq!(mesh.triangles(), 12);
        assert!(!mesh.open && mesh.stats.inverted == 0 && mesh.stats.degenerate == 0);
        assert_eq!(mesh.groups.len(), 1);

        // Indices dans la plage de leur groupe ; sommets soudés par normale (une normale par face).
        let vertex_count = mesh.groups[0].vertex_count;
        assert!(mesh.indices.iter().all(|index| *index < vertex_count));
        assert_eq!(mesh.positions.len() as u32, vertex_count);
        assert_eq!(mesh.normals.len(), mesh.positions.len());

        // L'étendue est celle de la boîte, en mètres, Y vers le haut.
        let (low, high) = (to_frame(bounds.low), to_frame(bounds.high));
        let scene_low = [low[0].min(high[0]), low[1].min(high[1]), low[2].min(high[2])];
        let scene_high = [low[0].max(high[0]), low[1].max(high[1]), low[2].max(high[2])];
        let centre = [(scene_low[0] + scene_high[0]) / 2.0, (scene_low[1] + scene_high[1]) / 2.0, (scene_low[2] + scene_high[2]) / 2.0];
        for axis in 0..3 {
            let min = mesh.positions.iter().map(|p| p[axis]).fold(f64::INFINITY, f64::min);
            let max = mesh.positions.iter().map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max);
            assert!((min - scene_low[axis]).abs() < 1e-9 && (max - scene_high[axis]).abs() < 1e-9, "axe {axis}");
        }
        assert!((scene_high[1] - scene_low[1] - 7.0 * FOOT).abs() < 1e-9, "la hauteur (Z) devient Y");

        // Chaque triangle regarde vers l'extérieur (son centre est plus loin du centre de la boîte que
        // son plan) et s'accorde avec la normale de ses sommets ; la boîte est une coque fermée.
        let mut normal_sum = [0.0f64; 3];
        for triangle in mesh.indices.chunks_exact(3) {
            let (normal, middle) = geometric(&mesh, 0, triangle);
            let outward = [middle[0] - centre[0], middle[1] - centre[1], middle[2] - centre[2]];
            assert!(normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2] > 0.0, "triangle tourné vers l'intérieur");
            let stored = mesh.normals[(mesh.groups[0].vertex_start + triangle[0]) as usize];
            assert!(normal[0] * f64::from(stored[0]) + normal[1] * f64::from(stored[1]) + normal[2] * f64::from(stored[2]) > 0.0);
            normal_sum = [normal_sum[0] + normal[0], normal_sum[1] + normal[1], normal_sum[2] + normal[2]];
        }
        assert!(normal_sum.iter().all(|value| value.abs() < 1e-9), "boîte non fermée : {normal_sum:?}");
    }

    #[test]
    fn la_boite_porte_la_couleur_demandee() {
        let paint = Paint::from_srgb([0.2, 0.4, 0.6], 1.0);
        let mesh = Bounds::new([0.0; 3], [1.0; 3]).unwrap().mesh(paint);
        assert_eq!(mesh.groups[0].paint, paint);
    }
}
