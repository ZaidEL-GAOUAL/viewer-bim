//! Phases du projet et vues 3D enregistrées, lues dans les enregistrements natifs de Revit.
//!
//! Ce que Revit enregistre, et que ce module en retient (les champs ont été relevés sur les octets des
//! fichiers d'essai, `cargo run --release --example views`) :
//!
//! - `ProjectPhase` : une phase du projet (son nom). `AllProjectPhases.m_phaseIds` les range dans l'ordre
//!   chronologique du projet.
//! - `PhaseFilterElem` : un filtre de phase. `m_phaseStatusPresentation` a sept entrées, une par état d'un
//!   élément dans la phase d'une vue (`ElementOnPhaseStatus` de l'API de Revit : 0 aucun, 1 passé, 2 existant, 3
//!   démoli, 4 nouveau, 5 temporaire, 6 futur), chacune valant 0 (ne pas afficher), 1 (afficher selon la catégorie) ou 2
//!   (afficher avec le remplacement graphique de l'état : `PhaseStatusPresentation`). Les filtres livrés avec Revit
//!   (« Tout afficher », « Afficher nouveau »…) redonnent exactement le comportement documenté de Revit.
//! - `AllProjectPhases.m_arrPhasingOverrides` : le remplacement graphique de chaque état (existant, démoli, nouveau,
//!   temporaire), dont le matériau de remplacement (`Phase - Exist`, `Phase - Demo`…) donne la couleur et la
//!   transparence d'une vue ombrée.
//! - `DBView3d` : une vue 3D (nom, repère de la caméra, élément `Viewer3d`, phase et filtre de phase dans ses jeux de
//!   paramètres, éléments masqués, catégories masquées). `Viewer3d` : la caméra (perspective ou parallèle, fenêtre de
//!   recadrage) et sa boîte de coupe ; `ModelClipBox` : la boîte de coupe elle-même.
//! - `DBViewPlan` : un plan d'étage (`m_planViewType` 1 : vu de dessus ; les plans de plafond, 2, ne sont pas lus), avec les mêmes
//!   champs qu'une vue 3D et sa plage de vue (`PlanViewRange2`, à défaut `PlanViewRange`, et les trois hauteurs absolues que Revit
//!   en tire). `Viewer` : son recadrage ; `DBViewType` (ou `DBViewTypeAreaPlan` pour un plan de surface, dont le `m_planViewType` est aussi 1) : le nom de
//!   son type (« Floor Plan », « Structural Plan », « Gross Building »…). Voir [`ViewRange`].
//!
//! Le module ne lit rien dans le fichier : `properties::Retained::observe` lui passe chaque enregistrement que la
//! géométrie décode déjà (aucune passe de plus), et `properties::build` lui demande les sections `phases` et `views` du
//! contrat de métadonnées (`docs/contrat-metadonnees.md`).
//!
//! Avant Revit 2015, le projet écrit aussi les vues, les phases et les filtres de phase de chaque famille chargée, possédés
//! (ElemTable) par l'enregistrement `Family` de cette famille (`native::families`). Chaque enregistrement est noté avec son
//! propriétaire, et [`Digest::settle`], une fois toute la lecture faite, écarte ceux que le prédicat commun reconnaît : sans
//! cela, `DynamoSample_2014.rvt` écrivait 41 vues et 12 filtres de phase là où `DynamoSample_2023.rvt`, le même modèle, en écrit 7
//! et 7, et l'ordre des phases du hangar venait d'un `AllProjectPhases` de famille.

mod camera;
mod write;

pub use camera::{Camera, SectionBox, plan_camera};
pub use write::{Elements, phases_json, views_json};

use crate::native::FamilyOwner;
use rvt::research::native_parameters::{GraphObject, ObjectGraph};
use rvt::research::native_saved_mesh::pointer;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Les classes d'enregistrements dont ce module se sert.
pub fn is_view_class(class: &str) -> bool {
    matches!(class, "ProjectPhase" | "AllProjectPhases" | "PhaseFilterElem" | "DBView3d" | "Viewer3d" | "ModelClipBox" | "DBViewPlan" | "Viewer" | "DBViewType" | "DBViewTypeAreaPlan")
}

/// Paramètres intégrés d'une vue : sa phase et son filtre de phase (`VIEW_PHASE`, `VIEW_PHASE_FILTER`).
const VIEW_PHASE: i64 = -1012102;
const VIEW_PHASE_FILTER: i64 = -1012103;

/// État d'un élément dans la phase d'une vue (`ElementOnPhaseStatus`), dans l'ordre de `m_phaseStatusPresentation`.
pub const STATUS_NAMES: [&str; 7] = ["none", "past", "existing", "demolished", "new", "temporary", "future"];

/// L'avertissement des `n` phases, filtres de phase ou vues gardés que possède une `Family` dont la définition ne se lit pas
/// (`Digest::unread`) : ils peuvent venir d'une famille chargée. Rien pour 0.
pub fn unread_warning(n: usize) -> Option<String> {
    match n {
        0 => None,
        1 => Some("1 enregistrement de phase, de filtre de phase ou de vue appartient à une famille dont la définition ne se lit pas : il peut venir d'une famille chargée.".to_string()),
        n => Some(format!("{n} enregistrements de phases, de filtres de phase ou de vues appartiennent à une famille dont la définition ne se lit pas : ils peuvent venir d'une famille chargée.")),
    }
}

/// Un filtre de phase : son nom et, par état, ce qu'il en fait.
#[derive(Debug, Clone, PartialEq)]
pub struct PhaseFilter {
    pub name: String,
    /// Filtre appliqué aux vues neuves (`m_bDefault`).
    pub default: bool,
    /// Une entrée par état, dans l'ordre de [`STATUS_NAMES`] : 0 masqué, 1 selon la catégorie, 2 remplacé.
    pub presentation: [u8; 7],
}

/// Une vue 3D, telle que `DBView3d` la décrit.
#[derive(Debug, Clone, Default)]
pub struct ViewRecord {
    pub id: i64,
    pub name: String,
    /// Vue nommée par l'utilisateur ; la vue par défaut « {3D} » ne l'est pas.
    pub named: bool,
    /// Gabarit de vue : ce n'est pas une vue qu'on ouvre.
    pub template: bool,
    /// Œil (pieds, repère de Revit).
    pub eye: [f64; 3],
    /// Droite, haut, et sens inverse du regard de la vue : `m_horzDir`, `m_vertDir`, `m_viewDir`.
    pub right: [f64; 3],
    pub up: [f64; 3],
    pub back: [f64; 3],
    /// L'élément `Viewer3d` de la vue.
    pub viewer: i64,
    pub phase: Option<i64>,
    pub phase_filter: Option<i64>,
    pub hidden_elements: Vec<i64>,
    /// Catégories masquées : un identifiant négatif est une `BuiltInCategory`, un identifiant positif l'élément `CategoryElem` d'une catégorie
    /// du projet (celle d'un import CAD, ou une sous-catégorie).
    pub hidden_categories: Vec<i64>,
    /// `m_importsExcluded` : la vue masque les imports CAD (« Imports dans les familles » décoché dans les catégories d'import).
    pub imports_excluded: bool,
}

/// La plage de vue d'un plan d'étage, telle que Revit l'écrit : les hauteurs absolues qu'il en a déduites (pieds, repère du projet) et les
/// niveaux et décalages qui les ont données, dans l'ordre **coupe, haut, bas, profondeur de vue, (inutilisé)**.
///
/// Ce que les fichiers d'essai en disent (`examples/views.rs --dump DBViewPlan`, mesuré sur les 543 plans des 55 fichiers) :
/// - `m_cutPlaneElev`, `m_bottomClipElev` et `m_topClipElev` sont déjà résolus par Revit ; une valeur de plus de 1e8 en valeur absolue
///   (±999 999 999,99) veut dire « illimité » ;
/// - les niveaux et les décalages sont dans `PlanViewRange2` (`m_viewDepthPlaneLevelIds` et `m_viewDepthPlaneOffsets` dans les fichiers
///   récents, `m_levelIds` et `m_offsets` dans les autres : même sens), à défaut dans `PlanViewRange` (`m_levelPos`, `m_offsets`) ;
/// - un identifiant de niveau -1 est « illimité », -4 « le niveau en dessous », -2 et -3 les autres niveaux relatifs des gabarits.
///
/// Vérifié sur les plans des fichiers d'essai dont la coupe et le haut (ou le bas) sont sur le même niveau : coupe − décalage de coupe =
/// haut − décalage du haut (527 plans sur 527) et = bas − décalage du bas (502 sur 502), ce qui fixe l'ordre des cinq entrées.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewRange {
    /// `m_cutPlaneElev` : le plan de coupe.
    pub cut: f64,
    /// `m_bottomClipElev` : le bas de la plage de vue.
    pub bottom_clip: f64,
    /// Les cinq niveaux (identifiant d'élément, -1 illimité) ou positions de niveau (`PlanViewRange.m_levelPos`).
    pub levels: Option<[i64; 5]>,
    /// Les cinq décalages, en pieds.
    pub offsets: Option<[f64; 5]>,
}

/// Une valeur de plage de plus de 1e8 pieds en valeur absolue : Revit écrit ±999 999 999,99 pour « illimité ».
fn is_unlimited(feet: f64) -> bool {
    !feet.is_finite() || feet.abs() > 1e8
}

impl ViewRange {
    /// Le plan de coupe, en pieds ; `None` s'il est absent ou illimité (le plan n'a alors pas de hauteur à montrer).
    pub fn cut_feet(&self) -> Option<f64> {
        (!is_unlimited(self.cut)).then_some(self.cut)
    }

    /// La profondeur de vue (le bas de ce que le plan montre sous sa coupe), en pieds ; `None` si elle n'a pas de limite.
    ///
    /// 1. Si le niveau de la profondeur est celui du bas de la plage (le même identifiant, ou la même position de niveau, et ce n'est pas
    ///    « illimité »), c'est `m_bottomClipElev` − décalage du bas + décalage de la profondeur : la profondeur est à son décalage du même
    ///    niveau que le bas.
    /// 2. Sinon, si le niveau de la profondeur est « illimité » (-1), ou si `m_bottomClipElev` l'est, il n'y a pas de limite.
    /// 3. Sinon, c'est `m_bottomClipElev` : la profondeur est sur un autre niveau dont le fichier ne donne pas l'altitude ; le bas de la
    ///    plage la borne par le haut (le plan montre au moins ce qui est entre la coupe et ce bas, pas plus bas : prudent).
    pub fn depth_feet(&self) -> Option<f64> {
        if is_unlimited(self.bottom_clip) {
            return None;
        }
        if let (Some(levels), Some(offsets)) = (self.levels, self.offsets) {
            if levels[3] == -1 {
                return None;
            }
            if levels[2] == levels[3] {
                let depth = self.bottom_clip - offsets[2] + offsets[3];
                return (!is_unlimited(depth)).then_some(depth);
            }
        }
        Some(self.bottom_clip)
    }
}

/// Un plan d'étage (`DBViewPlan` dont `m_planViewType` est 1 et qui n'est pas un gabarit).
#[derive(Debug, Clone)]
pub struct Plan {
    /// Ce qu'un plan a de commun avec une vue 3D : nom, repère, `Viewer`, phase, éléments et catégories masqués.
    pub view: ViewRecord,
    /// L'élément `DBViewType` du plan (son nom est celui du type : « Floor Plan »), -1 sans type.
    pub type_id: i64,
    /// `m_bUseTrueNorth` : le plan est orienté sur le nord vrai. `m_vertDir` porte déjà cette rotation (voir `camera::plan_camera`) : le
    /// drapeau n'est qu'une information.
    pub true_north: bool,
    pub range: ViewRange,
}

/// La caméra d'une vue 3D : `Viewer3d`.
#[derive(Debug, Clone)]
pub struct Viewer {
    /// 1 : projection parallèle, 2 : perspective (relevé sur les vues « Perspective… » des fichiers d'essai).
    pub projection: i64,
    /// Distance de l'œil au plan sur lequel la fenêtre de recadrage est écrite (`m_projDist`, 0,1 pied).
    pub plane_distance: f64,
    pub crop: Bounded,
    pub clip_box: i64,
}

/// Un volume borné de Revit (`BoundedSpace`) : un repère (`basis`, une ligne par axe, dans le repère du projet), son
/// origine, et pour chaque axe les décalages (haut, bas) du volume par rapport à l'origine, actifs ou non.
#[derive(Debug, Clone, PartialEq)]
pub struct Bounded {
    pub basis: [[f64; 3]; 3],
    pub origin: [f64; 3],
    /// Par axe : [décalage du côté positif, décalage du côté négatif (≤ 0)], en pieds.
    pub offsets: [[f64; 2]; 3],
    pub active: [[bool; 2]; 3],
    pub on: bool,
}

/// Ce qu'un enregistrement `AllProjectPhases` apporte : l'ordre des phases et le matériau de remplacement de chaque état.
#[derive(Debug, Default)]
struct PhaseTable {
    id: i64,
    /// `m_phaseIds`.
    order: Vec<i64>,
    /// État (index de [`STATUS_NAMES`]) → matériau de remplacement (`m_arrPhasingOverrides`).
    status_materials: BTreeMap<usize, i64>,
}

/// Tout ce que les enregistrements de phases et de vues ont donné.
#[derive(Debug, Default)]
pub struct Digest {
    /// Phases : identifiant → nom.
    phases: BTreeMap<i64, String>,
    /// Un `AllProjectPhases` par enregistrement, dans l'ordre où ils ont été lus : le dernier donne l'ordre des phases, et chaque
    /// état prend le matériau du dernier qui en désigne un (un projet n'en a qu'un ; avant Revit 2015, chaque famille chargée
    /// avait le sien, voir [`Digest::settle`]).
    tables: Vec<PhaseTable>,
    filters: BTreeMap<i64, PhaseFilter>,
    /// Matériaux : identifiant → (couleur au format COLORREF de Windows, transparence 0 à 1).
    materials: HashMap<i64, (u32, f64)>,
    views: BTreeMap<i64, ViewRecord>,
    viewers: BTreeMap<i64, Viewer>,
    boxes: BTreeMap<i64, Bounded>,
    /// Les plans d'étage (gabarits, plans de plafond et autres sens de regard écartés dès la lecture).
    plans: BTreeMap<i64, Plan>,
    /// Le recadrage de chaque `Viewer` lu (les plans, mais aussi les coupes, façades et détails : `settle` ne garde que ceux des plans).
    plan_viewers: BTreeMap<i64, Bounded>,
    /// Le nom de chaque `DBViewType` lu (`SymbolInfo.m_name`) : `settle` ne garde que ceux des plans.
    view_types: BTreeMap<i64, String>,
    /// Le propriétaire d'ElemTable de chaque enregistrement de phase, de filtre, de vue, de plan, de caméra ou de boîte de coupe lu : de
    /// quoi savoir, une fois toute la lecture faite, lesquels sont des pièces d'une famille chargée (`settle`). Un identifiant par
    /// enregistrement : quelques centaines au plus.
    owners: BTreeMap<i64, i64>,
    /// Enregistrements gardés que possède une `Family` dont on ne sait pas si elle est chargée (`FamilyOwner::Unread`, voir `settle`).
    unread: usize,
}

fn element_id(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    ["m_id", "m_id64"].into_iter().find_map(|key| value.get(key).and_then(element_id))
}

fn vector(value: Option<&Value>) -> Option<[f64; 3]> {
    let array = value?.as_array()?;
    if array.len() != 3 {
        return None;
    }
    let mut out = [0.0; 3];
    for (slot, item) in out.iter_mut().zip(array) {
        *slot = item.as_f64().filter(|x| x.is_finite())?;
    }
    Some(out)
}

fn matrix(value: Option<&Value>) -> Option<[[f64; 3]; 3]> {
    let array = value?.as_array()?;
    if array.len() != 3 {
        return None;
    }
    let mut out = [[0.0; 3]; 3];
    for (row, item) in out.iter_mut().zip(array) {
        *row = vector(Some(item))?;
    }
    Some(out)
}

/// Un `BoundedSpace` tel que Revit l'écrit : `{m_basis, m_boundActive, m_boundOffset, m_isOn, m_orig}`.
fn bounded(value: &Value) -> Option<Bounded> {
    let basis = matrix(value.get("m_basis"))?;
    let origin = vector(value.get("m_orig"))?;
    let pairs = value.get("m_boundOffset")?.as_array()?;
    let flags = value.get("m_boundActive")?.as_array()?;
    if pairs.len() != 3 || flags.len() != 3 {
        return None;
    }
    let mut offsets = [[0.0; 2]; 3];
    let mut active = [[false; 2]; 3];
    for axis in 0..3 {
        let pair = pairs[axis].as_array()?;
        let flag = flags[axis].as_array()?;
        for side in 0..2 {
            offsets[axis][side] = pair.get(side)?.as_f64().filter(|x| x.is_finite())?;
            active[axis][side] = flag.get(side)?.as_bool()?;
        }
    }
    Some(Bounded { basis, origin, offsets, active, on: value.get("m_isOn").and_then(Value::as_bool).unwrap_or(false) })
}

/// Le premier objet du graphe de cette classe.
fn object<'a>(graph: &'a ObjectGraph, class: &str) -> Option<&'a GraphObject> {
    graph.objects.iter().find(|object| object.class_name == class)
}

impl Digest {
    /// Un enregistrement d'élément (canal 102) vient d'être décodé : on en garde ce qui sert aux phases et aux vues, et son
    /// propriétaire d'ElemTable (`owner`, `-1` s'il n'en a pas) pour `settle`.
    pub fn observe(&mut self, id: u64, owner: i64, class: &str, graph: &ObjectGraph) {
        let id = id as i64;
        let Some(root) = graph.objects.first() else { return };
        if is_view_class(class) {
            self.owners.insert(id, owner);
        }
        let fields = &root.fields;
        match class {
            "ProjectPhase" => {
                if let Some(name) = fields.get("m_name").and_then(Value::as_str) {
                    self.phases.insert(id, name.to_string());
                }
            }
            "AllProjectPhases" => {
                let mut table = PhaseTable { id, order: fields.get("m_phaseIds").and_then(Value::as_array).into_iter().flatten().filter_map(element_id).collect(), ..PhaseTable::default() };
                for (index, object) in graph.objects.iter().enumerate() {
                    if object.class_name != "PhasingOverrides" {
                        continue;
                    }
                    let Some(status) = object.fields.get("m_elementOnPhaseStatus").and_then(Value::as_u64).map(|status| status as usize) else { continue };
                    let target = object.fields.get("m_oGMaterialOverrider").and_then(|field| pointer(graph, index, field).ok().flatten());
                    let material = target.and_then(|target| graph.objects.get(target)).and_then(|object| object.fields.get("m_materialId")).and_then(element_id);
                    if let Some(material) = material.filter(|material| *material >= 0) {
                        table.status_materials.insert(status, material);
                    }
                }
                self.tables.push(table);
            }
            "PhaseFilterElem" => {
                let entries: Vec<u8> = fields.get("m_phaseStatusPresentation").and_then(Value::as_array).into_iter().flatten().filter_map(|n| n.as_u64().and_then(|n| u8::try_from(n).ok())).collect();
                if let (Some(name), Ok(presentation)) = (fields.get("m_name").and_then(Value::as_str), <[u8; 7]>::try_from(entries)) {
                    self.filters.insert(id, PhaseFilter { name: name.to_string(), default: fields.get("m_bDefault").and_then(Value::as_bool).unwrap_or(false), presentation });
                }
            }
            "DBView3d" => {
                if let Some(view) = view_record(id, graph) {
                    self.views.insert(id, view);
                }
            }
            "Viewer3d" => {
                if let (Some(crop), Some(projection)) = (fields.get("m_boundedSpace").and_then(bounded), fields.get("m_projMethodType").and_then(Value::as_i64)) {
                    let plane_distance = fields.get("m_projDist").and_then(Value::as_f64).filter(|d| d.is_finite() && *d > 0.0).unwrap_or(0.1);
                    let clip_box = fields.get("m_modelClipBoxId").and_then(element_id).unwrap_or(-1);
                    self.viewers.insert(id, Viewer { projection, plane_distance, crop, clip_box });
                }
            }
            "ModelClipBox" => {
                if let Some(space) = fields.get("m_boundedSpace").and_then(bounded) {
                    self.boxes.insert(id, space);
                }
            }
            "DBViewPlan" => {
                if let Some(plan) = plan_record(id, graph) {
                    self.plans.insert(id, plan);
                }
            }
            "Viewer" => {
                if let Some(space) = fields.get("m_boundedSpace").and_then(bounded) {
                    self.plan_viewers.insert(id, space);
                }
            }
            // Le type d'un plan : « Floor Plan », « Structural Plan »… ; celui d'un plan de surface (« Gross Building ») est d'une classe à part.
            "DBViewType" | "DBViewTypeAreaPlan" => {
                if let Some(name) = object(graph, "SymbolInfo").and_then(|info| info.fields.get("m_name")).and_then(Value::as_str) {
                    self.view_types.insert(id, name.to_string());
                }
            }
            _ => {}
        }
    }

    /// Toute la lecture est faite : écarte ce que possèdent les familles chargées (avant Revit 2015), d'après le prédicat commun
    /// (`native::FamilyRule::owner`, qui remonte la chaîne des propriétaires : `family_owner` répond pour le propriétaire direct d'un
    /// enregistrement). La règle éteinte (Revit 2015 et après) n'écarte rien, et le résultat est celui d'avant.
    ///
    /// - Un enregistrement dont la chaîne mène à une `Family` chargée (`FamilyOwner::Definition`, ou `DefinitionChain`) est écarté.
    ///   Mesuré : tous les `DBView3d`, `ProjectPhase`, `AllProjectPhases` et `PhaseFilterElem` d'une famille chargée ont cette `Family`
    ///   pour propriétaire direct ; le `Viewer3d` d'une vue est à deux pas d'elle, la boîte de coupe de ce `Viewer3d` à trois : la
    ///   chaîne les écarte avec leur vue, sans règle de plus.
    /// - Un enregistrement dont la chaîne est ambiguë (`FamilyOwner::Unread` : une `Family` illisible, un maillon inconnu de l'index)
    ///   reste, et se compte (`unread`) : un avertissement le dit, comme pour les éléments dessinés.
    pub fn settle(&mut self, family_owner: impl Fn(i64) -> FamilyOwner) {
        let mut dropped: BTreeSet<i64> = BTreeSet::new();
        let mut unread: BTreeSet<i64> = BTreeSet::new();
        for (&id, &owner) in &self.owners {
            match family_owner(owner) {
                FamilyOwner::Definition | FamilyOwner::DefinitionChain => {
                    dropped.insert(id);
                }
                FamilyOwner::Unread => {
                    unread.insert(id);
                }
                FamilyOwner::Elsewhere => {}
            }
        }
        if !dropped.is_empty() {
            self.phases.retain(|id, _| !dropped.contains(id));
            self.tables.retain(|table| !dropped.contains(&table.id));
            self.filters.retain(|id, _| !dropped.contains(id));
            self.views.retain(|id, _| !dropped.contains(id));
            self.viewers.retain(|id, _| !dropped.contains(id));
            self.boxes.retain(|id, _| !dropped.contains(id));
            self.plans.retain(|id, _| !dropped.contains(id));
            self.owners.retain(|id, _| !dropped.contains(id));
        }
        // Les `Viewer` et les `DBViewType` n'ont de sens que par un plan : ceux des coupes, des façades et des plans écartés ne se gardent pas.
        let (viewers, types): (BTreeSet<i64>, BTreeSet<i64>) = (self.plans.values().map(|plan| plan.view.viewer).collect(), self.plans.values().map(|plan| plan.type_id).collect());
        self.plan_viewers.retain(|id, _| viewers.contains(id));
        self.view_types.retain(|id, _| types.contains(id));
        self.unread = unread.iter().filter(|id| self.phases.contains_key(id) || self.filters.contains_key(id) || self.views.contains_key(id) || self.plans.contains_key(id) || self.tables.iter().any(|table| table.id == **id)).count();
    }

    /// Phases, filtres de phase et vues gardés que possède une `Family` dont on ne sait pas si elle est chargée (voir `settle`).
    pub fn unread(&self) -> usize {
        self.unread
    }

    /// Un enregistrement de matériau : sa couleur et sa transparence, pour les remplacements graphiques des phases.
    pub fn observe_material(&mut self, id: u64, graph: &ObjectGraph) {
        let Some(material) = object(graph, "Material") else { return };
        let (Some(color), Some(transparency)) = (material.fields.get("m_color").and_then(Value::as_u64), material.fields.get("m_transparency").and_then(Value::as_f64)) else { return };
        if let Ok(color) = u32::try_from(color) {
            self.materials.insert(id as i64, (color, transparency));
        }
    }

    /// Les phases, dans l'ordre du projet : (identifiant, nom). Sans `AllProjectPhases`, les phases par identifiant
    /// croissant (l'ordre réel est perdu).
    pub fn ordered_phases(&self) -> Vec<(i64, &str)> {
        let order = self.tables.last().map_or(&[][..], |table| table.order.as_slice());
        let named: Vec<(i64, &str)> = order.iter().filter_map(|id| self.phases.get(id).map(|name| (*id, name.as_str()))).collect();
        if !named.is_empty() {
            return named;
        }
        self.phases.iter().map(|(id, name)| (*id, name.as_str())).collect()
    }

    pub fn phase_name(&self, id: i64) -> Option<&str> {
        self.phases.get(&id).map(String::as_str)
    }

    pub fn filters(&self) -> impl Iterator<Item = (&i64, &PhaseFilter)> {
        self.filters.iter()
    }

    pub fn filter(&self, id: i64) -> Option<&PhaseFilter> {
        self.filters.get(&id)
    }

    /// Remplacement graphique de l'état `status` (index de [`STATUS_NAMES`]) : couleur RVB et opacité (1 moins la
    /// transparence du matériau de remplacement).
    pub fn status_override(&self, status: usize) -> Option<([u8; 3], f64)> {
        let material = self.tables.iter().rev().find_map(|table| table.status_materials.get(&status))?;
        let (color, transparency) = self.materials.get(material)?;
        let rgb = [(*color & 0xff) as u8, ((*color >> 8) & 0xff) as u8, ((*color >> 16) & 0xff) as u8];
        Some((rgb, (1.0 - transparency).clamp(0.0, 1.0)))
    }

    /// Les vues 3D qu'on peut ouvrir (ni gabarits, ni sans caméra), par identifiant.
    pub fn views(&self) -> impl Iterator<Item = (&ViewRecord, &Viewer, Option<&Bounded>)> {
        self.views.values().filter(|view| !view.template).filter_map(|view| {
            let viewer = self.viewers.get(&view.viewer)?;
            Some((view, viewer, self.boxes.get(&viewer.clip_box)))
        })
    }

    /// Les plans d'étage qu'on peut ouvrir (ceux dont le `Viewer` est lu), avec leur recadrage et le nom de leur type, par identifiant.
    pub fn plans(&self) -> impl Iterator<Item = (&Plan, &Bounded, Option<&str>)> {
        self.plans.values().filter_map(|plan| {
            let crop = self.plan_viewers.get(&plan.view.viewer)?;
            Some((plan, crop, self.view_types.get(&plan.type_id).map(String::as_str)))
        })
    }

    /// Rien à écrire dans le contrat ?
    pub fn is_empty(&self) -> bool {
        self.phases.is_empty() && self.views.is_empty() && self.plans.is_empty()
    }
}

/// Réduit un graphe `DBView3d` à ce qu'il faut pour ouvrir la vue.
fn view_record(id: i64, graph: &ObjectGraph) -> Option<ViewRecord> {
    let fields = &graph.objects.first()?.fields;
    let mut view = ViewRecord {
        id,
        name: fields.get("m_viewName").and_then(Value::as_str)?.to_string(),
        named: fields.get("m_named").and_then(Value::as_bool).unwrap_or(false),
        template: fields.get("m_isTemplate").and_then(Value::as_bool).unwrap_or(false),
        eye: vector(fields.get("m_origin"))?,
        right: vector(fields.get("m_horzDir"))?,
        up: vector(fields.get("m_vertDir"))?,
        back: vector(fields.get("m_viewDir"))?,
        viewer: fields.get("m_viewerId").and_then(element_id).unwrap_or(-1),
        ..ViewRecord::default()
    };
    // Phase et filtre de phase : deux paramètres d'élément (`VIEW_PHASE`, `VIEW_PHASE_FILTER`) du jeu de la vue.
    if let Some(set) = object(graph, "ParamValueSetElementId") {
        for entry in set.fields.get("m_paramSet").and_then(Value::as_array).into_iter().flatten() {
            let (Some(parameter), Some(target)) = (entry.get("m_paramId").and_then(element_id), entry.get("m_value").and_then(element_id)) else { continue };
            let target = Some(target).filter(|target| *target >= 0);
            match parameter {
                VIEW_PHASE => view.phase = target,
                VIEW_PHASE_FILTER => view.phase_filter = target,
                _ => {}
            }
        }
    }
    if let Some(settings) = object(graph, "HiddenElementsViewSettings") {
        view.hidden_elements = settings.fields.get("m_hiddenElements").and_then(Value::as_array).into_iter().flatten().filter_map(element_id).filter(|id| *id >= 0).collect();
    }
    if let Some(excluded) = object(graph, "IckyExcludedCategoriesSetPtrWrapper") {
        view.hidden_categories = excluded.fields.get("m_categoryIds").and_then(Value::as_array).into_iter().flatten().filter_map(element_id).collect();
        view.imports_excluded = excluded.fields.get("m_importsExcluded").and_then(Value::as_bool).unwrap_or(false);
    }
    Some(view)
}

/// Une liste de cinq entiers (niveaux d'une plage de vue), chacun un identifiant d'élément ou un nombre.
fn five_ids(value: Option<&Value>) -> Option<[i64; 5]> {
    let array = value?.as_array()?;
    let ids: Vec<i64> = array.iter().map(element_id).collect::<Option<_>>()?;
    ids.try_into().ok()
}

fn five_feet(value: Option<&Value>) -> Option<[f64; 5]> {
    let array = value?.as_array()?;
    let feet: Vec<f64> = array.iter().map(|x| x.as_f64().filter(|x| x.is_finite())).collect::<Option<_>>()?;
    feet.try_into().ok()
}

/// Les niveaux et les décalages de la plage de vue d'un plan : `PlanViewRange2` (`m_viewDepthPlaneLevelIds` et `m_viewDepthPlaneOffsets`, ou
/// `m_levelIds` et `m_offsets` dans les fichiers qui les nomment autrement), à défaut `PlanViewRange` (`m_levelPos` et `m_offsets`).
fn plan_levels(graph: &ObjectGraph) -> (Option<[i64; 5]>, Option<[f64; 5]>) {
    if let Some(range) = object(graph, "PlanViewRange2") {
        let fields = &range.fields;
        let levels = five_ids(fields.get("m_viewDepthPlaneLevelIds").or_else(|| fields.get("m_levelIds")));
        let offsets = five_feet(fields.get("m_viewDepthPlaneOffsets").or_else(|| fields.get("m_offsets")));
        if levels.is_some() && offsets.is_some() {
            return (levels, offsets);
        }
    }
    if let Some(range) = object(graph, "PlanViewRange") {
        let (levels, offsets) = (five_ids(range.fields.get("m_levelPos")), five_feet(range.fields.get("m_offsets")));
        if levels.is_some() && offsets.is_some() {
            return (levels, offsets);
        }
    }
    (None, None)
}

/// Réduit un graphe `DBViewPlan` à ce qu'il faut pour ouvrir le plan : `None` pour un gabarit, un plan qui ne regarde pas vers le bas
/// (`m_planViewType` 2 : plan de plafond ; tout ce qui n'est pas 1), ou dont une valeur manque.
fn plan_record(id: i64, graph: &ObjectGraph) -> Option<Plan> {
    let fields = &graph.objects.first()?.fields;
    if fields.get("m_planViewType").and_then(Value::as_i64) != Some(1) || fields.get("m_isTemplate").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let view = view_record(id, graph)?;
    let (levels, offsets) = plan_levels(graph);
    // Une plage illimitée ou absente se garde telle quelle : `ViewRange::cut_feet` dit qu'il n'y a rien à montrer.
    let feet = |name: &str| fields.get(name).and_then(Value::as_f64).unwrap_or(f64::NAN);
    Some(Plan {
        type_id: fields.get("m_dbViewTypeId").and_then(element_id).unwrap_or(-1),
        true_north: fields.get("m_bUseTrueNorth").and_then(Value::as_bool).unwrap_or(false),
        range: ViewRange { cut: feet("m_cutPlaneElev"), bottom_clip: feet("m_bottomClipElev"), levels, offsets },
        view,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::FamilyRule;
    use serde_json::json;

    fn graph(objects: Vec<(&str, Value)>) -> ObjectGraph {
        let objects: Vec<Value> = objects
            .into_iter()
            .enumerate()
            .map(|(i, (class, fields))| json!({"class_tag": 0, "class_name": class, "token": i, "start": 0, "fields_end": 0, "fields": fields}))
            .collect();
        serde_json::from_value(json!({"consumed_bytes": 0, "objects": objects, "edges": []})).expect("graphe")
    }

    fn id(n: i64) -> Value {
        json!({"m_id": {"m_id64": n}})
    }

    #[test]
    fn un_filtre_de_phase_se_decode_comme_revit_le_documente() {
        let mut digest = Digest::default();
        digest.observe(375, -1, "PhaseFilterElem", &graph(vec![("PhaseFilterElem", json!({"m_name": "Show All", "m_bDefault": true, "m_phaseStatusPresentation": [0, 0, 2, 2, 1, 2, 0]}))]));
        let filter = digest.filter(375).expect("filtre");
        assert_eq!(filter.name, "Show All");
        assert!(filter.default);
        // Passé masqué, existant remplacé, démoli remplacé, nouveau tel quel, temporaire remplacé, futur masqué.
        assert_eq!(filter.presentation, [0, 0, 2, 2, 1, 2, 0]);
        // Un tableau qui n'a pas sept entrées n'est pas un filtre.
        digest.observe(1, -1, "PhaseFilterElem", &graph(vec![("PhaseFilterElem", json!({"m_name": "Court", "m_phaseStatusPresentation": [0, 1]}))]));
        assert!(digest.filter(1).is_none());
    }

    #[test]
    fn l_ordre_des_phases_est_celui_de_all_project_phases() {
        let mut digest = Digest::default();
        digest.observe(86961, -1, "ProjectPhase", &graph(vec![("ProjectPhase", json!({"m_name": "Working Drawings"}))]));
        digest.observe(12589, -1, "ProjectPhase", &graph(vec![("ProjectPhase", json!({"m_name": "Existing"}))]));
        // Sans l'enregistrement d'ordre : l'ordre des identifiants, faute de mieux.
        assert_eq!(digest.ordered_phases(), vec![(12589, "Existing"), (86961, "Working Drawings")]);
        digest.observe(1, -1, "AllProjectPhases", &graph(vec![("AllProjectPhases", json!({"m_phaseIds": [id(86961), id(12589)]}))]));
        assert_eq!(digest.ordered_phases(), vec![(86961, "Working Drawings"), (12589, "Existing")]);
    }

    #[test]
    fn une_vue_garde_sa_phase_son_filtre_ses_elements_et_ses_categories_masques() {
        let root = json!({
            "m_viewName": "Cuisine", "m_named": true, "m_isTemplate": false,
            "m_origin": [1.0, 2.0, 3.0], "m_horzDir": [1.0, 0.0, 0.0], "m_vertDir": [0.0, 0.0, 1.0], "m_viewDir": [0.0, 1.0, 0.0],
            "m_viewerId": id(77),
        });
        let view = view_record(
            5,
            &graph(vec![
                ("DBView3d", root),
                ("ParamValueSetElementId", json!({"m_paramSet": [{"m_paramId": id(VIEW_PHASE_FILTER), "m_value": id(375)}, {"m_paramId": id(VIEW_PHASE), "m_value": id(86961)}]})),
                ("HiddenElementsViewSettings", json!({"m_hiddenElements": [id(959070), id(12)]})),
                ("IckyExcludedCategoriesSetPtrWrapper", json!({"m_categoryIds": [id(-2000240), id(-2000011)]})),
            ]),
        )
        .expect("vue");
        assert_eq!((view.name.as_str(), view.named, view.template, view.viewer), ("Cuisine", true, false, 77));
        assert_eq!((view.phase, view.phase_filter), (Some(86961), Some(375)));
        assert_eq!(view.hidden_elements, vec![959070, 12]);
        assert_eq!(view.hidden_categories, vec![-2000240, -2000011]);
        // Une phase « aucune » (-1) n'est pas une phase.
        let view = view_record(6, &graph(vec![("DBView3d", json!({"m_viewName": "Gabarit", "m_origin": [0, 0, 0], "m_horzDir": [1, 0, 0], "m_vertDir": [0, 0, 1], "m_viewDir": [0, 1, 0]})), ("ParamValueSetElementId", json!({"m_paramSet": [{"m_paramId": id(VIEW_PHASE), "m_value": id(-1)}]}))])).expect("vue");
        assert_eq!(view.phase, None);
    }

    #[test]
    fn un_materiau_de_remplacement_donne_sa_couleur_et_son_opacite() {
        let mut digest = Digest::default();
        // « Phase - Demo » de Revit : COLORREF 255 (rouge), transparence 0,4.
        digest.observe_material(105006, &graph(vec![("MaterialElem", json!({})), ("Material", json!({"m_color": 255, "m_transparency": 0.4}))]));
        digest.tables.push(PhaseTable { id: 1, status_materials: BTreeMap::from([(3, 105006)]), ..PhaseTable::default() });
        let (rgb, opacity) = digest.status_override(3).expect("remplacement");
        assert_eq!(rgb, [255, 0, 0]);
        assert!((opacity - 0.6).abs() < 1e-12);
        // COLORREF 8323072 = 0x7F0000 : octets bleu, vert, rouge.
        digest.observe_material(29, &graph(vec![("Material", json!({"m_color": 8_323_072, "m_transparency": 0.0}))]));
        digest.tables.push(PhaseTable { id: 2, status_materials: BTreeMap::from([(5, 29)]), ..PhaseTable::default() });
        assert_eq!(digest.status_override(5).expect("remplacement").0, [0, 0, 127]);
        assert!(digest.status_override(4).is_none());
    }
    /// Un `Digest` de projet de Revit 2014 à la main : ses phases, son filtre et sa vue (propriétaire -1), et ce que lui ajoutent
    /// quatre `Family` : 200 chargée (avec ses vues, phases et filtres), 201 chargée imbriquée dans la précédente, 202 sur place et
    /// 203 dont on ne sait pas si elle est chargée.
    fn digest_of_a_2014_project() -> Digest {
        let bounded = json!({"m_basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "m_orig": [0, 0, 0], "m_boundOffset": [[1, -1], [1, -1], [1, -1]], "m_boundActive": [[false, false], [false, false], [false, false]], "m_isOn": false});
        let mut digest = Digest::default();
        let mut view = |view: u64, owner: i64, name: &str, viewer: u64, clip: u64| {
            let root = json!({"m_viewName": name, "m_named": true, "m_origin": [0, 0, 0], "m_horzDir": [1, 0, 0], "m_vertDir": [0, 0, 1], "m_viewDir": [0, 1, 0], "m_viewerId": id(viewer as i64)});
            digest.observe(view, owner, "DBView3d", &graph(vec![("DBView3d", root)]));
            // La caméra appartient à sa vue, la boîte de coupe à la caméra.
            digest.observe(viewer, view as i64, "Viewer3d", &graph(vec![("Viewer3d", json!({"m_boundedSpace": bounded, "m_projMethodType": 1, "m_modelClipBoxId": id(clip as i64)}))]));
            digest.observe(clip, viewer as i64, "ModelClipBox", &graph(vec![("ModelClipBox", json!({"m_boundedSpace": bounded}))]));
        };
        view(10, -1, "Cuisine", 11, 12);
        view(20, 200, "{3D}", 21, 22);
        view(30, 201, "View 1", 31, 32);
        view(40, 202, "Sur place", 41, 42);
        view(50, 203, "Inconnue", 51, 52);
        let mut phase = |phase: u64, owner: i64, name: &str, table: u64, filter: u64| {
            digest.observe(phase, owner, "ProjectPhase", &graph(vec![("ProjectPhase", json!({"m_name": name}))]));
            digest.observe(table, owner, "AllProjectPhases", &graph(vec![("AllProjectPhases", json!({"m_phaseIds": [id(phase as i64)]}))]));
            digest.observe(filter, owner, "PhaseFilterElem", &graph(vec![("PhaseFilterElem", json!({"m_name": format!("Filtre {name}"), "m_phaseStatusPresentation": [0, 0, 2, 2, 1, 2, 0]}))]));
        };
        phase(100, -1, "Existing", 101, 102);
        // Les enregistrements de la famille chargée viennent après ceux du projet : sans la règle, son `AllProjectPhases` gagne.
        phase(210, 200, "New Construction", 211, 212);
        phase(310, 201, "New Construction", 311, 312);
        phase(410, 202, "Phase sur place", 411, 412);
        phase(510, 203, "Phase illisible", 511, 512);
        digest
    }

    /// Le prédicat commun, tel que la lecture l'applique : 200 est une `Family` chargée, 201 une autre, 202 sur place, 203 illisible. Les
    /// propriétaires d'ElemTable des enregistrements du résumé : la vue 10 (du projet) n'en a pas, 20, 30, 40 et 50 sont possédées par
    /// 200, 201, 202 et 203, la caméra d'une vue (n + 1) l'est par la vue, la boîte de coupe (n + 2) par la caméra.
    fn rule_of_a_project(owner: i64) -> FamilyOwner {
        let family = |id: u64| match id {
            200 | 201 => Some(Some(false)),
            202 => Some(Some(true)),
            203 => Some(None),
            _ => None,
        };
        let owner_of = |id: u64| match id {
            10 => Some(-1),
            20 => Some(200),
            30 => Some(201),
            40 => Some(202),
            50 => Some(203),
            11 | 12 | 21 | 22 | 31 | 32 | 41 | 42 | 51 | 52 => Some(id as i64 - 1),
            _ => None,
        };
        FamilyRule::On { document: Some(-1) }.owner(owner, family, owner_of)
    }

    #[test]
    fn les_vues_les_phases_et_les_filtres_d_une_famille_chargee_sont_ecartes() {
        let mut digest = digest_of_a_2014_project();
        // Avant la règle, tout se mêle : la famille chargée donne ses vues, et l'ordre vient de son `AllProjectPhases`.
        assert_eq!((digest.views.len(), digest.filters.len(), digest.phases.len()), (5, 5, 5));
        assert_eq!(digest.ordered_phases(), vec![(510, "Phase illisible")]);

        digest.settle(rule_of_a_project);
        // Restent le projet, la famille sur place (ses éléments sont dans le modèle) et celle qu'on ne sait pas lire.
        assert_eq!(digest.views.keys().copied().collect::<Vec<_>>(), vec![10, 40, 50]);
        assert_eq!(digest.filters.keys().copied().collect::<Vec<_>>(), vec![102, 412, 512]);
        assert_eq!(digest.phases.keys().copied().collect::<Vec<_>>(), vec![100, 410, 510]);
        assert_eq!(digest.tables.iter().map(|table| table.id).collect::<Vec<_>>(), vec![101, 411, 511]);
        // Ce que possèdent les vues écartées part avec elles : la caméra (profondeur 2) et la boîte de coupe (profondeur 3), y compris
        // celles d'une vue que possède une famille imbriquée.
        assert_eq!(digest.viewers.keys().copied().collect::<Vec<_>>(), vec![11, 41, 51]);
        assert_eq!(digest.boxes.keys().copied().collect::<Vec<_>>(), vec![12, 42, 52]);
        // La phase et le filtre de la vue du projet se lisent encore ; les vues sortent par nom.
        assert_eq!(digest.views().map(|(view, _, _)| view.name.as_str()).collect::<Vec<_>>(), vec!["Cuisine", "Sur place", "Inconnue"]);
        // Deux enregistrements de la famille illisible ne sont pas écartés (une vue, une phase, un filtre, une table) : comptés.
        assert_eq!(digest.unread(), 4);
    }

    #[test]
    fn la_regle_eteinte_ne_change_rien() {
        // Revit 2015 et après : aucun propriétaire n'est une famille chargée, le résumé est celui de la lecture.
        let mut digest = digest_of_a_2014_project();
        let before = format!("{digest:?}");
        digest.settle(|_| FamilyOwner::Elsewhere);
        assert_eq!(format!("{digest:?}"), before);
        assert_eq!(digest.unread(), 0);
        // Et le dernier `AllProjectPhases` lu donne toujours l'ordre.
        assert_eq!(digest.ordered_phases(), vec![(510, "Phase illisible")]);
    }

    #[test]
    fn l_ordre_des_phases_est_celui_du_projet_apres_l_ecart_des_familles() {
        // Le hangar : le dernier `AllProjectPhases` lu est celui d'une famille chargée, qui ne liste aucune phase ; l'ordre retombait
        // sur toutes les phases par identifiant, celles des familles comprises.
        let mut digest = Digest::default();
        digest.observe(32440, -1, "ProjectPhase", &graph(vec![("ProjectPhase", json!({"m_name": "Existing"}))]));
        digest.observe(118390, -1, "ProjectPhase", &graph(vec![("ProjectPhase", json!({"m_name": "New Construction"}))]));
        digest.observe(21886, -1, "AllProjectPhases", &graph(vec![("AllProjectPhases", json!({"m_phaseIds": [id(32440), id(118390)]}))]));
        digest.observe(148893, 148892, "ProjectPhase", &graph(vec![("ProjectPhase", json!({"m_name": "New Construction"}))]));
        digest.observe(172834, 172825, "AllProjectPhases", &graph(vec![("AllProjectPhases", json!({"m_phaseIds": []}))]));
        assert_eq!(digest.ordered_phases().len(), 3);
        digest.settle(|owner| if owner == 148892 || owner == 172825 { FamilyOwner::Definition } else { FamilyOwner::Elsewhere });
        assert_eq!(digest.ordered_phases(), vec![(32440, "Existing"), (118390, "New Construction")]);
    }

    // ---------------------------------------------------------------------------------------------------- plans d'étage

    /// Le graphe d'un `DBViewPlan` (le plan « GF » de `wadduwa.rvt`, au niveau 311 : coupe 4,921, bas 0,984, haut 8,530 pieds) : `fields` complète
    /// ou remplace ses champs, `objects` ajoute les objets du graphe (plage de vue, catégories exclues…).
    fn plan_graph(fields: Value, objects: Vec<(&str, Value)>) -> ObjectGraph {
        let mut root = json!({
            "m_viewName": "GF", "m_named": true, "m_isTemplate": false, "m_planViewType": 1, "m_bUseTrueNorth": false,
            "m_origin": [0.0, 0.0, 0.0], "m_horzDir": [1.0, 0.0, 0.0], "m_vertDir": [0.0, 1.0, 0.0], "m_viewDir": [0.0, 0.0, 1.0],
            "m_viewerId": id(313), "m_dbViewTypeId": id(49552),
            "m_cutPlaneElev": 4.921_259_842_519_684, "m_bottomClipElev": 0.984_251_968_503_937, "m_topClipElev": 8.530_183_727_034_12,
        });
        for (name, value) in fields.as_object().expect("champs") {
            root[name] = value.clone();
        }
        let mut all = vec![("DBViewPlan", root)];
        all.extend(objects);
        graph(all)
    }

    /// Un `PlanViewRange2` récent : coupe, haut, bas, profondeur de vue, inutilisé.
    fn range2(levels: [i64; 5], offsets: [f64; 5]) -> (&'static str, Value) {
        ("PlanViewRange2", json!({"m_viewDepthPlaneLevelIds": levels.map(id), "m_viewDepthPlaneOffsets": offsets}))
    }

    fn range_of(fields: Value, objects: Vec<(&str, Value)>) -> ViewRange {
        plan_record(312, &plan_graph(fields, objects)).expect("plan").range
    }

    fn close(found: Option<f64>, expected: Option<f64>) {
        match (found, expected) {
            (Some(found), Some(expected)) => assert!((found - expected).abs() < 1e-9, "{found} au lieu de {expected}"),
            _ => assert_eq!(found, expected),
        }
    }

    #[test]
    fn un_plan_garde_son_nom_son_type_son_viewer_sa_phase_et_ce_qu_il_masque() {
        let plan = plan_record(
            312,
            &plan_graph(
                json!({}),
                vec![
                    ("ParamValueSetElementId", json!({"m_paramSet": [{"m_paramId": id(VIEW_PHASE_FILTER), "m_value": id(375)}, {"m_paramId": id(VIEW_PHASE), "m_value": id(86961)}]})),
                    ("HiddenElementsViewSettings", json!({"m_hiddenElements": [id(508706)]})),
                    ("IckyExcludedCategoriesSetPtrWrapper", json!({"m_categoryIds": [id(-2000240), id(508641)], "m_importsExcluded": true, "m_modelsExcluded": false})),
                    range2([311, 311, 311, 311, -1], [3.937_007_874_015_748, 7.545_931_758_530_184, 0.0, 0.0, 0.0]),
                ],
            ),
        )
        .expect("plan");
        assert_eq!((plan.view.name.as_str(), plan.view.viewer, plan.type_id, plan.true_north), ("GF", 313, 49552, false));
        assert_eq!((plan.view.phase, plan.view.phase_filter), (Some(86961), Some(375)));
        assert_eq!(plan.view.hidden_elements, vec![508706]);
        // Les catégories masquées : une de Revit (négative) et un `CategoryElem` (positif, le calque d'un import ou son import).
        assert_eq!(plan.view.hidden_categories, vec![-2000240, 508641]);
        assert!(plan.view.imports_excluded);
        // Les trois hauteurs et les niveaux de la plage.
        assert_eq!(plan.range.levels, Some([311, 311, 311, 311, -1]));
        close(plan.range.cut_feet(), Some(4.921_259_842_519_684));
    }

    #[test]
    fn la_profondeur_de_vue_d_un_plan_du_meme_niveau_que_son_bas_suit_ses_decalages() {
        // « GF » de wadduwa : coupe +3,937 (4,921), haut +7,546, bas et profondeur +0 du niveau 311 (0,984 pied) : la profondeur est à 0,984.
        let levels = [311, 311, 311, 311, -1];
        let flat = range_of(json!({}), vec![range2(levels, [3.937_007_874_015_748, 7.545_931_758_530_184, 0.0, 0.0, 0.0])]);
        close(flat.cut_feet(), Some(4.921_259_842_519_684));
        close(flat.depth_feet(), Some(0.984_251_968_503_937));
        // Le plan de structure « 1F » du même fichier : coupe +0,984, haut +1,969, bas −3,937, profondeur −5,906 du niveau 355784 (12,795 pieds).
        // Bas = 8,858 ; la profondeur est 5,906 sous le niveau : 6,889 (= 8,858 + 3,937 − 5,906), pas le bas.
        let structural = range_of(
            json!({"m_cutPlaneElev": 13.779_527_559_055_12, "m_bottomClipElev": 8.858_267_716_535_43, "m_topClipElev": 14.763_779_527_559_06}),
            vec![range2([355784, 355784, 355784, 355784, -3], [0.984_251_968_503_937, 1.968_503_937_007_874, -3.937_007_874_015_748, -5.905_511_811_023_622, 0.0])],
        );
        close(structural.depth_feet(), Some(8.858_267_716_535_43 + 3.937_007_874_015_748 - 5.905_511_811_023_622));
        close(structural.depth_feet(), Some(12.795_275_590_551_18 - 5.905_511_811_023_622));
        // Deux fois « le niveau en dessous » (-4) : le même niveau, la formule vaut aussi (ici avec un niveau en dessous).
        let below = range_of(json!({"m_bottomClipElev": 0.0}), vec![range2([311, 311, -4, -4, 311], [3.937, 7.546, 0.0, -2.0, 0.0])]);
        close(below.depth_feet(), Some(-2.0));
    }

    #[test]
    fn la_profondeur_de_vue_illimitee_ou_sur_un_autre_niveau_ou_sans_bas_se_lit_comme_la_regle() {
        // Niveau de profondeur illimité (-1) : aucune borne basse, même si le bas de la plage en a une.
        let unlimited = range_of(json!({}), vec![range2([311, 311, 311, -1, -1], [3.937, 7.546, 0.0, 0.0, 0.0])]);
        assert_eq!(unlimited.depth_feet(), None);
        // Bas illimité (« niveau en dessous » sans niveau en dessous : Revit écrit −999 999 999,99) : aucune borne basse, même au même niveau.
        let no_bottom = range_of(json!({"m_bottomClipElev": -999_999_999.999_999_9}), vec![range2([311, 311, -4, -4, 311], [3.937, 7.546, 0.0, 0.0, 0.0])]);
        assert_eq!(no_bottom.depth_feet(), None);
        // Profondeur sur un autre niveau que le bas : le bas de la plage, par prudence (le fichier ne donne pas l'altitude de l'autre niveau).
        let other = range_of(json!({"m_bottomClipElev": 0.0}), vec![range2([712326, 712326, 30, -1, 712326], [4.0, 7.5, 0.0, 0.0, 0.0])]);
        assert_eq!(other.depth_feet(), None, "ce plan-là a une profondeur illimitée");
        let other = range_of(json!({"m_bottomClipElev": 12.5}), vec![range2([311, 311, 311, 312, -1], [3.937, 7.546, 0.0, -3.0, 0.0])]);
        close(other.depth_feet(), Some(12.5));
        // Les deux illimités (-1 et -1) ne sont pas « le même niveau » : pas de formule sur ±999 999 999.
        let both = range_of(json!({}), vec![range2([311, 311, -1, -1, -1], [3.937, 7.546, 0.0, 0.0, 0.0])]);
        assert_eq!(both.depth_feet(), None);
        // Sans plage de vue lisible : le bas de la plage, s'il est fini.
        close(range_of(json!({}), vec![]).depth_feet(), Some(0.984_251_968_503_937));
        assert_eq!(range_of(json!({"m_bottomClipElev": -999_999_999.999_999_9}), vec![]).depth_feet(), None);
    }

    #[test]
    fn la_coupe_illimitee_ou_absente_n_a_pas_de_hauteur() {
        assert_eq!(range_of(json!({"m_cutPlaneElev": 999_999_999.999_999_9}), vec![]).cut_feet(), None);
        assert_eq!(range_of(json!({"m_cutPlaneElev": -999_999_999.999_999_9}), vec![]).cut_feet(), None);
        // Un enregistrement sans `m_cutPlaneElev` (la valeur est absente, non zéro).
        let mut root = json!({"m_viewName": "x", "m_planViewType": 1, "m_origin": [0, 0, 0], "m_horzDir": [1, 0, 0], "m_vertDir": [0, 1, 0], "m_viewDir": [0, 0, 1]});
        root["m_isTemplate"] = json!(false);
        assert_eq!(plan_record(1, &graph(vec![("DBViewPlan", root)])).expect("plan").range.cut_feet(), None);
    }

    #[test]
    fn les_fichiers_plus_anciens_nomment_autrement_la_plage_de_vue() {
        // `PlanViewRange2` de Revit 2014 à 2023 : `m_levelIds` et `m_offsets`, dans le même ordre.
        let levels = [311, 311, -4, -4, 311].map(id);
        let old = ("PlanViewRange2", json!({"m_levelIds": levels, "m_offsets": [3.937, 7.546, 0.0, -2.0, 0.0]}));
        let range = range_of(json!({"m_bottomClipElev": 0.0}), vec![old]);
        assert_eq!(range.levels, Some([311, 311, -4, -4, 311]));
        close(range.depth_feet(), Some(-2.0));
        // Les fichiers qui n'ont que `PlanViewRange` : positions de niveau (0 : le niveau du plan, -1 illimité), mêmes décalages.
        let oldest = ("PlanViewRange", json!({"m_levelPos": [0, 0, 0, 0, 0], "m_offsets": [3.937, 7.546, 0.0, 0.0, 0.0]}));
        close(range_of(json!({}), vec![oldest]).depth_feet(), Some(0.984_251_968_503_937));
        let unlimited = ("PlanViewRange", json!({"m_levelPos": [0, 0, 0, -1, 0], "m_offsets": [3.937, 7.546, 0.0, 0.0, 0.0]}));
        assert_eq!(range_of(json!({}), vec![unlimited]).depth_feet(), None);
        // `PlanViewRange2` prime sur `PlanViewRange` quand les deux sont là (les niveaux relatifs y sont plus précis).
        let both = vec![
            ("PlanViewRange", json!({"m_levelPos": [0, 0, 0, 0, 0], "m_offsets": [3.937, 7.546, 0.0, 0.0, 0.0]})),
            range2([311, 311, 311, -1, -1], [3.937, 7.546, 0.0, 0.0, 0.0]),
        ];
        assert_eq!(range_of(json!({}), both).depth_feet(), None);
        // Une liste qui n'a pas cinq entrées n'est pas une plage : le bas de la plage (prudent), sans invention.
        let levels = [311, 311].map(id);
        let short = ("PlanViewRange2", json!({"m_viewDepthPlaneLevelIds": levels, "m_viewDepthPlaneOffsets": [0.0, 0.0]}));
        let range = range_of(json!({}), vec![short]);
        assert_eq!(range.levels, None);
        close(range.depth_feet(), Some(0.984_251_968_503_937));
    }

    #[test]
    fn les_gabarits_et_les_plans_de_plafond_ne_sont_pas_des_plans() {
        assert!(plan_record(1, &plan_graph(json!({}), vec![])).is_some());
        // Un gabarit de vue : jamais ouvert.
        assert!(plan_record(2, &plan_graph(json!({"m_isTemplate": true}), vec![])).is_none());
        // `m_planViewType` 2 : un plan de plafond, qui regarde vers le haut ; 0 et 3 ne sont pas des plans vus de dessus non plus.
        for kind in [0, 2, 3] {
            assert!(plan_record(3, &plan_graph(json!({"m_planViewType": kind}), vec![])).is_none(), "m_planViewType {kind}");
        }
        // Une vue 3D n'est pas un plan.
        let mut digest = Digest::default();
        digest.observe(4, -1, "DBViewPlan", &plan_graph(json!({"m_isTemplate": true}), vec![]));
        digest.observe(5, -1, "DBViewPlan", &plan_graph(json!({"m_planViewType": 2}), vec![]));
        assert_eq!(digest.plans.len(), 0);
    }

    /// Les trois enregistrements d'un plan, comme la lecture les observe : le plan, son `Viewer` (possédé par le plan) et son `DBViewType`.
    fn observe_plan(digest: &mut Digest, plan: i64, owner: i64, fields: Value, objects: Vec<(&str, Value)>, crop: Value, type_name: &str) {
        let viewer = plan + 1;
        let type_id = plan + 2;
        let mut fields = fields;
        fields["m_viewerId"] = id(viewer);
        fields["m_dbViewTypeId"] = id(type_id);
        digest.observe(plan as u64, owner, "DBViewPlan", &plan_graph(fields, objects));
        digest.observe(viewer as u64, plan, "Viewer", &graph(vec![("Viewer", json!({"m_boundedSpace": crop}))]));
        digest.observe(type_id as u64, owner, "DBViewType", &graph(vec![("DBViewType", json!({})), ("SymbolInfo", json!({"m_name": type_name}))]));
    }

    /// Un recadrage de plan : le repère du plan (droite, haut, l'opposé du regard), inactif ou actif sur les deux axes.
    fn plan_crop(active: bool, basis: Value, origin: [f64; 3], offsets: [[f64; 2]; 2]) -> Value {
        let flags = [[active, active], [active, active], [false, false]];
        json!({"m_basis": basis, "m_boundActive": flags, "m_boundOffset": [offsets[0], offsets[1], [100.0, -100.0]], "m_isOn": true, "m_orig": origin})
    }

    const PLAN_BASIS: [[i32; 3]; 3] = [[1, 0, 0], [0, 1, 0], [0, 0, -1]];

    fn no_crop() -> Value {
        plan_crop(false, json!(PLAN_BASIS), [0.0; 3], [[100.0, -100.0], [100.0, -100.0]])
    }

    fn views_of(digest: &Digest) -> Vec<Value> {
        let elements = Elements { keys: &HashMap::new(), categories: &BTreeSet::new(), category_property: "Catégorie", imports: &HashMap::new(), import_keys: &[] };
        let json = views_json(digest, &elements).expect("vues");
        serde_json::from_str::<Vec<Value>>(&json).expect("JSON")
    }

    fn number_of(value: &Value) -> f64 {
        value.as_f64().expect("nombre")
    }

    #[test]
    fn un_plan_s_ecrit_avec_son_type_sa_plage_en_metres_et_sa_camera_vers_le_bas() {
        let mut digest = Digest::default();
        let range = range2([311, 311, 311, 311, -1], [3.937_007_874_015_748, 7.545_931_758_530_184, 0.0, 0.0, 0.0]);
        observe_plan(&mut digest, 312, -1, json!({}), vec![range], no_crop(), "Floor Plan");
        let views = views_of(&digest);
        assert_eq!(views.len(), 1);
        let view = &views[0];
        assert_eq!((view["name"].as_str(), view["kind"].as_str(), view["type"].as_str()), (Some("GF"), Some("plan"), Some("Floor Plan")));
        // La coupe à 4,921 pieds (1,5 m) et la profondeur à 0,984 pied (0,3 m).
        assert!((number_of(&view["range"]["top"]) - 1.5).abs() < 1e-9 && (number_of(&view["range"]["bottom"]) - 0.3).abs() < 1e-9, "{}", view["range"]);
        // Une caméra parallèle qui regarde droit vers le bas ; le nord du projet (+Y de Revit) est -Z du viewer.
        let camera = &view["camera"];
        assert_eq!(camera["projection"], "orthographic");
        assert_eq!(camera["direction"], json!([0, -1, 0]));
        assert_eq!(camera["up"], json!([0, 0, -1]));
        // Sans recadrage : ni taille, ni boîte de coupe ; la position est l'origine de la vue à la hauteur de coupe.
        assert!(camera.get("size").is_none() && view.get("sectionBox").is_none());
        assert!((number_of(&camera["position"][1]) - 1.5).abs() < 1e-9);
    }

    #[test]
    fn le_type_d_un_plan_de_surface_vient_de_sa_classe_a_part() {
        // `rac_advanced_sample_project` : trois plans de surface (`m_planViewType` 1) ont pour type un `DBViewTypeAreaPlan` « Gross Building ».
        let mut digest = Digest::default();
        digest.observe(177344, -1, "DBViewTypeAreaPlan", &graph(vec![("DBViewTypeAreaPlan", json!({})), ("SymbolInfo", json!({"m_name": "Gross Building"}))]));
        digest.observe(313, 312, "Viewer", &graph(vec![("Viewer", json!({"m_boundedSpace": no_crop()}))]));
        digest.observe(312, -1, "DBViewPlan", &plan_graph(json!({"m_dbViewTypeId": id(177344)}), vec![]));
        assert_eq!(views_of(&digest)[0]["type"], "Gross Building");
    }

    #[test]
    fn un_plan_dont_la_profondeur_est_illimitee_n_a_pas_de_bas() {
        let mut digest = Digest::default();
        observe_plan(&mut digest, 312, -1, json!({}), vec![range2([311, 311, 311, -1, -1], [3.937, 7.546, 0.0, 0.0, 0.0])], no_crop(), "Floor Plan");
        let view = &views_of(&digest)[0];
        assert!(view["range"].get("bottom").is_none());
        assert!((number_of(&view["range"]["top"]) - 1.5).abs() < 1e-3);
    }

    #[test]
    fn un_plan_recadre_donne_sa_taille_son_centre_et_sa_boite_de_coupe() {
        // Le plan « Level 2 » de `DynamoSample` : recadrage de −23,25 à +45,95 pieds en x et −50,97 à +14,80 en y, depuis l'origine (0 ; 0 ; 10,17).
        let mut digest = Digest::default();
        let crop = plan_crop(true, json!(PLAN_BASIS), [0.0, 0.0, 10.170_603_674_541_038], [[45.945_051_495_065_06, -23.252_941_997_170_55], [14.795_846_146_664_697, -50.971_842_111_451_55]]);
        let fields = json!({"m_cutPlaneElev": 13.779_527_559_055_12, "m_bottomClipElev": 9.842_519_685_039_37});
        observe_plan(&mut digest, 245424, -1, fields, vec![range2([245423, 245423, 245423, 245423, 245423], [3.937_007_874_015_75, 7.545_931_758_530_18, 0.0, 0.0, 0.0])], crop, "Floor Plan");
        let view = &views_of(&digest)[0];
        // Largeur : 69,198 pieds, hauteur : 65,768 pieds ; position : le centre (11,346 ; −18,088) à la hauteur de coupe (13,78 pieds).
        let size = &view["camera"]["size"];
        assert!((number_of(&size[0]) - 69.197_993_492_235_61 * 0.3048).abs() < 1e-6 && (number_of(&size[1]) - 65.767_688_258_116_24 * 0.3048).abs() < 1e-6, "{size}");
        let position = &view["camera"]["position"];
        let (cx, cy) = ((45.945_051_495_065_06 - 23.252_941_997_170_55) / 2.0, (14.795_846_146_664_697 - 50.971_842_111_451_55) / 2.0);
        assert!((number_of(&position[0]) - cx * 0.3048).abs() < 1e-6 && (number_of(&position[2]) + cy * 0.3048).abs() < 1e-6 && (number_of(&position[1]) - 13.779_527_559_055_12 * 0.3048).abs() < 1e-6, "{position}");
        // La boîte : x et z du recadrage (le viewer lit y de la plage), sans rotation.
        let boxed = &view["sectionBox"];
        let (min, max) = (&boxed["min"], &boxed["max"]);
        assert!((number_of(&min[0]) - (cx - 34.598_996_746_117_8) * 0.3048).abs() < 1e-6 && (number_of(&max[0]) - (cx + 34.598_996_746_117_8) * 0.3048).abs() < 1e-6, "{boxed}");
        assert!((number_of(&min[2]) - (-cy - 32.883_844_129_058_1) * 0.3048).abs() < 1e-6 && (number_of(&max[2]) - (-cy + 32.883_844_129_058_1) * 0.3048).abs() < 1e-6, "{boxed}");
        // y : de la profondeur de vue (9,84 pieds : le bas de la plage, même niveau) à la coupe.
        assert!((number_of(&min[1]) - 9.842_519_685_039_37 * 0.3048).abs() < 1e-6 && (number_of(&max[1]) - 13.779_527_559_055_12 * 0.3048).abs() < 1e-6, "{boxed}");
        assert!(boxed.get("rotation").is_none());
    }

    #[test]
    fn un_plan_recadre_sans_profondeur_a_une_boite_sans_infini() {
        let mut digest = Digest::default();
        let crop = plan_crop(true, json!(PLAN_BASIS), [0.0; 3], [[10.0, -10.0], [5.0, -5.0]]);
        // Le bas de la plage est « le niveau en dessous » (-4) sans niveau en dessous : −999 999 999,99 dans le fichier.
        let fields = json!({"m_bottomClipElev": -999_999_999.999_999_9});
        observe_plan(&mut digest, 100, -1, fields, vec![range2([311, 311, -4, -4, 311], [3.937, 7.546, 0.0, 0.0, 0.0])], crop, "Floor Plan");
        let digest_range = &views_of(&digest)[0];
        // Le JSON n'a pas d'infini : un bas de -10 000 m ; la plage, elle, n'a pas de `bottom`.
        assert_eq!(digest_range["sectionBox"]["min"][1], -10000.0);
        assert!(digest_range["range"].get("bottom").is_none());
    }

    #[test]
    fn un_plan_a_l_orientation_de_m_vert_dir_qui_porte_deja_le_nord_vrai() {
        // Le plan « Site » de `DynamoSample` : `m_bUseTrueNorth` vrai, et son repère est celui du nord vrai du projet, 37° à l'est du nord du
        // projet (le nord de l'emplacement actif du fichier, (0,6018 ; 0,7986) : `properties::geo`). Le haut du plan est ce repère, non le nord du projet.
        let (cos, sin) = (37f64.to_radians().cos(), 37f64.to_radians().sin());
        let mut digest = Digest::default();
        let basis = json!([[cos, -sin, 0.0], [sin, cos, 0.0], [0.0, 0.0, -1.0]]);
        let crop = plan_crop(true, basis, [0.0; 3], [[190.0, -120.0], [100.0, -190.0]]);
        observe_plan(&mut digest, 8251, -1, json!({"m_bUseTrueNorth": true, "m_horzDir": [cos, -sin, 0.0], "m_vertDir": [sin, cos, 0.0]}), vec![range2([1, 1, 2, 2, -1], [328.084, 328.084, 0.0, 0.0, 0.0])], crop, "Floor Plan");
        let view = &views_of(&digest)[0];
        let up = &view["camera"]["up"];
        // Revit (sin ; cos) → viewer (x, 0, −y).
        assert!((number_of(&up[0]) - sin).abs() < 1e-8 && number_of(&up[1]) == 0.0 && (number_of(&up[2]) + cos).abs() < 1e-8, "{up}");
        // Le recadrage garde la même rotation : −37° (l'axe de dessin tourné de 37° dans le sens horaire vu d'en haut).
        assert!((number_of(&view["sectionBox"]["rotation"]) + 37.0).abs() < 1e-5, "{}", view["sectionBox"]);
    }

    #[test]
    fn un_recadrage_actif_qui_n_est_pas_un_rectangle_de_plan_fait_ecarter_le_plan() {
        // Le repère du recadrage n'est pas horizontal : on n'invente pas un rectangle.
        let mut digest = Digest::default();
        let tilted = json!([[1.0, 0.0, 0.0], [0.0, 0.7, 0.7], [0.0, -0.7, 0.7]]);
        observe_plan(&mut digest, 100, -1, json!({}), vec![], plan_crop(true, tilted, [0.0; 3], [[10.0, -10.0], [5.0, -5.0]]), "Floor Plan");
        observe_plan(&mut digest, 200, -1, json!({"m_viewName": "Bon"}), vec![], no_crop(), "Floor Plan");
        // Un recadrage inactif sur un repère quelconque est sans effet : le plan s'écrit.
        let names: Vec<String> = views_of(&digest).iter().map(|view| view["name"].as_str().expect("nom").to_string()).collect();
        assert_eq!(names, ["Bon"]);
    }

    #[test]
    fn un_plan_sans_coupe_finie_ou_sans_viewer_ou_dont_le_bas_depasse_la_coupe_n_est_pas_ecrit() {
        let mut digest = Digest::default();
        observe_plan(&mut digest, 100, -1, json!({"m_viewName": "Coupe illimitée", "m_cutPlaneElev": 999_999_999.999_999_9}), vec![], no_crop(), "Floor Plan");
        observe_plan(&mut digest, 200, -1, json!({"m_viewName": "Bas au-dessus", "m_cutPlaneElev": 3.0, "m_bottomClipElev": 5.0}), vec![], no_crop(), "Floor Plan");
        observe_plan(&mut digest, 300, -1, json!({"m_viewName": "Regarde vers le haut", "m_viewDir": [0.0, 0.0, -1.0]}), vec![], no_crop(), "Floor Plan");
        // Sans `Viewer` : le recadrage est inconnu.
        digest.observe(400, -1, "DBViewPlan", &plan_graph(json!({"m_viewName": "Sans viewer", "m_viewerId": id(9999)}), vec![]));
        observe_plan(&mut digest, 500, -1, json!({"m_viewName": "Bon"}), vec![], no_crop(), "Floor Plan");
        assert_eq!(digest.plans.len(), 5);
        let names: Vec<String> = views_of(&digest).iter().map(|view| view["name"].as_str().expect("nom").to_string()).collect();
        assert_eq!(names, ["Bon"]);
    }

    #[test]
    fn les_vues_3d_viennent_d_abord_puis_les_plans_par_hauteur_de_coupe_nom_et_identifiant() {
        let mut digest = Digest::default();
        let mut view = |view: u64, name: &str| {
            let root = json!({"m_viewName": name, "m_named": true, "m_origin": [0, 0, 0], "m_horzDir": [1, 0, 0], "m_vertDir": [0, 0, 1], "m_viewDir": [0, 1, 0], "m_viewerId": id(view as i64 + 1)});
            digest.observe(view, -1, "DBView3d", &graph(vec![("DBView3d", root)]));
            let space = json!({"m_basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "m_orig": [0, 0, 0], "m_boundOffset": [[100, -100], [100, -100], [100, -100]], "m_boundActive": [[false, false], [false, false], [false, false]], "m_isOn": false});
            digest.observe(view + 1, view as i64, "Viewer3d", &graph(vec![("Viewer3d", json!({"m_boundedSpace": space, "m_projMethodType": 1}))]));
        };
        view(10, "Vue B");
        view(20, "{3D}");
        // Les plans : le même nom « 1F » à deux hauteurs, « A » et « a » à la même (insensible à la casse, puis par identifiant), et un plan haut.
        // La coupe est à la même hauteur au millimètre près (3,937 pieds et 3,93701 pieds : 1,2000 m).
        observe_plan(&mut digest, 600, -1, json!({"m_viewName": "Toit", "m_cutPlaneElev": 40.0}), vec![], no_crop(), "Floor Plan");
        observe_plan(&mut digest, 700, -1, json!({"m_viewName": "b", "m_cutPlaneElev": 3.937}), vec![], no_crop(), "Floor Plan");
        observe_plan(&mut digest, 800, -1, json!({"m_viewName": "A", "m_cutPlaneElev": 3.937_01}), vec![], no_crop(), "Structural Plan");
        observe_plan(&mut digest, 900, -1, json!({"m_viewName": "a", "m_cutPlaneElev": 3.937}), vec![], no_crop(), "Floor Plan");
        observe_plan(&mut digest, 1000, -1, json!({"m_viewName": "1F", "m_cutPlaneElev": 13.0, "m_bottomClipElev": 9.0}), vec![], no_crop(), "Floor Plan");
        let views = views_of(&digest);
        let order: Vec<(&str, bool)> = views.iter().map(|view| (view["name"].as_str().expect("nom"), view["kind"] == "plan")).collect();
        assert_eq!(order, [("{3D}", false), ("Vue B", false), ("A", true), ("a", true), ("b", true), ("1F", true), ("Toit", true)]);
        // Les vues 3D n'ont ni `kind` ni `range`.
        assert!(views[0].get("kind").is_none() && views[0].get("range").is_none());
        // Le même nom, deux plans de types différents : le type les distingue.
        assert_eq!((views[2]["type"].as_str(), views[3]["type"].as_str()), (Some("Structural Plan"), Some("Floor Plan")));
    }

    /// Un `Elements` de Revit : trois éléments dessinés (deux murs et l'import « MAN-GF.dwg »), les catégories qu'ils portent.
    fn elements_with<'a>(keys: &'a HashMap<i64, &'a str>, categories: &'a BTreeSet<String>, imports: &'a HashMap<i64, String>, import_keys: &'a [&'a str]) -> Elements<'a> {
        Elements { keys, categories, category_property: "Catégorie", imports, import_keys }
    }

    #[test]
    fn les_categories_masquees_d_un_plan_nomment_celle_des_imports_dessines_et_ignorent_les_sous_categories() {
        let mut digest = Digest::default();
        // -2000011 : « Murs » ; 500 : la catégorie de l'import « MAN-2F.dwg » ; 508641 et 2466 : des sous-catégories (« A-Area », « Plan Swing ») ;
        // -2000999 : une catégorie de Revit qu'aucun élément ne porte.
        let icky = ("IckyExcludedCategoriesSetPtrWrapper", json!({"m_categoryIds": [id(-2000011), id(500), id(508641), id(2466), id(-2000999)]}));
        observe_plan(&mut digest, 100, -1, json!({}), vec![icky], no_crop(), "Floor Plan");
        let keys: HashMap<i64, &str> = HashMap::from([(10, "mur-1"), (20, "dwg-gf")]);
        let categories = BTreeSet::from(["Murs".to_string(), "MAN-2F.dwg".to_string(), "MAN-GF.dwg".to_string()]);
        let imports = HashMap::from([(500, "MAN-2F.dwg".to_string()), (501, "MAN-GF.dwg".to_string())]);
        let elements = elements_with(&keys, &categories, &imports, &["dwg-gf"]);
        let views: Vec<Value> = serde_json::from_str(&views_json(&digest, &elements).expect("vues")).expect("JSON");
        let hidden = &views[0]["hiddenCategories"];
        assert_eq!(hidden["property"], "Catégorie");
        // Murs (catalogue) et MAN-2F.dwg (import dessiné) ; ni les sous-catégories, ni MAN-GF.dwg (qu'aucune vue de ce plan ne masque).
        assert_eq!(hidden["values"], json!(["MAN-2F.dwg", "Murs"]));
        assert!(views[0].get("hiddenElements").is_none());
    }

    #[test]
    fn une_vue_qui_masque_les_imports_masque_les_cles_de_tous_les_imports_dessines() {
        let mut digest = Digest::default();
        let icky = ("IckyExcludedCategoriesSetPtrWrapper", json!({"m_categoryIds": [], "m_importsExcluded": true}));
        let hidden_elements = ("HiddenElementsViewSettings", json!({"m_hiddenElements": [id(10), id(20), id(30)]}));
        observe_plan(&mut digest, 100, -1, json!({}), vec![icky, hidden_elements], no_crop(), "Floor Plan");
        let keys: HashMap<i64, &str> = HashMap::from([(10, "mur-1"), (20, "dwg-gf"), (21, "dwg-1f")]);
        let (categories, imports) = (BTreeSet::new(), HashMap::new());
        let elements = elements_with(&keys, &categories, &imports, &["dwg-gf", "dwg-1f"]);
        let views: Vec<Value> = serde_json::from_str(&views_json(&digest, &elements).expect("vues")).expect("JSON");
        // Les éléments masqués (ceux qui sont dessinés), plus les deux imports, sans doublon, triés.
        assert_eq!(views[0]["hiddenElements"], json!(["dwg-1f", "dwg-gf", "mur-1"]));
        // Une vue qui ne masque pas les imports n'en masque aucun de plus.
        let mut plain = Digest::default();
        observe_plan(&mut plain, 100, -1, json!({}), vec![("HiddenElementsViewSettings", json!({"m_hiddenElements": [id(10)]}))], no_crop(), "Floor Plan");
        let views: Vec<Value> = serde_json::from_str(&views_json(&plain, &elements).expect("vues")).expect("JSON");
        assert_eq!(views[0]["hiddenElements"], json!(["mur-1"]));
    }

    #[test]
    fn une_vue_3d_masque_aussi_les_imports_et_leurs_categories() {
        let mut digest = Digest::default();
        let root = json!({"m_viewName": "Vue 3D", "m_named": true, "m_origin": [0, 0, 0], "m_horzDir": [1, 0, 0], "m_vertDir": [0, 0, 1], "m_viewDir": [0, 1, 0], "m_viewerId": id(11)});
        let icky = json!({"m_categoryIds": [id(500)], "m_importsExcluded": true});
        digest.observe(10, -1, "DBView3d", &graph(vec![("DBView3d", root), ("IckyExcludedCategoriesSetPtrWrapper", icky)]));
        let space = json!({"m_basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "m_orig": [0, 0, 0], "m_boundOffset": [[100, -100], [100, -100], [100, -100]], "m_boundActive": [[false, false], [false, false], [false, false]], "m_isOn": false});
        digest.observe(11, 10, "Viewer3d", &graph(vec![("Viewer3d", json!({"m_boundedSpace": space, "m_projMethodType": 1}))]));
        let keys: HashMap<i64, &str> = HashMap::new();
        let categories = BTreeSet::from(["MAN-2F.dwg".to_string()]);
        let imports = HashMap::from([(500, "MAN-2F.dwg".to_string())]);
        let elements = elements_with(&keys, &categories, &imports, &["dwg-2f"]);
        let views: Vec<Value> = serde_json::from_str(&views_json(&digest, &elements).expect("vues")).expect("JSON");
        assert_eq!(views[0]["hiddenCategories"]["values"], json!(["MAN-2F.dwg"]));
        assert_eq!(views[0]["hiddenElements"], json!(["dwg-2f"]));
    }

    #[test]
    fn les_plans_leurs_viewers_et_leurs_types_d_une_famille_chargee_sont_ecartes() {
        let mut digest = Digest::default();
        // Le plan 10 est au projet ; 20 est possédé par la famille chargée 200 ; 30 par 201, une famille chargée imbriquée dans 200 ; 40 par 203,
        // une famille dont on ne sait pas si elle est chargée. Chaque plan a son `Viewer` (n + 1, possédé par le plan) et son type (n + 2,
        // possédé comme le plan).
        for (plan, owner, name) in [(10, -1, "Projet"), (20, 200, "Famille"), (30, 201, "Imbriquée"), (40, 203, "Illisible")] {
            observe_plan(&mut digest, plan, owner, json!({"m_viewName": name}), vec![], no_crop(), name);
        }
        // Un `Viewer` de coupe que nul plan ne désigne ne se garde pas non plus.
        digest.observe(777, -1, "Viewer", &graph(vec![("Viewer", json!({"m_boundedSpace": no_crop()}))]));
        assert_eq!((digest.plans.len(), digest.plan_viewers.len(), digest.view_types.len()), (4, 5, 4));
        let family = |id: u64| match id {
            200 | 201 => Some(Some(false)),
            203 => Some(None),
            _ => None,
        };
        let owner_of = |id: u64| match id {
            10 | 11 | 12 => Some(-1),
            20 | 30 | 40 => Some(match id {
                20 => 200,
                30 => 201,
                _ => 203,
            }),
            21 | 31 | 41 => Some(id as i64 - 1),
            22 => Some(200),
            32 => Some(201),
            42 => Some(203),
            _ => None,
        };
        digest.settle(|owner| FamilyRule::On { document: Some(-1) }.owner(owner, family, owner_of));
        // Restent le plan du projet et celui d'une famille illisible (ambigu : gardé et compté).
        assert_eq!(digest.plans.keys().copied().collect::<Vec<_>>(), vec![10, 40]);
        assert_eq!(digest.plan_viewers.keys().copied().collect::<Vec<_>>(), vec![11, 41]);
        assert_eq!(digest.view_types.keys().copied().collect::<Vec<_>>(), vec![12, 42]);
        assert_eq!(digest.unread(), 1);
        assert_eq!(digest.plans().map(|(plan, _, name)| (plan.view.name.as_str(), name)).collect::<Vec<_>>(), vec![("Projet", Some("Projet")), ("Illisible", Some("Illisible"))]);
    }

    #[test]
    fn l_avertissement_compte_les_enregistrements_d_une_famille_illisible() {
        assert_eq!(unread_warning(0), None);
        assert_eq!(unread_warning(1).as_deref(), Some("1 enregistrement de phase, de filtre de phase ou de vue appartient à une famille dont la définition ne se lit pas : il peut venir d'une famille chargée."));
        assert_eq!(unread_warning(4).as_deref(), Some("4 enregistrements de phases, de filtres de phase ou de vues appartiennent à une famille dont la définition ne se lit pas : ils peuvent venir d'une famille chargée."));
    }
}
