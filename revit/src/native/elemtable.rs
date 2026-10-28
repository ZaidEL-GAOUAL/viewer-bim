//! L'index des éléments (`Global/ElemTable`) des fichiers de Revit 2012 à 2014.
//!
//! Avant Revit 2015, l'index a les mêmes quatre champs et les mêmes lignes de 28 octets que celui de 2015 ; une seule chose
//! change : le jeton du pointeur `m_pSource` (l'`IdentifierSource` différé qui clôt le flux) vaut 2, là où Revit 2015 et
//! après écrivent `u32::MAX`. rvt-rs (`native_index::parse`) l'exige et refuse l'index (« unsupported identifier source
//! pointer »). Mesuré : le jeton vaut 2 dans les 51 fichiers d'avant 2015 de la recherche (2012, 2013 et 2014), jamais
//! autre chose.
//!
//! Provenance : [`parse_legacy`] est `native_index::parse` de rvt-rs (Apache-2.0, https://github.com/DrunkOnJava/rvt-rs,
//! commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`), avec ses deux aides privées `fixed_layout` et `leaf_value`, réécrit
//! sur l'API publique de rvt-rs. À relire à chaque changement du commit épinglé. Attribution : `revit/THIRD_PARTY.md`, §5.
//!
//! Écarts avec l'original, tous voulus :
//! - le jeton de `m_pSource` doit valoir exactement [`LEGACY_SOURCE_TOKEN`] (2) ; toute autre valeur est une erreur qui la
//!   nomme (l'original exige `u32::MAX`) ;
//! - [`parse`] n'appelle ce portage que si rvt-rs refuse ET que l'année du fichier est d'avant 2015 ; sinon l'erreur de
//!   rvt-rs est rendue telle quelle, comme avant : rien ne change pour les fichiers de 2015 et plus.

use std::collections::BTreeMap;

use anyhow::{Result, bail, ensure};
use rvt::research::native_index::{self, Identity, ProjectIndex};
use rvt::research::native_parameters;
use rvt::research::schema_registry::Registry;

/// Le jeton de `m_pSource` que Revit 2012, 2013 et 2014 écrivent (mesuré sur 51 fichiers).
pub const LEGACY_SOURCE_TOKEN: u32 = 2;

/// La première année qui écrit le jeton `u32::MAX` de rvt-rs.
const FIRST_MODERN_YEAR: u32 = 2015;

/// Lit l'index des éléments : rvt-rs d'abord ; si rvt-rs refuse et que `year` est d'avant 2015, le portage qui exige le jeton
/// de ces années. Un échec des deux lectures rend les deux erreurs. Pour toute autre année, l'erreur de rvt-rs est rendue seule.
pub fn parse(index: &[u8], registry: &Registry, episodes: &[String], year: Option<u32>) -> Result<ProjectIndex> {
    match native_index::parse(index, registry, episodes) {
        Ok(project) => Ok(project),
        Err(strict) if year.is_some_and(|year| year < FIRST_MODERN_YEAR) => {
            parse_legacy(index, registry, episodes).map_err(|legacy| anyhow::anyhow!("index des éléments d'un fichier d'avant Revit {FIRST_MODERN_YEAR}, refusé par rvt-rs ({strict:#}) puis lu avec le jeton de m_pSource de ces années : {legacy:#}"))
        }
        Err(strict) => Err(strict),
    }
}

#[derive(Clone)]
struct Leaf {
    path: String,
    offset: usize,
    size: usize,
}

/// La disposition fixe d'une ligne de l'index : sa taille et, pour chaque champ de base, son chemin, son décalage et sa
/// largeur.
fn fixed_layout(registry: &Registry, tag: u16) -> Result<(usize, Vec<Leaf>)> {
    fn visit(registry: &Registry, tag: u16, prefix: &str, pos: &mut usize, leaves: &mut Vec<Leaf>, depth: usize) -> Result<()> {
        ensure!(depth < 128, "index layout recursion budget");
        let class = registry.class(tag).ok_or_else(|| anyhow::anyhow!("index layout class absent"))?;
        if class.parent_reference.tag >= 12 {
            visit(registry, class.parent_reference.tag, prefix, pos, leaves, depth + 1)?;
        }
        for field in &class.fields {
            if field.uninterpreted_flags & 2 != 0 {
                continue;
            }
            ensure!(field.uninterpreted_flags == 0 && field.modifier == 0, "nonfixed index schema field {}.{}", class.name, field.name);
            let path = if prefix.is_empty() { field.name.clone() } else { format!("{prefix}.{}", field.name) };
            if field.base == 14 {
                ensure!(field.references.len() == 1, "index reference field schema");
                visit(registry, field.references[0].tag, &path, pos, leaves, depth + 1)?;
            } else {
                let size = match field.base {
                    1 | 2 => 1,
                    3 => 2,
                    4..=6 => 4,
                    7 | 11 => 8,
                    9 => 16,
                    _ => bail!("unsupported index primitive"),
                };
                leaves.push(Leaf { path, offset: *pos, size });
                *pos += size;
            }
        }
        Ok(())
    }
    let mut size = 0;
    let mut leaves = Vec::new();
    visit(registry, tag, "", &mut size, &mut leaves, 0)?;
    Ok((size, leaves))
}

/// La valeur (entière) du seul champ dont le chemin commence par `prefix`, et sa largeur.
fn leaf_value(row: &[u8], layout: &[Leaf], prefix: &str) -> Result<(u64, usize)> {
    let candidates: Vec<_> = layout.iter().filter(|leaf| leaf.path.starts_with(prefix)).collect();
    ensure!(candidates.len() == 1, "ambiguous/missing index field {prefix}");
    let leaf = candidates[0];
    let end = leaf.offset.checked_add(leaf.size).ok_or_else(|| anyhow::anyhow!("truncated index field"))?;
    let bytes = row.get(leaf.offset..end).ok_or_else(|| anyhow::anyhow!("truncated index field"))?;
    Ok((
        match leaf.size {
            4 => u64::from(u32::from_le_bytes(bytes.try_into()?)),
            8 => u64::from_le_bytes(bytes.try_into()?),
            _ => bail!("unsupported index identity width"),
        },
        leaf.size,
    ))
}

/// `native_index::parse` de rvt-rs, avec le jeton de `m_pSource` des fichiers d'avant 2015 : décode le tableau des lignes
/// (`m_elemArr`) depuis sa vraie racine, puis les enregistrements du cimetière, le jeton, les indicateurs, l'`IdentifierSource`
/// différé et le terminateur exact. Les suffixes d'origine peuvent se répéter ; les identifiants courants sont uniques.
pub fn parse_legacy(index: &[u8], registry: &Registry, episodes: &[String]) -> Result<ProjectIndex> {
    ensure!(index.len() >= 6, "short project element index");
    let tag = u16::from_le_bytes(index[..2].try_into()?);
    let table = registry.class(tag).ok_or_else(|| anyhow::anyhow!("index root absent"))?;
    ensure!(table.name == "ElemTable" && matches!(table.fields.len(), 4 | 5), "unsupported index root schema");
    let array = &table.fields[0];
    ensure!(array.name == "m_elemArr" && array.raw_descriptor == 0x500e && array.references.len() == 1, "unsupported index array");
    let (stride, layout) = fixed_layout(registry, array.references[0].tag)?;
    ensure!(stride > 0, "empty index layout");
    let count = u32::from_le_bytes(index[2..6].try_into()?) as usize;
    let end = count.checked_mul(stride).and_then(|bytes| bytes.checked_add(6)).ok_or_else(|| anyhow::anyhow!("index array overflow"))?;
    let rows = index.get(6..end).ok_or_else(|| anyhow::anyhow!("truncated index array"))?;
    let mut result = BTreeMap::new();
    for (i, row) in rows.chunks_exact(stride).enumerate() {
        let element_id = leaf_value(row, &layout, "m_id.")?.0;
        let original_id_suffix = leaf_value(row, &layout, "m_history.m_originalElementId.")?.0;
        let creation_episode = u32::try_from(leaf_value(row, &layout, "m_history.m_creationDate.")?.0)?;
        let stored_revision = u32::try_from(leaf_value(row, &layout, "m_history.m_lastModificationDate.")?.0)?;
        let other_revision = u32::try_from(leaf_value(row, &layout, "m_history.m_lastUserModificationDate.")?.0)?;
        let (owner, width) = leaf_value(row, &layout, "m_OwningElementId.")?;
        let owning_element_id = if width == 4 { i64::from(owner as u32 as i32) } else { owner as i64 };
        let partition_id = i64::from(leaf_value(row, &layout, "m_partitionId.")?.0 as u32 as i32);
        // `as usize + 1` déborderait en WebAssembly (usize sur 32 bits) pour 0xFFFFFFFF : l'addition est contrôlée, et un épisode hors de
        // l'historique est une erreur qui nomme l'élément, jamais un indice faux.
        let reverse = (creation_episode as usize).checked_add(1).and_then(|episode| episodes.len().checked_sub(episode)).ok_or_else(|| anyhow::anyhow!("épisode de création {creation_episode} hors de l'historique ({} épisodes) pour l'élément {element_id}", episodes.len()))?;
        let unique_id = format!("{}-{original_id_suffix:08x}", episodes[reverse]);
        let raw_fields = row.chunks_exact(4).map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]])).collect();
        let entry = Identity { element_id, original_id_suffix, creation_episode, stored_revision, other_revision, row_offset: 6 + i * stride, raw_fields, owning_element_id, partition_id, unique_id };
        ensure!(result.insert(element_id, entry).is_none(), "duplicate current ElementId {element_id}");
    }
    let mut pos = end;
    let read_u32 = |pos: &mut usize| -> Result<u32> {
        let next = pos.checked_add(4).ok_or_else(|| anyhow::anyhow!("truncated index trailer"))?;
        let bytes = index.get(*pos..next).ok_or_else(|| anyhow::anyhow!("truncated index trailer"))?;
        *pos = next;
        Ok(u32::from_le_bytes(bytes.try_into()?))
    };
    let grave_count = read_u32(&mut pos)? as usize;
    ensure!(grave_count <= 1_000_000, "graveyard count budget");
    let field = &table.fields[1];
    ensure!(field.name == "m_graveyardRecs" && field.raw_descriptor == 0x500e && field.references.len() == 1, "unsupported graveyard schema");
    let mut graveyard_rows = Vec::new();
    for _ in 0..grave_count {
        let decoded = native_parameters::decode_object_fields(index, registry, pos, field.references[0].tag)?;
        pos = decoded.end;
        graveyard_rows.push(decoded.fields);
    }
    ensure!(table.fields[2].name == "m_pSource" && table.fields[2].raw_descriptor == 0x20e, "unsupported index source field");
    let token = read_u32(&mut pos)?;
    ensure!(token == LEGACY_SOURCE_TOKEN, "jeton du pointeur m_pSource inattendu : {token} (les fichiers d'avant Revit {FIRST_MODERN_YEAR} écrivent {LEGACY_SOURCE_TOKEN}, mesuré sur 51 fichiers)");
    let source_tag = u16::from_le_bytes(index.get(pos..pos + 2).ok_or_else(|| anyhow::anyhow!("source class absent"))?.try_into()?);
    pos += 2;
    // Comme rvt-rs : Revit 2023 n'a que `m_bExpandAllOnLoad`, les suivants ajoutent `m_bLastElementIdOverride` avant le corps différé.
    let flag_names: &[&str] = match table.fields.len() {
        4 => &["m_bExpandAllOnLoad"],
        5 => &["m_bExpandAllOnLoad", "m_bLastElementIdOverride"],
        _ => unreachable!("nombre de champs de la racine vérifié plus haut"),
    };
    for (i, name) in flag_names.iter().enumerate() {
        ensure!(table.fields[i + 3].name == *name && table.fields[i + 3].raw_descriptor == 1, "unsupported index flag schema");
        ensure!(index.get(pos).is_some_and(|value| *value <= 1), "invalid index flag");
        pos += 1;
    }
    ensure!(registry.class(source_tag).is_some_and(|class| class.name == "IdentifierSource"), "unsupported identifier source class");
    let source = native_parameters::decode_object_fields(index, registry, pos, source_tag)?;
    pos = source.end;
    ensure!(index.get(pos..) == Some(&[0; 4]), "unsupported index terminator");
    Ok(ProjectIndex { identities: result, graveyard_rows, row_stride: stride, source_fields: source.fields })
}
