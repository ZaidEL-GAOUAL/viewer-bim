//! Contrôle de `geometry::faces` sur des fichiers Revit : `cargo run --release --example faces -- <fichier.rvt>...`
//!
//! 1. Exactitude des formules de surface : écart, par couple de classes de surfaces voisines, entre
//!    les deux évaluations des points d'arêtes que Revit enregistre (`faces::check::edge_fit`).
//! 2. Lecture des contours et triangulation, sur toutes les faces : aire du module comparée à celle
//!    de rvt-rs quand il maille la face (`compare_with_rvt`), et écart des triangles à la surface
//!    (`chord_deviation`).
//! 3. Sens des triangles voisins : arêtes parcourues en sens opposés (cohérentes) ou dans le même
//!    sens (face retournée), pour tous les triangles puis pour ceux des faces du module.
//! 4. Triangles ajoutés par le module et temps de maillage.
//! 5. Empreintes (`--empreintes <fichier>`) : par fichier et par élément, une empreinte exacte (bit à
//!    bit) des primitives que rend `faces::graphics` et le nombre de diagnostics. `--comparer
//!    <fichier>` relit un fichier d'empreintes écrit par une version précédente et vérifie que chaque
//!    élément qui n'avait aucun diagnostic donne exactement les mêmes primitives : ce qui était
//!    déjà lu en entier ne change pas. Les éléments qui changent (diagnostics en moins) sont
//!    comptés à part.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::Instant;

use revit::geometry::faces::check::{EdgeFit, Orientation, chord_deviation, compare_with_rvt, edge_fit, orientation};
use revit::geometry::faces::{self, Meshes};
use revit::geometry::{classes, saved};
use rvt::research::native_parameters::ObjectGraph;

/// Faces, triangles, triangles à plus d'un millimètre de la surface, pire écart (pieds).
type Deviation = (usize, usize, usize, f64);
/// Faces, somme des écarts relatifs d'aire, pire écart relatif, faces à plus de 1 %.
type Areas = (usize, f64, f64, usize);

/// Passe les faces d'un graphe aux contrôles de forme.
fn visit(graph: &ObjectGraph, deviations: &mut BTreeMap<String, Deviation>, areas: &mut BTreeMap<String, Areas>) {
    for face in (0..graph.objects.len()).filter(|&i| graph.objects[i].class_name == "Face") {
        if let Some((worst, over, count)) = chord_deviation(graph, face) {
            let entry = deviations.entry(faces::surface_class(graph, face)).or_default();
            entry.0 += 1;
            entry.1 += count;
            entry.2 += over;
            entry.3 = entry.3.max(worst);
        }
        if let Some((surface, ours, reference)) = compare_with_rvt(graph, face) {
            let relative = (ours - reference).abs() / reference.max(1e-12);
            let entry = areas.entry(surface).or_default();
            entry.0 += 1;
            entry.1 += relative;
            entry.2 = entry.2.max(relative);
            entry.3 += usize::from(relative > 0.01);
        }
    }
}

/// Empreinte exacte (FNV-1a sur les bits) des primitives d'un élément.
fn fingerprint(meshes: &Meshes) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut feed = |word: u64| {
        for byte in word.to_le_bytes() {
            hash = (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
        }
    };
    for primitive in &meshes.primitives {
        feed(primitive.source_owner_id.map_or(u64::MAX, |id| id));
        feed(primitive.face_tag as u64);
        feed(primitive.render_style_id as u64);
        feed(primitive.material_id.map_or(u64::MAX, |id| id as u64));
        for vertex in &primitive.vertices {
            vertex.iter().for_each(|c| feed(c.to_bits()));
        }
        for normal in &primitive.normals {
            normal.iter().for_each(|c| feed(c.to_bits()));
        }
        for triangle in &primitive.triangles {
            triangle.iter().for_each(|c| feed(u64::from(*c)));
        }
        feed(u64::MAX - 1);
    }
    hash
}

/// Les empreintes d'un fichier écrit par `--empreintes` : (fichier, élément) → (empreinte, diagnostics).
fn read_fingerprints(path: &str) -> BTreeMap<(String, u64), (u64, usize)> {
    let text = std::fs::read_to_string(path).expect("fichier d'empreintes illisible");
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let (name, id, hash, diagnostics) = (fields.next()?, fields.next()?, fields.next()?, fields.next()?);
            Some(((name.to_string(), id.parse().ok()?), (u64::from_str_radix(hash, 16).ok()?, diagnostics.parse().ok()?)))
        })
        .collect()
}

fn main() {
    let mut write_fingerprints: Option<String> = None;
    let mut compare_with: Option<String> = None;
    let mut arguments = std::env::args().skip(1);
    let mut paths: Vec<String> = Vec::new();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--empreintes" => write_fingerprints = arguments.next(),
            "--comparer" => compare_with = arguments.next(),
            _ if argument.rsplit('/').next().is_some_and(|name| name.starts_with("._")) => {}
            _ => paths.push(argument),
        }
    }
    if paths.is_empty() {
        eprintln!("usage : cargo run --release --example faces -- [--empreintes <sortie>] [--comparer <référence>] <fichier.rvt>...");
        std::process::exit(2);
    }
    let reference = compare_with.as_deref().map(read_fingerprints);
    let mut fingerprint_lines = String::new();
    // Éléments dont l'empreinte change alors qu'ils n'avaient aucun diagnostic (à zéro), ceux qui
    // gagnent ou perdent des diagnostics, et ceux qui n'existent plus ou sont nouveaux.
    let (mut changed_clean, mut fixed, mut worse, mut identical, mut missing, mut unchanged_incomplete) = (Vec::new(), 0usize, 0usize, 0usize, 0usize, 0usize);
    let mut fits: BTreeMap<String, EdgeFit> = BTreeMap::new();
    let mut deviations: BTreeMap<String, Deviation> = BTreeMap::new();
    let mut areas: BTreeMap<String, Areas> = BTreeMap::new();
    let mut totals = [Orientation::default(); 2];
    let (mut own_triangles, mut all_triangles, mut seconds) = (0usize, 0usize, 0.0f64);
    for path in &paths {
        let name = path.rsplit('/').next().unwrap_or(path);
        let Ok(bytes) = std::fs::read(path) else { continue };
        let Ok(mut file) = rvt::RevitFile::open_bytes(bytes) else { continue };
        // Tous les fichiers que la lecture native sait lire (2015 à 2027) : Vignette-04, mega et rac sont d'avant 2023.
        if !file.basic_file_info().ok().is_some_and(|info| revit::native::SUPPORTED_RELEASES.contains(&info.version)) {
            continue;
        }
        let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let work = |scene: &saved::Scene, _id: u64, graph: &ObjectGraph| {
            let mut local_fits = BTreeMap::new();
            edge_fit(graph, &mut local_fits);
            let (mut local_deviations, mut local_areas) = (BTreeMap::new(), BTreeMap::new());
            visit(graph, &mut local_deviations, &mut local_areas);
            let clock = Instant::now();
            let meshes: Meshes = faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
            let elapsed = clock.elapsed().as_secs_f64();
            let orient = orientation(&meshes.primitives, &meshes.ours);
            let own: usize = meshes.primitives.iter().zip(&meshes.ours).filter(|(_, own)| **own).map(|(p, _)| p.triangles.len()).sum();
            let all: usize = meshes.primitives.iter().map(|p| p.triangles.len()).sum();
            let diagnostics = meshes.diagnostics.len() + meshes.unbounded_faces;
            (local_fits, local_deviations, local_areas, orient, own, all, elapsed, fingerprint(&meshes), diagnostics)
        };
        let Ok(scan) = saved::scan(&mut file, &wanted, 1, &work) else { continue };
        // Les formes des familles vivent dans les graphes des symboles que les instances placent.
        for graph in scan.scene.symbols.values() {
            edge_fit(graph, &mut fits);
            visit(graph, &mut deviations, &mut areas);
        }
        let mut per_file = [Orientation::default(); 2];
        for (id, result) in scan.results {
            let Some((local_fits, local_deviations, local_areas, orient, own, all, elapsed, hash, diagnostics)) = result else { continue };
            let _ = writeln!(fingerprint_lines, "{name} {id} {hash:016x} {diagnostics}");
            if let Some(reference) = &reference {
                match reference.get(&(name.to_string(), id)) {
                    None => missing += 1,
                    Some(&(old_hash, 0)) if old_hash == hash && diagnostics == 0 => identical += 1,
                    Some(&(_, 0)) => changed_clean.push(format!("{name} {id} ({diagnostics} diagnostics)")),
                    Some(&(_, old)) if diagnostics < old => fixed += 1,
                    Some(&(_, old)) if diagnostics > old => worse += 1,
                    Some(_) => unchanged_incomplete += 1,
                }
            }
            for (key, fit) in local_fits {
                let entry = fits.entry(key).or_default();
                entry.samples += fit.samples;
                entry.worst = entry.worst.max(fit.worst);
                entry.sum += fit.sum;
                entry.over_millimetre += fit.over_millimetre;
            }
            for (key, value) in local_deviations {
                let entry = deviations.entry(key).or_default();
                (entry.0, entry.1, entry.2, entry.3) = (entry.0 + value.0, entry.1 + value.1, entry.2 + value.2, entry.3.max(value.3));
            }
            for (key, value) in local_areas {
                let entry = areas.entry(key).or_default();
                (entry.0, entry.1, entry.2, entry.3) = (entry.0 + value.0, entry.1 + value.1, entry.2.max(value.2), entry.3 + value.3);
            }
            for k in 0..2 {
                per_file[k].opposed += orient[k].opposed;
                per_file[k].same += orient[k].same;
            }
            own_triangles += own;
            all_triangles += all;
            seconds += elapsed;
        }
        println!("{name} : arêtes cohérentes {} / retournées {} ; avec une face du module : {} / {}", per_file[0].opposed, per_file[0].same, per_file[1].opposed, per_file[1].same);
        for k in 0..2 {
            totals[k].opposed += per_file[k].opposed;
            totals[k].same += per_file[k].same;
        }
    }
    println!("\n== Écart des points d'arêtes entre les deux surfaces voisines (pieds ; 0,00328 = 1 mm)");
    println!("{:<28} {:>9} {:>11} {:>11} {:>8}", "couple", "points", "pire", "moyen", "> 1 mm");
    for (key, fit) in &fits {
        println!("{key:<28} {:>9} {:>11.2e} {:>11.2e} {:>8}", fit.samples, fit.worst, fit.sum / fit.samples.max(1) as f64, fit.over_millimetre);
    }
    println!("\n== Aire des faces que rvt-rs et le module maillent tous les deux (écart relatif)");
    println!("{:<14} {:>8} {:>11} {:>11} {:>9}", "surface", "faces", "moyen", "pire", "> 1 %");
    for (key, (count, sum, worst, over)) in &areas {
        println!("{key:<14} {count:>8} {:>11.2e} {worst:>11.2e} {over:>9}", sum / (*count).max(1) as f64);
    }
    println!("\n== Écart des triangles du module à leur surface, au centre de chaque triangle (pieds)");
    println!("{:<14} {:>8} {:>10} {:>11} {:>8}", "surface", "faces", "triangles", "pire", "> 1 mm");
    for (key, (count, triangles, over, worst)) in &deviations {
        println!("{key:<14} {count:>8} {triangles:>10} {worst:>11.2e} {over:>8}");
    }
    println!("\n== Sens des triangles voisins");
    println!("toutes les arêtes partagées : {} cohérentes, {} dans le même sens ({:.3} %)", totals[0].opposed, totals[0].same, 100.0 * totals[0].same as f64 / (totals[0].opposed + totals[0].same).max(1) as f64);
    println!("arêtes touchant une face du module : {} cohérentes, {} dans le même sens ({:.3} %)", totals[1].opposed, totals[1].same, 100.0 * totals[1].same as f64 / (totals[1].opposed + totals[1].same).max(1) as f64);
    println!("\ntriangles du module : {own_triangles} sur {all_triangles} ; temps de maillage : {seconds:.2} s");

    if let Some(path) = &write_fingerprints {
        std::fs::write(path, &fingerprint_lines).expect("écriture des empreintes");
        println!("\nempreintes écrites dans {path}");
    }
    if reference.is_some() {
        println!("\n== Comparaison avec la référence");
        println!("éléments lus en entier avant et identiques bit à bit : {identical}");
        println!("éléments lus en entier avant et qui ont changé : {}", changed_clean.len());
        for line in changed_clean.iter().take(20) {
            println!("  {line}");
        }
        println!("éléments qui avaient des diagnostics et en ont moins : {fixed} ; autant : {unchanged_incomplete} ; plus : {worse} ; absents de la référence : {missing}");
        if !changed_clean.is_empty() {
            std::process::exit(1);
        }
    }
}
