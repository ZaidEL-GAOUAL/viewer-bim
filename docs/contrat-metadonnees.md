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
| `source` | non | `{ "name": "maison.rvt", "kind": "revit" }` : le fichier source que ce JSON de modifications complète (`kind` : `revit`, `ifc`, `glb` ou `usd`). Informatif ; voir § 2 bis. |
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
- une valeur `null` dans le JSON **retire** la propriété du GLB (sans propriété du même nom dans le GLB, rien n'est
  retiré et la valeur reste vide) ;
- sans fichier JSON, ou pour un élément absent du JSON, seules les propriétés du GLB s'affichent.

Les JSON complets exportés par le viewer (« JSON ↓ ») portent `"propertiesMode": "replace"`. Pour les identifiants
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
pour la ranger dans une catégorie. Une saisie garde le type de la propriété : un nombre reste un
nombre (« 12,5 » avec la virgule française est lu), un booléen un booléen (« oui », « non ») ; une
valeur qui ne se convertit pas est refusée avec un message. Une propriété nouvelle prend le type
que le texte a l'air d'avoir. Une valeur différente du fichier d'origine est marquée, « ↺ » y
revient, et la case « Modifiées seulement » ne montre qu'elles.

Le fichier ouvert n'est jamais modifié. Les modifications vivent dans la page et se téléchargent
de deux façons :

- **« Modifications ↓ »** (le nombre d'éléments modifiés entre parenthèses) : un JSON de
  modifications, qui ne contient que ce qui diffère du fichier d'origine, en mode fusion (sans
  `propertiesMode`). Une propriété supprimée y vaut `null`. Chaque élément y porte aussi ses
  propriétés verrouillées (pour un `.rvt` : « Identifiant Revit »…), qui disent quel élément du
  fichier source il désigne. `source` nomme ce fichier. Comme il ne contient que les modifications,
  il reste valable après un nouvel enregistrement du fichier dans Revit : les valeurs que
  l'utilisateur n'a pas touchées viennent fraîches du fichier. Les vues que l'utilisateur a
  enregistrées (§ 2 sexies, « Vues de l'utilisateur ») y sont aussi, dans `views` : ce sont des
  modifications. Un tel fichier peut n'avoir que des vues (`"elements": {}`). Les découpages en pièces (§ 2 nonies) et
  les zones (§ 2 decies) y sont aussi, entiers, dans `splits` et `zones`, comme les observations (§ 2 terdecies), dans
  `observations`.
- **« JSON ↓ »** : toutes les propriétés, dans le format ci-dessus (propriétés du GLB, du JSON et
  modifications réunies, `readOnly` compris, `"propertiesMode": "replace"`), pièces comprises, avec `splits`, `zones` et
  `observations`.

« Annuler les modifications » revient au fichier d'origine.

```json
{
  "version": 1,
  "source": { "name": "maison.rvt", "kind": "revit" },
  "elements": {
    "2O2Fr$t4X7Zf8NOew3FLOH": {
      "properties": { "Identifiant Revit": 318215, "Niveau": "R+2", "Commentaires": null }
    }
  }
}
```

**À l'ouverture**, le modèle et ses JSON déposés ensemble sont réunis ainsi :

- la base est le JSON complet qui décrit le plus d'éléments du modèle : les métadonnées que le
  fichier donne lui-même (lecture d'un `.rvt`, conversion d'un `.ifc`) ou un JSON
  `"propertiesMode": "replace"` déposé avec lui, qui l'emporte à égalité. Les vues, les phases, la
  position et `readOnly` restent alors ceux du fichier, relus frais ;
- chaque JSON en mode fusion déposé avec un `.rvt` ou un `.ifc`, et chaque JSON qui porte `source`
  déposé avec un glb, un glTF ou un USD, s'applique par-dessus la base, par ordre de nom de fichier.
  Ses valeurs comptent comme des modifications : le prochain « Modifications ↓ » les garde, et
  « Annuler » y revient. Une valeur verrouillée par le fichier n'est pas remplacée ;
- un JSON de modifications dont moins de la moitié des éléments se trouve dans le modèle est
  appliqué quand même, et le viewer le dit (« 12 éléments modifiés sur 40 introuvables dans ce
  modèle »).

Avec un glb, un glTF ou un USD, un JSON en mode fusion sans `source` le complète comme décrit plus haut.

Le fichier décide de ce qui ne doit pas être modifié avec `readOnly`, une liste de motifs :

```json
"readOnly": ["Classe IFC", "Site", "Bâtiment", "Niveau", "Local", "Matériaux", "Qto_*"]
```

- un nom exact (`"Classe IFC"`) verrouille cette propriété ;
- le nom d'une catégorie verrouille tout son contenu (`"Dimensions"` verrouille
  `Dimensions / Hauteur (m)`) ;
- un préfixe suivi de `*` verrouille tout ce qui commence ainsi (`"Qto_*"` : toutes les quantités).

Sans `readOnly`, tout est modifiable. L'identifiant, lui, ne l'est jamais : c'est le lien avec
la géométrie. La lecture d'un `.rvt` ne verrouille que l'identité de l'élément : « Identifiant
Revit », « GUID IFC » et « Source de la géométrie ». Le convertisseur IFC fourni verrouille ce qui découle de la structure du modèle
plutôt que d'une saisie : la classe, le type, l'emplacement (site, bâtiment, niveau, local), les
matériaux et les quantités calculées. Le nom, la description, le repère et les jeux de
propriétés (`Pset_…`) restent modifiables.

## 2 ter. Modification par l’assistant et règles de présentation

Les propriétés se modifient par les contrôles manuels (ajout, valeur, date, suppression,
annulation et rétablissement) et par l’assistant, qui n’a que deux outils d’écriture :
`set_property` (une valeur fixe ou une formule par élément) et `plan_dates` (des dates de début
et de fin, groupées et ordonnées). Ces écritures passent par la même étape annulable que les
contrôles manuels, respectent `readOnly` et gardent le type de la propriété comme une saisie dans
la fiche ; elles font partie des modifications que « Modifications ↓ » télécharge. Dans
l’onglet Assistant, une écriture sur plus de 200 éléments ou sur toute la maquette est d’abord
montrée et n’a lieu qu’après « Appliquer » ; par `window.viewerBim`, `dryRun: true` donne le
même aperçu sans rien écrire. L’assistant
ne modifie jamais la géométrie. Les
coordonnées et mesures absentes du JSON ne sont pas calculées depuis le maillage pour le
modèle d’IA : `plan_dates` lit la hauteur des éléments dans la maquette pour les ordonner, et
cette géométrie reste dans le navigateur, elle n’est jamais envoyée au modèle.

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
Les conditions se lisent de la même façon dans les règles et dans les filtres de l’assistant
(`equals`, `not_equals`, `contains`, `greater`, `less`, `greater_or_equal`, `less_or_equal`,
`missing`, `present`). Les textes se comparent sans tenir compte de la casse ni des accents, et deux
valeurs qui se lisent comme des nombres (« 1 200 », « 1200,0 », `1200`) sont égales. **Une valeur
absente (propriété manquante, `null` ou texte vide) n’est égale à rien** : `not_equals` la retient,
alors que `equals`, `contains` et les comparaisons numériques ne la retiennent jamais ; seuls
`missing` et `present` parlent des valeurs absentes.
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
règle ce que la vue règle. Pour un `.rvt`, ce sont les vues 3D nommées du projet et ses plans d'étage (voir « Plans
d'étage » plus bas).

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
  },
  {
    "name": "GF", "kind": "plan", "type": "Floor Plan",
    "camera": { "position": [3.2, 30, 12.5], "direction": [0, -1, 0], "up": [0, 0, -1], "projection": "orthographic", "size": [62.4, 41.0] },
    "range": { "bottom": 0.3, "top": 1.5 },
    "sectionBox": { "min": [-28, 0.3, -8], "max": [34.4, 1.5, 33], "rotation": 0 },
    "hiddenElements": ["2O2Fr$t4X7Zf8NOew3FLOH"]
  }
]
```

| Champ | Obligatoire | Rôle |
| --- | --- | --- |
| `name` | oui | Nom affiché dans le menu. |
| `kind` | non | `"plan"` pour un plan d'étage ; absent (ou `"3d"`) pour une vue 3D. Voir « Plans d'étage ». |
| `type` | non | Le type de vue de Revit (« Floor Plan », « Structural Plan »…) : sert à distinguer deux plans de même nom. Affiché dans le menu. |
| `range` | plans | `{ "bottom": nombre, "top": nombre }`, en mètres, dans le repère du modèle (Y vers le haut, comme `sectionBox`). `top` est le plan de coupe ; `bottom` est la profondeur de vue, absente quand elle est illimitée. |
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
la boîte : six plans, en plus des trois plans de coupe libres. La carte « Coupes » la coupe ou la remet (case « Boîte de
coupe »), la pose autour de la sélection ou de ce qui est visible, et la modifie par ses poignées (une par face, et une
rotation autour de la verticale), même posée par une vue. Une boîte qui n'est pas active n'est pas écrite.

**Plans d'étage** (`kind: "plan"`). Un plan est vu de dessus, coupé à la hauteur de coupe du plan : il montre la maquette
entre sa profondeur de vue (`range.bottom`) et son plan de coupe (`range.top`), moins ce qu'il masque (`hiddenElements`,
`hiddenCategories`) et ce que son filtre de phase écarte. Le viewer l'ouvre comme une vue 2D :

- **Caméra.** Parallèle, regardant vers le bas (`direction: [0, -1, 0]`), `up` donnant le haut de l'écran (celui du
  plan dans Revit). Avec `size`, c'est la fenêtre du recadrage du plan ; sans `size`, la
  maquette est cadrée. L'œil est remonté au-dessus de la maquette, sur son axe : l'image est la même, mais le plan proche
  ne passe plus dans le plan de coupe, qui garderait sinon sa coupe (le remplissage des murs coupés) hors du champ.
- **Sans rotation.** Comme le bouton « 2D » : déplacement et zoom seulement. La rotation revient quand on ouvre une vue 3D,
  « Vue par défaut » ou qu'on quitte le mode 2D. Une vue 3D parallèle, elle, garde l'orbite.
- **Boîte de coupe.** Celle du plan, calculée par le viewer : en x et z, le `sectionBox` du plan (avec sa `rotation`) s'il
  en a un, sinon la boîte du modèle agrandie de 1 m de chaque côté ; en y, de `range.bottom` moins 2 cm (de quoi garder
  dans la coupe le dessus d'une dalle ou un DWG posé exactement au niveau) à `range.top`, ou, sans `range.bottom`, du bas
  du modèle moins 1 m. Le y de `sectionBox` n'est pas lu : la plage du plan le remplace.
- **Étendue lisible.** Un plan a besoin d'un `range.top` fini ; `range.bottom`, s'il est écrit, doit être fini et plus bas
  que `range.top`. Sinon l'étendue est écartée et l'entrée est lue comme une vue ordinaire (sa caméra, ses masquages et sa
  phase restent). `range` sur une vue qui n'est pas un plan est sans effet.
- **Menu « Vues ».** Les groupes « Mes vues », « Vues 3D », « Plans d'étage » et « Plans par niveau » (chacun s'il a des
  vues) ; la note d'un plan est son
  `type` (ou « plan »), puis « masquages » et sa phase.
- **Mode carte.** Comme pour toute vue : le reste de la vue est appliqué, la caméra attend la fermeture de la carte.

**Compatibilité des plans.** `kind`, `type` et `range` sont des ajouts : un viewer qui ignore `kind` ouvre un plan comme
une vue parallèle de dessus (sa caméra, ses masquages et sa phase), sans coupe à la hauteur du plan.

**À l'ouverture.** Quand le fichier a au moins une vue 3D, les éléments que **toutes** ses vues 3D masquent (une clé de
`hiddenElements`, ou une valeur de `hiddenCategories`, comme quand la vue est ouverte) démarrent masqués : Revit ne les
montre dans aucune vue 3D du fichier. Un élément que seules certaines vues 3D masquent reste visible, puisqu'une autre vue
le montre ; sans vue 3D, ou si aucun élément n'est masqué par toutes, rien ne change. **Les plans d'étage ne comptent pas
dans cette règle** : l'ouverture montre la maquette en 3D, et un plan s'écarte de la 3D dans les deux sens (il montre le
dessin DWG d'un niveau que les vues 3D masquent, et masque celui d'un autre niveau). Les éléments masqués restent dans
l'arbre, œil éteint : l'utilisateur peut les afficher, et « Tout afficher » les montre. C'est un comportement du viewer,
pas un changement de format.

**Ce que fait « Vue par défaut ».** Elle retire la boîte, la phase et le filtre, et replace la caméra d'avant l'ouverture de
la première vue (en perspective, avec la rotation, si c'est ainsi qu'elle était). Elle ramène les masquages à l'état de
l'ouverture : ce que toutes les vues 3D masquent reste masqué, le reste est affiché (sans vue 3D, ou si aucun élément n'est
masqué par toutes, tout est affiché).

**Vues de l'utilisateur** (`origin: "user"`). Le menu « Vues » enregistre ce que l'utilisateur voit (« Enregistrer cette
vue ») ; ses vues forment le groupe « Mes vues », au-dessus des vues du fichier, et se mettent à jour, se renomment, se
dupliquent, se suppriment et se déplacent. Une vue du fichier ne se modifie pas, mais se duplique dans « Mes vues ». Elles
s'écrivent dans `views`, à la suite des vues du fichier, avec ces champs en plus (tous facultatifs) :

```json
{
  "name": "Coupe R+1", "origin": "user", "id": "6f1c0e3e-0b8e-4b1a-9d0c-6a2f2d1c9b47",
  "camera": { "position": [651210, 40, -6861490], "direction": [0, -0.6, -0.8], "up": [0, 0.8, -0.6], "projection": "perspective", "fov": 50 },
  "sectionBox": { "min": [651200, 35, -6861500], "max": [651210, 41, -6861494], "rotation": 20 },
  "sections": [{ "name": "Niveau R+1", "point": [651205, 39.2, -6861497], "normal": [0, 1, 0], "enabled": true }],
  "hiddenElements": ["2O2Fr$t4X7Zf8NOew3FLOH"],
  "isolated": ["1kTvXnbbzCWw8lcMd1dR4o", "0BTBFw6f90Nfh9rP1dl_3P"],
  "appearanceRules": [{ "id": "r1", "enabled": true, "conditions": [{ "property": "Niveau", "op": "equals", "value": "R+1" }], "color": "#3366ff" }],
  "grouping": ["Niveau", "Catégorie"],
  "phase": "New Construction"
}
```

| Champ | Rôle |
| --- | --- |
| `origin` | `"user"` : une vue enregistrée par l'utilisateur, modifiable dans le viewer. Absent (ou `"file"`) : une vue du fichier, en lecture seule. |
| `id` | Identifiant stable de la vue (renommer ne le change pas) ; deux fichiers qui portent la même vue la donnent une fois. |
| `sections` | Plans de coupe libres (trois au plus) : `point` et `normal` dans le repère du modèle (mètres, Y vers le haut, comme `sectionBox`), `normal` unitaire tournée vers la partie retirée (le côté d'où l'on regarde la coupe), `enabled` (vrai par défaut), `name` facultatif. |
| `isolated` | Clés des éléments isolés : eux seuls sont affichés ; `hiddenElements` est alors ce que « Ne plus isoler » laisse masqué. |
| `appearanceRules` | Les règles de présentation (§ 2 ter), dans leur ordre. Une liste illisible est ignorée en entier. |
| `grouping` | Les propriétés de « Grouper par », dans l'ordre. Une propriété que le modèle n'a pas est ignorée. |

Une vue de l'utilisateur est **tout** ce qu'il voyait : à son ouverture, tout est d'abord réaffiché, puis la vue masque,
isole, coupe (ses plans ; sans `sections`, aucun plan libre) et colore. Les éléments masqués par la phase ne sont pas
écrits (la phase les masque de nouveau). Enregistrée depuis un plan d'étage ouvert en 2D, elle est un plan (`kind: "plan"`)
dont `range` et `sectionBox` sont la boîte du moment : elle se rouvre en 2D, sans rotation. Une clé qu'aucun élément ne
porte (le fichier a changé depuis) est ignorée, et le viewer dit combien. Les vues de l'utilisateur ne comptent pas dans la
règle « À l'ouverture » ci-dessus. Elles sont écrites par « JSON ↓ » et par « Modifications ↓ » ; à la relecture d'un
`.rvt` avec un JSON complet déposé, les vues du fichier sont relues fraîches et celles de l'utilisateur viennent du JSON.

**Plans par niveau.** Avec une section `levels` (§ 2 octies), le menu propose « Plan du niveau … » pour chaque niveau
qu'aucun plan du fichier ne couvre (même nom, ou profondeur de vue à moins de 5 cm du niveau) : vu de dessus, cadré sur la
maquette, `range` de l'altitude du niveau à 1,20 m au-dessus. Calculé à l'ouverture du menu, il n'est écrit nulle part tant
que l'utilisateur ne l'enregistre pas.

**Ce qui n'est pas repris** (un `.rvt` le contient, mais le viewer ne le dessine pas) : les remplacements graphiques par
catégorie ou par élément, les filtres de vue, le niveau de détail, le style visuel, le rendu (ombres, arrière-plan), les
gabarits de vue (la vue enregistre déjà les valeurs qu'un gabarit lui a appliquées) et la profondeur de découpe d'une vue
3D (celle d'un plan est sa plage `range`). Pour un plan, ne sont pas repris non plus : les plans de plafond, les fonds de
plan, les régions de plan, les sous-catégories masquées, les styles de ligne, les motifs de coupe, le tracé au-delà de la
coupe et les annotations (le détail de ce que la lecture d'un `.rvt` prend est dans `docs/lecture-revit.md`). Une vue
dont la caméra est illisible est ignorée sans empêcher les autres.

## 2 septies. Compatibilité

Les sections `phases`, `views` et `levels` sont facultatives et ajoutées sans changer la version du format : un fichier d'avant
continue de s'ouvrir tel quel, un viewer qui ne les connaît pas les ignore, et une section illisible est ignorée (elle n'empêche
pas d'ouvrir le modèle). `source` et la valeur `null` qui retire une propriété en mode fusion (§ 2 bis) sont des ajouts de même
nature : un viewer qui ignore `source` lit le JSON de modifications comme un complément, et un viewer qui ignore le sens de `null`
montre une valeur vide. Les champs `kind`, `type` et `range` des vues (plans d'étage) sont des ajouts de même nature : un
viewer qui les ignore ouvre un plan comme une vue parallèle de dessus. « JSON ↓ » les réécrit telles qu'elles ont été lues.
Les champs des vues de l'utilisateur (`origin`, `id`, `sections`, `isolated`, `appearanceRules`, `grouping`) le sont aussi :
un viewer qui les ignore ouvre la vue comme une vue du fichier (sa caméra, sa boîte, ses masquages, sa phase). Les sections
`splits` et `zones` aussi : un viewer qui les ignore montre les éléments entiers, et les propriétés écrites sur des pièces
(clés `<clé>~<n>`) ne trouvent pas leur élément, sans empêcher l'ouverture. Un JSON de modifications peut n'avoir que des
découpages ou des zones (`"elements": {}`). Les sections `clashTests` et `clashes` aussi : un viewer qui les ignore ouvre le
fichier sans conflits ; un JSON de modifications peut n'avoir qu'elles. La section `observations` aussi : un viewer qui l'ignore
ouvre le fichier sans observations ; un JSON de modifications peut n'avoir qu'elle.

## 2 octies. Niveaux (`levels`)

Une liste optionnelle à la racine donne les niveaux du modèle :

```json
"levels": [{ "name": "RDC", "elevation": 35.0 }, { "name": "R+1", "elevation": 38.0 }]
```

| Champ | Rôle |
| --- | --- |
| `name` | Nom du niveau (texte non vide). |
| `elevation` | Altitude du niveau, en mètres, dans le repère du modèle : le Y du GLB, c'est-à-dire la hauteur Z de l'IFC. |

Le viewer la trie par altitude et écarte une entrée sans nom ou sans altitude finie. Il s'en sert pour les plans par niveau
(§ 2 sexies) et la coupe « au niveau » (carte « Coupes » : un plan horizontal à 1,20 m au-dessus du niveau choisi, ou à une
hauteur saisie dans le même repère). Le convertisseur IFC fourni l'écrit depuis les `IfcBuildingStorey` : la hauteur de leur
placement (c'est elle qui place la géométrie), à défaut leur attribut `Elevation`, convertie en mètres. La lecture d'un
`.rvt` ne l'écrit pas encore. « JSON ↓ » la réécrit telle qu'elle a été lue.

## 2 nonies. Découpage en pièces (`splits`)

Une liste optionnelle à la racine décrit comment des éléments sont coupés en pièces (comme les « pièces » de Revit) : le
fichier garde la **définition** des coupes, jamais les maillages. Le viewer en tire les pièces à chaque ouverture.

```json
"splits": [
  { "id": "c1", "elements": ["RMpIvF5jLado8i5KMrQscB"], "lines": [[[10, 0.2, -8], [10, 0.2, 8]], [[-2, 0.2, 6], [22, 0.2, 6]]] },
  { "id": "c2", "elements": ["2O2Fr$t4X7Zf8NOew3FLOH"], "references": { "levels": ["R+1"] } },
  { "id": "c3", "elements": ["0BTBFw6f90Nfh9rP1dl_3P"], "references": { "axis": "x", "count": 4 }, "merged": [["0BTBFw6f90Nfh9rP1dl_3P~1", "0BTBFw6f90Nfh9rP1dl_3P~2"]] }
]
```

| Champ | Rôle |
| --- | --- |
| `id` | Identifiant stable du découpage ; deux fichiers qui portent le même le donnent une fois (le plus récent). |
| `elements` | Clés (celles de `elements`) des éléments découpés. |
| `lines` | Lignes dessinées en plan, deux points chacune, dans le repère du modèle (mètres, Y vers le haut, comme `sectionBox`) ; seuls x et z comptent. Chaque ligne porte un plan de coupe vertical et doit traverser l'élément de part en part : une coupe partielle est refusée. |
| `references` | À la place de `lines`, une coupe automatique : `levels` (noms de la section `levels` : coupe horizontale à l'altitude du niveau), ou `axis` (`"x"` ou `"z"`, axes du repère du modèle) avec `positions` (coordonnées sur cet axe), `interval` (un pas en mètres depuis le bord de chaque élément) ou `count` (nombre de parts égales de chaque élément). |
| `merged` | Facultatif : groupes de clés de pièces réunies ; chaque groupe devient la pièce du plus petit numéro. |

**Limites.** Une définition donne au plus 200 plans de coupe (lignes, niveaux et coupes le long d'un axe réunis) ; `count`
vaut au plus 200, `positions` a au plus 200 valeurs et `interval` vaut au moins 0,01 m. Une définition qui demande plus est
écartée à la lecture, et le viewer le dit (« Découpage « c1 » ignoré : plus de 200 coupes ») ; un pas accepté qui donnerait
plus de 200 coupes sur un élément très long est refusé pour cet élément. Le reste du fichier s'ouvre normalement.

**Pièces.** Une pièce est un élément de plus, ajouté au modèle : clé `<clé de l'original>~<n>`, numérotée de bas en haut, puis
du sud au nord, puis d'ouest en est (centre de sa boîte, au millimètre) : les mêmes coupes redonnent les mêmes numéros, donc les
propriétés et les dates écrites sur une pièce la retrouvent à la réouverture. Elle reprend les propriétés de l'original, plus
`Pièce / Origine` (nom et clé de l'original), `Pièce / Numéro`, `Pièce / Séquence` (modifiable ; vaut d'abord le numéro, et sert
à ordonner le planning), `Pièce / Maillage valide` (faux si la pièce n'est pas un solide fermé) et ses propres quantités
(« Quantités calculées », et les quantités de base IFC que porte l'original, recalculées ; `Fiabilité` vaut `indicatif` si le
maillage n'est pas valide). L'original n'est ni modifié ni retiré : il reste dans l'arbre, masqué tant qu'il a des pièces.
Seuls les solides fermés se découpent ; un maillage ouvert ou non manifold est refusé, avec la raison.

**Avec les fichiers.** « GLB ↓ » écrit les pièces à la place de leurs originaux (et le dit). Rouvert avec son JSON, ce GLB
contient déjà les pièces : le découpage n'est pas refait. Un élément de `elements` que le modèle n'a pas est signalé.

## 2 decies. Zones (`zones`)

Une liste optionnelle à la racine donne des zones dessinées en plan ; un élément est rangé dans celle qui couvre la plus grande
part de son emprise, écrite dans une propriété choisie à ce moment (« Zone » par défaut). Aucune géométrie n'est créée.

```json
"zones": [{ "name": "Zone A", "points": [[0, 0, 0], [20, 0, 0], [20, 0, -12], [0, 0, -12]] }]
```

`name` : nom de la zone (non vide) ; `points` : au moins trois sommets du polygone, dans le repère du modèle (mètres, Y vers le
haut) ; seuls x et z comptent. Une zone de même nom dans deux fichiers est donnée une fois (la plus récente).

## 2 undecies. Plusieurs maquettes

« Ajouter… » (et la carte « Maquettes » du menu « Contrôles ») ouvre une maquette de plus dans la même scène : un `.glb`, un
`.gltf`, un `.usdz` ou un `.ifc` (converti), avec son JSON. Un fichier Revit ne s'ajoute pas encore. Rien ne change dans les
fichiers ; c'est un comportement du viewer :

- **Repère.** Un seul, celui de la première maquette. Les suivantes sont placées par leurs coordonnées d'origine, jamais
  recentrées sur elles-mêmes : deux fichiers d'un même projet se superposent s'ils partagent leur repère. Quand deux maquettes
  sont plus loin l'une de l'autre que leur propre taille, le viewer dit que leurs repères diffèrent peut-être.
- **`Modèle`.** Chaque élément reçoit la propriété `Modèle`, le nom du fichier de sa maquette (une pièce, celui de son
  original), verrouillée : l'arbre, les filtres, les couleurs et le planning l'utilisent comme toute propriété.
- **Clés.** Chaque maquette garde les clés de son fichier. Une clé déjà prise par une maquette ouverte avant elle devient
  `<id>|<clé>` dans la session (`m2|2O2Fr$t4X7Zf8NOew3FLOH`), ce qui est le cas normal en comparant deux versions ; les
  maquettes déjà ouvertes ne changent jamais de clés.
- **Exports.** « JSON ↓ » et « Modifications ↓ » écrivent un fichier par maquette (`<nom>.json`, `<nom>.modifications.json`),
  chacun avec les clés de son fichier et sans `Modèle` : chaque JSON reste celui de son fichier. Les sections de la session
  (`views`, `splits`, `zones`, `georeference`, `phases`, `levels`, `clashTests`, `clashes`, `observations`) vont avec la
  première maquette.
  « GLB ↓ » écrit la réunion des maquettes, sous les clés de la session, et le dit.
- **Limites.** Toutes les maquettes partagent le budget de triangles de l'appareil : un ajout qui le dépasserait est refusé,
  avec les chiffres. Seule la dernière maquette ajoutée se retire. Le découpage en pièces ne porte que sur la première. En
  mode carte, ajouter, comparer et chercher des conflits attendent la fermeture de la carte.

**Comparer deux versions.** « Comparer avec… » (carte « Comparaison ») ajoute l'autre version comme maquette de référence
et apparie les éléments par leur clé : propriétés ajoutées, retirées ou changées (des motifs ignorés, même syntaxe que
`readOnly`), et géométrie (boîte au millimètre, nombre de triangles, volume et surface à 4 chiffres significatifs : même
forme au même endroit, déplacée, ou modifiée). Un élément sans paire qui a la même catégorie (une propriété choisie), le même
nom et la même forme qu'un élément supprimé, à moins de 50 cm, est montré « identifiant changé, probablement le même », jamais
fusionné. Le résultat colore la vue (ajouté vert, supprimé rouge translucide, modifié orange, inchangé estompé) : ce n'est pas
une propriété, rien n'en est exporté dans les JSON ; le rapport se télécharge à part (CSV ou JSON).

## 2 duodecies. Conflits (`clashTests`, `clashes`)

Deux listes optionnelles à la racine gardent le test de conflits et les conflits trouvés, avec le statut et le commentaire que
l'utilisateur leur a donnés (carte « Conflits ») :

```json
"clashTests": [{
  "id": "t1", "name": "Structure × réseaux", "type": "hard", "tolerance": 0.01,
  "a": { "model": "structure.ifc", "conditions": [{ "property": "Catégorie", "op": "equals", "value": "Poutre" }] },
  "b": { "model": "reseaux.ifc", "conditions": [] },
  "exclude": [{ "property": "Catégorie", "op": "equals", "value": "Réservation" }],
  "sameValue": "Hôte"
}],
"clashes": [{
  "test": "t1", "status": "active", "comment": "réservation à prévoir", "depth": 0.045, "point": [12.4, 3.1, -8.2],
  "a": { "key": "2O2Fr$t4X7Zf8NOew3FLOH", "model": "structure.ifc" },
  "b": { "key": "1kTvXnbbzCWw8lcMd1dR4o", "model": "reseaux.ifc" }
}]
```

| Champ | Rôle |
| --- | --- |
| `clashTests[].a`, `.b` | Les deux ensembles : `model`, le nom du fichier d'une maquette (absent : toutes, sauf une version de référence) ; `conditions`, comme celles des règles de présentation (§ 2 ter), toutes vraies. |
| `type`, `tolerance` | `hard` : un conflit franc, qui pénètre de plus que `tolerance` (mètres, 0,01 par défaut). Deux éléments qui se touchent n'en sont pas un. |
| `exclude` | Les éléments qui répondent à ces conditions ne sont dans aucun ensemble. |
| `sameValue` | Facultatif : les paires d'une même maquette qui ont la même valeur de cette propriété sont ignorées (un élément et son hôte). |
| `clashes[].a`, `.b` | Les deux éléments : `key`, la clé dans le fichier de leur maquette (sans préfixe de session), et `model`, le nom de ce fichier. |
| `status` | `new` (trouvé au dernier calcul), `active` (retrouvé), `resolved` (n'est plus trouvé), `ignored` (choisi par l'utilisateur). |
| `comment` | Texte libre. |
| `depth`, `point` | Profondeur approchée (mètres) et centre de la zone de recouvrement, dans le repère du modèle (mètres, Y vers le haut). |

Un nouveau calcul retrouve chaque conflit par ses deux éléments : il garde son commentaire, un conflit ignoré le reste, un
conflit qui n'est plus trouvé devient `resolved`. Un conflit dont une maquette n'est pas ouverte est gardé tel quel. Le viewer
ne connaît aucun nom de propriété : les ensembles, les exclusions et `sameValue` sont choisis par l'utilisateur. « JSON ↓ » et
« Modifications ↓ » écrivent ces deux sections ; une section illisible, ou une entrée illisible, est ignorée.

## 2 terdecies. Observations (`observations`)

Un objet optionnel à la racine garde le suivi de chantier (carte « Observations », menu « Chantier ») : les réglages (les
propriétés lues comme niveau, local et zone), les listes du projet (types, statuts et transitions permises, lots, priorités,
phases, entreprises) et les observations elles-mêmes, **sans leurs photos ni leurs images**, qui voyagent dans le fichier
`.bcf` exporté à côté. Elles y ajoutent ce que le BCF n'a pas : le repère posé sur un plan, le point 3D (repère d'origine,
Z vers le haut), l'emplacement, les éléments par maquette et clé, le numéro. Le format, la correspondance avec le BCF et la
fusion par GUID sont décrits dans `docs/contrat-observations.md`. « JSON ↓ » et « Modifications ↓ » écrivent la section ; un
JSON déposé sur le modèle ouvert ajoute ses observations à celles de la session ; une section illisible est ignorée, une
observation illisible écartée.

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
ignore les sections qu'il ne connaît pas. `georeference`, `phases`, `views`, `levels`, `splits`, `zones`, `clashTests`, `clashes` et `observations` sont déjà de
celles-là.

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
