//! Quels nœuds d'un graphe graphique se dessinent dans une vue 3D ombrée par défaut.
//!
//! C'est le parcours de `rvt::research::native_graphics_traversal` (Apache-2.0 : mêmes nœuds, mêmes
//! transformations, mêmes filtres de direction, de niveau de détail et de type de vue, même niveau de
//! détail 3 pour le viewport 3D par défaut), repris ici parce que rvt-rs s'arrête, avec un diagnostic, sur
//! des nœuds que les fichiers d'essai rendent tous lisibles : un élément qui en porte devenait « forme
//! partielle » ou, quand le nœud était la racine, une simple boîte. Chaque règle ajoutée ci-dessous est
//! justifiée par les octets des fichiers d'essai (`examples/graph.rs --classes` les recense), et aucune ne
//! fait disparaître une surface sans le dire : quand les octets ne permettent pas de trancher, le nœud
//! reste un diagnostic, comme chez rvt-rs.
//!
//! * `GBiFlipControl`, `GFlipControl` : les flèches de retournement que Revit affiche à la sélection
//!   (`m_base`, `m_length` en pixels, `m_origin`, aucun enfant). Ce ne sont pas des surfaces, et pas une
//!   transformation : le miroir d'une instance est dans sa matrice `m_Trf`, que `transform` retourne.
//! * `GImposter` : l'image d'un contenu RPC (arbres, personnages), dont l'actif est un pointeur nul
//!   (`m_oAsset.pointer_token` = 0xFFFFFFFF dans les 5 nœuds d'essai) : rien à dessiner. Le contenu 3D du
//!   même symbole est un `GPolyMesh` voisin, que Revit dessine en vue ombrée : il se dessine comme les autres, mais
//!   marqué « surcouche » (`Selected::overlay`) : ce voisin est la silhouette et l'empreinte au sol de l'arbre, dont
//!   les triangles horizontaux sont dans le plan de la face supérieure du sol (14 triangles à −6,53 m, celle de la dalle
//!   575046 de `wadduwa.rvt`), et que Revit montre pourtant par-dessus. Le lecteur le dit au viewer (un octet de plus par
//!   matériau) qui le dessine avec un décalage de profondeur : les deux surfaces coplanaires ne se disputent plus.
//! * `GInstance` à `m_bHasScale` vrai : rvt-rs refuse. Le drapeau dit qu'une échelle peut s'appliquer à l'instance, et l'échelle est
//!   dans la matrice 3 × 3 de `InstanceInfo.m_Trf` (aucun autre champ d'`InstanceInfo` n'en porte). Ce que les octets montrent : les
//!   blocs des DWG importées de `wadduwa.rvt` (« Peugeot 208.DWG », « Citroen C4.DWG » : 17 et 9 instances, de matrice identité ; un bloc
//!   d'un autre import à 25,4 et un à 2 413,27), des blocs à 0,125 chez `rac_advanced` et `mega_advanced`. Toutes ces matrices sont une rotation
//!   (ou un miroir) multipliée par un nombre : colonnes orthogonales et de même longueur, à 1e-9 près ([`uniform_scale`]). Une telle
//!   instance se place comme toute autre : le symbole est maillé dans ses unités (`faces::decode`, une fois pour toutes ses instances),
//!   puis ses sommets passent par la matrice et ses normales par l'inverse transposée, renormalisées (`faces::transform`, comme pour un
//!   miroir) ; une condition de direction se lit sur la direction de la matrice, sans son échelle (`direction_condition`). Une matrice qui
//!   n'est pas une échelle uniforme (étirement, cisaillement) n'a pas de lecture établie : un symbole sans surface n'a rien à perdre et
//!   l'instance se saute, comme une instance à cibles interdites (voir ci-dessous) ; un symbole qui porte des surfaces reste un diagnostic
//!   (« instance à échelle non uniforme non prise en charge »). Un drapeau absent reste refusé.
//!   Les imports CAD du projet (`ImportInstance`) n'ont aucune exception : leurs blocs à échelle (les plans DWG de `wadduwa.rvt` à 25,4, 75 ou 2 413,27) se
//!   placent comme les autres, et c'est le dessin de ces éléments qui est réglé à part (priorité de profondeur, `pack::Depth`).
//! * Le style d'une surface sans matériau : un `GPolyMesh` d'une DWG importée a `m_materialID` et `m_interiorGStyleID` à −1,
//!   et c'est le `GGroup` du calque (`GInfo.m_categoryId` : un `GStyleElem`) qui porte le style, dont le matériau donne la
//!   couleur (`Selected::layer`). Voir `geometry::materials`.
//! * `GComponentRef` : la référence, dans la famille hôte, à une instance imbriquée (le pieu d'une
//!   semelle sur pieux). Cette instance est un élément à part entière du modèle, avec son propre graphique
//!   et ses propres règles de visibilité (invisible, groupe, vue) : elle se dessine par elle-même, la
//!   redessiner ici la doublerait. Les cibles sont notées (`Selection::components`) pour qu'un essai
//!   vérifie que chacune est un élément dessiné ou une forme sans surface.
//! * `GInstance` à cibles interdites (`m_forbiddenTarget.m_targets` ≠ 0) : rvt-rs refuse toute valeur non nulle. Les
//!   fichiers d'essai en portent trois sortes (`examples/graph.rs --classes`, `examples/census.rs` partie 4) :
//!   - `10` (bits 1 et 3), sur 1 021 instances, toutes de visibilité 0 et toutes seules dans le graphe de leur élément
//!     (`GElement` → `GInstance`, 3 objets) : les 880 coussins ETFE de Vignette-04 (composants adaptatifs ; un symbole
//!     propre par instance, 880 symboles distincts, dont la face est une surface réglée entre deux droites qui passent par
//!     les points adaptatifs ; les panneaux de toiture qui les portent les citent par `GComponentRef`, ce qui les laisse
//!     se dessiner par eux-mêmes), les 120 chaises M_Chair-Breuer de `rac_advanced` et de `mega_advanced` (un symbole
//!     commun, cinq corps de 10 à 16 faces dans la branche 3D du symbole) et les 21 symboles de plan d'appareils
//!     électriques de RE1-Electrical (des lignes seulement, rien à dessiner). Ce sont des éléments à part entière
//!     (mobilier, modèles génériques) dont Revit montre la forme en vue 3D, et cette forme est celle du symbole que
//!     l'instance place : la boîte serrée de chaque chaise (`m_tightbBox`) est l'étendue du maillage du symbole placé (à
//!     5 mm près), la boîte enregistrée de chaque coussin est celle de son symbole déplacé par la matrice de l'instance
//!     (à 1 mm près, 880 sur 880 : Revit n'y met pas ses surfaces, elle dépasse le maillage de plus d'un mètre) et le
//!     maillage y tient (`tests/legacy.rs`). Ce n'est pas un doublon : aucun autre élément ne place le symbole d'un
//!     coussin ; celui des chaises l'est aussi, sans cibles interdites, par 48 autres chaises M_Chair-Breuer de
//!     `rac_advanced` (même famille, même symbole : le masque ne change pas ce qui se dessine) ; aucun élément ne dessine
//!     les mêmes triangles (`Stats::identical` est nul sur Vignette-04 ; les éléments dont la boîte recouvre celle d'un
//!     coussin sont son panneau de toiture et des dalles). Interdire les cibles 1 et 3 n'interdit donc pas la vue 3D ombrée, et un masque qui n'interdit
//!     que des cibles de `0b1010` non plus (`DRAWN_TARGETS`) ;
//!   - `0xCFFE` (53 246) et `0x8FFE` (36 862), qui interdisent presque toutes les cibles (bits 1 à 11, 14 et 15) : ils ne
//!     se trouvent que sur des instances de visibilité 1, que le drapeau de visibilité du nœud (déjà géré) écarte, ou
//!     dans des éléments qui ne se dessinent pas (définitions de groupe). Ce que ces masques font d'une instance
//!     visible n'est pas établi : elle reste un diagnostic quand son symbole porte des surfaces, et se saute sinon.
//! * `GInstance` à `m_resolveSymInView` vrai : rvt-rs refuse. Un symbole résolu « dans la vue » n'a rien à résoudre quand
//!   son graphe ne contient aucune condition (`GFilter` sans condition) : le résultat ne peut pas dépendre de la vue. Les
//!   seules instances visibles des fichiers d'essai (8 par fichier : les murs « Parapet Wall » de `rac_advanced` et de
//!   `mega_advanced`) placent un balayage de mur (192754 et ses sept voisins : une racine et un seul nœud `Geometry`, classe
//!   `WallSweep`), qui est un élément à part entière du modèle, avec sa fiche et son identifiant : comme une instance imbriquée
//!   (`GComponentRef`), il se dessine par lui-même et le mur ne le redessine pas (`Selection::components`). La boîte serrée du mur
//!   contient celle du balayage (38,81 à 39,59 pieds de haut, sur 37,40 à 39,59 pour le mur) : Revit l'y compte. Un symbole qui
//!   contient des conditions reste un diagnostic. Les 483 autres instances (de visibilité 1) sont écartées par le drapeau de
//!   visibilité. Ce n'est pas la règle des volées d'escalier ou de la lisse d'un garde-corps, dont l'instance n'est pas résolue
//!   dans la vue et dont la forme se dessine par leur hôte (`geometry::from_saved`, `referenced`).
//! * `GGTag` : un groupe « étiqueté » (identifiant de sélection `m_tag`, point d'essai du modèle). Ses enfants dans les
//!   fichiers d'essai sont des flèches de retournement (8), des pastilles `GBitmap` (448, de 10 × 10 pixels sur les
//!   poignées de sommets d'une toiture de face), des points (402 `GPoint`), du texte (41 `GText`) et, dans une famille, des
//!   filtres (18) : le nœud se visite comme un `GGroup`. `GBitmap` (point, taille en pixels) et `GText` (fragments de texte,
//!   taille d'écran fixe) sont des surcouches 2D sans surface, comme les lignes et les points.
//! * `GFilter` « famille de détail imbriquée » : de la géométrie de détail (2D : arcs de battement de
//!   porte, régions remplies), que Revit ne montre que dans les vues dont la direction correspond (plan,
//!   élévation, coupe : comparaisons 6 et 7, fausses dans une vue 3D). Leurs conditions s'évaluent comme
//!   celles de tout filtre ; une surface atteinte sans qu'aucune condition de vue ne l'ait rejetée reste
//!   un diagnostic.
//!
//! ## La forme d'un symbole, parcourue une fois
//!
//! Le graphe décodé d'un symbole de famille coûte 60 à 140 fois son enregistrement (chaque nombre devient une
//! valeur JSON) : les 707 symboles que place `rac_advanced_sample_project.rvt` pèsent 1 Go, gardés pendant tout
//! le maillage pour que chaque instance les parcoure. Or le parcours d'un symbole ne dépend de l'instance que
//! par sa matrice, et seulement dans les conditions de direction d'un filtre (`GConditionDir`, comparaisons
//! autres que 6 à 8). [`symbol_shape`] parcourt donc un symbole pour lui-même, avec la matrice identité, et en
//! garde une [`SymbolShape`] : les nœuds sélectionnés (dans le symbole et dans ceux qu'il place), chacun avec la
//! chaîne des transformations d'instance qui y mène, les diagnostics et les composants, dans l'ordre du parcours.
//! Placer une instance rejoue ces événements avec la matrice de l'instance, exactement comme le parcours l'aurait
//! fait (les produits de matrices sont faits dans le même ordre : même résultat bit à bit). Le graphe du symbole
//! peut alors être libéré. Un symbole dont une condition de direction dépend de la matrice n'a pas de forme :
//! son graphe reste, et chaque instance le parcourt comme avant.

use std::collections::HashSet;
use std::sync::Arc;

use rvt::research::native_graphics_traversal::GraphicsTransform;
use rvt::research::native_parameters::ObjectGraph;
use serde_json::Value;

use super::graph::identifier;
use crate::geometry::pack::FxMap;

/// Les cibles qu'une instance peut interdire sans que sa forme disparaisse d'une vue 3D ombrée : les bits 1 et 3 (voir
/// l'en-tête du module, masque 10 de 1 021 instances visibles dont les symboles sont la forme de leur élément).
const DRAWN_TARGETS: u64 = 0b1010;

/// Les refus d'une instance à cibles interdites ou à échelle dont le symbole porte des surfaces.
const RESTRICTED_REFUSAL: &str = "instance à cibles interdites dont le symbole porte des surfaces";
/// Le drapeau `m_bHasScale` est absent.
const SCALE_REFUSAL: &str = "instance à échelle non prise en charge";
const NON_UNIFORM_REFUSAL: &str = "instance à échelle non uniforme non prise en charge";

/// Le diagnostic d'une instance qui n'est pas placée (cibles interdites avant l'échelle) : `None` quand elle se place.
fn refusal(restricted: bool, scaled: Option<&'static str>) -> Option<&'static str> {
    if restricted { Some(RESTRICTED_REFUSAL) } else { scaled }
}

const IDENTITY: GraphicsTransform = [[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., 0.], [0., 0., 0., 1.]];

/// Les arêtes d'un graphe par (objet source, décalage du pointeur, jeton) ; `None` quand deux arêtes
/// portent la même clé (ambiguïté : le pointeur est refusé).
pub type EdgeIndex = FxMap<(usize, usize, u64), Option<usize>>;

/// Construit l'index des arêtes d'un graphe.
pub fn edge_index(graph: &ObjectGraph) -> EdgeIndex {
    let mut index = EdgeIndex::default();
    for (i, edge) in graph.edges.iter().enumerate() {
        let key = (edge.source_object_index, edge.pointer_offset, u64::from(edge.pointer_token));
        index.entry(key).and_modify(|slot| *slot = None).or_insert(Some(i));
    }
    index
}

/// Un nœud `Geometry` ou `GPolyMesh` à dessiner, avec sa transformation vers le repère du modèle.
#[derive(Debug, Clone)]
pub struct Selected {
    pub object_index: usize,
    /// `None` : le graphe de l'élément ; `Some` : celui du symbole de famille que l'instance place.
    pub source_owner_id: Option<u64>,
    pub world_transform: GraphicsTransform,
    /// Le `GPolyMesh` est le voisin d'un `GImposter` (l'image d'un contenu RPC) : surcouche à dessiner par-dessus les
    /// surfaces coplanaires (voir l'en-tête du module).
    pub overlay: bool,
    /// Un `GPolyMesh` : le `GStyleElem` (`GInfo.m_categoryId`) du groupe, du filtre ou du symbole le plus proche qui en a un,
    /// dans le même graphe ; `-1` s'il n'y en a pas, et pour tout autre nœud.
    pub layer: i64,
}

/// Ce que le parcours retient.
#[derive(Debug, Default)]
pub struct Selection {
    pub selected: Vec<Selected>,
    /// (indice d'objet, message) : ce que le parcours n'a pas compris.
    pub diagnostics: Vec<(usize, String)>,
    /// Instances imbriquées (cibles des `GComponentRef`) que l'élément n'a pas à redessiner.
    pub components: Vec<u64>,
    /// Les instances d'un symbole que le parcours n'avait pas encore (ni forme, ni graphe) et qu'il a laissées pour
    /// plus tard (`defer`), dans l'ordre du parcours : chacune se rejoue par [`place_pending`], à sa place.
    pub pending: Vec<Pending>,
}

/// Une instance laissée pour plus tard : tout ce qu'il faut pour reprendre le parcours à ce nœud, exactement comme
/// s'il avait eu le symbole sous la main.
#[derive(Debug, Clone)]
pub struct Pending {
    pub symbol: u64,
    pub object_index: usize,
    /// Le repère du nœud `GInstance` et la transformation de l'instance : le symbole se place dans `matrix × transform`.
    pub matrix: GraphicsTransform,
    pub transform: GraphicsTransform,
    pub depth: usize,
    pub detail_family: usize,
    pub restricted: bool,
    /// `m_bHasScale` vrai et matrice qui n'est pas une échelle uniforme : le diagnostic qu'elle donne si son symbole porte des surfaces ;
    /// l'instance se saute sinon.
    pub scaled: Option<&'static str>,
    pub view_resolved: bool,
    pub visits: usize,
    /// Où insérer, dans `selected`, `diagnostics` et `components`, ce que le placement produit.
    pub selected_at: usize,
    pub diagnostics_at: usize,
    pub components_at: usize,
}

/// Un événement du parcours d'un symbole, rejoué pour chacune de ses instances (voir [`SymbolShape`]).
#[derive(Debug, Clone)]
pub enum ShapeEvent {
    /// Un nœud `Geometry` ou `GPolyMesh` sélectionné : le symbole dont le graphe le porte, son indice d'objet,
    /// les transformations d'instance traversées depuis la racine du symbole, dans l'ordre (vide pour un nœud
    /// du symbole lui-même), et ce que `Selected` dit de la surcouche et du style.
    Node { owner: u64, object_index: usize, chain: Vec<GraphicsTransform>, overlay: bool, layer: i64 },
    /// Un diagnostic du parcours (indice d'objet, message).
    Diagnostic(usize, String),
}

/// La forme d'un symbole de famille : ce que son parcours sélectionne, indépendamment de l'instance qui le
/// place (voir l'en-tête du module). Calculée par [`symbol_shape`], gardée par `cache::FaceCache`.
#[derive(Debug, Default)]
pub struct SymbolShape {
    /// Les nœuds sélectionnés et les diagnostics, dans l'ordre du parcours.
    pub events: Vec<ShapeEvent>,
    /// Instances imbriquées référencées (`GComponentRef`), dans l'ordre.
    pub components: Vec<u64>,
    /// Nœuds visités par le parcours du symbole (ils comptent dans le budget du parcours de l'instance).
    pub visits: usize,
    /// Le symbole peut dessiner une surface (voir `Walker::bears_surface`) : décide le sort d'une instance à
    /// cibles interdites.
    pub bears_surface: bool,
    /// Le symbole dépend de la vue (voir `Walker::depends_on_view`) : décide le sort d'une instance résolue dans la vue.
    pub depends_on_view: bool,
}

/// Parcourt le graphe `root` (et ceux des symboles qu'il place, par `resolver`) pour le niveau de détail
/// `detail_level` (1 à 3). `edges(propriétaire, graphe)` rend l'index des arêtes d'un graphe de symbole,
/// que l'appelant peut garder d'une instance à l'autre ; `shapes(symbole)` rend la forme déjà parcourue d'un
/// symbole ([`SymbolShape`]), qui dispense de son graphe.
pub fn select<'a>(root: &'a ObjectGraph, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, edges: &dyn Fn(u64, &ObjectGraph) -> Arc<EdgeIndex>, shapes: &dyn Fn(u64) -> Option<Arc<SymbolShape>>, detail_level: i64) -> Selection {
    select_deferring(root, resolver, edges, shapes, detail_level, false)
}

/// [`select`], et, si `defer` est vrai, une instance d'un symbole qu'on n'a pas encore (ni forme, ni graphe) est
/// notée dans `Selection::pending` au lieu d'un diagnostic « graphique du symbole absent » : elle se rejouera par
/// [`place_pending`] quand le symbole sera lu.
pub fn select_deferring<'a>(root: &'a ObjectGraph, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, edges: &dyn Fn(u64, &ObjectGraph) -> Arc<EdgeIndex>, shapes: &dyn Fn(u64) -> Option<Arc<SymbolShape>>, detail_level: i64, defer: bool) -> Selection {
    let mut walk = Walker {
        view: View { graph: root, edges: Arc::new(edge_index(root)) },
        resolver,
        edges,
        shapes,
        detail_level,
        source_owner_id: None,
        ancestry: Vec::new(),
        detail_family: 0,
        result: Selection::default(),
        visits: 0,
        chain: Vec::new(),
        log: None,
        matrix_sensitive: false,
        defer,
        overlay_child: None,
        layer: -1,
    };
    if !(1..=3).contains(&detail_level) {
        walk.fail(0, "niveau de détail hors de 1 à 3");
    } else if root.objects.is_empty() {
        walk.fail(0, "graphe graphique vide");
    } else {
        walk.visit(0, IDENTITY, 0);
    }
    walk.result
}

/// Rejoue une instance laissée pour plus tard (`Selection::pending`), maintenant que son symbole est lu (sa forme
/// par `shapes`, ou son graphe par `resolver`) : ce que `select` aurait sélectionné et diagnostiqué à ce nœud, dans
/// l'ordre, à insérer aux places que `pending` indique.
pub fn place_pending<'a>(pending: &Pending, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, edges: &dyn Fn(u64, &ObjectGraph) -> Arc<EdgeIndex>, shapes: &dyn Fn(u64) -> Option<Arc<SymbolShape>>, detail_level: i64) -> Selection {
    // Un graphe vide : le parcours ne s'y arrête jamais (le nœud est celui de l'élément, déjà vu) ; la vue n'est
    // remplacée que si le symbole a un graphe.
    let mut walk = Walker {
        view: View { graph: empty_graph(), edges: Arc::new(EdgeIndex::default()) },
        resolver,
        edges,
        shapes,
        detail_level,
        source_owner_id: None,
        ancestry: Vec::new(),
        detail_family: pending.detail_family,
        result: Selection::default(),
        visits: pending.visits,
        chain: Vec::new(),
        log: None,
        matrix_sensitive: false,
        defer: false,
        overlay_child: None,
        layer: -1,
    };
    if let Err(message) = walk.enter_symbol(pending.symbol, pending.restricted, pending.scaled, pending.view_resolved, pending.matrix, pending.transform, pending.depth) {
        walk.fail(pending.object_index, &message);
    }
    walk.result
}

/// Un graphe sans objet (les champs de `ObjectGraph` ne se construisent que par rvt-rs : par sa désérialisation).
pub fn empty_graph() -> &'static ObjectGraph {
    static EMPTY: std::sync::OnceLock<ObjectGraph> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| serde_json::from_str(r#"{"consumed_bytes":0,"objects":[],"edges":[]}"#).expect("graphe vide"))
}

/// Parcourt le graphe `graph` du symbole `symbol` pour lui-même, avec la matrice identité, et rend sa forme :
/// ce que `select` sélectionnerait dans ce symbole pour n'importe quelle instance. `None` quand la forme dépend
/// de l'instance (une condition de direction a été évaluée), quand la racine n'est pas celle du symbole, ou hors
/// des niveaux de détail 1 à 3 : le graphe doit alors être gardé et parcouru à chaque instance.
///
/// Un symbole imbriqué dont la forme est connue (`shapes`) est rejoué ; sinon son graphe (`resolver`) est
/// parcouru. Le budget du parcours (100 000 visites) et le plafond de profondeur se comptent à partir de la racine
/// du symbole, comme si l'instance était à la racine de son élément.
pub fn symbol_shape<'a>(graph: &'a ObjectGraph, symbol: u64, resolver: &dyn Fn(u64) -> Option<&'a ObjectGraph>, edges: &dyn Fn(u64, &ObjectGraph) -> Arc<EdgeIndex>, shapes: &dyn Fn(u64) -> Option<Arc<SymbolShape>>, detail_level: i64) -> Option<SymbolShape> {
    let root = graph.objects.first()?;
    if !(1..=3).contains(&detail_level) || !owner_matches(root, symbol) {
        return None;
    }
    let mut walk = Walker {
        view: View { graph, edges: Arc::new(edge_index(graph)) },
        resolver,
        edges,
        shapes,
        detail_level,
        source_owner_id: Some(symbol),
        ancestry: Vec::new(),
        detail_family: 0,
        result: Selection::default(),
        visits: 0,
        chain: Vec::new(),
        log: Some(Vec::new()),
        matrix_sensitive: false,
        defer: false,
        overlay_child: None,
        layer: -1,
    };
    walk.visit(0, IDENTITY, 1);
    if walk.matrix_sensitive {
        return None;
    }
    let view = walk.view.clone();
    let bears_surface = walk.bears_surface(&view, 0, &mut HashSet::new(), &mut 0);
    let depends_on_view = walk.depends_on_view(&view, 0, &mut HashSet::new(), &mut 0);
    Some(SymbolShape { events: walk.log.take().unwrap_or_default(), components: walk.result.components, visits: walk.visits, bears_surface, depends_on_view })
}

/// Un graphe et l'index de ses arêtes.
#[derive(Clone)]
struct View<'a> {
    graph: &'a ObjectGraph,
    edges: Arc<EdgeIndex>,
}

impl View<'_> {
    /// L'objet que désigne le pointeur `value` du champ d'un objet `source`. Les pointeurs nuls ou
    /// externes, ambigus ou dont la classe ne concorde pas sont refusés.
    fn target(&self, source: usize, value: &Value) -> Result<usize, String> {
        let offset = value["offset"].as_u64().ok_or("décalage de pointeur absent")? as usize;
        let token = value["pointer_token"].as_u64().ok_or("jeton de pointeur absent")?;
        let slot = self.edges.get(&(source, offset, token)).ok_or("pointeur graphique nul ou externe")?;
        let edge = &self.graph.edges[slot.ok_or("arête graphique ambiguë")?];
        let target = self.graph.objects.get(edge.target_object_index).ok_or("cible d'arête hors du graphe")?;
        if edge.target_class_tag != target.class_tag || value["class_tag"].as_u64().is_some_and(|tag| tag != u64::from(target.class_tag)) {
            return Err("classe de l'arête graphique discordante".into());
        }
        Ok(edge.target_object_index)
    }

    fn children(&self, index: usize) -> Result<Vec<usize>, String> {
        self.graph.objects[index].fields["m_subNodes"].as_array().ok_or("enfants graphiques absents")?.iter().map(|pointer| self.target(index, pointer)).collect()
    }
}

struct Walker<'a, 'r> {
    view: View<'a>,
    resolver: &'r dyn Fn(u64) -> Option<&'a ObjectGraph>,
    edges: &'r dyn Fn(u64, &ObjectGraph) -> Arc<EdgeIndex>,
    shapes: &'r dyn Fn(u64) -> Option<Arc<SymbolShape>>,
    source_owner_id: Option<u64>,
    detail_level: i64,
    ancestry: Vec<(Option<u64>, usize)>,
    /// Profondeur de filtres « famille de détail imbriquée » ouverts au-dessus du nœud visité.
    detail_family: usize,
    result: Selection,
    visits: usize,
    /// Les transformations d'instance traversées depuis la racine, dans l'ordre (pour `log`).
    chain: Vec<GraphicsTransform>,
    /// Le journal des événements, quand le parcours est celui d'un symbole pour lui-même (`symbol_shape`).
    log: Option<Vec<ShapeEvent>>,
    /// Une condition de direction a été évaluée : la sélection dépend de la matrice de l'instance.
    matrix_sensitive: bool,
    /// Laisser pour plus tard les instances d'un symbole qu'on n'a pas encore (voir `select_deferring`).
    defer: bool,
    /// Le `GPolyMesh` que le parcours va visiter est le voisin d'un `GImposter` (voir `Selected::overlay`).
    overlay_child: Option<usize>,
    /// `GInfo.m_categoryId` du conteneur le plus proche qui en a un, dans le graphe visité (`-1` : aucun ; voir `Selected::layer`).
    layer: i64,
}

impl<'a> Walker<'a, '_> {
    fn fail(&mut self, index: usize, message: &str) {
        self.result.diagnostics.push((index, message.into()));
        if let Some(log) = &mut self.log {
            log.push(ShapeEvent::Diagnostic(index, message.into()));
        }
    }

    /// Un nœud `Geometry` ou `GPolyMesh` sélectionné, dans le repère `matrix`.
    fn keep(&mut self, index: usize, matrix: GraphicsTransform) {
        let is_poly_mesh = self.view.graph.objects[index].class_name == "GPolyMesh";
        let overlay = is_poly_mesh && self.overlay_child == Some(index);
        let layer = if is_poly_mesh { self.layer } else { -1 };
        self.result.selected.push(Selected { object_index: index, source_owner_id: self.source_owner_id, world_transform: matrix, overlay, layer });
        if let Some(log) = &mut self.log {
            log.push(ShapeEvent::Node { owner: self.source_owner_id.unwrap_or(0), object_index: index, chain: self.chain.clone(), overlay, layer });
        }
    }

    /// Rejoue la forme d'un symbole pour une instance placée par `transform` dans le repère `matrix` : ce que
    /// `visit(0, matrix × transform)` sur le graphe du symbole aurait sélectionné et diagnostiqué, dans le même
    /// ordre et avec les mêmes produits de matrices.
    fn place(&mut self, symbol: u64, shape: &SymbolShape, matrix: GraphicsTransform, transform: GraphicsTransform, depth: usize) {
        if self.visits + shape.visits > 100_000 || depth >= 128 {
            self.visits += 1;
            self.fail(0, "limite de ressources du parcours graphique");
            return;
        }
        if self.ancestry.contains(&(Some(symbol), 0)) {
            self.visits += 1;
            self.fail(0, "cycle dans les références graphiques");
            return;
        }
        self.visits += shape.visits;
        let placed = multiply(matrix, transform);
        for event in &shape.events {
            match event {
                ShapeEvent::Node { owner, object_index, chain, overlay, layer } => {
                    if self.detail_family > 0 {
                        self.fail(*object_index, "géométrie d'une famille de détail imbriquée qu'aucune condition de vue n'a écartée");
                        continue;
                    }
                    let world = chain.iter().fold(placed, |m, t| multiply(m, *t));
                    self.result.selected.push(Selected { object_index: *object_index, source_owner_id: Some(*owner), world_transform: world, overlay: *overlay, layer: *layer });
                    if let Some(log) = &mut self.log {
                        let mut full = self.chain.clone();
                        full.push(transform);
                        full.extend(chain.iter().copied());
                        log.push(ShapeEvent::Node { owner: *owner, object_index: *object_index, chain: full, overlay: *overlay, layer: *layer });
                    }
                }
                ShapeEvent::Diagnostic(index, message) => self.fail(*index, message),
            }
        }
        self.result.components.extend(shape.components.iter().copied());
    }

    /// Le graphe et l'index du symbole `symbol`, après avoir vérifié que c'est bien le sien (racine
    /// `GElement` dont l'identifiant est `symbol`).
    fn symbol(&self, symbol: u64) -> Result<View<'a>, String> {
        let graph = (self.resolver)(symbol).ok_or_else(|| format!("graphique du symbole {symbol} absent"))?;
        let root = graph.objects.first().ok_or("graphique du symbole vide")?;
        if !owner_matches(root, symbol) {
            return Err("propriétaire du graphique du symbole discordant".into());
        }
        Ok(View { graph, edges: (self.edges)(symbol, graph) })
    }

    fn visit(&mut self, index: usize, matrix: GraphicsTransform, depth: usize) {
        self.visits += 1;
        if self.visits > 100_000 || depth >= 128 {
            self.fail(index, "limite de ressources du parcours graphique");
            return;
        }
        if self.ancestry.contains(&(self.source_owner_id, index)) {
            self.fail(index, "cycle dans les références graphiques");
            return;
        }
        self.ancestry.push((self.source_owner_id, index));
        if let Err(message) = self.visit_inner(index, matrix, depth) {
            self.fail(index, &message);
        }
        self.ancestry.pop();
    }

    fn visit_inner(&mut self, index: usize, matrix: GraphicsTransform, depth: usize) -> Result<(), String> {
        let graph = self.view.graph;
        let object = &graph.objects[index];
        // Visibilité d'un nœud de groupe : 0 et 2 se dessinent, 1 et 3 ne le sont que dans le mode de
        // dessin spécial 7 (la vue par défaut est en mode normal).
        if let Some(flags) = object.fields["m_GInfo"]["m_flags"].as_u64() {
            if matches!(graphics_visibility(flags), 1 | 3) {
                return Ok(());
            }
        }
        match object.class_name.as_str() {
            "Geometry" | "GPolyMesh" => {
                if self.detail_family > 0 {
                    return Err("géométrie d'une famille de détail imbriquée qu'aucune condition de vue n'a écartée".into());
                }
                self.keep(index, matrix);
            }
            "GElement" | "GGroup" | "GFilter" | "GGTag" => {
                let children = self.view.children(index)?;
                let nested = object.class_name == "GFilter" && object.fields["m_bIsNestedDetailFamily"].as_bool() == Some(true);
                if object.class_name == "GFilter" {
                    if children.is_empty() {
                        return Ok(());
                    }
                    // Les courbes ne se dessinent pas (le viewer ne trace que des triangles).
                    if children.iter().all(|&child| self.only_curves(&self.view, child, &mut HashSet::new())) {
                        return Ok(());
                    }
                    let conditions = object.fields["m_oConditions"].as_array().ok_or("conditions du filtre absentes")?;
                    let mut unknown = None;
                    for pointer in conditions {
                        let condition = self.view.target(index, pointer)?;
                        let condition = &graph.objects[condition];
                        let directional = matches!(condition.class_name.as_str(), "GConditionDir" | "GConditionCut");
                        // Les comparaisons 6 à 8 ne lisent pas la matrice ; toute autre rend la sélection propre à l'instance.
                        if directional && !matches!(condition.fields["m_comp"].as_i64(), Some(6..=8)) {
                            self.matrix_sensitive = true;
                        }
                        let answer = if directional { direction_condition(&condition.fields, matrix) } else { condition_at_detail(&condition.class_name, &condition.fields, self.detail_level) };
                        match answer {
                            Ok(false) => return Ok(()),
                            Ok(true) => {}
                            Err(error) => unknown = Some(error),
                        }
                    }
                    if let Some(error) = unknown {
                        return Err(error);
                    }
                }
                // Le voisin d'un imposteur (le contenu RPC) est une surcouche ; le style du conteneur est celui des `GPolyMesh` qu'il porte.
                let has_imposter = children.iter().any(|&child| graph.objects[child].class_name == "GImposter");
                let previous_layer = self.layer;
                if let Some(style) = identifier(&object.fields["m_GInfo"]["m_categoryId"]).filter(|style| *style >= 0) {
                    self.layer = style;
                }
                self.detail_family += usize::from(nested);
                for child in children {
                    self.overlay_child = (has_imposter && graph.objects[child].class_name == "GPolyMesh").then_some(child);
                    self.visit(child, matrix, depth + 1);
                }
                self.overlay_child = None;
                self.detail_family -= usize::from(nested);
                self.layer = previous_layer;
            }
            "GComponentRef" => {
                let info = self.view.target(index, &object.fields["m_instanceInfo"])?;
                let info = &graph.objects[info];
                if info.class_name != "InstanceInfo" {
                    return Err("classe d'informations d'instance de composant inattendue".into());
                }
                read_transform(&info.fields["m_Trf"])?;
                if !plain_context(&info.fields) {
                    return Err("représentation ou document de composant non pris en charge".into());
                }
                let symbol = symbol_id(&info.fields).ok_or("identifiant de composant invalide")?;
                // L'instance imbriquée se dessine comme élément (voir l'en-tête du module).
                self.result.components.push(symbol);
            }
            "GInstance" => {
                // Une instance à échelle (`m_bHasScale` vrai) se place si sa matrice est une échelle uniforme ; sinon elle se saute quand son
                // symbole n'a rien à dessiner (voir l'en-tête du module) ; un drapeau absent reste refusé.
                let Some(flagged) = object.fields["m_bHasScale"].as_bool() else {
                    return Err(SCALE_REFUSAL.into());
                };
                let view_resolved = match object.fields["m_resolveSymInView"].as_bool() {
                    Some(resolved) => resolved,
                    None => return Err("instance dont le symbole dépend de la vue non prise en charge".into()),
                };
                // Cibles interdites : voir l'en-tête du module. Un masque qui n'interdit que des cibles de `DRAWN_TARGETS`
                // n'interdit pas la vue 3D ombrée ; les autres restent à établir.
                let restricted = object.fields["m_forbiddenTarget"]["m_targets"].as_u64().is_none_or(|targets| targets & !DRAWN_TARGETS != 0);
                let info = self.view.target(index, &object.fields["m_instanceInfo"])?;
                let info = &graph.objects[info];
                if info.class_name != "InstanceInfo" {
                    return Err("classe d'informations d'instance inattendue".into());
                }
                let transform = read_transform(&info.fields["m_Trf"])?;
                let scaled = (flagged && uniform_scale(&transform).is_none()).then_some(NON_UNIFORM_REFUSAL);
                let embedded = &object.fields["m_oEmbeddedSymbolGRep"];
                if embedded["pointer_token"].as_u64() == Some(0) {
                    if !plain_context(&info.fields) {
                        return Err("symbole externe : représentation ou document non pris en charge".into());
                    }
                    let symbol = symbol_id(&info.fields).ok_or("identifiant de symbole externe invalide")?;
                    if self.defer && (self.shapes)(symbol).is_none() && (self.resolver)(symbol).is_none() {
                        // Le symbole n'est pas encore lu : l'instance se rejouera à cette place (voir `place_pending`).
                        self.result.pending.push(Pending {
                            symbol,
                            object_index: index,
                            matrix,
                            transform,
                            depth,
                            detail_family: self.detail_family,
                            restricted,
                            scaled,
                            view_resolved,
                            visits: self.visits,
                            selected_at: self.result.selected.len(),
                            diagnostics_at: self.result.diagnostics.len(),
                            components_at: self.result.components.len(),
                        });
                        return Ok(());
                    }
                    self.enter_symbol(symbol, restricted, scaled, view_resolved, matrix, transform, depth)?;
                } else {
                    let embedded = self.view.target(index, embedded)?;
                    if let Some(message) = refusal(restricted, scaled) {
                        return if self.bears_surface(&self.view, embedded, &mut HashSet::new(), &mut 0) { Err(message.into()) } else { Ok(()) };
                    }
                    if view_resolved && self.depends_on_view(&self.view, embedded, &mut HashSet::new(), &mut 0) {
                        return Err("instance dont le symbole dépend de la vue non prise en charge".into());
                    }
                    self.chain.push(transform);
                    self.visit(embedded, multiply(matrix, transform), depth + 1);
                    self.chain.pop();
                }
            }
            // Lignes, points, commandes de retournement et imposteurs : pas de surface à dessiner.
            "GLine" | "GArc" | "GEllipse" | "GCurve" | "GNurbSpline" | "GPolyLine" | "GPolyline" | "GPoint" | "GBitmap" | "GText" => {}
            "GBiFlipControl" | "GFlipControl" => {
                if object.fields["m_subNodes"].as_array().is_some_and(|children| !children.is_empty()) {
                    return Err("commande de retournement qui porte des enfants".into());
                }
            }
            "GImposter" => {
                if object.fields["m_oAsset"]["pointer_token"].as_u64() != Some(u64::from(u32::MAX)) {
                    return Err("imposteur dont l'actif est lu en ligne : non pris en charge".into());
                }
            }
            other => return Err(format!("classe graphique atteinte non prise en charge : {other}")),
        }
        Ok(())
    }

    /// Place le symbole externe `symbol` d'une instance (nœud `GInstance` visité dans le repère `matrix`, de
    /// transformation `transform`) : par sa forme déjà parcourue, ou par son graphe. Mêmes décisions, dans le même
    /// ordre, par les deux chemins.
    fn enter_symbol(&mut self, symbol: u64, restricted: bool, scaled: Option<&'static str>, view_resolved: bool, matrix: GraphicsTransform, transform: GraphicsTransform, depth: usize) -> Result<(), String> {
        // La forme déjà parcourue du symbole dispense de son graphe.
        if let Some(shape) = (self.shapes)(symbol) {
            if let Some(message) = refusal(restricted, scaled) {
                return if shape.bears_surface { Err(message.into()) } else { Ok(()) };
            }
            if view_resolved {
                if shape.depends_on_view {
                    return Err("instance dont le symbole dépend de la vue non prise en charge".into());
                }
                self.result.components.push(symbol);
                return Ok(());
            }
            self.place(symbol, &shape, matrix, transform, depth + 1);
            return Ok(());
        }
        let view = self.symbol(symbol)?;
        if let Some(message) = refusal(restricted, scaled) {
            return if self.bears_surface(&view, 0, &mut HashSet::new(), &mut 0) { Err(message.into()) } else { Ok(()) };
        }
        if view_resolved {
            if self.depends_on_view(&view, 0, &mut HashSet::new(), &mut 0) {
                return Err("instance dont le symbole dépend de la vue non prise en charge".into());
            }
            // Le symbole est le graphique d'un autre élément (le balayage de mur) : il se dessine par lui-même, comme
            // une instance imbriquée (`GComponentRef`) ; le redessiner ici le doublerait.
            self.result.components.push(symbol);
            return Ok(());
        }
        let (previous_view, previous_owner) = (std::mem::replace(&mut self.view, view), self.source_owner_id.replace(symbol));
        // Le style et la surcouche ne passent pas d'un graphe à l'autre : le symbole a les siens.
        let (previous_layer, previous_overlay) = (std::mem::replace(&mut self.layer, -1), self.overlay_child.take());
        self.chain.push(transform);
        self.visit(0, multiply(matrix, transform), depth + 1);
        self.chain.pop();
        self.view = previous_view;
        self.source_owner_id = previous_owner;
        self.layer = previous_layer;
        self.overlay_child = previous_overlay;
        Ok(())
    }

    /// Le sous-graphe de `index` ne contient-il que des courbes ? (Les symboles placés ne sont pas suivis :
    /// dans le doute, faux.)
    fn only_curves(&self, view: &View<'_>, index: usize, seen: &mut HashSet<usize>) -> bool {
        if seen.len() >= 128 || !seen.insert(index) {
            return false;
        }
        let result = match view.graph.objects[index].class_name.as_str() {
            "GLine" | "GArc" | "GEllipse" | "GCurve" | "GNurbSpline" | "GPolyLine" | "GPolyline" | "GPoint" => true,
            "GElement" | "GGroup" | "GFilter" | "GGTag" => view.children(index).is_ok_and(|children| children.iter().all(|&child| self.only_curves(view, child, seen))),
            _ => false,
        };
        seen.remove(&index);
        result
    }

    /// Le sous-graphe de `index` peut-il dessiner une surface ? Suit les instances (symboles externes ou
    /// incorporés) et les références de composants ; tout ce qui n'est pas compris compte pour « oui ».
    fn bears_surface(&self, view: &View<'a>, index: usize, seen: &mut HashSet<(usize, usize)>, budget: &mut usize) -> bool {
        *budget += 1;
        if *budget > 20_000 {
            return true;
        }
        let key = (view.graph as *const ObjectGraph as usize, index);
        if !seen.insert(key) {
            return false;
        }
        let object = &view.graph.objects[index];
        match object.class_name.as_str() {
            "GPolyMesh" => true,
            "Geometry" => object.fields["m_pFaces"].as_array().is_none_or(|faces| !faces.is_empty()),
            "GLine" | "GArc" | "GEllipse" | "GCurve" | "GNurbSpline" | "GPolyLine" | "GPolyline" | "GPoint" | "GBitmap" | "GText" | "GBiFlipControl" | "GFlipControl" | "GImposter" => false,
            "GElement" | "GGroup" | "GFilter" | "GGTag" => match view.children(index) {
                Ok(children) => children.iter().any(|&child| self.bears_surface(view, child, seen, budget)),
                Err(_) => true,
            },
            "GInstance" => {
                let Ok(info) = view.target(index, &object.fields["m_instanceInfo"]) else { return true };
                let embedded = &object.fields["m_oEmbeddedSymbolGRep"];
                if embedded["pointer_token"].as_u64() == Some(0) {
                    let Some(symbol) = symbol_id(&view.graph.objects[info].fields) else { return true };
                    if let Some(shape) = (self.shapes)(symbol) {
                        return shape.bears_surface;
                    }
                    match self.symbol(symbol) {
                        Ok(inner) => self.bears_surface(&inner, 0, seen, budget),
                        Err(_) => true,
                    }
                } else {
                    match view.target(index, embedded) {
                        Ok(inner) => self.bears_surface(view, inner, seen, budget),
                        Err(_) => true,
                    }
                }
            }
            // Un composant est un élément à part : ses surfaces ne comptent pas ici.
            "GComponentRef" => false,
            _ => true,
        }
    }

    /// Le sous-graphe de `index` contient-il une condition, donc de quoi dépendre de la vue ? Suit les instances (symboles
    /// externes ou incorporés) ; tout ce qui n'est pas compris compte pour « oui ».
    fn depends_on_view(&self, view: &View<'a>, index: usize, seen: &mut HashSet<(usize, usize)>, budget: &mut usize) -> bool {
        *budget += 1;
        if *budget > 20_000 {
            return true;
        }
        let key = (view.graph as *const ObjectGraph as usize, index);
        if !seen.insert(key) {
            return false;
        }
        let object = &view.graph.objects[index];
        match object.class_name.as_str() {
            "Geometry" | "GPolyMesh" | "GLine" | "GArc" | "GEllipse" | "GCurve" | "GNurbSpline" | "GPolyLine" | "GPolyline" | "GPoint" | "GBitmap" | "GText" | "GBiFlipControl" | "GFlipControl" | "GImposter" | "GComponentRef" => false,
            "GElement" | "GGroup" | "GGTag" => match view.children(index) {
                Ok(children) => children.iter().any(|&child| self.depends_on_view(view, child, seen, budget)),
                Err(_) => true,
            },
            // Un filtre sans condition laisse passer tout ce qu'il porte, quelle que soit la vue.
            "GFilter" => match (object.fields["m_oConditions"].as_array(), view.children(index)) {
                (Some(conditions), Ok(children)) => !conditions.is_empty() || children.iter().any(|&child| self.depends_on_view(view, child, seen, budget)),
                _ => true,
            },
            "GInstance" => {
                let Ok(info) = view.target(index, &object.fields["m_instanceInfo"]) else { return true };
                let embedded = &object.fields["m_oEmbeddedSymbolGRep"];
                if embedded["pointer_token"].as_u64() == Some(0) {
                    let Some(symbol) = symbol_id(&view.graph.objects[info].fields) else { return true };
                    if let Some(shape) = (self.shapes)(symbol) {
                        return shape.depends_on_view;
                    }
                    match self.symbol(symbol) {
                        Ok(inner) => self.depends_on_view(&inner, 0, seen, budget),
                        Err(_) => true,
                    }
                } else {
                    match view.target(index, embedded) {
                        Ok(inner) => self.depends_on_view(view, inner, seen, budget),
                        Err(_) => true,
                    }
                }
            }
            _ => true,
        }
    }
}

/// Le contexte de représentation et de document des instances que ce parcours sait suivre : représentation
/// 0, document courant (jeton 1, sans classe).
fn plain_context(info: &Value) -> bool {
    info["m_GRepId"].as_u64() == Some(0) && info["m_cda"]["m_pDoc"]["pointer_token"].as_u64() == Some(1) && info["m_cda"]["m_pDoc"]["class_tag"].is_null()
}

fn symbol_id(info: &Value) -> Option<u64> {
    identifier(&info["m_symbolId"]).and_then(|id| u64::try_from(id).ok()).filter(|id| *id > 0)
}

/// La racine du graphique d'un symbole est bien celui du symbole demandé : en 2023 l'identifiant du
/// propriétaire est dans `GInfo.m_tag`, à partir de 2024 `m_elementId` s'y ajoute, et doit concorder.
fn owner_matches(root: &rvt::research::native_parameters::GraphObject, id: u64) -> bool {
    root.class_name == "GElement"
        && match root.fields.get("m_elementId") {
            Some(value) => value.as_u64() == Some(id),
            None => root.fields["m_GInfo"]["m_tag"].as_u64() == Some(id),
        }
}

pub fn graphics_visibility(flags: u64) -> u8 {
    let bits = flags & 0x1e0;
    if bits == 0 {
        0
    } else if bits == 0xe0 {
        3
    } else if bits < 0xe0 {
        if flags & 0x160 == 0x20 { 1 } else { 2 }
    } else if flags & 0x1a0 == 0x100 {
        1
    } else {
        2
    }
}

/// La matrice affine d'une instance (lignes de `m_3x3`, translation `m_or`), non singulière.
fn read_transform(value: &Value) -> Result<GraphicsTransform, String> {
    let rows = value["m_3x3"].as_array().filter(|rows| rows.len() == 3).ok_or("matrice d'instance absente")?;
    let origin = value["m_or"].as_array().filter(|origin| origin.len() == 3).ok_or("translation d'instance absente")?;
    let mut m = IDENTITY;
    for i in 0..3 {
        let row = rows[i].as_array().filter(|row| row.len() == 3).ok_or("ligne de matrice d'instance invalide")?;
        for j in 0..3 {
            m[i][j] = row[j].as_f64().filter(|x| x.is_finite()).ok_or("coefficient d'instance invalide")?;
        }
        m[i][3] = origin[i].as_f64().filter(|x| x.is_finite()).ok_or("translation d'instance invalide")?;
    }
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return Err("transformation d'instance singulière".into());
    }
    Ok(m)
}

/// Le facteur d'une matrice qui est une rotation (ou un miroir) multipliée par un nombre : ses trois colonnes sont orthogonales et de même
/// longueur, à 1e-9 près en valeur relative. `None` pour un étirement ou un cisaillement, et pour une matrice nulle.
pub fn uniform_scale(m: &GraphicsTransform) -> Option<f64> {
    let column = |j: usize| [m[0][j], m[1][j], m[2][j]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let scale = dot(column(0), column(0)).sqrt();
    if !scale.is_finite() || scale <= 0. {
        return None;
    }
    let tolerance = 1e-9 * scale;
    let equal = (0..3).all(|j| (dot(column(j), column(j)).sqrt() - scale).abs() <= tolerance);
    let orthogonal = [(0, 1), (0, 2), (1, 2)].iter().all(|&(i, j)| dot(column(i), column(j)).abs() <= tolerance * scale);
    (equal && orthogonal).then_some(scale)
}

fn multiply(a: GraphicsTransform, b: GraphicsTransform) -> GraphicsTransform {
    let mut result = [[0.; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            result[i][j] = (0..4).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    result
}

/// La direction de la vue 3D par défaut (type de vue 4) : les prédicats 6, 7 et 8 sont faux avant
/// négation dans ce contexte, 10 et 11 comparent l'angle à π/2 ± 1e-10, 0 et 3 l'égalité à la direction de la
/// vue (celle de rvt-rs : un seul vecteur, isométrique).
fn direction_condition(value: &Value, matrix: GraphicsTransform) -> Result<bool, String> {
    let negate = value["m_negateDirCondition"].as_bool().ok_or("négation de direction absente")?;
    let comparison = value["m_comp"].as_i64().ok_or("comparaison de direction absente")?;
    if matches!(comparison, 6..=8) {
        return Ok(negate);
    }
    let direction = value["m_dir"].as_array().filter(|a| a.len() == 3).ok_or("direction du filtre absente")?;
    let mut local = [0.; 3];
    for i in 0..3 {
        local[i] = direction[i].as_f64().filter(|x| x.is_finite()).ok_or("direction du filtre invalide")?;
    }
    let mut world = [0.; 3];
    for i in 0..3 {
        world[i] = (0..3).map(|j| matrix[i][j] * local[j]).sum();
    }
    let length = world.iter().map(|x| x * x).sum::<f64>().sqrt();
    if length < 1e-12 {
        return Err("direction du filtre nulle".into());
    }
    // Une matrice à échelle (instance à `m_bHasScale`) allonge la direction sans la tourner : seule la direction compte. Une matrice sans
    // échelle (la rotation ou le miroir d'avant) n'est pas touchée, bit pour bit.
    let local_length = local.iter().map(|x| x * x).sum::<f64>().sqrt();
    let length = if local_length > 0. && (length / local_length - 1.).abs() > 1e-9 {
        let ratio = length / local_length;
        for component in &mut world {
            *component /= ratio;
        }
        local_length
    } else {
        length
    };
    let actual = [-0.577350269189625, -0.577350269189627, 0.577350269189626];
    let answer = match comparison {
        10 | 11 => {
            let cosine = (0..3).map(|i| world[i] * actual[i]).sum::<f64>() / length;
            let angle = cosine.clamp(-1., 1.).acos();
            if comparison == 10 { angle < 1.5707963266948965 } else { angle > 1.5707963268948966 }
        }
        -1 | 0 | 3 => {
            let distance = (0..3).map(|i| (world[i] - actual[i]).powi(2)).sum::<f64>().sqrt();
            let equal = if distance < 1e-14 {
                true
            } else if distance > 1e-6 {
                false
            } else {
                return Err("égalité de direction dans la bande de tolérance non qualifiée".into());
            };
            if comparison == 0 { !equal } else { equal }
        }
        _ => return Err(format!("comparaison de direction non prise en charge : {comparison}")),
    };
    Ok(answer != negate)
}

/// Les conditions entières : type de vue (paramètre 1 : 4), niveau de détail (3), mode de dessin (6 : 0).
fn condition_at_detail(class: &str, value: &Value, detail_level: i64) -> Result<bool, String> {
    if !matches!(class, "GConditionInt" | "GConditionViewType" | "GConditionViewDetailLevel" | "GConditionVModeType") {
        return Err(format!("condition qui touche aux solides non prise en charge : {class}"));
    }
    let kind = value["m_param"].as_i64().ok_or("type de condition entière absent")?;
    let saved = value["m_value"].as_i64().ok_or("valeur de condition entière absente")?;
    if kind == 7 && saved == 2 && value["m_comp"].as_i64() == Some(0) {
        return Ok(true);
    }
    let actual = match kind {
        1 => 4,
        3 => detail_level,
        6 => 0,
        _ => return Err(format!("paramètre de condition entière non pris en charge : {kind}")),
    };
    match value["m_comp"].as_i64() {
        Some(-1 | 3) => Ok(saved == actual),
        Some(0) => Ok(saved != actual),
        Some(1) => Ok(saved > actual),
        Some(2) => Ok(saved >= actual),
        Some(4) => Ok(saved <= actual),
        Some(5) => Ok(saved < actual),
        _ => Err("comparaison de condition entière non prise en charge".into()),
    }
}
