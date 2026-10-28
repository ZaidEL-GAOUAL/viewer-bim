//! Recours quand la lecture native des enregistrements échoue (ou que l'année est inconnue) : rvt-rs reconstruit un modèle
//! IFC (noms, famille et type, niveau, matériaux, jeux de propriétés). On en tire la fiche de chaque élément,
//! sans les paramètres Revit.

use super::fiche::{self, Fiche};
use crate::{Context, catalog};
use rvt::ifc::IfcModel;
use rvt::ifc::entities::{IfcEntity, PropertySet, PropertyValue};
use std::collections::HashMap;

use super::json::Val;

const FOOT: f64 = 0.3048;

/// Jeux de propriétés de rvt-rs que la fiche ne montre pas : techniques, ou redondants avec la fiche.
fn skipped_set(name: &str) -> bool {
    name == "RvtElementRecordGeometry" || name == "Other" || name.starts_with("Pset_")
}

fn text(value: &PropertyValue) -> Option<String> {
    match value {
        PropertyValue::Text(s) | PropertyValue::Label(s) | PropertyValue::Identifier(s) => Some(s.clone()).filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn find<'a>(set: &'a PropertySet, name: &str) -> Option<&'a PropertyValue> {
    set.properties.iter().find(|p| p.name == name).map(|p| &p.value)
}

fn length_m(value: &PropertyValue) -> Option<f64> {
    match value {
        PropertyValue::LengthFeet(x) | PropertyValue::PositiveLengthFeet(x) => Some(x * FOOT),
        _ => None,
    }
}

pub fn fiches(file: &mut rvt::RevitFile, context: &mut Context, ids: &[u64], guids: &[Option<&str>]) -> anyhow::Result<Vec<Fiche>> {
    let model: &IfcModel = &context.export(file)?.model;

    // Élément Revit → index de l'entité IFC : le numéro d'élément est dans `type_guid` (« Tag » de l'IFC).
    let mut index_of: HashMap<u64, usize> = HashMap::new();
    for (i, entity) in model.entities.iter().enumerate() {
        if let IfcEntity::BuildingElement { type_guid: Some(tag), .. } = entity
            && let Ok(id) = tag.parse::<u64>()
        {
            index_of.entry(id).or_insert(i);
        }
    }
    // Jeux de propriétés de chaque entité.
    let mut sets: HashMap<usize, Vec<&PropertySet>> = HashMap::new();
    for entity in &model.entities {
        if let IfcEntity::ElementPropertySet { element, set } = entity {
            sets.entry(*element).or_default().push(set);
        }
    }

    let mut out = Vec::with_capacity(ids.len());
    for (position, id) in ids.iter().enumerate() {
        let guid = guids.get(position).copied().flatten();
        let mut head: Vec<(&'static str, Val)> = Vec::new();
        let Some(&index) = index_of.get(id) else {
            out.push(Fiche::bare(*id as i64, guid));
            continue;
        };
        let IfcEntity::BuildingElement { ifc_type, name, storey_index, material_index, material_layer_set_index, property_set, .. } = &model.entities[index] else {
            continue;
        };
        let element_sets: Vec<&PropertySet> = sets.get(&index).cloned().unwrap_or_default().into_iter().chain(property_set.iter()).collect();
        let other = element_sets.iter().find(|set| set.name == "Other");
        let record = element_sets.iter().find(|set| set.name == "RvtElementRecordGeometry");
        let from_other = |key: &str| other.and_then(|set| find(set, key)).and_then(text);
        let from_record = |key: &str| record.and_then(|set| find(set, key)).and_then(text);

        let category = from_other("Category").and_then(|english| catalog::category_from_english(&english).map(|c| c.label.to_string()).or(Some(english))).or_else(|| catalog::ifc_category(ifc_type).map(|c| c.label.to_string()));
        let family = from_other("Family").or_else(|| from_record("FamilyName"));
        let type_name = from_other("Type").or_else(|| from_record("TypeName"));
        let level = storey_index.and_then(|i| model.building_storeys.get(i)).map(|storey| storey.name.clone());

        if let Some(category) = &category {
            head.push((fiche::CATEGORY, Val::Text(category.clone())));
        }
        if let Some(family) = &family {
            head.push((fiche::FAMILY, Val::Text(family.clone())));
        }
        if let Some(type_name) = &type_name {
            head.push((fiche::TYPE, Val::Text(type_name.clone())));
        }
        if let Some(level) = level {
            head.push((fiche::LEVEL, Val::Text(level)));
        }
        head.push((fiche::REVIT_ID, Val::Int(*id as i64)));
        if let Some(guid) = guid {
            head.push((fiche::IFC_GUID, Val::Text(guid.to_string())));
        }

        // Matériaux : celui de l'élément, ceux de ses couches, ceux de son type.
        let mut materials: Vec<String> = Vec::new();
        let mut add = |name: &str| {
            if !name.is_empty() && !materials.iter().any(|m| m == name) {
                materials.push(name.to_string());
            }
        };
        if let Some(material) = material_index.and_then(|i| model.materials.get(i)) {
            add(&material.name);
        }
        if let Some(set) = material_layer_set_index.and_then(|i| model.material_layer_sets.get(i)) {
            for layer in &set.layers {
                if let Some(material) = layer.material_index.and_then(|i| model.materials.get(i)) {
                    add(&material.name);
                }
            }
        }
        if let Some(layers) = model.element_layers.get(&(*id as u32)) {
            for band in &layers.layers {
                if let Some(name) = &band.name {
                    add(name);
                }
            }
        }
        if let Some(names) = model.element_type_materials.get(&(*id as u32)) {
            for name in names {
                add(name);
            }
        }
        if !materials.is_empty() {
            head.push((fiche::MATERIALS, Val::List(materials)));
        }
        if category.is_none() {
            head.push((fiche::REVIT_CLASS, Val::Text(ifc_type.clone())));
        }

        // Quelques mesures que rvt-rs a retrouvées, puis les jeux de propriétés qui ne sont pas techniques.
        let mut groups: Vec<(String, Vec<(String, Val)>)> = Vec::new();
        if let Some(record) = record {
            let mut dimensions: Vec<(String, Val)> = Vec::new();
            if let Some(m) = find(record, "Thickness").and_then(length_m) {
                dimensions.push(("Épaisseur (m)".to_string(), Val::Num(m)));
            }
            if let Some(m) = find(record, "BoundingBoxHeight").and_then(length_m) {
                dimensions.push(("Hauteur de la boîte englobante (m)".to_string(), Val::Num(m)));
            }
            if !dimensions.is_empty() {
                groups.push(("Cotes".to_string(), dimensions));
            }
            let mut identity: Vec<(String, Val)> = Vec::new();
            if let Some(number) = record.properties.iter().find(|p| p.name == "RoomNumber").and_then(|p| text(&p.value)) {
                identity.push(("Numéro".to_string(), Val::Text(number)));
            }
            if let Some(room) = record.properties.iter().find(|p| p.name == "RoomName").and_then(|p| text(&p.value)) {
                identity.push(("Nom".to_string(), Val::Text(room)));
            }
            if !identity.is_empty() {
                groups.push(("Données d'identification".to_string(), identity));
            }
        }
        for set in element_sets.iter().filter(|set| !skipped_set(&set.name)) {
            let entries: Vec<(String, Val)> = set
                .properties
                .iter()
                .filter_map(|p| {
                    let value = match &p.value {
                        PropertyValue::Text(s) | PropertyValue::Label(s) | PropertyValue::Identifier(s) if !s.is_empty() => Val::Text(s.clone()),
                        PropertyValue::Integer(n) | PropertyValue::CountValue(n) => Val::Int(*n),
                        PropertyValue::Real(x) => Val::Num(*x),
                        PropertyValue::Boolean(b) => Val::Bool(*b),
                        _ => return None,
                    };
                    Some((super::json::property_name(&p.name), value))
                })
                .collect();
            if !entries.is_empty() {
                groups.push((set.name.clone(), entries));
            }
        }

        let label = match (&family, &type_name) {
            (Some(family), Some(type_name)) => format!("{family} : {type_name}"),
            _ => {
                let category_label = category.as_deref().unwrap_or("Élément Revit");
                match &type_name {
                    Some(type_name) => format!("{category_label} : {type_name}"),
                    None if name.contains(':') => name.clone(),
                    None => format!("{category_label} {id}"),
                }
            }
        };
        out.push(Fiche { label, head, groups });
    }
    Ok(out)
}
