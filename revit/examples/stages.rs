//! Mesure le coût de chaque étape de rvt-rs, chacune sur un fichier fraîchement ouvert (sans le
//! cache des flux décompressés laissé par une autre), puis enchaînées sur le même fichier.
//!
//! `cargo run --release --example stages -- revit/samples/2024_Core_Interior.rvt`

use rvt::research::{native_document, native_element_parameters, native_saved_scene, revit_global_ids};
use std::collections::BTreeSet;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path)?;
        let open = || rvt::RevitFile::open_bytes(bytes.clone());
        println!("== {path} ({:.1} Mo)", bytes.len() as f64 / 1e6);

        let t = Instant::now();
        let mut file = open()?;
        let release = file.basic_file_info()?.version;
        println!("ouverture + version {release}: {:.2} s", t.elapsed().as_secs_f64());

        let t = Instant::now();
        let ids = revit_global_ids::revit_global_ids(&mut open()?)?;
        println!("GlobalIds ({}): {:.2} s", ids.len(), t.elapsed().as_secs_f64());

        let t = Instant::now();
        let scene = native_saved_scene::extract(&mut open()?, &native_document::Options::default());
        let roots: BTreeSet<u64> = match &scene {
            Ok(scene) => {
                let triangles: usize =
                    scene.elements.iter().flat_map(|e| &e.meshes.primitives).map(|p| p.triangles.len()).sum();
                let partial = scene.elements.iter().filter(|e| e.status != "decoded_saved_graphics").count();
                println!(
                    "formes enregistrées ({} éléments, {partial} partiels, {triangles} triangles): {:.2} s",
                    scene.elements.len(),
                    t.elapsed().as_secs_f64()
                );
                scene.elements.iter().map(|e| e.id).collect()
            }
            Err(error) => {
                println!("formes enregistrées: échec {error:#} ({:.2} s)", t.elapsed().as_secs_f64());
                BTreeSet::new()
            }
        };

        let t = Instant::now();
        let parameters = native_element_parameters::read(&mut open()?, &roots)?;
        let count: usize = parameters.elements.values().map(Vec::len).sum();
        println!("paramètres ({count} valeurs): {:.2} s", t.elapsed().as_secs_f64());

        let t = Instant::now();
        let export = rvt::ifc::RvtDocExporter
            .export_with_diagnostics_and_limits(&mut open()?, rvt::walker::WalkerLimits::default())?;
        println!("export IFC de rvt-rs ({} entités): {:.2} s", export.model.entities.len(), t.elapsed().as_secs_f64());

        let t = Instant::now();
        let mut file = open()?;
        let _ = revit_global_ids::revit_global_ids(&mut file)?;
        let scene = native_saved_scene::extract(&mut file, &native_document::Options::default());
        let _ = native_element_parameters::read(&mut file, &roots)?;
        println!(
            "enchaînés sans l'export IFC (formes {}): {:.2} s",
            if scene.is_ok() { "lues" } else { "absentes" },
            t.elapsed().as_secs_f64()
        );

        // Le module de géométrie du viewer : formes enregistrées en trois passes, export IFC
        // seulement pour les éléments illisibles ou les fichiers d'avant 2023.
        let t = Instant::now();
        let mut file = open()?;
        let mut context = revit::Context::new(Some(release));
        let geometry = revit::geometry::build(&mut file, &mut context)?;
        println!(
            "géométrie du viewer ({} éléments, {} triangles, export IFC {}): {:.2} s",
            geometry.keys.len(),
            geometry.indices.len() / 3,
            if context.has_export() { "oui" } else { "non" },
            t.elapsed().as_secs_f64()
        );
    }
    Ok(())
}
