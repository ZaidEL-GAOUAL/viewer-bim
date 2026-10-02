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

Le fichier GLB lui-même n'est jamais modifié.

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
(vues enregistrées, regroupements prédéfinis, unités) sans casser les fichiers existants : un
viewer en version 1 ignore les sections qu'il ne connaît pas.

## 5. Le convertisseur IFC fourni

`pipeline/ifc_to_glb.py` produit ce format à partir d'un IFC : `extras.id` et les clés du JSON
sont les `GlobalId` des éléments, et la structure spatiale (site, bâtiment, niveau, local) est
écrite comme propriétés. Voir [pipeline/README.md](../pipeline/README.md).

## 6. Vérifier un export

`scripts/make-sample.mjs` génère un GLB et un JSON conformes, à comparer avec la sortie du
pipeline. Au chargement, le viewer indique combien d'éléments ont trouvé leurs métadonnées ;
si aucun identifiant ne correspond, il le signale et conserve les métadonnées déjà en place.
