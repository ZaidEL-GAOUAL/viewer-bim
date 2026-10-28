//! Index des groupes d'enregistrements des partitions : lire un enregistrement sans garder les partitions inflatées.
//!
//! rvt-rs inflate chaque partition en entier et la garde (`RevitFile::inflated_partition`) : 5 à 7 fois la taille du
//! fichier, vivants toute la lecture, pour que ses lectures successives ne la décompressent pas deux fois. Ici, un
//! premier passage parcourt chaque partition dans l'ordre (`walk_prepared`, le marcheur de rvt-rs refait sur un
//! lecteur séquentiel : un groupe inflaté à la fois, puis oublié) et note, pour chaque groupe des canaux 102 et 103, la
//! position de ses segments compressés, sa longueur inflatée, et l'encadrement de ses enregistrements avec la balise
//! de classe de chacun. Ensuite, lire des enregistrements choisis n'inflate que les groupes qui les contiennent (un
//! groupe fait en général 128 Ko inflatés ; au plus un enregistrement géant), à travers un petit cache LRU
//! (`LRU_BYTES`). Le recensement des classes (`saved::census`) ne lit plus que l'index.
//!
//! Les octets compressés viennent d'une [`PartitionSource`] : le document ouvert par tranches (`super::document`,
//! rien de gardé : le fichier reste dehors), ou, pour qui n'a qu'un `RevitFile` (sondes, essais), les partitions
//! préparées en mémoire (`InMemory`, à peu près la taille du fichier). L'index lui-même pèse cinq entiers par
//! enregistrement.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::io::{Cursor, Read};
use std::rc::Rc;

use anyhow::{Context as _, Result, bail, ensure};
use rvt::RevitFile;
use rvt::compression;
use rvt::research::native_segments::{GroupSource, Statistics};
use rvt::research::schema_registry::Registry;
use sha2::{Digest, Sha256};

use super::document::Partitions;
use super::records::{DeclaredSize, group_records};

/// Budget du cache des groupes inflatés (octets) : une poignée de groupes de 128 Ko, ou un seul groupe géant.
pub const LRU_BYTES: usize = 32 * 1024 * 1024;

/// Un enregistrement dans son groupe : identifiant, octet du début, corps `start..end` (dans les octets inflatés du
/// groupe) et balise de classe (les deux premiers octets du corps ; 0 si le corps est plus court).
#[derive(Debug, Clone, Copy)]
pub struct IndexedFrame {
    pub id: u64,
    pub offset: usize,
    pub start: usize,
    pub end: usize,
    pub tag: u16,
}

/// Un groupe (un ou plusieurs segments contigus d'un même canal).
pub struct GroupLoc {
    pub partition: usize,
    pub source: GroupSource,
    /// Position (octets préparés) et longueur des octets compressés de chaque segment.
    pub segments: Vec<(usize, usize)>,
    pub inflated_len: usize,
    /// Les enregistrements des groupes des canaux 102 et 103 sans clé de contenu ; pour les autres, vide ; ou l'erreur
    /// d'encadrement, rendue quand on lit le groupe.
    pub frames: std::result::Result<Vec<IndexedFrame>, String>,
    pub id_bytes: usize,
    pub rule: DeclaredSize,
    pub unexpected: bool,
}

pub struct PartitionLoc {
    pub name: String,
    pub number: u32,
    pub stats: Statistics,
}

/// D'où l'index lit les octets préparés (contrôles de page retirés) des partitions.
pub trait PartitionSource {
    /// Les partitions, nom et numéro, dans l'ordre des noms.
    fn partitions(&self) -> Vec<(String, u32)>;
    /// Un lecteur séquentiel des octets préparés d'une partition.
    fn open_prepared(&mut self, partition: usize) -> Result<Box<dyn Read + '_>>;
    /// Les octets préparés `offset..offset + len` d'une partition.
    fn read_prepared(&mut self, partition: usize, offset: usize, len: usize) -> Result<Vec<u8>>;
}

impl PartitionSource for Partitions {
    fn partitions(&self) -> Vec<(String, u32)> {
        self.list().iter().map(|partition| (partition.name.clone(), partition.number)).collect()
    }

    fn open_prepared(&mut self, partition: usize) -> Result<Box<dyn Read + '_>> {
        Ok(Box::new(Partitions::open_prepared(self, partition)?))
    }

    fn read_prepared(&mut self, partition: usize, offset: usize, len: usize) -> Result<Vec<u8>> {
        Partitions::read_prepared(self, partition, offset, len)
    }
}

/// Les partitions entières en mémoire, préparées : pour qui n'a qu'un `RevitFile`.
pub struct InMemory {
    names: Vec<(String, u32)>,
    prepared: Vec<Vec<u8>>,
}

impl InMemory {
    pub fn from_file(file: &mut RevitFile, max_stream_bytes: u64) -> Result<Self> {
        let mut names: Vec<String> = file.stream_names().iter().filter(|name| name.starts_with("Partitions/")).cloned().collect();
        names.sort();
        let mut out = Self { names: Vec::new(), prepared: Vec::new() };
        for name in names {
            let number: u32 = name.strip_prefix("Partitions/").and_then(|number| number.parse().ok()).with_context(|| format!("flux de partition inattendu : {name}"))?;
            let stored = file.read_stream_with_limit(&name, max_stream_bytes)?;
            out.prepared.push(compression::prepare_stream_for_inflate(&name, &stored).into_owned());
            out.names.push((name, number));
        }
        Ok(out)
    }
}

impl PartitionSource for InMemory {
    fn partitions(&self) -> Vec<(String, u32)> {
        self.names.clone()
    }

    fn open_prepared(&mut self, partition: usize) -> Result<Box<dyn Read + '_>> {
        Ok(Box::new(Cursor::new(self.prepared[partition].as_slice())))
    }

    fn read_prepared(&mut self, partition: usize, offset: usize, len: usize) -> Result<Vec<u8>> {
        self.prepared[partition].get(offset..offset + len).map(<[u8]>::to_vec).with_context(|| format!("{} : tranche hors de la partition", self.names[partition].0))
    }
}

pub struct SegmentIndex {
    pub partitions: Vec<PartitionLoc>,
    pub groups: Vec<GroupLoc>,
    /// Les groupes de chaque partition, dans l'ordre du fichier.
    pub by_partition: Vec<Vec<usize>>,
    source: Rc<RefCell<dyn PartitionSource>>,
    cache: RefCell<Lru>,
}

struct Lru {
    size: usize,
    order: VecDeque<usize>,
    groups: BTreeMap<usize, Rc<Vec<u8>>>,
}

/// Les groupes des canaux dont les enregistrements sont indexés.
fn indexed(source: &GroupSource) -> bool {
    source.content_key.is_none() && matches!(source.channel, 102 | 103)
}

impl SegmentIndex {
    /// Parcourt toutes les partitions une fois (un groupe inflaté à la fois) et garde l'index.
    pub fn build(source: Rc<RefCell<dyn PartitionSource>>, registry: &Registry, version: u32, max_group_bytes: usize) -> Result<Self> {
        let names = source.borrow().partitions();
        let mut partitions = Vec::new();
        let mut groups = Vec::new();
        let mut by_partition = Vec::new();
        for (partition, (name, number)) in names.into_iter().enumerate() {
            let mut mine = Vec::new();
            let stats = {
                let mut src = source.borrow_mut();
                let mut reader = src.open_prepared(partition)?;
                walk_prepared(&mut *reader, registry, max_group_bytes, |group_source, segments, bytes| {
                    let (frames, id_bytes, rule, unexpected) = if indexed(group_source) {
                        match group_records(group_source, bytes, version) {
                            Ok(grouping) => {
                                let frames = grouping
                                    .frames
                                    .iter()
                                    .map(|frame| IndexedFrame { id: frame.id, offset: frame.offset, start: frame.start, end: frame.end, tag: class_tag(&bytes[frame.start..frame.end]) })
                                    .collect();
                                (Ok(frames), grouping.id_bytes, grouping.rule, grouping.unexpected)
                            }
                            Err(error) => (Err(format!("{name}, groupe à l'octet {} : {error:#}", group_source.first_marker_offset)), 0, DeclaredSize::Body, false),
                        }
                    } else {
                        (Ok(Vec::new()), 0, DeclaredSize::Body, false)
                    };
                    mine.push(groups.len());
                    groups.push(GroupLoc { partition, source: group_source.clone(), segments: segments.to_vec(), inflated_len: bytes.len(), frames, id_bytes, rule, unexpected });
                    Ok(())
                })
                .with_context(|| format!("{name} : partition illisible"))?
            };
            by_partition.push(mine);
            partitions.push(PartitionLoc { name, number, stats });
        }
        Ok(Self { partitions, groups, by_partition, source, cache: RefCell::new(Lru { size: 0, order: VecDeque::new(), groups: BTreeMap::new() }) })
    }

    /// Les octets inflatés d'un groupe : ses segments sont relus, inflatés et concaténés, comme le marcheur de rvt-rs
    /// les a lus ; gardés dans le cache LRU s'ils y tiennent.
    pub fn group_bytes(&self, group: usize, max_group_bytes: usize) -> Result<Rc<Vec<u8>>> {
        if let Some(hit) = self.cache.borrow().groups.get(&group) {
            return Ok(Rc::clone(hit));
        }
        let loc = &self.groups[group];
        let mut data = Vec::with_capacity(loc.inflated_len);
        for &(at, len) in &loc.segments {
            let compressed = self.source.borrow_mut().read_prepared(loc.partition, at, len)?;
            let bytes = inflate_segment(&compressed, max_group_bytes)?;
            ensure!(data.len() + bytes.len() <= max_group_bytes, "groupe réassemblé au-delà du budget");
            data.extend_from_slice(&bytes);
        }
        ensure!(data.len() == loc.inflated_len, "longueur inflatée du groupe discordante");
        let data = Rc::new(data);
        let mut cache = self.cache.borrow_mut();
        if data.len() <= LRU_BYTES {
            cache.size += data.len();
            cache.order.push_back(group);
            cache.groups.insert(group, Rc::clone(&data));
            while cache.size > LRU_BYTES {
                let Some(old) = cache.order.pop_front() else { break };
                if let Some(bytes) = cache.groups.remove(&old) {
                    cache.size -= bytes.len();
                }
            }
        }
        Ok(data)
    }

    /// Enregistrements indexés (canaux 102 et 103).
    pub fn records(&self) -> usize {
        self.groups.iter().map(|group| group.frames.as_ref().map_or(0, Vec::len)).sum()
    }
}

/// La balise de classe d'un corps d'enregistrement.
fn class_tag(body: &[u8]) -> u16 {
    body.get(..2).map_or(0, |tag| u16::from_le_bytes([tag[0], tag[1]]))
}

/// Inflate un segment (un membre gzip tronqué), comme le marcheur de rvt-rs.
fn inflate_segment(compressed: &[u8], max_group_bytes: usize) -> Result<Vec<u8>> {
    let mut decoder = flate2::bufread::GzDecoder::new(compressed);
    let mut bytes = Vec::new();
    (&mut decoder).take(max_group_bytes as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max_group_bytes, "segment inflaté au-delà du budget");
    ensure!(decoder.get_ref().is_empty(), "le gzip ne consomme pas exactement le segment");
    Ok(bytes)
}

/// Un lecteur séquentiel qui compte sa position (en octets préparés).
struct Pull<'a> {
    reader: &'a mut dyn Read,
    pos: usize,
}

impl Pull<'_> {
    /// Lit `n` octets. `n` vient du fichier (taille d'un segment, d'une signature) : le tampon ne grossit qu'avec ce
    /// qui se lit réellement, jamais d'après `n` seul (un `vec![0; n]` d'une taille corrompue ferait avorter le worker).
    fn take(&mut self, n: usize) -> Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(n.min(64 * 1024));
        (&mut *self.reader).take(n as u64).read_to_end(&mut bytes).with_context(|| format!("marque de partition illisible à l'octet {}", self.pos))?;
        ensure!(bytes.len() == n, "marque de partition tronquée à l'octet {}", self.pos);
        self.pos += n;
        Ok(bytes)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.as_slice().try_into()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.as_slice().try_into()?))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.as_slice().try_into()?))
    }
}

/// Parcourt une partition préparée, lue dans l'ordre, comme `native_segments::walk_inflated(prepared, None, …)` de
/// rvt-rs (mêmes contrôles, même bilan `Statistics`), avec en plus la position des segments de chaque groupe :
/// `callback(groupe, segments (position, longueur compressée), octets inflatés)`.
pub fn walk_prepared(reader: &mut dyn Read, registry: &Registry, max_group_bytes: usize, mut callback: impl FnMut(&GroupSource, &[(usize, usize)], &[u8]) -> Result<()>) -> Result<Statistics> {
    ensure!(max_group_bytes > 0, "budget de groupe nul");
    let tag = |name: &str| registry.named(name).map(|class| class.tag).with_context(|| format!("classe de partition absente du schéma : {name}"));
    let content_tag = tag("ContentMarker")?;
    let content_key_tag = tag("ContentKey")?;
    let segment_tag = tag("SegmentMarker")?;
    let checkback_tag = tag("SegmentCheckback")?;
    // Les schémas de 2016 et 2017 n'ont pas de `SignatureMarker` : exigée seulement quand on la rencontre.
    let signature_tag = registry.named("SignatureMarker").map(|class| class.tag);
    let mut r = Pull { reader, pos: 0 };
    r.take(8)?;
    let mut stats = Statistics::default();
    let mut content_key: Option<[u8; 16]> = None;
    let mut content_element_count = None;
    let mut last_size = None;
    let mut active: Option<(GroupSource, Vec<(usize, usize)>, Vec<u8>)> = None;
    loop {
        let offset = r.pos;
        let next = r.u16()?;
        if next == content_tag {
            ensure!(active.is_none(), "frontière de contenu au milieu d'un segment continué");
            let token = r.u32()?;
            let count = if token == 0 {
                content_key = None;
                content_element_count = None;
                r.u32()?
            } else {
                ensure!(token == u32::MAX && r.u16()? == content_key_tag, "pointeur de clé de contenu non pris en charge");
                let count = r.u32()?;
                content_key = Some(r.take(16)?.as_slice().try_into()?);
                content_element_count = Some(count);
                count
            };
            if token == 0 && count == u32::MAX {
                // Au plus une page, plus un octet pour savoir qu'elle est dépassée : le pied d'un fichier corrompu ne se lit pas en entier.
                let mut tail = Vec::new();
                (&mut *r.reader).take(compression::REVIT_STORED_PAGE_BYTES as u64 + 1).read_to_end(&mut tail)?;
                ensure!(tail.len() <= compression::REVIT_STORED_PAGE_BYTES, "le pied opaque de la partition dépasse une page");
                stats.trailing_padding_bytes = tail.iter().take_while(|&&v| v == 0).count();
                stats.opaque_terminal_bytes = tail.len();
                stats.opaque_terminal_sha256 = Sha256::digest(&tail).iter().map(|b| format!("{b:02x}")).collect();
                return Ok(stats);
            }
            stats.content_sections += 1;
        } else if next == segment_tag {
            let flags = r.u32()?;
            let count = r.u32()?;
            let size = r.u32()?;
            let raw = r.u32()?;
            if size == 0 {
                ensure!(flags == 0 && count == 0 && raw == 0 && active.is_none(), "marque de segment vide invalide");
                continue;
            }
            ensure!(flags >> 2 != 0 && size >= 18, "indicateurs ou taille de segment non pris en charge à l'octet {offset}");
            // Un segment compressé plus gros que le budget d'un groupe ne s'inflaterait pas dans ce budget : refusé avant de le lire.
            ensure!(size as usize - 8 <= max_group_bytes, "segment de {size} octets au-delà du budget de groupe à l'octet {offset}");
            let channel = r.u64()?;
            let compressed_at = r.pos;
            let compressed = r.take(size as usize - 8)?;
            let bytes = inflate_segment(&compressed, max_group_bytes)?;
            stats.segments += 1;
            stats.inflated_bytes += bytes.len() as u64;
            last_size = Some(size);
            let from_previous = flags & 1 != 0;
            let to_next = flags & 2 != 0;
            ensure!(from_previous == active.is_some(), "continuation de segment incohérente à l'octet {offset}");
            if let Some((source, segments, data)) = &mut active {
                ensure!(source.channel == channel && source.content_key == content_key, "canal ou contenu de continuation discordant");
                ensure!(data.len().checked_add(bytes.len()).is_some_and(|n| n <= max_group_bytes), "groupe réassemblé au-delà du budget");
                data.extend_from_slice(&bytes);
                segments.push((compressed_at, compressed.len()));
                source.segment_count += 1;
                source.declared_objects += u64::from(count);
                source.declared_body_bytes += u64::from(raw);
            } else {
                active = Some((
                    GroupSource { content_key, content_element_count, channel, first_marker_offset: offset, segment_count: 1, declared_objects: u64::from(count), declared_body_bytes: u64::from(raw) },
                    vec![(compressed_at, compressed.len())],
                    bytes,
                ));
            }
            if !to_next {
                let (source, segments, bytes) = active.take().expect("groupe actif");
                callback(&source, &segments, &bytes)?;
                stats.groups += 1;
            }
        } else if next == checkback_tag {
            ensure!(last_size == Some(r.u32()?), "contrôle de segment discordant à l'octet {offset}");
            last_size = None;
        } else if Some(next) == signature_tag {
            ensure!(active.is_none(), "signature au milieu d'un segment continué");
            let count = r.u32()? as usize;
            ensure!(count <= 1_000_000, "signature de partition au-delà du budget");
            r.take(count)?;
            let units = r.u32()? as usize;
            ensure!(units <= 1_000_000, "texte de signature au-delà du budget");
            let text = r.take(units * 2)?.chunks_exact(2).map(|s| u16::from_le_bytes([s[0], s[1]])).collect::<Vec<_>>();
            String::from_utf16(&text)?;
        } else {
            bail!("marque de partition inconnue {next} à l'octet {offset}");
        }
    }
}

type Key = (u64, u64, usize);

thread_local! {
    static INDEX: RefCell<Option<(Key, Rc<SegmentIndex>)>> = const { RefCell::new(None) };
    static SOURCE: RefCell<Option<(Key, Rc<RefCell<dyn PartitionSource>>)>> = const { RefCell::new(None) };
}

/// Donne au fichier (la clé du préambule, voir `records::preamble`) la source de ses partitions : l'index se construira
/// dessus au premier besoin. Sans source, il se construit depuis le `RevitFile` (partitions entières en mémoire).
pub fn register_source(file: &mut RevitFile, source: Rc<RefCell<dyn PartitionSource>>) {
    let key = super::records::fingerprint(file);
    SOURCE.with(|cell| *cell.borrow_mut() = Some((key, source)));
}

/// L'index du fichier, construit une fois par fichier ; un autre fichier le remplace. `clear_index` le libère en fin
/// de lecture.
pub fn index(file: &mut RevitFile, registry: &Registry, version: u32) -> Result<Rc<SegmentIndex>> {
    let key = super::records::fingerprint(file);
    if let Some(hit) = INDEX.with(|cell| cell.borrow().as_ref().filter(|(cached, _)| *cached == key).map(|(_, index)| Rc::clone(index))) {
        return Ok(hit);
    }
    let source: Rc<RefCell<dyn PartitionSource>> = match SOURCE.with(|cell| cell.borrow().as_ref().filter(|(cached, _)| *cached == key).map(|(_, source)| Rc::clone(source))) {
        Some(source) => source,
        None => Rc::new(RefCell::new(InMemory::from_file(file, 512 * 1024 * 1024)?)),
    };
    let fresh = Rc::new(SegmentIndex::build(source, registry, version, 256 * 1024 * 1024)?);
    INDEX.with(|cell| *cell.borrow_mut() = Some((key, Rc::clone(&fresh))));
    Ok(fresh)
}

/// Oublie l'index gardé et la source enregistrée.
pub fn clear_index() {
    INDEX.with(|cell| *cell.borrow_mut() = None);
    SOURCE.with(|cell| *cell.borrow_mut() = None);
}
