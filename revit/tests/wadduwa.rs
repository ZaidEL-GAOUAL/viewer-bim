//! Les voitures importées en DWG dans leur famille, leurs couleurs, les arbres RPC posés sur le sol : les budgets de
//! lecture des graphiques (3 millions de valeurs, octets d'un enregistrement bornés à 8 000 000), les voitures de
//! `wadduwa.rvt` (un fichier privé de l'utilisateur, jamais commité : les essais qui l'utilisent passent sans rien faire
//! quand il est absent de `revit/samples/`), le décalage des arbres (surcouche) et le pas de sept octets de la table des matériaux.
//!
//! À lancer avec `cargo test --release --test wadduwa` : en débogage, le décodage est long.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::OnceLock;

use revit::geometry::pack::MATERIAL_STRIDE;
use revit::geometry::saved::{GEOMETRY_GRAPH_LIMIT, GRAPH_LIMIT, graph_limit};
use revit::native::records::{MAX_RECORD_BYTES, OVERSIZE_BYTES_PER_VALUE, oversize_limit};
use revit::native::{self, Options};
use revit::{Output, read};

fn sample_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

/// Les octets d'un fichier d'essai, ou `None` (essai ignoré) s'il n'a pas été téléchargé.
fn sample_bytes(relative: &str) -> Option<Vec<u8>> {
    let path = sample_path(relative);
    if !path.exists() {
        eprintln!("{relative} absent : essai ignoré");
        return None;
    }
    Some(std::fs::read(&path).unwrap_or_else(|error| panic!("{relative} illisible : {error}")))
}

// ---------------------------------------------------------------------------------------------
// Les budgets de lecture
// ---------------------------------------------------------------------------------------------

/// Le canal 103 (les graphiques que l'on dessine) a un budget de 3 millions de valeurs et d'objets ; le canal 102 (les enregistrements
/// d'éléments, dont les propriétés) garde 1 million.
#[test]
fn les_budgets_de_valeurs_des_canaux_102_et_103_different() {
    assert_eq!(GRAPH_LIMIT, 1_000_000);
    assert_eq!(GEOMETRY_GRAPH_LIMIT, 3_000_000);
    assert_eq!(graph_limit(102), GRAPH_LIMIT);
    assert_eq!(graph_limit(103), GEOMETRY_GRAPH_LIMIT);
    // Le « Peugeot 208.DWG » de wadduwa.rvt demande 1 970 695 valeurs et 198 objets : au-dessus de l'ancien budget, dans le nouveau.
    assert!(1_970_695 > GRAPH_LIMIT && 1_970_695 <= GEOMETRY_GRAPH_LIMIT);
}

/// La borne en octets d'un enregistrement avant tout décodage ne suit pas le budget de valeurs : celle du million de valeurs,
/// 1 000 000 × 8 octets, pour le canal 103 comme pour le canal 102. Sans elle, le budget de 3 millions laisserait décoder (pour le
/// refuser ensuite) le `DirectShapeType` de 16,5 Mo de Core Interior.
#[test]
fn la_borne_en_octets_d_un_enregistrement_ne_suit_pas_le_budget_de_valeurs() {
    assert_eq!(MAX_RECORD_BYTES, GRAPH_LIMIT * OVERSIZE_BYTES_PER_VALUE);
    assert_eq!(MAX_RECORD_BYTES, 8_000_000);
    // Le budget des graphiques n'élargit pas la borne : 3 millions de valeurs, la même que pour 1 million.
    assert_eq!(oversize_limit(GEOMETRY_GRAPH_LIMIT), MAX_RECORD_BYTES);
    assert_eq!(oversize_limit(GEOMETRY_GRAPH_LIMIT), oversize_limit(GRAPH_LIMIT));
    assert_ne!(oversize_limit(GEOMETRY_GRAPH_LIMIT), GEOMETRY_GRAPH_LIMIT * OVERSIZE_BYTES_PER_VALUE);
    // Un petit budget garde sa borne proportionnelle (les essais qui refusent tout avec un budget de 1 valeur).
    assert_eq!(oversize_limit(1), OVERSIZE_BYTES_PER_VALUE);
    assert_eq!(oversize_limit(0), 0);
    assert_eq!(oversize_limit(usize::MAX), MAX_RECORD_BYTES);
    // Le Peugeot (3 769 685 octets) et le Citroën (3 363 927) passent la borne.
    assert!(3_769_685 <= MAX_RECORD_BYTES && 3_363_927 <= MAX_RECORD_BYTES);
}

/// Sur Core Interior, le `DirectShapeType` (130286, 16,5 Mo) reste refusé d'emblée avec le budget des graphiques, sans être décodé : le
/// diagnostic le dit, et c'est la borne en octets qui le dit, pas le budget de valeurs.
#[test]
fn le_direct_shape_type_de_core_interior_reste_refuse_d_emblee() {
    let Some(bytes) = sample_bytes("samples/2024_Core_Interior.rvt") else { return };
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let options = Options { channels: BTreeSet::from([103]), selected_ids: BTreeSet::from([130_286]), max_graph_values: GEOMETRY_GRAPH_LIMIT, max_graph_objects: GEOMETRY_GRAPH_LIMIT, ..Default::default() };
    let mut seen = 0;
    native::extract_graphs(&mut file, &options, |record| {
        seen += 1;
        assert!(record.graph.is_none(), "l'enregistrement est refusé");
        assert!(record.source.body_bytes > MAX_RECORD_BYTES, "{} octets", record.source.body_bytes);
        let diagnostic = record.diagnostic.clone().unwrap_or_default();
        assert!(diagnostic.contains("non décodé") && diagnostic.contains(&MAX_RECORD_BYTES.to_string()), "{diagnostic}");
        Ok(())
    })
    .expect("lecture");
    assert_eq!(seen, 1);
}

// ---------------------------------------------------------------------------------------------
// wadduwa.rvt : les cinq voitures, les quatre arbres
// ---------------------------------------------------------------------------------------------

/// La lecture de `wadduwa.rvt`, faite une fois pour les essais qui la partagent ; `None` quand le fichier est absent.
fn wadduwa() -> Option<&'static Output> {
    static OUTPUT: OnceLock<Option<Output>> = OnceLock::new();
    OUTPUT
        .get_or_init(|| {
            let bytes = sample_bytes("samples/wadduwa.rvt")?;
            Some(read(&bytes, &revit::Options::default()).expect("lecture de wadduwa.rvt"))
        })
        .as_ref()
}

/// Ce que la sortie dit d'un élément : sa source, ses triangles, ceux de surcouche (priorité 1) et d'hôte (priorité 2), et ses triangles par
/// ligne de la table des matériaux.
struct Seen {
    name: String,
    source: u8,
    triangles: usize,
    overlay: usize,
    host: usize,
    by_material: BTreeMap<usize, usize>,
}

fn elements(output: &Output) -> Vec<Seen> {
    let mut seen: Vec<Seen> = output.names.iter().zip(&output.sources).map(|(name, source)| Seen { name: name.clone(), source: *source, triangles: 0, overlay: 0, host: 0, by_material: BTreeMap::new() }).collect();
    for primitive in output.primitives.chunks_exact(6) {
        let (element, triangles, material) = (primitive[0] as usize, primitive[4] as usize / 3, primitive[5] as usize);
        seen[element].triangles += triangles;
        match output.materials[material * MATERIAL_STRIDE + 6] {
            1 => seen[element].overlay += triangles,
            2 => seen[element].host += triangles,
            _ => {}
        }
        *seen[element].by_material.entry(material).or_default() += triangles;
    }
    seen
}

/// La priorité de profondeur d'un élément (octet 6 des matériaux de ses primitives), s'il n'en a qu'une ; panique s'il en mêle.
fn depth_of(output: &Output, index: usize) -> u8 {
    let depths: BTreeSet<u8> = output.primitives.chunks_exact(6).filter(|p| p[0] as usize == index).map(|p| output.materials[p[5] as usize * MATERIAL_STRIDE + 6]).collect();
    assert_eq!(depths.len(), 1, "{} : priorités {depths:?}", output.names[index]);
    *depths.iter().next().unwrap()
}

/// L'`Identifiant Revit` de chaque élément (son numéro dans la sortie) d'après le JSON de métadonnées.
fn revit_ids(output: &Output) -> BTreeMap<u64, usize> {
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    output.keys.iter().enumerate().filter_map(|(index, key)| Some((metadata["elements"][key]["properties"]["Identifiant Revit"].as_u64()?, index))).collect()
}

/// La couleur (octets sRGB) d'une ligne de la table des matériaux.
fn color(output: &Output, material: usize) -> [u8; 4] {
    let row = &output.materials[material * MATERIAL_STRIDE..][..MATERIAL_STRIDE];
    [row[0], row[1], row[2], row[3]]
}

/// La couleur qui porte le plus de triangles d'un élément.
fn dominant(output: &Output, element: &Seen) -> [u8; 4] {
    let (material, _) = element.by_material.iter().max_by_key(|(_, triangles)| **triangles).expect("un élément dessiné");
    color(output, *material)
}

/// Les cinq voitures (« Blue Car » ×3, « Red Car » ×2) ne sont plus des boîtes « Inconnue » : la DWG importée dans leur famille se lit
/// (budget de 3 millions de valeurs), et chacune a plus de 100 000 triangles. Toutes sont entières (source 0) : les neuf instances à
/// échelle des calques de la « Red Car » sont vides, et les huit de la « Blue Car » qui placent les roues sont de matrice identité, une
/// échelle uniforme, donc placées comme les autres. Les couleurs sont celles des matériaux des calques : la carrosserie est rouge pour
/// l'une, bleue pour l'autre, et les roues, du style de calque « 0 » (« Render Material 255-255-255 »), sont blanches.
#[test]
fn wadduwa_les_cinq_voitures_sont_dessinees_et_colorees() {
    let Some(output) = wadduwa() else { return };
    let seen = elements(output);
    let blue: Vec<&Seen> = seen.iter().filter(|e| e.name.starts_with("Blue Car")).collect();
    let red: Vec<&Seen> = seen.iter().filter(|e| e.name.starts_with("Red Car")).collect();
    assert_eq!((blue.len(), red.len()), (3, 2));
    for car in blue.iter().chain(&red) {
        assert_ne!(car.source, 3, "{} : une boîte « Inconnue »", car.name);
        assert!(car.triangles > 100_000, "{} : {} triangles", car.name, car.triangles);
        assert_eq!(car.overlay, 0, "{} : une voiture n'est pas une surcouche", car.name);
    }
    assert!(red.iter().chain(&blue).all(|car| car.source == 0 && car.overlay == 0 && car.host == 0), "les cinq voitures sont entières, ordinaires : les roues de la Blue Car sont placées");
    // Les triangles : la Peugeot a ses neuf calques (141 806) et ses huit roues (7 120), le Citroën ses dix calques.
    assert!(blue.iter().all(|car| car.triangles == 148_926), "Blue Car : {:?}", blue.iter().map(|car| car.triangles).collect::<Vec<_>>());
    assert!(red.iter().all(|car| car.triangles == 123_868), "Red Car : {:?}", red.iter().map(|car| car.triangles).collect::<Vec<_>>());
    // Les roues : 7 120 triangles blancs en plus du calque blanc de la carrosserie (10 566).
    for car in &blue {
        let white: usize = car.by_material.iter().filter(|(material, _)| color(output, **material) == [255, 255, 255, 255]).map(|(_, triangles)| *triangles).sum();
        assert_eq!(white, 10_566 + 7_120, "{} : triangles blancs", car.name);
    }
    // La couleur dominante : celle de la carrosserie (36,8 % des facettes de la Peugeot, 40,0 % du Citroën).
    for car in &blue {
        let [r, g, b, a] = dominant(output, car);
        assert!(b >= 100 && r < 40 && g < 40 && a == 255, "{} : {:?}", car.name, [r, g, b, a]);
    }
    for car in &red {
        let [r, g, b, a] = dominant(output, car);
        assert!(r >= 100 && g < 30 && b < 30 && a == 255, "{} : {:?}", car.name, [r, g, b, a]);
    }
    // Les parties communes sont les mêmes : la vitre (15 15 18, 30 % de transparence) est dans les deux voitures.
    let glass = |car: &Seen| car.by_material.keys().any(|material| color(output, *material) == [15, 15, 18, 178]);
    assert!(glass(blue[0]) && glass(red[0]), "la vitre est transparente dans les deux voitures");
}

/// Les quatre arbres RPC (« M_RPC Tree ») ont des triangles de surcouche, leur silhouette et leur empreinte au sol ; les sols n'en
/// ont aucun (ce sont des hôtes), et seuls les arbres et les cinq plans DWG importés (voir plus bas) en ont. Et la table des matériaux a sept
/// octets par ligne.
#[test]
fn wadduwa_les_quatre_arbres_ont_une_surcouche_et_les_sols_aucune() {
    let Some(output) = wadduwa() else { return };
    assert_eq!(output.materials.len() % MATERIAL_STRIDE, 0);
    let seen = elements(output);
    let trees: Vec<&Seen> = seen.iter().filter(|e| e.name.starts_with("M_RPC Tree")).collect();
    let floors: Vec<&Seen> = seen.iter().filter(|e| e.name.starts_with("Sol :")).collect();
    assert_eq!(trees.len(), 4);
    assert!(floors.len() >= 7);
    for tree in &trees {
        assert!(tree.overlay > 0, "{} : aucune surcouche", tree.name);
    }
    for floor in &floors {
        assert_eq!(floor.overlay, 0, "{} : un sol n'est pas une surcouche", floor.name);
    }
    let owners: BTreeSet<&str> = seen.iter().filter(|e| e.overlay > 0).map(|e| e.name.as_str()).filter(|name| !name.ends_with(".dwg")).collect();
    assert_eq!(owners.len(), 3, "hors plans DWG, seuls les arbres (3 familles) ont une surcouche : {owners:?}");
    assert_eq!(seen.iter().filter(|e| e.overlay > 0 && !e.name.ends_with(".dwg")).count(), 4);
}

/// Une priorité de profondeur a sa propre ligne de matériau : jamais la même qu'une face d'une autre priorité de la même couleur.
#[test]
fn wadduwa_une_priorite_ne_partage_pas_sa_ligne_avec_une_autre() {
    let Some(output) = wadduwa() else { return };
    let mut rows: [BTreeSet<usize>; 3] = Default::default();
    for primitive in output.primitives.chunks_exact(6) {
        let material = primitive[5] as usize;
        rows[output.materials[material * MATERIAL_STRIDE + 6] as usize].insert(material);
    }
    assert!(rows.iter().all(|set| !set.is_empty()), "les trois priorités existent dans wadduwa");
    assert!(rows[0].is_disjoint(&rows[1]) && rows[0].is_disjoint(&rows[2]) && rows[1].is_disjoint(&rows[2]));
}

/// La priorité de profondeur d'un élément est celle de sa classe : les hôtes système (murs, sols, toitures, plafonds, topographie, plateformes) sont à
/// 2 ; les escaliers, garde-corps, poteaux et familles à 0 ; les imports CAD et l'image d'un contenu RPC à 1. Quand des faces de deux éléments
/// sont exactement dans le même plan, la plus prioritaire gagne : les faces latérales de l'escalier 676369 et de la volée 680413 contre les murs
/// 681797, 685962 et 567439 (1,5 à 2,5 m² chacun, la ligne diagonale en pointillés et les traînées sombres de l'utilisateur), et le dessus des
/// 38 poteaux (« Poteaux », « Poteaux porteurs ») contre la dalle qui les couvre (les carrés blancs qui scintillaient sur les toits).
#[test]
fn wadduwa_les_hotes_passent_devant_ce_qui_leur_est_coplanaire() {
    let Some(output) = wadduwa() else { return };
    let ids = revit_ids(output);
    let depth_of_id = |id: u64| depth_of(output, *ids.get(&id).unwrap_or_else(|| panic!("élément {id} absent")));
    // L'escalier contre les murs.
    for stair in [676_369u64, 680_413] {
        assert_eq!(depth_of_id(stair), 0, "escalier {stair}");
    }
    for wall in [681_797u64, 685_962, 567_439] {
        assert_eq!(depth_of_id(wall), 2, "mur {wall}");
    }
    // Les poteaux contre les dalles.
    let seen = elements(output);
    let mut columns = 0;
    for (index, element) in seen.iter().enumerate() {
        let name = element.name.as_str();
        let is_column = name.starts_with("M_Rectangular Column") || name.starts_with("Concrete-Square-Column");
        let is_host = name.starts_with("Mur de base") || name.starts_with("Sol :") || name.starts_with("Toiture de base");
        if is_column {
            columns += 1;
            assert_eq!(depth_of(output, index), 0, "{name}");
        } else if is_host {
            assert_eq!(depth_of(output, index), 2, "{name}");
        }
    }
    assert_eq!(columns, 62 + 37 + 27 + 9 + 2, "poteaux de wadduwa");
}

/// Les cinq plans DWG importés dans le projet (`ImportInstance` 508410, 508602, 508706, 509408, 509601) se dessinent, en surcouche : leurs blocs
/// ont une échelle (25,4 ; 75 ; 2 413,27 ; 0,75 avec miroir…), uniforme, et un import CAD du projet est un élément du modèle comme les autres. Ce
/// sont des régions pleines à plat, à la hauteur de chaque niveau (0,3 ; 3,9 ; 7,3 ; 10,6 ; 13,1 m), donc coplanaires avec le dessus des dalles :
/// la surcouche les montre par-dessus. Leur nom est celui du fichier importé.
#[test]
fn wadduwa_les_cinq_plans_importes_se_dessinent_en_surcouche() {
    let Some(output) = wadduwa() else { return };
    // 437 éléments : 440 avant que le contenu des familles sur place soit dessiné par leur instance (trois formes de cadre de fenêtre,
    // 752500, 752831 et 760354, que leurs instances 752689, 752933 et 760361 dessinent à leur tour : voir `wadduwa_le_contenu_des_familles_sur_place_...`).
    assert_eq!(output.keys.len(), 437);
    let seen = elements(output);
    let ids = revit_ids(output);
    for (id, name, triangles, height) in [(508_410u64, "MAN-GF.dwg", 773, 0.3), (508_602, "MAN-1F.dwg", 689, 3.9), (508_706, "MAN-2F.dwg", 128, 7.3), (509_408, "MAN-RF.dwg", 162, 10.6), (509_601, "MAN-URF.dwg", 150, 13.1)] {
        let index = *ids.get(&id).unwrap_or_else(|| panic!("{id} absent"));
        let plan = &seen[index];
        assert_eq!(plan.name, name, "{id} : nom du fichier importé");
        // La catégorie que le fichier donne à l'import : le `CategoryElem` de ce nom (Revit : « Catégories importées »).
        let key = &output.keys[index];
        let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
        assert_eq!(metadata["elements"][key]["properties"]["Catégorie"].as_str(), Some(name), "{id} : catégorie");
        assert_eq!(metadata["elements"][key]["label"].as_str(), Some(name), "{id} : libellé");
        assert_eq!((plan.source, plan.triangles, plan.overlay), (0, triangles, triangles), "{id}");
        assert_eq!(depth_of(output, index), 1, "{id} : surcouche");
        // À plat : un seul Y (en mètres, repère du modèle), à la hauteur du niveau.
        let (mut low, mut high) = (f64::MAX, f64::MIN);
        for primitive in output.primitives.chunks_exact(6).filter(|p| p[0] as usize == index) {
            for vertex in primitive[1]..primitive[1] + primitive[2] {
                let y = f64::from(output.positions[vertex as usize * 3 + 1]) + output.origin[1];
                (low, high) = (low.min(y), high.max(y));
            }
        }
        assert!(high - low < 0.01 && (low - height).abs() < 0.06, "{id} : Y de {low} à {high}");
    }
}

/// Les trois familles sur place de `wadduwa.rvt` (« Exterior Window Frame », « Exterior Window Frame 2 », « Exterior Window Frame1 » : des cadres de
/// fenêtre créés dans l'éditeur de modèle sur place) : chacune a une extrusion (752500, 752831, 760354) que son instance (752689, 752933, 760361) dessine
/// à son tour, avec les mêmes 32 triangles. La forme n'est pas dessinée : l'extrusion de 752500 l'était deux fois (par elle-même et par son instance, à
/// l'endroit même), celle de 760354, copie de la famille dont l'instance a été déplacée de 3,56 m, restait en fantôme à l'endroit d'origine, sur 752500.
/// Le mur et ce que la famille possède sans être une forme de sa définition (les murs 757897 et 760541, de 12 triangles : des éléments du modèle avec
/// leur niveau, leur type et leur GUID, que l'instance ne dessine pas) restent dessinés.
#[test]
fn wadduwa_le_contenu_des_familles_sur_place_est_dessine_par_leur_instance() {
    let Some(output) = wadduwa() else { return };
    let ids = revit_ids(output);
    let seen = elements(output);
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    for (form, instance, family) in [(752_500u64, 752_689u64, "Exterior Window Frame"), (752_831, 752_933, "Exterior Window Frame 2"), (760_354, 760_361, "Exterior Window Frame1")] {
        assert!(!ids.contains_key(&form), "la forme {form} ne se dessine pas : son instance {instance} la dessine");
        let index = *ids.get(&instance).unwrap_or_else(|| panic!("instance {instance} absente"));
        // Les mêmes 32 triangles que la forme, en forme Revit entière.
        assert_eq!((seen[index].source, seen[index].triangles), (0, 32), "instance {instance}");
        let fiche = &metadata["elements"][&output.keys[index]];
        assert_eq!(fiche["properties"]["Catégorie"].as_str(), Some("Modèles génériques"), "{instance}");
        assert_eq!(fiche["properties"]["Famille"].as_str(), Some(family), "{instance}");
    }
    // Les murs que les familles possèdent restent dessinés.
    for wall in [757_897u64, 760_541] {
        assert!(ids.contains_key(&wall), "le mur {wall} est un élément du modèle : il reste dessiné");
    }
}

/// Un import CAD propre à une vue (« vue actuelle seulement » : `m_ownerDBViewId` ≠ −1) n'est jamais montré en 3D par Revit : il reste écarté, comme
/// une annotation. `rac_advanced` en a un (« Roofing Detail.dwg », 228746, propre à la vue 228707), `wadduwa.rvt` n'a que des imports du modèle (5 sur 5),
/// `Vignette-04-BaseFile` aussi (2 sur 2) et `dynamo-nyc-site-2013` (1 sur 1).
#[test]
fn un_import_cad_propre_a_une_vue_n_est_pas_dessine() {
    let Some(bytes) = sample_bytes("samples/rac_advanced_sample_project.rvt") else { return };
    let output = read(&bytes, &revit::Options::default()).expect("lecture de rac_advanced");
    assert!(!output.names.iter().any(|name| name.ends_with(".dwg")), "aucun import dessiné : {:?}", output.names.iter().filter(|name| name.ends_with(".dwg")).collect::<Vec<_>>());
}

// ---------------------------------------------------------------------------------------------
// Les fichiers publics
// ---------------------------------------------------------------------------------------------

/// Le fichier d'essai commité : la table des matériaux a sept octets par ligne, avec des priorités de profondeur d'hôte (ses murs) et
/// ordinaire, et aucun triangle de surcouche (ni `GImposter` ni import CAD).
#[test]
fn le_fichier_commite_a_des_materiaux_de_sept_octets_sans_surcouche() {
    let bytes = std::fs::read(sample_path("tests/fixtures/Revit_IFC5_Einhoven.rvt")).expect("fichier commité");
    let output = read(&bytes, &revit::Options::default()).expect("lecture");
    assert!(!output.materials.is_empty());
    assert_eq!(output.materials.len() % MATERIAL_STRIDE, 0);
    assert!(output.materials.chunks_exact(MATERIAL_STRIDE).all(|row| row[4] <= 1 && row[5] <= 1 && matches!(row[6], 0 | 2)));
    assert!(output.materials.chunks_exact(MATERIAL_STRIDE).any(|row| row[6] == 2), "les murs sont des hôtes");
}

/// Core Interior ne change pas : mêmes éléments, mêmes triangles, toutes les formes entières, aucune surcouche.
#[test]
fn core_interior_ne_change_pas() {
    let Some(bytes) = sample_bytes("samples/2024_Core_Interior.rvt") else { return };
    let output = read(&bytes, &revit::Options::default()).expect("lecture de Core Interior");
    assert_eq!(output.report.elements, 856);
    assert_eq!(output.report.triangles, 34_504);
    assert_eq!((output.report.sources.revit, output.report.sources.partial, output.report.sources.rebuilt, output.report.sources.unknown), (856, 0, 0, 0));
    assert!(elements(&output).iter().all(|element| element.overlay == 0));
}
