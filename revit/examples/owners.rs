//! Mesure : à qui appartiennent, dans l'ElemTable, les enregistrements d'éléments d'un fichier d'avant 2015 ?
//!
//!   cargo run --release --example owners -- <fichier> [--classes Classe,Classe...] [--chains Classe] [--rule]
//!
//! Avant 2015, le projet écrit parmi ses enregistrements le contenu de chaque famille chargée (ses éléments, ses vues, ses
//! phases…). Pour chaque classe d'enregistrement, le tableau dit combien d'enregistrements ont pour propriétaire direct une `Family`
//! (sur place, celle du document, ou une définition chargée), combien en ont une plus haut dans la chaîne des propriétaires
//! (bornée à 16), et combien n'en ont aucune. `--classes` écrit en plus chaque enregistrement de ces classes avec sa chaîne ;
//! `--chains` regroupe les chaînes (suite de classes) d'une classe. `--rule` applique le prédicat commun (`native::FamilyRule`) à tous
//! les enregistrements, comme la lecture, et compte ce qu'il décide : propriétaire direct (`Definition`), par des intermédiaires
//! (`DefinitionChain`), ambigu (`Unread`), par classe, avec la plus longue chaîne jusqu'à une `Family`.

use std::collections::BTreeMap;

use revit::native::{self, FamilyOwner, FamilyRule, Options, families::Owners};

struct Row {
    class: String,
    owner: i64,
    /// `m_inPlace` d'une `Family`.
    in_place: Option<bool>,
    name: Option<String>,
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args.first().expect("usage : owners <fichier> [--classes A,B] [--chains A]");
    let value_of = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|i| args.get(i + 1)).map(|list| list.split(',').map(str::to_string).collect::<Vec<_>>());
    let listed = value_of("--classes").unwrap_or_default();
    let chained = value_of("--chains").unwrap_or_default();
    let mut file = rvt::RevitFile::open_bytes(std::fs::read(path)?)?;
    let year = native::format_year(&mut file).map(|(year, _)| year);
    let preamble = native::preamble(&mut file)?;
    let document = preamble.owner_family.clone();
    let is_family = native::is_family(&file);

    // Tous les enregistrements d'éléments (canal 102), décodés.
    let mut rows: BTreeMap<u64, Row> = BTreeMap::new();
    let options = Options { max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Options::default() };
    native::extract_graphs(&mut file, &options, |record| {
        let root = record.graph.as_ref().and_then(|graph| graph.objects.first()).map(|root| &root.fields);
        let class = record.class_name.clone().unwrap_or_default();
        let in_place = (class == "Family").then(|| root.and_then(|fields| fields.get("m_inPlace")).and_then(serde_json::Value::as_bool)).flatten();
        let name = root.and_then(|fields| fields.get("m_viewName").or_else(|| fields.get("m_name")).or_else(|| fields.get("m_text"))).and_then(|value| value.as_str().map(str::to_string));
        rows.insert(record.identity.element_id, Row { class, owner: record.identity.owning_element_id, in_place, name });
        Ok(())
    })?;

    println!("{path} : année {year:?}, {} enregistrements, famille de document {:?}, fichier de famille {is_family}", rows.len(), document);
    let families: Vec<_> = rows.iter().filter(|(_, row)| row.class == "Family").collect();
    let doc = document.as_ref().ok().copied().unwrap_or(-2);
    let kind = |id: i64, row: &Row| -> &'static str {
        if id == doc {
            "document"
        } else {
            match row.in_place {
                Some(true) => "sur place",
                Some(false) => "chargée",
                None => "illisible",
            }
        }
    };
    let mut by_kind: BTreeMap<&str, usize> = BTreeMap::new();
    for (id, row) in &families {
        *by_kind.entry(kind(**id as i64, row)).or_default() += 1;
    }
    println!("  Family : {} ({by_kind:?})", families.len());

    // Chaîne des propriétaires : (classes, première Family rencontrée à quelle profondeur et de quelle sorte).
    let walk = |id: u64| -> (Vec<String>, Option<(usize, &'static str)>) {
        let mut chain = Vec::new();
        let mut found = None;
        let mut owner = rows.get(&id).map_or(-1, |row| row.owner);
        for depth in 1..=16 {
            let Some(row) = u64::try_from(owner).ok().and_then(|owner| rows.get(&owner)) else {
                chain.push(if owner < 0 { "∅".to_string() } else { format!("?{owner}") });
                break;
            };
            chain.push(row.class.clone());
            if row.class == "Family" && found.is_none() {
                found = Some((depth, kind(owner, row)));
            }
            owner = row.owner;
        }
        (chain, found)
    };

    // Par classe : direct / profond / aucun.
    #[derive(Default)]
    struct Tally {
        total: usize,
        direct: BTreeMap<&'static str, usize>,
        deep: BTreeMap<&'static str, usize>,
        none: usize,
    }
    let mut tallies: BTreeMap<&str, Tally> = BTreeMap::new();
    let mut chains: BTreeMap<(String, String), usize> = BTreeMap::new();
    for (id, row) in &rows {
        let tally = tallies.entry(row.class.as_str()).or_default();
        tally.total += 1;
        let (chain, found) = walk(*id);
        match found {
            Some((1, kind)) => *tally.direct.entry(kind).or_default() += 1,
            Some((_, kind)) => *tally.deep.entry(kind).or_default() += 1,
            None => tally.none += 1,
        }
        if chained.contains(&row.class) {
            *chains.entry((row.class.clone(), chain.join(" > "))).or_default() += 1;
        }
        if listed.contains(&row.class) {
            let tail = found.map_or(String::new(), |(depth, kind)| format!(" [Family {kind} à {depth}]"));
            println!("    {:>8} {:<18} propriétaire {:>8} {:<40} chaîne {}{tail}", id, row.class, row.owner, row.name.clone().unwrap_or_default(), chain.join(" > "));
        }
    }
    println!("  {:<34} {:>6} {:>8}   direct (Family par sorte)   profond   sans Family", "classe", "total", "");
    for (class, tally) in &tallies {
        if tally.direct.is_empty() && tally.deep.is_empty() {
            continue;
        }
        println!("  {class:<34} {:>6}   direct {:?}   profond {:?}   sans {}", tally.total, tally.direct, tally.deep, tally.none);
    }
    let unreached: Vec<String> = tallies.iter().filter(|(_, tally)| tally.direct.is_empty() && tally.deep.is_empty()).map(|(class, tally)| format!("{class}:{}", tally.total)).collect();
    println!("  classes sans aucune Family au-dessus : {}", unreached.join(" "));
    for ((class, chain), n) in &chains {
        println!("  chaîne {class} : {chain} ×{n}");
    }
    if args.iter().any(|arg| arg == "--rule") {
        let owners = Owners::of(&mut file);
        let rule = FamilyRule::of(&mut file);
        println!("  règle : {rule:?}");
        let family = |id: u64| rows.get(&id).filter(|row| row.class == "Family").map(|row| row.in_place);
        let mut by_class: BTreeMap<&str, [usize; 4]> = BTreeMap::new();
        let mut longest = 0usize;
        let mut totals = [0usize; 4];
        for (id, row) in &rows {
            let kind = rule.owner(row.owner, family, |id| owners.get(id));
            let slot = match kind {
                FamilyOwner::Elsewhere => 0,
                FamilyOwner::Definition => 1,
                FamilyOwner::DefinitionChain => 2,
                FamilyOwner::Unread => 3,
            };
            totals[slot] += 1;
            by_class.entry(row.class.as_str()).or_default()[slot] += 1;
            if slot == 1 || slot == 2 {
                longest = longest.max(walk(*id).0.iter().position(|class| class == "Family").map_or(0, |at| at + 1));
            }
        }
        println!("  enregistrements : ailleurs {} | définition directe {} | par intermédiaires {} | ambigus {} ; plus longue chaîne jusqu'à la Family : {longest}", totals[0], totals[1], totals[2], totals[3]);
        for (class, counts) in &by_class {
            if counts[2] > 0 || counts[3] > 0 {
                println!("    {class:<34} direct {:>5} par intermédiaires {:>5} ambigus {:>5}", counts[1], counts[2], counts[3]);
            }
        }
    }
    Ok(())
}
