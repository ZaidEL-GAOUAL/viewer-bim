//! Surfaces enregistrées, évaluées dans leur propre paramétrage (u, v) : plan, cylindre, cône,
//! surface de révolution et surface réglée. Chaque surface donne son point et ses dérivées
//! partielles ; la normale est leur produit vectoriel, orientée ensuite par les drapeaux de la face.
//!
//! * plan : `P = O + u X + v Y`
//! * cylindre : `P = C + R cos u X + R sin u Y + v Z`
//! * cône (sommet en `m_center`, demi-angle `a`, `v` = distance au sommet sur la génératrice) :
//!   `P = C + v sin a (cos u X + sin u Y) + v cos a Z`
//! * révolution : le profil `q(v)`, dans le repère local, tourne de `u` autour de Z :
//!   `P = C + X (q₀ cos u − q₁ sin u) + Y (q₀ sin u + q₁ cos u) + Z q₂`
//! * réglée : `P = (1 − v) C₁(t₁) + v C₂(t₂)`, `tᵢ = début + u (fin − début)` de la courbe `i`.
//! * Hermite : une grille de nœuds, chacun avec son point, ses tangentes `∂P/∂u` et `∂P/∂v` et sa dérivée mixte
//!   `∂²P/∂u∂v`, interpolée par un carreau bicubique d'Hermite par maille (voir `Shape::Hermite`).
//!
//! Formules vérifiées contre les points de bord de Revit par baleti (`rvt-reader`, MIT, voir
//! `THIRD_PARTY.md`) ; celles du plan, du cylindre, de la révolution et de la surface réglée sont
//! aussi celles de rvt-rs.

use anyhow::{Context, Result, bail, ensure};
use rvt::research::native_parameters::ObjectGraph;

use super::curve::Curve;
use super::graph::{envelope, number, point3, target};
use super::math::{V3, add, cross, dot, frame, norm, scale, sub, unit};

#[derive(Debug, Clone)]
pub enum Shape {
    Plane,
    Cylinder { radius: f64 },
    Cone { half_angle: f64 },
    Revolution { profile: Curve },
    Ruled { first: Curve, second: Curve },
    /// `HermiteSurf` : un maillage de `us.len()` × `vs.len()` nœuds (`m_uParams`, `m_vParams`), le nœud (i, j) étant à
    /// l'indice `j · nu + i` de `m_NodeArray` (u varie le plus vite : sur les 5 × 5 nœuds de la première surface lue,
    /// l'écart entre un nœud et son voisin selon u vaut la demi-somme de leurs tangentes `∂P/∂u` à 3e-17 pied près,
    /// contre 4e-4 selon v, et à 4e-2 pour l'ordre inverse). Dans chaque maille, un carreau bicubique d'Hermite
    /// construit sur les quatre nœuds d'angle : `P(s, t) = Σ hₖ(s) hₗ(t) Gₖₗ`, avec les fonctions de base d'Hermite
    /// (valeur et tangente à chaque bout), `Gₖₗ` le point, la tangente ou la dérivée mixte du nœud, multipliés par les
    /// longueurs de maille. Un carreau est de classe C¹ d'une maille à l'autre.
    Hermite { us: Vec<f64>, vs: Vec<f64>, nodes: Vec<HermiteNode> },
}

/// Un nœud d'une surface d'Hermite : point, dérivées partielles et dérivée mixte, par rapport aux paramètres (u, v).
#[derive(Debug, Clone, Copy)]
pub struct HermiteNode {
    pub point: V3,
    pub du: V3,
    pub dv: V3,
    pub duv: V3,
}

#[derive(Debug, Clone)]
pub struct Surface {
    pub shape: Shape,
    /// Origine du plan, centre du cylindre, sommet du cône, centre de la révolution.
    pub origin: V3,
    pub x: V3,
    pub y: V3,
    pub z: V3,
    /// `[[umin, vmin], [umax, vmax]]`.
    pub envelope: [[f64; 2]; 2],
    /// `m_orientFlag` : le sens de la normale `Su × Sv` est le sens extérieur quand il est vrai.
    pub orient: bool,
}

impl Surface {
    pub fn read(graph: &ObjectGraph, index: usize) -> Result<Surface> {
        let object = graph.objects.get(index).context("surface : objet absent")?;
        let f = &object.fields;
        let orient = f["m_orientFlag"].as_bool().context("surface : orientation absente")?;
        let envelope = envelope(f)?;
        match object.class_name.as_str() {
            "Plane" => {
                let (x, y) = (point3(&f["m_xVec"])?, point3(&f["m_yVec"])?);
                let z = unit(cross(x, y)).context("plan singulier")?;
                Ok(Surface { shape: Shape::Plane, origin: point3(&f["m_origin"])?, x, y, z, envelope, orient })
            }
            "CylSurf" => {
                let radius = number(&f["m_radius"], "rayon du cylindre")?;
                ensure!(radius > 0.0, "cylindre : rayon nul");
                let (x, y, z) = basis(f)?;
                Ok(Surface { shape: Shape::Cylinder { radius }, origin: point3(&f["m_center"])?, x, y, z, envelope, orient })
            }
            "ConeSurf" => {
                let half_angle = number(&f["m_halfAngle"], "demi-angle du cône")?;
                ensure!(half_angle > 0.0 && half_angle < std::f64::consts::FRAC_PI_2 + 1e-9, "cône : demi-angle invalide");
                let (x, y, z) = basis(f)?;
                Ok(Surface { shape: Shape::Cone { half_angle }, origin: point3(&f["m_center"])?, x, y, z, envelope, orient })
            }
            "SurfRev" => {
                let profile = target(graph, index, &f["m_pProfileCurve"])?.context("surface de révolution : profil absent")?;
                let (x, y, z) = basis(f)?;
                Ok(Surface { shape: Shape::Revolution { profile: Curve::read(graph, profile)? }, origin: point3(&f["m_center"])?, x, y, z, envelope, orient })
            }
            "RuledSurf" => {
                // Une des deux « courbes » peut être absente : la surface converge alors vers le
                // point `m_Point1` ou `m_Point2` (une surface réglée en éventail).
                let curve = |pointer: &str, point: &str| -> Result<Curve> {
                    match target(graph, index, &f[pointer])? {
                        Some(profile) => Curve::read(graph, profile),
                        None => Ok(Curve::Point(point3(&f[point])?)),
                    }
                };
                let (first, second) = (curve("m_pProfileCurve1", "m_Point1")?, curve("m_pProfileCurve2", "m_Point2")?);
                if matches!((&first, &second), (Curve::Point(_), Curve::Point(_))) {
                    bail!("surface réglée sans aucune courbe");
                }
                Ok(Surface { shape: Shape::Ruled { first, second }, origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0], envelope, orient })
            }
            "HermiteSurf" => {
                let knots = |name: &str, what: &str| -> Result<Vec<f64>> {
                    let values: Vec<f64> = f[name].as_array().with_context(|| format!("{what} absents"))?.iter().map(|k| number(k, what)).collect::<Result<_>>()?;
                    ensure!(values.len() >= 2 && values.windows(2).all(|pair| pair[1] > pair[0]), "{what} non croissants");
                    Ok(values)
                };
                let (us, vs) = (knots("m_uParams", "paramètres u")?, knots("m_vParams", "paramètres v")?);
                ensure!(f["m_periodic"].as_array().is_some_and(|flags| flags.iter().all(|flag| flag.as_bool() == Some(false))), "surface d'Hermite périodique non prise en charge");
                let raw = f["m_NodeArray"].as_array().context("nœuds de la surface d'Hermite absents")?;
                ensure!(raw.len() == us.len() * vs.len(), "surface d'Hermite : {} nœuds pour {} × {} paramètres", raw.len(), us.len(), vs.len());
                let mut nodes = Vec::with_capacity(raw.len());
                for node in raw {
                    let tangents = node["m_iTangent"].as_array().filter(|t| t.len() == 2).context("surface d'Hermite : deux tangentes par nœud attendues")?;
                    nodes.push(HermiteNode { point: point3(&node["m_iPoint"])?, du: point3(&tangents[0])?, dv: point3(&tangents[1])?, duv: point3(&node["m_iMixedDer"])? });
                }
                Ok(Surface { shape: Shape::Hermite { us, vs, nodes }, origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0], envelope, orient })
            }
            other => bail!("surface non prise en charge : {other}"),
        }
    }

    pub fn is_plane(&self) -> bool {
        matches!(self.shape, Shape::Plane)
    }

    /// Le point de la surface en (u, v).
    pub fn eval(&self, u: f64, v: f64) -> V3 {
        let (c, s) = (u.cos(), u.sin());
        match &self.shape {
            Shape::Plane => add(self.origin, add(scale(self.x, u), scale(self.y, v))),
            Shape::Cylinder { radius } => add(self.origin, frame(self.x, self.y, self.z, [radius * c, radius * s, v])),
            Shape::Cone { half_angle } => add(self.origin, frame(self.x, self.y, self.z, [v * half_angle.sin() * c, v * half_angle.sin() * s, v * half_angle.cos()])),
            Shape::Revolution { profile } => {
                let q = profile.eval(v);
                add(self.origin, frame(self.x, self.y, self.z, [q[0] * c - q[1] * s, q[0] * s + q[1] * c, q[2]]))
            }
            Shape::Ruled { first, second } => {
                let (p1, p2) = (first.eval(ruled_parameter(first, u)), second.eval(ruled_parameter(second, u)));
                add(scale(p1, 1.0 - v), scale(p2, v))
            }
            Shape::Hermite { us, vs, nodes } => hermite_patch(us, vs, nodes, u, v).0,
        }
    }

    /// Dérivées partielles `(∂P/∂u, ∂P/∂v)` en (u, v).
    pub fn partials(&self, u: f64, v: f64) -> (V3, V3) {
        let (c, s) = (u.cos(), u.sin());
        match &self.shape {
            Shape::Plane => (self.x, self.y),
            Shape::Cylinder { radius } => (frame(self.x, self.y, self.z, [-radius * s, radius * c, 0.0]), self.z),
            Shape::Cone { half_angle } => {
                let (sa, ca) = (half_angle.sin(), half_angle.cos());
                (frame(self.x, self.y, self.z, [-v * sa * s, v * sa * c, 0.0]), frame(self.x, self.y, self.z, [sa * c, sa * s, ca]))
            }
            Shape::Revolution { profile } => {
                let (q, dq) = (profile.eval(v), profile.derivative(v));
                (frame(self.x, self.y, self.z, [-q[0] * s - q[1] * c, q[0] * c - q[1] * s, 0.0]), frame(self.x, self.y, self.z, [dq[0] * c - dq[1] * s, dq[0] * s + dq[1] * c, dq[2]]))
            }
            Shape::Ruled { first, second } => {
                let (t1, t2) = (ruled_parameter(first, u), ruled_parameter(second, u));
                let (r1, r2) = (first.range(), second.range());
                let du = add(scale(first.derivative(t1), (1.0 - v) * (r1[1] - r1[0])), scale(second.derivative(t2), v * (r2[1] - r2[0])));
                (du, sub(second.eval(t2), first.eval(t1)))
            }
            Shape::Hermite { us, vs, nodes } => {
                let (_, du, dv) = hermite_patch(us, vs, nodes, u, v);
                (du, dv)
            }
        }
    }

    /// La normale unitaire `Su × Sv` en (u, v), sans tenir compte de l'orientation. Aux points
    /// singuliers (sommet d'un cône, pôle d'une révolution) où elle s'annule, on la prend un peu à
    /// l'intérieur de l'enveloppe, où elle est continue.
    pub fn normal(&self, u: f64, v: f64) -> Option<V3> {
        let direct = |u: f64, v: f64| {
            let (su, sv) = self.partials(u, v);
            let (c, scale) = (cross(su, sv), norm(su) * norm(sv));
            (scale > 0.0 && norm(c) > 1e-9 * scale).then(|| unit(c)).flatten()
        };
        if let Some(n) = direct(u, v) {
            return Some(n);
        }
        let [[u0, v0], [u1, v1]] = self.envelope;
        let (du, dv) = ((u1 - u0) * 1e-3, (v1 - v0) * 1e-3);
        let toward = |value: f64, lo: f64, hi: f64, step: f64| if value - lo < hi - value { value + step } else { value - step };
        [(u, toward(v, v0, v1, dv)), (toward(u, u0, u1, du), v), (toward(u, u0, u1, du), toward(v, v0, v1, dv))].into_iter().find_map(|(a, b)| direct(a, b))
    }

    /// Facteurs de longueur de u et de v au centre de l'enveloppe : l'échelle qui rend le plan (u, v)
    /// isotrope pour la triangulation.
    pub fn metric(&self, bounds: [[f64; 2]; 2]) -> [f64; 2] {
        let mut sum = [0.0, 0.0];
        let mut count = 0.0;
        for i in 0..5 {
            for j in 0..5 {
                let u = bounds[0][0] + (bounds[1][0] - bounds[0][0]) * (i as f64 + 0.5) / 5.0;
                let v = bounds[0][1] + (bounds[1][1] - bounds[0][1]) * (j as f64 + 0.5) / 5.0;
                let (su, sv) = self.partials(u, v);
                if norm(su).is_finite() && norm(sv).is_finite() {
                    sum[0] += norm(su);
                    sum[1] += norm(sv);
                    count += 1.0;
                }
            }
        }
        let average = |total: f64| if count > 0.0 && total / count > 1e-9 { total / count } else { 1.0 };
        [average(sum[0]), average(sum[1])]
    }
}

/// Les fonctions de base d'Hermite en `s` ∈ [0, 1] (valeur au début, tangente au début, valeur à la fin, tangente à la
/// fin) et leurs dérivées par rapport à `s`.
fn hermite_basis(s: f64) -> ([f64; 4], [f64; 4]) {
    let (s2, s3) = (s * s, s * s * s);
    ([2.0 * s3 - 3.0 * s2 + 1.0, s3 - 2.0 * s2 + s, -2.0 * s3 + 3.0 * s2, s3 - s2], [6.0 * s2 - 6.0 * s, 3.0 * s2 - 4.0 * s + 1.0, -6.0 * s2 + 6.0 * s, 3.0 * s2 - 2.0 * s])
}

/// Le point et les deux dérivées partielles d'une surface d'Hermite en (u, v) (hors de la grille : ramené dessus).
fn hermite_patch(us: &[f64], vs: &[f64], nodes: &[HermiteNode], u: f64, v: f64) -> (V3, V3, V3) {
    use super::curve::hermite_cell;
    let (i, s, hu) = hermite_cell(us, u);
    let (j, t, hv) = hermite_cell(vs, v);
    let nu = us.len();
    let at = |di: usize, dj: usize| nodes[(j + dj) * nu + i + di];
    let (n00, n10, n01, n11) = (at(0, 0), at(1, 0), at(0, 1), at(1, 1));
    // G[k][l] : k sur u (valeur en i, tangente en i, valeur en i + 1, tangente en i + 1), l de même sur v.
    let g = [
        [n00.point, scale(n00.dv, hv), n01.point, scale(n01.dv, hv)],
        [scale(n00.du, hu), scale(n00.duv, hu * hv), scale(n01.du, hu), scale(n01.duv, hu * hv)],
        [n10.point, scale(n10.dv, hv), n11.point, scale(n11.dv, hv)],
        [scale(n10.du, hu), scale(n10.duv, hu * hv), scale(n11.du, hu), scale(n11.duv, hu * hv)],
    ];
    let ((bs, ds), (bt, dt)) = (hermite_basis(s), hermite_basis(t));
    let (mut point, mut du, mut dv) = ([0.0; 3], [0.0; 3], [0.0; 3]);
    for k in 0..4 {
        for l in 0..4 {
            point = add(point, scale(g[k][l], bs[k] * bt[l]));
            du = add(du, scale(g[k][l], ds[k] * bt[l]));
            dv = add(dv, scale(g[k][l], bs[k] * dt[l]));
        }
    }
    (point, scale(du, 1.0 / hu), scale(dv, 1.0 / hv))
}

/// Le paramètre de la courbe `curve` qui répond à `u` : `u` parcourt [0, 1] quand la courbe
/// parcourt son intervalle.
fn ruled_parameter(curve: &Curve, u: f64) -> f64 {
    let [a, b] = curve.range();
    a + u * (b - a)
}

/// Le repère (x, y, z) d'un cylindre, d'un cône ou d'une révolution : unitaire et orthogonal à
/// 1e-3 près (Revit l'écrit à 1e-9 près).
fn basis(fields: &serde_json::Value) -> Result<(V3, V3, V3)> {
    let (x, y, z) = (point3(&fields["m_xVec"])?, point3(&fields["m_yVec"])?, point3(&fields["m_zVec"])?);
    ensure!([x, y, z].iter().all(|axis| (norm(*axis) - 1.0).abs() < 1e-3), "repère non unitaire");
    ensure!(dot(x, y).abs() < 1e-3 && dot(x, z).abs() < 1e-3 && dot(y, z).abs() < 1e-3, "repère non orthogonal");
    Ok((x, y, z))
}
