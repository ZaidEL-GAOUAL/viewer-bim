//! Un élément dont Revit a enregistré la forme mais que le lecteur ne sait pas lire n'est jamais écarté
//! en silence : il est dessiné par la boîte englobante que Revit a enregistrée pour lui, marqué
//! « Inconnue (boîte englobante) » (source 3), et un avertissement le compte (`geometry::bounds`).
//!
//! Le lecteur sait aujourd'hui lire toutes les formes des fichiers d'essai : plus aucun élément n'y est une
//! boîte. Le chemin des boîtes se vérifie donc en mode prudent (`Context::prudent` : rvt-rs seul, sans nos
//! maillages ni notre parcours des graphiques), où ces éléments redeviennent illisibles. Sans mode
//! prudent, les mêmes fichiers n'ont aucune boîte.
//!
//! À lancer avec `cargo test --release`. Les fichiers publics viennent de `npm run samples:revit` ;
//! sans eux, les essais qui en dépendent passent sans rien faire.

use std::path::PathBuf;

use revit::geometry::{self, Geometry, saved};
use revit::{Context, Options, read};

fn sample(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(path)
}

fn build(path: &PathBuf, prudent: bool) -> (Geometry, Vec<String>) {
    let bytes = std::fs::read(path).expect("fichier d'essai illisible");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = file.basic_file_info().ok().map(|info| info.version);
    let mut context = Context::new(release);
    context.prudent = prudent;
    let geometry = geometry::build(&mut file, &mut context).expect("géométrie");
    (geometry, context.warnings)
}

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Les triangles d'un élément : sommets (mètres, Y vers le haut, relatifs à l'origine) et normales du
/// premier sommet de chacun.
fn triangles_of(geometry: &Geometry, element: usize) -> Vec<([V3; 3], V3)> {
    let at = |array: &[f32], vertex: usize| [f64::from(array[vertex * 3]), f64::from(array[vertex * 3 + 1]), f64::from(array[vertex * 3 + 2])];
    let mut out = Vec::new();
    for row in geometry.primitives.chunks_exact(6) {
        let [owner, vertex_start, _, index_start, index_count, _] = row else { unreachable!() };
        if *owner as usize != element {
            continue;
        }
        let corners = &geometry.indices[*index_start as usize..(*index_start + *index_count) as usize];
        for corner in corners.chunks_exact(3) {
            let vertex = |k: usize| (*vertex_start + corner[k]) as usize;
            out.push(([at(&geometry.positions, vertex(0)), at(&geometry.positions, vertex(1)), at(&geometry.positions, vertex(2))], at(&geometry.normals, vertex(0))));
        }
    }
    out
}

/// L'étendue (minimum, maximum) d'un ensemble de triangles.
fn extent(triangles: &[([V3; 3], V3)]) -> Option<(V3, V3)> {
    let mut points = triangles.iter().flat_map(|(corners, _)| corners.iter().copied());
    let first = points.next()?;
    Some(points.fold((first, first), |(low, high), p| ([low[0].min(p[0]), low[1].min(p[1]), low[2].min(p[2])], [high[0].max(p[0]), high[1].max(p[1]), high[2].max(p[2])])))
}

/// Ce qu'on attend de chaque élément de source 3 que ce module a dessiné, et des avertissements.
fn check_boxes(name: &str, geometry: &Geometry, warnings: &[String]) {
    let boxes: Vec<usize> = (0..geometry.keys.len()).filter(|&element| geometry.sources[element] == 3).collect();
    let stats = &geometry.stats;
    // Rien n'est compté deux fois : ni redessiné par l'export, ni écarté, ni sans forme.
    assert!(stats.boxed + stats.undrawn <= stats.unreadable, "{name} : {} boîtes et {} non dessinés pour {} illisibles", stats.boxed, stats.undrawn, stats.unreadable);
    assert_eq!(stats.undrawn, 0, "{name} : élément sans aucune étendue");
    // Les seuls éléments de source 3 sont les boîtes des illisibles : l'export IFC de rvt-rs ne sert plus
    // à les redessiner (il n'en redessinait aucun : voir `geometry::rebuilt`).
    assert!(!stats.export_needed, "{name} : export IFC calculé pour des éléments illisibles");
    assert_eq!(stats.boxed, stats.unreadable, "{name} : illisibles sans boîte");
    assert_eq!(boxes.len(), stats.boxed, "{name} : éléments de source 3");
    assert_eq!(geometry.counts.unknown, boxes.len());

    // L'avertissement : un seul, qui compte les boîtes, sans jamais dire « n'est pas dessiné » d'une
    // forme illisible.
    let unreadable: Vec<&String> = warnings.iter().filter(|message| message.contains("ne sait pas encore lire")).collect();
    assert!(unreadable.iter().all(|message| message.contains("boîte englobante") && message.contains("« Inconnue »") && !message.contains("pas dessiné")), "{name} : {unreadable:?}");
    if stats.boxed == 0 {
        assert!(unreadable.is_empty(), "{name} : {unreadable:?}");
    } else {
        assert_eq!(unreadable.len(), 1, "{name} : {unreadable:?}");
        let expected = if stats.boxed == 1 { "1 élément a une forme".to_string() } else { format!("{} éléments ont une forme", stats.boxed) };
        assert!(unreadable[0].starts_with(&expected), "{name} : {}", unreadable[0]);
    }

    // Le reste du modèle, pour s'assurer que les boîtes sont au même endroit que lui.
    let others: Vec<([V3; 3], V3)> = (0..geometry.keys.len()).filter(|&element| geometry.sources[element] != 3).flat_map(|element| triangles_of(geometry, element)).collect();
    let rest = extent(&others);

    for &element in &boxes {
        let label = format!("{name} : {}", geometry.names[element]);
        let triangles = triangles_of(geometry, element);
        assert_eq!(triangles.len(), 12, "{label} : triangles");
        let (low, high) = extent(&triangles).unwrap_or_else(|| panic!("{label} : aucun triangle"));
        for axis in 0..3 {
            let side = high[axis] - low[axis];
            assert!(side.is_finite() && side > 1e-3 && side < 1e5, "{label} : côté {axis} de {side} m");
        }
        if let Some((rest_low, rest_high)) = rest {
            assert!((0..3).all(|axis| low[axis] <= rest_high[axis] && high[axis] >= rest_low[axis]), "{label} : hors du reste du modèle");
        }

        // Sens des triangles : vers l'extérieur de la boîte (son centre est au dehors du plan de chaque
        // triangle) et d'accord avec les normales des sommets.
        let centre = [(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0, (low[2] + high[2]) / 2.0];
        let mut closed = [0.0f64; 3];
        for (corners, normal) in &triangles {
            let geometric = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
            let middle = [(corners[0][0] + corners[1][0] + corners[2][0]) / 3.0, (corners[0][1] + corners[1][1] + corners[2][1]) / 3.0, (corners[0][2] + corners[1][2] + corners[2][2]) / 3.0];
            assert!(dot(geometric, sub(middle, centre)) > 0.0, "{label} : triangle tourné vers l'intérieur");
            assert!(dot(geometric, *normal) > 0.0, "{label} : triangle contraire à sa normale");
            closed = [closed[0] + geometric[0], closed[1] + geometric[1], closed[2] + geometric[2]];
        }
        assert!(closed.iter().all(|value| value.abs() < 1e-3), "{label} : boîte non fermée {closed:?}");
    }
}

/// Aucun élément n'est une boîte : le lecteur lit toutes les formes enregistrées de ce fichier.
fn assert_no_boxes(name: &str, geometry: &Geometry, warnings: &[String]) {
    assert_eq!(geometry.counts.unknown, 0, "{name} : boîtes englobantes");
    assert_eq!(geometry.counts.partial, 0, "{name} : formes partielles");
    assert_eq!(geometry.counts.rebuilt, 0, "{name} : formes reconstruites");
    assert_eq!(geometry.stats.unreadable, 0, "{name} : formes illisibles");
    assert_eq!(geometry.stats.undrawn, 0, "{name} : éléments sans étendue");
    assert!(!geometry.stats.export_needed, "{name} : export IFC calculé");
    assert!(warnings.iter().all(|message| !message.contains("ne sait pas encore lire")), "{name} : {warnings:?}");
}

#[test]
fn core_interior_dessine_tout_ce_qui_est_dessinable() {
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let (geometry, warnings) = build(&path, false);
    assert_no_boxes("Core Interior", &geometry, &warnings);
    // Plus aucun élément « sans géométrie » : la topographie 21974 est dessinée (par sa forme Revit).
    assert_eq!(geometry.without_geometry, 0);

    // La topographie 21974 : ses faces (deux GPolyMesh aux normales par sommet) se lisent ; sa boîte,
    // `GElement.m_tightbBox`, est [20, 25, −43,0005] à [167, 114, −0,651] pieds, et sa forme tient dedans
    // exactement (la même étendue qu'avec la boîte que ce lecteur en dessinait avant de lire ces faces).
    let element = geometry.element_ids.iter().position(|&id| id == 21974).expect("la topographie 21974 n'est pas dessinée");
    assert!(geometry.names[element].starts_with("SiteSurface "), "{}", geometry.names[element]);
    assert_eq!(geometry.sources[element], 0, "source de la topographie");
    let (low, high) = extent(&triangles_of(&geometry, element)).expect("triangles de la topographie");
    // (x, y, z) pieds → (x, z, −y) × 0,3048 m, relatif à l'origine du modèle.
    let foot = 0.3048;
    let expected_low = [20.0 * foot - geometry.origin[0], -43.00052261352539 * foot - geometry.origin[1], -114.0 * foot - geometry.origin[2]];
    let expected_high = [167.0 * foot - geometry.origin[0], -0.6510416865348816 * foot - geometry.origin[1], -25.0 * foot - geometry.origin[2]];
    for axis in 0..3 {
        // Les positions sont des f32, relatives à l'origine : un demi-millimètre de marge.
        assert!((low[axis] - expected_low[axis]).abs() < 5e-4 && (high[axis] - expected_high[axis]).abs() < 5e-4, "axe {axis} : {low:?} {high:?} contre {expected_low:?} {expected_high:?}");
    }
}

/// En mode prudent (rvt-rs seul), la topographie 21974 redevient illisible : sa boîte, au même endroit.
#[test]
fn core_interior_prudent_montre_sa_topographie_par_sa_boite() {
    let Some(path) = sample("2024_Core_Interior.rvt") else { return };
    let (geometry, warnings) = build(&path, true);
    check_boxes("Core Interior (prudent)", &geometry, &warnings);
    let stats = &geometry.stats;
    assert_eq!((stats.boxed, stats.unreadable), (1, 1));
    // Plus un seul élément « sans géométrie » : celui qui l'était est dessiné, par sa boîte.
    assert_eq!(geometry.without_geometry, 0);
    let element = geometry.element_ids.iter().position(|&id| id == 21974).expect("la topographie 21974 n'est pas dessinée");
    assert_eq!(geometry.sources[element], 3);
    let (low, high) = extent(&triangles_of(&geometry, element)).expect("triangles de la boîte");
    let foot = 0.3048;
    let expected_low = [20.0 * foot - geometry.origin[0], -43.00052261352539 * foot - geometry.origin[1], -114.0 * foot - geometry.origin[2]];
    let expected_high = [167.0 * foot - geometry.origin[0], -0.6510416865348816 * foot - geometry.origin[1], -25.0 * foot - geometry.origin[2]];
    for axis in 0..3 {
        assert!((low[axis] - expected_low[axis]).abs() < 5e-4 && (high[axis] - expected_high[axis]).abs() < 5e-4, "axe {axis}");
    }
}

#[test]
fn dynamo_sample_2024_lit_toutes_ses_formes() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let (geometry, warnings) = build(&path, false);
    assert_no_boxes("DynamoSample 2024", &geometry, &warnings);
    assert_eq!(geometry.counts.revit, geometry.keys.len());
}

/// Rvt-rs seul : les trois topographies (normales par sommet) et les deux figurines RPC (imposteur et
/// topologie à indicateurs d'arêtes) sont illisibles et montrées par leur boîte ; sept garde-corps ne
/// sont que partiels (commande de retournement) et une semelle de pieux (composant imbriqué).
#[test]
fn dynamo_sample_2024_prudent_montre_ses_formes_illisibles_par_leur_boite() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let (geometry, warnings) = build(&path, true);
    check_boxes("DynamoSample 2024 (prudent)", &geometry, &warnings);
    // Sans nos maillages, les faces que rvt-rs ne sait pas mailler manquent aussi : plus de partiels qu'avant (et
    // quelques éléments dont aucune face ne se maille deviennent des boîtes) ; les cinq illisibles d'alors le sont encore.
    assert!(geometry.counts.unknown >= 5 && geometry.counts.partial >= 8, "{:?}", geometry.counts);
    // Rien d'illisible n'est compté parmi les éléments sans forme : seuls restent les éléments vides.
    assert_eq!(geometry.stats.boxed, geometry.stats.unreadable);
}

#[test]
fn re1_electrical_lit_toutes_ses_formes() {
    let Some(path) = sample("RE1-Electrical.rvt") else { return };
    let (geometry, warnings) = build(&path, false);
    assert_no_boxes("RE1-Electrical", &geometry, &warnings);
    // 49 éléments à forme Revit ; les 21 instances de symboles de plan (« SYMBOL-Electrical », faites de
    // lignes seulement) n'ont aucune surface : sans géométrie, comptées et non dessinées. L'export IFC de
    // rvt-rs (2,2 s, 1,2 s natif) n'en redessinait aucune.
    assert_eq!(geometry.counts.revit, 49);
    assert_eq!(geometry.without_geometry, 21);
}

#[test]
fn re1_electrical_prudent_montre_ses_symboles_et_ses_formes_partielles() {
    let Some(path) = sample("RE1-Electrical.rvt") else { return };
    let (geometry, warnings) = build(&path, true);
    // 21 boîtes, comme avec la lecture complète de rvt-rs, et pas d'export IFC pour les redessiner.
    check_boxes("RE1-Electrical (prudent)", &geometry, &warnings);
    assert!(geometry.counts.unknown >= 21 && geometry.counts.partial >= 24, "{:?}", geometry.counts);
}

/// La fiche d'un élément de source 3 le dit : « Source de la géométrie » = « Inconnue (boîte englobante) ».
#[test]
fn la_fiche_d_une_boite_la_declare_inconnue() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let bytes = std::fs::read(path).expect("fichier d'essai");
    let output = read(&bytes, &Options { prudent: true, ..Options::default() }).expect("lecture");
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    let boxes: Vec<usize> = (0..output.keys.len()).filter(|&element| output.sources[element] == 3).collect();
    assert_eq!(boxes.len(), output.report.sources.unknown);
    assert!(!boxes.is_empty());
    for element in boxes {
        let properties = &metadata["elements"][&output.keys[element]]["properties"];
        assert_eq!(properties["Source de la géométrie"], "Inconnue (boîte englobante)", "{}", output.names[element]);
    }
    // Rien d'illisible n'est compté sans géométrie : ces éléments sont dessinés.
    assert!(output.report.warnings.iter().any(|message| message.contains("boîte englobante") && message.contains("« Inconnue »")));
}

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/Revit_IFC5_Einhoven.rvt");

/// Un plafond de maillage nul sur le fichier d'essai committé : dès qu'un élément est maillé, le plafond
/// (`Scene::hard_limit`) est atteint et les suivants ne le sont plus. Ce qu'il refuse de mailler se montre par la boîte que
/// Revit a enregistrée (source 3) et se compte avec ce que le budget remplace par une boîte : ni « trop dense », ni
/// « illisible », ni deux fois. En mode prudent aucune instance n'attend ses symboles : tous les éléments passent par le
/// plafond au début de leur maillage ; sinon, les brouillons d'instances le rencontrent quand on les achève
/// (`saved::complete`), et c'est la plupart des éléments du fichier.
#[test]
fn le_plafond_de_maillage_se_compte_comme_le_budget() {
    let path = PathBuf::from(FIXTURE);
    let bytes = std::fs::read(&path).expect("fichier d'essai");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let mut context = Context::new(file.basic_file_info().ok().map(|info| info.version));
    context.prudent = true;
    context.hard_triangle_limit = Some(0);
    let geometry = geometry::build(&mut file, &mut context).expect("géométrie");
    let (stats, warnings) = (&geometry.stats, &context.warnings);

    assert!(stats.capped + stats.capped_undrawn > 0, "le plafond de maillage devait être atteint : {:?}", (stats.capped, stats.capped_undrawn, stats.mesh_limit));
    assert_eq!(stats.mesh_limit, 0);
    // Un élément refusé par le plafond n'est ni trop dense ni illisible : il n'est compté que par le budget (ou, sans boîte
    // enregistrée, par son propre avertissement). Aucun élément n'est compté deux fois.
    assert_eq!((stats.too_dense, stats.too_dense_undrawn), (0, 0));
    assert_eq!(stats.trimmed, stats.capped, "le budget par défaut ne remplace rien d'autre");
    assert_eq!(geometry.counts.unknown, stats.boxed + stats.capped, "chaque boîte a une seule cause : {:?}", geometry.counts);
    assert_eq!(geometry.sources.iter().filter(|&&source| source == 3).count(), geometry.counts.unknown);

    // Les avertissements : chaque cause compte ses éléments, une fois.
    let budget: Vec<&String> = warnings.iter().filter(|message| message.starts_with("Le fichier dépasse 3000000 triangles,")).collect();
    assert_eq!(budget.len(), usize::from(stats.capped > 0), "{warnings:?}");
    if stats.capped > 0 {
        let expected = if stats.capped == 1 { "l'élément dont la forme ne tenait plus".to_string() } else { format!("les {} éléments dont la forme ne tenait plus", stats.capped) };
        assert!(budget[0].contains(&expected), "{}", budget[0]);
    }
    let uncapped = warnings.iter().filter(|message| message.starts_with("Le fichier dépasse 0 triangles maillés")).count();
    assert_eq!(uncapped, usize::from(stats.capped_undrawn > 0), "{warnings:?}");
    let unread: Vec<&String> = warnings.iter().filter(|message| message.contains("ne sait pas encore lire : ")).collect();
    assert_eq!(unread.len(), usize::from(stats.boxed > 0), "{warnings:?}");
    assert!(warnings.iter().all(|message| !message.contains("plus de 250000 triangles")), "{warnings:?}");

    // Sans mode prudent : le plus gros du maillage est celui des brouillons d'instances, achevés après la lecture des symboles.
    // Le plafond les refuse aussi : au moins une instance qui attendait ses symboles est montrée par sa boîte (son
    // diagnostic le dit), comptée par le budget comme les autres, et aucun élément ne disparaît.
    let drawn = build(&path, false).0.keys.len();
    // Le plafond juste au niveau de ce que les éléments sans instance différée maillent à eux seuls (une somme, quel que soit
    // l'ordre des fils) : il n'en refuse aucun, et le premier brouillon achevé le dépasse.
    let (scene, _) = drafts();
    let limit = scene.meshed.load(std::sync::atomic::Ordering::Relaxed);
    let bytes = std::fs::read(&path).expect("fichier d'essai");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let mut context = Context::new(file.basic_file_info().ok().map(|info| info.version));
    context.hard_triangle_limit = Some(limit);
    let geometry = geometry::build(&mut file, &mut context).expect("géométrie");
    let stats = &geometry.stats;
    assert!(stats.deferred > 0, "le fichier d'essai a des instances qui attendent leurs symboles");
    let drafts_capped = stats.incomplete.values().filter(|incomplete| incomplete.diagnostics.iter().any(|message| message.contains("instance dont les symboles n'étaient pas lus"))).count();
    assert!(drafts_capped > 0, "aucun brouillon d'instance n'a été refusé par le plafond : {} plafonnés, {} différés", stats.capped, stats.deferred);
    assert_eq!(stats.trimmed, stats.capped);
    assert_eq!((stats.too_dense, stats.too_dense_undrawn, stats.boxed, stats.undrawn), (0, 0, 0, 0));
    assert_eq!(geometry.counts.unknown, stats.capped);
    assert_eq!(geometry.keys.len() + stats.capped_undrawn, drawn, "aucun élément ne disparaît ni ne se double");
}

/// Les brouillons d'instances d'un fichier : leur scène, et leurs formes que rien n'a achevées.
fn drafts() -> (saved::Scene, Vec<(u64, saved::Shape)>) {
    let mut file = rvt::RevitFile::open_bytes(std::fs::read(FIXTURE).expect("fichier d'essai")).expect("fichier Revit");
    let wanted = |scene: &saved::Scene, _: u64, info: &saved::Info| geometry::classes::excluded(&scene.facts(info)).is_none();
    let work = |scene: &saved::Scene, id: u64, graph: &rvt::research::native_parameters::ObjectGraph| saved::shape(scene, id, graph);
    // Un achèvement qui ne fait rien : les brouillons restent au résultat du balayage.
    let finish = |_: &saved::Scene, _: u64, _: &mut saved::Shape| {};
    let pending = |shape: &saved::Shape| shape.draft.is_some();
    let scan = saved::scan_with(&mut file, &wanted, 1, &work, Some(&finish), &pending, None, saved::Plan::exhaustive()).expect("lecture des graphiques");
    let drafts = scan.results.into_iter().filter_map(|(id, shape)| shape.filter(|shape| shape.draft.is_some()).map(|shape| (id, shape))).collect();
    (scan.scene, drafts)
}

/// `saved::complete` vérifie le plafond de maillage comme `saved::shape` : un brouillon d'instance au-delà devient une forme
/// plafonnée (sans maillage, ni trop dense), avant tout maillage de ses symboles ; en deçà, il s'achève.
#[test]
fn un_brouillon_d_instance_au_dela_du_plafond_n_est_pas_acheve() {
    use std::sync::atomic::Ordering;
    let (scene, drafts_found) = drafts();
    assert!(!drafts_found.is_empty(), "le fichier d'essai a des instances qui attendent leurs symboles");
    let before = scene.meshed.load(Ordering::Relaxed);
    for (id, mut shape) in drafts_found {
        saved::complete(&scene, id, &mut shape);
        assert!(shape.draft.is_none() && !shape.capped, "sous le plafond, le brouillon {id} s'achève");
    }
    assert!(scene.meshed.load(Ordering::Relaxed) > before, "achever des brouillons les maille");

    let (mut other, drafts_found) = drafts();
    other.hard_limit = 5;
    other.meshed.store(6, Ordering::Relaxed);
    let before = other.meshed.load(Ordering::Relaxed);
    for (id, mut shape) in drafts_found {
        saved::complete(&other, id, &mut shape);
        assert!(shape.capped && !shape.too_dense && shape.mesh.is_empty() && shape.draft.is_none(), "au-delà du plafond, le brouillon {id} est plafonné");
        assert!(shape.graphics && shape.partial(), "un diagnostic dit pourquoi : {:?}", shape.diagnostics);
    }
    assert_eq!(other.meshed.load(Ordering::Relaxed), before, "rien n'a été maillé");
}
