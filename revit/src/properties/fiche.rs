//! La fiche d'un élément : ses propriétés « de tête » (catégorie, famille, type, niveau…) puis ses
//! paramètres Revit rangés par groupe, ceux de l'instance d'abord, ceux du type ensuite.

use super::json::{Val, property_name};
use super::native::{Collected, Layer, Param, Raw, Storage};
use crate::catalog::units::{self, Spec};
use crate::catalog::{self, Quantity};
use crate::native::families;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

const FOOT: f64 = units::FOOT;

/// Noms français des propriétés de tête.
pub const CATEGORY: &str = "Catégorie";
pub const FAMILY: &str = "Famille";
pub const TYPE: &str = "Type";
pub const LEVEL: &str = "Niveau";
pub const REVIT_ID: &str = "Identifiant Revit";
pub const IFC_GUID: &str = "GUID IFC";
pub const PHASE_CREATED: &str = "Phase de création";
pub const PHASE_DEMOLISHED: &str = "Phase de démolition";
pub const MATERIALS: &str = "Matériaux";
pub const REVIT_CLASS: &str = "Classe Revit";
pub const GEOMETRY_SOURCE: &str = "Source de la géométrie";
pub const OTHER_GROUP: &str = "Autre";

// Paramètres intégrés que la fiche présente autrement (en tête) ou qui ne sont que de la plomberie.
const ELEM_TYPE_PARAM: i64 = -1002050;
const ELEM_FAMILY_PARAM: i64 = -1002051;
const ELEM_FAMILY_AND_TYPE_PARAM: i64 = -1002052;
const SYMBOL_ID_PARAM: i64 = -1002000;
const ALL_MODEL_TYPE_NAME: i64 = -1002001;
const ELEM_CATEGORY_PARAM: i64 = -1140362;
const ELEM_CATEGORY_PARAM_MT: i64 = -1140363;
const FAMILY_LEVEL_PARAM: i64 = -1001352;
const SCHEDULE_LEVEL_PARAM: i64 = -1002062;
const PHASE_CREATED_PARAM: i64 = -1012100;
const PHASE_DEMOLISHED_PARAM: i64 = -1012101;
const ROOM_NAME_PARAM: i64 = -1006900;
const ROOM_NUMBER_PARAM: i64 = -1006901;
const FUNCTION_PARAM: i64 = -1001006;

const PLUMBING: &[i64] = &[
    ELEM_TYPE_PARAM,
    ELEM_FAMILY_PARAM,
    ELEM_FAMILY_AND_TYPE_PARAM,
    SYMBOL_ID_PARAM,
    ALL_MODEL_TYPE_NAME,
    ELEM_CATEGORY_PARAM,
    ELEM_CATEGORY_PARAM_MT,
    FAMILY_LEVEL_PARAM,
    SCHEDULE_LEVEL_PARAM,
    PHASE_CREATED_PARAM,
    PHASE_DEMOLISHED_PARAM,
];

/// Ordre d'affichage des groupes, celui de la palette de Revit ; les autres suivent, « Autre » en dernier.
const GROUP_ORDER: &[&str] = &[
    "Contraintes",
    "Cotes",
    "Structure",
    "Construction",
    "Matériaux et finitions",
    "Graphismes",
    "Données d'identification",
    "Paramètres IFC",
    "Données",
    "Général",
    "Texte",
    "Visibilité",
    "Mécanique",
    "Mécanique - Débit d'air",
    "Mécanique - Charges",
    "Plomberie",
    "Électricité",
    "Électricité - Circuits",
    "Électricité - Charges",
    "Électricité - Éclairage",
    "Protection incendie",
    "Analyse énergétique",
    "Modèle analytique",
];

/// Une fiche prête à être écrite.
pub struct Fiche {
    pub label: String,
    /// Propriétés de tête : (nom, valeur).
    pub head: Vec<(&'static str, Val)>,
    /// Groupes : (nom du groupe, propriétés).
    pub groups: Vec<(String, Vec<(String, Val)>)>,
}

impl Fiche {
    /// La fiche d'un élément dont on ne sait rien de plus que son identifiant.
    pub fn bare(id: i64, guid: Option<&str>) -> Self {
        let mut head: Vec<(&'static str, Val)> = vec![(REVIT_ID, Val::Int(id))];
        if let Some(guid) = guid {
            head.push((IFC_GUID, Val::Text(guid.to_string())));
        }
        Fiche { label: format!("Élément Revit {id}"), head, groups: Vec::new() }
    }
}

/// La famille et le type d'un élément, tels que la fiche les écrit (propriétés « Famille » et « Type ») et que le libellé les nomme.
struct Naming {
    family: Option<String>,
    type_name: Option<String>,
}

pub struct Resolver<'a> {
    pub collected: &'a Collected,
    /// Libellés des éléments déjà calculés : un hôte (le mur d'une porte) est nommé par le sien.
    labels: RefCell<HashMap<i64, String>>,
    /// Le propriétaire d'ElemTable d'un enregistrement (`families::Owners::get`), `None` si l'index ne le connaît pas.
    owner_of: Box<dyn Fn(u64) -> Option<i64> + 'a>,
    /// `ADocument.m_ownerFamilyId` : la `Family` que le document est (`-1` dans un projet, `None` si la racine ne se lit pas).
    document_family: Option<i64>,
}

impl<'a> Resolver<'a> {
    /// Sans propriétaires d'ElemTable : les formes d'une famille et les profilés intégrés d'un mur n'ont alors pas de catégorie (les
    /// essais à la main, `used_builtin_parameters` et `double_parameters`, qui n'écrivent aucune catégorie).
    pub fn new(collected: &'a Collected) -> Self {
        Self::with_owners(collected, |_| None, None)
    }

    /// Avec les propriétaires d'ElemTable et la famille du document : de quoi ranger les formes d'une famille et les profilés
    /// intégrés d'un mur.
    pub fn with_owners(collected: &'a Collected, owner_of: impl Fn(u64) -> Option<i64> + 'a, document_family: Option<i64>) -> Self {
        Self { collected, labels: RefCell::new(HashMap::new()), owner_of: Box::new(owner_of), document_family }
    }

    fn record(&self, id: i64) -> Option<&Raw> {
        self.collected.records.get(&id)
    }

    /// Le nom de l'élément `id` : celui de son enregistrement (type, niveau, phase, matériau), sinon son libellé.
    fn name_of(&self, id: i64) -> Option<String> {
        let raw = self.record(id)?;
        if let Some(name) = &raw.name {
            return Some(name.clone());
        }
        if let Some(label) = self.labels.borrow().get(&id) {
            return Some(label.clone());
        }
        let label = self.label_of(id, raw);
        self.labels.borrow_mut().insert(id, label.clone());
        Some(label)
    }

    /// Un import CAD (`ImportInstance`) : son nom est celui du fichier importé (le nom de son symbole d'import, « MAN-GF.dwg »), et sa catégorie celle
    /// que le fichier donne à ce symbole : l'élément `CategoryElem` qui porte aussi le nom du fichier (Revit les range sous « Catégories
    /// importées »), ou une catégorie de Revit (« Styles d'objet d'importation » pour `SiteModel.dwg` de `dynamo-nyc-site-2013`). `None` pour
    /// tout autre élément, et pour un import dont le symbole ne se lit pas ou n'a pas de nom : il garde alors son libellé de catégorie et d'identifiant.
    fn import_naming(&self, raw: &Raw, type_raw: Option<&Raw>) -> Option<(String, Option<String>)> {
        if raw.class != crate::geometry::classes::IMPORT_CLASS {
            return None;
        }
        let symbol = type_raw.filter(|symbol| symbol.class == "MasterImportSymbol")?;
        let file = symbol.name.clone()?;
        let category = symbol.import_category.and_then(|id| if id > 0 { self.record(id).and_then(|record| record.name.clone()) } else { catalog::category(id).map(|category| category.label.to_string()) });
        Some((file, category))
    }

    /// Le libellé d'un élément : « Famille : Type », à défaut la famille seule, la catégorie et le type, la catégorie et l'identifiant.
    fn label_of(&self, id: i64, raw: &Raw) -> String {
        let type_raw = self.type_of(raw);
        if let Some((file, _)) = self.import_naming(raw, type_raw) {
            return file;
        }
        let family_raw = type_raw.and_then(|t| t.family).and_then(|id| self.record(id));
        let category = self.category_of(id, raw, type_raw, family_raw);
        let naming = self.naming(id, raw, type_raw, family_raw);
        self.label(raw, category, naming.family.as_deref(), naming.type_name.as_deref(), id)
    }

    /// La famille et le type d'un élément tels que la fiche et le libellé les écrivent : une seule fonction pour les deux, pour que le
    /// nom d'un hôte (le mur d'une porte) et la fiche de cet hôte s'accordent.
    ///
    /// Ce que le type de l'élément donne (`own_naming`) vaut d'abord. Un élément sans type en prend un que le fichier ne lui donne pas
    /// directement (`hosted_naming`) : celui du mur qui possède un profilé intégré, ceux de la famille sur place qui possède une forme.
    fn naming(&self, id: i64, raw: &Raw, type_raw: Option<&Raw>, family_raw: Option<&Raw>) -> Naming {
        let own = Self::own_naming(type_raw, family_raw);
        if type_raw.is_some() {
            return own;
        }
        self.hosted_naming(id, raw).unwrap_or(own)
    }

    /// La famille et le type que donne le type de l'élément : le nom de la famille chargée, à défaut la famille système de la classe du
    /// type (« Mur de base » pour `BasicWallType`), et le nom du type.
    fn own_naming(type_raw: Option<&Raw>, family_raw: Option<&Raw>) -> Naming {
        Naming {
            family: family_raw.and_then(|f| f.name.clone()).or_else(|| type_raw.and_then(|t| catalog::system_family(&t.class)).map(str::to_string)),
            type_name: type_raw.and_then(|t| t.name.clone()),
        }
    }

    /// La famille et le type d'un élément qui n'a pas de type, d'après son propriétaire d'ElemTable :
    /// - un profilé intégré à la structure d'un type de mur (`m_wallSweepInfo.m_fixed`) fait partie du mur : Revit ne le laisse pas
    ///   sélectionner à part et il suit les graphiques du mur. Il prend la famille et le type du mur (85 sur 85 ont le mur pour
    ///   propriétaire, comme pour leur catégorie), accepté si ce propriétaire est un mur et rien d'autre. Les paramètres du type du mur
    ///   ne se joignent pas à la fiche du profilé : ce n'est pas son type ;
    /// - une forme d'une famille sur place (extrusion, balayage, forme de masse…) est ce que Revit sélectionne comme l'instance de cette
    ///   famille, étiquetée « famille : type ». Chaîne mesurée sur 25 formes : forme → `Family` (`m_inPlace`, « Generic Models 9 »,
    ///   « Main Building », « wardrobe1 »…) → `FamilySymbol` → `FamilyInstance`. La famille est celle de la `Family`, le type est le
    ///   `FamilySymbol` qui la possède, accepté s'il est un type dont la famille est cette `Family` ; sans lui, le type reste vide.
    ///   Pas de paramètres de type non plus.
    ///
    /// Une forme de la famille du document (un `.rfa`) n'a ni famille ni type dans l'éditeur de familles : elle reste sans (voir `label`).
    fn hosted_naming(&self, id: i64, raw: &Raw) -> Option<Naming> {
        if let Some(wall) = self.sweep_wall(id, raw) {
            let wall_type = self.type_of(wall);
            let wall_family = wall_type.and_then(|t| t.family).and_then(|id| self.record(id));
            return Some(Self::own_naming(wall_type, wall_family));
        }
        if catalog::is_family_form(&raw.class) {
            let (family_id, family) = self.owner_family(id).filter(|(family_id, _)| self.document_family != Some(*family_id))?;
            let name = family.name.clone()?;
            let symbol = self.owner(family_id).and_then(|owner| self.record(owner)).filter(|symbol| symbol.class == "FamilySymbol" && symbol.is_type && symbol.family == Some(family_id));
            return Some(Naming { family: Some(name), type_name: symbol.and_then(|symbol| symbol.name.clone()) });
        }
        None
    }

    /// Un identifiant d'élément tel qu'une valeur de paramètre le donne : le nom de la cible, ou, pour une
    /// catégorie (identifiant négatif), son nom français.
    fn target(&self, id: i64) -> Option<String> {
        if id > 0 {
            self.name_of(id)
        } else {
            catalog::category(id).map(|category| category.label.to_string())
        }
    }

    /// Le type de l'élément : l'enregistrement que désigne un de ses champs et qui porte un `SymbolInfo`, dans l'ordre :
    /// 1. `m_masterSymbolId` ;
    /// 2. `m_typeId` : c'est le vrai type quand l'élément a aussi un symbole interne que le balayage prendrait avant lui. Une lisse
    ///    haute (`TopRail`) désigne par `m_symbolId` un `ContinuousRailSymbol` propre à elle, nommé « 1 », « 3 »… pour 12 des 38 mesurées
    ///    (DynamoSample, 4 années, et SampleModel ; les 26 autres ont un symbole sans nom, que le balayage laissait déjà de côté), et par
    ///    `m_typeId` son `TopRailType` (« Rectangular - 50x50mm »), le seul que Revit montre ;
    /// 3. le balayage des autres champs.
    ///
    /// Un champ n'est accepté que s'il désigne un enregistrement de type (`is_type`) : un `m_typeId` qui n'en désigne pas ne range rien.
    fn type_of<'r>(&'r self, raw: &'r Raw) -> Option<&'r Raw> {
        let typed = |field: &str| raw.refs.iter().filter(|(name, _)| name == field).find_map(|(_, id)| self.record(*id).filter(|r| r.is_type));
        // Un type qui porte un nom d'abord (certains symboles sont des types sans nom), puis tout type.
        let candidates = || raw.refs.iter().filter(|(field, _)| !field.contains("Level"));
        typed("m_masterSymbolId").or_else(|| typed("m_typeId")).or_else(|| {
            let found = candidates()
                .find(|(_, id)| self.record(*id).is_some_and(|r| r.is_type && r.name.is_some()))
                .or_else(|| candidates().find(|(_, id)| self.record(*id).is_some_and(|r| r.is_type)));
            self.record(found?.1)
        })
    }

    /// La catégorie de l'élément `id`, dans l'ordre :
    /// 1. la famille de son type (instance de famille) ;
    /// 2. ses paramètres `ELEM_CATEGORY_PARAM` ;
    /// 3. ce que le fichier dit de lui et qui l'emporte sur sa classe (`stated_category`) : la famille d'une forme, la dalle de fondation ;
    /// 4. sa classe (`catalog::fiche_class_category`) ;
    /// 5. ce que le fichier enregistre pour une classe qui n'a pas de catégorie (`recorded_category`).
    ///
    /// Une source manquante ou ambiguë ne range pas : l'élément garde « Classe Revit ».
    fn category_of(&self, id: i64, raw: &Raw, type_raw: Option<&Raw>, family: Option<&Raw>) -> Option<&'static catalog::Category> {
        if let Some(category) = family.and_then(|f| f.category).and_then(catalog::category) {
            return Some(category);
        }
        for param in [ELEM_CATEGORY_PARAM, ELEM_CATEGORY_PARAM_MT] {
            if let Some(category) = raw.params.iter().find(|p| p.id == param).and_then(|p| p.value.as_i64()).and_then(catalog::category) {
                return Some(category);
            }
        }
        self.stated_category(id, raw, type_raw).or_else(|| catalog::fiche_class_category(&raw.class)).or_else(|| self.recorded_category(id, raw, type_raw))
    }

    /// Ce que le fichier dit de la catégorie d'un élément et qui prime sur la table des classes, parce qu'il la contredit
    /// quelquefois :
    /// - une forme de famille (extrusion, forme de masse, balayage, fusion, révolution…) prend la catégorie de la famille qui la possède.
    ///   `ExtrusionElem → OST_GenericModel` et `FormElem → OST_Mass` se trompaient pour 11 des 34 formes mesurées (SampleModel : mobilier,
    ///   clockwork-wall : murs, mega et rac : masses, AdaptivePanel : modèles génériques) ; la catégorie de la famille est celle du
    ///   graphique de 44 des 45 formes, la 45e (un vide) n'est dessinée qu'avec le style de la géométrie coupante, et sa famille est des
    ///   modèles génériques comme la table. Une forme sans famille lisible garde la catégorie de sa classe ;
    /// - un sol dont le type est une dalle de fondation (`FloorAttributes.m_footingType` = 1) est une fondation porteuse : 5 sols sur 5
    ///   (« 150mm Foundation Slab ») sont dessinés avec le style OST_StructuralFoundation, et les 177 sols de type 0 avec OST_Floors.
    fn stated_category(&self, id: i64, raw: &Raw, type_raw: Option<&Raw>) -> Option<&'static catalog::Category> {
        if catalog::is_family_form(&raw.class) {
            return self.owner_family_category(id);
        }
        if raw.class == "Floor" && type_raw.is_some_and(|t| t.class == "FloorAttributes" && t.footing_type == Some(1)) {
            return catalog::category_by_ost("OST_StructuralFoundation");
        }
        None
    }

    /// Ce que le fichier enregistre pour un élément que ni sa famille, ni ses paramètres, ni sa classe ne rangent : la catégorie que
    /// son auteur a donnée à la forme directe, la classe de son type, ou le mur qui possède un profilé intégré.
    fn recorded_category(&self, id: i64, raw: &Raw, type_raw: Option<&Raw>) -> Option<&'static catalog::Category> {
        match raw.class.as_str() {
            // La catégorie que son auteur a donnée à la forme directe ; une valeur positive ou -1 n'en est pas une.
            "DirectShape" => raw.own_category.filter(|category| *category < 0).and_then(catalog::category),
            // Nez de dalle, bandeau ou gouttière : la classe de son type le dit. Sans type, ou d'une autre classe : rien.
            "SweepHost" => type_raw.and_then(|t| catalog::type_category(&t.class)),
            "WallSweep" => match (raw.wall_sweep, type_raw) {
                // Un profilé intégré à la structure d'un type de mur n'a pas de type : il suit le mur qui le possède (ElemTable),
                // comme ses graphiques (OST_Walls sur 85 sur 85). Accepté si ce propriétaire est un mur, et rien d'autre.
                (Some(info), None) if info.fixed => catalog::fiche_class_category(&self.sweep_wall(id, raw)?.class),
                // Un profilé autonome : la classe de son type, si elle s'accorde avec `m_wallSweepType` (0 profilé, 1 feuillure).
                (Some(info), Some(t)) if !info.fixed => match (t.class.as_str(), info.kind) {
                    ("CorniceAttr", 0) | ("RevealAttr", 1) => catalog::type_category(&t.class),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        }
    }

    /// Le propriétaire d'ElemTable de l'enregistrement `id`.
    fn owner(&self, id: i64) -> Option<i64> {
        (self.owner_of)(u64::try_from(id).ok()?)
    }

    /// Le mur qui possède un profilé intégré à la structure d'un type de mur (`m_wallSweepInfo.m_fixed`), d'après l'ElemTable : un
    /// profilé de ce genre n'a pas de type et suit son mur. Accepté si ce propriétaire est un mur, et rien d'autre : un propriétaire
    /// d'une autre classe, sans enregistrement ou inconnu de l'index ne donne rien.
    fn sweep_wall(&self, id: i64, raw: &Raw) -> Option<&Raw> {
        if !raw.wall_sweep.is_some_and(|info| info.fixed) {
            return None;
        }
        let wall = self.record(self.owner(id)?)?;
        catalog::fiche_class_category(&wall.class).filter(|category| category.ost == "OST_Walls").map(|_| wall)
    }

    /// La première `Family` que l'on rencontre en remontant les propriétaires d'ElemTable de `id` (au plus `families::MAX_OWNER_CHAIN`),
    /// avec son identifiant, si cette famille est sur place ou celle du document : les formes d'une famille chargée ne sont pas de ce
    /// modèle. Une `Family` dont on ne sait pas si elle est sur place (`m_inPlace` illisible), un maillon dont l'enregistrement manque
    /// (on ne sait pas si c'est une `Family`) ou une chaîne sans `Family` ne donnent rien.
    fn owner_family(&self, id: i64) -> Option<(i64, &Raw)> {
        let mut current = self.owner(id)?;
        for _ in 0..families::MAX_OWNER_CHAIN {
            let record = self.record(current)?;
            if record.class == "Family" {
                let ours = record.in_place == Some(true) || self.document_family == Some(current);
                return ours.then_some((current, record));
            }
            current = self.owner(current)?;
        }
        None
    }

    /// La catégorie de la famille que donne [`Resolver::owner_family`].
    fn owner_family_category(&self, id: i64) -> Option<&'static catalog::Category> {
        self.owner_family(id)?.1.category.and_then(catalog::category)
    }

    fn level_of(&self, raw: &Raw) -> Option<String> {
        for id in [FAMILY_LEVEL_PARAM, SCHEDULE_LEVEL_PARAM] {
            if let Some(name) = raw.params.iter().find(|p| p.id == id).and_then(|p| p.value.as_i64()).filter(|id| *id > 0).and_then(|id| self.name_of(id)) {
                return Some(name);
            }
        }
        for key in ["m_assocLevelId", "m_baseLevelId", "m_levelId", "m_scheduleOnlyLevelId"] {
            if let Some(name) = raw.refs.iter().find(|(field, _)| field == key).and_then(|(_, id)| self.name_of(*id)) {
                return Some(name);
            }
        }
        None
    }

    fn phase_of(&self, raw: &Raw, id: i64) -> Option<String> {
        // Une phase peut porter l'identifiant 0 : seul -1 dit « aucune phase ».
        raw.params.iter().find(|p| p.id == id).and_then(|p| p.value.as_i64()).filter(|id| *id >= 0).and_then(|id| self.name_of(id))
    }

    /// La fiche de l'élément `id`.
    pub fn fiche(&self, id: i64, guid: Option<&str>) -> Fiche {
        let Some(raw) = self.record(id) else { return Fiche::bare(id, guid) };
        let type_raw = self.type_of(raw);
        let family_raw = type_raw.and_then(|t| t.family).and_then(|id| self.record(id));
        let category = self.category_of(id, raw, type_raw, family_raw);
        let Naming { family: family_name, type_name } = self.naming(id, raw, type_raw, family_raw);
        let import = self.import_naming(raw, type_raw);
        let import_category = import.as_ref().and_then(|(_, category)| category.clone());

        // -- propriétés de tête
        let mut head: Vec<(&'static str, Val)> = Vec::new();
        if let Some(category) = category {
            head.push((CATEGORY, Val::Text(category.label.to_string())));
        } else if let Some(name) = &import_category {
            head.push((CATEGORY, Val::Text(name.clone())));
        }
        if let Some(name) = &family_name {
            head.push((FAMILY, Val::Text(name.clone())));
        }
        if let Some(name) = &type_name {
            head.push((TYPE, Val::Text(name.clone())));
        }
        if let Some(name) = self.level_of(raw) {
            head.push((LEVEL, Val::Text(name)));
        }
        head.push((REVIT_ID, Val::Int(id)));
        if let Some(guid) = guid {
            head.push((IFC_GUID, Val::Text(guid.to_string())));
        }
        if let Some(name) = self.phase_of(raw, PHASE_CREATED_PARAM) {
            head.push((PHASE_CREATED, Val::Text(name)));
        }
        if let Some(name) = self.phase_of(raw, PHASE_DEMOLISHED_PARAM) {
            head.push((PHASE_DEMOLISHED, Val::Text(name)));
        }
        if category.is_none() && import_category.is_none() {
            head.push((REVIT_CLASS, Val::Text(raw.class.clone())));
        }

        // -- paramètres : ceux de l'instance, puis ceux du type que l'instance n'a pas
        let mut params: Vec<Param> = raw.params.clone();
        let held: HashSet<i64> = params.iter().map(|p| p.id).collect();
        if let Some(type_raw) = type_raw {
            for p in &type_raw.params {
                if held.contains(&p.id) || type_raw.instance_defaults.contains(&p.id) {
                    continue;
                }
                let mut p = p.clone();
                p.from_type = true;
                params.push(p);
            }
            params.extend(self.type_structure_params(type_raw, &held));
        }

        let mut materials: Vec<String> = Vec::new();
        let mut add_material = |name: Option<String>| {
            if let Some(name) = name
                && !materials.contains(&name)
            {
                materials.push(name);
            }
        };
        let mut groups: Vec<(String, Vec<(String, Val)>)> = Vec::new();
        let mut used: HashSet<(usize, String)> = HashSet::new();
        for p in &params {
            if PLUMBING.contains(&p.id) {
                continue;
            }
            if p.storage == Storage::ElementId
                && let Some(target) = p.value.as_i64().filter(|id| *id > 0).and_then(|id| self.record(id))
                && target.class == "MaterialElem"
            {
                add_material(target.name.clone());
            }
            let Some((unit, value)) = self.convert(p) else { continue };
            let name = self.parameter_name(p);
            let name = format!("{}{}{}", property_name(&name), unit, if p.from_type { " (type)" } else { "" });
            let group = self.group_label(p);
            let index = match groups.iter().position(|(g, _)| *g == group) {
                Some(index) => index,
                None => {
                    groups.push((group, Vec::new()));
                    groups.len() - 1
                }
            };
            let mut name = name;
            if !used.insert((index, name.clone())) {
                // Deux paramètres de même nom dans un groupe : le second porte son identifiant.
                name = format!("{name} #{}", p.id.unsigned_abs());
                used.insert((index, name.clone()));
            }
            groups[index].1.push((name, value));
        }
        // Les matériaux du type : sa géométrie et ses couches (les couches se lisent aussi telles quelles).
        if let Some(type_raw) = type_raw {
            if !type_raw.layers.is_empty() {
                let index = match groups.iter().position(|(g, _)| g == "Construction") {
                    Some(index) => index,
                    None => {
                        groups.push(("Construction".to_string(), Vec::new()));
                        groups.len() - 1
                    }
                };
                groups[index].1.push(("Couches (type)".to_string(), Val::List(self.layers_text(&type_raw.layers))));
            }
            for id in &type_raw.geometry_materials {
                add_material(self.name_of(*id));
            }
            for layer in &type_raw.layers {
                add_material(self.name_of(layer.material));
            }
        }
        if !materials.is_empty() {
            head.push((MATERIALS, Val::List(materials)));
        }

        groups.sort_by_key(|(name, _)| {
            if name == OTHER_GROUP {
                usize::MAX
            } else {
                GROUP_ORDER.iter().position(|g| g == name).unwrap_or(GROUP_ORDER.len())
            }
        });

        let label = match &import {
            Some((file, _)) => file.clone(),
            None => self.label(raw, category, family_name.as_deref(), type_name.as_deref(), id),
        };
        Fiche { label, head, groups }
    }

    /// « Famille : Type » ; à défaut la famille seule, la catégorie et le type, puis la catégorie et l'identifiant. Une forme de la
    /// famille du document (un `.rfa`) est nommée par sa sorte et son identifiant (« Extrusion 1234 »).
    fn label(&self, raw: &Raw, category: Option<&catalog::Category>, family: Option<&str>, type_name: Option<&str>, id: i64) -> String {
        // Un nom de type sans lettre ni chiffre (« - », « -- ») ne distingue rien : RE1-Architecture nomme ainsi ses
        // types de mur, de sol, de plafond et de mobilier (`SymbolInfo.m_name`, comme dans l'export IFC de Revit). Le
        // libellé s'en passe ; la propriété « Type » garde le nom enregistré.
        let placeholder = type_name.is_some_and(|name| !name.chars().any(char::is_alphanumeric));
        if placeholder && let Some(family) = family {
            return family.to_string();
        }
        let type_name = type_name.filter(|_| !placeholder);
        if let (Some(family), Some(type_name)) = (family, type_name) {
            return format!("{family} : {type_name}");
        }
        // Une famille sans type lisible (la famille sur place dont le symbole ne se lit pas) : la famille seule, comme pour un type
        // qui ne distingue rien.
        if let Some(family) = family {
            return family.to_string();
        }
        let category_label = category.map_or("Élément Revit", |c| c.label);
        if let Some(type_name) = type_name {
            return format!("{category_label} : {type_name}");
        }
        if raw.class == "RoomElem" {
            let text = |param: i64| raw.params.iter().find(|p| p.id == param).and_then(|p| p.value.as_str()).filter(|s| !s.is_empty());
            return match (text(ROOM_NUMBER_PARAM), text(ROOM_NAME_PARAM)) {
                (Some(number), Some(name)) => format!("Pièce {number} : {name}"),
                (None, Some(name)) => format!("Pièce : {name}"),
                (Some(number), None) => format!("Pièce {number}"),
                (None, None) => format!("{category_label} {id}"),
            };
        }
        // Dans l'éditeur de familles, une forme n'a ni famille ni type : Revit la nomme par sa sorte (« Extrusion 1234 »). Les 20 formes
        // de .rfa mesurées (FamilyDocumentTests, AdaptivePanel, setout-point, ShellFamily…) ont pour propriétaire la famille du document.
        if let Some(kind) = catalog::form_kind(&raw.class)
            && self.owner_family(id).is_some_and(|(family_id, _)| self.document_family == Some(family_id))
        {
            return format!("{kind} {id}");
        }
        format!("{category_label} {id}")
    }

    /// Des paramètres de type que le fichier ne range pas dans ses jeux de paramètres : la fonction d'un
    /// type de mur, l'épaisseur et les couches d'une structure composée.
    fn type_structure_params(&self, type_raw: &Raw, held: &HashSet<i64>) -> Vec<Param> {
        let mut out = Vec::new();
        let synthetic = |id: i64, storage: Storage, value: serde_json::Value| Param { id, storage, value, caption: None, spec: None, group: None, from_type: true };
        if let Some(text) = type_raw.function.and_then(function_text)
            && !held.contains(&FUNCTION_PARAM)
            && !type_raw.params.iter().any(|p| p.id == FUNCTION_PARAM)
        {
            out.push(synthetic(FUNCTION_PARAM, Storage::Text, serde_json::Value::from(text)));
        }
        if !type_raw.layers.is_empty() {
            let thickness = match type_raw.class.as_str() {
                "BasicWallType" | "NewCurtainWallType" | "StackedWallType" => Some(-1001000), // WALL_ATTR_WIDTH_PARAM
                "FloorAttributes" => Some(-1001902),                                      // FLOOR_ATTR_DEFAULT_THICKNESS_PARAM
                "RoofAttributes" => Some(-1001600),                                       // ROOF_ATTR_DEFAULT_THICKNESS_PARAM
                "CompoundCeilingType" => Some(-1002206),                                  // CEILING_THICKNESS
                _ => None,
            };
            let total: f64 = type_raw.layers.iter().map(|layer| layer.width).sum();
            if let Some(id) = thickness
                && total > 0.0
                && !held.contains(&id)
                && !type_raw.params.iter().any(|p| p.id == id)
            {
                out.push(synthetic(id, Storage::Double, serde_json::Value::from(total)));
            }
        }
        out
    }

    /// Les couches d'un type, une ligne chacune : « Béton (0,2 m) ».
    pub fn layers_text(&self, layers: &[Layer]) -> Vec<String> {
        layers
            .iter()
            .map(|layer| {
                let material = self.name_of(layer.material).unwrap_or_else(|| "Sans matériau".to_string());
                format!("{material} ({} m)", super::json::round_significant(layer.width * FOOT, 6))
            })
            .collect()
    }

    /// Voir `properties::used_builtin_parameters`.
    pub fn used_builtin_parameters(&self, ids: &[u64]) -> std::collections::BTreeMap<i64, (usize, String, String)> {
        let mut out: std::collections::BTreeMap<i64, (usize, String, String)> = std::collections::BTreeMap::new();
        for id in ids {
            let Some(raw) = self.record(*id as i64) else { continue };
            let held: HashSet<i64> = raw.params.iter().map(|p| p.id).collect();
            let mut all: Vec<&Param> = raw.params.iter().collect();
            let synthetic;
            if let Some(type_raw) = self.type_of(raw) {
                all.extend(type_raw.params.iter().filter(|p| !held.contains(&p.id)));
                synthetic = self.type_structure_params(type_raw, &held);
                all.extend(synthetic.iter());
            }
            for p in all {
                if p.id < 0 {
                    let entry = out.entry(p.id).or_insert((0, format!("{:?}", p.storage), p.value.to_string()));
                    entry.0 += 1;
                    if matches!(entry.2.as_str(), "0" | "0.0" | "-1" | "false") {
                        entry.2 = p.value.to_string();
                    }
                }
            }
        }
        out
    }

    /// Voir `properties::double_parameters`.
    pub fn double_parameters(&self, ids: &[u64]) -> std::collections::BTreeMap<(i64, Option<String>), (usize, Spec)> {
        let mut out: std::collections::BTreeMap<(i64, Option<String>), (usize, Spec)> = std::collections::BTreeMap::new();
        for id in ids {
            let Some(raw) = self.record(*id as i64) else { continue };
            let held: HashSet<i64> = raw.params.iter().map(|p| p.id).collect();
            let mut all: Vec<&Param> = raw.params.iter().collect();
            let synthetic;
            if let Some(type_raw) = self.type_of(raw) {
                all.extend(type_raw.params.iter().filter(|p| !held.contains(&p.id) && !type_raw.instance_defaults.contains(&p.id)));
                synthetic = self.type_structure_params(type_raw, &held);
                all.extend(synthetic.iter());
            }
            for p in all {
                if p.storage == Storage::Double && !PLUMBING.contains(&p.id) && p.value.as_f64().is_some_and(|x| x.is_finite() && x.abs() < 1e20) {
                    out.entry((p.id, p.spec.clone())).or_insert((0, double_spec(p))).0 += 1;
                }
            }
        }
        out
    }

    fn parameter_name(&self, p: &Param) -> String {
        if let Some(caption) = &p.caption {
            return caption.clone();
        }
        match catalog::parameter(p.id) {
            Some(known) => known.label.to_string(),
            None => format!("Paramètre Revit {}", p.id),
        }
    }

    fn group_label(&self, p: &Param) -> String {
        let from_definition = p.group.as_deref().and_then(catalog::group_label);
        let from_catalog = catalog::parameter(p.id).and_then(|known| known.group).and_then(catalog::group_label);
        from_definition.or(from_catalog).unwrap_or(OTHER_GROUP).to_string()
    }

    /// Valeur d'un paramètre pour la fiche, avec le suffixe d'unité à poser sur son nom (« (m) »).
    /// `None` pour une valeur à ne pas montrer (vide, invalide).
    fn convert(&self, p: &Param) -> Option<(&'static str, Val)> {
        match p.storage {
            Storage::Text => {
                let text = p.value.as_str()?;
                (!text.trim().is_empty()).then(|| ("", Val::Text(text.to_string())))
            }
            Storage::Integer => {
                if let Some(b) = p.value.as_bool() {
                    return Some(("", Val::Bool(b)));
                }
                let n = p.value.as_i64()?;
                if p.id == FUNCTION_PARAM && p.caption.is_none() {
                    if let Some(text) = function_text(n) {
                        return Some(("", Val::Text(text.to_string())));
                    }
                }
                let yes_no = catalog::parameter(p.id).is_some_and(|known| known.quantity == Quantity::YesNo);
                Some(("", if yes_no && (n == 0 || n == 1) { Val::Bool(n == 1) } else { Val::Int(n) }))
            }
            Storage::Double => {
                let x = p.value.as_f64().filter(|x| x.is_finite() && x.abs() < 1e20)?;
                Some(match double_spec(p) {
                    Spec::Convert(unit) => (unit.suffix, Val::Num(unit.convert(x))),
                    // Sans dimension, ou grandeur dont l'unité interne n'est pas établie : le nombre du fichier,
                    // sans unité dans le nom (on ne le présente pas comme du SI).
                    Spec::Plain | Spec::Unknown => ("", Val::Num(x)),
                })
            }
            Storage::ElementId => {
                let id = p.value.as_i64()?;
                let name = self.target(id)?;
                Some(("", Val::Text(name)))
            }
        }
    }
}

/// La fonction d'un type (FUNCTION_PARAM, `WallFunction`) : intérieur, extérieur…
fn function_text(function: i64) -> Option<&'static str> {
    Some(match function {
        0 => "Intérieur",
        1 => "Extérieur",
        2 => "Fondation",
        3 => "Soutènement",
        4 => "Sous-face",
        5 => "Gaine technique",
        _ => return None,
    })
}

/// Ce que dit la spec d'un paramètre décimal : celle de sa définition dans le fichier (paramètres de famille,
/// partagés et de projet), à défaut la grandeur que le catalogue donne au paramètre intégré.
pub fn double_spec(p: &Param) -> Spec {
    match &p.spec {
        Some(spec) => units::of_spec(spec),
        None => match catalog::parameter(p.id).map_or(Quantity::Other, |known| known.quantity) {
            Quantity::Length => Spec::Convert(units::LENGTH),
            Quantity::Area => Spec::Convert(units::AREA),
            Quantity::Volume => Spec::Convert(units::VOLUME),
            Quantity::Angle => Spec::Convert(units::ANGLE),
            Quantity::Spec(kind) => units::of_kind(kind),
            Quantity::YesNo | Quantity::Other => Spec::Unknown,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn double(id: i64, spec: Option<&str>, value: f64) -> Param {
        Param { id, storage: Storage::Double, value: serde_json::Value::from(value), caption: None, spec: spec.map(str::to_string), group: None, from_type: false }
    }

    /// Ce que la fiche écrit pour ce paramètre : le suffixe du nom et le nombre.
    fn written(p: &Param) -> (&'static str, f64) {
        let collected = Collected::default();
        match Resolver::new(&collected).convert(p) {
            Some((unit, Val::Num(x))) => (unit, x),
            other => panic!("{other:?}"),
        }
    }

    fn close(found: f64, expected: f64) {
        assert!((found - expected).abs() <= expected.abs() * 1e-9, "{found} au lieu de {expected}");
    }

    /// Le libellé que la fiche donne à un élément selon le nom de son type.
    fn labelled(family: Option<&str>, type_name: Option<&str>) -> String {
        let collected = Collected::default();
        Resolver::new(&collected).label(&Raw::default(), None, family, type_name, 7)
    }

    #[test]
    fn un_type_nomme_par_un_tiret_n_est_pas_dans_le_libelle() {
        // RE1-Architecture : « Mur de base : - », « Sofa, 3-Seat-NON-COLLECTUS : - »…
        assert_eq!(labelled(Some("Mur de base"), Some("-")), "Mur de base");
        assert_eq!(labelled(Some("Sol"), Some("--")), "Sol");
        // Sans famille, le tiret ne remplace pas non plus la catégorie.
        assert_eq!(labelled(None, Some("-")), "Élément Revit 7");
        // Un vrai nom de type, même court ou ponctué, reste dans le libellé.
        assert_eq!(labelled(Some("Porte"), Some("60\" x 94\"")), "Porte : 60\" x 94\"");
        assert_eq!(labelled(Some("Porte"), Some("A-1")), "Porte : A-1");
        assert_eq!(labelled(None, Some("Single-Flush")), "Élément Revit : Single-Flush");
    }

    #[test]
    fn la_spec_du_fichier_donne_l_unite() {
        let (unit, x) = written(&double(1234567, Some("autodesk.spec.aec.hvac:airFlow-2.0.0"), 1.0));
        assert_eq!(unit, " (L/s)");
        close(x, 28.316846592);
        let (unit, x) = written(&double(1234568, Some("autodesk.spec.aec.electrical:potential-1.0.0"), 1291.6692500051666));
        assert_eq!(unit, " (V)");
        close(x, 120.0);
        let (unit, x) = written(&double(1234569, Some("autodesk.spec.aec.hvac:temperature-1.0.0"), 293.15));
        assert_eq!(unit, " (°C)");
        close(x, 20.0);
        // Les quatre d'avant restent ce qu'elles étaient.
        assert_eq!(written(&double(1234570, Some("autodesk.spec.aec:length-2.0.0"), 10.0)), (" (m)", 3.048));
        assert_eq!(written(&double(1234571, Some("autodesk.spec.aec:area-2.0.0"), 1.0)).0, " (m²)");
        assert_eq!(written(&double(1234572, Some("autodesk.spec.aec:volume-2.0.0"), 1.0)).0, " (m³)");
        assert_eq!(written(&double(1234573, Some("autodesk.spec.aec:angle-2.0.0"), std::f64::consts::PI)), (" (°)", 180.0));
    }

    #[test]
    fn un_integre_prend_la_grandeur_du_catalogue() {
        // ROOM_DESIGN_POWER_LOAD_PARAM : 100 W s'enregistrent 1076,391.
        let (unit, x) = written(&double(-1114229, None, 1076.391041670972));
        assert_eq!(unit, " (W)");
        close(x, 100.0);
        // Un débit d'air par surface n'est pas une surface (le mot AREA de son nom le faisait croire).
        let (unit, x) = written(&double(-1114812, None, 1.0));
        assert_eq!(unit, " (L/(s·m²))");
        close(x, 304.8);
        // Une longueur, comme avant.
        assert_eq!(written(&double(-1001108, None, 1.0)), (" (m)", 0.3048));
        // Un nombre connu pour sans dimension : celui du fichier, sans unité.
        assert_eq!(written(&double(-1114174, None, 0.5)), ("", 0.5));
    }

    #[test]
    fn une_grandeur_inconnue_reste_telle_quelle_sans_unite() {
        // Une conductivité thermique que le fichier déclare : l'unité interne n'est pas établie.
        assert_eq!(written(&double(1234580, Some("autodesk.spec.aec.energy:thermalConductivity-2.0.0"), 3.5)), ("", 3.5));
        // Un intégré que le catalogue ne classe pas (ANALYTICAL_HEAT_TRANSFER_COEFFICIENT).
        assert_eq!(written(&double(-1005430, None, 7.25)), ("", 7.25));
        // Un paramètre inconnu du catalogue, sans spec.
        assert_eq!(written(&double(-999999999, None, 2.0)), ("", 2.0));
        assert_eq!(double_spec(&double(-1005430, None, 7.25)), Spec::Unknown);
    }

    // ---------------------------------------------------------------------------------------------
    // La catégorie d'un élément que la table des classes ne range pas (voir `category_of`)
    // ---------------------------------------------------------------------------------------------

    use super::super::native::WallSweepInfo;
    use std::collections::BTreeMap;

    fn record(class: &str) -> Raw {
        Raw { class: class.to_string(), ..Raw::default() }
    }

    /// Un élément de classe `class` qui désigne `type_id` comme son type (le champ `m_typeId` que les fiches suivent).
    fn element(class: &str, type_id: Option<i64>) -> Raw {
        Raw { refs: type_id.map(|id| ("m_typeId".to_string(), id)).into_iter().collect(), ..record(class) }
    }

    /// Un type de classe `class`, nommé.
    fn type_record(class: &str, name: &str) -> Raw {
        Raw { is_type: true, name: Some(name.to_string()), ..record(class) }
    }

    /// Une `Family` de catégorie `category` (BuiltInCategory), sur place ou non, ou dont `m_inPlace` n'a pas été lu.
    fn family(category: i64, in_place: Option<bool>) -> Raw {
        Raw { category: Some(category), in_place, ..record("Family") }
    }

    /// Ce que la fiche de l'élément 100 dit de sa catégorie et de sa classe, avec ces enregistrements, ces propriétaires d'ElemTable
    /// (enregistrement → propriétaire) et cette famille de document.
    fn head_of(records: Vec<(i64, Raw)>, owners: &[(u64, i64)], document: Option<i64>) -> (Option<String>, bool) {
        let collected = Collected { records: records.into_iter().collect() };
        let owners: BTreeMap<u64, i64> = owners.iter().copied().collect();
        let resolver = Resolver::with_owners(&collected, move |id| owners.get(&id).copied(), document);
        let fiche = resolver.fiche(100, None);
        let text = |name: &str| fiche.head.iter().find(|(property, _)| *property == name).and_then(|(_, value)| if let Val::Text(text) = value { Some(text.clone()) } else { None });
        (text(CATEGORY), text(REVIT_CLASS).is_some())
    }

    /// La catégorie de l'élément 100, ou `None` (« Classe Revit » est alors écrite : l'essai le vérifie).
    fn category_of_100(records: Vec<(i64, Raw)>, owners: &[(u64, i64)], document: Option<i64>) -> Option<String> {
        let (category, with_class) = head_of(records, owners, document);
        assert_eq!(category.is_none(), with_class, "« Classe Revit » ne s'écrit que sans catégorie");
        category
    }

    const GENERIC_MODELS: i64 = -2000151;
    const STRUCTURAL_FRAMING: i64 = -2001320;
    const MASS: i64 = -2003400;

    #[test]
    fn une_forme_directe_prend_la_categorie_que_son_auteur_lui_a_donnee() {
        let shape = |category: Option<i64>| vec![(100, Raw { own_category: category, ..record("DirectShape") })];
        assert_eq!(category_of_100(shape(Some(-2000151)), &[], None).as_deref(), Some("Modèles génériques"));
        // Aucun filtre de nature : la valeur est celle du fichier.
        assert_eq!(category_of_100(shape(Some(-2000032)), &[], None).as_deref(), Some("Sols"));
        // -1 : le fichier ne dit rien ; un identifiant positif n'est pas une catégorie ; un négatif que le catalogue ne connaît pas non plus.
        assert_eq!(category_of_100(shape(Some(-1)), &[], None), None);
        assert_eq!(category_of_100(shape(Some(5)), &[], None), None);
        assert_eq!(category_of_100(shape(Some(-999_999_999)), &[], None), None);
        assert_eq!(category_of_100(shape(None), &[], None), None);
    }

    #[test]
    fn un_nez_de_dalle_un_bandeau_une_gouttiere_se_rangent_d_apres_la_classe_de_leur_type() {
        let host = |type_class: Option<&str>| {
            let mut records = vec![(100, element("SweepHost", type_class.map(|_| 200)))];
            if let Some(class) = type_class {
                records.push((200, type_record(class, "Slab Edge")));
            }
            records
        };
        assert_eq!(category_of_100(host(Some("EdgeSlabAttr")), &[], None).as_deref(), Some("Nez de dalle"));
        assert_eq!(category_of_100(host(Some("FasciaAttr")), &[], None).as_deref(), Some("Bandeaux"));
        assert_eq!(category_of_100(host(Some("GutterAttr")), &[], None).as_deref(), Some("Gouttières"));
        // Sans type, avec la classe de base (qui partage ses sous-classes) ou avec le type d'une autre classe : rien.
        assert_eq!(category_of_100(host(None), &[], None), None);
        assert_eq!(category_of_100(host(Some("SweepHostAttr")), &[], None), None);
        assert_eq!(category_of_100(host(Some("RoofAttributes")), &[], None), None);
    }

    #[test]
    fn un_nez_de_dalle_a_sa_famille_systeme_dans_son_libelle() {
        let collected = Collected { records: vec![(100, element("SweepHost", Some(200))), (200, type_record("EdgeSlabAttr", "Slab Edge"))].into_iter().collect() };
        let fiche = Resolver::new(&collected).fiche(100, None);
        assert_eq!(fiche.label, "Nez de dalle : Slab Edge");
        let head = |name: &str| fiche.head.iter().find(|(property, _)| *property == name).map(|(_, value)| format!("{value:?}"));
        assert!(head(FAMILY).is_some_and(|value| value.contains("Nez de dalle")), "{:?}", fiche.head);
        assert!(head(TYPE).is_some_and(|value| value.contains("Slab Edge")));
    }

    #[test]
    fn un_profile_integre_a_la_structure_d_un_mur_suit_le_mur_qui_le_possede() {
        let fixed = Some(WallSweepInfo { fixed: true, kind: 0 });
        let sweep = |info: Option<WallSweepInfo>| Raw { wall_sweep: info, ..record("WallSweep") };
        let with_owner = |owner: Raw| vec![(100, sweep(fixed)), (300, owner)];
        assert_eq!(category_of_100(with_owner(record("SWall")), &[(100, 300)], None).as_deref(), Some("Murs"));
        // Les autres classes de murs que les fiches rangent dans les murs.
        assert_eq!(category_of_100(with_owner(record("FaceWall")), &[(100, 300)], None).as_deref(), Some("Murs"));
        assert_eq!(category_of_100(with_owner(record("ArcWall")), &[(100, 300)], None).as_deref(), Some("Murs"));
        // Un propriétaire qui n'est pas un mur, un propriétaire dont l'enregistrement manque, ou inconnu de l'index : rien.
        assert_eq!(category_of_100(with_owner(record("Floor")), &[(100, 300)], None), None);
        assert_eq!(category_of_100(with_owner(family(GENERIC_MODELS, Some(true))), &[(100, 300)], None), None);
        assert_eq!(category_of_100(vec![(100, sweep(fixed))], &[(100, 300)], None), None);
        assert_eq!(category_of_100(with_owner(record("SWall")), &[], None), None);
        assert_eq!(category_of_100(with_owner(record("SWall")), &[(100, -1)], None), None);
        // Un profilé intégré a un type ? Ce n'est pas ce qu'on a mesuré : rien. Sans `m_wallSweepInfo` lisible non plus.
        let mut typed = with_owner(record("SWall"));
        typed[0].1.refs.push(("m_typeId".to_string(), 200));
        typed.push((200, type_record("CorniceAttr", "Corniche")));
        assert_eq!(category_of_100(typed, &[(100, 300)], None), None);
        assert_eq!(category_of_100(vec![(100, sweep(None)), (300, record("SWall"))], &[(100, 300)], None), None);
    }

    #[test]
    fn un_profile_autonome_se_range_d_apres_son_type_s_il_s_accorde_avec_sa_nature() {
        let standalone = |type_class: &str, kind: i64| {
            vec![(100, Raw { wall_sweep: Some(WallSweepInfo { fixed: false, kind }), ..element("WallSweep", Some(200)) }), (200, type_record(type_class, "Profilé"))]
        };
        assert_eq!(category_of_100(standalone("CorniceAttr", 0), &[], None).as_deref(), Some("Corniches"));
        assert_eq!(category_of_100(standalone("RevealAttr", 1), &[], None).as_deref(), Some("Feuillures"));
        // La classe du type et la nature ne s'accordent pas, ou la classe est celle de base : rien.
        assert_eq!(category_of_100(standalone("RevealAttr", 0), &[], None), None);
        assert_eq!(category_of_100(standalone("CorniceAttr", 1), &[], None), None);
        assert_eq!(category_of_100(standalone("WallSweepAttr", 0), &[], None), None);
        // Sans type : rien non plus.
        let untyped = vec![(100, Raw { wall_sweep: Some(WallSweepInfo { fixed: false, kind: 0 }), ..record("WallSweep") })];
        assert_eq!(category_of_100(untyped, &[], None), None);
    }

    /// Une forme (classe `class`) possédée par le propriétaire 300, avec ces enregistrements de plus et ces propriétaires de plus.
    fn form_with(class: &str, more: Vec<(i64, Raw)>, owners: &[(u64, i64)], document: Option<i64>) -> Option<String> {
        let mut records = vec![(100, record(class))];
        records.extend(more);
        let mut all = vec![(100, 300)];
        all.extend_from_slice(owners);
        category_of_100(records, &all, document)
    }

    #[test]
    fn une_forme_prend_la_categorie_de_sa_famille_sur_place_ou_du_document() {
        // Sur place (SampleModel « hood enclosure » : mobilier, mega et rac « Curved Beam » : ossature porteuse).
        assert_eq!(form_with("SweepElem", vec![(300, family(STRUCTURAL_FRAMING, Some(true)))], &[], Some(-1)).as_deref(), Some("Ossature porteuse"));
        // La famille que le document est (un .rfa) : ses formes sont la famille, `m_inPlace` faux.
        assert_eq!(form_with("BlendElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(300)).as_deref(), Some("Modèles génériques"));
        assert_eq!(form_with("RevolutionElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(300)).as_deref(), Some("Modèles génériques"));
        assert_eq!(form_with("SweptBlendElem", vec![(300, family(GENERIC_MODELS, Some(true)))], &[], Some(-1)).as_deref(), Some("Modèles génériques"));
        assert_eq!(form_with("FreeFormElement", vec![(300, family(GENERIC_MODELS, Some(true)))], &[], Some(-1)).as_deref(), Some("Modèles génériques"));
        // Une famille chargée (ni sur place ni celle du document) : sa forme n'est pas de ce modèle.
        assert_eq!(form_with("SweepElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(-1)), None);
        assert_eq!(form_with("SweepElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(999)), None);
        // `m_inPlace` illisible, et document inconnu : on ne sait pas.
        assert_eq!(form_with("SweepElem", vec![(300, family(GENERIC_MODELS, None))], &[], None), None);
        // Une famille sans catégorie lisible, ou d'une catégorie que le catalogue ne connaît pas.
        assert_eq!(form_with("SweepElem", vec![(300, Raw { category: None, ..family(0, Some(true)) })], &[], Some(-1)), None);
        assert_eq!(form_with("SweepElem", vec![(300, family(-999_999_999, Some(true)))], &[], Some(-1)), None);
    }

    #[test]
    fn la_remontee_des_proprietaires_d_une_forme_est_bornee_et_ne_devine_pas() {
        // Un enregistrement manque dans la chaîne : on ne sait pas si c'est une `Family`.
        assert_eq!(form_with("SweepElem", vec![], &[], Some(-1)), None);
        // Un groupe entre la forme et sa `Family` sur place : la première `Family` rencontrée.
        let chain = || vec![(300, record("ElementGroup")), (301, family(STRUCTURAL_FRAMING, Some(true)))];
        assert_eq!(form_with("SweepElem", chain(), &[(300, 301)], Some(-1)).as_deref(), Some("Ossature porteuse"));
        // Le propriétaire du groupe n'est pas connu de l'index, ou il n'y a pas de `Family` du tout : rien.
        assert_eq!(form_with("SweepElem", chain(), &[], Some(-1)), None);
        assert_eq!(form_with("SweepElem", chain(), &[(300, -1)], Some(-1)), None);
        // Deux éléments qui se possèdent l'un l'autre n'enferment pas la lecture : la chaîne s'arrête à la borne.
        let loop_ = vec![(300, record("ElementGroup")), (301, record("ElementGroup"))];
        assert_eq!(form_with("SweepElem", loop_, &[(300, 301), (301, 300)], Some(-1)), None);
        // Une `Family` au maillon `MAX_OWNER_CHAIN` est encore dans la borne, la suivante n'y est plus.
        let ladder = |links: i64| {
            let mut records: Vec<(i64, Raw)> = (0..links).map(|i| (300 + i, record("ElementGroup"))).collect();
            records.push((300 + links, family(STRUCTURAL_FRAMING, Some(true))));
            let owners: Vec<(u64, i64)> = (0..links).map(|i| ((300 + i) as u64, 301 + i)).collect();
            form_with("SweepElem", records, &owners, Some(-1))
        };
        assert!(ladder(families::MAX_OWNER_CHAIN as i64 - 1).is_some());
        assert!(ladder(families::MAX_OWNER_CHAIN as i64).is_none());
    }

    #[test]
    fn la_famille_d_une_forme_passe_avant_la_classe_pour_toutes_les_sous_classes_de_gensweep() {
        // ExtrusionElem → OST_GenericModel et FormElem → OST_Mass se trompaient : la famille dit autre chose.
        // Une extrusion d'une famille de masse sur place (mega et rac, éléments 139682 et 139763) : des masses.
        assert_eq!(form_with("ExtrusionElem", vec![(300, family(MASS, Some(true)))], &[], Some(-1)).as_deref(), Some("Masses"));
        // Une extrusion d'une famille de mobilier sur place (SampleModel, 506161 et 523524) ; de murs sur place (clockwork-wall, 180076).
        assert_eq!(form_with("ExtrusionElem", vec![(300, family(-2001100, Some(true)))], &[], Some(-1)).as_deref(), Some("Systèmes de mobilier"));
        assert_eq!(form_with("ExtrusionElem", vec![(300, family(-2000011, Some(true)))], &[], Some(-1)).as_deref(), Some("Murs"));
        // Une forme d'une famille de modèles génériques (AdaptivePanel.rfa) : des modèles génériques, non des masses.
        assert_eq!(form_with("FormElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(300)).as_deref(), Some("Modèles génériques"));
        // Une forme de masse d'une famille de masse reste une masse.
        assert_eq!(form_with("FormElem", vec![(300, family(MASS, Some(false)))], &[], Some(300)).as_deref(), Some("Masses"));
        // Le vide de void-cutter-2012.rfa (famille de modèles génériques, comme la table) garde sa catégorie.
        assert_eq!(form_with("ExtrusionElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(300)).as_deref(), Some("Modèles génériques"));
        // Sans famille lisible, la classe reste ce qu'elle était : ExtrusionElem des modèles génériques, FormElem des masses.
        assert_eq!(form_with("ExtrusionElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(-1)).as_deref(), Some("Modèles génériques"));
        assert_eq!(form_with("FormElem", vec![(300, family(GENERIC_MODELS, Some(false)))], &[], Some(-1)).as_deref(), Some("Masses"));
        assert_eq!(form_with("ExtrusionElem", vec![], &[], Some(-1)).as_deref(), Some("Modèles génériques"));
        assert_eq!(form_with("FormElem", vec![], &[], None).as_deref(), Some("Masses"));
    }

    #[test]
    fn la_famille_de_l_element_et_les_classes_gardent_leur_place() {
        // Une instance de famille garde la catégorie de la famille de son type, avant tout.
        let door = vec![(100, element("FamilyInstance", Some(200))), (200, Raw { family: Some(201), ..type_record("FamilySymbol", "0915 x 2134mm") }), (201, family(-2000023, Some(false)))];
        assert_eq!(category_of_100(door, &[(100, 300)], Some(-1)).as_deref(), Some("Portes"));
        // Une toiture par tracé possédée par une famille sur place de modèles génériques (hangar 198779, 199509) reste une toiture : la
        // règle des familles ne vaut que pour les formes.
        let roof = vec![(100, record("ProfileRoof")), (300, family(GENERIC_MODELS, Some(true)))];
        assert_eq!(category_of_100(roof, &[(100, 300)], Some(-1)).as_deref(), Some("Toitures"));
        // La table des classes des fiches : les 8 classes de la spec.
        for (class, label) in [("ProfileRoof", "Toitures"), ("FaceRoof", "Toitures"), ("ContFooting", "Fondations porteuses"), ("MassLevelData", "Sols de masse"), ("Stairs", "Escaliers"), ("FaceWall", "Murs"), ("ArcWall", "Murs"), ("CurtaSystem", "Systèmes de mur-rideau")] {
            assert_eq!(category_of_100(vec![(100, record(class))], &[], None).as_deref(), Some(label), "{class}");
        }
        // Une classe sans règle reste sans catégorie (« Classe Revit » est alors écrite).
        assert_eq!(category_of_100(vec![(100, record("FamilyInstance"))], &[], None), None);
        // La surface divisée : le propriétaire (la famille de masse) dit « Masses », mais ses graphiques sont tous des sous-catégories
        // d'OST_DividedSurface ; c'est la catégorie que Revit a pour elle (`FICHE_CLASS_CATEGORIES`).
        let divided = vec![(100, record("DividedSurface")), (300, family(MASS, Some(false)))];
        assert_eq!(category_of_100(divided, &[(100, 300)], Some(300)).as_deref(), Some("Surface divisée"));
        assert_eq!(category_of_100(vec![(100, record("DividedSurface"))], &[], None).as_deref(), Some("Surface divisée"));
    }

    #[test]
    fn une_dalle_de_fondation_est_une_fondation_porteuse() {
        // `FloorAttributes.m_footingType` : 1 pour « 150mm Foundation Slab », 0 pour les 177 autres sols mesurés.
        let floor = |footing: Option<i64>, type_class: &str| vec![(100, element("Floor", Some(200))), (200, Raw { footing_type: footing, ..type_record(type_class, "150mm Foundation Slab") })];
        assert_eq!(category_of_100(floor(Some(1), "FloorAttributes"), &[], None).as_deref(), Some("Fondations porteuses"));
        assert_eq!(category_of_100(floor(Some(0), "FloorAttributes"), &[], None).as_deref(), Some("Sols"));
        // Une valeur que l'on n'a pas mesurée, ou absente : un sol.
        assert_eq!(category_of_100(floor(Some(2), "FloorAttributes"), &[], None).as_deref(), Some("Sols"));
        assert_eq!(category_of_100(floor(None, "FloorAttributes"), &[], None).as_deref(), Some("Sols"));
        // Le drapeau d'un type d'une autre classe ne dit rien du sol ; un sol sans type lisible reste un sol.
        assert_eq!(category_of_100(floor(Some(1), "CompoundCeilingType"), &[], None).as_deref(), Some("Sols"));
        assert_eq!(category_of_100(vec![(100, element("Floor", None))], &[], None).as_deref(), Some("Sols"));
        // Une dalle de fondation reste nommée « Sol : type » (famille système des types de sol).
        let collected = Collected { records: floor(Some(1), "FloorAttributes").into_iter().collect() };
        assert_eq!(Resolver::new(&collected).fiche(100, None).label, "Sol : 150mm Foundation Slab");
    }

    // ---------------------------------------------------------------------------------------------
    // La famille, le type et le libellé que Revit montre (voir `naming`, `type_of` et `label`)
    // ---------------------------------------------------------------------------------------------

    /// La fiche de l'élément `id` avec ces enregistrements, ces propriétaires d'ElemTable et cette famille de document ; le nom que
    /// l'élément a quand un autre le désigne (`name_of`, celui d'un hôte) est celui de sa fiche.
    fn fiche_of(id: i64, records: Vec<(i64, Raw)>, owners: &[(u64, i64)], document: Option<i64>) -> Fiche {
        let collected = Collected { records: records.into_iter().collect() };
        let owners: BTreeMap<u64, i64> = owners.iter().copied().collect();
        let resolver = Resolver::with_owners(&collected, move |id| owners.get(&id).copied(), document);
        let fiche = resolver.fiche(id, None);
        assert_eq!(resolver.name_of(id).as_deref(), Some(fiche.label.as_str()), "le nom de l'hôte et le libellé de la fiche s'accordent");
        fiche
    }

    fn head_text(fiche: &Fiche, name: &str) -> Option<String> {
        fiche.head.iter().find(|(property, _)| *property == name).and_then(|(_, value)| if let Val::Text(text) = value { Some(text.clone()) } else { None })
    }

    /// (Famille, Type, libellé) de l'élément 100.
    fn naming_of_100(records: Vec<(i64, Raw)>, owners: &[(u64, i64)], document: Option<i64>) -> (Option<String>, Option<String>, String) {
        let fiche = fiche_of(100, records, owners, document);
        (head_text(&fiche, FAMILY), head_text(&fiche, TYPE), fiche.label.clone())
    }

    fn some(text: &str) -> Option<String> {
        Some(text.to_string())
    }

    /// Les `n` premiers enregistrements : les suivants manquent.
    fn first(mut records: Vec<(i64, Raw)>, n: usize) -> Vec<(i64, Raw)> {
        records.truncate(n);
        records
    }

    /// Un élément de classe `class` dont les champs désignent ces enregistrements : (nom du champ, identifiant).
    fn element_with(class: &str, refs: &[(&str, i64)]) -> Raw {
        Raw { refs: refs.iter().map(|(field, id)| (field.to_string(), *id)).collect(), ..record(class) }
    }

    #[test]
    fn un_garde_corps_a_la_famille_systeme_de_son_type() {
        // BaseRailing : le type est `m_stairsRailingAttrId` (`StairsRailingAttr`), non `m_baseRailingSymbolId`, un `BaseRailingSym` sans nom.
        let railing = |type_name: &str| {
            vec![
                (100, element_with("BaseRailing", &[("m_baseRailingSymbolId", 201), ("m_stairsRailingAttrId", 200)])),
                (200, type_record("StairsRailingAttr", type_name)),
                (201, Raw { is_type: true, ..record("BaseRailingSym") }),
            ]
        };
        assert_eq!(naming_of_100(railing("SH_1100mm"), &[], None), (some("Garde-corps"), some("SH_1100mm"), "Garde-corps : SH_1100mm".to_string()));
        // RE1-Architecture : « Railing:- » dans l'export IFC de Revit, la famille et un type nommé « - » ; le libellé s'en passe.
        assert_eq!(naming_of_100(railing("-"), &[], None), (some("Garde-corps"), some("-"), "Garde-corps".to_string()));
        // Une classe de type d'un autre nom n'est pas une famille système connue.
        let other = vec![(100, element_with("BaseRailing", &[("m_stairsRailingAttrId", 200)])), (200, type_record("RailingAttrBis", "SH_1100mm"))];
        assert_eq!(naming_of_100(other, &[], None).0, None);
    }

    #[test]
    fn une_lisse_haute_prend_son_type_et_non_son_symbole_interne() {
        // DynamoSample : `m_symbolId` désigne un `ContinuousRailSymbol` propre à la lisse (nommé « 1 », « 3 »…), `m_typeId` son `TopRailType`.
        let top_rail = |symbol_is_type: bool, type_id_is_type: bool| {
            vec![
                (100, element_with("TopRail", &[("m_symbolId", 201), ("m_typeId", 200)])),
                (200, Raw { is_type: type_id_is_type, name: some("Rectangular - 50x50mm"), ..record("TopRailType") }),
                (201, Raw { is_type: symbol_is_type, name: some(" 1"), ..record("ContinuousRailSymbol") }),
            ]
        };
        assert_eq!(naming_of_100(top_rail(true, true), &[], None), (some("Lisse haute"), some("Rectangular - 50x50mm"), "Lisse haute : Rectangular - 50x50mm".to_string()));
        // Un `m_typeId` qui ne désigne pas un enregistrement de type n'est pas pris : le balayage reste ce qu'il était (le symbole nommé).
        assert_eq!(naming_of_100(top_rail(true, false), &[], None), (None, some(" 1"), "Lisses hautes de garde-corps :  1".to_string()));
        // Ni un enregistrement qui manque.
        let missing = vec![(100, element_with("TopRail", &[("m_symbolId", 201), ("m_typeId", 999)])), (201, Raw { is_type: true, name: some(" 1"), ..record("ContinuousRailSymbol") })];
        assert_eq!(naming_of_100(missing, &[], None).1, some(" 1"));
        // `m_masterSymbolId` passe avant `m_typeId` (une instance de famille) ; s'il ne désigne pas un type, `m_typeId` prend la suite.
        let both = |master_is_type: bool| {
            vec![
                (100, element_with("FamilyInstance", &[("m_typeId", 200), ("m_masterSymbolId", 201)])),
                (200, type_record("FamilySymbol", "Par m_typeId")),
                (201, Raw { is_type: master_is_type, name: some("Par le maître"), ..record("FamilySymbol") }),
            ]
        };
        assert_eq!(naming_of_100(both(true), &[], None).1, some("Par le maître"));
        assert_eq!(naming_of_100(both(false), &[], None).1, some("Par m_typeId"));
        // Sans `m_masterSymbolId` ni `m_typeId` : le balayage, un type nommé d'abord.
        let scan = vec![(100, element_with("Floor", &[("m_aId", 201), ("m_bId", 200)])), (200, type_record("FloorAttributes", "Nommé")), (201, Raw { is_type: true, ..record("FamilySymbol") })];
        assert_eq!(naming_of_100(scan, &[], None).1, some("Nommé"));
    }

    #[test]
    fn une_gaine_et_un_tuyau_ont_leur_type() {
        // `m_idType` : `AbsDuctType` « Mitered Elbows / Tees » (DuctSegmentFlow), `RbsPipeType` « Standard » (ConnectorTestR20).
        let run = |class: &str, type_class: &str, type_name: &str| vec![(100, element_with(class, &[("m_idType", 200)])), (200, type_record(type_class, type_name))];
        assert_eq!(naming_of_100(run("RbsDuctCurve", "AbsDuctType", "Mitered Elbows / Tees"), &[], None), (some("Gaine"), some("Mitered Elbows / Tees"), "Gaine : Mitered Elbows / Tees".to_string()));
        assert_eq!(naming_of_100(run("RbsPipeCurve", "RbsPipeType", "Standard"), &[], None), (some("Tuyau"), some("Standard"), "Tuyau : Standard".to_string()));
    }

    /// Un mur de type `BasicWallType` « Generic - 200mm » (id 300, type 301, qui porte une épaisseur) et un profilé de mur `fixed` (id 100).
    fn sweep_and_wall(fixed: bool, wall: Raw) -> Vec<(i64, Raw)> {
        let sweep = Raw { wall_sweep: Some(WallSweepInfo { fixed, kind: 0 }), ..record("WallSweep") };
        vec![(100, sweep), (300, wall), (301, Raw { params: vec![double(-1001000, None, 0.5)], ..type_record("BasicWallType", "Generic - 200mm") })]
    }

    #[test]
    fn un_profile_integre_prend_la_famille_et_le_type_de_son_mur() {
        let wall = || element("SWall", Some(301));
        // Famille système et type du mur ; le libellé est celui du mur.
        let found = naming_of_100(sweep_and_wall(true, wall()), &[(100, 300)], None);
        assert_eq!(found, (some("Mur de base"), some("Generic - 200mm"), "Mur de base : Generic - 200mm".to_string()));
        // Une famille chargée : son nom (un mur-rideau, un mur d'une autre famille).
        let mut loaded = sweep_and_wall(true, wall());
        loaded[2].1.family = Some(302);
        loaded.push((302, Raw { name: some("Mur spécial"), ..record("Family") }));
        assert_eq!(naming_of_100(loaded, &[(100, 300)], None), (some("Mur spécial"), some("Generic - 200mm"), "Mur spécial : Generic - 200mm".to_string()));
        // Les paramètres du type du mur ne se joignent pas à la fiche du profilé (ils sont ceux de la fiche du mur).
        let sweep_fiche = fiche_of(100, sweep_and_wall(true, wall()), &[(100, 300)], None);
        assert!(sweep_fiche.groups.is_empty(), "{:?}", sweep_fiche.groups);
        let wall_fiche = fiche_of(300, sweep_and_wall(true, wall()), &[(100, 300)], None);
        assert!(!wall_fiche.groups.is_empty());
        // La catégorie est toujours celle du mur.
        assert_eq!(head_text(&sweep_fiche, CATEGORY), some("Murs"));
    }

    #[test]
    fn un_profile_integre_dont_le_proprietaire_n_est_pas_un_mur_ne_prend_rien() {
        let owned_by = |owner: Raw| naming_of_100(sweep_and_wall(true, owner), &[(100, 300)], None);
        // Un sol, une famille : ni famille, ni type, et le libellé est celui d'avant (catégorie inconnue : « Élément Revit »).
        for owner in [element("Floor", Some(301)), family(GENERIC_MODELS, Some(true)), element("FamilyInstance", Some(301))] {
            assert_eq!(owned_by(owner), (None, None, "Élément Revit 100".to_string()));
        }
        // Un mur sans type lisible : rien à reprendre, le libellé reste la catégorie et l'identifiant.
        assert_eq!(owned_by(record("SWall")), (None, None, "Murs 100".to_string()));
        // Un propriétaire que l'index ne connaît pas, ou dont l'enregistrement manque.
        assert_eq!(naming_of_100(sweep_and_wall(true, element("SWall", Some(301))), &[], None), (None, None, "Élément Revit 100".to_string()));
        assert_eq!(naming_of_100(first(sweep_and_wall(true, element("SWall", Some(301))), 1), &[(100, 300)], None), (None, None, "Élément Revit 100".to_string()));
        // Un profilé qui n'est pas intégré à la structure, sans type : rien non plus.
        assert_eq!(naming_of_100(sweep_and_wall(false, element("SWall", Some(301))), &[(100, 300)], None), (None, None, "Élément Revit 100".to_string()));
        // Un profilé intégré qui aurait un type garde le sien.
        let mut typed = sweep_and_wall(true, element("SWall", Some(301)));
        typed[0].1.refs.push(("m_typeId".to_string(), 302));
        typed.push((302, type_record("CorniceAttr", "Corniche")));
        assert_eq!(naming_of_100(typed, &[(100, 300)], None).1, some("Corniche"));
    }

    /// Une forme (100) d'une `Family` (300, sur place) possédée par un symbole (301) : ce que le fichier enregistre pour les formes d'une
    /// famille sur place (rac 139682 : forme → `Family` « Main Building » → `FamilySymbol` → `FamilyInstance`).
    fn in_place_form(class: &str) -> Vec<(i64, Raw)> {
        vec![
            (100, record(class)),
            (300, Raw { name: some("Main Building"), ..family(MASS, Some(true)) }),
            (301, Raw { family: Some(300), ..type_record("FamilySymbol", "Main Building 2") }),
        ]
    }

    #[test]
    fn une_forme_sur_place_prend_la_famille_et_le_symbole_qui_la_possedent() {
        let owners = [(100, 300), (300, 301), (301, 302)];
        for class in ["ExtrusionElem", "BlendElem", "SweepElem", "SweptBlendElem", "RevolutionElem", "FormElem", "FreeFormElement"] {
            let found = naming_of_100(in_place_form(class), &owners, Some(-1));
            assert_eq!(found, (some("Main Building"), some("Main Building 2"), "Main Building : Main Building 2".to_string()), "{class}");
        }
        // La catégorie est toujours celle de la famille ; pas de « Classe Revit ».
        assert_eq!(category_of_100(in_place_form("ExtrusionElem"), &owners, Some(-1)).as_deref(), Some("Masses"));
        // Une forme sur place n'a pas de type de famille : la fiche n'en joint pas les paramètres.
        let mut with_params = in_place_form("ExtrusionElem");
        with_params[2].1.params.push(double(-1001000, None, 0.5));
        assert!(fiche_of(100, with_params, &owners, Some(-1)).groups.is_empty());
    }

    #[test]
    fn une_forme_sur_place_sans_symbole_valide_n_a_pas_de_type() {
        // Le propriétaire de la `Family` n'est pas son symbole : famille seule, et le libellé est la famille.
        let family_only = (some("Main Building"), None, "Main Building".to_string());
        let with_owner = |owner: Raw| {
            let mut records = in_place_form("ExtrusionElem");
            records[2].1 = owner;
            naming_of_100(records, &[(100, 300), (300, 301)], Some(-1))
        };
        // Un symbole d'une autre famille.
        assert_eq!(with_owner(Raw { family: Some(999), ..type_record("FamilySymbol", "Autre") }), family_only);
        // Un symbole sans famille lisible.
        assert_eq!(with_owner(type_record("FamilySymbol", "Sans famille")), family_only);
        // Un enregistrement qui n'est pas un type (pas de `SymbolInfo`), ou qui n'est pas un `FamilySymbol`.
        assert_eq!(with_owner(Raw { family: Some(300), is_type: false, ..record("FamilySymbol") }), family_only);
        assert_eq!(with_owner(Raw { family: Some(300), ..type_record("FamilyInstance", "Instance") }), family_only);
        // Un symbole sans nom : pas de type à écrire.
        assert_eq!(with_owner(Raw { family: Some(300), is_type: true, ..record("FamilySymbol") }), family_only);
        // Un propriétaire dont l'enregistrement manque, ou que l'index ne connaît pas.
        assert_eq!(naming_of_100(first(in_place_form("ExtrusionElem"), 2), &[(100, 300), (300, 301)], Some(-1)), family_only);
        assert_eq!(naming_of_100(in_place_form("ExtrusionElem"), &[(100, 300)], Some(-1)), family_only);
        // Une famille sur place sans nom lisible : on ne nomme rien (la catégorie reste celle de la famille).
        let mut unnamed = in_place_form("ExtrusionElem");
        unnamed[1].1.name = None;
        assert_eq!(naming_of_100(unnamed, &[(100, 300), (300, 301)], Some(-1)), (None, None, "Masses 100".to_string()));
    }

    #[test]
    fn une_forme_d_une_famille_chargee_ou_inconnue_garde_ses_noms() {
        let owners = [(100, 300), (300, 301)];
        // Ni sur place ni celle du document : sa forme n'est pas de ce modèle (aucun nom, la catégorie de la classe).
        let mut loaded = in_place_form("ExtrusionElem");
        loaded[1].1.in_place = Some(false);
        assert_eq!(naming_of_100(loaded, &owners, Some(-1)), (None, None, "Modèles génériques 100".to_string()));
        // `m_inPlace` illisible : on ne sait pas.
        let mut unread = in_place_form("ExtrusionElem");
        unread[1].1.in_place = None;
        assert_eq!(naming_of_100(unread, &owners, Some(-1)), (None, None, "Modèles génériques 100".to_string()));
        // Une forme qui a un type l'emporte sur la règle des familles sur place.
        let mut typed = in_place_form("ExtrusionElem");
        typed[0].1.refs.push(("m_typeId".to_string(), 302));
        typed.push((302, type_record("FamilySymbol", "Son type")));
        assert_eq!(naming_of_100(typed, &owners, Some(-1)).1, some("Son type"));
        // Une classe qui n'est pas une forme de famille, possédée par la même `Family`, ne prend pas ses noms (une toiture par tracé).
        assert_eq!(naming_of_100(in_place_form("ProfileRoof"), &owners, Some(-1)), (None, None, "Toitures 100".to_string()));
    }

    #[test]
    fn une_forme_de_la_famille_du_document_est_nommee_par_sa_sorte() {
        // Dans un `.rfa`, la forme n'a ni famille ni type : sa sorte et son identifiant (FamilyDocumentTests, AdaptivePanel, setout-point…).
        let in_document = |class: &str| vec![(100, record(class)), (300, Raw { name: None, ..family(GENERIC_MODELS, Some(false)) })];
        for (class, label) in [
            ("ExtrusionElem", "Extrusion 100"),
            ("BlendElem", "Raccordement 100"),
            ("SweepElem", "Balayage 100"),
            ("SweptBlendElem", "Raccordement par balayage 100"),
            ("RevolutionElem", "Révolution 100"),
            ("FormElem", "Forme 100"),
            ("FreeFormElement", "Forme libre 100"),
        ] {
            assert_eq!(naming_of_100(in_document(class), &[(100, 300)], Some(300)), (None, None, label.to_string()), "{class}");
        }
        // Même avec un nom de famille lisible : Revit ne montre ni famille ni type pour la forme de la famille éditée.
        let mut named = in_document("ExtrusionElem");
        named[1].1.name = some("Chaise");
        assert_eq!(naming_of_100(named, &[(100, 300)], Some(300)), (None, None, "Extrusion 100".to_string()));
        // Une forme dont le propriétaire est inconnu, ou d'une famille qui n'est pas celle du document, garde « catégorie identifiant ».
        assert_eq!(naming_of_100(in_document("ExtrusionElem"), &[], Some(300)).2, "Modèles génériques 100");
        assert_eq!(naming_of_100(in_document("ExtrusionElem"), &[(100, 300)], Some(999)).2, "Modèles génériques 100");
        assert_eq!(naming_of_100(in_document("ExtrusionElem"), &[(100, 300)], None).2, "Modèles génériques 100");
        // Une classe qui n'est pas une forme de famille, possédée par la famille du document, n'a pas de sorte.
        assert_eq!(naming_of_100(in_document("ProfileRoof"), &[(100, 300)], Some(300)).2, "Toitures 100");
    }

    #[test]
    fn une_surface_divisee_a_sa_categorie_et_son_libelle() {
        // dynamo-tower-6-ds-2013 : 5 surfaces divisées, le propriétaire est la famille de masse du document.
        let divided = vec![(100, record("DividedSurface")), (300, Raw { name: None, ..family(MASS, Some(false)) })];
        let fiche = fiche_of(100, divided, &[(100, 300)], Some(300));
        assert_eq!((head_text(&fiche, CATEGORY), head_text(&fiche, FAMILY), head_text(&fiche, TYPE)), (some("Surface divisée"), None, None));
        assert_eq!(fiche.label, "Surface divisée 100");
        assert!(head_text(&fiche, REVIT_CLASS).is_none());
    }

    #[test]
    fn une_famille_sans_type_est_nommee_par_la_famille_seule() {
        assert_eq!(labelled(Some("Chaise"), None), "Chaise");
        // Rien ne change pour les autres cas : le tiret, le vrai type, la catégorie.
        assert_eq!(labelled(Some("Chaise"), Some("-")), "Chaise");
        assert_eq!(labelled(Some("Chaise"), Some("Bois")), "Chaise : Bois");
        assert_eq!(labelled(None, None), "Élément Revit 7");
    }

    /// Un import CAD (`ImportInstance`) : son libellé est le nom du fichier importé (le nom de son symbole d'import), sa catégorie celle que le
    /// fichier donne au symbole : l'élément `CategoryElem` de ce nom (wadduwa : « MAN-GF.dwg »), ou une catégorie de Revit (`SiteModel.dwg` de
    /// dynamo-nyc-site-2013 : « Styles d'objet d'importation », -2000196). Sans symbole lisible, l'import garde le libellé d'un élément sans type.
    #[test]
    fn un_import_cad_est_nomme_par_son_fichier_et_range_dans_sa_categorie() {
        let symbol = |name: Option<&str>, category: Option<i64>| Raw { is_type: true, name: name.map(str::to_string), import_category: category, ..record("MasterImportSymbol") };
        let import = || Raw { refs: vec![("m_symbolId".to_string(), 200), ("m_assocLevelId".to_string(), 300)], ..record("ImportInstance") };
        let level = || Raw { name: Some("Niveau 1".to_string()), ..record("Level") };
        // La catégorie est un élément (`CategoryElem`) qui porte le nom du fichier.
        let named = |category_name: &str| vec![(100, import()), (200, symbol(Some("MAN-GF.dwg"), Some(500))), (300, level()), (500, Raw { name: Some(category_name.to_string()), ..record("CategoryElem") })];
        let fiche = fiche_of(100, named("MAN-GF.dwg"), &[], None);
        assert_eq!(fiche.label, "MAN-GF.dwg");
        assert_eq!((head_text(&fiche, CATEGORY), head_text(&fiche, TYPE), head_text(&fiche, LEVEL)), (some("MAN-GF.dwg"), some("MAN-GF.dwg"), some("Niveau 1")));
        assert!(head_text(&fiche, REVIT_CLASS).is_none(), "une catégorie d'import range l'élément : pas de « Classe Revit »");
        // La catégorie est celle de Revit (identifiant négatif).
        let builtin = fiche_of(100, vec![(100, import()), (200, symbol(Some("SiteModel.dwg"), Some(-2000196)))], &[], None);
        assert_eq!((builtin.label.as_str(), head_text(&builtin, CATEGORY)), ("SiteModel.dwg", some("Styles d'objet d'importation")));
        // Une catégorie dont l'élément ne se lit pas : l'import reste nommé par son fichier, sans catégorie (et « Classe Revit » s'écrit).
        let unread = fiche_of(100, vec![(100, import()), (200, symbol(Some("MAN-GF.dwg"), Some(500)))], &[], None);
        assert_eq!((unread.label.as_str(), head_text(&unread, CATEGORY), head_text(&unread, REVIT_CLASS)), ("MAN-GF.dwg", None, some("ImportInstance")));
        // Un symbole sans nom, ou pas un symbole d'import : le libellé d'un élément sans type.
        let nameless = fiche_of(100, vec![(100, import()), (200, symbol(None, Some(500)))], &[], None);
        assert_eq!(nameless.label, "Élément Revit 100");
        let other = fiche_of(100, vec![(100, import()), (200, Raw { is_type: true, name: Some("Autre".to_string()), ..record("FamilySymbol") })], &[], None);
        assert_eq!(other.label, "Élément Revit : Autre");
    }
}
