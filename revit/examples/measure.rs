//! Mesure de la lecture native : `cargo run --release --example measure -- [--geometrie] [--etapes] [--exhaustif] <fichier.rvt>...`
//!
//! Une ligne par fichier : nom, année de Revit, secondes de `read` (toute la lecture), secondes de
//! la géométrie seule et leur détail (enregistrements d'éléments, symboles, éléments dont maillage,
//! maillage des instances qui ont attendu leurs symboles, export IFC, assemblage),
//! éléments, triangles, les quatre origines de géométrie, éléments sans forme, éléments dessinés
//! des deux côtés, triangles retournés, et si l'export IFC de rvt-rs a dû être calculé.
//!
//! Avec `--geometrie`, seule la géométrie est mesurée (un seul passage par fichier). Avec `--etapes`,
//! la durée de chaque étape de `read` (le `report.stages` que reçoit aussi le navigateur) est
//! imprimée sous la ligne du fichier ; la géométrie n'est alors pas relue une seconde fois. Avec
//! `--exhaustif`, aucun raccourci de lecture (voir `Options::exhaustive`).
//! `REVIT_THREADS=1` mesure le maillage sur un seul fil, comme en WebAssembly.
//!
//! `--empreintes <sortie>` écrit, pour chaque élément de chaque fichier, sa source, ses triangles et une
//! empreinte exacte (bit à bit) de sa forme finale (sommets absolus en f64, normales, indices, couleurs :
//! `ElementMesh::exact_fingerprint`, qui ne dépend pas de l'origine du modèle) : `fichier élément source triangles
//! empreinte`. `--comparer <référence>` relit un tel
//! fichier et vérifie que chaque élément qui était en source 0 (forme Revit entière) l'est toujours, avec exactement
//! la même forme : ce qui était lu en entier ne change pas. Sortie en erreur sinon.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::process::ExitCode;

use revit::{Context, Options, geometry, read};

/// Un fichier d'empreintes écrit par `--empreintes` : (fichier, élément) → (source, triangles, empreinte).
fn read_fingerprints(path: &str) -> BTreeMap<(String, u64), (u8, usize, u64)> {
    let text = std::fs::read_to_string(path).expect("fichier d'empreintes illisible");
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (name, id, source, triangles, hash) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?, fields.next()?);
            Some(((name.to_string(), id.parse().ok()?), (source.parse().ok()?, triangles.parse().ok()?, u64::from_str_radix(hash, 16).ok()?)))
        })
        .collect()
}

fn main() -> ExitCode {
    let mut geometry_only = false;
    let mut with_stages = false;
    let mut exhaustive = false;
    let mut write_fingerprints: Option<String> = None;
    let mut compare_with: Option<String> = None;
    let mut next: Option<&'static str> = None;
    // Les fichiers « ._* » sont des doublons AppleDouble que macOS sème sur les disques exFAT.
    let paths: Vec<String> = std::env::args()
        .skip(1)
        .filter(|argument| {
            match next.take() {
                Some("sortie") => {
                    write_fingerprints = Some(argument.clone());
                    return false;
                }
                Some(_) => {
                    compare_with = Some(argument.clone());
                    return false;
                }
                None => {}
            }
            if argument == "--empreintes" || argument == "--comparer" {
                next = Some(if argument == "--empreintes" { "sortie" } else { "référence" });
                return false;
            }
            if argument == "--geometrie" {
                geometry_only = true;
                return false;
            }
            if argument == "--etapes" {
                with_stages = true;
                return false;
            }
            if argument == "--exhaustif" {
                exhaustive = true;
                return false;
            }
            !argument.rsplit('/').next().is_some_and(|name| name.starts_with("._"))
        })
        .collect();
    if paths.is_empty() {
        eprintln!("usage : cargo run --release --example measure -- [--geometrie] <fichier.rvt>...");
        return ExitCode::from(2);
    }

    println!(
        "{:<40} {:>5} {:>7} | {:>6} {:>5} {:>5} {:>5} {:>5} {:>5} {:>6} {:>5} | {:>7} {:>9} | {:>6} {:>6} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>6} | {:>6} {:>7} {:>7}",
        "fichier", "année", "read s", "géom s", "enreg", "symb", "élém", "dont m", "reprise", "export", "assem", "éléments", "triangles", "revit", "partiel", "reconst", "inconnu", "sansgéo", "2 faces", "retourn", "invers", "illis.", "ident.", "export", "décodés", "écartés"
    );
    let mut failures = 0;
    let reference = compare_with.as_deref().map(read_fingerprints);
    let mut fingerprint_lines = String::new();
    // Comparaison : éléments source 0 avant, identiques / changés ; ceux qui n'étaient pas en source 0 et le sont maintenant.
    let (mut identical, mut changed, mut gained, mut still, mut other_changes) = (0usize, Vec::new(), 0usize, 0usize, 0usize);
    // Les éléments de la référence qu'on retrouve, pour compter ceux qui ont disparu des fichiers lus.
    let mut found: std::collections::BTreeSet<(String, u64)> = std::collections::BTreeSet::new();
    let mut files_read: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for path in &paths {
        let name = std::path::Path::new(path).file_name().map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                println!("{name:<40} illisible : {error}");
                failures += 1;
                continue;
            }
        };

        let total = if geometry_only {
            None
        } else {
            match read(&bytes, &Options { exhaustive, ..Options::default() }) {
                Ok(output) => {
                    if with_stages {
                        println!("{name:<40} read {:>6.2} s", output.report.seconds);
                        for stage in &output.report.stages {
                            println!("    {:<46} {:>6.2} s", stage.name, stage.seconds);
                        }
                        continue;
                    }
                    Some(output.report.seconds)
                }
                Err(error) => {
                    println!("{name:<40} échec : {error:#}");
                    failures += 1;
                    continue;
                }
            }
        };

        let result = rvt::RevitFile::open_bytes(bytes).map_err(anyhow::Error::from).and_then(|mut file| {
            // L'année de lecture de `read` : l'étiquette de la version, ou à défaut l'empreinte du schéma (Project Vasari).
            let release = revit::native::format_year(&mut file).map(|(year, _)| year);
            let mut context = Context::new(release);
            context.exhaustive = exhaustive;
            context.fingerprints = write_fingerprints.is_some() || compare_with.is_some();
            geometry::build(&mut file, &mut context).map(|geometry| (release, geometry))
        });
        match result {
            Ok((release, geometry)) => {
                let stats = &geometry.stats;
                let mut per_element = vec![0usize; geometry.keys.len()];
                for primitive in geometry.primitives.chunks_exact(6) {
                    per_element[primitive[0] as usize] += primitive[4] as usize / 3;
                }
                for (index, id) in geometry.element_ids.iter().enumerate() {
                    let Some(&(source, hash)) = stats.shapes.get(id) else { continue };
                    let (triangles, id) = (per_element[index], *id);
                    let _ = writeln!(fingerprint_lines, "{name} {id} {source} {triangles} {hash:016x}");
                    if let Some(reference) = &reference {
                        files_read.insert(name.clone());
                        found.insert((name.clone(), id));
                        match reference.get(&(name.clone(), id)) {
                            Some(&(0, old_triangles, old_hash)) if source == 0 && old_hash == hash && old_triangles == triangles => identical += 1,
                            Some(&(0, ..)) => changed.push(format!("{name} {id} (source 0 avant, {source} maintenant, {triangles} triangles)")),
                            Some(&(old, ..)) if old != 0 && source == 0 => gained += 1,
                            Some(&(old, ..)) if old != 0 && old == source => still += 1,
                            _ => other_changes += 1,
                        }
                    }
                }
                println!(
                    "{name:<40} {:>5} {:>7} | {:>6.2} {:>5.2} {:>5.2} {:>5.2} {:>5.2} {:>5.2} {:>6.2} {:>5.2} | {:>7} {:>9} | {:>6} {:>6} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>6} | {:>6} {:>7} {:>7}",
                    release.map_or_else(|| "?".to_string(), |year| year.to_string()),
                    total.map_or_else(|| "-".to_string(), |seconds| format!("{seconds:.2}")),
                    stats.seconds_total,
                    stats.saved.records,
                    stats.saved.symbols,
                    stats.saved.elements,
                    stats.saved.mesh,
                    stats.saved.retake,
                    stats.seconds_export,
                    stats.seconds_pack,
                    geometry.keys.len(),
                    geometry.indices.len() / 3,
                    geometry.counts.revit,
                    geometry.counts.partial,
                    geometry.counts.rebuilt,
                    geometry.counts.unknown,
                    geometry.without_geometry,
                    stats.double_sided_elements,
                    stats.mesh.flips,
                    stats.mesh.inverted,
                    stats.unreadable,
                    stats.identical,
                    if stats.export_needed { "oui" } else { "non" },
                    stats.decoded,
                    stats.skipped,
                );
            }
            Err(error) => {
                println!("{name:<40} échec : {error:#}");
                failures += 1;
            }
        }
    }
    if let Some(path) = &write_fingerprints {
        std::fs::write(path, &fingerprint_lines).expect("écriture des empreintes");
        println!("empreintes écrites dans {path}");
    }
    if reference.is_some() {
        println!("\n== Comparaison avec la référence");
        println!("éléments en source 0 avant et identiques bit à bit : {identical}");
        println!("éléments en source 0 avant et changés : {}", changed.len());
        for line in changed.iter().take(20) {
            println!("  {line}");
        }
        // Un élément de la référence qui n'est plus dessiné (fichiers lus ici seulement).
        let gone: Vec<String> = reference.as_ref().map_or(Vec::new(), |reference| reference.iter().filter(|((file, id), _)| files_read.contains(file) && !found.contains(&(file.clone(), *id))).map(|((file, id), (source, triangles, _))| format!("{file} {id} (source {source}, {triangles} triangles)")).collect());
        println!("éléments de la référence qui ne sont plus dessinés : {}", gone.len());
        for line in gone.iter().take(30) {
            println!("  {line}");
        }
        println!("éléments qui n'étaient pas en source 0 : devenus source 0 : {gained} ; même source : {still} ; autre changement (source, ou élément apparu ou disparu) : {other_changes}");
        if !changed.is_empty() || gone.iter().any(|line| line.contains("(source 0,")) {
            return ExitCode::FAILURE;
        }
    }
    if failures == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
