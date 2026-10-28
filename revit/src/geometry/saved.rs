//! Formes enregistrées par Revit (fichiers de 2012 à 2027) : les graphiques que Revit a
//! dessinés pour chaque élément, avec les transformations des instances déjà appliquées, en
//! pieds, Z vers le haut.
//!
//! C'est la logique de `rvt::research::native_saved_scene::extract` (mêmes primitives de rvt-rs,
//! mêmes maillages, mêmes matériaux), refaite pour trois raisons :
//! 1. son résultat ne dit pas la classe Revit de chaque élément, dont dépend la règle « dessinable
//!    ou non » ; sa passe sur les enregistrements d'éléments (canal 102, pour les matériaux) la
//!    voit passer ;
//! 2. il garde les graphes décodés de tous les éléments à la fois : 2,4 Go de mémoire pour les 34 Mo de
//!    Core Interior (un objet de graphe coûte environ 4 Ko). Ici, seuls les symboles de famille
//!    restent en mémoire ; chaque élément est maillé dès que son graphe est décodé, par lots, et
//!    libéré ;
//! 3. on ne décode que les éléments qu'on dessine.
//!
//! Quatre passes sur les partitions : (A) les enregistrements d'éléments, qui donnent la classe de
//! chacun, nourrissent le résolveur de matériaux et, par `Plan`, passent aux propriétés les graphes
//! dont elles ont besoin (aucun enregistrement n'est décodé deux fois) ; (B) les graphiques des
//! éléments à dessiner, maillés par lots ; (C) les graphiques des seuls symboles de famille que les
//! instances de (B) placent ; (D) le maillage des instances qui attendaient ces symboles (reprise des
//! seules instances en surnombre).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::{Context as _, Result};
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_saved_materials::RenderMaterial;
use serde_json::Value;

use super::faces::{self, FaceCache};
use super::materials::Resolver;
use super::{Stopwatch, classes};
use super::pack::{ElementMesh, Face, Paint};
use crate::native::{self, Options, Record};
pub use crate::native::families::{self, FamilyOwner, FamilyRule, LOADED_DEFINITIONS_FROM};
use crate::properties::{Retained, definition_classes, is_support_class};

/// Budget de décodage d'un graphe des enregistrements d'éléments, canal 102 (valeurs et objets). Celui de rvt-rs par défaut
/// (100 000) refuse les terrains et les grandes familles ; l'export `saved_meshes` de rvt-rs prend 1 million. Les
/// propriétés gardent ce budget : aucun enregistrement du canal 102 des fichiers d'essai n'en demande davantage.
pub const GRAPH_LIMIT: usize = 1_000_000;

/// Budget de décodage d'un graphe graphique, canal 103 (valeurs et objets) : celui des formes que l'on dessine. Une DWG
/// importée dans une famille (un `MasterImportSymbol`) est un graphe de maillages de facettes (`GPolyMesh`) que le budget d'un
/// million refusait, et la famille n'avait alors aucune surface : le « Peugeot 208.DWG » des voitures de `wadduwa.rvt` demande
/// 1 970 695 valeurs et 198 objets (3 769 685 octets), le « Citroen C4.DWG » 1 739 483 valeurs et 451 objets (3 363 927
/// octets) ; aucun autre enregistrement graphique des fichiers d'essai n'est refusé à 1 million, sauf le `DirectShapeType`
/// de `2024_Core_Interior` (16,5 Mo), que la borne en octets garde refusé (`native::records::MAX_RECORD_BYTES`). Trois millions laissent
/// une marge d'un tiers et un enregistrement de moins de 8 Mo en tient dès qu'il pèse 2,7 octets par valeur ou moins (ces
/// deux-là : 1,9 ; le plus dense des autres fichiers : 3,2).
pub const GEOMETRY_GRAPH_LIMIT: usize = 3_000_000;

/// La classe d'un import CAD du projet (DWG ou autre importé dans le modèle, pas dans une famille) : ses blocs à échelle ne sont pas placés
/// (`faces::Settings::uniform_scales`).
pub const PROJECT_IMPORT_CLASS: &str = "ImportInstance";

/// Niveau de détail « fin » (celui du viewport 3D par défaut).
pub const DETAIL_LEVEL: i64 = 3;

/// Triangles qu'un seul élément peut garder : au-delà, sa forme est trop dense pour ce lecteur et l'élément est
/// montré par sa boîte englobante (source 3, avec un avertissement). Le plus dense des fichiers d'essai, une cuve de
/// 202 tores, en a 163 000 ; un tiers de ce plafond est déjà un élément qui pèse à lui seul autant que Core Interior.
pub const MAX_ELEMENT_TRIANGLES: usize = 250_000;

/// Triangles maillés au total (avant soudure, tous éléments confondus, jamais décomptés) au-delà desquels les éléments
/// qui restent à mailler ne le sont plus : un arrêt global du travail de maillage, qui borne le temps d'un fichier
/// énorme (le budget de triangles, lui, ne décide que de ce qui est gardé, `geometry::Outlet`). Un peu moins de deux
/// fois le budget d'un fichier (`geometry::MAX_TRIANGLES`, 3 millions), ou deux fois le budget demandé s'il est plus
/// grand (`Scene::hard_limit`). Un élément refusé par lui n'est pas maillé : il est traité comme un élément que le budget
/// ne laisse plus tenir, montré par la boîte que Revit a enregistrée pour lui (source 3) et compté avec eux
/// (`Shape::capped`), jamais comme une forme trop dense. Il se vérifie quand un élément va être maillé (`shape`) et quand
/// un brouillon d'instance va être achevé (`complete`). Sous cette limite le résultat ne dépend pas de l'ordre des
/// fils ; au-delà, seuls les éléments touchés peuvent varier.
pub const HARD_TRIANGLE_LIMIT: usize = 5_000_000;

/// Les graphes d'un lot sont maillés ensemble, puis libérés : au plus cette somme d'octets d'enregistrements
/// (`Record::source::body_bytes`) décodés en mémoire à la fois, hors symboles. Un graphe décodé pèse 60 à 140
/// fois son enregistrement (chaque nombre devient une valeur JSON ; mesuré sur les fichiers d'essai), ce qui
/// fait de ce lot 60 à 140 Mo au plus. Les files d'attente ci-dessous valent 2 Mio : au-delà, un débordement relit
/// l'enregistrement, ce qui coûte un décodage de plus ; 2 Mio tiennent presque toutes les instances en attente de Core
/// Interior (2,7 Mo de corps en tout, 212 Mo décodés) et la moitié de celles de rac_advanced (3,5 Mo). Compter les objets, comme avant (40 000 objets), laissait passer 200 Mo
/// sur Core Interior : la taille d'un objet varie de 1 à 100.
const BATCH_BODY_BYTES: usize = 1 << 20;

/// Le même lot quand un seul fil maille (WebAssembly) : le lot ne sert alors qu'à amortir la remise, et ses graphes
/// décodés (de 61 à 142 fois leurs octets) sont le plus gros transitoire de la lecture ; un huitième suffit.
const SINGLE_THREAD_BATCH_BODY_BYTES: usize = BATCH_BODY_BYTES / 8;

/// Brouillons achevés d'un coup en D (`finish_parallel`) avant d'être remis : assez pour occuper les fils, assez peu
/// pour que leurs maillages achevés, qui coexistent jusqu'à la remise, restent légers.
const FINISH_SLICE: usize = 128;

/// Même borne pour les graphes de symboles qui attendent un symbole imbriqué pas encore lu (`load_symbols`) :
/// au-delà, le symbole est relu à la vague suivante, où l'imbriqué sera connu.
const PARKED_BODY_BYTES: usize = 2 << 20;

/// Ce que l'enregistrement d'élément (canal 102) apprend sur un élément.
#[derive(Debug, Clone)]
pub struct Info {
    /// Classe Revit : `SWall`, `FamilyInstance`, `RoomElem`…
    pub class: String,
    /// Vue propriétaire (`m_ownerDBViewId`), `-1` pour un élément du modèle.
    pub view: i64,
    /// Élément propriétaire (groupe, mur rideau, escalier…), `-1` si aucun.
    pub owner: i64,
    /// Définition de groupe où vit l'élément (`m_unplacedOwnerId`), `-1` s'il est placé.
    pub unplaced: i64,
    /// Instance invisible (`m_invisible`) ou dormante (`m_instDormant`).
    pub hidden: bool,
    /// Symbole que place une instance (`m_masterSymbolId`), `-1` sinon.
    pub master: i64,
    /// Famille d'un symbole (`m_familyId`), `-1` sinon.
    pub family: i64,
    /// Catégorie écrite dans l'enregistrement (`m_categoryId` : familles, courbes, texte 3D…).
    pub category: i64,
    /// Une `Family` sur place (`m_inPlace`, créée dans l'éditeur de modèle sur place : ce qu'elle possède est dans le modèle) ou
    /// non (chargée depuis un fichier de famille). `None` pour tout autre enregistrement, et pour une `Family` dont
    /// l'enregistrement n'a pas pu être décodé ou n'a pas ce champ : sa nature est alors inconnue (voir `Scene::family_owner`).
    /// C'est tout ce que la règle des définitions de familles garde des `Family` : un octet, dans le remplissage de `Info`.
    pub in_place: Option<bool>,
    /// Ce que la chaîne des propriétaires d'ElemTable de l'élément dit des familles chargées (`FamilyRule::owner`) : décidé après la
    /// passe A, quand toutes les `Family` sont connues (`settle_families`). `Elsewhere` quand la règle est éteinte (Revit 2015 et
    /// après) ou que rien ne mène à une `Family`.
    pub family_owner: FamilyOwner,
}

/// Décide, pour chaque élément lu, ce que la chaîne de ses propriétaires d'ElemTable dit des familles chargées (`Info::family_owner`) :
/// le prédicat commun à la géométrie et aux métadonnées (`FamilyRule::owner`), appliqué quand la passe A a lu toutes les `Family`.
/// `owner_of` donne le propriétaire de tout enregistrement de l'index (même de ceux que la lecture rapide ne décode pas : une courbe,
/// une esquisse). Règle éteinte (Revit 2015 et après) : rien n'est fait, aucun élément n'est touché.
pub fn settle_families(rule: FamilyRule, infos: &mut BTreeMap<u64, Info>, owner_of: &dyn Fn(u64) -> Option<i64>) {
    if rule == FamilyRule::Off {
        return;
    }
    // Les `Family` lues, avec leur `m_inPlace` : une centaine d'identifiants.
    let families: BTreeMap<u64, Option<bool>> = infos.iter().filter(|(_, info)| info.class == "Family").map(|(id, info)| (*id, info.in_place)).collect();
    let decided: Vec<(u64, FamilyOwner)> = infos.iter().map(|(id, info)| (*id, rule.owner(info.owner, |family| families.get(&family).copied(), owner_of))).filter(|(_, owner)| *owner != FamilyOwner::Elsewhere).collect();
    for (id, owner) in decided {
        if let Some(info) = infos.get_mut(&id) {
            info.family_owner = owner;
        }
    }
}

/// L'état commun à tous les éléments pendant le maillage.
pub struct Scene {
    pub infos: BTreeMap<u64, Info>,
    /// Graphes graphiques des symboles de famille que les instances placent et dont il a fallu garder le graphe :
    /// en mode prudent, quand `symbol_shapes` est faux, ou quand la forme du symbole dépend de l'instance (voir
    /// `faces::select::symbol_shape`). Les autres symboles sont dans `cache` (forme parcourue et nœuds maillés), leur
    /// graphe libéré dès sa lecture.
    pub symbols: BTreeMap<u64, ObjectGraph>,
    resolver: Resolver,
    /// Ce que le maillage garde d'une instance à l'autre (voir `faces::cache`).
    pub cache: FaceCache,
    /// Mode prudent : rvt-rs seul pour les faces et le parcours (voir `faces::Settings::prudent`).
    pub prudent: bool,
    /// Parcourir chaque symbole une fois et libérer son graphe (voir `Plan::keeping_symbol_graphs`).
    pub symbol_shapes: bool,
    /// Mailler chaque élément dès son graphe décodé, les instances d'un symbole pas encore lu laissées pour plus tard
    /// (`faces::Settings::defer`) et achevées après la lecture des symboles (`complete`) ; sinon, les graphiques des
    /// éléments sont lus une première fois pour connaître les symboles, puis une seconde pour les mailler.
    pub defer: bool,
    /// Au-delà de ces triangles maillés, plus rien n'est maillé (`HARD_TRIANGLE_LIMIT`, ou deux fois le budget du fichier).
    pub hard_limit: usize,
    /// Triangles maillés jusqu'ici, tous éléments confondus, sans jamais redescendre (voir `HARD_TRIANGLE_LIMIT`).
    pub meshed: AtomicUsize,
    /// Le fichier est un document de famille (voir `native::is_family`).
    pub family_document: bool,
    /// Ce que la lecture fait des éléments que possède une famille chargée (voir `FamilyRule`).
    pub family_rule: FamilyRule,
}

impl Scene {
    /// Ce que l'enregistrement de `info` dit de sa place dans le modèle, pour la règle de
    /// `classes::excluded`.
    pub fn facts<'a>(&'a self, info: &'a Info) -> classes::Facts<'a> {
        classes::Facts {
            class: &info.class,
            view: info.view,
            unplaced: info.unplaced != -1,
            owner_unplaced: self.owner_unplaced(info),
            owner_class: self.owner_info(info).map(|owner| owner.class.as_str()),
            hidden: info.hidden,
            category: self.category(info),
            family_document: self.family_document,
            family_definition: info.family_owner == FamilyOwner::Definition,
            family_chain: info.family_owner == FamilyOwner::DefinitionChain,
        }
    }

    /// Un propriétaire de `info` vit-il dans une définition de groupe ? De proche en proche, tant que le
    /// propriétaire est un conteneur que la lecture décode (ni une classe écartée, ni une classe d'appui,
    /// voir `decoded_class`) : c'est ce que la lecture rapide décide avant de décoder un enregistrement
    /// (`read_records`), qu'elle ne décode pas quand son propriétaire est dans ce cas.
    pub fn owner_unplaced(&self, info: &Info) -> bool {
        let mut owner = info.owner;
        for _ in 0..16 {
            let Some(owner_info) = u64::try_from(owner).ok().and_then(|id| self.infos.get(&id)) else { return false };
            if classes::excluded_class(&owner_info.class).is_some() || is_support_class(&owner_info.class) {
                return false;
            }
            if owner_info.unplaced != -1 {
                return true;
            }
            owner = owner_info.owner;
        }
        false
    }

    /// La catégorie (BuiltInCategory) d'un élément : celle que sa classe détermine (murs, sols…),
    /// celle qu'il porte, ou, pour une instance, celle de la famille de son symbole.
    pub fn category(&self, info: &Info) -> Option<i64> {
        if let Some(category) = crate::catalog::class_category(&info.class) {
            return Some(category.id);
        }
        if info.category < -1 {
            return Some(info.category);
        }
        let symbol = u64::try_from(info.master).ok().and_then(|id| self.infos.get(&id))?;
        let family = u64::try_from(symbol.family).ok().and_then(|id| self.infos.get(&id))?;
        (family.category < -1).then_some(family.category)
    }

    /// Le graphe d'un symbole, pour le parcours des graphiques d'une instance.
    pub fn symbol(&self, id: u64) -> Option<&ObjectGraph> {
        self.symbols.get(&id)
    }

    /// La couleur du matériau que Revit attache à l'élément lui-même (celui de son type), s'il en a un :
    /// pour la boîte d'un élément dont aucune face n'a pu se mailler (`bounds`), qui n'a pas de face
    /// dont lire un matériau.
    pub fn element_paint(&self, id: u64) -> Option<Paint> {
        let material = self.resolver.resolve(id, None, -1, -1, None).filter(|material| material.material_id.is_some())?;
        Some(paint(Some(&material)))
    }

    /// La classe de l'élément propriétaire de `info`, s'il en a un.
    pub fn owner_info(&self, info: &Info) -> Option<&Info> {
        u64::try_from(info.owner).ok().and_then(|owner| self.infos.get(&owner))
    }

    /// Les réglages du maillage des graphiques de l'élément `id`. Un import CAD du projet (`ImportInstance`) ne place pas ses blocs à échelle,
    /// comme avant l'échelle uniforme : voir l'en-tête de `faces::select`.
    pub fn settings(&self, id: u64) -> faces::Settings<'_> {
        let project_import = self.infos.get(&id).is_some_and(|info| info.class == PROJECT_IMPORT_CLASS);
        faces::Settings { detail_level: DETAIL_LEVEL, prudent: self.prudent, cache: Some(&self.cache), defer: self.defer, uniform_scales: !project_import }
    }

    /// Une scène sans fichier, pour les essais des règles de dessin (`geometry::tests`) : `infos` donne les éléments.
    #[cfg(test)]
    pub(crate) fn for_tests(infos: BTreeMap<u64, Info>, hard_limit: usize) -> Self {
        Self { infos, symbols: BTreeMap::new(), resolver: Resolver::default_viewport_profile(), cache: FaceCache::default(), prudent: false, symbol_shapes: true, defer: true, hard_limit, meshed: AtomicUsize::new(0), family_document: false, family_rule: FamilyRule::Off }
    }
}

/// Ce que `scan` rend.
pub struct Scan<T> {
    pub scene: Scene,
    /// Le résultat de `work` par élément voulu ; `None` si son graphe graphique est illisible.
    pub results: BTreeMap<u64, Option<T>>,
    /// Éléments voulus qui n'ont pas d'enregistrement graphique du tout.
    pub without_record: BTreeSet<u64>,
    /// Instances dont le graphique a attendu la lecture des symboles qu'elles placent (achevées après coup).
    pub deferred: usize,
    /// Enregistrements non décodés parce que leur propriétaire n'est pas placé dans le modèle (voir
    /// `read_records`).
    pub skipped: usize,
    /// Enregistrements d'éléments décodés (les autres, écartés d'après leur classe ou leur
    /// propriétaire, ne l'ont pas été).
    pub decoded: usize,
    pub timing: Timing,
}

/// Ce que `scan_salvaging` laisse quand la lecture échoue après les enregistrements d'éléments : la scène, et les
/// résultats de `work` que le balayage n'avait pas encore remis (brouillons qui attendaient leurs symboles, éléments
/// sans graphe décodé), de quoi décider de ce qui a été lu avant l'erreur.
pub struct Failure<T> {
    pub scene: Scene,
    pub results: BTreeMap<u64, Option<T>>,
}

/// Secondes passées dans chaque passe.
#[derive(Debug, Clone, Copy, Default)]
pub struct Timing {
    /// A : enregistrements d'éléments, balayage des classes compris.
    pub records: f64,
    /// Dont le balayage des classes, qui inflate aussi les partitions du fichier (la première fois
    /// qu'on les lit).
    pub census: f64,
    /// C : graphiques des symboles que les instances placent.
    pub symbols: f64,
    /// B : graphiques des éléments, maillage compris (sauf celui des instances en attente).
    pub elements: f64,
    /// Dont le maillage (somme des lots, instances en attente comprises).
    pub mesh: f64,
    /// D : achèvement des éléments dont une instance attendait ses symboles.
    pub retake: f64,
}

/// Le budget de décodage d'un graphe du canal : celui des graphiques (103) ou des enregistrements d'éléments (102).
pub fn graph_limit(channel: u64) -> usize {
    if channel == 103 { GEOMETRY_GRAPH_LIMIT } else { GRAPH_LIMIT }
}

/// Les réglages de lecture d'un canal, pour les éléments `ids` (tous si `ids` est vide). La borne en octets d'un
/// enregistrement (`native::records::MAX_RECORD_BYTES`) est la même pour les deux canaux.
fn read_options(channel: u64, ids: BTreeSet<u64>) -> Options {
    let limit = graph_limit(channel);
    Options { channels: BTreeSet::from([channel]), selected_ids: ids, max_graph_values: limit, max_graph_objects: limit, ..Default::default() }
}

/// Comment se lit la passe A, celle des enregistrements d'éléments (canal 102).
pub struct Plan<'a> {
    /// Où passer les graphes dont les propriétés ont besoin : ceux des éléments qui peuvent se
    /// dessiner et ceux des classes d'appui.
    retained: Option<&'a mut Retained>,
    /// Ne pas décoder les enregistrements des classes que la règle de dessin écarte et dont rien
    /// d'autre ne se sert (courbes, pièces, esquisses, vues…) : un quart de la passe sur Core Interior.
    /// Ces enregistrements n'ont alors ni `Info` ni ligne de recensement.
    skip_irrelevant: bool,
    /// Mode prudent (voir `Scene::prudent`).
    prudent: bool,
    /// Parcourir chaque symbole une fois et libérer son graphe (voir `Scene::symbol_shapes`).
    symbol_shapes: bool,
    /// Lire les graphiques des éléments deux fois (la première pour connaître les symboles) plutôt que laisser des
    /// instances pour plus tard : pour les sondes et les essais, dont le travail n'achève pas de brouillon.
    symbols_first: bool,
    /// Budget de triangles du fichier (`geometry::MAX_TRIANGLES` à défaut) : règle le garde-fou du maillage.
    triangle_budget: usize,
    /// Plafond de triangles maillés imposé à la place de celui qui se déduit du budget (essais seulement).
    hard_limit: Option<usize>,
}

impl<'a> Plan<'a> {
    /// Tout décoder, sans rien garder : pour le recensement et les mesures.
    pub fn exhaustive() -> Self {
        Self { retained: None, skip_irrelevant: false, prudent: false, symbol_shapes: true, symbols_first: false, triangle_budget: super::MAX_TRIANGLES, hard_limit: None }
    }

    /// La lecture de la chaîne : on ne décode que ce qui sert, et les graphes que les propriétés vont
    /// projeter sont passés à `retained`.
    pub fn reading_for(retained: &'a mut Retained) -> Self {
        Self { retained: Some(retained), skip_irrelevant: true, prudent: false, symbol_shapes: true, symbols_first: false, triangle_budget: super::MAX_TRIANGLES, hard_limit: None }
    }

    /// Mode prudent : rvt-rs seul pour les faces et le parcours des graphiques (`Options::prudent`).
    pub fn prudent(mut self, prudent: bool) -> Self {
        self.prudent = prudent;
        self
    }

    /// Le budget de triangles du fichier (`Context::triangle_budget`) : le garde-fou du maillage en vaut le double.
    pub fn budget(mut self, triangles: usize) -> Self {
        self.triangle_budget = triangles;
        self
    }

    /// Impose le plafond de triangles maillés (`Scene::hard_limit`) à la place de celui que le budget détermine : pour
    /// essayer ce qui arrive à un fichier qui l'atteint, sans qu'il faille en lire un de plusieurs millions de triangles.
    pub fn hard_limit(mut self, triangles: usize) -> Self {
        self.hard_limit = Some(triangles);
        self
    }

    /// Garder le graphe de chaque symbole et le parcourir à chaque instance, comme avant les formes de symboles :
    /// pour vérifier que les deux chemins rendent la même chose (`tests/symbols.rs`), et pour les sondes qui lisent
    /// les graphes des symboles (`examples/census.rs`).
    pub fn keeping_symbol_graphs(mut self) -> Self {
        self.symbol_shapes = false;
        self
    }

    /// Lire les symboles avant de mailler les éléments (deux lectures des graphiques des éléments), pour que `work`
    /// reçoive chaque élément avec tous ses symboles sous la main : les sondes et les essais, dont le travail n'est
    /// pas `shape` suivi de `complete`.
    pub fn symbols_first(mut self) -> Self {
        self.symbols_first = true;
        self
    }
}

/// Un enregistrement d'élément se décode si la règle de dessin ne l'écarte pas d'après sa seule classe,
/// ou si d'autres en dépendent : les types et familles (que les instances placent et qui donnent leur
/// catégorie), les niveaux, phases et matériaux des fiches.
fn decoded_class(class: &str) -> bool {
    classes::excluded_class(class).is_none() || is_support_class(class)
}

/// Peut-il se dessiner ? Ce que l'enregistrement dit de lui-même, sans son propriétaire ni sa
/// catégorie (`classes::excluded` complète quand toute la scène est lue) : une classe qui porte de la
/// géométrie, placée dans le modèle, visible, hors d'une vue. Une classe qui n'est pas dans la liste
/// (un élément y a pourtant une forme dans ce fichier) se relit au moment des propriétés.
fn may_be_drawn(info: &Info) -> bool {
    super::GEOMETRIC_CLASSES.contains(&info.class.as_str()) && info.unplaced == -1 && !info.hidden && info.view == -1
}

/// Lit le fichier et applique `work` aux graphiques de chaque élément voulu, un lot à la fois (sur
/// `threads` fils quand il y en a). Tous les enregistrements d'éléments sont décodés, et les graphes des
/// symboles de famille sont gardés dans la scène (`Scene::symbols`) : c'est l'entrée des sondes et des essais,
/// qui lisent ces graphes.
///
/// `wanted(scène, id, info)` choisit les éléments dont on lit les graphiques ; les
/// symboles de famille sont lus d'office.
pub fn scan<T: Send>(
    file: &mut rvt::RevitFile,
    wanted: &dyn Fn(&Scene, u64, &Info) -> bool,
    threads: usize,
    work: &(dyn Fn(&Scene, u64, &ObjectGraph) -> T + Sync),
) -> Result<Scan<T>> {
    scan_with(file, wanted, threads, work, None, &|_| false, None, Plan::exhaustive().keeping_symbol_graphs().symbols_first())
}

/// [`scan`] selon un `Plan`. `finish(scène, id, résultat)` achève après la lecture des symboles (C) le résultat des
/// éléments dont une instance avait été laissée pour plus tard (voir `Scene::defer`, `complete`) ; sans `finish`, les
/// graphiques des éléments sont lus deux fois (`Plan::symbols_first`), et `work` a toujours tous les symboles.
pub fn scan_with<T: Send>(
    file: &mut rvt::RevitFile,
    wanted: &dyn Fn(&Scene, u64, &Info) -> bool,
    threads: usize,
    work: &(dyn Fn(&Scene, u64, &ObjectGraph) -> T + Sync),
    finish: Option<&(dyn Fn(&Scene, u64, &mut T) + Sync)>,
    pending: &(dyn Fn(&T) -> bool + Sync),
    emit: Option<&mut dyn FnMut(&Scene, u64, T) -> Result<()>>,
    plan: Plan<'_>,
) -> Result<Scan<T>> {
    scan_salvaging(file, wanted, threads, work, finish, pending, emit, plan, &mut None)
}

/// [`scan_with`] qui, si la lecture échoue après les enregistrements d'éléments (un groupe dont l'encadrement échoue au
/// milieu du fichier, des symboles illisibles…), rend à `failure` la scène et ce que le balayage n'avait pas remis :
/// l'appelant décide alors de ce qui a déjà été lu, au lieu de le perdre avec la scène (`geometry::Rules::settle`). Les
/// graphes déjà décodés du lot en cours sont maillés avant l'échec. Une erreur de `emit` (la sortie ne prend plus rien)
/// n'est pas une lecture manquée : elle met fin au balayage comme les autres, `failure` en profite aussi, à l'appelant de
/// ne plus rien remettre.
pub fn scan_salvaging<T: Send>(
    file: &mut rvt::RevitFile,
    wanted: &dyn Fn(&Scene, u64, &Info) -> bool,
    threads: usize,
    work: &(dyn Fn(&Scene, u64, &ObjectGraph) -> T + Sync),
    finish: Option<&(dyn Fn(&Scene, u64, &mut T) + Sync)>,
    pending: &(dyn Fn(&T) -> bool + Sync),
    mut emit: Option<&mut dyn FnMut(&Scene, u64, T) -> Result<()>>,
    mut plan: Plan<'_>,
    failure: &mut Option<Failure<T>>,
) -> Result<Scan<T>> {
    let options = read_options;
    let mut timing = Timing::default();

    // A. Enregistrements d'éléments : classes, vues, propriétaires, matériaux.
    let step = Stopwatch::start();
    let mut infos = BTreeMap::new();
    let mut resolver = Resolver::default_viewport_profile();
    let skipped = read_records(file, &mut plan, &mut infos, &mut resolver, &mut timing.census).context("les enregistrements d'éléments n'ont pas pu être lus")?;
    timing.records = step.seconds();
    let symbols_first = plan.symbols_first || finish.is_none() || plan.prudent;
    // Ce que les chaînes de propriétaires disent des familles chargées (avant Revit 2015, voir `native::families`) : décidé ici, une
    // fois toutes les `Family` lues, avec les propriétaires de l'index du préambule.
    let family_rule = FamilyRule::of(file);
    let owners = families::Owners::of(file);
    settle_families(family_rule, &mut infos, &|id| owners.get(id));
    let mut scene = Scene { infos, symbols: BTreeMap::new(), resolver, cache: FaceCache::default(), prudent: plan.prudent, symbol_shapes: plan.symbol_shapes && !plan.prudent, defer: !symbols_first, hard_limit: plan.hard_limit.unwrap_or_else(|| HARD_TRIANGLE_LIMIT.max(plan.triangle_budget.saturating_mul(2))), meshed: AtomicUsize::new(0), family_document: native::is_family(file), family_rule };

    // Une erreur à partir d'ici rend la scène et les résultats non remis à `failure` (voir `scan_salvaging`).
    let mut results: BTreeMap<u64, Option<T>> = BTreeMap::new();
    macro_rules! stage {
        ($step:expr) => {
            match $step {
                Ok(value) => value,
                Err(error) => {
                    *failure = Some(Failure { scene, results });
                    return Err(error);
                }
            }
        };
    }

    let symbol_ids: BTreeSet<u64> = scene.infos.iter().filter(|(_, info)| classes::is_definition(&info.class)).map(|(id, _)| *id).collect();
    let wanted_ids: BTreeSet<u64> = scene.infos.iter().filter(|(id, info)| !symbol_ids.contains(id) && wanted(&scene, **id, info)).map(|(id, _)| *id).collect();
    // Les propriétés n'ont besoin que des éléments voulus et des classes d'appui : le reste se libère
    // avant que les graphiques, bien plus lourds, ne soient décodés.
    if let Some(retained) = plan.retained.as_deref_mut() {
        retained.finish_reading(|id| wanted_ids.contains(&id), family_rule, &|id| owners.get(id));
    }

    // B. Graphiques des éléments à dessiner, maillés par lots dès leur décodage. Les symboles de famille que les
    // instances placent ne sont pas lus d'avance : l'enregistrement d'une instance ne dit pas lesquels (son symbole
    // maître n'est pas celui dont elle place la forme), et en lire 555 pour en placer 22, comme sur Core Interior,
    // coûtait le tiers d'une lecture. Une instance d'un symbole pas encore lu est donc laissée pour plus tard par le
    // parcours (`faces::Settings::defer`) : l'élément est maillé pour ses nœuds propres, et `finish` l'achève en D,
    // une fois les symboles lus (C). Plus aucun graphe d'élément n'attend. Avec `symbols_first`, les graphiques sont
    // lus deux fois : d'abord pour les symboles, puis pour `work`.
    let step = Stopwatch::start();
    let mut seen: BTreeSet<u64> = BTreeSet::new();
    let mut needed: BTreeSet<u64> = BTreeSet::new();
    let mut deferred_count = 0usize;
    if !wanted_ids.is_empty() {
        if symbols_first {
            let read = native::extract_graphs(file, &options(103, wanted_ids.clone()), |record| {
                if let Some(graph) = record.graph {
                    needed.extend(symbol_references(&graph));
                }
                Ok(())
            })
            .context("les graphiques des éléments n'ont pas pu être lus");
            stage!(read);
            timing.elements = step.seconds();
            let step = Stopwatch::start();
            stage!(load_symbols(file, &mut scene, std::mem::take(&mut needed)));
            timing.symbols = step.seconds();
        }
        let step = Stopwatch::start();
        let mut batch: Vec<(u64, ObjectGraph)> = Vec::new();
        let mut bytes = 0usize;
        let read = native::extract_graphs(file, &options(103, wanted_ids.clone()), |record| {
            let id = record.identity.element_id;
            seen.insert(id);
            let Some(graph) = record.graph else {
                results.insert(id, None);
                return Ok(());
            };
            if !symbols_first {
                needed.extend(symbol_references(&graph));
            }
            bytes += record.source.body_bytes;
            batch.push((id, graph));
            if bytes >= if threads <= 1 { SINGLE_THREAD_BATCH_BODY_BYTES } else { BATCH_BODY_BYTES } {
                let done = flush(&scene, std::mem::take(&mut batch), threads, work, &mut timing.mesh);
                settle(&scene, done, finish.is_some(), pending, &mut emit, &mut results)?;
                bytes = 0;
            }
            Ok(())
        })
        .context("les graphiques des éléments n'ont pas pu être lus");
        // Le lot en cours est maillé même si la lecture a échoué : ses graphes sont décodés. Un échec de la remise prime.
        let rest = flush(&scene, batch, threads, work, &mut timing.mesh);
        let settled = settle(&scene, rest, finish.is_some(), pending, &mut emit, &mut results);
        stage!(settled.and(read));
        if symbols_first {
            timing.elements += step.seconds();
        } else {
            timing.elements = step.seconds();
        }
    }

    // C. Graphiques des symboles de famille que ces instances placent, et de ceux que ces symboles
    // placent à leur tour.
    if !symbols_first {
        let step = Stopwatch::start();
        stage!(load_symbols(file, &mut scene, needed));
        timing.symbols = step.seconds();
    }

    // D. Les éléments dont une instance attendait ses symboles sont achevés, à leur place.
    let step = Stopwatch::start();
    if let Some(finish) = finish {
        // Les brouillons quittent le résultat du balayage ; n'y restent que les éléments sans graphe décodé.
        let mut drafts: Vec<(u64, T)> = Vec::new();
        for (id, result) in std::mem::take(&mut results) {
            match result {
                Some(result) => drafts.push((id, result)),
                None => {
                    results.insert(id, None);
                }
            }
        }
        deferred_count = drafts.len();
        // Les résultats se modifient sur place, un fil par élément, par tranches : achevés, les éléments d'une tranche
        // partent à leur tour (par identifiant croissant), ou restent au résultat du balayage, avant la tranche suivante.
        let slice = if emit.is_some() { FINISH_SLICE.max(threads * 8) } else { drafts.len().max(1) };
        let mut drafts = drafts.into_iter().peekable();
        while drafts.peek().is_some() {
            let mut part: Vec<(u64, T)> = drafts.by_ref().take(slice).collect();
            let step_mesh = Stopwatch::start();
            finish_parallel(&scene, &mut part, threads, finish);
            timing.mesh += step_mesh.seconds();
            stage!(settle(&scene, part, false, pending, &mut emit, &mut results));
        }
    }
    timing.retake = step.seconds();

    let without_record = wanted_ids.into_iter().filter(|id| !seen.contains(id)).collect();
    let decoded = scene.infos.len();
    Ok(Scan { scene, results, without_record, deferred: deferred_count, skipped, decoded, timing })
}

/// Un enregistrement d'élément décodé : ce qu'il dit de lui (`Info`), ses matériaux (résolveur), et,
/// pour les propriétés, son graphe.
fn ingest_record(record: Record, infos: &mut BTreeMap<u64, Info>, resolver: &mut Resolver, retained: Option<&mut Retained>) -> Result<()> {
    let root = record.graph.as_ref().and_then(|graph| graph.objects.first()).map(|root| &root.fields);
    let id = |name: &str| root.and_then(|fields| fields.get(name)).and_then(identifier).unwrap_or(-1);
    let flag = |name: &str| root.and_then(|fields| fields.get(name)).and_then(Value::as_bool).unwrap_or(false);
    let info = Info {
        class: record.class_name.clone().unwrap_or_default(),
        view: id("m_ownerDBViewId"),
        owner: record.identity.owning_element_id,
        unplaced: id("m_unplacedOwnerId"),
        hidden: flag("m_invisible") || flag("m_instDormant"),
        master: id("m_masterSymbolId"),
        family: id("m_familyId"),
        category: id("m_categoryId"),
        // Une `Family` dont le graphe n'a pas été décodé (`root` absent) ou sans ce champ reste `None` : nature inconnue.
        in_place: families::in_place(record.class_name.as_deref().unwrap_or(""), root),
        // Décidé après la passe A (`settle_families`).
        family_owner: FamilyOwner::Elsewhere,
    };
    let keep = may_be_drawn(&info);
    resolver.ingest(&record)?;
    let element = record.identity.element_id;
    if let Some(retained) = retained {
        retained.observe(record, keep);
    }
    infos.insert(element, info);
    Ok(())
}

/// Lit les enregistrements d'éléments (canal 102) selon le plan ; rend le nombre de ceux qu'on a
/// laissés de côté sans les décoder.
///
/// Décoder un enregistrement est l'essentiel du travail de la passe A (à peu près 8 µs par objet de
/// graphe : 2,1 s des 2,6 s de Core Interior quand on décodait ses 26 425 enregistrements), et la
/// plupart ne servaient à rien (5 470 sont décodés aujourd'hui) :
/// - la règle de dessin écarte la classe de l'enregistrement (courbes, pièces, esquisses, vues…) : on
///   ne le décode pas ;
/// - son propriétaire n'est pas placé dans le modèle (membre d'une définition de groupe) : lui non
///   plus, puisque ce qui appartient à un élément d'une définition de groupe est de cette définition.
///   Sur Core Interior, 11 616 des 12 221 instances de famille sont les panneaux de murs-rideaux de
///   définitions de groupe. Seul l'enregistrement du propriétaire est décodé ; on ne perd que des
///   éléments que `classes::excluded_relation` aurait écartés (le propriétaire non placé dit déjà
///   l'essentiel, et `Plan::exhaustive` permet de le vérifier fichier par fichier).
/// Les types, familles, niveaux, phases et matériaux se décodent toujours.
///
/// Pour cela, un premier balayage lit la classe et le propriétaire de chaque enregistrement sans
/// aucun décodage de graphe (`census`) ; les éléments se décodent ensuite par vagues, les
/// propriétaires avant ce qu'ils possèdent.
fn read_records(file: &mut rvt::RevitFile, plan: &mut Plan<'_>, infos: &mut BTreeMap<u64, Info>, resolver: &mut Resolver, census_seconds: &mut f64) -> Result<usize> {
    let step = Stopwatch::start();
    let census = if plan.skip_irrelevant { census(file).ok() } else { None };
    *census_seconds = step.seconds();
    let Some(census) = census else {
        // Tout lire : le plan l'exige, ou le balayage a échoué (lecture de ce que rvt-rs refuse aussi).
        native::extract_graphs(file, &read_options(102, BTreeSet::new()), |record| ingest_record(record, infos, resolver, plan.retained.as_deref_mut()))?;
        return Ok(0);
    };

    // Ce qui se décode, et quand : les enregistrements dont le propriétaire est un élément qui peut
    // lui-même être écarté attendent de savoir s'il est placé.
    // Types, familles, niveaux, phases, matériaux et définitions de paramètres se décodent toujours, et
    // en premier : les définitions de paramètres vivent dans ces enregistrements, et les propriétés ne
    // projettent les autres (aussitôt décodés, pour ne pas garder leurs graphes) qu'après les avoir lues.
    let always = |class: &str| is_support_class(class) || census.definitions.contains(class);
    let is_container = |id: u64| census.classes.get(&id).is_some_and(|class| decoded_class(class) && !always(class));
    let mut first: BTreeSet<u64> = BTreeSet::new();
    let mut support: BTreeSet<u64> = BTreeSet::new();
    let mut round: BTreeSet<u64> = BTreeSet::new();
    let mut pending: BTreeMap<u64, u64> = BTreeMap::new();
    for (id, class) in &census.classes {
        if census.definitions.contains(class) {
            first.insert(*id);
            continue;
        }
        if always(class) {
            support.insert(*id);
            continue;
        }
        if !decoded_class(class) {
            continue;
        }
        match census.owners.get(id).copied().and_then(|owner| u64::try_from(owner).ok()) {
            Some(owner) if is_container(owner) => {
                pending.insert(*id, owner);
            }
            _ => {
                round.insert(*id);
            }
        }
    }

    let mut decoded: BTreeSet<u64> = BTreeSet::new();
    if !first.is_empty() {
        native::extract_graphs(file, &read_options(102, first), |record| ingest_record(record, infos, resolver, plan.retained.as_deref_mut()))?;
    }
    if let Some(retained) = plan.retained.as_deref_mut() {
        retained.definitions_done();
    }
    // Le reste des classes d'appui, et les éléments qui n'ont pas de propriétaire à attendre.
    round.extend(support);
    let mut dropped: BTreeSet<u64> = BTreeSet::new();
    for _ in 0..8 {
        if round.is_empty() {
            break;
        }
        let ids = std::mem::take(&mut round);
        native::extract_graphs(file, &read_options(102, ids.clone()), |record| ingest_record(record, infos, resolver, plan.retained.as_deref_mut()))?;
        decoded.extend(ids);
        // Ce qui attendait un propriétaire décodé : on le décode s'il est placé, on l'écarte sinon (et
        // ce qui l'attendait à son tour).
        loop {
            let mut changed = false;
            for (id, owner) in pending.clone() {
                if dropped.contains(&owner) || infos.get(&owner).is_some_and(|info| info.unplaced != -1) {
                    pending.remove(&id);
                    dropped.insert(id);
                    changed = true;
                } else if decoded.contains(&owner) {
                    pending.remove(&id);
                    round.insert(id);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
    }
    // Un propriétaire qui ne s'est jamais décodé (cycle, enregistrement illisible) ne dit rien de ce qui
    // l'attend : on le décode.
    round.extend(pending.keys());
    if !round.is_empty() {
        native::extract_graphs(file, &read_options(102, round), |record| ingest_record(record, infos, resolver, plan.retained.as_deref_mut()))?;
    }
    Ok(dropped.len())
}

/// La classe et le propriétaire de chaque enregistrement d'élément (canal 102), lus sans décoder aucun
/// graphe : la classe est celle que désigne la balise qui ouvre l'enregistrement, le propriétaire est dans
/// l'index des éléments. Les deux viennent de l'index des groupes (`native::index`, qui inflate chaque partition une
/// fois, groupe par groupe, sans rien garder d'inflaté) et du préambule (`native::preamble`), que les extractions
/// partagent.
struct Census {
    classes: BTreeMap<u64, String>,
    owners: BTreeMap<u64, i64>,
    /// Les classes qui portent des définitions de paramètres (voir `definition_classes`).
    definitions: BTreeSet<String>,
}

fn census(file: &mut rvt::RevitFile) -> Result<Census> {
    let preamble = native::preamble(file)?;
    let (registry, index) = (&preamble.registry, &preamble.index);
    let (version, _) = native::format_year(file).context("l'année de Revit du fichier ne se lit pas")?;
    let segments = native::index::index(file, registry, version)?;
    let mut census = Census { classes: BTreeMap::new(), owners: BTreeMap::new(), definitions: definition_classes(registry) };
    for group in &segments.groups {
        if group.source.content_key.is_some() || group.source.channel != 102 {
            continue;
        }
        let frames = group.frames.as_ref().map_err(|error| anyhow::anyhow!("{error}"))?;
        for frame in frames {
            if let Some(identity) = index.identities.get(&frame.id) {
                let class = registry.class(frame.tag).map_or("", |class| class.name.as_str());
                // Un élément a plusieurs enregistrements quand il a changé de partition : même classe.
                census.classes.entry(frame.id).or_insert_with(|| class.to_string());
                census.owners.insert(frame.id, identity.owning_element_id);
            }
        }
    }
    Ok(census)
}

/// Lit les graphiques des symboles `needed` et, de proche en proche, de ceux qu'ils placent à leur tour
/// (une famille imbriquée), et les range dans la scène : chaque symbole est parcouru une fois, ses nœuds
/// maillés, puis son graphe libéré (`settle_symbol`), dès que les symboles qu'il place sont connus eux-mêmes.
/// Un symbole lu avant ceux qu'il place attend, sous `PARKED_BODY_BYTES` ; au-delà, il est relu à la vague
/// suivante. Les graphes gardés (`Scene::symbols`) sont ceux dont la forme dépend de l'instance, ou tous en
/// mode prudent et quand `Scene::symbol_shapes` est faux.
fn load_symbols(file: &mut rvt::RevitFile, scene: &mut Scene, mut needed: BTreeSet<u64>) -> Result<()> {
    // Symboles demandés qu'aucun enregistrement lisible ne donne : ceux qui les placent n'ont rien à attendre.
    let mut absent: BTreeSet<u64> = BTreeSet::new();
    // Graphes en attente d'un symbole imbriqué : (graphe, octets de l'enregistrement, symboles placés).
    let mut parked: BTreeMap<u64, (ObjectGraph, usize, BTreeSet<u64>)> = BTreeMap::new();
    let mut parked_bytes = 0usize;
    for _ in 0..16 {
        needed.retain(|id| !scene.symbols.contains_key(id) && !scene.cache.has_shape(*id) && !parked.contains_key(id) && !absent.contains(id));
        if needed.is_empty() {
            break;
        }
        let requested = std::mem::take(&mut needed);
        let mut retry: BTreeSet<u64> = BTreeSet::new();
        let summary = native::extract_graphs(file, &read_options(103, requested.clone()), |record| {
            let id = record.identity.element_id;
            let Some(graph) = record.graph else { return Ok(()) };
            let placed = symbol_references(&graph);
            needed.extend(placed.iter().copied());
            if !scene.symbol_shapes {
                scene.symbols.insert(id, graph);
                return Ok(());
            }
            let known = |symbol: &u64| scene.symbols.contains_key(symbol) || scene.cache.has_shape(*symbol) || absent.contains(symbol);
            if placed.iter().all(known) {
                settle_symbol(scene, id, graph);
                settle_parked(scene, &mut parked, &mut parked_bytes, &absent);
            } else if parked_bytes + record.source.body_bytes <= PARKED_BODY_BYTES {
                parked_bytes += record.source.body_bytes;
                parked.insert(id, (graph, record.source.body_bytes, placed));
            } else {
                retry.insert(id);
            }
            Ok(())
        })
        .context("les graphiques des symboles de famille n'ont pas pu être lus")?;
        absent.extend(requested.iter().filter(|id| !scene.symbols.contains_key(id) && !scene.cache.has_shape(**id) && !parked.contains_key(id) && !retry.contains(id)).copied());
        let _ = summary;
        settle_parked(scene, &mut parked, &mut parked_bytes, &absent);
        needed.extend(retry);
    }
    // Ce qui attend encore (symboles qui se placent en cycle, ou plus de seize niveaux d'imbrication) : les graphes
    // se rejoignent dans la scène, puis chacun se parcourt à travers les autres, comme une instance l'aurait fait.
    let leftover: Vec<u64> = parked.keys().copied().collect();
    for (id, (graph, _, _)) in std::mem::take(&mut parked) {
        scene.symbols.insert(id, graph);
    }
    for id in leftover {
        if let Some(graph) = scene.symbols.remove(&id) {
            settle_symbol(scene, id, graph);
        }
    }
    Ok(())
}

/// Parcourt le symbole `id` pour lui-même, garde sa forme et ses nœuds maillés dans le cache de la scène, et
/// libère son graphe ; si sa forme dépend de l'instance, le graphe est gardé dans `Scene::symbols`.
fn settle_symbol(scene: &mut Scene, id: u64, graph: ObjectGraph) {
    // Le graphe est dans la scène le temps du parcours : un symbole qui se place lui-même (cycle) se voit.
    scene.symbols.insert(id, graph);
    let shape = {
        let resolver = |owner: u64| scene.symbol(owner);
        let edges = |owner: u64, graph: &ObjectGraph| scene.cache.edges(owner, graph);
        let shapes = |owner: u64| scene.cache.shape(owner);
        scene.symbols.get(&id).and_then(|graph| faces::select::symbol_shape(graph, id, &resolver, &edges, &shapes, DETAIL_LEVEL))
    };
    let Some(shape) = shape else { return };
    let graph = scene.symbols.remove(&id).expect("le graphe du symbole vient d'être rangé");
    for event in &shape.events {
        if let faces::select::ShapeEvent::Node { owner, object_index, .. } = event {
            if *owner == id {
                scene.cache.keep(id, *object_index, || faces::decode(&graph, *object_index));
            }
        }
    }
    scene.cache.insert_shape(id, shape);
}

/// Parcourt les symboles en attente dont les symboles imbriqués sont maintenant connus, jusqu'à ce que plus
/// aucun ne puisse l'être.
fn settle_parked(scene: &mut Scene, parked: &mut BTreeMap<u64, (ObjectGraph, usize, BTreeSet<u64>)>, parked_bytes: &mut usize, absent: &BTreeSet<u64>) {
    loop {
        let ready: Vec<u64> = parked
            .iter()
            .filter(|(id, (_, _, placed))| placed.iter().all(|symbol| symbol == *id || scene.symbols.contains_key(symbol) || scene.cache.has_shape(*symbol) || absent.contains(symbol)))
            .map(|(id, _)| *id)
            .collect();
        if ready.is_empty() {
            return;
        }
        for id in ready {
            let Some((graph, bytes, _)) = parked.remove(&id) else { continue };
            *parked_bytes -= bytes;
            settle_symbol(scene, id, graph);
        }
    }
}

/// Mailler un lot de graphes, puis les libérer.
fn flush<T: Send>(scene: &Scene, batch: Vec<(u64, ObjectGraph)>, threads: usize, work: &(dyn Fn(&Scene, u64, &ObjectGraph) -> T + Sync), mesh_seconds: &mut f64) -> Vec<(u64, T)> {
    if batch.is_empty() {
        return Vec::new();
    }
    let step = Stopwatch::start();
    let done = map_parallel(&batch, threads, &|(id, graph)| work(scene, *id, graph));
    *mesh_seconds += step.seconds();
    batch.into_iter().map(|(id, _)| id).zip(done).collect()
}

/// Ce que vient de rendre un lot : chaque résultat achevé part à `emit` sur-le-champ, dans l'ordre du lot (celui du
/// fichier) ; ce qui attend encore ses symboles (`pending`, quand il y a un `finish` à venir), ou tout quand rien
/// n'émet, reste au résultat du balayage.
fn settle<T>(scene: &Scene, done: Vec<(u64, T)>, finishing: bool, pending: &(dyn Fn(&T) -> bool + Sync), emit: &mut Option<&mut dyn FnMut(&Scene, u64, T) -> Result<()>>, results: &mut BTreeMap<u64, Option<T>>) -> Result<()> {
    for (id, result) in done {
        match emit.as_deref_mut() {
            Some(emit) if !(finishing && pending(&result)) => emit(scene, id, result)?,
            _ => {
                results.insert(id, Some(result));
            }
        }
    }
    Ok(())
}

/// Applique `finish` sur place à chaque résultat, sur `threads` fils quand il y en a.
#[cfg(not(target_arch = "wasm32"))]
fn finish_parallel<T: Send>(scene: &Scene, drafts: &mut [(u64, T)], threads: usize, finish: &(dyn Fn(&Scene, u64, &mut T) + Sync)) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    if threads <= 1 || drafts.len() < 2 {
        for (id, result) in drafts.iter_mut() {
            finish(scene, *id, result);
        }
        return;
    }
    let next = AtomicUsize::new(0);
    let cells: Vec<std::sync::Mutex<Option<&mut (u64, T)>>> = drafts.iter_mut().map(|draft| std::sync::Mutex::new(Some(draft))).collect();
    std::thread::scope(|scope| {
        for _ in 0..threads.min(cells.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(cell) = cells.get(index) else { break };
                if let Some((id, result)) = cell.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
                    finish(scene, *id, result);
                }
            });
        }
    });
}

/// WebAssembly n'a pas de fils : un élément après l'autre.
#[cfg(target_arch = "wasm32")]
fn finish_parallel<T: Send>(scene: &Scene, drafts: &mut [(u64, T)], _threads: usize, finish: &(dyn Fn(&Scene, u64, &mut T) + Sync)) {
    for (id, result) in drafts.iter_mut() {
        finish(scene, *id, result);
    }
}

/// Applique `f` à chaque élément de `items`, sur `threads` fils, en gardant l'ordre.
#[cfg(not(target_arch = "wasm32"))]
fn map_parallel<I: Sync, O: Send>(items: &[I], threads: usize, f: &(dyn Fn(&I) -> O + Sync)) -> Vec<O> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    if threads <= 1 || items.len() < 2 {
        return items.iter().map(f).collect();
    }
    let next = AtomicUsize::new(0);
    let mut done: Vec<(usize, O)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads.min(items.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(index) else { break };
                        out.push((index, f(item)));
                    }
                    out
                })
            })
            .collect();
        workers.into_iter().flat_map(|worker| worker.join().expect("un fil de maillage a paniqué")).collect()
    });
    done.sort_by_key(|(index, _)| *index);
    done.into_iter().map(|(_, output)| output).collect()
}

/// WebAssembly n'a pas de fils : un élément après l'autre.
#[cfg(target_arch = "wasm32")]
fn map_parallel<I: Sync, O: Send>(items: &[I], _threads: usize, f: &(dyn Fn(&I) -> O + Sync)) -> Vec<O> {
    items.iter().map(f).collect()
}

/// Les symboles de famille que les instances d'un graphe placent (`InstanceInfo.m_symbolId`).
pub fn symbol_references(graph: &ObjectGraph) -> BTreeSet<u64> {
    graph
        .objects
        .iter()
        .filter(|object| object.class_name == "InstanceInfo")
        .filter_map(|object| object.fields.get("m_symbolId"))
        .filter_map(identifier)
        .filter_map(|id| u64::try_from(id).ok())
        .filter(|id| *id > 0)
        .collect()
}

/// Un identifiant Revit sérialisé : un entier ou `{m_id: {m_id64: n}}`.
fn identifier(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    ["m_id", "m_id64"].iter().find_map(|key| value.get(*key)).and_then(identifier)
}

/// La forme enregistrée d'un élément, maillée.
pub struct Shape {
    pub mesh: ElementMesh,
    /// Symboles de famille dont l'élément place la forme (`source_owner_id` des primitives).
    pub sources: BTreeSet<u64>,
    /// Diagnostics de décodage (surfaces non prises en charge, filtres refusés…).
    pub diagnostics: Vec<String>,
    /// Faces dont Revit n'a pas de surface bornée que l'on sait mailler.
    pub unbounded_faces: usize,
    /// Leur classe de surface et la raison.
    pub failures: Vec<(String, String)>,
    /// L'enregistrement a un vrai graphique (racine `GElement`). Un élément sans graphique (style,
    /// matériau, paramètre, police…) a pour racine un `SerializedDummy` : rien à dessiner, rien de perdu.
    pub graphics: bool,
    /// La forme n'a pas été gardée parce qu'elle dépasse `MAX_ELEMENT_TRIANGLES` : le maillage est vide, un diagnostic
    /// le dit.
    pub too_dense: bool,
    /// La forme n'a pas été maillée parce que le plafond de triangles maillés du fichier était atteint
    /// (`Scene::hard_limit`) : le maillage est vide, un diagnostic le dit. Ce n'est pas une forme trop dense : l'élément se
    /// montre par sa boîte comme ceux que le budget remplace (`geometry::Outlet`), et se compte avec eux.
    pub capped: bool,
    /// Les primitives maillées, en attente d'instances dont le symbole n'était pas encore lu (`faces::Meshes::pending`) :
    /// `complete` les achève et fabrique alors le maillage. `None` quand la forme est finie.
    pub draft: Option<faces::Meshes>,
}

impl Shape {
    /// Au moins une face manque : « Forme Revit partielle ».
    pub fn partial(&self) -> bool {
        !self.diagnostics.is_empty() || self.unbounded_faces > 0
    }

    /// Une forme qu'on ne garde pas (trop dense) : rien à dessiner, un diagnostic dit pourquoi, et la boîte
    /// englobante de l'élément prend le relais (`geometry::from_saved`).
    fn refused(graphics: bool, reason: String) -> Shape {
        Shape { mesh: ElementMesh::default(), sources: BTreeSet::new(), diagnostics: vec![reason], unbounded_faces: 0, failures: Vec::new(), graphics, too_dense: true, capped: false, draft: None }
    }

    /// Une forme qu'on ne maille pas parce que le plafond de triangles maillés du fichier est atteint : la boîte
    /// englobante de l'élément prend le relais, comme pour une forme que le budget remplace.
    fn capped(graphics: bool, reason: String) -> Shape {
        Shape { mesh: ElementMesh::default(), sources: BTreeSet::new(), diagnostics: vec![reason], unbounded_faces: 0, failures: Vec::new(), graphics, too_dense: false, capped: true, draft: None }
    }
}

/// Mailler les graphiques d'un élément. Si une instance attend un symbole pas encore lu (`Scene::defer`), la forme
/// rendue est un brouillon (`Shape::draft`), que [`complete`] achève après la lecture des symboles.
pub fn shape(scene: &Scene, id: u64, graph: &ObjectGraph) -> Shape {
    // rvt-rs d'abord, puis `faces` pour ce qu'il refuse : voir `faces::graphics_with`.
    let graphics = graph.objects.first().is_some_and(|root| root.class_name == "GElement");
    if scene.meshed.load(Ordering::Relaxed) > scene.hard_limit {
        return Shape::capped(graphics, format!("forme non maillée : le plafond de {} triangles maillés pour le fichier est atteint", scene.hard_limit));
    }
    let meshes = faces::graphics_with(graph, &|owner| scene.symbol(owner), &scene.settings(id));
    if !meshes.pending.is_empty() {
        return Shape { mesh: ElementMesh::default(), sources: BTreeSet::new(), diagnostics: Vec::new(), unbounded_faces: 0, failures: Vec::new(), graphics, too_dense: false, capped: false, draft: Some(meshes) };
    }
    finish_shape(scene, id, graphics, meshes)
}

/// Achève un brouillon (voir `shape`) : les instances laissées pour plus tard sont rejouées à leur place, puis la
/// forme est maillée comme si tous les symboles avaient été là.
pub fn complete(scene: &Scene, id: u64, shape: &mut Shape) {
    let Some(mut meshes) = shape.draft.take() else { return };
    // Le plafond de maillage vaut aussi pour les brouillons : achever une instance est mailler ses symboles, le gros du travail
    // de bien des fichiers. Au-delà, l'élément n'est pas maillé : sa boîte enregistrée le montre (`Shape::capped`).
    if scene.meshed.load(Ordering::Relaxed) > scene.hard_limit {
        *shape = Shape::capped(shape.graphics, format!("instance dont les symboles n'étaient pas lus, non maillée : le plafond de {} triangles maillés pour le fichier est atteint", scene.hard_limit));
        return;
    }
    faces::complete(&mut meshes, &|owner| scene.symbol(owner), &scene.settings(id));
    *shape = finish_shape(scene, id, shape.graphics, meshes);
}

/// La forme d'un élément à partir de ses primitives maillées.
fn finish_shape(scene: &Scene, id: u64, graphics: bool, meshes: faces::Meshes) -> Shape {
    let raw: usize = meshes.primitives.iter().map(|primitive| primitive.triangles.len()).sum();
    scene.meshed.fetch_add(raw, Ordering::Relaxed);
    if raw > MAX_ELEMENT_TRIANGLES {
        return Shape::refused(graphics, format!("forme trop dense : {raw} triangles, au-delà du plafond de {MAX_ELEMENT_TRIANGLES} par élément"));
    }

    let mut sources = BTreeSet::new();
    let mut paints = Vec::with_capacity(meshes.primitives.len());
    for (position, primitive) in meshes.primitives.iter().enumerate() {
        if let Some(owner) = primitive.source_owner_id {
            sources.insert(owner);
        }
        // Un `GPolyMesh` sans matériau ni style prend le matériau de son calque, s'il en a un (voir `materials`).
        let layer = meshes.layers.get(position).copied().unwrap_or(-1);
        let material = scene.resolver.resolve_in_layer(id, primitive.source_owner_id, primitive.face_tag, primitive.render_style_id, primitive.material_id, layer);
        paints.push(paint(material.as_ref()));
    }
    let faces: Vec<Face<'_>> = meshes
        .primitives
        .iter()
        .enumerate()
        .map(|(position, primitive)| Face {
            vertices: &primitive.vertices,
            normals: Some(&primitive.normals),
            triangles: &primitive.triangles,
            paint: paints[position],
            overlay: meshes.overlay.get(position).copied().unwrap_or(false),
        })
        .collect();
    let mesh = ElementMesh::build(&faces);
    Shape { mesh, sources, diagnostics: meshes.diagnostics, unbounded_faces: meshes.unbounded_faces, failures: meshes.failures, graphics, too_dense: false, capped: false, draft: None }
}

/// La couleur d'une face. `base_color` de rvt-rs est le RVB enregistré par Revit divisé par 255,
/// sans courbe de transfert (rvt-rs le dit : « saved packed graphics RGB / 255 ») : ce sont déjà
/// des valeurs sRGB, il n'y a rien à convertir. Le profil par défaut de rvt-rs force l'alpha de
/// `base_color` à 1 ; la vraie opacité est dans `saved_opacity`. Matériau introuvable : gris neutre.
pub fn paint(material: Option<&RenderMaterial>) -> Paint {
    match material {
        Some(material) => {
            let opacity = material.saved_opacity.unwrap_or(material.base_color[3]);
            Paint::from_srgb([material.base_color[0], material.base_color[1], material.base_color[2]], opacity)
        }
        None => Paint::NEUTRAL,
    }
}
