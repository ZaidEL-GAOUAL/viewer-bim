//! Écrit en GLB (mètres, Y vers le haut, comme le viewer) la forme d'éléments choisis d'un fichier
//! Revit, pour la regarder dans n'importe quelle visionneuse glTF :
//!
//! ```text
//! cargo run --release --example glb -- <fichier.rvt> [--element 123,456] [--classe SWall,Floor]
//!                                      [--marquer] [--sortie forme.glb]
//! ```
//!
//! * `--element` : identifiants Revit (ElementId) ; `--classe` : classes Revit (`SWall`,
//!   `FamilyInstance`…) ; sans l'un ni l'autre, tous les éléments dessinés. Les deux se cumulent.
//! * `--marquer` : colore en magenta les faces maillées par `geometry::faces` (rvt-rs les refusait)
//!   et en gris les autres, au lieu des couleurs des matériaux de Revit.
//! * `--sortie` : fichier écrit (par défaut `forme.glb`).
//!
//! Les éléments passent par la même chaîne que la lecture complète (mêmes règles de dessin, mêmes
//! soudures, même changement de repère) ; la position des sommets est relative à l'origine du
//! modèle, indiquée dans `scene.extras.origine` (mètres, Y vers le haut).

use std::collections::BTreeSet;
use std::process::ExitCode;

use revit::geometry::faces;
use revit::geometry::pack::{ElementMesh, Face, Paint};
use revit::geometry::{classes, pack, saved};
use rvt::research::native_parameters::ObjectGraph;
use serde_json::json;

fn main() -> ExitCode {
    let mut path = None;
    let mut ids: BTreeSet<u64> = BTreeSet::new();
    let mut wanted_classes: BTreeSet<String> = BTreeSet::new();
    let mut mark = false;
    let mut output = "forme.glb".to_string();
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--element" => ids.extend(arguments.next().unwrap_or_default().split(',').filter_map(|id| id.trim().parse::<u64>().ok())),
            "--classe" => wanted_classes.extend(arguments.next().unwrap_or_default().split(',').map(|class| class.trim().to_string()).filter(|class| !class.is_empty())),
            "--marquer" => mark = true,
            "--sortie" => output = arguments.next().unwrap_or(output),
            other if !other.starts_with("--") && path.is_none() => path = Some(other.to_string()),
            other => {
                eprintln!("argument inconnu : {other}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(path) = path else {
        eprintln!("usage : cargo run --release --example glb -- <fichier.rvt> [--element 123,456] [--classe SWall,Floor] [--marquer] [--sortie forme.glb]");
        return ExitCode::from(2);
    };
    let everything = ids.is_empty() && wanted_classes.is_empty();

    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("{path} : illisible ({error})");
            return ExitCode::FAILURE;
        }
    };
    let mut file = match rvt::RevitFile::open_bytes(bytes) {
        Ok(file) => file,
        Err(error) => {
            eprintln!("{path} : {error}");
            return ExitCode::FAILURE;
        }
    };

    let wanted = |scene: &saved::Scene, id: u64, info: &saved::Info| {
        classes::excluded(&scene.facts(info)).is_none() && (everything || ids.contains(&id) || wanted_classes.contains(&info.class))
    };
    let work = |scene: &saved::Scene, id: u64, graph: &ObjectGraph| -> (ElementMesh, usize, usize, usize) {
        if !mark {
            let shape = saved::shape(scene, id, graph);
            return (shape.mesh, shape.unbounded_faces, shape.diagnostics.len(), 0);
        }
        let meshes = faces::graphics(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
        let ours = Paint::from_srgb([1.0, 0.0, 0.8], 1.0);
        let others = Paint::from_srgb([0.62, 0.62, 0.62], 1.0);
        let list: Vec<Face<'_>> = meshes
            .primitives
            .iter()
            .zip(&meshes.ours)
            .map(|(primitive, own)| Face { vertices: &primitive.vertices, normals: Some(&primitive.normals), triangles: &primitive.triangles, paint: if *own { ours } else { others }, overlay: false })
            .collect();
        let own: usize = meshes.primitives.iter().zip(&meshes.ours).filter(|(_, own)| **own).map(|(primitive, _)| primitive.triangles.len()).sum();
        (ElementMesh::build(&list), meshes.unbounded_faces, meshes.diagnostics.len(), own)
    };
    let scan = match saved::scan(&mut file, &wanted, 1, &work) {
        Ok(scan) => scan,
        Err(error) => {
            eprintln!("{path} : {error:#}");
            return ExitCode::FAILURE;
        }
    };

    let mut names: Vec<String> = Vec::new();
    let mut meshes: Vec<ElementMesh> = Vec::new();
    for (id, result) in scan.results {
        let Some((mesh, unbounded, diagnostics, own)) = result else {
            eprintln!("élément {id} : graphe illisible");
            continue;
        };
        if mesh.is_empty() {
            eprintln!("élément {id} : aucune forme");
            continue;
        }
        let class = scan.scene.infos.get(&id).map_or("?", |info| info.class.as_str());
        eprintln!("élément {id} ({class}) : {} triangles{}{}{}", mesh.triangles(), if own > 0 { format!(" (dont {own} du module des faces)") } else { String::new() }, if unbounded > 0 { format!(", {unbounded} faces non maillées") } else { String::new() }, if diagnostics > 0 { format!(", {diagnostics} diagnostics") } else { String::new() });
        names.push(format!("{class} {id}"));
        meshes.push(mesh);
    }
    if meshes.is_empty() {
        eprintln!("rien à écrire");
        return ExitCode::FAILURE;
    }
    let packed = pack::pack(meshes);
    let glb = glb(&names, &packed);
    if let Err(error) = std::fs::write(&output, &glb) {
        eprintln!("{output} : écriture impossible ({error})");
        return ExitCode::FAILURE;
    }
    println!("{output} : {} éléments, {} triangles, {:.1} Ko", names.len(), packed.indices.len() / 3, glb.len() as f64 / 1024.0);
    ExitCode::SUCCESS
}

/// Les octets d'un fichier GLB : un nœud et un maillage par élément, une primitive par couleur.
fn glb(names: &[String], packed: &pack::Packed) -> Vec<u8> {
    let positions: Vec<u8> = packed.positions.iter().flat_map(|v| v.to_le_bytes()).collect();
    let normals: Vec<u8> = packed.normals.iter().flat_map(|v| v.to_le_bytes()).collect();
    let indices: Vec<u8> = packed.indices.iter().flat_map(|v| v.to_le_bytes()).collect();
    let (normals_at, indices_at) = (positions.len(), positions.len() + normals.len());

    let linear = |byte: u8| {
        let c = f64::from(byte) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let materials: Vec<_> = packed
        .materials
        .chunks_exact(6)
        .map(|row| {
            json!({
                "pbrMetallicRoughness": { "baseColorFactor": [linear(row[0]), linear(row[1]), linear(row[2]), f64::from(row[3]) / 255.0], "metallicFactor": 0.0, "roughnessFactor": 0.9 },
                "alphaMode": if row[4] == 1 { "BLEND" } else { "OPAQUE" },
                "doubleSided": row[5] == 1,
            })
        })
        .collect();

    let mut accessors = Vec::new();
    let mut element_primitives: Vec<Vec<serde_json::Value>> = vec![Vec::new(); names.len()];
    for row in packed.primitives.chunks_exact(6) {
        let [element, vertex_start, vertex_count, index_start, index_count, material] = [row[0] as usize, row[1] as usize, row[2] as usize, row[3] as usize, row[4] as usize, row[5] as usize];
        let slice = &packed.positions[vertex_start * 3..(vertex_start + vertex_count) * 3];
        let (mut low, mut high) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for p in slice.chunks_exact(3) {
            for k in 0..3 {
                low[k] = low[k].min(p[k]);
                high[k] = high[k].max(p[k]);
            }
        }
        let first = accessors.len();
        accessors.push(json!({ "bufferView": 0, "byteOffset": vertex_start * 12, "componentType": 5126, "count": vertex_count, "type": "VEC3", "min": low, "max": high }));
        accessors.push(json!({ "bufferView": 1, "byteOffset": vertex_start * 12, "componentType": 5126, "count": vertex_count, "type": "VEC3" }));
        accessors.push(json!({ "bufferView": 2, "byteOffset": index_start * 4, "componentType": 5125, "count": index_count, "type": "SCALAR" }));
        element_primitives[element].push(json!({ "attributes": { "POSITION": first, "NORMAL": first + 1 }, "indices": first + 2, "material": material, "mode": 4 }));
    }
    let meshes: Vec<_> = element_primitives.into_iter().zip(names).map(|(primitives, name)| json!({ "name": name, "primitives": primitives })).collect();
    let nodes: Vec<_> = names.iter().enumerate().map(|(i, name)| json!({ "name": name, "mesh": i })).collect();
    let document = json!({
        "asset": { "version": "2.0", "generator": "viewer-bim-revit examples/glb" },
        "scene": 0,
        "scenes": [{ "nodes": (0..names.len()).collect::<Vec<_>>(), "extras": { "origine": packed.origin } }],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": positions.len(), "target": 34962 },
            { "buffer": 0, "byteOffset": normals_at, "byteLength": normals.len(), "target": 34962 },
            { "buffer": 0, "byteOffset": indices_at, "byteLength": indices.len(), "target": 34963 },
        ],
        "buffers": [{ "byteLength": positions.len() + normals.len() + indices.len() }],
    });

    let mut json_bytes = serde_json::to_vec(&document).expect("JSON glTF");
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }
    let mut binary: Vec<u8> = [positions, normals, indices].concat();
    while binary.len() % 4 != 0 {
        binary.push(0);
    }
    let total = 12 + 8 + json_bytes.len() + 8 + binary.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(binary.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&binary);
    out
}
