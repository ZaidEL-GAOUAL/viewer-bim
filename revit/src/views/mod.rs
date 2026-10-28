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

pub use camera::{Camera, SectionBox};
pub use write::{Elements, phases_json, views_json};

use crate::native::FamilyOwner;
use rvt::research::native_parameters::{GraphObject, ObjectGraph};
use rvt::research::native_saved_mesh::pointer;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Les classes d'enregistrements dont ce module se sert.
pub fn is_view_class(class: &str) -> bool {
    matches!(class, "ProjectPhase" | "AllProjectPhases" | "PhaseFilterElem" | "DBView3d" | "Viewer3d" | "ModelClipBox")
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
    /// Catégories masquées (identifiants négatifs de BuiltInCategory).
    pub hidden_categories: Vec<i64>,
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
    /// Le propriétaire d'ElemTable de chaque enregistrement de phase, de filtre, de vue, de caméra ou de boîte de coupe lu : de
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
            self.owners.retain(|id, _| !dropped.contains(id));
        }
        self.unread = unread.iter().filter(|id| self.phases.contains_key(id) || self.filters.contains_key(id) || self.views.contains_key(id) || self.tables.iter().any(|table| table.id == **id)).count();
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

    /// Rien à écrire dans le contrat ?
    pub fn is_empty(&self) -> bool {
        self.phases.is_empty() && self.views.is_empty()
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
    }
    Some(view)
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

    #[test]
    fn l_avertissement_compte_les_enregistrements_d_une_famille_illisible() {
        assert_eq!(unread_warning(0), None);
        assert_eq!(unread_warning(1).as_deref(), Some("1 enregistrement de phase, de filtre de phase ou de vue appartient à une famille dont la définition ne se lit pas : il peut venir d'une famille chargée."));
        assert_eq!(unread_warning(4).as_deref(), Some("4 enregistrements de phases, de filtres de phase ou de vues appartiennent à une famille dont la définition ne se lit pas : ils peuvent venir d'une famille chargée."));
    }
}
