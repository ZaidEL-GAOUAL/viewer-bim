//! La « Famille », le « Type » et le libellé des éléments que Revit nomme, lus sur les fichiers d'essai.
//!
//! - Garde-corps : sa famille système (« Garde-corps »), le type est `m_stairsRailingAttrId`.
//! - Lisse haute : le type est `m_typeId` (`TopRailType`), non le symbole interne `ContinuousRailSymbol` (« 1 », « 3 »…).
//! - Gaine et tuyau : le type est `m_idType`.
//! - Profilé de mur intégré à la structure d'un type de mur : la famille et le type du mur qui le possède.
//! - Forme d'une famille sur place : la `Family` et le `FamilySymbol` qui la possède.
//! - Forme de la famille du document (un `.rfa`) : ni famille ni type, le libellé est sa sorte et son identifiant.
//! - Surface divisée : la catégorie « Surface divisée ».
//! - L'année d'enregistrement ne change rien : le même modèle, enregistré par Revit 2014, 2023, 2024 et 2025, a les mêmes noms.
//!
//! Mesures de référence (54 fichiers lisibles, 15 667 éléments dessinés) : 271 éléments sans famille et 176 sans type avant, 61 et 61
//! après ; 5 sans catégorie avant, aucun après. Les 61 restants : 25 topographies, 8 sols de masse, 20 formes d'un `.rfa`, 5 surfaces
//! divisées et 3 formes directes, que Revit ne nomme pas non plus (`viewer-bim-travail/names/spec.md`).
//!
//! À lancer avec `cargo test --release --test names`. Les fichiers publics viennent de `npm run samples:revit` ; sans eux, les essais
//! qui en dépendent passent sans rien faire.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use revit::native::{self, Options as NativeOptions};
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

/// Une fiche : le libellé, les propriétés de tête de l'élément, et sa classe native.
struct Fiche<'a> {
    key: &'a str,
    id: u64,
    class: &'a str,
    label: &'a str,
    properties: &'a serde_json::Map<String, Value>,
}

impl Fiche<'_> {
    fn text(&self, name: &str) -> Option<&str> {
        self.properties.get(name).and_then(Value::as_str)
    }

    /// (Catégorie, Famille, Type) de l'élément.
    fn names(&self) -> (Option<&str>, Option<&str>, Option<&str>) {
        (self.text("Catégorie"), self.text("Famille"), self.text("Type"))
    }
}

/// Un fichier lu : ses métadonnées, et la classe native de chaque élément dessiné.
struct Lu {
    metadata: Value,
    classes: BTreeMap<u64, String>,
}

impl Lu {
    fn fiches(&self) -> Vec<Fiche<'_>> {
        self.metadata["elements"]
            .as_object()
            .expect("elements")
            .iter()
            .map(|(key, entry)| {
                let properties = entry["properties"].as_object().expect("properties");
                let id = properties["Identifiant Revit"].as_u64().expect("identifiant");
                Fiche { key, id, class: self.classes.get(&id).map_or("", String::as_str), label: entry["label"].as_str().expect("libellé"), properties }
            })
            .collect()
    }

    /// La fiche de l'élément `id`.
    fn fiche_of(&self, id: u64) -> Fiche<'_> {
        self.fiches().into_iter().find(|fiche| fiche.id == id).unwrap_or_else(|| panic!("élément {id} dessiné"))
    }

    /// Les fiches des éléments de classe `class`.
    fn of_class(&self, class: &str) -> Vec<Fiche<'_>> {
        self.fiches().into_iter().filter(|fiche| fiche.class == class).collect()
    }
}

/// Lit le fichier d'essai `stem` (lecture complète, comme le navigateur) et la classe de ses éléments dessinés.
fn lire(stem: &str) -> Option<Lu> {
    let path = sample(stem)?;
    let bytes = std::fs::read(&path).expect("fichier d'essai");
    let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{stem} : {error:#}"));
    let metadata: Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    let ids: BTreeSet<u64> = metadata["elements"].as_object().expect("elements").values().filter_map(|entry| entry["properties"]["Identifiant Revit"].as_u64()).collect();
    // La classe native de chaque élément dessiné : l'enregistrement, sans décoder son graphe.
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let mut classes = BTreeMap::new();
    let options = NativeOptions { selected_ids: ids, max_graph_values: 1, max_graph_objects: 1, ..NativeOptions::default() };
    native::extract_graphs(&mut file, &options, |record| {
        classes.insert(record.identity.element_id, record.class_name.clone().unwrap_or_default());
        Ok(())
    })
    .expect("lecture des classes");
    Some(Lu { metadata, classes })
}

#[test]
fn le_garde_corps_de_re1_a_sa_famille_systeme() {
    let Some(lu) = lire("RE1-Architecture") else { return };
    // Revit 2026 l'exporte « Railing:- » : la famille système et un type nommé « - » ; le libellé s'en passe, comme pour les murs.
    let railing = lu.fiche_of(462556);
    assert_eq!(railing.class, "BaseRailing");
    assert_eq!(railing.names(), (Some("Garde-corps"), Some("Garde-corps"), Some("-")));
    assert_eq!(railing.label, "Garde-corps");
}

#[test]
fn tous_les_garde_corps_ont_famille_et_type() {
    for stem in ["DynamoSample_2023", "SampleModel", "rac_advanced_sample_project", "mega_advanced_sample_file"] {
        let Some(lu) = lire(stem) else { continue };
        let railings = lu.of_class("BaseRailing");
        assert!(!railings.is_empty(), "{stem}");
        for railing in railings {
            assert_eq!((railing.text("Catégorie"), railing.text("Famille")), (Some("Garde-corps"), Some("Garde-corps")), "{stem} {}", railing.id);
            assert!(railing.text("Type").is_some(), "{stem} {}", railing.id);
        }
    }
    // Le type de ceux de DynamoSample : « SH_1100mm », et le libellé « Garde-corps : SH_1100mm » (qui était déjà le leur).
    if let Some(lu) = lire("DynamoSample_2023") {
        let railing = lu.fiche_of(567887);
        assert_eq!((railing.text("Famille"), railing.text("Type"), railing.label), (Some("Garde-corps"), Some("SH_1100mm"), "Garde-corps : SH_1100mm"));
    }
}

#[test]
fn les_lisses_hautes_ont_leur_type_et_non_leur_symbole_interne() {
    let Some(lu) = lire("DynamoSample_2023") else { return };
    // 931574 : `m_symbolId` est un `ContinuousRailSymbol` nommé « 1 », `m_typeId` est le `TopRailType`.
    for id in [931574, 931634] {
        let rail = lu.fiche_of(id);
        assert_eq!(rail.class, "TopRail");
        assert_eq!(rail.names(), (Some("Lisses hautes de garde-corps"), Some("Lisse haute"), Some("Rectangular - 50x50mm")), "{id}");
        assert_eq!(rail.label, "Lisse haute : Rectangular - 50x50mm", "{id}");
    }
    // Aucune lisse haute n'a pour type le nom d'un symbole interne.
    let rails = lu.of_class("TopRail");
    assert!(!rails.is_empty());
    for rail in rails {
        assert_eq!((rail.text("Famille"), rail.text("Type")), (Some("Lisse haute"), Some("Rectangular - 50x50mm")), "{}", rail.id);
    }
}

#[test]
fn la_gaine_et_le_tuyau_ont_leur_type() {
    if let Some(lu) = lire("DuctSegmentFlow") {
        let duct = lu.fiche_of(976562);
        assert_eq!(duct.class, "RbsDuctCurve");
        assert_eq!((duct.text("Famille"), duct.text("Type")), (Some("Gaine"), Some("Mitered Elbows / Tees")));
        assert_eq!(duct.label, "Gaine : Mitered Elbows / Tees");
    }
    if let Some(lu) = lire("ConnectorTestR20") {
        let pipe = lu.fiche_of(717849);
        assert_eq!(pipe.class, "RbsPipeCurve");
        assert_eq!((pipe.text("Famille"), pipe.text("Type")), (Some("Tuyau"), Some("Standard")));
        assert_eq!(pipe.label, "Tuyau : Standard");
    }
}

#[test]
fn un_profile_integre_a_la_famille_et_le_type_de_son_mur() {
    let Some(lu) = lire("rac_advanced_sample_project") else { return };
    // 192754 : possédé (ElemTable) par le mur 167548 ; Revit ne le sélectionne pas à part.
    let sweep = lu.fiche_of(192754);
    assert_eq!(sweep.class, "WallSweep");
    let wall = lu.fiche_of(167548);
    assert_eq!(wall.class, "SWall");
    assert_eq!(sweep.names(), (Some("Murs"), Some("Mur de base"), Some("Parapet Wall")));
    assert_eq!(sweep.names(), wall.names());
    assert_eq!(sweep.label, wall.label);
    assert_eq!(sweep.label, "Mur de base : Parapet Wall");
    // Les paramètres du type du mur ne sont pas ceux du profilé : aucun paramètre de type dans sa fiche.
    let typed = |fiche: &Fiche<'_>| fiche.properties.values().filter_map(Value::as_object).flat_map(|group| group.keys()).filter(|name| name.ends_with("(type)")).count();
    assert_eq!(typed(&sweep), 0);
    assert!(typed(&wall) > 0);
    // Les 8 profilés intégrés : tous nomment un mur.
    let sweeps = lu.of_class("WallSweep");
    assert_eq!(sweeps.len(), 8);
    for sweep in sweeps {
        assert_eq!((sweep.text("Catégorie"), sweep.text("Famille")), (Some("Murs"), Some("Mur de base")), "{}", sweep.id);
        assert!(sweep.text("Type").is_some(), "{}", sweep.id);
    }
}

#[test]
fn une_forme_sur_place_est_nommee_comme_son_instance() {
    if let Some(lu) = lire("rac_advanced_sample_project") {
        let form = lu.fiche_of(139682);
        assert_eq!(form.class, "ExtrusionElem");
        assert_eq!(form.names(), (Some("Masses"), Some("Main Building"), Some("Main Building")));
        assert_eq!(form.label, "Main Building : Main Building");
        let pavilion = lu.fiche_of(139763);
        assert_eq!((pavilion.text("Catégorie"), pavilion.label), (Some("Masses"), "Pavillion : Pavillion"));
        // La poutre courbe : une forme balayée d'une famille d'ossature porteuse sur place.
        assert_eq!(lu.fiche_of(201286).label, "Curved Beam : Curved Beam");
    }
    if let Some(lu) = lire("SampleModel") {
        for (id, family, kind) in [(506161, "wardrobe1", "wardrobe"), (523524, "wardrobe2", "wardrobe"), (697449, "hood enclosure", "hood enclosure")] {
            let form = lu.fiche_of(id);
            assert_eq!(form.names(), (Some("Systèmes de mobilier"), Some(family), Some(kind)), "{id}");
            assert_eq!(form.label, format!("{family} : {kind}"), "{id}");
        }
    }
}

#[test]
fn une_forme_sur_place_n_a_pas_les_parametres_de_type_de_son_symbole() {
    // Pas de jointure des paramètres du type : la fiche de la forme n'a que ses propres paramètres.
    let Some(lu) = lire("rac_advanced_sample_project") else { return };
    let form = lu.fiche_of(139682);
    let typed = form.properties.values().filter_map(Value::as_object).flat_map(|group| group.keys()).filter(|name| name.ends_with("(type)")).count();
    assert_eq!(typed, 0);
}

#[test]
fn les_formes_d_un_rfa_sont_nommees_par_leur_sorte() {
    let Some(lu) = lire("FamilyDocumentTests") else { return };
    let kinds = ["Extrusion", "Raccordement", "Raccordement par balayage", "Balayage", "Révolution", "Forme libre", "Forme"];
    let forms = lu.fiches();
    assert_eq!(forms.len(), 10);
    for form in forms {
        // « Extrusion 1234 » : une sorte (la plus longue qui convient) puis l'identifiant.
        let kind = kinds.iter().find(|kind| form.label.strip_prefix(*kind).is_some_and(|rest| rest.starts_with(' '))).unwrap_or_else(|| panic!("{} : libellé « {} »", form.id, form.label));
        assert_eq!(form.label, format!("{kind} {}", form.id));
        assert_eq!((form.text("Famille"), form.text("Type")), (None, None), "{}", form.id);
        assert_eq!(form.text("Catégorie"), Some("Modèles génériques"), "{}", form.id);
    }
    let expected = BTreeMap::from([("ExtrusionElem", "Extrusion"), ("BlendElem", "Raccordement"), ("SweepElem", "Balayage")]);
    for (class, kind) in expected {
        for form in lu.of_class(class) {
            assert_eq!(form.label, format!("{kind} {}", form.id), "{class}");
        }
    }
    // Les autres fichiers de familles : la révolution et la forme de masse.
    if let Some(lu) = lire("setout-point-2013") {
        assert_eq!(lu.of_class("RevolutionElem").iter().map(|form| form.label.to_string()).collect::<Vec<_>>(), ["Révolution 2934"]);
    }
    if let Some(lu) = lire("AdaptivePanel") {
        let forms = lu.of_class("FormElem");
        assert_eq!(forms.len(), 4);
        assert!(forms.iter().all(|form| form.label == format!("Forme {}", form.id) && form.text("Famille").is_none()));
    }
}

#[test]
fn les_surfaces_divisees_de_la_tour_ont_leur_categorie_et_leur_libelle() {
    let Some(lu) = lire("dynamo-tower-6-ds-2013") else { return };
    let divided = lu.of_class("DividedSurface");
    assert_eq!(divided.len(), 5);
    for fiche in divided {
        assert_eq!(fiche.text("Catégorie"), Some("Surface divisée"), "{}", fiche.id);
        assert_eq!(fiche.label, format!("Surface divisée {}", fiche.id));
        assert_eq!((fiche.text("Famille"), fiche.text("Type"), fiche.text("Classe Revit")), (None, None, None), "{}", fiche.id);
    }
}

/// Les classes que Revit ne nomme pas non plus (ni famille ni type) : la topographie, le sol de masse, la forme directe (`m_typeId` à -1),
/// la surface divisée et les formes de la famille du document.
const SANS_FAMILLE: &[&str] = &["SiteSurface", "MassLevelData", "DirectShape", "DividedSurface", "ExtrusionElem", "BlendElem", "SweepElem", "SweptBlendElem", "RevolutionElem", "FormElem", "FreeFormElement"];

#[test]
fn seuls_les_elements_que_revit_ne_nomme_pas_restent_sans_famille() {
    for stem in ["rac_advanced_sample_project", "mega_advanced_sample_file", "SampleModel", "DynamoSample_2023", "drone-hangar-building-2014", "2024_Core_Interior", "RE1-Architecture", "DuctSegmentFlow", "ConnectorTestR20", "FamilyDocumentTests", "dynamo-tower-6-ds-2013"] {
        let Some(lu) = lire(stem) else { continue };
        for fiche in lu.fiches() {
            assert!(fiche.text("Catégorie").is_some(), "{stem} {} : sans catégorie", fiche.id);
            if fiche.text("Famille").is_none() {
                assert!(SANS_FAMILLE.contains(&fiche.class), "{stem} {} ({}) : sans famille", fiche.id, fiche.class);
            }
            // Sans famille, sans type non plus.
            if fiche.text("Famille").is_none() {
                assert!(fiche.text("Type").is_none(), "{stem} {} ({}) : un type sans famille", fiche.id, fiche.class);
            }
        }
    }
}

#[test]
fn l_annee_d_enregistrement_ne_change_pas_les_noms() {
    // Le même modèle enregistré par Revit 2014, 2023, 2024 et 2025 : mêmes libellé, catégorie, famille et type sur chaque clé partagée.
    let years: Vec<(&str, Lu)> = ["DynamoSample_2014", "DynamoSample_2023", "DynamoSample_2024", "DynamoSample_2025"].into_iter().filter_map(|stem| lire(stem).map(|lu| (stem, lu))).collect();
    let Some((first_stem, first)) = years.first() else { return };
    let by_key = |lu: &Lu| -> BTreeMap<String, (String, Option<String>, Option<String>, Option<String>)> {
        lu.fiches().into_iter().map(|fiche| (fiche.key.to_string(), (fiche.label.to_string(), fiche.text("Catégorie").map(str::to_string), fiche.text("Famille").map(str::to_string), fiche.text("Type").map(str::to_string)))).collect()
    };
    let reference = by_key(first);
    for (stem, lu) in &years[1..] {
        let other = by_key(lu);
        let shared: Vec<&String> = reference.keys().filter(|key| other.contains_key(*key)).collect();
        assert!(shared.len() > 200, "{first_stem} et {stem} : {} clés partagées", shared.len());
        for key in shared {
            assert_eq!(reference[key], other[key], "{first_stem} et {stem} : {key}");
        }
    }
}
