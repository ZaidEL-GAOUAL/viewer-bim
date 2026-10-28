//! Le document à lire, sans le copier en entier : ses petits flux (`BasicFileInfo`, `Formats/Latest`, `Global/*`,
//! `ProjectInformation`, `PartAtom`…) sont recopiés dans un mini conteneur CFB en mémoire, dont rvt-rs fait son
//! `RevitFile` (préambule, année, GlobalIds) ; ses partitions (`Partitions/N`, l'essentiel des octets) restent dans le
//! conteneur d'origine et se lisent à la demande, par tranches, pour l'index des groupes (`super::index`).
//!
//! Le conteneur d'origine est un lecteur `Read + Seek` quelconque : un tampon en mémoire (natif, essais, Node), ou,
//! dans le navigateur, le `File` lui-même, dont JavaScript sert des fenêtres (`wasm.rs`, `FileReaderSync`). La caisse
//! `cfb` (celle de rvt-rs) résout les secteurs de chaque flux sur ce lecteur ; rvt-rs, lui, n'ouvre qu'un tampon
//! entier (`RevitFile::open_bytes`), d'où le mini conteneur. Seul le repli sur l'export IFC de rvt-rs, qui lit tout le
//! fichier, le relit en entier (`Partitions::whole`).
//!
//! Les partitions sont des flux « paginés » : tous les 65 249 octets enregistrés, 64 896 octets de charge utile puis
//! un contrôle ; la dernière page, courte, est gardée entière (`rvt::compression::strip_revit_page_checksums`). Les
//! positions que l'index note sont celles des octets « préparés » (contrôles retirés) ; `read_prepared` les ramène aux
//! octets enregistrés et ne lit que les pages touchées.

use std::cell::RefCell;
use std::io::{Cursor, Read, Seek, SeekFrom, Write};
use std::rc::Rc;

use anyhow::{Context as _, Result, ensure};
use rvt::RevitFile;
use rvt::compression::{REVIT_PAGE_PAYLOAD_BYTES as PAYLOAD, REVIT_STORED_PAGE_BYTES as PAGE};

/// Un lecteur d'octets du fichier.
pub trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

/// Le lecteur partagé entre le conteneur CFB et la relecture entière : une seule position, prêtée tour à tour.
#[derive(Clone)]
struct Shared(Rc<RefCell<Box<dyn ReadSeek>>>);

impl Read for Shared {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().read(buf)
    }
}

impl Seek for Shared {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.0.borrow_mut().seek(pos)
    }
}

/// Une partition : son nom de flux, son numéro et sa longueur enregistrée.
#[derive(Debug, Clone)]
pub struct Partition {
    pub name: String,
    pub number: u32,
    pub stored_len: u64,
}

impl Partition {
    /// Pages entières (avec contrôle) de la partition.
    fn full_pages(&self) -> u64 {
        self.stored_len / PAGE as u64
    }

    /// Longueur des octets préparés.
    pub fn prepared_len(&self) -> u64 {
        let full = self.full_pages();
        full * PAYLOAD as u64 + (self.stored_len - full * PAGE as u64)
    }

    /// La position enregistrée d'un octet préparé.
    fn stored_offset(&self, prepared: u64) -> u64 {
        let full = self.full_pages();
        if prepared >= full * PAYLOAD as u64 {
            full * PAGE as u64 + (prepared - full * PAYLOAD as u64)
        } else {
            (prepared / PAYLOAD as u64) * PAGE as u64 + prepared % PAYLOAD as u64
        }
    }
}

/// Le document ouvert : les petits flux pour rvt-rs, et les partitions à la demande.
pub struct Document {
    pub file: RevitFile,
    pub partitions: Rc<RefCell<Partitions>>,
}

impl Document {
    /// Ouvre le conteneur sur `reader`, recopie les petits flux dans le mini conteneur de rvt-rs et note les partitions.
    pub fn open(reader: Box<dyn ReadSeek>) -> Result<Self> {
        let mut reader = Shared(Rc::new(RefCell::new(reader)));
        let len = reader.seek(SeekFrom::End(0))?;
        reader.seek(SeekFrom::Start(0))?;
        let mut cfb = cfb::CompoundFile::open(reader.clone()).context("le fichier n'est pas un conteneur CFB lisible")?;
        let entries: Vec<(String, u64)> = cfb.walk().filter(|entry| entry.is_stream()).map(|entry| (entry.path().display().to_string().replace('\\', "/").trim_start_matches('/').to_string(), entry.len())).collect();
        let mut partitions = Vec::new();
        let mut mini = cfb::CompoundFile::create(Cursor::new(Vec::new())).context("mini conteneur")?;
        for (name, stored_len) in entries {
            if let Some(number) = name.strip_prefix("Partitions/").and_then(|rest| rest.parse::<u32>().ok()) {
                partitions.push(Partition { name, number, stored_len });
                continue;
            }
            let mut bytes = Vec::new();
            cfb.open_stream(format!("/{name}"))?.read_to_end(&mut bytes)?;
            if let Some((parent, _)) = name.rsplit_once('/') {
                mini.create_storage_all(format!("/{parent}"))?;
            }
            mini.create_stream(format!("/{name}"))?.write_all(&bytes)?;
        }
        partitions.sort_by(|a, b| a.name.cmp(&b.name));
        mini.flush()?;
        let file = RevitFile::open_bytes(mini.into_inner().into_inner()).context("le fichier n'est pas un fichier Revit lisible")?;
        Ok(Self { file, partitions: Rc::new(RefCell::new(Partitions { cfb, reader, partitions, len })) })
    }
}

/// Les partitions du conteneur d'origine, lues à la demande.
pub struct Partitions {
    cfb: cfb::CompoundFile<Shared>,
    reader: Shared,
    partitions: Vec<Partition>,
    len: u64,
}

impl Partitions {
    /// Longueur du fichier, en octets.
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn list(&self) -> &[Partition] {
        &self.partitions
    }

    /// Les octets enregistrés `offset..offset + len` d'une partition.
    fn read_stored(&mut self, partition: usize, offset: u64, len: usize) -> Result<Vec<u8>> {
        let name = &self.partitions[partition].name;
        let mut stream = self.cfb.open_stream(format!("/{name}")).with_context(|| format!("flux {name}"))?;
        stream.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; len];
        stream.read_exact(&mut bytes).with_context(|| format!("{name} : octets {offset} à {} hors du flux", offset + len as u64))?;
        Ok(bytes)
    }

    /// Les octets préparés `offset..offset + len` d'une partition (contrôles de page retirés) : seules les pages
    /// touchées sont lues.
    pub fn read_prepared(&mut self, partition: usize, offset: usize, len: usize) -> Result<Vec<u8>> {
        if len == 0 {
            return Ok(Vec::new());
        }
        let part = self.partitions[partition].clone();
        ensure!(offset as u64 + len as u64 <= part.prepared_len(), "{} : tranche hors de la partition", part.name);
        let start = part.stored_offset(offset as u64);
        let end = part.stored_offset(offset as u64 + len as u64 - 1) + 1;
        let stored = self.read_stored(partition, start, (end - start) as usize)?;
        let paged = part.full_pages() * PAGE as u64;
        let mut out = Vec::with_capacity(len);
        for (i, byte) in stored.iter().enumerate() {
            let at = start + i as u64;
            if at >= paged || (at % PAGE as u64) < (PAYLOAD as u64) {
                out.push(*byte);
            }
        }
        ensure!(out.len() == len, "{} : tranche préparée incomplète", part.name);
        Ok(out)
    }

    /// Un lecteur séquentiel des octets préparés d'une partition (pour construire l'index).
    pub fn open_prepared(&mut self, partition: usize) -> Result<Prepared> {
        let part = self.partitions[partition].clone();
        let mut stream = self.cfb.open_stream(format!("/{}", part.name)).with_context(|| format!("flux {}", part.name))?;
        stream.seek(SeekFrom::Start(0))?;
        Ok(Prepared { stream, part, stored_pos: 0 })
    }

    /// Tout le fichier, dans un `RevitFile` entier : le repli sur l'export IFC de rvt-rs en a besoin.
    pub fn whole(&mut self) -> Result<RevitFile> {
        self.reader.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::with_capacity(usize::try_from(self.len).unwrap_or(0));
        self.reader.read_to_end(&mut bytes)?;
        RevitFile::open_bytes(bytes).context("le fichier n'est pas un fichier Revit lisible")
    }
}

/// Les octets préparés d'une partition, lus dans l'ordre, une page enregistrée à la fois.
pub struct Prepared {
    stream: cfb::Stream<Shared>,
    part: Partition,
    stored_pos: u64,
}

impl Read for Prepared {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() || self.stored_pos >= self.part.stored_len {
            return Ok(0);
        }
        let paged = self.part.full_pages() * PAGE as u64;
        let payload_left = if self.stored_pos < paged {
            let within = self.stored_pos % PAGE as u64;
            if within >= PAYLOAD as u64 {
                // Le contrôle de fin de page : sauté.
                let skip = PAGE as u64 - within;
                self.stream.seek(SeekFrom::Current(skip as i64))?;
                self.stored_pos += skip;
                return self.read(buf);
            }
            PAYLOAD as u64 - within
        } else {
            self.part.stored_len - self.stored_pos
        };
        let wanted = (buf.len() as u64).min(payload_left) as usize;
        let read = self.stream.read(&mut buf[..wanted])?;
        self.stored_pos += read as u64;
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_positions_preparees_retrouvent_les_octets_enregistres() {
        // Deux pages entières et une page courte de 100 octets.
        let part = Partition { name: "Partitions/0".into(), number: 0, stored_len: 2 * PAGE as u64 + 100 };
        assert_eq!(part.prepared_len(), 2 * PAYLOAD as u64 + 100);
        assert_eq!(part.stored_offset(0), 0);
        assert_eq!(part.stored_offset(PAYLOAD as u64 - 1), PAYLOAD as u64 - 1);
        assert_eq!(part.stored_offset(PAYLOAD as u64), PAGE as u64);
        assert_eq!(part.stored_offset(2 * PAYLOAD as u64), 2 * PAGE as u64);
        assert_eq!(part.stored_offset(2 * PAYLOAD as u64 + 99), 2 * PAGE as u64 + 99);
        // Une dernière page courte mais plus longue que la charge utile d'une page entière reste entière.
        let long_tail = Partition { name: "Partitions/1".into(), number: 1, stored_len: PAGE as u64 + PAGE as u64 - 1 };
        assert_eq!(long_tail.prepared_len(), PAYLOAD as u64 + PAGE as u64 - 1);
        assert_eq!(long_tail.stored_offset(PAYLOAD as u64 + PAGE as u64 - 2), 2 * PAGE as u64 - 2);
    }
}
