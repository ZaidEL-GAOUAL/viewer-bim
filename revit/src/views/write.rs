//! Les sections `phases` et `views` du JSON de métadonnées (voir `docs/contrat-metadonnees.md`, § « Phases » et
//! « Vues enregistrées »).

use super::camera::{Camera, SectionBox, camera, plan_camera, section_box, section_camera};
use super::{Digest, STATUS_NAMES, SectionKind, ViewRecord};
use crate::catalog;
use crate::catalog::units::FOOT;
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
    /// Les catégories des imports CAD dessinés : identifiant de l'élément `CategoryElem` (positif, tel que `m_categoryIds` d'une vue le liste)
    /// → libellé que la fiche de ces imports porte dans `category_property` (« MAN-GF.dwg »). Un identifiant positif qui n'y est pas est une
    /// sous-catégorie (un calque d'import, « A-Area »…) : elle masque une partie d'une forme, ce que le viewer ne sait pas faire.
    pub imports: &'a HashMap<i64, String>,
    /// Les clés des imports CAD dessinés (`ImportInstance`) : une vue qui masque les imports (`m_importsExcluded`) les masque tous.
    pub import_keys: &'a [&'a str],
}

/// La caméra d'une vue (`"camera":{…}`).
fn write_camera(out: &mut String, camera: &Camera) {
    out.push_str(",\"camera\":{\"position\":");
    vector(out, camera.position);
    out.push_str(",\"direction\":");
    vector(out, camera.direction);
    out.push_str(",\"up\":");
    vector(out, camera.up);
    out.push_str(if camera.perspective { ",\"projection\":\"perspective\"" } else { ",\"projection\":\"orthographic\"" });
    if let Some(fov) = camera.fov {
        out.push_str(",\"fov\":");
        number(out, (fov * 100.0).round() / 100.0);
    }
    if let Some([width, height]) = camera.size {
        out.push_str(",\"size\":[");
        number(out, width);
        out.push(',');
        number(out, height);
        out.push(']');
    }
    out.push('}');
}

/// La boîte de coupe d'une vue (`"sectionBox":{…}`).
fn write_section_box(out: &mut String, found: &SectionBox) {
    out.push_str(",\"sectionBox\":{\"min\":");
    vector(out, found.min);
    out.push_str(",\"max\":");
    vector(out, found.max);
    if found.rotation.abs() > 1e-9 {
        out.push_str(",\"rotation\":");
        number(out, (found.rotation * 1e6).round() / 1e6);
    }
    out.push('}');
}

/// Ce que cache une vue, 3D ou plan, et sa phase : les catégories masquées, les éléments masqués, la phase et son filtre.
///
/// - Une catégorie masquée d'identifiant négatif (`BuiltInCategory`) s'écrit sous son nom français, celui que porte la propriété de catégorie des éléments.
/// - Un identifiant positif qui est la catégorie d'un import CAD dessiné s'écrit sous le libellé que ses éléments portent (« MAN-GF.dwg »). Les autres
///   identifiants positifs sont des sous-catégories : ignorés.
/// - Une vue qui masque les imports (`m_importsExcluded`) masque toutes les clés des imports dessinés.
fn write_visibility(out: &mut String, view: &ViewRecord, digest: &Digest, elements: &Elements<'_>) {
    let hidden: BTreeSet<&str> = view
        .hidden_categories
        .iter()
        .filter_map(|id| if *id < 0 { catalog::category(*id).map(|category| category.label) } else { elements.imports.get(id).map(String::as_str) })
        .filter(|label| elements.categories.contains(*label))
        .collect();
    if !hidden.is_empty() {
        out.push_str(",\"hiddenCategories\":{\"property\":");
        push_str(out, elements.category_property);
        out.push_str(",\"values\":");
        strings(out, hidden);
        out.push('}');
    }
    let mut keys: Vec<&str> = view.hidden_elements.iter().filter_map(|id| elements.keys.get(id).copied()).collect();
    if view.imports_excluded {
        keys.extend_from_slice(elements.import_keys);
    }
    keys.sort_unstable();
    keys.dedup();
    if !keys.is_empty() {
        out.push_str(",\"hiddenElements\":");
        strings(out, keys);
    }
    if let Some(name) = view.phase.and_then(|id| digest.phase_name(id)) {
        out.push_str(",\"phase\":");
        push_str(out, name);
    }
    if let Some(filter) = view.phase_filter.and_then(|id| digest.filter(id)) {
        out.push_str(",\"phaseFilter\":");
        push_str(out, &filter.name);
    }
}

/// La section `views` : une entrée par vue 3D de Revit qu'on peut ouvrir, triées par nom (la vue par défaut `{3D}`
/// d'abord), puis une par plan d'étage (`"kind":"plan"`), triés par hauteur de coupe, puis par nom, puis par identifiant, puis les plans de plafond
/// (`"kind":"ceiling"`) dans le même ordre, puis les façades (`"kind":"elevation"`) et les coupes (`"kind":"section"`), par nom et identifiant.
/// `None` sans vue.
///
/// Un plan s'écrit avec sa caméra (parallèle, vers le bas), sa plage de vue en mètres (`range` : `top` est le plan de coupe, `bottom` la
/// profondeur de vue, absente quand elle est illimitée), la boîte de son recadrage s'il est actif (`sectionBox` : x et z du recadrage, y de
/// la plage ; sans profondeur, `-10000`), et ce qu'il cache. Un plan sans coupe finie, sans `Viewer`, dont la caméra ou le recadrage ne se lit pas,
/// ou dont la profondeur est au-dessus de la coupe, n'est pas écrit : rien n'est inventé.
///
/// Un plan de plafond s'écrit comme un plan, la caméra de son fichier comprise (vue de dessus), mais sa plage va vers le haut : `range.bottom` est sa
/// coupe, `range.top` sa profondeur de vue (absente quand elle est illimitée ; la boîte monte alors à `10000`).
///
/// Une coupe ou une façade s'écrit avec sa caméra (parallèle, face à son plan de coupe) et sa boîte (`sectionBox`, tournée autour de la verticale,
/// dont la face proche est le plan de coupe), voir `camera::section_camera`. Une coupe à décrochement, ou dont le cadre ne se lit pas, n'est pas écrite.
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
        write_camera(&mut out, &camera);
        if let Some(found) = clip.and_then(section_box) {
            write_section_box(&mut out, &found);
        }
        write_visibility(&mut out, view, digest, elements);
        out.push('}');
    }

    // Les plans d'étage, puis les plans de plafond : par hauteur de coupe (au millimètre, que l'écriture garde), puis par nom, puis par identifiant.
    let mut plans: Vec<_> = digest.plans().filter_map(|(plan, crop, type_name)| Some((plan, plan.range.cut_feet()?, crop, type_name))).collect();
    plans.sort_by_key(|(plan, cut, _, _)| (plan.ceiling, (cut * FOOT * 1000.0).round() as i64, plan.view.name.to_lowercase(), plan.view.id));
    for (plan, cut, crop, type_name) in plans {
        let Some((camera, section)) = plan_camera(&plan.view, crop, cut) else { continue };
        // Un plan d'étage montre de sa profondeur (en bas) à sa coupe ; un plan de plafond, de sa coupe à sa profondeur (en haut).
        let (bottom, top) = if plan.ceiling { (Some(cut * FOOT), plan.range.ceiling_depth_feet().map(|feet| feet * FOOT)) } else { (plan.range.depth_feet().map(|feet| feet * FOOT), Some(cut * FOOT)) };
        // Un plan de plafond dont le haut n'est pas au-dessus de sa coupe ne montre rien : Revit ramène à la coupe un haut réglé plus bas qu'elle.
        if let (Some(bottom), Some(top)) = (bottom, top)
            && (bottom > top || (plan.ceiling && top - bottom < 1e-6))
        {
            continue;
        }
        if count > 0 {
            out.push(',');
        }
        count += 1;
        out.push_str("{\"name\":");
        push_str(&mut out, &plan.view.name);
        out.push_str(if plan.ceiling { ",\"kind\":\"ceiling\"" } else { ",\"kind\":\"plan\"" });
        if let Some(name) = type_name {
            out.push_str(",\"type\":");
            push_str(&mut out, name);
        }
        write_camera(&mut out, &camera);
        out.push_str(",\"range\":{");
        let bounds: Vec<(&str, f64)> = [("bottom", bottom), ("top", top)].into_iter().filter_map(|(name, value)| Some((name, value?))).collect();
        for (i, (name, value)) in bounds.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            let _ = write!(out, "\"{name}\":");
            number(&mut out, *value);
        }
        out.push('}');
        if let Some(mut found) = section {
            // Le recadrage ne dit rien de la hauteur : c'est la plage du plan (sans limite, bien au-delà du modèle).
            found.min[1] = bottom.unwrap_or(-UNBOUNDED);
            found.max[1] = top.unwrap_or(UNBOUNDED);
            write_section_box(&mut out, &found);
        }
        write_visibility(&mut out, &plan.view, digest, elements);
        out.push('}');
    }

    // Les façades, puis les coupes : par nom, puis par identifiant.
    let mut sections: Vec<_> = digest.sections().filter_map(|(section, frame, type_name)| Some((section, section_camera(&section.view, frame, section.cut?)?, type_name))).collect();
    sections.sort_by_key(|(section, _, _)| (section.kind == SectionKind::Section, section.view.name.to_lowercase(), section.view.id));
    for (section, (camera, found), type_name) in sections {
        if count > 0 {
            out.push(',');
        }
        count += 1;
        out.push_str("{\"name\":");
        push_str(&mut out, &section.view.name);
        out.push_str(match section.kind {
            SectionKind::Section => ",\"kind\":\"section\"",
            SectionKind::Elevation => ",\"kind\":\"elevation\"",
        });
        if let Some(name) = type_name {
            out.push_str(",\"type\":");
            push_str(&mut out, name);
        }
        write_camera(&mut out, &camera);
        write_section_box(&mut out, &found);
        write_visibility(&mut out, &section.view, digest, elements);
        out.push('}');
    }
    out.push(']');
    (count > 0).then_some(out)
}

/// Une étendue sans limite d'une boîte de coupe, en mètres : le bas d'un plan sans profondeur de vue, le haut d'un plan de plafond sans
/// profondeur (le JSON n'écrit pas d'infini). La même que `camera::UNBOUNDED_FEET`, en pieds.
const UNBOUNDED: f64 = 1e4;
