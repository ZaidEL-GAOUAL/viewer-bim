//! Les fichiers de Revit 2012 à 2014, lus par leurs enregistrements natifs comme ceux de 2015 et plus.
//!
//! - Année : l'étiquette des builds dont rvt-rs refuse le `BasicFileInfo` se lit dans le flux brut ; un fichier sans étiquette
//!   (Project Vasari) est daté par l'empreinte de son schéma, et le rapport garde `release: None`.
//! - Schéma : `Formats/Latest` de 2012 et de 2013 se lit sans le compte opaque par classe (3 154, 3 519 et 3 619 classes en 2012,
//!   2013 et 2014) ; toute lecture qui n'est pas exacte échoue en disant ce qui a été essayé.
//! - Index des éléments : le jeton de `m_pSource` vaut exactement 2 avant 2015 ; toute autre valeur échoue en la nommant.
//! - Parité : la même famille enregistrée en 2013 et en 2014, et le même modèle enregistré en 2014 et en 2023, donnent les mêmes
//!   formes (ce qui prouve le sens des drapeaux de face de 2012 et de 2013, `m_faceFlags`).
//! - Définitions : avant 2015, le projet écrit parmi ses enregistrements les éléments qui définissent chaque famille chargée
//!   (possédés, dans l'ElemTable, par leur `Family` : ni sur place, ni celle du document) ; ils ne sont ni dessinés ni décrits,
//!   et Revit 2015 et après n'en dessine aucun.
//! - Couverture : pour chaque fichier, au moins autant d'éléments en « Forme Revit » que mesuré (après cette exclusion).
//!
//! À lancer avec `cargo test --release --test pre2015`. Les fichiers publics viennent de `npm run samples:revit` ; sans eux,
//! les essais qui en dépendent passent sans rien faire.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use revit::geometry::pack::MATERIAL_STRIDE;
use revit::geometry::{self, classes};
use revit::native::{self, YearOrigin, elemtable, schema};
use revit::{Context, Options, Output, read};
use rvt::research::native_document::read_single;
use rvt::research::native_index;
use rvt::research::native_parameters::{self, GraphLimits};
use rvt::research::schema_registry;

fn sample(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(std::fs::read(path).expect("fichier d'essai illisible"))
}

fn open(bytes: Vec<u8>) -> rvt::RevitFile {
    rvt::RevitFile::open_bytes(bytes).expect("fichier Revit lisible")
}

/// Un fichier d'avant 2015 d'essai et son année de lecture (celle de l'étiquette ; pour un fichier de Project Vasari, celle de
/// son schéma).
struct Pre2015 {
    file: &'static str,
    year: u32,
}

/// Les fichiers d'avant 2015 de `revit/samples.json` qui se lisent. Le 21e, `tbc-exhaust-fan-build2007.rfa` (une famille de
/// 2008 : une autre disposition des partitions), ne se lit pas ; il a son essai.
const PRE_2015: [Pre2015; 20] = [
    Pre2015 { file: "void-cutter-2012.rfa", year: 2012 },
    Pre2015 { file: "dynamo-solar-radiation-vasari2012.rvt", year: 2012 },
    Pre2015 { file: "AdaptiveComponent-Revit2013.rfa", year: 2013 },
    Pre2015 { file: "setout-point-2013.rfa", year: 2013 },
    Pre2015 { file: "dynamo-nyc-site-2013.rvt", year: 2013 },
    Pre2015 { file: "dynamo-tower-6-ds-2013.rfa", year: 2013 },
    Pre2015 { file: "dynamo-pentagon-profile-2013.rfa", year: 2013 },
    Pre2015 { file: "dynamo-inst-param-2013.rvt", year: 2013 },
    Pre2015 { file: "dynamo-indexed-family-instances-2013.rfa", year: 2013 },
    Pre2015 { file: "DividedCurve-Revit2014.rfa", year: 2014 },
    Pre2015 { file: "dynamo-walls-floors-levels-2014.rvt", year: 2014 },
    Pre2015 { file: "dynamo-structural-framing-2014.rvt", year: 2014 },
    Pre2015 { file: "dynamo-create-wall-2014.rvt", year: 2014 },
    Pre2015 { file: "dynamo-topography-2014.rvt", year: 2014 },
    Pre2015 { file: "drone-hangar-building-2014.rvt", year: 2014 },
    Pre2015 { file: "clockwork-wall-stuff-2014.rvt", year: 2014 },
    Pre2015 { file: "clockwork-roof-floor-stuff-2014.rvt", year: 2014 },
    Pre2015 { file: "dynamo-adaptive-component-2014.rfa", year: 2014 },
    Pre2015 { file: "DynamoSample_2014.rvt", year: 2014 },
    Pre2015 { file: "dynamo-reference-plane-vasari2013.rfa", year: 2014 },
];

/// Les deux fichiers de Project Vasari (sans étiquette « Autodesk Revit ») et l'année de leur schéma.
const VASARI: [(&str, u32); 2] = [("dynamo-solar-radiation-vasari2012.rvt", 2012), ("dynamo-reference-plane-vasari2013.rfa", 2014)];

/// Les builds dont rvt-rs refuse le `BasicFileInfo` (aucun nombre de 2014 à 2030 dans le texte) : 20110309 (Revit 2012),
/// 20120828 et 20120928 (Revit 2013).
const HARD_BUILDS: [(&str, u32); 4] = [("void-cutter-2012.rfa", 2012), ("dynamo-pentagon-profile-2013.rfa", 2013), ("dynamo-tower-6-ds-2013.rfa", 2013), ("dynamo-nyc-site-2013.rvt", 2013)];

// ---------------------------------------------------------------------------------------------
// Année
// ---------------------------------------------------------------------------------------------

/// Les années de `revit/samples.json` : chaque fichier présent a pour `native::release` son `year`, `null` donnant `None`
/// (les deux fichiers de Vasari et la famille de 2008).
#[test]
fn l_annee_de_chaque_echantillon_est_celle_de_samples_json() {
    let list: serde_json::Value = serde_json::from_slice(&std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples.json")).expect("samples.json")).expect("JSON");
    let mut checked = 0;
    for entry in list["samples"].as_array().expect("liste") {
        let name = entry["name"].as_str().expect("nom");
        let path = std::fs::read_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples")).ok().and_then(|dir| dir.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).find(|file| !file.starts_with("._") && file.starts_with(&format!("{name}."))));
        let Some(file) = path else {
            eprintln!("{name} absent de revit/samples/ : essai ignoré");
            continue;
        };
        let Some(bytes) = sample(&file) else { continue };
        let expected = entry["year"].as_u64().map(|year| year as u32);
        assert_eq!(native::release(&mut open(bytes)), expected, "{file}");
        checked += 1;
    }
    eprintln!("{checked} fichiers d'essai datés comme samples.json");
}

/// Les builds de 2012 et de 2013 dont rvt-rs refuse le `BasicFileInfo` : l'année vient de l'étiquette du flux brut.
#[test]
fn l_etiquette_des_builds_que_rvt_rs_refuse_se_lit_dans_le_flux_brut() {
    for (name, year) in HARD_BUILDS {
        let Some(bytes) = sample(name) else { continue };
        let mut file = open(bytes);
        assert!(file.basic_file_info().is_err(), "{name} : rvt-rs date désormais ce fichier ; l'essai ne prouve plus rien");
        assert_eq!(native::raw_label_year(&mut file), Some(year), "{name}");
        assert_eq!(native::release(&mut file), Some(year), "{name}");
        assert_eq!(native::format_year(&mut file), Some((year, YearOrigin::Label)), "{name}");
    }
    // Les builds que rvt-rs date mal (« 20120221 » contient « 2022 ») : l'étiquette fait foi.
    for (name, year) in [("AdaptiveComponent-Revit2013.rfa", 2013), ("dynamo-inst-param-2013.rvt", 2013), ("setout-point-2013.rfa", 2013)] {
        let Some(bytes) = sample(name) else { continue };
        let mut file = open(bytes);
        assert_eq!(file.basic_file_info().expect("BasicFileInfo").version, 2022, "{name}");
        assert_eq!(native::release(&mut file), Some(year), "{name}");
    }
}

/// Un fichier de Project Vasari n'a pas d'étiquette « Autodesk Revit » : pas d'année de version, mais l'empreinte de son schéma est
/// celle de 2012 ou de 2014, et il se lit avec les règles de cette année, avec l'avertissement qui le dit. Le rapport garde
/// `release: None` et n'est pas expérimental.
#[test]
fn un_fichier_de_vasari_est_date_par_son_schema() {
    for (name, year) in VASARI {
        let Some(bytes) = sample(name) else { continue };
        let mut file = open(bytes.clone());
        assert_eq!(native::release(&mut file), None, "{name}");
        assert_eq!(native::raw_label_year(&mut file), None, "{name}");
        assert_eq!(native::format_year(&mut file), Some((year, YearOrigin::Schema)), "{name}");

        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        let report = &output.report;
        assert_eq!(report.release, None, "{name}");
        assert!(!report.experimental, "{name} : lecture expérimentale");
        let warning = format!("Fichier enregistré par un produit qui ne se nomme pas Revit (par exemple Project Vasari) : son format est reconnu à son schéma, celui de Revit {year}.");
        assert_eq!(report.warnings.iter().filter(|message| **message == warning).count(), 1, "{name} : {:?}", report.warnings);
        assert!(report.warnings.iter().all(|message| !message.contains("reconstruction") && !message.contains("n'ont pas pu être lues")), "{name} : {:?}", report.warnings);
        assert!(report.stages.iter().all(|stage| !stage.name.contains("export IFC")), "{name} : l'export IFC a servi");
        assert_eq!(report.sources.rebuilt, 0, "{name}");
        // Le contrat avec TypeScript ne change pas : `release` est `null`, `experimental` est faux.
        let json = serde_json::to_value(report).expect("rapport");
        assert!(json["release"].is_null() && json["experimental"] == serde_json::json!(false), "{name} : {json}");
    }
}

/// La famille de 2008 n'a ni étiquette ni schéma connu : pas d'année. Son `BasicFileInfo` brut ne porte que le build « 20070829_2300 »
/// (un Revit compilé en 2007), antérieur à Revit 2012, dont le premier build date de 2011 : la lecture la refuse, avec le texte de
/// `native::unsupported` pour une année antérieure adapté au build, au lieu d'une reconstruction qui ne trouvait rien.
#[test]
fn la_famille_de_2008_est_refusee_comme_anterieure_a_revit_2012() {
    let Some(bytes) = sample("tbc-exhaust-fan-build2007.rfa") else { return };
    let mut file = open(bytes.clone());
    assert_eq!((native::release(&mut file), native::format_year(&mut file)), (None, None));
    let schema_bytes = read_single(&mut file, "Formats/Latest").expect("Formats/Latest");
    assert_eq!(schema::year_of(&schema_bytes), None);
    // Ni rvt-rs ni le portage ne lisent son schéma : le préambule échoue, avec l'erreur de rvt-rs seule (aucune année ne
    // permet la lecture de secours).
    let error = format!("{:#}", native::read_preamble(&mut file).err().expect("préambule refusé"));
    assert!(error.contains("schema"), "{error}");
    // Le build, lu dans le flux brut.
    assert_eq!(native::old_build(&mut file), Some((2007, "20070829".to_string())));
    let expected = "Revit antérieur à 2012 : ce fichier a été enregistré par une version de Revit compilée en 2007 (build 20070829), dont les enregistrements ne se lisent pas ici (la lecture commence à Revit 2012). Ouvrez-le dans Revit 2012 ou plus récent et enregistrez-le de nouveau.";
    assert_eq!(native::unsupported_build(2007, "20070829"), expected);
    // La lecture échoue avec ce texte, sur les deux chemins (en entier, par morceaux), sans rien reconstruire.
    let error = read(&bytes, &Options::default()).err().expect("lecture refusée");
    assert_eq!(format!("{error:#}"), expected);
    let error = revit::read_streaming(Box::new(std::io::Cursor::new(bytes)), &Options::default(), &mut |_| Ok(())).err().expect("lecture par morceaux refusée");
    assert_eq!(format!("{error:#}"), expected);
}

/// Seul un build de 2010 ou avant fait refuser un fichier d'année inconnue : les builds de Revit 2012 (2011) et de Project Vasari (2012)
/// ne sont pas « anciens », et un fichier daté par son étiquette n'est jamais refusé pour son build.
#[test]
fn seul_un_build_de_2010_ou_avant_est_refuse() {
    for pre in &PRE_2015 {
        let Some(bytes) = sample(pre.file) else { continue };
        let mut file = open(bytes);
        assert_eq!(native::old_build(&mut file), None, "{} : build ancien", pre.file);
    }
}

// ---------------------------------------------------------------------------------------------
// Schéma
// ---------------------------------------------------------------------------------------------

/// Les octets inflatés de `Formats/Latest`.
fn schema_bytes(file: &mut rvt::RevitFile) -> Vec<u8> {
    read_single(file, "Formats/Latest").expect("Formats/Latest")
}

/// La table des empreintes : trois schémas, les préfixes mesurés (2012 : `b41b64b98526`, 2013 : `9104c870ce12`, 2014 :
/// `ecce7218df9f`), et chaque fichier d'avant 2015 présent a l'empreinte de son année (une empreinte par année, quelle que
/// soit la version de l'année).
#[test]
fn les_trois_schemas_d_avant_2015_ont_une_empreinte_par_annee() {
    assert_eq!(schema::SCHEMA_YEARS.iter().map(|(hash, year)| (&hash[..12], *year)).collect::<Vec<_>>(), vec![("b41b64b98526", 2012), ("9104c870ce12", 2013), ("ecce7218df9f", 2014)]);
    assert!(schema::SCHEMA_YEARS.iter().all(|(hash, _)| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())));
    let mut seen: BTreeMap<u32, BTreeSet<String>> = BTreeMap::new();
    for pre in &PRE_2015 {
        let Some(bytes) = sample(pre.file) else { continue };
        let mut file = open(bytes);
        let schema = schema_bytes(&mut file);
        assert_eq!(schema::year_of(&schema), Some(pre.year), "{}", pre.file);
        seen.entry(pre.year).or_default().insert(schema::sha256_hex(&schema));
    }
    for (year, hashes) in &seen {
        assert_eq!(hashes.len(), 1, "Revit {year} : plusieurs schémas : {hashes:?}");
    }
    // Aucun fichier de 2015 et plus n'a l'un de ces schémas.
    for name in ["singleDirectShape.rvt", "Vignette-04-BaseFile.rvt", "DynamoSample_2023.rvt", "DuctSegmentFlow.rvt", "AdaptivePanel.rfa"] {
        let Some(bytes) = sample(name) else { continue };
        assert_eq!(schema::year_of(&schema_bytes(&mut open(bytes))), None, "{name}");
    }
    assert_eq!(schema::year_of(&[]), None);
    assert_eq!(schema::year_of(b"Formats/Latest"), None);
}

/// Le schéma de chaque fichier d'avant 2015 se lit : exactement (aucun octet de reste, le terminateur de 8 octets nuls), des
/// balises de classe qui se suivent de 12 à 12 + n - 1, et le nombre de classes mesuré : 3 154 en 2012, 3 519 en 2013, 3 619 en
/// 2014. rvt-rs refuse ceux de 2012 et de 2013 et lit celui de 2014.
#[test]
fn le_schema_de_chaque_fichier_d_avant_2015_se_lit() {
    let expected: BTreeMap<u32, usize> = BTreeMap::from([(2012, 3154), (2013, 3519), (2014, 3619)]);
    for pre in &PRE_2015 {
        let Some(bytes) = sample(pre.file) else { continue };
        let mut file = open(bytes);
        let raw = schema_bytes(&mut file);
        let registry = schema::parse(&raw, Some(pre.year)).unwrap_or_else(|error| panic!("{} : {error:#}", pre.file));
        assert_eq!(registry.classes.len(), expected[&pre.year], "{}", pre.file);
        assert_eq!((registry.consumed_bytes, registry.terminator_offset), (raw.len(), raw.len() - 8), "{}", pre.file);
        assert_eq!(registry.source_sha256, schema::sha256_hex(&raw), "{}", pre.file);
        assert!(registry.classes.iter().enumerate().all(|(i, class)| usize::from(class.tag) == 12 + i), "{} : balises non séquentielles", pre.file);
        assert_eq!(schema_registry::parse(&raw).is_ok(), pre.year == 2014, "{} : rvt-rs lit le schéma de 2014 et refuse ceux de 2012 et de 2013", pre.file);
        // Le préambule entier, dont l'index des éléments, se lit.
        let preamble = native::read_preamble(&mut file).unwrap_or_else(|error| panic!("{} : {error:#}", pre.file));
        assert_eq!(preamble.registry.classes.len(), expected[&pre.year], "{}", pre.file);
        assert!(!preamble.index.identities.is_empty(), "{}", pre.file);
    }
}

/// Le port, avec le compte opaque, rend le registre de rvt-rs lui-même : sur les schémas de 2014 à 2023.
#[test]
fn le_port_du_schema_rend_celui_de_rvt_rs_quand_le_compte_opaque_existe() {
    for name in ["DividedCurve-Revit2014.rfa", "singleDirectShape.rvt", "Vignette-04-BaseFile.rvt", "SampleModel.rvt", "RiR-Template-2018.rte", "ConnectorTestR20.rvt", "DynamoSample_2023.rvt"] {
        let Some(bytes) = sample(name) else { continue };
        let raw = schema_bytes(&mut open(bytes));
        let theirs = schema_registry::parse(&raw).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        let ours = schema::parse_with(&raw, true).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert_eq!(serde_json::to_value(&ours).expect("registre"), serde_json::to_value(&theirs).expect("registre"), "{name}");
        // `schema::parse` rend celui de rvt-rs sans rien tenter d'autre.
        assert_eq!(serde_json::to_value(schema::parse(&raw, Some(2014)).expect("lu")).expect("registre"), serde_json::to_value(&theirs).expect("registre"), "{name}");
    }
}

/// Sans le compte opaque, le schéma de 2013 se lit ; avec lui, non (et inversement pour 2014) : l'interrupteur est le seul écart.
#[test]
fn le_schema_de_2013_ne_se_lit_que_sans_le_compte_opaque() {
    let (Some(old), Some(new)) = (sample("AdaptiveComponent-Revit2013.rfa"), sample("DividedCurve-Revit2014.rfa")) else { return };
    let (old, new) = (schema_bytes(&mut open(old)), schema_bytes(&mut open(new)));
    assert!(schema::parse_with(&old, false).is_ok());
    let error = format!("{:#}", schema::parse_with(&old, true).err().expect("refusé"));
    assert!(error.contains("schema"), "{error}");
    assert!(schema::parse_with(&new, true).is_ok());
    assert!(schema::parse_with(&new, false).is_err());
}

/// Ce qui n'est pas une lecture exacte échoue, et le message dit ce qui a été essayé : rvt-rs, puis le port sans compte opaque.
#[test]
fn un_schema_de_2013_abime_echoue_avec_les_deux_erreurs() {
    let Some(bytes) = sample("AdaptiveComponent-Revit2013.rfa") else { return };
    let raw = schema_bytes(&mut open(bytes));
    assert!(schema::parse(&raw, Some(2013)).is_ok());

    let mut truncated = raw.clone();
    truncated.pop();
    let mut extended = raw.clone();
    extended.push(0);
    let mut bad_terminator = raw.clone();
    *bad_terminator.last_mut().expect("octets") = 1;
    let mut bad_header = raw.clone();
    bad_header[0] = 1;
    // Un octet de la balise d'une référence de classe poussé hors des classes connues.
    let mut cut_short = raw.clone();
    cut_short.truncate(raw.len() / 2);
    for (what, damaged) in [("tronqué d'un octet", truncated), ("un octet de trop", extended), ("terminateur non nul", bad_terminator), ("en-tête de classe inattendu", bad_header), ("coupé en deux", cut_short)] {
        for year in [Some(2012), Some(2013)] {
            let message = format!("{:#}", schema::parse(&damaged, year).err().unwrap_or_else(|| panic!("{what} : lu sans erreur")));
            assert!(message.contains("refusé par rvt-rs") && message.contains("sans compte opaque par classe"), "{what} : {message}");
            assert!(message.contains(&format!("Revit {}", year.unwrap())), "{what} : {message}");
        }
        // Une autre année, ou une année inconnue : l'erreur de rvt-rs seule, comme avant (le port ne sert qu'en 2012 et en 2013).
        for year in [Some(2014), Some(2016), Some(2023), None] {
            let message = format!("{:#}", schema::parse(&damaged, year).err().unwrap_or_else(|| panic!("{what} : lu sans erreur")));
            assert!(!message.contains("sans compte opaque"), "{what} ({year:?}) : {message}");
        }
    }
    // Le schéma de 2013 donné pour un fichier de 2014 : rvt-rs le refuse, aucune lecture de secours n'est tentée.
    let message = format!("{:#}", schema::parse(&raw, Some(2014)).err().expect("refusé"));
    assert!(message.contains("schema declared field budget") && !message.contains("sans compte opaque"), "{message}");
    assert!(schema::parse(&raw, None).is_err());
}

// ---------------------------------------------------------------------------------------------
// Index des éléments
// ---------------------------------------------------------------------------------------------

/// Les trois flux d'où se déduit l'index d'un fichier : son schéma, ses épisodes de création et `Global/ElemTable`.
fn index_inputs(file: &mut rvt::RevitFile, year: u32) -> (schema_registry::Registry, Vec<String>, Vec<u8>) {
    let registry = schema::parse(&schema_bytes(file), Some(year)).expect("schéma");
    let episodes = native_index::creation_episodes(&read_single(file, "Global/History").expect("Global/History"), &registry).expect("épisodes");
    (registry, episodes, read_single(file, "Global/ElemTable").expect("Global/ElemTable"))
}

/// L'index des éléments de chaque fichier d'avant 2015 se lit (rvt-rs le refuse : jeton de `m_pSource` à 2), le jeton vaut 2, et
/// les deux lectures de l'index qui coexistent (rvt-rs, puis le portage) ne se contredisent pas.
#[test]
fn l_index_des_elements_de_chaque_fichier_d_avant_2015_se_lit() {
    for pre in &PRE_2015 {
        let Some(bytes) = sample(pre.file) else { continue };
        let mut file = open(bytes);
        let (registry, episodes, table) = index_inputs(&mut file, pre.year);
        let strict = format!("{:#}", native_index::parse(&table, &registry, &episodes).err().unwrap_or_else(|| panic!("{} : rvt-rs lit l'index d'avant 2015", pre.file)));
        assert!(strict.contains("unsupported identifier source pointer"), "{} : {strict}", pre.file);
        let index = elemtable::parse(&table, &registry, &episodes, Some(pre.year)).unwrap_or_else(|error| panic!("{} : {error:#}", pre.file));
        assert!(!index.identities.is_empty(), "{}", pre.file);
        assert_eq!(index.row_stride, 28, "{} : lignes de 28 octets", pre.file);
        // Chaque ligne a son propriétaire et sa partition, lus : un projet a des éléments qui en ont un.
        assert!(index.identities.values().all(|identity| identity.raw_fields.len() == 7), "{}", pre.file);
        // L'année demandée ne change que la lecture de secours : rvt-rs, ou rien, pour une année qui n'en a pas.
        for year in [Some(2015), Some(2023), None] {
            let message = format!("{:#}", elemtable::parse(&table, &registry, &episodes, year).err().unwrap_or_else(|| panic!("{} : lu pour {year:?}", pre.file)));
            assert!(message.contains("unsupported identifier source pointer") && !message.contains("jeton du pointeur m_pSource"), "{} ({year:?}) : {message}", pre.file);
        }
    }
}

/// Le jeton du pointeur `m_pSource` : l'octet est cherché (le jeton, puis la balise de l'`IdentifierSource`, qui le suit), puis
/// réécrit.
fn patch_token(table: &[u8], registry: &schema_registry::Registry, from: u32, to: u32) -> Vec<u8> {
    let tag = registry.named("IdentifierSource").expect("IdentifierSource").tag;
    let mut pattern = from.to_le_bytes().to_vec();
    pattern.extend(tag.to_le_bytes());
    let found: Vec<usize> = (0..table.len().saturating_sub(pattern.len())).filter(|at| table[*at..*at + pattern.len()] == pattern[..]).collect();
    assert_eq!(found.len(), 1, "le jeton {from} suivi de la balise {tag} doit apparaître une fois : {found:?}");
    let mut patched = table.to_vec();
    patched[found[0]..found[0] + 4].copy_from_slice(&to.to_le_bytes());
    patched
}

/// Un jeton autre que 2 est refusé avant 2015, et le message le nomme ; le jeton de 2015 et plus (`u32::MAX`) ne l'est pas par
/// rvt-rs mais l'est par le portage, qui n'accepte que 2.
#[test]
fn un_jeton_de_m_p_source_autre_que_2_echoue_en_le_nommant() {
    let Some(bytes) = sample("DividedCurve-Revit2014.rfa") else { return };
    let mut file = open(bytes);
    let (registry, episodes, table) = index_inputs(&mut file, 2014);
    for token in [0u32, 1, 3, 4, 100, 65_536, 0x8000_0002] {
        let patched = patch_token(&table, &registry, 2, token);
        let message = format!("{:#}", elemtable::parse(&patched, &registry, &episodes, Some(2014)).err().unwrap_or_else(|| panic!("jeton {token} accepté")));
        assert!(message.contains(&format!("jeton du pointeur m_pSource inattendu : {token} ")), "jeton {token} : {message}");
        assert!(message.contains("unsupported identifier source pointer"), "les deux erreurs : {message}");
        let direct = format!("{:#}", elemtable::parse_legacy(&patched, &registry, &episodes).err().expect("refusé"));
        assert!(direct.contains(&format!("inattendu : {token} ")), "{direct}");
    }
    let direct = format!("{:#}", elemtable::parse_legacy(&patch_token(&table, &registry, 2, u32::MAX), &registry, &episodes).err().expect("refusé"));
    assert!(direct.contains("inattendu : 4294967295 "), "{direct}");
    // Le jeton de 2015 sur un fichier de 2014 : rvt-rs le lit, comme avant (aucun changement pour ce jeton-là).
    assert!(elemtable::parse(&patch_token(&table, &registry, 2, u32::MAX), &registry, &episodes, Some(2014)).is_ok());
    // Le jeton 2 intact passe, le port seul comme `parse`.
    assert!(elemtable::parse_legacy(&table, &registry, &episodes).is_ok());
}

/// Le port lit comme rvt-rs : l'index d'un fichier de 2015, dont le jeton `u32::MAX` est réécrit en 2, donne par le port le même
/// index (mêmes éléments, mêmes lignes, cimetière et source) que celui que rvt-rs lit sur l'original.
#[test]
fn le_port_de_l_index_rend_celui_de_rvt_rs() {
    for (name, year) in [("singleDirectShape.rvt", 2015u32), ("Vignette-04-BaseFile.rvt", 2016), ("DynamoSample_2023.rvt", 2023), ("AdaptivePanel.rfa", 2027)] {
        let Some(bytes) = sample(name) else { continue };
        let mut file = open(bytes);
        let (registry, episodes, table) = index_inputs(&mut file, year);
        let theirs = native_index::parse(&table, &registry, &episodes).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert!(!theirs.identities.is_empty(), "{name}");
        let patched = patch_token(&table, &registry, u32::MAX, 2);
        let ours = elemtable::parse_legacy(&patched, &registry, &episodes).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert_eq!(serde_json::to_value(&ours).expect("index"), serde_json::to_value(&theirs).expect("index"), "{name}");
        // `parse` d'une année de 2015 et plus : rvt-rs, tel quel ; le jeton 2 y est refusé sans lecture de secours.
        let direct = elemtable::parse(&table, &registry, &episodes, Some(year)).expect("lu");
        assert_eq!(serde_json::to_value(&direct).expect("index"), serde_json::to_value(&theirs).expect("index"), "{name}");
        let message = format!("{:#}", elemtable::parse(&patched, &registry, &episodes, Some(year)).err().expect("refusé"));
        assert!(message.contains("unsupported identifier source pointer") && !message.contains("jeton du pointeur"), "{name} : {message}");
    }
}

// ---------------------------------------------------------------------------------------------
// Parité
// ---------------------------------------------------------------------------------------------

/// Boîte (minimum, maximum) de chaque élément, en mètres, repère absolu.
fn extents(output: &Output) -> Vec<Option<([f64; 3], [f64; 3])>> {
    let mut extents: Vec<Option<([f64; 3], [f64; 3])>> = vec![None; output.keys.len()];
    for row in output.primitives.chunks_exact(6) {
        let element = row[0] as usize;
        for vertex in output.positions[row[1] as usize * 3..(row[1] + row[2]) as usize * 3].chunks_exact(3) {
            let point = [f64::from(vertex[0]) + output.origin[0], f64::from(vertex[1]) + output.origin[1], f64::from(vertex[2]) + output.origin[2]];
            let current = extents[element].get_or_insert((point, point));
            for axis in 0..3 {
                current.0[axis] = current.0[axis].min(point[axis]);
                current.1[axis] = current.1[axis].max(point[axis]);
            }
        }
    }
    extents
}

fn triangles_of(output: &Output) -> Vec<usize> {
    let mut triangles = vec![0; output.keys.len()];
    for row in output.primitives.chunks_exact(6) {
        triangles[row[0] as usize] += row[4] as usize / 3;
    }
    triangles
}

fn colours_of(output: &Output) -> Vec<BTreeSet<[u8; 4]>> {
    let mut colours = vec![BTreeSet::new(); output.keys.len()];
    for row in output.primitives.chunks_exact(6) {
        colours[row[0] as usize].insert(output.materials[row[5] as usize * MATERIAL_STRIDE..][..4].try_into().expect("quatre octets"));
    }
    colours
}

/// Les sommets (absolus, dans l'ordre des indices) et les normales d'un élément.
fn vertices_of(output: &Output, element: usize) -> (Vec<[f64; 3]>, Vec<[f32; 3]>) {
    let (mut positions, mut normals) = (Vec::new(), Vec::new());
    for row in output.primitives.chunks_exact(6).filter(|row| row[0] as usize == element) {
        let (first, start, count) = (row[1] as usize, row[3] as usize, row[4] as usize);
        for index in &output.indices[start..start + count] {
            let vertex = first + *index as usize;
            positions.push([f64::from(output.positions[vertex * 3]) + output.origin[0], f64::from(output.positions[vertex * 3 + 1]) + output.origin[1], f64::from(output.positions[vertex * 3 + 2]) + output.origin[2]]);
            normals.push([output.normals[vertex * 3], output.normals[vertex * 3 + 1], output.normals[vertex * 3 + 2]]);
        }
    }
    (positions, normals)
}

/// La même famille enregistrée par Revit 2013 (faces à `m_faceFlags`, classe de version 8) et par Revit 2014 (`m_faceFlags_v9`) :
/// sur les éléments dessinés des deux côtés, mêmes triangles, mêmes couleurs, mêmes formes (sommets au millimètre, normales dans
/// le même sens). Mesuré : 12 éléments communs, 11 identiques au millimètre et aux normales près ; le douzième a les mêmes
/// triangles et les mêmes normales, et un sommet à 0,6 m. Si les faces retournées (bit 2) étaient lues à l'envers, les normales
/// des corps de six faces à drapeaux 4 et 6 seraient opposées.
#[test]
fn la_meme_famille_de_2013_et_de_2014_donne_les_memes_formes() {
    let (Some(old_bytes), Some(new_bytes)) = (sample("AdaptiveComponent-Revit2013.rfa"), sample("dynamo-adaptive-component-2014.rfa")) else { return };
    let old = read(&old_bytes, &Options::default()).expect("2013");
    let new = read(&new_bytes, &Options::default()).expect("2014");
    assert_eq!((old.report.release, new.report.release), (Some(2013), Some(2014)));
    let index: BTreeMap<&str, usize> = new.keys.iter().enumerate().map(|(i, key)| (key.as_str(), i)).collect();
    let (old_triangles, new_triangles) = (triangles_of(&old), triangles_of(&new));
    let (old_colours, new_colours) = (colours_of(&old), colours_of(&new));
    let (mut shared, mut identical, mut opposite) = (0, 0, 0);
    for (i, key) in old.keys.iter().enumerate() {
        let Some(&j) = index.get(key.as_str()) else { continue };
        shared += 1;
        assert_eq!(old_triangles[i], new_triangles[j], "{key} : triangles");
        assert_eq!(old_colours[i], new_colours[j], "{key} : couleurs");
        assert_eq!(old.sources[i], new.sources[j], "{key} : origine de la forme");
        let ((old_vertices, old_normals), (new_vertices, new_normals)) = (vertices_of(&old, i), vertices_of(&new, j));
        assert_eq!(old_vertices.len(), new_vertices.len(), "{key}");
        let farthest = old_vertices.iter().zip(&new_vertices).map(|(a, b)| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()).fold(0.0, f64::max);
        let facing = old_normals.iter().zip(&new_normals).map(|(a, b)| a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).fold(1.0f32, f32::min);
        opposite += usize::from(facing < 0.0);
        identical += usize::from(farthest < 0.001 && facing > 0.999);
    }
    eprintln!("communs {shared}, identiques {identical}, normales opposées {opposite}");
    assert!(shared >= 5, "éléments communs : {shared}");
    assert_eq!(opposite, 0, "des faces retournées sont lues à l'envers");
    assert!(identical + 1 >= shared, "identiques au millimètre : {identical} sur {shared}");
}

/// Le même modèle enregistré par Revit 2014 et par Revit 2023 (mêmes GlobalId) : les mêmes 257 éléments sont dessinés, avec les
/// mêmes sources, les mêmes triangles, les mêmes libellés, et une boîte à 1 cm près (au moins 255 sur 257 : un mur de fondation et
/// une lisse ont été retouchés entre les deux enregistrements). Revit 2014 écrit en plus, dans le projet, les éléments qui
/// définissent les familles chargées (114 dessinés de trop mesurés, à l'origine du projet) : la règle des définitions les écarte,
/// et les deux lectures dessinent exactement les mêmes éléments.
#[test]
fn dynamo_sample_2014_et_2023_sont_le_meme_modele() {
    let (Some(old_bytes), Some(new_bytes)) = (sample("DynamoSample_2014.rvt"), sample("DynamoSample_2023.rvt")) else { return };
    let old = read(&old_bytes, &Options::default()).expect("2014");
    let new = read(&new_bytes, &Options::default()).expect("2023");
    assert_eq!((old.report.release, new.report.release), (Some(2014), Some(2023)));
    assert_eq!((old.report.elements, new.report.elements), (257, 257));
    assert_eq!(old.keys.iter().collect::<BTreeSet<_>>(), new.keys.iter().collect::<BTreeSet<_>>(), "les deux lectures ne dessinent pas les mêmes éléments");
    let index: BTreeMap<&str, usize> = new.keys.iter().enumerate().map(|(i, key)| (key.as_str(), i)).collect();
    let (old_triangles, new_triangles) = (triangles_of(&old), triangles_of(&new));
    let (old_extents, new_extents) = (extents(&old), extents(&new));
    let old_meta: serde_json::Value = serde_json::from_str(&old.metadata).expect("métadonnées 2014");
    let new_meta: serde_json::Value = serde_json::from_str(&new.metadata).expect("métadonnées 2023");
    let (mut shared, mut near_box) = (0, 0);
    for (i, key) in old.keys.iter().enumerate() {
        let Some(&j) = index.get(key.as_str()) else { continue };
        shared += 1;
        assert_eq!(old.sources[i], new.sources[j], "{key} : origine de la forme");
        assert_eq!(old_triangles[i], new_triangles[j], "{key} : triangles");
        assert_eq!(old_meta["elements"][key]["label"], new_meta["elements"][key]["label"], "{key} : libellé");
        if let (Some(a), Some(b)) = (old_extents[i], new_extents[j]) {
            near_box += usize::from((0..3).all(|axis| (a.0[axis] - b.0[axis]).abs() < 0.01 && (a.1[axis] - b.1[axis]).abs() < 0.01));
        }
    }
    eprintln!("communs {shared} sur {} (2014) et {} (2023), boîte à 1 cm {near_box}", old.keys.len(), new.keys.len());
    assert_eq!(shared, 257, "les éléments de 2023 sont tous dessinés en 2014, et eux seuls");
    assert!(near_box >= 255, "boîtes à 1 cm : {near_box} sur {shared}");
}

/// Les mêmes fichiers d'essai de DynamoRevit avant et après le commit `fc01ba1` (2015-06-18), qui les a réenregistrés dans
/// Revit 2016 : Revit 2016 range les définitions de familles chargées à part (sections à clé de contenu, que la lecture saute),
/// le fichier de 2013 ou de 2014 les écrit parmi les éléments du projet. C'est une vérification indépendante de la règle des
/// définitions : les deux lectures doivent dessiner les mêmes éléments, avec les mêmes formes. Les quatre autres paires mesurées
/// (charpente, mur créé par Dynamo, plan de référence, composant adaptatif) dessinent zéro élément des deux côtés.
#[test]
fn un_fichier_d_avant_2015_et_son_reenregistrement_de_2016_dessinent_les_memes_elements() {
    for (old_name, new_name, expected) in [
        ("dynamo-inst-param-2013.rvt", "dynamo-inst-param-2016.rvt", 4),
        ("dynamo-indexed-family-instances-2013.rfa", "dynamo-indexed-family-instances-2016.rfa", 3),
        ("dynamo-walls-floors-levels-2014.rvt", "dynamo-walls-floors-levels-2016.rvt", 4),
        ("dynamo-topography-2014.rvt", "dynamo-topography-2016.rvt", 1),
    ] {
        let (Some(old_bytes), Some(new_bytes)) = (sample(old_name), sample(new_name)) else { continue };
        let old = read(&old_bytes, &Options::default()).unwrap_or_else(|error| panic!("{old_name} : {error:#}"));
        let new = read(&new_bytes, &Options::default()).unwrap_or_else(|error| panic!("{new_name} : {error:#}"));
        assert_eq!(new.report.release, Some(2016), "{new_name}");
        assert_eq!((old.keys.len(), new.keys.len()), (expected, expected), "{old_name} / {new_name}");
        let index: BTreeMap<&str, usize> = new.keys.iter().enumerate().map(|(i, key)| (key.as_str(), i)).collect();
        let (old_triangles, new_triangles) = (triangles_of(&old), triangles_of(&new));
        for (i, key) in old.keys.iter().enumerate() {
            let &j = index.get(key.as_str()).unwrap_or_else(|| panic!("{old_name} : {key} n'est pas dessiné en 2016"));
            assert_eq!(old.sources[i], new.sources[j], "{old_name} : {key}, origine de la forme");
            assert_eq!(old_triangles[i], new_triangles[j], "{old_name} : {key}, triangles");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Définitions de familles chargées
// ---------------------------------------------------------------------------------------------

/// `ADocument.m_ownerFamilyId` relu à la main (le décodage de la racine de `Global/Latest`, comme la sonde `ownerfamily` de la
/// recherche), indépendamment du champ `Preamble::owner_family` que la lecture utilise : `-1` dans un projet.
fn document_family_by_hand(file: &mut rvt::RevitFile, registry: &schema_registry::Registry) -> i64 {
    let bytes = read_single(file, "Global/Latest").expect("Global/Latest");
    let tag = u16::from_le_bytes([bytes[0], bytes[1]]);
    let root = native_parameters::decode_object_fields_with_limits(&bytes[..bytes.len() - 4], registry, 2, tag, &GraphLimits { max_values: 2_000_000, ..Default::default() }).expect("racine ADocument");
    assert_eq!(root.class_name, "ADocument");
    let value = &root.fields["m_ownerFamilyId"]["m_id"];
    value.get("m_id").or_else(|| value.get("m_id64")).and_then(serde_json::Value::as_i64).expect("m_ownerFamilyId")
}

/// Les éléments « de la sorte définition » du fichier, tels que la spécification les définit et sans passer par la lecture : ceux
/// dont la chaîne de propriétaires d'ElemTable (`owning_element_id`, remontée de 16 pas au plus) rencontre d'abord un enregistrement
/// `Family` qui n'est ni sur place (`m_inPlace`) ni celui du document : le propriétaire direct, ou un propriétaire de propriétaire
/// (un groupe, une courbe…). Calculé ici pour toutes les années, y compris celles où la règle est éteinte.
fn definition_kind(file: &mut rvt::RevitFile) -> BTreeSet<u64> {
    native::clear_preamble_cache();
    let preamble = native::preamble(file).expect("préambule");
    let document = document_family_by_hand(file, &preamble.registry);
    let mut in_place: BTreeMap<u64, Option<bool>> = BTreeMap::new();
    let options = native::Options { channels: BTreeSet::from([102]), selected_classes: BTreeSet::from(["Family".to_string()]), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() };
    native::extract_graphs(file, &options, |record| {
        let flag = record.graph.as_ref().and_then(|graph| graph.objects.first()).and_then(|root| root.fields.get("m_inPlace")).and_then(serde_json::Value::as_bool);
        in_place.insert(record.identity.element_id, flag);
        Ok(())
    })
    .expect("enregistrements Family");
    let identities = &preamble.index.identities;
    let kind = identities
        .keys()
        .copied()
        .filter(|id| {
            let mut owner = identities[id].owning_element_id;
            for _ in 0..16 {
                let Some(owner_id) = u64::try_from(owner).ok() else { return false };
                if let Some(flag) = in_place.get(&owner_id) {
                    return owner != document && *flag == Some(false);
                }
                let Some(next) = identities.get(&owner_id) else { return false };
                owner = next.owning_element_id;
            }
            false
        })
        .collect();
    native::clear_preamble_cache();
    kind
}

/// Les éléments que dessine la lecture (sans les fiches), et l'année de lecture du fichier.
fn drawn(bytes: Vec<u8>) -> (Option<u32>, Vec<u64>, geometry::Stats) {
    let mut file = open(bytes);
    let year = native::format_year(&mut file).map(|(year, _)| year);
    let mut context = Context::new(year);
    let prepared = geometry::prepare_streaming(&mut file, &mut context, &mut |_| Ok(())).expect("géométrie");
    native::clear_preamble_cache();
    (year, prepared.element_ids, prepared.stats)
}

/// Les fichiers de `revit/samples/` présents, hors les doublons AppleDouble (`._*`) que macOS sème sur les disques exFAT.
fn present_samples() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples"))
        .map(|dir| dir.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| !name.starts_with("._") && name.contains('.')).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// La famille du document est lue à la racine de `Global/Latest` : `-1` dans un projet, l'identifiant de l'enregistrement `Family`
/// du document dans une famille (valeurs mesurées sur les fichiers d'essai, `dumps/familyowned-all.log`), et le préambule rend ce
/// que la lecture à la main trouve, sur tous les fichiers présents.
#[test]
fn la_famille_du_document_se_lit_a_la_racine_de_global_latest() {
    for (name, expected) in [("void-cutter-2012.rfa", 2158), ("setout-point-2013.rfa", 2158), ("AdaptiveComponent-Revit2013.rfa", 1020), ("dynamo-tower-6-ds-2013.rfa", 1020), ("DividedCurve-Revit2014.rfa", 1020), ("dynamo-nyc-site-2013.rvt", -1), ("DynamoSample_2014.rvt", -1), ("drone-hangar-building-2014.rvt", -1), ("FamilyDocumentTests.rfa", 273384), ("AdaptivePanel.rfa", 1_591_622), ("SampleModel.rvt", -1)] {
        let Some(bytes) = sample(name) else { continue };
        let mut file = open(bytes);
        let preamble = native::preamble(&mut file).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert_eq!(preamble.owner_family, Ok(expected), "{name}");
        native::clear_preamble_cache();
    }
    let mut checked = 0;
    for name in present_samples() {
        let mut file = open(sample(&name).expect("présent"));
        let Ok(preamble) = native::preamble(&mut file) else { continue };
        let by_hand = document_family_by_hand(&mut file, &preamble.registry);
        assert_eq!(preamble.owner_family, Ok(by_hand), "{name}");
        // Un projet n'est la famille de personne ; un document de famille a la sienne.
        assert_eq!(by_hand == -1, !native::is_family(&file), "{name} : m_ownerFamilyId = {by_hand}");
        checked += 1;
        native::clear_preamble_cache();
    }
    eprintln!("{checked} fichiers : famille du document relue à la main comme par le préambule");
}

/// Les nombres d'éléments dessinés après l'exclusion des définitions de familles chargées : mesurés sur les fichiers d'essai, et
/// pour `DynamoSample_2014.rvt` les mêmes 257 éléments que `DynamoSample_2023.rvt` (mêmes clés).
#[test]
fn les_definitions_de_familles_chargees_ne_sont_pas_dessinees() {
    // Avant la règle : 371, 449, 40, 6 et 12 éléments dessinés (`after-A-measure.txt`). 265 éléments pour le hangar depuis que le contenu des
    // familles sur place est dessiné par leur instance : 279 avant, moins 14 extrusions (les formes des douze familles « Generic Models » dont
    // l'instance dessine les mêmes triangles ; sept de ces formes s'empilaient sur deux endroits, quatre à l'un et trois à l'autre, leurs instances étant ailleurs).
    for (name, expected) in [("DynamoSample_2014.rvt", 257), ("drone-hangar-building-2014.rvt", 265), ("dynamo-structural-framing-2014.rvt", 0), ("DividedCurve-Revit2014.rfa", 0), ("AdaptiveComponent-Revit2013.rfa", 5)] {
        let Some(bytes) = sample(name) else { continue };
        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert_eq!(output.report.elements, expected, "{name}");
        assert_eq!(output.keys.len(), expected, "{name}");
        // Aucune fiche pour ce qui n'est pas dessiné : autant de fiches que d'éléments.
        let meta: serde_json::Value = serde_json::from_str(&output.metadata).expect("métadonnées");
        assert_eq!(meta["elements"].as_object().map_or(0, |elements| elements.len()), expected, "{name} : fiches");
    }
    let (Some(old), Some(new)) = (sample("DynamoSample_2014.rvt"), sample("DynamoSample_2023.rvt")) else { return };
    let (old, new) = (read(&old, &Options::default()).expect("2014"), read(&new, &Options::default()).expect("2023"));
    assert_eq!(old.keys.iter().collect::<BTreeSet<_>>(), new.keys.iter().collect::<BTreeSet<_>>());
}

/// Sur chaque fichier d'avant 2015 présent : aucun élément dessiné ni décrit n'est de la sorte définition (propriétaire d'ElemTable
/// = `Family` ni sur place ni celle du document), la raison est comptée dans le recensement, et l'exclusion est réelle (les
/// fichiers dont la mesure a trouvé des définitions dessinées en comptent au moins autant).
#[test]
fn aucun_element_dessine_ne_definit_une_famille_chargee_avant_2015() {
    // Définitions dessinées avant la règle (mesure de la recherche, `dumps/familyowned-all.log`) : l'exclusion en compte au moins
    // autant, et plus, puisqu'elle compte aussi les éléments sans forme.
    let measured: BTreeMap<&str, usize> = BTreeMap::from([
        ("DynamoSample_2014.rvt", 114),
        ("drone-hangar-building-2014.rvt", 170),
        ("dynamo-structural-framing-2014.rvt", 40),
        ("dynamo-create-wall-2014.rvt", 34),
        ("dynamo-walls-floors-levels-2014.rvt", 34),
        ("dynamo-topography-2014.rvt", 34),
        ("dynamo-nyc-site-2013.rvt", 7),
        ("dynamo-inst-param-2013.rvt", 6),
        ("DividedCurve-Revit2014.rfa", 6),
        ("AdaptiveComponent-Revit2013.rfa", 7),
        ("dynamo-adaptive-component-2014.rfa", 7),
        ("dynamo-indexed-family-instances-2013.rfa", 9),
        ("clockwork-wall-stuff-2014.rvt", 3),
        ("clockwork-roof-floor-stuff-2014.rvt", 3),
    ]);
    let mut checked = 0;
    for pre in &PRE_2015 {
        let Some(bytes) = sample(pre.file) else { continue };
        let (year, ids, stats) = drawn(bytes.clone());
        assert_eq!(year, Some(pre.year), "{}", pre.file);
        let kind = definition_kind(&mut open(bytes.clone()));
        // Le calcul indépendant trouve bien les définitions que la mesure a vues dessinées (sans quoi l'essai ne prouverait rien).
        assert!(kind.len() >= measured.get(pre.file).copied().unwrap_or(0), "{} : {} éléments de la sorte définition trouvés, {} mesurés", pre.file, kind.len(), measured.get(pre.file).copied().unwrap_or(0));
        let leaked: Vec<u64> = ids.iter().copied().filter(|id| kind.contains(id)).collect();
        assert!(leaked.is_empty(), "{} : {} éléments dessinés définissent une famille chargée : {:?}", pre.file, leaked.len(), &leaked[..leaked.len().min(10)]);
        let excluded = stats.rules.get(classes::RELATION_REASONS[6]).copied().unwrap_or(0);
        assert!(excluded >= measured.get(pre.file).copied().unwrap_or(0), "{} : {excluded} définitions écartées, {} dessinées avant la règle", pre.file, measured.get(pre.file).copied().unwrap_or(0));
        assert!(stats.family_unread.is_empty(), "{} : des éléments d'une famille illisible, jamais vus avant : {:?}", pre.file, stats.family_unread);
        // Ni forme ni fiche : la lecture complète ne décrit que des éléments dessinés, aucun de la sorte définition.
        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{} : {error:#}", pre.file));
        let meta: serde_json::Value = serde_json::from_str(&output.metadata).expect("métadonnées");
        let described: BTreeSet<u64> = meta["elements"].as_object().into_iter().flatten().filter_map(|(_, element)| element["properties"]["Identifiant Revit"].as_u64()).collect();
        assert_eq!(described.len(), ids.len(), "{} : une fiche par élément dessiné", pre.file);
        assert!(described.is_disjoint(&kind), "{} : une fiche décrit une définition de famille chargée", pre.file);
        assert!(output.report.warnings.iter().all(|message| !message.contains("dont la définition ne se lit pas")), "{} : {:?}", pre.file, output.report.warnings);
        checked += 1;
    }
    eprintln!("{checked} fichiers d'avant 2015 : aucune définition de famille chargée dessinée");
}

/// La règle est éteinte à partir de 2015 : sur chaque fichier de 2015 et plus présent, la lecture ne dessine aucun élément de la
/// sorte définition (calculée ici aussi, règle éteinte), et ne compte aucune exclusion pour cette raison. Revit 2015 et après
/// n'écrivent pas ces éléments dans le projet (mesuré : 7 314 éléments dessinés sur dix fichiers de 2015 à 2027, aucun).
#[test]
fn aucun_element_dessine_ne_definit_une_famille_chargee_des_2015() {
    let mut checked = 0;
    for name in present_samples() {
        let bytes = sample(&name).expect("présent");
        let (year, ids, stats) = drawn(bytes.clone());
        let Some(year) = year.filter(|year| *year >= 2015) else { continue };
        let kind = definition_kind(&mut open(bytes));
        let leaked: Vec<u64> = ids.iter().copied().filter(|id| kind.contains(id)).collect();
        assert!(leaked.is_empty(), "{name} (Revit {year}) : {} éléments dessinés définissent une famille chargée : {:?}", leaked.len(), &leaked[..leaked.len().min(10)]);
        assert_eq!(stats.rules.get(classes::RELATION_REASONS[6]), None, "{name} : la règle des définitions n'a rien à faire en {year}");
        assert_eq!(stats.rules.get(classes::RELATION_REASONS[7]), None, "{name} : ni celle des pièces atteintes par des intermédiaires, en {year}");
        assert!(stats.family_unread.is_empty(), "{name}");
        eprintln!("{name} (Revit {year}) : {} éléments dessinés, {} de la sorte définition dans l'ElemTable", ids.len(), kind.len());
        checked += 1;
    }
    eprintln!("{checked} fichiers de 2015 et plus : aucun élément dessiné ne définit une famille chargée");
}

/// Un fichier dont tout ce qui se dessinait était des définitions n'a plus rien à dessiner : la lecture rend un résultat vide, sans
/// erreur ni lecture expérimentale (l'interface dit alors « ne contient aucun élément avec une géométrie » ; voir `App.ts`),
/// et la sortie par morceaux n'émet aucun morceau.
#[test]
fn un_fichier_dont_tout_etait_definition_ne_dessine_plus_rien_sans_echouer() {
    for name in ["dynamo-structural-framing-2014.rvt", "dynamo-create-wall-2014.rvt", "DividedCurve-Revit2014.rfa", "dynamo-solar-radiation-vasari2012.rvt"] {
        let Some(bytes) = sample(name) else { continue };
        let mut chunks = 0;
        let output = revit::read_streaming(Box::new(std::io::Cursor::new(bytes.clone())), &Options::default(), &mut |_| {
            chunks += 1;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert_eq!((output.report.elements, output.report.triangles, chunks), (0, 0, 0), "{name}");
        assert!(!output.report.experimental, "{name}");
        assert!(output.report.warnings.iter().all(|message| !message.contains("reconstruction") && !message.contains("n'ont pas pu être lues")), "{name} : {:?}", output.report.warnings);
        let meta: serde_json::Value = serde_json::from_str(&output.metadata).expect("métadonnées");
        assert!(meta["elements"].as_object().is_none_or(|elements| elements.is_empty()), "{name}");
        let whole = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert!(whole.keys.is_empty() && whole.positions.is_empty() && whole.report.elements == 0, "{name}");
    }
}

// ---------------------------------------------------------------------------------------------
// Métadonnées : vues, phases et filtres de phase
// ---------------------------------------------------------------------------------------------

/// La lecture d'un fichier d'essai et son JSON de métadonnées.
fn metadata_of(name: &str, bytes: &[u8]) -> (Output, serde_json::Value) {
    let output = read(bytes, &Options::default()).unwrap_or_else(|error| panic!("{name} : {error:#}"));
    let meta = serde_json::from_str(&output.metadata).unwrap_or_else(|error| panic!("{name} : métadonnées : {error}"));
    (output, meta)
}

/// Les enregistrements des classes `classes` d'un fichier : (identifiant, propriétaire d'ElemTable, nom ou texte, champs).
fn records_of(file: &mut rvt::RevitFile, classes: &[&str]) -> Vec<(String, u64, i64, Option<String>, serde_json::Value)> {
    let options = native::Options { channels: BTreeSet::from([102]), selected_classes: classes.iter().map(|class| (*class).to_string()).collect(), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() };
    let mut found = Vec::new();
    native::extract_graphs(file, &options, |record| {
        let fields = record.graph.as_ref().and_then(|graph| graph.objects.first()).map_or(serde_json::Value::Null, |root| root.fields.clone());
        let name = ["m_viewName", "m_name"].iter().find_map(|key| fields.get(*key)).and_then(serde_json::Value::as_str).map(str::to_string);
        found.push((record.class_name.clone().unwrap_or_default(), record.identity.element_id, record.identity.owning_element_id, name, fields));
        Ok(())
    })
    .expect("enregistrements");
    found
}

/// `DynamoSample_2014.rvt` et `DynamoSample_2023.rvt` sont le même modèle enregistré par deux Revit. Revit 2014 écrit en plus, dans le
/// projet, les vues (41 au lieu de 7), les filtres de phase (12 au lieu de 7) et les phases de chaque famille chargée : possédés, dans
/// l'ElemTable, par leur `Family`, que la lecture écarte comme les éléments de définition. Mesuré après l'écart : `phases` et `views`
/// sont identiques en tout point (noms, nombre, caméras, phase et filtre de chaque vue), comme `version` et `georeference`. Les
/// caméras de 2014 et de 2023 sont les mêmes : rien n'a été retouché entre les deux enregistrements.
///
/// Reste `readOnly`, la liste des noms de propriétés et de groupes des fiches, dans l'ordre où elles les rencontrent. Elle diffère
/// pour ce que les fiches de 2023 ont de plus que celles de 2014, sans rapport avec les familles chargées : un groupe
/// « Modèle analytique » que 48 éléments portent en 2023 (un seul paramètre, « Propriétés thermiques définies par (type) », que
/// Revit 2014 n'écrit pas), et l'ordre des groupes dans une fiche, qui suit l'ordre des paramètres de chaque version. Rien d'autre :
/// les noms de 2014 sont tous ceux de 2023.
#[test]
fn dynamo_sample_2014_et_2023_ont_les_memes_vues_et_les_memes_phases() {
    let (Some(old_bytes), Some(new_bytes)) = (sample("DynamoSample_2014.rvt"), sample("DynamoSample_2023.rvt")) else { return };
    let ((old, old_meta), (new, new_meta)) = (metadata_of("2014", &old_bytes), metadata_of("2023", &new_bytes));
    assert_eq!((old.report.release, new.report.release), (Some(2014), Some(2023)));
    // Les sections sans lien avec les familles chargées.
    assert_eq!(old_meta["version"], new_meta["version"]);
    assert_eq!(old_meta["georeference"], new_meta["georeference"]);
    // Les vues : les 7 de 2023 (la vue 3D par défaut et six vues nommées), et rien de plus en 2014.
    let names = |meta: &serde_json::Value| meta["views"].as_array().expect("vues").iter().map(|view| view["name"].as_str().expect("nom").to_string()).collect::<Vec<_>>();
    assert_eq!(names(&new_meta), vec!["{3D}", "Approach", "From Yard", "Kitchen", "Living Room", "Section Perspective", "Solar Analysis"]);
    assert_eq!(names(&old_meta), names(&new_meta), "noms et nombre des vues");
    assert_eq!(old_meta["views"], new_meta["views"], "caméras, phases et filtres de phase des vues");
    // Les phases : l'ordre, les filtres, les remplacements graphiques.
    assert_eq!(new_meta["phases"]["order"], serde_json::json!(["Existing", "Working Drawings", "Learning Content"]));
    assert_eq!(new_meta["phases"]["filters"].as_array().map(Vec::len), Some(7));
    assert_eq!(old_meta["phases"], new_meta["phases"]);
    // `readOnly` : les noms de 2014 sont ceux de 2023, moins le groupe analytique.
    let read_only = |meta: &serde_json::Value| meta["readOnly"].as_array().expect("readOnly").iter().map(|name| name.as_str().expect("nom").to_string()).collect::<BTreeSet<_>>();
    let (old_names, new_names) = (read_only(&old_meta), read_only(&new_meta));
    assert!(old_names.is_subset(&new_names), "noms de 2014 absents de 2023 : {:?}", old_names.difference(&new_names).collect::<Vec<_>>());
    assert_eq!(new_names.difference(&old_names).collect::<Vec<_>>(), vec!["Modèle analytique"]);
    let analytical = new_meta["elements"].as_object().expect("éléments").values().filter(|element| element["properties"].get("Modèle analytique").is_some()).count();
    let old_analytical = old_meta["elements"].as_object().expect("éléments").values().filter(|element| element["properties"].get("Modèle analytique").is_some()).count();
    assert_eq!((old_analytical, analytical), (0, 48));
    // Rien n'est ambigu : aucune famille illisible.
    assert!(old.report.warnings.iter().all(|message| !message.contains("dont la définition ne se lit pas")), "{:?}", old.report.warnings);
}

/// Le hangar (Revit 2014, sans réenregistrement) écrivait « Existing » puis cinq « New Construction » : le dernier `AllProjectPhases`
/// lu était celui d'une famille chargée, qui ne liste aucune phase, et l'ordre retombait sur toutes les phases par identifiant, celles
/// des familles comprises. Il est celui de l'`AllProjectPhases` du projet (le seul dont le propriétaire d'ElemTable est -1 : 21886, qui
/// liste 32440 et 118390), relu ici à la main : « Existing » puis « New Construction », comme les phases des éléments.
#[test]
fn le_hangar_n_a_plus_les_phases_des_familles_chargees() {
    let Some(bytes) = sample("drone-hangar-building-2014.rvt") else { return };
    let (output, meta) = metadata_of("hangar", &bytes);
    assert_eq!(meta["phases"]["order"], serde_json::json!(["Existing", "New Construction"]));
    // Relu à la main : les phases et l'ordre du projet.
    let mut file = open(bytes);
    let records = records_of(&mut file, &["ProjectPhase", "AllProjectPhases", "PhaseFilterElem"]);
    let project = |class: &str| records.iter().filter(|record| record.0 == class && record.2 == -1).collect::<Vec<_>>();
    let tables = project("AllProjectPhases");
    assert_eq!(tables.len(), 1, "un seul AllProjectPhases possédé par personne (celui du projet)");
    let listed: Vec<i64> = tables[0].4["m_phaseIds"].as_array().expect("m_phaseIds").iter().filter_map(|id| id["m_id"]["m_id"].as_i64()).collect();
    let phases: BTreeMap<i64, &str> = project("ProjectPhase").into_iter().map(|record| (record.1 as i64, record.3.as_deref().expect("nom de phase"))).collect();
    assert_eq!(listed.iter().map(|id| phases[id]).collect::<Vec<_>>(), vec!["Existing", "New Construction"]);
    // Les 7 filtres du projet, ni plus ni moins.
    let filters: Vec<&str> = project("PhaseFilterElem").iter().map(|record| record.3.as_deref().expect("nom de filtre")).collect();
    let written: Vec<&str> = meta["phases"]["filters"].as_array().expect("filtres").iter().map(|filter| filter["name"].as_str().expect("nom")).collect();
    assert_eq!(filters.len(), 7);
    assert_eq!(written.iter().collect::<BTreeSet<_>>(), filters.iter().collect::<BTreeSet<_>>());
    assert_eq!(written.len(), 7);
    // Chaque phase que les éléments dessinés portent est dans l'ordre.
    let order: BTreeSet<&str> = meta["phases"]["order"].as_array().expect("ordre").iter().filter_map(serde_json::Value::as_str).collect();
    for (key, element) in meta["elements"].as_object().expect("éléments") {
        for property in ["Phase de création", "Phase de démolition"] {
            if let Some(phase) = element["properties"][property].as_str() {
                assert!(order.contains(phase), "{key} : {property} « {phase} » hors de l'ordre des phases");
            }
        }
    }
    // Une seule vue : la vue 3D du projet (les deux autres vues 3D du projet sont des gabarits).
    assert_eq!(meta["views"].as_array().map(Vec::len), Some(1));
    // 279 avant que le contenu des familles sur place soit dessiné par leur instance : 14 extrusions de moins.
    assert_eq!(output.report.elements, 265);
}

/// Les mêmes fichiers d'essai de DynamoRevit avant et après leur réenregistrement dans Revit 2016 (voir plus haut) : Revit 2016 range le
/// contenu des familles chargées à part, le fichier de 2013 ou de 2014 le mêle aux enregistrements du projet. Indépendamment des
/// règles : les deux lectures donnent les mêmes vues et les mêmes phases. Un seul écart, qui est du fichier : le projet de 2013 de
/// `dynamo-inst-param` a une vue 3D « Active Workplane: Reference Point » que Revit 2016 n'a pas gardée au réenregistrement (son
/// enregistrement n'existe plus dans le fichier de 2016).
#[test]
fn les_vues_et_les_phases_d_un_fichier_d_avant_2015_sont_celles_de_son_reenregistrement_de_2016() {
    for (old_name, new_name, extra_view) in [
        ("dynamo-inst-param-2013.rvt", "dynamo-inst-param-2016.rvt", Some("Active Workplane: Reference Point")),
        ("dynamo-indexed-family-instances-2013.rfa", "dynamo-indexed-family-instances-2016.rfa", None),
        ("dynamo-walls-floors-levels-2014.rvt", "dynamo-walls-floors-levels-2016.rvt", None),
        ("dynamo-topography-2014.rvt", "dynamo-topography-2016.rvt", None),
    ] {
        let (Some(old_bytes), Some(new_bytes)) = (sample(old_name), sample(new_name)) else { continue };
        let ((_, old_meta), (_, new_meta)) = (metadata_of(old_name, &old_bytes), metadata_of(new_name, &new_bytes));
        let names = |meta: &serde_json::Value| meta["views"].as_array().map(|views| views.iter().map(|view| view["name"].as_str().expect("nom").to_string()).collect::<Vec<_>>()).unwrap_or_default();
        let mut old_names = names(&old_meta);
        if let Some(extra) = extra_view {
            let before = old_names.len();
            old_names.retain(|name| name != extra);
            assert_eq!(old_names.len() + 1, before, "{old_name} : la vue « {extra} » n'est pas dans le fichier de 2013");
        }
        assert_eq!(old_names, names(&new_meta), "{old_name} / {new_name} : vues");
        // Les phases : les mêmes (ou aucune, pour une famille, qui n'en a pas).
        assert_eq!(old_meta.get("phases"), new_meta.get("phases"), "{old_name} / {new_name} : phases");
    }
}

/// Sur chaque fichier d'avant 2015 présent, le JSON ne porte ni vue, ni filtre de phase, ni phase d'une famille chargée : recompté à la
/// main, sans passer par le prédicat de la lecture, d'après les enregistrements de ces classes dont la chaîne de propriétaires
/// d'ElemTable mène à une `Family` chargée (`definition_kind`). Les filtres écrits sont exactement ceux du projet (ou de la famille
/// du document), l'ordre des phases ne nomme que ses phases, et les vues sont parmi ses vues.
#[test]
fn aucune_vue_ni_phase_ni_filtre_d_une_famille_chargee_dans_les_metadonnees_d_avant_2015() {
    let mut checked = 0;
    for pre in &PRE_2015 {
        let Some(bytes) = sample(pre.file) else { continue };
        let mut file = open(bytes.clone());
        let kind = definition_kind(&mut file);
        let records = records_of(&mut file, &["DBView3d", "ProjectPhase", "PhaseFilterElem"]);
        let own = |class: &str| records.iter().filter(|record| record.0 == class && !kind.contains(&record.1)).collect::<Vec<_>>();
        let (_, meta) = metadata_of(pre.file, &bytes);
        // Filtres : exactement ceux qui ne sont pas à une famille chargée.
        let filters = meta["phases"]["filters"].as_array().map_or(0, Vec::len);
        assert_eq!(filters, own("PhaseFilterElem").len(), "{} : filtres de phase", pre.file);
        // Phases : l'ordre ne nomme que des phases du fichier qui ne sont pas à une famille chargée.
        let phases: Vec<&str> = own("ProjectPhase").iter().filter_map(|record| record.3.as_deref()).collect();
        let order: Vec<&str> = meta["phases"]["order"].as_array().map_or(Vec::new(), |order| order.iter().filter_map(serde_json::Value::as_str).collect());
        assert_eq!(order.len(), phases.len(), "{} : phases {order:?} contre {phases:?}", pre.file);
        let mut sorted = (order.clone(), phases.clone());
        sorted.0.sort_unstable();
        sorted.1.sort_unstable();
        assert_eq!(sorted.0, sorted.1, "{} : phases", pre.file);
        // Vues : parmi celles du fichier qui ne sont pas à une famille chargée (une vue sans caméra ou gabarit n'est pas écrite).
        let mut available: BTreeMap<&str, usize> = BTreeMap::new();
        for record in own("DBView3d") {
            *available.entry(record.3.as_deref().unwrap_or("")).or_default() += 1;
        }
        for view in meta["views"].as_array().into_iter().flatten() {
            let name = view["name"].as_str().expect("nom");
            let left = available.get_mut(name).unwrap_or_else(|| panic!("{} : la vue « {name} » n'est pas une vue de ce fichier", pre.file));
            assert!(*left > 0, "{} : la vue « {name} » apparaît plus de fois que dans le fichier", pre.file);
            *left -= 1;
        }
        checked += 1;
    }
    eprintln!("{checked} fichiers d'avant 2015 : aucune vue, aucun filtre ni aucune phase d'une famille chargée");
}

/// Le FNV-1a de 64 bits des octets du JSON de métadonnées : ce que `examples/dump.rs` écrit en tête de ses tableaux, la même fonction.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3))
}

/// Les JSON de métadonnées des fichiers de 2015 et plus, tels que la lecture les écrivait avant la règle des familles chargées étendue
/// aux vues, aux phases et aux filtres (`dump` de tous les fichiers, avant la modification) : (fichier, octets, FNV-1a).
///
/// Mis à jour pour les catégories des classes que la table des classes ne range pas (`tests/categories.rs`) : les onze fichiers dont des
/// catégories ou des libellés changent (AdaptivePanel, DynamoSample_2023 à 2025, FamilyDocumentTests, SampleModel, mega, rac,
/// revit-curtainwall-byprofile_v21, revit-openings_v22, singleDirectShape) ont leur empreinte d'après ; les 23 autres sont, octet pour
/// octet, ceux d'avant.
///
/// Mis à jour de nouveau pour les noms que Revit montre (`tests/names.rs` : famille système des garde-corps, type des lisses hautes, des
/// gaines et des tuyaux, famille et type des profilés de mur intégrés et des formes sur place, sorte des formes d'un `.rfa`, catégorie de
/// la surface divisée) : les douze fichiers dont des libellés, familles ou types changent (AdaptivePanel, ConnectorTestR20,
/// DuctSegmentFlow, DynamoSample_2023 à 2025, FamilyDocumentTests, RE1-Architecture, SampleModel, ShellFamily, mega, rac) ont leur
/// empreinte d'après ; les 22 autres sont, octet pour octet, ceux d'avant.
const METADATA_2015_PLUS: &[(&str, usize, u64)] = &[
    ("2024_Core_Interior.rvt", 608735, 0x7ee7f2a92be1b042),
    ("AdaptivePanel.rfa", 1366, 0xdba576d844cc54e1),
    ("CeilingType.rvt", 2785, 0x9018335c8fcae0e0),
    ("ConnectorTestR20.rvt", 5206, 0x64665edec51ffafd),
    ("DuctSegmentFlow.rvt", 5186, 0x13df71186211c810),
    ("DynamoSample_2023.rvt", 170207, 0xc1b2e122d288010e),
    ("DynamoSample_2024.rvt", 170796, 0x43f7fb2be9baa597),
    ("DynamoSample_2025.rvt", 170796, 0xc1d49ed1f4f1667f),
    ("FamilyDocumentTests.rfa", 3543, 0x23b55878ba8e6624),
    ("MassWithBoxAndCone.rfa", 712, 0x22f0b6822c67be81),
    ("Project1-BIM360-Local.rvt", 2029, 0xf7d720f076def3f8),
    ("Project1-Central.rvt", 2029, 0xf7d720f076def3f8),
    ("Project1-LocalFile.rvt", 2029, 0xf7d720f076def3f8),
    ("RE1-Architecture.rvt", 57928, 0xc8523f321267868d),
    ("RE1-Electrical.rvt", 74442, 0x0daa428ee1609193),
    ("RefineryPrimer-2023-BuildingGenerator.rvt", 84990, 0x15fae7bdd7845e37),
    ("RefineryPrimer-2024-BuildingGenerator.rvt", 87276, 0x1803fa85c80ed521),
    ("RefineryPrimer-2026-BuildingGenerator.rvt", 87525, 0x25b28cd8511b26d7),
    ("Revit_IFC5_Einhoven.rvt", 12898, 0x80af550e4c6e5419),
    ("RiR-Template-2018.rte", 1141, 0xbe768a52732e6f1e),
    ("RoomsAndExits.rvt", 11790, 0x31d6bcc2659cd4bd),
    // 333 868 → 332 831 octets depuis que le contenu des familles sur place est dessiné par leur instance : les fiches de trois formes en moins
    // (`wardrobe1` 506161, `wardrobe2` 523524, `hood enclosure` 697449), et le groupe « Graphismes » du `readOnly`, que seules ces formes portaient ;
    // aucun des 472 autres éléments ne change.
    ("SampleModel.rvt", 332831, 0xba9b7007d30781cf),
    ("ShellFamily.rfa", 1824, 0x613af44cb5706c2d),
    // 427 818 octets : l'élément `existingSite-meerkat.sat` (308836), que les imports CAD du projet avaient ajouté (428 135 octets), est le contenu d'une famille sur place de masse
    // (« Mass 1 », dont l'instance est une masse que Revit masque par défaut) : il n'est plus dessiné, comme sa famille. Le JSON est celui d'avant les imports CAD.
    ("Vignette-04-BaseFile.rvt", 427818, 0xd0346ad16625cbb0),
    ("dynamo-indexed-family-instances-2016.rfa", 2167, 0x1ebfde8889aacd9d),
    ("dynamo-inst-param-2016.rvt", 3278, 0xfa8da399270782cd),
    ("dynamo-topography-2016.rvt", 2247, 0x77fb6f4e9d02389a),
    ("dynamo-walls-floors-levels-2016.rvt", 5576, 0xc50ad1b0c02594d1),
    // 3 010 454 → 3 008 989 et 2 944 299 → 2 942 834 octets (1 465 chacun) depuis que le contenu des familles sur place est dessiné par leur instance : la fiche de la poutre
    // courbe 201286 en moins, que son instance 201308 dessine à son tour, et celles des formes de masse « Main Building » 139682 et « Pavillion » 139763, dont les instances sont des
    // masses que Revit masque par défaut ; et, dans les sept vues 3D enregistrées, l'entrée `hiddenCategories` « Masses » (elle ne liste que les catégories des éléments dessinés,
    // et ces deux formes étaient les seuls éléments « Masses »). Aucun autre élément ne change.
    ("mega_advanced_sample_file.rvt", 3008989, 0xc8fc938fecdd19c8),
    ("rac_advanced_sample_project.rvt", 2942834, 0x9738de592c182cae),
    ("revit-curtainwall-byprofile_v21.rvt", 71220, 0xa00ae21fd7f5f3e3),
    ("revit-docs_v20_project_ws.rvt", 4373, 0x02eb907c018631d0),
    ("revit-openings_v22.rvt", 11418, 0x99c3bf1fbecef549),
    ("singleDirectShape.rvt", 1966, 0x4c55bb3686d11e69),
];

/// La règle des familles chargées est éteinte à partir de 2015 : le JSON de métadonnées de chaque fichier de 2015 et plus présent est
/// octet pour octet celui d'avant la règle sur les vues, les phases et les filtres (longueur et empreinte). Un changement voulu du
/// JSON des fichiers récents met cette table à jour.
#[test]
fn le_json_de_metadonnees_des_fichiers_de_2015_et_plus_n_a_pas_change() {
    let mut checked = 0;
    for (name, length, hash) in METADATA_2015_PLUS {
        let Some(bytes) = sample(name) else { continue };
        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        assert!(output.report.release.is_some_and(|year| year >= 2015), "{name} : {:?}", output.report.release);
        assert_eq!((output.metadata.len(), fnv1a(output.metadata.as_bytes())), (*length, *hash), "{name} : le JSON de métadonnées a changé");
        checked += 1;
    }
    eprintln!("{checked} fichiers de 2015 et plus : métadonnées inchangées");
}

// ---------------------------------------------------------------------------------------------
// Index des éléments : épisode de création
// ---------------------------------------------------------------------------------------------

/// Un épisode de création qui n'est pas dans l'historique (0xFFFFFFFF, ou le premier de trop) fait échouer la lecture de l'index en
/// disant lequel et pour quel élément : jamais un indice faux. Le calcul de l'indice est contrôlé (`+ 1` déborde en WebAssembly, où
/// `usize` a 32 bits, pour 0xFFFFFFFF).
#[test]
fn un_episode_de_creation_hors_de_l_historique_echoue_en_nommant_l_element() {
    let Some(bytes) = sample("DividedCurve-Revit2014.rfa") else { return };
    let mut file = open(bytes);
    let (registry, episodes, table) = index_inputs(&mut file, 2014);
    let index = elemtable::parse(&table, &registry, &episodes, Some(2014)).expect("index");
    // Le champ de la ligne qui porte l'épisode : celui dont la valeur est, pour chaque élément, `creation_episode`.
    let first = index.identities.values().next().expect("un élément");
    let position = (0..first.raw_fields.len()).find(|at| index.identities.values().all(|identity| identity.raw_fields[*at] == identity.creation_episode)).expect("champ de l'épisode de création");
    for episode in [u32::MAX, episodes.len() as u32] {
        let mut patched = table.clone();
        let at = first.row_offset + 4 * position;
        patched[at..at + 4].copy_from_slice(&episode.to_le_bytes());
        let message = format!("{:#}", elemtable::parse_legacy(&patched, &registry, &episodes).err().unwrap_or_else(|| panic!("épisode {episode} accepté")));
        assert!(message.contains(&format!("épisode de création {episode} hors de l'historique ({} épisodes) pour l'élément {}", episodes.len(), first.element_id)), "épisode {episode} : {message}");
    }
    // Le dernier épisode de l'historique est valide.
    let mut patched = table.clone();
    let at = first.row_offset + 4 * position;
    patched[at..at + 4].copy_from_slice(&(episodes.len() as u32 - 1).to_le_bytes());
    assert!(elemtable::parse_legacy(&patched, &registry, &episodes).is_ok());
}

// ---------------------------------------------------------------------------------------------
// Couverture
// ---------------------------------------------------------------------------------------------

/// Ce qui a été mesuré sur un fichier d'avant 2015 après la lecture de son format, avec une marge : éléments dessinés, éléments
/// en « Forme Revit » entière, éléments en forme partielle au plus, et un plafond de triangles. Ni boîte, ni forme reconstruite.
///
/// Ces valeurs sont celles de la lecture qui écarte les éléments définissant une famille chargée (les 114 de `DynamoSample_2014`
/// qui s'empilaient à l'origine du projet : 371 éléments dessinés avant, 257 après) : planchers à 5 % près (aucune marge sous 20
/// éléments, où chaque élément compte), plafonds de triangles environ un quart au-dessus de la mesure. Un fichier qui redessine ses
/// définitions dépasse aussitôt son plafond de triangles ; les nombres exacts sont dans `les_definitions_de_familles_chargees_ne_sont_pas_dessinees`.
struct Floor {
    file: &'static str,
    year: u32,
    elements: usize,
    revit: usize,
    partial: usize,
    triangles: usize,
}

const FLOORS: [Floor; 20] = [
    Floor { file: "void-cutter-2012.rfa", year: 2012, elements: 2, revit: 2, partial: 0, triangles: 100 },
    // Un projet de Project Vasari qui ne contient que des définitions de familles de masse chargées (67 éléments, tous écartés) et
    // les 13 formes de masse que Revit masque par défaut (un avertissement les compte) : rien à dessiner.
    Floor { file: "dynamo-solar-radiation-vasari2012.rvt", year: 2012, elements: 0, revit: 0, partial: 0, triangles: 0 },
    Floor { file: "AdaptiveComponent-Revit2013.rfa", year: 2013, elements: 5, revit: 5, partial: 0, triangles: 30_000 },
    Floor { file: "setout-point-2013.rfa", year: 2013, elements: 1, revit: 1, partial: 0, triangles: 300 },
    // 1 élément, 1 forme partielle : le site (« Site 1 », 56 916 triangles, une face `Plane` au contour non raccordé). Depuis que les imports CAD du
    // projet se dessinent, l'import qu'il contient, `SiteModel.dwg` (230266), de la même forme et de la même face, l'était aussi (2 éléments, 113 832
    // triangles) : ce contenu de la famille sur place « Site 1 » est dessiné par l'instance (230269), qui le place 460 m plus loin, et l'import, à
    // l'endroit où la famille a été créée, n'est plus dessiné.
    Floor { file: "dynamo-nyc-site-2013.rvt", year: 2013, elements: 1, revit: 0, partial: 1, triangles: 64_000 },
    Floor { file: "dynamo-tower-6-ds-2013.rfa", year: 2013, elements: 6, revit: 6, partial: 0, triangles: 7_000 },
    Floor { file: "dynamo-pentagon-profile-2013.rfa", year: 2013, elements: 0, revit: 0, partial: 0, triangles: 0 },
    Floor { file: "dynamo-inst-param-2013.rvt", year: 2013, elements: 4, revit: 4, partial: 0, triangles: 100 },
    Floor { file: "dynamo-indexed-family-instances-2013.rfa", year: 2013, elements: 3, revit: 3, partial: 0, triangles: 2_800 },
    Floor { file: "DividedCurve-Revit2014.rfa", year: 2014, elements: 0, revit: 0, partial: 0, triangles: 0 },
    Floor { file: "dynamo-walls-floors-levels-2014.rvt", year: 2014, elements: 4, revit: 4, partial: 0, triangles: 100 },
    Floor { file: "dynamo-structural-framing-2014.rvt", year: 2014, elements: 0, revit: 0, partial: 0, triangles: 0 },
    Floor { file: "dynamo-create-wall-2014.rvt", year: 2014, elements: 0, revit: 0, partial: 0, triangles: 0 },
    Floor { file: "dynamo-topography-2014.rvt", year: 2014, elements: 1, revit: 1, partial: 0, triangles: 2_800 },
    Floor { file: "drone-hangar-building-2014.rvt", year: 2014, elements: 265, revit: 265, partial: 0, triangles: 73_000 },
    Floor { file: "clockwork-wall-stuff-2014.rvt", year: 2014, elements: 62, revit: 61, partial: 1, triangles: 8_900 },
    // 8 éléments depuis que le contenu des familles sur place est dessiné par leur instance : 9 avant, moins le balayage 181144 (68 486 triangles) de la famille
    // « Roofs 1 », que son instance 181411 dessine à son tour, avec les mêmes triangles (153 918 triangles avant, 85 432 après).
    Floor { file: "clockwork-roof-floor-stuff-2014.rvt", year: 2014, elements: 8, revit: 7, partial: 1, triangles: 107_000 },
    Floor { file: "dynamo-adaptive-component-2014.rfa", year: 2014, elements: 5, revit: 5, partial: 0, triangles: 30_000 },
    Floor { file: "DynamoSample_2014.rvt", year: 2014, elements: 245, revit: 245, partial: 0, triangles: 73_000 },
    Floor { file: "dynamo-reference-plane-vasari2013.rfa", year: 2014, elements: 0, revit: 0, partial: 0, triangles: 0 },
];

/// Chaque fichier d'avant 2015 se lit par ses formes enregistrées : au moins autant d'éléments en « Forme Revit » que mesuré,
/// aucune boîte ni forme reconstruite, pas d'export IFC, pas de lecture expérimentale, des triangles sous le budget.
#[test]
fn chaque_fichier_d_avant_2015_se_lit_par_ses_formes_enregistrees() {
    for floor in &FLOORS {
        let Some(bytes) = sample(floor.file) else { continue };
        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{} : {error:#}", floor.file));
        let report = &output.report;
        let vasari = VASARI.iter().any(|(name, _)| *name == floor.file);
        // L'année de Revit : celle de l'étiquette ; inconnue (et dite telle) pour Project Vasari.
        assert_eq!(report.release, if vasari { None } else { Some(floor.year) }, "{}", floor.file);
        assert!(report.elements >= floor.elements, "{} : {} éléments dessinés, {} attendus au moins", floor.file, report.elements, floor.elements);
        let sources = report.sources;
        assert!(sources.revit >= floor.revit, "{} : {} formes Revit entières, {} attendues au moins ({sources:?})", floor.file, sources.revit, floor.revit);
        assert!(sources.partial <= floor.partial, "{} : {} formes partielles, {} au plus ({sources:?})", floor.file, sources.partial, floor.partial);
        assert_eq!((sources.unknown, sources.rebuilt), (0, 0), "{} : {sources:?}", floor.file);
        assert!(report.stages.iter().all(|stage| !stage.name.contains("export IFC")), "{} : l'export IFC a servi : {:?}", floor.file, report.stages);
        assert!(!report.experimental, "{} : lecture expérimentale", floor.file);
        assert!(report.warnings.iter().all(|message| !message.contains("reconstruction") && !message.contains("n'ont pas pu être lues")), "{} : {:?}", floor.file, report.warnings);
        assert!(report.triangles <= floor.triangles, "{} : {} triangles", floor.file, report.triangles);
        assert!(report.triangles < revit::geometry::MAX_TRIANGLES, "{} : budget de triangles", floor.file);
    }
}

/// Les planchers couvrent les 20 fichiers d'avant 2015 qui se lisent, chacun à l'année de la table des fichiers.
#[test]
fn les_planchers_suivent_la_table_des_fichiers() {
    assert_eq!(FLOORS.len(), PRE_2015.len());
    for floor in &FLOORS {
        assert_eq!(PRE_2015.iter().find(|pre| pre.file == floor.file).map(|pre| pre.year), Some(floor.year), "{}", floor.file);
    }
}
