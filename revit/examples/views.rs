//! Montre les enregistrements de phases, de filtres de phase et de vues 3D d'un fichier Revit :
//!
//!   cargo run --release --example views -- <fichier.rvt> --classes [sous-chaîne...]   classes du schéma dont le nom contient l'une des sous-chaînes (nombre d'enregistrements)
//!   cargo run --release --example views -- <fichier.rvt> --dump Classe...             tous les champs des enregistrements de ces classes
//!   cargo run --release --example views -- <fichier.rvt> --id Id...                   idem pour des éléments donnés
//!
//! Sans option : la lecture complète, et les sections `phases` et `views` du JSON de métadonnées qui en sort.

use revit::native::{self, Options};
use std::collections::{BTreeMap, BTreeSet};

fn identifier(value: &serde_json::Value) -> Option<i64> {
    value.as_i64().or_else(|| ["m_id", "m_id64"].iter().find_map(|key| value.get(*key)).and_then(identifier))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.first().expect("usage : views <fichier.rvt> [--classes|--dump ...]");
    let bytes = std::fs::read(path)?;
    let mut file = rvt::RevitFile::open_bytes(bytes)?;
    let mode = args.get(1).map(String::as_str);
    let rest: Vec<String> = args.iter().skip(2).cloned().collect();
    match mode {
        Some("--classes") => {
            let preamble = native::preamble(&mut file)?;
            let mut counts: BTreeMap<String, usize> = BTreeMap::new();
            let wanted: BTreeSet<String> = preamble.registry.classes.iter().map(|c| c.name.clone()).filter(|n| rest.is_empty() || rest.iter().any(|r| n.contains(r.as_str()))).collect();
            let options = Options { selected_classes: wanted.clone(), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Options::default() };
            native::extract_graphs(&mut file, &options, |record| {
                *counts.entry(record.class_name.clone().unwrap_or_default()).or_default() += 1;
                Ok(())
            })?;
            for name in &wanted {
                println!("{name:<48} {}", counts.get(name).copied().unwrap_or(0));
            }
        }
        Some("--scan") => {
            // Phases de création et de démolition de tous les enregistrements d'éléments : (créée, démolie) → nombre.
            let options = Options { max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Options::default() };
            let mut counts: BTreeMap<(i64, i64), usize> = BTreeMap::new();
            native::extract_graphs(&mut file, &options, |record| {
                if let Some(root) = record.graph.as_ref().and_then(|graph| graph.objects.first()) {
                    let id = |name: &str| root.fields.get(name).and_then(identifier).unwrap_or(-1);
                    *counts.entry((id("m_createdPhaseId"), id("m_demolishedPhaseId"))).or_default() += 1;
                }
                Ok(())
            })?;
            for ((created, demolished), n) in counts {
                println!("créée {created:>8} démolie {demolished:>8} : {n}");
            }
        }
        Some("--id") => {
            let options = Options { selected_ids: rest.iter().filter_map(|id| id.parse().ok()).collect(), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Options::default() };
            native::extract_graphs(&mut file, &options, |record| {
                println!("=== id {} classe {:?} statut {}", record.identity.element_id, record.class_name, record.status);
                if let Some(graph) = &record.graph {
                    for (i, object) in graph.objects.iter().enumerate() {
                        println!("  [{i}] {} {}", object.class_name, object.fields);
                    }
                }
                Ok(())
            })?;
        }
        Some("--dump") => {
            let options = Options { selected_classes: rest.iter().cloned().collect(), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Options::default() };
            native::extract_graphs(&mut file, &options, |record| {
                println!("=== id {} classe {:?} statut {}", record.identity.element_id, record.class_name, record.status);
                if let Some(graph) = &record.graph {
                    for (i, object) in graph.objects.iter().enumerate() {
                        println!("  [{i}] {} {}", object.class_name, object.fields);
                    }
                }
                Ok(())
            })?;
        }
        _ => {
            // La lecture complète : les sections `phases` et `views` du JSON de métadonnées, et ce que la géométrie en dit.
            let output = revit::read(&std::fs::read(path)?, &revit::Options::default())?;
            let document: serde_json::Value = serde_json::from_str(&output.metadata)?;
            if let Some(phases) = document.get("phases") {
                println!("phases : {}", serde_json::to_string_pretty(phases)?);
            }
            if let Some(views) = document.get("views").and_then(serde_json::Value::as_array) {
                println!("{} vues", views.len());
                // Les étendues du modèle dessiné, dans le repère du projet.
                let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
                for vertex in output.positions.chunks_exact(3) {
                    for axis in 0..3 {
                        let x = f64::from(vertex[axis]) + output.origin[axis];
                        min[axis] = min[axis].min(x);
                        max[axis] = max[axis].max(x);
                    }
                }
                let centre = [(min[0] + max[0]) / 2.0, (min[1] + max[1]) / 2.0, (min[2] + max[2]) / 2.0];
                let radius = ((max[0] - min[0]).powi(2) + (max[1] - min[1]).powi(2) + (max[2] - min[2]).powi(2)).sqrt() / 2.0;
                for view in views {
                    let vec = |value: &serde_json::Value| -> [f64; 3] { std::array::from_fn(|i| value[i].as_f64().unwrap_or(0.0)) };
                    let (position, direction) = (vec(&view["camera"]["position"]), vec(&view["camera"]["direction"]));
                    let to = [centre[0] - position[0], centre[1] - position[1], centre[2] - position[2]];
                    let along = to[0] * direction[0] + to[1] * direction[1] + to[2] * direction[2];
                    let distance = (to.iter().map(|x| x * x).sum::<f64>() - along * along).max(0.0).sqrt();
                    println!("{}  [regard : à {:.1} m de l'axe, rayon du modèle {:.1} m, devant : {}]", serde_json::to_string(view)?, distance, radius, along > 0.0);
                }
            }
            println!("origine du modèle (m) : {:?}, {} éléments", output.origin, output.keys.len());
        }
    }
    Ok(())
}
