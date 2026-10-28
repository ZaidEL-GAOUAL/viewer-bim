//! Lecture des enregistrements natifs d'un fichier Revit, toutes années confondues (2012 à 2027).
//!
//! rvt-rs ne lit les enregistrements d'éléments (canal 102) et les graphiques enregistrés (canal 103)
//! que pour Revit 2023 à 2027 : sa fonction `extract_records` refuse les autres années (« native record
//! framing is unvalidated »). Les fichiers de Revit 2012 à 2022 écrivent pourtant les mêmes
//! enregistrements, dans les mêmes partitions ; seul l'encadrement de chaque enregistrement change
//! (largeur de l'identifiant, règle de la taille déclarée). Avant Revit 2015, le préambule diffère aussi
//! (schéma de 2012 et de 2013 : [`schema`] ; index des éléments : [`elemtable`]). Ce module porte l'extraction de rvt-rs
//! (voir [`records`]) et la lit pour toutes les années : un seul chemin, dont les tests vérifient, sur
//! les fichiers de 2023 et plus, qu'il rend exactement ce que rend rvt-rs.
//!
//! Les types sont ceux de `rvt::research::native_document` : un appelant qui passait par
//! `native_document::extract_graphs` passe par [`extract_graphs`] en changeant un seul nom de module.

pub mod document;
pub mod elemtable;
pub mod families;
pub mod increments;
pub mod index;
pub mod records;
pub mod schema;

pub use document::{Document, ReadSeek};
pub use families::{FamilyOwner, FamilyRule, LOADED_DEFINITIONS_FROM};
pub use increments::Routing;
pub use records::{
    DeclaredSize, Frame, Framing, Grouping, LEGACY_RELEASES, Preamble, SUPPORTED_RELEASES, YearOrigin, clear_preamble_cache, document_owner_family, extract_graphs, extract_graphs_reporting, format_year, group_records, id_width, is_family, normalize_legacy, old_build, preamble, raw_label_year, read_preamble, release, unsupported, unsupported_build,
};
pub use rvt::research::native_document::{Options, Record, RecordSource, Summary, read_single};
