//! Lecture des champs d'un graphe d'objets enregistré (valeurs JSON de rvt-rs) : points, réels,
//! identifiants et pointeurs.

use anyhow::{Context, Result, ensure};
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_saved_mesh::pointer;
use serde_json::Value;

use super::math::V3;

/// Un point de l'espace (trois réels finis).
pub fn point3(value: &Value) -> Result<V3> {
    let array = value.as_array().context("point : tableau attendu")?;
    ensure!(array.len() == 3, "point : trois coordonnées attendues");
    let mut out = [0.0; 3];
    for (slot, item) in out.iter_mut().zip(array) {
        *slot = item.as_f64().context("point : nombre attendu")?;
        ensure!(slot.is_finite(), "point : coordonnée non finie");
    }
    Ok(out)
}

/// Un point du plan (u, v).
pub fn point2(value: &Value) -> Result<[f64; 2]> {
    let array = value.as_array().context("point (u, v) : tableau attendu")?;
    ensure!(array.len() == 2, "point (u, v) : deux coordonnées attendues");
    let u = array[0].as_f64().context("point (u, v) : nombre attendu")?;
    let v = array[1].as_f64().context("point (u, v) : nombre attendu")?;
    ensure!(u.is_finite() && v.is_finite(), "point (u, v) : coordonnée non finie");
    Ok([u, v])
}

/// Un réel fini.
pub fn number(value: &Value, name: &str) -> Result<f64> {
    let x = value.as_f64().with_context(|| format!("{name} : nombre attendu"))?;
    ensure!(x.is_finite(), "{name} : valeur non finie");
    Ok(x)
}

/// Un intervalle `[début, fin]` de paramètres.
pub fn range(value: &Value, name: &str) -> Result<[f64; 2]> {
    let array = value.as_array().with_context(|| format!("{name} : tableau attendu"))?;
    ensure!(array.len() == 2, "{name} : deux bornes attendues");
    Ok([number(&array[0], name)?, number(&array[1], name)?])
}

/// Le pavé `[[umin, vmin], [umax, vmax]]` d'une enveloppe (`m_Envelope.m_corners`).
pub fn envelope(fields: &Value) -> Result<[[f64; 2]; 2]> {
    let corners = fields["m_Envelope"]["m_corners"].as_array().context("enveloppe absente")?;
    ensure!(corners.len() == 2, "enveloppe : deux coins attendus");
    Ok([point2(&corners[0])?, point2(&corners[1])?])
}

/// Un identifiant Revit sérialisé : un entier ou `{m_id: {m_id64: n}}`.
pub fn identifier(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    ["m_id", "m_id64"].iter().find_map(|key| value.get(*key)).and_then(identifier)
}

/// La cible d'un pointeur du graphe : `Ok(None)` pour un pointeur nul.
pub fn target(graph: &ObjectGraph, source: usize, value: &Value) -> Result<Option<usize>> {
    pointer(graph, source, value)
}

/// La cible d'un pointeur qui ne peut pas être nul.
pub fn required(graph: &ObjectGraph, source: usize, value: &Value, what: &str) -> Result<usize> {
    target(graph, source, value)?.with_context(|| format!("{what} : pointeur nul"))
}
