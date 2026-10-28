//! Les propriétés des fichiers Revit d'essai : le fichier committé (Revit 2023, licence MIT, voir
//! tests/fixtures) et, quand ils sont présents dans revit/samples/ (voir `npm run samples:revit`),
//! 2024_Core_Interior, DynamoSample_2024, RE1-Architecture et, avant Revit 2023, rac_advanced_sample_project.
//!
//! Les éléments passés au module sont des éléments du bâtiment (murs, sols, plafonds, instances de
//! famille…) : tous les murs, puis un échantillon régulier des autres, pour que le test reste court.

use revit::geometry::identity_keys;
use revit::properties::build;
use revit::Context;
use revit::native::{self, Options as NativeOptions};
use rvt::research::{native_document, revit_global_ids};
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

struct Run {
    ids: Vec<u64>,
    classes: BTreeMap<u64, String>,
    keys: Vec<String>,
    labels: Vec<String>,
    metadata: Value,
    /// Le JSON tel qu'écrit (l'ordre des propriétés compte pour le viewer).
    text: String,
    warnings: Vec<String>,
}

impl Run {
    fn element(&self, id: u64) -> &Value {
        let index = self.ids.iter().position(|i| *i == id).expect("élément demandé");
        &self.metadata["elements"][&self.keys[index]]
    }

    fn of_class<'a>(&'a self, class: &'a str) -> impl Iterator<Item = u64> + 'a {
        self.ids.iter().copied().filter(move |id| self.classes.get(id).is_some_and(|c| c == class))
    }
}

/// Construit les propriétés des éléments du bâtiment de `path` (au plus `limit` éléments non-murs).
fn run(path: &PathBuf, limit: usize) -> Run {
    let bytes = std::fs::read(path).expect("fichier d'essai");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = native::release(&mut file);
    let mut classes: BTreeMap<u64, String> = BTreeMap::new();
    let mut ids: Vec<u64> = Vec::new();
    // Tous les fichiers de 2015 à 2027 se lisent par leurs enregistrements natifs.
    {
        let wanted = ["SWall", "FamilyInstance", "Floor", "Ceiling", "StairsElement", "BaseRailing"];
        let options = NativeOptions { selected_classes: wanted.iter().map(|c| c.to_string()).collect(), ..Default::default() };
        native::extract_graphs(&mut file, &options, |record| {
            classes.insert(record.identity.element_id, record.class_name.clone().unwrap_or_default());
            Ok(())
        })
        .expect("lecture des classes");
        let walls: Vec<u64> = classes.iter().filter(|(_, class)| *class == "SWall").map(|(id, _)| *id).collect();
        let others: Vec<u64> = classes.iter().filter(|(_, class)| *class != "SWall").map(|(id, _)| *id).collect();
        let stride = others.len().div_ceil(limit.max(1)).max(1);
        ids.extend(walls.iter().take(limit));
        ids.extend(others.iter().step_by(stride));
    }
    let global_ids = revit_global_ids::revit_global_ids(&mut file).unwrap_or_default();
    // Les clés viennent de la géométrie, comme dans `read` ; ici, une forme Revit pour chaque élément.
    let keys = identity_keys(&global_ids, &ids);
    let sources = vec![0u8; ids.len()];

    let mut context = Context::new(release);
    let properties = build(&mut file, &mut context, &ids, &keys, &sources).expect("propriétés");
    let text = properties.metadata();
    let metadata: Value = serde_json::from_str(&text).expect("JSON de métadonnées");
    Run { ids, classes, keys, labels: properties.labels, metadata, text, warnings: context.warnings }
}

/// Le JSON suit le contrat v1 et décrit chaque élément demandé.
fn check_contract(run: &Run) {
    let metadata = &run.metadata;
    assert_eq!(metadata["version"], 1);
    let read_only: Vec<&str> = metadata["readOnly"].as_array().expect("readOnly").iter().map(|v| v.as_str().expect("motif")).collect();
    assert!(read_only.contains(&"Catégorie") && read_only.contains(&"Identifiant Revit"), "readOnly : {read_only:?}");
    let elements = metadata["elements"].as_object().expect("elements");
    assert_eq!(elements.len(), run.ids.len(), "un élément par identifiant demandé");
    for (index, key) in run.keys.iter().enumerate() {
        let entry = elements.get(key).unwrap_or_else(|| panic!("fiche manquante pour {key}"));
        assert!(entry["label"].as_str().is_some_and(|label| !label.is_empty()), "libellé de {key}");
        // Les noms rendus à côté du maillage sont les libellés des fiches.
        assert_eq!(entry["label"], run.labels[index].as_str(), "libellé de {key}");
        let properties = entry["properties"].as_object().expect("properties");
        assert_eq!(properties["Identifiant Revit"], run.ids[index], "identifiant Revit de {key}");
        // L'origine de la forme est là (sa place, juste après les matériaux, se vérifie côté JavaScript,
        // seul à garder l'ordre des propriétés d'un objet JSON).
        assert_eq!(properties["Source de la géométrie"], "Forme Revit", "source de la géométrie de {key}");
        // Tout nom de propriété de tête ou de groupe est en lecture seule.
        for (name, value) in properties {
            assert!(read_only.contains(&name.as_str()), "« {name} » n'est pas dans readOnly");
            if let Some(group) = value.as_object() {
                assert!(!group.is_empty(), "groupe vide « {name} »");
            }
        }
    }
    // Les clés sont uniques et les valeurs sont celles que le viewer lit (pas de null, pas d'objet à plus de deux niveaux :
    // une propriété de tête est une valeur ou un groupe, et un groupe ne contient que des valeurs).
    let mut seen = std::collections::HashSet::new();
    assert!(run.keys.iter().all(|key| seen.insert(key)), "clés uniques");
    for (key, entry) in elements {
        for (name, value) in entry["properties"].as_object().expect("properties") {
            assert!(!value.is_null(), "{key} : « {name} » est null");
            if let Some(group) = value.as_object() {
                for (inner, leaf) in group {
                    assert!(!leaf.is_null(), "{key} : « {name} » / « {inner} » est null");
                    assert!(!leaf.is_object(), "{key} : « {name} » / « {inner} » est un objet à un troisième niveau");
                }
            }
        }
    }
}

/// Part des occurrences de paramètres (dans les groupes) qui ont un vrai nom.
fn named_share(run: &Run) -> (usize, usize) {
    let (mut occurrences, mut unnamed) = (0, 0);
    for entry in run.metadata["elements"].as_object().unwrap().values() {
        for value in entry["properties"].as_object().unwrap().values() {
            if let Some(group) = value.as_object() {
                for name in group.keys() {
                    occurrences += 1;
                    if name.starts_with("Paramètre Revit") {
                        unnamed += 1;
                    }
                }
            }
        }
    }
    (occurrences, unnamed)
}

fn check_named(run: &Run) {
    let (occurrences, unnamed) = named_share(run);
    assert!(occurrences > 0, "aucun paramètre");
    assert!(unnamed * 100 <= occurrences, "{unnamed} paramètres sans nom sur {occurrences}");
}

fn share_with(run: &Run, name: &str) -> f64 {
    let elements = run.metadata["elements"].as_object().unwrap();
    elements.values().filter(|entry| entry["properties"].get(name).is_some()).count() as f64 / elements.len() as f64
}

/// Un mur porte des paramètres de type, en mètres et dans des groupes français.
fn check_walls(run: &Run) {
    let walls: Vec<u64> = run.of_class("SWall").collect();
    assert!(!walls.is_empty(), "aucun mur");
    let mut with_type_parameters = 0;
    for id in &walls {
        let properties = run.element(*id)["properties"].as_object().unwrap();
        assert_eq!(properties["Catégorie"], "Murs");
        let constraints = properties["Contraintes"].as_object().expect("groupe Contraintes");
        let height = constraints["Hauteur non contrainte (m)"].as_f64().expect("hauteur non contrainte");
        assert!((0.3..200.0).contains(&height), "hauteur non contrainte de {height} m");
        assert!(constraints.contains_key("Contrainte inférieure"), "contrainte inférieure");
        if properties.values().filter_map(Value::as_object).any(|group| group.keys().any(|name| name.ends_with(" (type)"))) {
            with_type_parameters += 1;
        }
    }
    assert!(with_type_parameters * 2 >= walls.len(), "paramètres de type sur {with_type_parameters} murs sur {}", walls.len());
}

/// Les fiches ne dépendent pas de ce que la lecture des éléments a gardé : les éléments qu'elle n'a pas
/// retenus (ici, tous) se relisent dans le fichier et donnent exactement les mêmes fiches.
fn check_fetch(path: &PathBuf, limit: usize) {
    let direct = run(path, limit);
    let bytes = std::fs::read(path).expect("fichier d'essai");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = native::release(&mut file);
    let mut context = Context::new(release);
    // Une lecture qui n'a gardé aucun élément : seulement les définitions et les classes d'appui.
    context.retained.scan(&mut file, &[]).expect("lecture des définitions");
    let sources = vec![0u8; direct.ids.len()];
    let again = build(&mut file, &mut context, &direct.ids, &direct.keys, &sources).expect("propriétés");
    assert!(again.metadata() == direct.text, "les fiches relues dans le fichier diffèrent de celles de la lecture directe");
    assert_eq!(again.labels, direct.labels);
}

#[test]
fn les_elements_non_gardes_se_relisent() {
    check_fetch(&PathBuf::from(FIXTURE), 200);
    if let Some(path) = sample("DynamoSample_2024.rvt") {
        check_fetch(&path, 150);
    }
}

#[test]
fn le_fichier_d_essai() {
    let run = run(&PathBuf::from(FIXTURE), 200);
    check_contract(&run);
    check_named(&run);
    assert!(run.warnings.is_empty(), "{:?}", run.warnings);
    assert!(share_with(&run, "Catégorie") > 0.9);
}

#[test]
fn core_interior() {
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let run = run(&path, 400);
    check_contract(&run);
    check_named(&run);
    check_walls(&run);
    assert!(share_with(&run, "Niveau") > 0.9, "niveau sur {:.0} %", 100.0 * share_with(&run, "Niveau"));
    assert!(share_with(&run, "Phase de création") > 0.8, "phase sur {:.0} %", 100.0 * share_with(&run, "Phase de création"));
    // L'emplacement du site est dans le fichier (Dog Lake, Minnesota).
    let geo = &run.metadata["georeference"];
    assert!((geo["latitude"].as_f64().unwrap() - 44.9565).abs() < 0.001);
    assert!((geo["longitude"].as_f64().unwrap() + 94.8205).abs() < 0.001);
    assert!((geo["elevation"].as_f64().unwrap() - 345.0).abs() < 1.0, "altitude en mètres");
    assert_eq!(geo["origin"], serde_json::json!([0, 0, 0]));
    // Une porte : famille, type, hôte, matériaux, paramètres du type, valeurs en mètres.
    let doors: Vec<&Value> = run.metadata["elements"].as_object().unwrap().values().filter(|entry| entry["properties"]["Catégorie"] == "Portes").collect();
    assert!(!doors.is_empty(), "aucune porte");
    let door = doors[0]["properties"].as_object().unwrap();
    assert!(door.contains_key("Famille") && door.contains_key("Type") && door.contains_key("Matériaux"));
    assert!(door["Contraintes"]["Hôte"].as_str().is_some_and(|host| host.contains(" : ")), "hôte nommé par son libellé");
}

/// L'emplacement que les trois DynamoSample enregistrent (« Internal », l'emplacement actif) : le nord vrai est
/// tourné de 37° dans le sens horaire par rapport au nord du projet, et l'origine du site est à 89,0779 pi
/// vers l'est et 10,1405 pi vers le nord de celle du projet. Revit l'écrit `m_Trf` : une matrice dont les
/// lignes sont (0,7986 ; 0,6018 ; 0) et (−0,6018 ; 0,7986 ; 0), la translation (89,0779 ; 10,1405 ; 0).
fn check_dynamo_location(run: &Run) {
    let geo = &run.metadata["georeference"];
    assert!((geo["latitude"].as_f64().unwrap() - 42.213).abs() < 0.001);
    assert!((geo["longitude"].as_f64().unwrap() + 71.0335).abs() < 0.001);
    assert!((geo["elevation"].as_f64().unwrap() - 46.9392).abs() < 1e-3, "altitude de 154 pi en mètres");
    // Le nord vrai est l'image de l'axe Y du site, la colonne 1 de la matrice : vers l'est du projet (x > 0) et
    // vers son nord (y > 0), à 37° dans le sens horaire de l'axe Y du projet. Un nord pris sur la ligne 1
    // (−0,6018 ; 0,7986) serait le miroir : x < 0.
    let north = geo["trueNorth"].as_array().unwrap();
    let (x, y) = (north[0].as_f64().unwrap(), north[1].as_f64().unwrap());
    assert!((x - 0.601815023).abs() < 1e-8 && (y - 0.79863551).abs() < 1e-8, "nord vrai ({x}, {y})");
    assert!((x.hypot(y) - 1.0).abs() < 1e-6, "nord unitaire");
    assert!((x.atan2(y).to_degrees() - 37.0).abs() < 0.01, "azimut du nord vrai : {} °", x.atan2(y).to_degrees());
    // L'origine du site, dans le repère du projet : 89,0779 pi et 10,1405 pi en mètres, au même niveau.
    let origin: Vec<f64> = geo["origin"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert!((origin[0] - 27.151).abs() < 1e-3 && (origin[1] - 3.0909).abs() < 1e-3 && origin[2].abs() < 1e-9, "origine {origin:?}");
}

#[test]
fn dynamo_sample_2024() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let run = run(&path, 300);
    check_contract(&run);
    check_named(&run);
    check_walls(&run);
    // Revit enregistre un emplacement pour ce projet (Boston), une rotation du nord et un décalage de l'origine.
    check_dynamo_location(&run);
}

#[test]
fn dynamo_sample_2023_et_2025_ont_le_meme_emplacement() {
    for name in ["DynamoSample_2023.rvt", "DynamoSample_2025.rvt"] {
        let Some(path) = sample(name) else { continue };
        check_dynamo_location(&run(&path, 60));
    }
}

/// Les emplacements de projet d'un fichier (nom, lignes de `m_3x3`, translation de `m_or`) et ses points de
/// base (type, coordonnées dans le projet, en pieds).
type Locations = (Vec<(String, [[f64; 3]; 3], [f64; 3])>, Vec<(i64, [f64; 3])>);

fn location_records(path: &PathBuf) -> Locations {
    let mut file = rvt::RevitFile::open_bytes(std::fs::read(path).expect("fichier d'essai")).expect("fichier Revit");
    let options = native_document::Options { selected_classes: ["GeoLocation", "BasePoint"].iter().map(|c| c.to_string()).collect(), ..Default::default() };
    let (mut locations, mut base_points) = (Vec::new(), Vec::new());
    let triple = |value: &Value| -> [f64; 3] { std::array::from_fn(|i| value[i].as_f64().expect("coordonnée")) };
    native_document::extract_graphs(&mut file, &options, |record| {
        let Some(graph) = record.graph else { return Ok(()) };
        let root = &graph.objects[0].fields;
        match record.class_name.as_deref() {
            Some("GeoLocation") => {
                let info = graph.objects.iter().find(|o| o.class_name == "InstanceInfo").expect("InstanceInfo");
                let rows = &info.fields["m_Trf"]["m_3x3"];
                let matrix: [[f64; 3]; 3] = std::array::from_fn(|i| triple(&rows[i]));
                locations.push((root["m_name"].as_str().unwrap_or("").to_string(), matrix, triple(&info.fields["m_Trf"]["m_or"])));
            }
            Some("BasePoint") => {
                let point = graph.objects.iter().find(|o| o.class_name == "GPoint").expect("GPoint");
                base_points.push((root["m_locationType"].as_i64().expect("type de point"), triple(&point.fields["m_coord"])));
            }
            _ => {}
        }
        Ok(())
    })
    .expect("lecture des emplacements");
    (locations, base_points)
}

/// Le sens de la transformation d'un emplacement, établi sur les données : l'emplacement « Project » a pour
/// matrice l'identité et pour translation la position du point de relevé (l'origine des coordonnées partagées)
/// dans le projet. Donc `m_or` est la position de l'origine du site dans le projet et `m_Trf` envoie le site dans
/// le projet (`p_projet = M · p_site + m_or`) : le nord vrai est la colonne 1 de la matrice, non sa ligne 1.
#[test]
fn le_sens_de_la_transformation_d_un_emplacement() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let (locations, base_points) = location_records(&path);
    let survey = base_points.iter().find(|(kind, _)| *kind == 0).expect("point de relevé").1;
    let project = locations.iter().find(|(name, ..)| name == "Project").expect("emplacement « Project »");
    assert_eq!(project.1, [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
    assert!(survey.iter().any(|x| x.abs() > 1.0), "un point de relevé qui n'est pas à l'origine : {survey:?}");
    for i in 0..3 {
        assert!((project.2[i] - survey[i]).abs() < 1e-9, "translation {:?}, point de relevé {survey:?}", project.2);
    }
    // L'emplacement actif : une rotation propre de 37° et la translation lue pour l'origine.
    let internal = locations.iter().find(|(name, ..)| name == "Internal").expect("emplacement « Internal »");
    let m = internal.1;
    let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    assert!((det - 1.0).abs() < 1e-9 && (m[0][0] - m[1][1]).abs() < 1e-12 && (m[0][1] + m[1][0]).abs() < 1e-12, "rotation propre : {m:?}");
    assert!((m[0][1].atan2(m[0][0]).to_degrees() - 37.0).abs() < 0.01);
    assert!((internal.2[0] - 89.0779).abs() < 1e-3 && (internal.2[1] - 10.1405).abs() < 1e-3);
}

#[test]
fn les_autres_echantillons_sont_au_nord_du_projet() {
    // Dans tous les autres fichiers d'essai l'emplacement actif est l'identité : nord vrai = axe Y, origine nulle.
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let run = run(&path, 60);
    let geo = &run.metadata["georeference"];
    assert_eq!(geo["trueNorth"], serde_json::json!([0, 1]));
    assert_eq!(geo["origin"], serde_json::json!([0, 0, 0]));
}

/// Les valeurs de ces paramètres, tels que la fiche les écrit : (nom, valeur) de tous les nombres des groupes.
fn numbers_of(entry: &Value) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for value in entry["properties"].as_object().unwrap().values() {
        if let Some(group) = value.as_object() {
            out.extend(group.iter().filter_map(|(name, value)| value.as_f64().map(|x| (name.clone(), x))));
        }
    }
    out
}

#[test]
fn duct_segment_flow_en_unites_si() {
    let Some(path) = sample("DuctSegmentFlow.rvt") else { return };
    let run = run(&path, 50);
    check_contract(&run);
    // La bouche de soufflage : Revit enregistre 8,33333 pi³/s (500 pi³/min) et 4,27015 kg/(pi·s²).
    let diffuser = run.metadata["elements"].as_object().unwrap().values().find(|entry| entry["label"].as_str().is_some_and(|label| label.starts_with("Supply Diffuser"))).expect("la bouche de soufflage");
    let group = diffuser["properties"]["Mécanique - Débit d'air"].as_object().expect("groupe du débit d'air");
    let flow = group["Flow (L/s)"].as_f64().expect("débit en L/s");
    assert!((flow - 235.974).abs() < 0.001, "débit de {flow} L/s");
    let drop = group["Pressure Drop (Pa)"].as_f64().expect("perte de charge en Pa");
    assert!((drop - 14.0097).abs() < 0.0001, "perte de charge de {drop} Pa");
    // La valeur brute (en unités internes) n'est plus présentée sous le nom du paramètre.
    assert!(!group.contains_key("Flow") && !group.contains_key("Pressure Drop"), "{group:?}");
}

#[test]
fn re1_electrical_en_unites_si() {
    let Some(path) = sample("RE1-Electrical.rvt") else { return };
    let run = run(&path, 300);
    check_contract(&run);
    let all: Vec<(String, f64)> = run.metadata["elements"].as_object().unwrap().values().flat_map(numbers_of).collect();
    let with = |suffix: &str| -> Vec<f64> { all.iter().filter(|(name, _)| name.contains(suffix)).map(|(_, x)| *x).collect() };
    // Des tensions de réseau, des puissances apparentes rondes et des fréquences de 50 ou 60 Hz : les valeurs que Revit
    // montre, non les 10,76 fois trop fortes ou trop faibles des unités internes.
    let volts = with("(V)");
    assert!(!volts.is_empty() && volts.iter().all(|v| [120.0, 208.0, 240.0, 277.0, 480.0].iter().any(|n| (v - n).abs() < 0.5)), "tensions : {volts:?}");
    let apparent = with("(VA)");
    assert!(!apparent.is_empty() && apparent.iter().all(|v| (v - v.round()).abs() < 0.01), "puissances apparentes : {apparent:?}");
    let hertz = with("(Hz)");
    assert!(!hertz.is_empty() && hertz.iter().all(|v| (v - 50.0).abs() < 1e-6 || (v - 60.0).abs() < 1e-6), "fréquences : {hertz:?}");
    // Une température enregistrée en kelvin est en degrés Celsius (0 °F = -17,7778 °C ; 0 K, valeur jamais réglée, = -273,15 °C).
    let celsius = with("(°C)");
    assert!(!celsius.is_empty() && celsius.iter().all(|v| (v + 17.7778).abs() < 1e-3 || (v + 273.15).abs() < 1e-6), "températures : {celsius:?}");
    // Aucune valeur d'une de ces grandeurs n'est restée sous un nom sans unité.
    for (name, _) in &all {
        for raw in ["Voltage", "Apparent Load", "Frequency", "Temperature Threshold"] {
            assert!(name != raw && name != &format!("{raw} (type)"), "« {name} » sans unité");
        }
    }
}

#[test]
fn re1_architecture() {
    let Some(path) = sample("RE1-Architecture.rvt") else { return };
    let run = run(&path, 300);
    check_contract(&run);
    check_named(&run);
    check_walls(&run);
    // Les couches d'un mur composé et leurs matériaux.
    let wall = run.of_class("SWall").find_map(|id| {
        let properties = &run.element(id)["properties"];
        properties["Construction"].get("Couches (type)").map(|_| properties.clone())
    });
    let wall = wall.expect("un mur à couches");
    assert!(wall["Matériaux"].as_array().is_some_and(|materials| !materials.is_empty()));
    // Les types de ce fichier s'appellent « - » (`SymbolInfo.m_name`, comme dans l'export IFC de Revit : « Basic Wall:- ») :
    // la propriété « Type » garde ce nom, le libellé s'en passe. Les portes, elles, ont de vrais noms de type.
    for id in run.of_class("SWall") {
        let entry = run.element(id);
        assert_eq!(entry["properties"]["Type"], "-", "type du mur {id}");
        assert!(entry["label"].as_str().is_some_and(|label| !label.ends_with(" : -")), "libellé du mur {id} : {}", entry["label"]);
    }
    let doors: Vec<&Value> = run.metadata["elements"].as_object().unwrap().values().filter(|entry| entry["properties"]["Catégorie"] == "Portes").collect();
    assert!(!doors.is_empty() && doors.iter().all(|door| door["label"].as_str().is_some_and(|label| label.contains(" : "))), "libellés des portes");
}

#[test]
fn de_revit_2015_a_2022() {
    // Les paramètres natifs de Revit, comme à partir de 2023 : plus de reconstruction IFC, plus d'avertissement.
    for (name, year, limit) in [("rac_advanced_sample_project.rvt", 2019, 400), ("SampleModel.rvt", 2017, 400), ("ConnectorTestR20.rvt", 2020, 400), ("RoomsAndExits.rvt", 2021, 400)] {
        let Some(path) = sample(name) else { continue };
        let run = run(&path, limit);
        check_contract(&run);
        assert!(run.warnings.is_empty(), "{name} ({year}) : {:?}", run.warnings);
        check_named(&run);
        let elements = run.metadata["elements"].as_object().unwrap();
        // Des groupes de paramètres Revit (Contraintes, Cotes, Données d'identification…) sur la plupart des éléments, ce
        // que la reconstruction IFC ne donnait pas.
        let with_groups = elements.values().filter(|entry| entry["properties"].as_object().is_some_and(|properties| properties.values().any(|value| value.is_object()))).count();
        assert!(with_groups * 10 >= elements.len() * 9, "{name} : {with_groups} fiches avec des groupes sur {}", elements.len());
        let with_family = elements.values().filter(|entry| entry["properties"].get("Famille").is_some() && entry["properties"].get("Niveau").is_some()).count();
        assert!(with_family > 0, "{name} : aucun élément avec famille et niveau");
    }
}
