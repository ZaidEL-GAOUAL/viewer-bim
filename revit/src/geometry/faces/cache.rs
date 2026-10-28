//! Ce que la lecture d'un fichier garde d'une instance à l'autre : les formes parcourues des symboles de
//! famille (`select::SymbolShape`), les faces déjà maillées de leurs nœuds, et les index d'arêtes des
//! graphes de symboles qu'il a fallu garder.
//!
//! Une famille placée 400 fois (les poteaux, les portes d'un immeuble) a un seul graphique, celui de
//! son symbole ; chaque instance le parcourt, puis en transforme les faces. Mailler une face courbe
//! (la tentative de rvt-rs, la triangulation contrainte, la grille intérieure) coûte bien plus que de
//! la transformer : on ne la mène donc qu'une fois par nœud de symbole, dans le repère du symbole, et
//! chaque instance en copie le résultat avant de le placer.
//!
//! Le cache vit autant que la scène (`saved::Scene`) et se partage entre les fils de maillage. Deux régimes :
//! - un symbole dont la forme est connue (`shape`) n'a plus de graphe : ses nœuds sont gardés sans plafond
//!   (`keep`), puisqu'ils ne pourraient pas se recalculer ; ils pèsent ce que leurs instances copient de toute
//!   façon, jamais plus que le maillage du fichier ;
//! - un symbole dont le graphe est gardé (sa forme dépend de l'instance) a ses nœuds maillés à la demande
//!   (`node`), sous le plafond `MAX_CACHED_VERTICES` : au-delà, un nœud nouveau se mène sans être gardé.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_saved_mesh::Primitive;

use super::select::{EdgeIndex, SymbolShape, edge_index};
use crate::geometry::pack::FxMap;

/// Plafond de sommets gardés pour les nœuds maillés à la demande (environ 70 octets chacun avec leurs normales
/// et leurs triangles : 35 Mo).
pub const MAX_CACHED_VERTICES: usize = 500_000;

/// Les faces d'un nœud `Geometry` ou `GPolyMesh`, maillées, dans le repère de son graphe.
#[derive(Debug, Default)]
pub struct Node {
    /// Chaque primitive et si elle vient de ce module (rvt-rs avait refusé la face).
    pub primitives: Vec<(Primitive, bool)>,
    /// Faces qu'aucune méthode n'a su mailler.
    pub unbounded: usize,
    /// Plans sans contour (faces de référence, jamais dessinées).
    pub references: usize,
    /// Découpes vides reconnues par rvt-rs.
    pub empties: usize,
    /// Classe de surface et raison de chaque face non maillée.
    pub failures: Vec<(String, String)>,
}

impl Node {
    fn vertices(&self) -> usize {
        self.primitives.iter().map(|(primitive, _)| primitive.vertices.len()).sum()
    }
}

/// Un nœud gardé : ses faces, ou la raison pour laquelle elles n'ont pas pu se décoder (gardée aussi, pour que
/// chaque instance porte le même diagnostic qu'avec le graphe).
#[derive(Debug, Clone)]
pub enum Cached {
    Node(Arc<Node>),
    Failed(String),
}

#[derive(Default)]
pub struct FaceCache {
    edges: Mutex<FxMap<u64, Arc<EdgeIndex>>>,
    nodes: Mutex<FxMap<(u64, usize), Cached>>,
    shapes: Mutex<FxMap<u64, Arc<SymbolShape>>>,
    vertices: AtomicUsize,
    kept_vertices: AtomicUsize,
}

impl std::fmt::Debug for FaceCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FaceCache({} sommets à la demande, {} sommets gardés, {} formes)", self.vertices.load(Ordering::Relaxed), self.kept_vertices.load(Ordering::Relaxed), lock(&self.shapes).len())
    }
}

impl FaceCache {
    /// L'index des arêtes du graphe du symbole `owner`.
    pub fn edges(&self, owner: u64, graph: &ObjectGraph) -> Arc<EdgeIndex> {
        if let Some(index) = lock(&self.edges).get(&owner) {
            return Arc::clone(index);
        }
        // Calculé hors du verrou : deux fils peuvent le faire en même temps, le résultat est le même.
        let index = Arc::new(edge_index(graph));
        Arc::clone(lock(&self.edges).entry(owner).or_insert(index))
    }

    /// La forme parcourue du symbole `owner`, si elle est connue.
    pub fn shape(&self, owner: u64) -> Option<Arc<SymbolShape>> {
        lock(&self.shapes).get(&owner).map(Arc::clone)
    }

    pub fn has_shape(&self, owner: u64) -> bool {
        lock(&self.shapes).contains_key(&owner)
    }

    /// Garde la forme parcourue du symbole `owner` : ses instances se placeront sans son graphe.
    pub fn insert_shape(&self, owner: u64, shape: SymbolShape) {
        lock(&self.shapes).insert(owner, Arc::new(shape));
    }

    /// Nombre de formes de symboles gardées.
    pub fn shapes(&self) -> usize {
        lock(&self.shapes).len()
    }

    /// Le nœud `object` du symbole `owner`, s'il est déjà gardé.
    pub fn cached(&self, owner: u64, object: usize) -> Option<Cached> {
        lock(&self.nodes).get(&(owner, object)).cloned()
    }

    /// Les faces du nœud `object` du symbole `owner`, maillées par `compute` si elles ne le sont pas déjà,
    /// gardées sous le plafond `MAX_CACHED_VERTICES`. Une erreur n'est pas gardée.
    pub fn node(&self, owner: u64, object: usize, compute: impl FnOnce() -> anyhow::Result<Node>) -> anyhow::Result<Arc<Node>> {
        if let Some(Cached::Node(node)) = lock(&self.nodes).get(&(owner, object)) {
            return Ok(Arc::clone(node));
        }
        let node = Arc::new(compute()?);
        let vertices = node.vertices();
        if self.vertices.load(Ordering::Relaxed) + vertices <= MAX_CACHED_VERTICES {
            self.vertices.fetch_add(vertices, Ordering::Relaxed);
            lock(&self.nodes).insert((owner, object), Cached::Node(Arc::clone(&node)));
        }
        Ok(node)
    }

    /// Maille le nœud `object` du symbole `owner` par `compute` et le garde sans plafond, échec compris : le graphe
    /// du symbole va être libéré, rien ne pourra le recalculer.
    pub fn keep(&self, owner: u64, object: usize, compute: impl FnOnce() -> anyhow::Result<Node>) {
        if lock(&self.nodes).contains_key(&(owner, object)) {
            return;
        }
        let cached = match compute() {
            Ok(node) => {
                self.kept_vertices.fetch_add(node.vertices(), Ordering::Relaxed);
                Cached::Node(Arc::new(node))
            }
            Err(error) => Cached::Failed(format!("{error:#}")),
        };
        lock(&self.nodes).insert((owner, object), cached);
    }

    /// Sommets des nœuds gardés sans plafond (ceux des symboles dont le graphe a été libéré).
    pub fn kept_vertices(&self) -> usize {
        self.kept_vertices.load(Ordering::Relaxed)
    }
}

/// Un verrou empoisonné (un fil a paniqué) ne rend pas le cache faux : ses entrées sont complètes.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
