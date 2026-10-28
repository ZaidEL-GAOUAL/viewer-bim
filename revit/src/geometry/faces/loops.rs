//! Les boucles de contour d'une face : chaque arête enregistrée porte, pour chacune des deux faces
//! qu'elle sépare, la liste de ses points (u, v) dans le paramétrage de cette face (deux extrémités
//! et des points intermédiaires). Les deux faces voisines lisent donc les mêmes points, évalués sur
//! leur propre surface : leurs sommets coïncident, sans fissure.
//!
//! Même lecture que `rvt::research::native_saved_mesh`, avec quelques différences : une tolérance de
//! raccord plus large (Revit écrit parfois des boucles fermées à 3e-7 près, ou à 0,1 mm près), les
//! arêtes dont les deux côtés sont la même face (la couture d'un cylindre entier), un nombre
//! quelconque de boucles pour toute surface, les points affinés avec la face voisine (`refine`, sur la grille de rvt-rs
//! quand c'est lui qui maille cette voisine : un cylindre ou une révolution) et les pôles ramenés à la génératrice
//! qui y arrive (`pin_poles`).

use std::collections::{BTreeSet, HashMap};

use anyhow::{Context, Result, ensure};
use rvt::research::native_parameters::ObjectGraph;

use super::graph::{point2, target};
use super::math::{distance, norm};
use super::refine::{Grid, refine_on};
use super::region::{Loop, Uv, clean_loop, signed_area};
use super::surface::{Shape, Surface};

/// Tolérances de raccord de deux extrémités d'arêtes dans le plan (u, v), de la plus stricte à la
/// plus large : on essaie la suivante seulement quand la boucle ne se ferme pas avec la précédente.
const TOLERANCES: [f64; 3] = [1e-7, 1e-5, 2e-4];

/// Dernier recours : deux extrémités dont les points de la surface sont à moins de 0,3 mm sont les
/// mêmes (Revit écrit des boucles dont les extrémités sont décalées de 0,1 mm en (u, v), surtout le
/// long des rayons minuscules ou des profils de révolution).
const SPACE_TOLERANCE: f64 = 1e-3;

/// Les boucles de `face` ; `None` si la face n'a aucune boucle (pas de contour).
pub fn read(graph: &ObjectGraph, face: usize, surface: &Surface) -> Result<Option<Vec<Loop>>> {
    let fields = &graph.objects[face].fields;
    let Some(mut current) = target(graph, face, &fields["m_pFirstLoop"])? else { return Ok(None) };
    let mut rings = Vec::new();
    let mut seen = BTreeSet::new();
    let mut neighbours: HashMap<usize, Neighbour> = HashMap::new();
    loop {
        ensure!(seen.insert(current), "cycle dans la liste des boucles");
        rings.push(ring(graph, face, current, surface, &mut neighbours)?);
        match target(graph, current, &graph.objects[current].fields["m_nextLoop"])? {
            Some(next) => current = next,
            None => break,
        }
    }
    Ok(Some(rings))
}

/// Une face voisine : sa surface, et la grille que rvt-rs lui pose quand c'est lui qui la maille (un cylindre ou une
/// révolution).
struct Neighbour {
    surface: Option<Surface>,
    grid: Option<Grid>,
}

impl Neighbour {
    fn read(graph: &ObjectGraph, face: usize) -> Neighbour {
        let surface = target(graph, face, &graph.objects[face].fields["m_pSurf"]).ok().flatten().and_then(|index| Surface::read(graph, index).ok());
        let grid = match surface.as_ref().map(|surface| &surface.shape) {
            Some(Shape::Cylinder { .. }) => super::cylinder_grid(graph, face),
            Some(Shape::Revolution { .. }) => super::revolution_grid(graph, face),
            _ => None,
        };
        Neighbour { surface, grid }
    }
}

/// Une des faces voisines de `face` (celles qui partagent une de ses arêtes) a-t-elle une surface de la classe
/// `class` ? Parcourt les arêtes des boucles sans lire leurs points. `false` si le contour ne se parcourt pas (la
/// lecture complète, `read`, dira pourquoi).
pub fn has_neighbour_surface(graph: &ObjectGraph, face: usize, class: &str) -> bool {
    has_neighbour_surface_in(graph, face, &[class])
}

/// Une des faces voisines de `face` a-t-elle une surface d'une des classes `classes` ?
pub fn has_neighbour_surface_in(graph: &ObjectGraph, face: usize, classes: &[&str]) -> bool {
    let found = || -> Result<bool> {
        let fields = &graph.objects[face].fields;
        let Some(mut current) = target(graph, face, &fields["m_pFirstLoop"])? else { return Ok(false) };
        let mut loops_seen = BTreeSet::new();
        loop {
            ensure!(loops_seen.insert(current), "cycle dans la liste des boucles");
            let mut edge = target(graph, current, &graph.objects[current].fields["m_next"])?.context("boucle vide")?;
            let mut previous = current;
            let mut visited: BTreeSet<(usize, usize)> = BTreeSet::new();
            while edge != current {
                let side = edge_side(graph, face, edge, previous, &visited)?;
                ensure!(visited.insert((edge, side)), "boucle sans fin");
                let other = target(graph, edge, &graph.objects[edge].fields["m_pFace"][1 - side])?;
                if let Some(surface) = other.and_then(|other| target(graph, other, &graph.objects[other].fields["m_pSurf"]).ok().flatten()) {
                    if classes.contains(&graph.objects[surface].class_name.as_str()) {
                        return Ok(true);
                    }
                }
                previous = edge;
                edge = target(graph, edge, &graph.objects[edge].fields["m_next"][side])?.context("arête suivante absente")?;
                ensure!(visited.len() <= 1_000_000, "boucle sans fin");
            }
            match target(graph, current, &graph.objects[current].fields["m_nextLoop"])? {
                Some(next) => current = next,
                None => return Ok(false),
            }
        }
    };
    found().unwrap_or(false)
}

/// Une boucle : ses arêtes dans l'ordre de la chaîne `m_next`, raccordées en une ligne fermée.
fn ring(graph: &ObjectGraph, face: usize, loop_index: usize, surface: &Surface, neighbours: &mut HashMap<usize, Neighbour>) -> Result<Loop> {
    let object = &graph.objects[loop_index];
    ensure!(["EdgeLoop", "EdgeLoopWithChainEnvelopes"].contains(&object.class_name.as_str()), "boucle de type {} non prise en charge", object.class_name);
    ensure!(object.fields["m_open"] == false, "boucle ouverte");
    ensure!(target(graph, loop_index, &object.fields["m_pFace"])? == Some(face), "la boucle n'appartient pas à la face");

    let mut current = target(graph, loop_index, &object.fields["m_next"])?.context("boucle vide")?;
    let mut previous = loop_index;
    let mut visited: BTreeSet<(usize, usize)> = BTreeSet::new();
    let mut segments: Vec<Vec<Uv>> = Vec::new();
    while current != loop_index {
        let edge = &graph.objects[current];
        ensure!(edge.class_name == "Edge", "élément de boucle qui n'est pas une arête");
        let side = edge_side(graph, face, current, previous, &visited)?;
        // Une chaîne qui repasse par la même arête du même côté (A→B→A) ne reviendra jamais au début de
        // la boucle : sans cette garde, elle tournerait jusqu'à la limite de segments.
        ensure!(visited.insert((current, side)), "boucle sans fin");
        let points = edge_points(graph, current, side)?;
        let mut points = refined(graph, face, current, side, surface, points, neighbours);
        pin_poles(surface, &mut points);
        segments.push(points);
        previous = current;
        current = target(graph, current, &edge.fields["m_next"][side])?.context("arête suivante absente")?;
        ensure!(segments.len() <= 1_000_000, "boucle sans fin");
    }
    ensure!(!segments.is_empty(), "boucle sans arête");

    for tolerance in TOLERANCES.into_iter().map(Some).chain([None]) {
        if let Some(points) = chain(&segments, tolerance, surface) {
            let ring = clean_loop(&points, 1e-9);
            ensure!(ring.len() >= 3 && signed_area(&ring).abs() > 1e-12, "contour dégénéré");
            return Ok(ring);
        }
    }
    anyhow::bail!("contour non raccordé")
}

/// De quel côté de l'arête `edge` se trouve `face` (indice dans `m_pFace`). Quand les deux côtés
/// sont la même face, on prend celui dont l'arête précédente est celle d'où l'on vient, à défaut
/// celui qu'on n'a pas encore parcouru.
fn edge_side(graph: &ObjectGraph, face: usize, edge: usize, previous: usize, visited: &BTreeSet<(usize, usize)>) -> Result<usize> {
    let fields = &graph.objects[edge].fields;
    let faces = fields["m_pFace"].as_array().context("paire de faces de l'arête absente")?;
    ensure!(faces.len() == 2, "paire de faces de l'arête incomplète");
    let mut sides = Vec::new();
    for (side, pointer) in faces.iter().enumerate() {
        if target(graph, edge, pointer)? == Some(face) {
            sides.push(side);
        }
    }
    match sides.as_slice() {
        [] => anyhow::bail!("l'arête n'appartient pas à la face"),
        [side] => Ok(*side),
        _ => {
            for &side in &sides {
                if target(graph, edge, &fields["m_prev"][side]).ok().flatten() == Some(previous) && !visited.contains(&(edge, side)) {
                    return Ok(side);
                }
            }
            sides.into_iter().find(|side| !visited.contains(&(edge, *side))).context("arête parcourue deux fois du même côté")
        }
    }
}

/// Les points (u, v) de l'arête `edge`, côté `side`, affinés avec ceux de la face voisine quand on
/// sait les lui donner aussi (voir `refine`) ; sinon tels qu'enregistrés. Quand c'est rvt-rs qui maille la voisine (un
/// cylindre, une révolution), elle impose sa grille : ses sommets sont alors repris tels quels.
fn refined(graph: &ObjectGraph, face: usize, edge: usize, side: usize, surface: &Surface, own: Vec<Uv>, neighbours: &mut HashMap<usize, Neighbour>) -> Vec<Uv> {
    let fields = &graph.objects[edge].fields;
    let Some(other_face) = fields["m_pFace"].get(1 - side).and_then(|pointer| target(graph, edge, pointer).ok().flatten()) else { return own };
    if other_face == face {
        return own;
    }
    let neighbour = neighbours.entry(other_face).or_insert_with(|| Neighbour::read(graph, other_face));
    let Some(other_surface) = neighbour.surface.as_ref() else { return own };
    let Ok(other_points) = edge_points(graph, edge, 1 - side) else { return own };
    // Les côtés dans l'ordre de l'arête (0 puis 1) : les deux faces voisines font le même calcul.
    let (sides, grids) = if side == 0 { ([(surface, own.as_slice()), (other_surface, other_points.as_slice())], [None, neighbour.grid.as_ref()]) } else { ([(other_surface, other_points.as_slice()), (surface, own.as_slice())], [neighbour.grid.as_ref(), None]) };
    match refine_on(sides, grids) {
        Some(both) => both.into_iter().nth(side).unwrap_or(own),
        None => own,
    }
}

/// Les points (u, v) d'une arête du côté `side` : première extrémité, points intermédiaires,
/// dernière extrémité.
fn edge_points(graph: &ObjectGraph, edge: usize, side: usize) -> Result<Vec<Uv>> {
    let fields = &graph.objects[edge].fields;
    let ends = fields["m_firstAndLastEdgePnts"].as_array().context("extrémités de l'arête absentes")?;
    ensure!(ends.len() == 2, "extrémités de l'arête incomplètes");
    let mut points = vec![point2(&ends[0]["uv"][side])?];
    for sample in fields["m_interiorEdgePnts"].as_array().context("points intermédiaires de l'arête absents")? {
        points.push(point2(&sample["uv"][side])?);
    }
    points.push(point2(&ends[1]["uv"][side])?);
    Ok(points)
}

/// Deux extrémités sont-elles confondues : à `tolerance` près dans le plan (u, v), ou, quand
/// `tolerance` est `None`, à `SPACE_TOLERANCE` près sur la surface.
fn joined(a: Uv, b: Uv, tolerance: Option<f64>, surface: &Surface) -> bool {
    match tolerance {
        Some(tolerance) => (a[0] - b[0]).hypot(a[1] - b[1]) <= tolerance,
        None => distance(surface.eval(a[0], a[1]), surface.eval(b[0], b[1])) <= SPACE_TOLERANCE,
    }
}

/// Distance dans le plan (u, v).
fn gap(a: Uv, b: Uv) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// Raccorde les polylignes en une ligne fermée : chacune est prise telle quelle ou à l'envers selon
/// l'extrémité qui touche la précédente (la plus proche dans le plan (u, v) quand les deux la
/// touchent, comme les deux bords d'une arête réduite à un pôle). La première peut aussi être
/// retournée.
fn chain(segments: &[Vec<Uv>], tolerance: Option<f64>, surface: &Surface) -> Option<Vec<Uv>> {
    // Une arête réduite à un point (pôle d'un cône ou d'une sphère) ne dessine rien.
    let segments: Vec<&Vec<Uv>> = segments.iter().filter(|s| s.iter().any(|p| gap(*p, s[0]) > tolerance.unwrap_or(1e-9))).collect();
    if segments.is_empty() {
        return None;
    }
    // Deux extrémités confondues sur la surface mais pas dans le plan (u, v) (le sommet d'un cône ou
    // d'un éventail : tous ses (u, v) sont le même point) restent deux sommets du contour, que relie un
    // côté de longueur nulle dans l'espace.
    let same_uv = |a: Uv, b: Uv| gap(a, b) <= tolerance.unwrap_or(1e-9);
    for reverse in [false, true] {
        let mut out: Vec<Uv> = segments[0].clone();
        if reverse {
            out.reverse();
        }
        let mut valid = true;
        for segment in &segments[1..] {
            let last = *out.last()?;
            let (first_end, last_end) = (segment[0], *segment.last()?);
            let forward = joined(last, first_end, tolerance, surface);
            let backward = joined(last, last_end, tolerance, surface);
            if forward && (!backward || gap(last, first_end) <= gap(last, last_end)) {
                out.extend_from_slice(if same_uv(last, first_end) { &segment[1..] } else { segment });
            } else if backward {
                let skip = usize::from(same_uv(last, last_end));
                out.extend(segment.iter().rev().skip(skip).copied());
            } else {
                valid = false;
                break;
            }
        }
        if valid && joined(out[0], *out.last()?, tolerance, surface) {
            if same_uv(out[0], *out.last()?) {
                out.pop();
            }
            return Some(out);
        }
    }
    None
}

/// Aux pôles (sommet d'un cône, d'un éventail, pôle d'une sphère), tous les (u, v) d'une même ligne
/// sont le même point : Revit y écrit un `u` quelconque, qui incline le côté qui y arrive (la
/// génératrice d'un éventail devient une diagonale du plan (u, v), et la région avec elle). On prend
/// pour `u` celui du premier point de l'arête qui n'est pas au pôle.
pub fn pin_poles(surface: &Surface, points: &mut [Uv]) {
    let is_pole = |p: Uv| {
        let (su, sv) = surface.partials(p[0], p[1]);
        norm(su) <= 1e-9 * norm(sv).max(1e-12)
    };
    let n = points.len();
    if n < 2 {
        return;
    }
    if is_pole(points[0]) {
        if let Some(k) = (1..n).find(|&k| !is_pole(points[k])) {
            let u = points[k][0];
            points[..k].iter_mut().for_each(|p| p[0] = u);
        }
    }
    if is_pole(points[n - 1]) {
        if let Some(k) = (0..n - 1).rev().find(|&k| !is_pole(points[k])) {
            let u = points[k][0];
            points[k + 1..].iter_mut().for_each(|p| p[0] = u);
        }
    }
}
