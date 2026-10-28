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

/// Les 162 éléments qui gagnent une catégorie : (fichier, classe, catégorie, nombre). Mesuré : 166 éléments dessinés sans catégorie dans
/// les 54 fichiers lisibles, 162 depuis que le contenu des familles sur place est dessiné par leur instance : les quatre balayages
/// (`SweepElem`) de `SampleModel` (le caisson de hotte 697449), de `clockwork-roof-floor-stuff-2014` (181144), de `mega_advanced_sample_file` et de
/// `rac_advanced_sample_project` (la poutre courbe 201286) ne sont plus dessinés : leurs instances le sont, avec leur catégorie (voir
/// `FORMES_ECARTEES`). Les 157 premiers sont rangés par leur classe, leur type ou leur propriétaire ; les 5 `DividedSurface` de
/// `dynamo-tower-6-ds-2013` le sont par la catégorie OST_DividedSurface (`FICHE_CLASS_CATEGORIES`). Un fichier absent de cette table n'a
/// aucun élément de ces classes.
const NOUVELLES: &[(&str, &str, Option<&str>, usize)] = &[
    ("FamilyDocumentTests", "BlendElem", Some("Modèles génériques"), 4),
    ("FamilyDocumentTests", "SweepElem", Some("Modèles génériques"), 2),
    ("SampleModel", "ProfileRoof", Some("Toitures"), 1),
    ("clockwork-roof-floor-stuff-2014", "FaceRoof", Some("Toitures"), 1),
    ("clockwork-roof-floor-stuff-2014", "ProfileRoof", Some("Toitures"), 2),
    ("clockwork-wall-stuff-2014", "CurtaSystem", Some("Systèmes de mur-rideau"), 1),
    ("clockwork-wall-stuff-2014", "FaceWall", Some("Murs"), 1),
    ("drone-hangar-building-2014", "ContFooting", Some("Fondations porteuses"), 16),
    ("drone-hangar-building-2014", "ProfileRoof", Some("Toitures"), 5),
    ("drone-hangar-building-2014", "WallSweep", Some("Murs"), 69),
    ("dynamo-tower-6-ds-2013", "DividedSurface", Some("Surface divisée"), 5),
    ("mega_advanced_sample_file", "FaceRoof", Some("Toitures"), 1),
    ("mega_advanced_sample_file", "MassLevelData", Some("Sols de masse"), 4),
    ("mega_advanced_sample_file", "ProfileRoof", Some("Toitures"), 6),
    ("mega_advanced_sample_file", "SweepHost", Some("Nez de dalle"), 2),
    ("mega_advanced_sample_file", "WallSweep", Some("Murs"), 8),
    ("rac_advanced_sample_project", "FaceRoof", Some("Toitures"), 1),
    ("rac_advanced_sample_project", "MassLevelData", Some("Sols de masse"), 4),
    ("rac_advanced_sample_project", "ProfileRoof", Some("Toitures"), 6),
    ("rac_advanced_sample_project", "Stairs", Some("Escaliers"), 5),
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
fn les_162_elements_gagnent_leur_categorie() {
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
    // Les 54 fichiers présents : 162 et 0. Sinon, ce que les fichiers présents en comptent.
    let all = NOUVELLES.iter().all(|(file, ..)| sample(file).is_some());
    if all {
        assert_eq!((found, without), (162, 0));
    }
}

#[test]
fn rac_range_ses_classes_et_n_ecrit_plus_de_classe_revit() {
    let Some(lu) = lire("rac_advanced_sample_project") else { return };
    // SweepHost : un nez de dalle (type « Slab Edge », classe `EdgeSlabAttr`), non plus « Dalle de bord » (rendu automatique).
    for (class, category, n) in [("WallSweep", "Murs", 8), ("SweepHost", "Nez de dalle", 2), ("Stairs", "Escaliers", 5), ("MassLevelData", "Sols de masse", 4), ("ProfileRoof", "Toitures", 6), ("FaceRoof", "Toitures", 1)] {
        assert_eq!(count(&lu, class, Some(category)), n, "{class}");
        assert_eq!(count(&lu, class, None), 0, "{class} sans catégorie");
    }
    // La poutre courbe de la famille sur place « Curved Beam » (le balayage 201286) n'est plus dessinée : son instance (201308) la dessine, avec sa
    // catégorie (« Ossature porteuse »), et aucun élément `SweepElem` ne reste.
    assert_eq!(count(&lu, "SweepElem", Some("Ossature porteuse")) + count(&lu, "SweepElem", None), 0);
    let beam = lu.fiche_of(201308);
    assert_eq!((beam.class, beam.category()), ("FamilyInstance", Some("Ossature porteuse")));
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
/// contre les dumps d'avant (15 501 éléments avec catégorie, 15 480 depuis que 21 formes de familles sur place ne sont plus dessinées (dont 17
/// avaient une catégorie, les quatre `SweepElem` de `NOUVELLES` n'en avaient pas : voir `FORMES_ECARTEES`) ni les quatre formes de masses masquées de
/// `FORMES_DE_MASSES_MASQUEES`) ; les 15 471 autres gardent la leur.
///
/// - Formes (`ExtrusionElem`, `FormElem`) : la famille qui les possède passe avant la classe. La table des classes se trompait pour
///   11 formes sur 34, la catégorie de la famille est celle de leurs graphiques (`GInfo.m_categoryId`). Trois de ces onze formes (les deux
///   armoires de `SampleModel`, 506161 et 523524, et le mur sur place 180076 de `clockwork-wall-stuff-2014`) sont des formes de familles sur place que
///   leur instance dessine : elles ne sont plus dessinées, leur instance a la même catégorie (`FORMES_ECARTEES`). Les quatre autres (les formes de masse « Main Building » et « Pavillion » de `mega_advanced_sample_file` et de
///   `rac_advanced_sample_project`, 139682 et 139763, « Modèles génériques » devenue « Masses ») sont des masses masquées par défaut (`FORMES_DE_MASSES_MASQUEES`) : plus dessinées non plus.
/// - Sols : la dalle de fondation (`FloorAttributes.m_footingType` = 1, « 150mm Foundation Slab ») est dessinée avec le style
///   OST_StructuralFoundation, 5 sols sur 5 ; les 177 autres sols dessinés (`m_footingType` = 0) avec OST_Floors.
const CHANGEMENTS: &[(&str, u64, &str, &str, &str)] = &[
    ("AdaptivePanel", 1591840, "FormElem", "Masses", "Modèles génériques"),
    ("AdaptivePanel", 1591862, "FormElem", "Masses", "Modèles génériques"),
    ("AdaptivePanel", 1591876, "FormElem", "Masses", "Modèles génériques"),
    ("AdaptivePanel", 1592760, "FormElem", "Masses", "Modèles génériques"),
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
    // Les 14 extrusions des douze familles « Generic Models » du hangar (des familles sur place) ne sont plus dessinées : leurs instances le sont.
    if let Some(lu) = lire("drone-hangar-building-2014") {
        assert_eq!(count(&lu, "ExtrusionElem", Some("Modèles génériques")), 0);
        assert_eq!(count(&lu, "ExtrusionElem", None), 0);
    }
    if let Some(lu) = lire("FamilyDocumentTests") {
        assert_eq!(count(&lu, "ExtrusionElem", Some("Modèles génériques")), 4);
    }
}

/// Les formes de familles sur place que la lecture ne dessine plus : (fichier, forme, instance, catégorie). Le projet écrit les formes que l'éditeur de
/// modèle sur place a créées (extrusions, balayages) parmi ses éléments, dans son propre repère, et leur instance les dessine à son tour, là où elle
/// est : quand l'instance est dessinée avec au moins autant de triangles, la forme ne l'est pas (`geometry::Rules::release_in_place`). C'étaient les
/// 21 formes, de 6 fichiers, que `CHANGEMENTS` et les tests de noms épinglaient ; l'instance a le même libellé, la même catégorie, la même famille et le même
/// type que la forme qu'elle remplace (vérifié sur les dumps d'avant et d'après, 24 paires sur 24 : la 25e est l'import de `dynamo-nyc-site-2013`, voir
/// l'import `SiteModel.dwg` de `dynamo-nyc-site-2013`, absent des dumps d'avant). Les formes de masse de `rac_advanced_sample_project` et de `mega_advanced_sample_file`
/// (139682 et 139763), dont l'instance est une masse que Revit masque par défaut, n'ont pas d'instance dessinée : voir `FORMES_DE_MASSES_MASQUEES`.
const FORMES_ECARTEES: &[(&str, u64, u64, &str)] = &[
    ("SampleModel", 506161, 506168, "Systèmes de mobilier"),
    ("SampleModel", 523524, 523531, "Systèmes de mobilier"),
    ("SampleModel", 697449, 697577, "Systèmes de mobilier"),
    ("clockwork-roof-floor-stuff-2014", 181144, 181411, "Toitures"),
    ("clockwork-wall-stuff-2014", 180076, 180330, "Murs"),
    ("drone-hangar-building-2014", 197890, 198013, "Modèles génériques"),
    ("drone-hangar-building-2014", 198031, 198170, "Modèles génériques"),
    ("drone-hangar-building-2014", 198536, 198543, "Modèles génériques"),
    ("drone-hangar-building-2014", 198585, 198592, "Modèles génériques"),
    ("drone-hangar-building-2014", 198614, 198621, "Modèles génériques"),
    ("drone-hangar-building-2014", 198813, 198820, "Modèles génériques"),
    ("drone-hangar-building-2014", 198845, 198852, "Modèles génériques"),
    ("drone-hangar-building-2014", 198858, 198865, "Modèles génériques"),
    ("drone-hangar-building-2014", 198887, 198894, "Modèles génériques"),
    ("drone-hangar-building-2014", 199109, 198894, "Modèles génériques"),
    ("drone-hangar-building-2014", 199257, 198894, "Modèles génériques"),
    ("drone-hangar-building-2014", 199737, 199746, "Modèles génériques"),
    ("drone-hangar-building-2014", 199770, 199779, "Modèles génériques"),
    ("drone-hangar-building-2014", 199789, 199798, "Modèles génériques"),
    ("mega_advanced_sample_file", 201286, 201308, "Ossature porteuse"),
    ("rac_advanced_sample_project", 201286, 201308, "Ossature porteuse"),
];

#[test]
fn les_formes_de_familles_sur_place_ont_leur_instance_pour_les_remplacer() {
    for (stem, form, instance, category) in FORMES_ECARTEES {
        let Some(lu) = lire(stem) else { continue };
        assert!(lu.fiches().iter().all(|fiche| fiche.id != *form), "{stem} : la forme {form} est dessinée par son instance {instance}");
        let fiche = lu.fiche_of(*instance);
        assert_eq!((fiche.class, fiche.category()), ("FamilyInstance", Some(*category)), "{stem} {instance}");
    }
}

/// Les formes de familles sur place dont l'instance est une masse, que Revit masque par défaut (la règle des masses, `RELATION_REASONS[5]`, écarte l'instance) :
/// la forme l'est avec elle, avec la même raison, comptée dans l'avertissement des masses. (fichier, forme) ; l'import SAT 308836 de `Vignette-04-BaseFile` (famille
/// « Mass 1 ») en est un aussi, mais absent des dumps d'avant. Les vues 3D enregistrées de `rac_advanced_sample_project` et de `mega_advanced_sample_file` cachent
/// déjà la catégorie « Masses » (`hiddenCategories`) : ces formes, rangées dans cette catégorie (`tests/names.rs`), y étaient cachées du viewer, et ne sont plus dessinées.
const FORMES_DE_MASSES_MASQUEES: &[(&str, u64)] = &[("mega_advanced_sample_file", 139_682), ("mega_advanced_sample_file", 139_763), ("rac_advanced_sample_project", 139_682), ("rac_advanced_sample_project", 139_763)];

#[test]
fn les_formes_de_masses_masquees_ne_sont_pas_dessinees() {
    for (stem, id) in FORMES_DE_MASSES_MASQUEES.iter().chain(&[("Vignette-04-BaseFile", 308_836)]) {
        let Some(lu) = lire(stem) else { continue };
        assert!(lu.fiches().iter().all(|fiche| fiche.id != *id), "{stem} : {id} est une masse masquée par défaut, comme l'instance de sa famille");
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
        // Les formes de familles sur place que leur instance dessine ne le sont plus (`FORMES_ECARTEES`) : absentes d'après, présentes d'avant.
        let gone: BTreeSet<u64> = FORMES_ECARTEES.iter().filter(|(file, ..)| file == stem).map(|(_, form, ..)| *form).chain(FORMES_DE_MASSES_MASQUEES.iter().filter(|(file, _)| file == stem).map(|(_, form)| *form)).collect();
        let keys_before: Vec<&String> = before["elements"].as_object().expect("elements").keys().filter(|key| !gone.contains(&id_of(before, key))).collect();
        assert_eq!(before["elements"].as_object().expect("elements").len() - keys_before.len(), gone.len(), "{stem} : toutes les formes écartées étaient dessinées avant");
        let keys_after: Vec<&String> = after["elements"].as_object().expect("elements").keys().collect();
        assert_eq!(keys_before, keys_after, "{stem} : mêmes éléments, dans le même ordre, hors les formes de familles sur place");
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
        // 15 501 éléments avec une catégorie avant, 21 de moins depuis que les formes de familles sur place ne sont plus dessinées (17 avaient une catégorie, plus
        // 4 formes de masses masquées : 15 480), dont 9 changent.
        assert_eq!((compared, changed), (15_480, CHANGEMENTS.len()));
        assert_eq!(CHANGEMENTS.len(), 9);
    }
}
