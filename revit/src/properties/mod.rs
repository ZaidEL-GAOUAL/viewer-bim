//! Propriétés : le JSON de métadonnées du contrat `docs/contrat-metadonnees.md`, une fiche par
//! élément dessiné.
//!
//! Revit 2012 à 2027 : tout vient des enregistrements natifs du fichier (paramètres enregistrés,
//! type, niveau, phases, matériaux, famille), sans l'export IFC de rvt-rs, qui coûte l'essentiel d'une
//! lecture (voir `Context::export`). Ces enregistrements, la géométrie les décode déjà pour savoir quoi
//! dessiner : elle les laisse dans `Context::retained`, projetés pour les fiches, et ce module ne relit
//! le fichier que pour ce qui manque (voir `native`). Si la lecture native échoue sur un fichier d'avant
//! 2023, on prend ce que l'export IFC de rvt-rs reconstruit (noms, famille et type, niveau, matériaux,
//! jeux de propriétés), avec un avertissement qui dit pourquoi.
//!
//! Les clés des fiches sont celles de la géométrie (`geometry::identity_keys`) : le GlobalId IFC que
//! Revit donnerait à l'élément, à défaut `rvt-<ElementId>`. Elles arrivent toutes faites, avec l'origine
//! de la forme de chaque élément (propriété `Source de la géométrie`), et les libellés des fiches repartent
//! avec elles : ce sont les noms que le viewer affiche.

mod fiche;
mod geo;
pub(crate) mod json;
mod legacy;
mod native;

use crate::Context;
use crate::geometry::Stopwatch;
use fiche::Resolver;
use json::{Val, push_str};
use std::collections::BTreeMap;

pub use native::{Retained, definition_classes, is_support_class};

/// Tout ce que le module produit : le JSON de métadonnées (version 1, `readOnly`, `elements`, `georeference`) en
/// trois parts, pour qu'il puisse partir par morceaux avec la géométrie (`lib::read_streaming`) ou s'écrire d'un bloc
/// (`metadata`).
#[derive(Debug, Clone, Default)]
pub struct Properties {
    /// Le début du JSON, jusqu'à l'accolade qui ouvre `elements` (comprise).
    pub head: String,
    /// Un fragment `"clé":{…}` par élément, dans l'ordre de `ids`, sans virgule.
    pub elements: Vec<String>,
    /// La fin du JSON, après le dernier élément.
    pub tail: String,
    /// Le nom affiché de chaque élément, dans l'ordre de `ids` : le libellé de sa fiche, qui est aussi
    /// celui du JSON (le viewer le lit des deux côtés et ils doivent être identiques).
    pub labels: Vec<String>,
    /// Éléments dont la fiche n'a pas de « Classe IFC » (catégorie sans équivalent, ou sans catégorie) : pour le bilan.
    pub without_ifc_class: usize,
}

impl Properties {
    /// Le JSON entier : les trois parts, les fragments séparés par des virgules.
    pub fn metadata(&self) -> String {
        let mut out = String::with_capacity(self.head.len() + self.tail.len() + self.elements.iter().map(|fragment| fragment.len() + 1).sum::<usize>());
        out.push_str(&self.head);
        for (i, fragment) in self.elements.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(fragment);
        }
        out.push_str(&self.tail);
        out
    }
}

/// Les valeurs de `Source de la géométrie`, dans l'ordre des sources de la géométrie (0 à 3).
const SOURCE_NAMES: [&str; 4] = ["Forme Revit", "Forme Revit partielle", "Forme reconstruite", "Inconnue (boîte englobante)"];

/// Fabrique les propriétés des éléments `ids` (identifiants Revit, dans l'ordre de la géométrie).
///
/// `keys` sont leurs clés d'identité et `sources` l'origine de leur forme, tels que la géométrie les
/// rend : le module n'en calcule aucune, pour que les fiches et le maillage ne puissent pas diverger.
pub fn build(file: &mut rvt::RevitFile, context: &mut Context, ids: &[u64], keys: &[String], sources: &[u8]) -> anyhow::Result<Properties> {
    anyhow::ensure!(ids.len() == keys.len() && ids.len() == sources.len(), "les identifiants, les clés et les sources des éléments ne sont pas alignés");
    let native_release = context.release.is_some_and(|year| crate::native::SUPPORTED_RELEASES.contains(&year));
    // L'export IFC de rvt-rs ne sert que de recours : il coûte l'essentiel d'une lecture, et à partir de 2023 on ne
    // le calcule jamais ici (on s'en sert s'il l'a déjà été, par la géométrie).
    let ifc_fallback = !matches!(context.release, Some(2023..=2027)) || context.has_export();
    let mut fiches = Vec::new();
    let mut georeference = None;
    let mut sections = Sections::default();
    let mut native_done = false;
    if native_release {
        let step = Stopwatch::start();
        let result = native_fiches(file, context, ids, keys);
        // Tout ce que la lecture des éléments avait gardé a servi : on le libère avant la suite.
        context.retained.clear();
        match result {
            Ok((found, found_georeference, found_sections, project_seconds)) => {
                context.stage("propriétés : enregistrements", step.seconds() - project_seconds);
                context.stage("propriétés : fiches", project_seconds);
                fiches = found;
                georeference = found_georeference;
                sections = found_sections;
                native_done = true;
            }
            Err(error) => {
                context.warnings.push(format!(
                    "Les paramètres natifs de Revit n'ont pas pu être lus ({error:#}) : {}",
                    if ifc_fallback { "les propriétés viennent de la reconstruction IFC de rvt-rs (noms, famille, type, niveau, matériaux), sans les paramètres Revit." } else { "les éléments n'ont que leur identifiant." }
                ));
            }
        }
    }
    if !native_done {
        let step = Stopwatch::start();
        let guids: Vec<Option<&str>> = ids.iter().enumerate().map(|(i, id)| guid_of(keys, i, *id)).collect();
        match ifc_fallback.then(|| legacy::fiches(file, context, ids, &guids)) {
            Some(Ok(found)) => fiches = found,
            Some(Err(error)) => context.warnings.push(format!("L'export IFC de rvt-rs n'a pas pu servir aux propriétés ({error:#}) : les éléments n'ont que leur identifiant.")),
            None => {}
        }
        if fiches.is_empty() && !ids.is_empty() {
            fiches = ids.iter().enumerate().map(|(i, id)| fiche::Fiche::bare(*id as i64, guids[i])).collect();
        }
        context.stage("propriétés : fiches (export IFC)", step.seconds());
    }

    // L'origine de la forme, juste après les matériaux dans les propriétés de tête.
    for (fiche, source) in fiches.iter_mut().zip(sources) {
        let name = SOURCE_NAMES.get(usize::from(*source)).copied().unwrap_or(SOURCE_NAMES[3]);
        fiche.head.push((fiche::GEOMETRY_SOURCE, Val::Text(name.to_string())));
    }

    let step = Stopwatch::start();
    let (head, elements, tail) = write(keys, &fiches, georeference.as_ref(), &sections);
    context.stage("propriétés : JSON", step.seconds());
    let without_ifc_class = fiches.iter().filter(|fiche| !fiche.head.iter().any(|(name, _)| *name == fiche::IFC_CLASS)).count();
    let labels = fiches.into_iter().map(|fiche| fiche.label).collect();
    Ok(Properties { head, elements, tail, labels, without_ifc_class })
}

/// Le GlobalId IFC d'un élément, si sa clé en est un (à défaut, la clé est `rvt-<ElementId>`).
fn guid_of(keys: &[String], index: usize, id: u64) -> Option<&str> {
    let key = keys[index].as_str();
    (key != format!("rvt-{id}")).then_some(key)
}

/// Les fiches des éléments `ids` d'après les enregistrements natifs, l'emplacement du site, et la durée
/// des fiches elles-mêmes (le reste est la projection des enregistrements). Les enregistrements sont
/// ceux que la géométrie a gardés en lisant les éléments, ou, à défaut, ceux d'une passe sur le fichier.
fn native_fiches(file: &mut rvt::RevitFile, context: &mut Context, ids: &[u64], keys: &[String]) -> anyhow::Result<(Vec<fiche::Fiche>, Option<geo::Georeference>, Sections, f64)> {
    if !context.retained.is_filled() {
        context.retained.scan(file, ids)?;
    }
    let georeference = geo::read(&context.retained);
    let collected = native::collect(file, &mut context.retained, ids)?;
    // Les propriétaires d'ElemTable et la famille du document viennent du préambule, déjà lu et gardé : aucune lecture de plus.
    let owners = crate::native::families::Owners::of(file);
    let levels = levels_json(&collected, |id| owners.get(id));
    let document_family = crate::native::preamble(file).ok().and_then(|preamble| preamble.owner_family.as_ref().ok().copied());
    let step = Stopwatch::start();
    let resolver = Resolver::with_owners(&collected, move |id| owners.get(id), document_family);
    let fiches: Vec<fiche::Fiche> = ids.iter().enumerate().map(|(i, id)| resolver.fiche(*id as i64, guid_of(keys, i, *id))).collect();
    let imports = resolver.imports(ids);
    let mut sections = sections(context.retained.views(), ids, keys, &fiches, &imports);
    sections.levels = levels;
    // Les phases, filtres et vues que possède une famille dont on ne sait pas si elle est chargée restent dans les sections : on le dit.
    context.warnings.extend(crate::views::unread_warning(context.retained.views().unread()));
    Ok((fiches, georeference, sections, step.seconds()))
}

/// Les sections `phases` et `views` du contrat, écrites avec les noms des propriétés des fiches (le viewer ne connaît
/// aucun nom : il les lit dans le fichier).
fn sections(digest: &crate::views::Digest, ids: &[u64], keys: &[String], fiches: &[fiche::Fiche], imports: &(Vec<usize>, std::collections::HashMap<i64, String>)) -> Sections {
    let keys_by_id: std::collections::HashMap<i64, &str> = ids.iter().zip(keys).map(|(id, key)| (*id as i64, key.as_str())).collect();
    let import_keys: Vec<&str> = imports.0.iter().map(|index| keys[*index].as_str()).collect();
    let categories: std::collections::BTreeSet<String> = fiches.iter().filter_map(|fiche| fiche.head.iter().find(|(name, _)| *name == fiche::CATEGORY)).filter_map(|(_, value)| if let Val::Text(text) = value { Some(text.clone()) } else { None }).collect();
    Sections {
        phases: crate::views::phases_json(digest, fiche::PHASE_CREATED, fiche::PHASE_DEMOLISHED),
        views: crate::views::views_json(digest, &crate::views::Elements { keys: &keys_by_id, categories: &categories, category_property: fiche::CATEGORY, imports: &imports.1, import_keys: &import_keys }),
        levels: None,
    }
}

/// Les sections facultatives du document de métadonnées, déjà écrites en JSON.
#[derive(Debug, Default)]
struct Sections {
    phases: Option<String>,
    views: Option<String>,
    levels: Option<String>,
}

/// La section `levels` du contrat : les niveaux du projet, `{ name, elevation }`, l'altitude en mètres dans le repère du modèle (celui de la
/// géométrie et des plages de vue des plans, voir `native::level_elevation`), triés par altitude. `None` sans niveau (une famille).
///
/// - Seuls les niveaux du projet comptent : un `Level` sans propriétaire d'ElemTable (`owner_of` rend -1). Les autres sont des copies (ceux
///   que possède la définition d'un groupe, `ElementGroupType`) ou des pièces d'une famille (avant Revit 2015, chaque famille chargée écrit
///   ses niveaux parmi ceux du projet ; un `.rfa` a son « Ref. Level », possédé par sa propre famille).
/// - Deux niveaux à la même altitude (au millimètre) n'en font qu'un, nommé des deux noms (« A / B ») ; deux niveaux de même nom n'en font
///   qu'un, le plus bas. Les deux cas ne se voient dans aucun fichier d'essai une fois les copies écartées.
fn levels_json(collected: &native::Collected, owner_of: impl Fn(u64) -> Option<i64>) -> Option<String> {
    let mut found: Vec<(f64, i64, &str)> = collected
        .records
        .iter()
        .filter(|(id, raw)| raw.class == "Level" && u64::try_from(**id).ok().and_then(&owner_of) == Some(-1))
        .filter_map(|(id, raw)| Some((raw.elevation.filter(|z| z.is_finite())? * crate::catalog::units::FOOT, *id, raw.name.as_deref().filter(|name| !name.trim().is_empty())?)))
        .collect();
    found.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut levels: Vec<(f64, String)> = Vec::new();
    for (elevation, _, name) in found {
        if levels.iter().any(|(_, names)| names.split(" / ").any(|known| known == name)) {
            continue;
        }
        match levels.last_mut() {
            Some((last, names)) if (elevation - *last).abs() < 5e-4 => {
                names.push_str(" / ");
                names.push_str(name);
            }
            _ => levels.push((elevation, name.to_string())),
        }
    }
    if levels.is_empty() {
        return None;
    }
    let mut out = String::from("[");
    for (i, (elevation, name)) in levels.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":");
        push_str(&mut out, name);
        // Neuf chiffres significatifs, comme le géoréférencement ; un reste de calcul (−0, 1e-16) s'écrit 0.
        let elevation = if elevation.abs() < 1e-12 { 0.0 } else { json::round_significant(*elevation, 9) };
        out.push_str(&format!(",\"elevation\":{elevation}}}"));
    }
    out.push(']');
    Some(out)
}

/// Les paramètres intégrés (identifiants négatifs) que portent les éléments `ids` et leurs types, avec leur
/// nombre d'occurrences, leur sorte de valeur et un exemple : pour vérifier la couverture du catalogue
/// (`revit/examples/props.rs --ids`).
#[doc(hidden)]
pub fn used_builtin_parameters(file: &mut rvt::RevitFile, ids: &[u64]) -> anyhow::Result<BTreeMap<i64, (usize, String, String)>> {
    let collected = native::collect(file, &mut Retained::default(), ids)?;
    let resolver = Resolver::new(&collected);
    Ok(resolver.used_builtin_parameters(ids))
}

/// Les paramètres décimaux que portent les éléments `ids` et leurs types (ceux que les fiches écrivent), par
/// (identifiant, spec du fichier), avec leur nombre d'occurrences et ce que les fiches en font : converti en unité
/// SI, nombre sans dimension, ou grandeur inconnue laissée telle quelle (`revit/examples/props.rs`).
#[doc(hidden)]
pub fn double_parameters(file: &mut rvt::RevitFile, ids: &[u64]) -> anyhow::Result<BTreeMap<(i64, Option<String>), (usize, crate::catalog::units::Spec)>> {
    let collected = native::collect(file, &mut Retained::default(), ids)?;
    let resolver = Resolver::new(&collected);
    Ok(resolver.double_parameters(ids))
}

/// Écrit le document de métadonnées.
/// Le JSON de métadonnées en trois parts (voir `Properties`).
fn write(keys: &[String], fiches: &[fiche::Fiche], georeference: Option<&geo::Georeference>, sections: &Sections) -> (String, Vec<String>, String) {
    // Seule l'identité est verrouillée : le lien avec l'élément du fichier et l'origine de sa forme. Tout le reste se modifie
    // dans le viewer, et ses modifications vont dans un JSON à part (le fichier n'est jamais écrit).
    let read_only = [fiche::REVIT_ID, fiche::IFC_GUID, fiche::GEOMETRY_SOURCE];

    let mut fragments: Vec<String> = Vec::with_capacity(fiches.len());
    for (key, fiche) in keys.iter().zip(fiches) {
        let mut elements = String::with_capacity(600);
        push_str(&mut elements, key);
        elements.push_str(":{\"label\":");
        push_str(&mut elements, &fiche.label);
        elements.push_str(",\"properties\":{");
        let mut first = true;
        let mut comma = |out: &mut String| {
            if !first {
                out.push(',');
            }
            first = false;
        };
        for (name, value) in &fiche.head {
            comma(&mut elements);
            push_str(&mut elements, name);
            elements.push(':');
            value.write(&mut elements);
        }
        for (group, entries) in &fiche.groups {
            if entries.is_empty() {
                continue;
            }
            comma(&mut elements);
            push_str(&mut elements, group);
            elements.push_str(":{");
            for (j, (name, value)) in entries.iter().enumerate() {
                if j > 0 {
                    elements.push(',');
                }
                push_str(&mut elements, name);
                elements.push(':');
                value.write(&mut elements);
            }
            elements.push('}');
        }
        elements.push_str("}}");
        fragments.push(elements);
    }

    let mut out = String::with_capacity(1024);
    out.push_str("{\"version\":1,\"readOnly\":[");
    for (i, name) in read_only.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_str(&mut out, name);
    }
    out.push(']');
    if let Some(geo) = georeference {
        // Le nom du lieu n'est repris que s'il en est un (« Boston, MA »), non des coordonnées.
        let source = if geo.place.chars().any(char::is_alphabetic) { format!("Revit ({})", geo.place) } else { "Revit (emplacement du site)".to_string() };
        out.push_str(&format!(
            ",\"georeference\":{{\"latitude\":{},\"longitude\":{},\"elevation\":{},\"origin\":[{},{},{}],\"trueNorth\":[{},{}],\"source\":",
            json::round_significant(geo.latitude, 9),
            json::round_significant(geo.longitude, 9),
            json::round_significant(geo.elevation, 9),
            json::round_significant(geo.origin[0], 9),
            json::round_significant(geo.origin[1], 9),
            json::round_significant(geo.origin[2], 9),
            json::round_significant(geo.true_north[0], 9),
            json::round_significant(geo.true_north[1], 9),
        ));
        push_str(&mut out, &source);
        out.push('}');
    }
    if let Some(levels) = &sections.levels {
        out.push_str(",\"levels\":");
        out.push_str(levels);
    }
    if let Some(phases) = &sections.phases {
        out.push_str(",\"phases\":");
        out.push_str(phases);
    }
    if let Some(views) = &sections.views {
        out.push_str(",\"views\":");
        out.push_str(views);
    }
    out.push_str(",\"elements\":{");
    (out, fragments, "}}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_georeferencement_s_ecrit_a_neuf_chiffres_significatifs() {
        // Une altitude de 1523,456789123 m garde neuf chiffres significatifs (1523,45679), comme la latitude, la longitude et
        // l'origine ; six chiffres la rogneraient au centimètre (1523,46).
        let geo = geo::Georeference { latitude: 45.1234567891, longitude: 5.1234567891, elevation: 1523.456_789_123, origin: [652_345.678_912_3, 1.0, 2.0], true_north: [0.0, 1.0], place: "Grenoble".to_string() };
        let (head, _, _) = write(&[], &[], Some(&geo), &Sections::default());
        assert!(head.contains("\"elevation\":1523.45679,"), "{head}");
        assert!(head.contains("\"latitude\":45.1234568,"), "{head}");
        assert!(head.contains("\"origin\":[652345.679,"), "{head}");
    }

    #[test]
    fn les_niveaux_du_projet_s_ecrivent_tries_en_metres_sans_copies_ni_doublons() {
        let level = |name: &str, feet: Option<f64>| native::Raw { class: "Level".to_string(), name: Some(name.to_string()), elevation: feet, ..native::Raw::default() };
        let mut collected = native::Collected::default();
        collected.records.insert(311, level("RDC", Some(0.984_251_968_503_937)));
        collected.records.insert(694, level("R+1", Some(9.842_519_685_039_37)));
        collected.records.insert(355_523, level("Terrain", Some(0.0)));
        // La copie d'un niveau dans la définition d'un groupe (`ElementGroupType`), et le niveau d'une famille chargée : écartés.
        collected.records.insert(786_763, level("Toiture", Some(30.0)));
        collected.records.insert(147_295, level("Ground floor", Some(-3.0)));
        // Même altitude qu'un autre (au millimètre) : un seul niveau, des deux noms ; même nom qu'un plus bas : écarté.
        collected.records.insert(900, level("Dalle RDC", Some(0.984_251_968_503_937 + 1e-5)));
        collected.records.insert(901, level("R+1", Some(40.0)));
        // Sans altitude lisible, ou sans nom : écarté.
        collected.records.insert(902, level("Sans plan", None));
        collected.records.insert(903, level("  ", Some(50.0)));
        let owners = |id: u64| Some(match id {
            786_763 => 786_761,
            147_295 => 147_271,
            _ => -1,
        });
        let json: serde_json::Value = serde_json::from_str(&levels_json(&collected, owners).expect("niveaux")).expect("JSON");
        assert_eq!(json, serde_json::json!([{"name": "Terrain", "elevation": 0}, {"name": "RDC / Dalle RDC", "elevation": 0.3}, {"name": "R+1", "elevation": 3}]));
        // Aucun niveau du projet : pas de section.
        assert_eq!(levels_json(&native::Collected::default(), |_| Some(-1)), None);
    }
}
