//! Les coupes, les façades et les plans de plafond de Revit dans la section `views` du JSON de métadonnées (`"kind"` `"section"`,
//! `"elevation"`, `"ceiling"`), et les niveaux (`levels`) : voir `docs/contrat-metadonnees.md` et `docs/lecture-revit.md`.
//!
//! Le fichier committé (Revit 2023, `tests/fixtures`) sert toujours : il a un niveau, une façade et un plan de plafond. Les autres viennent de
//! `revit/samples/` (voir `npm run samples:revit`) et leurs essais passent sans rien faire quand ils manquent. `wadduwa.rvt` est un fichier
//! privé de l'utilisateur, jamais commité : ses essais passent aussi sans rien faire quand il est absent, et ne vérifient que des noms, des
//! comptes, ou l'accord de deux choses que le fichier dit chacune de son côté.
//!
//! À lancer avec `cargo test --release --test sections` : en débogage, le décodage est long.

use revit::{Options, Output, read};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/Revit_IFC5_Einhoven.rvt");

/// Un millimètre : la tolérance des altitudes comparées.
const MM: f64 = 1e-3;

fn sample(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if path.exists() {
        Some(path)
    } else {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        None
    }
}

struct Read {
    output: Output,
    metadata: Value,
}

fn open(path: &PathBuf) -> Read {
    let output = read(&std::fs::read(path).expect("fichier d'essai"), &Options::default()).expect("lecture");
    let metadata = serde_json::from_str(&output.metadata).expect("JSON de métadonnées");
    Read { output, metadata }
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or_else(|| panic!("{value} n'est pas un nombre"))
}

fn vec3(value: &Value) -> [f64; 3] {
    let array = value.as_array().expect("vecteur");
    assert_eq!(array.len(), 3, "{value}");
    [number(&array[0]), number(&array[1]), number(&array[2])]
}

impl Read {
    fn views(&self) -> &[Value] {
        self.metadata["views"].as_array().map_or(&[], Vec::as_slice)
    }

    fn of_kind(&self, kind: &str) -> Vec<&Value> {
        self.views().iter().filter(|view| view["kind"] == kind).collect()
    }

    fn names_of_kind(&self, kind: &str) -> Vec<&str> {
        self.of_kind(kind).iter().map(|view| view["name"].as_str().expect("nom")).collect()
    }

    fn find(&self, kind: &str, name: &str) -> &Value {
        let found: Vec<&Value> = self.views().iter().filter(|view| view["kind"] == kind && view["name"] == name).collect();
        assert_eq!(found.len(), 1, "{kind} « {name} »");
        found[0]
    }

    /// Les niveaux : (nom, altitude en mètres), dans l'ordre du JSON.
    fn levels(&self) -> Vec<(String, f64)> {
        self.metadata["levels"].as_array().into_iter().flatten().map(|level| (level["name"].as_str().expect("nom").to_string(), number(&level["elevation"]))).collect()
    }

    fn level(&self, name: &str) -> f64 {
        self.levels().into_iter().find(|(level, _)| level == name).unwrap_or_else(|| panic!("niveau « {name} »")).1
    }

    fn properties(&self, index: usize) -> &Value {
        &self.metadata["elements"][&self.output.keys[index]]["properties"]
    }

    /// La boîte (repère du viewer : mètres, Y vers le haut, coordonnées du projet) des éléments `wanted`.
    fn bounds(&self, wanted: impl Fn(usize) -> bool) -> Option<([f64; 3], [f64; 3])> {
        let (mut min, mut max) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for primitive in self.output.primitives.chunks_exact(6) {
            if !wanted(primitive[0] as usize) {
                continue;
            }
            for vertex in primitive[1]..primitive[1] + primitive[2] {
                for axis in 0..3 {
                    let x = f64::from(self.output.positions[vertex as usize * 3 + axis]) + self.output.origin[axis];
                    min[axis] = min[axis].min(x);
                    max[axis] = max[axis].max(x);
                }
            }
        }
        min[0].is_finite().then_some((min, max))
    }

    fn bounds_of(&self, category: &str) -> ([f64; 3], [f64; 3]) {
        self.bounds(|index| self.properties(index)["Catégorie"] == category).unwrap_or_else(|| panic!("aucun élément « {category} »"))
    }
}

/// Les huit coins d'une boîte (min, max) du viewer.
fn corners((min, max): ([f64; 3], [f64; 3])) -> Vec<[f64; 3]> {
    (0..8).map(|i| [if i & 1 == 0 { min[0] } else { max[0] }, if i & 2 == 0 { min[1] } else { max[1] }, if i & 4 == 0 { min[2] } else { max[2] }]).collect()
}

/// Un point du viewer est-il dans la boîte de coupe d'une vue (`sectionBox`, tournée de `rotation` degrés autour de la verticale, dans le sens
/// anti-horaire vu d'en haut, autour de son centre), à 1 cm près ? On ramène le point dans le repère de la boîte par la rotation inverse.
fn inside(view: &Value, p: [f64; 3]) -> bool {
    let boxed = &view["sectionBox"];
    let (min, max) = (vec3(&boxed["min"]), vec3(&boxed["max"]));
    let rotation = boxed.get("rotation").map_or(0.0, number).to_radians();
    let centre = [(min[0] + max[0]) / 2.0, (min[2] + max[2]) / 2.0];
    let (dx, dz) = (p[0] - centre[0], p[2] - centre[1]);
    // Anti-horaire vu d'en haut, Y vers le haut et Z vers le spectateur : la rotation inverse.
    let (s, c) = (rotation.sin(), rotation.cos());
    let q = [centre[0] + c * dx - s * dz, p[1], centre[1] + s * dx + c * dz];
    (0..3).all(|axis| q[axis] >= min[axis] - 0.01 && q[axis] <= max[axis] + 0.01)
}

/// Ce que toute coupe, façade ou plan de plafond écrit doit tenir, et l'ordre des sortes de vues.
fn check_views(read: &Read, file: &str) {
    for view in read.of_kind("section").into_iter().chain(read.of_kind("elevation")) {
        let name = view["name"].as_str().expect("nom");
        let camera = &view["camera"];
        assert_eq!(camera["projection"], "orthographic", "{file} / {name}");
        // Un regard horizontal, un haut vertical, pas de plage.
        let direction = vec3(&camera["direction"]);
        assert!(direction[1].abs() < 1e-9 && (direction[0].hypot(direction[2]) - 1.0).abs() < 1e-6, "{file} / {name} : {direction:?}");
        assert_eq!(vec3(&camera["up"]), [0.0, 1.0, 0.0], "{file} / {name}");
        assert!(view.get("range").is_none(), "{file} / {name}");
        // La caméra est sur la face proche de la boîte, le plan de coupe : un pas de 5 cm en avant est dedans, un pas en arrière dehors (quand
        // la vue est recadrée : sinon la caméra est sur le plan de coupe, mais pas forcément au centre des côtés).
        let position = vec3(&camera["position"]);
        let step = |k: f64| [position[0] + direction[0] * k, position[1], position[2] + direction[2] * k];
        assert!(inside(view, step(0.05)), "{file} / {name} : rien devant la caméra");
        if camera.get("size").is_some() {
            assert!(!inside(view, step(-0.05)), "{file} / {name} : la face proche de la boîte n'est pas le plan de coupe");
        }
    }
    for view in read.of_kind("ceiling") {
        let name = view["name"].as_str().expect("nom");
        let range = &view["range"];
        let bottom = number(&range["bottom"]);
        assert!(range.get("top").is_none_or(|top| number(top) > bottom), "{file} / {name} : {range}");
        assert_eq!(vec3(&view["camera"]["direction"]), [0.0, -1.0, 0.0], "{file} / {name}");
    }
    // Les vues 3D d'abord, puis les plans, les plans de plafond, les façades et les coupes.
    let order = |view: &Value| ["3d", "plan", "ceiling", "elevation", "section"].iter().position(|kind| view.get("kind").map_or("3d", |k| k.as_str().expect("sorte")) == *kind).expect("sorte connue");
    let kinds: Vec<usize> = read.views().iter().map(order).collect();
    assert!(kinds.windows(2).all(|pair| pair[0] <= pair[1]), "{file} : ordre des sortes {kinds:?}");
}

// ------------------------------------------------------------------------------------------------ fichier committé

#[test]
fn le_fichier_committe_a_un_niveau_un_plan_de_plafond_et_une_facade_dont_le_cadre_englobe_le_modele() {
    let read = open(&PathBuf::from(FIXTURE));
    assert_eq!(read.levels(), vec![("Level 1".to_string(), 0.0)]);
    let kinds: Vec<(&str, &str)> = read.views().iter().map(|view| (view.get("kind").map_or("3d", |kind| kind.as_str().expect("sorte")), view["name"].as_str().expect("nom"))).collect();
    assert_eq!(kinds, vec![("3d", "{3D}"), ("plan", "Level 1"), ("plan", "Level 1"), ("ceiling", "Level 1"), ("elevation", "Elevation 1 - a")]);
    check_views(&read, "Revit_IFC5_Einhoven");
    // Le plan de plafond : coupe à 7,546 pieds (2,3 m) au-dessus de « Level 1 » ; pas de niveau au-dessus, pas de haut.
    let ceiling = read.find("ceiling", "Level 1");
    assert!((number(&ceiling["range"]["bottom"]) - 2.3).abs() < MM && ceiling["range"].get("top").is_none(), "{}", ceiling["range"]);
    assert_eq!(ceiling["type"], "Ceiling Plan");
    // La façade regarde vers le nord du projet (−Z du viewer). Son cadre et sa boîte (sans découpe lointaine, voir `camera::section_camera`)
    // englobent tout le modèle, ce que fait une façade posée pour le montrer : chaque coin de la boîte de chaque catégorie y est.
    let elevation = read.find("elevation", "Elevation 1 - a");
    assert_eq!(vec3(&elevation["camera"]["direction"]), [0.0, 0.0, -1.0]);
    assert!(elevation["camera"].get("size").is_some());
    let categories: BTreeSet<&str> = read.metadata["elements"].as_object().expect("éléments").values().filter_map(|element| element["properties"]["Catégorie"].as_str()).collect();
    assert!(!categories.is_empty());
    for category in categories {
        assert!(corners(read.bounds_of(category)).into_iter().all(|corner| inside(elevation, corner)), "{category} hors du cadre de la façade");
    }
}

// ------------------------------------------------------------------------------------------------ niveaux

/// Les niveaux s'accordent avec ce que le fichier dit ailleurs de leurs altitudes : la profondeur de vue des plans d'étage de même nom qui la mettent
/// au niveau (type « Floor Plan »), et le pied des murs dont la contrainte inférieure est ce niveau (altitude + décalage inférieur), au millimètre.
/// Rend (plans vérifiés, murs vérifiés).
fn check_levels(read: &Read, file: &str) -> (usize, usize) {
    let levels = read.levels();
    assert!(!levels.is_empty(), "{file} : aucun niveau");
    assert!(levels.windows(2).all(|pair| pair[0].1 < pair[1].1), "{file} : niveaux non triés ou doublons d'altitude {levels:?}");
    let names: BTreeSet<&str> = levels.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names.len(), levels.len(), "{file} : doublons de nom");
    let mut plans = 0;
    for plan in read.of_kind("plan").into_iter().filter(|plan| plan["type"] == "Floor Plan") {
        let (Some(bottom), Some((_, elevation))) = (plan["range"].get("bottom").map(number), levels.iter().find(|(name, _)| plan["name"] == name.as_str())) else { continue };
        // Une profondeur au niveau même (la plus courante) ; une autre est sur un autre niveau ou décalée, et ne dit rien.
        if (bottom - elevation).abs() < 0.05 {
            assert!((bottom - elevation).abs() < MM, "{file} / {} : profondeur {bottom}, niveau {elevation}", plan["name"]);
            plans += 1;
        }
    }
    let (mut walls, mut off) = (0, Vec::new());
    for index in 0..read.output.keys.len() {
        let properties = read.properties(index);
        let constraints = &properties["Contraintes"];
        let (Some(level), Some(offset)) = (constraints["Contrainte inférieure"].as_str(), constraints["Décalage inférieur (m)"].as_f64()) else { continue };
        if properties["Catégorie"] != "Murs" || properties["Source de la géométrie"] != "Forme Revit" {
            continue;
        }
        let Some((_, elevation)) = levels.iter().find(|(name, _)| name == level) else { continue };
        let Some((min, _)) = read.bounds(|i| i == index) else { continue };
        if (min[1] - (elevation + offset)).abs() < MM {
            walls += 1;
        } else {
            off.push((properties["Identifiant Revit"].clone(), ((min[1] - (elevation + offset)) * 1000.0).round() / 1000.0));
        }
    }
    // Un mur peut être attaché par son pied à un sol ou à une toiture, ou porter un profilé qui descend plus bas : son pied n'est plus alors à son
    // décalage. Ce sont des exceptions.
    assert!(off.len() * 10 <= walls, "{file} : {walls} murs au pied attendu, {} non : {off:?}", off.len());
    eprintln!("{file} : {} niveaux, {plans} plans et {walls} murs (sur {}) au millimètre", levels.len(), walls + off.len());
    (plans, walls)
}

#[test]
fn les_niveaux_des_dynamo_sample_sont_ceux_de_leurs_plans_et_du_pied_de_leurs_murs() {
    let expected = [("Foundation", -0.8), ("Level 1 Living Rm.", -0.55), ("Level 1", 0.0), ("Ceiling", 2.7), ("Level 2", 3.0), ("Roof Line", 6.0)];
    for file in ["DynamoSample_2014.rvt", "DynamoSample_2023.rvt", "DynamoSample_2025.rvt"] {
        let Some(path) = sample(file) else { continue };
        let read = open(&path);
        let levels = read.levels();
        assert_eq!(levels.len(), expected.len(), "{file} : {levels:?}");
        for ((name, elevation), (expected_name, expected_elevation)) in levels.iter().zip(expected) {
            assert_eq!(name, expected_name, "{file}");
            assert!((elevation - expected_elevation).abs() < MM, "{file} / {name} : {elevation}");
        }
        // « Level 2 » : le plan de même nom a sa profondeur au niveau (3,0 m) ; « Level 1 » n'a pas de profondeur (rien en dessous).
        let (plans, walls) = check_levels(&read, file);
        assert!(plans >= 1 && walls > 10, "{file} : {plans} plans, {walls} murs");
    }
}

#[test]
fn les_niveaux_des_autres_fichiers_s_accordent_avec_leurs_plans_et_leurs_murs() {
    let mut checked = 0;
    for file in ["2024_Core_Interior.rvt", "rac_advanced_sample_project.rvt", "RE1-Architecture.rvt", "Vignette-04-BaseFile.rvt", "revit-curtainwall-byprofile_v21.rvt", "drone-hangar-building-2014.rvt", "SampleModel.rvt"] {
        let Some(path) = sample(file) else { continue };
        check_levels(&open(&path), file);
        checked += 1;
    }
    eprintln!("{checked} fichiers");
    // Les copies de niveaux des définitions de groupes ne sont pas des niveaux : Core Interior en a 59, pour 15 niveaux.
    if let Some(path) = sample("2024_Core_Interior.rvt") {
        assert_eq!(open(&path).levels().len(), 15);
    }
}

#[test]
fn wadduwa_a_ses_six_niveaux_ses_cinq_plans_de_plafond_et_ses_quatre_facades() {
    let Some(path) = sample("wadduwa.rvt") else { return };
    let read = open(&path);
    // Six niveaux du projet, du plus bas au plus haut ; les quatre copies de « RF » des définitions de groupes ne comptent pas.
    let names: Vec<String> = read.levels().into_iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["F.G.L", "GF", "1F", "2F", "RF", "URF"]);
    let (plans, walls) = check_levels(&read, "wadduwa");
    assert!(plans >= 1 && walls > 0, "{plans} plans, {walls} murs");
    // Les plans de plafond : coupe au-dessus de leur niveau, haut (s'il y en a un) au-dessus de la coupe (`check_views`). Le fichier en a cinq ;
    // ceux de « F.G.L » et de « 2F » ont leur haut réglé sur un niveau plus bas que leur coupe, et Revit a enregistré pour haut la coupe elle-même
    // (`m_topClipElev`) : ils ne montrent rien et ne sont pas écrits (voir docs/lecture-revit.md).
    assert_eq!(read.names_of_kind("ceiling"), ["GF", "1F", "RF"]);
    for ceiling in read.of_kind("ceiling") {
        let name = ceiling["name"].as_str().expect("nom");
        assert!(number(&ceiling["range"]["bottom"]) > read.level(name), "{name}");
    }
    // Le plafond de « GF » monte jusqu'au niveau « 2F » : le haut que Revit a enregistré et celui de sa plage s'accordent.
    assert!((number(&read.find("ceiling", "GF")["range"]["top"]) - read.level("2F")).abs() < MM);
    // Les façades nommées regardent vers leur point cardinal ; il n'y a pas de coupe.
    let mut elevations = read.names_of_kind("elevation");
    elevations.sort_unstable();
    assert_eq!(elevations, ["East", "North", "South", "West"]);
    assert_eq!(check_cardinal(&read, "wadduwa"), 4);
    assert!(read.of_kind("section").is_empty());
    check_views(&read, "wadduwa");
}

// ------------------------------------------------------------------------------------------------ façades et coupes

/// Les façades nommées « North », « South », « East » ou « West » regardent vers le sud, le nord, l'ouest et l'est du projet : le nord du projet
/// (+Y de Revit) est −Z du viewer. Rend leur nombre.
fn check_cardinal(read: &Read, file: &str) -> usize {
    let mut checked = 0;
    for elevation in read.of_kind("elevation") {
        let expected = match elevation["name"].as_str().expect("nom") {
            "North" => [0.0, 0.0, 1.0],
            "South" => [0.0, 0.0, -1.0],
            "East" => [-1.0, 0.0, 0.0],
            "West" => [1.0, 0.0, 0.0],
            _ => continue,
        };
        let direction = vec3(&elevation["camera"]["direction"]);
        assert!(direction.iter().zip(expected).all(|(found, wanted)| (found - wanted).abs() < 1e-9), "{file} / {} : {direction:?}", elevation["name"]);
        checked += 1;
    }
    checked
}

#[test]
fn les_facades_nommees_regardent_vers_leur_point_cardinal() {
    let mut checked = 0;
    for file in ["DynamoSample_2014.rvt", "DynamoSample_2023.rvt", "SampleModel.rvt", "rac_advanced_sample_project.rvt", "mega_advanced_sample_file.rvt", "CeilingType.rvt", "RoomsAndExits.rvt", "drone-hangar-building-2014.rvt"] {
        let Some(path) = sample(file) else { continue };
        let read = open(&path);
        checked += check_cardinal(&read, file);
        check_views(&read, file);
    }
    eprintln!("{checked} façades nommées");
}

#[test]
fn les_facades_de_rac_englobent_tous_ses_murs_et_ses_copies_de_groupe_ne_sont_pas_ecrites() {
    let Some(path) = sample("rac_advanced_sample_project.rvt") else { return };
    let read = open(&path);
    check_views(&read, "rac_advanced_sample_project");
    // Les quatre façades du projet : leur cadre et leur plan de coupe enferment tous les murs (le cadre que Revit pose autour du bâtiment).
    let walls = read.bounds_of("Murs");
    for name in ["North", "South", "East", "West"] {
        let elevation = read.find("elevation", name);
        assert!(corners(walls).into_iter().all(|corner| inside(elevation, corner)), "{name}");
    }
    // Comptes figés. Façades : les quatre et « Courtyard Elevation - South Wing ». Coupes : la coupe à décrochement « Section Through Main Stair »
    // (son cadre couvre ses deux tronçons) n'est pas écrite ; ses détails pris sur un seul tronçon le sont ; les copies des définitions de groupes
    // (`m_unplacedOwnerId`) ne le sont pas.
    assert_eq!(read.of_kind("elevation").len(), 5);
    assert_eq!(read.names_of_kind("section"), ["Detail At Grade", "Detail At Parapet", "Typical Wall Section"]);
    assert_eq!(read.names_of_kind("ceiling"), ["01 - Entry Level", "02 - Floor", "03 - Floor", "Roof"]);
    assert_eq!(read.find("section", "Typical Wall Section")["type"], "Wall Section");
}

#[test]
fn dynamo_sample_2014_et_2023_ont_les_memes_coupes_facades_et_plans_de_plafond() {
    let (Some(old), Some(new)) = (sample("DynamoSample_2014.rvt"), sample("DynamoSample_2023.rvt")) else { return };
    let (old, new) = (open(&old), open(&new));
    for kind in ["section", "elevation", "ceiling"] {
        assert_eq!(old.of_kind(kind), new.of_kind(kind), "{kind}");
    }
    // « Building Section » est une coupe à décrochement : pas écrite.
    assert_eq!(new.names_of_kind("section"), ["Stair Section", "Typ. Wall Section", "Typical Floor Wall Connection", "Typical Foundation Detail"]);
    check_views(&new, "DynamoSample_2023");
}

#[test]
fn les_coupes_des_autres_fichiers_ont_une_camera_et_une_boite_valides() {
    let mut checked = 0;
    for file in ["2024_Core_Interior.rvt", "RE1-Electrical.rvt", "RefineryPrimer-2024-BuildingGenerator.rvt", "Vignette-04-BaseFile.rvt", "revit-openings_v22.rvt", "mega_advanced_sample_file.rvt", "Project1-Central.rvt", "revit-curtainwall-byprofile_v21.rvt"] {
        let Some(path) = sample(file) else { continue };
        check_views(&open(&path), file);
        checked += 1;
    }
    eprintln!("{checked} fichiers");
}
