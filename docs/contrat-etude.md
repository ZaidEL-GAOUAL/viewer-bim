# Contrat du fichier d'étude de site (version 1)

Ce document décrit le fichier JSON qu'ouvre et qu'enregistre la page **Étude de site** (`site.html`). Une étude tient un
site, son contexte (voisins et relief, lus une fois puis gardés) et des propositions faites de volumes. Rien n'est gardé
dans le navigateur : le fichier est la seule mémoire de l'étude. Code : `src/site/study.ts` (lecture, écriture).

## Repère

- **Local, en mètres** : est, nord depuis l'**origine** du site (`site.origin`), dans le plan tangent à la Terre en ce
  point (ellipsoïde WGS84). Un point du plan s'écrit `[est, nord]`.
- **Hauteurs** (« haut ») : en mètres depuis l'**altitude de l'origine** (`site.origin.altitude`, au-dessus du niveau de la
  mer). Le relief (`context.terrain.heights`) est, lui, en altitudes : le sol local vaut `altitude − site.origin.altitude`.
- Le nord du repère est le nord vrai.

## Exemple

```json
{
  "format": "etude-de-site",
  "version": 1,
  "name": "Îlot des Tanneurs",
  "site": {
    "origin": { "latitude": 48.8566, "longitude": 2.3522, "altitude": 35 },
    "utcOffset": 1,
    "limit": [[0, 0], [40, 0], [40, 25], [0, 25]]
  },
  "context": {
    "buildings": [
      { "id": "osm-123", "footprint": [[50, 0], [60, 0], [60, 10], [50, 10]], "height": 12, "heightSource": "tagged" }
    ],
    "terrain": { "west": -300, "south": -300, "step": 30, "columns": 21, "rows": 21, "heights": [35.2, 35.4, "…"] },
    "credits": ["Bâtiments : © les contributeurs d’OpenStreetMap (ODbL), lus par Overpass", "Relief : Terrain Tiles (AWS Open Data, Mapzen) — …"],
    "radius": 300,
    "fetchedAt": "2026-11-14T10:00:00.000Z"
  },
  "proposals": [
    {
      "id": "6f1c…",
      "name": "Proposition 1",
      "volumes": [
        { "id": "a41e…", "name": "Bâtiment A", "footprint": [[5, 5], [25, 5], [25, 15], [5, 15]],
          "baseLevel": 0, "floors": 5, "floorHeight": 3, "use": "logement", "floorUses": ["commerce"] }
      ]
    }
  ],
  "settings": {
    "uses": [{ "id": "logement", "name": "Logement", "color": "#e9b44c", "housing": true }, "…"],
    "dwellingSize": 65,
    "efficiency": 0.8,
    "units": "m2"
  }
}
```

## Champs

| Champ | Obligatoire | Rôle |
| --- | --- | --- |
| `format` | oui | Toujours `"etude-de-site"` : distingue une étude d'un JSON de métadonnées du viewer. |
| `version` | oui | `1`. Une autre version est refusée (message en clair). |
| `name` | non | Nom de l'étude. |
| `site.origin` | oui | `latitude` (−90 à 90), `longitude` (−180 à 180), `altitude` (m, au-dessus de la mer ; 0 par défaut). |
| `site.utcOffset` | non | Décalage horaire du site en heures (−12 à 14) pour le Soleil. Par défaut, déduit de la longitude (15° par heure) ; l'utilisateur le corrige selon l'heure légale. Aucun fuseau n'est lu dans le navigateur. |
| `site.limit` | non | Limite du terrain, au moins trois points ; vide tant qu'elle n'est pas dessinée. |
| `context.buildings[]` | non | Voisins : `id`, `footprint` (≥ 3 points), `height` (m au-dessus du sol, > 0), `heightSource`, `edited`. |
| `heightSource` | non | `measured` (fournisseur national), `tagged` (attributs OpenStreetMap `height` ou `building:levels` × 3 m), `assumed` (8 m par défaut). Autre valeur lue : `assumed`. |
| `edited` | non | `true` si l'utilisateur a corrigé la hauteur. |
| `context.terrain` | non | Grille régulière : coin sud-ouest (`west`, `south`, m), pas `step` (m), `columns` × `rows` (≥ 2), `heights` (altitudes en m, rangées du sud au nord, colonnes d'ouest en est). `null` : sol plat à l'altitude de l'origine. |
| `context.credits` | non | Attributions des données lues (OpenStreetMap, relief…), montrées sur la page et gardées ici. |
| `context.radius` | non | Rayon lu autour de l'origine (m). |
| `context.fetchedAt` | non | Date de la lecture (ISO 8601) ; `null` : rien n'a été lu. |
| `proposals[]` | non | Propositions (au moins une après lecture) : `id`, `name`, `volumes[]`. |
| `volumes[]` | — | `id`, `name`, `footprint` (≥ 3 points ; un volume illisible est écarté), `baseLevel` (m, repère local ; 0), `floors` (entier ≥ 1 ; 1), `floorHeight` (m ; 3), `use` (identifiant d'usage ; le premier de la liste), `floorUses` (facultatif : usage par niveau depuis le rez-de-chaussée, une case vide reprend `use`). |
| `settings.uses[]` | non | Liste d'usages modifiable : `id`, `name`, `color` (`#RRGGBB` ; toute autre valeur est remplacée par la couleur par défaut), `housing` (compte pour les logements). Par défaut : logement, bureaux, commerce, stationnement, autre. |
| `settings.dwellingSize` | non | Surface moyenne d'un logement (m², 65 par défaut). |
| `settings.efficiency` | non | Part de la surface de plancher habitable (0 à 1, 0,8 par défaut). |
| `settings.units` | non | `m2` (défaut) ou `ft2` pour l'affichage des surfaces ; le fichier reste en mètres. |

Règles :

- **Champs inconnus gardés** : à la racine comme dans le site, le contexte, une proposition, un volume, un voisin ou un
  usage, un champ que cette version ne connaît pas est relu et réécrit tel quel.
- **Lecture tolérante** : une valeur absente ou illisible prend sa valeur par défaut ; seuls le `format`, la `version` et
  l'origine (latitude, longitude) sont exigés.
- **Le contexte n'est jamais relu à l'ouverture** : il n'est lu (Overpass, tuiles de relief) que sur demande explicite
  (« Charger le voisinage ») et remplace alors le précédent.
- Les chiffres et les analyses ne sont pas enregistrés : ils se recalculent.

## Export vers le viewer

« Exporter la proposition » écrit deux fichiers à déposer ensemble dans le viewer :

- un **GLB** : un nœud par volume (`extras.id` = identifiant du volume), triangles en mètres, Y vers le haut, le glTF
  (x, y, z) valant (est, haut, −nord) du repère local ; couleur de l'usage en couleur de sommet ; propriétés dans
  `extras` sous « Étude de site » (proposition, usage, niveaux, hauteurs, emprise, surface de plancher) ;
- un **JSON de métadonnées** (voir `docs/contrat-metadonnees.md`) avec les mêmes propriétés et un `georeference` :
  latitude et longitude de l'origine, `elevation` = altitude de l'origine, `origin` = `[0, 0, 0]`, `trueNorth` = `[0, 1]`.
  Le viewer pose ainsi la proposition à sa place sur la carte.
