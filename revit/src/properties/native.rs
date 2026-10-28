//! Lecture des enregistrements natifs de Revit 2012 à 2027 : pour chaque élément dessiné, ses
//! paramètres enregistrés et les liens vers son type, son niveau, ses phases et ses matériaux ; puis
//! les enregistrements liés (types, niveaux, phases, matériaux, familles).
//!
//! Chaque enregistrement n'est décodé qu'une fois. La géométrie lit déjà tous les enregistrements
//! d'éléments (canal 102) pour savoir ce qui se dessine : elle passe ceux dont les propriétés auront
//! besoin à [`Retained::observe`], qui garde leur graphe décodé (les éléments qui pourraient se
//! dessiner, leurs types, familles, niveaux, phases et matériaux) et lit au passage les définitions
//! de paramètres que Revit range dans d'autres enregistrements. Les propriétés n'ont ensuite qu'à
//! projeter ces graphes (`native_metadata::project_with_definitions`) : les trois passes de
//! `native_document::extract` qu'elles faisaient, chacune précédée de sa propre lecture de toutes les
//! définitions, ne servent plus qu'à aller chercher, rarement, ce que la lecture des éléments n'a pas
//! gardé (une cible de paramètre qui n'est ni dessinée ni de ces classes).
//!
//! Sans la géométrie (essais, exemples), [`Retained::scan`] fait la même lecture sur les seuls
//! éléments demandés et les classes d'appui, en une passe.
//!
//! On n'appelle pas `native_element_parameters::read` : il ne joint le type que pour les instances de
//! famille et lit toutes les familles ; ici la jointure vaut pour toutes les catégories.

use crate::native::{self, FamilyRule, Options, Record, families};
use rvt::research::native_metadata::{self, SavedMetadata};
use rvt::research::native_parameter_definitions::{self as parameter_definitions, Definition, Registry as Definitions};
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::schema_registry;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Budget de décodage d'un graphe (valeurs et objets) : le même que celui de la lecture des formes.
const GRAPH_LIMIT: usize = 1_000_000;

/// Sorte de valeur d'un paramètre, comme Revit la stocke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    Text,
    Integer,
    Double,
    ElementId,
}

/// Un paramètre enregistré d'un élément ou de son type.
#[derive(Debug, Clone)]
pub struct Param {
    pub id: i64,
    pub storage: Storage,
    /// La valeur enregistrée, dans les unités internes de Revit ; un oui/non est un booléen.
    pub value: Value,
    /// Le nom donné par la définition du paramètre (famille, partagé, projet, global).
    pub caption: Option<String>,
    /// ForgeTypeId de la nature de la valeur (« autodesk.spec.aec:length-1.0.0 »), si la définition le dit.
    pub spec: Option<String>,
    /// ForgeTypeId du groupe, si la définition le dit.
    pub group: Option<String>,
    /// Valeur du type, non de l'élément.
    pub from_type: bool,
}

/// Une couche de la structure composée d'un type de mur, de sol, de toiture ou de plafond.
#[derive(Debug, Clone)]
pub struct Layer {
    /// Épaisseur en pieds.
    pub width: f64,
    /// Élément matériau, ou négatif si la couche n'en a pas.
    pub material: i64,
}

/// `WallSweep.m_wallSweepInfo` : ce que le fichier dit d'un profilé de mur (une corniche, une feuillure…).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallSweepInfo {
    /// `m_fixed` : le profilé fait partie de la structure verticale composée d'un type de mur (`WallSweepInfo.IsFixed`), il
    /// n'a pas de type et appartient (ElemTable) à son mur.
    pub fixed: bool,
    /// `m_wallSweepType` : 0 un profilé, 1 une feuillure (`WallSweepType.Sweep`, `Reveal`).
    pub kind: i64,
}

/// Ce que l'on retient d'un enregistrement.
#[derive(Debug, Default)]
pub struct Raw {
    pub class: String,
    /// Paramètres propres, sans doublon.
    pub params: Vec<Param>,
    /// Paramètres de famille qui sont des paramètres d'instance : sur un type, leur valeur est celle par
    /// défaut de la famille, non celle de l'instance.
    pub instance_defaults: BTreeSet<i64>,
    /// Liens vers d'autres éléments : (nom du champ, identifiant).
    pub refs: Vec<(String, i64)>,
    /// Nom d'un type (`SymbolInfo`), d'un niveau, d'une phase, d'un matériau ou d'une famille.
    pub name: Option<String>,
    /// L'enregistrement est un type : il porte un `SymbolInfo`.
    pub is_type: bool,
    /// Famille d'un type de famille chargée (`m_familyId`).
    pub family: Option<i64>,
    /// Catégorie d'une famille (`m_categoryId`, négatif).
    pub category: Option<i64>,
    /// `m_inPlace` d'une famille : `Some(true)` pour une famille sur place, `None` si le fichier ne le dit pas.
    pub in_place: Option<bool>,
    /// Catégorie enregistrée sur l'élément lui-même : `DirectShapeDataCell.m_categoryId` d'une forme directe.
    pub own_category: Option<i64>,
    /// `m_wallSweepInfo` d'un `WallSweep`.
    pub wall_sweep: Option<WallSweepInfo>,
    /// `m_footingType` d'un type de sol (`FloorAttributes`) : 1 pour une dalle de fondation, 0 pour un sol.
    pub footing_type: Option<i64>,
    /// Fonction d'un type de mur (`m_function`).
    pub function: Option<i64>,
    pub layers: Vec<Layer>,
    /// Matériaux de la géométrie d'un type de famille (`m_geomTag2MaterialId`).
    pub geometry_materials: Vec<i64>,
}

/// Tout ce qui a été lu, par identifiant d'élément.
#[derive(Debug, Default)]
pub struct Collected {
    pub records: HashMap<i64, Raw>,
}

/// Un identifiant d'élément tel que les enregistrements l'écrivent : `{"m_id":{"m_id64":n}}` (Revit 2024 et
/// plus), `{"m_id":{"m_id":n}}` (Revit 2023) ou le nombre seul.
pub(super) fn element_id(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    ["m_id", "m_id64"].into_iter().find_map(|key| value.get(key).and_then(element_id))
}

fn storage_of(name: &str) -> Storage {
    match name {
        "String" => Storage::Text,
        "Double" => Storage::Double,
        "ElementId" => Storage::ElementId,
        _ => Storage::Integer,
    }
}

fn param(id: i64, storage: &str, raw: &Value, definition: Option<&Definition>) -> Param {
    let spec = definition.and_then(|d| d.spec_type_id.clone());
    let value = match (spec.as_deref(), raw.as_i64()) {
        (Some(spec), Some(n)) if spec.starts_with("autodesk.spec:spec.bool-") => Value::Bool(n != 0),
        _ => raw.clone(),
    };
    Param {
        id,
        storage: storage_of(storage),
        value,
        caption: definition.map(|d| d.caption.clone()).filter(|caption| !caption.is_empty()),
        spec,
        group: definition.and_then(|d| d.group_type_id.clone()).filter(|group| !group.is_empty()),
        from_type: false,
    }
}

/// Les champs qui désignent un type, un niveau ou une famille, que l'on suit. `…idattr` est le seul champ de ce nom dans les
/// schémas des 54 fichiers d'essai lisibles : `CurtaSystemBase.m_idAttr`, le type d'un système de murs-rideaux. `…idtype` est
/// `m_idType` : le type d'une gaine (`RbsDuctCurve`, `AbsDuctType`) ou d'un tuyau (`RbsPipeCurve`, `RbsPipeType`), 5 éléments sur 5
/// mesurés sans autre champ de type. `m_idSegment` (le segment d'un tuyau ou d'une gaine) n'est pas un type : il ne se suit pas.
fn followed(field: &str) -> bool {
    let field = field.to_ascii_lowercase();
    field.ends_with("attributesid")
        || field.ends_with("attrid")
        || field.ends_with("idattr")
        || field.ends_with("idtype")
        || field.ends_with("typeid")
        || field.ends_with("symbolid")
        || field.contains("level")
}

/// Réduit un enregistrement décodé à ce qui sert aux fiches. `None` si ses paramètres ne se projettent pas.
fn decode(id: u64, graph: &ObjectGraph, definitions: &Definitions) -> Option<Raw> {
    let metadata: SavedMetadata = native_metadata::project_with_definitions(graph, definitions).ok()?;
    let metadata = &metadata;
    let root = graph.objects.first()?;
    let definitions: HashMap<i64, &Definition> = metadata.parameter_definitions.iter().map(|d| (d.parameter_id, d)).collect();
    let definition = |id: i64| definitions.get(&id).copied();

    let mut params = Vec::new();
    for set in &metadata.parameter_sets {
        for value in &set.parameters {
            params.push(param(value.serialized_parameter_id, &value.storage_type, &value.raw_value, definition(value.serialized_parameter_id)));
        }
    }
    let mut instance_defaults = BTreeSet::new();
    for value in &metadata.resolved_family_parameters {
        let is_instance = definition(value.parameter_id).and_then(|d| d.owner_fields.get("m_instanceParam")).and_then(Value::as_bool) == Some(true);
        if is_instance {
            instance_defaults.insert(value.parameter_id);
        }
        params.push(param(value.parameter_id, &value.storage_type, &value.raw_value, definition(value.parameter_id)));
    }
    for value in &metadata.raw_field_parameters {
        params.push(param(value.parameter_id, &value.storage_type, &value.raw_value, definition(value.parameter_id)));
    }
    // Une valeur par paramètre : la première source lue la garde.
    let mut seen = BTreeSet::new();
    params.retain(|p| seen.insert(p.id));

    let class = root.class_name.clone();
    let mut raw = Raw { class, params, instance_defaults, ..Raw::default() };
    let fields = root.fields.as_object();
    let own_id = id as i64;
    for (key, value) in fields.into_iter().flatten() {
        if followed(key)
            && let Some(id) = element_id(value).filter(|id| *id > 0 && *id != own_id)
        {
            raw.refs.push((key.clone(), id));
        }
    }

    let object = |class: &str| graph.objects.iter().find(|o| o.class_name == class);
    let text = |value: Option<&Value>| value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(info) = object("SymbolInfo") {
        raw.is_type = true;
        raw.name = text(info.fields.get("m_name"));
    }
    match raw.class.as_str() {
        "Level" => raw.name = text(root.fields.get("m_text")),
        "ProjectPhase" => raw.name = text(root.fields.get("m_name")),
        "MaterialElem" => raw.name = object("Material").and_then(|o| text(o.fields.get("m_name"))),
        "Family" => {
            raw.name = text(root.fields.get("m_name")).or_else(|| object("Family").and_then(|o| text(o.fields.get("m_name"))));
            raw.category = root.fields.get("m_categoryId").and_then(element_id);
            raw.in_place = families::in_place(&raw.class, Some(&root.fields));
        }
        _ => {}
    }
    if raw.is_type {
        raw.family = root.fields.get("m_familyId").and_then(element_id).filter(|id| *id > 0);
        raw.function = root.fields.get("m_function").and_then(Value::as_i64);
        if let Some(map) = root.fields.get("m_geomTag2MaterialId").and_then(Value::as_array) {
            for entry in map {
                if let Some(id) = entry.get("second").or_else(|| entry.get("m_materialId")).and_then(element_id).filter(|id| *id > 0)
                    && !raw.geometry_materials.contains(&id)
                {
                    raw.geometry_materials.push(id);
                }
            }
        }
    }
    if let Some(layers) = graph.objects.iter().find_map(|o| o.fields.get("m_layers").and_then(Value::as_array)) {
        for layer in layers {
            raw.layers.push(Layer {
                width: layer.get("m_layerWidth").and_then(Value::as_f64).unwrap_or(0.0),
                material: layer.get("m_materialId").and_then(element_id).unwrap_or(-1),
            });
        }
    }
    // Ce que le fichier dit de la catégorie d'un élément, quand sa classe ne suffit pas (voir `fiche::Resolver::category_of`).
    match raw.class.as_str() {
        "DirectShape" => raw.own_category = object("DirectShapeDataCell").and_then(|cell| cell.fields.get("m_categoryId")).and_then(element_id),
        "WallSweep" => {
            raw.wall_sweep = root.fields.get("m_wallSweepInfo").and_then(|info| Some(WallSweepInfo { fixed: info.get("m_fixed")?.as_bool()?, kind: info.get("m_wallSweepType")?.as_i64()? }));
        }
        "FloorAttributes" => raw.footing_type = root.fields.get("m_footingType").and_then(Value::as_i64),
        _ => {}
    }
    add_native_fields(&mut raw, root.fields.as_object());
    Some(raw)
}

/// Des paramètres que Revit calcule à partir des champs natifs de l'élément et que le fichier ne
/// range pas dans ses jeux de paramètres : les niveaux d'un mur, son usage structurel…
fn add_native_fields(raw: &mut Raw, fields: Option<&serde_json::Map<String, Value>>) {
    let Some(fields) = fields else { return };
    let level = |name: &str| fields.get(name).and_then(element_id).filter(|id| *id > 0);
    // Un élément de phase peut porter l'identifiant 0 (la première phase de certains gabarits) : seul -1 dit « aucune ».
    let phase = |name: &str| fields.get(name).and_then(element_id).filter(|id| *id >= 0);
    let mut add = |id: i64, storage: Storage, value: Value| {
        if !raw.params.iter().any(|p| p.id == id) {
            raw.params.push(Param { id, storage, value, caption: None, spec: None, group: None, from_type: false });
        }
    };
    // Les phases d'un élément : rvt-rs ne les range en paramètres que pour certaines classes.
    if let Some(id) = phase("m_createdPhaseId") {
        add(-1012100, Storage::ElementId, Value::from(id)); // PHASE_CREATED
    }
    if let Some(id) = phase("m_demolishedPhaseId") {
        add(-1012101, Storage::ElementId, Value::from(id)); // PHASE_DEMOLISHED
    }
    if raw.class == "SWall" {
        if let Some(id) = level("m_assocLevelId") {
            add(-1001107, Storage::ElementId, Value::from(id)); // WALL_BASE_CONSTRAINT
        }
        if let Some(id) = level("m_upToLevelId") {
            add(-1001103, Storage::ElementId, Value::from(id)); // WALL_HEIGHT_TYPE
        }
        if let Some(on) = fields.get("m_roomBounding").and_then(Value::as_bool) {
            add(-1001007, Storage::Integer, Value::Bool(on)); // WALL_ATTR_ROOM_BOUNDING
        }
        if let Some(on) = fields.get("m_isStructuralSignificant").and_then(Value::as_bool) {
            add(-1001596, Storage::Integer, Value::Bool(on)); // WALL_STRUCTURAL_SIGNIFICANT
        }
    }
}

/// Les éléments que désigne un enregistrement : les champs qui suivent un type, un niveau ou une famille,
/// et les valeurs de paramètres qui sont des identifiants d'élément.
fn referenced(raw: &Raw) -> impl Iterator<Item = u64> + '_ {
    let fields = raw.refs.iter().map(|(_, id)| *id);
    let parameters = raw.params.iter().filter(|p| p.storage == Storage::ElementId).map(|p| p.value.as_i64().unwrap_or(-1));
    fields.chain(parameters).filter_map(|id| u64::try_from(id).ok()).filter(|id| *id > 0)
}

/// Ce que désigne en plus un type : sa famille, les matériaux de ses couches et de sa géométrie, et les
/// éléments de ses paramètres.
fn type_links(raw: &Raw) -> impl Iterator<Item = u64> + '_ {
    let family = raw.family.into_iter();
    let layers = raw.layers.iter().map(|layer| layer.material);
    let materials = raw.geometry_materials.iter().copied();
    let parameters = raw.params.iter().filter(|p| p.storage == Storage::ElementId).map(|p| p.value.as_i64().unwrap_or(-1));
    family.chain(layers).chain(materials).chain(parameters).filter_map(|id| u64::try_from(id).ok()).filter(|id| *id > 0)
}

/// Classes dont les enregistrements servent aux fiches quel que soit l'élément : ce que les instances
/// placent (types, symboles, familles), les niveaux, les phases, les matériaux, et l'emplacement du
/// site (`geo`).
pub fn is_support_class(class: &str) -> bool {
    crate::geometry::classes::is_definition(class) || matches!(class, "Level" | "ProjectPhase" | "MaterialElem") || is_site_class(class) || crate::views::is_view_class(class)
}

/// Les classes dont les enregistrements portent une définition de paramètre, ou le contexte qui sert à
/// les résoudre : ce que lit la première passe de `native_document::extract`. Une classe porte une
/// définition si elle ou l'un de ses parents a un champ `m_pParamDef`.
pub fn definition_classes(registry: &schema_registry::Registry) -> BTreeSet<String> {
    let mut classes: BTreeSet<String> = ["UnitsElem", "ParamBinding", "Family", "FamilySymbol"].into_iter().map(String::from).collect();
    for class in &registry.classes {
        let mut tag = class.tag;
        for _ in 0..128 {
            let Some(current) = registry.class(tag) else { break };
            if current.fields.iter().any(|field| field.name == "m_pParamDef") {
                classes.insert(class.name.clone());
                break;
            }
            tag = current.parent_reference.tag;
        }
    }
    classes
}

/// Classes de l'emplacement du site, dont les propriétés ne gardent que le résultat (`geo`).
fn is_site_class(class: &str) -> bool {
    matches!(class, "GeoLocation" | "GeoSite" | "ActiveGeoLocationTrackingElement")
}

/// Un paramètre décimal de Revit 2015 à 2020 n'a pas de spec mais le numéro de l'ancienne énumération `UnitType`
/// (`m_unitType`) : on lui donne la spec que Revit 2022 donne à ce numéro (voir `catalog::unit_types`), pour que sa
/// valeur se convertisse en SI comme celle d'un fichier récent. Un numéro inconnu laisse la définition sans spec.
fn complete_legacy_spec(definition: &mut Definition) {
    if definition.spec_type_id.is_some() || definition.definition_class != "ParamDefValue" {
        return;
    }
    let Some(spec) = definition.definition_fields.get("m_unitType").and_then(Value::as_i64).and_then(crate::catalog::unit_types::spec_of) else { return };
    definition.spec_type_id = Some(spec.to_string());
    definition.spec_evidence = "mapped_legacy_unit_type";
}

/// Octets d'enregistrements (`Record::source::body_bytes`) dont on garde le graphe en attendant que les
/// définitions de paramètres soient lues. Un graphe décodé pèse 60 à 140 fois son enregistrement (mesuré sur les
/// fichiers d'essai : chaque nombre devient une valeur JSON), soit 60 à 140 Mo ici au plus ; compter les objets
/// (20 000) laissait monter cette attente à 390 Mo sur `rac_advanced_sample_project.rvt`. C'est, depuis que les instances
/// n'attendent plus leurs symboles avec leur graphe, la plus grosse file de la lecture : à 2 Mio elle faisait le pic de
/// `RefineryPrimer` et de `ConnectorTestR20` (190 à 210 Mo), pour 0,2 s de relecture en moins. Au-delà, les types et
/// familles (des centaines dans un fichier de MEP) ne sont plus gardés : on n'en lit que le contexte, et ceux qu'un
/// élément dessiné désigne se relisent dans le fichier.
const WAITING_BODY_BYTES: usize = 1 << 20;

/// Ce que la lecture des enregistrements d'éléments (canal 102) laisse aux propriétés : les définitions de
/// paramètres lues au passage, et les enregistrements des éléments qui peuvent se dessiner et des classes
/// d'appui, déjà projetés pour les fiches (voir le début du module).
#[derive(Default)]
pub struct Retained {
    definitions: Definitions,
    /// Toutes les définitions de paramètres sont lues : un enregistrement décodé ensuite se projette
    /// aussitôt, et son graphe, lourd, n'est pas gardé (voir `Retained::definitions_done`).
    definitions_done: bool,
    /// Graphes qui attendent la fin des définitions pour être projetés, et la somme des octets de leurs
    /// enregistrements.
    waiting: HashMap<u64, ObjectGraph>,
    waiting_bytes: usize,
    /// Les enregistrements projetés.
    collected: Collected,
    /// Parmi eux, les éléments qui peuvent se dessiner (les autres sont des classes d'appui).
    candidates: BTreeSet<u64>,
    /// L'emplacement du site : quelques graphes.
    site: HashMap<u64, ObjectGraph>,
    /// Les phases, filtres de phase et vues 3D (voir le module `views`) : ce qu'on en retient, sans les graphes.
    views: crate::views::Digest,
    /// Les `Family` lues (identifiant → `m_inPlace`, voir `native::families::in_place`) : de quoi dire, une fois toute la lecture faite,
    /// quels enregistrements de `views` sont des pièces d'une famille chargée. Une centaine d'identifiants.
    families: BTreeMap<u64, Option<bool>>,
    /// La lecture des éléments a eu lieu (par la géométrie ou par [`Retained::scan`]).
    filled: bool,
    /// Éléments déjà cherchés dans le fichier : un enregistrement absent ou illisible ne se cherche pas
    /// deux fois.
    fetched: BTreeSet<u64>,
}

impl Retained {
    /// Un enregistrement d'élément (canal 102) vient d'être décodé. S'il porte une définition de paramètre
    /// ou le contexte qui sert à les résoudre, celle-ci est lue (comme la première passe de
    /// `native_document::extract`). S'il peut se dessiner (`keep`) ou s'il est de ceux qui servent à toutes
    /// les fiches, il est projeté pour elles, tout de suite si les définitions sont complètes.
    pub fn observe(&mut self, record: Record, keep: bool) {
        let id = record.identity.element_id;
        let class = record.class_name.as_deref().unwrap_or("");
        // Une `Family` se note même quand son graphe ne s'est pas décodé : sa nature inconnue est ce que la règle des familles
        // chargées traite comme ambigu (`FamilyOwner::Unread`), comme pour les éléments dessinés (`saved::Info::in_place`).
        if class == "Family" {
            self.families.insert(id, families::in_place(class, record.graph.as_ref().and_then(|graph| graph.objects.first()).map(|root| &root.fields)));
        }
        let Some(graph) = record.graph else { return };
        self.ingest_definition(&graph);
        if crate::views::is_view_class(class) {
            self.views.observe(id, record.identity.owning_element_id, class, &graph);
        } else if class == "MaterialElem" {
            self.views.observe_material(id, &graph);
        }
        if is_site_class(class) {
            self.site.insert(id, graph);
        } else if crate::views::is_view_class(class) && class != "ProjectPhase" {
            // Phases, filtres et vues : tout ce qui sert est dans `views`, ces enregistrements n'ont pas de fiche.
        } else if keep || is_support_class(class) {
            if keep {
                self.candidates.insert(id);
            }
            // Les niveaux, phases, matériaux et vues servent à toutes les fiches et sont peu nombreux : ils attendent
            // toujours. Le budget ne vaut que pour les types, familles et éléments, nombreux et relus au besoin.
            let small = is_support_class(class) && !crate::geometry::classes::is_definition(class);
            if self.definitions_done {
                self.project_now(id, &graph);
            } else if small || self.waiting_bytes + record.source.body_bytes <= WAITING_BODY_BYTES {
                self.waiting_bytes += record.source.body_bytes;
                self.waiting.insert(id, graph);
            }
        }
    }

    fn ingest_definition(&mut self, graph: &ObjectGraph) {
        let Some(root) = graph.objects.first() else { return };
        // Les erreurs (définition absente, conflit) n'empêchent pas de lire le reste : le paramètre
        // concerné reste simplement sans nom ni unité, comme dans `native_document::extract`.
        let _ = match root.class_name.as_str() {
            "UnitsElem" => self.definitions.ingest_units(graph),
            "ParamBinding" | "Family" | "FamilySymbol" => self.definitions.ingest_binding_context(graph),
            _ => match parameter_definitions::project(graph) {
                Ok(Some(mut definition)) => {
                    complete_legacy_spec(&mut definition);
                    self.definitions.insert(definition)
                }
                _ => Ok(()),
            },
        };
    }

    fn project_now(&mut self, id: u64, graph: &ObjectGraph) {
        if let Some(raw) = decode(id, graph, &self.definitions) {
            self.collected.records.insert(id as i64, raw);
        }
    }

    /// Les définitions de paramètres sont toutes lues (elles vivent dans des enregistrements de classes
    /// qu'on lit en premier) : ce qui attendait est projeté, et ce qui se décode ensuite l'est aussitôt.
    pub fn definitions_done(&mut self) {
        if self.definitions_done {
            return;
        }
        self.definitions_done = true;
        let _ = self.definitions.enable_builtin_catalog("");
        self.waiting_bytes = 0;
        for (id, graph) in std::mem::take(&mut self.waiting) {
            self.project_now(id, &graph);
        }
    }

    /// Fin de la lecture des éléments : les éléments que `keep` ne retient pas (ils ne se dessinent pas
    /// après tout) sont oubliés, et les phases, filtres de phase et vues que possède une famille chargée (avant Revit 2015, voir
    /// `native::families`) sont écartés du résumé de `views`, d'après la même règle que la géométrie.
    /// `owner_of` donne le propriétaire d'ElemTable de tout enregistrement (`native::families::Owners`), que la règle remonte.
    pub fn finish_reading(&mut self, keep: impl Fn(u64) -> bool, rule: FamilyRule, owner_of: &dyn Fn(u64) -> Option<i64>) {
        self.definitions_done();
        let family_facts = &self.families;
        self.views.settle(|owner| rule.owner(owner, |id| family_facts.get(&id).copied(), owner_of));
        let dropped: Vec<u64> = self.candidates.iter().copied().filter(|id| !keep(*id)).collect();
        for id in dropped {
            self.candidates.remove(&id);
            self.collected.records.remove(&(id as i64));
        }
        self.filled = true;
    }

    /// La lecture des éléments a eu lieu.
    pub fn is_filled(&self) -> bool {
        self.filled
    }

    /// Libère tout ce qui a été gardé.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// Les phases, filtres de phase et vues 3D lus avec les éléments.
    pub fn views(&self) -> &crate::views::Digest {
        &self.views
    }

    /// Les graphes de l'emplacement du site, d'une classe donnée.
    pub fn site_graphs<'a>(&'a self, class: &'a str) -> impl Iterator<Item = (u64, &'a ObjectGraph)> + 'a {
        self.site.iter().filter(move |(_, graph)| graph.objects.first().is_some_and(|root| root.class_name == class)).map(|(id, graph)| (*id, graph))
    }

    /// Garde le graphe d'un enregistrement de l'emplacement du site, comme `observe` le fait d'un enregistrement décodé :
    /// pour les essais de `geo`, qui construisent leurs graphes à la main.
    #[cfg(test)]
    pub(super) fn keep_site_graph(&mut self, id: u64, graph: ObjectGraph) {
        self.site.insert(id, graph);
    }

    /// Lit les éléments `ids`, les classes d'appui et les définitions de paramètres d'un fichier, en une
    /// passe : ce que la géométrie offre déjà quand elle a lu le fichier, pour qui n'a que des
    /// identifiants.
    pub fn scan(&mut self, file: &mut rvt::RevitFile, ids: &[u64]) -> anyhow::Result<()> {
        let preamble = native::preamble(file)?;
        let registry = &preamble.registry;
        let wanted: BTreeSet<u64> = ids.iter().copied().collect();
        let options = Options {
            selected_ids: wanted.clone(),
            selected_classes: registry.classes.iter().map(|class| class.name.as_str()).filter(|name| is_support_class(name) || is_site_class(name)).map(str::to_string).chain(definition_classes(registry)).collect(),
            max_graph_values: GRAPH_LIMIT,
            max_graph_objects: GRAPH_LIMIT,
            ..Options::default()
        };
        native::extract_graphs(file, &options, |record| {
            let keep = wanted.contains(&record.identity.element_id);
            self.observe(record, keep);
            Ok(())
        })?;
        let owners = families::Owners::of(file);
        self.finish_reading(|id| wanted.contains(&id), FamilyRule::of(file), &|id| owners.get(id));
        Ok(())
    }

    /// Lit dans le fichier les enregistrements de `ids` que la lecture des éléments n'a pas gardés, et
    /// les projette : une passe sur le fichier, qu'on évite quand rien ne manque.
    fn fetch_missing(&mut self, file: &mut rvt::RevitFile, ids: &BTreeSet<u64>) -> anyhow::Result<()> {
        let missing: BTreeSet<u64> = ids.iter().copied().filter(|id| !self.collected.records.contains_key(&(*id as i64)) && !self.fetched.contains(id)).collect();
        if missing.is_empty() {
            return Ok(());
        }
        self.fetched.extend(&missing);
        let options = Options { selected_ids: missing, max_graph_values: GRAPH_LIMIT, max_graph_objects: GRAPH_LIMIT, ..Options::default() };
        native::extract_graphs(file, &options, |record| {
            if let Some(graph) = record.graph {
                self.project_now(record.identity.element_id, &graph);
            }
            Ok(())
        })?;
        Ok(())
    }

    /// Les propriétaires d'ElemTable dont dépendent la catégorie, la famille et le type d'un profilé de mur (son mur, et le type de ce mur)
    /// et d'une forme de famille (sa première `Family`, qu'on remonte comme `fiche::Resolver::category_of`, au plus
    /// [`families::MAX_OWNER_CHAIN`] pas, puis le `FamilySymbol` qui possède cette `Family`). Presque tout est déjà là : le mur se dessine,
    /// `Family` est une classe d'appui. Ce qui manque (une `Family` ou un symbole que la file d'attente de [`WAITING_BODY_BYTES`] a laissé
    /// tomber) se lit dans le fichier, pour que la lecture rapide rende ce que la lecture complète rend.
    fn fetch_owners(&mut self, file: &mut rvt::RevitFile, roots: &BTreeSet<u64>) -> anyhow::Result<()> {
        let owners = families::Owners::of(file);
        let of_class = |records: &HashMap<i64, Raw>, wanted: fn(&str) -> bool| -> BTreeSet<u64> { roots.iter().copied().filter(|id| records.get(&(*id as i64)).is_some_and(|raw| wanted(&raw.class))).collect() };
        let owners_of = |ids: &BTreeSet<u64>| -> BTreeSet<u64> { ids.iter().filter_map(|id| owners.get(*id)).filter_map(|owner| u64::try_from(owner).ok()).collect() };
        let sweeps = of_class(&self.collected.records, |class| class == "WallSweep");
        let mut forms = of_class(&self.collected.records, crate::catalog::is_family_form);
        // Le mur d'un profilé et la première étape de la remontée d'une forme : leur propriétaire direct.
        let direct = owners_of(&sweeps.union(&forms).copied().collect());
        self.fetch_missing(file, &direct)?;
        // Le type du mur d'un profilé intégré (sa famille système et son nom, que la fiche du profilé reprend) : ce que le mur désigne.
        let walls = owners_of(&sweeps);
        let wall_links: BTreeSet<u64> = walls.iter().filter_map(|id| self.collected.records.get(&(*id as i64))).flat_map(referenced).collect();
        self.fetch_missing(file, &wall_links)?;
        forms = owners_of(&forms);
        // Les `Family` atteintes : leur propriétaire est le symbole dont la fiche d'une forme sur place prend le type.
        let mut reached: BTreeSet<u64> = BTreeSet::new();
        for _ in 1..families::MAX_OWNER_CHAIN {
            // On ne monte pas plus haut qu'une `Family`, ni qu'un enregistrement que le fichier ne donne pas.
            let is_family = |id: &u64| self.collected.records.get(&(*id as i64)).is_some_and(|raw| raw.class == "Family");
            reached.extend(forms.iter().copied().filter(is_family));
            forms.retain(|id| self.collected.records.get(&(*id as i64)).is_some_and(|raw| raw.class != "Family"));
            forms = owners_of(&forms);
            if forms.is_empty() {
                break;
            }
            self.fetch_missing(file, &forms)?;
        }
        reached.extend(forms.iter().copied().filter(|id| self.collected.records.get(&(*id as i64)).is_some_and(|raw| raw.class == "Family")));
        self.fetch_missing(file, &owners_of(&reached))
    }

    /// Complète ce qui a été projeté avec ce que désignent les éléments `roots` : ce que leurs champs et
    /// leurs paramètres désignent (types, niveaux, phases, hôtes), puis ce que désignent à leur tour les
    /// types (famille, matériaux des couches). Presque tout est déjà là ; le reste se lit dans le fichier.
    fn close(&mut self, file: &mut rvt::RevitFile, roots: &BTreeSet<u64>) -> anyhow::Result<()> {
        self.fetch_missing(file, roots)?;
        self.fetch_owners(file, roots)?;
        let records = &self.collected.records;
        let targets: BTreeSet<u64> = roots.iter().filter_map(|id| records.get(&(*id as i64))).flat_map(referenced).collect();
        self.fetch_missing(file, &targets)?;
        // Ce que ces éléments désignent à leur tour : le type d'un hôte, par exemple, dont la fiche de l'élément écrit le
        // nom (« Élément Revit : Structural Framing System »). Sans lui, la fiche d'une lecture rapide dirait « Élément
        // Revit 201312 » là où la lecture sans raccourci, qui a tout décodé, donne le nom.
        let records = &self.collected.records;
        let second: BTreeSet<u64> = targets.iter().filter_map(|id| records.get(&(*id as i64))).flat_map(referenced).filter(|id| !roots.contains(id) && !targets.contains(id)).collect();
        self.fetch_missing(file, &second)?;
        let records = &self.collected.records;
        let links: BTreeSet<u64> = roots.iter().chain(&targets).chain(&second).filter_map(|id| records.get(&(*id as i64))).filter(|raw| raw.is_type).flat_map(type_links).collect();
        self.fetch_missing(file, &links)
    }
}

/// Les enregistrements des éléments `ids` et de ce qu'ils désignent, projetés pour les fiches. Échoue si
/// le fichier n'est pas de Revit 2012 à 2027 (le lecteur natif ne le déchiffre pas).
pub fn collect(file: &mut rvt::RevitFile, retained: &mut Retained, ids: &[u64]) -> anyhow::Result<Collected> {
    if !retained.is_filled() {
        retained.scan(file, ids)?;
    }
    retained.close(file, &ids.iter().copied().collect())?;
    Ok(std::mem::take(&mut retained.collected))
}

#[cfg(test)]
mod tests {
    use super::followed;

    #[test]
    fn les_champs_qui_designent_un_type_un_niveau_ou_une_famille_se_suivent() {
        for field in ["m_typeId", "m_masterSymbolId", "m_symbolId", "m_stairsRailingAttrId", "m_idAttr", "m_assocLevelId", "m_baseLevelId", "m_footingAttributesId"] {
            assert!(followed(field), "{field}");
        }
        // `m_idType` : le type d'une gaine ou d'un tuyau (`RbsDuctCurve`, `RbsPipeCurve`).
        assert!(followed("m_idType"));
        // Le segment d'un tuyau ou d'une gaine n'est pas un type ; ni la phase, la famille ou le propriétaire.
        for field in ["m_idSegment", "m_createdPhaseId", "m_famId", "m_ownerId", "m_id", "m_idTypeOf"] {
            assert!(!followed(field), "{field}");
        }
    }
}
