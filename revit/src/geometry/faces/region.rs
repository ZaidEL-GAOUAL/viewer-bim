//! Triangulation d'une région du plan (u, v) délimitée par des boucles : triangulation de
//! Delaunay contrainte (les arêtes des boucles sont toutes présentes, donc deux faces voisines
//! qui se partagent une arête gardent exactement les mêmes sommets : pas de fissure), avec, pour
//! les surfaces courbes, des points intérieurs sur une grille assez fine pour la flèche voulue.
//!
//! Le plan (u, v) est d'abord mis à l'échelle (`metric`) pour que les longueurs s'y rapprochent de
//! celles de l'espace : sans cela, une région de 0,01 radian sur 13 pieds donnerait des triangles
//! d'une finesse absurde. Les points rendus sont dans les unités d'origine.

use anyhow::{Result, bail};
use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};

use crate::geometry::pack::FxMap;

pub type Uv = [f64; 2];

/// Une boucle fermée : sommets consécutifs, sans répéter le premier à la fin.
pub type Loop = Vec<Uv>;

/// Résultat : des points (u, v) et des triangles antihoraires dans le plan (u, v).
#[derive(Debug, Clone, Default)]
pub struct Mesh2 {
    pub points: Vec<Uv>,
    pub triangles: Vec<[u32; 3]>,
    /// Côtés de contour que la triangulation n'a pas pu inscrire parce qu'ils en croisent un autre. Revit en écrit
    /// de minuscules (un recul de 1,5e-3 radian au coin d'un cylindre : deux chaises de RE1-Architecture) : la
    /// région se triangule quand même, avec la frontière approchée à l'échelle de ce recul. On les compte, on ne
    /// refuse pas la face (elle serait « partielle » pour rien).
    pub conflicts: usize,
}

/// Nombre maximal de points intérieurs d'une face : une grille plus grosse est éclaircie de façon uniforme (un point sur
/// `k` de chaque axe, le plus petit `k` qui convient), jamais coupée en cours de route, ce qui laisserait sans point
/// intérieur toutes les rangées qui suivent. `tess::fit_interior` ramène d'avance les grilles de surfaces courbes à
/// cette limite sans rien éclaircir (mêmes mailles, un peu moins nombreuses).
pub const MAX_INTERIOR_POINTS: usize = 60_000;

/// Aire signée d'une boucle (positive si elle tourne dans le sens antihoraire).
pub fn signed_area(ring: &[Uv]) -> f64 {
    let n = ring.len();
    (0..n).map(|i| ring[i][0] * ring[(i + 1) % n][1] - ring[(i + 1) % n][0] * ring[i][1]).sum::<f64>() / 2.0
}

/// Règle pair-impair : le point est à l'intérieur si un rayon issu de lui coupe un nombre impair de
/// côtés de l'ensemble des boucles (les trous comptent donc pour des sorties).
pub fn inside(point: Uv, loops: &[Loop]) -> bool {
    let mut hit = false;
    for ring in loops {
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            if (a[1] > point[1]) != (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0] {
                hit = !hit;
            }
        }
    }
    hit
}

/// Distance de `point` au plus proche côté des boucles.
fn distance_to_loops(point: Uv, loops: &[Loop]) -> f64 {
    let mut best = f64::INFINITY;
    for ring in loops {
        let n = ring.len();
        for i in 0..n {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let length2 = dx * dx + dy * dy;
            let t = if length2 > 0.0 { (((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2).clamp(0.0, 1.0) } else { 0.0 };
            let (cx, cy) = (a[0] + t * dx - point[0], a[1] + t * dy - point[1]);
            best = best.min(cx * cx + cy * cy);
        }
    }
    best.sqrt()
}

/// Retire les sommets doubles consécutifs (et le dernier s'il répète le premier) d'une boucle.
pub fn clean_loop(ring: &[Uv], tolerance: f64) -> Loop {
    let mut out: Loop = Vec::with_capacity(ring.len());
    for &p in ring {
        if out.last().is_none_or(|last| (last[0] - p[0]).hypot(last[1] - p[1]) > tolerance) {
            out.push(p);
        }
    }
    while out.len() > 1 && (out[0][0] - out[out.len() - 1][0]).hypot(out[0][1] - out[out.len() - 1][1]) <= tolerance {
        out.pop();
    }
    out
}

/// Les valeurs infimes (6e-30 au lieu de 0, restes de calcul de Revit) sont refusées par la
/// triangulation : on les ramène à zéro.
fn snap(value: f64) -> f64 {
    if value.abs() < 1e-20 { 0.0 } else { value }
}

/// Écart relatif à l'étendue de la région en dessous duquel deux sommets sont le même : les restes de
/// calcul de Revit (1e-15) ne fabriquent pas des arêtes de longueur nulle ou des triangles de surface
/// nulle, que la triangulation traiterait comme des cas limites.
const MERGE_TOLERANCE: f64 = 1e-12;

/// Les sommets de la triangulation : uniques à `MERGE_TOLERANCE` près, avec les coordonnées d'origine du
/// premier sommet de chaque groupe, et l'indice de chaque sommet proposé dans la liste des sommets uniques.
struct Vertices {
    points: Vec<Point2<f64>>,
    originals: Vec<Uv>,
    cell: f64,
    origin: [f64; 2],
    /// Le sommet de chaque case de côté `cell` : deux sommets d'une même case sont à moins de `cell`, donc confondus.
    grid: FxMap<(i64, i64), usize>,
}

impl Vertices {
    fn new(bounds_min: [f64; 2], span: f64) -> Self {
        Self { points: Vec::new(), originals: Vec::new(), cell: (span * MERGE_TOLERANCE).max(1e-200), origin: bounds_min, grid: Default::default() }
    }

    fn cell_of(&self, p: [f64; 2]) -> (i64, i64) {
        (((p[0] - self.origin[0]) / self.cell).floor() as i64, ((p[1] - self.origin[1]) / self.cell).floor() as i64)
    }

    /// L'indice du sommet de `scaled` : un sommet déjà là à `cell` près, sinon un nouveau.
    fn add(&mut self, scaled: [f64; 2], original: Uv) -> usize {
        let (cx, cy) = self.cell_of(scaled);
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(&index) = self.grid.get(&(cx.saturating_add(dx), cy.saturating_add(dy))) else { continue };
                let q = &self.points[index];
                if (q.x - scaled[0]).abs() <= self.cell && (q.y - scaled[1]).abs() <= self.cell {
                    return index;
                }
            }
        }
        let index = self.points.len();
        self.points.push(Point2::new(scaled[0], scaled[1]));
        self.originals.push(original);
        self.grid.insert((cx, cy), index);
        index
    }
}

/// Triangule l'intérieur des `loops` (règle pair-impair).
///
/// * `metric` : échelle de (u, v) vers des longueurs (rayon pour u d'un cylindre, 1 pour v…).
/// * `grid` : abscisses et ordonnées des points intérieurs à semer (pour les surfaces courbes) ;
///   vide pour une surface plane, où les sommets des boucles suffisent.
///
/// Aucune entrée ne fait paniquer cette fonction, ce qui compte en WebAssembly où une panique n'est pas
/// rattrapable : valeurs non finies, échelle invalide, boucles de moins de trois sommets, sommets
/// confondus, côtés de longueur nulle ou en double, croisements, tout cela est refusé (`Err`) ou
/// ramené au cas simple *avant* la triangulation, qui n'est appelée que par ses `try_*`
/// (`tests/degenerate.rs` le vérifie sur des boucles dégénérées et sur 200 000 cas tirés au
/// hasard, d'un tirage déterministe qui mêle boucles dégénérées, valeurs non finies, grilles et échelles invalides).
pub fn triangulate(loops: &[Loop], metric: Uv, grid: Option<(&[f64], &[f64])>) -> Result<Mesh2> {
    let (mu, mv) = (metric[0], metric[1]);
    if !(mu.is_finite() && mv.is_finite() && mu > 0.0 && mv > 0.0) {
        bail!("échelle (u, v) invalide");
    }
    let scaled_loops: Vec<Loop> = loops.iter().map(|ring| ring.iter().map(|p| [snap(p[0] * mu), snap(p[1] * mv)]).collect()).collect();
    if !scaled_loops.iter().flatten().all(|p| p[0].is_finite() && p[1].is_finite()) {
        bail!("sommet de contour non fini");
    }
    if let Some((us, vs)) = grid {
        if !us.iter().chain(vs).all(|x| x.is_finite()) {
            bail!("grille intérieure non finie");
        }
    }
    let (mut low, mut high) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for p in scaled_loops.iter().flatten() {
        for axis in 0..2 {
            low[axis] = low[axis].min(p[axis]);
            high[axis] = high[axis].max(p[axis]);
        }
    }
    let span = (high[0] - low[0]).max(high[1] - low[1]);
    if !(span.is_finite() && span > 0.0) {
        bail!("moins de trois sommets de contour");
    }

    // Sommets : ceux des boucles, puis les points semés, confondus à `MERGE_TOLERANCE` près ; arêtes : les
    // côtés des boucles, sans côté de longueur nulle ni en double.
    let mut vertices = Vertices::new(low, span);
    let mut edges: Vec<[usize; 2]> = Vec::new();
    let mut seen_edges: crate::geometry::pack::FxSet<(usize, usize)> = Default::default();
    for (ring, scaled) in loops.iter().zip(&scaled_loops) {
        let ids: Vec<usize> = ring.iter().zip(scaled).map(|(p, s)| vertices.add(*s, *p)).collect();
        for i in 0..ids.len() {
            let (a, b) = (ids[i], ids[(i + 1) % ids.len()]);
            if a != b && seen_edges.insert((a.min(b), a.max(b))) {
                edges.push([a, b]);
            }
        }
    }
    if vertices.points.len() < 3 || edges.len() < 3 {
        bail!("moins de trois sommets de contour");
    }
    if let Some((us, vs)) = grid {
        let step_u = us.windows(2).map(|w| (w[1] - w[0]) * mu).fold(f64::INFINITY, f64::min);
        let step_v = vs.windows(2).map(|w| (w[1] - w[0]) * mv).fold(f64::INFINITY, f64::min);
        // Écart minimal d'un point semé au contour : un quart du plus petit pas, pour ne pas
        // fabriquer de lamelles le long des bords.
        let margin = 0.25 * step_u.min(step_v);
        // Une grille de plus de `MAX_INTERIOR_POINTS` points est éclaircie de façon uniforme : arrêter le semis à la limite
        // laisserait sans point toutes les dernières rangées de la région. Seules les abscisses strictement à l'intérieur
        // de l'étendue des boucles comptent : une abscisse sur son bord ne donne jamais un point intérieur.
        let inner = |knots: &[f64], scale: f64, axis: usize| knots.iter().filter(|k| snap(**k * scale) > low[axis] && snap(**k * scale) < high[axis]).count();
        let (inner_u, inner_v) = (inner(us, mu, 0), inner(vs, mv, 1));
        let stride = (1..).find(|k| inner_u.div_ceil(*k) * inner_v.div_ceil(*k) <= MAX_INTERIOR_POINTS).unwrap_or(1);
        for &v in vs.iter().step_by(stride) {
            for &u in us.iter().step_by(stride) {
                let scaled = [snap(u * mu), snap(v * mv)];
                if !(scaled[0].is_finite() && scaled[1].is_finite()) || !inside(scaled, &scaled_loops) || distance_to_loops(scaled, &scaled_loops) <= margin {
                    continue;
                }
                vertices.add(scaled, [u, v]);
            }
        }
    }

    // Les sommets sont uniques : la triangulation les garde dans leur ordre, et les coordonnées d'origine
    // de chacun sont celles de `originals`.
    let Vertices { points: vertices, originals: points, .. } = vertices;
    let expected = vertices.len();
    // Deux côtés qui se croisent : la triangulation ne panique pas, elle les signale (voir `Mesh2::conflicts`).
    let mut conflicts = 0usize;
    let cdt = ConstrainedDelaunayTriangulation::<Point2<f64>>::try_bulk_load_cdt(vertices, edges, |_| conflicts += 1).map_err(|error| anyhow::anyhow!("triangulation impossible : {error:?}"))?;
    if cdt.num_vertices() != expected {
        bail!("triangulation : sommets perdus");
    }

    let mut triangles = Vec::with_capacity(cdt.num_inner_faces());
    for face in cdt.inner_faces() {
        let corners = face.vertices();
        let ids = corners.map(|vertex| vertex.fix().index() as u32);
        let p = corners.map(|vertex| {
            let position = vertex.position();
            [position.x, position.y]
        });
        let centroid = [(p[0][0] + p[1][0] + p[2][0]) / 3.0, (p[0][1] + p[1][1] + p[2][1]) / 3.0];
        if !inside(centroid, &scaled_loops) {
            continue;
        }
        let area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
        // Trois sommets alignés dans le plan (u, v) (des points du même bord droit, surtout) font un
        // triangle sans surface dans ce plan mais bien réel sur la surface : la corde d'un arc.
        let longest = (0..3).map(|k| (p[(k + 1) % 3][0] - p[k][0]).powi(2) + (p[(k + 1) % 3][1] - p[k][1]).powi(2)).fold(0.0, f64::max);
        if area.abs() <= 1e-10 * longest {
            continue;
        }
        triangles.push(if area > 0.0 { ids } else { [ids[0], ids[2], ids[1]] });
    }
    if triangles.is_empty() {
        bail!("aucun triangle dans la région");
    }
    // L'ordre dans lequel la triangulation rend ses triangles, et le sommet par lequel chacun commence, dépendent de
    // parcours de tables de hachage de `spade` (graine aléatoire à chaque lancement) : le même maillage sortait dans
    // un ordre différent d'une lecture à l'autre. Chaque triangle est ramené à son plus petit indice en premier (sens
    // conservé), et la liste est triée : le résultat ne dépend plus que de la région.
    for triangle in &mut triangles {
        let first = (0..3).min_by_key(|k| triangle[*k]).unwrap_or(0);
        triangle.rotate_left(first);
    }
    triangles.sort_unstable();
    Ok(Mesh2 { points, triangles, conflicts })
}
