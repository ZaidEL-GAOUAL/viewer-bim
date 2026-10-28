//! Recensement sur des fichiers Revit : `cargo run --release --example census -- <fichier.rvt>...`
//!
//! 1. Pour chaque classe Revit, ce que la règle « dessinable ou non » en fait (classes, relations,
//!    doublons de symboles, éléments vides ou illisibles), à relire par le responsable de la règle.
//! 2. Les faces enregistrées, avant et après `geometry::faces` : celles que rvt-rs ne sait pas
//!    mailler, groupées par classe de surface (`Geometry.m_pFaces` → face → `m_pSurf`) et par
//!    raison, avec le nombre d'éléments touchés ; puis ce que le module des faces en fait (maillées
//!    par lui, plans sans contour, échecs restants).
//!
//! 3. Les éléments dont la forme n'est pas lue en entier (source 1, boîte englobante ou reconstruits
//!    parce que illisibles) : classe, catégorie, famille et type, et les diagnostics exacts du
//!    parcours et du décodage, regroupés (les chiffres des messages sont retirés pour regrouper).
//!
//! 4. Les instances à cibles interdites (`GInstance.m_forbiddenTarget.m_targets` ≠ 0) des éléments qui se dessinent : où elles
//!    sont dans le graphe, ce que leur symbole contient, quels autres éléments placent le même symbole et quels autres
//!    éléments dessinés couvrent la même étendue (une instance « dessinée par son propre élément » ferait doublon).
//!
//! Tous les fichiers de 2012 à 2027 se lisent par leurs formes enregistrées ; les autres années ne passent que par
//! l'export IFC (partie 1), la partie 2 les ignore.

use std::collections::{BTreeMap, BTreeSet};
use std::process::ExitCode;

use revit::geometry::bounds::Bounds;
use revit::geometry::faces::select::graphics_visibility;
use revit::geometry::faces::{self, Outcome as After};
use revit::geometry::{self, ClassRow, classes, saved};
use revit::Context;
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::{native_empty_faces, native_graphics_traversal, native_saved_mesh};

/// Ce qu'une face enregistrée devient au maillage de rvt-rs.
enum Outcome {
    Meshed,
    /// Pas de contour borné que rvt-rs sache mailler : la classe de sa surface.
    Unbounded(String),
    /// Erreur de décodage de la face : classe de sa surface, message.
    Failed(String, String),
}

/// Une face : son sort avec rvt-rs seul, puis avec `geometry::faces`.
struct FaceResult {
    before: Outcome,
    after: AfterKind,
}

/// Le sort final d'une face, sans les maillages.
enum AfterKind {
    Rvt,
    Own,
    Reference,
    EmptyTrim,
    Failed(String, String),
}

/// Retire les chiffres d'un message pour regrouper les mêmes erreurs.
fn generic(message: &str) -> String {
    message.chars().filter(|c| !c.is_ascii_digit()).take(90).collect()
}

/// Les faces des nœuds `Geometry` que le viewport 3D par défaut sélectionne pour un élément
/// (symboles placés compris), chacune avec son sort avant et après `geometry::faces`.
fn faces_of(scene: &saved::Scene, graph: &ObjectGraph) -> Vec<FaceResult> {
    let selection = native_graphics_traversal::select_graphics_with_resolver_at_detail(graph, &|owner| scene.symbol(owner), saved::DETAIL_LEVEL);
    let mut outcomes = Vec::new();
    for selected in &selection.selected {
        let g = match selected.source_owner_id {
            None => graph,
            Some(owner) => match scene.symbol(owner) {
                Some(owner_graph) => owner_graph,
                None => continue,
            },
        };
        let object = &g.objects[selected.object_index];
        if object.class_name != "Geometry" {
            continue;
        }
        let Some(pointers) = object.fields["m_pFaces"].as_array() else { continue };
        for pointer in pointers {
            let Ok(Some(face)) = native_saved_mesh::pointer(g, selected.object_index, pointer) else { continue };
            let before = match native_saved_mesh::face(g, face) {
                Ok(Some(_)) => Outcome::Meshed,
                Ok(None) if native_empty_faces::is_observed_empty_trim_face(g, face) => Outcome::Meshed,
                Ok(None) => Outcome::Unbounded(faces::surface_class(g, face)),
                Err(error) => Outcome::Failed(faces::surface_class(g, face), generic(&format!("{error:#}"))),
            };
            let after = match faces::mesh_face(g, face) {
                After::Rvt(_) => AfterKind::Rvt,
                After::Own(_) => AfterKind::Own,
                After::Reference => AfterKind::Reference,
                After::EmptyTrim => AfterKind::EmptyTrim,
                After::Failed { surface, reason } => AfterKind::Failed(surface, generic(&reason)),
            };
            outcomes.push(FaceResult { before, after });
        }
    }
    outcomes
}

/// Une instance à cibles interdites trouvée dans le graphe d'un élément.
#[derive(Clone)]
struct Restricted {
    targets: u64,
    /// Visibilité du nœud (voir `select::graphics_visibility`).
    visibility: u8,
    /// Classes des nœuds qui la portent, de la racine à son parent.
    ancestors: String,
    /// Symbole placé (`InstanceInfo.m_symbolId`), s'il n'est pas incorporé.
    symbol: Option<u64>,
    /// Faces des nœuds `Geometry` et maillages `GPolyMesh` du graphe du symbole ; `None` : graphe du symbole absent.
    surfaces: Option<usize>,
}

/// Ce que le travail sur le graphe d'un élément rend, en plus des faces et des triangles.
struct Work {
    faces: Vec<FaceResult>,
    triangles: usize,
    restricted: Vec<Restricted>,
    /// Boîte que Revit a enregistrée pour l'élément (pieds, Z vers le haut).
    bounds: Option<Bounds>,
    /// Symboles que ses instances placent.
    symbols: BTreeSet<u64>,
}

/// Les instances à cibles interdites d'un graphe, avec leurs ancêtres et ce que contient leur symbole.
fn restricted_instances(scene: &saved::Scene, graph: &ObjectGraph) -> Vec<Restricted> {
    use rvt::research::native_saved_mesh::pointer;
    // Parcours depuis la racine par les sous-nœuds et les symboles incorporés : la classe de chaque ancêtre.
    let mut parent: BTreeMap<usize, usize> = BTreeMap::new();
    let mut stack = vec![0usize];
    while let Some(index) = stack.pop() {
        let object = &graph.objects[index];
        let children = object.fields["m_subNodes"].as_array().into_iter().flatten().chain(std::iter::once(&object.fields["m_oEmbeddedSymbolGRep"]));
        for child in children {
            if let Ok(Some(target)) = pointer(graph, index, child) {
                if target != 0 && !parent.contains_key(&target) {
                    parent.insert(target, index);
                    stack.push(target);
                }
            }
        }
    }
    let mut found = Vec::new();
    for (index, object) in graph.objects.iter().enumerate() {
        if object.class_name != "GInstance" {
            continue;
        }
        let targets = object.fields["m_forbiddenTarget"]["m_targets"].as_u64().unwrap_or(u64::MAX);
        if targets == 0 {
            continue;
        }
        let mut chain = Vec::new();
        let mut at = index;
        while let Some(&up) = parent.get(&at) {
            chain.push(graph.objects[up].class_name.as_str());
            at = up;
        }
        chain.reverse();
        let symbol = pointer(graph, index, &object.fields["m_instanceInfo"]).ok().flatten().and_then(|info| faces::graph::identifier(&graph.objects[info].fields["m_symbolId"])).and_then(|id| u64::try_from(id).ok()).filter(|id| *id > 0);
        let embedded = object.fields["m_oEmbeddedSymbolGRep"]["pointer_token"].as_u64() != Some(0);
        let surfaces_of = |g: &ObjectGraph| g.objects.iter().map(|o| if o.class_name == "Geometry" { o.fields["m_pFaces"].as_array().map_or(0, Vec::len) } else { usize::from(o.class_name == "GPolyMesh") }).sum::<usize>();
        let surfaces = if embedded { Some(surfaces_of(graph)) } else { symbol.and_then(|id| scene.symbol(id)).map(surfaces_of) };
        found.push(Restricted {
            targets,
            visibility: graphics_visibility(object.fields["m_GInfo"]["m_flags"].as_u64().unwrap_or(0)),
            ancestors: chain.join(">"),
            symbol: if embedded { None } else { symbol },
            surfaces,
        });
    }
    found
}

/// Un élément qui porte une instance à cibles interdites.
struct RestrictedRow {
    id: u64,
    class: String,
    instances: Vec<Restricted>,
    /// Boîte enregistrée, en mètres, Y vers le haut.
    bounds: Option<([f64; 3], [f64; 3])>,
    /// Écart le plus grand, sur les six faces, entre l'étendue du maillage dessiné et la boîte enregistrée (mètres) ;
    /// `None` si l'élément n'est pas dessiné par un maillage ou n'a pas de boîte.
    box_gap: Option<f64>,
    /// Les autres éléments dessinés qui placent un de ses symboles.
    same_symbol: Vec<u64>,
    /// Les autres éléments dessinés dont l'étendue recouvre au moins la moitié de la sienne : (identifiant, part recouverte).
    overlapping: Vec<(u64, f64)>,
}

/// Un élément dont la forme n'est pas lue en entier.
struct IncompleteRow {
    id: u64,
    source: u8,
    class: String,
    category: String,
    family: String,
    kind: String,
    /// Diagnostics regroupés (message sans chiffres) avec leur nombre.
    diagnostics: BTreeMap<String, usize>,
    failures: BTreeMap<String, usize>,
    unreadable_graph: bool,
}

struct IncompleteFile {
    name: String,
    release: Option<u32>,
    elements: usize,
    sources: [usize; 4],
    rows: Vec<IncompleteRow>,
    /// Catégorie, famille et type de chaque élément dessiné, par ElementId.
    labels: BTreeMap<u64, [String; 3]>,
    /// Étendue de chaque élément dessiné (mètres, repère absolu).
    extents: BTreeMap<u64, ([f64; 3], [f64; 3])>,
    /// Source de chaque élément dessiné.
    source_of: BTreeMap<u64, u8>,
    /// Les éléments à instance à cibles interdites (partie 4).
    restricted: Vec<RestrictedRow>,
}

/// Les propriétés « Catégorie », « Famille » et « Type » de chaque élément, par ElementId.
fn incomplete_file(name: &str, release: Option<u32>, file: &mut rvt::RevitFile, context: &mut Context, built: &geometry::Geometry) -> IncompleteFile {
    let mut sources = [0usize; 4];
    for &source in &built.sources {
        sources[usize::from(source)] += 1;
    }
    let properties = revit::properties::build(file, context, &built.element_ids, &built.keys, &built.sources).ok();
    let metadata: Option<serde_json::Value> = properties.as_ref().and_then(|properties| serde_json::from_str(&properties.metadata()).ok());
    let mut rows = Vec::new();
    for (index, id) in built.element_ids.iter().enumerate() {
        let Some(incomplete) = built.stats.incomplete.get(id) else { continue };
        let fiche = metadata.as_ref().map(|metadata| &metadata["elements"][&built.keys[index]]["properties"]);
        let text = |key: &str| fiche.and_then(|fiche| fiche[key].as_str()).unwrap_or("?").to_string();
        let mut diagnostics: BTreeMap<String, usize> = BTreeMap::new();
        for message in &incomplete.diagnostics {
            // « object 123: message » : l'indice d'objet est retiré.
            let message = message.split_once(": ").map_or(message.as_str(), |(_, rest)| rest);
            *diagnostics.entry(generic(message)).or_default() += 1;
        }
        let mut failures: BTreeMap<String, usize> = BTreeMap::new();
        for (surface, reason) in &incomplete.failures {
            *failures.entry(format!("{surface} : {}", generic(reason))).or_default() += 1;
        }
        rows.push(IncompleteRow {
            id: *id,
            source: built.sources[index],
            class: incomplete.class.clone(),
            category: text("Catégorie"),
            family: text("Famille"),
            kind: text("Type"),
            diagnostics,
            failures,
            unreadable_graph: incomplete.unreadable_graph,
        });
    }
    // Les illisibles que personne n'a dessinés ne sont pas dans `element_ids` : rien à lister.
    let mut labels = BTreeMap::new();
    let mut source_of = BTreeMap::new();
    for (index, id) in built.element_ids.iter().enumerate() {
        let fiche = metadata.as_ref().map(|metadata| &metadata["elements"][&built.keys[index]]["properties"]);
        let text = |key: &str| fiche.and_then(|fiche| fiche[key].as_str()).unwrap_or("?").to_string();
        labels.insert(*id, [text("Catégorie"), text("Famille"), text("Type")]);
        source_of.insert(*id, built.sources[index]);
    }
    // Étendue de chaque élément : les positions sont relatives à `origin`, en f32.
    let mut extents: BTreeMap<u64, ([f64; 3], [f64; 3])> = BTreeMap::new();
    for row in built.primitives.chunks_exact(6) {
        let id = built.element_ids[row[0] as usize];
        for vertex in built.positions[row[1] as usize * 3..(row[1] + row[2]) as usize * 3].chunks_exact(3) {
            let point = [f64::from(vertex[0]) + built.origin[0], f64::from(vertex[1]) + built.origin[1], f64::from(vertex[2]) + built.origin[2]];
            let current = extents.entry(id).or_insert((point, point));
            for axis in 0..3 {
                current.0[axis] = current.0[axis].min(point[axis]);
                current.1[axis] = current.1[axis].max(point[axis]);
            }
        }
    }
    IncompleteFile { name: name.to_string(), release, elements: built.keys.len(), sources, rows, labels, extents, source_of, restricted: Vec::new() }
}

fn print_incomplete(files: &[IncompleteFile]) {
    println!("\n== Éléments dont la forme n'est pas lue en entier, par fichier (source 1 : partielle, 2 : reconstruite, 3 : boîte)");
    for file in files.iter().filter(|file| file.release.is_some_and(|year| revit::native::SUPPORTED_RELEASES.contains(&year))) {
        println!(
            "\n{} (Revit {}) : {} éléments, sources 0/1/2/3 = {}/{}/{}/{}",
            file.name,
            file.release.map_or("?".to_string(), |year| year.to_string()),
            file.elements,
            file.sources[0],
            file.sources[1],
            file.sources[2],
            file.sources[3]
        );
        // Regroupement : même classe, catégorie, famille, type, source et mêmes diagnostics.
        let mut groups: BTreeMap<(u8, String, String, String, String, Vec<(String, usize)>, Vec<(String, usize)>, bool), Vec<u64>> = BTreeMap::new();
        for row in &file.rows {
            let key = (row.source, row.class.clone(), row.category.clone(), row.family.clone(), row.kind.clone(), row.diagnostics.clone().into_iter().collect(), row.failures.clone().into_iter().collect(), row.unreadable_graph);
            groups.entry(key).or_default().push(row.id);
        }
        for ((source, class, category, family, kind, diagnostics, failures, unreadable_graph), ids) in groups {
            let shown: Vec<String> = ids.iter().take(6).map(u64::to_string).collect();
            println!("  source {source} · {} éléments ({}{}) · {class} · {category} · {family} · {kind}", ids.len(), shown.join(", "), if ids.len() > 6 { ", …" } else { "" });
            if unreadable_graph {
                println!("      graphe graphique illisible");
            }
            for (message, count) in diagnostics {
                println!("      diagnostic ×{count} : {message}");
            }
            for (message, count) in failures {
                println!("      face non maillée ×{count} : {message}");
            }
        }
    }
}

/// Partie 4 : les éléments à instances à cibles interdites, regroupés.
fn print_restricted(files: &[IncompleteFile]) {
    println!("\n== Instances à cibles interdites (GInstance.m_forbiddenTarget.m_targets ≠ 0) des éléments dessinés");
    for file in files.iter().filter(|file| !file.restricted.is_empty()) {
        println!("\n{} (Revit {}) : {} éléments", file.name, file.release.map_or("?".to_string(), |year| year.to_string()), file.restricted.len());
        let mut groups: BTreeMap<String, Vec<&RestrictedRow>> = BTreeMap::new();
        for row in &file.restricted {
            let [category, family, kind] = file.labels.get(&row.id).cloned().unwrap_or_default();
            let mut shapes: Vec<String> = row.instances.iter().map(|i| format!("cibles {} (0b{:b}) visibilité {} sous [{}] symbole {} avec {} surfaces", i.targets, i.targets, i.visibility, i.ancestors, if i.symbol.is_some() { "externe" } else { "incorporé" }, i.surfaces.map_or("?".to_string(), |n| if n == 0 { "0".to_string() } else { "des".to_string() }))).collect();
            shapes.sort();
            shapes.dedup();
            let source = file.source_of.get(&row.id).copied().unwrap_or(9);
            groups.entry(format!("source {source} · {} · {category} · {family} · {kind} · {}", row.class, shapes.join(" ; "))).or_default().push(row);
        }
        for (key, rows) in groups {
            let shown: Vec<String> = rows.iter().take(5).map(|row| row.id.to_string()).collect();
            println!("  {} éléments ({}{}) · {key}", rows.len(), shown.join(", "), if rows.len() > 5 { ", …" } else { "" });
            let distinct: BTreeSet<u64> = rows.iter().flat_map(|row| row.instances.iter().filter_map(|i| i.symbol)).collect();
            let with_same: usize = rows.iter().filter(|row| !row.same_symbol.is_empty()).count();
            // Parmi les éléments qui placent le même symbole, ceux qui ne sont pas eux-mêmes de ce groupe (un vrai doublon).
            let group: BTreeSet<u64> = rows.iter().map(|row| row.id).collect();
            let outside: BTreeSet<u64> = rows.iter().flat_map(|row| row.same_symbol.iter().copied()).filter(|id| !group.contains(id)).collect();
            let mut families: BTreeMap<String, usize> = BTreeMap::new();
            for id in &outside {
                *families.entry(file.labels.get(id).map_or("?".to_string(), |l| format!("{} · {}", l[0], l[1]))).or_default() += 1;
            }
            println!("      éléments hors du groupe qui placent un de ses symboles : {} {families:?}", outside.len());
            let with_overlap: usize = rows.iter().filter(|row| !row.overlapping.is_empty()).count();
            println!("      symboles distincts : {} ; éléments dont un autre élément dessiné place le même symbole : {with_same} ; dont un autre élément dessiné recouvre ≥ 50 % de la boîte : {with_overlap}", distinct.len());
            let boxes: Vec<String> = rows.iter().take(3).filter_map(|row| row.bounds.map(|(low, high)| format!("{} : {:.2} × {:.2} × {:.2} m", row.id, high[0] - low[0], high[1] - low[1], high[2] - low[2]))).collect();
            println!("      boîtes enregistrées : {}", boxes.join(" ; "));
            let mut gaps: Vec<f64> = rows.iter().filter_map(|row| row.box_gap).collect();
            gaps.sort_by(f64::total_cmp);
            if let (Some(median), Some(worst)) = (gaps.get(gaps.len() / 2), gaps.last()) {
                println!("      étendue du maillage contre boîte enregistrée (sur {} éléments, source {}) : écart médian {:.1} mm, pire {:.1} mm", gaps.len(), rows.iter().filter_map(|row| file.source_of.get(&row.id)).map(u8::to_string).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>().join("/"), median * 1000.0, worst * 1000.0);
            }
            for row in rows.iter().filter(|row| !row.same_symbol.is_empty() || !row.overlapping.is_empty()).take(3) {
                let overlaps: Vec<String> = row.overlapping.iter().take(4).map(|(id, part)| format!("{id} ({:.0} %, {} · source {})", 100.0 * part, file.labels.get(id).map_or("?", |l| l[1].as_str()), file.source_of.get(id).map_or(9, |s| *s))).collect();
                println!("      exemple {} : même symbole chez {:?} ; recouvert par {}", row.id, row.same_symbol.iter().take(4).collect::<Vec<_>>(), overlaps.join(", "));
            }
        }
    }
}

#[derive(Default)]
struct Missing {
    faces: usize,
    /// (fichier, élément) touchés.
    elements: BTreeSet<(usize, u64)>,
}

fn main() -> ExitCode {
    let paths: Vec<String> = std::env::args().skip(1).filter(|path| !path.rsplit('/').next().is_some_and(|name| name.starts_with("._"))).collect();
    if paths.is_empty() {
        eprintln!("usage : cargo run --release --example census -- <fichier.rvt>...");
        return ExitCode::from(2);
    }
    let mut classes_total: BTreeMap<String, ClassRow> = BTreeMap::new();
    let mut unbounded: BTreeMap<String, Missing> = BTreeMap::new();
    let mut failed: BTreeMap<(String, String), Missing> = BTreeMap::new();
    let mut remaining: BTreeMap<(String, String), Missing> = BTreeMap::new();
    let (mut faces_ok, mut faces_total) = (0usize, 0usize);
    // Sort final des faces avec `geometry::faces` : rvt-rs, ce module, plans sans contour, découpes
    // vides, échecs.
    let mut finals = [0usize; 5];
    let mut elements_touched: BTreeSet<(usize, u64)> = BTreeSet::new();
    let mut elements_failing: BTreeSet<(usize, u64)> = BTreeSet::new();
    let mut elements_with_faces: BTreeSet<(usize, u64)> = BTreeSet::new();
    let mut ifc_types: BTreeMap<String, usize> = BTreeMap::new();
    // Règle de relation → (éléments avec forme, triangles) retirés.
    let mut removed: BTreeMap<&'static str, (usize, usize)> = BTreeMap::new();
    let mut rules_total: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut per_file: Vec<(String, usize, usize, usize)> = Vec::new();
    let mut identical_total = 0usize;
    // Partie 3 : par fichier, les sources et les éléments incomplets.
    let mut incomplete_report: Vec<IncompleteFile> = Vec::new();
    // Partie 5 : classe Revit des symboles que placent les éléments dessinés (graphes d'instances) :
    // classe → (éléments qui en placent, symboles distincts, exemple fichier élément → symbole).
    let mut placed_classes: BTreeMap<String, (usize, BTreeSet<(usize, u64)>, String)> = BTreeMap::new();

    for (file_index, path) in paths.iter().enumerate() {
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("{name} : illisible ({error})");
                continue;
            }
        };
        let mut file = match rvt::RevitFile::open_bytes(bytes) {
            Ok(file) => file,
            Err(error) => {
                eprintln!("{name} : {error}");
                continue;
            }
        };
        // L'année de lecture de `read` : l'étiquette de la version, ou à défaut l'empreinte du schéma (Project Vasari).
        let release = revit::native::format_year(&mut file).map(|(year, _)| year);
        eprintln!("{name} ({release:?})");

        // Partie 1 : la règle, classe par classe.
        let mut context = Context::new(release);
        match geometry::build(&mut file, &mut context) {
            Ok(built) => {
                incomplete_report.push(incomplete_file(&name, release, &mut file, &mut context, &built));
                identical_total += built.stats.identical;
                for (reason, count) in &built.stats.rules {
                    *rules_total.entry(reason).or_default() += count;
                }
                for (class, row) in built.stats.classes {
                    let total = classes_total.entry(class).or_default();
                    total.elements += row.elements;
                    total.excluded = total.excluded.or(row.excluded);
                    total.drawn += row.drawn;
                    total.excluded_by_relation += row.excluded_by_relation;
                    total.symbols += row.symbols;
                    total.inside_owner += row.inside_owner;
                    total.empty += row.empty;
                    total.unreadable += row.unreadable;
                    total.double_sided += row.double_sided;
                    total.not_geometric += row.not_geometric;
                    total.identical += row.identical;
                }
                if release.is_some_and(|year| year < 2023) {
                    // Fichier d'avant 2023 : les classes sont des types IFC de l'export.
                    if let Ok(export) = context.export(&mut file) {
                        for entity in &export.model.entities {
                            if let rvt::ifc::entities::IfcEntity::BuildingElement { ifc_type, .. } = entity {
                                *ifc_types.entry(ifc_type.clone()).or_default() += 1;
                            }
                        }
                    }
                }
            }
            Err(error) => eprintln!("  géométrie : {error:#}"),
        }

        // Parties 2 et 3 : tous les éléments dont la classe n'est pas exclue sont décodés (audit),
        // puis les règles de relation s'appliquent comme dans `geometry::build`.
        if !release.is_some_and(|year| revit::native::SUPPORTED_RELEASES.contains(&year)) {
            continue;
        }
        let wanted = |_: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded_class(&info.class).is_none();
        let work = |scene: &saved::Scene, id: u64, graph: &ObjectGraph| Work {
            faces: faces_of(scene, graph),
            triangles: saved::shape(scene, id, graph).mesh.triangles(),
            restricted: restricted_instances(scene, graph),
            bounds: Bounds::of_graph(graph),
            symbols: saved::symbol_references(graph),
        };
        let Ok(scan) = saved::scan(&mut file, &wanted, 1, &work) else { continue };
        let (mut before, mut after) = (0usize, 0usize);
        let mut before_triangles = 0usize;
        // Partie 4 : les éléments dessinés (source connue) qui portent des instances à cibles interdites.
        let mut placers: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
        let mut candidates: Vec<(u64, Vec<Restricted>, Option<Bounds>)> = Vec::new();
        for (id, result) in &scan.results {
            let Some(work) = result else { continue };
            if incomplete_report.last().is_some_and(|file| file.source_of.contains_key(id)) {
                for symbol in &work.symbols {
                    placers.entry(*symbol).or_default().push(*id);
                    let class = scan.scene.infos.get(symbol).map_or("(sans enregistrement d'élément)".to_string(), |info| info.class.clone());
                    let entry = placed_classes.entry(class).or_insert((0, BTreeSet::new(), format!("{name} {id} -> {symbol}")));
                    entry.0 += 1;
                    entry.1.insert((file_index, *symbol));
                }
                if !work.restricted.is_empty() {
                    candidates.push((*id, work.restricted.clone(), work.bounds));
                }
            }
        }
        if let Some(report) = incomplete_report.last_mut() {
            for (id, instances, bounds) in candidates {
                let in_metres = bounds.map(|b| {
                    let f = geometry::pack::FOOT;
                    let (a, c) = ([b.low[0] * f, b.low[2] * f, -b.low[1] * f], [b.high[0] * f, b.high[2] * f, -b.high[1] * f]);
                    ([a[0].min(c[0]), a[1].min(c[1]), a[2].min(c[2])], [a[0].max(c[0]), a[1].max(c[1]), a[2].max(c[2])])
                });
                let mut same_symbol: BTreeSet<u64> = BTreeSet::new();
                for instance in &instances {
                    for other in instance.symbol.and_then(|symbol| placers.get(&symbol)).into_iter().flatten() {
                        if *other != id {
                            same_symbol.insert(*other);
                        }
                    }
                }
                let mut overlapping = Vec::new();
                if let Some((low, high)) = in_metres {
                    // Volume commun des deux boîtes, rapporté à celle de l'élément (épaisseur minimale 1 mm).
                    let side = |low: f64, high: f64| (high - low).max(1e-3);
                    let volume = (0..3).map(|axis| side(low[axis], high[axis])).product::<f64>();
                    for (other, (other_low, other_high)) in &report.extents {
                        if *other == id {
                            continue;
                        }
                        let shared = (0..3).map(|axis| side(low[axis].max(other_low[axis]), high[axis].min(other_high[axis]).max(low[axis].max(other_low[axis])))).product::<f64>();
                        let disjoint = (0..3).any(|axis| high[axis].min(other_high[axis]) < low[axis].max(other_low[axis]));
                        if !disjoint && shared / volume >= 0.5 {
                            overlapping.push((*other, shared / volume));
                        }
                    }
                }
                let class = scan.scene.infos.get(&id).map_or(String::new(), |info| info.class.clone());
                let box_gap = match (in_metres, report.extents.get(&id)) {
                    (Some((low, high)), Some((mesh_low, mesh_high))) => Some((0..3).map(|axis| (low[axis] - mesh_low[axis]).abs().max((high[axis] - mesh_high[axis]).abs())).fold(0.0, f64::max)),
                    _ => None,
                };
                report.restricted.push(RestrictedRow { id, class, instances, bounds: in_metres, box_gap, same_symbol: same_symbol.into_iter().collect(), overlapping });
            }
        }
        for (id, result) in scan.results {
            let Some(Work { faces: outcomes, triangles, .. }) = result else { continue };
            if triangles == 0 {
                continue;
            }
            before += 1;
            before_triangles += triangles;
            let facts = scan.scene.facts(&scan.scene.infos[&id]);
            if let Some(reason) = classes::excluded_relation(&facts) {
                let row = removed.entry(reason).or_default();
                row.0 += 1;
                row.1 += triangles;
                continue;
            }
            after += 1;
            for result in outcomes {
                elements_with_faces.insert((file_index, id));
                match result.before {
                    Outcome::Meshed => {
                        faces_ok += 1;
                        faces_total += 1;
                    }
                    Outcome::Unbounded(surface) => {
                        faces_total += 1;
                        let entry = unbounded.entry(surface).or_default();
                        entry.faces += 1;
                        entry.elements.insert((file_index, id));
                    }
                    Outcome::Failed(surface, message) => {
                        faces_total += 1;
                        let entry = failed.entry((surface, message)).or_default();
                        entry.faces += 1;
                        entry.elements.insert((file_index, id));
                    }
                }
                match result.after {
                    AfterKind::Rvt => finals[0] += 1,
                    AfterKind::Own => {
                        finals[1] += 1;
                        elements_touched.insert((file_index, id));
                    }
                    AfterKind::Reference => finals[2] += 1,
                    AfterKind::EmptyTrim => finals[3] += 1,
                    AfterKind::Failed(surface, message) => {
                        finals[4] += 1;
                        elements_failing.insert((file_index, id));
                        let entry = remaining.entry((surface, message)).or_default();
                        entry.faces += 1;
                        entry.elements.insert((file_index, id));
                    }
                }
            }
        }
        per_file.push((name, before, before_triangles, after));
    }

    println!("== Règle de dessin, classe par classe (tous les fichiers)");
    println!("{:<34} {:<16} {:>8} {:>7} {:>7} {:>7} {:>7} {:>6} {:>7} {:>6} {:>6} {:>6}", "classe", "décision", "éléments", "dessinés", "2 faces", "relat.", "symb.", "dans", "vides", "illis.", "sansf.", "ident.");
    let mut rows: Vec<_> = classes_total.iter().collect();
    rows.sort_by_key(|(_, row)| std::cmp::Reverse((row.drawn, row.elements)));
    for (class, row) in rows {
        let interesting = row.drawn + row.excluded_by_relation + row.symbols + row.inside_owner + row.empty + row.unreadable > 0 || row.excluded.is_some() && row.elements > 0;
        if !interesting {
            continue;
        }
        let decision = match (row.excluded, row.drawn) {
            (Some(reason), _) => format!("exclu ({reason})"),
            (None, 0) => "gardé (rien)".to_string(),
            (None, _) => "dessiné".to_string(),
        };
        println!(
            "{:<34} {:<16.16} {:>8} {:>7} {:>7} {:>7} {:>7} {:>6} {:>7} {:>6} {:>6} {:>6}",
            if class.is_empty() { "?" } else { class },
            decision,
            row.elements,
            row.drawn,
            row.double_sided,
            row.excluded_by_relation,
            row.symbols,
            row.inside_owner,
            row.empty,
            row.unreadable,
            row.not_geometric,
            row.identical
        );
    }
    println!("\n== Règles d'exclusion : enregistrements d'éléments écartés (tous les fichiers 2023+)");
    for (reason, count) in &rules_total {
        println!("  {count:>7} : {reason}");
    }
    println!("\n== Ce que retire chaque règle de relation, parmi les éléments qui avaient une forme (tous les fichiers 2023+)");
    println!("{:>8} {:>10}  règle", "éléments", "triangles");
    for reason in classes::RELATION_REASONS {
        let (elements, triangles) = removed.get(reason).copied().unwrap_or_default();
        println!("{elements:>8} {triangles:>10}  {reason}");
    }
    println!("{:<44} {:>14} {:>12} {:>14}", "fichier", "avec forme", "triangles", "dessinés après");
    for (name, before, triangles, after) in &per_file {
        println!("{name:<44} {before:>14} {triangles:>12} {after:>14}");
    }
    println!("éléments qui dessinent exactement les mêmes triangles qu'un autre (gardés : DROP_IDENTICAL = {}) : {identical_total}", geometry::DROP_IDENTICAL);
    let ignored: usize = classes_total.values().filter(|row| row.drawn + row.empty + row.unreadable + row.symbols + row.inside_owner == 0 && row.excluded.is_none()).map(|row| row.elements).sum();
    println!("(classes sans aucune forme et non exclues, non listées : {ignored} éléments)");
    println!("\nRaisons d'exclusion par classe :");
    let mut reasons: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (class, row) in &classes_total {
        if let Some(reason) = row.excluded {
            if row.elements > 0 {
                reasons.entry(reason).or_default().push(class);
            }
        }
    }
    for (reason, list) in reasons {
        println!("  {reason} : {}", list.join(", "));
    }
    if !ifc_types.is_empty() {
        println!("\nTypes IFC des éléments de l'export (fichiers d'avant 2023) : {ifc_types:?}");
    }

    print_incomplete(&incomplete_report);
    print_restricted(&incomplete_report);
    println!("\n== Classe Revit des symboles que placent les instances des éléments dessinés");
    println!("{:<44} {:>10} {:>9}  exemple", "classe du symbole", "placements", "distincts");
    for (class, (placements, symbols, example)) in &placed_classes {
        println!("{class:<44} {placements:>10} {:>9}  {example}", symbols.len());
    }

    println!("\n== Faces enregistrées avec rvt-rs seul, par classe de surface (fichiers 2023+)");
    println!("faces maillées : {faces_ok} sur {faces_total}");
    println!("{:<28} {:>8} {:>9}", "classe de surface", "faces", "éléments");
    let mut rows: Vec<_> = unbounded.iter().collect();
    rows.sort_by_key(|(_, missing)| std::cmp::Reverse(missing.faces));
    for (surface, missing) in rows {
        println!("{surface:<28} {:>8} {:>9}   (face sans contour borné)", missing.faces, missing.elements.len());
    }
    let mut rows: Vec<_> = failed.iter().collect();
    rows.sort_by_key(|(_, missing)| std::cmp::Reverse(missing.faces));
    for ((surface, message), missing) in rows {
        println!("{surface:<28} {:>8} {:>9}   {message}", missing.faces, missing.elements.len());
    }

    println!("\n== Faces enregistrées avec geometry::faces (rvt-rs d'abord, puis ce module)");
    let [by_rvt, by_us, references, empties, lost] = finals;
    let drawn_faces = by_rvt + by_us + lost;
    println!("maillées par rvt-rs : {by_rvt}");
    println!("maillées par geometry::faces : {by_us}  (sur {} éléments)", elements_touched.len());
    println!("plans sans contour (faces de référence, jamais dessinées) : {references}");
    println!("découpes vides reconnues par rvt-rs : {empties}");
    println!("non maillées : {lost}  (sur {} éléments)", elements_failing.len());
    println!("total {faces_total} faces ; part des faces à dessiner qui se maillent : {:.2} % ({} sur {drawn_faces}) ; sur l'ensemble des faces : {:.2} %", 100.0 * (by_rvt + by_us) as f64 / drawn_faces.max(1) as f64, by_rvt + by_us, 100.0 * (by_rvt + by_us + empties) as f64 / faces_total.max(1) as f64);
    println!("éléments avec au moins une face : {} ; avec une face non maillée : {}", elements_with_faces.len(), elements_failing.len());
    if !remaining.is_empty() {
        println!("{:<28} {:>8} {:>9}", "reste, par surface", "faces", "éléments");
        let mut rows: Vec<_> = remaining.iter().collect();
        rows.sort_by_key(|(_, missing)| std::cmp::Reverse(missing.faces));
        for ((surface, message), missing) in rows {
            println!("{surface:<28} {:>8} {:>9}   {message}", missing.faces, missing.elements.len());
        }
    }
    ExitCode::SUCCESS
}
