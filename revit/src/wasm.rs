//! Pont `wasm-bindgen` : `readRevit(bytes, options?)` rend à JavaScript un objet simple fait de
//! tableaux typés (voir `RevitOutput` côté TypeScript). Compilé uniquement pour `wasm32`.

use js_sys::{Array, Float32Array, Object, Reflect, Uint8Array, Uint32Array};
use wasm_bindgen::prelude::*;

use std::io::{Read, Seek, SeekFrom};

use crate::{Chunk, Options, Output, read_from, read_owned, read_streaming};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

/// Une panique de Rust devient une vraie erreur JavaScript, avec son texte et sa position, au lieu
/// d'un `RuntimeError: unreachable` muet. Le message passe aussi par `console.error`. Installé une
/// seule fois par instance WebAssembly (le worker et le fil principal ont chacun la leur).
///
/// Sur `wasm32-unknown-unknown`, une panique n'est pas rattrapable (pas de déroulement, donc pas de
/// `catch_unwind`) : le crochet lève lui-même l'exception JavaScript, qui traverse les appels
/// WebAssembly jusqu'à l'appelant. L'instance est alors dans un état douteux : l'appelant doit la
/// jeter (terminer le worker) plutôt que la réutiliser.
fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            let message = format!("panique interne de la lecture Revit : {info}");
            console_error(&message);
            wasm_bindgen::throw_val(js_sys::Error::new(&message).into());
        }));
    });
}

/// Le type de ce que rend `readRevit`, tel que le voit TypeScript (recopié dans le `.d.ts`).
#[wasm_bindgen(typescript_custom_section)]
const OUTPUT_TYPE: &str = r#"
/** Ce que `readRevit` rend : un objet simple, tableaux typés compris (voir docs/lecture-revit.md). */
export interface RevitOutput {
  /** Clé d'identité de chaque élément : GlobalId IFC de Revit, à défaut `rvt-<ElementId>`. */
  keys: string[];
  /** Nom affiché de chaque élément : le libellé de sa fiche (« Famille : Type »), le même que `label` dans `metadata`. */
  names: string[];
  /** 0 forme Revit, 1 partielle, 2 reconstruite, 3 inconnue (boîte englobante). */
  sources: Uint8Array;
  /** Centre du modèle en mètres, Y vers le haut : les positions en sont relatives. */
  origin: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  /** Coins des triangles, locaux au premier sommet de la primitive. */
  indices: Uint32Array;
  /** Pas de 6 : élément, premier sommet, nombre de sommets, premier indice, nombre d'indices, matériau. */
  primitives: Uint32Array;
  /**
   * Pas de 7 : r, g, b, a (octets sRGB), transparent (0/1), double face (0/1), surcouche (0/1 : triangles que le
   * viewer dessine par-dessus les surfaces coplanaires, l'image d'un contenu RPC posée sur le sol).
   */
  materials: Uint8Array;
  /** JSON du contrat docs/contrat-metadonnees.md (version 1). Vide quand la sortie est partie par morceaux. */
  metadata: string;
  /**
   * Quand la sortie est partie par morceaux (`readRevitFile` avec `onChunk`) : le JSON de métadonnées est
   * `metadataHead` + les `metadataElements` des morceaux séparés par des virgules + `metadataTail`.
   */
  metadataHead?: string;
  metadataTail?: string;
  report: {
    release: number | null;
    experimental: boolean;
    elements: number;
    triangles: number;
    seconds: number;
    sources: { revit: number; partial: number; rebuilt: number; unknown: number };
    withoutGeometry: number;
    warnings: string[];
    /** Durée de chaque étape de la lecture, dans l'ordre (diagnostic). */
    stages: { name: string; seconds: number }[];
  };
}

/**
 * Un morceau de la sortie (`readRevitFile` avec `onChunk`) : quelques éléments consécutifs, dans l'ordre des clés,
 * avec leurs tableaux (les mêmes que ceux de `RevitOutput`, restreints à ces éléments). Les indices d'élément des
 * primitives sont ceux du morceau (de 0) ; `materials` est la table de toute la lecture jusqu'à ce morceau (celle du
 * morceau suivant la prolonge) ; `origin` est l'origine du modèle entier. Mis bout à bout, les morceaux redonnent
 * exactement la sortie d'un bloc.
 */
export interface RevitChunk {
  keys: string[];
  names: string[];
  sources: Uint8Array;
  origin: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  primitives: Uint32Array;
  materials: Uint8Array;
  /** Les fragments `"clé":{…}` du JSON de métadonnées de ces éléments, séparés par des virgules. */
  metadataElements: string;
}
"#;

/// Lit un fichier Revit et rend un `RevitOutput`. Réglages (`options`, objet JavaScript facultatif) :
/// `prudent` (booléen) lit les formes avec rvt-rs seul, sans aucun de nos maillages de faces : une face
/// que rvt-rs refuse reste manquante (forme partielle ou boîte englobante). C'est le recours après une
/// « panique interne » : une panique ne se rattrape pas en WebAssembly, l'appelant recommence dans un
/// worker neuf avec `{ prudent: true }`. `triangleBudget` (nombre) est le budget de triangles du fichier entier,
/// que le viewer règle d'après la mémoire de l'appareil (`readRevit.ts`) : au-delà, les éléments lus ensuite sont
/// montrés par leur boîte et marqués « Inconnue » (3 millions à défaut). Les autres propriétés sont ignorées.
#[wasm_bindgen(js_name = readRevit, unchecked_return_type = "RevitOutput")]
pub fn read_revit(bytes: Vec<u8>, options: Option<Object>) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let start = js_sys::Date::now();
    let settings = settings(options.as_ref());
    // Les octets passés par JavaScript sont déjà une copie dans la mémoire de WebAssembly : le lecteur
    // la garde telle quelle au lieu d'en faire une seconde.
    let mut output = read_owned(bytes, &settings).map_err(|error| js_error(&format!("{error:#}")))?;
    output.report.seconds = (js_sys::Date::now() - start) / 1000.0;
    to_js(&output).map_err(|error| js_error(&format!("{error:?}")))
}

/// Lit un fichier Revit **sans le copier dans la mémoire du module** : `size` est sa taille en octets et `read(début,
/// longueur)` une fonction JavaScript qui rend un `Uint8Array` de ces octets (dans un worker : `FileReaderSync` sur
/// `file.slice(début, début + longueur)`). Le lecteur demande des fenêtres de `WINDOW_BYTES` ; les petits flux du
/// conteneur sont recopiés dans un mini conteneur, les partitions se lisent par tranches (voir `native::document`).
/// Mêmes réglages et même résultat que `readRevit`.
/// Avec `onChunk` (fonction JavaScript), la sortie part par morceaux (`RevitChunk`) pendant le maillage, dans l'ordre
/// où les formes s'achèvent : la mémoire du module ne tient jamais tous les maillages à la fois. Le `RevitOutput` rendu
/// n'a alors que `report`, `names` (les libellés des fiches, un par élément dans l'ordre des morceaux, qui remplacent
/// leurs noms provisoires) et `metadata` (le JSON entier) ; ses tableaux et ses clés sont vides.
#[wasm_bindgen(js_name = readRevitFile, unchecked_return_type = "RevitOutput")]
pub fn read_revit_file(size: f64, read: js_sys::Function, options: Option<Object>, on_chunk: Option<js_sys::Function>) -> Result<JsValue, JsValue> {
    install_panic_hook();
    let start = js_sys::Date::now();
    let settings = settings(options.as_ref());
    let failed = std::rc::Rc::new(std::cell::RefCell::new(None));
    let reader = JsFile { len: size as u64, pos: 0, read, window: Vec::new(), window_start: 0, window_bytes: WINDOW_BYTES, failed: std::rc::Rc::clone(&failed) };
    let result = match on_chunk {
        Some(on_chunk) => read_streaming(Box::new(reader), &settings, &mut |chunk| {
            let value = chunk_to_js(&chunk).map_err(|error| anyhow::anyhow!("{error:?}"))?;
            on_chunk.call1(&JsValue::NULL, &value).map_err(|error| anyhow::anyhow!("le morceau n'a pas pu être remis : {}", js_sys::Error::from(error).message()))?;
            Ok(())
        }),
        None => read_from(Box::new(reader), &settings),
    };
    // Une erreur de la fonction de lecture (fichier déplacé, modifié : `NotReadableError`) est rendue telle quelle,
    // avec son nom, que le fil principal reconnaît.
    if let Some(error) = failed.borrow_mut().take() {
        return Err(error);
    }
    let mut output = result.map_err(|error| js_error(&format!("{error:#}")))?;
    output.report.seconds = (js_sys::Date::now() - start) / 1000.0;
    to_js(&output).map_err(|error| js_error(&format!("{error:?}")))
}

/// Taille des fenêtres demandées à JavaScript : assez grandes pour que la lecture séquentielle d'une partition (l'index)
/// coûte peu d'appels, assez petites pour ne pas peser (une seule fenêtre vit à la fois).
const WINDOW_BYTES: u64 = 1 << 20;

/// Le `File` du navigateur vu comme un lecteur `Read + Seek` : une fenêtre d'octets à la fois.
struct JsFile {
    len: u64,
    pos: u64,
    read: js_sys::Function,
    window: Vec<u8>,
    window_start: u64,
    window_bytes: u64,
    /// L'erreur levée par `read`, gardée pour être rendue telle quelle.
    failed: std::rc::Rc<std::cell::RefCell<Option<JsValue>>>,
}

impl JsFile {
    fn fetch(&mut self, start: u64) -> std::io::Result<()> {
        // Une fenêtre fixe : mesuré sur Core Interior (34 Mo), 675 lectures de 1 Mio ; des fenêtres qui s'adaptent (256 Kio
        // après un saut, doublées en séquence) en faisaient 1 650, pour 990 Mo lus au lieu de 700.
        let length = self.window_bytes.min(self.len - start);
        let value = self.read.call2(&JsValue::NULL, &JsValue::from_f64(start as f64), &JsValue::from_f64(length as f64)).map_err(|error| {
            let text = format!("lecture du fichier à l'octet {start} : {}", js_sys::Error::from(error.clone()).message());
            *self.failed.borrow_mut() = Some(error);
            std::io::Error::other(text)
        })?;
        let array = Uint8Array::new(&value);
        if u64::from(array.length()) != length {
            return Err(std::io::Error::other(format!("lecture du fichier à l'octet {start} : {} octets rendus pour {length} demandés", array.length())));
        }
        self.window = array.to_vec();
        self.window_start = start;
        Ok(())
    }
}

impl Read for JsFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        if self.pos < self.window_start || self.pos >= self.window_start + self.window.len() as u64 {
            self.fetch(self.pos)?;
        }
        let from = (self.pos - self.window_start) as usize;
        let count = buf.len().min(self.window.len() - from);
        buf[..count].copy_from_slice(&self.window[from..from + count]);
        self.pos += count as u64;
        Ok(count)
    }
}

impl Seek for JsFile {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(at) => Some(at),
            SeekFrom::End(delta) => self.len.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.pos.checked_add_signed(delta),
        };
        let target = target.ok_or_else(|| std::io::Error::other("position hors du fichier"))?;
        self.pos = target;
        Ok(target)
    }
}

/// Un réglage booléen de l'objet `options` : faux s'il est absent ou n'est pas le booléen `true`.
fn flag(options: Option<&Object>, name: &str) -> bool {
    options.and_then(|options| Reflect::get(options, &JsValue::from_str(name)).ok()).and_then(|value| value.as_bool()).unwrap_or(false)
}

/// Un nombre entier positif des réglages (`None` s'il manque ou n'en est pas un).
fn count(options: Option<&Object>, name: &str) -> Option<usize> {
    options.and_then(|options| Reflect::get(options, &JsValue::from_str(name)).ok()).and_then(|value| value.as_f64()).filter(|value| value.is_finite() && *value >= 1.0).map(|value| value as usize)
}

/// Les réglages d'une lecture, lus de l'objet JavaScript (voir `readRevit`).
fn settings(options: Option<&Object>) -> Options {
    Options { prudent: flag(options, "prudent"), triangle_budget: count(options, "triangleBudget"), ..Options::default() }
}

/// Les erreurs rendues à JavaScript sont de vraies `Error` : l'appelant lit toujours `.message`.
fn js_error(message: &str) -> JsValue {
    js_sys::Error::new(message).into()
}

/// Un morceau, pour JavaScript (`RevitChunk`).
fn chunk_to_js(chunk: &Chunk) -> Result<JsValue, JsValue> {
    let object = Object::new();
    let set = |name: &str, value: JsValue| Reflect::set(&object, &JsValue::from_str(name), &value).map(|_| ());
    set("keys", strings(&chunk.keys).into())?;
    set("names", strings(&chunk.names).into())?;
    set("sources", Uint8Array::from(&chunk.sources[..]).into())?;
    set("origin", chunk.origin.iter().map(|value| JsValue::from_f64(*value)).collect::<Array>().into())?;
    set("positions", Float32Array::from(&chunk.positions[..]).into())?;
    set("normals", Float32Array::from(&chunk.normals[..]).into())?;
    set("indices", Uint32Array::from(&chunk.indices[..]).into())?;
    set("primitives", Uint32Array::from(&chunk.primitives[..]).into())?;
    set("materials", Uint8Array::from(&chunk.materials[..]).into())?;
    set("metadataElements", JsValue::from_str(&chunk.metadata_elements))?;
    Ok(object.into())
}

fn to_js(output: &Output) -> Result<JsValue, JsValue> {
    let object = Object::new();
    let set = |name: &str, value: JsValue| Reflect::set(&object, &JsValue::from_str(name), &value).map(|_| ());

    set("keys", strings(&output.keys).into())?;
    set("names", strings(&output.names).into())?;
    set("sources", Uint8Array::from(&output.sources[..]).into())?;
    set("origin", output.origin.iter().map(|value| JsValue::from_f64(*value)).collect::<Array>().into())?;
    set("positions", Float32Array::from(&output.positions[..]).into())?;
    set("normals", Float32Array::from(&output.normals[..]).into())?;
    set("indices", Uint32Array::from(&output.indices[..]).into())?;
    set("primitives", Uint32Array::from(&output.primitives[..]).into())?;
    set("materials", Uint8Array::from(&output.materials[..]).into())?;
    set("metadata", JsValue::from_str(&output.metadata))?;
    if !output.metadata_head.is_empty() || !output.metadata_tail.is_empty() {
        set("metadataHead", JsValue::from_str(&output.metadata_head))?;
        set("metadataTail", JsValue::from_str(&output.metadata_tail))?;
    }
    let report = serde_json::to_string(&output.report).map_err(|error| js_error(&error.to_string()))?;
    set("report", js_sys::JSON::parse(&report)?)?;
    Ok(object.into())
}

fn strings(values: &[String]) -> Array {
    values.iter().map(|value| JsValue::from_str(value)).collect()
}
