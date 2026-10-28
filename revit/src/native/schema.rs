//! Le schéma des classes (`Formats/Latest`) des fichiers de Revit 2012 et 2013, et l'empreinte qui date un fichier sans
//! étiquette.
//!
//! rvt-rs (`schema_registry::parse`) lit le schéma de Revit 2014 à 2027 tel quel, et refuse celui de 2012 et de 2013 à
//! l'octet 58 (« schema declared field budget »). Mesuré sur les 52 fichiers d'avant 2015 de la recherche : le schéma de
//! Revit 2014 écrit, après chaque classe, un compte de 16 octets opaques (un `u32`, puis ce nombre de blocs de 16 octets) ;
//! celui de 2012 et de 2013 ne l'écrit pas. Lu sans ce compte, chaque schéma de 2012 et de 2013 se consomme exactement : des
//! balises de classe qui se suivent, puis le terminateur de 8 octets nuls. Il y a un schéma par année (toutes les versions
//! d'une année écrivent les mêmes octets, voir [`SCHEMA_YEARS`]).
//!
//! Provenance : [`Reader`] est `schema_registry::parse` de rvt-rs (Apache-2.0,
//! https://github.com/DrunkOnJava/rvt-rs, commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`), réécrit à l'identique avec un
//! seul interrupteur, `trailer` : vrai, il lit comme rvt-rs (Revit 2014 et après) ; faux, il ne lit pas le compte opaque
//! (Revit 2012 et 2013). Il rend le `Registry` de rvt-rs : rien en aval ne change. À relire à chaque changement du commit
//! épinglé. Attribution : `revit/THIRD_PARTY.md`, §5.
//!
//! Écarts avec l'original, tous voulus :
//! - l'interrupteur `trailer` ;
//! - les classes lues sans compte opaque ont `opaque_16byte_entry_count` à 0 et un résumé vide (aucun code ne s'en sert) ;
//! - [`parse`] n'appelle le port que si rvt-rs refuse ET que l'année est 2012 ou 2013 ; sinon l'erreur de rvt-rs est rendue
//!   telle quelle, comme avant.

use anyhow::{Result, bail, ensure};
use rvt::research::schema_registry::{self, Class, Field, Reference, Registry};
use sha2::{Digest, Sha256};

/// Les trois schémas mesurés, par empreinte SHA-256 des octets inflatés de `Formats/Latest`, et l'année de Revit qui les écrit.
///
/// Mesuré sur les 52 fichiers d'avant 2015 de la recherche (`revit/samples.json`, `year` ≤ 2014 ou `null`), et vérifié à
/// chaque lancement des essais (`tests/pre2015.rs`) sur ceux qui sont présents :
/// - 2012 : `void-cutter-2012.rfa` (build 20110309) et `dynamo-solar-radiation-vasari2012.rvt` (Project Vasari) ;
/// - 2013 : les sept fichiers de 2013 (builds 20120221, 20120224 « Preview », 20120828 et 20120928) ;
/// - 2014 : les onze fichiers de 2014 (builds 20130217, 20130308, 20130709 et 20131024) et la famille Vasari de 2013-06
///   (`dynamo-reference-plane-vasari2013.rfa`), dont le schéma est celui de 2014.
///
/// Chaque année n'a qu'un schéma : tous les fichiers d'une année donnent la même empreinte. Les fichiers de Vasari n'ont pas
/// d'étiquette « Autodesk Revit » : leur empreinte les date (voir [`year_of`]).
pub const SCHEMA_YEARS: [(&str, u32); 3] = [
    ("b41b64b98526cee53b125c6e587ea88dfe0343b9f50ea7442ce1a72003b895a8", 2012),
    ("9104c870ce120a1d7ff76fe62686de3f027b796259fe47c74f106237e3786ac4", 2013),
    ("ecce7218df9f0ddc21b44aceb255e1f0651be0127dfc8c876214403633ac4fa8", 2014),
];

/// L'empreinte SHA-256, en hexadécimal, d'octets.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// L'année de Revit dont `bytes` (les octets inflatés de `Formats/Latest`) sont exactement le schéma, d'après
/// [`SCHEMA_YEARS`] ; `None` pour tout autre schéma (on ne devine pas).
pub fn year_of(bytes: &[u8]) -> Option<u32> {
    let hash = sha256_hex(bytes);
    SCHEMA_YEARS.iter().find(|(known, _)| *known == hash).map(|(_, year)| *year)
}

/// Lit le schéma d'un fichier : rvt-rs d'abord ; si rvt-rs refuse et que `year` est 2012 ou 2013, le port sans compte opaque.
/// Le port n'est accepté que sur une consommation exacte, des balises séquentielles et le terminateur de 8 octets nuls
/// (ce que [`Reader`] vérifie). Un échec des deux lectures rend les deux erreurs. Pour toute autre année, l'erreur de rvt-rs
/// est rendue seule : rien ne change pour les fichiers de 2014 et plus.
pub fn parse(bytes: &[u8], year: Option<u32>) -> Result<Registry> {
    match schema_registry::parse(bytes) {
        Ok(registry) => Ok(registry),
        Err(strict) if matches!(year, Some(2012 | 2013)) => {
            parse_with(bytes, false).map_err(|legacy| anyhow::anyhow!("schéma de Revit {}, refusé par rvt-rs ({strict:#}) puis lu sans compte opaque par classe : {legacy:#}", year.unwrap_or_default()))
        }
        Err(strict) => Err(strict),
    }
}

/// `schema_registry::parse` de rvt-rs, avec (`trailer`, Revit 2014 et après) ou sans (Revit 2012 et 2013) le compte
/// d'entrées opaques qui termine chaque classe.
pub fn parse_with(bytes: &[u8], trailer: bool) -> Result<Registry> {
    ensure!(bytes.len() <= 64 * 1024 * 1024, "schema byte budget exceeded");
    let mut reader = Reader { bytes, pos: 0, classes: Vec::new(), references: 0, fields: 0, definition_depth: 0, trailer };
    while bytes.len().saturating_sub(reader.pos) > 8 {
        reader.definition()?;
    }
    let terminator_offset = reader.pos;
    ensure!(reader.take(8)? == [0; 8] && reader.pos == bytes.len(), "unsupported schema stream terminator");
    let classes = reader.classes.into_iter().collect::<Option<Vec<_>>>().ok_or_else(|| anyhow::anyhow!("incomplete schema definition"))?;
    Ok(Registry { source_sha256: sha256_hex(bytes), consumed_bytes: reader.pos, reference_count: reader.references, terminator_offset, classes })
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
    classes: Vec<Option<Class>>,
    references: usize,
    fields: usize,
    definition_depth: usize,
    trailer: bool,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(count).ok_or_else(|| anyhow::anyhow!("schema length overflow at {}", self.pos))?;
        let result = self.bytes.get(self.pos..end).ok_or_else(|| anyhow::anyhow!("truncated schema at {}: need {count} bytes", self.pos))?;
        self.pos = end;
        Ok(result)
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }

    fn text(&mut self, count: usize) -> Result<String> {
        ensure!((1..=4096).contains(&count), "schema name byte budget at {}: {count}", self.pos);
        Ok(std::str::from_utf8(self.take(count)?)?.to_owned())
    }

    fn reference(&mut self) -> Result<Reference> {
        ensure!(self.references < 1_000_000, "schema reference budget exceeded");
        self.references += 1;
        let offset = self.pos;
        let raw = self.u16()?;
        let tag = raw & 0x7fff;
        let introduces_definition = raw & 0x8000 != 0;
        if introduces_definition {
            ensure!(usize::from(tag) == 12 + self.classes.len(), "nonsequential schema definition tag {tag} at {offset}");
            self.definition()?;
        } else {
            ensure!(usize::from(tag) < 12 + self.classes.len(), "forward/unknown schema reference {tag} at {offset}");
        }
        Ok(Reference { offset, tag, introduces_definition })
    }

    fn field(&mut self, depth: usize) -> Result<Field> {
        ensure!(depth <= 64 && self.fields < 100_000, "schema field recursion/count budget exceeded");
        self.fields += 1;
        let offset = self.pos;
        let count = self.u32()? as usize;
        let name = self.text(count)?;
        let descriptor_offset = self.pos;
        let raw_descriptor = self.u32()?;
        let base = raw_descriptor as u8;
        let modifier = (raw_descriptor >> 8) as u8;
        let uninterpreted_flags = (raw_descriptor >> 16) as u16;
        ensure!((1..=14).contains(&base) && [0, 1, 2, 3, 4, 16, 17, 18, 19, 80, 81, 82, 83, 84, 96].contains(&modifier), "unsupported schema descriptor {raw_descriptor:#010x} at {descriptor_offset}");
        let array_count = if (16..=19).contains(&modifier) {
            let count = self.u32()?;
            ensure!((1..=1_000_000).contains(&count), "schema array count budget at {}", self.pos);
            Some(count)
        } else {
            None
        };
        let mut references = Vec::new();
        if base == 14 && [0, 16, 80].contains(&modifier) {
            references.push(self.reference()?);
        }
        let nested_descriptor = if base == 13 {
            let nested = self.field(depth + 1)?;
            references.extend(nested.references.iter().cloned());
            for _ in 1..array_count.unwrap_or(1) {
                for expected in &nested.references {
                    let actual = self.reference()?;
                    ensure!(actual.tag == expected.tag, "schema composite repeated reference mismatch at {}", actual.offset);
                    references.push(actual);
                }
            }
            // Un composite qui n'est pas lui-même un tableau, sur un tableau fixe de références de classe simples, écrit
            // ces références une fois de plus après le descripteur imbriqué (`SiteSurface.m_facets` de Revit 2018).
            if array_count.is_none() && nested.base == 14 && nested.array_count.is_some() {
                for expected in &nested.references {
                    let actual = self.reference()?;
                    ensure!(actual.tag == expected.tag, "schema composite trailing reference mismatch at {}", actual.offset);
                    references.push(actual);
                }
            }
            Some(Box::new(nested))
        } else {
            None
        };
        Ok(Field { offset, name, descriptor_offset, raw_descriptor, base, modifier, uninterpreted_flags, array_count, references, nested_descriptor, end: self.pos })
    }

    fn definition(&mut self) -> Result<()> {
        ensure!(self.definition_depth < 128 && self.classes.len() < 32756, "schema definition recursion/registry budget exceeded");
        self.definition_depth += 1;
        let offset = self.pos;
        ensure!(self.u16()? == 0, "unsupported schema definition header at {offset}");
        let count = self.u16()? as usize;
        let name = self.text(count)?;
        let ordinal = self.classes.len();
        let tag = (12 + ordinal) as u16;
        // L'enregistrement de la classe précède ses définitions imbriquées.
        self.classes.push(None);
        let parent_reference = self.reference()?;
        let version_like_word = self.u32()?;
        let count = self.u32()? as usize;
        ensure!(count <= 100_000, "schema declared field budget at {} (class {name})", self.pos);
        let mut fields = Vec::new();
        for _ in 0..count {
            fields.push(self.field(0)?);
        }
        let (opaque_16byte_entry_count, opaque_entries_offset, opaque_entries_sha256) = if self.trailer {
            let entries = self.u32()?;
            ensure!(entries <= 1_000_000, "schema opaque trailer budget exceeded");
            let at = self.pos;
            let Some(length) = (entries as usize).checked_mul(16) else { bail!("schema opaque trailer budget exceeded") };
            (entries, at, sha256_hex(self.take(length)?))
        } else {
            (0, self.pos, String::new())
        };
        self.classes[ordinal] = Some(Class { tag, name, offset, parent_reference, version_like_word, fields, opaque_16byte_entry_count, opaque_entries_offset, opaque_entries_sha256, end: self.pos });
        self.definition_depth -= 1;
        Ok(())
    }
}
