//! Formes reconstruites : les corps que rvt-rs fabrique pour son export IFC (murs, dalles, toits,
//! poteaux, poutres, escaliers, tuyaux…) depuis les données de Revit, triangulés par son
//! constructeur glTF (`rvt::ifc::gltf::build_gltf`).
//!
//! Chemin de repli, coûteux (l'export balaie le fichier une fois par catégorie Revit : 2,3 s en
//! natif et environ 8 s en WebAssembly sur Core Interior) : on n'y passe que si la lecture des formes
//! enregistrées a échoué en entier (ou si l'année du fichier est inconnue ou plus récente que celles que
//! `native` lit). Elle n'avait rien à reconstruire pour aucun fichier de 2015 à 2022 d'essai. Pour les éléments isolés dont la forme enregistrée est illisible, il ne rapportait
//! rien : sur les onze fichiers d'essai 2023 et plus, après que le parcours des graphiques eut appris
//! les nœuds que rvt-rs refuse, plus aucun élément n'est illisible, et avant cela l'export n'avait pas
//! redessiné un seul des 21 de RE1-Electrical pour 2,2 s. Ils se montrent donc par leur boîte
//! (`geometry::bounds`).
//!
//! Le document glTF donne un nœud par corps, avec son maillage et sa matrice (pieds, Z vers le
//! haut, repère du modèle) ; le nœud racine, qui convertit en mètres Y vers le haut, n'a pas
//! d'`extras` et est ignoré : le changement de repère se fait une seule fois, dans `pack`.
//! Le lien avec Revit est le `Tag` de l'entité IFC (`type_guid`), l'ElementId en décimal.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use rvt::ifc::entities::{IfcEntity, PropertyValue};
use rvt::ifc::export_content::RECORD_BBOX_BODY_SOURCE;
use rvt::ifc::gltf::{GltfDocument, build_gltf};

use super::pack::{ElementMesh, Face, Paint};
use crate::Context;

/// Ce que l'export reconstruit.
pub struct Output {
    pub elements: Vec<Rebuilt>,
    /// Éléments de l'export (hors espaces) dont aucun corps n'a pu être dessiné.
    pub without_body: BTreeSet<u64>,
}

/// Un élément reconstruit.
pub struct Rebuilt {
    pub id: u64,
    /// Type IFC de l'entité (`IFCWALL`…), à défaut de la classe Revit.
    pub class: String,
    /// Tous ses corps sont la boîte de l'enregistrement de l'élément : source « inconnue ».
    pub bbox: bool,
    pub mesh: ElementMesh,
}

struct OwnedFace {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
    paint: Paint,
}

struct Accumulated {
    class: String,
    bbox: bool,
    double_sided: bool,
    faces: Vec<OwnedFace>,
}

/// Les éléments reconstruits par l'export IFC de rvt-rs. Plusieurs corps d'un même ElementId (couches
/// d'un mur, morceaux d'une dalle) forment un seul élément.
pub fn build(file: &mut rvt::RevitFile, context: &mut Context) -> Result<Output> {
    let export = context.export(file)?;
    let model = &export.model;
    let (document, binary) = build_gltf(model);

    let mut elements: BTreeMap<u64, Accumulated> = BTreeMap::new();
    for node in &document.nodes {
        let (Some(extras), Some(mesh_index)) = (&node.extras, node.mesh) else { continue };
        let Some(IfcEntity::BuildingElement { ifc_type, type_guid, property_set, .. }) = model.entities.get(extras.entity_index) else { continue };
        if ifc_type == "IFCSPACE" || ifc_type == "IFCOPENINGELEMENT" {
            continue;
        }
        let Some(id) = type_guid.as_deref().and_then(|tag| tag.parse::<u64>().ok()) else { continue };
        // Une boîte d'enregistrement n'est pas un corps : même critère que `saved_meshes::attach`.
        let (mut source, mut resolved) = (None, false);
        for property in property_set.iter().flat_map(|set| &set.properties) {
            match (property.name.as_str(), &property.value) {
                ("BodySource", PropertyValue::Text(text)) => source = Some(text.as_str()),
                ("ProfileResolved", PropertyValue::Boolean(true)) => resolved = true,
                _ => {}
            }
        }
        let bbox = source == Some(RECORD_BBOX_BODY_SOURCE) && !resolved;

        let entry = elements.entry(id).or_insert_with(|| Accumulated { class: ifc_type.clone(), bbox: true, double_sided: false, faces: Vec::new() });
        entry.bbox &= bbox;
        let matrix = node.matrix.map(|m| m.map(f64::from));
        let Some(mesh) = document.meshes.get(mesh_index) else { continue };
        for primitive in &mesh.primitives {
            if primitive.mode != 4 {
                continue;
            }
            let (Some(&position), Some(indices)) = (primitive.attributes.get("POSITION"), primitive.indices) else { continue };
            let (Some(vertices), Some(corners)) = (read_vec3(&document, &binary, position), read_indices(&document, &binary, indices)) else { continue };
            let vertices = vertices.into_iter().map(|p| apply(matrix.as_ref(), p)).collect();
            let triangles = corners.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
            let (paint, double_sided) = paint_of(&document, primitive.material);
            entry.double_sided |= double_sided;
            entry.faces.push(OwnedFace { vertices, triangles, paint });
        }
    }

    // Les éléments de l'export, pour compter ceux dont aucun corps ne se dessine.
    let mut known = BTreeSet::new();
    for entity in &model.entities {
        let IfcEntity::BuildingElement { ifc_type, type_guid, .. } = entity else { continue };
        if ifc_type == "IFCSPACE" || ifc_type == "IFCOPENINGELEMENT" {
            continue;
        }
        if let Some(id) = type_guid.as_deref().and_then(|tag| tag.parse::<u64>().ok()) {
            known.insert(id);
        }
    }

    let elements: Vec<Rebuilt> = elements
        .into_iter()
        .filter_map(|(id, element)| {
            let faces: Vec<Face<'_>> = element.faces.iter().map(|face| Face { vertices: &face.vertices, normals: None, triangles: &face.triangles, paint: face.paint, overlay: false }).collect();
            let mut mesh = ElementMesh::build(&faces);
            if mesh.is_empty() {
                return None;
            }
            mesh.open |= element.double_sided;
            Some(Rebuilt { id, class: element.class, bbox: element.bbox, mesh })
        })
        .collect();
    let drawn: BTreeSet<u64> = elements.iter().map(|element| element.id).collect();
    let without_body = known.difference(&drawn).copied().collect();
    Ok(Output { elements, without_body })
}

/// Un point du corps, dans le repère du modèle : la matrice du nœud (colonnes, comme glTF).
fn apply(matrix: Option<&[f64; 16]>, p: [f64; 3]) -> [f64; 3] {
    let Some(m) = matrix else { return p };
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ]
}

/// Les octets d'un accesseur : début et nombre d'éléments.
fn accessor_bytes<'a>(document: &GltfDocument, binary: &'a [u8], index: usize, width: usize) -> Option<(&'a [u8], usize, u32)> {
    let accessor = document.accessors.get(index)?;
    let view = document.buffer_views.get(accessor.buffer_view)?;
    let start = view.byte_offset.checked_add(accessor.byte_offset)?;
    let end = start.checked_add(accessor.count.checked_mul(width)?)?;
    Some((binary.get(start..end)?, accessor.count, accessor.component_type))
}

fn read_vec3(document: &GltfDocument, binary: &[u8], index: usize) -> Option<Vec<[f64; 3]>> {
    let (bytes, count, component) = accessor_bytes(document, binary, index, 12)?;
    if component != 5126 {
        return None;
    }
    let float = |at: usize| f64::from(f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]));
    Some((0..count).map(|i| [float(i * 12), float(i * 12 + 4), float(i * 12 + 8)]).collect())
}

fn read_indices(document: &GltfDocument, binary: &[u8], index: usize) -> Option<Vec<u32>> {
    let component = document.accessors.get(index)?.component_type;
    match component {
        5125 => {
            let (bytes, count, _) = accessor_bytes(document, binary, index, 4)?;
            Some((0..count).map(|i| u32::from_le_bytes([bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2], bytes[i * 4 + 3]])).collect())
        }
        5123 => {
            let (bytes, count, _) = accessor_bytes(document, binary, index, 2)?;
            Some((0..count).map(|i| u32::from(u16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]))).collect())
        }
        _ => None,
    }
}

/// Couleur sRGB et double face d'un matériau glTF. `base_color_factor` est linéaire (rvt-rs
/// linéarise les couleurs Revit), on revient aux octets sRGB.
fn paint_of(document: &GltfDocument, material: Option<usize>) -> (Paint, bool) {
    let Some(material) = material.and_then(|index| document.materials.get(index)) else { return (Paint::NEUTRAL, false) };
    let [r, g, b, a] = material.pbr_metallic_roughness.base_color_factor.map(f64::from);
    (Paint::from_srgb([linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(b)], a), material.double_sided)
}

fn linear_to_srgb(value: f64) -> f64 {
    let value = value.clamp(0.0, 1.0);
    if value <= 0.003_130_8 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 }
}
