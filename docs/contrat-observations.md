# Contrat des observations (suivi de chantier)

Une observation est un constat de chantier (réserve, défaut, sécurité, tâche…) posé sur un élément de la maquette ou sur un
plan, avec sa vue, son image, ses photos, ses commentaires et son statut. Elle est enregistrée de deux façons, qui se
complètent :

- **le fichier `.bcf`** (BCF 3.0, buildingSMART) : les observations elles-mêmes, avec leurs photos et les images de leurs
  points de vue. Il se lit dans les autres outils BIM (Solibri, BIMcollab, Revizto, Dalux…) ;
- **la section `observations` du JSON de métadonnées** (`JSON ↓` et `Modifications ↓`, voir `contrat-metadonnees.md`) : ce
  que le BCF n'a pas (repère sur un plan, point 3D, emplacement, éléments par maquette, numéro), les listes du projet et les
  réglages, et une copie des observations **sans photos ni images**.

Rien ne quitte la page sans un export choisi par l'utilisateur. Les photos ne vivent que dans la page jusqu'à l'export du
`.bcf` : rouvrir le JSON sans le `.bcf` rend les observations, leurs repères et leurs commentaires, mais pas leurs photos ;
« Ouvrir un .bcf… » les remet (fusion par GUID, ci-dessous).

## 1. Correspondance avec le BCF

| Champ de l'observation | BCF 3.0 (`markup.bcf`, `viewpoint.bcfv`) |
| --- | --- |
| Type (réserve, défaut, sécurité, tâche — liste modifiable) | `Topic/@TopicType` |
| Statut (Ouverte, En cours, Résolue, Contestée, Clôturée — liste modifiable) | `Topic/@TopicStatus` |
| Lot | `Labels/Label` (le premier) |
| Phase (Visite, OPR, Levée de réserves, GPA) | `Stage` |
| Entreprise | `AssignedTo` |
| Échéance, priorité, titre, description | `DueDate`, `Priority`, `Title`, `Description` |
| Créée le / par, modifiée le / par | `CreationDate`, `CreationAuthor`, `ModifiedDate`, `ModifiedAuthor` |
| Éléments | `Selection` **et** `Coloring` (une couleur, `FFFF3B30`, ARGB sans `#`) du premier point de vue, `Visibility` : tout visible. Par élément : `IfcGuid` (GlobalId IFC, sans préfixe de session) ; un élément Revit y ajoute `OriginatingSystem` = `Revit` et `AuthoringToolId` = son ElementId (lu dans les propriétés non modifiables que le lecteur déclare : l'entier est l'ElementId, le texte de 22 caractères le GlobalId) ; un Revit sans GUID n'a que `AuthoringToolId` (clé `rvt-<ElementId>`) ; autre clé : `AuthoringToolId` et `OriginatingSystem` = le type de la maquette. Une pièce (`<clé>~n`) prend l'identité de son original |
| Vue et coupe | caméra du point de vue (`PerspectiveCamera` ou `OrthogonalCamera`) et `ClippingPlanes` |
| Point | `Lines` du premier point de vue : une croix de trois traits de 30 cm centrée sur le point (X, Y, Z), repère du modèle, Z vers le haut ; et `viewer-bim.json` (ci-dessous) |
| Image de la vue | `snapshot.png` du point de vue (au plus 1 500 px de côté), repère rouge sur le point ; absente en mode carte (le globe dessine sa propre copie : l'application le dit) |
| Photos | `DocumentReferences` → `documents.xml` et `Documents/<guid>` (JPEG, réduites à 1 500 px de côté) |
| Historique (changements de statut compris) et commentaires | `Comments/Comment` |
| Repère sur un plan, point 3D | `viewer-bim.json` du dossier du sujet : `{ "point": [x, y, z], "pin": { "plan", "x", "y" }, "drawingPin": { "plan", "x", "y" } }` (fichier à nous, que la spécification BCF permet ; les autres outils l'ignorent) |
| Emplacement, numéro, origine | aucun : section `observations` du JSON seulement |

**Deux points de vue par sujet qui a un point.** Quand la vue de l'utilisateur ne regarde pas déjà le point (axe à moins de 8°), le sujet écrit **en premier** un point de vue visé (en perspective, de biais et d'en haut, cadré sur la boîte des éléments, jamais derrière un mur), puis la vue de l'utilisateur : les autres outils ouvrent le premier. Ses éléments, sa croix et (à la création) son image sont ceux du point de vue visé. Son GUID est dérivé de celui du sujet : un export répété ne l'empile pas.

Les listes du projet vont dans `extensions.xml` : `TopicTypes` (types), `TopicStatuses` (statuts), `Priorities`,
`TopicLabels` (lots), `Users` (entreprises et auteurs), `Stages` (phases).

**Coordonnées.** Tout ce qui est en mètres (caméra, plans de coupe, point, repère sur plan) est dans le repère d'origine du
modèle, **Z vers le haut** (celui de l'IFC ou du `.rvt`), jamais dans le repère recentré du viewer. Le repère du modèle du
viewer (Y vers le haut, celui des vues enregistrées) s'y ramène par (x, y, z) → (x, −z, y).

**Points de vue.** Une perspective garde son champ vertical (`FieldOfView`, ramené entre 45° et 60° à l'écriture comme le
demande BCF 3.0) et ses proportions (`AspectRatio`) ; une projection parallèle sa hauteur en mètres (`ViewToWorldScale`). Les
plans de coupe libres sont écrits d'abord, puis la boîte de coupe en six plans (normales vers l'extérieur, du côté retiré) ;
à la lecture, six derniers plans qui forment une boîte tournée autour de la verticale redeviennent une boîte.

**Écrit strictement** : GUID partout (minuscules), dates ISO 8601 (`2026-11-14T08:30:00Z`), image PNG ou JPEG d'au plus
1 500 px de côté (sinon l'export est refusé ; une image plus grande lue d'un autre outil est réduite à l'import), éléments
dans l'ordre du schéma, XML échappé.

**Lu** : BCF 3.0 et 2.1 (commentaires et points de vue à côté du sujet, étiquettes répétées, documents par chemin), archives
stockées ou compressées (deflate). Les éléments d'un sujet : `Selection`, sinon `Coloring`, sinon les exceptions de
`Visibility` ; le premier groupe dont un élément se retrouve dans la maquette ouverte (sinon le premier non vide). Un
`AuthoringToolId` numérique est un ElementId Revit (`rvt-<id>`) quand `OriginatingSystem` dit Revit ou que la maquette
ouverte est un `.rvt` ; sinon c'est une clé ordinaire. Le point : `viewer-bim.json`, sinon le centre de la croix (`Lines`),
sinon le centre des éléments, sinon l'endroit de la maquette que la caméra regarde (rayon le long de sa direction), sinon
aucun : l'observation est alors listée « sans position ». Un fichier sans elles s'ouvre comme avant.
**Pas pris en charge** (lu sans erreur, pas réécrit) : en-tête des fichiers IFC, `BimSnippet`, exceptions de visibilité
(lues, jamais écrites), images posées dans la vue, `extensions.xsd` de 2.1 (les valeurs des sujets lus rejoignent les
listes).

## 2. La section `observations` du JSON

Facultative, à la racine. Un fichier sans elle s'ouvre comme avant ; un viewer qui ne la connaît pas l'ignore.

```json
"observations": {
  "settings": { "level": "Niveau", "room": "Local", "zone": "Zone" },
  "lists": {
    "kinds": ["Réserve", "Défaut", "Sécurité", "Tâche"],
    "statuses": ["Ouverte", "En cours", "Résolue", "Contestée", "Clôturée"],
    "done": ["Résolue", "Clôturée"],
    "trades": ["Plomberie", "Peinture"],
    "priorities": ["Critique", "Haute", "Normale", "Basse"],
    "phases": ["Visite", "OPR", "Levée de réserves", "GPA"],
    "companies": ["Durand"],
    "transitions": { "Ouverte": ["En cours", "Résolue", "Contestée", "Clôturée"], "Clôturée": ["Ouverte"] }
  },
  "topics": [{
    "guid": "3f0e6a9c-1b2d-4e5f-8a7b-9c0d1e2f3a4b", "number": 12,
    "type": "Réserve", "status": "Ouverte", "title": "Joint silicone à reprendre", "priority": "Haute", "labels": ["Plomberie"],
    "creationDate": "2026-11-14T08:30:00Z", "creationAuthor": "Zaid", "dueDate": "2026-11-30T00:00:00Z",
    "assignedTo": "Durand", "stage": "OPR", "description": "Salle de bain, angle du bac.",
    "referenceLinks": [], "relatedTopics": [],
    "comments": [{ "guid": "…", "date": "2026-11-14T09:00:00Z", "author": "Zaid", "text": "Statut : Ouverte → En cours" }],
    "viewpoints": [{ "guid": "…", "camera": { "kind": "orthogonal", "viewPoint": [12.4, 8.2, 23.1], "direction": [0, 0, -1], "up": [0, 1, 0], "viewToWorldScale": 18, "aspectRatio": 1.6 }, "clippingPlanes": [], "selection": [] }],
    "documents": [{ "guid": "…", "filename": "photo-1.jpg" }],
    "elements": [{ "key": "2O2Fr$t4X7Zf8NOew3FLOH", "model": "maison.ifc" }],
    "pin": { "plan": "Niveau 1", "x": 12.4, "y": 8.2 }, "point": [12.4, 8.2, 3.1],
    "location": { "level": "R+1", "room": "Salle de bain" }
  }]
}
```

| Champ | Rôle |
| --- | --- |
| `settings` | Les propriétés des éléments que l'utilisateur désigne comme niveau, local et zone : l'emplacement d'une observation est lu sur son premier élément. Aucun nom de propriété n'est connu du viewer. |
| `lists` | Les listes du projet, modifiables. `done` : les statuts qui terminent une observation (elle n'est plus « en retard »). `transitions` : pour chaque statut, ceux qui peuvent suivre ; un statut absent de la table peut aller vers tous les autres. |
| `topics[]` | Les champs BCF du § 1 (mêmes noms que dans `bcf.ts`), sans contenu binaire : un document garde son nom, pas ses octets ; un point de vue n'a pas d'image. |
| `number` | Numéro lisible, unique dans le projet (« N° 12 »). |
| `elements` | `key` : la clé de l'élément dans le fichier de sa maquette (sans préfixe de session) ; `model` : le nom de ce fichier. Un élément sans `model` (lu d'un `.bcf`), ou d'une maquette ouverte sous un autre nom, est cherché par sa clé dans toutes les maquettes. |
| `pin` | Le repère posé sur un plan : `plan`, l'identifiant de la vue (à défaut son nom) ; `x`, `y` en mètres, repère d'origine (Z vers le haut). |
| `drawingPin` | Facultatif. Le repère posé sur un plan du suivi de chantier (`chantier.html` : un fichier image ou PDF du projet) : `plan`, l'identifiant de ce plan ; `x`, `y` en fractions de sa largeur et de sa hauteur (0 à 1, depuis le coin haut gauche). Le viewer le garde sans l'afficher. |
| `point` | Le point désigné, repère d'origine, Z vers le haut : il garde l'observation à sa place si l'élément disparaît. |
| `location` | Niveau, local et zone, lus sur l'élément à la création (et quand les réglages changent). |
| `origin` | Ce qui a créé l'observation (`clash:…`, `requirement:…`) : la même source n'en crée pas deux. |

Une section illisible est ignorée ; une observation illisible (sans `guid`, `title` ou `creationDate`) est écartée. Avec
plusieurs maquettes ouvertes, la section va dans le JSON de la première, comme les autres sections de la session.

## 3. Fusion

Ouvrir un `.bcf`, ou déposer un JSON qui a la section, réunit les observations par GUID de sujet :

- une observation nouvelle est ajoutée (son numéro est gardé s'il est libre, sinon elle prend le suivant) ;
- une observation connue est mise à jour : la plus récemment modifiée l'emporte champ par champ ; commentaires, points de
  vue et documents sont réunis par GUID, et photos et images reprises de l'autre côté quand il les a ; les éléments gardent
  leur maquette ; repère, point et emplacement viennent du côté qui les a ;
- les valeurs utilisées (types, statuts, lots, phases, entreprises) rejoignent les listes.

Rouvrir le modèle avec son JSON, puis le `.bcf`, rend donc tout : repères sur les plans et photos.

## 4. Éléments disparus

Une observation dont un élément n'existe plus dans la maquette ouverte (IFC réexporté avec de nouveaux GlobalId, élément
supprimé) reste dans la liste, marquée « élément introuvable » et comptée ; son point, son niveau et sa vue la retrouvent.
