//! Extraction des enregistrements du canal 102 (éléments) et du canal 103 (graphiques enregistrés)
//! pour tous les fichiers Revit de 2012 à 2027.
//!
//! Provenance : portage, sur l'API publique de rvt-rs, de `native_document::extract_records`,
//! `native_document::group_records` et `native_es_catalog::decode` (rvt-rs, Apache-2.0,
//! https://github.com/DrunkOnJava/rvt-rs, commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`). rvt-rs réserve
//! ces fonctions à Revit 2023–2027 tant que l'encadrement des enregistrements n'est pas mesuré pour les
//! autres années : politique « fermé par défaut » que ce portage conserve (voir ci-dessous). À relire
//! à chaque changement du commit épinglé. Attribution : `revit/THIRD_PARTY.md`, §5.
//!
//! Ce portage est le seul chemin de lecture, pour toutes les années : `tests/native_records.rs` vérifie qu'il
//! rend, sur les fichiers de 2023 et plus, les mêmes enregistrements, les mêmes graphes et le même bilan que
//! rvt-rs (la référence), et sur ceux de 2012 à 2022 les taux de décodage mesurés.
//!
//! Écarts avec l'original, tous voulus :
//! - la largeur de l'identifiant et la règle de la taille déclarée dépendent de l'année (voir
//!   [`group_records`]) et sont vérifiées sur les octets, groupe par groupe ;
//! - l'arithmétique des positions passe par `u64` et des comparaisons avec la longueur du groupe, jamais
//!   par une addition sur `usize` (32 bits en WebAssembly, sans contrôle de débordement en release) ;
//! - seuls les groupes des canaux demandés sont encadrés (rvt-rs encadre aussi les autres) ;
//! - avant 2023, chaque graphe passe par [`normalize_legacy`] ;
//! - l'année du fichier est celle de [`format_year`] : l'étiquette « Autodesk Revit AAAA » de `BasicFileInfo` ([`release`]),
//!   non le `version` de rvt-rs, qui se trompe sur les fichiers d'avant 2015 et qui refuse le `BasicFileInfo` de
//!   plusieurs builds de 2012 et de 2013 (l'étiquette est alors lue dans le flux brut) ; à défaut d'étiquette (Project
//!   Vasari), l'empreinte du schéma, quand c'est exactement l'un des trois schémas mesurés de 2012 à 2014
//!   ([`super::schema::SCHEMA_YEARS`]) ;
//! - le préambule des fichiers de 2012 à 2014 : rvt-rs refuse le schéma de 2012 et de 2013 (le compte opaque par classe
//!   n'y existe pas, voir [`super::schema`]) et l'index des éléments d'avant 2015 (le jeton de `m_pSource` vaut 2, voir
//!   [`super::elemtable`]) ; rvt-rs lit d'abord, les portages ne servent que s'il refuse et que l'année est d'avant 2015 ;
//! - les enregistrements émis n'ont ni `saved_metadata` ni `effective_ifc_parameter` (aucun appelant ne
//!   s'en sert, et leur calcul coûte) ni `body_sha256` ; `Summary::global_streams`,
//!   `projected_metadata_records` et `unsupported_metadata_records` restent vides ;
//! - le catalogue de stockage extensible (`es_catalog`) est lu avec `rvt::research::native_es_catalog`
//!   d'abord, puis, s'il refuse, avec `lenient_es_catalog` : Revit 2016 à 2020 écrivent des champs
//!   d'entité sans `m_specTypeId`, que rvt-rs exige, et les enregistrements qui portent une entité
//!   (une partie des `FamilyInstance`) restent alors illisibles ;
//! - les incréments de stockage passent par [`super::increments`] : rvt-rs d'abord ; pour une copie locale
//!   d'un modèle partagé (workshared local, BIM 360), dont les deux tables de `DocumentIncrementTable`
//!   diffèrent et que rvt-rs refuse, la table locale, qui décrit les partitions du fichier ;
//! - le préambule (schéma, index des éléments, incréments, catalogue de stockage extensible) est lu une
//!   fois par fichier et gardé (voir [`preamble`]) : rvt-rs le garde dans `RevitFile`, dont le champ n'est
//!   pas public ;
//! - le préambule porte aussi la famille du document (`ADocument.m_ownerFamilyId`, [`document_owner_family`]), lue à la racine du
//!   même flux `Global/Latest` : avant 2015, elle distingue les éléments de la famille éditée de ceux des familles chargées dans le
//!   projet (`geometry::classes::RELATION_REASONS`).

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::hash::Hasher;
use std::ops::RangeInclusive;
use std::rc::Rc;

use anyhow::{Context as _, Result, bail, ensure};
use serde_json::{Value, json};
use rvt::RevitFile;
use rvt::research::native_document::{self, Options, Record, RecordSource, ResourceBudget, Summary};
use rvt::research::native_es_catalog;
use rvt::research::native_extensible_storage::{Catalog, Field, Schema, guid_string};
use rvt::research::native_index::{self, Increment, ProjectIndex};
use rvt::research::native_metadata;
use rvt::research::native_parameters::{self, GraphLimits, ObjectGraph};
use rvt::research::native_segments::GroupSource;
use rvt::research::schema_registry::Registry;

use super::increments::{self, Routing};

/// Les années de Revit que cette extraction lit : 2012 à 2027. Avant 2012, le format des enregistrements n'est pas
/// mesuré (la famille de 2008 de la recherche a une autre disposition des partitions) ; après 2027, rvt-rs lui-même refuse.
pub const SUPPORTED_RELEASES: RangeInclusive<u32> = 2012..=2027;

/// Les années d'avant 2023, où rvt-rs refuse de lire les enregistrements, et dont les graphes demandent
/// [`normalize_legacy`] (il est appliqué à chacun, voir `extract_ported`).
pub const LEGACY_RELEASES: RangeInclusive<u32> = 2012..=2022;

/// Plafond de lecture d'un flux d'un fichier (celui de rvt-rs).
const STREAM_LIMIT: u64 = 512 * 1024 * 1024;

/// Octets d'enregistrement au plus par valeur décodée : un enregistrement plus long que `max_graph_values` fois ce
/// nombre ne peut pas tenir dans le budget de valeurs de rvt-rs, qui le refuserait après l'avoir décodé en entier
/// (le `DirectShapeType` de 15,6 Mo de Core Interior coûte 305 Mo à décoder avant d'être refusé). Une valeur occupe au
/// plus 8 octets (un réel double, un entier long) ; seules les chaînes font exception (une valeur pour deux octets par
/// caractère), et un enregistrement de géométrie n'est pas fait de chaînes : sur les 32 fichiers d'essai, le plus long
/// enregistrement accepté fait 2,8 Mo pour 886 000 valeurs (3,2 octets par valeur), et `tests/native_records.rs`
/// vérifie, contre rvt-rs, qu'aucun enregistrement écarté ainsi n'aurait été décodé.
pub const OVERSIZE_BYTES_PER_VALUE: usize = 8;

/// Octets d'enregistrement au plus qu'on tente de décoder, quel que soit le budget de valeurs demandé : un
/// enregistrement plus long est refusé d'emblée, sans être décodé. C'est la borne que le budget d'un million de valeurs
/// imposait déjà (1 000 000 × [`OVERSIZE_BYTES_PER_VALUE`]) : elle ne bouge pas quand le budget des graphiques passe à 3 millions
/// (`geometry::saved::GEOMETRY_GRAPH_LIMIT`), parce que la mémoire d'un décodage suit les octets, pas le budget : un graphe
/// décodé pèse 60 à 140 fois son enregistrement. Sans elle, le `DirectShapeType` de 16,5 Mo de `2024_Core_Interior`
/// (refusé à 1 million comme à 4 millions de valeurs, mais après les avoir presque toutes décodées) ferait passer le
/// pic de ce fichier de 274 à 1 356 Mo (mesuré avec un budget de 4 millions) sans rien changer à sa sortie.
pub const MAX_RECORD_BYTES: usize = 1_000_000 * OVERSIZE_BYTES_PER_VALUE;

/// Les octets au plus qu'un enregistrement peut avoir pour être décodé avec ce budget de valeurs : ce que le budget
/// ne saurait contenir ([`OVERSIZE_BYTES_PER_VALUE`] octets par valeur), et jamais plus de [`MAX_RECORD_BYTES`].
pub fn oversize_limit(max_graph_values: usize) -> usize {
    max_graph_values.saturating_mul(OVERSIZE_BYTES_PER_VALUE).min(MAX_RECORD_BYTES)
}

/// Les flux dont le préambule se déduit entièrement.
const PREAMBLE_STREAMS: [&str; 5] = ["Formats/Latest", "Global/History", "Global/ElemTable", "Global/DocumentIncrementTable", "Global/Latest"];

// ---------------------------------------------------------------------------------------------
// Encadrement des enregistrements d'un groupe
// ---------------------------------------------------------------------------------------------

/// Largeur en octets de l'identifiant d'élément qui ouvre un enregistrement : 4 jusqu'à Revit 2023, 8
/// à partir de 2024.
pub fn id_width(version: u32) -> usize {
    if version >= 2024 { 8 } else { 4 }
}

/// Ce que la marque de segment déclare comme « octets de corps » d'un groupe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeclaredSize {
    /// La somme des longueurs de corps (Revit 2018 et après, mesuré de 2018 à 2026).
    Body,
    /// La somme des longueurs de corps plus 4 octets par enregistrement : la longueur répétée en fin
    /// d'enregistrement est comptée (Revit 2015, 2016 et 2017, mesuré).
    BodyAndTrailer,
}

impl DeclaredSize {
    /// La règle mesurée pour une année.
    fn expected(version: u32) -> Self {
        if version <= 2017 { Self::BodyAndTrailer } else { Self::Body }
    }

    /// Ordre dans lequel les règles sont essayées pour une année : la mesurée d'abord.
    fn order(version: u32) -> [Self; 2] {
        match Self::expected(version) {
            Self::BodyAndTrailer => [Self::BodyAndTrailer, Self::Body],
            Self::Body => [Self::Body, Self::BodyAndTrailer],
        }
    }
}

/// Un enregistrement d'un groupe, comme le quadruplet de rvt-rs : `offset` est l'octet du début de
/// l'enregistrement, `start..end` son corps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    pub id: u64,
    pub offset: usize,
    pub start: usize,
    pub end: usize,
}

/// Les enregistrements d'un groupe et l'encadrement qui les a fait lire.
#[derive(Debug, Clone)]
pub struct Grouping {
    pub frames: Vec<Frame>,
    /// Largeur de l'identifiant retenue (4 ou 8).
    pub id_bytes: usize,
    /// Règle de taille déclarée qui a convenu.
    pub rule: DeclaredSize,
    /// Vrai si la largeur ou la règle diffère de ce qu'on attend de l'année du fichier.
    pub unexpected: bool,
}

/// Lit un `u32` petit-boutiste à `at`, sans panique ni débordement.
fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    let end = at.checked_add(4).context("position d'enregistrement démesurée")?;
    let raw: [u8; 4] = bytes.get(at..end).context("enregistrement tronqué")?.try_into()?;
    Ok(u32::from_le_bytes(raw))
}

fn u64_at(bytes: &[u8], at: usize) -> Result<u64> {
    let end = at.checked_add(8).context("position d'enregistrement démesurée")?;
    let raw: [u8; 8] = bytes.get(at..end).context("enregistrement tronqué")?.try_into()?;
    Ok(u64::from_le_bytes(raw))
}

/// Découpe `bytes` en enregistrements d'identifiant de `id_bytes` octets : l'identifiant, l'en-tête
/// (4 octets de plus en canaux 102 et 103, dont la longueur du corps en dernier), le corps, sa longueur
/// répétée. Rend les enregistrements et la somme des longueurs de corps. Toute la comptabilité des
/// positions est en `u64`, comparée à la longueur du groupe avant d'être ramenée à `usize`.
fn split_group(bytes: &[u8], id_bytes: usize, channel: u64, max_records: u64) -> Result<(Vec<Frame>, u64)> {
    let header: u64 = match channel {
        101 => id_bytes as u64 + 4,
        102 | 103 => id_bytes as u64 + 8,
        _ => bail!("canal d'enregistrements non pris en charge : {channel}"),
    };
    let total = bytes.len() as u64;
    let mut frames = Vec::new();
    let mut body_sum = 0u64;
    let mut pos = 0u64;
    while pos < total {
        ensure!(total - pos >= header + 4, "en-tête d'enregistrement tronqué à l'octet {pos} (reste {} sur {})", total - pos, header + 4);
        // `pos < total` : l'octet existe, la conversion est sans perte.
        let at = pos as usize;
        let id = if id_bytes == 4 { u64::from(u32_at(bytes, at)?) } else { u64_at(bytes, at)? };
        let length = u64::from(u32_at(bytes, at + (header as usize) - 4)?);
        let start = pos + header;
        let end = start + length;
        ensure!(end + 4 <= total, "corps d'enregistrement tronqué à l'octet {pos} : longueur déclarée {length}, reste {}", total - start);
        let repeated = u64::from(u32_at(bytes, end as usize)?);
        ensure!(repeated == length, "longueurs d'enregistrement discordantes à l'octet {pos} : {length} puis {repeated}");
        ensure!((frames.len() as u64) < max_records, "plus d'enregistrements que les {max_records} déclarés (octet {pos})");
        frames.push(Frame { id, offset: at, start: start as usize, end: end as usize });
        body_sum += length;
        pos = end + 4;
    }
    Ok((frames, body_sum))
}

/// Les enregistrements d'un groupe de segments, `(id, début, début du corps, fin du corps)` : un
/// identifiant, un en-tête, le corps et sa longueur répétée. Le nombre d'objets et la taille de corps
/// que les marques de segment déclarent doivent s'accorder avec ce qui est lu.
///
/// Ce que Revit écrit change avec l'année, et rien n'est supposé sans être vérifié sur les octets :
/// - l'identifiant fait 4 octets jusqu'à Revit 2023, 8 à partir de 2024 ([`id_width`]) ; l'autre
///   largeur n'est essayée que si la première ne donne pas un groupe cohérent ;
/// - la taille déclarée est la somme des longueurs de corps, plus 4 par enregistrement jusqu'à Revit
///   2017 ([`DeclaredSize`]) ; l'autre règle n'est essayée, elle aussi, que si la première ne convient pas.
///
/// Un groupe est accepté quand chaque enregistrement a ses deux longueurs égales, que leur nombre est
/// celui que le groupe déclare et que la taille déclarée suit l'une des règles. Sinon : erreur, qui dit
/// ce qui a été essayé. Un écart avec l'attendu de l'année est signalé par `unexpected`.
pub fn group_records(source: &GroupSource, bytes: &[u8], version: u32) -> Result<Grouping> {
    let expected_width = id_width(version);
    let widths = [expected_width, 12 - expected_width];
    let mut errors = Vec::new();
    for id_bytes in widths {
        match split_group(bytes, id_bytes, source.channel, source.declared_objects) {
            Err(error) => errors.push(format!("identifiant de {id_bytes} octets : {error:#}")),
            Ok((frames, body_sum)) => {
                let count = frames.len() as u64;
                if count != source.declared_objects {
                    errors.push(format!("identifiant de {id_bytes} octets : {count} enregistrements lus, {} déclarés", source.declared_objects));
                    continue;
                }
                let fits = |rule: DeclaredSize| match rule {
                    DeclaredSize::Body => body_sum == source.declared_body_bytes,
                    DeclaredSize::BodyAndTrailer => count.checked_mul(4).and_then(|trailers| body_sum.checked_add(trailers)) == Some(source.declared_body_bytes),
                };
                if let Some(rule) = DeclaredSize::order(version).into_iter().find(|rule| fits(*rule)) {
                    let unexpected = id_bytes != expected_width || DeclaredSize::expected(version) != rule;
                    return Ok(Grouping { frames, id_bytes, rule, unexpected });
                }
                errors.push(format!(
                    "identifiant de {id_bytes} octets : somme des corps {body_sum} sur {count} enregistrements, {} octets déclarés (ni la somme, ni la somme plus 4 par enregistrement)",
                    source.declared_body_bytes
                ));
            }
        }
    }
    bail!("encadrement des enregistrements du canal {} non reconnu pour Revit {version} : {}", source.channel, errors.join(" ; "))
}

// ---------------------------------------------------------------------------------------------
// Préambule du fichier
// ---------------------------------------------------------------------------------------------

/// Ce que toute extraction lit avant les partitions : le schéma, l'index des éléments, les incréments
/// de stockage (et la table qui les a donnés, voir [`increments`]) et le catalogue de stockage extensible
/// (celui-ci peut manquer : le message dit pourquoi).
pub struct Preamble {
    pub registry: Registry,
    pub index: ProjectIndex,
    pub increments: Vec<Increment>,
    /// [`Routing::Shared`] pour un modèle non partagé ou un central, [`Routing::Local`] pour une copie
    /// locale d'un modèle partagé.
    pub routing: Routing,
    pub es_catalog: std::result::Result<(Catalog, serde_json::Value), String>,
    /// `ADocument.m_ownerFamilyId`, la famille que le document est (`-1` dans un projet) : ce qui distingue, avant 2015, les
    /// éléments de la famille que ce fichier édite de ceux des familles chargées dans le projet (voir
    /// [`document_owner_family`]). Le message dit pourquoi la racine ne se lit pas.
    pub owner_family: std::result::Result<i64, String>,
    /// L'année de lecture du fichier et d'où elle vient (voir [`format_year`]), lue une fois avec le schéma : pour un fichier sans
    /// étiquette (Project Vasari), la retrouver demande d'inflater `Formats/Latest` et d'en calculer l'empreinte, ce que chaque
    /// appel de `format_year` (un par extraction) refaisait.
    pub format_year: Option<(u32, YearOrigin)>,
}

/// Lit le préambule d'un fichier (voir [`preamble`] pour la version gardée en mémoire).
pub fn read_preamble(file: &mut RevitFile) -> Result<Preamble> {
    // L'année décide des seules lectures de secours d'avant 2015 : le schéma est lu d'abord, car son empreinte date un
    // fichier sans étiquette (voir [`format_year`]).
    let schema = native_document::read_single(file, "Formats/Latest")?;
    let labelled = release(file);
    let format = labelled.map(|year| (year, YearOrigin::Label)).or_else(|| super::schema::year_of(&schema).map(|year| (year, YearOrigin::Schema)));
    let year = format.map(|(year, _)| year);
    let registry = super::schema::parse(&schema, year)?;
    let episodes = native_index::creation_episodes(&native_document::read_single(file, "Global/History")?, &registry)?;
    let index = super::elemtable::parse(&native_document::read_single(file, "Global/ElemTable")?, &registry, &episodes, year)?;
    let (increments, routing) = increments::storage_increments(&native_document::read_single(file, "Global/DocumentIncrementTable")?, &registry)?;
    // Le flux global n'est lu qu'une fois : le catalogue de stockage extensible et la famille du document en sortent.
    let global = native_document::read_single(file, "Global/Latest");
    let owner_family = match &global {
        Ok(bytes) => document_owner_family(bytes, &registry).map_err(|error| format!("{error:#}")),
        Err(error) => Err(format!("{error:#}")),
    };
    let es_catalog = global
        .and_then(|bytes| native_es_catalog::decode(&bytes, &registry).or_else(|strict| lenient_es_catalog(&bytes, &registry).map_err(|_| strict)))
        .map_err(|error| format!("{error:#}"));
    Ok(Preamble { registry, index, increments, routing, es_catalog, owner_family, format_year: format })
}

/// `ADocument.m_ownerFamilyId` : l'identifiant de la famille que le document est, `-1` dans un projet (`.rvt`) et l'identifiant de
/// l'enregistrement `Family` du document dans une famille (`.rfa`), lu à la racine de `Global/Latest`, celle que lit aussi le
/// catalogue de stockage extensible. Seuls les champs propres de la racine sont décodés (aucun pointeur n'est suivi, aucun objet
/// possédé) : quelques dizaines de valeurs, sur tous les fichiers d'essai (`tests/pre2015.rs` : `-1` dans tous les projets).
///
/// Avant 2015, Revit écrit dans le projet les éléments qui définissent chaque famille chargée, possédés par l'enregistrement
/// `Family` de cette famille ; ceux de la famille que le document édite le sont par la famille du document, qu'il ne faut pas
/// prendre pour une définition chargée (`geometry::classes::RELATION_REASONS`).
pub fn document_owner_family(bytes: &[u8], registry: &Registry) -> Result<i64> {
    ensure!(bytes.len() >= 6, "flux global trop court pour porter la racine du document ({} octets)", bytes.len());
    // Le pied fixe de 4 octets nuls n'est pas du graphe (voir `lenient_es_catalog`).
    let end = bytes.len() - 4;
    let tag = u16::from_le_bytes([bytes[0], bytes[1]]);
    let root = native_parameters::decode_object_fields_with_limits(&bytes[..end], registry, 2, tag, &GraphLimits { max_values: 2_000_000, ..Default::default() })?;
    ensure!(root.class_name == "ADocument", "la racine du flux global est « {} », non ADocument", root.class_name);
    let field = root.fields.get("m_ownerFamilyId").context("ADocument n'a pas de champ m_ownerFamilyId")?;
    identifier(field)
}

/// Empreinte des flux dont se déduit le préambule : deux hachages indépendants de leurs octets
/// stockés et leur taille. Le préambule est une fonction de ces flux seuls ; deux fichiers qui les ont
/// identiques ont le même préambule.
pub(crate) fn fingerprint(file: &mut RevitFile) -> (u64, u64, usize) {
    let mut sip = std::hash::DefaultHasher::new();
    let mut fnv = 0xcbf2_9ce4_8422_2325_u64;
    let mut total = 0usize;
    for name in PREAMBLE_STREAMS {
        sip.write(name.as_bytes());
        match file.read_stream_with_limit(name, STREAM_LIMIT) {
            Ok(bytes) => {
                total = total.wrapping_add(bytes.len());
                sip.write_usize(bytes.len());
                sip.write(&bytes);
                for byte in &bytes {
                    fnv = (fnv ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
                }
            }
            Err(_) => sip.write_u8(0),
        }
    }
    (sip.finish(), fnv, total)
}

type Cached = ((u64, u64, usize), Rc<Preamble>);

thread_local! {
    static CACHE: RefCell<Option<Cached>> = const { RefCell::new(None) };
}

/// Le préambule du fichier, lu une seule fois : les appels suivants sur le même fichier (une extraction
/// par passe de lecture) reprennent celui qui est gardé. Un seul préambule est gardé par fil ; un autre
/// fichier le remplace. Voir [`clear_preamble_cache`] pour libérer la mémoire en fin de lecture.
pub fn preamble(file: &mut RevitFile) -> Result<Rc<Preamble>> {
    let key = fingerprint(file);
    if let Some(hit) = CACHE.with(|cache| cache.borrow().as_ref().filter(|(cached, _)| *cached == key).map(|(_, preamble)| Rc::clone(preamble))) {
        return Ok(hit);
    }
    let fresh = Rc::new(read_preamble(file)?);
    CACHE.with(|cache| *cache.borrow_mut() = Some((key, Rc::clone(&fresh))));
    Ok(fresh)
}

/// Oublie le préambule gardé (schéma de plusieurs milliers de classes, index de tous les éléments) et l'index des
/// groupes (`super::index`).
pub fn clear_preamble_cache() {
    CACHE.with(|cache| *cache.borrow_mut() = None);
    super::index::clear_index();
}

/// Le catalogue de stockage extensible d'un fichier ancien : `native_es_catalog::decode` de rvt-rs, dont
/// la seule différence est que `m_specTypeId` d'un champ est facultatif (Revit 2016 à 2020 n'écrivent
/// que le nom et le type du champ, pas l'identifiant de spécification des unités) : un champ sans lui
/// a `spec_type_id` à `None`, comme un champ dont l'identifiant est vide. Mesuré sur les fichiers de
/// 2016, 2019 et 2020 de `revit/samples.json` : toutes les entités se décodent alors.
/// Le JSON de provenance ne porte pas d'empreinte (pas de SHA-256 dans cette caisse).
fn lenient_es_catalog(bytes: &[u8], registry: &Registry) -> Result<(Catalog, Value)> {
    ensure!((6..=32 * 1024 * 1024).contains(&bytes.len()), "taille du flux global du catalogue de stockage extensible non qualifiée");
    let end = bytes.len() - 4;
    ensure!(bytes[end..] == [0; 4], "le pied fixe du flux global n'est pas la valeur nulle qualifiée");
    let graph = native_parameters::decode_graph_with_limits(&bytes[..end], registry, &GraphLimits { max_values: 2_000_000, ..Default::default() })?;
    let root = graph.objects.first().context("graphe global vide")?;
    ensure!(root.class_name == "ADocument", "le catalogue de stockage extensible demande une racine ADocument");
    let manager = es_owned(&graph, 0, &root.fields["m_pAppInfoManager"])?;
    ensure!(graph.objects[manager].class_name == "AppInfoManager", "classe du gestionnaire de stockage extensible inattendue");
    let pointers = graph.objects[manager].fields["m_appInfoArr"].as_array().context("tableau d'informations d'application absent")?;
    let mut storages = Vec::new();
    for pointer in pointers {
        if pointer["pointer_token"].as_u64() == Some(0) {
            continue;
        }
        let index = es_owned(&graph, manager, pointer)?;
        if graph.objects[index].class_name == "ESSchemaStorage" {
            storages.push(index);
        }
    }
    ensure!(storages.len() == 1, "stockage des schémas absent ou ambigu");
    let storage = &graph.objects[storages[0]];
    let (old, current) = (storage.fields.get("m_storedSchemas"), storage.fields.get("m_schemaUsageMap"));
    ensure!(old.is_some() ^ current.is_some(), "disposition du stockage des schémas absente ou ambiguë");
    let usage_map = current.is_some();
    let rows = old.or(current).and_then(Value::as_array).context("entrées de schéma absentes")?;
    let mut catalog = Catalog::default();
    for row in rows {
        let schema = if usage_map { &row["second"]["m_schema"] } else { &row["second"] };
        let guid = es_guid(&row["first"])?;
        ensure!(guid == es_guid(&schema["m_guid"])?, "la clé et le GUID du schéma diffèrent");
        let mut fields = Vec::new();
        for field in schema["m_fields"].as_array().context("champs du schéma absents")? {
            let sub = es_guid(&field["m_subSchemaGUID"])?;
            let spec = field["m_specTypeId"]["m_typeId"].as_str().unwrap_or_default().to_owned();
            fields.push(Field {
                index: u32::try_from(field["m_entryIndex"].as_u64().context("index de champ invalide")?)?,
                name: es_string(field, "m_fieldName")?,
                type_name: es_string(field, "m_fieldTypeName")?,
                container_type: i32::try_from(field["m_containerType"].as_i64().context("type de conteneur invalide")?)?,
                subschema_guid: (sub != "00000000-0000-0000-0000-000000000000").then_some(sub),
                spec_type_id: (!spec.is_empty()).then_some(spec),
                raw_metadata: field.clone(),
            });
        }
        let mut raw_metadata = schema.clone();
        if usage_map {
            raw_metadata["_storage_usage"] = row["second"].clone();
        }
        catalog.insert(Schema { guid, name: es_string(schema, "m_schemaName")?, fields, raw_metadata })?;
    }
    let source = json!({ "stream": "Global/Latest", "stream_bytes": bytes.len(), "graph_bytes": end, "root_class": "ADocument", "storage_object_index": storages[0], "scope": "m_specTypeId facultatif (Revit 2016 à 2020)" });
    Ok((catalog, source))
}

fn es_string(value: &Value, key: &str) -> Result<String> {
    value[key].as_str().map(str::to_owned).with_context(|| format!("texte {key} absent du schéma de stockage extensible"))
}

fn es_guid(value: &Value) -> Result<String> {
    let value = if value.get("guid_bytes").is_some() { value } else { &value["m_guid"] };
    let bytes = value["guid_bytes"].as_array().context("octets du GUID absents")?;
    ensure!(bytes.len() == 16, "largeur de GUID inattendue");
    let mut raw = [0u8; 16];
    for (target, source) in raw.iter_mut().zip(bytes) {
        *target = u8::try_from(source.as_u64().context("octet de GUID invalide")?)?;
    }
    Ok(guid_string(raw))
}

/// L'objet que le pointeur de `owner` à l'octet `pointer["offset"]` possède, quand il n'y en a qu'un.
fn es_owned(graph: &ObjectGraph, owner: usize, pointer: &Value) -> Result<usize> {
    let offset = pointer["offset"].as_u64().context("pointeur de propriété absent")?;
    let mut edges = graph.edges.iter().filter(|edge| edge.source_object_index == owner && edge.pointer_offset as u64 == offset);
    let edge = edges.next().context("pointeur de propriété non résolu")?;
    ensure!(edges.next().is_none(), "pointeur de propriété ambigu");
    ensure!(edge.target_object_index < graph.objects.len(), "cible hors du graphe");
    Ok(edge.target_object_index)
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

/// Ce que l'extraction a constaté de l'encadrement des groupes lus (passe d'émission).
#[derive(Debug, Clone, Default)]
pub struct Framing {
    /// Groupes encadrés, par largeur d'identifiant retenue.
    pub groups_by_id_width: BTreeMap<usize, usize>,
    /// Groupes encadrés, par règle de taille déclarée retenue.
    pub groups_by_rule: BTreeMap<DeclaredSize, usize>,
    /// Enregistrements encadrés.
    pub records: usize,
    /// Groupes dont l'encadrement diffère de l'attendu de l'année (voir [`Grouping::unexpected`]) :
    /// 0 sur tous les fichiers mesurés.
    pub unexpected_groups: usize,
    /// Groupes écartés parce que leur canal n'est pas demandé, par canal.
    pub skipped_channels: BTreeMap<u64, usize>,
}

/// L'année de Revit qui a enregistré le fichier d'après son étiquette, ou `None` si elle ne se lit pas.
///
/// `BasicFileInfo.version` de rvt-rs est le premier nombre à quatre chiffres de 2014 à 2030 que contient
/// le texte : dans un fichier de Revit 2013 (« Autodesk Revit Architecture 2013 (Build: 20120221_2030(x64)) »)
/// il tombe sur « 2022 » à l'intérieur de la date de version. Quand le texte porte l'étiquette
/// « Autodesk Revit [Architecture|MEP|Structure] AAAA (Build: … », c'est donc elle qui fait foi.
///
/// Quand rvt-rs refuse le `BasicFileInfo` (aucun nombre de 2014 à 2030 : Revit 2012, et Revit 2013 des builds 20120828 et
/// 20120928, mesurés) ou que le texte n'a pas l'étiquette, l'étiquette est cherchée dans le flux brut ([`raw_label_year`]).
/// Un fichier sans étiquette « Autodesk Revit » (Project Vasari) n'a pas d'année ici : voir [`format_year`]. Sans étiquette,
/// et quand rvt-rs date le texte (Revit 2019 et après), c'est l'année de rvt-rs qui est rendue, comme avant.
pub fn release(file: &mut RevitFile) -> Option<u32> {
    let info = file.basic_file_info().ok();
    let labelled = info.as_ref().and_then(|info| info.properties.iter().find(|property| property.key == "Revit Build")).and_then(|property| labelled_year(&property.value));
    if let Some(year) = labelled.or_else(|| raw_label_year(file)) {
        return Some(year);
    }
    info.map(|info| info.version).filter(|year| *year > 0)
}

/// Plafond de lecture du flux `BasicFileInfo` brut : il fait de 500 octets à 3 Ko.
const RAW_INFO_LIMIT: u64 = 1 << 20;

/// Caractères, après « Autodesk Revit », où l'on cherche « (Build: » : l'étiquette en fait 64 au plus (`raw_label_year_of`), la
/// plus longue mesurée (« Autodesk Revit Architecture 2013 ») 32.
const LABEL_WINDOW: usize = 80;

/// L'année de l'étiquette « Autodesk Revit … AAAA (Build: » cherchée dans le flux brut `BasicFileInfo` ([`raw_label_year_of`]).
pub fn raw_label_year(file: &mut RevitFile) -> Option<u32> {
    raw_label_year_of(&file.read_stream_with_limit("BasicFileInfo", RAW_INFO_LIMIT).ok()?)
}

/// L'année de l'étiquette dans les octets d'un flux `BasicFileInfo`, décodés en UTF-16LE aux deux alignements d'octets, comme
/// rvt-rs le fait pour ses propriétés (mesuré : l'étiquette de Revit 2012 n'est lisible qu'à l'alignement pair, celle de
/// certains Revit 2013 aux deux). L'étiquette est le texte
/// qui va de « Autodesk Revit » à « (Build: » : « Autodesk Revit Architecture 2012 », « Autodesk Revit 2013 - Preview ». Un
/// chemin d'accès qui contient « Autodesk Revit 2020\… » (mesuré dans une copie locale BIM 360) n'est pas une étiquette ; un
/// libellé qui n'est pas un nom de produit suivi d'une année (« Autodesk Project Vasari ») non plus. `None` si rien ne
/// convient, sans rien deviner.
fn raw_label_year_of(raw: &[u8]) -> Option<u32> {
    for shift in 0..2 {
        let units: Vec<u16> = raw.get(shift..)?.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let text = String::from_utf16_lossy(&units);
        for (at, _) in text.match_indices("Autodesk Revit") {
            // L'étiquette fait 64 caractères au plus et « (Build: » la suit de près : la recherche s'arrête à 80 caractères après
            // « Autodesk Revit ». Sans cette borne, chaque occurrence cherchait jusqu'à la fin du texte (un flux peut faire
            // 1 Mio), et `release` s'exécute à chaque extraction de chaque fichier.
            let tail = &text[at..];
            let window = tail.char_indices().nth(LABEL_WINDOW).map_or(tail, |(end, _)| &tail[..end]);
            let Some(until) = window.find(" (Build: ") else { continue };
            let label = &tail[..until];
            if label.chars().count() <= 64 && label.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '-') {
                if let Some(year) = labelled_year(label) {
                    return Some(year);
                }
            }
        }
    }
    None
}

/// Dernière année de compilation d'un Revit dont les fichiers sont d'avant Revit 2012 : Revit 2012 est compilé en 2011 (build
/// 20110309 mesuré), le plus ancien Revit que ce lecteur lit. Un build de 2010 ou avant est donc celui d'un Revit antérieur.
pub const LAST_OLD_BUILD_YEAR: u32 = 2010;

/// Le build d'un fichier sans étiquette de version ni schéma connu, quand il date d'avant Revit 2012 : `(année, date « AAAAMMJJ »)`.
/// C'est ce qui distingue une famille de 2007 (« 20070829_2300 », mesuré sur `tbc-exhaust-fan-build2007.rfa`, qui n'a ni
/// « Autodesk Revit » ni schéma de la table) d'un fichier d'une autre origine, qui garde le comportement d'avant. `None` si le flux
/// ne porte aucun build, ou un build de 2011 ou après (Project Vasari : 2012).
pub fn old_build(file: &mut RevitFile) -> Option<(u32, String)> {
    let raw = file.read_stream_with_limit("BasicFileInfo", RAW_INFO_LIMIT).ok()?;
    build_stamp_of(&raw).filter(|(year, _)| *year <= LAST_OLD_BUILD_YEAR)
}

/// Pourquoi un fichier dont le build date d'avant Revit 2012 (`old_build`) n'est pas lu : le texte de [`unsupported`] pour
/// une année antérieure, avec l'année de compilation du build à la place de l'année de version, que ce fichier ne dit pas.
pub fn unsupported_build(year: u32, date: &str) -> String {
    let first = SUPPORTED_RELEASES.start();
    format!("Revit antérieur à {first} : ce fichier a été enregistré par une version de Revit compilée en {year} (build {date}), dont les enregistrements ne se lisent pas ici (la lecture commence à Revit {first}). Ouvrez-le dans Revit {first} ou plus récent et enregistrez-le de nouveau.")
}

/// Le build écrit dans les octets d'un flux `BasicFileInfo` (décodés en UTF-16LE aux deux alignements, comme
/// [`raw_label_year_of`]) : `(année, « AAAAMMJJ »)`. Deux formes, mesurées : « (Build: AAAAMMJJ_HHMM) » à la suite d'un nom de produit,
/// et le « AAAAMMJJ_HHMM » seul des Revit de 2007 (« Revit Build: 20070829_2300 »). Huit chiffres qu'aucun chiffre ne précède, un mois
/// de 01 à 12, un jour de 01 à 31 ; rien n'est deviné d'un texte qui n'a pas cette forme.
fn build_stamp_of(raw: &[u8]) -> Option<(u32, String)> {
    for shift in 0..2 {
        let units: Vec<u16> = raw.get(shift..)?.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let text = String::from_utf16_lossy(&units);
        let bytes = text.as_bytes();
        for at in 0..bytes.len().saturating_sub(7) {
            let date = &bytes[at..at + 8];
            if !date.iter().all(u8::is_ascii_digit) || (at > 0 && bytes[at - 1].is_ascii_digit()) {
                continue;
            }
            // « _HHMM » derrière la date, ou « (Build: » devant elle.
            let time = bytes.get(at + 8) == Some(&b'_') && bytes.get(at + 9..at + 13).is_some_and(|hours| hours.iter().all(u8::is_ascii_digit));
            let labelled = text[..at].ends_with("(Build: ");
            let number = |range: std::ops::Range<usize>| std::str::from_utf8(&date[range]).ok().and_then(|digits| digits.parse::<u32>().ok());
            let (Some(year), Some(month), Some(day)) = (number(0..4), number(4..6), number(6..8)) else { continue };
            if (time || labelled) && (1990..=2040).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day) {
                return Some((year, String::from_utf8_lossy(date).into_owned()));
            }
        }
    }
    None
}

/// Où l'année de lecture d'un fichier a été trouvée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YearOrigin {
    /// `BasicFileInfo` ([`release`]) : l'étiquette « Autodesk Revit AAAA », ou, pour Revit 2019 et après qui n'en ont pas, l'année
    /// que rvt-rs y lit.
    Label,
    /// Pas d'étiquette (Project Vasari) : l'empreinte des octets de `Formats/Latest` est exactement l'un des trois schémas
    /// mesurés de 2012, 2013 et 2014 ([`super::schema::SCHEMA_YEARS`]). Le fichier se lit avec les règles de cette année,
    /// mais l'année de Revit qui l'a enregistré est inconnue.
    Schema,
}

/// L'année dont les règles lisent le fichier, et d'où elle vient : l'étiquette de [`release`], à défaut l'empreinte du schéma
/// ([`YearOrigin::Schema`]). `None` : ni l'une ni l'autre (une famille de 2008, un fichier d'une autre origine) ; le fichier ne
/// se lit pas nativement.
pub fn format_year(file: &mut RevitFile) -> Option<(u32, YearOrigin)> {
    if let Some(year) = release(file) {
        return Some((year, YearOrigin::Label));
    }
    // Sans étiquette, l'empreinte du schéma décide : le préambule, gardé pour toute la lecture (`clear_preamble_cache`), l'a déjà
    // calculée. S'il ne se lit pas, on la calcule ici, comme avant.
    if let Ok(preamble) = preamble(file) {
        return preamble.format_year;
    }
    let schema = native_document::read_single(file, "Formats/Latest").ok()?;
    super::schema::year_of(&schema).map(|year| (year, YearOrigin::Schema))
}

/// Le fichier est-il un document de famille (`.rfa`) ? Un projet (`.rvt`) et un modèle de projet (`.rte`) ont un flux
/// `ProjectInformation` ; une famille a un flux `PartAtom` (sa description XML) et pas de `ProjectInformation`.
pub fn is_family(file: &RevitFile) -> bool {
    let names = file.stream_names();
    names.iter().any(|name| name == "PartAtom") && !names.iter().any(|name| name == "ProjectInformation")
}

/// L'année de « Autodesk Revit Architecture 2013 (Build: 20120221_2030(x64)) ».
fn labelled_year(text: &str) -> Option<u32> {
    let rest = text.trim().strip_prefix("Autodesk Revit")?;
    let digits: String = rest.trim_start_matches(|c: char| c.is_alphabetic() || c == ' ').chars().take(4).collect();
    digits.parse().ok().filter(|year| (2000..=2040).contains(year))
}

/// Extrait les graphes d'objets des enregistrements d'éléments sélectionnés, comme
/// `rvt::research::native_document::extract_graphs`, pour les années 2012 à 2027 ([`SUPPORTED_RELEASES`]).
///
/// C'est notre portage de la fonction de rvt-rs pour toutes les années : sur 2023 et plus récent, il rend les
/// mêmes enregistrements que rvt-rs (identité, canal, classe, état, graphe, source), ce que
/// `tests/native_records.rs` vérifie sur tous les fichiers d'essai, en un peu moins de temps (il ne projette pas
/// les métadonnées). Avant 2023, les graphes passent par [`normalize_legacy`].
pub fn extract_graphs(file: &mut RevitFile, options: &Options, emit: impl FnMut(Record) -> Result<()>) -> Result<Summary> {
    extract_graphs_reporting(file, options, emit).map(|(summary, _)| summary)
}

/// [`extract_graphs`], avec en plus le constat d'encadrement des groupes lus.
pub fn extract_graphs_reporting(file: &mut RevitFile, options: &Options, emit: impl FnMut(Record) -> Result<()>) -> Result<(Summary, Framing)> {
    let (version, _) = format_year(file).context("l'année de Revit du fichier ne se lit pas")?;
    ensure!(SUPPORTED_RELEASES.contains(&version), "{}", unsupported(version));
    extract_ported(file, options, emit, version)
}

/// Pourquoi une année n'est pas lue.
pub fn unsupported(version: u32) -> String {
    if version < *SUPPORTED_RELEASES.start() {
        let first = SUPPORTED_RELEASES.start();
        format!("Revit antérieur à {first} : ce fichier a été enregistré par Revit {version}, dont les enregistrements ne se lisent pas ici (la lecture commence à Revit {first}). Ouvrez-le dans Revit {first} ou plus récent et enregistrez-le de nouveau.")
    } else {
        format!("Revit {version} : cette version de Revit est plus récente que celles que ce lecteur sait lire (jusqu'à Revit {}).", SUPPORTED_RELEASES.end())
    }
}

fn class_of(registry: &Registry, body: &[u8]) -> Option<String> {
    let tag = body.get(..2).map(|tag| u16::from_le_bytes([tag[0], tag[1]]))?;
    registry.class(tag).map(|class| class.name.clone())
}

/// Un identifiant sérialisé : un entier, ou un entier enveloppé dans `m_id` (32 bits) ou `m_id64`.
fn identifier(value: &serde_json::Value) -> Result<i64> {
    if let Some(number) = value.as_i64() {
        return Ok(number);
    }
    for key in ["m_id", "m_id64"] {
        if let Some(inner) = value.get(key) {
            return identifier(inner);
        }
    }
    bail!("forme d'identifiant enregistré non prise en charge")
}

fn extract_ported(file: &mut RevitFile, options: &Options, mut emit: impl FnMut(Record) -> Result<()>, version: u32) -> Result<(Summary, Framing)> {
    let preamble = preamble(file)?;
    let Preamble { registry, index, increments, es_catalog, .. } = &*preamble;
    let catalog = es_catalog.as_ref().ok().map(|(catalog, _)| catalog);
    // L'index des groupes (voir `super::index`) : les partitions ne sont inflatées qu'une fois, pour le construire, et
    // seuls les groupes qui contiennent un enregistrement à émettre le sont de nouveau.
    let segments = super::index::index(file, registry, version)?;
    let present: BTreeSet<u32> = segments.partitions.iter().map(|partition| partition.number).collect();
    let selected: BTreeSet<u64> = index.identities.keys().filter(|id| (options.selected_ids.is_empty() && options.selected_classes.is_empty()) || options.selected_ids.contains(id)).copied().collect();
    // Un enregistrement est sélectionné par son identifiant ou par la classe que nomme la balise de son corps.
    let is_selected = |id: u64, tag: u16| {
        selected.contains(&id) || (!options.selected_classes.is_empty() && index.identities.contains_key(&id) && registry.class(tag).is_some_and(|class| options.selected_classes.contains(&class.name)))
    };

    let mut summary = Summary {
        budgets: ResourceBudget { max_stream_bytes: options.max_stream_bytes, max_group_bytes: options.max_group_bytes, max_graph_values: options.max_graph_values, max_graph_objects: options.max_graph_objects },
        revit_version: version,
        schema_sha256: registry.source_sha256.clone(),
        indexed_elements: index.identities.len(),
        graveyard_records: index.graveyard_rows.len(),
        selected_indexed_elements: selected.len(),
        serialized_values_not_evaluated: true,
        requested_ids_absent_from_index: options.selected_ids.iter().filter(|id| !index.identities.contains_key(id)).copied().collect(),
        ..Default::default()
    };
    match es_catalog {
        Ok((catalog, source)) => {
            summary.extensible_storage_catalog = Some(catalog.clone());
            summary.extensible_storage_catalog_source = Some(source.clone());
        }
        Err(error) => summary.extensible_storage_catalog_diagnostic = Some(error.clone()),
    }
    let mut framing = Framing::default();

    // Un élément a une partition « courante » (celle où l'envoie sa révision enregistrée) ; ses
    // enregistrements ailleurs sont historiques. Sur certains fichiers cette partition n'en contient
    // aucun : l'enregistrement courant est alors sa copie dans la dernière partition qui en a une.
    // L'index dit d'abord quelles partitions détiennent les enregistrements de chaque élément sélectionné.
    let mut holders: BTreeMap<(u64, u64), BTreeSet<u32>> = BTreeMap::new();
    for group in &segments.groups {
        if group.source.content_key.is_some() || !options.channels.contains(&group.source.channel) {
            continue;
        }
        let frames = group.frames.as_ref().map_err(|error| anyhow::anyhow!("{error}"))?;
        for frame in frames {
            if is_selected(frame.id, frame.tag) {
                holders.entry((group.source.channel, frame.id)).or_default().insert(segments.partitions[group.partition].number);
            }
        }
    }

    let mut seen = BTreeSet::new();
    let mut seen_ids = BTreeSet::new();
    for (p, partition_loc) in segments.partitions.iter().enumerate() {
        let partition = partition_loc.number;
        let name = &partition_loc.name;
        for &gi in &segments.by_partition[p] {
            let group = &segments.groups[gi];
            if group.source.content_key.is_some() {
                summary.skipped_embedded_content_groups += 1;
                continue;
            }
            if !options.channels.contains(&group.source.channel) {
                *framing.skipped_channels.entry(group.source.channel).or_default() += 1;
                continue;
            }
            let frames = group.frames.as_ref().map_err(|error| anyhow::anyhow!("{error}"))?;
            *framing.groups_by_id_width.entry(group.id_bytes).or_default() += 1;
            *framing.groups_by_rule.entry(group.rule).or_default() += 1;
            framing.records += frames.len();
            framing.unexpected_groups += usize::from(group.unexpected);
            // Les octets du groupe ne sont inflatés qu'au premier enregistrement à émettre.
            let mut bytes: Option<Rc<Vec<u8>>> = None;
            for frame in frames {
                let (id, offset, start, end) = (frame.id, frame.offset, frame.start, frame.end);
                if !is_selected(id, frame.tag) {
                    continue;
                }
                let identity = &index.identities[&id];
                let routed = native_index::route_episode(identity.stored_revision, increments, &present)?;
                let current = match holders.get(&(group.source.channel, id)) {
                    Some(held) if !held.contains(&routed) => *held.last().expect("un élément de `holders` a une partition"),
                    _ => routed,
                };
                if current != partition {
                    summary.skipped_historical_records += 1;
                    continue;
                }
                summary.current_records_outside_route += usize::from(current != routed);
                ensure!(seen.insert((group.source.channel, id)), "enregistrement courant ambigu pour {id} au canal {}", group.source.channel);
                seen_ids.insert(id);
                if bytes.is_none() {
                    bytes = Some(segments.group_bytes(gi, options.max_group_bytes)?);
                }
                let group_bytes = bytes.as_ref().expect("groupe inflaté");
                let body = &group_bytes[start..end];

                let class_name = class_of(registry, body);
                let limits = GraphLimits { max_values: options.max_graph_values, max_objects: options.max_graph_objects, ..Default::default() };
                // Un enregistrement que le budget de valeurs refuserait de toute façon n'est pas décodé (voir
                // `OVERSIZE_BYTES_PER_VALUE`) : refusé d'emblée, avec un diagnostic qui le dit.
                let oversize = body.len() > oversize_limit(options.max_graph_values);
                let decoded = if oversize {
                    Err(anyhow::anyhow!("enregistrement de {} octets : au-delà de {} octets ou du budget de {} valeurs, non décodé", body.len(), MAX_RECORD_BYTES, options.max_graph_values))
                } else {
                    native_parameters::decode_graph_with_catalog_usage(body, registry, &limits, catalog)
                }
                .and_then(|(mut graph, usage)| {
                    if LEGACY_RELEASES.contains(&version) {
                        normalize_legacy(&mut graph);
                    }
                    if group.source.channel == 102 {
                        let root = graph.objects.first().ok_or_else(|| anyhow::anyhow!("graphe propriétaire vide"))?;
                        let saved_id = identifier(&root.fields["m_id"])?;
                        ensure!(u64::try_from(saved_id).ok() == Some(id), "l'identité sérialisée du propriétaire diffère de l'enregistrement indexé {id}");
                    }
                    Ok((graph, usage))
                });
                let (status, diagnostic, graph) = match decoded {
                    Ok((graph, usage)) => {
                        summary.max_graph_objects_observed = summary.max_graph_objects_observed.max(usage.objects);
                        summary.max_graph_values_observed = summary.max_graph_values_observed.max(usage.values);
                        summary.complete_graph_records += 1;
                        ("complete_bounded_graph", None, Some(graph))
                    }
                    Err(error) => {
                        summary.unsupported_graph_records += 1;
                        summary.refused_graph_ids.push(id);
                        if let Some(class_name) = &class_name {
                            *summary.refused_graph_classes.entry(class_name.clone()).or_default() += 1;
                        }
                        ("unsupported_graph", Some(error.to_string()), None)
                    }
                };
                let coverage = summary.classes.entry(class_name.clone().unwrap_or_else(|| "<unregistered>".into())).or_default();
                coverage.records += 1;
                coverage.body_bytes += body.len() as u64;
                if graph.is_some() {
                    coverage.complete_graphs += 1;
                    coverage.complete_graph_body_bytes += body.len() as u64;
                } else {
                    coverage.unsupported_graphs += 1;
                    *coverage.diagnostics.entry(diagnostic.clone().unwrap_or_default()).or_default() += 1;
                }
                summary.emitted_records += 1;
                let (derived_default_ifc_guid, derived_identifier_diagnostic) = match native_metadata::derive_default_ifc_guid(&identity.unique_id) {
                    Ok(value) => (Some(value), None),
                    Err(error) => (None, Some(error.to_string())),
                };
                emit(Record {
                    identity: identity.clone(),
                    derived_default_ifc_guid,
                    derived_identifier_diagnostic,
                    effective_ifc_parameter: None,
                    effective_ifc_parameter_diagnostic: None,
                    channel: group.source.channel,
                    class_name,
                    status: status.into(),
                    diagnostic,
                    source: RecordSource { stream: name.clone(), group: group.source.clone(), group_record_offset: offset, body_bytes: body.len(), body_sha256: String::new() },
                    graph,
                    saved_metadata: None,
                    metadata_diagnostic: None,
                })?;
            }
        }
        summary.partitions.insert(name.clone(), partition_loc.stats.clone());
    }
    summary.selected_ids_without_records = selected.difference(&seen_ids).copied().collect();
    Ok((summary, framing))
}

// ---------------------------------------------------------------------------------------------
// Graphes de Revit 2012–2020 (et sans doute 2021–2022)
// ---------------------------------------------------------------------------------------------

/// Les drapeaux de face (`GFace.m_faceFlags`, classe de version 8, Revit 2012 et 2013) dont le sens est mesuré : 4 et 6.
/// Ce sont les deux seules valeurs vues (AdaptiveComponent-Revit2013 : 4 sur 1 787 faces, 6 sur 8) ; le sens est celui de
/// `m_faceFlags_v9` de la version 9 (Revit 2014 et après), dont le bit 2 retourne la face :
/// - sur les six corps de cette famille dont les faces portent à la fois 4 et 6, seule la règle « le bit 2 retourne la face »
///   ferme leur volume (écart de fermeture de 0,0000 à 0,0001, contre 0,0058 à 0,0143 pour toute autre règle, y compris
///   l'absence de règle) ;
/// - la même famille enregistrée en 2013 et en 2014 donne, une fois `m_faceFlags` copié dans `m_faceFlags_v9`, des maillages
///   identiques sur 11 éléments de 12.
const KNOWN_FACE_FLAGS: [u64; 2] = [4, 6];

/// Met un graphe d'une ancienne année dans la forme que le parcours de rvt-rs attend :
/// - les `InstanceInfo` de Revit 2012 à 2020 n'ont pas de champ `m_GRepId` (introduit plus tard), et le
///   parcours des graphiques enregistrés refuse tout instance de symbole dont `m_GRepId` n'est pas 0. Le champ absent est
///   ajouté à 0, valeur qu'il a sur les fichiers récents pour l'affichage par défaut ;
/// - une `GFace` de Revit 2012 ou 2013 nomme `m_faceFlags` le champ que celle de 2014 nomme `m_faceFlags_v9` : sa valeur est
///   copiée dans `m_faceFlags_v9` quand elle est 4 ou 6 ([`KNOWN_FACE_FLAGS`]). Toute autre valeur laisse `m_faceFlags_v9`
///   absent : la face est alors illisible (le parcours le refuse), la forme partielle ou une boîte, et marquée comme telle ;
///   on ne devine pas le sens d'un drapeau qu'aucun fichier mesuré ne porte.
///
/// Un champ présent n'est jamais touché. Rend le nombre d'`InstanceInfo` complétés.
pub fn normalize_legacy(graph: &mut ObjectGraph) -> usize {
    let mut fixed = 0;
    for object in &mut graph.objects {
        if let Some(fields) = object.fields.as_object_mut() {
            if !fields.contains_key("m_faceFlags_v9") {
                if let Some(flags) = fields.get("m_faceFlags").and_then(Value::as_u64).filter(|flags| KNOWN_FACE_FLAGS.contains(flags)) {
                    fields.insert("m_faceFlags_v9".to_string(), json!(flags));
                }
            }
        }
        if object.class_name != "InstanceInfo" {
            continue;
        }
        let Some(fields) = object.fields.as_object_mut() else { continue };
        if !fields.contains_key("m_GRepId") {
            fields.insert("m_GRepId".to_string(), serde_json::json!(0));
            fixed += 1;
        }
    }
    fixed
}

#[cfg(test)]
mod tests {
    use super::{build_stamp_of, labelled_year, raw_label_year_of, unsupported_build};

    /// Le texte en UTF-16LE, précédé de `shift` octets : l'alignement que décode `raw_label_year_of`.
    fn utf16(text: &str, shift: usize) -> Vec<u8> {
        let mut bytes = vec![0x41; shift];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }

    #[test]
    fn l_etiquette_du_flux_brut_se_lit_aux_deux_alignements() {
        // Les formes mesurées : Revit 2012 (sans retour à la ligne, suivi d'un octet de longueur et du chemin), Revit 2013.
        for (text, year) in [
            ("Autodesk Revit Architecture 2012 (Build: 20110309_2315)%\0C:\\tmp\\revit\\", 2012),
            ("Autodesk Revit 2013 (Build: 20120828_2115(x64))D\0C:\\Users\\jezykm\\Dropb", 2013),
            ("Autodesk Revit 2013 - Preview (Build: 20120224_1515)\r\nLast Save Path: ", 2013),
            ("Autodesk Revit MEP 2014 (Build: 20130709_2115(x64))\r\n", 2014),
        ] {
            for shift in 0..2 {
                assert_eq!(raw_label_year_of(&utf16(text, shift)), Some(year), "{text:?} décalé de {shift}");
            }
        }
    }

    #[test]
    fn le_flux_brut_sans_etiquette_ne_donne_rien() {
        for text in [
            // Project Vasari : pas d'étiquette « Autodesk Revit » (mesuré sur les deux fichiers Vasari).
            "Autodesk Project Vasari (Build: 20120503_2330)9\0C:\\VasariWIP\\2-5\\Dynam",
            "Autodesk Vasari (Build: 20130618_1200(x64))\r\nLast Save Path: C:\\Users\\Ian",
            // Un chemin d'accès qui contient le nom du produit et une année (copie locale BIM 360 de Revit 2020).
            "Autodesk\\Revit\\Autodesk Revit 2020\\CollaborationCache\\G3Z9R8PVN55Y\\fe5",
            // Revit 2023 et après : pas d'année dans l'étiquette.
            "Autodesk Revit\u{10}\0RevitApplication\r\nWorksharing: Not enabled\r\nUsername: \r\n",
            // Un libellé trop long ou qui n'est pas un nom de produit ne vaut pas étiquette.
            "Autodesk Revit 2013 \\ copie (Build: 20120828_2115)",
            "Autodesk Revit (Build: 20150427_1515(x64))",
            // L'étiquette n'est cherchée que dans les 80 caractères qui suivent « Autodesk Revit ».
            &format!("Autodesk Revit 2013{} (Build: 20120828_2115)", " ".repeat(100)),
            "",
        ] {
            for shift in 0..2 {
                assert_eq!(raw_label_year_of(&utf16(text, shift)), None, "{text:?} décalé de {shift}");
            }
        }
        assert_eq!(raw_label_year_of(&[]), None);
        assert_eq!(raw_label_year_of(&[0x41]), None);
    }

    #[test]
    fn l_annee_de_l_etiquette_de_version() {
        assert_eq!(labelled_year("Autodesk Revit Architecture 2013 (Build: 20120221_2030(x64))"), Some(2013));
        assert_eq!(labelled_year("Autodesk Revit 2015 (Build: 20140702_0715(x64))"), Some(2015));
        assert_eq!(labelled_year("Autodesk Revit MEP 2014 (Build: 20130709_2115(x64))"), Some(2014));
        assert_eq!(labelled_year("  Autodesk Revit Structure 2016 (Build: 20150427_1515(x64))"), Some(2016));
        // Pas d'étiquette, ou pas d'année plausible : on ne devine rien.
        assert_eq!(labelled_year("2020 20220517_1515(x64)"), None);
        assert_eq!(labelled_year("Autodesk Revit (Build: 20150427_1515(x64))"), None);
        assert_eq!(labelled_year("Autodesk Revit 1999 (Build: 20150427_1515(x64))"), None);
        assert_eq!(labelled_year(""), None);
    }

    #[test]
    fn le_build_d_un_flux_brut_se_lit_sous_ses_deux_formes() {
        // Les formes mesurées : le build seul (Revit de 2007, `tbc-exhaust-fan-build2007.rfa`, précédé d'un octet de longueur), le build
        // d'un nom de produit (Revit 2012, Project Vasari).
        for (text, expected) in [
            ("\r\020070829_2300>\0C:\\Documents and Settings\\schmidm\\Desktop\\Test\\Exhaust Fan.rfa", (2007, "20070829")),
            ("Worksharing: Not enabled\r\nRevit Build: 20070829_2300\r\nLast Save Path: C:\\", (2007, "20070829")),
            ("Autodesk Revit Architecture 2012 (Build: 20110309_2315)%\0C:\\tmp", (2011, "20110309")),
            ("Autodesk Project Vasari (Build: 20120503_2330)9\0C:\\VasariWIP", (2012, "20120503")),
            ("Autodesk Revit 2013 (Build: 20120828_2115(x64))", (2012, "20120828")),
        ] {
            for shift in 0..2 {
                assert_eq!(build_stamp_of(&utf16(text, shift)), Some((expected.0, expected.1.to_string())), "{text:?} décalé de {shift}");
            }
        }
    }

    #[test]
    fn un_texte_qui_n_a_pas_la_forme_d_un_build_n_en_donne_pas() {
        for text in [
            "",
            "Autodesk Revit 2013",
            // Huit chiffres sans heure ni « (Build: » : un numéro, une date de chemin.
            "C:\\Projets\\20070829\\plan.rfa",
            // Précédés d'un chiffre, ou un mois et un jour qui n'en sont pas.
            "Revit Build: 120070829_2300",
            "Revit Build: 20071329_2300",
            "Revit Build: 20070800_2300",
            "Revit Build: 18500829_2300",
        ] {
            for shift in 0..2 {
                assert_eq!(build_stamp_of(&utf16(text, shift)), None, "{text:?} décalé de {shift}");
            }
        }
        assert_eq!(build_stamp_of(&[]), None);
        assert_eq!(build_stamp_of(&[0x41]), None);
    }

    #[test]
    fn le_refus_d_un_build_d_avant_2012_dit_l_annee_de_compilation() {
        assert_eq!(
            unsupported_build(2007, "20070829"),
            "Revit antérieur à 2012 : ce fichier a été enregistré par une version de Revit compilée en 2007 (build 20070829), dont les enregistrements ne se lisent pas ici (la lecture commence à Revit 2012). Ouvrez-le dans Revit 2012 ou plus récent et enregistrez-le de nouveau."
        );
    }
}
