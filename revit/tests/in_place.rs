//! Le contenu des familles sur place est dessiné par leur instance, non à l'endroit où la famille a été créée.
//!
//! Une famille créée dans l'éditeur de modèle sur place (`Family.m_inPlace` vrai) écrit ses formes parmi les éléments du projet, dans le repère du
//! projet ; son instance les dessine à son tour, là où elle est aujourd'hui. La lecture dessinait les deux : deux fois au même endroit quand l'instance
//! n'avait pas bougé, une forme en fantôme à l'endroit d'origine quand l'instance avait été déplacée (une copie de la famille), des formes empilées
//! (`drone-hangar-building-2014`), ou à 555 m (`dynamo-nyc-site-2013`). Une forme dont une instance de sa famille est dessinée, avec au moins autant
//! de triangles que tout le contenu de la famille, n'est pas dessinée ; sinon elle l'est, et un avertissement la compte (`geometry::Rules`).
//!
//! À lancer avec `cargo test --release`. Les fichiers publics viennent de `npm run samples:revit` ; sans eux, les essais qui en dépendent passent
//! sans rien faire.

use std::collections::BTreeSet;
use std::path::PathBuf;

use revit::geometry::{self, Geometry, classes};
use revit::Context;

fn sample(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(std::fs::read(path).expect("fichier d'essai"))
}

fn lire(name: &str) -> Option<(Geometry, Vec<String>)> {
    let bytes = sample(name)?;
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = revit::native::format_year(&mut file).map(|(year, _)| year);
    let mut context = Context::new(release);
    let geometry = geometry::build(&mut file, &mut context).unwrap_or_else(|error| panic!("{name} : {error:#}"));
    Some((geometry, context.warnings))
}

/// Pour chaque fichier : le nombre de formes écartées (leur instance les dessine), celui des formes de masses masquées (l'instance de la famille est une masse
/// que Revit masque par défaut, le contenu l'est aussi), celui des formes gardées (aucune instance dessinée avec tout le contenu, ni masse : dessinées avec un
/// avertissement). Mesuré par `cargo run --release --example inplace -- <fichier>`.
///
/// - `wadduwa.rvt` (fichier privé, absent du dépôt) : les trois cadres de fenêtre.
/// - `SampleModel` : les armoires 506161 et 523524, le caisson de hotte 697449. Les quatre murs de « water » ne sont pas des formes.
/// - `drone-hangar-building-2014` : les 14 extrusions des douze familles « Generic Models ».
/// - `dynamo-nyc-site-2013` : l'import `SiteModel.dwg` (230266) de la famille « Site 1 ».
/// - `rac_advanced_sample_project` et `mega_advanced_sample_file` : la poutre courbe 201286 est écartée ; « Main Building » (139682) et « Pavillion » (139763)
///   sont des formes de masse, dont les instances sont des masses que Revit masque par défaut : écartées avec elles.
/// - `Vignette-04-BaseFile` : l'import SAT 308836 de la famille « Mass 1 », dont l'instance est une masse.
///
/// Aucun fichier d'essai n'a de forme gardée : ce cas (instance masquée pour une autre raison, illisible, absente) n'est essayé que par les essais unitaires
/// de `geometry` ; la colonne le dit.
const FICHIERS: &[(&str, usize, usize, usize)] = &[
    ("wadduwa.rvt", 3, 0, 0),
    ("SampleModel.rvt", 3, 0, 0),
    ("clockwork-roof-floor-stuff-2014.rvt", 1, 0, 0),
    ("clockwork-wall-stuff-2014.rvt", 1, 0, 0),
    ("drone-hangar-building-2014.rvt", 14, 0, 0),
    ("dynamo-nyc-site-2013.rvt", 1, 0, 0),
    ("rac_advanced_sample_project.rvt", 1, 2, 0),
    ("mega_advanced_sample_file.rvt", 1, 2, 0),
    ("Vignette-04-BaseFile.rvt", 0, 1, 0),
    ("DynamoSample_2014.rvt", 0, 0, 0),
    ("DynamoSample_2023.rvt", 0, 0, 0),
    ("DynamoSample_2024.rvt", 0, 0, 0),
    ("DynamoSample_2025.rvt", 0, 0, 0),
    ("dynamo-solar-radiation-vasari2012.rvt", 0, 0, 0),
];

#[test]
fn chaque_forme_ecartee_a_une_instance_dessinee_qui_porte_son_contenu() {
    for (name, excluded, masses, kept) in FICHIERS {
        let Some((geometry, warnings)) = lire(name) else { continue };
        let drawn: BTreeSet<u64> = geometry.element_ids.iter().copied().collect();
        let (mut count_excluded, mut count_masses, mut count_kept) = (0, 0, 0);
        for family in &geometry.stats.in_place {
            let triangles: usize = family.content.iter().map(|content| content.triangles).sum();
            if family.excluded {
                // Les formes ne sont pas dessinées, une instance l'est par sa forme enregistrée, avec au moins autant de triangles que tout le contenu.
                assert!(family.content.iter().all(|content| !drawn.contains(&content.id)), "{name} : famille {} : une forme écartée est dessinée", family.family);
                assert!(family.instances.iter().any(|instance| instance.source <= 1 && instance.triangles >= triangles && drawn.contains(&instance.id)), "{name} : famille {} : aucune instance dessinée ne porte les {triangles} triangles de son contenu", family.family);
                count_excluded += family.content.len();
            } else if family.mass {
                // L'instance de la famille est une masse, que Revit masque par défaut : ni elle ni son contenu ne sont dessinés.
                assert!(family.content.iter().all(|content| !drawn.contains(&content.id)), "{name} : famille {} : une forme de masse masquée est dessinée", family.family);
                assert!(family.instances.is_empty(), "{name} : famille {} : une instance de masse est dessinée", family.family);
                count_masses += family.content.len();
            } else {
                // Jamais perdu : toutes les formes gardées sont dessinées.
                assert!(family.content.iter().all(|content| drawn.contains(&content.id)), "{name} : famille {} : une forme gardée n'est pas dessinée", family.family);
                count_kept += family.content.len();
            }
        }
        assert_eq!((count_excluded, count_masses, count_kept), (*excluded, *masses, *kept), "{name} : formes écartées, de masses masquées et gardées");
        assert_eq!(geometry.stats.rules.get(classes::RELATION_REASONS[8]).copied().unwrap_or(0), *excluded, "{name} : la raison est comptée dans le recensement");
        // Les formes de masses masquées sont comptées par la règle des masses (et son avertissement), non par un avertissement qui leur serait propre.
        assert!(geometry.stats.masses_hidden >= *masses, "{name} : {} masses masquées comptées", geometry.stats.masses_hidden);
        // L'avertissement du contenu de famille sur place compte les formes gardées, et seulement elles.
        let warned: Vec<&String> = warnings.iter().filter(|warning| warning.contains("du contenu") && warning.contains("sur place")).collect();
        assert_eq!(warned.len(), usize::from(*kept > 0), "{name} : {warned:?}");
        if *kept > 0 {
            assert!(warned[0].starts_with(&format!("{kept} élément")), "{name} : {}", warned[0]);
        }
        if *masses > 0 {
            assert!(warnings.iter().any(|warning| warning.contains("masse") && warning.contains("Revit masque les masses par défaut")), "{name} : l'avertissement des masses manque : {warnings:?}");
        }
    }
}

/// Une forme que sa famille a écrite à la même place que celles de ses copies (`drone-hangar-building-2014` : quatre extrusions de familles
/// « Generic Models » au même point, trois autres à un autre point) s'empilait ; leurs instances sont à des endroits différents et dessinent chacune la leur.
#[test]
fn les_formes_empilees_du_hangar_sont_dessinees_une_fois_par_leur_instance() {
    let Some((geometry, _)) = lire("drone-hangar-building-2014.rvt") else { return };
    let low = |extent: Option<[[f64; 3]; 2]>| extent.map(|[low, _]| [(low[0] * 100.0).round() as i64, (low[1] * 100.0).round() as i64, (low[2] * 100.0).round() as i64]).expect("boîte");
    for stacks in [&[198_025u64, 198_810, 198_842, 198_855][..], &[199_734, 199_767, 199_786][..]] {
        let families: Vec<_> = stacks.iter().filter_map(|id| geometry.stats.in_place.iter().find(|family| family.family == *id)).collect();
        assert_eq!(families.len(), stacks.len());
        let forms: BTreeSet<[i64; 3]> = families.iter().map(|family| low(family.content[0].extent)).collect();
        let instances: BTreeSet<[i64; 3]> = families.iter().map(|family| low(family.instances[0].extent)).collect();
        assert_eq!(forms.len(), 1, "les formes s'empilent à un seul endroit : {forms:?}");
        assert_eq!(instances.len(), families.len(), "chaque instance est ailleurs : {instances:?}");
    }
}

/// L'import du site de `dynamo-nyc-site-2013` était dessiné à 555 m de l'instance de sa famille (« Site 1 »), avec les mêmes 56 916 triangles.
#[test]
fn l_import_du_site_est_dessine_par_son_instance_555_m_plus_loin() {
    let Some((geometry, _)) = lire("dynamo-nyc-site-2013.rvt") else { return };
    let family = geometry.stats.in_place.iter().find(|family| family.family == 230_264).expect("famille « Site 1 »");
    assert!(family.excluded);
    let (content, instance) = (&family.content[0], &family.instances[0]);
    assert_eq!((content.id, content.class.as_str(), content.triangles), (230_266, "ImportInstance", 56_916));
    assert_eq!((instance.id, instance.source, instance.triangles), (230_269, 1, 56_916));
    let [a, _] = content.extent.expect("boîte");
    let [b, _] = instance.extent.expect("boîte");
    let distance = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
    assert!((distance - 555.0).abs() < 1.0, "distance de {distance} m");
    assert_eq!(geometry.element_ids, vec![230_269]);
}
