//! La « Catégorie » des éléments que la table des classes ne range pas, lue sur les fichiers d'essai.
//!
//! - Classes : `ProfileRoof`, `FaceRoof`, `ContFooting`, `MassLevelData`, `Stairs`, `FaceWall`, `ArcWall` et `CurtaSystem` ont une
//!   seule catégorie (`catalog::fiche_class_category`, que la géométrie ne lit pas : le dessin ne change pas). `DividedSurface` aussi,
//!   « Surface divisée » (OST_DividedSurface, catégorie interne que seules les fiches lisent).
//! - Types : `SweepHost` se range d'après la classe de son type (nez de dalle, bandeau, gouttière), `WallSweep` autonome d'après son
//!   type et sa nature.
//! - Propriétaire : `DirectShape` d'après la catégorie que son auteur lui a donnée, un `WallSweep` intégré à la structure d'un mur
//!   d'après le mur qui le possède, une forme de famille (`SweepElem`, `BlendElem`, `RevolutionElem`, et `ExtrusionElem`, `FormElem`)
//!   d'après la famille sur place ou du document qui la possède.
//! - Dalle de fondation : un sol dont le type a `m_footingType` = 1.
//! - Chaque catégorie de ces classes est aussi celle des styles graphiques de l'élément dans le fichier (canal 103) : 161 sur 161
//!   (`viewer-bim-travail/categories/spec.md`, §2.2 et §3).
//! - Non-régression : aucun élément qui avait une catégorie ne la change, hors les 16 changements listés dans `CHANGEMENTS`.
//!
//! À lancer avec `cargo test --release --test categories`. Les fichiers publics viennent de `npm run samples:revit` ; sans eux, les
//! essais qui en dépendent passent sans rien faire.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use revit::native::{self, Options as NativeOptions, schema::sha256_hex};
use revit::{Options, read};
use serde_json::Value;

/// Le fichier d'essai `stem` (`rac_advanced_sample_project` → `rac_advanced_sample_project.rvt`), s'il est dans `revit/samples/`.
fn sample(stem: &str) -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples");
    let found = std::fs::read_dir(&dir).ok().and_then(|entries| {
        entries.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).find(|file| !file.starts_with("._") && file.strip_prefix(stem).is_some_and(|rest| rest.starts_with('.')))
    });
    if found.is_none() {
        eprintln!("{stem} absent de revit/samples/ : essai ignoré");
    }
    found.map(|file| dir.join(file))
}

/// Une fiche : ce que le JSON de métadonnées dit d'un élément, et sa classe native.
struct Fiche<'a> {
    id: u64,
    class: &'a str,
    properties: &'a serde_json::Map<String, Value>,
}

impl Fiche<'_> {
    fn text(&self, name: &str) -> Option<&str> {
        self.properties.get(name).and_then(Value::as_str)
    }

    fn category(&self) -> Option<&str> {
        self.text("Catégorie")
    }
}

/// Un fichier lu : ses métadonnées, et la classe native de chaque élément dessiné (les métadonnées n'écrivent la classe que des
/// éléments sans catégorie).
struct Lu {
    metadata: Value,
    classes: BTreeMap<u64, String>,
}

impl Lu {
    fn fiches(&self) -> Vec<Fiche<'_>> {
        self.metadata["elements"]
            .as_object()
            .expect("elements")
            .values()
            .map(|entry| {
                let properties = entry["properties"].as_object().expect("properties");
                let id = properties["Identifiant Revit"].as_u64().expect("identifiant");
                Fiche { id, class: self.classes.get(&id).map_or("", String::as_str), properties }
            })
            .collect()
    }

    /// Le nombre d'éléments par (classe native, catégorie ; `None` sans catégorie).
    fn counts(&self) -> BTreeMap<(String, Option<String>), usize> {
        let mut counts = BTreeMap::new();
        for fiche in self.fiches() {
            *counts.entry((fiche.class.to_string(), fiche.category().map(str::to_string))).or_default() += 1;
        }
        counts
    }

    /// La fiche de l'élément `id`.
    fn fiche_of(&self, id: u64) -> Fiche<'_> {
        self.fiches().into_iter().find(|fiche| fiche.id == id).unwrap_or_else(|| panic!("élément {id} dessiné"))
    }
}

/// Lit le fichier d'essai `stem` (lecture complète, comme le navigateur) et la classe de ses éléments dessinés.
fn lire(stem: &str) -> Option<Lu> {
    let path = sample(stem)?;
    let bytes = std::fs::read(&path).expect("fichier d'essai");
    Some(lire_octets(&bytes, stem))
}

fn lire_octets(bytes: &[u8], stem: &str) -> Lu {
    let output = read(bytes, &Options::default()).unwrap_or_else(|error| panic!("{stem} : {error:#}"));
    let metadata: Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    let ids: BTreeSet<u64> = metadata["elements"].as_object().expect("elements").values().filter_map(|entry| entry["properties"]["Identifiant Revit"].as_u64()).collect();
    // La classe native de chaque élément dessiné : l'enregistrement, sans décoder son graphe.
    let mut file = rvt::RevitFile::open_bytes(bytes.to_vec()).expect("fichier Revit");
    let mut classes = BTreeMap::new();
    let options = NativeOptions { selected_ids: ids, max_graph_values: 1, max_graph_objects: 1, ..NativeOptions::default() };
    native::extract_graphs(&mut file, &options, |record| {
        classes.insert(record.identity.element_id, record.class_name.clone().unwrap_or_default());
        Ok(())
    })
    .expect("lecture des classes");
    Lu { metadata, classes }
}

/// Le nombre d'éléments de classe `class` et de catégorie `category` dans `lu`.
fn count(lu: &Lu, class: &str, category: Option<&str>) -> usize {
    lu.counts().get(&(class.to_string(), category.map(str::to_string))).copied().unwrap_or(0)
}

/// Aucune fiche de `lu` n'écrit « Classe Revit » (tout élément a une catégorie).
fn no_revit_class(lu: &Lu, stem: &str) {
    let without: Vec<(u64, &str)> = lu.fiches().into_iter().filter(|fiche| fiche.properties.contains_key("Classe Revit")).map(|fiche| (fiche.id, fiche.class)).collect();
    assert!(without.is_empty(), "{stem} : « Classe Revit » écrite pour {without:?}");
    assert!(lu.metadata["readOnly"].as_array().expect("readOnly").iter().all(|name| name != "Classe Revit"), "{stem} : « Classe Revit » listée dans readOnly");
}

// ---------------------------------------------------------------------------------------------
// Les classes de la spec, fichier par fichier
// ---------------------------------------------------------------------------------------------

/// Les 166 éléments qui gagnent une catégorie : (fichier, classe, catégorie, nombre). Mesuré : 166 éléments dessinés sans catégorie dans
/// les 54 fichiers lisibles. Les 161 premiers sont rangés par leur classe, leur type ou leur propriétaire ; les 5 `DividedSurface` de
/// `dynamo-tower-6-ds-2013` le sont par la catégorie OST_DividedSurface (`FICHE_CLASS_CATEGORIES`). Un fichier absent de cette table n'a
/// aucun élément de ces classes.
const NOUVELLES: &[(&str, &str, Option<&str>, usize)] = &[
    ("FamilyDocumentTests", "BlendElem", Some("Modèles génériques"), 4),
    ("FamilyDocumentTests", "SweepElem", Some("Modèles génériques"), 2),
    ("SampleModel", "ProfileRoof", Some("Toitures"), 1),
    ("SampleModel", "SweepElem", Some("Systèmes de mobilier"), 1),
    ("clockwork-roof-floor-stuff-2014", "FaceRoof", Some("Toitures"), 1),
    ("clockwork-roof-floor-stuff-2014", "ProfileRoof", Some("Toitures"), 2),
    ("clockwork-roof-floor-stuff-2014", "SweepElem", Some("Toitures"), 1),
    ("clockwork-wall-stuff-2014", "CurtaSystem", Some("Systèmes de mur-rideau"), 1),
    ("clockwork-wall-stuff-2014", "FaceWall", Some("Murs"), 1),
    ("drone-hangar-building-2014", "ContFooting", Some("Fondations porteuses"), 16),
    ("drone-hangar-building-2014", "ProfileRoof", Some("Toitures"), 5),
    ("drone-hangar-building-2014", "WallSweep", Some("Murs"), 69),
    ("dynamo-tower-6-ds-2013", "DividedSurface", Some("Surface divisée"), 5),
    ("mega_advanced_sample_file", "FaceRoof", Some("Toitures"), 1),
    ("mega_advanced_sample_file", "MassLevelData", Some("Sols de masse"), 4),
    ("mega_advanced_sample_file", "ProfileRoof", Some("Toitures"), 6),
    ("mega_advanced_sample_file", "SweepElem", Some("Ossature porteuse"), 1),
    ("mega_advanced_sample_file", "SweepHost", Some("Nez de dalle"), 2),
    ("mega_advanced_sample_file", "WallSweep", Some("Murs"), 8),
    ("rac_advanced_sample_project", "FaceRoof", Some("Toitures"), 1),
    ("rac_advanced_sample_project", "MassLevelData", Some("Sols de masse"), 4),
    ("rac_advanced_sample_project", "ProfileRoof", Some("Toitures"), 6),
    ("rac_advanced_sample_project", "Stairs", Some("Escaliers"), 5),
    ("rac_advanced_sample_project", "SweepElem", Some("Ossature porteuse"), 1),
    ("rac_advanced_sample_project", "SweepHost", Some("Nez de dalle"), 2),
    ("rac_advanced_sample_project", "WallSweep", Some("Murs"), 8),
    ("revit-curtainwall-byprofile_v21", "DirectShape", Some("Modèles génériques"), 2),
    ("revit-openings_v22", "ArcWall", Some("Murs"), 1),
    ("revit-openings_v22", "ProfileRoof", Some("Toitures"), 3),
    ("setout-point-2013", "RevolutionElem", Some("Modèles génériques"), 1),
    ("singleDirectShape", "DirectShape", Some("Modèles génériques"), 1),
];

/// Les classes de `NOUVELLES` : celles que ces essais surveillent.
const CLASSES_NOUVELLES: &[&str] = &["WallSweep", "ProfileRoof", "ContFooting", "MassLevelData", "SweepElem", "DividedSurface", "Stairs", "BlendElem", "SweepHost", "FaceRoof", "DirectShape", "FaceWall", "CurtaSystem", "ArcWall", "RevolutionElem"];

#[test]
fn les_166_elements_gagnent_leur_categorie() {
    let files: BTreeSet<&str> = NOUVELLES.iter().map(|(file, ..)| *file).collect();
    let (mut found, mut without) = (0, 0);
    for stem in files {
        let Some(lu) = lire(stem) else { continue };
        // Pour chacune des 15 classes, la catégorie et le nombre attendus ; ni plus, ni autre catégorie.
        for class in CLASSES_NOUVELLES {
            let expected: BTreeMap<Option<&str>, usize> = NOUVELLES.iter().filter(|(file, c, ..)| *file == stem && c == class).map(|(_, _, category, n)| (*category, *n)).collect();
            let actual: BTreeMap<Option<String>, usize> = lu.counts().into_iter().filter(|((c, _), _)| c == class).map(|((_, category), n)| (category, n)).collect();
            let expected: BTreeMap<Option<String>, usize> = expected.into_iter().map(|(category, n)| (category.map(str::to_string), n)).collect();
            assert_eq!(actual, expected, "{stem} : {class}");
            found += expected.iter().filter(|(category, _)| category.is_some()).map(|(_, n)| n).sum::<usize>();
            without += expected.iter().filter(|(category, _)| category.is_none()).map(|(_, n)| n).sum::<usize>();
        }
        // Plus aucun élément ne garde « Classe Revit ».
        no_revit_class(&lu, stem);
    }
    // Les 54 fichiers présents : 166 et 0. Sinon, ce que les fichiers présents en comptent.
    let all = NOUVELLES.iter().all(|(file, ..)| sample(file).is_some());
    if all {
        assert_eq!((found, without), (166, 0));
    }
}

#[test]
fn rac_range_ses_classes_et_n_ecrit_plus_de_classe_revit() {
    let Some(lu) = lire("rac_advanced_sample_project") else { return };
    // SweepHost : un nez de dalle (type « Slab Edge », classe `EdgeSlabAttr`), non plus « Dalle de bord » (rendu automatique).
    for (class, category, n) in [("WallSweep", "Murs", 8), ("SweepHost", "Nez de dalle", 2), ("Stairs", "Escaliers", 5), ("MassLevelData", "Sols de masse", 4), ("ProfileRoof", "Toitures", 6), ("FaceRoof", "Toitures", 1), ("SweepElem", "Ossature porteuse", 1)] {
        assert_eq!(count(&lu, class, Some(category)), n, "{class}");
        assert_eq!(count(&lu, class, None), 0, "{class} sans catégorie");
    }
    no_revit_class(&lu, "rac_advanced_sample_project");
    // Les noms des familles système que le fichier ne nomme pas (« Famille : Type »).
    let edge = lu.fiches().into_iter().find(|fiche| fiche.class == "SweepHost").expect("nez de dalle");
    assert_eq!((edge.text("Famille"), edge.text("Type")), (Some("Nez de dalle"), Some("Slab Edge")));
    let stairs = lu.fiches().into_iter().find(|fiche| fiche.class == "Stairs").expect("escalier");
    assert_eq!((stairs.text("Famille"), stairs.text("Type")), (Some("Escalier"), Some("150mm max riser 300mm tread")));
}

#[test]
fn les_profiles_de_mur_integres_d_un_fichier_de_2014_suivent_leur_mur() {
    // drone-hangar-building-2014 : Revit 2014 (le chemin d'avant 2015), 69 profilés `m_fixed` possédés par un mur.
    let Some(lu) = lire("drone-hangar-building-2014") else { return };
    assert_eq!(count(&lu, "WallSweep", Some("Murs")), 69);
    assert_eq!(count(&lu, "ContFooting", Some("Fondations porteuses")), 16);
    assert_eq!(count(&lu, "ProfileRoof", Some("Toitures")), 5);
    no_revit_class(&lu, "drone-hangar-building-2014");
    let footing = lu.fiches().into_iter().find(|fiche| fiche.class == "ContFooting").expect("semelle");
    assert_eq!(footing.text("Famille"), Some("Semelle filante"));
    // Un profilé intégré est dans « Murs » : une vue qui masque les murs masque aussi ses 69 profilés (comme Revit).
    assert!(lu.fiches().into_iter().filter(|fiche| fiche.class == "WallSweep").all(|fiche| fiche.category() == Some("Murs")));
}

#[test]
fn les_formes_des_familles_et_les_formes_directes_prennent_la_categorie_que_le_fichier_donne() {
    if let Some(lu) = lire("FamilyDocumentTests") {
        assert_eq!(count(&lu, "BlendElem", Some("Modèles génériques")), 4);
        assert_eq!(count(&lu, "SweepElem", Some("Modèles génériques")), 2);
        no_revit_class(&lu, "FamilyDocumentTests");
    }
    if let Some(lu) = lire("setout-point-2013") {
        assert_eq!(count(&lu, "RevolutionElem", Some("Modèles génériques")), 1);
        no_revit_class(&lu, "setout-point-2013");
    }
    if let Some(lu) = lire("singleDirectShape") {
        assert_eq!(count(&lu, "DirectShape", Some("Modèles génériques")), 1);
        no_revit_class(&lu, "singleDirectShape");
    }
}

#[test]
fn les_surfaces_divisees_ont_la_categorie_de_leurs_styles() {
    // Le propriétaire (la famille de masse) dit « Masses », mais tous les styles graphiques de l'élément sont des sous-catégories d'OST_DividedSurface :
    // la catégorie que Revit a pour cet élément (`FICHE_CLASS_CATEGORIES`, que la géométrie ne lit pas : le dessin ne change pas).
    let Some(lu) = lire("dynamo-tower-6-ds-2013") else { return };
    let divided: Vec<Fiche<'_>> = lu.fiches().into_iter().filter(|fiche| fiche.class == "DividedSurface").collect();
    assert_eq!(divided.len(), 5);
    for fiche in &divided {
        assert_eq!(fiche.category(), Some("Surface divisée"), "{}", fiche.id);
        assert_eq!(fiche.text("Classe Revit"), None, "{}", fiche.id);
        let label = lu.metadata["elements"].as_object().expect("elements").values().find(|entry| entry["properties"]["Identifiant Revit"].as_u64() == Some(fiche.id)).map(|entry| entry["label"].as_str().expect("libellé"));
        assert_eq!(label, Some(format!("Surface divisée {}", fiche.id).as_str()));
    }
    no_revit_class(&lu, "dynamo-tower-6-ds-2013");
}

// ---------------------------------------------------------------------------------------------
// §9 : ce qui change des catégories qui existaient
// ---------------------------------------------------------------------------------------------

/// Les seules catégories déjà écrites qui changent : (fichier, élément, classe, avant, après). Mesuré sur les 54 fichiers lisibles
/// contre les dumps d'avant (15 501 éléments avec catégorie) ; les 15 485 autres gardent la leur.
///
/// - Formes (`ExtrusionElem`, `FormElem`) : la famille qui les possède passe avant la classe. La table des classes se trompait pour
///   11 formes sur 34, la catégorie de la famille est celle de leurs graphiques (`GInfo.m_categoryId`).
/// - Sols : la dalle de fondation (`FloorAttributes.m_footingType` = 1, « 150mm Foundation Slab ») est dessinée avec le style
///   OST_StructuralFoundation, 5 sols sur 5 ; les 177 autres sols dessinés (`m_footingType` = 0) avec OST_Floors.
const CHANGEMENTS: &[(&str, u64, &str, &str, &str)] = &[
    ("AdaptivePanel", 1591840, "FormElem", "Masses", "Modèles génériques"),
    ("AdaptivePanel", 1591862, "FormElem", "Masses", "Modèles génériques"),
    ("AdaptivePanel", 1591876, "FormElem", "Masses", "Modèles génériques"),
    ("AdaptivePanel", 1592760, "FormElem", "Masses", "Modèles génériques"),
    ("SampleModel", 506161, "ExtrusionElem", "Modèles génériques", "Systèmes de mobilier"),
    ("SampleModel", 523524, "ExtrusionElem", "Modèles génériques", "Systèmes de mobilier"),
    ("clockwork-wall-stuff-2014", 180076, "ExtrusionElem", "Modèles génériques", "Murs"),
    ("mega_advanced_sample_file", 139682, "ExtrusionElem", "Modèles génériques", "Masses"),
    ("mega_advanced_sample_file", 139763, "ExtrusionElem", "Modèles génériques", "Masses"),
    ("rac_advanced_sample_project", 139682, "ExtrusionElem", "Modèles génériques", "Masses"),
    ("rac_advanced_sample_project", 139763, "ExtrusionElem", "Modèles génériques", "Masses"),
    ("DynamoSample_2014", 766598, "Floor", "Sols", "Fondations porteuses"),
    ("DynamoSample_2023", 766598, "Floor", "Sols", "Fondations porteuses"),
    ("DynamoSample_2024", 766598, "Floor", "Sols", "Fondations porteuses"),
    ("DynamoSample_2025", 766598, "Floor", "Sols", "Fondations porteuses"),
    ("SampleModel", 766598, "Floor", "Sols", "Fondations porteuses"),
];

#[test]
fn la_famille_d_une_forme_passe_avant_la_classe() {
    // §9.1 à 9.3 : les 11 formes que la table des classes rangeait mal prennent la catégorie de leur famille.
    for (stem, id, class, _, after) in CHANGEMENTS.iter().filter(|(_, _, class, ..)| *class != "Floor") {
        let Some(lu) = lire(stem) else { continue };
        let fiche = lu.fiche_of(*id);
        assert_eq!((fiche.class, fiche.category()), (*class, Some(*after)), "{stem} {id}");
    }
    // Le vide de void-cutter-2012.rfa, dessiné avec le seul style de la géométrie coupante, est d'une famille de modèles génériques : la
    // catégorie de la table des classes, inchangée.
    if let Some(lu) = lire("void-cutter-2012") {
        assert_eq!(count(&lu, "ExtrusionElem", Some("Modèles génériques")), 2);
        assert_eq!(count(&lu, "ExtrusionElem", None), 0);
    }
    // Les formes qui étaient bien rangées (masses d'une famille de masse, extrusions d'une famille de modèles génériques) le restent.
    if let Some(lu) = lire("ShellFamily") {
        assert_eq!(count(&lu, "FormElem", Some("Masses")), 2);
    }
    if let Some(lu) = lire("drone-hangar-building-2014") {
        assert_eq!(count(&lu, "ExtrusionElem", Some("Modèles génériques")), 14);
    }
    if let Some(lu) = lire("FamilyDocumentTests") {
        assert_eq!(count(&lu, "ExtrusionElem", Some("Modèles génériques")), 4);
    }
}

#[test]
fn une_dalle_de_fondation_est_une_fondation_porteuse() {
    // §9.4 : `FloorAttributes.m_footingType` = 1 pour les 5 sols « 150mm Foundation Slab ».
    for stem in ["DynamoSample_2014", "DynamoSample_2023", "DynamoSample_2024", "DynamoSample_2025", "SampleModel"] {
        let Some(lu) = lire(stem) else { continue };
        let slab = lu.fiche_of(766598);
        assert_eq!((slab.class, slab.category(), slab.text("Type")), ("Floor", Some("Fondations porteuses"), Some("150mm Foundation Slab")), "{stem}");
        // Une seule dalle de fondation par fichier ; tous les autres sols sont des sols.
        assert_eq!(count(&lu, "Floor", Some("Fondations porteuses")), 1, "{stem}");
        assert_eq!(count(&lu, "Floor", None), 0, "{stem}");
        assert!(count(&lu, "Floor", Some("Sols")) >= 1, "{stem}");
    }
}

#[test]
fn le_systeme_de_murs_rideaux_a_son_type() {
    // §9.6 : `CurtaSystemBase.m_idAttr` (le seul champ en `…idattr` des schémas mesurés) désigne son type, comme `…attrid` ailleurs.
    let Some(lu) = lire("clockwork-wall-stuff-2014") else { return };
    let system = lu.fiche_of(180697);
    assert_eq!(system.class, "CurtaSystem");
    assert_eq!(system.category(), Some("Systèmes de mur-rideau"));
    assert_eq!(system.text("Type"), Some("1500 x 3000mm"));
    // §9.7 : sa famille système, au singulier du libellé de sa catégorie.
    assert_eq!(system.text("Famille"), Some("Système de mur-rideau"));
    // Les 36 panneaux qui l'ont pour hôte le nomment par ce libellé, non plus par « Élément Revit 180697 ».
    let hosts: Vec<&str> = lu.fiches().into_iter().filter_map(|fiche| fiche.properties.get("Contraintes").and_then(|group| group.get("Hôte")).and_then(Value::as_str)).collect();
    assert_eq!(hosts.iter().filter(|host| **host == "Système de mur-rideau : 1500 x 3000mm").count(), 36);
    assert!(hosts.iter().all(|host| !host.contains("180697")), "{hosts:?}");
}

// ---------------------------------------------------------------------------------------------
// Non-régression
// ---------------------------------------------------------------------------------------------

/// Les catégories de ce que les 15 classes ne touchent pas, comptées d'avant : (catégorie, nombre), pour les éléments de classes hors
/// des 15 de la spec et hors `ExtrusionElem` et `FormElem`, qui peuvent changer (`CHANGEMENTS`). Aucun de ces éléments n'était sans
/// catégorie.
const RAC_INCHANGES: &[(&str, usize)] = &[
    ("Meneaux de mur-rideau", 3276),
    ("Panneaux de mur-rideau", 1349),
    ("Murs", 180),
    ("Poteaux porteurs", 176),
    ("Mobilier", 152),
    ("Portes", 100),
    ("Plafonds", 65),
    ("Modèles génériques", 42),
    ("Appareils d'éclairage", 41),
    ("Ossature porteuse", 38),
    ("Végétation", 30),
    ("Stationnement", 27),
    ("Fenêtres", 24),
    ("Garde-corps", 22),
    ("Sols", 16),
    ("Environnement", 3),
    ("Topographie", 3),
    ("Terrassements de bâtiment", 1),
];

const CORE_INTERIOR_INCHANGES: &[(&str, usize)] = &[("Murs", 360), ("Poteaux", 256), ("Portes", 132), ("Sols", 99), ("Fenêtres", 6), ("Topographie", 2), ("Terrassements de bâtiment", 1)];

#[test]
fn les_categories_des_autres_classes_ne_changent_pas() {
    let own: BTreeSet<&str> = CLASSES_NOUVELLES.iter().copied().chain(["ExtrusionElem", "FormElem"]).collect();
    for (stem, expected) in [("rac_advanced_sample_project", RAC_INCHANGES), ("2024_Core_Interior", CORE_INTERIOR_INCHANGES)] {
        let Some(lu) = lire(stem) else { continue };
        let mut actual: BTreeMap<String, usize> = BTreeMap::new();
        for fiche in lu.fiches().into_iter().filter(|fiche| !own.contains(fiche.class)) {
            *actual.entry(fiche.category().unwrap_or("(aucune)").to_string()).or_default() += 1;
        }
        let expected: BTreeMap<String, usize> = expected.iter().map(|(category, n)| (category.to_string(), *n)).collect();
        assert_eq!(actual, expected, "{stem}");
    }
}

/// Le dossier des métadonnées d'avant (les dumps de `viewer-bim-travail/categories/before/`, produits par `examples/dump.rs` avant ce
/// changement), ou `REVIT_CATEGORIES_AVANT`.
fn before_dumps() -> PathBuf {
    std::env::var_os("REVIT_CATEGORIES_AVANT").map_or_else(|| PathBuf::from("/Volumes/Zaid's SSD 1/viewer-bim-travail/categories/before"), PathBuf::from)
}

/// L'empreinte des 54 dumps d'avant : SHA-256 des lignes « nom empreinte-du-dump », triées par nom. Les dumps ne servent de référence
/// que s'ils sont ceux d'avant : un dossier refait avec un lecteur plus récent ne prouverait plus rien.
const EMPREINTE_AVANT: &str = "95f3a65256b5f490f3be50db8117446a20d39c223d7928440a2eeb28520419ad";

/// Les dumps de `dir` (nom → JSON), leur nombre et l'empreinte de leurs lignes « nom empreinte-du-dump » (triées par nom de fichier).
fn read_dumps(dir: &std::path::Path) -> Option<(usize, String, BTreeMap<String, Value>)> {
    let mut files: Vec<String> = std::fs::read_dir(dir).ok()?.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|file| !file.starts_with("._") && file.ends_with(".metadata.json")).collect();
    files.sort();
    let mut lines = String::new();
    let mut dumps = BTreeMap::new();
    for file in &files {
        let bytes = std::fs::read(dir.join(file)).ok()?;
        let name = file.trim_end_matches(".metadata.json");
        lines.push_str(&format!("{name} {}\n", sha256_hex(&bytes)));
        dumps.insert(name.to_string(), serde_json::from_slice(&bytes).ok()?);
    }
    Some((files.len(), sha256_hex(lines.as_bytes()), dumps))
}

/// Les dumps d'avant, s'ils sont tous là et que leur empreinte est celle de `EMPREINTE_AVANT`.
fn before_metadata() -> Option<BTreeMap<String, Value>> {
    let dir = before_dumps();
    match read_dumps(&dir) {
        Some((54, digest, dumps)) if digest == EMPREINTE_AVANT => Some(dumps),
        _ => {
            eprintln!("dumps d'avant absents ou modifiés dans {} : comparaison avec eux ignorée", dir.display());
            None
        }
    }
}

#[test]
fn aucune_categorie_existante_ne_change_hors_des_changements_listes() {
    let before = before_metadata();
    // Sans les dumps, les fichiers des changements listés : la catégorie d'après de chacun.
    let stems: BTreeSet<String> = match &before {
        Some(dumps) => dumps.keys().cloned().collect(),
        None => CHANGEMENTS.iter().map(|(stem, ..)| stem.to_string()).collect(),
    };
    let expected_changes: BTreeMap<(&str, u64), (&str, &str)> = CHANGEMENTS.iter().map(|(stem, id, _, old, new)| ((*stem, *id), (*old, *new))).collect();
    let (mut compared, mut changed) = (0, 0);
    for stem in &stems {
        let Some(path) = sample(stem) else { continue };
        let bytes = std::fs::read(&path).expect("fichier d'essai");
        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{stem} : {error:#}"));
        let after: Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
        let category_of = |metadata: &Value, key: &str| metadata["elements"][key]["properties"]["Catégorie"].as_str().map(str::to_string);
        let id_of = |metadata: &Value, key: &str| metadata["elements"][key]["properties"]["Identifiant Revit"].as_u64().expect("identifiant");
        // Les changements listés ont lieu (avec ou sans les dumps).
        for ((file, id), (_, new)) in &expected_changes {
            if file != stem {
                continue;
            }
            let key = after["elements"].as_object().expect("elements").keys().find(|key| id_of(&after, key) == *id).unwrap_or_else(|| panic!("{stem} : {id} dessiné"));
            assert_eq!(category_of(&after, key).as_deref(), Some(*new), "{stem} {id}");
            changed += 1;
        }
        let Some(before) = before.as_ref().and_then(|dumps| dumps.get(stem)) else { continue };
        let keys_before: Vec<&String> = before["elements"].as_object().expect("elements").keys().collect();
        let keys_after: Vec<&String> = after["elements"].as_object().expect("elements").keys().collect();
        assert_eq!(keys_before, keys_after, "{stem} : mêmes éléments, dans le même ordre");
        for key in keys_before {
            let Some(old) = category_of(before, key) else { continue };
            compared += 1;
            let id = id_of(before, key);
            let new = category_of(&after, key);
            match expected_changes.get(&(stem.as_str(), id)) {
                Some((expected_old, expected_new)) => assert_eq!((old.as_str(), new.as_deref()), (*expected_old, Some(*expected_new)), "{stem} {id}"),
                None => assert_eq!(new.as_deref(), Some(old.as_str()), "{stem} {id} : la catégorie d'un élément qui en avait une a changé"),
            }
        }
    }
    if before.is_some() && stems.iter().all(|stem| sample(stem).is_some()) {
        // 15 501 éléments avec une catégorie avant, dont 16 changent.
        assert_eq!((compared, changed), (15_501, CHANGEMENTS.len()));
    }
}
