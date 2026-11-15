//! La « Classe IFC » des fiches Revit (`properties::fiche`, table `src/catalog/ifc_classes.tsv`) : le paramètre « Exporter en IFC en tant que » de
//! l'élément d'abord, puis la classe du type, puis la catégorie ; et le bilan des éléments qui n'en ont pas.
//!
//! Le fichier committé sert toujours ; les autres viennent de `revit/samples/` et leurs essais passent sans rien faire quand ils manquent.
//! À lancer avec `cargo test --release --test ifc_classes`.

use revit::{Options, Output, read};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/Revit_IFC5_Einhoven.rvt");

fn sample(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if path.exists() {
        Some(path)
    } else {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        None
    }
}

fn open(path: &PathBuf) -> (Output, Value) {
    let output = read(&std::fs::read(path).expect("fichier d'essai"), &Options::default()).expect("lecture");
    let metadata = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    (output, metadata)
}

/// (Catégorie, Classe IFC) → nombre d'éléments.
fn classes(metadata: &Value) -> BTreeMap<(String, String), usize> {
    let mut out = BTreeMap::new();
    for element in metadata["elements"].as_object().expect("éléments").values() {
        let properties = &element["properties"];
        let text = |name: &str| properties[name].as_str().unwrap_or("—").to_string();
        *out.entry((text("Catégorie"), text("Classe IFC"))).or_default() += 1;
    }
    out
}

fn pairs(expected: &[(&str, &str, usize)]) -> BTreeMap<(String, String), usize> {
    expected.iter().map(|(category, class, n)| ((category.to_string(), class.to_string()), *n)).collect()
}

#[test]
fn le_fichier_committe_a_une_classe_ifc_pour_chaque_element_et_dit_d_ou_elle_vient() {
    let (output, metadata) = open(&PathBuf::from(FIXTURE));
    assert_eq!(output.report.without_ifc_class, 0);
    let found = classes(&metadata);
    assert!(found.keys().all(|(_, class)| class.starts_with("Ifc")), "{found:?}");
    assert_eq!(found.get(&("Murs".to_string(), "IfcWall".to_string())).copied().unwrap_or(0) > 0, true, "{found:?}");
    // La classe est en tête de fiche, modifiable (seule l'identité est verrouillée) ; son origine est dans « Paramètres IFC ».
    assert!(!metadata["readOnly"].as_array().expect("readOnly").iter().any(|name| name == "Classe IFC"));
    for element in metadata["elements"].as_object().expect("éléments").values() {
        let origin = element["properties"]["Paramètres IFC"]["Origine de la classe IFC"].as_str().unwrap_or("");
        // Aucun paramètre « Exporter en IFC en tant que » ici : la catégorie, ou le type d'un mur-rideau.
        assert!(origin.starts_with("Déduite de la catégorie") || origin.starts_with("Déduite du type « Mur-rideau »"), "{origin}");
    }
}

#[test]
fn re1_architecture_a_les_classes_que_l_export_ifc_de_revit_lui_donne() {
    // L'export IFC2X3 que Revit 2026 a fait de ce fichier (Drshelden/IFC-ECS, data/RE1/RE1-Architecture.ifc), élément par élément par le GlobalId,
    // ramené aux noms IFC4 : IfcWallStandardCase → IfcWall, IfcFurnishingElement → IfcFurniture, IfcFlowTerminal (appareil sanitaire) →
    // IfcSanitaryTerminal. Le mur-rideau, de catégorie « Murs », est un IfcCurtainWall.
    let Some(path) = sample("RE1-Architecture.rvt") else { return };
    let (output, metadata) = open(&path);
    let expected = pairs(&[
        ("Appareils sanitaires", "IfcSanitaryTerminal", 7),
        ("Garde-corps", "IfcRailing", 1),
        ("Meneaux de mur-rideau", "IfcMember", 10),
        ("Mobilier", "IfcFurniture", 13),
        ("Mobilier fixe", "IfcFurniture", 10),
        ("Murs", "IfcCurtainWall", 1),
        ("Murs", "IfcWall", 7),
        ("Panneaux de mur-rideau", "IfcPlate", 2),
        ("Plafonds", "IfcCovering", 6),
        ("Portes", "IfcDoor", 5),
        ("Sols", "IfcSlab", 2),
        ("Équipements spéciaux", "IfcBuildingElementProxy", 9),
    ]);
    assert_eq!(classes(&metadata), expected);
    assert_eq!(output.report.without_ifc_class, 0);
}

#[test]
fn le_parametre_de_l_element_l_emporte_sur_la_categorie() {
    // 2024_Core_Interior : 22 sols portent « Exporter en IFC en tant que » (et le paramètre partagé IfcExportAs, de même valeur) : 20
    // « IfcShadingDevice » et 2 « ifcSlab », écrit « IfcSlab ».
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let (_, metadata) = open(&path);
    let mut by_parameter: BTreeMap<String, usize> = BTreeMap::new();
    for element in metadata["elements"].as_object().expect("éléments").values() {
        let properties = &element["properties"];
        if properties["Paramètres IFC"]["Origine de la classe IFC"].as_str().is_some_and(|origin| origin.starts_with("Paramètre « Exporter en IFC en tant que »")) {
            *by_parameter.entry(properties["Classe IFC"].as_str().expect("classe").to_string()).or_default() += 1;
        }
    }
    assert_eq!(by_parameter, BTreeMap::from([("IfcShadingDevice".to_string(), 20), ("IfcSlab".to_string(), 2)]));
}

#[test]
fn le_bilan_compte_les_elements_sans_classe_ifc() {
    let mut checked = 0;
    for file in ["dynamo-topography-2016.rvt", "wadduwa.rvt", "DynamoSample_2023.rvt", "rac_advanced_sample_project.rvt"] {
        let Some(path) = sample(file) else { continue };
        let (output, metadata) = open(&path);
        let without = metadata["elements"].as_object().expect("éléments").values().filter(|element| element["properties"].get("Classe IFC").is_none()).count();
        assert_eq!(output.report.without_ifc_class, without, "{file}");
        checked += 1;
    }
    // La topographie n'a pas d'équivalent dans la table : elle est comptée.
    if let Some(path) = sample("dynamo-topography-2016.rvt") {
        let (output, metadata) = open(&path);
        let topography = metadata["elements"].as_object().expect("éléments").values().filter(|element| element["properties"]["Catégorie"] == "Topographie").count();
        assert!(topography > 0 && output.report.without_ifc_class >= topography);
    }
    eprintln!("{checked} fichiers");
}
