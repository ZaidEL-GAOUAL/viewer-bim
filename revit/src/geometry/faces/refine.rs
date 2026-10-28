//! Affinage d'une arête que deux faces se partagent. Revit n'en enregistre que quelques points
//! (tous les 15° d'un cercle, parfois tous les 45°), alors que les faces voisines, elles, sont
//! maillées bien plus finement à l'intérieur : sans affinage, la corde entre deux points de bord
//! rentre de plusieurs millimètres dans la surface, et la première rangée intérieure se replie
//! dessus (une rotule de 1,6 mm de rayon, avec des cordes de 5 mm).
//!
//! On insère des points entre deux points enregistrés quand la corde s'écarte de plus de
//! `CHORD_ERROR` de la surface, et seulement quand on sait leur donner un (u, v) sur **chacune** des
//! deux faces, de sorte que les deux faces gardent exactement les mêmes sommets :
//!
//! * les deux côtés de l'arête sont des droites du plan (u, v) de leur surface (un cercle d'une
//!   surface de révolution contre un cercle de la surface voisine) : les points sont à la même
//!   fraction du segment des deux côtés ;
//! * un côté est un plan : le point de l'autre surface (à la fraction voulue) est projeté sur le plan.
//!
//! Dans les deux cas, les points ne sont gardés que si les deux surfaces s'y rejoignent à 0,01 mm
//! près (ce qui écarte les arêtes qui ne sont pas des droites dans le plan (u, v), comme l'ellipse
//! qu'un plan oblique découpe dans un cylindre : celles-là gardent leurs points enregistrés). La
//! décision ne dépend que de l'arête, jamais de la face qui la lit : les deux voisines affinent de
//! la même façon.
//!
//! Quand la face voisine est un cylindre ou une révolution que rvt-rs maille lui-même (`Grid`), ses sommets sont ceux de
//! sa grille (le pas angulaire de sa flèche, plus les points enregistrés de son contour), quoi qu'on pense de l'arête :
//! on les reprend tous, sans autre critère de flèche, sur le côté qui n'est pas le sien. Un plan qui touche un cylindre
//! est donc maillé par ce module (`faces::mesh_face`) : rvt-rs l'affinerait sur la grille de son profil par défaut
//! (0,001 pied de flèche), plus fine que celle du cylindre, et laisserait des fentes de quelques dixièmes de millimètre.

use rvt::research::native_parametric_surface::Curve as RvtCurve;

use super::math::{V3, add, distance, dot, scale, sub};
use super::region::Uv;
use super::surface::Surface;
use super::tess::CHORD_ERROR;

/// Nombre maximal de mailles insérées dans un segment enregistré.
const MAX_SPLIT: usize = 32;

/// Écart toléré entre les deux surfaces à un point affiné : un centième de millimètre.
const MEETING: f64 = 3.3e-5;

/// Écart (u ou v) en dessous duquel un côté enregistré du contour d'un cylindre ou d'une révolution est une isoligne : la
/// tolérance de leurs contours rectangulaires chez rvt-rs.
const ISOLINE: f64 = 1e-7;

/// Les abscisses des sommets que rvt-rs met sur un cylindre ou une surface de révolution : toutes celles de la grille de ses
/// mailles, en u (l'angle) et en v (la hauteur ou le profil), triées.
#[derive(Debug, Clone, PartialEq)]
pub struct Grid {
    pub u: Vec<f64>,
    pub v: Vec<f64>,
}

impl Grid {
    /// La grille que `cylinder_face` pose sur un cylindre de rayon `radius` dont le contour (u, v) est `trim`, à la flèche
    /// `chord_error` et avec des mailles d'au plus `max_v_edge` pieds de haut : mêmes opérations dans le même ordre (le
    /// pas angulaire d'une flèche, mailles uniformes entre les bornes du contour, plus les abscisses de ses points
    /// enregistrés), pour que les sommets soient les mêmes au bit près. Un essai le vérifie sur ses maillages.
    pub fn cylinder(radius: f64, trim: &[Uv], chord_error: f64, max_v_edge: f64) -> Option<Grid> {
        if !(chord_error.is_finite() && chord_error > 0.0 && max_v_edge.is_finite() && max_v_edge > 0.0 && radius.is_finite() && radius > 0.0) {
            return None;
        }
        let bound = |axis: usize, f: fn(f64, f64) -> f64, start: f64| trim.iter().map(|p| p[axis]).fold(start, f);
        let (min, max) = ([bound(0, f64::min, f64::INFINITY), bound(1, f64::min, f64::INFINITY)], [bound(0, f64::max, f64::NEG_INFINITY), bound(1, f64::max, f64::NEG_INFINITY)]);
        let sagitta_ratio = (chord_error / (2.0 * radius)).min(1.0);
        let angular_step = (4.0 * sagitta_ratio.sqrt().asin()).min(std::f64::consts::FRAC_PI_2);
        Some(Grid { u: axis(min[0], max[0], angular_step, trim.iter().map(|p| p[0]))?, v: axis(min[1], max[1], max_v_edge, trim.iter().map(|p| p[1]))? })
    }

    /// La grille que `native_parametric_mesh::face` pose sur une surface de révolution de profil `profile` (une droite ou un
    /// arc : les seuls que rvt-rs lit) dont le contour (u, v) est `trim` : des mailles uniformes entre les bornes du contour,
    /// de pas angulaire pour une flèche fixe de 0,001 pied selon le rayon du profil (en u), et de la longueur de la droite
    /// ou de l'arc (en v), plus tous les points enregistrés du contour. Mêmes opérations dans le même ordre que rvt-rs ; un
    /// essai le vérifie sur ses maillages.
    pub fn revolution(profile: &RvtCurve, trim: &[Uv]) -> Option<Grid> {
        const CHORD: f64 = 0.001;
        let angular = |r: f64| (4.0 * (CHORD / (2.0 * r.max(CHORD))).min(1.0).sqrt().asin()).min(std::f64::consts::FRAC_PI_2);
        let bound = |axis: usize, f: fn(f64, f64) -> f64, start: f64| trim.iter().map(|p| p[axis]).fold(start, f);
        let (min, max) = ([bound(0, f64::min, f64::INFINITY), bound(1, f64::min, f64::INFINITY)], [bound(0, f64::max, f64::NEG_INFINITY), bound(1, f64::max, f64::NEG_INFINITY)]);
        if !(max[0] > min[0] && max[1] > min[1]) {
            return None;
        }
        let (du, dv) = match profile {
            RvtCurve::Line { origin, direction, .. } => {
                let radius = [min[1], max[1]].into_iter().map(|v| (origin[0] + v * direction[0]).hypot(origin[1] + v * direction[1])).fold(0., f64::max);
                (angular(radius), 1. / direction.iter().map(|x| x * x).sum::<f64>().sqrt())
            }
            RvtCurve::Arc { center, radius, .. } => (angular(center[0].hypot(center[1]) + 2. * radius), angular(*radius)),
        };
        let axis = |k: usize, step: f64| -> Option<Vec<f64>> {
            let count = ((max[k] - min[k]) / step).ceil().max(1.);
            if !(count.is_finite() && count <= 10000.) {
                return None;
            }
            let count = count as usize;
            let mut values = (0..=count).map(|i| min[k] + (max[k] - min[k]) * i as f64 / count as f64).collect::<Vec<_>>();
            values.extend(trim.iter().map(|p| p[k]));
            values.sort_by(f64::total_cmp);
            values.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
            Some(values)
        };
        Some(Grid { u: axis(0, du)?, v: axis(1, dv)? })
    }

    /// Les points de la grille strictement entre les extrémités `p0` et `p1` d'un côté enregistré qui court le long d'une
    /// isoligne (u ou v constant), dans l'ordre du parcours : chacun avec sa fraction du côté et son (u, v). `None` si le
    /// côté n'est pas une isoligne.
    fn cuts(&self, p0: Uv, p1: Uv) -> Option<Vec<(f64, Uv)>> {
        let (du, dv) = (p1[0] - p0[0], p1[1] - p0[1]);
        let (axis, knots) = if dv.abs() < ISOLINE && du.abs() >= ISOLINE {
            (0, &self.u)
        } else if du.abs() < ISOLINE && dv.abs() >= ISOLINE {
            (1, &self.v)
        } else {
            return None;
        };
        let (lo, hi) = (p0[axis].min(p1[axis]), p0[axis].max(p1[axis]));
        let mut inside: Vec<f64> = knots.iter().copied().filter(|k| *k > lo + 1e-12 && *k < hi - 1e-12).collect();
        if p0[axis] > p1[axis] {
            inside.reverse();
        }
        Some(
            inside
                .into_iter()
                .map(|k| {
                    let mut point = p0;
                    point[axis] = k;
                    ((k - p0[axis]) / (p1[axis] - p0[axis]), point)
                })
                .collect(),
        )
    }
}

/// Les valeurs d'un axe de `cylinder_face` (`tessellation_axis`) : `min`, `max` et les mailles uniformes de pas au plus `step`
/// entre eux, plus les abscisses `knots` qui tombent strictement entre les deux, triées, celles qui sont à 1e-12 près l'une
/// de l'autre n'en faisant qu'une.
fn axis(min: f64, max: f64, step: f64, knots: impl Iterator<Item = f64>) -> Option<Vec<f64>> {
    if !(min.is_finite() && max.is_finite() && step.is_finite() && step > 0.0 && max > min) {
        return None;
    }
    let count = ((max - min) / step).ceil();
    if !(count.is_finite() && (1.0..=2_000_000.0).contains(&count)) {
        return None;
    }
    let n = count as usize;
    let mut values = (0..=n).map(|i| min + (max - min) * i as f64 / n as f64).collect::<Vec<_>>();
    values.extend(knots.filter(|v| v.is_finite() && *v > min && *v < max));
    values.sort_by(f64::total_cmp);
    values.dedup_by(|a, b| (*a - *b).abs() <= 1e-12);
    (values.len() >= 2).then_some(values)
}

/// Les deux listes de points (u, v) d'une arête, une par côté, après affinage ; `None` si rien n'est
/// affiné (les listes enregistrées servent alors telles quelles).
pub fn refine(sides: [(&Surface, &[Uv]); 2]) -> Option<[Vec<Uv>; 2]> {
    refine_on(sides, [None, None])
}

/// `refine`, avec pour chaque côté la grille de rvt-rs quand c'est lui qui maille la face de ce côté (un cylindre, une
/// révolution) : ses sommets sont alors imposés, sur ce côté et, par le même point évalué sur l'autre surface, sur l'autre.
pub fn refine_on(sides: [(&Surface, &[Uv]); 2], grids: [Option<&Grid>; 2]) -> Option<[Vec<Uv>; 2]> {
    let [(surface_a, points_a), (surface_b, points_b)] = sides;
    if points_a.len() != points_b.len() || points_a.len() < 2 {
        return None;
    }
    let mut out = [vec![points_a[0]], vec![points_b[0]]];
    let mut changed = false;
    for k in 0..points_a.len() - 1 {
        let (a0, a1, b0, b1) = (points_a[k], points_a[k + 1], points_b[k], points_b[k + 1]);
        let pieces = split(surface_a, a0, a1, surface_b, b0, b1, grids);
        changed |= pieces.is_some();
        for (a, b) in pieces.into_iter().flatten().chain([(a1, b1)]) {
            out[0].push(a);
            out[1].push(b);
        }
    }
    changed.then_some(out)
}

/// Un point à insérer dans un segment enregistré : sa fraction du segment et, quand une grille de rvt-rs l'impose, le
/// côté qui le porte et son (u, v).
type Cut = (f64, Option<(usize, Uv)>);

/// Les points intermédiaires (côté a, côté b) à insérer entre deux points enregistrés ; `None` s'il n'y en a pas à insérer
/// (corde assez fine) ou pas moyen de les donner aux deux côtés.
fn split(a: &Surface, a0: Uv, a1: Uv, b: &Surface, b0: Uv, b1: Uv, grids: [Option<&Grid>; 2]) -> Option<Vec<(Uv, Uv)>> {
    let lerp = |p: Uv, q: Uv, t: f64| [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    let cuts: Vec<Cut> = match grids {
        // Un côté est une face que rvt-rs maille : tous les points de sa grille, sans autre critère de flèche.
        [Some(grid), _] => grid.cuts(a0, a1)?.into_iter().map(|(t, point)| (t, Some((0, point)))).collect(),
        [None, Some(grid)] => grid.cuts(b0, b1)?.into_iter().map(|(t, point)| (t, Some((1, point)))).collect(),
        [None, None] => by_sagitta(a, a0, a1, b, b0, b1)?.into_iter().map(|t| (t, None)).collect(),
    };
    if cuts.is_empty() {
        return None;
    }

    // Les écarts des deux surfaces aux extrémités enregistrées : Revit les écrit à 1e-4 pied près, et
    // les points affinés ne peuvent pas faire mieux.
    let ends = distance(a.eval(a0[0], a0[1]), b.eval(b0[0], b0[1])).max(distance(a.eval(a1[0], a1[1]), b.eval(b1[0], b1[1])));
    let allowed = ends + MEETING;

    let imposed = |forced: Option<(usize, Uv)>, side: usize, otherwise: Uv| match forced {
        Some((from, point)) if from == side => point,
        _ => otherwise,
    };
    let mut pieces = Vec::with_capacity(cuts.len());
    for (t, forced) in cuts {
        let (pa, pb) = if a.is_plane() || b.is_plane() {
            let (curved, curved_points, plane, from) = if a.is_plane() { (b, imposed(forced, 1, lerp(b0, b1, t)), a, true) } else { (a, imposed(forced, 0, lerp(a0, a1, t)), b, false) };
            let point = curved.eval(curved_points[0], curved_points[1]);
            let on_plane = project(plane, point)?;
            if distance(plane.eval(on_plane[0], on_plane[1]), point) > allowed {
                return None;
            }
            if from { (on_plane, curved_points) } else { (curved_points, on_plane) }
        } else {
            let (pa, pb) = (imposed(forced, 0, lerp(a0, a1, t)), imposed(forced, 1, lerp(b0, b1, t)));
            if distance(a.eval(pa[0], pa[1]), b.eval(pb[0], pb[1])) > allowed {
                return None;
            }
            (pa, pb)
        };
        pieces.push((pa, pb));
    }
    Some(pieces)
}

/// Les fractions du segment où insérer un point pour que la flèche de la corde reste sous `CHORD_ERROR` ; `None` si elle
/// l'est déjà (ou si les deux surfaces sont des plans).
fn by_sagitta(a: &Surface, a0: Uv, a1: Uv, b: &Surface, b0: Uv, b1: Uv) -> Option<Vec<f64>> {
    let lerp = |p: Uv, q: Uv, t: f64| [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    // Combien de mailles : la flèche d'une corde diminue comme le carré de sa longueur.
    let sagitta = |s: &Surface, p: Uv, q: Uv| {
        let (ends, middle) = (add(s.eval(p[0], p[1]), s.eval(q[0], q[1])), s.eval((p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0));
        distance(scale(ends, 0.5), middle)
    };
    // Une des deux surfaces est un plan : la flèche vient de l'autre côté.
    let worst = match (a.is_plane(), b.is_plane()) {
        (true, false) => sagitta(b, b0, b1),
        (false, true) => sagitta(a, a0, a1),
        (false, false) => sagitta(a, a0, a1).max(sagitta(b, b0, b1)),
        (true, true) => return None,
    };
    if !(worst > CHORD_ERROR) {
        return None;
    }
    // La flèche ne décroît exactement comme le carré de la longueur que sur une parabole : un arc de cercle de 90° coupé
    // ainsi garde 5 % de flèche de plus que voulu, un demi-cercle 23 %. Elle est donc mesurée sur les mailles choisies,
    // et le nombre relevé tant qu'elle dépasse.
    let mut count = ((worst / CHORD_ERROR).sqrt().ceil() as usize).clamp(2, MAX_SPLIT);
    let pieces_sagitta = |s: &Surface, p: Uv, q: Uv, count: usize| (0..count).map(|j| sagitta(s, lerp(p, q, j as f64 / count as f64), lerp(p, q, (j + 1) as f64 / count as f64))).fold(0.0, f64::max);
    while count < MAX_SPLIT {
        let sag = match (a.is_plane(), b.is_plane()) {
            (true, false) => pieces_sagitta(b, b0, b1, count),
            (false, true) => pieces_sagitta(a, a0, a1, count),
            _ => pieces_sagitta(a, a0, a1, count).max(pieces_sagitta(b, b0, b1, count)),
        };
        if !(sag > CHORD_ERROR) {
            break;
        }
        count = (((count as f64) * (sag / CHORD_ERROR).sqrt()).ceil() as usize).max(count + 1).min(MAX_SPLIT);
    }
    Some((1..count).map(|j| j as f64 / count as f64).collect())
}

/// Le (u, v) du point `point` sur un plan (moindres carrés si la base n'est pas orthonormée).
fn project(plane: &Surface, point: V3) -> Option<Uv> {
    let d = sub(point, plane.origin);
    let (xx, xy, yy) = (dot(plane.x, plane.x), dot(plane.x, plane.y), dot(plane.y, plane.y));
    let det = xx * yy - xy * xy;
    if !(det.abs() > 1e-24) {
        return None;
    }
    let (dx, dy) = (dot(d, plane.x), dot(d, plane.y));
    Some([(dx * yy - dy * xy) / det, (dy * xx - dx * xy) / det])
}
