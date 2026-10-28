//! Écrit ce que `read` rend pour chaque fichier, pour comparer deux versions du lecteur :
//! `cargo run --release --example dump -- <dossier de sortie> <fichier.rvt>...`
//!
//! Par fichier : `<nom>.metadata.json` (les métadonnées) et `<nom>.txt` (clés, noms, sources et
//! empreintes des tableaux de maillage).

use std::fmt::Write as _;

fn hash(bytes: &[u8]) -> u64 {
    // FNV-1a : suffisant pour voir qu'un tableau a changé.
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (out, files) = args.split_first().expect("usage : dump <dossier> <fichier.rvt>...");
    std::fs::create_dir_all(out)?;
    for path in files {
        let name = std::path::Path::new(path).file_stem().map_or_else(|| "sortie".into(), |n| n.to_string_lossy().into_owned());
        let bytes = std::fs::read(path)?;
        let output = revit::read(&bytes, &revit::Options::default())?;
        std::fs::write(format!("{out}/{name}.metadata.json"), &output.metadata)?;
        let mut text = String::new();
        let _ = writeln!(text, "elements {} triangles {} sans géométrie {}", output.keys.len(), output.report.triangles, output.report.without_geometry);
        let _ = writeln!(text, "sources {:?}", output.report.sources);
        let _ = writeln!(text, "origin {:?}", output.origin);
        for (label, array) in [
            ("positions", bytemuck_f32(&output.positions)),
            ("normals", bytemuck_f32(&output.normals)),
            ("indices", output.indices.iter().flat_map(|v| v.to_le_bytes()).collect()),
            ("primitives", output.primitives.iter().flat_map(|v| v.to_le_bytes()).collect()),
            ("materials", output.materials.clone()),
        ] {
            let _ = writeln!(text, "{label} {} {:016x}", array.len(), hash(&array));
        }
        // Les triangles de surcouche (septième octet des matériaux : l'image d'un contenu RPC, voir `geometry::pack::MATERIAL_STRIDE`).
        let stride = revit::geometry::pack::MATERIAL_STRIDE;
        let overlay: Vec<&[u32]> = output.primitives.chunks_exact(6).filter(|p| output.materials[p[5] as usize * stride + 6] != 0).collect();
        let _ = writeln!(text, "surcouche {} triangles dans {} primitives", overlay.iter().map(|p| p[4] as usize / 3).sum::<usize>(), overlay.len());
        for warning in &output.report.warnings {
            let _ = writeln!(text, "avertissement : {warning}");
        }
        for (i, key) in output.keys.iter().enumerate() {
            let _ = writeln!(text, "{key}\t{}\t{}", output.names[i], output.sources[i]);
        }
        std::fs::write(format!("{out}/{name}.txt"), text)?;
        println!("{name}: {} éléments, {:.2} s", output.keys.len(), output.report.seconds);
    }
    Ok(())
}

fn bytemuck_f32(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}
