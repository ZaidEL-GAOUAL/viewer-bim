//! Courbes enregistrées (les profils des surfaces de révolution et réglées) : droite, arc,
//! ellipse, spline d'Hermite et NURBS. Chaque courbe sait donner son point et sa dérivée à un
//! paramètre ; les paramètres hors de l'intervalle sont ramenés dessus.
//!
//! Les formules sont celles que Revit utilise pour ses propres arêtes (vérifiées par baleti,
//! `rvt-reader`, MIT, contre les points de bord que Revit enregistre ; voir `THIRD_PARTY.md`).

use anyhow::{Context, Result, bail, ensure};
use rvt::research::native_parameters::ObjectGraph;

use super::graph::{number, point3, range};
use super::math::{V3, add, scale, sub};

#[derive(Debug, Clone)]
pub enum Curve {
    /// Un point : « courbe » dégénérée d'une surface réglée qui converge vers un sommet.
    Point(V3),
    Line { origin: V3, direction: V3, range: [f64; 2] },
    Arc { center: V3, x: V3, y: V3, radius: f64, range: [f64; 2] },
    Ellipse { center: V3, x: V3, y: V3, x_length: f64, y_length: f64, range: [f64; 2] },
    /// Spline cubique d'Hermite : à chaque nœud, un paramètre, un point et une tangente (dérivée
    /// par rapport au paramètre).
    Hermite { params: Vec<f64>, points: Vec<V3>, tangents: Vec<V3>, range: [f64; 2] },
    /// B-spline rationnelle non uniforme.
    Nurbs { degree: usize, knots: Vec<f64>, poles: Vec<V3>, weights: Vec<f64>, range: [f64; 2] },
}

impl Curve {
    /// Lit l'objet `index` du graphe (`GLine`, `GArc`, `GEllipse`, `GHermiteSpline`, `GNurbSpline`).
    pub fn read(graph: &ObjectGraph, index: usize) -> Result<Curve> {
        let object = graph.objects.get(index).context("courbe : objet absent")?;
        let f = &object.fields;
        match object.class_name.as_str() {
            "GLine" => {
                let direction = point3(&f["m_dirVec"])?;
                ensure!(super::math::norm(direction) > 1e-12, "droite : direction nulle");
                Ok(Curve::Line { origin: point3(&f["m_origin"])?, direction, range: range(&f["m_endParams"], "droite")? })
            }
            "GArc" => {
                let radius = number(&f["m_radius"], "rayon d'arc")?;
                ensure!(radius > 0.0, "arc : rayon nul");
                Ok(Curve::Arc { center: point3(&f["m_center"])?, x: point3(&f["m_xVec"])?, y: point3(&f["m_yVec"])?, radius, range: range(&f["m_endParams"], "arc")? })
            }
            "GEllipse" => {
                let x_length = number(&f["m_xLen"], "demi-axe de l'ellipse")?;
                let y_length = number(&f["m_yLen"], "demi-axe de l'ellipse")?;
                ensure!(x_length > 0.0 && y_length > 0.0, "ellipse : demi-axe nul");
                Ok(Curve::Ellipse { center: point3(&f["m_center"])?, x: point3(&f["m_xVec"])?, y: point3(&f["m_yVec"])?, x_length, y_length, range: range(&f["m_endParams"], "ellipse")? })
            }
            "GHermiteSpline" => {
                let nodes = f["m_NodeArray"].as_array().context("Hermite : nœuds absents")?;
                ensure!(nodes.len() >= 2, "Hermite : au moins deux nœuds");
                let mut params = Vec::with_capacity(nodes.len());
                let mut points = Vec::with_capacity(nodes.len());
                let mut tangents = Vec::with_capacity(nodes.len());
                for node in nodes {
                    params.push(number(&node["m_iParametr"], "paramètre de nœud")?);
                    points.push(point3(&node["m_iPoint"])?);
                    tangents.push(point3(&node["m_iTangent"])?);
                }
                ensure!(params.windows(2).all(|pair| pair[1] > pair[0]), "Hermite : paramètres non croissants");
                let span = [params[0], params[params.len() - 1]];
                let bounds = if f.get("m_endParams").is_some() { range(&f["m_endParams"], "Hermite")? } else { span };
                Ok(Curve::Hermite { params, points, tangents, range: bounds })
            }
            "GNurbSpline" => {
                let degree = f["m_Degree"].as_u64().context("NURBS : degré absent")? as usize;
                let knots: Vec<f64> = f["m_Knots"].as_array().context("NURBS : nœuds absents")?.iter().map(|k| number(k, "nœud")).collect::<Result<_>>()?;
                let controls = f["m_ctrlPoints"].as_array().context("NURBS : points de contrôle absents")?;
                let mut poles = Vec::with_capacity(controls.len());
                let mut weights = Vec::with_capacity(controls.len());
                for control in controls {
                    poles.push(point3(&control["m_Point"])?);
                    weights.push(control.get("m_w").map_or(Ok(1.0), |w| number(w, "poids"))?);
                }
                ensure!(degree >= 1 && poles.len() > degree, "NURBS : degré et points de contrôle incohérents");
                ensure!(knots.len() == poles.len() + degree + 1, "NURBS : nombre de nœuds incohérent");
                ensure!(knots.windows(2).all(|pair| pair[1] >= pair[0]) && weights.iter().all(|w| *w > 0.0), "NURBS : nœuds ou poids invalides");
                let span = [knots[degree], knots[poles.len()]];
                let bounds = if f.get("m_endParams").is_some() { range(&f["m_endParams"], "NURBS")? } else { span };
                Ok(Curve::Nurbs { degree, knots, poles, weights, range: bounds })
            }
            other => bail!("courbe de profil non prise en charge : {other}"),
        }
    }

    /// Intervalle de paramètres de la courbe.
    pub fn range(&self) -> [f64; 2] {
        match self {
            Curve::Point(_) => [0.0, 1.0],
            Curve::Line { range, .. } | Curve::Arc { range, .. } | Curve::Ellipse { range, .. } | Curve::Hermite { range, .. } | Curve::Nurbs { range, .. } => *range,
        }
    }

    /// Le point au paramètre `t`.
    pub fn eval(&self, t: f64) -> V3 {
        match self {
            Curve::Point(p) => *p,
            Curve::Line { origin, direction, .. } => add(*origin, scale(*direction, t)),
            Curve::Arc { center, x, y, radius, .. } => add(*center, scale(add(scale(*x, t.cos()), scale(*y, t.sin())), *radius)),
            Curve::Ellipse { center, x, y, x_length, y_length, .. } => add(*center, add(scale(*x, x_length * t.cos()), scale(*y, y_length * t.sin()))),
            Curve::Hermite { params, points, tangents, .. } => {
                let (i, s, h) = hermite_cell(params, t);
                let (h00, h10, h01, h11) = (2.0 * s * s * s - 3.0 * s * s + 1.0, s * s * s - 2.0 * s * s + s, -2.0 * s * s * s + 3.0 * s * s, s * s * s - s * s);
                add(add(scale(points[i], h00), scale(tangents[i], h10 * h)), add(scale(points[i + 1], h01), scale(tangents[i + 1], h11 * h)))
            }
            Curve::Nurbs { degree, knots, poles, weights, .. } => {
                let (span, basis) = nurbs_basis(*degree, knots, poles.len(), t);
                let (mut sum, mut weight) = ([0.0; 3], 0.0);
                for (k, n) in basis.iter().enumerate() {
                    let index = span - degree + k;
                    let w = n * weights[index];
                    sum = add(sum, scale(poles[index], w));
                    weight += w;
                }
                if weight.abs() > 1e-300 { scale(sum, 1.0 / weight) } else { poles[0] }
            }
        }
    }

    /// La dérivée par rapport au paramètre, au paramètre `t`.
    pub fn derivative(&self, t: f64) -> V3 {
        match self {
            Curve::Point(_) => [0.0; 3],
            Curve::Line { direction, .. } => *direction,
            Curve::Arc { x, y, radius, .. } => scale(add(scale(*x, -t.sin()), scale(*y, t.cos())), *radius),
            Curve::Ellipse { x, y, x_length, y_length, .. } => add(scale(*x, -x_length * t.sin()), scale(*y, y_length * t.cos())),
            Curve::Hermite { params, points, tangents, .. } => {
                let (i, s, h) = hermite_cell(params, t);
                let (d00, d10, d01, d11) = (6.0 * s * s - 6.0 * s, 3.0 * s * s - 4.0 * s + 1.0, -6.0 * s * s + 6.0 * s, 3.0 * s * s - 2.0 * s);
                add(scale(add(scale(points[i], d00), scale(points[i + 1], d01)), 1.0 / h), add(scale(tangents[i], d10), scale(tangents[i + 1], d11)))
            }
            Curve::Nurbs { .. } => {
                // Différence centrée : la forme analytique d'une dérivée rationnelle n'apporte rien ici.
                let [a, b] = self.range();
                let h = (b - a).abs().max(1e-12) * 1e-6;
                let (t0, t1) = ((t - h).max(a.min(b)), (t + h).min(a.max(b)));
                if t1 > t0 { scale(sub(self.eval(t1), self.eval(t0)), 1.0 / (t1 - t0)) } else { [0.0; 3] }
            }
        }
    }
}

/// Segment d'une spline d'Hermite qui contient `t` : indice du nœud de départ, abscisse locale
/// dans [0, 1] et longueur du segment.
pub(super) fn hermite_cell(params: &[f64], t: f64) -> (usize, f64, f64) {
    let last = params.len() - 2;
    let i = match params.binary_search_by(|p| p.total_cmp(&t)) {
        Ok(i) => i.min(last),
        Err(i) => i.saturating_sub(1).min(last),
    };
    let h = params[i + 1] - params[i];
    (i, ((t - params[i]) / h).clamp(0.0, 1.0), h)
}

/// Fonctions de base non nulles d'une B-spline en `t` : l'indice du dernier nœud de l'intervalle
/// et les `degré + 1` valeurs (algorithme A2.2 du NURBS Book).
fn nurbs_basis(degree: usize, knots: &[f64], poles: usize, t: f64) -> (usize, Vec<f64>) {
    let t = t.clamp(knots[degree], knots[poles]);
    // Intervalle [knots[span], knots[span + 1]) contenant t ; le dernier intervalle est fermé.
    let mut span = degree;
    while span + 1 < poles && t >= knots[span + 1] {
        span += 1;
    }
    let mut basis = vec![0.0; degree + 1];
    let mut left = vec![0.0; degree + 1];
    let mut right = vec![0.0; degree + 1];
    basis[0] = 1.0;
    for j in 1..=degree {
        left[j] = t - knots[span + 1 - j];
        right[j] = knots[span + j] - t;
        let mut saved = 0.0;
        for r in 0..j {
            let denominator = right[r + 1] + left[j - r];
            let value = if denominator.abs() > 1e-300 { basis[r] / denominator } else { 0.0 };
            basis[r] = saved + right[r + 1] * value;
            saved = left[j - r] * value;
        }
        basis[j] = saved;
    }
    (span, basis)
}
