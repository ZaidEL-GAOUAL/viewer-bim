# Contrat entre le GLB et le JSON de métadonnées

Ce document décrit ce que le pipeline (IFC → GLB + JSON) doit produire pour que le viewer
relie chaque objet 3D à ses propriétés. Le viewer ne connaît aucun standard BIM : il ne suppose
l'existence d'aucune propriété et découvre tout dans le fichier.

## 1. Côté géométrie (GLB ou glTF)

Chaque objet du bâtiment (un mur, une porte, une dalle) est un **nœud glTF** qui porte un
identifiant dans son champ `extras.id` :

```json
{
  "name": "Mur extérieur 01",
  "mesh": 12,
  "translation": [4.0, 0.0, 2.5],
  "extras": { "id": "2O2Fr$t4X7Zf8NOew3FLOH" }
}
```

Règles :

- `extras.id` est une chaîne ou un nombre. C'est la clé de liaison avec le JSON.
- Un nœud identifié peut contenir des nœuds enfants sans identifiant (par exemple le cadre et le
  vitrage d'une fenêtre) : toute leur géométrie appartient à l'élément parent.
- Si **aucun** nœud du fichier n'a d'`extras.id`, le viewer se rabat sur le `name` de chaque nœud
  portant un maillage. Cette solution de secours suffit pour un export simple, mais les noms ne
  sont pas garantis uniques : préférez `extras.id`.
- L'unité est le mètre et l'axe vertical est Y, comme l'impose la spécification glTF.
- Seuls les triangles sont affichés. Les couleurs de base des matériaux, la transparence et les
  textures de couleur sont reprises ; les autres textures (relief, rugosité) sont ignorées.
- Les fichiers compressés avec Draco ou Meshopt sont acceptés.
- Un nœud identifié sans géométrie (un étage, un local sans volume) n'apparaît pas dans le viewer.

## 2. Côté métadonnées (JSON)

```json
{
  "version": 1,
  "elements": {
    "2O2Fr$t4X7Zf8NOew3FLOH": {
      "label": "Mur extérieur 01",
      "properties": {
        "Catégorie": "Mur",
        "Niveau": "R+1",
        "Porteur": true,
        "Dimensions": { "Longueur (m)": 4.2, "Hauteur (m)": 2.7 }
      }
    }
  }
}
```

| Champ | Obligatoire | Rôle |
| --- | --- | --- |
| `version` | non (1 par défaut) | Version du format. Le viewer refuse une version plus récente que celle qu'il connaît. |
| `readOnly` | non | Liste des propriétés que le viewer affiche sans permettre de les modifier (voir § 2 bis). |
| `propertiesMode` | non | `"replace"` indique un état complet des propriétés pour chaque élément présent. Sans ce champ, le JSON complète les propriétés du GLB. |
| `elements` | oui | Objet indexé par identifiant : la même valeur que `extras.id` dans le GLB. |
| `label` | non | Nom affiché dans l'arborescence et la fiche. À défaut, le `name` du nœud glTF. |
| `properties` | non | Propriétés libres de l'élément. |

Valeurs acceptées dans `properties` :

- texte, nombre, booléen ou `null` ;
- un objet imbriqué, qui sert de **catégorie** : `"Dimensions": { "Hauteur (m)": 2.7 }` devient la
  propriété `Dimensions / Hauteur (m)` et s'affiche sous le titre « Dimensions » ;
- un tableau, affiché comme une liste de valeurs séparées par des virgules.

Les éléments n'ont pas à porter tous les mêmes propriétés. Une propriété absente s'affiche
« (non défini) » dans les regroupements et les filtres.

### Formes tolérées

Pour simplifier les premiers essais, le viewer accepte aussi :

- un objet racine directement indexé par identifiant, sans `version` ni `elements` ;
- des propriétés posées directement dans l'élément, sans l'enveloppe `properties` ;
- `elements` sous forme de liste, chaque entrée portant un champ `id`.

```json
{ "2O2Fr$t4X7Zf8NOew3FLOH": { "Catégorie": "Mur", "Niveau": "R+1" } }
```

### Propriétés déjà présentes dans le GLB

Les autres champs `extras` d'un nœud glTF (hors `id`) sont aussi des propriétés de l'élément.
Le viewer les réunit avec celles du JSON :

- les propriétés du GLB viennent en premier, celles du JSON à la suite ;
- pour une propriété de même nom des deux côtés, la valeur du JSON l'emporte ;
- sans fichier JSON, ou pour un élément absent du JSON, seules les propriétés du GLB s'affichent.

Les JSON exportés par le viewer portent `"propertiesMode": "replace"`. Pour les identifiants
présents, leurs propriétés remplacent celles embarquées dans le modèle : une propriété supprimée
ne réapparaît donc pas à la réouverture. Les éléments absents gardent leurs propriétés d’origine.
Les anciens JSON et les fichiers complémentaires sans ce marqueur conservent la fusion décrite
ci-dessus. Un import effectué après chargement reste annulable, y compris les verrous ajoutés.

Le fichier ouvert sur disque n’est pas modifié. Lors d’un téléchargement GLB, les métadonnées
courantes peuvent être réinjectées dans les extras du fichier exporté.

## 2 bis. Modification des métadonnées dans le viewer

Dans la fiche d'un élément (ou d'une sélection de plusieurs éléments), chaque propriété est un
champ : texte, nombre, booléen ou date selon la valeur en place. Une valeur modifiée s'applique
à toute la sélection ; « Ajouter une propriété » en crée une nouvelle, avec `Catégorie / Nom`
pour la ranger dans une catégorie. Les modifications ne vivent que dans la page : le bouton
« JSON ↓ » télécharge les métadonnées courantes dans le format ci-dessus (propriétés du GLB,
du JSON et modifications réunies, `readOnly` compris), et « Annuler les modifications » revient
aux fichiers chargés.

Le fichier décide de ce qui ne doit pas être modifié avec `readOnly`, une liste de motifs :

```json
"readOnly": ["Classe IFC", "Site", "Bâtiment", "Niveau", "Local", "Matériaux", "Qto_*"]
```

- un nom exact (`"Classe IFC"`) verrouille cette propriété ;
- le nom d'une catégorie verrouille tout son contenu (`"Dimensions"` verrouille
  `Dimensions / Hauteur (m)`) ;
- un préfixe suivi de `*` verrouille tout ce qui commence ainsi (`"Qto_*"` : toutes les quantités).

Sans `readOnly`, tout est modifiable. L'identifiant, lui, ne l'est jamais : c'est le lien avec
la géométrie. Le convertisseur IFC fourni verrouille ce qui découle de la structure du modèle
plutôt que d'une saisie : la classe, le type, l'emplacement (site, bâtiment, niveau, local), les
matériaux et les quantités calculées. Le nom, la description, le repère et les jeux de
propriétés (`Pset_…`) restent modifiables.

## 2 ter. Lecture seule pour l’assistant et règles de présentation

Seuls les contrôles manuels modifient les propriétés : ajout, valeur, date, suppression,
annulation et rétablissement. L’assistant consulte les métadonnées et ne dispose d’aucun outil
de modification des propriétés ou de la géométrie. Les coordonnées et mesures non présentes
dans le JSON ne sont pas calculées depuis le maillage pour lui.

Les règles de présentation lisent les propriétés sans les modifier. Leur ordre est significatif :
la dernière règle correspondante gagne pour chaque attribut (couleur et opacité séparément).
Elles sont partagées par le panneau manuel et les outils de l’assistant.

```json
[
  {"id":"co2","enabled":true,"conditions":[{"property":"CO2","op":"greater","value":1000}],"color":"#808080"},
  {"id":"batiment","enabled":true,"conditions":[{"property":"Bâtiment","op":"equals","value":"A"}],"color":"#3366ff"},
  {"id":"avancement","enabled":true,"conditions":[],"opacityBy":{"property":"Avancement","scale":"percent"}}
]
```

Les conditions d’une règle sont combinées par ET ; une liste vide concerne tous les éléments.
Une opacité fixe utilise `opacity` entre 0 et 1. Pour `opacityBy`, l’échelle `percent` signifie
0–100 et `fraction` signifie 0–1 ; les valeurs numériques ne sont pas devinées. Les valeurs
absentes ou non numériques ne remplacent pas une opacité déjà définie. Les règles, comme les
filtres de visibilité, concernent la vue courante et ne modifient pas les matériaux exportés.

## 2 quater. Position sur Terre (`georeference`)

Un bloc optionnel à la racine place la maquette sur la carte du viewer (option « Carte ») :

```json
"georeference": {
  "latitude": 45.747398, "longitude": 4.690430, "elevation": 0,
  "origin": [0, 0, 0], "trueNorth": [0, 1], "rotation": 0, "source": "IfcSite"
}
```

| Champ | Rôle |
| --- | --- |
| `latitude`, `longitude` | Position, en degrés décimaux (WGS 84), du point `origin` du repère du projet. |
| `elevation` | Altitude de ce point en mètres au-dessus du niveau moyen de la mer, comme `RefElevation` dans l'IFC (0 par défaut). Le viewer la convertit lui-même en hauteur au-dessus de l'ellipsoïde pour le globe (géoïde EGM96) ; n'y mettez pas une hauteur ellipsoïdale. |
| `origin` | Ce point, dans le repère du projet tel qu'il est dans l'IFC : X vers l'est du projet, Y vers son nord, Z vers le haut, en mètres ([0, 0, 0] par défaut). |
| `trueNorth` ou `rotation` | Direction du nord vrai dans le plan du projet : un vecteur unitaire, ou un angle en degrés depuis l'axe Y, positif dans le sens horaire ([0, 1] / 0 par défaut). |
| `source` | D'où vient la position : « IfcSite », « manuel »… (informatif). |

Le convertisseur IFC le remplit depuis `IfcSite` (`RefLatitude`, `RefLongitude`, `RefElevation`,
placement du site) et le nord vrai du contexte géométrique ; une `IfcMapConversion` (IFC4) est
recopiée telle quelle sous `projected`, à titre indicatif. Sans ce bloc, la position se saisit
dans la carte (ou d'un clic), et « JSON ↓ » l'enregistre. En USD, le même bloc est dans le
`customLayerData` du calque (`dictionary georeference`).

## 2 quinquies. Phases (`phases`)

Un bloc optionnel à la racine décrit les phases d'un projet (construction, démolition, rénovation) et ce que chaque
filtre de phase fait des éléments. Le viewer en tire un sélecteur « Phase » et un sélecteur « Filtre de phase » (panneau
« Couleurs et filtres »). Il ne connaît aucun nom de propriété ni de phase : tout est dans le bloc.

```json
"phases": {
  "order": ["Existing", "Demolition", "New Construction"],
  "created": "Phase de création",
  "demolished": "Phase de démolition",
  "filters": [
    {
      "name": "Show All", "default": true,
      "statuses": { "past": "hidden", "existing": "overridden", "demolished": "overridden", "new": "normal", "temporary": "overridden", "future": "hidden" }
    },
    { "name": "Show New", "statuses": { "past": "hidden", "existing": "hidden", "demolished": "hidden", "new": "normal", "temporary": "hidden", "future": "hidden" } }
  ],
  "overrides": {
    "existing": { "color": "#7f7f7f" },
    "demolished": { "color": "#ff0000", "opacity": 0.6 }
  }
}
```

| Champ | Obligatoire | Rôle |
| --- | --- | --- |
| `order` | oui | Les noms des phases, de la plus ancienne à la plus récente. |
| `created` | oui | Nom de la propriété qui porte, pour chaque élément, la **phase de création** : une valeur de `order`. |
| `demolished` | non | Nom de la propriété qui porte la **phase de démolition** (une valeur de `order`). Absente : aucun élément n'est démoli. |
| `filters` | non | Les filtres de phase : `name`, `default` (le filtre des vues neuves) et `statuses`. |
| `overrides` | non | L'apparence d'un état « remplacé » : `color` (`#rrggbb`) et `opacity` (0 à 1), par état. |

**États.** Dans la phase choisie, un élément est dans l'un de six états, déduits de la position de sa phase de création et
de sa phase de démolition dans `order` :

| État | Définition |
| --- | --- |
| `future` | créé après la phase ; |
| `new` | créé dans la phase, non démoli dans la phase ; |
| `existing` | créé avant la phase, et pas démoli avant la fin de la phase ; |
| `demolished` | créé avant la phase, démoli dans la phase ; |
| `temporary` | créé et démoli dans la phase ; |
| `past` | démoli avant la phase. |

Un élément sans phase de création (propriété absente, ou valeur qui n'est pas dans `order`) n'est pas lié aux phases : il
reste affiché tel quel, comme un niveau ou une trame dans Revit.

**Filtres.** `statuses` associe à chaque état `hidden` (masqué), `normal` (dessiné tel quel) ou `overridden` (dessiné avec le
remplacement de l'état). Un état absent est dessiné tel quel. Sans `default`, le premier filtre sert aux vues neuves ;
sans filtre du tout, rien n'est masqué ni teinté.

**Remplacements.** Un état `overridden` prend `overrides[état]` : la couleur de l'élément est remplacée (les règles
d'apparence de l'utilisateur restent prioritaires) et l'opacité imposée si elle est inférieure à 1. Sans remplacement pour
l'état, le viewer teinte l'existant en gris, le démoli en rouge translucide et le temporaire en bleu translucide ; un état
`new` n'est jamais teinté sans que le fichier le demande.

Le viewer applique la phase en masquant les éléments (c'est la visibilité des éléments, comme l'arbre et les filtres : un
choix manuel ultérieur reste possible) et par la couleur et l'opacité des éléments remplacés ; le calcul est le même pour
tout fichier qui donne ce bloc. Revit y met, depuis un `.rvt` : la liste ordonnée des phases du projet, les filtres de phase
du projet (sept états par filtre, 0 masqué, 1 selon la catégorie, 2 remplacé) et, pour le remplacement de chaque état,
couleur et transparence du matériau de remplacement de phase (« Phase - Exist », « Phase - Demo »…). Les remplacements
graphiques de lignes (couleur de trait, motif, demi-teinte) ne sont pas repris.

## 2 sexies. Vues enregistrées (`views`)

Un tableau optionnel à la racine liste des vues enregistrées du modèle : un clic dans le menu « Vues » place la caméra et
règle ce que la vue règle. Pour un `.rvt`, ce sont les vues 3D nommées du projet.

```json
"views": [
  {
    "name": "Cuisine",
    "camera": { "position": [-4.61, 1.5, 2.74], "direction": [0.991, -0.051, 0.124], "up": [0.05, 0.999, 0.006], "projection": "perspective", "fov": 57.5 },
    "sectionBox": { "min": [-29.65, -8.32, -20.61], "max": [12.46, 18.42, 55.04], "rotation": 0 },
    "hiddenCategories": { "property": "Catégorie", "values": ["Murs"] },
    "hiddenElements": ["2O2Fr$t4X7Zf8NOew3FLOH"],
    "phase": "New Construction", "phaseFilter": "Show All"
  },
  {
    "name": "{3D}",
    "camera": { "position": [-22.9, 39.3, 46.2], "direction": [0.399, -0.680, -0.616], "up": [0.369, 0.733, -0.571], "projection": "orthographic", "size": [99.9, 48.2] }
  }
]
```

| Champ | Obligatoire | Rôle |
| --- | --- | --- |
| `name` | oui | Nom affiché dans le menu. |
| `camera` | oui | Voir ci-dessous. |
| `sectionBox` | non | Boîte de coupe active de la vue (voir ci-dessous). |
| `hiddenCategories` | non | `property` : nom de la propriété des éléments qui porte leur catégorie ; `values` : les valeurs masquées. La vue désigne elle-même sa propriété : le viewer n'en connaît aucune. |
| `hiddenElements` | non | Clés (celles de `elements`) des éléments masqués. |
| `phase`, `phaseFilter` | non | Phase et filtre de phase de la vue : des noms de `phases.order` et `phases.filters`. |

**Repère.** Toutes les coordonnées sont celles du modèle tel que le GLB les donne : mètres, axe Y vers le haut (pour un
`.rvt` : `(x, y, z)` pieds → `(x, z, −y) × 0,3048`, coordonnées du projet). Le viewer les recentre avec le décalage qu'il
retire à la géométrie (`Model.offset`) : une vue reste juste quel que soit ce décalage.

**Caméra.** `position` (l'œil), `direction` (sens du regard, unitaire) ou `target` (un point regardé, à la place de
`direction`), `up` (haut ; par défaut la verticale, corrigé pour être perpendiculaire au regard), `projection`
(`perspective`, par défaut, ou `orthographic`). En perspective, `fov` est le champ vertical en degrés (sans lui, celui du
viewer reste). En projection parallèle, `size` est la largeur et la hauteur, en mètres, de ce que la vue montre (sans elle,
seule la direction compte : la maquette est cadrée). Le viewer glisse la caméra vers la vue, sauf si les animations sont
réduites dans le système ; saisir la vue interrompt le mouvement. Une vue parallèle garde l'orbite : c'est une vue 3D en
isométrique, pas la vue 2D.

**Boîte de coupe.** `min` et `max` sont les coins de la boîte **avant rotation** ; `rotation` (degrés, 0 par défaut) la
tourne autour de la verticale (Y), dans le sens anti-horaire vu d'en haut, autour de son centre. Le viewer garde l'intérieur de
la boîte : six plans, en plus des trois plans de coupe libres (la carte « Coupes » a une case « Boîte de coupe de la vue »
pour la couper ou la remettre). Une boîte qui n'est pas active n'est pas écrite.

**Ce que fait « Vue par défaut ».** Elle retire la boîte, les masquages de la vue, la phase et le filtre, et replace la caméra
d'avant l'ouverture de la première vue.

**Ce qui n'est pas repris** (un `.rvt` le contient, mais le viewer ne le dessine pas) : les remplacements graphiques par
catégorie ou par élément, les filtres de vue, le niveau de détail, le style visuel, le rendu (ombres, arrière-plan), les
gabarits de vue (la vue enregistre déjà les valeurs qu'un gabarit lui a appliquées) et la profondeur de découpe. Une
vue dont la caméra est illisible est ignorée sans empêcher les autres.

## 2 septies. Compatibilité

Les sections `phases` et `views` sont facultatives et ajoutées sans changer la version du format : un fichier d'avant
continue de s'ouvrir tel quel, un viewer qui ne les connaît pas les ignore, et une section illisible est ignorée (elle n'empêche
pas d'ouvrir le modèle). « JSON ↓ » les réécrit telles qu'elles ont été lues.

## 3. Groupes et sous-groupes

L'arborescence n'est pas écrite dans le fichier. Elle est calculée dans le viewer à partir des
propriétés choisies dans « Grouper par », dans l'ordre : `Niveau` puis `Catégorie` donne un groupe
par niveau, avec un sous-groupe par catégorie à l'intérieur.

Pour offrir une hiérarchie à l'utilisateur (site, bâtiment, étage, local, lot, zone, phase…), le
pipeline n'a donc qu'à écrire une propriété par niveau sur chaque élément. Par exemple, la
structure spatiale d'un IFC devient :

```json
"properties": { "Site": "Campus", "Bâtiment": "A", "Étage": "R+1", "Local": "Bureau 104" }
```

## 4. Évolutions prévues par le format

Le champ `version` permet d'ajouter plus tard des sections optionnelles à côté de `elements`
(regroupements prédéfinis, unités) sans casser les fichiers existants : un viewer en version 1
ignore les sections qu'il ne connaît pas. `georeference`, `phases` et `views` sont déjà de celles-là.

## 5. Variante USD

Le viewer accepte aussi un fichier USD (`.usdz` contenant un `.usda`, ou `.usda` seul) à la place
du GLB. L'identifiant et les propriétés peuvent alors être écrits directement dans le fichier,
dans le `customData` du prim de chaque élément :

```
def Xform "E_2O2Fr_t4X7Zf8NOew3FLOH" (
    customData = {
        string id = "2O2Fr$t4X7Zf8NOew3FLOH"
        string label = "Mur extérieur 01"
        dictionary properties = {
            string "Catégorie" = "Mur"
            string Niveau = "R+1"
            dictionary Dimensions = { double "Longueur (m)" = 4.2 }
        }
    }
)
```

Un JSON déposé avec le fichier reste prioritaire sur ces métadonnées embarquées. La liste
`readOnly` se place dans le `customLayerData` du calque (`string[] readOnly = [...]`). Après des
modifications dans le viewer, « USD ↓ » réécrit le paquet issu de la conversion avec les
métadonnées courantes.

## 6. Le convertisseur IFC fourni

`pipeline/ifc_to_glb.py` produit ce format à partir d'un IFC : `extras.id` et les clés du JSON
sont les `GlobalId` des éléments, et la structure spatiale (site, bâtiment, niveau, local) est
écrite comme propriétés. Voir [pipeline/README.md](../pipeline/README.md).

## 7. Vérifier un export

`scripts/make-sample.mjs` génère un GLB et un JSON conformes, à comparer avec la sortie du
pipeline. Au chargement, le viewer indique combien d'éléments ont trouvé leurs métadonnées ;
si aucun identifiant ne correspond, il le signale et conserve les métadonnées déjà en place.
