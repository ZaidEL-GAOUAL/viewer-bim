//! Mesure et montre les propriétés d'un fichier Revit :
//!
//!   cargo run --release --example props -- <fichier.rvt>...                  bilan par fichier
//!   cargo run --release --example props -- <fichier.rvt> --show Classe...    une fiche par classe native (SWall, FamilyInstance…)
//!   cargo run --release --example props -- <fichier.rvt> --ids               paramètres intégrés rencontrés, avec leur nombre et leur libellé
//!
//! Le bilan de chaque fichier donne aussi les unités : combien de valeurs décimales sont converties en unités SI,
//! combien sont sans dimension, combien sont d'une grandeur inconnue (laissées telles quelles, sans unité).
//!
//! Les éléments passés au module sont ceux que la géométrie enregistrée de Revit dessine, hors types.

use revit::catalog::units::Spec;
use revit::Context;
use rvt::research::{native_document, native_saved_scene};
use std::collections::BTreeMap;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let show_at = args.iter().position(|a| a == "--show");
    let show: Vec<String> = show_at.map(|i| args[i + 1..].to_vec()).unwrap_or_default();
    let list_ids = args.iter().any(|a| a == "--ids");
    let out_at = args.iter().position(|a| a == "--out");
    let paths: Vec<&String> = args[..show_at.unwrap_or(args.len())].iter().enumerate().filter(|(i, _)| out_at.is_none_or(|o| *i != o + 1)).map(|(_, a)| a).filter(|a| !a.starts_with("--") && !a.rsplit('/').next().unwrap_or("").starts_with("._")).collect();

    for path in paths {
        let bytes = std::fs::read(path)?;
        let name = path.rsplit('/').next().unwrap_or(path);
        let mut file = rvt::RevitFile::open_bytes(bytes.clone())?;
        let release = file.basic_file_info().ok().map(|i| i.version).filter(|y| *y > 0);

        // Les éléments dessinés et leur classe (2023+ : classe native ; avant : les ids de la géométrie enregistrée n'existent pas).
        let mut class_of: BTreeMap<u64, String> = BTreeMap::new();
        let native = matches!(release, Some(2023..=2027));
        let ids: Vec<u64>;
        if native {
            native_document::extract_graphs(&mut file, &native_document::Options::default(), |r| {
                class_of.insert(r.identity.element_id, r.class_name.clone().unwrap_or_default());
                Ok(())
            })?;
            let scene = native_saved_scene::extract(&mut rvt::RevitFile::open_bytes(bytes.clone())?, &native_document::Options::default())?;
            ids = scene
                .elements
                .iter()
                .filter(|e| !e.meshes.primitives.is_empty())
                .map(|e| e.id)
                .filter(|id| class_of.get(id).is_some_and(|c| c != "FamilySymbol" && !c.contains("FamSym")))
                .collect();
        } else {
            // Avant 2023 : tous les éléments de la table (la géométrie n'est pas lue ici).
            let guids = rvt::research::revit_global_ids::revit_global_ids(&mut file).unwrap_or_default();
            let mut all: Vec<u64> = guids.keys().map(|id| u64::from(*id)).collect();
            all.sort_unstable();
            all.dedup();
            ids = all;
        }

        // Mesure : fichier fraîchement ouvert (à froid), puis après une lecture des formes (comme dans la chaîne).
        // Les clés viennent de la géométrie, comme dans `read` ; ici, une forme Revit pour chaque élément.
        let guids = rvt::research::revit_global_ids::revit_global_ids(&mut rvt::RevitFile::open_bytes(bytes.clone())?).unwrap_or_default();
        let keys = revit::geometry::identity_keys(&guids, &ids);
        let sources = vec![0u8; ids.len()];

        let mut cold_file = rvt::RevitFile::open_bytes(bytes.clone())?;
        let mut context = Context::new(release);
        let t = Instant::now();
        let properties = revit::properties::build(&mut cold_file, &mut context, &ids, &keys, &sources)?;
        let cold = t.elapsed().as_secs_f64();

        let mut warm_file = rvt::RevitFile::open_bytes(bytes.clone())?;
        if native {
            let _ = native_saved_scene::extract(&mut warm_file, &native_document::Options::default());
        }
        let mut context = Context::new(release);
        let t = Instant::now();
        let again = revit::properties::build(&mut warm_file, &mut context, &ids, &keys, &sources)?;
        let warm = t.elapsed().as_secs_f64();
        assert_eq!(properties.metadata(), again.metadata());

        if let Some(i) = args.iter().position(|a| a == "--out") {
            std::fs::write(&args[i + 1], &properties.metadata())?;
        }
        let doc: serde_json::Value = serde_json::from_str(&properties.metadata())?;
        let elements = doc["elements"].as_object().unwrap();
        let (mut occurrences, mut unnamed) = (0usize, 0usize);
        let mut unnamed_names: BTreeMap<String, usize> = BTreeMap::new();
        let mut with_level = 0usize;
        let mut with_phase = 0usize;
        let mut with_type_params = 0usize;
        let mut with_category = 0usize;
        for (_, e) in elements {
            let props = e["properties"].as_object().unwrap();
            if props.contains_key("Niveau") { with_level += 1; }
            if props.contains_key("Phase de création") { with_phase += 1; }
            if props.contains_key("Catégorie") { with_category += 1; }
            let mut has_type = false;
            for (_, v) in props {
                if let Some(group) = v.as_object() {
                    for (n, _) in group {
                        occurrences += 1;
                        has_type |= n.ends_with("(type)");
                        if n.starts_with("Paramètre Revit") { unnamed += 1; *unnamed_names.entry(n.clone()).or_default() += 1; }
                    }
                }
            }
            if has_type { with_type_params += 1; }
        }
        println!(
            "{name:<44} {} éléments, JSON {:.1} Mo, à froid {cold:.2} s, après les formes {warm:.2} s, nommés {:.2} % ({unnamed}/{occurrences}), catégorie {with_category}, niveau {with_level}, phase {with_phase}, paramètres de type {with_type_params}, georef {}, avert. {}",
            elements.len(),
            properties.metadata().len() as f64 / 1e6,
            100.0 * (occurrences - unnamed) as f64 / occurrences.max(1) as f64,
            doc.get("georeference").map_or("non".to_string(), |g| format!("{:.4},{:.4}", g["latitude"].as_f64().unwrap_or(0.0), g["longitude"].as_f64().unwrap_or(0.0))),
            context.warnings.len(),
        );
        for w in &context.warnings { println!("  avertissement : {w}"); }
        if native {
            // Unités : ce que les fiches font des valeurs décimales (voir catalog::units).
            let census = revit::properties::double_parameters(&mut rvt::RevitFile::open_bytes(bytes.clone())?, &ids)?;
            let (mut total, mut converted, mut plain, mut unknown) = (0usize, 0usize, 0usize, 0usize);
            let mut unconverted: BTreeMap<String, usize> = BTreeMap::new();
            for ((id, spec), (count, kind)) in &census {
                total += count;
                match kind {
                    Spec::Convert(_) => converted += count,
                    Spec::Plain => plain += count,
                    Spec::Unknown => {
                        unknown += count;
                        let what = match spec {
                            Some(spec) => format!("spec {}", revit::catalog::units::kind_of(spec)),
                            None => format!("intégré {id} {}", revit::catalog::parameter(*id).map_or("?", |k| k.name)),
                        };
                        *unconverted.entry(what).or_default() += count;
                    }
                }
            }
            println!("  unités : {total} valeurs décimales, converties {converted}, sans dimension {plain}, grandeur inconnue laissée telle quelle {unknown}");
            // Les longueurs, surfaces, volumes et angles des intégrés sans spec comptent comme convertis ; reste le nombre
            // de valeurs d'une grandeur connue du fichier mais non convertie.
            let mut v: Vec<_> = unconverted.into_iter().collect();
            v.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
            if !v.is_empty() {
                println!("  non converties : {}", v.iter().take(15).map(|(n, c)| format!("{n} x{c}")).collect::<Vec<_>>().join(", "));
            }
        }
        if !unnamed_names.is_empty() {
            let mut v: Vec<_> = unnamed_names.into_iter().collect();
            v.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
            println!("  sans nom : {}", v.iter().take(12).map(|(n, c)| format!("{n} x{c}")).collect::<Vec<_>>().join(", "));
        }
        if list_ids && native {
            // id, occurrences, stockage, exemple, libellé du catalogue, nature, groupe, origine du libellé
            let used = revit::properties::used_builtin_parameters(&mut rvt::RevitFile::open_bytes(bytes.clone())?, &ids)?;
            for (id, (count, storage, example)) in used {
                let known = revit::catalog::parameter(id);
                println!(
                    "{id}\t{count}\t{storage}\t{}\t{}\t{}\t{:?}\t{}\t{}",
                    known.map_or("?", |k| k.name),
                    known.map_or("?", |k| k.label),
                    example.chars().take(30).collect::<String>(),
                    known.map(|k| k.quantity),
                    known.and_then(|k| k.group).unwrap_or("-"),
                    known.map_or("-", |k| if k.manual { "m" } else { "r" }),
                );
            }
        }
        for class in &show {
            if let Some(category) = class.strip_prefix("cat=") {
                // Une fiche de la catégorie demandée (« cat=Portes »).
                let found = elements.iter().find(|(_, e)| e["properties"]["Catégorie"] == category);
                match found {
                    Some((key, e)) => println!("--- catégorie {category}, clé {key}\n{}", serde_json::to_string_pretty(e)?),
                    None => println!("  (aucun élément de catégorie {category})"),
                }
                continue;
            }
            let found = ids.iter().find(|id| class_of.get(id).is_some_and(|c| c == class));
            let Some(id) = found else { println!("  (aucun élément de classe {class})"); continue };
            let key = &keys[ids.iter().position(|i| i == id).expect("élément trouvé plus haut")];
            println!("--- {class} {id}");
            println!("{}", serde_json::to_string_pretty(&elements[key])?);
        }
    }
    Ok(())
}
