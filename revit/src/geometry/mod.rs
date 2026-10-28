//! Géométrie : une forme par élément, dans cet ordre, sans jamais une boîte en silence.
//!
//! 1. **Forme Revit** : les graphiques que Revit a enregistrés (fichiers de Revit 2012 à 2027),
//!    placés, avec les couleurs de ses matériaux (`saved`). Source 0, ou 1 si certaines faces ne
//!    se maillent pas encore.
//! 2. **Forme reconstruite** : les corps que rvt-rs reconstruit pour son export IFC (`rebuilt`).
//!    Coûteux, donc seulement quand les formes enregistrées n'ont pas pu être lues du tout (fichier
//!    d'une année que le lecteur ne lit pas, ou lecture échouée). Source 2 ; source 3 si le corps n'est que la boîte
//!    de l'enregistrement de l'élément (dessinée quand même, marquée inconnue). Un élément isolé
//!    dont la forme enregistrée est illisible n'y passe plus : l'export n'en redessinait aucun
//!    (voir `rebuilt`).
//! 3. **Boîte englobante** : un élément dont la forme enregistrée est illisible (graphe refusé,
//!    ou aucune surface qui se maille), trop dense (`saved::MAX_ELEMENT_TRIANGLES`) ou que le
//!    plafond de maillage du fichier a empêché de mailler (`saved::HARD_TRIANGLE_LIMIT`) se montre
//!    par la boîte que Revit a enregistrée pour lui (`bounds`). Source 3, « Inconnue (boîte
//!    englobante) » : il n'est jamais écarté en silence, et un avertissement le compte, chaque
//!    élément dans l'avertissement de sa seule cause.
//! 4. Rien : sans aucune étendue (pas de graphe lisible), l'élément n'est pas dessiné ; un
//!    avertissement le compte, à part de `without_geometry`, où ne sont que les éléments qui n'ont
//!    rien à montrer (classes sans géométrie, éléments vides).
//!
//! Ne se dessine pas ce qu'une vue 3D de Revit ne montre pas comme objet : pièces, niveaux,
//! trames, vues, boîtes de coupe, annotations, modèle analytique, types et symboles de famille
//! (`classes`). Les identifiants sont les GlobalId IFC que calcule l'exporteur de Revit.

pub mod bounds;
pub mod classes;
pub mod faces;
pub mod materials;
pub mod pack;
pub mod rebuilt;
pub mod saved;

use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::properties::Retained;
use crate::{Context, SourceCounts};
use pack::{ElementMesh, MeshStats, Paint};

/// Tout ce que le module produit : les colonnes de `Output` qui décrivent le maillage.
#[derive(Debug, Clone, Default)]
pub struct Geometry {
    /// Clé d'identité de chaque élément (voir `Output::keys`).
    pub keys: Vec<String>,
    /// Identifiant Revit (ElementId) de chaque élément, dans le même ordre que `keys` : c'est
    /// ce que reçoit le module des propriétés.
    pub element_ids: Vec<u64>,
    pub names: Vec<String>,
    pub sources: Vec<u8>,
    pub origin: [f64; 3],
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub primitives: Vec<u32>,
    pub materials: Vec<u8>,
    pub counts: SourceCounts,
    /// Éléments trouvés mais sans rien à dessiner.
    pub without_geometry: usize,
    /// Mesures et décisions, pour les essais et le recensement (pas dans le contrat).
    pub stats: Stats,
}

/// Une ligne du recensement : ce qu'il est advenu des éléments d'une classe Revit.
#[derive(Debug, Clone, Default)]
pub struct ClassRow {
    pub elements: usize,
    /// Raison de l'exclusion de la classe, si elle l'est.
    pub excluded: Option<&'static str>,
    /// Dessinés (forme enregistrée ou reconstruite).
    pub drawn: usize,
    /// Écartés parce que propres à une vue ou membres d'une définition de groupe.
    pub excluded_by_relation: usize,
    /// Symbole que d'autres éléments placent : écarté pour ne pas dessiner deux fois.
    pub symbols: usize,
    /// Sous-élément dont la forme est déjà celle de son propriétaire.
    pub inside_owner: usize,
    /// Dessinable mais sans aucune surface : rien à montrer.
    pub empty: usize,
    /// Dessinable mais forme illisible (graphe refusé ou diagnostics), trop dense ou non maillée à cause du plafond du
    /// fichier : à reconstruire, ou montrée par sa boîte.
    pub unreadable: usize,
    /// Parmi les dessinés, ceux dont la forme n'est pas une coque fermée (dessinés des deux côtés).
    pub double_sided: usize,
    /// Classe sans aucune forme dans ce fichier (réglages, styles, paramètres…) : ni dessinée,
    /// ni comptée comme élément sans forme.
    pub not_geometric: usize,
    /// Dessine exactement les mêmes triangles qu'un élément d'identifiant plus petit.
    pub identical: usize,
}

/// Un élément dessinable dont la forme enregistrée n'a pas été lue en entier : ce que la lecture n'a
/// pas compris, pour le recensement et les essais (pas dans le contrat).
#[derive(Debug, Clone, Default)]
pub struct Incomplete {
    pub class: String,
    /// Diagnostics du parcours et du décodage (un message par nœud refusé).
    pub diagnostics: Vec<String>,
    /// Faces qu'aucune méthode n'a su mailler : classe de surface et raison.
    pub failures: Vec<(String, String)>,
    /// Le graphe graphique lui-même n'a pas pu être décodé (aucune face à examiner).
    pub unreadable_graph: bool,
}

/// Ce qu'on mesure en route.
#[derive(Debug, Clone, Default)]
pub struct Stats {
    /// Secondes de chaque passe sur les formes enregistrées (voir `saved::Timing`), export IFC,
    /// assemblage.
    pub saved: saved::Timing,
    pub seconds_export: f64,
    pub seconds_pack: f64,
    pub seconds_total: f64,
    /// L'export IFC de rvt-rs a dû être calculé.
    pub export_needed: bool,
    /// Éléments dessinables dont la forme enregistrée est illisible.
    pub unreadable: usize,
    /// Parmi eux, ceux que ni la reconstruction ni rien d'autre n'a dessinés et qui le sont par leur
    /// boîte englobante (source 3), et ceux qui n'ont aucune étendue et ne sont pas dessinés.
    pub boxed: usize,
    pub undrawn: usize,
    pub threads: usize,
    /// Instances dont le graphique a attendu la lecture des symboles qu'elles placent.
    pub deferred: usize,
    /// Enregistrements d'éléments non décodés parce que leur propriétaire n'est pas placé.
    pub skipped: usize,
    /// Enregistrements d'éléments décodés.
    pub decoded: usize,
    /// Éléments identiques, au triangle près, à un élément d'identifiant plus petit.
    pub identical: usize,
    pub mesh: MeshStats,
    /// Éléments dessinés des deux côtés (forme non fermée).
    pub double_sided_elements: usize,
    /// Éléments dont la forme dépasse `saved::MAX_ELEMENT_TRIANGLES` : montrés par leur boîte (source 3), comptés ici et
    /// nulle part ailleurs. Ceux pour lesquels Revit n'a pas enregistré de boîte ne sont pas dessinés : `too_dense_undrawn`.
    pub too_dense: usize,
    pub too_dense_undrawn: usize,
    /// Éléments dont la forme a été remplacée par leur boîte pour que le fichier tienne dans `MAX_TRIANGLES`, ou parce que le
    /// plafond de triangles maillés du fichier était atteint (`saved::Scene::hard_limit`) et qu'ils n'ont pas été maillés.
    pub trimmed: usize,
    /// Parmi eux, ceux que le plafond de maillage a refusés : montrés par la boîte que Revit a enregistrée. Sans boîte
    /// enregistrée, l'élément n'est pas dessiné (`capped_undrawn`).
    pub capped: usize,
    pub capped_undrawn: usize,
    /// Le plafond de triangles maillés de la lecture (`saved::Scene::hard_limit`).
    pub mesh_limit: usize,
    /// Éléments remis à la sortie qu'une instance lue après eux place comme symbole (voir `Rules`) : jamais vu.
    pub drawn_symbols: usize,
    pub materials: usize,
    /// Pour chaque élément dessiné : sa source et l'empreinte exacte de sa forme (`ElementMesh::exact_fingerprint`),
    /// quand `Context::fingerprints` le demande (essais de non-régression).
    pub shapes: BTreeMap<u64, (u8, u64)>,
    pub classes: BTreeMap<String, ClassRow>,
    /// Enregistrements d'éléments écartés, par raison (classe ou relation).
    pub rules: BTreeMap<&'static str, usize>,
    /// Parmi ceux que la règle des masses écarte (`rules`), ceux dont la classe peut porter de la géométrie de modèle :
    /// les masses qu'une vue 3D ne montre pas, et que l'avertissement compte. Le reste, ce sont des enregistrements
    /// sans forme (les deux `CategoryElem` de la catégorie Masses que porte tout modèle, styles…) : rien à dessiner.
    pub masses_hidden: usize,
    /// Les éléments dessinables dont la forme enregistrée n'a pas été lue en entier (source 1, ou
    /// illisible : boîte englobante, source 3), avec ce qui n'a pas été compris.
    pub incomplete: BTreeMap<u64, Incomplete>,
    /// Éléments dessinés que possède une `Family` dont on ne sait pas si elle est chargée (avant Revit 2015, voir
    /// `saved::FamilyOwner::Unread`) : gardés, et comptés par un avertissement. Jamais vu sur les fichiers d'essai.
    pub family_unread: BTreeSet<u64>,
    /// Les familles sur place dont le contenu est une forme dessinée, et ce qu'on en a fait (voir `InPlaceFamily`).
    pub in_place: Vec<InPlaceFamily>,
    /// Les éléments dessinés dont la chaîne des propriétaires atteint une famille sur place sans être une forme de sa définition (un mur, un
    /// toit, un sol : des éléments du modèle que la famille possède) : (famille, élément, classe). Dessinés, comme avant.
    pub in_place_standalone: Vec<(u64, u64, String)>,
}

/// Un élément du contenu d'une famille sur place (un élément dont la chaîne des propriétaires d'ElemTable atteint une `Family` sur
/// place), dont la forme est maillée.
#[derive(Debug, Clone)]
pub struct InPlaceContent {
    pub id: u64,
    pub class: String,
    pub triangles: usize,
    /// Boîte du maillage, en mètres, Y vers le haut (`ElementMesh::extent`).
    pub extent: Option<[[f64; 3]; 2]>,
}

/// Une instance d'une famille sur place remise à la sortie.
#[derive(Debug, Clone)]
pub struct InPlaceInstance {
    pub id: u64,
    /// Source de sa forme remise (0 enregistrée, 1 partielle, 2 reconstruite, 3 boîte).
    pub source: u8,
    pub triangles: usize,
    pub extent: Option<[[f64; 3]; 2]>,
}

/// Une famille sur place dont le contenu est dessiné : une famille créée dans l'éditeur de modèle sur place. Le projet écrit ses
/// formes dans son repère (à l'endroit où elles ont été créées) et son instance, qui les dessine à son tour, là où elle est
/// aujourd'hui : une copie déplacée de l'instance laisse la forme d'origine en place, un fantôme ; quand l'instance n'a pas bougé,
/// la forme est dessinée deux fois. Quand une instance de la famille est dessinée et porte autant de triangles que son contenu,
/// celui-ci n'est pas dessiné (`classes::RELATION_REASONS`, dernière raison) ; sinon il l'est, comme avant, et un avertissement le
/// compte (`in_place_warning`). Quand l'instance est une masse que Revit masque par défaut, le contenu en est une aussi : il n'est pas
/// dessiné et la règle des masses le compte (`mass`).
#[derive(Debug, Clone)]
pub struct InPlaceFamily {
    pub family: u64,
    pub content: Vec<InPlaceContent>,
    /// Les instances de la famille que la lecture a dessinées (de n'importe quelle source).
    pub instances: Vec<InPlaceInstance>,
    /// Le contenu est écarté : une instance dessine sa forme, avec au moins autant de triangles.
    pub excluded: bool,
    /// Le contenu est écarté comme une masse : l'instance de la famille en est une, que Revit masque par défaut (raison
    /// `classes::RELATION_REASONS[5]`, comptée dans `masses_hidden` : l'avertissement des masses la compte). Ni dessiné, ni compté par `in_place_warning`.
    pub mass: bool,
}

/// Triangles qu'un fichier peut afficher : au-delà, les éléments les plus denses sont montrés par leur boîte englobante
/// (source 3) jusqu'à ce que le total y tienne, avec un avertissement.
///
/// Le nombre vient de la mémoire, mesurée en WebAssembly sur les 28 fichiers d'essai (Node 24, instance neuve par
/// fichier, mémoire linéaire après la lecture). La sortie : 12 octets d'indices par triangle, plus 24 octets (position
/// et normale en `f32`) par sommet, et 0,5 à 0,7 sommet par triangle sur les fichiers denses (soudure comprise) : de
/// 24 à 29 octets par triangle ; elle existe en trois exemplaires, celui de Rust, les tableaux typés du transfert, puis les
/// géométries que `buildModel` fabrique : environ 90 octets par triangle, soit 270 Mo pour 3 millions. Le plus lourd à
/// porter est le travail de la lecture : de 270 octets par triangle (Vignette-04, 2,2 millions de triangles, 968 Mo) à 600
/// (mega_advanced, 1,3 million, 1 045 Mo ; le nombre d'éléments pèse aussi), soit au pire 1,8 Go pour 3 millions, plus les
/// 17 fois la taille du fichier de ce qui ne dépend pas des triangles (45 Mo au plus pour un fichier ancien : 0,8 Go).
/// Au total, moins de 2,7 Go dans les 4 Gio d'une instance WebAssembly (3,2 Gio budgétés). Le plus lourd des fichiers
/// d'essai a 2,2 millions de triangles.
pub const MAX_TRIANGLES: usize = 3_000_000;

/// Classes qui portent de la géométrie de modèle, même si aucune n'a de forme lisible dans le
/// fichier. Une classe absente d'ici compte aussi dès qu'un de ses éléments a une forme.
pub(crate) const GEOMETRIC_CLASSES: &[&str] = &[
    "SWall", "Floor", "Ceiling", "FamilyInstance", "FootPrintRoof", "ExtrusionRoof", "StairsElement", "StairsRun", "StairsLanding", "BaseRailing", "TopRail", "HandRail", "SiteSurface", "BuildingPad", "RbsPipeCurve", "RbsDuctCurve", "FormElem", "ExtrusionElem", "Text3dElem",
];

/// Écarter les éléments qui dessinent exactement les mêmes triangles au même endroit qu'un autre
/// élément (le même objet posé deux fois : Revit le signale « éléments identiques au même
/// endroit » mais le dessine et l'exporte tous). Désactivé : chacun garde sa fiche et son
/// GlobalId, que d'autres fichiers (IFC, planning) peuvent viser ; les doublons exacts sont
/// comptés dans le recensement (`Stats::identical`).
pub const DROP_IDENTICAL: bool = false;


/// Ce que le travail d'un élément rend à la passe sur les formes enregistrées : sa forme maillée et,
/// si elle n'a aucune surface, la boîte que Revit a enregistrée pour lui.
struct Read {
    shape: saved::Shape,
    bounds: Option<bounds::Bounds>,
}

/// Pourquoi la forme enregistrée d'un élément n'est pas gardée : ce qui décide de l'avertissement qui le compte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// Illisible : graphe refusé, ou diagnostics sans aucune surface.
    Unread,
    /// Plus de `saved::MAX_ELEMENT_TRIANGLES` triangles.
    TooDense,
    /// Pas maillée : le plafond de triangles maillés du fichier était atteint (`saved::Shape::capped`).
    Capped,
}

/// Un élément dessinable dont la forme enregistrée n'est pas gardée : sa classe, pourquoi, et sa boîte englobante
/// (maillée, de la couleur de son matériau) si Revit en a enregistré une.
struct Unreadable {
    class: String,
    mesh: Option<ElementMesh>,
    why: Refusal,
}

/// Ce que `prepare` rend : tout de `Geometry` sauf les tableaux assemblés, et les maillages des éléments, dans
/// l'ordre des clés, prêts à être assemblés en un seul morceau (`build`) ou en plusieurs (`lib::read_streaming`).
#[derive(Debug, Default)]
pub struct Prepared {
    pub keys: Vec<String>,
    pub element_ids: Vec<u64>,
    pub names: Vec<String>,
    pub sources: Vec<u8>,
    pub counts: SourceCounts,
    pub without_geometry: usize,
    pub stats: Stats,
    pub meshes: Vec<ElementMesh>,
}

impl Prepared {
    pub fn triangles(&self) -> usize {
        self.meshes.iter().map(ElementMesh::triangles).sum()
    }
}

/// Un élément achevé, remis à la sortie dès qu'il l'est (`prepare_streaming`) : sa clé d'identité, son nom provisoire
/// (classe et identifiant ; le libellé de la fiche vient avec les propriétés, à la fin), sa source et son maillage.
pub struct Emitted {
    pub id: u64,
    pub key: String,
    pub name: String,
    pub class: String,
    pub source: u8,
    pub mesh: ElementMesh,
}

/// Fabrique la géométrie de tous les éléments dessinables, assemblée en un seul morceau.
pub fn build(file: &mut rvt::RevitFile, context: &mut Context) -> anyhow::Result<Geometry> {
    let prepared = prepare(file, context)?;
    let step = Stopwatch::start();
    let Prepared { keys, element_ids, names, sources, counts, without_geometry, mut stats, meshes } = prepared;
    let packed = pack::pack(meshes);
    stats.seconds_pack = step.seconds();
    stats.double_sided_elements = packed.double_sided_elements;
    stats.materials = packed.materials.len() / 6;
    context.stage("géométrie : assemblage", stats.seconds_pack);
    Ok(Geometry { keys, element_ids, names, sources, origin: packed.origin, positions: packed.positions, normals: packed.normals, indices: packed.indices, primitives: packed.primitives, materials: packed.materials, counts, without_geometry, stats })
}

/// Fabrique les maillages de tous les éléments dessinables, sans les assembler : [`prepare_streaming`] avec tous les
/// maillages gardés, remis dans l'ordre des identifiants d'élément (la sortie d'un bloc est triée ; celle par
/// morceaux suit l'ordre où les formes s'achèvent).
pub fn prepare(file: &mut rvt::RevitFile, context: &mut Context) -> anyhow::Result<Prepared> {
    let mut meshes = Vec::new();
    let prepared = prepare_streaming(file, context, &mut |emitted| {
        meshes.push(emitted.mesh);
        Ok(())
    })?;
    let Prepared { keys, element_ids, names, sources, counts, without_geometry, stats, meshes: _ } = prepared;
    let mut order: Vec<usize> = (0..element_ids.len()).collect();
    order.sort_by_key(|&i| element_ids[i]);
    let mut meshes: Vec<Option<ElementMesh>> = meshes.into_iter().map(Some).collect();
    let mut sorted = Prepared { counts, without_geometry, stats, ..Prepared::default() };
    for &i in &order {
        sorted.keys.push(keys[i].clone());
        sorted.element_ids.push(element_ids[i]);
        sorted.names.push(names[i].clone());
        sorted.sources.push(sources[i]);
        sorted.meshes.push(meshes[i].take().expect("un maillage par élément"));
    }
    Ok(sorted)
}

/// Fabrique les maillages de tous les éléments dessinables et remet chacun à `sink` dès qu'il est achevé, dans l'ordre
/// où ils s'achèvent : les éléments sans instance différée au fil de leur lot (l'ordre du fichier), les autres après la
/// lecture des symboles, par identifiant croissant ; puis les boîtes (formes illisibles, trop denses, ou que le plafond de
/// maillage a refusées) et les formes reconstruites. Rien n'attend tout le fichier, sauf ce qu'une règle exige : un
/// sous-élément attend son propriétaire (il est dessiné par lui s'il tient dans sa boîte en ne plaçant que ses
/// symboles), et les éléments sans aucune surface attendent de savoir si leur classe porte de la géométrie dans ce
/// fichier (`Rules`). Le budget de triangles
/// (`Context::triangle_budget`) se dépense dans cet ordre : au-delà, chaque élément est montré par sa boîte. Le
/// `Prepared` rendu décrit les éléments remis, sans leurs maillages. Un `sink` qui rend une erreur met fin à la lecture
/// avec cette erreur : rien n'est reconstruit ni compté à sa place, et rien ne lui est plus remis.
pub fn prepare_streaming(file: &mut rvt::RevitFile, context: &mut Context, sink: &mut dyn FnMut(Emitted) -> anyhow::Result<()>) -> anyhow::Result<Prepared> {
    let clock = Stopwatch::start();
    let mut stats = Stats::default();
    let mut without: BTreeSet<u64> = BTreeSet::new();
    let release = context.release;
    let global_ids = context.global_ids(file).clone();
    let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids, triangles: 0, budget: context.triangle_budget, trimmed: 0, fingerprints: context.fingerprints, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink, sink_error: None };

    // 1. Formes enregistrées par Revit.
    let mut saved_read = false;
    let mut unreadable: BTreeMap<u64, Unreadable> = BTreeMap::new();
    if release.is_none_or(|year| crate::native::SUPPORTED_RELEASES.contains(&year)) {
        match from_saved(file, context.exhaustive, context.prudent, context.hard_triangle_limit, &mut context.retained, &mut outlet, &mut without, &mut unreadable, &mut stats) {
            Ok(scene) => {
                saved_read = true;
                free_scene(scene);
            }
            Err(error) => {
                // La sortie qui ne prend plus rien n'est pas une lecture manquée : rien ne se reconstruit pour elle, la
                // lecture s'arrête sur l'erreur de la sortie (celle-ci, non une variante enrobée par le balayage).
                if outlet.failed() {
                    return Err(outlet.raise(error));
                }
                context.warnings.push(format!("Les formes enregistrées par Revit n'ont pas pu être lues ({error:#}) ; les éléments sont reconstruits depuis les données de Revit, ou montrés par leur boîte et marqués « Inconnue »."));
            }
        }
    } else if let Some(year) = release {
        context.warnings.push(format!("{} Les éléments sont reconstruits, ou montrés par leur boîte et marqués « Inconnue ».", crate::native::unsupported(year)));
    }
    stats.unreadable = unreadable.values().filter(|element| element.why == Refusal::Unread).count();
    let masses = stats.masses_hidden;
    if masses > 0 {
        context.warnings.push(if masses == 1 {
            "1 masse n'est pas dessinée : Revit masque les masses par défaut dans les vues 3D.".to_string()
        } else {
            format!("{masses} masses ne sont pas dessinées : Revit masque les masses par défaut dans les vues 3D.")
        });
    }

    // 2. Formes reconstruites : tout le fichier, quand les formes enregistrées manquent (année que la lecture native
    // ne lit pas, ou lecture échouée). Jamais pour quelques éléments illisibles : l'export n'en redessinait aucun.
    if !saved_read {
        let step = Stopwatch::start();
        match rebuilt::build(file, context) {
            Ok(output) => {
                for element in output.elements {
                    if outlet.drawn(element.id) {
                        continue;
                    }
                    let source = if element.bbox { 3 } else { 2 };
                    outlet.put(element.id, element.class, source, element.mesh)?;
                }
                without.extend(output.without_body);
            }
            Err(error) => {
                // Un manque de mémoire dont le lecteur TypeScript sait quoi faire (`isMemoryFailure`) : sans formes
                // enregistrées lues non plus, la lecture n'a rien à montrer, elle s'arrête sur cette erreur.
                if format!("{error:#}").starts_with("mémoire insuffisante") {
                    return Err(error);
                }
                context.warnings.push(format!("La reconstruction des formes depuis les données de Revit a échoué ({error:#}) ; les éléments dont la forme enregistrée n'avait pas été lue ne sont pas dessinés, hormis ceux que Revit a enregistrés avec une boîte englobante, montrés par elle."));
            }
        }
        stats.seconds_export = step.seconds();
    }

    // 3. Les éléments dont la forme enregistrée n'est pas gardée (que la reconstruction, si elle a eu lieu, n'a pas
    // redessinés) : leur boîte englobante, source 3 (jamais écartés en silence) ; sans étendue, rien à dessiner, et
    // l'avertissement qui les compte le dit.
    emit_refused(&mut outlet, &mut stats, unreadable)?;
    stats.export_needed = context.has_export();
    for id in &outlet.emitted {
        without.remove(id);
    }
    stats.trimmed = outlet.trimmed;
    context.warnings.extend(refusal_warnings(&stats, outlet.budget));
    // Les éléments d'une famille dont la définition ne se lit pas ne sont comptés que s'ils sont dessinés.
    stats.family_unread.retain(|id| outlet.drawn(*id));
    context.warnings.extend(family_warning(stats.family_unread.len()));
    // Le contenu des familles sur place que son instance ne dessine pas (masquée, vide, illisible, ou plus petite) : dessiné à sa place
    // d'origine, comptant seulement ce que la sortie a remis.
    let kept = stats.in_place.iter().filter(|family| !family.excluded && !family.mass).flat_map(|family| &family.content).filter(|content| outlet.drawn(content.id)).count();
    context.warnings.extend(in_place_warning(kept));

    // 4. Les clés d'identité (le GlobalId IFC de Revit, à défaut `rvt-<ElementId>`) ont été données à l'émission.
    let Outlet { mut prepared, shapes, mesh_stats, .. } = outlet;
    prepared.without_geometry = without.len();
    stats.mesh = mesh_stats;
    stats.shapes = shapes;
    stats.seconds_total = clock.seconds();
    if stats.saved.census > 0.0 {
        context.stage("géométrie : balayage des classes et inflation", stats.saved.census);
    }
    context.stage("géométrie : enregistrements d'éléments", stats.saved.records - stats.saved.census);
    context.stage("géométrie : symboles de famille", stats.saved.symbols);
    context.stage("géométrie : graphiques et maillage", stats.saved.elements + stats.saved.retake);
    if stats.seconds_export > 0.0 {
        context.stage("géométrie : export IFC", stats.seconds_export);
    }
    prepared.stats = stats;
    Ok(prepared)
}

/// Remet à la sortie la boîte des éléments dont la forme enregistrée n'est pas gardée (`Unreadable`), ceux que rien n'a
/// redessinés, et les compte une fois, d'après ce qui est réellement remis : `Stats::boxed` et `undrawn` (illisibles),
/// `too_dense` et `too_dense_undrawn`, `capped` et `capped_undrawn` (le plafond de maillage ; ceux-là comptent aussi dans
/// `Outlet::trimmed`, comme les formes que le budget remplace). Un élément sans boîte enregistrée n'est pas dessiné.
fn emit_refused(outlet: &mut Outlet<'_>, stats: &mut Stats, unreadable: BTreeMap<u64, Unreadable>) -> anyhow::Result<()> {
    for (id, element) in unreadable {
        if outlet.drawn(id) {
            continue;
        }
        let Unreadable { class, mesh, why } = element;
        match (why, mesh) {
            (Refusal::Unread, Some(mesh)) => {
                outlet.put(id, class, 3, mesh)?;
                stats.boxed += 1;
            }
            (Refusal::Unread, None) => stats.undrawn += 1,
            (Refusal::TooDense, Some(mesh)) => {
                outlet.put(id, class, 3, mesh)?;
                stats.too_dense += 1;
            }
            (Refusal::TooDense, None) => stats.too_dense_undrawn += 1,
            (Refusal::Capped, Some(mesh)) => {
                outlet.put_trimmed(id, class, mesh)?;
                stats.capped += 1;
            }
            (Refusal::Capped, None) => stats.capped_undrawn += 1,
        }
    }
    Ok(())
}

/// Les avertissements qui comptent les éléments dont la forme enregistrée n'est pas gardée, d'après ce qui a réellement
/// été remis (`Stats`) : chacun l'est une seule fois, dans l'avertissement de sa cause.
fn refusal_warnings(stats: &Stats, budget: usize) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut count = |n: usize, one: String, many: String| {
        if n > 0 {
            warnings.push(if n == 1 { one } else { many });
        }
    };
    // Une forme que Revit a enregistrée et que ce lecteur ne sait pas encore lire.
    let n = stats.boxed;
    count(n, "1 élément a une forme que Revit a enregistrée mais que ce lecteur ne sait pas encore lire : il est montré par sa boîte englobante et marqué « Inconnue ».".to_string(), format!("{n} éléments ont une forme que Revit a enregistrée mais que ce lecteur ne sait pas encore lire : ils sont montrés par leur boîte englobante et marqués « Inconnue »."));
    let n = stats.undrawn;
    count(
        n,
        "1 élément a une forme que Revit a enregistrée mais que ce lecteur ne sait pas encore lire, et Revit n'a pas enregistré de boîte pour lui : il n'est pas dessiné.".to_string(),
        format!("{n} éléments ont une forme que Revit a enregistrée mais que ce lecteur ne sait pas encore lire, et Revit n'a pas enregistré de boîte pour eux : ils ne sont pas dessinés."),
    );
    // Une forme de plus de `MAX_ELEMENT_TRIANGLES` triangles.
    let max = saved::MAX_ELEMENT_TRIANGLES;
    let n = stats.too_dense;
    count(
        n,
        format!("1 élément a une forme de plus de {max} triangles, que ce lecteur ne garde pas : il est montré par sa boîte englobante et marqué « Inconnue »."),
        format!("{n} éléments ont une forme de plus de {max} triangles, que ce lecteur ne garde pas : ils sont montrés par leur boîte englobante et marqués « Inconnue »."),
    );
    let n = stats.too_dense_undrawn;
    count(
        n,
        format!("1 élément a une forme de plus de {max} triangles, que ce lecteur ne garde pas, et Revit n'a pas enregistré de boîte pour lui : il n'est pas dessiné."),
        format!("{n} éléments ont une forme de plus de {max} triangles, que ce lecteur ne garde pas, et Revit n'a pas enregistré de boîte pour eux : ils ne sont pas dessinés."),
    );
    // Le budget de triangles du fichier : ce qui ne tenait plus dedans, ou que le plafond de maillage a empêché de mailler.
    let n = stats.trimmed;
    count(
        n,
        format!("Le fichier dépasse {budget} triangles, ce que ce navigateur peut afficher : l'élément dont la forme ne tenait plus dans ce budget est montré par sa boîte englobante et marqué « Inconnue »."),
        format!("Le fichier dépasse {budget} triangles, ce que ce navigateur peut afficher : les {n} éléments dont la forme ne tenait plus dans ce budget sont montrés par leur boîte englobante et marqués « Inconnue »."),
    );
    let (n, limit) = (stats.capped_undrawn, stats.mesh_limit);
    count(
        n,
        format!("Le fichier dépasse {limit} triangles maillés, ce que ce lecteur maille au plus : 1 élément n'a pas été maillé, et Revit n'a pas enregistré de boîte pour lui : il n'est pas dessiné."),
        format!("Le fichier dépasse {limit} triangles maillés, ce que ce lecteur maille au plus : {n} éléments n'ont pas été maillés, et Revit n'a pas enregistré de boîte pour eux : ils ne sont pas dessinés."),
    );
    warnings
}

/// L'avertissement des `n` éléments dessinés que possède une `Family` dont la définition ne se lit pas (`Stats::family_unread`) : ils
/// peuvent être des pièces de famille dessinées à l'origine du projet. Rien pour 0.
fn family_warning(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("1 élément appartient à une famille dont la définition ne se lit pas : il peut être une pièce de famille dessinée à l'origine du projet.".to_string()),
        n => Some(format!("{n} éléments appartiennent à une famille dont la définition ne se lit pas : ils peuvent être des pièces de famille dessinées à l'origine du projet.")),
    }
}

/// L'avertissement des `n` éléments du contenu d'une famille sur place dessinés tels quels (`Stats::in_place`) : aucune instance de leur
/// famille n'est dessinée avec tout ce contenu (instance masquée, vide, illisible ou absente ; ni une masse que Revit masque par défaut :
/// le contenu l'est alors aussi, l'avertissement des masses le compte), et rien ne dit où l'instance est : le contenu est à l'endroit où la
/// famille a été créée, peut-être pas où elle est aujourd'hui. Rien pour 0.
fn in_place_warning(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("1 élément du contenu d'une famille sur place est dessiné à l'endroit où la famille a été créée : aucune instance de sa famille n'est dessinée avec tout ce contenu, il peut être à une autre place que dans Revit.".to_string()),
        n => Some(format!("{n} éléments du contenu de familles sur place sont dessinés à l'endroit où les familles ont été créées : aucune instance de leur famille n'est dessinée avec tout ce contenu, ils peuvent être à une autre place que dans Revit.")),
    }
}

/// La sortie de `prepare_streaming` : ce qu'elle sait des éléments remis (clés, noms, sources, comptes, empreintes),
/// le budget de triangles qui se dépense dans l'ordre des remises, et le puits où chaque maillage part.
struct Outlet<'s> {
    prepared: Prepared,
    emitted: BTreeSet<u64>,
    /// Clés déjà données : un GlobalId pris par un autre élément n'est pas repris.
    used: HashSet<String>,
    global_ids: BTreeMap<u32, String>,
    triangles: usize,
    budget: usize,
    trimmed: usize,
    fingerprints: bool,
    shapes: BTreeMap<u64, (u8, u64)>,
    mesh_stats: MeshStats,
    sink: &'s mut dyn FnMut(Emitted) -> anyhow::Result<()>,
    /// L'erreur du puits, quand il a refusé un élément : la lecture s'arrête sur elle. `emit` ne rend alors qu'un
    /// témoin, que le balayage fait remonter (et enrobe de contexte) ; l'erreur d'origine reste ici (`raise`).
    sink_error: Option<anyhow::Error>,
}

impl Outlet<'_> {
    fn drawn(&self, id: u64) -> bool {
        self.emitted.contains(&id)
    }

    /// Le puits a-t-il refusé un élément ?
    fn failed(&self) -> bool {
        self.sink_error.is_some()
    }

    /// L'erreur à rendre pour `error`, qui a traversé le balayage : celle du puits s'il en a refusé un, sinon `error`.
    fn raise(&mut self, error: anyhow::Error) -> anyhow::Error {
        self.sink_error.take().unwrap_or(error)
    }

    /// [`emit`](Self::emit) pour qui ne passe pas par le balayage : l'erreur rendue est celle du puits.
    fn put(&mut self, id: u64, class: String, source: u8, mesh: ElementMesh) -> anyhow::Result<()> {
        self.emit(id, class, source, mesh).map_err(|error| self.raise(error))
    }

    /// Un élément montré par sa boîte (source 3) parce que le plafond de maillage du fichier ne laisse plus rien mailler :
    /// compté avec ceux que le budget de triangles remplace par leur boîte (`trimmed`).
    fn put_trimmed(&mut self, id: u64, class: String, mesh: ElementMesh) -> anyhow::Result<()> {
        self.trimmed += 1;
        self.put(id, class, 3, mesh)
    }

    /// Remet un élément à la sortie. Au-delà du budget de triangles, sa forme est remplacée par la boîte de son maillage
    /// (source 3, de la couleur de sa première primitive) : déterministe, dans l'ordre des remises.
    fn emit(&mut self, id: u64, class: String, mut source: u8, mut mesh: ElementMesh) -> anyhow::Result<()> {
        // Un puits qui a refusé un élément n'en reçoit plus : la lecture est finie.
        if self.failed() {
            return Err(anyhow::anyhow!("la sortie n'accepte plus d'éléments"));
        }
        if source != 3 && self.triangles + mesh.triangles() > self.budget {
            if let Some(boxed) = boxed_mesh(&mesh) {
                mesh = boxed;
                source = 3;
                self.trimmed += 1;
            }
        }
        self.triangles += mesh.triangles();
        let key = identity_key(&self.global_ids, &mut self.used, id);
        let name = format!("{} {id}", if class.is_empty() { "Élément" } else { &class });
        match source {
            0 => self.prepared.counts.revit += 1,
            1 => self.prepared.counts.partial += 1,
            2 => self.prepared.counts.rebuilt += 1,
            _ => self.prepared.counts.unknown += 1,
        }
        self.mesh_stats.add(&mesh.stats);
        if self.fingerprints {
            self.shapes.insert(id, (source, mesh.exact_fingerprint()));
        }
        self.emitted.insert(id);
        self.prepared.keys.push(key.clone());
        self.prepared.element_ids.push(id);
        self.prepared.names.push(name.clone());
        self.prepared.sources.push(source);
        (self.sink)(Emitted { id, key, name, class, source, mesh }).map_err(|error| {
            self.sink_error = Some(error);
            anyhow::anyhow!("la sortie a refusé un élément")
        })
    }
}

/// La boîte du maillage d'un élément, de la couleur de sa première primitive : ce qui le montre quand sa forme n'est
/// pas gardée. `None` sans sommet.
fn boxed_mesh(mesh: &ElementMesh) -> Option<ElementMesh> {
    let paint = mesh.groups.first().map_or(Paint::NEUTRAL, |group| group.paint);
    // Les sommets sont en mètres, Y vers le haut : la boîte se refait en pieds, Z vers le haut.
    let [low, high] = mesh.extent()?;
    let feet = |p: [f64; 3]| [p[0] / pack::FOOT, -p[2] / pack::FOOT, p[1] / pack::FOOT];
    let (a, b) = (feet(low), feet(high));
    let bounds = bounds::Bounds::new([a[0].min(b[0]), a[1].min(b[1]), a[2].min(b[2])], [a[0].max(b[0]), a[1].max(b[1]), a[2].max(b[2])])?;
    Some(bounds.mesh(paint))
}

/// La clé d'identité d'un élément : son GlobalId IFC, à défaut `rvt-<ElementId>` (aussi quand le GlobalId est déjà
/// pris par un autre élément, `used`). Seule la géométrie les calcule ; les propriétés les reçoivent.
fn identity_key(global_ids: &BTreeMap<u32, String>, used: &mut HashSet<String>, id: u64) -> String {
    let key = u32::try_from(id).ok().and_then(|id| global_ids.get(&id)).filter(|key| !used.contains(*key)).cloned().unwrap_or_else(|| format!("rvt-{id}"));
    used.insert(key.clone());
    key
}

/// Les clés d'identité des éléments `ids`, dans l'ordre (voir `identity_key`).
pub fn identity_keys(global_ids: &BTreeMap<u32, String>, ids: &[u64]) -> Vec<String> {
    let mut used: HashSet<String> = HashSet::with_capacity(ids.len());
    ids.iter().map(|id| identity_key(global_ids, &mut used, *id)).collect()
}

/// Les formes enregistrées : décide quels éléments se dessinent, les maille, remet chacun à la sortie dès qu'il est
/// achevé (`Rules`), écarte les doublons de placement, et note ceux dont la forme est illisible.
fn from_saved(file: &mut rvt::RevitFile, exhaustive: bool, prudent: bool, hard_limit: Option<usize>, retained: &mut Retained, outlet: &mut Outlet<'_>, without: &mut BTreeSet<u64>, unreadable: &mut BTreeMap<u64, Unreadable>, stats: &mut Stats) -> anyhow::Result<saved::Scene> {
    // Quels éléments se dessinent, d'après leur classe et leurs relations.
    let wanted = |scene: &saved::Scene, _id: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
    let threads = thread_count();
    stats.threads = threads;
    // Une forme sans aucune surface peut encore se montrer par la boîte que Revit a enregistrée ; un brouillon (une
    // instance attend son symbole) garde la boîte aussi, le graphe n'étant plus là quand il s'achève.
    let work = |scene: &saved::Scene, id: u64, graph: &rvt::research::native_parameters::ObjectGraph| {
        let shape = saved::shape(scene, id, graph);
        let bounds = if shape.mesh.is_empty() || shape.draft.is_some() { bounds::Bounds::of_graph(graph) } else { None };
        Read { shape, bounds }
    };
    let finish = |scene: &saved::Scene, id: u64, read: &mut Read| {
        if read.shape.draft.is_some() {
            saved::complete(scene, id, &mut read.shape);
            if !read.shape.mesh.is_empty() {
                read.bounds = None;
            }
        }
    };
    let pending = |read: &Read| read.shape.draft.is_some();
    let plan = if exhaustive { saved::Plan::exhaustive() } else { saved::Plan::reading_for(retained) }.prudent(prudent).budget(outlet.budget);
    let plan = match hard_limit {
        Some(limit) => plan.hard_limit(limit),
        None => plan,
    };
    let mut rules = Rules { outlet, stats, unreadable, without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: GEOMETRIC_CLASSES.iter().map(|class| (*class).to_string()).collect(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
    let mut emit = |scene: &saved::Scene, id: u64, read: Read| rules.offer(scene, id, read);
    let mut failure = None;
    let scan = match saved::scan_salvaging(file, &wanted, threads, &work, Some(&finish), &pending, Some(&mut emit), plan, &mut failure) {
        Ok(scan) => scan,
        Err(error) => {
            // La sortie qui ne prend plus rien : l'erreur est la sienne (`prepare_streaming` la rend), rien ne se sauve.
            if rules.outlet.failed() {
                return Err(error);
            }
            // La lecture s'arrête au milieu du fichier : ce que les règles tiennent déjà (sous-éléments qui attendaient
            // leur propriétaire, éléments sans surface, brouillons d'instances) se décide comme à la fin d'une lecture
            // réussie, au lieu de se perdre avec la scène. Les éléments pas encore lus se reconstruisent ensuite, ou non.
            if let Some(saved::Failure { scene, results }) = failure {
                rules.settle(&scene, results, BTreeSet::new())?;
                free_scene(scene);
            }
            return Err(error);
        }
    };
    let saved::Scan { scene, results, without_record, deferred, skipped, decoded, timing } = scan;
    rules.settle(&scene, results, without_record)?;
    let stats = rules.stats;
    stats.saved = timing;
    stats.deferred = deferred;
    stats.skipped = skipped;
    stats.decoded = decoded;
    Ok(scene)
}

/// Ce qu'on retient d'un propriétaire achevé, pour décider de ses sous-éléments : les symboles qu'il place et la boîte
/// de son maillage ; `None` s'il n'a pas de forme.
type OwnerRecord = Option<(BTreeSet<u64>, [[f64; 3]; 2])>;

/// Les règles de dessin appliquées à chaque élément dès que sa forme est achevée, puis à la fin pour ce qui ne pouvait
/// pas se décider avant : chaque élément dessiné part à la sortie (`Outlet`) sans attendre les autres.
///
/// - Un symbole que d'autres éléments placent n'est pas un objet à dessiner à son tour : la règle vaut pour ce qui
///   n'est pas encore remis quand la référence est connue : les sous-éléments, qui attendent leur propriétaire (une
///   course d'escalier est placée par son escalier), et les éléments sans surface, décidés à la fin. Un élément déjà
///   remis qu'un autre élément lu après lui placerait est compté (`Stats::drawn_symbols`), jamais vu sur les fichiers
///   d'essai (les symboles sont des définitions, que la règle de dessin écarte d'avance, ou des sous-éléments).
/// - Un sous-élément (course d'escalier…) qui ne place que des symboles que son propriétaire place déjà est dessiné
///   par lui. Hypothèse : placer les mêmes symboles, et tenir dans la boîte que le propriétaire dessine (à 1 cm près),
///   c'est être la même forme. Il attend donc que son propriétaire soit achevé (s'il doit l'être) ; un sous-élément qui
///   poserait un symbole du propriétaire ailleurs que lui, hors de sa boîte, est gardé.
/// - Le contenu d'une famille sur place (ses formes et ses imports CAD, `classes::is_family_content`, dont la chaîne des propriétaires atteint
///   une `Family` sur place, `saved::Info::in_place_family`) est dessiné par l'instance de la famille, que Revit montre seule : quand une
///   instance est dessinée par sa forme enregistrée avec au moins autant de triangles que tout ce contenu, il n'est pas dessiné ; sinon il l'est,
///   comme avant, et un avertissement le compte (`in_place_warning`). La décision se prend à la fin de la lecture (`release_in_place`) : le
///   contenu attend hors de la sortie, sauf celui d'une famille dont aucune instance ne peut être dessinée, qui part tout de suite. Le contenu
///   suit la règle de visibilité de son instance : quand l'instance de la famille est écartée comme une masse (`RELATION_REASONS[5]`, Revit
///   masque les masses par défaut), son contenu l'est aussi, avec la même raison, compté dans `masses_hidden` (l'avertissement des masses le
///   compte, `in_place_warning` non) ; une instance écartée pour une autre raison (masquée), illisible ou absente laisse le contenu dessiné.
/// - Le même objet posé deux fois (mêmes triangles, au même endroit) est compté, dans l'ordre des remises.
/// - Ce qui porte de la géométrie de modèle, sans qu'il faille connaître chaque classe (gaines et tuyaux flexibles,
///   chemins de câbles, toits rideaux…) : un enregistrement dont la racine est un `SerializedDummy` n'a pas de
///   graphique (styles, matériaux, paramètres, polices… même quand ils portent une catégorie de modèle) : rien à
///   dessiner, rien de perdu ; un vrai graphique (racine `GElement`) est de la géométrie de modèle si l'élément est
///   d'une catégorie de modèle (genre `M` du catalogue) ou d'une classe connue pour l'être ; un élément sans catégorie
///   (axe de profil, ligne de propriété, moyeu, chemin 3D) n'est pas un objet qu'on dessine ; quand le graphique n'a
///   pas pu être décodé du tout, on ne sait rien de lui : la classe ou la catégorie décide (les classes de modèle
///   connues, celles que le catalogue rattache à une catégorie de modèle, toute classe dont un élément a une forme dans
///   ce fichier, et un élément qui porte lui-même une catégorie de modèle, comme un `DirectShape` importé).
///   Les éléments sans surface se décident donc à la fin, quand toutes les formes sont connues. Si la lecture s'arrête sur
///   une erreur, ce que les règles tiennent encore se décide de même, d'après ce qui a été lu (voir
///   `from_saved`).
struct Rules<'a, 's> {
    outlet: &'a mut Outlet<'s>,
    stats: &'a mut Stats,
    unreadable: &'a mut BTreeMap<u64, Unreadable>,
    without: &'a mut BTreeSet<u64>,
    wanted: &'a dyn Fn(&saved::Scene, u64, &saved::Info) -> bool,
    /// Les propriétaires d'éléments voulus, voulus eux-mêmes : leurs sous-éléments les attendent.
    with_children: Option<BTreeSet<u64>>,
    owners: BTreeMap<u64, OwnerRecord>,
    /// Sous-éléments qui attendent leur propriétaire.
    held: BTreeMap<u64, Vec<(u64, saved::Shape)>>,
    seen: HashSet<[u64; 3]>,
    identical: Vec<u64>,
    /// Classes dont un élément a une forme dans ce fichier, et les classes connues pour porter de la géométrie.
    geometric: BTreeSet<String>,
    /// Symboles placés par les éléments lus.
    referenced: BTreeSet<u64>,
    /// Éléments sans surface, décidés à la fin : forme (sans maillage ; `None` : graphe non décodé) et boîte enregistrée.
    later: Vec<(u64, Option<saved::Shape>, Option<bounds::Bounds>)>,
    /// Le contenu des familles sur place, et leurs instances (voir `InPlace`).
    in_place: InPlace,
}

/// Le contenu des familles sur place (`saved::Info::in_place_family`) attend, hors de la sortie, que la lecture soit finie : c'est
/// alors seulement qu'on sait si l'instance de sa famille est dessinée, et ce qu'elle porte (`Rules::release_in_place`).
#[derive(Default)]
struct InPlace {
    /// Par famille sur place, les formes de son contenu que les règles de dessin auraient dessinées, tenues hors de la sortie.
    content: BTreeMap<u64, Vec<(u64, saved::Shape)>>,
    /// Par famille sur place, ses instances remises à la sortie.
    instances: BTreeMap<u64, Vec<InPlaceInstance>>,
    /// Ce que les règles de dessin disent d'avance des instances des familles sur place (calculé à la première forme de contenu) : les
    /// familles dont une instance au moins n'est pas écartée (`drawable` : leur contenu attend la fin de la lecture), et celles qui n'en
    /// ont aucune de dessinable dont une est une masse que Revit masque par défaut (`masses` : leur contenu est une masse aussi). Les
    /// autres (instances masquées pour une autre raison, absentes) dessinent leur contenu tout de suite, comme avant.
    visibility: Option<(BTreeSet<u64>, BTreeSet<u64>)>,
    /// Le contenu des familles qui n'attendent rien, dessiné tout de suite (voir `visibility`) : pour le recensement et l'avertissement.
    drawn_now: BTreeMap<u64, Vec<InPlaceContent>>,
    /// Le contenu des familles dont l'instance est une masse masquée : écarté avec la même raison que l'instance.
    masses: BTreeMap<u64, Vec<InPlaceContent>>,
}

/// La famille sur place dont l'élément `id` est une instance (le symbole qu'il place est de cette famille), s'il en est une.
fn in_place_instance_of(scene: &saved::Scene, id: u64) -> Option<u64> {
    let symbol = scene.infos.get(&id).and_then(|info| u64::try_from(info.master).ok()).and_then(|master| scene.infos.get(&master))?;
    let family = u64::try_from(symbol.family).ok()?;
    scene.infos.get(&family).filter(|info| info.in_place == Some(true)).map(|_| family)
}

impl Rules<'_, '_> {
    fn class_of<'c>(scene: &'c saved::Scene, id: u64) -> &'c str {
        scene.infos.get(&id).map_or("", |info| info.class.as_str())
    }

    /// Une forme achevée arrive.
    fn offer(&mut self, scene: &saved::Scene, id: u64, read: Read) -> anyhow::Result<()> {
        let Read { shape, bounds } = read;
        self.referenced.extend(shape.sources.iter().copied());
        if shape.draft.is_some() {
            // Une instance qui attendait ses symboles et que la lecture, arrêtée avant, n'a pas achevée : sa forme est
            // inconnue, la boîte que Revit a enregistrée la montre (jamais prise pour un élément vide).
            return self.give_up(scene, id, bounds, shape);
        }
        if shape.mesh.is_empty() {
            self.settle_owner(scene, id, None)?;
            self.later.push((id, Some(shape), bounds));
            return Ok(());
        }
        self.geometric.insert(Self::class_of(scene, id).to_string());
        // Un sous-élément attend son propriétaire : il peut être placé par lui (course d'escalier) ou tenir dans sa boîte.
        if let Some(owner) = Self::owner_of(scene, id) {
            if !self.owners.contains_key(&owner) && self.waits_for(scene, owner) {
                self.held.entry(owner).or_default().push((id, shape));
                return Ok(());
            }
        }
        self.decide(scene, id, shape)
    }

    /// Un brouillon jamais achevé (`offer`) : illisible, montré par la boîte enregistrée s'il y en a une, et son propriétaire
    /// n'a plus rien à attendre de lui.
    fn give_up(&mut self, scene: &saved::Scene, id: u64, bounds: Option<bounds::Bounds>, shape: saved::Shape) -> anyhow::Result<()> {
        let class = Self::class_of(scene, id).to_string();
        self.stats.classes.entry(class.clone()).or_default().unreadable += 1;
        let diagnostics = vec!["forme non achevée : la lecture s'est arrêtée avant les symboles de famille que l'instance place".to_string()];
        self.stats.incomplete.insert(id, Incomplete { class: class.clone(), diagnostics, failures: shape.failures, unreadable_graph: false });
        let mesh = bounds.map(|bounds| bounds.mesh(scene.element_paint(id).unwrap_or(Paint::NEUTRAL)));
        self.unreadable.insert(id, Unreadable { class, mesh, why: Refusal::Unread });
        self.settle_owner(scene, id, None)
    }

    fn owner_of(scene: &saved::Scene, id: u64) -> Option<u64> {
        scene.infos.get(&id).and_then(|info| u64::try_from(info.owner).ok())
    }

    /// Une forme dont le propriétaire, s'il y en a un, est connu : placée par un autre élément, elle n'est pas dessinée ;
    /// dessinée par son propriétaire, non plus ; sinon elle l'est.
    fn decide(&mut self, scene: &saved::Scene, id: u64, shape: saved::Shape) -> anyhow::Result<()> {
        if self.referenced.contains(&id) {
            self.stats.classes.entry(Self::class_of(scene, id).to_string()).or_default().symbols += 1;
            return self.settle_owner(scene, id, Self::record(&shape));
        }
        if let Some(record) = Self::owner_of(scene, id).and_then(|owner| self.owners.get(&owner)) {
            if !shape.sources.is_empty() && Self::inside(&shape, record) {
                self.stats.classes.entry(Self::class_of(scene, id).to_string()).or_default().inside_owner += 1;
                return self.settle_owner(scene, id, Self::record(&shape));
            }
        }
        self.draw(scene, id, shape)
    }

    /// Le propriétaire `owner` est voulu et pas encore achevé : ses sous-éléments l'attendent.
    fn waits_for(&mut self, scene: &saved::Scene, owner: u64) -> bool {
        let with_children = self.with_children.get_or_insert_with(|| {
            let wanted = |id: u64| scene.infos.get(&id).is_some_and(|info| (self.wanted)(scene, id, info));
            scene.infos.iter().filter(|(id, _)| wanted(**id)).filter_map(|(_, info)| u64::try_from(info.owner).ok()).filter(|owner| wanted(*owner)).collect()
        });
        with_children.contains(&owner)
    }

    fn record(shape: &saved::Shape) -> OwnerRecord {
        shape.mesh.extent().map(|extent| (shape.sources.clone(), extent))
    }

    /// Le sous-élément ne place que des symboles de son propriétaire et tient dans sa boîte, à 1 cm près.
    fn inside(shape: &saved::Shape, record: &OwnerRecord) -> bool {
        let Some((sources, [low, high])) = record else { return false };
        let Some([own_low, own_high]) = shape.mesh.extent() else { return false };
        shape.sources.is_subset(sources) && (0..3).all(|axis| own_low[axis] >= low[axis] - 0.01 && own_high[axis] <= high[axis] + 0.01)
    }

    /// L'élément `id` est achevé (dessiné ou non) : ce qu'on en retient pour ses sous-éléments, qui sont alors décidés.
    fn settle_owner(&mut self, scene: &saved::Scene, id: u64, record: OwnerRecord) -> anyhow::Result<()> {
        self.owners.insert(id, record);
        if let Some(children) = self.held.remove(&id) {
            for (child, shape) in children {
                self.decide(scene, child, shape)?;
            }
        }
        Ok(())
    }

    /// Dessine une forme : doublons comptés, forme partielle notée, remise à la sortie, puis ses sous-éléments décidés. Le contenu d'une
    /// famille sur place attend la fin de la lecture (`release_in_place`), mais ses sous-éléments n'attendent pas.
    fn draw(&mut self, scene: &saved::Scene, id: u64, shape: saved::Shape) -> anyhow::Result<()> {
        if let Some(family) = scene.infos.get(&id).and_then(|info| info.in_place_family) {
            if classes::is_family_content(Self::class_of(scene, id)) {
                let wanted = self.wanted;
                let (drawable, masses) = self.in_place.visibility.get_or_insert_with(|| {
                    let (mut drawable, mut masses) = (BTreeSet::new(), BTreeSet::new());
                    for (instance, info) in scene.infos.iter().filter(|(_, info)| info.master != -1) {
                        let Some(family) = in_place_instance_of(scene, *instance) else { continue };
                        if wanted(scene, *instance, info) {
                            drawable.insert(family);
                        } else if classes::excluded(&scene.facts(info)) == Some(classes::RELATION_REASONS[5]) {
                            masses.insert(family);
                        }
                    }
                    (drawable, masses)
                });
                let (waits, mass) = (drawable.contains(&family), !drawable.contains(&family) && masses.contains(&family));
                if mass {
                    // L'instance de la famille est une masse, que Revit masque par défaut : son contenu en est une aussi, écarté pour la même raison
                    // (l'avertissement des masses le compte, pas un autre).
                    let content = InPlaceContent { id, class: Self::class_of(scene, id).to_string(), triangles: shape.mesh.triangles(), extent: shape.mesh.extent() };
                    self.in_place.masses.entry(family).or_default().push(content);
                    self.stats.classes.entry(Self::class_of(scene, id).to_string()).or_default().excluded_by_relation += 1;
                    *self.stats.rules.entry(classes::RELATION_REASONS[5]).or_default() += 1;
                    self.stats.masses_hidden += 1;
                    let record = Self::record(&shape);
                    return self.settle_owner(scene, id, record);
                }
                if !waits {
                    // Aucune instance ne peut dessiner ce contenu (masquée, masse que Revit masque par défaut, absente) : dessiné tout de suite.
                    let content = InPlaceContent { id, class: Self::class_of(scene, id).to_string(), triangles: shape.mesh.triangles(), extent: shape.mesh.extent() };
                    self.in_place.drawn_now.entry(family).or_default().push(content);
                    let record = self.draw_now(scene, id, shape)?;
                    return self.settle_owner(scene, id, record);
                }
                let record = Self::record(&shape);
                self.in_place.content.entry(family).or_default().push((id, shape));
                return self.settle_owner(scene, id, record);
            }
            // Un mur, un toit, un sol que la famille possède sans qu'une instance les dessine : des éléments du modèle, dessinés.
            self.stats.in_place_standalone.push((family, id, Self::class_of(scene, id).to_string()));
        }
        let record = self.draw_now(scene, id, shape)?;
        self.settle_owner(scene, id, record)
    }

    /// Remet une forme à la sortie (voir `draw`), sans décider de ses sous-éléments : ce qu'on retient d'elle pour eux.
    fn draw_now(&mut self, scene: &saved::Scene, id: u64, shape: saved::Shape) -> anyhow::Result<OwnerRecord> {
        let class = Self::class_of(scene, id).to_string();
        if !self.seen.insert(shape.mesh.fingerprint()) {
            self.identical.push(id);
        }
        let row = self.stats.classes.entry(class.clone()).or_default();
        row.drawn += 1;
        row.double_sided += usize::from(shape.mesh.open);
        let source = u8::from(shape.partial());
        if shape.partial() {
            self.stats.incomplete.insert(id, Incomplete { class: class.clone(), diagnostics: shape.diagnostics.clone(), failures: shape.failures.clone(), unreadable_graph: false });
        }
        let record = Self::record(&shape);
        // Une instance d'une famille sur place : ce qu'elle dessine, pour décider du contenu de sa famille.
        let instance = in_place_instance_of(scene, id).map(|family| (family, shape.mesh.triangles(), record.as_ref().map(|(_, extent)| *extent)));
        self.outlet.emit(id, class, source, shape.mesh)?;
        if let Some((family, triangles, extent)) = instance {
            // La source remise, que le budget de triangles du fichier a pu changer en boîte.
            let source = self.outlet.prepared.sources.last().copied().unwrap_or(source);
            self.in_place.instances.entry(family).or_default().push(InPlaceInstance { id, source, triangles, extent });
        }
        Ok(record)
    }

    /// Tout est lu : le contenu de chaque famille sur place est écarté quand une instance de la famille est dessinée par sa forme
    /// (source 0 ou 1, pas par sa boîte) avec au moins autant de triangles que tout le contenu ; sinon il est dessiné comme les autres
    /// formes, jamais perdu : l'instance est masquée, vide, illisible, ou ne porte pas tout ce que la famille a écrit.
    fn release_in_place(&mut self, scene: &saved::Scene) -> anyhow::Result<()> {
        for (family, content) in std::mem::take(&mut self.in_place.content) {
            let instances = self.in_place.instances.remove(&family).unwrap_or_default();
            let triangles: usize = content.iter().map(|(_, shape)| shape.mesh.triangles()).sum();
            let excluded = instances.iter().any(|instance| instance.source <= 1 && instance.triangles >= triangles);
            let described: Vec<InPlaceContent> = content.iter().map(|(id, shape)| InPlaceContent { id: *id, class: Self::class_of(scene, *id).to_string(), triangles: shape.mesh.triangles(), extent: shape.mesh.extent() }).collect();
            if excluded {
                for (id, _) in &content {
                    let row = self.stats.classes.entry(Self::class_of(scene, *id).to_string()).or_default();
                    row.excluded_by_relation += 1;
                    *self.stats.rules.entry(classes::RELATION_REASONS[8]).or_default() += 1;
                }
            } else {
                for (id, shape) in content {
                    self.draw_now(scene, id, shape)?;
                }
            }
            self.stats.in_place.push(InPlaceFamily { family, content: described, instances, excluded, mass: false });
        }
        // Le contenu que rien ne pouvait remplacer, dessiné dès sa remise.
        for (family, content) in std::mem::take(&mut self.in_place.drawn_now) {
            let instances = self.in_place.instances.remove(&family).unwrap_or_default();
            self.stats.in_place.push(InPlaceFamily { family, content, instances, excluded: false, mass: false });
        }
        // Le contenu des masses masquées : jamais dessiné, comme leur instance.
        for (family, content) in std::mem::take(&mut self.in_place.masses) {
            self.stats.in_place.push(InPlaceFamily { family, content, instances: Vec::new(), excluded: false, mass: true });
        }
        Ok(())
    }

    /// Tout est lu : les sous-éléments dont le propriétaire n'est jamais venu, les éléments sans surface, les comptes.
    fn settle(&mut self, scene: &saved::Scene, results: BTreeMap<u64, Option<Read>>, without_record: BTreeSet<u64>) -> anyhow::Result<()> {
        self.stats.mesh_limit = scene.hard_limit;
        for (_, children) in std::mem::take(&mut self.held) {
            for (child, shape) in children {
                self.decide(scene, child, shape)?;
            }
        }
        // Les éléments qui restent au balayage : ceux sans graphe décodé (`None`), et ce que les sondes n'ont pas remis.
        for (id, result) in results {
            match result {
                Some(read) => self.offer(scene, id, read)?,
                None => self.later.push((id, None, None)),
            }
        }
        // Toutes les instances sont remises : le contenu des familles sur place se décide.
        self.release_in_place(scene)?;
        let geometric = &self.geometric;
        let is_model_class = |id: u64| geometric.contains(Self::class_of(scene, id)) || crate::catalog::class_category(Self::class_of(scene, id)).is_some_and(|category| category.kind == 'M');
        // Le recensement par classe : tous les enregistrements d'éléments du fichier.
        for (&id, info) in &scene.infos {
            let row = self.stats.classes.entry(info.class.clone()).or_default();
            row.elements += 1;
            if let Some(reason) = classes::excluded_class(&info.class) {
                row.excluded = Some(reason);
                *self.stats.rules.entry(reason).or_default() += 1;
            } else if let Some(reason) = classes::excluded_relation(&scene.facts(info)) {
                row.excluded_by_relation += 1;
                *self.stats.rules.entry(reason).or_default() += 1;
                // Une masse que la vue 3D ne montre pas : seul un enregistrement dont la classe porte de la géométrie compte
                // (une instance de famille de masse, une forme volumique), pas la catégorie Masses elle-même ni ses styles.
                if reason == classes::RELATION_REASONS[5] && is_model_class(id) {
                    self.stats.masses_hidden += 1;
                }
            } else if info.family_owner == saved::FamilyOwner::Unread {
                // Pas écarté, et possédé par une `Family` dont la nature ne se lit pas : compté s'il est dessiné (`family_warning`).
                self.stats.family_unread.insert(id);
            }
        }
        // Un import CAD du projet (`ImportInstance`) est un élément du modèle : Revit le montre en 3D (sauf s'il est propre à une vue, ce que la règle de
        // relation écarte avant). Un import dont la forme ne se lit qu'en partie se dessine « partielle », un import illisible par sa boîte, et un
        // import sans surface (des lignes) est compté sans géométrie : rien n'est écarté en silence comme un élément qui n'en est pas un.
        let is_model_element = |id: u64| is_model_class(id) || Self::class_of(scene, id) == classes::IMPORT_CLASS || scene.infos.get(&id).and_then(|info| scene.category(info)).and_then(crate::catalog::category).is_some_and(|category| category.kind == 'M');
        for (id, shape, bounds) in std::mem::take(&mut self.later) {
            let class = Self::class_of(scene, id).to_string();
            let row = self.stats.classes.entry(class.clone()).or_default();
            if self.referenced.contains(&id) {
                row.symbols += 1;
                continue;
            }
            match shape {
                Some(shape) if nothing_to_lose(&shape, is_model_element(id), bounds.is_some()) => row.not_geometric += 1,
                None if !is_model_element(id) => row.not_geometric += 1,
                // Un graphe refusé : la forme existe sans doute mais n'a pas pu se lire. La classe ou la catégorie décide.
                None => {
                    row.unreadable += 1;
                    self.stats.incomplete.insert(id, Incomplete { class: class.clone(), unreadable_graph: true, ..Incomplete::default() });
                    self.unreadable.insert(id, Unreadable { class, mesh: None, why: Refusal::Unread });
                }
                // Des diagnostics sans aucune surface, ou une forme refusée (trop dense, ou pas maillée à cause du plafond du
                // fichier) : la forme existe sans doute mais n'a pas pu se lire. L'étendue que Revit a enregistrée, s'il y
                // en a une, en fait une boîte, de la couleur du matériau de l'élément (à défaut, le gris neutre).
                Some(shape) if shape.partial() || shape.too_dense || shape.capped => {
                    row.unreadable += 1;
                    let why = if shape.capped {
                        Refusal::Capped
                    } else if shape.too_dense {
                        Refusal::TooDense
                    } else {
                        Refusal::Unread
                    };
                    let mesh = bounds.map(|bounds| bounds.mesh(scene.element_paint(id).unwrap_or(Paint::NEUTRAL)));
                    self.stats.incomplete.insert(id, Incomplete { class: class.clone(), diagnostics: shape.diagnostics, failures: shape.failures, unreadable_graph: false });
                    self.unreadable.insert(id, Unreadable { class, mesh, why });
                }
                Some(_) => {
                    row.empty += 1;
                    self.without.insert(id);
                }
            }
        }
        self.stats.drawn_symbols = self.referenced.iter().filter(|id| self.outlet.drawn(**id)).count();
        self.stats.identical = self.identical.len();
        for id in &self.identical {
            self.stats.classes.entry(Self::class_of(scene, *id).to_string()).or_default().identical += 1;
        }
        // Des éléments d'une classe qui porte de la géométrie, sans enregistrement graphique.
        for id in without_record {
            if is_model_class(id) {
                self.stats.classes.entry(Self::class_of(scene, id).to_string()).or_default().empty += 1;
                self.without.insert(id);
            }
        }
        Ok(())
    }
}

/// Un élément sans maillage ne porte-t-il rien qu'on perde en ne le dessinant pas ? Oui s'il n'a pas de graphique
/// (style, matériau, paramètre…) ou si ce n'est pas un objet du modèle (axe de profil, ligne de propriété…). Non
/// pour une forme refusée parce qu'elle est trop dense (`saved::Shape::too_dense`) : c'est bien de la géométrie, que sa
/// boîte englobante montre à sa place (source 3) quelle que soit sa classe. Elle était écartée en silence quand la
/// classe n'était pas connue pour porter de la géométrie, ce qui arrive dès qu'aucun élément de cette classe n'a de
/// forme gardée (les deux sculptures `DirectShape` de `revit-curtainwall-byprofile_v21`, quand leurs faces d'Hermite
/// dépassaient le plafond d'un élément).
///
/// Une forme que le plafond de maillage n'a pas laissé mailler (`saved::Shape::capped`) n'a pas été regardée : on ne sait
/// pas si elle avait des surfaces. Sans graphique, il n'y a rien à perdre ; avec un graphique, la boîte que Revit a
/// enregistrée (`has_box`) dit que l'élément a une étendue, qu'il faut montrer ; sans boîte, seul un élément du modèle
/// compte (un axe de profil ou une ligne de propriété sans étendue ne se dessinait pas non plus).
fn nothing_to_lose(shape: &saved::Shape, model_element: bool, has_box: bool) -> bool {
    if shape.too_dense {
        return false;
    }
    if shape.capped {
        return !shape.graphics || (!model_element && !has_box);
    }
    !shape.graphics || !model_element
}

/// Libère les graphes décodés, qui coûtent des centaines de millisecondes à détruire : à part,
/// sur un autre fil, quand il y en a.
fn free_scene(scene: saved::Scene) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::thread::spawn(move || drop(scene));
    }
    #[cfg(target_arch = "wasm32")]
    {
        drop(scene);
    }
}

/// Nombre de fils de maillage : tous les cœurs, ou `REVIT_THREADS` (pour mesurer un seul fil, comme
/// en WebAssembly).
fn thread_count() -> usize {
    #[cfg(not(target_arch = "wasm32"))]
    {
        if let Some(count) = std::env::var("REVIT_THREADS").ok().and_then(|value| value.parse::<usize>().ok()) {
            return count.max(1);
        }
        std::thread::available_parallelism().map_or(1, |count| count.get())
    }
    #[cfg(target_arch = "wasm32")]
    {
        1
    }
}

/// Chronomètre : `std::time::Instant` plante en WebAssembly, où l'on lit l'horloge du navigateur
/// (`Date.now`, à la milliseconde).
pub struct Stopwatch {
    #[cfg(not(target_arch = "wasm32"))]
    start: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    start: f64,
}

impl Stopwatch {
    pub fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            start: std::time::Instant::now(),
            #[cfg(target_arch = "wasm32")]
            start: js_sys::Date::now(),
        }
    }

    pub fn seconds(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.start.elapsed().as_secs_f64()
        }
        #[cfg(target_arch = "wasm32")]
        {
            (js_sys::Date::now() - self.start) / 1000.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pack::Face;

    fn shape(graphics: bool, too_dense: bool) -> saved::Shape {
        saved::Shape { mesh: ElementMesh::default(), sources: BTreeSet::new(), diagnostics: Vec::new(), unbounded_faces: 0, failures: Vec::new(), graphics, too_dense, capped: false, draft: None }
    }

    #[test]
    fn une_forme_trop_dense_n_est_jamais_ecartee_en_silence() {
        // Sans graphique ou hors du modèle : rien à perdre.
        assert!(nothing_to_lose(&shape(false, false), true, false));
        assert!(nothing_to_lose(&shape(true, false), false, false));
        // Un objet du modèle sans surface : rien non plus (c'est la règle des éléments vides qui le dit).
        assert!(!nothing_to_lose(&shape(true, false), true, false));
        // Refusée pour sa densité : de la géométrie, qui passe par sa boîte, de quelque classe qu'elle soit.
        assert!(!nothing_to_lose(&shape(true, true), false, false));
        assert!(!nothing_to_lose(&shape(true, true), true, false));
        // Pas maillée parce que le plafond du fichier est atteint : elle n'a pas été regardée. Un style, un matériau (pas de
        // graphique) n'a rien à perdre ; un élément du modèle, ou n'importe quel graphique qui a une boîte enregistrée, si.
        let capped = |graphics: bool| saved::Shape { capped: true, ..shape(graphics, false) };
        assert!(nothing_to_lose(&capped(false), true, true));
        assert!(!nothing_to_lose(&capped(true), true, false));
        assert!(!nothing_to_lose(&capped(true), false, true));
        // Sans boîte, un graphique qui n'est pas du modèle (axe de profil, ligne de propriété) ne se dessinait pas non plus.
        assert!(nothing_to_lose(&capped(true), false, false));
    }

    /// Une bande plane de `cells` × 2 triangles, de `cells` pieds de long.
    fn strip(cells: u32) -> ElementMesh {
        let mut vertices = Vec::new();
        for i in 0..=cells {
            vertices.push([f64::from(i), 0.0, 0.0]);
            vertices.push([f64::from(i), 1.0, 0.0]);
        }
        let mut triangles = Vec::new();
        for i in 0..cells {
            let k = 2 * i;
            triangles.push([k, k + 2, k + 1]);
            triangles.push([k + 1, k + 2, k + 3]);
        }
        ElementMesh::build(&[Face { vertices: &vertices, normals: None, triangles: &triangles, paint: Paint::NEUTRAL, depth: pack::Depth::Ordinary }])
    }

    /// Remet `cells` (identifiant, longueur de bande) à un `Outlet` au budget `budget` : (sources, triangles) remis, et le
    /// nombre d'éléments passés en boîte.
    fn emitted(cells: &[(u64, u32)], budget: usize) -> (Vec<(u64, u8, usize, ElementMesh)>, usize) {
        let mut out = Vec::new();
        let mut sink = |emitted: Emitted| {
            out.push((emitted.id, emitted.source, emitted.mesh.triangles(), emitted.mesh));
            Ok(())
        };
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        for (id, n) in cells {
            outlet.emit(*id, "Floor".into(), 0, strip(*n)).expect("remise");
        }
        let trimmed = outlet.trimmed;
        assert_eq!(outlet.prepared.keys, cells.iter().map(|(id, _)| format!("rvt-{id}")).collect::<Vec<_>>());
        drop(outlet);
        (out, trimmed)
    }

    #[test]
    fn sous_le_budget_rien_ne_change() {
        let (out, trimmed) = emitted(&[(1, 100), (2, 50)], 300); // 300 triangles au total
        assert_eq!(trimmed, 0);
        assert!(out.iter().all(|(_, source, _, _)| *source == 0));
    }

    #[test]
    fn au_dela_du_budget_ce_qui_ne_tient_plus_devient_une_boite() {
        // 400 + 200 + 200 + 20 triangles, budget 500, dans l'ordre des remises : le deuxième ne tient plus (600), boîte de
        // 12 ; le troisième non plus (412 + 200) ; le quatrième tient (424 + 20) et reste dessiné.
        let (out, trimmed) = emitted(&[(1, 200), (2, 100), (3, 100), (4, 10)], 500);
        assert_eq!(trimmed, 2);
        assert_eq!(out.iter().map(|(id, source, triangles, _)| (*id, *source, *triangles)).collect::<Vec<_>>(), vec![(1, 0, 400), (2, 3, 12), (3, 3, 12), (4, 0, 20)]);
        // La boîte est celle de la bande, en mètres : 100 pieds sur 1 pied, d'épaisseur minimale.
        let [low, high] = out[1].3.extent().expect("boîte");
        assert!((high[0] - low[0] - 100.0 * pack::FOOT).abs() < 1e-6, "{low:?} {high:?}");
    }

    #[test]
    fn le_budget_ne_vide_jamais_un_fichier() {
        // Même sous un budget impossible, chaque élément reste dessiné (par sa boîte, 12 triangles).
        let (out, trimmed) = emitted(&[(1, 100), (2, 100)], 1);
        assert_eq!(trimmed, 2);
        assert!(out.iter().all(|(_, source, triangles, _)| *source == 3 && *triangles == 12));
    }

    // --- La sortie qui refuse un élément (P1) et les formes que le plafond de maillage refuse (P5).

    /// Un puits qui accepte `accepted` éléments, puis refuse tous les suivants.
    fn failing_after(accepted: usize, taken: &mut Vec<u64>) -> impl FnMut(Emitted) -> anyhow::Result<()> + '_ {
        move |emitted| {
            if taken.len() >= accepted {
                anyhow::bail!("mémoire insuffisante : le morceau n'a pas pu être transmis");
            }
            taken.push(emitted.id);
            Ok(())
        }
    }

    #[test]
    fn un_puits_qui_refuse_met_fin_a_la_lecture_avec_son_erreur() {
        let mut taken = Vec::new();
        let mut sink = failing_after(1, &mut taken);
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: usize::MAX, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        outlet.emit(1, "Floor".into(), 0, strip(3)).expect("le premier est pris");
        assert!(!outlet.failed());
        // Le deuxième est refusé : le balayage ne voit qu'un témoin, l'erreur d'origine reste à la sortie.
        let witness = outlet.emit(2, "Floor".into(), 0, strip(3)).expect_err("refusé");
        assert!(outlet.failed());
        assert!(!format!("{witness:#}").starts_with("mémoire insuffisante"), "{witness:#}");
        // Plus rien n'est remis au puits ensuite.
        assert!(outlet.emit(3, "Floor".into(), 0, strip(3)).is_err());
        let error = outlet.raise(witness);
        assert!(format!("{error:#}").starts_with("mémoire insuffisante : le morceau"), "{error:#}");
        // Hors du balayage (reconstruction, boîtes), `put` rend directement l'erreur du puits.
        let mut none = Vec::new();
        let mut refusing = failing_after(0, &mut none);
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: usize::MAX, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut refusing, sink_error: None };
        let error = outlet.put(1, "Floor".into(), 0, strip(3)).expect_err("refusé");
        assert!(format!("{error:#}").starts_with("mémoire insuffisante : le morceau"), "{error:#}");
        drop(outlet);
        drop(sink);
        assert_eq!(taken, vec![1], "le puits n'a rien reçu après son refus");
    }

    fn element(class: &str) -> saved::Info {
        saved::Info { class: class.to_string(), view: -1, owner: -1, unplaced: -1, hidden: false, master: -1, family: -1, category: -1, in_place: None, family_owner: saved::FamilyOwner::Elsewhere, in_place_family: None }
    }

    /// Une forme sans maillage : refusée parce que trop dense (`too_dense`), parce que le plafond est atteint (`capped`),
    /// ou illisible (ni l'un ni l'autre : un diagnostic).
    fn refused(too_dense: bool, capped: bool) -> saved::Shape {
        saved::Shape { diagnostics: vec!["refusée".to_string()], graphics: true, too_dense, capped, ..shape(true, false) }
    }

    fn boxed_at(x: f64) -> Option<bounds::Bounds> {
        bounds::Bounds::new([x, 0.0, 0.0], [x + 10.0, 10.0, 10.0])
    }

    #[test]
    fn les_formes_refusees_se_comptent_une_fois_dans_l_avertissement_de_leur_cause() {
        // 1 : pas maillée (plafond), boîte enregistrée ; 2 : de même, sans boîte ; 3 : trop dense, avec boîte ; 4 : trop
        // dense, sans boîte ; 5 : illisible, avec boîte ; 6 : une forme maillée.
        let scene = saved::Scene::for_tests((1..=6).map(|id| (id, element("Floor"))).collect(), 1234);
        let mut taken = Vec::new();
        let mut sink = |emitted: Emitted| {
            taken.push((emitted.id, emitted.source, emitted.mesh.triangles()));
            Ok(())
        };
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |_: &saved::Scene, _: u64, _: &saved::Info| true;
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: BTreeSet::new(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        for (id, shape, bounds) in [
            (1, refused(false, true), boxed_at(0.0)),
            (2, refused(false, true), None),
            (3, refused(true, false), boxed_at(20.0)),
            (4, refused(true, false), None),
            (5, refused(false, false), boxed_at(40.0)),
            (6, saved::Shape { mesh: strip(5), graphics: true, ..shape(true, false) }, None),
        ] {
            rules.offer(&scene, id, Read { shape, bounds }).expect("remise");
        }
        rules.settle(&scene, BTreeMap::new(), BTreeSet::new()).expect("décisions");
        assert_eq!(stats.mesh_limit, 1234);
        emit_refused(&mut outlet, &mut stats, unreadable).expect("boîtes");
        stats.trimmed = outlet.trimmed;
        drop(outlet);

        // Chaque élément est compté une fois, dans sa cause : ni « trop dense » pour le plafond, ni « illisible » pour l'un
        // ni pour l'autre.
        assert_eq!((stats.too_dense, stats.too_dense_undrawn), (1, 1));
        assert_eq!((stats.capped, stats.capped_undrawn, stats.trimmed), (1, 1, 1));
        assert_eq!((stats.boxed, stats.undrawn), (1, 0));
        // Remis : la forme maillée (source 0) et les trois boîtes (source 3, 12 triangles) ; les deux sans boîte ne le sont pas.
        assert_eq!(taken, vec![(6, 0, 10), (1, 3, 12), (3, 3, 12), (5, 3, 12)]);

        let warnings = refusal_warnings(&stats, 500);
        let text = warnings.join("\n");
        assert_eq!(warnings.len(), 5, "{text}");
        assert!(warnings[0].starts_with("1 élément a une forme que Revit a enregistrée mais que ce lecteur ne sait pas encore lire : il est montré"), "{text}");
        assert!(warnings[1].starts_with("1 élément a une forme de plus de 250000 triangles") && warnings[1].ends_with("il est montré par sa boîte englobante et marqué « Inconnue »."), "{text}");
        assert!(warnings[2].starts_with("1 élément a une forme de plus de 250000 triangles") && warnings[2].ends_with("il n'est pas dessiné."), "{text}");
        assert!(warnings[3].starts_with("Le fichier dépasse 500 triangles") && warnings[3].contains("l'élément dont la forme ne tenait plus dans ce budget est montré"), "{text}");
        assert!(warnings[4].starts_with("Le fichier dépasse 1234 triangles maillés") && warnings[4].contains("1 élément n'a pas été maillé") && warnings[4].ends_with("il n'est pas dessiné."), "{text}");
    }

    /// Un import CAD du projet (`ImportInstance`) est un élément du modèle : sa forme illisible se montre par la boîte que Revit a enregistrée (source 3,
    /// « Inconnue ») au lieu d'être écartée en silence, comme l'était un élément d'une classe qui n'en est pas un (ici une classe qu'aucune table ne connaît).
    /// Un import qui n'a aucune surface (des lignes) est compté sans géométrie, comme tout élément du modèle.
    #[test]
    fn un_import_cad_dont_la_forme_est_illisible_est_montre_par_sa_boite() {
        let scene = saved::Scene::for_tests([(1, element("ImportInstance")), (2, element("ImportInstance")), (3, element("ClasseInconnue"))].into_iter().collect(), 1000);
        let mut sink = |_: Emitted| Ok(());
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |_: &saved::Scene, _: u64, _: &saved::Info| true;
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: GEOMETRIC_CLASSES.iter().map(|class| (*class).to_string()).collect(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        // 1 : un import illisible avec boîte ; 2 : un import de lignes seulement (graphique, aucun diagnostic, aucune surface) ; 3 : une classe inconnue
        // à la forme illisible, avec boîte.
        for (id, shape, bounds) in [(1, refused(false, false), boxed_at(0.0)), (2, shape(true, false), None), (3, refused(false, false), boxed_at(20.0))] {
            rules.offer(&scene, id, Read { shape, bounds }).expect("remise");
        }
        rules.settle(&scene, BTreeMap::new(), BTreeSet::new()).expect("décisions");
        assert!(unreadable.get(&1).is_some_and(|element| element.mesh.is_some() && element.why == Refusal::Unread), "l'import illisible est montré par sa boîte");
        assert_eq!(stats.classes["ImportInstance"].unreadable, 1);
        assert!(without.contains(&2), "l'import sans surface est compté sans géométrie");
        assert!(!unreadable.contains_key(&3) && !without.contains(&3), "la classe inconnue reste écartée comme avant");
        assert_eq!(stats.classes["ClasseInconnue"].not_geometric, 1);
    }

    #[test]
    fn un_brouillon_que_la_lecture_n_a_pas_acheve_est_montre_par_sa_boite() {
        // Une instance qui attendait ses symboles quand la lecture s'est arrêtée : jamais prise pour un élément vide.
        let scene = saved::Scene::for_tests((1..=2).map(|id| (id, element("FamilyInstance"))).collect(), 1000);
        let mut sink = |_: Emitted| Ok(());
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |_: &saved::Scene, _: u64, _: &saved::Info| true;
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: BTreeSet::new(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        let draft = |bounds| Read { shape: saved::Shape { draft: Some(faces::Meshes::default()), ..shape(true, false) }, bounds };
        let results: BTreeMap<u64, Option<Read>> = BTreeMap::from([(1, Some(draft(boxed_at(0.0)))), (2, Some(draft(None)))]);
        rules.settle(&scene, results, BTreeSet::new()).expect("décisions");
        assert!(without.is_empty(), "un brouillon n'est pas un élément vide : {without:?}");
        assert_eq!(unreadable.len(), 2);
        assert!(unreadable[&1].mesh.is_some() && unreadable[&2].mesh.is_none());
        assert!(unreadable.values().all(|element| element.why == Refusal::Unread));
        assert_eq!(stats.classes["FamilyInstance"].unreadable, 2);
    }

    #[test]
    fn l_avertissement_des_masses_ne_compte_que_les_enregistrements_a_geometrie() {
        // Tout modèle porte les enregistrements de la catégorie Masses elle-même (`CategoryElem`) et ses styles
        // (`GStyleElem`) : la règle des masses les écarte, mais ce ne sont pas des masses que la vue 3D omet. Une instance de
        // famille de masse (`FamilyInstance`) et une forme de masse (`FormElem`) en sont.
        let mass = crate::catalog::category_by_ost("OST_Mass").expect("catégorie Masses").id;
        let infos: BTreeMap<u64, saved::Info> = [(1, "CategoryElem"), (2, "CategoryElem"), (3, "GStyleElem"), (4, "FamilyInstance"), (5, "FormElem")]
            .into_iter()
            .map(|(id, class)| (id, saved::Info { category: mass, ..element(class) }))
            .collect();
        let scene = saved::Scene::for_tests(infos, 1000);
        let mut sink = |_: Emitted| Ok(());
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |_: &saved::Scene, _: u64, _: &saved::Info| true;
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: GEOMETRIC_CLASSES.iter().map(|class| (*class).to_string()).collect(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        rules.settle(&scene, BTreeMap::new(), BTreeSet::new()).expect("décisions");
        // Le recensement garde tous les enregistrements écartés par la règle ; l'avertissement n'en compte que deux.
        assert_eq!(stats.rules[classes::RELATION_REASONS[5]], 5);
        assert_eq!(stats.masses_hidden, 2);
    }

    /// Une scène avec une famille sur place (10), son symbole (11), son instance (12) et ce que la famille possède : deux formes (13 et
    /// 15 : une extrusion et un balayage) et un mur (14).
    fn scene_in_place(hidden: bool, mass: bool) -> saved::Scene {
        let owned = |class: &str| saved::Info { owner: 10, in_place_family: Some(10), ..element(class) };
        let infos = BTreeMap::from([
            (10, saved::Info { in_place: Some(true), ..element("Family") }),
            (11, saved::Info { family: 10, ..element("FamilySymbol") }),
            (12, saved::Info { master: 11, hidden, category: if mass { crate::catalog::category_by_ost("OST_Mass").expect("catégorie Masses").id } else { -1 }, ..element("FamilyInstance") }),
            (13, owned("ExtrusionElem")),
            (14, owned("SWall")),
            (15, owned("SweepElem")),
        ]);
        saved::Scene::for_tests(infos, 1000)
    }

    /// Lit `scene_in_place` en remettant ces formes (identifiant, cases d'une bande : 2 triangles chacune), dans cet ordre, puis en
    /// décidant : ce que la sortie a reçu (identifiant, source) et le recensement.
    fn lire_en_place(offers: &[(u64, u32)]) -> (Vec<(u64, u8)>, Stats) {
        lire_en_place_avec(offers, false, false)
    }

    /// [`lire_en_place`], l'instance 12 étant masquée (`hidden`), une masse (`mass`, que Revit masque par défaut) ou ni l'un ni l'autre : une
    /// instance masquée ou masse est écartée d'avance par les règles de dessin.
    fn lire_en_place_avec(offers: &[(u64, u32)], hidden: bool, mass: bool) -> (Vec<(u64, u8)>, Stats) {
        let scene = scene_in_place(hidden, mass);
        let mut taken = Vec::new();
        let mut sink = |emitted: Emitted| {
            taken.push((emitted.id, emitted.source));
            Ok(())
        };
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |scene: &saved::Scene, _: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: GEOMETRIC_CLASSES.iter().map(|class| (*class).to_string()).collect(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        for (id, cells) in offers {
            // Une forme dessinée a de la surface : la bande, décalée pour que deux formes ne soient pas les mêmes triangles.
            let shape = saved::Shape { mesh: strip(*cells), graphics: true, ..shape(true, false) };
            rules.offer(&scene, *id, Read { shape, bounds: None }).expect("remise");
        }
        rules.settle(&scene, BTreeMap::new(), BTreeSet::new()).expect("décisions");
        drop(outlet);
        (taken, stats)
    }

    #[test]
    fn le_contenu_d_une_famille_sur_place_est_dessine_par_son_instance() {
        // La forme 13 (6 triangles) et le mur 14 (2) sont remis avant l'instance 12 (6 triangles) : la forme attend, le mur est un
        // élément du modèle et part tout de suite ; l'instance porte autant de triangles que la forme, la forme est écartée.
        let (taken, stats) = lire_en_place(&[(13, 3), (14, 1), (12, 3)]);
        assert_eq!(taken, vec![(14, 0), (12, 0)], "ni la forme, ni rien d'autre n'est perdu");
        assert_eq!(stats.rules[classes::RELATION_REASONS[8]], 1);
        assert_eq!(stats.classes["ExtrusionElem"].excluded_by_relation, 1);
        assert_eq!(stats.classes["ExtrusionElem"].drawn, 0);
        assert_eq!(stats.in_place.len(), 1);
        let family = &stats.in_place[0];
        assert!(family.excluded && family.family == 10);
        assert_eq!(family.content.iter().map(|content| (content.id, content.triangles)).collect::<Vec<_>>(), vec![(13, 6)]);
        assert_eq!(family.instances.iter().map(|instance| (instance.id, instance.source, instance.triangles)).collect::<Vec<_>>(), vec![(12, 0, 6)]);
        // Le mur que la famille possède est dessiné, et compté à part : ce n'est pas une forme de sa définition.
        assert_eq!(stats.in_place_standalone, vec![(10, 14, "SWall".to_string())]);
        // L'ordre des remises ne change rien : l'instance d'abord, la forme ensuite.
        let (taken, stats) = lire_en_place(&[(12, 3), (14, 1), (13, 3)]);
        assert_eq!(taken, vec![(12, 0), (14, 0)]);
        assert_eq!(stats.rules[classes::RELATION_REASONS[8]], 1);
        // Plusieurs formes : toutes écartées quand l'instance porte la somme de leurs triangles (6 + 4 = 10).
        let (taken, stats) = lire_en_place(&[(13, 3), (15, 2), (12, 5)]);
        assert_eq!(taken, vec![(12, 0)]);
        assert_eq!(stats.rules[classes::RELATION_REASONS[8]], 2);
    }

    #[test]
    fn le_contenu_d_une_famille_sur_place_sans_instance_dessinee_reste_dessine() {
        // Aucune instance remise (masquée, vide, illisible ou absente) : la forme est dessinée comme avant, à la fin de la lecture, et
        // l'avertissement la compte ; jamais perdue.
        let (taken, stats) = lire_en_place(&[(13, 3), (14, 1)]);
        assert_eq!(taken, vec![(14, 0), (13, 0)]);
        assert!(!stats.rules.contains_key(classes::RELATION_REASONS[8]));
        assert_eq!(stats.classes["ExtrusionElem"].drawn, 1);
        assert!(!stats.in_place[0].excluded && stats.in_place[0].instances.is_empty());
        // Une instance qui porte moins de triangles que les formes (6 + 4 contre 8) ne les contient pas toutes : toutes restent.
        let (taken, stats) = lire_en_place(&[(13, 3), (15, 2), (12, 4)]);
        assert_eq!(taken, vec![(12, 0), (13, 0), (15, 0)]);
        assert!(!stats.in_place[0].excluded);
        assert!(!stats.rules.contains_key(classes::RELATION_REASONS[8]));
        // Une instance que la lecture n'a pas dessinée par sa forme (ici : une boîte, source 3) ne compte pas. Ce cas ne se produit que
        // par le budget de triangles du fichier (`Outlet::emit`) : l'instance est alors remplacée par sa boîte.
        let scene = scene_in_place(false, false);
        let mut taken = Vec::new();
        let mut sink = |emitted: Emitted| {
            taken.push((emitted.id, emitted.source));
            Ok(())
        };
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 4, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |scene: &saved::Scene, _: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: GEOMETRIC_CLASSES.iter().map(|class| (*class).to_string()).collect(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        for (id, cells) in [(12, 3), (13, 3)] {
            rules.offer(&scene, id, Read { shape: saved::Shape { mesh: strip(cells), graphics: true, ..shape(true, false) }, bounds: None }).expect("remise");
        }
        rules.settle(&scene, BTreeMap::new(), BTreeSet::new()).expect("décisions");
        drop(outlet);
        assert_eq!(taken.iter().map(|(id, _)| *id).collect::<Vec<_>>(), vec![12, 13], "l'instance est une boîte, la forme reste dessinée");
        assert_eq!(taken[0].1, 3);
        assert!(!stats.in_place[0].excluded);
    }

    #[test]
    fn le_contenu_d_une_famille_sans_instance_voulue_se_dessine_tout_de_suite() {
        // L'instance est masquée (ou c'est une masse que Revit masque par défaut) : aucune ne peut dessiner la forme, qui garde sa place
        // dans l'ordre des remises (13 avant le mur 14), comme avant, et que l'avertissement compte.
        let (taken, stats) = lire_en_place_avec(&[(13, 3), (14, 1)], true, false);
        assert_eq!(taken, vec![(13, 0), (14, 0)]);
        assert!(!stats.in_place[0].excluded && stats.in_place[0].content.len() == 1);
        assert!(!stats.rules.contains_key(classes::RELATION_REASONS[8]));
    }

    #[test]
    fn le_contenu_d_une_famille_dont_l_instance_est_une_masse_est_une_masse() {
        // L'instance 12 est une masse (catégorie Masses) que Revit masque par défaut : la règle des masses l'écarte, et le contenu de sa
        // famille (la forme 13) l'est avec la même raison, comptée dans `masses_hidden` ; le mur 14, un élément du modèle, reste dessiné.
        let (taken, stats) = lire_en_place_avec(&[(13, 3), (14, 1)], false, true);
        assert_eq!(taken, vec![(14, 0)], "la forme de la masse n'est pas dessinée");
        assert_eq!(stats.rules[classes::RELATION_REASONS[5]], 2, "l'instance et sa forme");
        assert_eq!(stats.masses_hidden, 2);
        assert_eq!(stats.classes["ExtrusionElem"].excluded_by_relation, 1);
        assert!(stats.in_place[0].mass && !stats.in_place[0].excluded && stats.in_place[0].content.len() == 1);
        // Pas de raison propre au contenu de famille sur place, ni d'avertissement qui le compte.
        assert!(!stats.rules.contains_key(classes::RELATION_REASONS[8]));
        // Une instance masquée pour une autre raison (invisible) ne rend pas le contenu à une masse : dessiné comme avant.
        let (taken, stats) = lire_en_place_avec(&[(13, 3), (14, 1)], true, false);
        assert_eq!(taken, vec![(13, 0), (14, 0)]);
        assert_eq!(stats.masses_hidden, 0);
    }

    #[test]
    fn l_avertissement_du_contenu_de_famille_sur_place_compte_ce_qui_reste_dessine() {
        assert_eq!(in_place_warning(0), None);
        assert!(in_place_warning(1).is_some_and(|text| text.starts_with("1 élément du contenu d'une famille sur place est dessiné à l'endroit où la famille a été créée")));
        assert!(in_place_warning(3).is_some_and(|text| text.starts_with("3 éléments du contenu de familles sur place sont dessinés")));
    }

    /// Une scène d'avant 2015 : les `Family` 10 (chargée), 11 (sur place), 12 (celle du document d'une famille éditée) et 13 (dont
    /// l'enregistrement n'a pas pu être décodé : `m_inPlace` absent), et une `FamilyInstance` (une pièce imbriquée) par propriétaire : 110 à 113 pour ces quatre,
    /// 114 sans propriétaire, 115 dont le propriétaire n'a pas d'enregistrement, 116 dont le propriétaire est un mur. Et des chaînes : 117 est
    /// possédée par le groupe 21 de la chargée 10, 118 par la courbe 22 (que la lecture rapide ne décode pas : seul l'index la connaît)
    /// de la même, 119 par le groupe 23 de la sur place 11, 120 par un groupe dont le propriétaire (98) n'est pas dans l'index, 121 par un
    /// groupe de la famille illisible 13.
    fn scene_of_families(rule: saved::FamilyRule) -> saved::Scene {
        let family = |in_place| saved::Info { in_place, ..element("Family") };
        let owned = |owner: i64| saved::Info { owner, ..element("FamilyInstance") };
        let group = |owner: i64| saved::Info { owner, ..element("ElementGroup") };
        let mut infos: BTreeMap<u64, saved::Info> = BTreeMap::from([
            (10, family(Some(false))),
            (11, family(Some(true))),
            (12, family(Some(false))),
            (13, family(None)),
            (20, element("SWall")),
            (21, group(10)),
            (23, group(11)),
            (24, group(98)),
            (25, group(13)),
            (110, owned(10)),
            (111, owned(11)),
            (112, owned(12)),
            (113, owned(13)),
            (114, owned(-1)),
            (115, owned(99)),
            (116, owned(20)),
            (117, owned(21)),
            (118, owned(22)),
            (119, owned(23)),
            (120, owned(24)),
            (121, owned(25)),
        ]);
        // L'index connaît aussi la courbe 22, absente des éléments lus, et le mur 20 (propriétaire de 116) n'a pas de propriétaire.
        let mut owners: BTreeMap<u64, i64> = infos.iter().map(|(id, info)| (*id, info.owner)).collect();
        owners.insert(22, 10);
        saved::settle_families(rule, &mut infos, &|id| owners.get(&id).copied());
        let mut scene = saved::Scene::for_tests(infos, 1000);
        scene.family_rule = rule;
        scene
    }

    #[test]
    fn la_regle_des_familles_ne_vise_que_les_definitions_chargees() {
        use saved::FamilyOwner::{Definition, DefinitionChain, Elsewhere, Unread};
        let decisions = |rule| {
            let scene = scene_of_families(rule);
            (110..=121).map(|id| (id, scene.infos[&id].family_owner, classes::excluded(&scene.facts(&scene.infos[&id])))).collect::<Vec<_>>()
        };
        let direct = Some(classes::RELATION_REASONS[6]);
        let chain = Some(classes::RELATION_REASONS[7]);
        // Un projet (`m_ownerFamilyId` à -1) : toute `Family` non sur place est chargée, dont celle qui serait « 12 ». Une famille
        // dont l'enregistrement ne se décode pas, ou sans `m_inPlace`, n'est pas écartée : sa nature est inconnue. Les chaînes de
        // propriétaires se remontent : le groupe (117) et la courbe (118) d'une chargée en sont des pièces, par des intermédiaires ;
        // ceux d'une sur place (119) restent dans le modèle ; un maillon inconnu de l'index (120) ou une famille illisible (121) rendent
        // la chaîne ambiguë.
        assert_eq!(
            decisions(saved::FamilyRule::On { document: Some(-1) }),
            vec![
                (110, Definition, direct),
                (111, Elsewhere, None),
                (112, Definition, direct),
                (113, Unread, None),
                (114, Elsewhere, None),
                (115, Unread, None),
                (116, Elsewhere, None),
                (117, DefinitionChain, chain),
                (118, DefinitionChain, chain),
                (119, Elsewhere, None),
                (120, Unread, None),
                (121, Unread, None),
            ]
        );
        // Une famille éditée (`.rfa`) : ce que possède sa propre `Family` (12) est la famille elle-même, quel que soit `m_inPlace`.
        assert_eq!(
            decisions(saved::FamilyRule::On { document: Some(12) }),
            vec![
                (110, Definition, direct),
                (111, Elsewhere, None),
                (112, Elsewhere, None),
                (113, Unread, None),
                (114, Elsewhere, None),
                (115, Unread, None),
                (116, Elsewhere, None),
                (117, DefinitionChain, chain),
                (118, DefinitionChain, chain),
                (119, Elsewhere, None),
                (120, Unread, None),
                (121, Unread, None),
            ]
        );
        // Une famille dont la racine ne se lit pas : on ne sait plus laquelle est la sienne, rien n'est écarté.
        assert_eq!(
            decisions(saved::FamilyRule::On { document: None }),
            vec![
                (110, Unread, None),
                (111, Elsewhere, None),
                (112, Unread, None),
                (113, Unread, None),
                (114, Elsewhere, None),
                (115, Unread, None),
                (116, Elsewhere, None),
                (117, Unread, None),
                (118, Unread, None),
                (119, Elsewhere, None),
                (120, Unread, None),
                (121, Unread, None),
            ]
        );
        // Une famille éditée dont `m_ownerFamilyId` ne désigne aucune `Family` (77) : même chose, rien n'est écarté.
        assert!(decisions(saved::FamilyRule::On { document: Some(77) }).iter().all(|(_, owner, excluded)| *owner != Definition && *owner != DefinitionChain && excluded.is_none()));
        // 2015 et après : la règle est éteinte, tous les éléments restent.
        assert!(decisions(saved::FamilyRule::Off).iter().all(|(_, owner, excluded)| *owner == Elsewhere && excluded.is_none()));
    }

    #[test]
    fn les_definitions_ecartees_se_comptent_et_les_familles_illisibles_s_avertissent() {
        let scene = scene_of_families(saved::FamilyRule::On { document: Some(-1) });
        let mut sink = |_: Emitted| Ok(());
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |scene: &saved::Scene, _: u64, info: &saved::Info| classes::excluded(&scene.facts(info)).is_none();
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: GEOMETRIC_CLASSES.iter().map(|class| (*class).to_string()).collect(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        // Les éléments voulus : ni les deux définitions directes (110, 112), ni les deux pièces (117, 118) qui les atteignent par des
        // intermédiaires, ni les `Family` et les groupes (écartés par leur classe).
        let kept: Vec<u64> = scene.infos.iter().filter(|(id, info)| wanted(&scene, **id, info)).map(|(id, _)| *id).collect();
        assert_eq!(kept, vec![20, 111, 113, 114, 115, 116, 119, 120, 121]);
        rules.settle(&scene, BTreeMap::new(), BTreeSet::new()).expect("décisions");
        // Comptées comme les autres exclusions, par raison (la définition directe et la pièce par intermédiaires à part) et par classe ;
        // les éléments dont la famille est illisible ou la chaîne ambiguë (113, 115, 120, 121) sont notés.
        assert_eq!(stats.rules[classes::RELATION_REASONS[6]], 2);
        assert_eq!(stats.rules[classes::RELATION_REASONS[7]], 2);
        assert_eq!(stats.classes["FamilyInstance"].excluded_by_relation, 4);
        assert_eq!(stats.family_unread, BTreeSet::from([113, 115, 120, 121]));

        // Seuls les éléments dessinés se comptent dans l'avertissement.
        assert_eq!(family_warning(0), None);
        assert_eq!(family_warning(1).as_deref(), Some("1 élément appartient à une famille dont la définition ne se lit pas : il peut être une pièce de famille dessinée à l'origine du projet."));
        assert_eq!(family_warning(3).as_deref(), Some("3 éléments appartiennent à une famille dont la définition ne se lit pas : ils peuvent être des pièces de famille dessinées à l'origine du projet."));
    }

    #[test]
    fn un_graphe_non_decode_se_juge_sur_la_classe_ou_la_categorie() {
        // Un élément importé (classe que rien ne rattache au modèle) dont le graphique n'a pas pu être décodé : sa catégorie
        // de modèle (Modèles génériques) en fait de la géométrie qu'on ne sait pas lire, non un élément à écarter ; sans
        // catégorie, la classe seule ne dit rien de plus qu'avant.
        let mut infos: BTreeMap<u64, saved::Info> = BTreeMap::new();
        infos.insert(1, saved::Info { category: -2000151, ..element("ImportedThing") });
        infos.insert(2, element("ImportedThing"));
        let scene = saved::Scene::for_tests(infos, 1000);
        let mut sink = |_: Emitted| Ok(());
        let mut outlet = Outlet { prepared: Prepared::default(), emitted: BTreeSet::new(), used: HashSet::new(), global_ids: BTreeMap::new(), triangles: 0, budget: 1_000_000, trimmed: 0, fingerprints: false, shapes: BTreeMap::new(), mesh_stats: MeshStats::default(), sink: &mut sink, sink_error: None };
        let (mut stats, mut unreadable, mut without) = (Stats::default(), BTreeMap::new(), BTreeSet::new());
        let wanted = |_: &saved::Scene, _: u64, _: &saved::Info| true;
        let mut rules = Rules { outlet: &mut outlet, stats: &mut stats, unreadable: &mut unreadable, without: &mut without, wanted: &wanted, with_children: None, owners: BTreeMap::new(), held: BTreeMap::new(), seen: HashSet::new(), identical: Vec::new(), geometric: BTreeSet::new(), referenced: BTreeSet::new(), later: Vec::new(), in_place: InPlace::default() };
        rules.settle(&scene, BTreeMap::from([(1, None), (2, None)]), BTreeSet::new()).expect("décisions");
        assert_eq!(unreadable.keys().copied().collect::<Vec<_>>(), vec![1], "seul l'élément de catégorie de modèle est à montrer");
        assert!(unreadable[&1].mesh.is_none() && unreadable[&1].why == Refusal::Unread);
        assert!(stats.incomplete[&1].unreadable_graph && !stats.incomplete.contains_key(&2));
        let row = &stats.classes["ImportedThing"];
        assert_eq!((row.unreadable, row.not_geometric), (1, 1));
        // Sans boîte enregistrée il n'est pas dessiné, et l'avertissement le dit.
        emit_refused(&mut outlet, &mut stats, unreadable).expect("boîtes");
        assert_eq!((stats.boxed, stats.undrawn), (0, 1));
        assert!(refusal_warnings(&stats, 100)[0].contains("n'a pas enregistré de boîte pour lui : il n'est pas dessiné"));
    }
}
