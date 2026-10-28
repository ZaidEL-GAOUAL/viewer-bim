//! La sortie par morceaux (`read_streaming`) redonne exactement la sortie d'un bloc (`read`) : mêmes clés, sources et
//! tableaux une fois les morceaux mis bout à bout, mêmes noms et métadonnées dans le squelette rendu à la fin ; et
//! chaque morceau se tient seul (indices d'élément locaux, table des matériaux qui prolonge celle du morceau
//! précédent, origine commune, un nom provisoire par élément). Les morceaux sont aussi comparés, élément par élément, à
//! la voie par blocs (`geometry::build` : un autre lecteur du fichier, un autre assemblage, les éléments triés par
//! identifiant), et une sortie qui refuse un élément met fin à la lecture avec son erreur.
//!
//! À lancer avec `cargo test --release`. Le fichier d'essai committé (Revit 2023, tests/fixtures) est toujours là ;
//! les fichiers publics viennent de `npm run samples:revit`, et sans eux les essais qui en dépendent sont ignorés.

use std::collections::BTreeMap;
use std::path::PathBuf;

use revit::geometry::{self, Emitted, Geometry};
use revit::{CHUNK_TRIANGLES, Chunk, Context, Options, read, read_streaming};

/// Le fichier de `revit/samples/`, à défaut celui de `tests/fixtures/` (le seul que le dépôt garde).
fn sample(name: &str) -> Option<Vec<u8>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for dir in ["samples", "tests/fixtures"] {
        let path = root.join(dir).join(name);
        if path.exists() {
            return Some(std::fs::read(path).expect("fichier d'essai"));
        }
    }
    eprintln!("{name} absent de revit/samples/ : essai ignoré");
    None
}

/// Lit `bytes` par morceaux et rend les morceaux et la sortie squelette.
fn chunks_of(bytes: &[u8]) -> (Vec<Chunk>, revit::Output) {
    let mut chunks = Vec::new();
    let output = read_streaming(Box::new(std::io::Cursor::new(bytes.to_vec())), &Options::default(), &mut |chunk| {
        chunks.push(chunk);
        Ok(())
    })
    .expect("lecture par morceaux");
    (chunks, output)
}

#[test]
fn les_morceaux_mis_bout_a_bout_redonnent_la_sortie_d_un_bloc() {
    for name in ["Revit_IFC5_Einhoven.rvt", "DynamoSample_2024.rvt", "SampleModel.rvt"] {
        let Some(bytes) = sample(name) else { continue };
        let whole = read(&bytes, &Options::default()).expect("lecture d'un bloc");
        let (chunks, skeleton) = chunks_of(&bytes);
        assert!(skeleton.keys.is_empty() && skeleton.positions.is_empty(), "{name} : le squelette n'a pas de tableaux");
        // Les libellés des fiches et le JSON de métadonnées, connus à la fin, sont ceux du squelette.
        assert_eq!(skeleton.names, whole.names, "{name} : noms");
        assert_eq!(skeleton.metadata, whole.metadata, "{name} : métadonnées");
        assert!(skeleton.metadata_head.is_empty() && skeleton.metadata_tail.is_empty(), "{name} : plus de JSON en trois parts");
        assert_eq!(skeleton.report.elements, whole.report.elements, "{name}");
        assert_eq!(skeleton.report.triangles, whole.report.triangles, "{name}");

        // Remis bout à bout, comme `read_from` et comme le viewer.
        let (mut keys, mut sources, mut positions, mut normals, mut indices, mut primitives) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut materials = Vec::new();
        for chunk in &chunks {
            assert!(!chunk.keys.is_empty(), "{name} : un morceau vide");
            assert_eq!(chunk.origin, whole.origin, "{name} : l'origine est celle du modèle entier");
            // Les indices d'élément sont locaux au morceau ; la table des matériaux prolonge la précédente.
            for primitive in chunk.primitives.chunks_exact(6) {
                assert!((primitive[0] as usize) < chunk.keys.len(), "{name} : indice d'élément hors du morceau");
                assert!((primitive[5] as usize) < chunk.materials.len() / 6, "{name} : matériau hors de la table du morceau");
            }
            assert!(chunk.materials.starts_with(&materials), "{name} : la table des matériaux ne prolonge pas la précédente");
            materials = chunk.materials.clone();
            let (element_base, vertex_base, index_base) = (keys.len() as u32, (positions.len() / 3) as u32, indices.len() as u32);
            for primitive in chunk.primitives.chunks_exact(6) {
                primitives.extend_from_slice(&[element_base + primitive[0], vertex_base + primitive[1], primitive[2], index_base + primitive[3], primitive[4], primitive[5]]);
            }
            // Un nom provisoire par élément (classe et identifiant), en attendant les libellés des fiches.
            assert_eq!(chunk.names.len(), chunk.keys.len(), "{name} : un nom par élément");
            assert!(chunk.names.iter().all(|provisional| !provisional.is_empty()), "{name} : nom vide");
            assert!(chunk.metadata_elements.is_empty(), "{name} : plus de fragment de JSON par morceau");
            keys.extend(chunk.keys.iter().cloned());
            sources.extend(chunk.sources.iter().copied());
            positions.extend(chunk.positions.iter().copied());
            normals.extend(chunk.normals.iter().copied());
            indices.extend(chunk.indices.iter().copied());
        }
        assert_eq!(keys, whole.keys, "{name} : clés");
        assert_eq!(sources, whole.sources, "{name} : sources");
        assert_eq!(positions, whole.positions, "{name} : positions");
        assert_eq!(normals, whole.normals, "{name} : normales");
        assert_eq!(indices, whole.indices, "{name} : indices");
        assert_eq!(primitives, whole.primitives, "{name} : primitives");
        assert_eq!(materials, whole.materials, "{name} : matériaux");
        // Un morceau part dès qu'il atteint le budget : privé de son dernier élément, il lui est inférieur ; et tous, sauf le
        // dernier de la lecture, l'ont atteint.
        for (index, chunk) in chunks.iter().enumerate() {
            let triangles = chunk.indices.len() / 3;
            let last = triangles_per_element(chunk).last().copied().expect("un élément");
            assert!(triangles - last < CHUNK_TRIANGLES, "{name} : morceau de {triangles} triangles dont {last} pour son dernier élément");
            if index + 1 < chunks.len() {
                assert!(triangles >= CHUNK_TRIANGLES, "{name} : le morceau {index} est parti à {triangles} triangles, sous le budget");
            }
        }
        // Les comptes d'éléments sont ceux des morceaux, du rapport, des noms et du JSON de métadonnées.
        let in_chunks: usize = chunks.iter().map(|chunk| chunk.keys.len()).sum();
        assert_eq!(in_chunks, skeleton.report.elements, "{name} : éléments des morceaux et du rapport");
        assert_eq!(in_chunks, skeleton.names.len(), "{name} : éléments des morceaux et noms");
        let metadata: serde_json::Value = serde_json::from_str(&skeleton.metadata).expect("JSON de métadonnées");
        assert_eq!(in_chunks, metadata["elements"].as_object().expect("elements").len(), "{name} : éléments des morceaux et fiches");
        assert_eq!(chunks.iter().map(|chunk| chunk.sources.len()).sum::<usize>(), in_chunks, "{name} : une source par élément");
        let sources = &skeleton.report.sources;
        assert_eq!(sources.revit + sources.partial + sources.rebuilt + sources.unknown, in_chunks, "{name} : sources du rapport");
        assert_eq!(chunks.iter().map(|chunk| chunk.indices.len() / 3).sum::<usize>(), skeleton.report.triangles, "{name} : triangles des morceaux et du rapport");
        if whole.report.triangles > 2 * CHUNK_TRIANGLES {
            assert!(chunks.len() >= 2, "{name} : un fichier de {} triangles devrait donner plusieurs morceaux", whole.report.triangles);
        }
        eprintln!("{name} : {} morceaux pour {} éléments et {} triangles, identiques à la sortie d'un bloc", chunks.len(), whole.keys.len(), whole.report.triangles);
    }
}

/// Les triangles de chaque élément d'un morceau, dans l'ordre de ses clés.
fn triangles_per_element(chunk: &Chunk) -> Vec<usize> {
    let mut triangles = vec![0usize; chunk.keys.len()];
    for primitive in chunk.primitives.chunks_exact(6) {
        triangles[primitive[0] as usize] += primitive[4] as usize / 3;
    }
    triangles
}

/// Ce que chaque élément dessine, indépendamment de la façon dont les tableaux sont assemblés : sa source, ses triangles
/// et sa boîte en coordonnées absolues (les positions sont relatives à `origin`).
type Summary = BTreeMap<String, (u8, usize, [f64; 6])>;

fn summarize(keys: &[String], sources: &[u8], origin: [f64; 3], positions: &[f32], primitives: &[u32], into: &mut Summary) {
    let mut shapes: Vec<(usize, [f64; 6])> = vec![(0, [f64::INFINITY, f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]); keys.len()];
    for primitive in primitives.chunks_exact(6) {
        let (element, first, count) = (primitive[0] as usize, primitive[1] as usize, primitive[2] as usize);
        shapes[element].0 += primitive[4] as usize / 3;
        for vertex in positions[3 * first..3 * (first + count)].chunks_exact(3) {
            for axis in 0..3 {
                let value = f64::from(vertex[axis]) + origin[axis];
                shapes[element].1[axis] = shapes[element].1[axis].min(value);
                shapes[element].1[3 + axis] = shapes[element].1[3 + axis].max(value);
            }
        }
    }
    for (index, key) in keys.iter().enumerate() {
        assert!(into.insert(key.clone(), (sources[index], shapes[index].0, shapes[index].1)).is_none(), "clé en double : {key}");
    }
}

/// Les morceaux de `read_streaming` redonnent, élément par élément, ce que la voie par blocs fabrique : un autre lecteur
/// du fichier (en mémoire, non par tranches), un autre assemblage (un seul morceau, éléments triés par identifiant).
#[test]
fn les_morceaux_dessinent_ce_que_la_voie_par_blocs_dessine() {
    for name in ["Revit_IFC5_Einhoven.rvt", "DynamoSample_2024.rvt", "SampleModel.rvt"] {
        let Some(bytes) = sample(name) else { continue };
        let (chunks, skeleton) = chunks_of(&bytes);
        let mut streamed = Summary::new();
        for chunk in &chunks {
            summarize(&chunk.keys, &chunk.sources, chunk.origin, &chunk.positions, &chunk.primitives, &mut streamed);
        }

        let mut file = rvt::RevitFile::open_bytes(bytes.clone()).expect("fichier Revit");
        let release = revit::native::release(&mut file);
        let blocks: Geometry = geometry::build(&mut file, &mut Context::new(release)).expect("géométrie par blocs");
        let mut block_summary = Summary::new();
        summarize(&blocks.keys, &blocks.sources, blocks.origin, &blocks.positions, &blocks.primitives, &mut block_summary);

        assert_eq!(streamed.len(), blocks.keys.len(), "{name} : éléments");
        assert_eq!(streamed.len(), skeleton.report.elements, "{name} : éléments du rapport");
        assert!(blocks.element_ids.windows(2).all(|pair| pair[0] < pair[1]), "{name} : la voie par blocs trie par identifiant");
        for (key, (source, triangles, bounds)) in &block_summary {
            let (streamed_source, streamed_triangles, streamed_bounds) = streamed.get(key).unwrap_or_else(|| panic!("{name} : {key} absent des morceaux"));
            assert_eq!(source, streamed_source, "{name} : source de {key}");
            assert_eq!(triangles, streamed_triangles, "{name} : triangles de {key}");
            for axis in 0..6 {
                assert!((bounds[axis] - streamed_bounds[axis]).abs() < 2e-3, "{name} : boîte de {key} : {bounds:?} contre {streamed_bounds:?}");
            }
        }
        eprintln!("{name} : {} éléments identiques, morceaux et blocs", streamed.len());
    }
}

/// Une sortie qui refuse un élément met fin à la lecture avec son erreur : ni reprise par l'export IFC (17 à 23 fois la
/// taille du fichier), ni avertissement, ni élément remis après le refus.
#[test]
fn une_sortie_qui_refuse_un_element_met_fin_a_la_lecture() {
    let bytes = sample("Revit_IFC5_Einhoven.rvt").expect("le fichier d'essai committé");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = revit::native::release(&mut file);
    let mut context = Context::new(release);
    let mut calls = 0usize;
    let error = geometry::prepare_streaming(&mut file, &mut context, &mut |_: Emitted| {
        calls += 1;
        if calls == 3 {
            anyhow::bail!("mémoire insuffisante : refus du troisième élément");
        }
        Ok(())
    })
    .map(|_| ())
    .expect_err("la lecture doit échouer");
    assert_eq!(format!("{error:#}"), "mémoire insuffisante : refus du troisième élément", "l'erreur de la sortie, non enrobée");
    assert_eq!(calls, 3, "rien n'est remis après le refus");
    assert!(context.warnings.is_empty(), "aucun avertissement de lecture manquée : {:?}", context.warnings);
    assert!(!context.has_export(), "pas de reconstruction par l'export IFC");
}

#[test]
fn read_streaming_rend_l_erreur_de_la_sortie() {
    let bytes = sample("Revit_IFC5_Einhoven.rvt").expect("le fichier d'essai committé");
    let mut calls = 0usize;
    let error = read_streaming(Box::new(std::io::Cursor::new(bytes)), &Options::default(), &mut |_| {
        calls += 1;
        anyhow::bail!("le morceau n'a pas pu être transmis")
    })
    .map(|_| ())
    .expect_err("une sortie qui refuse met fin à la lecture");
    assert_eq!(format!("{error:#}"), "le morceau n'a pas pu être transmis");
    assert_eq!(calls, 1);
}

/// Si la lecture s'arrête sur une erreur après les enregistrements d'éléments, la scène et les résultats non remis sont
/// rendus à l'appelant (`saved::scan_salvaging`), qui décide de ce qui est déjà lu au lieu de le perdre.
#[test]
fn une_lecture_interrompue_rend_la_scene_et_ce_qui_n_a_pas_ete_remis() {
    use revit::geometry::saved;
    let bytes = sample("Revit_IFC5_Einhoven.rvt").expect("le fichier d'essai committé");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let wanted = |scene: &saved::Scene, _: u64, info: &saved::Info| revit::geometry::classes::excluded(&scene.facts(info)).is_none();
    let work = |_: &saved::Scene, id: u64, _: &rvt::research::native_parameters::ObjectGraph| id;
    let mut offered = Vec::new();
    let mut emit = |_: &saved::Scene, id: u64, _: u64| {
        offered.push(id);
        if offered.len() == 3 {
            anyhow::bail!("remise refusée");
        }
        Ok(())
    };
    let mut failure = None;
    let error = saved::scan_salvaging(&mut file, &wanted, 1, &work, None, &|_| false, Some(&mut emit), saved::Plan::exhaustive(), &mut failure).map(|_| ()).expect_err("la lecture s'arrête");
    assert!(format!("{error:#}").contains("remise refusée"), "{error:#}");
    let failure = failure.expect("la scène est rendue");
    assert!(!failure.scene.infos.is_empty());
    assert_eq!(offered.len(), 3, "le balayage ne remet plus rien après l'erreur de la remise");
}

