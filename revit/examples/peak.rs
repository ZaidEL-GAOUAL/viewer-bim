//! Pic de mémoire d'une lecture : `cargo run --release --example peak -- <fichier.rvt>...`
//!
//! Un allocateur global qui compte ce que Rust alloue (octets vivants, pic) autour de `read` : pour chaque
//! fichier, sa taille, le pic de mémoire pendant la lecture et son rapport à la taille du fichier, ce qui reste
//! vivant à la fin (la sortie : tableaux, métadonnées, rapport), la durée, les éléments et les triangles. C'est la
//! mesure native de ce que la mémoire linéaire de l'instance WebAssembly atteint (elle ne rend jamais ce qu'elle a
//! pris) : en WebAssembly, les pointeurs et les valeurs JSON de rvt-rs sont plus petits, et la mémoire mesurée
//! vaut 0,73 à 0,84 fois ce pic (`docs/lecture-revit.md`).
//!
//! `REVIT_THREADS=1` maille sur un seul fil, comme en WebAssembly.
//!
//! Avec `--etapes`, la lecture tourne sur un fil pendant que celui-ci relève la mémoire vivante toutes les
//! millisecondes ; les relevés sont ensuite découpés selon `report.stages` (les étapes se suivent, leurs durées
//! s'additionnent) : pour chaque étape, sa durée, le pic de mémoire vivante pendant l'étape et la mémoire vivante
//! à sa fin. Rien n'est sondé dans la bibliothèque.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

use revit::{Options, Output, read};

struct Counting;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

impl Counting {
    fn grow(bytes: usize) {
        let now = CURRENT.fetch_add(bytes, Relaxed) + bytes;
        PEAK.fetch_max(now, Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            Self::grow(layout.size());
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        CURRENT.fetch_sub(layout.size(), Relaxed);
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            Self::grow(layout.size());
        }
        p
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                Self::grow(new_size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const MB: f64 = 1_000_000.0;

/// Lit `bytes` sur un fil et relève la mémoire vivante toutes les millisecondes : (instant, octets vivants).
fn read_sampled(bytes: &[u8]) -> (anyhow::Result<Output>, Vec<(f64, usize)>) {
    let clock = Instant::now();
    std::thread::scope(|scope| {
        let reader = scope.spawn(|| read(bytes, &Options::default()));
        let mut samples = Vec::new();
        while !reader.is_finished() {
            samples.push((clock.elapsed().as_secs_f64(), CURRENT.load(Relaxed)));
            std::thread::sleep(Duration::from_millis(1));
        }
        samples.push((clock.elapsed().as_secs_f64(), CURRENT.load(Relaxed)));
        (reader.join().expect("le fil de lecture a paniqué"), samples)
    })
}

/// Pour chaque étape du rapport : durée, pic de mémoire vivante pendant l'étape et mémoire vivante à sa fin,
/// d'après les relevés (relatifs à `base`).
fn print_stages(output: &Output, samples: &[(f64, usize)], base: usize) {
    let mut start = 0.0;
    for stage in &output.report.stages {
        let end = start + stage.seconds;
        let window: Vec<usize> = samples.iter().filter(|(t, _)| *t >= start && *t <= end).map(|(_, live)| live.saturating_sub(base)).collect();
        let peak = window.iter().copied().max().unwrap_or(0);
        let last = window.last().copied().unwrap_or(0);
        println!("    {:<46} {:>6.2} s   pic {:>8.1} Mo   fin {:>8.1} Mo", stage.name, stage.seconds, peak as f64 / MB, last as f64 / MB);
        start = end;
    }
}

fn main() {
    let mut with_stages = false;
    // Les fichiers « ._* » sont des doublons AppleDouble que macOS sème sur les disques exFAT.
    let paths: Vec<String> = std::env::args()
        .skip(1)
        .filter(|argument| {
            if argument == "--etapes" {
                with_stages = true;
                return false;
            }
            !argument.rsplit('/').next().is_some_and(|name| name.starts_with("._"))
        })
        .collect();
    if paths.is_empty() {
        eprintln!("usage : cargo run --release --example peak -- [--etapes] <fichier.rvt>...");
        std::process::exit(2);
    }
    println!("{:<42} {:>7} {:>8} {:>7} {:>8} {:>6} {:>8} {:>9}", "fichier", "Mo", "pic Mo", "pic/Mo", "sortie", "s", "éléments", "triangles");
    for path in &paths {
        let name = std::path::Path::new(path).file_name().map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                println!("{name:<42} illisible : {error}");
                continue;
            }
        };
        let size = bytes.len();
        let before = CURRENT.load(Relaxed);
        PEAK.store(before, Relaxed);
        let clock = Instant::now();
        let (result, samples) = if with_stages { read_sampled(&bytes) } else { (read(&bytes, &Options::default()), Vec::new()) };
        let seconds = clock.elapsed().as_secs_f64();
        let peak = PEAK.load(Relaxed) - before;
        match result {
            Ok(output) => {
                let kept = CURRENT.load(Relaxed) - before;
                println!(
                    "{name:<42} {:>7.1} {:>8.1} {:>7.1} {:>8.1} {:>6.2} {:>8} {:>9}",
                    size as f64 / MB,
                    peak as f64 / MB,
                    peak as f64 / size as f64,
                    kept as f64 / MB,
                    seconds,
                    output.report.elements,
                    output.report.triangles
                );
                if with_stages {
                    print_stages(&output, &samples, before);
                }
            }
            Err(error) => println!("{name:<42} {:>7.1} {:>8.1} échec : {error:#}", size as f64 / MB, peak as f64 / MB),
        }
    }
}
