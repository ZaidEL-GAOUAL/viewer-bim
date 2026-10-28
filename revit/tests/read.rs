//! La lecture native du fichier d'essai (Revit 2023, licence MIT, voir tests/fixtures).

use revit::geometry::pack::MATERIAL_STRIDE;
use revit::{Options, read};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/Revit_IFC5_Einhoven.rvt");

#[test]
fn lit_le_fichier_d_essai() {
    let bytes = std::fs::read(FIXTURE).expect("fichier d'essai absent");
    let output = read(&bytes, &Options::default()).expect("lecture");

    assert_eq!(output.report.release, Some(2023));
    assert!(output.report.seconds >= 0.0);

    // Les colonnes par élément ont toutes la même longueur.
    let elements = output.keys.len();
    assert_eq!(output.names.len(), elements);
    assert_eq!(output.sources.len(), elements);
    assert_eq!(output.report.elements, elements);

    // Le maillage est cohérent : normales par sommet, indices dans leur primitive.
    assert_eq!(output.positions.len() % 3, 0);
    assert_eq!(output.normals.len(), output.positions.len());
    assert_eq!(output.indices.len() % 3, 0);
    assert_eq!(output.report.triangles, output.indices.len() / 3);
    assert_eq!(output.primitives.len() % 6, 0);
    assert_eq!(output.materials.len() % MATERIAL_STRIDE, 0);
    let vertices = output.positions.len() / 3;
    let materials = output.materials.len() / MATERIAL_STRIDE;
    for primitive in output.primitives.chunks_exact(6) {
        let [element, vertex_start, vertex_count, index_start, index_count, material] = primitive else { unreachable!() };
        assert!((*element as usize) < elements);
        assert!((*vertex_start + *vertex_count) as usize <= vertices);
        assert!((*material as usize) < materials);
        let indices = &output.indices[*index_start as usize..(*index_start + *index_count) as usize];
        assert!(indices.iter().all(|index| index < vertex_count));
    }

    // Les quatre origines de géométrie recouvrent exactement les éléments dessinés.
    let sources = &output.report.sources;
    assert_eq!(sources.revit + sources.partial + sources.rebuilt + sources.unknown, elements);
    assert!(output.sources.iter().all(|source| *source <= 3));

    // Le JSON de métadonnées suit le contrat.
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    assert_eq!(metadata["version"], 1);
    assert!(metadata["readOnly"].is_array());
    assert!(metadata["elements"].is_object());
    for key in &output.keys {
        assert!(metadata["elements"].get(key).is_some(), "fiche manquante pour {key}");
    }
    check_join(&output);
}

/// La géométrie et les propriétés parlent des mêmes éléments : la fiche de chaque clé a pour libellé
/// le nom rendu à côté du maillage, et dit d'où vient sa forme.
pub fn check_join(output: &revit::Output) {
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    let origins = ["Forme Revit", "Forme Revit partielle", "Forme reconstruite", "Inconnue (boîte englobante)"];
    let read_only: Vec<&str> = metadata["readOnly"].as_array().unwrap().iter().map(|name| name.as_str().unwrap()).collect();
    assert!(read_only.contains(&"Source de la géométrie"));
    for (index, key) in output.keys.iter().enumerate() {
        let entry = &metadata["elements"][key];
        assert_eq!(entry["label"], output.names[index].as_str(), "libellé de {key}");
        let properties = entry["properties"].as_object().expect("propriétés");
        assert_eq!(properties["Source de la géométrie"], origins[usize::from(output.sources[index])], "origine de la forme de {key}");
    }
    // Chaque étape de la lecture a sa durée.
    assert!(output.report.stages.iter().any(|stage| stage.name == "ouverture"));
    assert!(output.report.stages.iter().all(|stage| stage.seconds >= 0.0));
}

#[test]
fn n_avertit_pas_de_masses_sur_un_fichier_qui_n_en_a_pas() {
    // Le fichier d'essai n'a aucune masse, mais la catégorie Masses y a ses deux enregistrements (comme dans tout modèle) :
    // la règle des masses les écarte, l'avertissement ne les compte pas.
    let bytes = std::fs::read(FIXTURE).expect("fichier d'essai absent");
    let output = read(&bytes, &Options::default()).expect("lecture");
    assert!(output.report.warnings.iter().all(|message| !message.contains("masse")), "{:?}", output.report.warnings);
}

#[test]
fn refuse_un_fichier_qui_n_est_pas_du_revit() {
    let error = read(b"ceci n'est pas un fichier Revit", &Options::default()).unwrap_err();
    assert!(format!("{error:#}").contains("Revit"));
}
