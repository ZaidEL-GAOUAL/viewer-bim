//! Écrit la sortie brute de `read` pour comparer deux versions du lecteur à une tolérance près :
//! `cargo run --release --example dumpraw -- <dossier de sortie> <fichier.rvt>...`
//!
//! Par fichier : `<nom>.positions` (les positions f32, telles quelles, petit-boutiste) et `<nom>.rest.txt` (origine,
//! nombre d'éléments et de triangles, et une empreinte FNV-1a de chacun des autres tableaux, des clés, des noms, des
//! sources et des métadonnées). Deux lectures dont le `.rest.txt` est identique ne diffèrent que par leurs positions,
//! que l'on compare nombre à nombre (`scripts` de la copie de travail).

use std::fmt::Write as _;

fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).filter(|argument| !argument.rsplit('/').next().is_some_and(|name| name.starts_with("._"))).collect();
    let (out, files) = args.split_first().expect("usage : dumpraw <dossier> <fichier.rvt>...");
    std::fs::create_dir_all(out)?;
    for path in files {
        let name = std::path::Path::new(path).file_stem().map_or_else(|| "sortie".into(), |n| n.to_string_lossy().into_owned());
        let bytes = std::fs::read(path)?;
        let output = match revit::read(&bytes, &revit::Options::default()) {
            Ok(output) => output,
            Err(error) => {
                std::fs::write(format!("{out}/{name}.rest.txt"), format!("échec {error:#}\n"))?;
                continue;
            }
        };
        let positions: Vec<u8> = output.positions.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(format!("{out}/{name}.positions"), &positions)?;
        let mut text = String::new();
        let _ = writeln!(text, "origin {:?}", output.origin);
        let _ = writeln!(text, "elements {} triangles {}", output.keys.len(), output.report.triangles);
        let _ = writeln!(text, "keys {:016x}", hash(output.keys.join("\n").as_bytes()));
        let _ = writeln!(text, "names {:016x}", hash(output.names.join("\n").as_bytes()));
        let _ = writeln!(text, "sources {:016x}", hash(&output.sources));
        let _ = writeln!(text, "normals {:016x}", hash(&output.normals.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()));
        let _ = writeln!(text, "indices {:016x}", hash(&output.indices.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()));
        let _ = writeln!(text, "primitives {:016x}", hash(&output.primitives.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()));
        let _ = writeln!(text, "materials {:016x}", hash(&output.materials));
        let _ = writeln!(text, "metadata {:016x}", hash(output.metadata.as_bytes()));
        std::fs::write(format!("{out}/{name}.rest.txt"), text)?;
    }
    Ok(())
}
