//! Modèles partagés (worksharing) : un central et deux copies locales de DynamoRevit (`Project1`, Revit 2020)
//! et un second central (Rhino.Inside.Revit), quand `revit/samples/` les a (`npm run samples:revit`). À lancer
//! avec `cargo test --release --test workshared`.
//!
//! - la copie locale (fichier) et la copie du cache de BIM 360 se routent par leur table locale d'incréments
//!   (`native::increments`), que rvt-rs refuse (« global/local increment routing tables differ ») ;
//! - leurs enregistrements des canaux 102 et 103 sont, élément par élément, ceux du central (graphes égaux) ;
//! - un central et tous les autres fichiers gardent la table de rvt-rs, octet pour octet (`Routing::Shared`) ;
//! - la lecture complète (`revit::read`) des trois fichiers rend le même modèle, par la lecture native de bout
//!   en bout (aucun repli sur l'export IFC), et la copie porte l'avertissement qui dit ce qu'elle est.
//!
//! Les essais de sélection de la table, sur des valeurs JSON fabriquées, sont dans `src/native/increments.rs`.

use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;

use revit::native::{self, Options, Routing, increments};
use rvt::RevitFile;
use rvt::research::native_index;
use rvt::research::schema_registry;

const CENTRAL: &str = "Project1-Central.rvt";
const LOCAL: &str = "Project1-LocalFile.rvt";
const CLOUD: &str = "Project1-BIM360-Local.rvt";
const RHINO_CENTRAL: &str = "revit-docs_v20_project_ws.rvt";

/// Les copies locales de `revit/samples/` : toutes les autres sont des centraux ou des fichiers non partagés.
const LOCAL_COPIES: [&str; 2] = [LOCAL, CLOUD];

fn samples_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples")
}

fn sample(name: &str) -> Option<PathBuf> {
    let path = samples_dir().join(name);
    if path.exists() {
        Some(path)
    } else {
        eprintln!("{name} absent : essai ignoré (npm run samples:revit)");
        None
    }
}

fn routing(path: &PathBuf) -> Routing {
    native::clear_preamble_cache();
    let mut file = RevitFile::open(path).unwrap();
    native::preamble(&mut file).unwrap().routing
}

/// Empreinte de chaque enregistrement émis (classe, état, graphe entier), par ElementId.
fn records(path: &PathBuf, channel: u64) -> (BTreeMap<u64, u64>, native::Summary) {
    native::clear_preamble_cache();
    let mut file = RevitFile::open(path).unwrap();
    let options = Options { channels: BTreeSet::from([channel]), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() };
    let mut out = BTreeMap::new();
    let (summary, _) = native::extract_graphs_reporting(&mut file, &options, |record| {
        let mut digest = DefaultHasher::new();
        (&record.class_name, &record.status).hash(&mut digest);
        if let Some(graph) = &record.graph {
            serde_json::to_string(&graph.objects.iter().map(|object| (&object.class_name, &object.fields)).collect::<Vec<_>>()).unwrap().hash(&mut digest);
        }
        assert!(out.insert(record.identity.element_id, digest.finish()).is_none(), "deux enregistrements courants pour {}", record.identity.element_id);
        Ok(())
    })
    .unwrap();
    (out, summary)
}

fn read(path: &PathBuf) -> revit::Output {
    revit::read(&std::fs::read(path).unwrap(), &revit::Options::default()).unwrap_or_else(|error| panic!("{} : {error:#}", path.display()))
}

#[test]
fn les_copies_locales_se_routent_par_leur_table_locale() {
    let (Some(central), Some(local), Some(cloud)) = (sample(CENTRAL), sample(LOCAL), sample(CLOUD)) else { return };
    assert_eq!(routing(&central), Routing::Shared);
    // La copie de fichier connaît les trois incréments du central et n'en a écrit qu'un ; celle de BIM 360 deux et un.
    assert_eq!(routing(&local), Routing::Local { global_rows: 3, local_rows: 1 });
    assert_eq!(routing(&cloud), Routing::Local { global_rows: 2, local_rows: 1 });
}

#[test]
fn les_enregistrements_d_une_copie_locale_sont_ceux_du_central() {
    let (Some(central), Some(local), Some(cloud)) = (sample(CENTRAL), sample(LOCAL), sample(CLOUD)) else { return };
    for channel in [102, 103] {
        let (reference, summary) = records(&central, channel);
        // Le central garde, en plus de l'enregistrement courant de chaque élément, 6 537 copies historiques.
        assert_eq!((summary.indexed_elements, summary.emitted_records, summary.skipped_historical_records), (6664, 6664, 6537), "central, canal {channel}");
        assert!(summary.selected_ids_without_records.is_empty(), "central, canal {channel}");

        // La copie locale n'a que l'enregistrement courant de chacun, octet pour octet celui du central.
        let (copy, summary) = records(&local, channel);
        assert_eq!((summary.emitted_records, summary.skipped_historical_records, summary.selected_ids_without_records.len()), (6664, 0, 0), "copie locale, canal {channel}");
        assert_eq!(summary.current_records_outside_route, 0, "copie locale, canal {channel} : aucun enregistrement hors de sa route");
        assert_eq!(copy, reference, "canal {channel} : la copie locale diffère du central");

        // La copie de BIM 360 est un autre document (l'envoi au nuage est un « enregistrer sous ») : 103
        // FamilySurrogate et le GeoSite changent (canal 102), jamais un graphique (canal 103).
        let (copy, summary) = records(&cloud, channel);
        assert_eq!((summary.emitted_records, summary.skipped_historical_records, summary.selected_ids_without_records.len()), (6664, 0, 0), "BIM 360, canal {channel}");
        assert_eq!(copy.keys().collect::<Vec<_>>(), reference.keys().collect::<Vec<_>>(), "canal {channel} : les éléments de BIM 360 sont ceux du central");
        let differing = reference.iter().filter(|(id, digest)| copy.get(id) != Some(digest)).count();
        assert_eq!(differing, if channel == 102 { 104 } else { 0 }, "BIM 360, canal {channel}");
    }
}

#[test]
fn la_lecture_complete_d_une_copie_locale_rend_le_modele_du_central() {
    let (Some(central), Some(local), Some(cloud)) = (sample(CENTRAL), sample(LOCAL), sample(CLOUD)) else { return };
    let reference = read(&central);
    assert_eq!(reference.report.release, Some(2020));
    assert!(!reference.report.warnings.iter().any(|warning| warning == increments::LOCAL_COPY_WARNING), "un central n'est pas une copie locale : {:?}", reference.report.warnings);
    // Ce que ces projets de gabarit contiennent : 6 664 éléments, dont une seule instance de famille, trois niveaux et
    // deux masses que la règle des masses n'affiche pas. Rien à dessiner : la comparaison des tableaux est donc
    // celle des clés et des métadonnées ; les enregistrements, eux, sont comparés un à un ci-dessus.
    let other_warnings = |output: &revit::Output| output.report.warnings.iter().filter(|warning| warning.as_str() != increments::LOCAL_COPY_WARNING).cloned().collect::<Vec<_>>();

    for (name, path) in [("copie locale", &local), ("BIM 360", &cloud)] {
        let copy = read(path);
        assert_eq!(copy.keys, reference.keys, "{name}");
        assert_eq!(copy.names, reference.names, "{name}");
        assert_eq!(copy.sources, reference.sources, "{name}");
        assert_eq!(copy.origin, reference.origin, "{name}");
        assert_eq!(copy.positions, reference.positions, "{name}");
        assert_eq!(copy.normals, reference.normals, "{name}");
        assert_eq!(copy.indices, reference.indices, "{name}");
        assert_eq!(copy.primitives, reference.primitives, "{name}");
        assert_eq!(copy.materials, reference.materials, "{name}");
        assert_eq!(copy.metadata, reference.metadata, "{name}");
        let (a, b) = (&copy.report, &reference.report);
        assert_eq!((a.release, a.elements, a.triangles, a.without_geometry), (b.release, b.elements, b.triangles, b.without_geometry), "{name}");
        assert_eq!(format!("{:?}", a.sources), format!("{:?}", b.sources), "{name}");
        assert_eq!(other_warnings(&copy), other_warnings(&reference), "{name} : mêmes avertissements que le central, sauf la note de copie locale");

        // L'avertissement de copie locale est là, une fois, en tête.
        assert_eq!(a.warnings.first().map(String::as_str), Some(increments::LOCAL_COPY_WARNING), "{name} : {:?}", a.warnings);
        assert_eq!(a.warnings.iter().filter(|warning| warning.as_str() == increments::LOCAL_COPY_WARNING).count(), 1, "{name}");

        // Aucun repli sur l'export IFC de rvt-rs (il échouerait sur une copie locale) : lecture native de bout en bout.
        assert!(!a.experimental, "{name} : lecture expérimentale");
        assert_eq!(a.sources.rebuilt, 0, "{name}");
        assert!(!a.warnings.iter().any(|warning| warning.contains("IFC") || warning.contains("n'ont pas pu être lus") || warning.contains("n'ont pas pu être lues")), "{name} : {:?}", a.warnings);
        let seconds = |stage: &str| a.stages.iter().find(|candidate| candidate.name == stage).map(|candidate| candidate.seconds);
        // L'étape « export IFC » n'est notée que si l'export a eu lieu : elle manque.
        assert_eq!(seconds("géométrie : export IFC"), None, "{name} : l'export IFC ne doit pas être calculé pour la géométrie");
        assert_eq!(seconds("propriétés : fiches (export IFC)"), None, "{name} : les fiches ne viennent pas de l'export IFC");
        assert!(seconds("propriétés : fiches").is_some(), "{name} : les fiches viennent des enregistrements natifs");
    }
}

#[test]
fn le_second_central_garde_la_table_de_rvt_rs() {
    let Some(path) = sample(RHINO_CENTRAL) else { return };
    assert_eq!(routing(&path), Routing::Shared);
    let output = read(&path);
    assert_eq!(output.report.release, Some(2020));
    assert!(!output.report.experimental);
    assert!(!output.report.warnings.iter().any(|warning| warning == increments::LOCAL_COPY_WARNING), "{:?}", output.report.warnings);
}

/// Pour chaque fichier d'un dossier : la table de ce module est celle de rvt-rs quand rvt-rs lit (mêmes lignes,
/// `Shared`), son refus quand il refuse (même message), et ne diffère de rvt-rs que pour une copie locale connue.
/// Rend le nombre de fichiers lus par la table de rvt-rs, refusés par rvt-rs et ce module, lus par la table locale,
/// et ignorés (dont rvt-rs ne lit pas le schéma : Revit 2012 et 2013, et la famille de 2008).
fn check_files(files: &[PathBuf]) -> (usize, usize, usize, usize) {
    let (mut shared, mut refused, mut local, mut skipped) = (0, 0, 0, 0);
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let mut file = RevitFile::open(path).unwrap_or_else(|error| panic!("{name} : {error:#}"));
        let (Ok(formats), Ok(table)) = (native::read_single(&mut file, "Formats/Latest"), native::read_single(&mut file, "Global/DocumentIncrementTable")) else {
            panic!("{name} : flux du préambule illisibles");
        };
        let Ok(registry) = schema_registry::parse(&formats) else {
            // rvt-rs ne lit pas le schéma de Revit 2012 et 2013 (ni celui d'une famille de 2008) : `native::schema` le lit pour la lecture
            // native, et ce n'est pas l'affaire de ce module. Un fichier plus récent dont le schéma ne se lit pas est une erreur.
            assert!(native::format_year(&mut file).is_none_or(|(year, _)| year < 2014), "{name} : schéma illisible");
            eprintln!("{name} : enregistré avant Revit 2014, ignoré");
            skipped += 1;
            continue;
        };
        match (native_index::storage_increments(&table, &registry), increments::storage_increments(&table, &registry)) {
            (Ok(strict), Ok((ours, routing))) => {
                assert_eq!(routing, Routing::Shared, "{name}");
                assert_eq!(ours, strict, "{name} : mêmes incréments que rvt-rs");
                assert!(!LOCAL_COPIES.contains(&name.as_str()), "{name} est une copie locale : rvt-rs ne devrait pas la lire");
                shared += 1;
            }
            (Err(strict), Err(ours)) => {
                assert_eq!(format!("{ours:#}"), format!("{strict:#}"), "{name} : le refus est celui de rvt-rs");
                assert!(!LOCAL_COPIES.contains(&name.as_str()), "{name} est une copie locale lisible : {strict:#}");
                refused += 1;
            }
            (Err(strict), Ok((_, routing))) => {
                assert!(matches!(routing, Routing::Local { .. }), "{name}");
                assert!(LOCAL_COPIES.contains(&name.as_str()), "{name} : lu par la table locale alors que rvt-rs refuse ({strict:#}) et que ce n'est pas une copie locale connue");
                local += 1;
            }
            (Ok(_), Err(error)) => panic!("{name} : rvt-rs lit, pas ce module ({error:#})"),
        }
    }
    (shared, refused, local, skipped)
}

#[test]
fn le_fichier_d_essai_livre_garde_la_table_de_rvt_rs() {
    // Le seul fichier versionné : l'essai ne dépend pas du téléchargement des échantillons.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Revit_IFC5_Einhoven.rvt");
    assert_eq!(check_files(&[path.clone()]), (1, 0, 0, 0));
    assert_eq!(routing(&path), Routing::Shared);
}

#[test]
fn central_et_fichiers_non_partages_gardent_la_table_de_rvt_rs() {
    let Ok(entries) = std::fs::read_dir(samples_dir()) else {
        eprintln!("revit/samples absent : essai ignoré (npm run samples:revit)");
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            // Pas les « ._ » que macOS écrit sur un disque exFAT.
            !name.starts_with('.') && matches!(path.extension().and_then(|extension| extension.to_str()), Some("rvt" | "rfa" | "rte"))
        })
        .collect();
    files.sort();
    let (shared, refused, local, skipped) = check_files(&files);
    eprintln!("{} fichiers : {shared} par la table de rvt-rs, {refused} refusés par rvt-rs et ce module, {local} par la table locale, {skipped} d'avant Revit 2014", files.len());
    // Les copies locales présentes sont les seules lues par la table locale, et il n'y en a pas d'autre.
    let present = LOCAL_COPIES.iter().filter(|name| samples_dir().join(name).exists()).count();
    assert_eq!(local, present);
    assert_eq!(refused, 0, "aucun fichier d'essai ne doit être refusé");
    assert_eq!(shared + local + skipped, files.len());
}
