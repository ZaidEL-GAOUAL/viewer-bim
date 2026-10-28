//! Petits calculs sur des vecteurs de l'espace (`[f64; 3]`), en pieds comme tout le reste du
//! module : sans dépendance, pour que les évaluateurs restent lisibles.

pub type V3 = [f64; 3];

pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn scale(a: V3, factor: f64) -> V3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

pub fn distance(a: V3, b: V3) -> f64 {
    norm(sub(a, b))
}

/// Le vecteur de même direction et de longueur 1 ; `None` s'il est nul ou non fini.
pub fn unit(a: V3) -> Option<V3> {
    let length = norm(a);
    (length.is_finite() && length > 1e-300).then(|| scale(a, 1.0 / length))
}

/// Combinaison `a·x + b·y + c·z` : un point d'un repère de base (x, y, z).
pub fn frame(x: V3, y: V3, z: V3, local: V3) -> V3 {
    [
        x[0] * local[0] + y[0] * local[1] + z[0] * local[2],
        x[1] * local[0] + y[1] * local[1] + z[1] * local[2],
        x[2] * local[0] + y[2] * local[1] + z[2] * local[2],
    ]
}

pub fn finite(a: V3) -> bool {
    a.iter().all(|c| c.is_finite())
}
