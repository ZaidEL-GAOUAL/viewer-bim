//! Les plans d'étage de Revit dans la section `views` du JSON de métadonnées (`"kind": "plan"`, voir `docs/contrat-metadonnees.md` et
//! `docs/lecture-revit.md`) : ce que la lecture en écrit pour les fichiers d'essai.
//!
//! Le fichier committé (Revit 2023, `tests/fixtures`) sert toujours ; les autres viennent de `revit/samples/` (voir `npm run samples:revit`) et
//! leurs essais passent sans rien faire quand ils manquent. `wadduwa.rvt` est un fichier privé de l'utilisateur, jamais commité : ses essais
//! passent aussi sans rien faire quand il est absent.
//!
//! À lancer avec `cargo test --release --test plans` : en débogage, le décodage est long.

use revit::{Options, Output, read};
use serde_json::Value;
use std::collections::BTreeSet;
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

struct Read {
    output: Output,
    metadata: Value,
}

fn open(path: &PathBuf) -> Read {
    let output = read(&std::fs::read(path).expect("fichier d'essai"), &Options::default()).expect("lecture");
    let metadata = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    Read { output, metadata }
}

impl Read {
    fn views(&self) -> &[Value] {
        self.metadata["views"].as_array().map_or(&[], Vec::as_slice)
    }

    /// Les plans d'étage, dans l'ordre du JSON.
    fn plans(&self) -> Vec<&Value> {
        self.views().iter().filter(|view| view["kind"] == "plan").collect()
    }

    /// Les vues 3D, dans l'ordre du JSON.
    fn views_3d(&self) -> Vec<&Value> {
        self.views().iter().filter(|view| view.get("kind").is_none()).collect()
    }

    /// La clé de l'élément dessiné qui porte ce libellé (il y en a un seul).
    fn key_of(&self, label: &str) -> &str {
        let found: Vec<&str> = self.output.names.iter().zip(&self.output.keys).filter(|(name, _)| name.as_str() == label).map(|(_, key)| key.as_str()).collect();
        assert_eq!(found.len(), 1, "« {label} » : {found:?}");
        found[0]
    }

    /// Les clés des éléments qu'un plan masque.
    fn hidden_keys<'a>(&self, plan: &'a Value) -> BTreeSet<&'a str> {
        plan["hiddenElements"].as_array().into_iter().flatten().filter_map(Value::as_str).collect()
    }
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or_else(|| panic!("{value} n'est pas un nombre"))
}

fn vec3(value: &Value) -> [f64; 3] {
    let array = value.as_array().expect("vecteur");
    assert_eq!(array.len(), 3, "{value}");
    [number(&array[0]), number(&array[1]), number(&array[2])]
}

/// `(nom, type)` de chaque plan, dans l'ordre du JSON.
fn names_and_types(read: &Read) -> Vec<(String, Option<String>)> {
    read.plans().iter().map(|plan| (plan["name"].as_str().expect("nom").to_string(), plan["type"].as_str().map(str::to_string))).collect()
}

fn pair(name: &str, type_name: &str) -> (String, Option<String>) {
    (name.to_string(), Some(type_name.to_string()))
}

/// Ce que tout plan écrit doit tenir : une plage et une caméra valides, une boîte de coupe qui est celle du recadrage, des clés et des catégories
/// qui existent dans le modèle.
fn check_plans(read: &Read, file: &str) {
    let keys: BTreeSet<&str> = read.output.keys.iter().map(String::as_str).collect();
    let categories: BTreeSet<&str> = read.metadata["elements"].as_object().expect("éléments").values().filter_map(|element| element["properties"]["Catégorie"].as_str()).collect();
    for plan in read.plans() {
        let name = plan["name"].as_str().expect("nom");
        let top = number(&plan["range"]["top"]);
        assert!(top.is_finite(), "{file} / {name} : coupe {top}");
        let bottom = plan["range"].get("bottom").map(number);
        assert!(bottom.is_none_or(|bottom| bottom.is_finite() && bottom <= top), "{file} / {name} : plage {}", plan["range"]);
        // Une caméra parallèle qui regarde vers le bas, dont le haut est horizontal et unitaire.
        let camera = &plan["camera"];
        assert_eq!(camera["projection"], "orthographic", "{file} / {name}");
        assert_eq!(vec3(&camera["direction"]), [0.0, -1.0, 0.0], "{file} / {name}");
        let up = vec3(&camera["up"]);
        assert!(up[1].abs() < 1e-9 && (up[0].hypot(up[2]) - 1.0).abs() < 1e-6, "{file} / {name} : haut {up:?}");
        assert!(camera.get("fov").is_none(), "{file} / {name}");
        // Recadré : une taille et une boîte de coupe ; sinon ni l'une ni l'autre. La boîte a la plage du plan en y.
        match (camera.get("size"), plan.get("sectionBox")) {
            (Some(size), Some(found)) => {
                assert!(number(&size[0]) > 0.0 && number(&size[1]) > 0.0, "{file} / {name} : taille {size}");
                let (min, max) = (vec3(&found["min"]), vec3(&found["max"]));
                assert!(min[0] < max[0] && min[2] < max[2], "{file} / {name} : boîte {found}");
                assert_eq!(max[1], top, "{file} / {name}");
                assert_eq!(min[1], bottom.unwrap_or(-10000.0), "{file} / {name}");
                // La taille est celle du rectangle de la boîte (avant rotation) : largeur en x, hauteur en z.
                assert!((number(&size[0]) - (max[0] - min[0])).abs() < 1e-3 && (number(&size[1]) - (max[2] - min[2])).abs() < 1e-3, "{file} / {name} : {size} contre {found}");
            }
            (None, None) => {}
            other => panic!("{file} / {name} : taille et boîte vont ensemble ({other:?})"),
        }
        // Ce qu'un plan masque existe dans le modèle.
        for key in read.hidden_keys(plan) {
            assert!(keys.contains(key), "{file} / {name} : l'élément masqué {key} n'est pas dessiné");
        }
        for value in plan["hiddenCategories"]["values"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            assert!(categories.contains(value), "{file} / {name} : la catégorie masquée « {value} » n'est portée par aucun élément");
        }
    }
    // Les vues 3D passent d'abord : « {3D} » en tête, puis les autres ; les plans ensuite, par hauteur de coupe croissante.
    let kinds: Vec<bool> = read.views().iter().map(|view| view["kind"] == "plan").collect();
    assert!(kinds.windows(2).all(|pair| !pair[0] || pair[1]), "{file} : une vue 3D après un plan");
    let tops: Vec<f64> = read.plans().iter().map(|plan| (number(&plan["range"]["top"]) * 1000.0).round()).collect();
    assert!(tops.windows(2).all(|pair| pair[0] <= pair[1]), "{file} : plans non triés par hauteur de coupe : {tops:?}");
}

// ------------------------------------------------------------------------------------------------ fichier committé

#[test]
fn le_fichier_committe_a_ses_deux_plans_apres_sa_vue_3d() {
    let read = open(&PathBuf::from(FIXTURE));
    // « Level 1 » existe en deux types : un plan de structure (coupe 0,3 m, profondeur −1,8 m) et un plan d'étage (1,2 m, profondeur 0 m).
    assert_eq!(read.views_3d().len(), 1);
    assert_eq!(read.views()[0]["name"], "{3D}");
    assert_eq!(names_and_types(&read), vec![pair("Level 1", "Structural Plan"), pair("Level 1", "Floor Plan")]);
    let plans = read.plans();
    assert!((number(&plans[0]["range"]["top"]) - 0.3).abs() < 1e-6 && (number(&plans[0]["range"]["bottom"]) + 1.8).abs() < 1e-6, "{}", plans[0]["range"]);
    assert!((number(&plans[1]["range"]["top"]) - 1.2).abs() < 1e-6 && number(&plans[1]["range"]["bottom"]).abs() < 1e-6, "{}", plans[1]["range"]);
    check_plans(&read, "Revit_IFC5_Einhoven");
    // Les vues 3D n'ont ni `kind` ni `range` : le contrat d'avant est intact.
    assert!(read.views()[0].get("kind").is_none() && read.views()[0].get("range").is_none());
}

// ------------------------------------------------------------------------------------------------ wadduwa

#[test]
fn wadduwa_a_dix_plans_d_etage_sans_plan_de_plafond_ni_gabarit() {
    let Some(path) = sample("wadduwa.rvt") else { return };
    let read = open(&path);
    // Le fichier a 20 enregistrements `DBViewPlan` : 5 gabarits, 5 plans de plafond (`m_planViewType` 2 : GF, 2F, 1F, RF et F.G.L, vus d'en
    // dessous) et 10 plans d'étage, qui sont ceux-ci, du plus bas au plus haut.
    assert_eq!(
        names_and_types(&read),
        vec![
            pair("F.G.L", "Structural Plan"),
            pair("F.G.L", "Floor Plan"),
            pair("GF", "Floor Plan"),
            pair("1F", "Structural Plan"),
            pair("1F", "Floor Plan"),
            pair("2F", "Floor Plan"),
            pair("RF", "Structural Plan"),
            pair("RF", "Floor Plan"),
            pair("URF", "Floor Plan"),
            pair("Site", "Floor Plan"),
        ]
    );
    let mut names: Vec<String> = read.plans().iter().map(|plan| plan["name"].as_str().expect("nom").to_string()).collect();
    names.sort();
    assert_eq!(names, ["1F", "1F", "2F", "F.G.L", "F.G.L", "GF", "RF", "RF", "Site", "URF"]);
    // Une seule vue 3D, et elle passe d'abord.
    assert_eq!(read.views_3d().len(), 1);
    assert_eq!(read.views()[0]["name"], "{3D}");
    assert!(read.views_3d().iter().all(|view| view.get("range").is_none()));
    check_plans(&read, "wadduwa");
    // Aucun des plans n'est recadré : ni taille, ni boîte de coupe.
    assert!(read.plans().iter().all(|plan| plan["camera"].get("size").is_none() && plan.get("sectionBox").is_none()));
}

#[test]
fn wadduwa_la_plage_du_plan_gf_va_de_30_cm_a_1_50_m() {
    let Some(path) = sample("wadduwa.rvt") else { return };
    let read = open(&path);
    let gf = read.plans().into_iter().find(|plan| plan["name"] == "GF").expect("plan GF");
    // Niveau GF à 0,984 pied (0,30 m) ; coupe à +3,937 pieds, profondeur à +0 : de 0,30 m à 1,50 m (4,921 pieds).
    assert!((number(&gf["range"]["top"]) - 1.5).abs() < 1e-6, "{}", gf["range"]);
    assert!((number(&gf["range"]["bottom"]) - 0.3).abs() < 1e-6, "{}", gf["range"]);
    // Le plan de structure « 1F » : coupe +0,984, haut +1,969, bas −3,937 et profondeur −5,906 pied du niveau 1F (3,90 m) : 2,10 m à 4,20 m.
    let one = read.plans().into_iter().find(|plan| plan["name"] == "1F" && plan["type"] == "Structural Plan").expect("plan 1F de structure");
    assert!((number(&one["range"]["top"]) - 4.2).abs() < 1e-3 && (number(&one["range"]["bottom"]) - 2.1).abs() < 1e-3, "{}", one["range"]);
    // Le plan « Site » : coupe à 328 pieds du niveau, profondeur au niveau du terrain.
    let site = read.plans().into_iter().find(|plan| plan["name"] == "Site").expect("plan Site");
    assert!((number(&site["range"]["top"]) - 100.3).abs() < 0.01 && number(&site["range"]["bottom"]).abs() < 1e-6, "{}", site["range"]);
}

#[test]
fn wadduwa_chaque_plan_masque_le_dwg_de_son_niveau_comme_revit() {
    let Some(path) = sample("wadduwa.rvt") else { return };
    let read = open(&path);
    let dwg = |file: &str| read.key_of(file);
    let plan = |name: &str, type_name: &str| read.plans().into_iter().find(|plan| plan["name"] == name && plan["type"] == type_name).unwrap_or_else(|| panic!("plan {name} ({type_name})"));
    // « GF » montre MAN-GF.dwg : il n'est pas masqué (les calques de DWG qu'il masque sont des sous-catégories, que le viewer ne sait pas masquer).
    let gf = plan("GF", "Floor Plan");
    assert!(!read.hidden_keys(gf).contains(dwg("MAN-GF.dwg")));
    assert!(read.hidden_keys(gf).is_empty());
    assert!(gf.get("hiddenCategories").is_none());
    // « 2F » masque MAN-2F.dwg ; « URF » masque MAN-URF.dwg.
    assert_eq!(read.hidden_keys(plan("2F", "Floor Plan")), BTreeSet::from([dwg("MAN-2F.dwg")]));
    assert_eq!(read.hidden_keys(plan("URF", "Floor Plan")), BTreeSet::from([dwg("MAN-URF.dwg")]));
    // Les deux plans « RF » : celui du type « Floor Plan » (355853) masque MAN-RF.dwg, celui de structure (355872) non.
    assert_eq!(read.hidden_keys(plan("RF", "Floor Plan")), BTreeSet::from([dwg("MAN-RF.dwg")]));
    assert!(read.hidden_keys(plan("RF", "Structural Plan")).is_empty());
    // « 1F » ne masque aucun DWG.
    assert!(read.hidden_keys(plan("1F", "Floor Plan")).is_empty());
    // Le plan « Site » masque par catégorie de Revit : les appareils électriques, que des éléments du modèle portent.
    let site = plan("Site", "Floor Plan");
    assert_eq!(site["hiddenCategories"]["property"], "Catégorie");
    assert_eq!(site["hiddenCategories"]["values"], serde_json::json!(["Appareils électriques"]));
    // Tous les plans nomment leur phase et son filtre.
    assert!(read.plans().iter().all(|plan| plan["phase"] == "New Construction" && plan["phaseFilter"] == "Show All"));
}

// ------------------------------------------------------------------------------------------------ fichiers d'avant 2015

#[test]
fn dynamo_sample_2014_et_2023_donnent_la_meme_liste_de_plans() {
    // 2014 : 66 enregistrements de plans (ceux des familles chargées, que ce fichier mêle aux siens), 3 en 2023 : « Level 1 », « Level 2 » et « Site ».
    let (Some(old), Some(new)) = (sample("DynamoSample_2014.rvt"), sample("DynamoSample_2023.rvt")) else { return };
    let (old, new) = (open(&old), open(&new));
    assert_eq!(names_and_types(&new), vec![pair("Level 1", "Floor Plan"), pair("Level 2", "Floor Plan"), pair("Site", "Floor Plan")]);
    assert_eq!(names_and_types(&old), names_and_types(&new));
    // Les plans, octet pour octet (plage, caméra, recadrage, masquages, phase).
    assert_eq!(old.plans(), new.plans());
    check_plans(&old, "DynamoSample_2014");
    check_plans(&new, "DynamoSample_2023");
}

#[test]
fn le_hangar_n_a_que_les_plans_du_projet_et_non_ceux_de_ses_familles_chargees() {
    // `drone-hangar-building-2014` : 102 enregistrements de plans (gabarits, plans de plafond et plans des familles chargées compris) ; 7 plans d'étage
    // sont ceux du projet : « Level 1 », « Level 2 », « Level 3 » et « Level 4 » (les deux derniers en deux types), « Site ».
    let Some(path) = sample("drone-hangar-building-2014.rvt") else { return };
    let read = open(&path);
    assert_eq!(
        names_and_types(&read),
        vec![pair("Level 1", "Floor Plan"), pair("Level 2", "Floor Plan"), pair("Level 3", "Structural Plan"), pair("Level 3", "Floor Plan"), pair("Level 4", "Structural Plan"), pair("Level 4", "Floor Plan"), pair("Site", "Floor Plan")]
    );
    check_plans(&read, "drone-hangar-building-2014");
}

// ------------------------------------------------------------------------------------------------ le nord vrai et le recadrage

/// Le nord vrai du fichier (`georeference.trueNorth`, plan du projet) dans le repère du viewer (x, 0, −y).
fn true_north_up(read: &Read) -> [f64; 3] {
    let north = read.metadata["georeference"]["trueNorth"].as_array().expect("nord vrai");
    [number(&north[0]), 0.0, -number(&north[1])]
}

#[test]
fn le_haut_d_un_plan_nord_vrai_est_m_vert_dir_qui_porte_deja_la_rotation() {
    // Le plan « Site » des DynamoSample est orienté sur le nord vrai (`m_bUseTrueNorth`) : son `m_vertDir` est exactement le nord vrai de l'emplacement
    // actif du fichier (37° du nord du projet), tel que `properties::geo` le lit. Le plan est donc écrit avec ce vecteur tel quel, sans le composer avec
    // la rotation du site (elle serait comptée deux fois) ; les plans qui n'ont pas l'indicateur ont le nord du projet en haut.
    let mut checked = 0;
    for file in ["DynamoSample_2014.rvt", "DynamoSample_2023.rvt", "DynamoSample_2024.rvt", "DynamoSample_2025.rvt", "SampleModel.rvt"] {
        let Some(path) = sample(file) else { continue };
        let read = open(&path);
        let north = true_north_up(&read);
        let find = |name: &str| read.plans().into_iter().find(|plan| plan["name"] == name).unwrap_or_else(|| panic!("{file} : plan {name}"));
        let up = vec3(&find("Site")["camera"]["up"]);
        assert!(up.iter().zip(north).all(|(found, expected)| (found - expected).abs() < 1e-6), "{file} : {up:?} contre le nord vrai {north:?}");
        assert!((north[0].atan2(-north[2]).to_degrees() - 37.0).abs() < 0.01, "{file} : {north:?}");
        // Le recadrage de ce plan est tourné comme lui : 37° dans le sens horaire vu d'en haut (-37° anti-horaire).
        assert!((number(&find("Site")["sectionBox"]["rotation"]) + 37.0).abs() < 1e-3, "{file} : {}", find("Site")["sectionBox"]);
        for name in ["Level 1", "Level 2"] {
            assert_eq!(vec3(&find(name)["camera"]["up"]), [0.0, 0.0, -1.0], "{file} : {name}");
            assert!(find(name)["sectionBox"].get("rotation").is_none(), "{file} : {name}");
        }
        checked += 1;
    }
    eprintln!("{checked} fichiers : le haut du plan « Site » est le nord vrai du fichier");
    // Les six autres plans « nord vrai » des fichiers d'essai (`m_bUseTrueNorth`) sont dans des fichiers dont le nord vrai est celui du projet :
    // leur haut est le nord du projet, qui est le nord vrai de `georeference`.
    for (file, name) in [("dynamo-nyc-site-2013.rvt", "2D Site"), ("dynamo-inst-param-2016.rvt", "2D Site"), ("dynamo-structural-framing-2014.rvt", "Level 1 - Analytical")] {
        let Some(path) = sample(file) else { continue };
        let read = open(&path);
        let plan = read.plans().into_iter().find(|plan| plan["name"] == name).unwrap_or_else(|| panic!("{file} : plan {name}"));
        assert_eq!(vec3(&plan["camera"]["up"]), true_north_up(&read), "{file} : {name}");
        assert_eq!(true_north_up(&read), [0.0, 0.0, -1.0], "{file}");
    }
}

#[test]
fn un_plan_recadre_a_la_taille_et_au_centre_de_son_recadrage() {
    // « Level 2 » de DynamoSample : recadrage de −23,25 à +45,95 pieds en x et de −50,97 à +14,80 pieds en y (plan Revit), depuis l'origine du plan.
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let read = open(&path);
    let level = read.plans().into_iter().find(|plan| plan["name"] == "Level 2").expect("plan Level 2");
    let size = &level["camera"]["size"];
    assert!((number(&size[0]) - 69.197_993_5 * 0.3048).abs() < 1e-5 && (number(&size[1]) - 65.767_688_3 * 0.3048).abs() < 1e-5, "{size}");
    // Position : le centre du recadrage, à la hauteur de coupe (13,78 pieds = 4,2 m) ; x = 11,346 pieds, z = −y = 18,088 pieds.
    let position = vec3(&level["camera"]["position"]);
    assert!((position[0] - 11.346_055_75 * 0.3048).abs() < 1e-5 && (position[1] - 4.2).abs() < 1e-3 && (position[2] - 18.087_998_98 * 0.3048).abs() < 1e-5, "{position:?}");
    // Boîte : la plage du plan en y (3,0 m à 4,2 m), le recadrage en x et z.
    let (min, max) = (vec3(&level["sectionBox"]["min"]), vec3(&level["sectionBox"]["max"]));
    assert!((min[1] - 3.0).abs() < 1e-3 && (max[1] - 4.2).abs() < 1e-3, "{}", level["sectionBox"]);
    // « Level 1 » n'a pas de profondeur (le niveau en dessous n'existe pas) : sa boîte descend à −10 000 m.
    let first = read.plans().into_iter().find(|plan| plan["name"] == "Level 1").expect("plan Level 1");
    assert!(first["range"].get("bottom").is_none());
    assert_eq!(vec3(&first["sectionBox"]["min"])[1], -10000.0);
    check_plans(&read, "DynamoSample_2024");
}

#[test]
fn les_plans_recadres_et_tournes_des_autres_fichiers_ont_une_plage_et_une_camera_valides() {
    let mut checked = 0;
    for file in [
        "2024_Core_Interior.rvt",
        "Project1-Central.rvt",
        "RE1-Electrical.rvt",
        "Vignette-04-BaseFile.rvt",
        "SampleModel.rvt",
        "revit-curtainwall-byprofile_v21.rvt",
        "mega_advanced_sample_file.rvt",
        "dynamo-nyc-site-2013.rvt",
    ] {
        let Some(path) = sample(file) else { continue };
        let read = open(&path);
        assert!(!read.plans().is_empty(), "{file} : aucun plan");
        check_plans(&read, file);
        checked += 1;
    }
    // Un plan tourné qui n'est pas « nord vrai » : `ROOF_02` de Vignette-04, recadré dans un repère à 29° du projet.
    if let Some(path) = sample("Vignette-04-BaseFile.rvt") {
        let read = open(&path);
        let roof = read.plans().into_iter().find(|plan| plan["name"] == "ROOF_02").expect("plan ROOF_02");
        assert!((number(&roof["sectionBox"]["rotation"]) + 29.0).abs() < 0.1, "{}", roof["sectionBox"]);
        let up = vec3(&roof["camera"]["up"]);
        assert!((up[0] - 0.4848).abs() < 1e-3 && (up[2] + 0.8746).abs() < 1e-3, "{up:?}");
    }
    eprintln!("{checked} fichiers : plans valides");
}

// ------------------------------------------------------------------------------------------------ comptes figés

#[test]
fn rac_advanced_sample_project_a_treize_plans_dont_trois_plans_de_surface() {
    // Compte figé : ce que la lecture trouve, non ce qu'on attendait. 23 enregistrements `DBViewPlan` (gabarits et plans de plafond compris),
    // 13 plans d'étage : 10 plans d'étage, 3 plans de surface (`DBViewTypeAreaPlan`, type « Gross Building » : `m_planViewType` 1 comme les autres).
    // Ces trois-là sont lus comme des plans (coupe, plage, recadrage) : les limites de surface et les remplissages de couleur ne se dessinent pas.
    let Some(path) = sample("rac_advanced_sample_project.rvt") else { return };
    let read = open(&path);
    assert_eq!(read.plans().len(), 13);
    let areas = read.plans().iter().filter(|plan| plan["type"] == "Gross Building").count();
    let floors = read.plans().iter().filter(|plan| plan["type"] == "Floor Plan").count();
    assert_eq!((floors, areas), (10, 3));
    check_plans(&read, "rac_advanced_sample_project");
    // Les vues 3D du fichier sont celles d'avant : 7, « {3D} » d'abord.
    assert_eq!(read.views_3d().len(), 7);
    assert_eq!(read.views()[0]["name"], "{3D}");
}
