//! Sonde : de quoi se compose l'ensemble dessiné, et d'où viennent les triangles confondus.
//! `cargo run --release --example dupes -- <fichier.rvt>`
//!
//! Ne dépend que de l'API de `revit::geometry::saved` : une passe sur les enregistrements d'éléments
//! pour les champs bruts (propriétaire, phases, options de conception, vue, famille…), puis le
//! maillage de l'ensemble dessiné par les règles de la première livraison, puis ce que retire chaque
//! règle de `classes::excluded_relation`.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use revit::catalog;
use revit::geometry::{classes, saved};
use revit::native as native_document;
use serde_json::Value;

type Key = [[i64; 3]; 3];

#[derive(Default, Clone, Debug)]
struct Raw {
    class: String,
    owner: i64,
    unplaced: i64,
    created: i64,
    demolished: i64,
    option: i64,
    view: i64,
    master: i64,
    family: i64,
    category: i64,
    is_2d: bool,
    nothing_visible: bool,
    dormant: bool,
    invisible: bool,
    super_instance: i64,
    group_instance: i64,
}

fn identifier(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    ["m_id", "m_id64"].iter().find_map(|k| value.get(*k)).and_then(identifier)
}

fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("fichier");
    let bytes = std::fs::read(&path)?;

    // Champs bruts de tous les enregistrements d'éléments.
    let mut raw: BTreeMap<u64, Raw> = BTreeMap::new();
    {
        let mut file = rvt::RevitFile::open_bytes(bytes.clone())?;
        let options = native_document::Options { channels: BTreeSet::from([102]), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() };
        native_document::extract_graphs(&mut file, &options, |r| {
            let f = r.graph.as_ref().map(|g| &g.objects[0].fields);
            let id = |k: &str| f.and_then(|f| f.get(k)).and_then(identifier).unwrap_or(-1);
            let flag = |k: &str| f.and_then(|f| f.get(k)).and_then(Value::as_bool).unwrap_or(false);
            raw.insert(
                r.identity.element_id,
                Raw {
                    class: r.class_name.clone().unwrap_or_default(),
                    owner: r.identity.owning_element_id,
                    unplaced: id("m_unplacedOwnerId"),
                    created: id("m_createdPhaseId"),
                    demolished: id("m_demolishedPhaseId"),
                    option: id("m_designOptionId"),
                    view: id("m_ownerDBViewId"),
                    master: id("m_masterSymbolId"),
                    family: id("m_familyId"),
                    category: id("m_categoryId"),
                    is_2d: flag("m_is2d"),
                    nothing_visible: flag("m_bHasNothingVisible"),
                    dormant: flag("m_instDormant"),
                    invisible: flag("m_invisible"),
                    super_instance: id("m_superInstanceId"),
                    group_instance: id("m_GInstanceId"),
                },
            );
            Ok(())
        })?;
    }

    // Catégorie : par la classe quand elle la détermine, sinon par la famille de l'instance.
    let category_of = |id: u64| -> Option<i64> {
        let element = raw.get(&id)?;
        if let Some(category) = catalog::class_category(&element.class) {
            return Some(category.id);
        }
        if element.category < -1 {
            return Some(element.category);
        }
        if element.master > 0 {
            let symbol = raw.get(&(element.master as u64))?;
            let family = raw.get(&(symbol.family as u64))?;
            return (family.category < -1).then_some(family.category);
        }
        None
    };
    let category_name = |category: Option<i64>| -> String {
        match category {
            None => "(sans catégorie)".to_string(),
            Some(id) => catalog::category(id).map_or_else(|| format!("{id}"), |c| format!("{} [{}]", c.label, c.kind)),
        }
    };

    // Maillage de l'ensemble dessiné aujourd'hui (règles de classes::excluded seules).
    let mut file = rvt::RevitFile::open_bytes(bytes)?;
    // Règles de la première livraison : classe, vue propriétaire, propriétaire de type.
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| {
        let owner_class = scene.owner_info(info).map(|owner| owner.class.as_str());
        classes::excluded_class(&info.class).is_none() && info.view == -1 && !owner_class.is_some_and(|c| c.ends_with("Type"))
    };
    let work = |scene: &saved::Scene, id: u64, graph: &rvt::research::native_parameters::ObjectGraph| {
        let shape = saved::shape(scene, id, graph);
        let q = |p: [f64; 3]| [(p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64, (p[2] * 1e4).round() as i64];
        let mut keys: Vec<Key> = Vec::with_capacity(shape.mesh.triangles());
        for group in &shape.mesh.groups {
            let base = group.vertex_start as usize;
            for t in shape.mesh.indices[group.index_start as usize..(group.index_start + group.index_count) as usize].chunks_exact(3) {
                let mut key = [q(shape.mesh.positions[base + t[0] as usize]), q(shape.mesh.positions[base + t[1] as usize]), q(shape.mesh.positions[base + t[2] as usize])];
                key.sort();
                keys.push(key);
            }
        }
        (keys, shape.sources)
    };
    let scan = saved::scan(&mut file, &wanted, 1, &work)?;

    // L'ensemble dessiné aujourd'hui : un élément avec des triangles, qui n'est pas un symbole placé
    // par d'autres ni déjà dans son propriétaire (règles de `geometry::build`).
    let referenced: BTreeSet<u64> = scan.results.values().flatten().flat_map(|(_, sources)| sources.iter().copied()).collect();
    let mut drawn: BTreeMap<u64, &Vec<Key>> = BTreeMap::new();
    for (id, result) in &scan.results {
        let Some((keys, sources)) = result else { continue };
        if keys.is_empty() || referenced.contains(id) {
            continue;
        }
        let owner = raw[id].owner;
        let inside = u64::try_from(owner).ok().and_then(|o| scan.results.get(&o)).and_then(|r| r.as_ref()).is_some_and(|(ok, os)| !ok.is_empty() && !sources.is_empty() && sources.is_subset(os));
        if !inside {
            drawn.insert(*id, keys);
        }
    }
    let triangles: usize = drawn.values().map(|k| k.len()).sum();
    println!("== {path}\nensemble dessiné par les règles de la première livraison : {} éléments, {triangles} triangles\n", drawn.len());

    // (a) par classe et par catégorie
    let mut by_class: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut by_category: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (id, keys) in &drawn {
        let e = by_class.entry(raw[id].class.clone()).or_default();
        e.0 += 1;
        e.1 += keys.len();
        let e = by_category.entry(category_name(category_of(*id))).or_default();
        e.0 += 1;
        e.1 += keys.len();
    }
    println!("-- par classe Revit (éléments, triangles)");
    for (c, (n, t)) in &by_class {
        println!("  {c:<24} {n:>6} {t:>8}");
    }
    println!("-- par catégorie (éléments, triangles)");
    let mut v: Vec<_> = by_category.iter().collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.1.0));
    for (c, (n, t)) in v {
        println!("  {c:<50} {n:>6} {t:>8}");
    }

    // (b) triangles confondus entre éléments
    let mut owners_of: HashMap<Key, Vec<u64>> = HashMap::new();
    for (id, keys) in &drawn {
        let mut seen: BTreeSet<&Key> = BTreeSet::new();
        for key in keys.iter() {
            if seen.insert(key) {
                owners_of.entry(*key).or_default().push(*id);
            }
        }
    }
    let mut pairs: BTreeMap<(u64, u64), usize> = BTreeMap::new();
    for ids in owners_of.values() {
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                *pairs.entry((*a, *b)).or_default() += 1;
            }
        }
    }
    let pair_triangles: usize = pairs.values().sum();
    println!("\n-- paires d'éléments dont des triangles coïncident : {} paires, {pair_triangles} triangles", pairs.len());

    // Les paires, selon qu'un côté ou les deux sont des éléments non placés (définitions de groupe).
    let (mut both, mut one, mut none) = ((0usize, 0usize), (0usize, 0usize), (0usize, 0usize));
    for ((a, b), n) in &pairs {
        let count = usize::from(raw[a].unplaced >= 0) + usize::from(raw[b].unplaced >= 0);
        let slot = match count { 2 => &mut both, 1 => &mut one, _ => &mut none };
        slot.0 += 1;
        slot.1 += n;
    }
    println!("   deux côtés non placés : {} paires, {} triangles ; un côté non placé, l'autre placé : {} paires, {} triangles ; les deux placés : {} paires, {} triangles", both.0, both.1, one.0, one.1, none.0, none.1);
    // Phase, option et vue des deux côtés d'une paire où l'un est non placé.
    let mut sides: BTreeMap<String, usize> = BTreeMap::new();
    for (a, b) in pairs.keys() {
        for id in [a, b] {
            let e = &raw[id];
            *sides.entry(format!("{}: phase créée={} démolie={} option={} vue={}", if e.unplaced >= 0 { "non placé" } else { "placé    " }, e.created, e.demolished, e.option, if e.view == -1 { "modèle" } else { "vue" })).or_default() += 1;
        }
    }
    println!("   côtés de paires (comptés par paire) :");
    for (k, n) in &sides {
        println!("     {n:>6} {k}");
    }

    let describe = |id: u64| -> String {
        let e = &raw[&id];
        let owner_class = u64::try_from(e.owner).ok().and_then(|o| raw.get(&o)).map_or("-".to_string(), |o| o.class.clone());
        format!("{}[{}] propriétaire={}{}", e.class, category_name(category_of(id)), owner_class, if e.unplaced >= 0 { " non-placé" } else { "" })
    };
    let mut kinds: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
    for ((a, b), n) in &pairs {
        let (da, db) = (describe(*a), describe(*b));
        let key = if da <= db { (da, db) } else { (db, da) };
        let e = kinds.entry(key).or_default();
        e.0 += 1;
        e.1 += n;
    }
    let mut v: Vec<_> = kinds.iter().collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.1.1));
    for ((a, b), (p, t)) in v.iter().take(18) {
        println!("  {p:>5} paires {t:>7} triangles : {a}  <->  {b}");
    }

    // (c) chaque règle candidate : éléments touchés, paires expliquées
    type Rule<'a> = (&'a str, Box<dyn Fn(u64) -> bool + 'a>);
    let group_type_chain = |id: u64| -> bool {
        let mut cur = raw[&id].owner;
        for _ in 0..10 {
            let Some(o) = u64::try_from(cur).ok().and_then(|o| raw.get(&o)) else { return false };
            if o.class == "ElementGroupType" {
                return true;
            }
            cur = o.owner;
        }
        false
    };
    let rules: Vec<Rule> = vec![
        ("non placé (m_unplacedOwnerId != -1)", Box::new(|id| raw[&id].unplaced >= 0)),
        ("chaîne de propriétaires atteint un ElementGroupType", Box::new(group_type_chain)),
        ("m_GInstanceId >= 0 (identifiant d'instance graphique : toutes les instances, ne distingue rien)", Box::new(|id| raw[&id].group_instance >= 0)),
        ("démoli (m_demolishedPhaseId != -1)", Box::new(|id| raw[&id].demolished >= 0)),
        ("option de conception réelle (m_designOptionId >= 0)", Box::new(|id| raw[&id].option >= 0)),
        ("instance imbriquée (m_superInstanceId != -1)", Box::new(|id| raw[&id].super_instance >= 0)),
        ("instance dormante ou invisible", Box::new(|id| raw[&id].dormant || raw[&id].invisible)),
        ("famille 2D seulement (m_is2d)", Box::new(|id| u64::try_from(raw[&id].master).ok().and_then(|m| raw.get(&m)).and_then(|s| raw.get(&(s.family as u64))).is_some_and(|f| f.is_2d))),
        ("symbole sans rien de visible (m_bHasNothingVisible)", Box::new(|id| u64::try_from(raw[&id].master).ok().and_then(|m| raw.get(&m)).is_some_and(|s| s.nothing_visible))),
        ("catégorie d'annotation, interne ou analytique", Box::new(|id| category_of(id).and_then(catalog::category).is_some_and(|c| matches!(c.kind, 'A' | 'I' | 'N')))),
        ("classe Part / Assembly / lien / import", Box::new(|id| { let c = &raw[&id].class; c.contains("Part") || c.contains("Assembly") || c.contains("Link") || c.contains("Import") || c.contains("DirectShape") })),
    ];
    println!("\n-- règles candidates (éléments dessinés touchés, triangles, paires dont un côté est touché, paires dont les deux)");
    for (name, rule) in &rules {
        let flagged: BTreeSet<u64> = drawn.keys().copied().filter(|id| rule(*id)).collect();
        let tri: usize = flagged.iter().map(|id| drawn[id].len()).sum();
        let one = pairs.keys().filter(|(a, b)| flagged.contains(a) || flagged.contains(b)).count();
        let both = pairs.keys().filter(|(a, b)| flagged.contains(a) && flagged.contains(b)).count();
        println!("  {:>6} éléments {tri:>8} triangles {one:>6} paires ({both} les deux côtés) : {name}", flagged.len());
    }

    // Ce que retire chaque règle de relation (la vraie, de `classes`), dans l'ordre, et ce qui reste.
    println!("\n-- règles de `classes::excluded_relation`, appliquées dans l'ordre à l'ensemble ci-dessus");
    let mut removed: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut kept: BTreeSet<u64> = BTreeSet::new();
    for (id, keys) in &drawn {
        let facts = scan.scene.facts(&scan.scene.infos[id]);
        match classes::excluded_relation(&facts) {
            Some(reason) => {
                let e = removed.entry(reason).or_default();
                e.0 += 1;
                e.1 += keys.len();
            }
            None => {
                kept.insert(*id);
            }
        }
    }
    for reason in classes::RELATION_REASONS {
        let (n, t) = removed.get(reason).copied().unwrap_or_default();
        println!("  {n:>6} éléments {t:>8} triangles retirés : {reason}");
    }
    let kept_triangles: usize = kept.iter().map(|id| drawn[id].len()).sum();
    println!("  => {} éléments, {kept_triangles} triangles restent", kept.len());
    let remaining: Vec<(&(u64, u64), &usize)> = pairs.iter().filter(|((a, b), _)| kept.contains(a) && kept.contains(b)).collect();
    let duplicates: Vec<_> = remaining.iter().filter(|((a, b), n)| {
        let smallest = drawn[a].len().min(drawn[b].len());
        smallest > 0 && **n as f64 >= 0.9 * smallest as f64
    }).collect();
    println!("  paires avec au moins un triangle commun : {} ({} triangles) ; dont doublons (>= 90 % du plus petit) : {} ({} triangles)", remaining.len(), remaining.iter().map(|(_, n)| **n).sum::<usize>(), duplicates.len(), duplicates.iter().map(|(_, n)| **n).sum::<usize>());
    for ((a, b), n) in duplicates.iter().take(6) {
        println!("  doublon : {a} {} <-> {b} {} ({n} triangles)", describe(*a), describe(*b));
    }
    let mut left_by_kind: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
    for ((a, b), n) in &remaining {
        let (da, db) = (describe(*a).split(" propriétaire").next().unwrap().to_string(), describe(*b).split(" propriétaire").next().unwrap().to_string());
        let key = if da <= db { (da, db) } else { (db, da) };
        let e = left_by_kind.entry(key).or_default();
        e.0 += 1;
        e.1 += **n;
    }
    for ((a, b), (p, t)) in &left_by_kind {
        println!("  contact : {p:>4} paires {t:>6} triangles : {a} <-> {b}");
    }

    // Composition de ce qui reste, et origine des éléments retirés par définition de groupe.
    let mut kept_class: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut kept_category: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for id in &kept {
        let e = kept_class.entry(raw[id].class.clone()).or_default();
        e.0 += 1;
        e.1 += drawn[id].len();
        let e = kept_category.entry(category_name(category_of(*id))).or_default();
        e.0 += 1;
        e.1 += drawn[id].len();
    }
    println!("-- ce qui reste, par classe puis par catégorie (éléments, triangles)");
    for (c, (n, t)) in &kept_class {
        println!("  {c:<24} {n:>6} {t:>8}");
    }
    let mut v: Vec<_> = kept_category.iter().collect();
    v.sort_by_key(|x| std::cmp::Reverse(x.1.0));
    for (c, (n, t)) in v {
        println!("  {c:<50} {n:>6} {t:>8}");
    }
    let root_type = |id: u64| -> Option<u64> {
        let mut cur = raw[&id].owner;
        let mut found = None;
        for _ in 0..10 {
            let Some(o) = u64::try_from(cur).ok().and_then(|o| raw.get(&o).map(|r| (o, r))) else { break };
            if o.1.class == "ElementGroupType" {
                found = Some(o.0);
            }
            cur = o.1.owner;
        }
        found
    };
    let mut by_type: BTreeMap<u64, (usize, usize, usize)> = BTreeMap::new();
    for (id, keys) in &drawn {
        if let Some(t) = root_type(*id) {
            let e = by_type.entry(t).or_default();
            e.0 += 1;
            e.1 += keys.len();
            // combien de ses triangles coïncident avec un élément placé
            let coincide = keys.iter().filter(|k| owners_of[*k].iter().any(|o| kept.contains(o))).count();
            e.2 += coincide;
        }
    }
    println!("-- éléments dessinés retirés, par type de groupe (éléments, triangles, dont triangles qui coïncident avec un élément placé)");
    for (t, (n, tri, co)) in &by_type {
        println!("  groupe {t}: {n:>6} {tri:>8} {co:>8}");
    }
    let unplaced_total: usize = by_type.values().map(|v| v.1).sum();
    let unplaced_coinciding: usize = by_type.values().map(|v| v.2).sum();
    println!("  total : {unplaced_total} triangles, dont {unplaced_coinciding} coïncident avec un élément placé");

    // Phases, options, vues des éléments dessinés
    let mut meta: BTreeMap<String, usize> = BTreeMap::new();
    for id in drawn.keys() {
        let e = &raw[id];
        *meta.entry(format!("phase créée={} démolie={} option={} vue={}", e.created, e.demolished, e.option, if e.view == -1 { "modèle" } else { "vue" })).or_default() += 1;
    }
    println!("\n-- phase / option / vue des éléments dessinés");
    for (k, n) in meta {
        println!("  {n:>6} {k}");
    }
    Ok(())
}
