//! Mesure de l'extraction native des enregistrements (canaux 102 et 103) : `cargo run --release
//! --example records -- [--rvt-rs] [--refus] <fichier>...`
//!
//! Une ligne par fichier et par canal : année de Revit, enregistrements, graphes décodés, refusés, taux
//! de décodage, secondes, et l'encadrement constaté (groupes par largeur d'identifiant, par règle de taille
//! déclarée, groupes inattendus ; en canal 103, le nombre d'éléments dessinés, ceux dont le graphe
//! s'ouvre par `GElement`). `--rvt-rs` lit aussi chaque fichier de 2023 et plus avec rvt-rs
//! (la référence) pour comparer les durées ; `--refus` détaille les classes et les diagnostics refusés ;
//! `--champs` compte, par fichier, les champs qui changent d'une année à l'autre : les `InstanceInfo` sans
//! `m_GRepId` (voir `native::normalize_legacy`) et les objets qui portent `m_unitType` (Revit jusqu'en
//! 2020 ou 2021) ou `m_specTypeId` (après).

use std::collections::{BTreeMap, BTreeSet};
use std::process::ExitCode;
use std::time::Instant;

use revit::native::{self, Options};

fn options(channel: u64) -> Options {
    // Les mêmes plafonds que `geometry::saved::GRAPH_LIMIT`.
    Options { channels: BTreeSet::from([channel]), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() }
}

fn main() -> ExitCode {
    let mut compare = false;
    let mut details = false;
    let mut fields = false;
    let paths: Vec<String> = std::env::args()
        .skip(1)
        .filter(|argument| {
            match argument.as_str() {
                "--rvt-rs" => compare = true,
                "--refus" => details = true,
                "--champs" => fields = true,
                _ => return !argument.rsplit('/').next().is_some_and(|name| name.starts_with("._")),
            }
            false
        })
        .collect();
    if paths.is_empty() {
        eprintln!("usage : cargo run --release --example records -- [--rvt-rs] [--refus] [--champs] <fichier>...");
        return ExitCode::from(2);
    }

    println!("{:<40} {:>5} {:>7} {:>5} {:>6} {:>8} {:>8} {:>7} {:>7} {:>7} | {}", "fichier", "année", "Mo", "canal", "lu par", "enreg.", "décodés", "refusés", "taux %", "s", "encadrement");
    let mut failures = 0;
    for path in &paths {
        let mut counts: BTreeMap<&str, [usize; 4]> = BTreeMap::new();
        let name = std::path::Path::new(path).file_name().map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                println!("{name:<40} illisible : {error}");
                failures += 1;
                continue;
            }
        };
        let megabytes = bytes.len() as f64 / 1e6;
        let mut file = match rvt::RevitFile::open_bytes(bytes) {
            Ok(file) => file,
            Err(error) => {
                println!("{name:<40} fichier Revit illisible : {error}");
                failures += 1;
                continue;
            }
        };
        let version = file.basic_file_info().map(|info| info.version).unwrap_or(0);

        // Le préambule seul : ce que paie la première extraction d'un fichier.
        native::clear_preamble_cache();
        let step = Instant::now();
        let preamble_note = match native::preamble(&mut file) {
            Ok(preamble) => format!(
                "préambule {:.3} s ({} éléments indexés, {} classes, catalogue de stockage extensible : {})",
                step.elapsed().as_secs_f64(),
                preamble.index.identities.len(),
                preamble.registry.classes.len(),
                match &preamble.es_catalog {
                    Ok((catalog, _)) => format!("{} schémas", catalog.schemas.len()),
                    Err(error) => format!("ILLISIBLE ({})", error.chars().take(200).collect::<String>()),
                }
            ),
            Err(error) => format!("préambule illisible : {error:#}"),
        };

        for channel in [102u64, 103] {
            let mut decoded = 0usize;
            let mut refused = 0usize;
            let mut drawn = 0usize;
            let mut classes: BTreeMap<String, usize> = BTreeMap::new();
            let mut diagnostics: BTreeMap<String, usize> = BTreeMap::new();
            let step = Instant::now();
            let mut on_record = |record: native::Record| {
                if let Some(graph) = &record.graph {
                    decoded += 1;
                    // Un graphe de canal 103 qui s'ouvre par `GElement` est un élément dessiné.
                    drawn += usize::from(channel == 103 && graph.objects.first().is_some_and(|root| root.class_name == "GElement"));
                } else {
                    refused += 1;
                    *classes.entry(record.class_name.clone().unwrap_or_else(|| "<aucune>".into())).or_default() += 1;
                    *diagnostics.entry(record.diagnostic.clone().unwrap_or_default().chars().take(150).collect()).or_default() += 1;
                }
                if fields {
                    if let Some(graph) = &record.graph {
                        for object in &graph.objects {
                            let key = |name: &str| object.fields.get(name).is_some();
                            counts.entry(if channel == 103 { "103" } else { "102" }).or_insert([0; 4]);
                            let entry = counts.get_mut(if channel == 103 { "103" } else { "102" }).expect("entrée ajoutée");
                            if object.class_name == "InstanceInfo" {
                                entry[0] += 1;
                                entry[1] += usize::from(!key("m_GRepId"));
                            }
                            entry[2] += usize::from(key("m_unitType"));
                            entry[3] += usize::from(key("m_specTypeId"));
                        }
                    }
                }
                Ok(())
            };
            let result = native::extract_graphs_reporting(&mut file, &options(channel), &mut on_record);
            let seconds = step.elapsed().as_secs_f64();
            match result {
                Ok((summary, framing)) => {
                    let total = decoded + refused;
                    let rate = if total == 0 { 100.0 } else { 100.0 * decoded as f64 / total as f64 };
                    let by = "port";
                    let framing_note = format!("groupes id {:?} règle {:?}, {} inattendus, {} enreg. encadrés", framing.groups_by_id_width, framing.groups_by_rule, framing.unexpected_groups, framing.records);
                    println!("{name:<40} {version:>5} {megabytes:>7.1} {channel:>5} {by:>6} {total:>8} {decoded:>8} {refused:>7} {rate:>7.2} {seconds:>7.2} | {framing_note} (indexés {}, historiques écartés {}{})", summary.indexed_elements, summary.skipped_historical_records, if channel == 103 { format!(", dessinés {drawn}") } else { String::new() });
                    if details && refused > 0 {
                        println!("    classes refusées : {classes:?}");
                        for (diagnostic, count) in &diagnostics {
                            println!("    {count} × {diagnostic}");
                        }
                    }
                }
                Err(error) => {
                    failures += 1;
                    println!("{name:<40} {version:>5} {megabytes:>7.1} {channel:>5} ERREUR {error:#}");
                }
            }
            if compare && version >= 2023 {
                decoded = 0;
                refused = 0;
                let step = Instant::now();
                let result = rvt::research::native_document::extract_graphs(&mut file, &options(channel), |record| {
                    if record.graph.is_some() {
                        decoded += 1;
                    } else {
                        refused += 1;
                    }
                    Ok(())
                });
                let seconds = step.elapsed().as_secs_f64();
                match result {
                    Ok(_) => println!("{name:<40} {version:>5} {megabytes:>7.1} {channel:>5} {:>6} {:>8} {decoded:>8} {refused:>7} {:>7} {seconds:>7.2} |", "rvt-rs", decoded + refused, ""),
                    Err(error) => println!("{name:<40} {version:>5} {megabytes:>7.1} {channel:>5} rvt-rs ERREUR {error:#}"),
                }
            }
        }
        println!("{name:<40} {preamble_note}");
        if fields {
            for (channel, [instance_infos, without_grepid, unit_type, spec_type]) in &counts {
                println!("{name:<40} canal {channel} : InstanceInfo {instance_infos} dont sans m_GRepId {without_grepid} ; objets avec m_unitType {unit_type}, avec m_specTypeId {spec_type}");
            }
        }
    }
    if failures > 0 { ExitCode::FAILURE } else { ExitCode::SUCCESS }
}
