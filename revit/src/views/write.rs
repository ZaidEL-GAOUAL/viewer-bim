//! Les sections `phases` et `views` du JSON de métadonnées (voir `docs/contrat-metadonnees.md`, § « Phases » et
//! « Vues enregistrées »).

use super::camera::{camera, section_box};
use super::{Digest, STATUS_NAMES};
use crate::catalog;
use crate::properties::json::{push_str, round_significant};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt::Write;

fn number(out: &mut String, x: f64) {
    // Un reste de calcul (1e-16 pour une composante qui devrait être nulle) et le zéro négatif s'écrivent « 0 » ;
    // neuf chiffres significatifs : le millimètre à 100 km.
    let x = if x.abs() < 1e-12 { 0.0 } else { round_significant(x, 9) };
    let _ = write!(out, "{x}");
}

fn vector(out: &mut String, v: [f64; 3]) {
    out.push('[');
    for (i, x) in v.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        number(out, *x);
    }
    out.push(']');
}

fn strings(out: &mut String, items: impl IntoIterator<Item = impl AsRef<str>>) {
    out.push('[');
    for (i, item) in items.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_str(out, item.as_ref());
    }
    out.push(']');
}

/// `#rrggbb`.
fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// La section `phases` : l'ordre des phases, les propriétés qui portent la phase de création et de démolition des
/// éléments, les filtres de phase et le remplacement graphique de chaque état. `None` sans phase (une famille).
pub fn phases_json(digest: &Digest, created: &str, demolished: &str) -> Option<String> {
    let phases = digest.ordered_phases();
    if phases.is_empty() {
        return None;
    }
    let mut out = String::from("{\"order\":");
    strings(&mut out, phases.iter().map(|(_, name)| *name));
    out.push_str(",\"created\":");
    push_str(&mut out, created);
    out.push_str(",\"demolished\":");
    push_str(&mut out, demolished);

    out.push_str(",\"filters\":[");
    for (i, (_, filter)) in digest.filters().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":");
        push_str(&mut out, &filter.name);
        if filter.default {
            out.push_str(",\"default\":true");
        }
        out.push_str(",\"statuses\":{");
        let mut first = true;
        // « Aucun » (0) n'est pas un état d'élément : les filtres de Revit n'en font rien.
        for (status, entry) in STATUS_NAMES.iter().zip(filter.presentation).skip(1) {
            let presentation = match entry {
                0 => "hidden",
                1 => "normal",
                2 => "overridden",
                _ => continue,
            };
            if !first {
                out.push(',');
            }
            first = false;
            let _ = write!(out, "\"{status}\":\"{presentation}\"");
        }
        out.push_str("}}");
    }
    out.push(']');

    // Les remplacements graphiques : ce que Revit montre d'un état « remplacé » dans une vue ombrée.
    let overrides: BTreeMap<&str, ([u8; 3], f64)> = (1..STATUS_NAMES.len()).filter_map(|status| digest.status_override(status).map(|found| (STATUS_NAMES[status], found))).collect();
    if !overrides.is_empty() {
        out.push_str(",\"overrides\":{");
        for (i, (status, (rgb, opacity))) in overrides.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let _ = write!(out, "\"{status}\":{{\"color\":\"{}\"", hex(*rgb));
            if *opacity < 0.999 {
                let _ = write!(out, ",\"opacity\":{}", (opacity * 100.0).round() / 100.0);
            }
            out.push('}');
        }
        out.push('}');
    }
    out.push('}');
    Some(out)
}

/// Ce que `views_json` sait des éléments du modèle.
pub struct Elements<'a> {
    /// Clé d'un élément dessiné, par identifiant Revit : les éléments masqués d'une vue ne sont repris que s'ils le sont.
    pub keys: &'a HashMap<i64, &'a str>,
    /// Les catégories (valeurs de `category_property`) que portent les éléments dessinés : une catégorie masquée qu'aucun
    /// élément ne porte n'apporte rien au contrat.
    pub categories: &'a BTreeSet<String>,
    /// Nom de la propriété qui porte la catégorie des éléments.
    pub category_property: &'a str,
}

/// La section `views` : une entrée par vue 3D de Revit qu'on peut ouvrir, triées par nom (la vue par défaut `{3D}`
/// d'abord). `None` sans vue.
pub fn views_json(digest: &Digest, elements: &Elements<'_>) -> Option<String> {
    let mut views: Vec<_> = digest.views().collect();
    views.sort_by_key(|(view, _, _)| (!view.name.starts_with('{'), view.name.to_lowercase(), view.id));
    let mut out = String::from("[");
    let mut count = 0;
    for (view, viewer, clip) in views {
        let Some(camera) = camera(view, viewer) else { continue };
        if count > 0 {
            out.push(',');
        }
        count += 1;
        out.push_str("{\"name\":");
        push_str(&mut out, &view.name);
        out.push_str(",\"camera\":{\"position\":");
        vector(&mut out, camera.position);
        out.push_str(",\"direction\":");
        vector(&mut out, camera.direction);
        out.push_str(",\"up\":");
        vector(&mut out, camera.up);
        out.push_str(if camera.perspective { ",\"projection\":\"perspective\"" } else { ",\"projection\":\"orthographic\"" });
        if let Some(fov) = camera.fov {
            out.push_str(",\"fov\":");
            number(&mut out, (fov * 100.0).round() / 100.0);
        }
        if let Some([width, height]) = camera.size {
            out.push_str(",\"size\":[");
            number(&mut out, width);
            out.push(',');
            number(&mut out, height);
            out.push(']');
        }
        out.push('}');
        if let Some(found) = clip.and_then(section_box) {
            out.push_str(",\"sectionBox\":{\"min\":");
            vector(&mut out, found.min);
            out.push_str(",\"max\":");
            vector(&mut out, found.max);
            if found.rotation.abs() > 1e-9 {
                out.push_str(",\"rotation\":");
                number(&mut out, (found.rotation * 1e6).round() / 1e6);
            }
            out.push('}');
        }
        // Catégories masquées : leur nom français, celui que porte la propriété de catégorie des éléments.
        let hidden: BTreeSet<&str> = view.hidden_categories.iter().filter_map(|id| catalog::category(*id)).map(|category| category.label).filter(|label| elements.categories.contains(*label)).collect();
        if !hidden.is_empty() {
            out.push_str(",\"hiddenCategories\":{\"property\":");
            push_str(&mut out, elements.category_property);
            out.push_str(",\"values\":");
            strings(&mut out, hidden);
            out.push('}');
        }
        let mut keys: Vec<&str> = view.hidden_elements.iter().filter_map(|id| elements.keys.get(id).copied()).collect();
        keys.sort_unstable();
        keys.dedup();
        if !keys.is_empty() {
            out.push_str(",\"hiddenElements\":");
            strings(&mut out, keys);
        }
        if let Some(name) = view.phase.and_then(|id| digest.phase_name(id)) {
            out.push_str(",\"phase\":");
            push_str(&mut out, name);
        }
        if let Some(filter) = view.phase_filter.and_then(|id| digest.filter(id)) {
            out.push_str(",\"phaseFilter\":");
            push_str(&mut out, &filter.name);
        }
        out.push('}');
    }
    out.push(']');
    (count > 0).then_some(out)
}
