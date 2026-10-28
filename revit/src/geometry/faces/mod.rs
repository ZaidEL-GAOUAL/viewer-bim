//! Maillage de toutes les faces que Revit a enregistrées.
//!
//! Revit enregistre, pour chaque élément dessiné, la géométrie qu'il a produite en dernier : des
//! faces de B-rep (une surface et ses boucles d'arêtes) et des maillages. rvt-rs n'en maille qu'une
//! partie (plans et cylindres à contour simple, surfaces réglées et de révolution rectangulaires) ;
//! ce module reprend les autres à partir des données de la face elle-même :
//!
//! * `surface` : plan, cylindre, cône, révolution, surface réglée et surface d'Hermite (`HermiteSurf`), avec leurs normales ;
//! * `curve` : les courbes de profil (droite, arc, ellipse, spline d'Hermite, NURBS) ;
//! * `loops` : les boucles de contour, lues dans les arêtes (points (u, v) des deux côtés), avec les
//!   pôles (sommet d'un cône ou d'un éventail) ramenés à la génératrice qui y arrive ;
//! * `refine` : les arêtes partagées, affinées des deux côtés à la fois quand les points que Revit
//!   enregistre (tous les 15° à 45°) laisseraient des cordes de plus de 1 mm, ou reprises sur la grille de la voisine
//!   quand c'est rvt-rs qui la maille (cylindre, révolution : `refine::Grid`) ;
//! * `region` + `tess` : la région (u, v) délimitée par les boucles, triangulée (Delaunay contraint,
//!   toutes les arêtes de boucle présentes : deux faces voisines gardent les mêmes sommets) avec une
//!   grille de points intérieurs pour les surfaces courbes, puis reportée sur la surface ;
//! * `check` : les contrôles de `examples/faces.rs` et des essais ;
//! * `select` : quels nœuds du graphique se dessinent dans une vue 3D ombrée (le parcours de rvt-rs, plus
//!   les nœuds que les fichiers d'essai rendent lisibles : voir sa documentation) ;
//! * `cache` : ce qui se garde d'une instance à l'autre (index d'arêtes, faces maillées des symboles).
//!
//! Chaque face passe d'abord par rvt-rs (`native_saved_mesh::face`) : celles qu'il sait mailler
//! gardent exactement ses triangles, sauf les surfaces réglées et les plans qui touchent une surface que ce
//! module affine à sa façon (`PLANE_NEIGHBOURS_FOR_US` : surface réglée, cône, Hermite, cylindre), que ce
//! module maille d'abord. Les transformations et les `GPolyMesh` sont ceux de
//! `native_saved_mesh::graphics_with_resolver_at_detail`, avec en plus les normales par sommet,
//! par facette ou absentes. Avec `Settings::prudent`, rien de ce module ne tourne : c'est rvt-rs seul
//! (voir `graphics_with`).
//!
//! ## Les plans sans contour
//!
//! Un plan dont `m_pFirstLoop` est nul n'a aucune région à mailler : on ne sait de lui que le pavé
//! (u, v) de son plan. Sur les 16 fichiers d'essai, 611 éléments (murs, poteaux, escaliers, garde-corps)
//! en portent 1 835, et chacun de ces éléments est déjà une coque fermée sans eux (surface vectorielle
//! nulle) : ce ne sont pas des morceaux manquants. Dessinés sur leur pavé, ils ajouteraient des
//! rectangles flottants (le mur 16788 de Core Interior, de 15 pieds de haut, en reçoit un à 0,25 pied
//! de son extrémité). rvt-rs écarte de même ses « découpes vides ». Ils sont donc comptés à part
//! (`reference_faces`) et ne rendent pas la forme « partielle » ; `MESH_REFERENCE_FACES` les dessine.

/// Dessiner aussi les plans sans contour, sur tout leur pavé (u, v) ? Non : voir plus haut. Passer à
/// `true` pour les voir (par `examples/glb.rs`) : chacun devient un rectangle posé sur son plan.
pub const MESH_REFERENCE_FACES: bool = false;

pub mod cache;
pub mod check;
pub mod curve;
pub mod graph;
pub mod loops;
pub mod math;
pub mod refine;
pub mod region;
pub mod select;
pub mod surface;
pub mod tess;

use std::sync::Arc;

use anyhow::{Context, Result, bail, ensure};
use rvt::research::native_empty_faces::is_observed_empty_trim_face;
use rvt::research::native_graphics_traversal::GraphicsTransform;
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_saved_mesh::{CylinderTessellationProfile, FaceMesh, Primitive, cylinder_face, face as rvt_face, graphics_with_resolver_at_detail, pointer};

pub use cache::FaceCache;
use cache::Node;

/// Ce qu'une face devient.
#[derive(Debug, Clone)]
pub enum Outcome {
    /// rvt-rs sait la mailler : ses triangles, inchangés.
    Rvt(FaceMesh),
    /// Maillée par ce module (rvt-rs la refusait).
    Own(FaceMesh),
    /// Plan sans aucun contour : face de référence que Revit n'affiche pas.
    Reference,
    /// Enregistrement de découpe vide, reconnu par rvt-rs.
    EmptyTrim,
    /// Aucune méthode n'y arrive : classe de la surface et raison.
    Failed { surface: String, reason: String },
}

/// Les classes de surface dont un plan voisin se maille par ce module et non par rvt-rs, avec la raison :
///
/// * `RuledSurf` : rvt-rs reporte sur le contour du plan la grille de la surface réglée voisine (960 points pour une dalle
///   de 9 points enregistrés, dans Vignette-04) et le découpe alors en oreilles, un travail qui croît plus vite que le
///   carré du nombre de sommets (0,77 s la face, 2 s par élément de la tour) ; la triangulation de ce module est de l'ordre
///   de n log n et garde les points enregistrés ;
/// * `ConeSurf`, `HermiteSurf` : rvt-rs ne maille pas ces surfaces, ce module si, et il affine leur arête avec le plan
///   (`refine`) ; rvt-rs, lui, ne touche l'arête d'un plan que si sa voisine est un cylindre, une révolution ou une
///   surface réglée : le plan garderait son polygone enregistré (tous les 15°), et une fente de 2,6 mm s'ouvrirait contre
///   le cercle d'un cône de 1 pied de rayon, 23 mm à 45° ;
/// * `CylSurf` : rvt-rs affine l'arête du plan sur la grille de son profil par défaut (0,001 pied de flèche), plus fine
///   que celle de ses cylindres (`tess::CHORD_ERROR`, voir `cylinder_at_chord`) : un trou rond d'un pied de rayon dans une
///   dalle montrait une fente de 0,8 mm. Le plan se maille ici, sur la grille même du cylindre (`cylinder_grid`).
///
/// Un plan dont les voisines sont des plans ou des révolutions reste à rvt-rs : contre un plan, personne n'affine l'arête ;
/// contre une révolution, rvt-rs l'affine sur la grille de la révolution, qu'il maille lui-même. Un plan qui touche une
/// révolution et l'une des classes ci-dessus est maillé ici, sur la grille de la révolution aussi (`revolution_grid`).
const PLANE_NEIGHBOURS_FOR_US: [&str; 4] = ["RuledSurf", "ConeSurf", "HermiteSurf", "CylSurf"];

/// Mailler une face : rvt-rs d'abord, puis ce module ; sauf les surfaces réglées, que ce module maille d'abord
/// (voir `tess::ruled_knots`) : rvt-rs y met une maille par pied du plus long profil de toute la composante
/// connexe, soit plus de 27 000 triangles pour chacune des faces de Vignette-04, grandes ou petites, plates ou
/// gauches. S'il ne sait pas la mailler, rvt-rs reste le recours.
pub fn mesh_face(graph: &ObjectGraph, face: usize) -> Outcome {
    // Les plans qui touchent une surface que ce module affine à sa façon (`PLANE_NEIGHBOURS_FOR_US`) : les deux faces d'une
    // arête partagée doivent y poser les mêmes sommets.
    let class = surface_class(graph, face);
    if class == "RuledSurf" || (class == "Plane" && loops::has_neighbour_surface_in(graph, face, &PLANE_NEIGHBOURS_FOR_US)) {
        if let Ok(Some(mesh)) = guarded_own_mesh(graph, face) {
            return Outcome::Own(mesh);
        }
    }
    // Les cylindres de rvt-rs, à la flèche de ce module (`tess::CHORD_ERROR`) plutôt qu'à son profil par défaut (0,001 pied).
    let rvt = if class == "CylSurf" { cylinder_at_chord(graph, face) } else { rvt_face(graph, face) };
    match rvt {
        Ok(Some(mesh)) => return Outcome::Rvt(mesh),
        Ok(None) if is_observed_empty_trim_face(graph, face) => return Outcome::EmptyTrim,
        // Sans boucle : plan de référence, ou surface courbe sans arête (traitée par `tess`).
        Ok(None) | Err(_) => {}
    }
    // Rattrape une panique de la triangulation (la face est alors comptée comme non maillée, comme toute
    // autre erreur) là où le déroulement existe, c'est-à-dire en natif. En WebAssembly (`panic = abort`),
    // cela ne rattrape rien : c'est `tess` et `region` qui n'ont aucune panique possible par construction
    // (voir `region::triangulate`), et `Settings::prudent` qui évite ce module tout entier.
    let attempt = guarded_own_mesh(graph, face);
    match attempt {
        Ok(Some(mesh)) => Outcome::Own(mesh),
        Ok(None) => Outcome::Reference,
        Err(error) => Outcome::Failed { surface: surface_class(graph, face), reason: format!("{error:#}") },
    }
}

/// Le profil des cylindres de rvt-rs : la flèche de ce module, et la hauteur maximale d'une maille de rvt-rs.
const CYLINDER_PROFILE: CylinderTessellationProfile = CylinderTessellationProfile { chord_error: tess::CHORD_ERROR, max_v_edge: 1.0 };

/// La grille de sommets que rvt-rs pose sur la surface de révolution `face` quand `mesh_face` le lui laisse mailler
/// (`rvt_face` aboutit) : comme pour un cylindre (`cylinder_grid`), les faces voisines que ce module maille la reprennent.
pub fn revolution_grid(graph: &ObjectGraph, face: usize) -> Option<refine::Grid> {
    use rvt::research::native_parametric_surface::ParametricSurface;
    let mesh = rvt_face(graph, face).ok()??;
    let surface = graph::target(graph, face, &graph.objects[face].fields["m_pSurf"]).ok()??;
    match ParametricSurface::read(graph, surface).ok()? {
        ParametricSurface::SurfRev { profile, .. } => refine::Grid::revolution(&profile, &mesh.trim_uv),
        ParametricSurface::RuledSurf { .. } => None,
    }
}

/// Un cylindre maillé par rvt-rs (`cylinder_face`) à la flèche `tess::CHORD_ERROR`, avec les mêmes refus que
/// `native_saved_mesh::face` : sans contour, pas de maillage (face de référence) ; avec des régions de face, pas de
/// cylindre simple.
fn cylinder_at_chord(graph: &ObjectGraph, face: usize) -> Result<Option<FaceMesh>> {
    let fields = &graph.objects[face].fields;
    if pointer(graph, face, &fields["m_pFirstLoop"])?.is_none() {
        return Ok(None);
    }
    ensure!(fields["m_faceRegions"].as_array().context("régions de face")?.is_empty(), "face regions need subdivision");
    cylinder_face(graph, face, CYLINDER_PROFILE).map(Some)
}

/// La grille de sommets que rvt-rs pose sur le cylindre `face` quand `mesh_face` le lui laisse mailler (`cylinder_at_chord`
/// aboutit) : c'est elle qui décide des sommets de ses côtés, et les faces voisines que ce module maille doivent les
/// reprendre (voir `refine::Grid`). `None` si rvt-rs ne maille pas ce cylindre : ce module le fait alors lui-même, avec
/// les points que `refine` donne aux deux côtés de chaque arête.
pub fn cylinder_grid(graph: &ObjectGraph, face: usize) -> Option<refine::Grid> {
    let mesh = cylinder_at_chord(graph, face).ok()??;
    let cylinder = mesh.analytic_surface.as_ref()?;
    refine::Grid::cylinder(cylinder.radius, &mesh.trim_uv, CYLINDER_PROFILE.chord_error, CYLINDER_PROFILE.max_v_edge)
}

/// `own_mesh`, avec la panique de la triangulation rattrapée là où le déroulement existe (voir `mesh_face`).
fn guarded_own_mesh(graph: &ObjectGraph, face: usize) -> Result<Option<FaceMesh>> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| own_mesh(graph, face))).unwrap_or_else(|_| Err(anyhow::anyhow!("panique pendant le maillage de la face")))
}

/// Classe de la surface d'une face (`?` si elle est introuvable).
pub fn surface_class(graph: &ObjectGraph, face: usize) -> String {
    graph::target(graph, face, &graph.objects[face].fields["m_pSurf"])
        .ok()
        .flatten()
        .map_or_else(|| "?".to_string(), |surface| graph.objects[surface].class_name.clone())
}

/// Le maillage de ce module pour une face, au format de rvt-rs.
fn own_mesh(graph: &ObjectGraph, face: usize) -> Result<Option<FaceMesh>> {
    let Some(geometry) = tess::tessellate(graph, face)? else { return Ok(None) };
    let fields = &graph.objects[face].fields;
    let render_style_id = graph::identifier(&fields["m_renderStyleId"]).context("identifiant de style de rendu absent")?;
    let normal = geometry.normals.first().copied().unwrap_or([0.0, 0.0, 1.0]);
    Ok(Some(FaceMesh {
        face_index: face,
        face_tag: fields["m_GInfo"]["m_tag"].as_i64().unwrap_or(-1),
        render_style_id,
        vertices: geometry.vertices,
        triangles: geometry.triangles,
        normal,
        normals: geometry.normals,
        analytic_surface: None,
        trim_uv: Vec::new(),
    }))
}

/// Les primitives maillées d'un élément, avec ce qui n'a pas pu l'être.
#[derive(Debug, Default)]
pub struct Meshes {
    pub primitives: Vec<Primitive>,
    /// Pour chaque primitive : vrai si elle vient de ce module (rvt-rs avait refusé la face).
    pub ours: Vec<bool>,
    /// Problèmes de parcours, de transformation ou de GPolyMesh (pas de faces) : ceux du parcours d'abord, puis ceux
    /// des nœuds (`node_diagnostics` derniers).
    pub diagnostics: Vec<String>,
    pub node_diagnostics: usize,
    /// Faces qu'aucune méthode n'a su mailler.
    pub unbounded_faces: usize,
    /// Leur classe de surface et la raison.
    pub failures: Vec<(String, String)>,
    /// Plans sans contour : faces de référence non dessinées.
    pub reference_faces: usize,
    /// Découpes vides reconnues par rvt-rs.
    pub empty_trim_faces: usize,
    /// Instances imbriquées que l'élément référence (`GComponentRef`) et ne redessine pas : elles se
    /// dessinent comme éléments (voir `select`).
    pub components: Vec<u64>,
    /// Les instances d'un symbole pas encore lu, laissées pour plus tard (`Settings::defer`), avec la place de ce
    /// qu'elles produiront : voir [`complete`].
    pub pending: Vec<PendingPlacement>,
}

/// Une instance laissée pour plus tard, et où insérer ce qu'elle produira dans les listes de `Meshes`.
#[derive(Debug, Clone)]
pub struct PendingPlacement {
    pub pending: select::Pending,
    pub primitives_at: usize,
    /// Dans les diagnostics du parcours (en tête de `diagnostics`), et dans ceux des nœuds (à la suite).
    pub walk_diagnostics_at: usize,
    pub node_diagnostics_at: usize,
    pub failures_at: usize,
    pub components_at: usize,
}

/// Comment mailler les graphiques d'un élément.
#[derive(Debug, Clone, Copy)]
pub struct Settings<'c> {
    /// Niveau de détail de la vue (1 à 3).
    pub detail_level: i64,
    /// Mode prudent : rvt-rs seul (son parcours, ses faces, ses `GPolyMesh`), aucune face maillée par ce
    /// module. Une face qu'il refuse reste manquante, comme avant l'existence de ce module. C'est le
    /// recours quand une panique de ce module a interrompu une lecture (voir `Options::prudent`).
    pub prudent: bool,
    /// Ce qui se garde d'une instance à l'autre ; `None` pour un élément seul. Un cache ne se partage
    /// qu'entre appels aux mêmes réglages.
    pub cache: Option<&'c FaceCache>,
    /// Laisser pour plus tard les instances d'un symbole pas encore lu (`Meshes::pending`), au lieu d'un
    /// diagnostic : la lecture les achève après avoir lu les symboles (`complete`).
    pub defer: bool,
}

/// Mailler les graphiques d'un élément, sans cache, au niveau de détail `detail_level`.
pub fn graphics<'a>(root: &'a ObjectGraph, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, detail_level: i64) -> Meshes {
    graphics_with(root, resolver, &Settings { detail_level, prudent: false, cache: None, defer: false })
}

/// Mailler les graphiques d'un élément : mêmes transformations et mêmes primitives que
/// `native_saved_mesh::graphics_with_resolver_at_detail`, avec la sélection de `select` et les faces que ce
/// module sait mailler. Une face qui échoue ne fait plus perdre tout son nœud `Geometry`.
pub fn graphics_with<'a>(root: &'a ObjectGraph, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, settings: &Settings<'_>) -> Meshes {
    if settings.prudent {
        return rvt_only(root, resolver, settings.detail_level);
    }
    let edges_of = |owner: u64, graph: &ObjectGraph| match settings.cache {
        Some(cache) => cache.edges(owner, graph),
        None => Arc::new(select::edge_index(graph)),
    };
    let shapes_of = |owner: u64| settings.cache.and_then(|cache| cache.shape(owner));
    let selection = select::select_deferring(root, resolver, &edges_of, &shapes_of, settings.detail_level, settings.defer);
    mesh_selection(selection, root, resolver, settings)
}

/// Rejoue une instance laissée pour plus tard (`Meshes::pending`), maintenant que son symbole est lu : les primitives,
/// diagnostics, échecs et composants qu'elle produit, à insérer aux places que `placement` indique (voir `complete`).
pub fn place<'a>(placement: &PendingPlacement, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, settings: &Settings<'_>) -> Meshes {
    let edges_of = |owner: u64, graph: &ObjectGraph| match settings.cache {
        Some(cache) => cache.edges(owner, graph),
        None => Arc::new(select::edge_index(graph)),
    };
    let shapes_of = |owner: u64| settings.cache.and_then(|cache| cache.shape(owner));
    let selection = select::place_pending(&placement.pending, resolver, &edges_of, &shapes_of, settings.detail_level);
    // Les nœuds d'un placement sont tous d'un symbole : le graphe de l'élément ne sert pas.
    mesh_selection(selection, select::empty_graph(), resolver, settings)
}

/// Achève `meshes` : chaque instance laissée pour plus tard est rejouée (`place`) et ce qu'elle produit est inséré à
/// sa place, dans l'ordre du parcours ; le résultat est exactement ce que `graphics_with` aurait rendu avec tous les
/// symboles sous la main.
pub fn complete<'a>(meshes: &mut Meshes, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, settings: &Settings<'_>) {
    let placements = std::mem::take(&mut meshes.pending);
    let walk_total = meshes.diagnostics.len() - meshes.node_diagnostics;
    // Les places sont celles du parcours initial : chaque insertion décale les suivantes.
    let (mut d_primitives, mut d_walk, mut d_node, mut d_failures, mut d_components) = (0usize, 0usize, 0usize, 0usize, 0usize);
    for placement in &placements {
        let placed = place(placement, resolver, settings);
        let at = placement.primitives_at + d_primitives;
        let count = placed.primitives.len();
        meshes.primitives.splice(at..at, placed.primitives);
        meshes.ours.splice(at..at, placed.ours);
        d_primitives += count;
        let placed_walk = placed.diagnostics.len() - placed.node_diagnostics;
        let (walk_part, node_part) = placed.diagnostics.split_at(placed_walk);
        let at = placement.walk_diagnostics_at + d_walk;
        meshes.diagnostics.splice(at..at, walk_part.iter().cloned());
        d_walk += placed_walk;
        let at = walk_total + d_walk + placement.node_diagnostics_at + d_node;
        meshes.diagnostics.splice(at..at, node_part.iter().cloned());
        d_node += node_part.len();
        meshes.node_diagnostics += node_part.len();
        let at = placement.failures_at + d_failures;
        let count = placed.failures.len();
        meshes.failures.splice(at..at, placed.failures);
        d_failures += count;
        let at = placement.components_at + d_components;
        let count = placed.components.len();
        meshes.components.splice(at..at, placed.components);
        d_components += count;
        meshes.unbounded_faces += placed.unbounded_faces;
        meshes.reference_faces += placed.reference_faces;
        meshes.empty_trim_faces += placed.empty_trim_faces;
    }
}

/// Maille les nœuds d'une sélection : les primitives dans l'ordre des nœuds, les diagnostics du parcours puis ceux
/// des nœuds, et la place de chaque instance laissée pour plus tard.
fn mesh_selection<'a>(selection: select::Selection, root: &'a ObjectGraph, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, settings: &Settings<'_>) -> Meshes {
    let mut out = Meshes { diagnostics: selection.diagnostics.iter().map(|(index, message)| format!("objet {index} : {message}")).collect(), components: selection.components, ..Default::default() };
    let walk_diagnostics = out.diagnostics.len();
    let mut pending = selection.pending.into_iter().peekable();
    for (position, selected) in selection.selected.into_iter().enumerate() {
        while let Some(next) = pending.peek() {
            if next.selected_at > position {
                break;
            }
            let next = pending.next().expect("placement en attente");
            out.pending.push(PendingPlacement { primitives_at: out.primitives.len(), walk_diagnostics_at: next.diagnostics_at, node_diagnostics_at: out.diagnostics.len() - walk_diagnostics, failures_at: out.failures.len(), components_at: next.components_at, pending: next });
        }
        let index = selected.object_index;
        // Les nœuds d'un symbole se maillent une fois pour toutes ses instances (voir `cache`) ; ceux d'un symbole
        // dont le graphe a été libéré y sont déjà, faces ou raison de l'échec.
        let kept = match (selected.source_owner_id, settings.cache) {
            (Some(owner), Some(cache)) => cache.cached(owner, index),
            _ => None,
        };
        let node: Result<Arc<Node>> = match kept {
            Some(cache::Cached::Node(node)) => Ok(node),
            Some(cache::Cached::Failed(reason)) => Err(anyhow::anyhow!("{reason}")),
            None => {
                let graph = match selected.source_owner_id {
                    None => root,
                    Some(id) => match resolver(id) {
                        Some(graph) => graph,
                        None => {
                            out.diagnostics.push(format!("le graphique du symbole {id} a disparu"));
                            continue;
                        }
                    },
                };
                match (selected.source_owner_id, settings.cache) {
                    (Some(owner), Some(cache)) => cache.node(owner, index, || decode(graph, index)),
                    _ => decode(graph, index).map(Arc::new),
                }
            }
        };
        let placed = node.and_then(|node| {
            let mut primitives = node.primitives.clone();
            for (primitive, _) in &mut primitives {
                primitive.source_owner_id = selected.source_owner_id;
                transform(primitive, selected.world_transform)?;
            }
            Ok((primitives, node))
        });
        match placed {
            Ok((primitives, node)) => {
                for (primitive, own) in primitives {
                    out.primitives.push(primitive);
                    out.ours.push(own);
                }
                out.unbounded_faces += node.unbounded;
                out.reference_faces += node.references;
                out.empty_trim_faces += node.empties;
                out.failures.extend(node.failures.iter().cloned());
            }
            Err(error) => out.diagnostics.push(format!("objet {index} : {error:#}")),
        }
    }
    // Les instances en attente après le dernier nœud.
    for next in pending {
        out.pending.push(PendingPlacement { primitives_at: out.primitives.len(), walk_diagnostics_at: next.diagnostics_at, node_diagnostics_at: out.diagnostics.len() - walk_diagnostics, failures_at: out.failures.len(), components_at: next.components_at, pending: next });
    }
    out.node_diagnostics = out.diagnostics.len() - walk_diagnostics;
    out
}

/// Le mode prudent : `native_saved_mesh::graphics_with_resolver_at_detail`, rien d'autre.
fn rvt_only<'a>(root: &'a ObjectGraph, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, detail_level: i64) -> Meshes {
    let meshes = graphics_with_resolver_at_detail(root, resolver, detail_level);
    Meshes {
        ours: vec![false; meshes.primitives.len()],
        primitives: meshes.primitives,
        node_diagnostics: 0,
        diagnostics: meshes.diagnostics,
        unbounded_faces: meshes.unbounded_faces,
        empty_trim_faces: meshes.empty_trim_faces,
        ..Default::default()
    }
}

/// Les faces d'un nœud `Geometry` ou `GPolyMesh`, dans le repère de son graphe (pas encore placées).
pub(crate) fn decode(graph: &ObjectGraph, index: usize) -> Result<Node> {
    let object = &graph.objects[index];
    let mut node = Node::default();
    if object.class_name == "Geometry" {
        for pointer_value in object.fields["m_pFaces"].as_array().context("faces du nœud Geometry absentes")? {
            let Some(face) = pointer(graph, index, pointer_value)? else {
                node.unbounded += 1;
                node.failures.push(("?".to_string(), "pointeur de face nul".to_string()));
                continue;
            };
            let (mesh, own) = match mesh_face(graph, face) {
                Outcome::Rvt(mesh) => (mesh, false),
                Outcome::Own(mesh) => (mesh, true),
                Outcome::Reference => {
                    node.references += 1;
                    continue;
                }
                Outcome::EmptyTrim => {
                    node.empties += 1;
                    continue;
                }
                Outcome::Failed { surface, reason } => {
                    node.unbounded += 1;
                    node.failures.push((surface, reason));
                    continue;
                }
            };
            let normals = if mesh.normals.len() == mesh.vertices.len() { mesh.normals.clone() } else { vec![mesh.normal; mesh.vertices.len()] };
            node.primitives.push((
                Primitive {
                    source_owner_id: None,
                    object_index: index,
                    face_tag: mesh.face_tag,
                    render_style_id: mesh.render_style_id,
                    material_id: None,
                    vertices: mesh.vertices,
                    normals,
                    triangles: mesh.triangles,
                },
                own,
            ));
        }
    } else if object.class_name == "GPolyMesh" {
        node.primitives.push((poly_mesh(graph, index)?, false));
    }
    Ok(node)
}

/// Un nœud `GPolyMesh` : un maillage de facettes que Revit a stocké tel quel (terrain, pièces de mur
/// rideau, contenus RPC, appareils d'éclairage). Les triangles sont ceux du maillage ; les normales
/// dépendent de `m_normalsFlag` de sa topologie, que les fichiers d'essai donnent ainsi :
///
/// * indicateur 0 : une normale par sommet. Dans les terrains, le nombre de normales est celui des points
///   et pas celui des facettes (146 points et 146 normales pour 144 facettes, 558 pour 928 facettes), et
///   sur 558 points les trois normales de sommet concordent avec la facette dans 928 cas sur 928, la
///   « i-ème normale » dans 30 : les sommets sont gardés tels quels, les normales s'interpolent ;
/// * indicateur 2 : une normale par facette (544 normales pour 544 facettes sur 304 points, 166 sur
///   168 points : la i-ème normale est celle du triangle i, à 1e-3 près, dans 544 cas sur 544 et 166 sur
///   166) : un sommet par coin, ombrage plat ;
/// * aucune normale : celle de chaque triangle.
///
/// `FacetedTopology8` n'ajoute à `FacetedTopology0` que `m_edgeVisFlagsArr` (visibilité des arêtes d'une
/// vue en fil de fer) : sans effet sur les surfaces. Un indicateur que le nombre de normales contredit est
/// refusé : un diagnostic, jamais une normale devinée.
fn poly_mesh(graph: &ObjectGraph, index: usize) -> Result<Primitive> {
    let object = &graph.objects[index];
    let topology_index = pointer(graph, index, &object.fields["m_pFacetedTopology"])?.context("topologie de facettes absente")?;
    let topology = &graph.objects[topology_index];
    ensure!(matches!(topology.class_name.as_str(), "FacetedTopology0" | "FacetedTopology8"), "topologie de facettes non prise en charge : {}", topology.class_name);
    let f = &topology.fields;
    let points = |name: &str, what: &str| -> Result<Vec<[f64; 3]>> { f[name].as_array().with_context(|| what.to_string())?.iter().map(graph::point3).collect() };
    let vertices = points("m_pointsArr", "points du maillage")?;
    let normals = points("m_normalsArr", "normales du maillage")?;
    let triangles = f["m_facetsArr"]
        .as_array()
        .context("facettes du maillage")?
        .iter()
        .map(|facet| -> Result<[u32; 3]> {
            let corners = facet.as_array().context("facette : tableau attendu")?;
            ensure!(corners.len() == 3, "facette qui n'est pas un triangle");
            let mut triangle = [0; 3];
            for (slot, corner) in triangle.iter_mut().zip(corners) {
                *slot = u32::try_from(corner.as_u64().context("facette : indice attendu")?)?;
                ensure!((*slot as usize) < vertices.len(), "facette : indice hors des points");
            }
            Ok(triangle)
        })
        .collect::<Result<Vec<_>>>()?;

    enum Binding {
        None,
        PerVertex,
        PerFacet,
    }
    let flag = f["m_normalsFlag"].as_u64();
    let binding = match (flag, normals.len()) {
        (_, 0) => Binding::None,
        (Some(0), count) if count == vertices.len() => Binding::PerVertex,
        // Par facette : l'indicateur 2, et l'indicateur 0 quand le nombre de normales n'est pas celui des points
        // (la lecture de rvt-rs).
        (Some(0 | 2), count) if count == triangles.len() => Binding::PerFacet,
        _ => bail!("liaison des normales non prise en charge (indicateur {flag:?}, {} normales pour {} points et {} facettes)", normals.len(), vertices.len(), triangles.len()),
    };
    let (face_tag, render_style_id, material_id) = (
        object.fields["m_GInfo"]["m_tag"].as_i64().unwrap_or(-1),
        graph::identifier(&object.fields["m_interiorGStyleID"]).context("style du maillage absent")?,
        Some(graph::identifier(&object.fields["m_materialID"]).context("matériau du maillage absent")?).filter(|id| *id >= 0),
    );
    if let Binding::PerVertex = binding {
        return Ok(Primitive { source_owner_id: None, object_index: index, face_tag, render_style_id, material_id, vertices, normals, triangles });
    }

    // Un sommet par coin de facette : une normale par facette, donnée ou celle du triangle.
    let mut expanded_vertices = Vec::with_capacity(triangles.len() * 3);
    let mut expanded_normals = Vec::with_capacity(triangles.len() * 3);
    let mut expanded_triangles = Vec::with_capacity(triangles.len());
    for (i, triangle) in triangles.iter().enumerate() {
        let base = expanded_vertices.len() as u32;
        let normal = if let Binding::PerFacet = binding {
            normals[i]
        } else {
            let [a, b, c] = triangle.map(|corner| vertices[corner as usize]);
            math::cross(math::sub(b, a), math::sub(c, a))
        };
        for corner in triangle {
            expanded_vertices.push(vertices[*corner as usize]);
            expanded_normals.push(normal);
        }
        expanded_triangles.push([base, base + 1, base + 2]);
    }
    Ok(Primitive { source_owner_id: None, object_index: index, face_tag, render_style_id, material_id, vertices: expanded_vertices, normals: expanded_normals, triangles: expanded_triangles })
}

/// Applique la transformation affine du nœud (colonne : repère local, ligne : monde) aux sommets
/// et aux normales d'une primitive ; une transformation qui inverse l'espace retourne les triangles.
fn transform(primitive: &mut Primitive, m: GraphicsTransform) -> Result<()> {
    let a = [m[0][0], m[1][0], m[2][0]];
    let b = [m[0][1], m[1][1], m[2][1]];
    let c = [m[0][2], m[1][2], m[2][2]];
    let (bc, ca, ab) = (math::cross(b, c), math::cross(c, a), math::cross(a, b));
    let det = (0..3).map(|i| a[i] * bc[i]).sum::<f64>();
    ensure!(det.is_finite() && det.abs() > 1e-12, "singular graphics transform");
    for vertex in &mut primitive.vertices {
        let old = *vertex;
        *vertex = std::array::from_fn(|i| m[i][3] + (0..3).map(|j| m[i][j] * old[j]).sum::<f64>());
        ensure!(vertex.iter().all(|x| x.is_finite()), "nonfinite transformed vertex");
    }
    for normal in &mut primitive.normals {
        let old = *normal;
        *normal = std::array::from_fn(|i| (bc[i] * old[0] + ca[i] * old[1] + ab[i] * old[2]) / det);
        let length = normal.iter().map(|v| v * v).sum::<f64>().sqrt();
        // Une normale indéfinie (vecteur nul) reste nulle : l'assemblage prend alors celle du triangle.
        if length > 1e-12 && length.is_finite() {
            for value in normal.iter_mut() {
                *value /= length;
            }
        } else {
            *normal = [0.0; 3];
        }
    }
    if det < 0.0 {
        for triangle in &mut primitive.triangles {
            triangle.swap(1, 2);
        }
    }
    Ok(())
}
