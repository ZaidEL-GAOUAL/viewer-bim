//! Les incréments de stockage d'un fichier : quelle partition (`Partitions/N`) détient l'enregistrement
//! courant d'un élément, d'après sa date de dernière modification (`native_index::route_episode`).
//!
//! `Global/DocumentIncrementTable` porte deux tables de même forme : `m_increments` et
//! `m_localIncrements`. rvt-rs (`native_index::storage_increments`) exige qu'elles soient égales, ce qui
//! est vrai d'un modèle non partagé et d'un modèle central. Une copie locale d'un modèle partagé (celle
//! d'un utilisateur, ou celle du cache de BIM 360 / Autodesk Docs) les a différentes :
//! - `m_increments` est l'historique des incréments du **central** tel que la copie le connaît à sa
//!   dernière synchronisation (mêmes lignes, mêmes horodatages que la table du central) ;
//! - `m_localIncrements` décrit les incréments physiquement écrits dans **ce** fichier : la copie
//!   locale mesurée est réécrite d'un bloc, en un seul incrément, et n'a qu'une partition
//!   (`Partitions/0`).
//!
//! Mesuré sur `Project1.rvt` (central) et `Project1_LocalFile.rvt` (sa copie locale) de DynamoRevit :
//! le central a 3 incréments et 3 partitions, la copie 1 incrément local et 1 partition ; router la
//! copie par la table globale envoie 6 537 des 6 664 éléments vers `Partitions/1`, absente ; la table
//! locale les envoie tous vers `Partitions/0`, qui détient l'unique enregistrement de chacun, octet pour
//! octet celui que le central route (6 664 sur 6 664 en canaux 102 et 103).
//!
//! La table locale est donc celle qui fait foi pour lire le fichier tel qu'il a été enregistré : elle
//! seule décrit ses partitions. Pour un fichier dont les deux tables sont égales, rien ne change :
//! c'est la fonction de rvt-rs qui lit ([`Routing::Shared`]).
//!
//! Provenance : [`rows`] reprend les contrôles de `decode_increment_rows`, fonction privée de rvt-rs
//! (Apache-2.0, https://github.com/DrunkOnJava/rvt-rs, commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`) ;
//! à relire à chaque changement du commit épinglé (voir `revit/THIRD_PARTY.md`, § 5).

use anyhow::{Context as _, Result, ensure};
use rvt::research::native_index::{self, Increment};
use rvt::research::native_parameters::{self, GraphLimits};
use rvt::research::schema_registry::Registry;
use serde_json::Value;

/// Laquelle des deux tables route les enregistrements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Routing {
    /// Les deux tables sont égales (modèle non partagé, ou central) : la table de rvt-rs.
    Shared,
    /// Copie locale d'un modèle partagé : la table locale, seule à décrire les partitions du fichier.
    Local { global_rows: usize, local_rows: usize },
}

/// L'avertissement du rapport pour une copie locale : ce que l'utilisateur lit, et pourquoi ce n'est pas
/// forcément le central.
pub const LOCAL_COPY_WARNING: &str = "Copie locale d'un modèle partagé : le modèle est lu tel que cet utilisateur l'a enregistré (les synchronisations ultérieures des autres utilisateurs n'y figurent pas).";

impl Routing {
    /// Vrai pour une copie locale d'un modèle partagé (fichier ou cache de BIM 360).
    pub fn is_local(self) -> bool {
        matches!(self, Self::Local { .. })
    }
}

/// Les incréments de stockage qui routent les enregistrements de ce fichier. rvt-rs d'abord ; s'il refuse,
/// la table locale, seulement si le seul écart est le désaccord des deux tables (sinon : le refus de rvt-rs,
/// jamais un message de ce module).
pub fn storage_increments(bytes: &[u8], registry: &Registry) -> Result<(Vec<Increment>, Routing)> {
    let strict = match native_index::storage_increments(bytes, registry) {
        Ok(increments) => return Ok((increments, Routing::Shared)),
        Err(error) => error,
    };
    match decode_table(bytes, registry).and_then(|fields| select(&fields)) {
        Ok(Some(found)) => Ok(found),
        Ok(None) | Err(_) => Err(strict),
    }
}

/// Les champs de l'objet `DocumentIncrementTable`, décodés comme rvt-rs les décode (même budget, même
/// fin de flux).
fn decode_table(bytes: &[u8], registry: &Registry) -> Result<Value> {
    ensure!(bytes.len() >= 2, "classe de la table des incréments tronquée");
    let tag = u16::from_le_bytes([bytes[0], bytes[1]]);
    ensure!(registry.class(tag).is_some_and(|class| class.name == "DocumentIncrementTable"), "classe de la table des incréments inattendue");
    // La table grandit avec le document : une valeur par octet du flux au plus (le budget de rvt-rs).
    let defaults = GraphLimits::default();
    let limits = GraphLimits { max_values: defaults.max_values.max(bytes.len()), ..defaults };
    let root = native_parameters::decode_object_fields_with_limits(bytes, registry, 2, tag, &limits)?;
    ensure!(bytes.get(root.end..) == Some(&[0; 4][..]), "fin de la table des incréments inattendue");
    Ok(root.fields)
}

/// La table locale quand les deux tables diffèrent ; `None` quand elles sont égales (le refus de rvt-rs
/// vient alors d'ailleurs). Les compteurs de révision des flux, qui diffèrent d'une table à l'autre
/// sans rien router, ne comptent pas dans la comparaison. Refuse une permutation d'épisodes (rvt-rs ne
/// l'interprète que pour un seul incrément partagé) et une table locale vide.
pub fn select(fields: &Value) -> Result<Option<(Vec<Increment>, Routing)>> {
    let global = rows(&fields["m_increments"]).context("table globale des incréments")?;
    let local = rows(&fields["m_localIncrements"]).context("table locale des incréments")?;
    if global == local {
        return Ok(None);
    }
    ensure!(!local.is_empty(), "table locale des incréments vide");
    let permutation = fields["m_permutation"].as_array().context("permutation des incréments absente")?;
    ensure!(permutation.is_empty(), "permutation des incréments d'une copie locale non prise en charge");
    let routing = Routing::Local { global_rows: global.len(), local_rows: local.len() };
    Ok(Some((local, routing)))
}

/// `decode_increment_rows` de rvt-rs (privée), mêmes contrôles.
fn rows(value: &Value) -> Result<Vec<Increment>> {
    let mut result = Vec::new();
    let mut previous = -1;
    for row in value.as_array().context("lignes d'incréments absentes")? {
        let greatest_episode = row["m_greatest"]["m_id"].as_i64().context("épisode le plus récent absent")?;
        let total_episodes = row["m_totalEpisodes"].as_u64().context("nombre d'épisodes absent")?;
        let stored_elements = row["m_totalElements"].as_u64().context("nombre d'éléments absent")?;
        ensure!(
            greatest_episode >= previous && greatest_episode >= -1 && total_episodes >= u64::try_from(greatest_episode + 1)?,
            "plage d'épisodes d'un incrément invalide"
        );
        previous = greatest_episode;
        let mut redirects = Vec::new();
        for version in row["m_incrementVersions"].as_array().context("versions d'incrément absentes")? {
            redirects.push((
                version["m_causedByIncrementNumber"].as_i64().context("renvoi d'incrément absent")?,
                version["m_totalElements"].as_u64().context("nombre d'éléments d'un renvoi absent")?,
            ));
        }
        result.push(Increment { greatest_episode, total_episodes, stored_elements, redirects, episode_permutation: Vec::new() });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    fn row(greatest: i64, elements: u64, versions: &[(i64, u64)]) -> Value {
        json!({
            "m_greatest": {"m_id": greatest}, "m_totalEpisodes": greatest + 1, "m_totalElements": elements,
            "m_incrementVersions": versions.iter().map(|(cause, count)| json!({"m_causedByIncrementNumber": cause, "m_totalElements": count})).collect::<Vec<_>>(),
            // Les compteurs de révision des flux diffèrent entre les deux tables d'un central : ils ne routent rien.
            "m_basicFileInfoStreamRevision": 174,
        })
    }

    /// Les tables de `Project1_LocalFile.rvt` (DynamoRevit), telles que décodées.
    fn local_copy() -> Value {
        json!({
            "m_increments": [row(583, 43008, &[(-1, 43008)]), row(584, 6537, &[(-1, 6537)]), row(584, 0, &[(-1, 0)])],
            "m_localIncrements": [row(584, 43008, &[(-1, 43008)])],
            "m_permutation": [],
        })
    }

    /// Les tables de la copie du cache de BIM 360 : le central du nuage a compacté l'incrément 0 dans le 1.
    fn cloud_copy() -> Value {
        json!({
            "m_increments": [row(583, 0, &[(-1, 43008), (1, 0)]), row(584, 43008, &[(-1, 43008)])],
            "m_localIncrements": [row(584, 43008, &[(-1, 43008)])],
            "m_permutation": [],
        })
    }

    #[test]
    fn une_copie_locale_route_par_sa_table_locale() {
        let (increments, routing) = select(&local_copy()).unwrap().expect("tables différentes");
        assert_eq!(routing, Routing::Local { global_rows: 3, local_rows: 1 });
        assert!(routing.is_local());
        let present = BTreeSet::from([0]);
        for episode in [390, 582, 584] {
            assert_eq!(native_index::route_episode(episode, &increments, &present).unwrap(), 0);
        }
        // La table globale, elle, envoie l'épisode 584 vers une partition que la copie n'a pas.
        let global = rows(&local_copy()["m_increments"]).unwrap();
        assert!(native_index::route_episode(584, &global, &present).is_err());
    }

    #[test]
    fn la_copie_du_cache_de_bim_360_route_par_sa_table_locale() {
        let (increments, routing) = select(&cloud_copy()).unwrap().expect("tables différentes");
        assert_eq!(routing, Routing::Local { global_rows: 2, local_rows: 1 });
        let present = BTreeSet::from([0]);
        for episode in [0, 390, 584] {
            assert_eq!(native_index::route_episode(episode, &increments, &present).unwrap(), 0);
        }
        // Le central du nuage a rangé les éléments dans l'incrément 1 : la table globale ne trouve aucun élément ici.
        let global = rows(&cloud_copy()["m_increments"]).unwrap();
        assert!(native_index::route_episode(390, &global, &present).is_err());
    }

    #[test]
    fn des_tables_egales_restent_a_rvt_rs() {
        let mut central = local_copy();
        central["m_localIncrements"] = central["m_increments"].clone();
        central["m_localIncrements"][2]["m_basicFileInfoStreamRevision"] = json!(173);
        assert!(select(&central).unwrap().is_none());
        // Pareil pour un fichier non partagé : un seul incrément, deux tables égales.
        let single = json!({"m_increments": [row(584, 10, &[(-1, 10)])], "m_localIncrements": [row(584, 10, &[(-1, 10)])], "m_permutation": []});
        assert!(select(&single).unwrap().is_none());
    }

    #[test]
    fn refuse_une_permutation() {
        let mut permuted = local_copy();
        permuted["m_permutation"] = json!([{"first": {"m_id": 1}, "second": 2}]);
        assert!(select(&permuted).is_err());
        let mut absent = local_copy();
        absent.as_object_mut().unwrap().remove("m_permutation");
        assert!(select(&absent).is_err());
    }

    #[test]
    fn refuse_une_table_locale_vide_ou_invalide() {
        let mut empty = local_copy();
        empty["m_localIncrements"] = json!([]);
        assert!(select(&empty).is_err());
        let mut decreasing = local_copy();
        decreasing["m_localIncrements"] = json!([row(584, 1, &[(-1, 1)]), row(583, 1, &[(-1, 1)])]);
        assert!(select(&decreasing).is_err());
        let mut absent = local_copy();
        absent.as_object_mut().unwrap().remove("m_localIncrements");
        assert!(select(&absent).is_err());
        let mut mistyped = local_copy();
        mistyped["m_localIncrements"][0]["m_totalElements"] = json!("43008");
        assert!(select(&mistyped).is_err());
        // Une table globale invalide est refusée aussi : on ne devine pas laquelle croire.
        let mut global = local_copy();
        global["m_increments"] = json!({});
        assert!(select(&global).is_err());
    }
}
