//! Les familles chargées avant Revit 2015 : le seul prédicat qui reconnaît ce que leur contenu a laissé dans le projet.
//!
//! Avant Revit 2015, le projet écrit parmi ses propres enregistrements le contenu de chaque famille chargée : ses éléments
//! (extrusions, balayages, fusions, instances imbriquées…), mais aussi ses vues (`DBView3d`), ses phases (`ProjectPhase`,
//! `AllProjectPhases`) et ses filtres de phase (`PhaseFilterElem`). Tous ont pour propriétaire, dans l'ElemTable
//! (`Identity::owning_element_id`), l'enregistrement `Family` de cette famille. Revit 2015 et après rangent ce contenu dans
//! des sections que la lecture ne parcourt pas : rien n'est à écarter.
//!
//! Mesure (`cargo run --release --example owners -- <fichier>`, résultats dans `pre2015/metaleak.md`), sur les 20 fichiers
//! d'avant 2015 qui se lisent :
//! - les `DBView3d`, `ProjectPhase`, `AllProjectPhases` et `PhaseFilterElem` d'une famille chargée ont pour propriétaire
//!   *direct* une `Family` (profondeur 1, y compris quand cette `Family` est elle-même possédée par une autre : une famille
//!   imbriquée) ;
//! - un `Viewer3d` est possédé par sa vue (profondeur 2 jusqu'à la `Family`), un `ModelClipBox` par son `Viewer3d`
//!   (profondeur 3) : la remontée de la chaîne les écarte avec leur vue ;
//! - le contenu d'une famille chargée que Revit 2015 et après gardent aussi dans le projet (ses `ParamElemFamily`, qui
//!   donnent leur nom aux paramètres des instances) n'est pas écarté : ce n'est pas ce que ce prédicat reconnaît.
//!
//! Les contenus mesurés ont tous une `Family` pour propriétaire direct, mais rien n'interdit qu'un élément y arrive par des
//! intermédiaires (un groupe de modèle, un symbole d'import, une courbe) : le prédicat remonte donc la chaîne des propriétaires
//! d'ElemTable, de façon bornée ([`MAX_OWNER_CHAIN`]), jusqu'à la première `Family` qu'il rencontre, comme `Scene::owner_unplaced`
//! le fait pour les groupes. Une chaîne qui bute sur un enregistrement que l'index ne connaît pas, ou qui dépasse la borne, est
//! ambiguë (`FamilyOwner::Unread`) : l'enregistrement reste, et un avertissement le compte.
//!
//! Il sert la géométrie (`geometry::saved`) et les métadonnées (`properties::Retained`, `views::Digest`) : une seule règle, jamais
//! recopiée.

use rvt::RevitFile;
use serde_json::Value;

use std::rc::Rc;

use super::{Preamble, format_year, is_family, preamble};

/// Première année de Revit dont le projet n'écrit plus, parmi ses enregistrements, le contenu des familles chargées
/// (`FamilyRule`).
pub const LOADED_DEFINITIONS_FROM: u32 = 2015;

/// Ce que la lecture fait de ce que possède une famille chargée (éléments, vues, phases, filtres de phase).
///
/// Avant Revit 2015, le projet écrit parmi ses enregistrements ce contenu, dans le repère local de la famille : les éléments,
/// dessinés tels quels, s'empilent à l'origine du projet ; les vues, les phases et les filtres s'ajoutent à ceux du projet.
/// Mesures : `DynamoSample_2014.rvt` dessine 114 éléments de trop contre `DynamoSample_2023.rvt` (même modèle), et écrit 41 vues et
/// 12 filtres de phase là où la version de 2023 en écrit 7 et 7 ; tous possédés (ElemTable) par une `Family` qui n'est ni sur
/// place ni celle du document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FamilyRule {
    /// Revit 2015 et après (ou année inconnue) : rien n'est écarté pour sa famille.
    Off,
    /// Avant 2015. `document` est `ADocument.m_ownerFamilyId` : `-1` dans un projet, l'identifiant de la famille éditée dans un
    /// `.rfa` (dont les éléments, les vues et les phases ne sont pas ceux d'une famille chargée), `None` si la racine d'un `.rfa`
    /// ne se lit pas : on ne sait plus alors quelle `Family` est celle du document.
    On { document: Option<i64> },
}

/// Qui possède un enregistrement, par rapport aux familles chargées ? Ce que [`FamilyRule::owner`] répond.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FamilyOwner {
    /// Son propriétaire n'est pas une `Family` (ou la règle est éteinte), ou c'en est une dont le contenu est dans le modèle :
    /// sur place, ou celle du document.
    Elsewhere,
    /// Une `Family` chargée, ni sur place ni celle du document : l'enregistrement en est une pièce de définition, à écarter.
    Definition,
    /// La même `Family` chargée, atteinte en remontant la chaîne des propriétaires par au moins un intermédiaire (un groupe de
    /// modèle, un symbole d'import, une courbe…) : à écarter aussi, mais comptée à part (`classes::RELATION_REASONS`).
    DefinitionChain,
    /// Une `Family` dont on ne peut pas dire si elle est chargée : son enregistrement ne s'est pas décodé, il n'a pas `m_inPlace`,
    /// ou la famille du document ne se lit pas. Rien n'est écarté : l'enregistrement reste, et un avertissement le compte.
    Unread,
}

/// Nombre de propriétaires que [`FamilyRule::owner`] remonte au plus avant de juger la chaîne ambiguë : celui de
/// `Scene::owner_unplaced`. Mesuré sur les 20 fichiers d'avant 2015 qui se lisent (`cargo run --release --example owners -- <fichier>
/// --rule`, tous les enregistrements) : la chaîne la plus longue d'un enregistrement jusqu'à sa première `Family` compte 3 propriétaires.
pub const MAX_OWNER_CHAIN: usize = 16;

impl FamilyRule {
    /// La règle d'un fichier : allumée avant Revit 2015, d'après l'année de lecture (celle de l'étiquette, ou de l'empreinte du
    /// schéma pour Project Vasari), avec la famille du document que lit le préambule (`Preamble::owner_family`).
    pub fn of(file: &mut RevitFile) -> Self {
        let before = format_year(file).is_some_and(|(year, _)| year < LOADED_DEFINITIONS_FROM);
        if !before {
            return Self::Off;
        }
        let document = preamble(file).ok().and_then(|preamble| preamble.owner_family.as_ref().ok().copied());
        Self::before_2015(is_family(file), document)
    }

    /// La famille du document d'un fichier, de toute année (`ADocument.m_ownerFamilyId`, validée comme le fait
    /// [`before_2015`](Self::before_2015)) : `Some(-1)` pour un projet, `Some(id)` pour la famille qu'un `.rfa` édite, `None` si
    /// on ne sait pas laquelle est la sienne. Les familles sur place ([`in_place_family`]) en ont besoin quelle que soit l'année.
    pub fn document_of(file: &mut RevitFile) -> Option<i64> {
        let document = preamble(file).ok().and_then(|preamble| preamble.owner_family.as_ref().ok().copied());
        match Self::before_2015(is_family(file), document) {
            Self::On { document } => document,
            Self::Off => None,
        }
    }

    /// La règle d'un fichier d'avant 2015 d'après ce qu'on sait de son document : `is_family` (flux `PartAtom`, voir
    /// `native::is_family`) et `ADocument.m_ownerFamilyId` (`None` si la racine ne se lit pas).
    ///
    /// `document` n'est retenu que s'il est cohérent avec la nature du fichier : `-1` dans un projet, un identifiant de `Family` dans
    /// une famille (que [`FamilyRule::owner`] vérifie ensuite : il doit être un enregistrement `Family` qui existe). Sinon, la
    /// famille du document est inconnue (`None`) et tout est ambigu : sans cela, une famille dont la racine donnerait `-1`, ou un
    /// `.rfa` que `is_family` prendrait pour un projet, traiterait sa propre `Family` comme une famille chargée, écarterait tous
    /// ses éléments, sans avertissement : un fichier vide d'apparence légitime.
    pub fn before_2015(is_family: bool, owner_family: Option<i64>) -> Self {
        let document = match (is_family, owner_family) {
            (false, Some(-1)) => Some(-1),
            (true, Some(id)) if id >= 0 => Some(id),
            _ => None,
        };
        Self::On { document }
    }

    /// Le prédicat : l'enregistrement dont le propriétaire d'ElemTable est `owner` (`-1` s'il n'en a pas) est-il une pièce d'une
    /// famille chargée ? On remonte la chaîne des propriétaires jusqu'à la première `Family` (au plus [`MAX_OWNER_CHAIN`] pas).
    ///
    /// - `family(id)` dit ce que l'appelant sait de l'enregistrement `id` : `None` si ce n'est pas une `Family`, `Some(m_inPlace)`
    ///   si c'en est une, `m_inPlace` valant `None` quand l'enregistrement ne s'est pas décodé ou n'a pas ce champ.
    /// - `owner_of(id)` donne le propriétaire d'ElemTable de tout enregistrement `id`, `None` si l'index ne le connaît pas.
    ///
    /// Une chaîne qui s'achève sans `Family` (propriétaire `-1`) n'a rien à voir avec une famille. Une chaîne qui bute sur un
    /// enregistrement inconnu, ou qui dépasse la borne, est ambiguë.
    pub fn owner(self, owner: i64, family: impl Fn(u64) -> Option<Option<bool>>, owner_of: impl Fn(u64) -> Option<i64>) -> FamilyOwner {
        let FamilyRule::On { document } = self else { return FamilyOwner::Elsewhere };
        // La famille du document d'un `.rfa` doit être un enregistrement `Family` qui existe ; sinon on ne sait pas laquelle est la
        // sienne.
        let document = document.filter(|document| *document == -1 || u64::try_from(*document).ok().is_some_and(|id| family(id).is_some()));
        let mut current = owner;
        for step in 0..MAX_OWNER_CHAIN {
            let Some(id) = u64::try_from(current).ok() else { return FamilyOwner::Elsewhere };
            if let Some(in_place) = family(id) {
                // La famille du document : ses éléments sont la famille elle-même, quel que soit `m_inPlace`.
                if document == Some(current) {
                    return FamilyOwner::Elsewhere;
                }
                return match (in_place, document) {
                    (Some(true), _) => FamilyOwner::Elsewhere,
                    (Some(false), Some(_)) if step == 0 => FamilyOwner::Definition,
                    (Some(false), Some(_)) => FamilyOwner::DefinitionChain,
                    _ => FamilyOwner::Unread,
                };
            }
            match owner_of(id) {
                Some(next) => current = next,
                None => return FamilyOwner::Unread,
            }
        }
        FamilyOwner::Unread
    }
}

/// Les propriétaires d'ElemTable de tous les enregistrements d'un fichier : ce que `FamilyRule::owner` remonte. Ce sont ceux du
/// préambule, déjà en mémoire (`native::preamble`) : rien de plus n'est gardé.
pub struct Owners(Option<Rc<Preamble>>);

impl Owners {
    /// Les propriétaires du fichier ; vides si son préambule ne se lit pas (toute chaîne y est alors ambiguë).
    pub fn of(file: &mut RevitFile) -> Self {
        Self(preamble(file).ok())
    }

    /// Le propriétaire de l'enregistrement `id`, `-1` s'il n'en a pas ; `None` si l'index ne connaît pas `id`.
    pub fn get(&self, id: u64) -> Option<i64> {
        self.0.as_ref()?.index.identities.get(&id).map(|identity| identity.owning_element_id)
    }
}

/// La famille sur place dont un enregistrement est une pièce, de toute année : celle que la chaîne de ses propriétaires d'ElemTable
/// atteint en premier, quand c'est une `Family` sur place (`m_inPlace` vrai) qui n'est pas celle du document. Une famille sur place
/// est créée dans l'éditeur de modèle sur place : ses formes sont dans le repère du projet, mais le projet les place aussi par son
/// instance (`FamilyInstance`), qui les dessine à son tour ; l'instance se déplace avec ses copies, la forme reste à sa place
/// d'origine. La chaîne se remonte comme celle des familles chargées (`FamilyRule::owner`, bornée par [`MAX_OWNER_CHAIN`]).
///
/// `document` est la famille du document ([`FamilyRule::document_of`]) : les formes d'un `.rfa` sont la famille elle-même, et se
/// dessinent. `None` si on ne sait pas laquelle c'est (rien n'est alors reconnu). `family(id)` et `owner_of(id)` comme pour
/// `FamilyRule::owner` ; `None` aussi pour une chaîne qui s'achève sans `Family`, qui bute sur un enregistrement inconnu, dépasse
/// la borne, ou atteint une `Family` dont on ne sait pas si elle est sur place : l'élément reste dessiné comme avant.
pub fn in_place_family(document: Option<i64>, owner: i64, family: impl Fn(u64) -> Option<Option<bool>>, owner_of: impl Fn(u64) -> Option<i64>) -> Option<u64> {
    let document = document?;
    // La famille du document d'un `.rfa` doit être un enregistrement `Family` qui existe ; sinon on ne sait pas laquelle est la sienne.
    if document != -1 && !u64::try_from(document).ok().is_some_and(|id| family(id).is_some()) {
        return None;
    }
    let mut current = owner;
    for _ in 0..MAX_OWNER_CHAIN {
        let id = u64::try_from(current).ok()?;
        if let Some(in_place) = family(id) {
            return (current != document && in_place == Some(true)).then_some(id);
        }
        current = owner_of(id)?;
    }
    None
}

/// `m_inPlace` d'un enregistrement de classe `class` dont `root` est le premier objet du graphe décodé : `Some` pour une `Family` qui
/// a le champ, `None` pour tout autre enregistrement, pour une `Family` dont le graphe n'a pas été décodé (`root` absent) et pour une
/// `Family` sans ce champ. C'est tout ce que la règle retient des `Family`.
pub fn in_place(class: &str, root: Option<&Value>) -> Option<bool> {
    (class == "Family").then(|| root.and_then(|fields| fields.get("m_inPlace")).and_then(Value::as_bool)).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Les `Family` d'un fichier d'essai : 10 sur place, 11 chargée, 12 illisible (sans `m_inPlace`) ; 20 et 21 n'en sont pas.
    fn lookup(id: u64) -> Option<Option<bool>> {
        BTreeMap::from([(10, Some(true)), (11, Some(false)), (12, None)]).get(&id).copied()
    }

    /// Les propriétaires de ces enregistrements : 20 (un groupe) est possédé par la chargée 11, 21 (une courbe) par le groupe 20, 22 par
    /// la sur place 10, 23 par personne, 24 par un enregistrement que l'index ne connaît pas (99), 25 par l'illisible 12, 26 et 27 se
    /// possèdent l'un l'autre.
    fn owners(id: u64) -> Option<i64> {
        BTreeMap::from([(20, 11), (21, 20), (22, 10), (23, -1), (24, 99), (25, 12), (26, 27), (27, 26)]).get(&id).copied()
    }

    #[test]
    fn le_predicat_distingue_les_familles_chargees_des_autres() {
        let project = FamilyRule::On { document: Some(-1) };
        assert_eq!(project.owner(11, lookup, owners), FamilyOwner::Definition);
        assert_eq!(project.owner(10, lookup, owners), FamilyOwner::Elsewhere);
        assert_eq!(project.owner(12, lookup, owners), FamilyOwner::Unread);
        // Aucun propriétaire.
        assert_eq!(project.owner(-1, lookup, owners), FamilyOwner::Elsewhere);
        // La famille que le document est : ni sur place ni chargée, ses éléments sont la famille.
        assert_eq!(FamilyRule::On { document: Some(11) }.owner(11, lookup, owners), FamilyOwner::Elsewhere);
        assert_eq!(FamilyRule::On { document: Some(11) }.owner(12, lookup, owners), FamilyOwner::Unread);
        assert_eq!(FamilyRule::On { document: Some(11) }.owner(21, lookup, owners), FamilyOwner::Elsewhere);
        // Une racine illisible : on ne sait plus quelle `Family` est celle du document, rien n'est écarté.
        assert_eq!(FamilyRule::On { document: None }.owner(11, lookup, owners), FamilyOwner::Unread);
        assert_eq!(FamilyRule::On { document: None }.owner(10, lookup, owners), FamilyOwner::Elsewhere);
        // La règle éteinte (Revit 2015 et après) n'écarte rien, et ne consulte rien.
        assert_eq!(FamilyRule::Off.owner(11, |_| panic!("la règle éteinte ne regarde rien"), |_| panic!("ni les propriétaires")), FamilyOwner::Elsewhere);
    }

    #[test]
    fn la_chaine_des_proprietaires_se_remonte_jusqu_a_la_premiere_family() {
        let project = FamilyRule::On { document: Some(-1) };
        // Un groupe (20) de la famille chargée 11, puis une courbe (21) de ce groupe : définition, par intermédiaires.
        assert_eq!(project.owner(20, lookup, owners), FamilyOwner::DefinitionChain);
        assert_eq!(project.owner(21, lookup, owners), FamilyOwner::DefinitionChain);
        // La première `Family` rencontrée décide : sur place (22), le contenu est dans le modèle ; illisible (25), c'est ambigu.
        assert_eq!(project.owner(22, lookup, owners), FamilyOwner::Elsewhere);
        assert_eq!(project.owner(25, lookup, owners), FamilyOwner::Unread);
        // Une chaîne qui s'achève sans `Family` n'en est pas une pièce.
        assert_eq!(project.owner(23, lookup, owners), FamilyOwner::Elsewhere);
        // Un maillon que l'index ne connaît pas, une boucle, la borne : ambigu, jamais écarté.
        assert_eq!(project.owner(24, lookup, owners), FamilyOwner::Unread);
        assert_eq!(project.owner(99, lookup, owners), FamilyOwner::Unread);
        assert_eq!(project.owner(26, lookup, owners), FamilyOwner::Unread);
        // Une chaîne de `MAX_OWNER_CHAIN` maillons avant la `Family` passe ; d'un maillon de plus, elle est ambiguë.
        let long = |id: u64| (id >= 1000).then_some(id as i64 + 1).filter(|next| *next <= 1000 + 64);
        let chain = |length: u64| FamilyRule::On { document: Some(-1) }.owner((1000 + 64 - length) as i64, |id| (id == 1000 + 64).then_some(Some(false)), long);
        assert_eq!(chain(MAX_OWNER_CHAIN as u64 - 1), FamilyOwner::DefinitionChain);
        assert_eq!(chain(MAX_OWNER_CHAIN as u64), FamilyOwner::Unread);
        // La famille du document, atteinte par un intermédiaire, est la famille elle-même.
        assert_eq!(FamilyRule::On { document: Some(11) }.owner(21, lookup, owners), FamilyOwner::Elsewhere);
    }

    #[test]
    fn la_famille_du_document_doit_etre_coherente_avec_la_nature_du_fichier() {
        // Un projet : `-1`. Une famille : l'identifiant d'une `Family`.
        assert_eq!(FamilyRule::before_2015(false, Some(-1)), FamilyRule::On { document: Some(-1) });
        assert_eq!(FamilyRule::before_2015(true, Some(1020)), FamilyRule::On { document: Some(1020) });
        // Une famille dont la racine donne `-1`, ou une racine illisible, quelle que soit la nature que `is_family` lui donne (il peut
        // se tromper sur un vrai `.rfa`) : ambigu, jamais « un projet » qui écarterait tout.
        assert_eq!(FamilyRule::before_2015(true, Some(-1)), FamilyRule::On { document: None });
        assert_eq!(FamilyRule::before_2015(true, None), FamilyRule::On { document: None });
        assert_eq!(FamilyRule::before_2015(false, None), FamilyRule::On { document: None });
        // Un « projet » qui dit avoir une famille de document, ou une valeur plus petite que -1 : contradiction.
        assert_eq!(FamilyRule::before_2015(false, Some(1020)), FamilyRule::On { document: None });
        assert_eq!(FamilyRule::before_2015(true, Some(-5)), FamilyRule::On { document: None });
    }

    #[test]
    fn la_famille_du_document_doit_etre_un_enregistrement_family_qui_existe() {
        // Une famille éditée dont `m_ownerFamilyId` désigne 77, qui n'est pas une `Family` : on ne sait pas laquelle est la sienne, la
        // chargée 11 comme la sur place 10 restent ambiguës ou dans le modèle, sans rien écarter.
        let rule = FamilyRule::before_2015(true, Some(77));
        assert_eq!(rule, FamilyRule::On { document: Some(77) });
        assert_eq!(rule.owner(11, lookup, owners), FamilyOwner::Unread);
        assert_eq!(rule.owner(20, lookup, owners), FamilyOwner::Unread);
        assert_eq!(rule.owner(10, lookup, owners), FamilyOwner::Elsewhere);
        // Désigner un enregistrement qui est bien une `Family` suffit, et ce qu'elle possède est la famille.
        assert_eq!(FamilyRule::before_2015(true, Some(11)).owner(11, lookup, owners), FamilyOwner::Elsewhere);
        assert_eq!(FamilyRule::before_2015(true, Some(11)).owner(12, lookup, owners), FamilyOwner::Unread);
    }

    #[test]
    fn la_famille_sur_place_d_un_element_se_trouve_en_remontant_la_chaine() {
        let project = Some(-1);
        // La sur place 10 : propriétaire direct de l'élément, ou atteinte par un intermédiaire (22).
        assert_eq!(in_place_family(project, 10, lookup, owners), Some(10));
        assert_eq!(in_place_family(project, 22, lookup, owners), Some(10));
        // Les familles chargées (11) et illisibles (12, 25) ne sont pas sur place : l'élément reste dessiné.
        assert_eq!(in_place_family(project, 11, lookup, owners), None);
        assert_eq!(in_place_family(project, 12, lookup, owners), None);
        assert_eq!(in_place_family(project, 25, lookup, owners), None);
        // Par des intermédiaires : 20 est possédé par la chargée 11, 21 par 20 ; une chaîne qui s'achève sans `Family`, un maillon
        // inconnu, une boucle : rien.
        assert_eq!(in_place_family(project, 21, lookup, owners), None);
        assert_eq!(in_place_family(project, 23, lookup, owners), None);
        assert_eq!(in_place_family(project, 24, lookup, owners), None);
        assert_eq!(in_place_family(project, 26, lookup, owners), None);
        assert_eq!(in_place_family(project, -1, lookup, owners), None);
        // La borne de la chaîne : `MAX_OWNER_CHAIN - 1` maillons avant la `Family` passent, un de plus non.
        let long = |id: u64| (id >= 1000).then_some(id as i64 + 1).filter(|next| *next <= 1000 + 64);
        let chain = |length: u64| in_place_family(project, (1000 + 64 - length) as i64, |id| (id == 1000 + 64).then_some(Some(true)), long);
        assert_eq!(chain(MAX_OWNER_CHAIN as u64 - 1), Some(1064));
        assert_eq!(chain(MAX_OWNER_CHAIN as u64), None);
    }

    #[test]
    fn la_famille_du_document_n_est_jamais_une_famille_sur_place() {
        // Un `.rfa` dont la famille éditée est la sur place 10 : ses formes sont la famille, elles se dessinent. Le même fichier avec
        // un document inconnu, ou qui n'est pas une `Family` : rien n'est reconnu.
        assert_eq!(in_place_family(Some(10), 10, lookup, owners), None);
        assert_eq!(in_place_family(Some(10), 22, lookup, owners), None);
        assert_eq!(in_place_family(Some(11), 10, lookup, owners), Some(10));
        assert_eq!(in_place_family(None, 10, lookup, owners), None);
        assert_eq!(in_place_family(Some(77), 10, lookup, owners), None);
    }

    #[test]
    fn m_in_place_ne_se_lit_que_sur_une_family() {
        let root = serde_json::json!({"m_inPlace": false});
        assert_eq!(in_place("Family", Some(&root)), Some(false));
        assert_eq!(in_place("Family", Some(&serde_json::json!({"m_inPlace": true}))), Some(true));
        assert_eq!(in_place("Family", Some(&serde_json::json!({}))), None);
        assert_eq!(in_place("Family", None), None);
        assert_eq!(in_place("FamilySymbol", Some(&root)), None);
    }
}
