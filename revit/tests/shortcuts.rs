//! Les raccourcis de la lecture ne changent rien au résultat : ne pas décoder ce que la règle de dessin
//! écarte d'avance (classes, éléments d'une définition de groupe), laisser la géométrie passer aux
//! propriétés les enregistrements qu'elle a décodés, ne lire que les symboles que les instances placent.
//! `Options::exhaustive` lit tout, sans raccourci, et relit les propriétés à part : les deux lectures
//! rendent exactement les mêmes éléments, les mêmes tableaux et les mêmes métadonnées.
//!
//! À lancer avec `cargo test --release`. Les fichiers publics viennent de `npm run samples:revit` ;
//! sans eux, les essais qui en dépendent passent sans rien faire.

use std::path::PathBuf;

use revit::{Options, Output, read};

fn sample(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(std::fs::read(path).expect("fichier d'essai"))
}

fn same_result(a: &Output, b: &Output, name: &str) {
    assert_eq!(a.keys, b.keys, "{name} : éléments");
    assert_eq!(a.names, b.names, "{name} : noms");
    assert_eq!(a.sources, b.sources, "{name} : origines des formes");
    assert_eq!(a.origin, b.origin, "{name} : origine");
    assert_eq!(a.positions, b.positions, "{name} : positions");
    assert_eq!(a.normals, b.normals, "{name} : normales");
    assert_eq!(a.indices, b.indices, "{name} : indices");
    assert_eq!(a.primitives, b.primitives, "{name} : primitives");
    assert_eq!(a.materials, b.materials, "{name} : matériaux");
    assert_eq!(a.metadata, b.metadata, "{name} : métadonnées");
    assert_eq!(a.report.sources.revit, b.report.sources.revit);
    assert_eq!(a.report.without_geometry, b.report.without_geometry, "{name} : éléments sans forme");
}

fn compare(name: &str) {
    let Some(bytes) = sample(name) else { return };
    let quick = read(&bytes, &Options::default()).expect("lecture");
    let full = read(&bytes, &Options { exhaustive: true, ..Options::default() }).expect("lecture sans raccourci");
    same_result(&quick, &full, name);
    assert!(!quick.keys.is_empty());
}

#[test]
fn core_interior_2024() {
    compare("2024_Core_Interior.rvt");
}

#[test]
fn dynamo_sample_2024() {
    compare("DynamoSample_2024.rvt");
}

#[test]
fn re1_architecture_2025() {
    compare("RE1-Architecture.rvt");
}

#[test]
fn refinery_primer_2026() {
    compare("RefineryPrimer-2026-BuildingGenerator.rvt");
}

#[test]
fn re1_electrical_2025() {
    compare("RE1-Electrical.rvt");
}

#[test]
fn le_fichier_d_essai_2023() {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/Revit_IFC5_Einhoven.rvt")).expect("fichier d'essai");
    let quick = read(&bytes, &Options::default()).expect("lecture");
    let full = read(&bytes, &Options { exhaustive: true, ..Options::default() }).expect("lecture sans raccourci");
    same_result(&quick, &full, "Revit_IFC5_Einhoven");
}

/// Les mêmes raccourcis sur les fichiers de Revit 2015 à 2022 : la lecture rapide et la lecture sans raccourci rendent
/// le même résultat.
#[test]
fn sample_model_2017() {
    compare("SampleModel.rvt");
}

#[test]
fn rac_advanced_2019() {
    compare("rac_advanced_sample_project.rvt");
}

#[test]
fn connector_test_2020() {
    compare("ConnectorTestR20.rvt");
}

#[test]
fn rooms_and_exits_2021() {
    compare("RoomsAndExits.rvt");
}

#[test]
fn une_famille_de_2020() {
    compare("FamilyDocumentTests.rfa");
}
