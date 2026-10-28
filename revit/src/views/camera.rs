//! La caméra et la boîte de coupe d'une vue 3D, converties dans le repère du viewer : mètres, axe Y vers le haut,
//! `(x, y, z)` pieds devient `(x, z, -y) × 0,3048`, comme la géométrie (`geometry`), mais sans soustraire l'origine du
//! modèle : ce sont les coordonnées du projet, celles que le viewer recentre en retranchant `Model.offset`.

use super::{Bounded, Viewer, ViewRecord};
use crate::catalog::units::FOOT;

type V3 = [f64; 3];

/// Un point de Revit (pieds, Z vers le haut) en mètres, Y vers le haut.
fn point(p: V3) -> V3 {
    [p[0] * FOOT, p[2] * FOOT, -p[1] * FOOT]
}

/// Une direction de Revit, dans le même repère (unitaire, sans l'échelle).
fn direction(d: V3) -> V3 {
    [d[0], d[2], -d[1]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn length(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn scale(a: V3, k: f64) -> V3 {
    [a[0] * k, a[1] * k, a[2] * k]
}

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn unit(a: V3) -> Option<V3> {
    let n = length(a);
    (n > 1e-9 && n.is_finite()).then(|| scale(a, 1.0 / n))
}

/// Angle entre deux vecteurs, en degrés.
fn angle_between(a: V3, b: V3) -> f64 {
    (dot(a, b) / (length(a) * length(b))).clamp(-1.0, 1.0).acos().to_degrees()
}

/// La caméra d'une vue 3D, dans le repère du viewer (voir le contrat, `views[].camera`).
#[derive(Debug, Clone, PartialEq)]
pub struct Camera {
    pub position: V3,
    /// Sens du regard, unitaire.
    pub direction: V3,
    /// Haut de la caméra, unitaire et perpendiculaire au regard.
    pub up: V3,
    pub perspective: bool,
    /// Perspective : champ vertical, en degrés.
    pub fov: Option<f64>,
    /// Projection parallèle : largeur et hauteur de ce que la vue montre, en mètres.
    pub size: Option<[f64; 2]>,
}

/// Une fenêtre de recadrage écrite avec la valeur par défaut de Revit (±100 pieds) n'a jamais été réglée : elle ne
/// dit rien de ce que la vue montre.
fn is_default(pair: [f64; 2]) -> bool {
    (pair[0] - 100.0).abs() < 1e-9 && (pair[1] + 100.0).abs() < 1e-9
}

/// La caméra de la vue `view`, d'après son repère (œil, droite, haut, sens inverse du regard) et la fenêtre de
/// recadrage de son `Viewer3d`.
///
/// - Le regard est l'opposé de `m_viewDir` ; la droite est regard × haut (vérifié sur les vues des fichiers d'essai).
/// - Perspective : la fenêtre de recadrage est écrite sur le plan à `plane_distance` de l'œil ; ses quatre décalages
///   donnent le champ vertical et le centre de la fenêtre. Le centre est rarement sur l'axe (le recadrage est décalé) :
///   la caméra regarde le centre de la fenêtre, sinon le cadrage est faux de plusieurs degrés. Le plan de la fenêtre est
///   une hypothèse (le champ qui en résulte est de 40° à 90° sur les vues d'essai, à 0,1 pied ; au plan proche, déduit
///   de la profondeur de découpe, il tomberait à 24° pour des vues extérieures) : elle n'est pas confrontée à Revit.
/// - Projection parallèle : la fenêtre donne la largeur et la hauteur montrées ; son centre décale l'œil.
pub fn camera(view: &ViewRecord, viewer: &Viewer) -> Option<Camera> {
    let forward = unit([-view.back[0], -view.back[1], -view.back[2]])?;
    let up = unit(view.up)?;
    // Revit : droite = regard × haut. On la recalcule depuis les deux autres, qui sont les plus sûrs.
    let right = unit([forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]])?;
    // Le haut exact, perpendiculaire au regard.
    let up = unit([right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]])?;

    let perspective = viewer.projection == 2;
    let crop = &viewer.crop;
    let [x, y] = [crop.offsets[0], crop.offsets[1]];
    // Fenêtre : droite, gauche (≤ 0), haut, bas (≤ 0). Réglée par l'utilisateur (côtés actifs) ou, à défaut, au moins
    // écrite par Revit (autre chose que ±100 pieds) : la vue parallèle {3D} y garde ce qu'elle montrait.
    let set = |pair: [f64; 2]| !is_default(pair);
    let sides_active = crop.active[0].iter().chain(&crop.active[1]).all(|active| *active);
    let window = (sides_active || (set(x) && set(y))).then_some((x[0], x[1], y[0], y[1])).filter(|(r, l, t, b)| r > l && t > b);

    let mut eye = view.eye;
    let (mut dir, mut fov, mut size) = (forward, None, None);
    if perspective {
        if let Some((r, l, t, b)) = window {
            let d = viewer.plane_distance;
            let (cx, cy) = ((r + l) / 2.0, (t + b) / 2.0);
            // Le centre de la fenêtre sur le plan de projection, relativement à l'œil.
            let centre = add(add(scale(forward, d), scale(right, cx)), scale(up, cy));
            let v = fov_between(forward, right, up, d, cx, t, b);
            if let Some(looking) = unit(centre).filter(|_| (5.0..170.0).contains(&v)) {
                fov = Some(v);
                dir = looking;
            }
        }
    } else if let Some((r, l, t, b)) = window.filter(|_| set(x) && set(y)) {
        size = Some([(r - l) * FOOT, (t - b) * FOOT]);
        eye = add(add(eye, scale(right, (r + l) / 2.0)), scale(up, (t + b) / 2.0));
    }

    // Le haut suit le nouveau regard : projeté perpendiculairement.
    let dir_m = direction(dir);
    let up_m = direction(up);
    let up_m = unit([up_m[0] - dir_m[0] * dot(up_m, dir_m), up_m[1] - dir_m[1] * dot(up_m, dir_m), up_m[2] - dir_m[2] * dot(up_m, dir_m)])?;
    Some(Camera { position: point(eye), direction: dir_m, up: up_m, perspective, fov, size })
}

/// Champ vertical entre les rayons qui passent par le haut et le bas de la fenêtre, sur la colonne de son centre.
fn fov_between(forward: V3, right: V3, up: V3, plane: f64, cx: f64, top: f64, bottom: f64) -> f64 {
    let ray = |y: f64| add(add(scale(forward, plane), scale(right, cx)), scale(up, y));
    angle_between(ray(top), ray(bottom))
}

/// Une boîte de coupe, dans le repère du viewer : les coins `min` et `max` de la boîte avant rotation, et sa rotation
/// autour de la verticale (Y), en degrés, positive dans le sens anti-horaire vu d'en haut, autour de son centre.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionBox {
    pub min: V3,
    pub max: V3,
    pub rotation: f64,
}

/// La boîte de coupe d'une vue, si elle est active, bornée de tous les côtés, et si son repère est celui d'une
/// rotation autour de la verticale (le seul que l'interface de Revit sait faire) : sinon `None`.
pub fn section_box(space: &Bounded) -> Option<SectionBox> {
    if !space.on || space.active.iter().flatten().any(|active| !active) {
        return None;
    }
    let [u, v, w] = space.basis;
    // Orthonormée directe, avec l'axe Z du repère local vertical : u et v horizontaux, w = Z.
    let ok = |a: V3, b: V3| dot(a, b).abs() < 1e-6;
    if ![u, v, w].iter().all(|axis| (length(*axis) - 1.0).abs() < 1e-6) || !ok(u, v) || !ok(u, w) || !ok(v, w) {
        return None;
    }
    if u[2].abs() > 1e-6 || v[2].abs() > 1e-6 || (w[2] - 1.0).abs() > 1e-6 {
        return None;
    }
    // Sens direct : v = Z × u.
    if (v[0] + u[1]).abs() > 1e-6 || (v[1] - u[0]).abs() > 1e-6 {
        return None;
    }
    let rotation = u[1].atan2(u[0]).to_degrees();
    let [ou, ov, ow] = space.offsets;
    if ![ou, ov, ow].iter().all(|pair| pair[0] > pair[1] && pair[0].abs() < 1e6 && pair[1].abs() < 1e6) {
        return None;
    }
    // Centre et demi-côtés, dans le repère local puis dans celui du projet (pieds).
    let mid = |pair: [f64; 2]| (pair[0] + pair[1]) / 2.0;
    let half = |pair: [f64; 2]| (pair[0] - pair[1]) / 2.0;
    let centre = add(add(add(space.origin, scale(u, mid(ou))), scale(v, mid(ov))), scale(w, mid(ow)));
    let c = point(centre);
    // x local → X, z local (haut) → Y, y local → -Z du viewer.
    let h = [half(ou) * FOOT, half(ow) * FOOT, half(ov) * FOOT];
    Some(SectionBox { min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]], max: [c[0] + h[0], c[1] + h[1], c[2] + h[2]], rotation })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounded(basis: [[f64; 3]; 3], origin: V3, offsets: [[f64; 2]; 3], on: bool) -> Bounded {
        Bounded { basis, origin, offsets, active: [[true; 2]; 3], on }
    }

    const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

    fn view(eye: V3, right: V3, up: V3, back: V3) -> ViewRecord {
        ViewRecord { eye, right, up, back, ..ViewRecord::default() }
    }

    fn viewer(projection: i64, offsets: [[f64; 2]; 3], active: bool) -> Viewer {
        Viewer { projection, plane_distance: 0.1, crop: Bounded { active: [[active; 2]; 3], ..bounded(IDENTITY, [0.0; 3], offsets, true) }, clip_box: -1 }
    }

    fn near(a: V3, b: V3) {
        assert!(a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9), "{a:?} != {b:?}");
    }

    #[test]
    fn les_axes_de_revit_deviennent_ceux_du_viewer() {
        // (1, 2, 3) pieds : x, z vers le haut, -y.
        near(point([1.0, 2.0, 3.0]), [0.3048, 0.9144, -0.6096]);
        near(direction([1.0, 2.0, 3.0]), [1.0, 3.0, -2.0]);
    }

    #[test]
    fn une_vue_parallele_garde_son_regard_son_haut_et_la_taille_de_sa_fenetre() {
        // Regard vers le nord (+Y de Revit), haut vertical : le sens inverse du regard (`m_viewDir`) est vers le sud.
        let view = view([10.0, 20.0, 5.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]);
        let crop = viewer(1, [[20.0, -10.0], [8.0, -4.0], [1000.0, 0.1]], false);
        let camera = camera(&view, &crop).expect("caméra");
        assert!(!camera.perspective);
        // Nord de Revit = -Z du viewer.
        near(camera.direction, [0.0, 0.0, -1.0]);
        near(camera.up, [0.0, 1.0, 0.0]);
        // Fenêtre de 30 × 12 pieds ; l'œil est décalé vers le centre (+5 à droite, +2 en haut).
        let size = camera.size.expect("taille");
        assert!((size[0] - 30.0 * FOOT).abs() < 1e-9 && (size[1] - 12.0 * FOOT).abs() < 1e-9, "{size:?}");
        near(camera.position, point([15.0, 20.0, 7.0]));
        assert!(camera.fov.is_none());
        // Fenêtre jamais réglée (±100 pieds) : aucune taille.
        let default = viewer(1, [[100.0, -100.0], [100.0, -100.0], [1000.0, 0.1]], false);
        let camera = super::camera(&view, &default).expect("caméra");
        assert!(camera.size.is_none());
        near(camera.position, point([10.0, 20.0, 5.0]));
    }

    #[test]
    fn une_perspective_regarde_le_centre_de_sa_fenetre_et_en_deduit_son_champ() {
        // Fenêtre symétrique de ±0,1 en x et ±0,0562 en y à 0,1 pied : 90° × 59,9° (la fenêtre de la « Cuisine » en est proche).
        let view = view([0.0, 0.0, 5.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [-1.0, 0.0, 0.0]);
        let crop = viewer(2, [[0.1, -0.1], [0.05, -0.05], [50.0, 0.1]], true);
        let camera = camera(&view, &crop).expect("caméra");
        assert!(camera.perspective);
        // Regard vers +X, sans décalage : direction (1, 0, 0), haut (0, 1, 0).
        near(camera.direction, [1.0, 0.0, 0.0]);
        near(camera.up, [0.0, 1.0, 0.0]);
        let fov = camera.fov.expect("champ");
        assert!((fov - 2.0 * (0.5f64).atan().to_degrees()).abs() < 1e-9, "{fov}");
        // Fenêtre décalée vers le haut de 0,05 (45° au-dessus de l'axe sur un plan à 0,1) : la caméra regarde plus haut.
        let shifted = viewer(2, [[0.1, -0.1], [0.1, 0.0], [50.0, 0.1]], true);
        let camera = super::camera(&view, &shifted).expect("caméra");
        assert!(camera.direction[1] > 0.3, "{:?}", camera.direction);
        assert!((length(camera.up) - 1.0).abs() < 1e-9);
        assert!(dot(camera.up, camera.direction).abs() < 1e-9);
        // Fenêtre par défaut, non active : pas de champ, le regard reste celui de la vue.
        let default = viewer(2, [[100.0, -100.0], [100.0, -100.0], [1000.0, 0.1]], false);
        let camera = super::camera(&view, &default).expect("caméra");
        assert!(camera.fov.is_none());
        near(camera.direction, [1.0, 0.0, 0.0]);
    }

    #[test]
    fn une_boite_de_coupe_axiale_devient_min_et_max() {
        // Origine (10, 20, 30) pieds ; x de -2 à +4, y de -1 à +3, z de -5 à +5.
        let space = bounded(IDENTITY, [10.0, 20.0, 30.0], [[4.0, -2.0], [3.0, -1.0], [5.0, -5.0]], true);
        let b = section_box(&space).expect("boîte");
        // Centre du repère local : (10+1, 20+1, 30) ; viewer : (x, z, -y).
        let c = point([11.0, 21.0, 30.0]);
        near(b.min, [c[0] - 3.0 * FOOT, c[1] - 5.0 * FOOT, c[2] - 2.0 * FOOT]);
        near(b.max, [c[0] + 3.0 * FOOT, c[1] + 5.0 * FOOT, c[2] + 2.0 * FOOT]);
        assert_eq!(b.rotation, 0.0);
        // Une boîte inactive, ou ouverte d'un côté, n'est pas une boîte de coupe.
        assert!(section_box(&Bounded { on: false, ..space.clone() }).is_none());
        let mut open = space;
        open.active[2][0] = false;
        assert!(section_box(&open).is_none());
    }

    #[test]
    fn une_boite_tournee_autour_de_la_verticale_donne_sa_rotation() {
        let (s, c) = (30f64.to_radians().sin(), 30f64.to_radians().cos());
        // Axe local x à 30° du X de Revit ; y local = Z × x.
        let space = bounded([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]], [0.0; 3], [[2.0, -2.0], [1.0, -1.0], [3.0, -3.0]], true);
        let b = section_box(&space).expect("boîte");
        assert!((b.rotation - 30.0).abs() < 1e-9, "{}", b.rotation);
        near(b.max, [2.0 * FOOT, 3.0 * FOOT, 1.0 * FOOT]);
        // Une rotation autour d'un autre axe n'est pas représentable.
        let tilted = bounded([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], [0.0; 3], [[2.0, -2.0], [1.0, -1.0], [3.0, -3.0]], true);
        assert!(section_box(&tilted).is_none());
        // Un repère qui retourne l'espace non plus.
        let mirrored = bounded([[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]], [0.0; 3], [[2.0, -2.0], [1.0, -1.0], [3.0, -3.0]], true);
        assert!(section_box(&mirrored).is_none());
    }
}
