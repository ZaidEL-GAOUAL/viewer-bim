//! Affiche le graphe graphique (canal 103) d'un élément, ou d'un symbole de famille, pour savoir ce que
//! Revit y a enregistré : `cargo run --release --example graph -- <fichier.rvt> <ElementId>... [--champs]`
//!
//! Le graphe est parcouru depuis sa racine par `m_subNodes`, `m_instanceInfo`, `m_oEmbeddedSymbolGRep`,
//! `m_oConditions` et `m_pFacetedTopology` ; chaque nœud montre sa classe et ses champs scalaires
//! (`--champs` : tous les champs, tronqués à 600 caractères). Un symbole placé par une instance est
//! suivi (`m_symbolId`) et imprimé à la suite.
//!
//! `--classe <Nom>` imprime à la suite, pour chaque graphe lu, tous les champs (sans troncature) des objets de cette
//! classe (`Face`, `HermiteSurf`, `GGTag`…), avec leurs pointeurs résolus en indices d'objets.
//!
//! `graph --classes <fichier.rvt>...` recense à la place les nœuds graphiques de tous les éléments (classe,
//! champs, valeurs distinctes des champs d'état) : de quoi décider, sur les octets, ce que Revit dessine.

use std::collections::BTreeSet;

use revit::native::{self as native_document, Options};
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_saved_mesh::pointer;
use serde_json::Value;

fn identifier(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| ["m_id", "m_id64"].iter().find_map(|key| value.get(*key)).and_then(identifier))
}

fn short(value: &Value, all: bool) -> String {
    let text = value.to_string();
    if all || text.len() <= 160 { text.chars().take(600).collect() } else { format!("{}…({} car.)", text.chars().take(160).collect::<String>(), text.len()) }
}

/// Les champs scalaires d'un nœud, sur une ligne : `GInfo.m_flags` et les champs d'état ; tous avec `--champs`.
fn summary(object: &rvt::research::native_parameters::GraphObject, all: bool) -> String {
    let Some(fields) = object.fields.as_object() else { return String::new() };
    let mut parts = Vec::new();
    for (name, value) in fields {
        let pointerish = value.get("pointer_token").is_some() || value.as_array().is_some_and(|a| a.first().is_some_and(|v| v.get("pointer_token").is_some()));
        match name.as_str() {
            "m_subNodes" | "m_oConditions" | "m_instanceInfo" | "m_oEmbeddedSymbolGRep" | "m_pFacetedTopology" => continue,
            "m_pFaces" => parts.push(format!("faces={}", value.as_array().map_or(0, Vec::len))),
            "m_GInfo" => parts.push(format!("flags={} tag={} cmd={} cat={}", value["m_flags"], value["m_tag"], value["m_controlCommand"], identifier(&value["m_categoryId"]).unwrap_or(-9))),
            "m_forbiddenTarget" => parts.push(format!("cibles={}", value["m_targets"])),
            _ if pointerish && !all => continue,
            "m_bBox" | "m_tightbBox" | "m_tagId" | "m_cda" if !all => continue,
            _ => parts.push(format!("{name}={}", short(value, all))),
        }
    }
    parts.join(" ")
}

fn walk(graph: &ObjectGraph, index: usize, depth: usize, all: bool, seen: &mut BTreeSet<usize>, symbols: &mut BTreeSet<u64>) {
    let object = &graph.objects[index];
    let pad = "  ".repeat(depth);
    let again = !seen.insert(index);
    println!("{pad}[{index}] {} {}{}", object.class_name, summary(object, all), if again { " (déjà vu)" } else { "" });
    if again {
        return;
    }
    if object.class_name == "InstanceInfo" {
        if let Some(id) = object.fields.get("m_symbolId").and_then(identifier).and_then(|id| u64::try_from(id).ok()) {
            symbols.insert(id);
        }
        println!("{pad}  symbole={} trf={}", object.fields["m_symbolId"]["m_id"]["m_id64"], short(&object.fields["m_Trf"], all));
    }
    for name in ["m_instanceInfo", "m_oEmbeddedSymbolGRep", "m_pFacetedTopology"] {
        if let Ok(Some(target)) = pointer(graph, index, &object.fields[name]) {
            println!("{pad}  -> {name}");
            walk(graph, target, depth + 2, all, seen, symbols);
        }
    }
    for name in ["m_oConditions", "m_subNodes"] {
        if let Some(list) = object.fields[name].as_array() {
            for item in list {
                match pointer(graph, index, item) {
                    Ok(Some(target)) => walk(graph, target, depth + 1, all, seen, symbols),
                    other => println!("{pad}  (pointeur non résolu : {other:?})"),
                }
            }
        }
    }
}

/// Recense les nœuds graphiques de tous les éléments des fichiers : par classe, le nombre de nœuds, les
/// champs rencontrés et, pour les champs d'état, leurs valeurs distinctes avec des exemples d'éléments.
fn census(paths: &[String]) {
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Class {
        nodes: usize,
        fields: BTreeMap<String, usize>,
        values: BTreeMap<String, BTreeMap<String, (usize, String)>>,
    }
    // Les champs dont on liste les valeurs.
    const STATE: &[&str] = &["m_targets", "m_bHasScale", "m_resolveSymInView", "m_bIsNestedDetailFamily", "m_GRepId", "m_normalsFlag", "m_comp", "m_param", "m_value", "m_negateDirCondition", "m_gElemType", "m_flags"];
    let mut classes: BTreeMap<String, Class> = BTreeMap::new();
    // GInstance : (cibles interdites, visibilité du nœud) → nombre, et selon que le symbole placé porte des surfaces.
    let mut instances: BTreeMap<(u64, u8), [usize; 3]> = BTreeMap::new();
    let mut examples: BTreeMap<(u64, u8), String> = BTreeMap::new();
    // GFilter « famille de détail imbriquée » : conditions (classe, comparaison, négation) → nombre.
    let mut nested: BTreeMap<String, (usize, String)> = BTreeMap::new();
    // GPolyMesh : topologie (classe, points, normales, facettes, indicateur de normales) → exemples.
    let mut polymeshes: Vec<String> = Vec::new();
    // InstanceInfo : transformations qui inversent l'espace (déterminant négatif) : fichier → (nombre, exemples).
    let mut mirrored: BTreeMap<String, (usize, usize, Vec<String>)> = BTreeMap::new();
    // GImposter / GBiFlipControl : jetons des pointeurs d'actif.
    let mut imposters: Vec<String> = Vec::new();
    // Nœuds conteneurs : (classe du parent, classe de l'enfant) → (nombre, exemple), pour les classes listées dans `PARENTS`.
    const PARENTS: &[&str] = &["GGTag"];
    let mut children_of: BTreeMap<(String, String), (usize, String)> = BTreeMap::new();
    // GInstance dont `m_resolveSymInView` est vrai : (fichier, visibilité du nœud, le symbole porte des surfaces) → (nombre, exemple).
    let mut resolved: BTreeMap<(String, u8, Option<bool>), (usize, String)> = BTreeMap::new();
    let mut resolved_pending: Vec<(String, u8, u64, String)> = Vec::new();
    for path in paths {
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let Ok(bytes) = std::fs::read(path) else { continue };
        let Ok(mut file) = rvt::RevitFile::open_bytes(bytes) else { continue };
        // Tous les fichiers que la lecture native sait lire (2015 à 2027).
        if !file.basic_file_info().ok().is_some_and(|info| native_document::SUPPORTED_RELEASES.contains(&info.version)) {
            continue;
        }
        let options = Options { channels: BTreeSet::from([103]), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() };
        let mut surfaces: BTreeMap<u64, bool> = BTreeMap::new();
        let mut placed: Vec<(u64, u8, u64, u64)> = Vec::new();
        let _ = native_document::extract_graphs(&mut file, &options, |record| {
            let Some(graph) = record.graph else { return Ok(()) };
            let owner = record.identity.element_id;
            surfaces.insert(owner, graph.objects.iter().any(|o| o.class_name == "GPolyMesh" || o.class_name == "Geometry" && o.fields["m_pFaces"].as_array().is_some_and(|a| !a.is_empty())));
            for (index, object) in graph.objects.iter().enumerate() {
                if PARENTS.contains(&object.class_name.as_str()) {
                    for child in object.fields["m_subNodes"].as_array().into_iter().flatten() {
                        let class = match pointer(&graph, index, child) {
                            Ok(Some(target)) => graph.objects[target].class_name.clone(),
                            _ => "(pointeur non résolu)".to_string(),
                        };
                        children_of.entry((object.class_name.clone(), class)).or_insert((0, format!("{name} {owner}"))).0 += 1;
                    }
                }
                if object.class_name == "GInstance" && object.fields["m_resolveSymInView"].as_bool() == Some(true) {
                    let flags = object.fields["m_GInfo"]["m_flags"].as_u64().unwrap_or(0);
                    let bits = flags & 0x1e0;
                    let visibility = if bits == 0 { 0 } else if bits == 0xe0 { 3 } else if bits < 0xe0 { if flags & 0x160 == 0x20 { 1 } else { 2 } } else if flags & 0x1a0 == 0x100 { 1 } else { 2 };
                    let symbol = pointer(&graph, index, &object.fields["m_instanceInfo"]).ok().flatten().and_then(|info| identifier(&graph.objects[info].fields["m_symbolId"])).and_then(|id| u64::try_from(id).ok()).unwrap_or(0);
                    resolved_pending.push((name.clone(), visibility, symbol, format!("{name} {owner}")));
                }
                if object.class_name == "GFilter" && object.fields["m_bIsNestedDetailFamily"].as_bool() == Some(true) {
                    let mut signature = Vec::new();
                    for condition in object.fields["m_oConditions"].as_array().into_iter().flatten() {
                        if let Ok(Some(target)) = pointer(&graph, index, condition) {
                            let c = &graph.objects[target];
                            signature.push(format!("{}(comp={},neg={},param={},val={})", c.class_name, c.fields["m_comp"], c.fields["m_negateDirCondition"], c.fields["m_param"], c.fields["m_value"]));
                        }
                    }
                    let children: Vec<String> = object.fields["m_subNodes"].as_array().into_iter().flatten().filter_map(|child| pointer(&graph, index, child).ok().flatten()).map(|c| graph.objects[c].class_name.clone()).collect();
                    let key = format!("{} -> enfants {}", signature.join(" & "), { let mut c = children; c.sort(); c.dedup(); c.join(",") });
                    nested.entry(key).or_insert((0, format!("{name} {owner}"))).0 += 1;
                }
                if object.class_name == "GImposter" {
                    imposters.push(format!("{name} {owner} : actif={} trf={}", object.fields["m_oAsset"], object.fields["m_trf"]));
                }
                if object.class_name == "InstanceInfo" {
                    let m = &object.fields["m_Trf"]["m_3x3"];
                    let g = |i: usize, j: usize| m[i][j].as_f64().unwrap_or(f64::NAN);
                    let det = g(0, 0) * (g(1, 1) * g(2, 2) - g(1, 2) * g(2, 1)) - g(0, 1) * (g(1, 0) * g(2, 2) - g(1, 2) * g(2, 0)) + g(0, 2) * (g(1, 0) * g(2, 1) - g(1, 1) * g(2, 0));
                    let entry = mirrored.entry(name.clone()).or_default();
                    entry.0 += 1;
                    if det < 0.0 {
                        entry.1 += 1;
                        if entry.2.len() < 6 {
                            entry.2.push(format!("{owner}->{}", object.fields["m_symbolId"]["m_id"]["m_id64"]));
                        }
                    }
                }
                if object.class_name == "GPolyMesh" {
                    let line = match pointer(&graph, index, &object.fields["m_pFacetedTopology"]) {
                        Ok(Some(topology)) => {
                            let t = &graph.objects[topology];
                            let count = |field: &str| t.fields[field].as_array().map_or(-1, |a| a.len() as i64);
                            let arities: BTreeSet<usize> = t.fields["m_facetsArr"].as_array().into_iter().flatten().map(|f| f.as_array().map_or(0, Vec::len)).collect();
                            // Lecture des normales : par facette (la i-ème normale est celle de la facette i) ou par sommet
                            // (la normale de chaque coin est celle de son sommet) : part des triangles dont la normale
                            // concorde avec celle de leurs trois sommets (cos > 0,5, signe compris) ou de leur facette (cos > 0,999).
                            let vec = |field: &str| -> Vec<[f64; 3]> { t.fields[field].as_array().into_iter().flatten().filter_map(|p| Some([p[0].as_f64()?, p[1].as_f64()?, p[2].as_f64()?])).collect() };
                            let (points, normals) = (vec("m_pointsArr"), vec("m_normalsArr"));
                            let facets: Vec<[usize; 3]> = t.fields["m_facetsArr"].as_array().into_iter().flatten().filter_map(|f| Some([f[0].as_u64()? as usize, f[1].as_u64()? as usize, f[2].as_u64()? as usize])).collect();
                            let unit = |v: [f64; 3]| { let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-300); [v[0] / l, v[1] / l, v[2] / l] };
                            let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
                            let (mut per_facet, mut per_vertex, mut valid) = (0usize, 0usize, 0usize);
                            for (i, f) in facets.iter().enumerate() {
                                if f.iter().any(|&c| c >= points.len()) { continue; }
                                let (a, b, c) = (points[f[0]], points[f[1]], points[f[2]]);
                                let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
                                let face = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
                                valid += 1;
                                if normals.get(i).is_some_and(|n| dot(unit(*n), face) > 0.999) { per_facet += 1; }
                                if f.iter().all(|&c| normals.get(c).is_some_and(|n| dot(unit(*n), face) > 0.5)) { per_vertex += 1; }
                            }
                            format!("{name} {owner} : {} points={} normales={} facettes={} (arités {:?}) indicateur={} concordance par facette {per_facet}/{valid}, par sommet {per_vertex}/{valid}", t.class_name, count("m_pointsArr"), count("m_normalsArr"), count("m_facetsArr"), arities, t.fields["m_normalsFlag"])
                        }
                        other => format!("{name} {owner} : topologie introuvable {other:?}"),
                    };
                    polymeshes.push(line);
                }
                if object.class_name == "GInstance" {
                    let targets = object.fields["m_forbiddenTarget"]["m_targets"].as_u64().unwrap_or(u64::MAX);
                    let flags = object.fields["m_GInfo"]["m_flags"].as_u64().unwrap_or(0);
                    let bits = flags & 0x1e0;
                    let visibility = if bits == 0 { 0 } else if bits == 0xe0 { 3 } else if bits < 0xe0 { if flags & 0x160 == 0x20 { 1 } else { 2 } } else if flags & 0x1a0 == 0x100 { 1 } else { 2 };
                    let symbol = pointer(&graph, index, &object.fields["m_instanceInfo"]).ok().flatten().and_then(|info| identifier(&graph.objects[info].fields["m_symbolId"])).and_then(|id| u64::try_from(id).ok()).unwrap_or(0);
                    placed.push((targets, visibility, symbol, owner));
                }
            }
            for object in &graph.objects {
                let entry = classes.entry(object.class_name.clone()).or_default();
                entry.nodes += 1;
                let Some(fields) = object.fields.as_object() else { continue };
                for (field, value) in fields {
                    *entry.fields.entry(field.clone()).or_default() += 1;
                    let value = if field == "m_forbiddenTarget" { value["m_targets"].clone() } else { value.clone() };
                    let field = if field == "m_forbiddenTarget" { "m_targets".to_string() } else { field.clone() };
                    if STATE.contains(&field.as_str()) {
                        let slot = entry.values.entry(field).or_default().entry(value.to_string()).or_insert((0, format!("{name} {}", record.identity.element_id)));
                        slot.0 += 1;
                    }
                }
            }
            Ok(())
        });
        for (file, visibility, symbol, example) in resolved_pending.drain(..) {
            let slot = resolved.entry((file, visibility, surfaces.get(&symbol).copied())).or_insert((0, example));
            slot.0 += 1;
        }
        for (targets, visibility, symbol, owner) in placed {
            let slot = instances.entry((targets, visibility)).or_default();
            match surfaces.get(&symbol) {
                Some(true) => slot[0] += 1,
                Some(false) => slot[1] += 1,
                None => slot[2] += 1,
            }
            examples.entry((targets, visibility)).or_insert_with(|| format!("{name} {owner} -> {symbol}"));
        }
    }
    println!("GImposter :");
    for line in &imposters {
        println!("    {line}");
    }
    println!("InstanceInfo à déterminant négatif (miroir) : fichier → négatifs / total [exemples propriétaire->symbole]");
    for (file, (total, negative, shown)) in &mirrored {
        println!("    {file} : {negative} / {total} {shown:?}");
    }
    println!("GPolyMesh :");
    for line in &polymeshes {
        println!("    {line}");
    }
    println!("GFilter imbriqué (famille de détail) : conditions -> enfants");
    for (key, (count, example)) in &nested {
        println!("    ×{count} [{example}] {key}");
    }
    println!("Enfants des nœuds conteneurs {PARENTS:?} : (parent, enfant) → nombre [exemple]");
    for ((parent, child), (count, example)) in &children_of {
        println!("    {parent} > {child} : {count} [{example}]");
    }
    println!("GInstance à m_resolveSymInView vrai : (fichier, visibilité du nœud, le symbole porte des surfaces : oui/non/graphe absent) → nombre [exemple]");
    for ((file, visibility, surfaces), (count, example)) in &resolved {
        println!("    {file} visibilité {visibility} symbole avec surfaces {} : {count} [{example}]", surfaces.map_or("graphe absent".to_string(), |b| if b { "oui".into() } else { "non".into() }));
    }
    println!("GInstance par (cibles interdites, visibilité) : symbole avec surfaces / sans surface directe / symbole sans graphe");
    for ((targets, visibility), counts) in &instances {
        println!("    cibles {targets:>6} (0b{targets:b}) visibilité {visibility} : {} / {} / {}  [{}]", counts[0], counts[1], counts[2], examples[&(*targets, *visibility)]);
    }
    for (class, entry) in &classes {
        if !class.starts_with('G') && !matches!(class.as_str(), "Geometry" | "InstanceInfo" | "FacetedTopology0") {
            continue;
        }
        println!("{class} : {} nœuds", entry.nodes);
        let fields: Vec<String> = entry.fields.iter().map(|(field, count)| if *count == entry.nodes { field.clone() } else { format!("{field}({count})") }).collect();
        println!("    champs : {}", fields.join(" "));
        for (field, values) in &entry.values {
            let shown: Vec<String> = values.iter().take(14).map(|(value, (count, example))| format!("{value}×{count} [{example}]")).collect();
            println!("    {field} : {}", shown.join(" ; "));
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--classes") {
        census(&args[1..]);
        return;
    }
    let all = args.iter().any(|a| a == "--champs");
    let dump_class: Option<String> = args.iter().position(|a| a == "--classe").and_then(|i| args.get(i + 1)).cloned();
    let args: Vec<String> = match args.iter().position(|a| a == "--classe") {
        Some(i) => args.iter().enumerate().filter(|(k, _)| *k != i && *k != i + 1).map(|(_, a)| a.clone()).collect(),
        None => args,
    };
    let (path, ids) = match args.iter().filter(|a| *a != "--champs").collect::<Vec<_>>().split_first() {
        Some((path, ids)) => ((*path).clone(), ids.iter().filter_map(|id| id.parse::<u64>().ok()).collect::<Vec<_>>()),
        None => {
            eprintln!("usage : graph <fichier.rvt> <ElementId>... [--champs]");
            std::process::exit(2);
        }
    };
    let mut file = rvt::RevitFile::open_bytes(std::fs::read(&path).expect("fichier illisible")).expect("fichier Revit");
    let mut todo: BTreeSet<u64> = ids.into_iter().collect();
    let mut done: BTreeSet<u64> = BTreeSet::new();
    while !todo.is_empty() {
        let batch = std::mem::take(&mut todo);
        let options = Options { channels: BTreeSet::from([103]), selected_ids: batch.clone(), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() };
        let mut symbols = BTreeSet::new();
        native_document::extract_graphs(&mut file, &options, |record| {
            let id = record.identity.element_id;
            println!("\n=== élément {id} ({} objets)", record.graph.as_ref().map_or(0, |g| g.objects.len()));
            if let Some(graph) = &record.graph {
                let mut seen = BTreeSet::new();
                walk(graph, 0, 0, all, &mut seen, &mut symbols);
                println!("({} objets atteints sur {})", seen.len(), graph.objects.len());
                if let Some(class) = &dump_class {
                    for (index, object) in graph.objects.iter().enumerate().filter(|(_, o)| &o.class_name == class) {
                        println!("--- [{index}] {class}");
                        if let Some(fields) = object.fields.as_object() {
                            for (name, value) in fields {
                                let resolved = if value.get("pointer_token").is_some() { format!(" -> {:?}", pointer(graph, index, value).ok().flatten()) } else { String::new() };
                                let resolved_list = value.as_array().filter(|a| a.first().is_some_and(|v| v.get("pointer_token").is_some())).map(|a| format!(" -> {:?}", a.iter().map(|v| pointer(graph, index, v).ok().flatten()).collect::<Vec<_>>())).unwrap_or_default();
                                println!("    {name} = {}{resolved}{resolved_list}", value.to_string().chars().take(60000).collect::<String>());
                            }
                        }
                    }
                }
            }
            Ok(())
        })
        .expect("lecture des graphiques");
        done.extend(batch);
        todo = symbols.into_iter().filter(|id| !done.contains(id)).collect();
    }
}
