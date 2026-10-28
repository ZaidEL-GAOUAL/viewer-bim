//! Quels éléments se dessinent. La règle est celle d'une vue 3D de Revit (et du convertisseur IFC
//! du viewer, qui ignore `IfcSpace`) : on écarte ce qui n'est pas un objet du bâtiment.
//!
//! La décision se prend sur le nom de classe Revit de l'enregistrement de l'élément (`SWall`,
//! `FamilyInstance`, `RoomElem`…), qui ne dépend pas de la langue du fichier (`excluded_class`),
//! puis sur ce que l'enregistrement dit de la place de l'élément dans le modèle
//! (`excluded_relation`) : membre d'une définition de groupe (non placé), instance invisible,
//! membre d'un type ou d'un symbole, propre à une vue, catégorie d'annotation ou analytique, masse, et, avant Revit 2015,
//! élément qui définit une famille chargée.
//! Sur Core Interior ces règles ramènent 13 528 éléments à 855 : les 854 que contient l'export IFC
//! de Revit, plus la topographie. `examples/census.rs` imprime ce que chaque règle retire, et
//! `examples/dupes.rs` explique d'où viennent les triangles confondus.

/// Type, symbole ou définition de famille : ce que les instances placent. Leurs graphiques sont
/// lus d'office (les instances en reprennent la forme), mais ils ne se dessinent jamais seuls.
pub fn is_definition(class: &str) -> bool {
    class.ends_with("Type") || class.ends_with("Attr") || class.ends_with("Attributes") || class.contains("Sym") || class.contains("Surrogate") || class == "Family"
}

/// Motifs de classes écartées, par raison. Une classe est écartée si elle correspond à l'un d'eux.
pub fn excluded_class(class: &str) -> Option<&'static str> {
    let starts = |prefix: &str| class.starts_with(prefix);
    let has = |part: &str| class.contains(part);

    // Types, symboles et définitions : ce que les instances placent, jamais dessiné seul (il
    // s'afficherait à l'origine). Les instances en reprennent déjà la forme.
    if is_definition(class) {
        return Some("type, symbole ou définition de famille");
    }
    // Un groupe est un conteneur : ses membres se dessinent, lui n'a rien à montrer.
    if class == "ElementGroup" {
        return Some("groupe (conteneur)");
    }
    if matches!(class, "RoomElem" | "Room") || starts("Area") || starts("Space") || has("MEPSpace") || starts("Zone") {
        return Some("pièce, surface ou espace");
    }
    if matches!(class, "Level" | "Grid" | "GuideGrid" | "RefPlane" | "ReferencePoint" | "BasePoint" | "SurveyPoint" | "SketchGrid" | "LevelRoomPlan") {
        return Some("repère (niveau, trame, plan de référence)");
    }
    if starts("DBView") || starts("Viewer") || matches!(class, "Viewport" | "Section" | "ExtentElem") || starts("Callout") || starts("InteriorElev") || starts("Elevation") || has("Camera") || starts("Legend") {
        return Some("vue, coupe ou caméra");
    }
    if has("ClipBox") || has("ScopeBox") || has("SectionBox") {
        return Some("boîte de coupe ou d'étendue");
    }
    if starts("Analytical") {
        return Some("modèle analytique");
    }
    if has("Tag") || has("Dim") || matches!(class, "TextNote" | "FilledRegion") || has("Keynote") || has("Revision") || starts("Spot") || has("Leader") || has("Detail") {
        return Some("annotation");
    }
    if starts("Sketch") || class == "VarSketch" {
        return Some("esquisse");
    }
    // Des lignes n'ont pas de surface à mailler : le viewer ne dessine que des triangles.
    if matches!(class, "CurveElem" | "CurtainGridLine") {
        return Some("ligne ou courbe");
    }
    None
}

/// Ce que l'enregistrement d'un élément dit de sa place dans le modèle (voir `saved::Scene::facts`).
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    pub class: &'a str,
    /// Vue propriétaire (`m_ownerDBViewId`) ; `-1` pour un élément du modèle.
    pub view: i64,
    /// L'élément vit dans la définition d'un groupe (`m_unplacedOwnerId` ≠ −1) : il n'est pas
    /// placé dans le modèle.
    pub unplaced: bool,
    /// Un propriétaire de l'élément (de proche en proche, tant que ce sont des conteneurs que la lecture
    /// décode) vit dans la définition d'un groupe : l'élément en est un membre, même si son propre
    /// enregistrement ne le dit pas. C'est la règle que la lecture rapide applique sans décoder ces
    /// enregistrements (`saved::read_records`) : les deux lectures écartent les mêmes éléments.
    pub owner_unplaced: bool,
    /// Classe de l'élément propriétaire (`owning_element_id`), s'il en a un.
    pub owner_class: Option<&'a str>,
    /// Instance invisible (case « Visible » décochée) ou dormante.
    pub hidden: bool,
    /// Catégorie Revit (BuiltInCategory, négatif), quand le fichier la donne.
    pub category: Option<i64>,
    /// Le fichier est un document de famille (`.rfa`) : ses formes (extrusions, révolutions, balayages, formes
    /// volumiques) sont la famille elle-même, que sa vue 3D montre, masses de famille conceptuelle comprises.
    pub family_document: bool,
    /// L'élément définit une famille chargée dans ce projet : son propriétaire d'ElemTable est un enregistrement `Family` qui
    /// n'est ni sur place ni celle du document (`native::FamilyOwner::Definition`). Vrai seulement avant Revit 2015, où ces
    /// éléments sont écrits dans le projet.
    pub family_definition: bool,
    /// Il en est une pièce par des intermédiaires : la chaîne de ses propriétaires d'ElemTable (un groupe de modèle, un symbole
    /// d'import, une courbe…) mène à une telle `Family` (`native::FamilyOwner::DefinitionChain`). Compté à part.
    pub family_chain: bool,
}

/// Les raisons d'exclusion par relation, dans l'ordre où on les teste.
pub const RELATION_REASONS: &[&str] = &[
    "membre d'une définition de groupe (non placé)",
    "instance invisible ou dormante",
    "membre d'un type ou d'un symbole",
    "propre à une vue (annotation)",
    "catégorie d'annotation, analytique ou interne",
    "masse (masquée par défaut dans Revit)",
    "définition d'une famille chargée",
    "pièce d'une famille chargée, par des intermédiaires",
];

/// Raison de l'exclusion d'un élément pour ce qu'il est par rapport au reste du modèle (classe
/// non exclue par `excluded_class`). Une règle par ligne de `RELATION_REASONS`.
pub fn excluded_relation(facts: &Facts) -> Option<&'static str> {
    // Les éléments d'une définition de groupe sont des copies qui servent à placer le groupe : le
    // groupe placé a les siens, qui coïncident exactement avec elles. Revit ne les montre pas (ni
    // son export IFC : Core Interior, 854 éléments, sont ceux qui ne sont pas non placés).
    if facts.unplaced || facts.owner_unplaced {
        return Some(RELATION_REASONS[0]);
    }
    // La case « Visible » de l'instance : Revit ne la dessine pas (les balustres qui définissent
    // le garde-corps d'un type, par exemple).
    if facts.hidden {
        return Some(RELATION_REASONS[1]);
    }
    // Ce qu'un type ou un symbole possède est sa définition (type de groupe, symbole de garde-corps).
    // Une famille (`Family`) n'en fait pas partie : ce qu'une famille sur place possède (des murs
    // créés dans l'éditeur) est dans le modèle.
    if facts.owner_class.is_some_and(|owner| owner.ends_with("Type") || owner.contains("Sym")) {
        return Some(RELATION_REASONS[2]);
    }
    if facts.view != -1 {
        return Some(RELATION_REASONS[3]);
    }
    if let Some(category) = facts.category.and_then(crate::catalog::category) {
        // A annotation, N modèle analytique, I interne : jamais des objets d'une vue 3D.
        if matches!(category.kind, 'A' | 'N' | 'I') {
            return Some(RELATION_REASONS[4]);
        }
        // Dans un projet, une masse est masquée par défaut ; dans une famille, ses formes sont la famille.
        if category.ost == "OST_Mass" && !facts.family_document {
            return Some(RELATION_REASONS[5]);
        }
    }
    // Avant Revit 2015, le projet porte, en clair parmi ses enregistrements, les éléments qui définissent chaque famille
    // chargée (extrusions, balayages, fusions, instances imbriquées…) : leur propriétaire d'ElemTable est la `Family`, et
    // leurs formes sont dans le repère local de la famille, donc dessinées à l'origine du projet. Revit 2015 et après les
    // rangent dans des sections que la lecture ne parcourt pas. Mesuré sur `DynamoSample_2014.rvt` contre
    // `DynamoSample_2023.rvt` (même modèle, mêmes GlobalId) : 114 éléments de trop en 2014, tous de ce genre, aucun en 2023.
    // La règle vient en dernier : ce que les autres raisons écartent déjà garde sa raison.
    if facts.family_definition {
        return Some(RELATION_REASONS[6]);
    }
    // Même règle quand la chaîne des propriétaires passe par des intermédiaires avant la `Family` : l'élément n'est pas moins une
    // pièce de la famille. Aucun n'est dessiné dans les fichiers d'essai (`pre2015/metaleak.md`) ; la raison est comptée à part.
    if facts.family_chain {
        return Some(RELATION_REASONS[7]);
    }
    None
}

/// Raison de l'exclusion d'un élément : sa classe, puis ses relations.
pub fn excluded(facts: &Facts) -> Option<&'static str> {
    excluded_class(facts.class).or_else(|| excluded_relation(facts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(class: &str) -> Facts<'_> {
        Facts { class, view: -1, unplaced: false, owner_unplaced: false, owner_class: None, hidden: false, category: None, family_document: false, family_definition: false, family_chain: false }
    }

    #[test]
    fn les_objets_du_batiment_se_dessinent() {
        for class in ["SWall", "Floor", "Ceiling", "FamilyInstance", "StairsElement", "StairsRun", "BaseRailing", "TopRail", "SiteSurface", "BuildingPad", "RbsDuctCurve", "FormElem", "ExtrusionElem", "Text3dElem"] {
            assert_eq!(excluded(&facts(class)), None, "{class}");
        }
    }

    #[test]
    fn ce_qui_n_est_pas_un_objet_s_ecarte() {
        for class in ["FamilySymbol", "SysPanelFamSym", "BaseRailingSym", "RoomElem", "Level", "Grid", "AnalyticalPanel", "RefPlane", "CurveElem", "ModelClipBox"] {
            assert!(excluded_class(class).is_some(), "{class}");
        }
    }

    #[test]
    fn les_relations_ecartent_ce_que_revit_ne_montre_pas() {
        let wall = facts("SWall");
        assert_eq!(excluded(&Facts { unplaced: true, ..wall }), Some(RELATION_REASONS[0]));
        // Un membre d'un élément qui vit dans une définition de groupe en est un aussi.
        assert_eq!(excluded(&Facts { owner_unplaced: true, ..wall }), Some(RELATION_REASONS[0]));
        assert_eq!(excluded(&Facts { hidden: true, ..facts("FamilyInstance") }), Some(RELATION_REASONS[1]));
        assert_eq!(excluded(&Facts { owner_class: Some("BaseRailingSym"), ..facts("FamilyInstance") }), Some(RELATION_REASONS[2]));
        assert_eq!(excluded(&Facts { owner_class: Some("ElementGroupType"), ..facts("Floor") }), Some(RELATION_REASONS[2]));
        assert_eq!(excluded(&Facts { view: 1234, ..facts("FamilyInstance") }), Some(RELATION_REASONS[3]));
        // Un membre d'un groupe placé, d'un mur rideau ou d'un escalier reste un objet du modèle.
        assert_eq!(excluded(&Facts { owner_class: Some("ElementGroup"), ..facts("Floor") }), None);
        assert_eq!(excluded(&Facts { owner_class: Some("SWall"), ..facts("FamilyInstance") }), None);
        assert_eq!(excluded(&Facts { owner_class: Some("Family"), ..facts("SWall") }), None);
        // La définition d'une famille chargée (avant 2015) : sa raison vient après les autres.
        assert_eq!(excluded(&Facts { family_definition: true, ..facts("ExtrusionElem") }), Some(RELATION_REASONS[6]));
        assert_eq!(excluded(&Facts { family_definition: true, hidden: true, ..facts("ExtrusionElem") }), Some(RELATION_REASONS[1]));
        assert_eq!(RELATION_REASONS[6], "définition d'une famille chargée");
        // La même famille atteinte par des intermédiaires (un groupe de modèle dans la famille) : écartée aussi, raison à part, et
        // après les autres raisons comme la définition directe.
        assert_eq!(excluded(&Facts { family_chain: true, ..facts("FamilyInstance") }), Some(RELATION_REASONS[7]));
        assert_eq!(excluded(&Facts { family_chain: true, hidden: true, ..facts("FamilyInstance") }), Some(RELATION_REASONS[1]));
        assert_eq!(RELATION_REASONS[7], "pièce d'une famille chargée, par des intermédiaires");
    }

    #[test]
    fn les_classes_de_la_spec_des_categories_ne_sont_pas_ecartees_pour_leur_categorie() {
        // `Scene::category` donne à ces classes la catégorie de la table des classes (leurs enregistrements n'en portent pas) : aucune
        // n'est une catégorie d'annotation, interne ou analytique, ni OST_Mass, dans un projet comme dans une famille.
        for class in ["ProfileRoof", "FaceRoof", "ContFooting", "Stairs", "FaceWall", "ArcWall", "CurtaSystem"] {
            let category = crate::catalog::class_category(class).unwrap_or_else(|| panic!("{class} est dans la table des classes")).id;
            for family_document in [false, true] {
                assert_eq!(excluded(&Facts { category: Some(category), family_document, ..facts(class) }), None, "{class}");
            }
        }
        // Le sol de masse (OST_MassFloor) n'est pas la masse : la règle des masses ne l'atteint pas.
        let mass_floor = crate::catalog::category_by_ost("OST_MassFloor").expect("sol de masse").id;
        assert_eq!(excluded(&Facts { category: Some(mass_floor), ..facts("MassLevelData") }), None);
    }

    #[test]
    fn les_categories_d_annotation_et_les_masses_s_ecartent() {
        let by_ost = |ost: &str| crate::catalog::category_by_ost(ost).expect(ost).id;
        let instance = facts("FamilyInstance");
        assert_eq!(excluded(&Facts { category: Some(by_ost("OST_GenericAnnotation")), ..instance }), Some(RELATION_REASONS[4]));
        assert_eq!(excluded(&Facts { category: Some(by_ost("OST_Mass")), ..instance }), Some(RELATION_REASONS[5]));
        // Dans une famille (.rfa), les formes d'une masse sont la famille : elles se dessinent.
        assert_eq!(excluded(&Facts { category: Some(by_ost("OST_Mass")), family_document: true, ..instance }), None);
        assert_eq!(excluded(&Facts { category: Some(by_ost("OST_GenericAnnotation")), family_document: true, ..instance }), Some(RELATION_REASONS[4]));
        assert_eq!(excluded(&Facts { category: Some(by_ost("OST_Walls")), ..instance }), None);
    }
}
