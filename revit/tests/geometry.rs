//! La géométrie sur le fichier d'essai commité (Revit 2023, licence MIT, voir tests/fixtures) et,
//! quand `revit/samples/` existe (scripts/fetch-revit-samples.mjs), sur Core Interior 2024 et
//! DynamoSample 2024. Sans les fichiers publics, ces deux derniers essais passent sans rien faire.
//!
//! À lancer avec `cargo test --release` : en débogage, le décodage de Core Interior est long.

use std::collections::HashSet;
use std::path::PathBuf;

use revit::geometry::pack::MATERIAL_STRIDE;
use revit::geometry::{self, Geometry};
use revit::Context;

fn crate_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn build_with_warnings(path: &PathBuf) -> (Option<u32>, Geometry, Vec<String>) {
    let bytes = std::fs::read(path).expect("fichier d'essai illisible");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = file.basic_file_info().ok().map(|info| info.version);
    let mut context = Context::new(release);
    let geometry = geometry::build(&mut file, &mut context).expect("géométrie");
    (release, geometry, context.warnings)
}

fn build(path: &PathBuf) -> (Option<u32>, Geometry) {
    let (release, geometry, _) = build_with_warnings(path);
    (release, geometry)
}

/// Les invariants du contrat, sur n'importe quel fichier. Rend la part de triangles dont le sens
/// s'accorde avec leurs normales.
fn check(geometry: &Geometry) -> f64 {
    let elements = geometry.keys.len();
    assert!(elements > 0, "aucun élément dessiné");
    assert_eq!(geometry.names.len(), elements);
    assert_eq!(geometry.element_ids.len(), elements);
    assert_eq!(geometry.sources.len(), elements);
    assert!(geometry.sources.iter().all(|source| *source <= 3));

    // Les quatre origines recouvrent exactement les éléments dessinés.
    let counts = &geometry.counts;
    assert_eq!(counts.revit + counts.partial + counts.rebuilt + counts.unknown, elements);
    for (origin, expected) in [(0u8, counts.revit), (1, counts.partial), (2, counts.rebuilt), (3, counts.unknown)] {
        assert_eq!(geometry.sources.iter().filter(|source| **source == origin).count(), expected);
    }

    // Clés uniques, éléments dans l'ordre de leur ElementId.
    let keys: HashSet<&String> = geometry.keys.iter().collect();
    assert_eq!(keys.len(), elements, "clés en double");
    assert!(geometry.element_ids.windows(2).all(|pair| pair[0] < pair[1]), "éléments non triés par ElementId");

    // Aucune valeur non finie ; normales unitaires.
    assert!(geometry.origin.iter().all(|value| value.is_finite()));
    assert!(geometry.positions.iter().all(|value| value.is_finite()));
    assert!(geometry.normals.iter().all(|value| value.is_finite()));
    assert_eq!(geometry.positions.len() % 3, 0);
    assert_eq!(geometry.normals.len(), geometry.positions.len());
    for normal in geometry.normals.chunks_exact(3).step_by(97) {
        let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
        assert!((length - 1.0).abs() < 1e-3, "normale non unitaire : {length}");
    }

    // Primitives : bornes, matériaux, indices locaux, sans triangle en double.
    assert_eq!(geometry.indices.len() % 3, 0);
    assert_eq!(geometry.primitives.len() % 6, 0);
    assert_eq!(geometry.materials.len() % MATERIAL_STRIDE, 0);
    let vertices = geometry.positions.len() / 3;
    let materials = geometry.materials.len() / MATERIAL_STRIDE;
    assert!(geometry.materials.chunks_exact(MATERIAL_STRIDE).all(|row| row[4] <= 1 && row[5] <= 1 && row[6] <= 2 && (row[4] == 1) == (row[3] < 255)));
    let mut drawn = vec![false; elements];
    let (mut agreeing, mut total) = (0usize, 0usize);
    for primitive in geometry.primitives.chunks_exact(6) {
        let [element, vertex_start, vertex_count, index_start, index_count, material] = primitive else { unreachable!() };
        assert!((*element as usize) < elements);
        drawn[*element as usize] = true;
        assert!((*vertex_start + *vertex_count) as usize <= vertices);
        assert!((*material as usize) < materials);
        assert!(*index_count > 0 && index_count % 3 == 0);
        let indices = &geometry.indices[*index_start as usize..(*index_start + *index_count) as usize];
        assert!(indices.iter().all(|index| index < vertex_count), "indice hors de sa primitive");

        let mut seen: HashSet<[u32; 3]> = HashSet::new();
        for triangle in indices.chunks_exact(3) {
            let corners = [triangle[0], triangle[1], triangle[2]];
            let canonical = *[corners, [corners[1], corners[2], corners[0]], [corners[2], corners[0], corners[1]]].iter().min().unwrap();
            assert!(seen.insert(canonical), "triangle en double dans une primitive");

            let at = |corner: u32| {
                let base = (*vertex_start + corner) as usize * 3;
                let position = [geometry.positions[base] as f64, geometry.positions[base + 1] as f64, geometry.positions[base + 2] as f64];
                let normal = [geometry.normals[base] as f64, geometry.normals[base + 1] as f64, geometry.normals[base + 2] as f64];
                (position, normal)
            };
            let (a, na) = at(corners[0]);
            let (b, nb) = at(corners[1]);
            let (c, nc) = at(corners[2]);
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let geometric = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            let mean = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
            total += 1;
            if geometric[0] * mean[0] + geometric[1] * mean[1] + geometric[2] * mean[2] >= 0.0 {
                agreeing += 1;
            }
        }
    }
    assert!(drawn.iter().all(|drawn| *drawn), "un élément n'a aucune primitive");
    assert_eq!(total, geometry.indices.len() / 3);
    agreeing as f64 / total.max(1) as f64
}

#[test]
fn le_fichier_d_essai_donne_une_geometrie_coherente() {
    let (release, geometry) = build(&crate_path("tests/fixtures/Revit_IFC5_Einhoven.rvt"));
    assert_eq!(release, Some(2023));
    let agreement = check(&geometry);
    assert!(agreement >= 0.99, "sens des triangles : {agreement}");
    // Revit 2023 : les formes enregistrées suffisent, l'export IFC n'est pas calculé.
    assert!(!geometry.stats.export_needed);
}

fn sample(name: &str) -> Option<PathBuf> {
    let path = crate_path(&format!("samples/{name}"));
    path.exists().then_some(path)
}

#[test]
fn core_interior_2024() {
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let (release, geometry) = build(&path);
    assert_eq!(release, Some(2024));
    let agreement = check(&geometry);
    assert!(agreement >= 0.99, "sens des triangles : {agreement}");
    let counts = geometry.counts;
    let drawn = geometry.keys.len();
    // « Forme Revit » tout court (source 0) pour chacun des 856 éléments : toutes les faces à dessiner se
    // maillent (rvt-rs, puis `geometry::faces`), les 1 338 plans sans contour de ses murs et de ses
    // poteaux ne sont pas des faces à dessiner (des faces de référence : chaque élément est déjà une
    // coque fermée sans elles), et la topographie 21974, dont les deux GPolyMesh ont une normale par
    // sommet, se lit aussi (elle était une boîte avant que le parcours des graphiques lise ce cas). Avec
    // rvt-rs seul, 493 des 855 éléments étaient « partiels ».
    assert_eq!((counts.revit, counts.partial, counts.rebuilt, counts.unknown), (856, 0, 0, 0), "sources");
    // Ce que dessine une vue 3D de Revit, une fois chaque chose : les 854 éléments que l'export IFC
    // de Revit contient (360 murs, 394 instances de famille — 132 portes, 256 poteaux, 6 fenêtres —,
    // 99 sols et 1 terrassement de bâtiment) et la topographie, que l'IFC porte par le site : deux
    // `SiteSurface`, celle qui était lue d'emblée et celle de l'identifiant 21974. Pas les 12 673
    // éléments des définitions de groupe (« non placés »), qui doublent ceux du modèle, ni pièces,
    // niveaux, trames, types et symboles.
    let count = |class: &str| geometry.names.iter().filter(|name| name.starts_with(&format!("{class} "))).count();
    assert_eq!(count("SWall"), 360);
    assert_eq!(count("FamilyInstance"), 394);
    assert_eq!(count("Floor"), 99);
    assert_eq!(count("BuildingPad"), 1);
    assert_eq!(count("SiteSurface"), 2);
    assert_eq!(drawn, 856);
    assert!(geometry.indices.len() / 3 < 40_000, "triangles : {}", geometry.indices.len() / 3);
    assert_eq!(geometry.without_geometry, 0);
    // Les seuls éléments qui dessinent les mêmes triangles qu'un autre sont des doublons du modèle
    // lui-même (sols identiques au même endroit, que Revit signale et exporte tous).
    assert_eq!(geometry.stats.identical, 26);
    // Vitesse : pas d'export IFC pour quelques éléments illisibles.
    assert!(!geometry.stats.export_needed);
}

/// Tous les fichiers de Revit 2023 et plus dont on dispose : chaque élément dessiné a sa forme Revit
/// (source 0), sans reconstruction ni boîte, et l'export IFC n'est jamais calculé. Avant le parcours
/// des graphiques de `geometry::faces::select`, source 0/1/3 : Dynamo 244/8/5, RE1-Architecture 70/3/0,
/// RE1-Electrical 25/24/21, Core Interior 855/0/1.
#[test]
fn tous_les_fichiers_2023_et_plus_ont_la_forme_revit_de_chaque_element() {
    // (fichier, éléments dessinés, éléments sans géométrie).
    let expected: [(&str, usize, usize); 11] = [
        ("DynamoSample_2023.rvt", 257, 0),
        ("DynamoSample_2024.rvt", 257, 0),
        ("DynamoSample_2025.rvt", 257, 0),
        ("RE1-Architecture.rvt", 73, 4),
        // Les 21 instances de symboles de plan (lignes seulement) n'ont aucune surface.
        ("RE1-Electrical.rvt", 49, 21),
        ("2024_Core_Interior.rvt", 856, 0),
        ("DuctSegmentFlow.rvt", 6, 0),
        ("RefineryPrimer-2023-BuildingGenerator.rvt", 175, 0),
        ("RefineryPrimer-2024-BuildingGenerator.rvt", 175, 0),
        ("RefineryPrimer-2026-BuildingGenerator.rvt", 175, 0),
        ("Revit_IFC5_Einhoven.rvt", 28, 0),
    ];
    for (name, drawn, without) in expected {
        let Some(path) = sample(name) else { continue };
        let (_, geometry, warnings) = build_with_warnings(&path);
        let agreement = check(&geometry);
        assert!(agreement >= 0.99, "{name} : sens des triangles : {agreement}");
        let counts = geometry.counts;
        assert_eq!((counts.revit, counts.partial, counts.rebuilt, counts.unknown), (drawn, 0, 0, 0), "{name} : sources");
        assert_eq!(geometry.without_geometry, without, "{name} : éléments sans géométrie");
        assert_eq!(geometry.stats.unreadable, 0, "{name} : formes illisibles");
        assert!(!geometry.stats.export_needed, "{name} : l'export IFC ne doit pas être calculé pour un fichier de 2023 ou plus");
        assert!(warnings.iter().all(|message| !message.contains("ne sait pas encore lire")), "{name} : {warnings:?}");
        // Coques fermées dont les faces regardent vers l'intérieur, retournées en bloc par l'assemblage : aucune,
        // sauf la forme de source lumineuse (un maillage fermé de 544 facettes, sous le boîtier) des deux appareils
        // d'éclairage de RE1-Electrical, que Revit écrit avec des normales rentrantes (volume signé négatif).
        let inverted = if name == "RE1-Electrical.rvt" { 2 } else { 0 };
        assert_eq!(geometry.stats.mesh.inverted, inverted, "{name} : coques retournées en bloc");
    }
}

/// Un fichier de Revit 2017 se lit comme ceux de 2023 : par les formes que Revit a enregistrées (couleurs de ses
/// matériaux comprises), sans export IFC. Avant, tout venait de l'export de rvt-rs (56 corps reconstruits, 397 boîtes).
#[test]
fn un_fichier_de_2017_se_lit_par_ses_formes_enregistrees() {
    let Some(path) = sample("SampleModel.rvt") else { return };
    let (release, geometry, warnings) = build_with_warnings(&path);
    assert_eq!(release, Some(2017));
    let agreement = check(&geometry);
    assert!(agreement >= 0.99, "sens des triangles : {agreement}");
    let counts = geometry.counts;
    assert_eq!(counts.rebuilt, 0);
    assert!(counts.revit + counts.partial >= 470 && counts.unknown == 0, "{counts:?}");
    assert!(!geometry.stats.export_needed, "l'export IFC ne doit pas être calculé pour un fichier de 2017");
    assert!(warnings.iter().all(|message| !message.contains("Inconnue") && !message.contains("Revit 2017")), "{warnings:?}");
}

/// Si la lecture native échoue (ici : mode simulé en refusant l'année), les éléments sont reconstruits par l'export de
/// rvt-rs, avec un avertissement qui dit pourquoi, comme avant.
#[test]
fn une_annee_que_le_lecteur_ne_lit_pas_retombe_sur_l_export_ifc() {
    let Some(path) = sample("SampleModel.rvt") else { return };
    let bytes = std::fs::read(&path).expect("fichier d'essai illisible");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    // Une année de Revit « 2030 », plus récente que celles que le lecteur sait lire.
    let mut context = Context::new(Some(2030));
    let geometry = geometry::build(&mut file, &mut context).expect("géométrie");
    assert!(context.warnings.iter().any(|message| message.contains("Revit 2030") && message.contains("plus récente") && message.contains("Inconnue")), "{:?}", context.warnings);
    assert_eq!(geometry.counts.revit + geometry.counts.partial, 0);
    assert!(geometry.stats.export_needed);
}
