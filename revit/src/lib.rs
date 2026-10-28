//! Lecture native des fichiers Revit (.rvt) pour Viewer BIM.
//!
//! Cette caisse enveloppe rvt-rs. Elle tourne telle quelle en natif (tests, mesures) et, compilée
//! pour `wasm32-unknown-unknown`, derrière `wasm.rs`, dans un worker du navigateur. Le contrat
//! entre Rust et TypeScript est [`Output`] : des tableaux typés prêts pour three.js, plus le JSON
//! de métadonnées du contrat `docs/contrat-metadonnees.md`.
//!
//! La chaîne : `read` ouvre le fichier (un projet `.rvt` ou une famille `.rfa`, de Revit 2012 à 2027 ; `native` lit
//! ses enregistrements), puis `geometry::build` fabrique les formes et
//! `properties::build` les propriétés. Les deux modules partagent le [`Context`] : l'export IFC de
//! rvt-rs, coûteux, n'y est calculé qu'à la demande, et les enregistrements d'éléments que la
//! géométrie décode pour savoir quoi dessiner y restent pour que les propriétés ne les décodent pas
//! une seconde fois (`properties::Retained`). La géométrie rend aussi les clés d'identité, que les
//! propriétés reprennent telles quelles.

use std::collections::BTreeMap;

use anyhow::Context as _;
use serde::Serialize;

pub mod catalog;
pub mod geometry;
pub mod native;
pub mod properties;
pub mod views;

#[cfg(target_arch = "wasm32")]
mod wasm;

/// Réglages de la lecture.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Décoder tous les enregistrements d'éléments, même ceux que la règle de dessin écarte d'avance
    /// (voir `geometry::saved::Plan`), et laisser les propriétés relire les leurs : plus lent, pour
    /// vérifier que les raccourcis de la lecture ne changent rien au résultat.
    pub exhaustive: bool,
    /// Mode prudent : les faces et le parcours des graphiques ne passent que par rvt-rs, aucun de nos
    /// maillages (`geometry::faces`). Une face que rvt-rs refuse reste manquante (forme partielle ou boîte),
    /// comme avant l'existence de ce maillage. C'est le recours quand une lecture a échoué sur une panique
    /// interne : en WebAssembly une panique n'est pas rattrapable, le lecteur recommence alors dans un
    /// worker neuf avec ce réglage (`readRevit(octets, { prudent: true })`).
    pub prudent: bool,
    /// Budget de triangles du fichier entier (`geometry::MAX_TRIANGLES` à défaut) : ce que le navigateur de
    /// l'utilisateur peut afficher, d'après sa mémoire (`readRevit.ts`). Au-delà, les éléments lus ensuite sont
    /// montrés par leur boîte englobante et marqués « Inconnue ».
    pub triangle_budget: Option<usize>,
}

/// Ce que `read` fournit à l'interface (le contrat décrit dans le plan, côté TypeScript
/// `RevitOutput`). Tous les tableaux sont cohérents entre eux : un élément par entrée de `keys`.
#[derive(Debug, Clone, Default)]
pub struct Output {
    /// Clé d'identité de chaque élément : le GlobalId IFC de Revit, à défaut `rvt-<ElementId>`.
    pub keys: Vec<String>,
    /// Nom affiché de chaque élément : le libellé de sa fiche (« Famille : Type »), le même que `label` dans
    /// `metadata`.
    pub names: Vec<String>,
    /// Origine de la géométrie de chaque élément : 0 forme Revit, 1 partielle, 2 reconstruite,
    /// 3 inconnue (boîte englobante).
    pub sources: Vec<u8>,
    /// Centre du modèle en mètres, Y vers le haut : les positions en sont relatives.
    pub origin: [f64; 3],
    /// Positions xyz en mètres, Y vers le haut, relatives à `origin`.
    pub positions: Vec<f32>,
    /// Normales unitaires, une par sommet.
    pub normals: Vec<f32>,
    /// Coins des triangles, locaux au premier sommet de leur primitive.
    pub indices: Vec<u32>,
    /// Pas de 6 : élément, premier sommet, nombre de sommets, premier indice, nombre d'indices,
    /// matériau.
    pub primitives: Vec<u32>,
    /// Pas de 7 (`geometry::pack::MATERIAL_STRIDE`) : r, g, b, a (octets sRGB), transparent (0/1), double face (0/1),
    /// priorité de profondeur (`geometry::pack::Depth` : 0 ordinaire, 1 surcouche, 2 hôte), qui l'emporte quand des faces de deux éléments sont dans le même plan :
    /// 1 pour l'image d'un contenu RPC et les imports CAD du projet, 2 pour les murs, sols, toitures, plafonds, topographie et plateformes.
    pub materials: Vec<u8>,
    /// JSON du contrat `docs/contrat-metadonnees.md` (version 1). Quand la lecture est émise par morceaux
    /// (`read_streaming`), le squelette rendu à la fin le porte en entier, avec `names` : les fiches ne sont lues
    /// qu'après la géométrie.
    pub metadata: String,
    /// Inusités : la sortie par morceaux portait le JSON en trois parts (début, fragments des morceaux, fin) ; elle
    /// le rend maintenant entier à la fin. Gardés vides pour le contrat.
    pub metadata_head: String,
    pub metadata_tail: String,
    pub report: Report,
}

/// Un morceau de la sortie (`read_streaming`) : quelques éléments consécutifs, dans l'ordre où leur forme s'est
/// achevée (`geometry::prepare_streaming`), avec leurs tableaux, les mêmes que ceux d'`Output` restreints à ces
/// éléments. Les indices d'élément des primitives sont ceux du morceau (de 0) ; `materials` est la table des matériaux
/// de toute la lecture jusqu'à ce morceau (la table d'un morceau prolonge celle du précédent, les indices ne changent
/// pas) ; `origin` est l'origine du modèle entier (le centre de la boîte du premier morceau). `names` sont des noms
/// provisoires (classe et identifiant) : les libellés des fiches viennent avec le squelette, à la fin, comme le JSON de
/// métadonnées (`metadata_elements` reste vide). Mis bout à bout, les morceaux redonnent exactement les tableaux
/// d'`Output` (`read_from`).
#[derive(Debug, Clone, Default)]
pub struct Chunk {
    pub keys: Vec<String>,
    pub names: Vec<String>,
    pub sources: Vec<u8>,
    pub origin: [f64; 3],
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub primitives: Vec<u32>,
    pub materials: Vec<u8>,
    pub metadata_elements: String,
}

/// Triangles par morceau, à peu près (un morceau a au moins un élément) : 250 000 triangles font 7 à 10 Mo de tableaux.
pub const CHUNK_TRIANGLES: usize = 250_000;

/// Bilan de la lecture, montré à l'utilisateur.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Année de Revit qui a enregistré le fichier (l'étiquette de BasicFileInfo). `None` pour un fichier sans étiquette
    /// « Autodesk Revit » (Project Vasari) même quand son schéma le fait lire avec les règles d'une année de 2012 à 2014
    /// (`native::format_year`) : l'année de Revit est alors inconnue, et un avertissement le dit.
    pub release: Option<u32>,
    /// La lecture native n'a pas suffi (format que le lecteur ne reconnaît pas, ou formes reconstruites par l'export IFC de
    /// rvt-rs à la place des graphiques enregistrés) : des éléments peuvent manquer ou être approximatifs. Un fichier sans
    /// étiquette dont le schéma est reconnu (`release: None`, année de lecture connue) se lit nativement : pas expérimental.
    pub experimental: bool,
    pub elements: usize,
    pub triangles: usize,
    /// Durée de `read` en secondes. Laissée à 0 en WebAssembly (`Instant` y est indisponible) :
    /// `wasm.rs` la mesure avec l'horloge du navigateur.
    pub seconds: f64,
    pub sources: SourceCounts,
    /// Éléments trouvés mais sans rien à dessiner.
    pub without_geometry: usize,
    /// Messages en français, destinés à l'utilisateur.
    pub warnings: Vec<String>,
    /// Durée de chaque étape de la lecture, dans l'ordre (diagnostic : voir `revit/examples/measure.rs`).
    pub stages: Vec<Stage>,
}

/// Une étape de la lecture et le temps qu'elle a pris.
#[derive(Debug, Clone, Serialize)]
pub struct Stage {
    pub name: &'static str,
    pub seconds: f64,
}

/// Nombre d'éléments par origine de géométrie.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct SourceCounts {
    pub revit: usize,
    pub partial: usize,
    pub rebuilt: usize,
    pub unknown: usize,
}

/// L'état partagé des deux modules et les avertissements accumulés.
pub struct Context {
    /// Année de Revit du fichier.
    pub release: Option<u32>,
    /// Modèle IFC reconstruit par rvt-rs, calculé à la première demande seulement (voir
    /// [`Context::export`]).
    export: Option<rvt::ifc::ExportResult>,
    /// Messages en français pour l'utilisateur ; recopiés dans `Report::warnings`.
    pub warnings: Vec<String>,
    /// Durées des étapes, dans l'ordre ; recopiées dans `Report::stages`.
    pub stages: Vec<Stage>,
    /// Les enregistrements d'éléments que la géométrie a décodés et dont les propriétés se servent
    /// (voir `properties::Retained`).
    pub retained: properties::Retained,
    /// Lecture sans raccourci (voir `Options::exhaustive`).
    pub exhaustive: bool,
    /// Mode prudent (voir `Options::prudent`).
    pub prudent: bool,
    /// Calculer l'empreinte exacte de la forme finale de chaque élément (`geometry::Stats::shapes`), pour les
    /// essais de non-régression (`examples/measure.rs --empreintes`). Éteint : le viewer n'en a pas besoin.
    pub fingerprints: bool,
    /// GlobalId IFC de chaque élément (ElementId → GlobalId), lus une fois (voir [`Context::global_ids`]).
    /// Budget de triangles du fichier entier (voir `Options::triangle_budget`).
    pub triangle_budget: usize,
    /// Plafond de triangles maillés imposé à la place de celui que le budget détermine (`geometry::saved::Scene::hard_limit`) :
    /// pour les essais seulement, qui n'ont pas à lire un fichier de millions de triangles pour l'atteindre.
    pub hard_triangle_limit: Option<usize>,
    global_ids: Option<BTreeMap<u32, String>>,
    /// Le fichier entier, relu à la demande pour l'export IFC de rvt-rs (voir [`Context::export`]) : quand la lecture
    /// passe par un document lu par tranches (`native::Document`), `file` n'a que les petits flux.
    whole: Option<std::rc::Rc<std::cell::RefCell<native::document::Partitions>>>,
}

impl Context {
    pub fn new(release: Option<u32>) -> Self {
        Self { release, export: None, warnings: Vec::new(), stages: Vec::new(), retained: properties::Retained::default(), exhaustive: false, prudent: false, fingerprints: false, triangle_budget: geometry::MAX_TRIANGLES, hard_triangle_limit: None, global_ids: None, whole: None }
    }

    /// Note la durée d'une étape.
    pub fn stage(&mut self, name: &'static str, seconds: f64) {
        self.stages.push(Stage { name, seconds });
    }

    /// Les GlobalId IFC que l'exporteur de Revit donne aux éléments (table vide si le fichier ne les
    /// permet pas) : lus une seule fois.
    pub fn global_ids(&mut self, file: &mut rvt::RevitFile) -> &BTreeMap<u32, String> {
        self.global_ids.get_or_insert_with(|| rvt::research::revit_global_ids::revit_global_ids(file).unwrap_or_default())
    }

    /// L'export IFC de rvt-rs (modèle reconstruit et diagnostics). Il balaie tout le fichier une
    /// fois par catégorie Revit et coûte l'essentiel d'une lecture : à 2024, sur 34 Mo, 3,5 s en
    /// natif et 8 s en WebAssembly. Les fichiers de Revit 2012 à 2027 se lisent par leurs
    /// enregistrements natifs (formes enregistrées, paramètres) : on n'y recourt que si cette
    /// lecture échoue ou si l'année du fichier est inconnue ou plus récente que celles qu'elle lit.
    pub fn export(&mut self, file: &mut rvt::RevitFile) -> anyhow::Result<&rvt::ifc::ExportResult> {
        if self.export.is_none() {
            let export_of = |file: &mut rvt::RevitFile| rvt::ifc::RvtDocExporter.export_with_diagnostics_and_limits(file, rvt::walker::WalkerLimits::default()).context("rvt-rs n'a pas pu décoder le contenu du fichier");
            // L'export lit tout le fichier : avec un document lu par tranches, il faut le relire en entier.
            let export = match self.whole.clone() {
                Some(partitions) => {
                    #[cfg(target_arch = "wasm32")]
                    if let Some(message) = too_large_for_export(partitions.borrow().len()) {
                        anyhow::bail!("{message}");
                    }
                    export_of(&mut partitions.borrow_mut().whole()?)?
                }
                None => export_of(file)?,
            };
            self.export = Some(export);
        }
        Ok(self.export.as_ref().expect("export calculé ci-dessus"))
    }

    /// Vrai si l'export IFC a déjà été calculé (pour le bilan et les mesures).
    pub fn has_export(&self) -> bool {
        self.export.is_some()
    }
}

/// Nombre d'éléments indexés au-delà duquel un fichier est refusé en WebAssembly, avant tout décodage. Depuis que le
/// fichier reste hors du module et que la sortie part par morceaux pendant le maillage, plus rien n'y grandit avec la
/// taille du fichier ; ce qui grandit avec le nombre d'éléments est le préambule (schéma, index de tous les éléments,
/// incréments : de 150 à 250 octets par élément indexé, soit 5 à 13 Mo sur les fichiers d'essai) et l'index des groupes
/// (quelques dizaines d'octets par enregistrement). À 4 millions d'éléments indexés, le préambule seul atteint le
/// gigaoctet : au-delà, la lecture n'a pas été essayée, et une instance 32 bits (4 Gio) ne la garantirait pas.
pub const MAX_INDEXED_ELEMENTS: usize = 4_000_000;

/// Taille de fichier au-delà de laquelle la reconstruction par l'export IFC de rvt-rs (fichiers d'avant 2012, ou
/// lecture native échouée) n'est pas tentée en WebAssembly : l'export lit le fichier entier en mémoire et le décode
/// tout entier, de 17 à 23 fois la taille du fichier (mesuré sur les fichiers de 2023 et plus, avant la lecture
/// native) ; 150 Mo en occuperaient jusqu'à 3,4 Go. C'est la seule part de la lecture qui grandit encore avec la
/// taille du fichier.
pub const MAX_EXPORT_BYTES: u64 = 150_000_000;

/// Pourquoi un fichier de `indexed` éléments indexés ne se lit pas dans la mémoire d'un navigateur. Le texte commence
/// par « mémoire insuffisante » : le lecteur TypeScript le reconnaît (`isMemoryFailure`) et répond comme à tout manque
/// de mémoire.
pub fn too_many_elements_for_browser(indexed: usize) -> Option<String> {
    (indexed > MAX_INDEXED_ELEMENTS).then(|| {
        format!("mémoire insuffisante : ce fichier indexe {indexed} éléments ; au-delà de {MAX_INDEXED_ELEMENTS}, l'index que Revit en a enregistré dépasse à lui seul ce qu'une instance WebAssembly de 4 Gio peut garder pendant la lecture.")
    })
}

/// Pourquoi un fichier de `bytes` octets ne peut pas être reconstruit par l'export IFC dans la mémoire d'un navigateur.
pub fn too_large_for_export(bytes: u64) -> Option<String> {
    (bytes > MAX_EXPORT_BYTES).then(|| {
        format!(
            "mémoire insuffisante : la reconstruction des formes par l'export IFC demande le fichier entier en mémoire et jusqu'à 23 fois sa taille ; au-delà de {} Mo, elle n'est pas tentée dans le navigateur (fichier de {} Mo).",
            MAX_EXPORT_BYTES / 1_000_000,
            bytes.div_ceil(1_000_000)
        )
    })
}

/// Lit un fichier Revit en mémoire.
pub fn read(bytes: &[u8], options: &Options) -> anyhow::Result<Output> {
    read_owned(bytes.to_vec(), options)
}

/// [`read`] pour qui peut céder ses octets (natif, essais, Node) : un lecteur en mémoire sur ces octets.
pub fn read_owned(bytes: Vec<u8>, options: &Options) -> anyhow::Result<Output> {
    read_from(Box::new(std::io::Cursor::new(bytes)), options)
}

/// Lit un fichier Revit par un lecteur d'octets quelconque, sans jamais le copier en entier (`native::Document`) :
/// les petits flux passent dans un mini conteneur pour rvt-rs, les partitions se lisent par tranches, à la demande de
/// l'index des groupes. Dans le navigateur, le lecteur est le `File` lui-même (`wasm.rs`, `readRevitFile`). La sortie
/// est assemblée d'un bloc : les morceaux de `read_streaming` mis bout à bout.
pub fn read_from(reader: Box<dyn native::ReadSeek>, options: &Options) -> anyhow::Result<Output> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut output = read_streaming(reader, options, &mut |chunk| {
        chunks.push(chunk);
        Ok(())
    })?;
    // Les tableaux des morceaux mis bout à bout : exactement ce qu'un seul morceau aurait donné. Les noms (libellés
    // des fiches) et le JSON de métadonnées sont ceux du squelette, connus à la fin de la lecture.
    for chunk in chunks {
        let (element_base, vertex_base, index_base) = (output.keys.len() as u32, (output.positions.len() / 3) as u32, output.indices.len() as u32);
        for primitive in chunk.primitives.chunks_exact(6) {
            output.primitives.extend_from_slice(&[element_base + primitive[0], vertex_base + primitive[1], primitive[2], index_base + primitive[3], primitive[4], primitive[5]]);
        }
        output.keys.extend(chunk.keys);
        output.sources.extend(chunk.sources);
        output.origin = chunk.origin;
        output.positions.extend(chunk.positions);
        output.normals.extend(chunk.normals);
        output.indices.extend(chunk.indices);
        output.materials = chunk.materials;
    }
    Ok(output)
}

/// [`read_from`], la sortie émise par morceaux (`Chunk`, `CHUNK_TRIANGLES` triangles à peu près chacun) à `sink` dès
/// qu'ils sont assemblés, pendant le maillage : la mémoire ne tient jamais tous les maillages à la fois, seulement
/// ceux du morceau en cours (et ce qu'une règle de dessin retient, voir `geometry::Rules`). Un `sink` qui rend une erreur
/// met fin à la lecture avec cette erreur, telle quelle : les éléments qu'il n'a pas reçus ne sont ni reconstruits ni
/// comptés. L'`Output` rendu n'a que le rapport, les noms (`names`, les libellés des fiches, dans l'ordre des morceaux)
/// et `metadata` : ses tableaux et ses clés sont vides.
pub fn read_streaming(reader: Box<dyn native::ReadSeek>, options: &Options, sink: &mut dyn FnMut(Chunk) -> anyhow::Result<()>) -> anyhow::Result<Output> {
    // Le préambule gardé par `native::preamble` (schéma de milliers de classes, index de tous les éléments) et
    // l'index des groupes ne doivent pas survivre à la lecture, quelle qu'en soit l'issue : un fichier lu ensuite n'en
    // hériterait pas, et en WebAssembly la mémoire d'un worker qui lit plusieurs fichiers ne s'en alourdirait pas.
    let _guard = PreambleGuard;
    let clock = Clock::start();

    let step = geometry::Stopwatch::start();
    let mut document = native::Document::open(reader).context("le fichier n'est pas un fichier Revit lisible")?;
    let file = &mut document.file;
    // L'année du rapport est celle de l'étiquette ; l'année de lecture est la même, ou, sans étiquette (Project Vasari), celle
    // dont le schéma est exactement l'un des trois mesurés (`native::format_year`).
    let release = native::release(file);
    let format = native::format_year(file);
    if let Some(year) = release.filter(|year| *year < *native::SUPPORTED_RELEASES.start()) {
        anyhow::bail!("{}", native::unsupported(year));
    }
    // Ni étiquette ni schéma connu, mais un build de 2010 ou avant (une famille de Revit 2008) : ce Revit-là est antérieur à 2012. Tout
    // autre fichier d'année inconnue garde son comportement.
    if format.is_none() {
        if let Some((year, date)) = native::old_build(file) {
            anyhow::bail!("{}", native::unsupported_build(year, &date));
        }
    }
    let year = format.map(|(year, _)| year);
    native::index::register_source(file, document.partitions.clone());
    // En WebAssembly seulement : en natif, la mémoire n'est pas celle d'une instance de 4 Gio.
    #[cfg(target_arch = "wasm32")]
    if let Ok(preamble) = native::preamble(file) {
        if let Some(message) = too_many_elements_for_browser(preamble.index.identities.len()) {
            anyhow::bail!("{message}");
        }
    }

    let mut context = Context::new(year);
    if let Some((year, native::YearOrigin::Schema)) = format {
        context.warnings.push(unlabelled_warning(year));
    }
    context.exhaustive = options.exhaustive;
    context.prudent = options.prudent;
    context.triangle_budget = options.triangle_budget.unwrap_or(geometry::MAX_TRIANGLES);
    context.whole = Some(document.partitions.clone());
    context.stage("ouverture", step.seconds());
    // Les morceaux : chaque maillage achevé rejoint le morceau en cours, qui part à `sink` dès qu'il atteint
    // `CHUNK_TRIANGLES` triangles ; la mémoire ne tient jamais que les maillages de ce morceau.
    let mut packer = Packer { sink, origin: None, table: geometry::pack::MaterialTable::default(), meshes: Vec::new(), keys: Vec::new(), names: Vec::new(), sources: Vec::new(), triangles: 0, total: 0, seconds: 0.0 };
    let geometry::Prepared { keys, element_ids, names: _, sources, counts, without_geometry, stats: _, meshes: _ } = geometry::prepare_streaming(file, &mut context, &mut |emitted| packer.push(emitted))?;
    packer.flush()?;
    let (seconds_pack, triangles) = (packer.seconds, packer.total);
    drop(packer);
    let properties = properties::build(file, &mut context, &element_ids, &keys, &sources)?;
    // Une copie locale d'un modèle partagé se lit par sa table locale d'incréments (`native::increments`) : le modèle
    // est celui que son utilisateur a enregistré. Le préambule est gardé, ce test ne relit rien.
    if year.is_none_or(|year| native::SUPPORTED_RELEASES.contains(&year)) && native::preamble(file).is_ok_and(|preamble| preamble.routing.is_local()) {
        context.warnings.insert(0, native::increments::LOCAL_COPY_WARNING.to_string());
    }

    context.stage("géométrie : assemblage", seconds_pack);
    let metadata = properties.metadata();
    let names = properties.labels;

    // « Expérimental » : la lecture native n'a pas suffi (lecture échouée et reconstruite par l'export IFC de rvt-rs), ou le format du
    // fichier n'est pas reconnu (ni étiquette, ni schéma connu). Un fichier sans étiquette au schéma reconnu se lit nativement.
    let experimental = year.is_none() || context.has_export();
    let report = Report {
        release,
        experimental,
        elements: keys.len(),
        triangles,
        seconds: clock.seconds(),
        sources: counts,
        without_geometry,
        warnings: context.warnings,
        stages: context.stages,
    };
    Ok(Output { names, metadata, report, ..Output::default() })
}

/// L'avertissement d'un fichier lu sans étiquette de version, d'après l'empreinte de son schéma.
fn unlabelled_warning(year: u32) -> String {
    format!("Fichier enregistré par un produit qui ne se nomme pas Revit (par exemple Project Vasari) : son format est reconnu à son schéma, celui de Revit {year}.")
}

/// Les maillages qui attendent d'être assemblés en morceau (`read_streaming`), et ce qu'il faut pour les assembler :
/// l'origine du modèle (le centre de la boîte du premier morceau, commune à tous les suivants) et la table des
/// matériaux, que chaque morceau prolonge.
struct Packer<'s> {
    sink: &'s mut dyn FnMut(Chunk) -> anyhow::Result<()>,
    origin: Option<[f64; 3]>,
    table: geometry::pack::MaterialTable,
    meshes: Vec<geometry::pack::ElementMesh>,
    keys: Vec<String>,
    names: Vec<String>,
    sources: Vec<u8>,
    /// Triangles du morceau en cours, et de toute la lecture.
    triangles: usize,
    total: usize,
    seconds: f64,
}

impl Packer<'_> {
    fn push(&mut self, emitted: geometry::Emitted) -> anyhow::Result<()> {
        let triangles = emitted.mesh.triangles();
        self.triangles += triangles;
        self.total += triangles;
        self.keys.push(emitted.key);
        self.names.push(emitted.name);
        self.sources.push(emitted.source);
        self.meshes.push(emitted.mesh);
        if self.triangles >= CHUNK_TRIANGLES {
            self.flush()?;
        }
        Ok(())
    }

    /// Le morceau en cours part, s'il a un élément.
    fn flush(&mut self) -> anyhow::Result<()> {
        if self.keys.is_empty() {
            return Ok(());
        }
        let step = geometry::Stopwatch::start();
        let meshes = std::mem::take(&mut self.meshes);
        let origin = *self.origin.get_or_insert_with(|| geometry::pack::origin_of(meshes.iter()));
        let packed = geometry::pack::pack_chunk(meshes, origin, &mut self.table);
        self.triangles = 0;
        let chunk = Chunk {
            keys: std::mem::take(&mut self.keys),
            names: std::mem::take(&mut self.names),
            sources: std::mem::take(&mut self.sources),
            origin,
            positions: packed.positions,
            normals: packed.normals,
            indices: packed.indices,
            primitives: packed.primitives,
            materials: packed.materials,
            metadata_elements: String::new(),
        };
        self.seconds += step.seconds();
        (self.sink)(chunk)
    }
}

/// Libère le préambule gardé par `native::preamble` quand la lecture se termine, par un résultat ou par une erreur.
struct PreambleGuard;

impl Drop for PreambleGuard {
    fn drop(&mut self) {
        native::clear_preamble_cache();
    }
}

/// Chronomètre : `std::time::Instant` plante en WebAssembly (pas d'horloge), il n'existe donc que
/// hors du navigateur.
struct Clock {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
}

impl Clock {
    fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: std::time::Instant::now(),
        }
    }

    fn seconds(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_secs_f64()
        }
        #[cfg(target_arch = "wasm32")]
        {
            0.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_fichier_hors_de_portee_est_refuse_en_francais_comme_un_manque_de_memoire() {
        let message = too_many_elements_for_browser(MAX_INDEXED_ELEMENTS + 1).expect("refusé");
        assert!(message.starts_with("mémoire insuffisante : "), "{message}");
        assert!(message.contains("4000001 éléments"), "{message}");
        assert_eq!(too_many_elements_for_browser(MAX_INDEXED_ELEMENTS), None);
        let message = too_large_for_export(MAX_EXPORT_BYTES + 1).expect("refusé");
        assert!(message.starts_with("mémoire insuffisante : ") && message.contains("150 Mo") && message.contains("151 Mo"), "{message}");
        assert_eq!(too_large_for_export(MAX_EXPORT_BYTES), None);
    }
}
