//! Les fichiers de Revit 2015 à 2022 et les familles (.rfa), lus par leurs enregistrements natifs comme ceux de 2023 et
//! plus : formes enregistrées par Revit, couleurs de ses matériaux, paramètres et unités, sans l'export IFC de rvt-rs.
//!
//! - Parité : `SampleModel.rvt` (Revit 2017) et `DynamoSample_2023.rvt` sont le même modèle (mêmes identifiants
//!   d'élément et mêmes GlobalId IFC) enregistré par deux versions ; sur les 234 éléments qu'ils ont en commun, la
//!   forme, les couleurs et les fiches doivent se retrouver (aux modifications que le modèle a reçues entre-temps).
//! - Couverture : pour chaque fichier ancien, au moins autant d'éléments en « Forme Revit » que mesuré, aucune boîte en
//!   trop, pas d'export IFC, des triangles sous le budget.
//! - Les derniers éléments en boîte ou en forme partielle : coussins ETFE adaptatifs de Vignette-04 (instances à cibles
//!   interdites, 880 boîtes), chaises de `rac_advanced` et `mega_advanced` (60 boîtes chacun), murs de parapet (instance dont le
//!   symbole est « résolu dans la vue »), poignées de toiture (`GGTag`) et surfaces d'Hermite (`HermiteSurf` : panneaux de
//!   Vignette-04, bols de SampleModel, sculptures de `revit-curtainwall-byprofile_v21`) : chaque règle de dessin a son essai.
//! - Familles : ce qu'un document de famille dessine.
//!
//! À lancer avec `cargo test --release`. Les fichiers publics viennent de `npm run samples:revit` ; sans eux, les
//! essais qui en dépendent passent sans rien faire.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use revit::geometry::bounds::Bounds;
use revit::geometry::pack::to_frame;
use revit::geometry::{self, Geometry, classes, saved};
use revit::{Context, Options, Output, read};
use rvt::research::native_parameters::ObjectGraph;

fn sample(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(std::fs::read(path).expect("fichier d'essai illisible"))
}

fn build(bytes: Vec<u8>) -> (Option<u32>, Geometry, Context) {
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = revit::native::release(&mut file);
    let mut context = Context::new(release);
    let geometry = geometry::build(&mut file, &mut context).expect("géométrie");
    (release, geometry, context)
}

// ---------------------------------------------------------------------------------------------
// Couverture
// ---------------------------------------------------------------------------------------------

/// Ce qui a été mesuré sur un fichier ancien : éléments dessinés, tous en « Forme Revit » (complète : ni forme partielle, ni
/// boîte), et un plafond de triangles.
struct Floor {
    file: &'static str,
    year: u32,
    elements: usize,
    triangles: usize,
}

const FLOORS: [Floor; 12] = [
    Floor { file: "singleDirectShape.rvt", year: 2015, elements: 1, triangles: 5_000 },
    // Les 880 coussins ETFE (composants adaptatifs à cibles interdites) et les 54 panneaux de toiture à surfaces d'Hermite : 2,75 millions
    // de triangles à la flèche de 0,001 pied, 0,99 million à celle de 0,003 pied (`faces::tess::CHORD_ERROR`), 0,91 million depuis
    // qu'un axe de grille ne grossit plus sans abaisser l'écart (`ruled_knots`, `hermite_knots`), pour un budget de 3 millions
    // (`geometry::MAX_TRIANGLES`).
    Floor { file: "Vignette-04-BaseFile.rvt", year: 2016, elements: 953, triangles: 2_900_000 },
    Floor { file: "SampleModel.rvt", year: 2017, elements: 475, triangles: 1_100_000 },
    // 60 chaises à cibles interdites, 8 murs de parapet à symbole « résolu dans la vue » (leurs 8 balayages restent des éléments), 3 éléments
    // à `GGTag`.
    Floor { file: "rac_advanced_sample_project.rvt", year: 2019, elements: 5574, triangles: 2_200_000 },
    Floor { file: "mega_advanced_sample_file.rvt", year: 2020, elements: 5526, triangles: 1_750_000 },
    Floor { file: "ConnectorTestR20.rvt", year: 2020, elements: 3, triangles: 10_000 },
    Floor { file: "RoomsAndExits.rvt", year: 2021, elements: 12, triangles: 1_000 },
    // Les deux sculptures `DirectShape` à 84 faces d'Hermite chacune : 128 000 triangles chacune (environ 123 000 depuis que
    // `hermite_knots` fige l'axe dont le grossissement n'abaisse pas l'écart).
    Floor { file: "revit-curtainwall-byprofile_v21.rvt", year: 2021, elements: 123, triangles: 300_000 },
    Floor { file: "CeilingType.rvt", year: 2022, elements: 1, triangles: 100 },
    Floor { file: "revit-openings_v22.rvt", year: 2022, elements: 15, triangles: 10_000 },
    // Un modèle de projet de Revit 2018 n'a rien à dessiner.
    Floor { file: "RiR-Template-2018.rte", year: 2018, elements: 0, triangles: 0 },
    // Une famille de 2016 sans aucune forme (une masse vide) : rien à dessiner, mais une lecture sans erreur.
    Floor { file: "MassWithBoxAndCone.rfa", year: 2016, elements: 0, triangles: 0 },
];

#[test]
fn chaque_fichier_ancien_se_lit_par_ses_formes_enregistrees() {
    for floor in &FLOORS {
        let Some(bytes) = sample(floor.file) else { continue };
        let output = read(&bytes, &Options::default()).unwrap_or_else(|error| panic!("{} : {error:#}", floor.file));
        let report = &output.report;
        assert_eq!(report.release, Some(floor.year), "{}", floor.file);
        assert_eq!(report.elements, floor.elements, "{} : éléments dessinés", floor.file);
        // Tous en forme Revit entière : ni partielle, ni boîte englobante.
        let sources = report.sources;
        assert_eq!((sources.revit, sources.partial, sources.unknown), (floor.elements, 0, 0), "{} : {sources:?}", floor.file);
        // Aucune forme reconstruite : l'export IFC de rvt-rs n'est pas calculé.
        assert_eq!(sources.rebuilt, 0, "{} : {sources:?}", floor.file);
        assert!(report.stages.iter().all(|stage| !stage.name.contains("export IFC")), "{} : l'export IFC a servi : {:?}", floor.file, report.stages);
        assert!(!report.experimental, "{} : lecture expérimentale", floor.file);
        assert!(report.warnings.iter().all(|message| !message.contains("reconstruction") && !message.contains("n'ont pas pu être lues")), "{} : {:?}", floor.file, report.warnings);
        assert!(report.triangles <= floor.triangles, "{} : {} triangles", floor.file, report.triangles);
        assert!(report.triangles < geometry::MAX_TRIANGLES, "{} : budget de triangles", floor.file);
    }
}

/// Le plus lourd des fichiers d'essai, Vignette-04 (Revit 2016), faisait 19,6 millions de triangles : rvt-rs maille une
/// surface réglée à une maille par pied du plus long profil de sa composante connexe (27 000 triangles la face, grande ou
/// petite, plate ou gauche), et ce module à une maille par pied aussi. Les surfaces réglées se maillent désormais à la
/// flèche voulue (`faces::tess`), et les plans qui les touchent ne reçoivent plus leur grille. Mesuré : 2,75 millions à la
/// flèche de 0,001 pied, 988 664 à celle de 0,003 pied (`CHORD_ERROR`, un millimètre), 910 804 depuis qu'un axe de grille
/// ne grossit plus sans abaisser l'écart (`tess::ruled_knots`, `hermite_knots`) ; la borne basse garde qu'aucune surface
/// courbe ne s'est effondrée (un cylindre ou une surface réglée aplatis en quelques triangles ferait chuter le compte bien
/// sous 800 000), la haute que le budget reste loin.
#[test]
fn vignette_ne_fait_plus_dix_neuf_millions_de_triangles() {
    let Some(bytes) = sample("Vignette-04-BaseFile.rvt") else { return };
    let (_, geometry, context) = build(bytes);
    let triangles = geometry.indices.len() / 3;
    assert!(triangles > 800_000 && triangles < 2_900_000, "triangles : {triangles}");
    // Le plus dense des éléments : 1,17 million avant, moins de 100 000 maintenant.
    let mut per: BTreeMap<u32, usize> = BTreeMap::new();
    for row in geometry.primitives.chunks_exact(6) {
        *per.entry(row[0]).or_default() += row[4] as usize / 3;
    }
    let densest = per.values().copied().max().unwrap_or(0);
    assert!(densest < 100_000, "élément le plus dense : {densest} triangles");
    assert!(context.warnings.iter().all(|message| !message.contains("plafond") && !message.contains("dépasse")), "{:?}", context.warnings);
    assert_eq!(geometry.stats.too_dense + geometry.stats.trimmed, 0);
}

// ---------------------------------------------------------------------------------------------
// Les derniers éléments en boîte ou en forme partielle
// ---------------------------------------------------------------------------------------------

/// Boîte (minimum, maximum) du maillage de chaque élément dessiné, en mètres, repère absolu (Y vers le haut).
fn mesh_extents(geometry: &Geometry) -> BTreeMap<u64, ([f64; 3], [f64; 3])> {
    let mut extents: BTreeMap<u64, ([f64; 3], [f64; 3])> = BTreeMap::new();
    for row in geometry.primitives.chunks_exact(6) {
        let id = geometry.element_ids[row[0] as usize];
        for vertex in geometry.positions[row[1] as usize * 3..(row[1] + row[2]) as usize * 3].chunks_exact(3) {
            let point = [f64::from(vertex[0]) + geometry.origin[0], f64::from(vertex[1]) + geometry.origin[1], f64::from(vertex[2]) + geometry.origin[2]];
            let current = extents.entry(id).or_insert((point, point));
            for axis in 0..3 {
                current.0[axis] = current.0[axis].min(point[axis]);
                current.1[axis] = current.1[axis].max(point[axis]);
            }
        }
    }
    extents
}

/// Triangles de chaque élément dessiné.
fn mesh_triangles(geometry: &Geometry) -> BTreeMap<u64, usize> {
    let mut triangles: BTreeMap<u64, usize> = BTreeMap::new();
    for row in geometry.primitives.chunks_exact(6) {
        *triangles.entry(geometry.element_ids[row[0] as usize]).or_default() += row[4] as usize / 3;
    }
    triangles
}

/// La source (0 à 3) d'un élément dessiné, ou `None` s'il ne l'est pas.
fn source_of(geometry: &Geometry, id: u64) -> Option<u8> {
    geometry.element_ids.iter().position(|element| *element == id).map(|index| geometry.sources[index])
}

/// Une boîte de Revit (pieds, Z vers le haut) dans le repère de la scène (mètres, Y vers le haut).
fn in_scene(bounds: &Bounds) -> ([f64; 3], [f64; 3]) {
    let (a, b) = (to_frame(bounds.low), to_frame(bounds.high));
    (std::array::from_fn(|k| a[k].min(b[k])), std::array::from_fn(|k| a[k].max(b[k])))
}

/// Un identifiant Revit sérialisé : un entier ou `{m_id: {m_id64: n}}`.
fn identifier(value: &serde_json::Value) -> Option<u64> {
    value.as_u64().or_else(|| ["m_id", "m_id64"].iter().find_map(|key| value.get(*key)).and_then(identifier))
}

/// Ce que `work` lit dans le graphique de chaque élément dessiné d'un fichier (les éléments `wanted`).
fn read_graphs<T: Send>(bytes: &[u8], wanted: &dyn Fn(u64) -> bool, work: &(dyn Fn(&saved::Scene, u64, &ObjectGraph) -> T + Sync)) -> BTreeMap<u64, T> {
    let mut file = rvt::RevitFile::open_bytes(bytes.to_vec()).expect("fichier Revit");
    let selection = |scene: &saved::Scene, id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none() && wanted(id);
    let scan = saved::scan(&mut file, &selection, 1, work).expect("lecture des graphiques");
    scan.results.into_iter().filter_map(|(id, result)| result.map(|value| (id, value))).collect()
}

/// Les éléments dont le graphique contient une instance dont les cibles interdites valent `mask`.
fn with_forbidden_targets(bytes: &[u8], mask: u64) -> BTreeSet<u64> {
    let found = read_graphs(bytes, &|_| true, &|_, _, graph: &ObjectGraph| graph.objects.iter().any(|o| o.class_name == "GInstance" && o.fields["m_forbiddenTarget"]["m_targets"].as_u64() == Some(mask)));
    found.into_iter().filter(|(_, has)| *has).map(|(id, _)| id).collect()
}

/// La boîte que Revit a enregistrée pour chaque élément de `ids` (la boîte serrée, à défaut la boîte), dans la scène.
fn recorded_boxes(bytes: &[u8], ids: &BTreeSet<u64>) -> BTreeMap<u64, ([f64; 3], [f64; 3])> {
    let found = read_graphs(bytes, &|id| ids.contains(&id), &|_, _, graph: &ObjectGraph| Bounds::of_graph(graph));
    found.into_iter().filter_map(|(id, bounds)| bounds.map(|bounds| (id, in_scene(&bounds)))).collect()
}

/// Chaque triangle d'un élément regarde du côté de la normale de ses sommets (sens des triangles cohérent avec les normales).
fn winding_follows_normals(geometry: &Geometry, id: u64) {
    let index = geometry.element_ids.iter().position(|element| *element == id).expect("élément dessiné") as u32;
    let mut triangles = 0;
    for row in geometry.primitives.chunks_exact(6).filter(|row| row[0] == index) {
        let vertex = |corner: u32| {
            let at = (row[1] + corner) as usize * 3;
            [f64::from(geometry.positions[at]), f64::from(geometry.positions[at + 1]), f64::from(geometry.positions[at + 2])]
        };
        let normal = |corner: u32| {
            let at = (row[1] + corner) as usize * 3;
            [f64::from(geometry.normals[at]), f64::from(geometry.normals[at + 1]), f64::from(geometry.normals[at + 2])]
        };
        for triangle in geometry.indices[row[3] as usize..(row[3] + row[4]) as usize].chunks_exact(3) {
            let [a, b, c] = [vertex(triangle[0]), vertex(triangle[1]), vertex(triangle[2])];
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let geometric = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            for corner in triangle {
                let n = normal(*corner);
                assert!(geometric[0] * n[0] + geometric[1] * n[1] + geometric[2] * n[2] > 0.0, "élément {id} : triangle contraire à la normale de son sommet");
            }
            triangles += 1;
        }
    }
    assert!(triangles > 0, "élément {id} sans triangle");
}

/// Les 880 coussins ETFE de Vignette-04 : des composants adaptatifs. Le graphique de chaque instance n'est qu'une instance rigide
/// d'un symbole qui lui est propre (880 symboles, chacun avec sa face : une surface réglée entre deux droites, dont les extrémités
/// sont les points adaptatifs), et `m_forbiddenTarget` vaut 10 : ce n'est pas un doublon, c'est la forme de l'élément. La boîte
/// enregistrée de l'instance (`m_bBox`) est celle du symbole déplacé par la matrice de l'instance, pas celle de ses surfaces : le
/// maillage y tient (880 sur 880), et la boîte le dépasse de plus d'un mètre pour presque tous.
#[test]
fn les_coussins_etfe_adaptatifs_sont_la_forme_de_leur_symbole() {
    let Some(bytes) = sample("Vignette-04-BaseFile.rvt") else { return };
    let (_, geometry, _) = build(bytes.clone());
    let cushions = with_forbidden_targets(&bytes, 10);
    assert_eq!(cushions.len(), 880);
    let (extents, triangles) = (mesh_extents(&geometry), mesh_triangles(&geometry));
    let boxes = recorded_boxes(&bytes, &cushions);
    assert_eq!(boxes.len(), 880);

    // La boîte enregistrée d'une instance : le symbole (boîte `m_bBox` de son graphique) déplacé par la matrice de l'instance.
    let moved = read_graphs(&bytes, &|id| cushions.contains(&id), &|scene: &saved::Scene, _, graph: &ObjectGraph| {
        let object = graph.objects.iter().find(|o| o.class_name == "InstanceInfo").expect("informations d'instance");
        let symbol = scene.symbol(identifier(&object.fields["m_symbolId"]).expect("symbole")).expect("graphique du symbole");
        let corners = symbol.objects[0].fields["m_bBox"].as_array().expect("boîte du symbole").clone();
        let m = &object.fields["m_Trf"];
        let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for corner in 0..8 {
            let local: Vec<f64> = (0..3).map(|k| corners[(corner >> k) & 1][k].as_f64().expect("coin")).collect();
            for i in 0..3 {
                let value: f64 = (0..3).map(|j| m["m_3x3"][i][j].as_f64().expect("matrice") * local[j]).sum::<f64>() + m["m_or"][i].as_f64().expect("translation");
                low[i] = low[i].min(value);
                high[i] = high[i].max(value);
            }
        }
        Bounds::new(low, high).map(|bounds| in_scene(&bounds))
    });
    let (mut touching, mut inflated) = (0, 0);
    for id in &cushions {
        assert_eq!(source_of(&geometry, *id), Some(0), "coussin {id}");
        assert!(triangles[id] >= 2, "coussin {id} : {} triangles", triangles[id]);
        let (low, high) = extents[id];
        let (box_low, box_high) = boxes[id];
        // Le maillage tient dans la boîte enregistrée (à 1 cm près)...
        assert!((0..3).all(|k| low[k] >= box_low[k] - 0.01 && high[k] <= box_high[k] + 0.01), "coussin {id} : {low:?} {high:?} hors de {box_low:?} {box_high:?}");
        // ... qui est la boîte du symbole placé par l'instance (à 1 mm près), non celle des surfaces.
        let (symbol_low, symbol_high) = moved[id].expect("boîte du symbole placé");
        assert!((0..3).all(|k| (box_low[k] - symbol_low[k]).abs() < 1e-3 && (box_high[k] - symbol_high[k]).abs() < 1e-3), "coussin {id} : boîte enregistrée {box_low:?} {box_high:?}, symbole placé {symbol_low:?} {symbol_high:?}");
        // Le maillage touche la boîte sur un axe horizontal quand la diagonale du losange en est proche (645 coussins sur 880).
        touching += usize::from([0, 2].iter().any(|&k| (low[k] - box_low[k]).abs() < 0.01 && (high[k] - box_high[k]).abs() < 0.01));
        // Elle est plus grande que le maillage (le losange tourné y est inscrit) : preuve que ce n'est pas la boîte de la forme.
        inflated += usize::from((0..3).any(|k| box_high[k] - box_low[k] > high[k] - low[k] + 1.0));
    }
    eprintln!("coussins dont le maillage touche la boîte : {touching} ; dont la boîte dépasse le maillage de plus d'un mètre : {inflated}");
    assert!(touching > 500, "coussins dont le maillage touche la boîte enregistrée : {touching}");
    assert!(inflated > 800, "coussins dont la boîte enregistrée dépasse le maillage : {inflated}");
    // Une seule surface, ouverte : dessinée des deux côtés ; triangles dans le sens de leurs normales ; aucun doublon exact.
    for id in [719757, 719758, 719772] {
        winding_follows_normals(&geometry, id);
        let index = geometry.element_ids.iter().position(|element| *element == id).expect("coussin") as u32;
        for row in geometry.primitives.chunks_exact(6).filter(|row| row[0] == index) {
            assert_eq!(geometry.materials[row[5] as usize * 6 + 5], 1, "coussin {id} : face unique dessinée des deux côtés");
        }
    }
    assert_eq!(geometry.stats.identical, 0, "des éléments dessinent exactement les mêmes triangles");
}

/// Les 60 chaises M_Chair-Breuer de `rac_advanced` et de `mega_advanced` (cibles interdites 10) : leur symbole commun est leur forme.
/// La boîte serrée que Revit enregistre pour chaque chaise (`m_tightbBox`) est celle de ce maillage, à 5 mm près (le pire écart
/// observé est de 2,4 mm : la boîte est celle des courbes exactes, le maillage celle de ses cordes).
#[test]
fn les_chaises_a_cibles_interdites_sont_la_forme_de_leur_symbole() {
    for file in ["rac_advanced_sample_project.rvt", "mega_advanced_sample_file.rvt"] {
        let Some(bytes) = sample(file) else { continue };
        let (_, geometry, _) = build(bytes.clone());
        let chairs = with_forbidden_targets(&bytes, 10);
        assert_eq!(chairs.len(), 60, "{file}");
        let (extents, triangles) = (mesh_extents(&geometry), mesh_triangles(&geometry));
        let boxes = recorded_boxes(&bytes, &chairs);
        for id in &chairs {
            assert_eq!(source_of(&geometry, *id), Some(0), "{file} : chaise {id}");
            assert_eq!(triangles[id], triangles[&180296], "{file} : chaise {id} : même symbole, même nombre de triangles");
            let ((low, high), (box_low, box_high)) = (extents[id], boxes[id]);
            assert!((0..3).all(|k| (low[k] - box_low[k]).abs() < 0.005 && (high[k] - box_high[k]).abs() < 0.005), "{file} : chaise {id} : {low:?} {high:?} contre la boîte {box_low:?} {box_high:?}");
        }
        assert!(triangles[&180296] > 5_000 && triangles[&180296] < 8_000, "{file} : {} triangles", triangles[&180296]);
        winding_follows_normals(&geometry, 180296);
    }
}

/// Les 8 murs « Parapet Wall » de `rac_advanced` et de `mega_advanced` placent par une instance « résolue dans la vue » le balayage
/// (`WallSweep`) qui les couronne : un symbole d'un seul nœud `Geometry`, sans condition, qui est un élément à part entière. Il se
/// dessine par lui-même, comme avant (même source, mêmes triangles, empreintes exactes inchangées : 8 éléments par fichier), le mur ne
/// le redessine pas et se lit désormais en entier (il était « partiel »).
#[test]
fn les_murs_de_parapet_ne_redessinent_pas_leur_balayage() {
    // Les balayages (identifiant, triangles, empreinte exacte de leur forme finale) tels qu'ils étaient avant que les murs ne se lisent
    // en entier : ils ne doivent pas changer.
    const SWEEPS: [(u64, usize, u64); 8] = [
        (192754, 1020, 0x235ea892b72bd9ce),
        (192755, 3084, 0x9a1fe21ea61e9753),
        (192756, 4404, 0x170dce0809c35dcf),
        (192757, 5364, 0xaf290238a1aa48f4),
        (192758, 1020, 0x6011f968997c328d),
        (192759, 4024, 0xb84d7854ddb5407e),
        (192760, 2660, 0xef8750b0d1781af1),
        (192761, 1744, 0xe241bee15c29b308),
    ];
    // (mur, triangles de la seule forme du mur : 24, 22, 20, 22, 18 et 52 ; les deux autres murs n'ont pas de repère ici).
    const WALLS: [(u64, usize); 6] = [(167548, 24), (167733, 22), (167934, 20), (168058, 22), (168129, 18), (168323, 52)];
    for file in ["rac_advanced_sample_project.rvt", "mega_advanced_sample_file.rvt"] {
        let Some(bytes) = sample(file) else { continue };
        let mut opened = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
        let mut context = Context::new(revit::native::release(&mut opened));
        context.fingerprints = true;
        let geometry = geometry::build(&mut opened, &mut context).expect("géométrie");
        let triangles = mesh_triangles(&geometry);
        for (sweep, expected, fingerprint) in SWEEPS {
            assert_eq!(source_of(&geometry, sweep), Some(0), "{file} : balayage {sweep}");
            assert_eq!(triangles[&sweep], expected, "{file} : balayage {sweep}");
            assert_eq!(geometry.stats.shapes[&sweep], (0, fingerprint), "{file} : balayage {sweep} : forme modifiée");
        }
        for (wall, expected) in WALLS {
            assert_eq!(source_of(&geometry, wall), Some(0), "{file} : mur {wall}");
            assert_eq!(triangles[&wall], expected, "{file} : mur {wall} ne dessine que sa propre forme");
        }
        assert_eq!((geometry.counts.partial, geometry.counts.unknown), (0, 0), "{file}");
    }
}

/// Les poignées de sommets d'une toiture de face (140056 : `GGTag` qui portent des pastilles `GBitmap` et des points) et les flèches
/// de retournement des rives de dalle (217842 et 217846 : `GGTag` autour de `GBiFlipControl`) ne sont pas des surfaces : ces
/// éléments se lisent en entier.
#[test]
fn les_etiquettes_graphiques_ne_rendent_plus_une_forme_partielle() {
    for file in ["rac_advanced_sample_project.rvt", "mega_advanced_sample_file.rvt"] {
        let Some(bytes) = sample(file) else { continue };
        let (_, geometry, _) = build(bytes);
        for id in [140056, 217842, 217846] {
            assert_eq!(source_of(&geometry, id), Some(0), "{file} : {id}");
        }
        assert!(geometry.stats.incomplete.is_empty(), "{file} : {:?}", geometry.stats.incomplete.keys().collect::<Vec<_>>());
    }
}

/// Les surfaces d'Hermite (`HermiteSurf`) : les 54 panneaux de toiture de Vignette-04, les 4 bols de SampleModel (« Walvit Hung
/// Bowl », 8 faces), les deux sculptures `DirectShape` de `revit-curtainwall-byprofile_v21` (84 faces chacune) et la coque de
/// `ShellFamily.rfa`. Plus aucun n'est partiel ni en boîte, et chacun reste sous le plafond d'un élément.
#[test]
fn les_surfaces_d_hermite_se_dessinent() {
    let cases: [(&str, &[u64]); 4] = [
        ("SampleModel.rvt", &[499496, 935747, 937571, 938761]),
        ("revit-curtainwall-byprofile_v21.rvt", &[284570, 287881]),
        ("ShellFamily.rfa", &[33507]),
        ("Vignette-04-BaseFile.rvt", &[719756, 719795, 719850, 719905, 719960, 720070]),
    ];
    for (file, ids) in cases {
        let Some(bytes) = sample(file) else { continue };
        let (_, geometry, context) = build(bytes.clone());
        assert!(context.warnings.iter().all(|message| !message.contains("plus de 250000") && !message.contains("plafond")), "{file} : {:?}", context.warnings);
        let triangles = mesh_triangles(&geometry);
        for id in ids {
            assert_eq!(source_of(&geometry, *id), Some(0), "{file} : {id}");
            assert!(triangles[id] > 1_000 && triangles[id] < revit::geometry::saved::MAX_ELEMENT_TRIANGLES, "{file} : {id} : {} triangles", triangles[id]);
        }
        assert_eq!((geometry.counts.partial, geometry.counts.unknown), (0, 0), "{file}");
    }
    // Les deux sculptures sont les mêmes (même forme, même endroit) : deux éléments dessinés l'un sur l'autre, comme avant.
    if let Some(bytes) = sample("revit-curtainwall-byprofile_v21.rvt") {
        let (_, geometry, _) = build(bytes);
        let triangles = mesh_triangles(&geometry);
        assert_eq!(triangles[&284570], triangles[&287881]);
        assert!(triangles[&284570] > 100_000 && triangles[&284570] < 150_000, "{} triangles", triangles[&284570]);
        assert_eq!(geometry.stats.identical, 1);
    }
}

/// Aucun des fichiers qui portent les nouvelles formes n'atteint un plafond (250 000 triangles par élément, 3 millions par fichier,
/// 5 millions de triangles maillés) : ni forme refusée pour sa densité, ni élément ramené à sa boîte, ni avertissement de triangles.
#[test]
fn aucun_fichier_d_essai_n_atteint_les_plafonds_de_triangles() {
    for name in ["Vignette-04-BaseFile.rvt", "revit-curtainwall-byprofile_v21.rvt", "rac_advanced_sample_project.rvt"] {
        let Some(bytes) = sample(name) else { continue };
        let (_, geometry, context) = build(bytes);
        assert_eq!((geometry.stats.too_dense, geometry.stats.trimmed), (0, 0), "{name}");
        assert!(context.warnings.iter().all(|message| !message.contains("triangles")), "{name} : {:?}", context.warnings);
    }
}

// ---------------------------------------------------------------------------------------------
// Parité SampleModel (2017) / DynamoSample_2023
// ---------------------------------------------------------------------------------------------

/// Boîte (minimum, maximum) de chaque élément, en mètres, repère absolu.
fn extents(output: &Output) -> Vec<Option<([f64; 3], [f64; 3])>> {
    let mut extents: Vec<Option<([f64; 3], [f64; 3])>> = vec![None; output.keys.len()];
    for row in output.primitives.chunks_exact(6) {
        let element = row[0] as usize;
        for vertex in output.positions[row[1] as usize * 3..(row[1] + row[2]) as usize * 3].chunks_exact(3) {
            let point = [f64::from(vertex[0]) + output.origin[0], f64::from(vertex[1]) + output.origin[1], f64::from(vertex[2]) + output.origin[2]];
            let current = extents[element].get_or_insert((point, point));
            for axis in 0..3 {
                current.0[axis] = current.0[axis].min(point[axis]);
                current.1[axis] = current.1[axis].max(point[axis]);
            }
        }
    }
    extents
}

fn triangles_of(output: &Output) -> Vec<usize> {
    let mut triangles = vec![0; output.keys.len()];
    for row in output.primitives.chunks_exact(6) {
        triangles[row[0] as usize] += row[4] as usize / 3;
    }
    triangles
}

fn colours_of(output: &Output) -> Vec<BTreeSet<[u8; 4]>> {
    let mut colours = vec![BTreeSet::new(); output.keys.len()];
    for row in output.primitives.chunks_exact(6) {
        colours[row[0] as usize].insert(output.materials[row[5] as usize * 6..][..4].try_into().expect("quatre octets"));
    }
    colours
}

/// Le même modèle enregistré par Revit 2017 et par Revit 2023 : sur les éléments communs (mêmes GlobalId), mêmes sources
/// de forme, mêmes couleurs, presque mêmes triangles et mêmes fiches. Mesuré sur 234 éléments communs : source 234,
/// triangles 219, couleurs 234, boîte à 1 cm 186, libellés 234, fiches 226 (le groupe « Modèle analytique », qui n'existe
/// qu'à partir de Revit 2023, mis à part). Les écarts qui restent sont des modifications du modèle entre les deux
/// enregistrements (un mur de 9,2 m devenu 6 m, des jonctions, un niveau) : les mêmes que celles que la note de
/// recherche avait mesurées par l'export IFC, à deux triangles près.
#[test]
fn sample_model_2017_et_dynamo_sample_2023_sont_le_meme_modele() {
    let (Some(old_bytes), Some(new_bytes)) = (sample("SampleModel.rvt"), sample("DynamoSample_2023.rvt")) else { return };
    let old = read(&old_bytes, &Options::default()).expect("2017");
    let new = read(&new_bytes, &Options::default()).expect("2023");
    assert_eq!((old.report.release, new.report.release), (Some(2017), Some(2023)));

    let index: BTreeMap<&str, usize> = new.keys.iter().enumerate().map(|(i, key)| (key.as_str(), i)).collect();
    let (old_triangles, new_triangles) = (triangles_of(&old), triangles_of(&new));
    let (old_extents, new_extents) = (extents(&old), extents(&new));
    let (old_colours, new_colours) = (colours_of(&old), colours_of(&new));
    let old_meta: serde_json::Value = serde_json::from_str(&old.metadata).expect("métadonnées 2017");
    let new_meta: serde_json::Value = serde_json::from_str(&new.metadata).expect("métadonnées 2023");

    let (mut shared, mut same_source, mut same_triangles, mut same_colours, mut near_box, mut same_label, mut same_sheet) = (0, 0, 0, 0, 0, 0, 0);
    let mut sheet_differences: BTreeMap<String, usize> = BTreeMap::new();
    for (i, key) in old.keys.iter().enumerate() {
        let Some(&j) = index.get(key.as_str()) else { continue };
        shared += 1;
        same_source += usize::from(old.sources[i] == new.sources[j]);
        same_triangles += usize::from(old_triangles[i] == new_triangles[j]);
        same_colours += usize::from(old_colours[i] == new_colours[j]);
        if let (Some(a), Some(b)) = (old_extents[i], new_extents[j]) {
            near_box += usize::from((0..3).all(|axis| (a.0[axis] - b.0[axis]).abs() < 0.01 && (a.1[axis] - b.1[axis]).abs() < 0.01));
        }
        same_label += usize::from(old_meta["elements"][key]["label"] == new_meta["elements"][key]["label"]);
        let old_sheet = &old_meta["elements"][key]["properties"];
        let mut new_sheet = new_meta["elements"][key]["properties"].clone();
        if let Some(sheet) = new_sheet.as_object_mut() {
            sheet.remove("Modèle analytique");
        }
        if *old_sheet == new_sheet {
            same_sheet += 1;
        } else if let (Some(a), Some(b)) = (old_sheet.as_object(), new_sheet.as_object()) {
            for (name, value) in a {
                if b.get(name) != Some(value) {
                    *sheet_differences.entry(name.clone()).or_default() += 1;
                }
            }
        }
    }
    eprintln!("communs {shared} : source {same_source}, triangles {same_triangles}, couleurs {same_colours}, boîte {near_box}, libellés {same_label}, fiches {same_sheet} ; fiches différentes : {sheet_differences:?}");
    assert!(shared >= 230, "éléments communs : {shared}");
    assert_eq!(same_source, shared, "origines des formes");
    assert!(same_triangles >= 215, "mêmes triangles : {same_triangles} sur {shared}");
    assert!(same_colours >= 232, "mêmes couleurs : {same_colours} sur {shared}");
    assert!(near_box >= 180, "boîtes à 1 cm : {near_box} sur {shared}");
    assert_eq!(same_label, shared, "libellés");
    // Les fiches : y compris les paramètres de famille, que Revit 2017 enregistre avec le numéro de l'ancienne énumération
    // `UnitType` (« Casement Depth (type) 0.19685 » en pieds, sans unité) et Revit 2023 avec leur spec (« Casement Depth
    // (m) (type) 0.06 ») : `catalog::unit_types` les ramène au même résultat.
    assert!(same_sheet >= 220, "fiches identiques : {same_sheet} sur {shared} ; différences : {sheet_differences:?}");
    // Ce qui diffère n'est jamais une unité : aucune propriété n'a un suffixe d'unité d'un côté et pas de l'autre.
    let unit_only: Vec<&String> = sheet_differences.keys().filter(|name| name.contains(" (m)") || name.contains(" (m²)") || name.contains(" (°)")).collect();
    assert!(unit_only.is_empty(), "propriétés dont l'unité diffère : {unit_only:?}");
}

/// Les propriétés d'un paramètre de famille décimal d'un fichier de 2017 portent leur unité SI dans le nom.
#[test]
fn un_parametre_de_famille_de_2017_est_converti_en_si() {
    let Some(bytes) = sample("SampleModel.rvt") else { return };
    let output = read(&bytes, &Options::default()).expect("2017");
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("métadonnées");
    let mut with_unit = 0;
    let mut raw_feet = 0;
    for entry in metadata["elements"].as_object().expect("éléments").values() {
        for group in entry["properties"].as_object().expect("propriétés").values().filter_map(|value| value.as_object()) {
            for (name, value) in group {
                if value.is_number() && name.ends_with(" (m) (type)") {
                    with_unit += 1;
                }
                // Le nom de la maquette de 2023 : « Casement Depth (m) (type) 0.06 », en 2017 enregistré 0,19685 pied.
                if name == "Casement Depth (type)" {
                    raw_feet += 1;
                }
            }
        }
    }
    assert!(with_unit > 0, "aucun paramètre de type converti en mètres");
    assert_eq!(raw_feet, 0, "« Casement Depth (type) » est resté en pieds, sans unité");
}

// ---------------------------------------------------------------------------------------------
// Familles
// ---------------------------------------------------------------------------------------------

/// Les classes Revit des éléments dessinés (les noms de `Geometry::names` sont « Classe identifiant »).
fn drawn_classes(geometry: &Geometry) -> BTreeMap<String, usize> {
    let mut classes = BTreeMap::new();
    for name in &geometry.names {
        *classes.entry(name.split(' ').next().unwrap_or("").to_string()).or_default() += 1;
    }
    classes
}

/// Un document de famille dessine ses formes : ici quatre formes volumiques d'un panneau adaptatif (Revit 2027), que la
/// règle des projets écartait (leur catégorie est « Masses », masquée par défaut dans un projet).
#[test]
fn une_famille_de_2027_dessine_ses_formes() {
    let Some(bytes) = sample("AdaptivePanel.rfa") else { return };
    let (release, geometry, context) = build(bytes);
    assert_eq!(release, Some(2027));
    assert_eq!(drawn_classes(&geometry), BTreeMap::from([("FormElem".to_string(), 4)]));
    assert_eq!(geometry.counts.revit, 4);
    assert_eq!(geometry.indices.len() / 3, 84);
    assert!(context.warnings.iter().all(|message| !message.contains("masse")), "{:?}", context.warnings);
}

/// Une famille de 2020 : extrusions, fusions, balayages. Les repères, esquisses, vues, annotations et lignes ne se
/// dessinent pas, comme dans un projet.
#[test]
fn une_famille_de_2020_dessine_ses_extrusions_et_balayages() {
    let Some(bytes) = sample("FamilyDocumentTests.rfa") else { return };
    let (release, geometry, _) = build(bytes);
    assert_eq!(release, Some(2020));
    assert_eq!(drawn_classes(&geometry), BTreeMap::from([("BlendElem".to_string(), 4), ("ExtrusionElem".to_string(), 4), ("SweepElem".to_string(), 2)]));
    assert_eq!(geometry.counts.revit, 10);
    assert_eq!(geometry.indices.len() / 3, 328);
}

/// Une famille de 2016 : une forme volumique, une instance de famille imbriquée (une famille chargée dans la famille).
#[test]
fn une_famille_de_2016_dessine_ses_formes_et_ses_instances_imbriquees() {
    let Some(bytes) = sample("ShellFamily.rfa") else { return };
    let (release, geometry, _) = build(bytes);
    assert_eq!(release, Some(2016));
    let classes = drawn_classes(&geometry);
    assert_eq!(classes.get("FormElem"), Some(&2), "{classes:?}");
    assert_eq!(classes.get("FamilyInstance"), Some(&2), "{classes:?}");
    // Quatre formes Revit entières : la coque aux surfaces d'Hermite (33507) était une boîte.
    assert_eq!((geometry.counts.revit, geometry.counts.partial, geometry.counts.unknown), (4, 0, 0));
}

/// Une famille sans forme se lit sans erreur et ne dessine rien.
#[test]
fn une_famille_sans_forme_ne_dessine_rien() {
    let Some(bytes) = sample("MassWithBoxAndCone.rfa") else { return };
    let output = read(&bytes, &Options::default()).expect("lecture");
    assert_eq!((output.report.release, output.report.elements, output.report.triangles), (Some(2016), 0, 0));
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata).expect("métadonnées");
    assert_eq!(metadata["elements"].as_object().map(serde_json::Map::len), Some(0));
}
