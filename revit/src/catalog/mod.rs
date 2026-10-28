//! Catalogue de Revit : les paramètres intégrés (identifiant numérique, nom, libellé français, nature de
//! la valeur, groupe), les groupes de paramètres et les catégories.
//!
//! Les tables sont des fichiers TSV générés par `scripts/gen-revit-catalog.mjs` à partir de
//! Rhino.Inside.Revit (licence MIT, voir `revit/THIRD_PARTY.md`) ; les libellés français sont écrits
//! pour ce projet. Elles sont lues une seule fois, à la première demande.

pub mod unit_types;
pub mod units;

use std::collections::HashMap;
use std::sync::OnceLock;

const PARAMETERS: &str = include_str!("parameters.tsv");
const GROUPS: &str = include_str!("groups.tsv");
const CATEGORIES: &str = include_str!("categories.tsv");

/// Ce que mesure une valeur décimale, dans l'unité interne de Revit (pieds, radians).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quantity {
    /// Longueur : pieds → mètres.
    Length,
    /// Surface : pieds carrés → mètres carrés.
    Area,
    /// Volume : pieds cubes → mètres cubes.
    Volume,
    /// Angle : radians → degrés.
    Angle,
    /// Entier valant 0 ou 1 : oui / non.
    YesNo,
    /// Une grandeur de Revit désignée par la nature de sa spec (« airFlow », « power »…), dont `units`
    /// donne la conversion. Le catalogue n'en nomme que pour les paramètres intégrés dont la grandeur est
    /// certaine (`source/specs.tsv`) : le fichier n'enregistre de spec que pour les paramètres de famille,
    /// partagés et de projet.
    Spec(&'static str),
    /// Autre chose (ou inconnu) : le nombre tel quel.
    Other,
}

/// Un paramètre intégré de Revit.
#[derive(Debug)]
pub struct Parameter {
    pub id: i64,
    /// Nom d'énumération de Revit (WALL_BASE_OFFSET).
    pub name: &'static str,
    /// Libellé français.
    pub label: &'static str,
    pub quantity: Quantity,
    /// Groupe, sous la forme « autodesk.parameter.group:constraints » (sans version).
    pub group: Option<&'static str>,
    /// Libellé écrit à la main (sinon, rendu automatique de l'identifiant).
    pub manual: bool,
}

/// Une catégorie de Revit.
#[derive(Debug)]
pub struct Category {
    pub id: i64,
    /// Nom d'énumération (OST_Walls).
    pub ost: &'static str,
    pub label: &'static str,
    /// M modèle, A annotation, I interne, N analytique.
    pub kind: char,
}

struct Tables {
    parameters: HashMap<i64, Parameter>,
    groups: HashMap<&'static str, &'static str>,
    categories: HashMap<i64, Category>,
    by_ost: HashMap<&'static str, i64>,
}

fn rows(text: &'static str) -> impl Iterator<Item = Vec<&'static str>> {
    text.lines().filter(|line| !line.is_empty() && !line.starts_with('#')).map(|line| line.split('\t').collect())
}

/// Un code d'une lettre (L, A, V, R, B), « - » pour inconnu, ou la nature d'une spec (« airFlow »).
fn quantity(code: &'static str) -> Quantity {
    match code {
        "L" => Quantity::Length,
        "A" => Quantity::Area,
        "V" => Quantity::Volume,
        "R" => Quantity::Angle,
        "B" => Quantity::YesNo,
        "-" | "" => Quantity::Other,
        kind => Quantity::Spec(kind),
    }
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        // id, nom, ForgeTypeId, années, nature, groupe, libellé, origine
        let parameters = rows(PARAMETERS)
            .filter_map(|row| {
                let id = row.first()?.parse().ok()?;
                Some((
                    id,
                    Parameter {
                        id,
                        name: row.get(1)?,
                        label: row.get(6)?,
                        quantity: quantity(row.get(4)?),
                        group: row.get(5).copied().filter(|group| *group != "-"),
                        manual: row.get(7) == Some(&"m"),
                    },
                ))
            })
            .collect();
        // clé ForgeTypeId sans version, id, nom d'énumération, libellé, origine
        let groups = rows(GROUPS).filter_map(|row| Some((*row.first()?, *row.get(3)?))).collect();
        // id, nom OST_, libellé, genre, années, origine
        let mut by_ost = HashMap::new();
        let categories = rows(CATEGORIES)
            .filter_map(|row| {
                let id: i64 = row.first()?.parse().ok()?;
                let ost: &'static str = row.get(1)?;
                by_ost.insert(ost, id);
                Some((id, Category { id, ost, label: row.get(2)?, kind: row.get(3)?.chars().next()? }))
            })
            .collect();
        Tables { parameters, groups, categories, by_ost }
    })
}

/// Le paramètre intégré d'identifiant `id` (négatif), s'il est au catalogue.
pub fn parameter(id: i64) -> Option<&'static Parameter> {
    tables().parameters.get(&id)
}

/// Le libellé d'un groupe de paramètres, d'après son ForgeTypeId (avec ou sans version :
/// « autodesk.parameter.group:constraints-1.0.0 »).
pub fn group_label(forge_id: &str) -> Option<&'static str> {
    tables().groups.get(strip_version(forge_id)).copied()
}

/// « autodesk.parameter.group:constraints-1.0.0 » → « autodesk.parameter.group:constraints ».
pub fn strip_version(forge_id: &str) -> &str {
    match forge_id.rfind('-') {
        Some(dash) if forge_id[dash + 1..].chars().all(|c| c.is_ascii_digit() || c == '.') && dash + 1 < forge_id.len() => &forge_id[..dash],
        _ => forge_id,
    }
}

/// La catégorie d'identifiant `id` (négatif, BuiltInCategory).
pub fn category(id: i64) -> Option<&'static Category> {
    tables().categories.get(&id)
}

/// La catégorie de nom d'énumération `ost` (« OST_Walls »).
pub fn category_by_ost(ost: &str) -> Option<&'static Category> {
    let tables = tables();
    tables.by_ost.get(ost).and_then(|id| tables.categories.get(id))
}

/// Classe native de Revit → catégorie, pour les éléments qui ne passent pas par une famille
/// chargée (murs, sols, plafonds, garde-corps, escaliers…).
///
/// Cette table est lue par la géométrie (`Scene::category`, `classes::excluded`, `is_model_class`) comme par les fiches : une ligne
/// ajoutée écarte ou garde des éléments, et dessine la boîte d'un élément dont le graphe ne se lit pas au lieu de l'écarter. Les
/// classes de catégorie de modèle (genre M, hors OST_Mass) qui ont une seule catégorie y sont : sans cela, un fichier dont le seul
/// `ProfileRoof` est illisible l'écarterait en silence, quand la règle du projet est de le dessiner par sa boîte et de le lister.
/// Les noms de classes de l'API (`FootPrintRoof`, `ExtrusionRoof`, `CurtainRoof`) n'en font plus partie : aucun schéma mesuré (les 54
/// fichiers d'essai lisibles, Revit 2012 à 2027) n'a de classe de ce nom, la toiture par tracé s'y appelle `ProfileRoof`.
const CLASS_CATEGORIES: &[(&str, &str)] = &[
    ("SWall", "OST_Walls"),
    ("Floor", "OST_Floors"),
    ("Ceiling", "OST_Ceilings"),
    ("Roof", "OST_Roofs"),
    // Les classes de la spec des catégories (viewer-bim-travail/categories/spec.md) : une seule catégorie chacune, celle de leurs
    // styles graphiques dans le fichier (canal 103 : `GInfo.m_categoryId` puis `GStyleElem.m_categoryId`), 23 sur 23 pour `ProfileRoof`,
    // 16 sur 16 pour `ContFooting`, 5 sur 5 pour `Stairs`, 3 sur 3 pour `FaceRoof`, et le seul `FaceWall`, `ArcWall` et `CurtaSystem`. Leurs
    // enregistrements n'ont ni `m_categoryId` ni `m_masterSymbolId` (mesuré sur les 54 fichiers) : la géométrie ne leur en connaissait pas.
    // Toutes sont des catégories de modèle hors OST_Mass : aucune n'est écartée par `classes::excluded_relation`.
    ("ProfileRoof", "OST_Roofs"),
    ("FaceRoof", "OST_Roofs"),
    ("ContFooting", "OST_StructuralFoundation"),
    // L'ancien escalier d'esquisse (`StairsAttributes`) ; une rampe est une autre classe (`Ramp`), non listée : aucun essai.
    ("Stairs", "OST_Stairs"),
    ("FaceWall", "OST_Walls"),
    ("ArcWall", "OST_Walls"),
    ("CurtaSystem", "OST_CurtaSystem"),
    ("StairsElement", "OST_Stairs"),
    ("StairsRun", "OST_StairsRuns"),
    ("StairsLanding", "OST_StairsLandings"),
    ("StairsTriserSymbol", "OST_StairsTrisers"),
    ("StairsSupport", "OST_StairsSupports"),
    ("BaseRailing", "OST_StairsRailing"),
    ("BaseRailingSym", "OST_StairsRailing"),
    ("TopRail", "OST_RailingTopRail"),
    ("HandRail", "OST_RailingHandRail"),
    ("ContinuousRailSymbol", "OST_RailingTopRail"),
    ("RoomElem", "OST_Rooms"),
    ("CurtainGridLine", "OST_CurtainGrids"),
    ("BuildingPad", "OST_BuildingPad"),
    ("SiteSurface", "OST_Topography"),
    ("FormElem", "OST_Mass"),
    ("ExtrusionElem", "OST_GenericModel"),
    ("Text3dElem", "OST_GenericModel"),
    ("AnalyticalPanel", "OST_AnalyticalPanel"),
    ("AnalyticalMember", "OST_AnalyticalMember"),
    ("RbsDuctCurve", "OST_DuctCurves"),
    ("RbsPipeCurve", "OST_PipeCurves"),
    ("RbsFlexDuctCurve", "OST_FlexDuctCurves"),
    ("RbsFlexPipeCurve", "OST_FlexPipeCurves"),
    ("RbsCableTrayCurve", "OST_CableTray"),
    ("RbsConduitCurve", "OST_Conduit"),
    ("GuideGrid", "OST_GuideGrid"),
    ("CurveElem", "OST_Lines"),
    ("Grid", "OST_Grids"),
    ("Level", "OST_Levels"),
];

/// Les classes que seules les fiches rangent, hors de la table que lit la géométrie (`fiche_class_category`).
///
/// `MassLevelData` est le sol de masse (OST_MassFloor, 8 sur 8 sont dessinés avec ses styles). OST_MassFloor est une catégorie de
/// modèle qui n'est pas OST_Mass : ni `classes::excluded_relation` ni `masses_hidden` ne l'écartent ni ne la comptent (`excluded_relation` ne teste que le nom OST_Mass). Mais
/// les sols de masse sont dessinés dans un projet quand leurs masses sont masquées par défaut, et si Revit les masque avec elles est
/// une question de géométrie que le catalogue (sans parents de sous-catégories) ne tranche pas (spec, §9.9) : la ranger dans
/// `CLASS_CATEGORIES` la déciderait, et ferait dessiner une boîte à un sol de masse illisible. Elle reste aux fiches, qui ne dessinent
/// rien (`tests::la_classe_que_seules_les_fiches_rangent_ne_change_pas_le_dessin`).
///
/// `DividedSurface` est la surface divisée (OST_DividedSurface, « Surface divisée », -2003323 : Revit a une catégorie de ce nom pour cet
/// élément). Le propriétaire de la famille dit « Masses », mais les 5 surfaces mesurées (`dynamo-tower-6-ds-2013`) sont dessinées avec
/// des styles qui sont tous des sous-catégories d'OST_DividedSurface (`_Nodes`, `_Gridlines`, `_PatternLines`, `_PatternFill`), et une
/// sous-catégorie est toujours sous la catégorie de l'élément (vrai pour 4 des 5 cas de sous-catégories seules mesurés plus tôt). C'est une
/// catégorie interne (genre I) : `classes::excluded` l'écarterait du dessin si la géométrie la lisait. Elle reste aux fiches.
const FICHE_CLASS_CATEGORIES: &[(&str, &str)] = &[("MassLevelData", "OST_MassFloor"), ("DividedSurface", "OST_DividedSurface")];

/// Classe native d'un type → catégorie de ses éléments, pour les classes d'éléments que plusieurs catégories se partagent :
/// `SweepHost` (nez de dalle, bandeau, gouttière) et `WallSweep` autonome (profilé, feuillure). On ne range jamais d'après les
/// classes de base `SweepHostAttr` et `WallSweepAttr` : elles n'ont aucun enregistrement et ne disent rien.
const TYPE_CATEGORIES: &[(&str, &str)] = &[
    ("EdgeSlabAttr", "OST_EdgeSlab"),
    ("FasciaAttr", "OST_Fascia"),
    ("GutterAttr", "OST_Gutter"),
    ("CorniceAttr", "OST_Cornices"),
    ("RevealAttr", "OST_Reveals"),
];

/// La catégorie d'un élément d'après sa classe native, quand elle la détermine. C'est la table que lit la géométrie.
pub fn class_category(class: &str) -> Option<&'static Category> {
    CLASS_CATEGORIES.iter().find(|(name, _)| *name == class).and_then(|(_, ost)| category_by_ost(ost))
}

/// La catégorie d'un élément pour sa fiche : celle de [`class_category`], puis celle des classes que seules les fiches rangent.
pub fn fiche_class_category(class: &str) -> Option<&'static Category> {
    class_category(class).or_else(|| FICHE_CLASS_CATEGORIES.iter().find(|(name, _)| *name == class).and_then(|(_, ost)| category_by_ost(ost)))
}

/// La catégorie des éléments d'un type, d'après la classe native du type, quand elle la détermine.
pub fn type_category(type_class: &str) -> Option<&'static Category> {
    TYPE_CATEGORIES.iter().find(|(name, _)| *name == type_class).and_then(|(_, ost)| category_by_ost(ost))
}

/// Les formes d'une famille : les sous-classes de `GenSweep` (extrusion, fusion, balayage, balayage fusionné, révolution, forme
/// de masse, forme libre). Leur catégorie est celle de la famille qui les possède, quand le fichier la donne : sur les 45 formes de
/// 54 fichiers, la catégorie de la famille est celle de leur graphique pour 44 (la 45e est un vide, dessiné avec le seul style de
/// géométrie coupante). Le `m_categoryId` de `GenSweep` lui-même est toujours -1 : c'est la sous-catégorie de la forme.
pub fn is_family_form(class: &str) -> bool {
    matches!(class, "ExtrusionElem" | "BlendElem" | "SweepElem" | "SweptBlendElem" | "RevolutionElem" | "FormElem" | "FreeFormElement")
}

/// Le nom que l'éditeur de familles de Revit donne à une forme selon sa sorte (« Extrusion », « Balayage »…), pour une forme de
/// [`is_family_form`] : dans un `.rfa`, une forme n'a ni famille ni type, c'est ce nom et son identifiant qui la désignent. `None` pour
/// toute autre classe.
pub fn form_kind(class: &str) -> Option<&'static str> {
    Some(match class {
        "ExtrusionElem" => "Extrusion",
        "BlendElem" => "Raccordement",
        "SweepElem" => "Balayage",
        "SweptBlendElem" => "Raccordement par balayage",
        "RevolutionElem" => "Révolution",
        "FormElem" => "Forme",
        "FreeFormElement" => "Forme libre",
        _ => return None,
    })
}

/// Nom français de la famille système d'un type, d'après la classe native de son enregistrement
/// (« Mur de base » pour `BasicWallType`). Sert au libellé « Famille : Type » des murs, sols,
/// plafonds, toitures, escaliers, nez de dalle, bandeaux, gouttières, semelles et systèmes de murs-rideaux, dont le fichier
/// ne nomme pas la famille.
pub fn system_family(type_class: &str) -> Option<&'static str> {
    Some(match type_class {
        "BasicWallType" => "Mur de base",
        "NewCurtainWallType" => "Mur-rideau",
        "StackedWallType" => "Mur empilé",
        "FloorAttributes" => "Sol",
        "CompoundCeilingType" => "Plafond composé",
        "BasicCeilingType" => "Plafond de base",
        "RoofAttributes" => "Toiture de base",
        "CurtainRoofAttributes" => "Toiture-verrière",
        "StairsType" | "StairsAttributes" => "Escalier",
        "StairsRunType" => "Volée d'escalier",
        "StairsLandingType" => "Palier d'escalier",
        "BuildingPadType" => "Terrassement de bâtiment",
        // Les noms de la famille système, au singulier comme les précédents, dans le vocabulaire des libellés de catégories
        // (source/categories-fr.tsv) : « Bandeaux », « Gouttières », « Systèmes de mur-rideau » ; « Fondations porteuses » est celui
        // de toute la catégorie, la famille système de la semelle filante a le sien.
        "EdgeSlabAttr" => "Nez de dalle",
        "FasciaAttr" => "Bandeau",
        "GutterAttr" => "Gouttière",
        "ContFootingType" => "Semelle filante",
        "CurtaSystemAttr" => "Système de mur-rideau",
        // Le type d'un garde-corps est `BaseRailing.m_stairsRailingAttrId` (83 sur 83 mesurés : « SH_1100mm »…), de la classe
        // `StairsRailingAttr` ; Revit l'appelle « Railing » (RE1-Architecture : « Railing:- » dans son export IFC).
        "StairsRailingAttr" => "Garde-corps",
        "HandRailType" => "Main courante",
        "TopRailType" => "Lisse haute",
        "RbsDuctType" | "AbsDuctType" => "Gaine",
        "AbsFlexDuctType" => "Gaine souple",
        "RbsPipeType" => "Tuyau",
        "RbsFlexPipeType" => "Tuyau flexible",
        "RbsCableTrayType" => "Chemin de câbles",
        "RbsConduitType" => "Conduit",
        _ => return None,
    })
}

/// Nombre d'entrées du catalogue (identifiants de paramètres, groupes, catégories) : pour les bilans.
pub fn sizes() -> (usize, usize, usize) {
    let tables = tables();
    (tables.parameters.len(), tables.groups.len(), tables.categories.len())
}

/// Noms anglais de catégories (ceux que Revit écrit dans ses exports) qui ne se déduisent pas du nom OST_
/// en retirant espaces et pluriel.
const ENGLISH_ALIASES: &[(&str, &str)] = &[
    ("railings", "OST_StairsRailing"),
    ("curtainpanels", "OST_CurtainWallPanels"),
    ("curtainwallpanels", "OST_CurtainWallPanels"),
    ("specialtyequipment", "OST_SpecialityEquipment"),
    ("pipes", "OST_PipeCurves"),
    ("ducts", "OST_DuctCurves"),
    ("flexducts", "OST_FlexDuctCurves"),
    ("flexpipes", "OST_FlexPipeCurves"),
    ("cabletrays", "OST_CableTray"),
    ("conduits", "OST_Conduit"),
    ("genericmodels", "OST_GenericModel"),
    ("airterminals", "OST_DuctTerminal"),
    ("topography", "OST_Topography"),
    ("structuralconnections", "OST_StructConnections"),
];

/// La catégorie d'après son nom anglais d'affichage (« Walls », « Generic Models »), tel que l'écrivent les
/// exports de Revit. Sert aux fichiers d'avant Revit 2023.
pub fn category_from_english(name: &str) -> Option<&'static Category> {
    let squashed: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if squashed.is_empty() {
        return None;
    }
    let lower = squashed.to_ascii_lowercase();
    if let Some((_, ost)) = ENGLISH_ALIASES.iter().find(|(alias, _)| *alias == lower) {
        return category_by_ost(ost);
    }
    // « Structural Columns » → OST_StructuralColumns ; au singulier si le pluriel n'existe pas.
    let tables = tables();
    let find = |wanted: &str| tables.by_ost.iter().find(|(ost, _)| ost.len() == wanted.len() + 4 && ost[4..].eq_ignore_ascii_case(wanted)).and_then(|(_, id)| tables.categories.get(id));
    find(&squashed).or_else(|| squashed.strip_suffix('s').and_then(find))
}

/// Catégorie d'un élément IFC reconstruit par rvt-rs, d'après sa classe IFC.
pub fn ifc_category(ifc_type: &str) -> Option<&'static Category> {
    let ost = match ifc_type {
        "IFCWALL" | "IFCWALLSTANDARDCASE" => "OST_Walls",
        "IFCSLAB" => "OST_Floors",
        "IFCROOF" => "OST_Roofs",
        "IFCCOVERING" => "OST_Ceilings",
        "IFCDOOR" => "OST_Doors",
        "IFCWINDOW" => "OST_Windows",
        "IFCCOLUMN" => "OST_Columns",
        "IFCBEAM" | "IFCMEMBER" => "OST_StructuralFraming",
        "IFCPLATE" => "OST_CurtainWallPanels",
        "IFCCURTAINWALL" => "OST_Walls",
        "IFCSTAIR" => "OST_Stairs",
        "IFCSTAIRFLIGHT" => "OST_StairsRuns",
        "IFCRAMP" | "IFCRAMPFLIGHT" => "OST_Ramps",
        "IFCRAILING" => "OST_StairsRailing",
        "IFCFURNITURE" | "IFCFURNISHINGELEMENT" => "OST_Furniture",
        "IFCSPACE" => "OST_Rooms",
        "IFCBUILDINGELEMENTPROXY" => "OST_GenericModel",
        "IFCLIGHTFIXTURE" => "OST_LightingFixtures",
        "IFCFOOTING" | "IFCPILE" => "OST_StructuralFoundation",
        "IFCSANITARYTERMINAL" => "OST_PlumbingFixtures",
        "IFCPIPEFITTING" => "OST_PipeFitting",
        "IFCPIPESEGMENT" => "OST_PipeCurves",
        "IFCDUCTSEGMENT" => "OST_DuctCurves",
        "IFCDUCTFITTING" => "OST_DuctFitting",
        "IFCFLOWTERMINAL" => "OST_DuctTerminal",
        "IFCCABLECARRIERSEGMENT" => "OST_CableTray",
        "IFCCABLESEGMENT" => "OST_Wire",
        "IFCREINFORCINGBAR" => "OST_Rebar",
        _ => return None,
    };
    category_by_ost(ost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_tables_se_lisent() {
        let (parameters, groups, categories) = sizes();
        assert!(parameters > 3000, "{parameters} paramètres");
        assert!(groups > 100, "{groups} groupes");
        assert!(categories > 1000, "{categories} catégories");
    }

    #[test]
    fn des_libelles_connus() {
        let offset = parameter(-1001108).expect("WALL_BASE_OFFSET");
        assert_eq!(offset.name, "WALL_BASE_OFFSET");
        assert_eq!(offset.label, "Décalage inférieur");
        assert_eq!(offset.quantity, Quantity::Length);
        assert_eq!(offset.group.and_then(group_label), Some("Contraintes"));
        assert_eq!(category(-2000011).map(|c| c.label), Some("Murs"));
        assert_eq!(group_label("autodesk.parameter.group:dimensions-1.0.0"), Some("Cotes"));
        assert_eq!(group_label("autodesk.parameter.group:identityData"), Some("Données d'identification"));
        // Un paramètre que Rhino.Inside.Revit ne publie pas.
        assert_eq!(parameter(-1001101).map(|p| p.label), Some("Hauteur calculée"));
    }

    #[test]
    fn la_nature_des_parametres_integres() {
        let quantity = |name: &str| tables().parameters.values().find(|p| p.name == name).map(|p| p.quantity);
        // Écrite à la main (source/parameter-specs.tsv).
        assert_eq!(quantity("RBS_PIPE_FLOW_PARAM"), Some(Quantity::Spec("flow")));
        assert_eq!(quantity("RBS_DUCT_FLOW_PARAM"), Some(Quantity::Spec("airFlow")));
        assert_eq!(quantity("ROOM_DESIGN_POWER_LOAD_PARAM"), Some(Quantity::Spec("power")));
        assert_eq!(quantity("RBS_ELEC_VOLTAGE"), Some(Quantity::Spec("potential")));
        // « Débit d'air par surface » n'est pas une surface, quoi qu'en dise le mot AREA du nom.
        assert_eq!(quantity("SPACE_OUTDOOR_AIRFLOW_PER_AREA"), Some(Quantity::Spec("airFlowDensity")));
        assert_eq!(quantity("ZONE_USE_OUTSIDE_AIR_PER_AREA_PARAM"), Some(Quantity::Other));
        // Une surface par personne en est une.
        assert_eq!(quantity("ROOM_AREA_PER_PERSON_PARAM"), Some(Quantity::Area));
        // Une surface par charge (m²/W) n'est pas une surface (m²) : pas de ×0,0929.
        assert_eq!(quantity("ZONE_CALCULATED_AREA_PER_COOLING_LOAD_PARAM"), Some(Quantity::Spec("areaDividedByCoolingLoad")));
        assert_eq!(quantity("ZONE_CALCULATED_AREA_PER_HEATING_LOAD_PARAM"), Some(Quantity::Spec("areaDividedByHeatingLoad")));
        // Devinée à son nom, comme avant.
        assert_eq!(quantity("WALL_USER_HEIGHT_PARAM"), Some(Quantity::Length));
    }

    #[test]
    fn toute_nature_du_catalogue_a_son_unite() {
        // Une faute de frappe dans source/parameter-specs.tsv laisserait un paramètre sans conversion, sans bruit.
        for parameter in tables().parameters.values() {
            if let Quantity::Spec(kind) = parameter.quantity {
                assert_ne!(units::of_kind(kind), units::Spec::Unknown, "{} : nature « {kind} » inconnue de units.rs", parameter.name);
            }
        }
        let specs = tables().parameters.values().filter(|p| matches!(p.quantity, Quantity::Spec(_))).count();
        assert!(specs > 100, "{specs} paramètres intégrés avec une nature de spec");
    }

    #[test]
    fn toutes_les_classes_ont_leur_categorie() {
        for (class, ost) in CLASS_CATEGORIES.iter().chain(FICHE_CLASS_CATEGORIES).chain(TYPE_CATEGORIES) {
            assert!(category_by_ost(ost).is_some(), "{class} → {ost} est inconnu");
        }
    }

    /// Les 8 classes de la spec des catégories que la table des classes ne rangeait pas.
    const SPEC_CLASSES: [(&str, &str); 8] = [
        ("ProfileRoof", "OST_Roofs"),
        ("FaceRoof", "OST_Roofs"),
        ("ContFooting", "OST_StructuralFoundation"),
        ("Stairs", "OST_Stairs"),
        ("FaceWall", "OST_Walls"),
        ("ArcWall", "OST_Walls"),
        ("CurtaSystem", "OST_CurtaSystem"),
        ("MassLevelData", "OST_MassFloor"),
    ];

    #[test]
    fn les_classes_de_la_spec_ne_changent_pas_ce_qui_se_dessine() {
        // La géométrie lit `class_category` : ni exclusion (catégorie d'annotation, interne, analytique, ou masse), ni élément traité
        // autrement d'après un autre genre que M.
        for (class, ost) in SPEC_CLASSES {
            let category = category_by_ost(ost).expect(ost);
            assert_eq!(category.kind, 'M', "{class} → {ost}");
            assert_ne!(category.ost, "OST_Mass", "{class}");
            assert_eq!(fiche_class_category(class).map(|c| c.ost), Some(ost), "{class}");
        }
        // Les 7 classes de catégorie de modèle sont dans la table de la géométrie : un élément illisible est dessiné par sa boîte, non écarté.
        for (class, ost) in &SPEC_CLASSES[..7] {
            assert_eq!(class_category(class).map(|c| c.ost), Some(*ost), "{class}");
            assert!(CLASS_CATEGORIES.iter().any(|(name, _)| name == class), "{class}");
        }
        // Le sol de masse n'y est pas : les fiches seules le rangent (voir `FICHE_CLASS_CATEGORIES`).
        assert!(class_category("MassLevelData").is_none());
        assert_eq!(FICHE_CLASS_CATEGORIES, &[("MassLevelData", "OST_MassFloor"), ("DividedSurface", "OST_DividedSurface")]);
    }

    #[test]
    fn la_classe_que_seules_les_fiches_rangent_ne_change_pas_le_dessin() {
        for (class, ost) in FICHE_CLASS_CATEGORIES {
            let category = category_by_ost(ost).expect(ost);
            assert_ne!(category.ost, "OST_Mass", "{class}");
            assert!(CLASS_CATEGORIES.iter().all(|(name, _)| name != class), "{class} masquerait une ligne de CLASS_CATEGORIES");
            assert!(class_category(class).is_none(), "{class} : la géométrie ne la lit pas");
        }
        // Le sol de masse est de genre M ; la surface divisée est de genre I, ce qui la ferait écarter du dessin (`classes::excluded`)
        // si la géométrie la lisait : c'est pourquoi elle n'est que dans la table des fiches.
        assert_eq!(category_by_ost("OST_MassFloor").map(|c| c.kind), Some('M'));
        assert_eq!(category_by_ost("OST_DividedSurface").map(|c| (c.kind, c.label)), Some(('I', "Surface divisée")));
        assert_eq!(fiche_class_category("DividedSurface").map(|c| c.label), Some("Surface divisée"));
        // Les fiches voient aussi tout ce que voit la géométrie.
        for (class, ost) in CLASS_CATEGORIES {
            assert_eq!(fiche_class_category(class).map(|c| c.ost), Some(*ost));
        }
        assert_eq!(fiche_class_category("MassLevelData").map(|c| c.label), Some("Sols de masse"));
        assert_eq!(fiche_class_category("ProfileRoof").map(|c| c.label), Some("Toitures"));
        // Une classe que le fichier ne range pas d'après son nom n'a pas de catégorie.
        for class in ["WallSweep", "SweepHost", "DirectShape", "SweepElem", "FamilyInstance"] {
            assert!(fiche_class_category(class).is_none(), "{class}");
        }
    }

    #[test]
    fn les_noms_de_l_api_ne_sont_pas_des_classes_du_fichier() {
        // Aucun schéma mesuré (Revit 2012 à 2027) n'a de classe `FootPrintRoof`, `ExtrusionRoof` ou `CurtainRoof` : la toiture par
        // tracé est `ProfileRoof`, par face `FaceRoof`, par extrusion `Roof`.
        for class in ["FootPrintRoof", "ExtrusionRoof", "CurtainRoof"] {
            assert!(CLASS_CATEGORIES.iter().chain(FICHE_CLASS_CATEGORIES).all(|(name, _)| *name != class), "{class}");
        }
    }

    #[test]
    fn la_classe_d_un_type_donne_la_categorie() {
        for (class, ost) in TYPE_CATEGORIES {
            assert_eq!(type_category(class).map(|c| c.ost), Some(*ost), "{class}");
        }
        assert_eq!(type_category("EdgeSlabAttr").map(|c| c.ost), Some("OST_EdgeSlab"));
        assert_eq!(type_category("FasciaAttr").map(|c| c.ost), Some("OST_Fascia"));
        assert_eq!(type_category("GutterAttr").map(|c| c.ost), Some("OST_Gutter"));
        assert_eq!(type_category("CorniceAttr").map(|c| c.ost), Some("OST_Cornices"));
        assert_eq!(type_category("RevealAttr").map(|c| c.ost), Some("OST_Reveals"));
        // Les classes de base n'ont pas d'enregistrement et partagent leurs sous-classes ; un type de toiture n'est pas un profilé.
        for class in ["SweepHostAttr", "WallSweepAttr", "RoofAttributes", "FamilySymbol", ""] {
            assert!(type_category(class).is_none(), "{class}");
        }
    }

    #[test]
    fn les_formes_d_une_famille_sont_les_sous_classes_de_gensweep() {
        for class in ["ExtrusionElem", "BlendElem", "SweepElem", "SweptBlendElem", "RevolutionElem", "FormElem", "FreeFormElement"] {
            assert!(is_family_form(class), "{class}");
        }
        // Pas une `GenSweep` : rien n'appuie sa catégorie sur celle de sa famille.
        for class in ["DividedSurface", "DirectShape", "FamilyInstance", "SWall", "Roof", "GenSweep"] {
            assert!(!is_family_form(class), "{class}");
        }
    }

    #[test]
    fn le_nom_d_une_forme_de_famille_est_celui_de_sa_sorte() {
        // Toute forme de famille a un nom de sorte, et rien d'autre n'en a.
        for (class, kind) in [
            ("ExtrusionElem", "Extrusion"),
            ("BlendElem", "Raccordement"),
            ("SweepElem", "Balayage"),
            ("SweptBlendElem", "Raccordement par balayage"),
            ("RevolutionElem", "Révolution"),
            ("FormElem", "Forme"),
            ("FreeFormElement", "Forme libre"),
        ] {
            assert!(is_family_form(class), "{class}");
            assert_eq!(form_kind(class), Some(kind), "{class}");
        }
        for class in ["DividedSurface", "DirectShape", "FamilyInstance", "SWall", "GenSweep", ""] {
            assert_eq!(form_kind(class), None, "{class}");
        }
    }

    #[test]
    fn les_noms_anglais_de_categories() {
        assert_eq!(category_from_english("Walls").map(|c| c.ost), Some("OST_Walls"));
        assert_eq!(category_from_english("Generic Models").map(|c| c.ost), Some("OST_GenericModel"));
        assert_eq!(category_from_english("Structural Columns").map(|c| c.ost), Some("OST_StructuralColumns"));
        assert_eq!(category_from_english("Railings").map(|c| c.ost), Some("OST_StairsRailing"));
        assert!(category_from_english("Nothing like this").is_none());
    }

    #[test]
    fn les_versions_se_retirent() {
        assert_eq!(strip_version("autodesk.parameter.group:constraints-1.0.0"), "autodesk.parameter.group:constraints");
        assert_eq!(strip_version("autodesk.parameter.group:constraints"), "autodesk.parameter.group:constraints");
        assert_eq!(strip_version("autodesk.revit.group:profilen1-1.0.0"), "autodesk.revit.group:profilen1");
    }

    #[test]
    fn les_noms_de_type_systeme() {
        assert_eq!(system_family("BasicWallType"), Some("Mur de base"));
        assert_eq!(system_family("FamilySymbol"), None);
        // Les types des classes que les fiches rangent désormais.
        assert_eq!(system_family("EdgeSlabAttr"), Some("Nez de dalle"));
        assert_eq!(system_family("FasciaAttr"), Some("Bandeau"));
        assert_eq!(system_family("GutterAttr"), Some("Gouttière"));
        assert_eq!(system_family("ContFootingType"), Some("Semelle filante"));
        assert_eq!(system_family("StairsAttributes"), Some("Escalier"));
        assert_eq!(system_family("CurtaSystemAttr"), Some("Système de mur-rideau"));
        // Le type d'un garde-corps (`BaseRailing.m_stairsRailingAttrId`) et celui de sa lisse haute (`TopRail.m_typeId`).
        assert_eq!(system_family("StairsRailingAttr"), Some("Garde-corps"));
        assert_eq!(system_family("TopRailType"), Some("Lisse haute"));
        // Les classes de base n'ont pas d'enregistrement : pas de nom.
        assert_eq!(system_family("SweepHostAttr"), None);
    }

    #[test]
    fn les_noms_de_type_systeme_suivent_les_libelles_de_categorie() {
        // Le nom de la famille système d'un type est le singulier du libellé de sa catégorie (le catalogue écrit « Bandeaux », « Gouttières »,
        // « Systèmes de mur-rideau », « Escaliers »), sauf la semelle filante, plus précise que « Fondations porteuses ».
        let label = |ost: &str| category_by_ost(ost).expect(ost).label;
        assert_eq!(label("OST_EdgeSlab"), system_family("EdgeSlabAttr").unwrap());
        assert_eq!(label("OST_Fascia"), format!("{}x", system_family("FasciaAttr").unwrap()));
        assert_eq!(label("OST_Gutter"), format!("{}s", system_family("GutterAttr").unwrap()));
        assert_eq!(label("OST_Stairs"), format!("{}s", system_family("StairsAttributes").unwrap()));
        assert_eq!(label("OST_CurtaSystem"), system_family("CurtaSystemAttr").unwrap().replacen("Système", "Systèmes", 1));
        // Le même mot que les types de composants déjà nommés.
        assert_eq!(system_family("StairsAttributes"), system_family("StairsType"));
    }
}
