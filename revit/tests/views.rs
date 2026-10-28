//! Les phases et les vues 3D enregistrées : ce que la lecture en écrit dans le JSON de métadonnées (sections `phases` et
//! `views` du contrat) et ce que les fichiers d'essai en disent.
//!
//! Le fichier committé (Revit 2023, `tests/fixtures`) sert toujours ; les autres viennent de `revit/samples/` (voir
//! `npm run samples:revit`) et leurs essais passent sans rien faire quand ils manquent.

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
    fn phases(&self) -> &Value {
        &self.metadata["phases"]
    }

    /// Les vues 3D. Les plans d'étage (`"kind": "plan"`, après les vues 3D) ont leurs essais dans `tests/plans.rs`.
    fn views(&self) -> Vec<&Value> {
        self.metadata["views"].as_array().into_iter().flatten().filter(|view| view.get("kind").is_none()).collect()
    }

    fn plans(&self) -> Vec<&Value> {
        self.metadata["views"].as_array().into_iter().flatten().filter(|view| view["kind"] == "plan").collect()
    }

    fn view(&self, name: &str) -> &Value {
        self.views().into_iter().find(|view| view["name"] == name).unwrap_or_else(|| panic!("vue « {name} » absente"))
    }

    fn order(&self) -> Vec<&str> {
        self.phases()["order"].as_array().map_or(vec![], |order| order.iter().filter_map(Value::as_str).collect())
    }

    fn filter(&self, name: &str) -> &Value {
        self.phases()["filters"].as_array().and_then(|filters| filters.iter().find(|filter| filter["name"] == name)).unwrap_or_else(|| panic!("filtre « {name} » absent"))
    }

    /// Les coins du modèle dessiné, dans le repère du projet (mètres, Y vers le haut) : positions + origine.
    fn bounds(&self) -> ([f64; 3], [f64; 3]) {
        let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for vertex in self.output.positions.chunks_exact(3) {
            for axis in 0..3 {
                let x = f64::from(vertex[axis]) + self.output.origin[axis];
                min[axis] = min[axis].min(x);
                max[axis] = max[axis].max(x);
            }
        }
        (min, max)
    }
}

fn vec3(value: &Value) -> [f64; 3] {
    let array = value.as_array().expect("vecteur");
    assert_eq!(array.len(), 3, "{value}");
    [array[0].as_f64().expect("nombre"), array[1].as_f64().expect("nombre"), array[2].as_f64().expect("nombre")]
}

fn statuses(filter: &Value) -> Vec<(&str, &str)> {
    let mut out: Vec<(&str, &str)> = filter["statuses"].as_object().expect("états").iter().map(|(k, v)| (k.as_str(), v.as_str().expect("présentation"))).collect();
    out.sort_unstable();
    out
}

// ------------------------------------------------------------------------------------------------ phases

#[test]
fn le_fichier_committe_a_deux_phases_dans_l_ordre_du_projet() {
    let read = open(&PathBuf::from(FIXTURE));
    assert_eq!(read.order(), ["Existing", "New Construction"]);
    // Les propriétés des éléments que le viewer lira, par leur nom : rien n'est écrit en dur côté viewer.
    assert_eq!(read.phases()["created"], "Phase de création");
    assert_eq!(read.phases()["demolished"], "Phase de démolition");
    // Les éléments ont bien ces propriétés, et ce sont des noms de la liste ordonnée.
    let order = read.order();
    let elements = read.metadata["elements"].as_object().expect("éléments");
    let created: BTreeSet<&str> = elements.values().filter_map(|e| e["properties"]["Phase de création"].as_str()).collect();
    assert!(!created.is_empty(), "aucun élément n'a de phase de création");
    assert!(created.iter().all(|name| order.contains(name)), "{created:?}");
}

#[test]
fn les_filtres_de_phase_se_decodent_comme_les_filtres_livres_avec_revit() {
    let read = open(&PathBuf::from(FIXTURE));
    let names: Vec<&str> = read.phases()["filters"].as_array().expect("filtres").iter().filter_map(|filter| filter["name"].as_str()).collect();
    assert_eq!(names, ["Show Previous Phase", "Show Previous + New", "Show Previous + Demo", "Show Demo + New", "Show All"]);
    let all = read.filter("Show All");
    assert_eq!(all["default"], true);
    // « Tout afficher » : l'existant, le démoli et le temporaire remplacés, le nouveau tel quel, le passé et le futur masqués.
    assert_eq!(
        statuses(all),
        [("demolished", "overridden"), ("existing", "overridden"), ("future", "hidden"), ("new", "normal"), ("past", "hidden"), ("temporary", "overridden")]
    );
    let shown = |name: &str| statuses(read.filter(name)).into_iter().filter(|(_, presentation)| *presentation != "hidden").collect::<Vec<_>>();
    assert_eq!(shown("Show Previous Phase"), [("existing", "overridden")]);
    assert_eq!(shown("Show Previous + New"), [("existing", "overridden"), ("new", "normal")]);
    assert_eq!(shown("Show Previous + Demo"), [("demolished", "overridden"), ("existing", "overridden")]);
    assert_eq!(shown("Show Demo + New"), [("demolished", "overridden"), ("new", "normal"), ("temporary", "overridden")]);
    // Un seul filtre est celui des vues neuves.
    let defaults = read.phases()["filters"].as_array().expect("filtres").iter().filter(|filter| filter["default"] == true).count();
    assert_eq!(defaults, 1);
}

#[test]
fn les_filtres_en_plus_d_un_projet_se_decodent_aussi() {
    // curtainwall : « Show Complete » (existant et nouveau tels quels), « Show New », « Show Demo ».
    let Some(path) = sample("revit-curtainwall-byprofile_v21.rvt") else { return };
    let read = open(&path);
    let shown = |name: &str| statuses(read.filter(name)).into_iter().filter(|(_, presentation)| *presentation != "hidden").collect::<Vec<_>>();
    assert_eq!(shown("Show Complete"), [("existing", "normal"), ("new", "normal")]);
    assert_eq!(shown("Show New"), [("new", "normal")]);
    assert_eq!(shown("Show Demo"), [("demolished", "overridden")]);
    assert_eq!(shown("Show Demo + New"), [("demolished", "overridden"), ("new", "normal"), ("temporary", "overridden")]);
}

#[test]
fn les_remplacements_graphiques_viennent_des_materiaux_de_phase_du_fichier() {
    // Le fichier committé n'a pas de matériau de remplacement (ceux de son gabarit valent -1) : rien n'est inventé.
    let read = open(&PathBuf::from(FIXTURE));
    assert!(read.phases().get("overrides").is_none());
    // DynamoSample (Revit 2024) : « Phase - Exist » gris 127, opaque ; « Phase - Demo » rouge, transparence 0,4 ;
    // « Phase - Temporary » bleu foncé, transparence 0,4 (COLORREF : octets bleu, vert, rouge).
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let read = open(&path);
    let overrides = &read.phases()["overrides"];
    assert_eq!(overrides["existing"]["color"], "#7f7f7f");
    assert!(overrides["existing"].get("opacity").is_none());
    assert_eq!(overrides["demolished"]["color"], "#ff0000");
    assert_eq!(overrides["demolished"]["opacity"], 0.6);
    assert_eq!(overrides["temporary"]["color"], "#00007f");
    assert_eq!(overrides["temporary"]["opacity"], 0.6);
}

#[test]
fn plusieurs_phases_dans_l_ordre_de_leur_enregistrement() {
    // DynamoSample : trois phases, les éléments sont créés dans la deuxième.
    if let Some(path) = sample("DynamoSample_2024.rvt") {
        let read = open(&path);
        assert_eq!(read.order(), ["Existing", "Working Drawings", "Learning Content"]);
        let elements = read.metadata["elements"].as_object().expect("éléments");
        assert!(elements.values().any(|e| e["properties"]["Phase de création"] == "Working Drawings"));
        assert!(elements.values().all(|e| e["properties"]["Phase de création"].as_str().is_none_or(|name| read.order().contains(&name))));
    }
    // revit-curtainwall-byprofile : neuf phases (« 01 - Existing », « 02 - Demo », … « Project Completion »), dont une d'identifiant 0.
    if let Some(path) = sample("revit-curtainwall-byprofile_v21.rvt") {
        let read = open(&path);
        assert_eq!(
            read.order(),
            ["01 - Existing", "02 - Demo", "A10 - Substructure", "B10 - Superstructure", "B20 - Exterior Enclosure", "C10 - Interior Construction", "C20 - Interior Finishes", "E20 - Furnishings", "Project Completion"]
        );
        // Ses filtres comptent « Show Demo » et « Show Complete » que les autres gabarits n'ont pas tous.
        assert_eq!(statuses(read.filter("Show Demo")).iter().filter(|(_, p)| *p != "hidden").collect::<Vec<_>>(), [&("demolished", "overridden")]);
        let elements = read.metadata["elements"].as_object().expect("éléments");
        assert!(elements.values().any(|e| e["properties"]["Phase de création"] == "Project Completion"));
    }
}

#[test]
fn une_phase_d_identifiant_zero_est_bien_celle_des_elements_qui_la_portent() {
    // Refinery : la phase « New Construction » porte l'identifiant 0, et ses 175 éléments y sont créés. Un identifiant 0
    // pris pour « aucune phase » leur retirait la propriété.
    let Some(path) = sample("RefineryPrimer-2024-BuildingGenerator.rvt") else { return };
    let read = open(&path);
    assert_eq!(read.order(), ["Existing", "New Construction"]);
    let elements = read.metadata["elements"].as_object().expect("éléments");
    let created = elements.values().filter(|e| e["properties"]["Phase de création"] == "New Construction").count();
    assert!(created > 100, "{created} éléments dans « New Construction »");
}

// ------------------------------------------------------------------------------------------------ vues

/// La demi-droite de la caméra passe par la sphère englobante du modèle, ou la caméra y est : « elle regarde la maquette ».
fn looks_at_model(read: &Read, camera: &Value) -> bool {
    let (min, max) = read.bounds();
    let centre = [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0, (min[2] + max[2]) / 2.0];
    let radius = ((max[0] - min[0]).powi(2) + (max[1] - min[1]).powi(2) + (max[2] - min[2]).powi(2)).sqrt() / 2.0;
    let (position, direction) = (vec3(&camera["position"]), vec3(&camera["direction"]));
    let to_centre = [centre[0] - position[0], centre[1] - position[1], centre[2] - position[2]];
    let along = to_centre[0] * direction[0] + to_centre[1] * direction[1] + to_centre[2] * direction[2];
    let distance = (to_centre.iter().map(|x| x * x).sum::<f64>() - along * along).max(0.0).sqrt();
    to_centre.iter().map(|x| x * x).sum::<f64>().sqrt() <= radius || (along > 0.0 && distance <= radius)
}

/// `aimed` : toutes les vues regardent la maquette (vrai pour les bâtiments, pas pour les petits fichiers dont la vue par défaut
/// regarde l'origine du gabarit).
fn check_cameras(read: &Read, aimed: bool) {
    assert!(!read.views().is_empty());
    for view in read.views() {
        let camera = &view["camera"];
        let name = view["name"].as_str().expect("nom");
        let (direction, up) = (vec3(&camera["direction"]), vec3(&camera["up"]));
        let norm = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        assert!((norm(direction) - 1.0).abs() < 1e-6 && (norm(up) - 1.0).abs() < 1e-6, "{name} : vecteurs non unitaires");
        assert!((direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2]).abs() < 1e-6, "{name} : haut non perpendiculaire au regard");
        match camera["projection"].as_str() {
            Some("perspective") => {
                if let Some(fov) = camera.get("fov") {
                    assert!((10.0..=170.0).contains(&fov.as_f64().expect("champ")), "{name} : champ {fov}");
                }
                assert!(camera.get("size").is_none(), "{name}");
            }
            Some("orthographic") => assert!(camera.get("fov").is_none(), "{name}"),
            other => panic!("{name} : projection {other:?}"),
        }
        assert!(!aimed || looks_at_model(read, camera), "{name} : la caméra ne regarde pas la maquette ({camera})");
    }
}

#[test]
fn les_vues_du_fichier_committe_ont_une_camera_valide() {
    // {3D} : la vue par défaut d'un projet jamais recadrée regarde l'origine du gabarit, pas la maquette : on vérifie les
    // vecteurs, pas le cadrage (voir `les_vues_de_dynamo_sample…` pour des vues qui regardent un bâtiment).
    let read = open(&PathBuf::from(FIXTURE));
    check_cameras(&read, false);
    // Vue par défaut {3D} : parallèle, en isométrique (regard à 45° vers le bas, en diagonale).
    let camera = &read.view("{3D}")["camera"];
    assert_eq!(camera["projection"], "orthographic");
    let direction = vec3(&camera["direction"]);
    assert!(direction.iter().all(|x| (x.abs() - 0.577_350_269).abs() < 1e-6), "{direction:?}");
    // Phase et filtre de la vue sont des noms de la section `phases`.
    let phase = read.view("{3D}")["phase"].as_str().expect("phase");
    assert!(read.order().contains(&phase));
    assert!(read.phases()["filters"].as_array().expect("filtres").iter().any(|filter| filter["name"] == read.view("{3D}")["phaseFilter"]));
}

#[test]
fn les_vues_de_dynamo_sample_ont_leur_camera_leur_boite_et_leurs_elements_masques() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let read = open(&path);
    check_cameras(&read, true);
    assert_eq!(read.views().len(), 7);
    let names: Vec<&str> = read.views().iter().filter_map(|view| view["name"].as_str()).collect();
    assert_eq!(names, ["{3D}", "Approach", "From Yard", "Kitchen", "Living Room", "Section Perspective", "Solar Analysis"]);

    // Cinq perspectives, avec un champ vertical déduit de la fenêtre de recadrage.
    let kitchen = &read.view("Kitchen")["camera"];
    assert_eq!(kitchen["projection"], "perspective");
    assert!((kitchen["fov"].as_f64().expect("champ") - 57.52).abs() < 0.01);
    // L'œil de la cuisine : (-15,124 ; -8,985 ; 4,921) pieds du projet → x, z, -y en mètres.
    let eye = vec3(&kitchen["position"]);
    assert!((eye[0] - (-15.124_359_7 * 0.3048)).abs() < 1e-3 && (eye[1] - 4.921_259_8 * 0.3048).abs() < 1e-3 && (eye[2] - 8.984_615_9 * 0.3048).abs() < 1e-3, "{eye:?}");

    // La vue « Solar Analysis » est parallèle, sans fenêtre réglée : pas de taille. Sa boîte de coupe est active.
    assert_eq!(read.view("Solar Analysis")["camera"]["projection"], "orthographic");
    assert!(read.view("Solar Analysis")["camera"].get("size").is_none());
    // « {3D} » garde la fenêtre qu'elle montrait : 328 × 158 pieds.
    let size = read.view("{3D}")["camera"]["size"].as_array().expect("taille").iter().filter_map(Value::as_f64).collect::<Vec<_>>();
    assert!((size[0] - 99.94).abs() < 0.01 && (size[1] - 48.19).abs() < 0.01, "{size:?}");

    // Boîtes de coupe : actives pour deux vues seulement, dans les étendues du modèle (elles les recoupent et ne les
    // dépassent pas de plus de leur taille).
    let (min, max) = read.bounds();
    let with_box: Vec<&str> = read.views().iter().filter(|view| view.get("sectionBox").is_some()).filter_map(|view| view["name"].as_str()).collect();
    assert_eq!(with_box, ["Section Perspective", "Solar Analysis"]);
    for name in with_box {
        let b = &read.view(name)["sectionBox"];
        let (bmin, bmax) = (vec3(&b["min"]), vec3(&b["max"]));
        for axis in 0..3 {
            assert!(bmin[axis] < bmax[axis], "{name}");
            assert!(bmin[axis] < max[axis] && bmax[axis] > min[axis], "{name} : la boîte ne recoupe pas le modèle sur l'axe {axis}");
            assert!(bmax[axis] - bmin[axis] < 3.0 * (max[axis] - min[axis]) + 1.0, "{name} : boîte démesurée sur l'axe {axis}");
        }
        // Boîte alignée sur les axes du projet.
        assert!(b.get("rotation").is_none());
    }

    // Éléments masqués : leurs clés existent dans le modèle.
    let keys: BTreeSet<&str> = read.output.keys.iter().map(String::as_str).collect();
    let hidden = read.view("Section Perspective")["hiddenElements"].as_array().expect("éléments masqués");
    assert!(!hidden.is_empty());
    assert!(hidden.iter().all(|key| keys.contains(key.as_str().expect("clé"))));
    // Phase et filtre : des noms de la section `phases`.
    for view in read.views() {
        assert_eq!(view["phase"], "Working Drawings");
        assert_eq!(view["phaseFilter"], "Show All");
    }
}

#[test]
fn les_categories_et_les_elements_masques_d_une_vue_existent_dans_le_modele() {
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let read = open(&path);
    check_cameras(&read, false);
    let view = read.view("Demo Export");
    assert!(looks_at_model(&read, &view["camera"]));
    // Les murs sont masqués par catégorie : la propriété de catégorie est nommée par le contrat, et des éléments la portent.
    assert_eq!(view["hiddenCategories"]["property"], "Catégorie");
    let values: Vec<&str> = view["hiddenCategories"]["values"].as_array().expect("valeurs").iter().filter_map(Value::as_str).collect();
    assert_eq!(values, ["Murs"]);
    let elements = read.metadata["elements"].as_object().expect("éléments");
    assert!(elements.values().any(|e| e["properties"]["Catégorie"] == "Murs"));
    // Ses éléments masqués sont des éléments du modèle.
    let keys: BTreeSet<&str> = read.output.keys.iter().map(String::as_str).collect();
    let hidden = view["hiddenElements"].as_array().expect("éléments masqués");
    assert!(hidden.len() > 10 && hidden.iter().all(|key| keys.contains(key.as_str().expect("clé"))));
    // Une perspective à 80° : la vue « Demo Export » a un champ de 80°.
    assert_eq!(view["camera"]["fov"], 80.0);
}

#[test]
fn les_vues_des_fichiers_de_2017_et_des_familles_se_lisent_aussi() {
    if let Some(path) = sample("SampleModel.rvt") {
        let read = open(&path);
        check_cameras(&read, true);
        // Trois boîtes de coupe actives : « {3D} », « Section Perspective » et « Solar Analysis ».
        let boxes = read.views().iter().filter(|view| view.get("sectionBox").is_some()).count();
        assert_eq!(boxes, 3);
        assert_eq!(read.order(), ["Existing", "Working Drawings", "Learning Content"]);
    }
    // Une famille a des vues 3D et pas de phase.
    if let Some(path) = sample("ShellFamily.rfa") {
        let read = open(&path);
        assert!(read.metadata.get("phases").is_none());
        assert_eq!(read.views().len(), 2);
    }
}

#[test]
fn les_phases_des_vues_de_revit_curtainwall_couvrent_tout_le_projet() {
    // Une vue par phase, chacune avec son filtre : « 02 - Demo » montre le démoli, les autres « Show Previous + New ».
    let Some(path) = sample("revit-curtainwall-byprofile_v21.rvt") else { return };
    let read = open(&path);
    check_cameras(&read, false);
    assert_eq!(read.view("02 - Demo")["phase"], "02 - Demo");
    assert_eq!(read.view("02 - Demo")["phaseFilter"], "Show Previous + Demo");
    assert_eq!(read.view("B10 - Superstructure")["phase"], "B10 - Superstructure");
    assert_eq!(read.view("Perspective 3D")["phase"], "Project Completion");
    assert_eq!(read.view("Perspective 3D")["phaseFilter"], "Show Complete");
    // Toutes les vues nomment une phase de la liste.
    for view in read.views() {
        assert!(read.order().contains(&view["phase"].as_str().expect("phase")), "{view}");
    }
}

#[test]
fn un_projet_sans_vue_3d_n_ecrit_que_ses_plans_d_etage() {
    // Les vues 3D de ce modèle de projet sont des gabarits sans caméra : il n'a aucune vue 3D à écrire. Ses trois plans d'étage (voir
    // `tests/plans.rs`) sont, eux, dans la section `views` : sans eux, la section serait absente comme avant.
    let Some(path) = sample("RoomsAndExits.rvt") else { return };
    let read = open(&path);
    assert!(read.views().is_empty());
    assert_eq!(read.plans().len(), 3);
    assert!(read.metadata.get("phases").is_some());
    assert!(read.metadata.get("elements").is_some());
}
