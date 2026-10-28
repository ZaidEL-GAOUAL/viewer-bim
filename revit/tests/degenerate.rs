//! Le maillage des faces ne panique jamais, quelle que soit l'entrée.
//!
//! En WebAssembly (`wasm32-unknown-unknown`), une panique n'est pas rattrapable : `catch_unwind` ne
//! rattrape rien, une face dégénérée emporterait toute la lecture du fichier. Ces essais n'utilisent donc
//! pas `catch_unwind` : une panique fait échouer l'essai, et un crochet de panique la compte aussi (un
//! compteur nul est une vérification de plus, que ni la fonction essayée ni un rattrapage ne peuvent
//! masquer). Cas dégénérés nommés (boucles de moins de trois points, sommets confondus, côtés nuls ou
//! doublés, boucles alignées, valeurs non finies ou extrêmes), puis un tirage au hasard déterministe de
//! boucles de toutes sortes. Les cas sont refusés (`Err`) ou triangulés, jamais autre chose.
//!
//! Isolé dans son propre binaire : le crochet de panique est global au processus.
//!
//! À lancer avec `cargo test --release`.

use std::sync::atomic::{AtomicUsize, Ordering};

use revit::geometry::faces::region::{self, Loop};
use revit::geometry::faces::surface::{Shape, Surface};
use revit::geometry::faces::tess;

static PANICS: AtomicUsize = AtomicUsize::new(0);

/// Compte les paniques de tout le processus (en plus du comportement d'un essai : une panique échoue).
fn count_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            PANICS.fetch_add(1, Ordering::SeqCst);
            previous(info);
        }));
    });
}

fn triangulate(loops: &[Loop], metric: [f64; 2], grid: Option<(&[f64], &[f64])>) -> Result<region::Mesh2, String> {
    region::triangulate(loops, metric, grid).map_err(|error| format!("{error:#}"))
}

fn square(side: f64) -> Loop {
    vec![[0.0, 0.0], [side, 0.0], [side, side], [0.0, side]]
}

#[test]
fn les_boucles_degenerees_sont_refusees_sans_panique() {
    count_panics();
    let before = PANICS.load(Ordering::SeqCst);
    let unit = [1.0, 1.0];

    // Moins de trois sommets : refusé.
    for ring in [vec![], vec![[1.0, 1.0]], vec![[0.0, 0.0], [1.0, 1.0]], vec![[0.0, 0.0], [1.0, 0.0], [0.0, 0.0]]] {
        assert!(triangulate(&[ring.clone()], unit, None).is_err(), "boucle {ring:?}");
    }
    assert!(triangulate(&[], unit, None).is_err(), "aucune boucle");

    // Tous les sommets confondus, ou confondus à un reste de calcul près (1e-15) : refusé.
    assert!(triangulate(&[vec![[1.0, 2.0]; 6]], unit, None).is_err());
    let blurred: Loop = (0..6).map(|k| [1.0 + 1e-15 * f64::from(k), 2.0 - 1e-15 * f64::from(k)]).collect();
    assert!(triangulate(&[blurred], unit, None).is_err());

    // Sommets alignés : pas de surface, refusé.
    let line: Loop = (0..8).map(|k| [f64::from(k), 2.0 * f64::from(k)]).collect();
    assert!(triangulate(&[line], unit, None).is_err(), "boucle alignée");
    let horizontal: Loop = (0..8).map(|k| [f64::from(k), 3.0]).collect();
    assert!(triangulate(&[horizontal], unit, None).is_err(), "boucle alignée sur un axe");
    let nearly: Loop = (0..8).map(|k| [f64::from(k), f64::from(k) * (1.0 + 1e-16)]).collect();
    assert!(triangulate(&[nearly], unit, None).is_err(), "boucle presque alignée");

    // Valeurs non finies ou hors de portée : refusé.
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1e300, -1e300] {
        let mut ring = square(1.0);
        ring[2][0] = bad;
        assert!(triangulate(&[ring], unit, None).is_err(), "coordonnée {bad}");
    }
    for metric in [[0.0, 1.0], [1.0, -1.0], [f64::NAN, 1.0], [1.0, f64::INFINITY], [1e-300, 1e300]] {
        // Une échelle invalide est refusée ; une échelle extrême aussi quand elle fait déborder les coordonnées.
        let _ = triangulate(&[square(1.0)], metric, None);
    }
    assert!(triangulate(&[square(1.0)], [0.0, 1.0], None).is_err());
    assert!(triangulate(&[square(1.0)], [f64::NAN, 1.0], None).is_err());
    let grid_nan = [0.0, f64::NAN, 1.0];
    assert!(triangulate(&[square(1.0)], unit, Some((&grid_nan, &[0.0, 1.0]))).is_err(), "grille non finie");

    // Des sommets en double dans une boucle valide et des côtés de longueur nulle ne gênent pas : la
    // région est triangulée comme sans eux (le carré fait deux triangles).
    let mut doubled = square(2.0);
    doubled.insert(1, doubled[0]);
    doubled.insert(3, doubled[3]);
    doubled.push(doubled[0]);
    let mesh = triangulate(&[doubled], unit, None).expect("carré avec des sommets en double");
    assert_eq!(mesh.points.len(), 4);
    assert_eq!(mesh.triangles.len(), 2);
    // Un carré dessiné deux fois (deux boucles identiques) : le côté en double n'est inscrit qu'une fois.
    let _ = triangulate(&[square(2.0), square(2.0)], unit, None);
    // Sommets à un reste de calcul près : fusionnés, le carré reste un carré.
    let jitter: Loop = square(1.0).into_iter().flat_map(|p| [p, [p[0] + 1e-15, p[1] - 1e-15]]).collect();
    let mesh = triangulate(&[jitter], unit, None).expect("carré aux sommets doublés à 1e-15 près");
    assert_eq!((mesh.points.len(), mesh.triangles.len()), (4, 2));

    // Une boucle croisée (nœud papillon) : triangulée ou refusée, sans panique.
    let _ = triangulate(&[vec![[0.0, 0.0], [2.0, 2.0], [2.0, 0.0], [0.0, 2.0]]], unit, None);

    assert_eq!(PANICS.load(Ordering::SeqCst), before, "une panique a eu lieu");
}

#[test]
fn un_contour_sans_etendue_ou_une_surface_degeneree_est_refuse() {
    count_panics();
    let before = PANICS.load(Ordering::SeqCst);
    let plane = Surface { shape: Shape::Plane, origin: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0], envelope: [[0.0, 0.0], [10.0, 10.0]], orient: true };
    for ring in [vec![[1.0, 1.0], [1.0, 1.0], [1.0, 1.0]], vec![[0.0, 0.0], [5.0, 0.0], [10.0, 0.0]], vec![[0.0, 0.0], [0.0, 5.0], [0.0, 10.0]]] {
        assert!(tess::mesh(&plane, &[ring.clone()], true).is_err(), "contour {ring:?}");
    }
    assert_eq!(PANICS.load(Ordering::SeqCst), before, "une panique a eu lieu");
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn range(&mut self, low: f64, high: f64) -> f64 {
        low + (high - low) * self.unit()
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Un cas tiré au hasard : boucles, échelle (u, v) et grille intérieure. Les familles visent les points
/// délicats d'une triangulation : alignements, sommets (presque) confondus, boucles trop courtes ou qui
/// se croisent, valeurs extrêmes, échelles invalides.
fn random_case(rng: &mut Rng) -> (Vec<Loop>, [f64; 2], Option<(Vec<f64>, Vec<f64>)>) {
    let scale = [1.0, 1e-6, 1e6, 3.0, 1e-3][rng.below(5)];
    let n = 2 + rng.below(12);
    let mut loops: Vec<Loop> = Vec::new();
    match rng.below(9) {
        // Polygone convexe régulier.
        0 => {
            let k = 3 + rng.below(10);
            loops.push((0..k).map(|i| [(i as f64 / k as f64 * std::f64::consts::TAU).cos() * scale, (i as f64 / k as f64 * std::f64::consts::TAU).sin() * scale]).collect());
        }
        // Rectangle dont les côtés portent beaucoup de points alignés, bruités.
        1 => {
            let m = 2 + rng.below(40);
            let noise = [0.0, 1e-17, 1e-15, 1e-12][rng.below(4)];
            let mut ring = Vec::new();
            for i in 0..m {
                ring.push([i as f64 / m as f64 * scale, rng.range(-noise, noise)]);
            }
            for i in 0..m {
                ring.push([scale + rng.range(-noise, noise), i as f64 / m as f64 * scale]);
            }
            for i in 0..m {
                ring.push([(1.0 - i as f64 / m as f64) * scale, scale + rng.range(-noise, noise)]);
            }
            for i in 0..m {
                ring.push([rng.range(-noise, noise), (1.0 - i as f64 / m as f64) * scale]);
            }
            loops.push(ring);
        }
        // Points quelconques : boucle qui se croise.
        2 => loops.push((0..n).map(|_| [rng.unit() * scale, rng.unit() * scale]).collect()),
        // Sommets sur une petite grille : doublons, côtés nuls, recoupements.
        3 => {
            let mut ring: Loop = (0..n).map(|_| [rng.below(4) as f64 * scale, rng.below(4) as f64 * scale]).collect();
            if rng.below(2) == 0 {
                ring.push(ring[0]);
            }
            loops.push(ring);
        }
        // Quasi-doublons.
        4 => {
            let mut ring: Loop = (0..n).map(|_| [rng.below(3) as f64 * scale, rng.below(3) as f64 * scale]).collect();
            for p in &mut ring {
                p[0] += rng.range(-1e-14, 1e-14) * scale;
                p[1] += rng.range(-1e-14, 1e-14) * scale;
            }
            loops.push(ring);
        }
        // Zéro à trois points.
        5 => {
            let k = rng.below(4);
            loops.push((0..k).map(|_| [rng.unit() * scale, rng.unit() * scale]).collect());
        }
        // Valeurs extrêmes ou non finies.
        6 => {
            let big = [1e300, 1e150, 1e60, 1e-60, 1e-150, 1e-300, f64::NAN, f64::INFINITY, 5e-324, 0.0][rng.below(10)];
            loops.push((0..n.max(3)).map(|_| [rng.unit() * big, rng.unit() * big]).collect());
        }
        // Deux boucles identiques ou imbriquées.
        7 => {
            let ring: Loop = (0..4).map(|i| [[0.0, 1.0, 1.0, 0.0][i] * scale, [0.0, 0.0, 1.0, 1.0][i] * scale]).collect();
            loops.push(ring.clone());
            if rng.below(2) == 0 {
                loops.push(ring);
            } else {
                loops.push(ring.iter().map(|p| [p[0] * 0.5 + 0.25 * scale, p[1] * 0.5 + 0.25 * scale]).collect());
            }
        }
        // Tous les points sur une droite (à un reste de calcul près).
        _ => loops.push((0..n.max(3)).map(|i| [i as f64 * scale, i as f64 * scale * [1.0, 1.0 + 1e-16, 2.0][rng.below(3)]]).collect()),
    }
    let metric = match rng.below(40) {
        0 => [0.0, 1.0],
        1 => [f64::NAN, 1.0],
        2 => [1.0, f64::INFINITY],
        3 => [-1.0, 1.0],
        4 => [1e-300, 1e300],
        _ => [1.0 + rng.unit(), 1.0 + rng.unit()],
    };
    let grid = (rng.below(3) == 0).then(|| {
        let us: Vec<f64> = (0..=rng.below(8)).map(|i| i as f64 * scale / 4.0).collect();
        let mut vs: Vec<f64> = (0..=rng.below(8)).map(|i| i as f64 * scale / 4.0).collect();
        if rng.below(4) == 0 {
            vs.push(f64::NAN);
        }
        (us, vs)
    });
    (loops, metric, grid)
}

#[test]
fn deux_cent_mille_boucles_au_hasard_ne_font_jamais_paniquer() {
    count_panics();
    let before = PANICS.load(Ordering::SeqCst);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let (mut triangulated, mut refused) = (0usize, 0usize);
    for _ in 0..200_000 {
        let (loops, metric, grid) = random_case(&mut rng);
        match region::triangulate(&loops, metric, grid.as_ref().map(|(us, vs)| (us.as_slice(), vs.as_slice()))) {
            Ok(mesh) => {
                triangulated += 1;
                // Un maillage rendu est cohérent : indices dans les points, triangles à trois sommets distincts.
                assert!(mesh.triangles.iter().all(|t| t.iter().all(|&c| (c as usize) < mesh.points.len()) && t[0] != t[1] && t[1] != t[2] && t[0] != t[2]));
                assert!(mesh.points.iter().flatten().all(|v| v.is_finite()));
            }
            Err(_) => refused += 1,
        }
    }
    assert!(triangulated > 20_000 && refused > 20_000, "tirage déséquilibré : {triangulated} triangulés, {refused} refusés");
    assert_eq!(PANICS.load(Ordering::SeqCst), before, "une panique a eu lieu");
}

/// Une grille de plusieurs centaines de milliers de points (700 × 700) passe par l'éclaircissement du semis sans panique,
/// avec tout au plus `MAX_INTERIOR_POINTS` points intérieurs ; une grille dont les abscisses sont hors de l'étendue des boucles
/// (aucun point à semer) ou toutes à ses bords n'en sème aucun.
#[test]
fn une_grille_enorme_est_eclaircie_sans_panique() {
    count_panics();
    let before = PANICS.load(Ordering::SeqCst);
    let knots: Vec<f64> = (0..=700).map(|k| f64::from(k) / 700.0).collect();
    let mesh = triangulate(&[square(1.0)], [1.0, 1.0], Some((&knots, &knots))).expect("triangulation");
    assert!(mesh.points.len() - 4 <= region::MAX_INTERIOR_POINTS, "points intérieurs : {}", mesh.points.len() - 4);
    assert!(mesh.points.len() - 4 > region::MAX_INTERIOR_POINTS / 4, "grille éclaircie à l'excès : {}", mesh.points.len() - 4);
    // Hors de l'étendue : rien à semer, le contour seul.
    let outside: Vec<f64> = (0..=700).map(|k| 2.0 + f64::from(k)).collect();
    let mesh = triangulate(&[square(1.0)], [1.0, 1.0], Some((&outside, &outside))).expect("triangulation");
    assert_eq!(mesh.points.len(), 4);
    // Aux bords seulement : de même.
    let edges = [0.0, 1.0];
    assert_eq!(triangulate(&[square(1.0)], [1.0, 1.0], Some((&edges, &edges))).expect("triangulation").points.len(), 4);
    assert_eq!(PANICS.load(Ordering::SeqCst), before, "une panique a eu lieu");
}
