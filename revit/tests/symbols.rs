//! Les formes de symboles (`faces::select::symbol_shape`) ne changent rien au maillage : parcourir chaque
//! symbole une fois, garder sa forme et ses nœuds maillés, puis libérer son graphe, rend pour chaque élément
//! exactement la même forme (bit à bit : sommets, normales, indices, couleurs) que parcourir le graphe du
//! symbole à chaque instance, avec les mêmes diagnostics, les mêmes sources et les mêmes faces manquantes.
//! Et les graphes des symboles ne vivent plus dans la scène : c'était 0,67 à 1,04 Go sur les fichiers denses
//! de 2016 à 2020.
//!
//! À lancer avec `cargo test --release`. Les fichiers publics viennent de `npm run samples:revit` ;
//! sans eux, les essais qui en dépendent passent sans rien faire.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use revit::geometry::{classes, saved};
use rvt::research::native_parameters::ObjectGraph;

fn sample(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(path)
}

fn open(path: &PathBuf) -> rvt::RevitFile {
    rvt::RevitFile::open_bytes(std::fs::read(path).expect("fichier d'essai")).expect("ouverture")
}

/// Ce qu'un élément rend, comparable d'une lecture à l'autre.
#[derive(Debug)]
struct Digest {
    fingerprint: u64,
    triangles: usize,
    /// Les triangles par priorité de profondeur (ordinaire, surcouche, hôte) : l'empreinte exacte ne la distingue pas.
    depths: [usize; 3],
    sources: BTreeSet<u64>,
    diagnostics: Vec<String>,
    unbounded_faces: usize,
    failures: Vec<(String, String)>,
    graphics: bool,
    too_dense: bool,
    capped: bool,
    /// Un brouillon (instance qui attend son symbole), achevé par `finish`.
    draft: Option<revit::geometry::faces::Meshes>,
}

impl PartialEq for Digest {
    fn eq(&self, other: &Self) -> bool {
        (self.fingerprint, self.triangles, self.depths, &self.sources, &self.diagnostics, self.unbounded_faces, &self.failures, self.graphics, self.too_dense, self.capped, self.draft.is_some())
            == (other.fingerprint, other.triangles, other.depths, &other.sources, &other.diagnostics, other.unbounded_faces, &other.failures, other.graphics, other.too_dense, other.capped, other.draft.is_some())
    }
}

impl Digest {
    fn of(shape: saved::Shape) -> Self {
        Digest {
            fingerprint: shape.mesh.exact_fingerprint(),
            triangles: shape.mesh.triangles(),
            depths: [0, 1, 2].map(|depth| shape.mesh.groups.iter().filter(|group| group.depth as usize == depth).map(|group| group.index_count as usize / 3).sum()),
            sources: shape.sources,
            diagnostics: shape.diagnostics,
            unbounded_faces: shape.unbounded_faces,
            failures: shape.failures,
            graphics: shape.graphics,
            too_dense: shape.too_dense,
            capped: shape.capped,
            draft: shape.draft,
        }
    }
}

/// Lit les formes de tous les éléments dessinables de `path`, en gardant les graphes des symboles ou non. Rend
/// les formes, le nombre de graphes de symboles gardés dans la scène, le nombre de formes de symboles et les
/// sommets des nœuds de symboles gardés sans plafond.
fn read(path: &PathBuf, keep_graphs: bool) -> (BTreeMap<u64, Option<Digest>>, usize, usize, usize) {
    let mut file = open(path);
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
    let work = |scene: &saved::Scene, id: u64, graph: &ObjectGraph| Digest::of(saved::shape(scene, id, graph));
    let plan = if keep_graphs { saved::Plan::exhaustive().keeping_symbol_graphs() } else { saved::Plan::exhaustive() };
    let finish = |scene: &saved::Scene, id: u64, digest: &mut Digest| {
        if let Some(draft) = digest.draft.take() {
            let mut shape = saved::Shape { mesh: Default::default(), sources: Default::default(), diagnostics: Vec::new(), unbounded_faces: 0, failures: Vec::new(), graphics: digest.graphics, too_dense: false, capped: false, draft: Some(draft) };
            saved::complete(scene, id, &mut shape);
            *digest = Digest::of(shape);
        }
    };
    let scan = saved::scan_with(&mut file, &wanted, 4, &work, Some(&finish), &|_| false, None, plan).expect("lecture des graphiques");
    (scan.results, scan.scene.symbols.len(), scan.scene.cache.shapes(), scan.scene.cache.kept_vertices())
}

#[test]
fn la_forme_des_symboles_rend_le_meme_maillage_que_leurs_graphes() {
    for name in ["DynamoSample_2024.rvt", "RE1-Architecture.rvt", "SampleModel.rvt", "rac_advanced_sample_project.rvt", "Vignette-04-BaseFile.rvt", "mega_advanced_sample_file.rvt"] {
        let Some(path) = sample(name) else { continue };
        let (with_graphs, kept, no_shapes, _) = read(&path, true);
        let (with_shapes, graphs_left, shapes, kept_vertices) = read(&path, false);
        assert_eq!(no_shapes, 0, "{name} : aucune forme de symbole quand les graphes sont gardés");
        assert_eq!(with_graphs.len(), with_shapes.len(), "{name} : éléments");
        let mut compared = 0;
        for (id, expected) in &with_graphs {
            assert_eq!(with_shapes.get(id), Some(expected), "{name} : élément {id}");
            compared += usize::from(expected.as_ref().is_some_and(|digest| !digest.sources.is_empty()));
        }
        assert!(compared > 0, "{name} : aucun élément ne place de symbole");
        // Chaque symbole placé a sa forme, ou son graphe si sa forme dépend de l'instance ; les fichiers d'essai n'en
        // ont aucun de la seconde sorte.
        assert_eq!(shapes + graphs_left, kept, "{name} : symboles");
        assert_eq!(graphs_left, 0, "{name} : {graphs_left} graphes de symboles gardés");
        eprintln!("{name} : {compared} éléments qui placent des symboles, {shapes} formes de symboles ({kept_vertices} sommets de nœuds gardés), identiques bit à bit");
    }
}

/// `saved::scan` (sondes et essais) garde les graphes des symboles ; la lecture normale (`Plan::reading_for`,
/// `Plan::exhaustive`) les libère.
#[test]
fn la_lecture_normale_libere_les_graphes_des_symboles() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let mut file = open(&path);
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
    let work = |_scene: &saved::Scene, _id: u64, graph: &ObjectGraph| graph.objects.len();
    let probe = saved::scan(&mut file, &wanted, 1, &work).expect("lecture");
    assert!(!probe.scene.symbols.is_empty());
    assert_eq!(probe.scene.cache.shapes(), 0);
    let normal = saved::scan_with(&mut file, &wanted, 1, &work, None, &|_| false, None, saved::Plan::exhaustive()).expect("lecture");
    assert!(normal.scene.symbols.is_empty());
    assert_eq!(normal.scene.cache.shapes(), probe.scene.symbols.len());
    assert!(normal.scene.cache.kept_vertices() > 0);
}
