# Lecture des fichiers Revit (.rvt, .rfa)

Le viewer ouvre un `.rvt` (projet) ou un `.rfa` (famille), et leurs gabarits `.rte` et `.rft` (même conteneur, même lecteur), sans Revit, sans service Autodesk, sans IFC ni GLB intermédiaire. Tout se
passe dans l'onglet du navigateur : le fichier n'est envoyé à aucun serveur. Ce document décrit
comment c'est construit, ce que le lecteur rend, d'où viennent les formes et les propriétés, et
comment reconstruire et tester le tout.

## 1. Architecture

```
fichier .rvt ou .rfa (objet File)
   |
   |  postMessage : le File lui-même, sans copie des octets
   v
src/revit/readRevit.ts        fil principal : budget de triangles d'après la mémoire de l'appareil, un worker
   |                          neuf par fichier, erreurs traduites en français, abandon possible (AbortSignal)
   v
src/revit/revitWorker.ts      worker : démarre le module WebAssembly, lui prête le File par tranches
   |                          (FileReaderSync, jamais le fichier entier) et lui passe les morceaux (readRevitFile)
   |
   v
src/revit/pkg/                module WebAssembly (revit_bg.wasm, environ 5 Mo) et sa glue JavaScript,
   |                          compilés depuis revit/ et versionnés dans le dépôt
   v
revit/src/                    caisse Rust : rvt-rs ouvre le fichier, native/ en lit les enregistrements
                              (Revit 2012 à 2027), geometry/ fabrique les formes, properties/ le JSON
   |
   |  RevitChunk × n pendant le maillage (250 000 triangles par morceau, tableaux typés transférés sans
   |  copie), puis RevitOutput : rapport, libellés des éléments, texte JSON
   v
src/revit/readRevit.ts        rawFromChunk : chaque morceau devient un RawModel, remis à l'instant
   |
   +--> engine/buildModel.ts  ModelBuilder.append : le modèle grandit à l'écran morceau par morceau ;
   |                          fusion dans les lots, état GPU, boîtes, picking : le code du glTF
   |
   +--> data/metadata.ts      le JSON du contrat alimente la fiche, l'arbre, les filtres
```

Points de conception.

- **Un worker par fichier.** Une instance WebAssembly ne rend jamais sa mémoire, et une panique la
  laisse dans un état douteux. Le fil principal termine donc le worker dès le résultat ou l'erreur.
  Un chargement lancé pendant une lecture l'interrompt aussitôt, pour ne pas garder deux lecteurs
  en mémoire.
- **Chargement à la demande.** Le module n'est téléchargé que par le worker, au premier `.rvt` ou `.rfa`.
  Vite l'émet comme fichier à part (`dist/assets/revit_bg-<empreinte>.wasm`) et en donne l'adresse
  relativement au script du worker : le site fonctionne sous le sous-dossier de GitHub Pages.
- **Le fichier reste dehors, la sortie part par morceaux.** Le module ne reçoit pas les octets du fichier : il
  demande au worker des fenêtres de 1 Mio (`readRevitFile(size, read, options, onChunk)`, `FileReaderSync` sur
  `file.slice`), les petits flux du conteneur passent dans un mini conteneur pour rvt-rs et les partitions se lisent
  par tranches, à la demande d'un index des groupes d'enregistrements (`native/document.rs`, `native/index.rs`).
  Chaque forme achevée rejoint le morceau en cours, qui part dès 250 000 triangles (`CHUNK_TRIANGLES`) : la mémoire
  du module ne tient jamais ni le fichier, ni tous les maillages, ni tous les tableaux (§ 7). Les libellés des fiches
  et le JSON de métadonnées, lus après la géométrie, viennent avec la fin.
- **Pas de GLB.** Les tableaux sortent du worker par transfert. `buildModel` les lit tels quels
  (`RawModel`, `kind: 'raw'`). Un GLB n'est écrit que pour « GLB ↓ » ou « USD ↓ », à partir du
  modèle affiché (`writeGlb`), puisqu'un `.rvt` n'a pas de GLB d'origine.
- **Chaque enregistrement se décode une fois.** Décoder un graphe d'objets de rvt-rs coûte à peu près
  8 µs par objet et fait l'essentiel de la lecture ; la géométrie et les propriétés partagent donc
  les mêmes décodages (§ 7).
- **Panique de Rust.** Elle revient en vraie erreur JavaScript avec son texte, qui commence par
  « panique interne » (`isPanicFailure`). Un manque de mémoire, lui, arrête le module sans passer par
  ce crochet : `RuntimeError` dont le message est la trappe nue (`unreachable`) ou `RangeError` ;
  `isMemoryFailure` (`src/revit/readRevit.ts`) les reconnaît et le viewer répond que le fichier est
  trop volumineux. Une panique n'est jamais prise pour un manque de mémoire, même si son texte parle
  de `capacity overflow` (un nombre mal formé) ou d'`unreachable` (`entered unreachable code`).
- **Relecture prudente.** En WebAssembly (wasm32) une panique n'est pas rattrapable : elle interrompt
  toute la lecture. `readRevit` relit alors le fichier une fois, dans un worker neuf, avec
  `{ prudent: true }` (la requête du worker porte un champ `options`) : seul le maillage de rvt-rs lit
  les formes, sans le code du lecteur qui a paniqué, donc certaines formes peuvent être incomplètes.
  Un statut « nouvelle lecture en mode prudent » s'affiche pendant la relecture, et le rapport gagne
  l'avertissement « Une erreur interne a interrompu la première lecture ; le fichier a été relu en
  mode prudent : certaines formes peuvent être incomplètes. ». Ni un manque de mémoire, ni un abandon,
  ni un worker mort ne déclenchent de relecture ; si le mode prudent panique à son tour, l'erreur est
  rendue telle quelle.

Le worker envoie quatre sortes de messages, chacun portant l'`id` de la lecture :
`{ type: 'status', message }` avant les étapes lourdes (« Chargement du lecteur Revit… », « Lecture
du fichier Revit… »), `{ type: 'chunk', chunk }` pour chaque morceau de géométrie, dès qu'il est assemblé (clés, noms
provisoires, sources, origine, tableaux, table des matériaux prolongée d'un morceau au suivant),
`{ type: 'done', output }` avec la fin (rapport, libellés des fiches dans l'ordre des morceaux, JSON entier), et
`{ type: 'error', name, message }` en cas d'échec. Le viewer construit le modèle morceau par morceau
(`ModelBuilder`, `Model.grow`) : il apparaît dès le premier, la caméra le cadre, et l'arbre, les fiches et les filtres
se branchent à la fin, quand le JSON est là. Le worker mesure lui-même la durée
(`report.seconds`, de la mise en route du lecteur à la fin de la lecture), car l'horloge de Rust
n'existe pas en WebAssembly.

## 2. Le contrat de sortie

`readRevit(octets)` rend un objet simple. Le type TypeScript est `RevitOutput`
(`src/revit/pkg/revit.d.ts`), le type Rust `Output` (`revit/src/lib.rs`).

| Champ | Contenu |
| --- | --- |
| `keys` | Une clé unique par élément (voir § 5). |
| `names` | Nom affiché de chaque élément : le libellé de sa fiche (« Famille : Type », à défaut la famille seule, catégorie et type, ou catégorie et identifiant ; une forme de la famille d'un `.rfa` : sa sorte et son identifiant, « Extrusion 1234 »), identique au `label` du même élément dans `metadata`. |
| `sources` | `Uint8Array`, une valeur par élément : 0 forme Revit, 1 partielle, 2 reconstruite, 3 inconnue. |
| `origin` | Centre du modèle en mètres, Y vers le haut, en double précision. |
| `positions` | `Float32Array`, xyz en mètres, Y vers le haut, relatives à `origin`. |
| `normals` | `Float32Array`, une normale unitaire par sommet. |
| `indices` | `Uint32Array`, coins des triangles, locaux au premier sommet de leur primitive. |
| `primitives` | `Uint32Array`, six entiers par primitive : élément, premier sommet, nombre de sommets, premier indice, nombre d'indices, matériau. |
| `materials` | `Uint8Array`, sept octets par matériau : r, g, b, a (sRGB), transparent (0 ou 1), double face (0 ou 1), priorité de profondeur (0 ordinaire, 1 surcouche, 2 hôte : qui l'emporte quand des faces de deux éléments sont dans le même plan, voir § 3). Ce tableau est interne entre le module et le viewer, pas le contrat de métadonnées. |
| `metadata` | Texte JSON, exactement le format de [contrat-metadonnees.md](contrat-metadonnees.md) (version 1, `readOnly`, `elements`, et si le fichier les donne `georeference`, `phases` et `views`). |
| `report` | Bilan de la lecture, voir ci-dessous. |

Règles que le lecteur respecte et que `buildModel` vérifie avant de lire hors des tampons :
les triangles tournent dans le sens direct vu de l'extérieur, aucun triangle n'est dupliqué, chaque
indice reste inférieur au nombre de sommets de sa primitive, et `metadata.elements[clé]` existe pour
chaque clé, avec `label` égal au nom. Un élément sans primitive reste un élément, avec une boîte vide.

Le rapport (`report`) contient `release` (année de Revit, ou `null`), `experimental`, `elements`,
`triangles`, `seconds`, `sources` (`revit`, `partial`, `rebuilt`, `unknown`), `withoutGeometry`,
`warnings` (phrases en français) et `stages` (la durée de chaque étape de la lecture, dans l'ordre,
pour le diagnostic : voir § 7). Le viewer en fait la carte « Fichier Revit lu », par exemple :

> 970 éléments lus en 4,2 s (Revit 2024) : 958 formes Revit, 8 partielles, 3 reconstruites, 1 inconnue (boîte englobante). Regroupez par « Source de la géométrie » pour les retrouver.

La carte ajoute « N éléments sans géométrie ne sont pas dessinés » quand il y en a, puis les
avertissements du lecteur, puis « Lecture expérimentale » si c'est le
cas. Elle passe au style d'avertissement dès qu'un élément n'a pas sa forme Revit complète, que la
lecture est expérimentale ou que le lecteur a des avertissements.

`report.experimental` est vrai quand la lecture native n'a pas suffi : l'année de Revit du fichier est
inconnue, ou les formes ont dû être reconstruites par l'export IFC de rvt-rs (voir § 6). Une année de
2012 à 2027 lue par ses enregistrements natifs n'est jamais expérimentale. Un fichier sans étiquette d'année (Project Vasari)
dont le schéma est celui d'une année connue ne l'est pas non plus : `report.release` reste `null` (« version de Revit inconnue »),
et un avertissement dit de quelle année le format a été reconnu (§ 6).

## 3. D'où vient la géométrie

Pour chaque élément, dans cet ordre, jamais une boîte en silence.

1. **Forme Revit.** La forme d'affichage que Revit enregistre dans le fichier (le canal graphique
   103 de rvt-rs, `rvt::research::native_saved_scene`). Elle inclut la forme du type de famille posée
   par chaque instance, et les couleurs de rendu des matériaux. Propriété : « Forme Revit ».
   Si certaines faces enregistrées n'ont pas pu être tracées : « Forme Revit partielle ».
2. **Forme reconstruite.** Refaite à partir des données de l'élément (murs, dalles, toits,
   poteaux, poutres, escaliers, tuyaux, éléments de mur-rideau…) avec le constructeur glTF de
   rvt-rs. Les corps dont la source est la boîte de l'enregistrement sont exclus. Propriété :
   « Forme reconstruite ». Seulement quand les formes enregistrées n'ont pas pu être lues du tout
   (une année de Revit que le lecteur ne lit pas, ou une lecture native qui a échoué : l'avertissement
   dit pourquoi) : l'export IFC de rvt-rs qu'elle exige (2,2 s en natif sur `RE1-Electrical.rvt`) ne
   redessinait aucun des éléments illisibles d'un fichier lu nativement, ni de 2023 ou plus, ni de 2012 à 2022, et rend un projet vide
   sur tous les fichiers d'avant 2015 essayés.
3. **Boîte englobante.** Pour un élément dont Revit a enregistré la forme mais que le lecteur ne
   sait pas lire (graphe refusé, aucune face qui se trace) : la boîte que Revit a enregistrée pour lui (`GElement.m_tightbBox`, à défaut `m_bBox`, en pieds
   dans le repère du modèle), dessinée avec la couleur du matériau de l'élément et marquée « Inconnue
   (boîte englobante) ». Un avertissement les compte. Sans aucune étendue enregistrée, l'élément n'est
   pas dessiné et un second avertissement le dit : il n'est pas compté dans `withoutGeometry`. Chaque élément n'est compté
   que dans un avertissement : forme illisible, forme trop dense (plus de 250 000 triangles), ou forme au-delà du budget
   de triangles ou du plafond de maillage (`Scene::hard_limit`, vérifié avant chaque élément et chaque instance achevée
   après ses symboles), ces deux derniers comptés ensemble.

Pour retrouver les éléments des sources 2 et 3, ou les formes partielles : dans le panneau de
gauche, « Grouper par », puis « Source de la géométrie ». Les règles de couleur peuvent aussi
s'appuyer sur cette propriété.

Ce que le lecteur retient des graphiques enregistrés est ce qu'une vue 3D ombrée de Revit dessine (`revit/src/geometry/faces/select.rs`,
niveau de détail fin). Les octets des fichiers d'essai (`cargo run --release --example graph -- --classes <fichier>`)
décident des cas que rvt-rs refuse : les flèches de retournement (`GBiFlipControl`) ne sont pas des surfaces
et le miroir d'une instance est dans sa matrice ; l'image d'un contenu RPC (`GImposter`, actif nul) n'a rien à
dessiner et son maillage voisin (`GPolyMesh`) se dessine, en surcouche (voir plus bas) ; une famille de détail imbriquée (arcs de
battement, régions remplies) ne se montre que dans les vues dont la direction correspond (plan, élévation) ;
une instance imbriquée référencée par son hôte (`GComponentRef`) se dessine comme élément, pas deux fois. Les normales d'un `GPolyMesh` sont par
sommet (indicateur 0) ou par facette (indicateur 2). Ce qui n'est pas compris reste un diagnostic : la forme
est « partielle », jamais une surface perdue sans le dire. Les derniers cas que rvt-rs refusait et que les octets des fichiers
d'essai tranchent (mesurés par `examples/census.rs`, partie 4, et `examples/graph.rs --classes`) :

- **Composants adaptatifs (les 880 coussins ETFE de Vignette-04).** Ni forme propre à l'instance, ni mise en forme par point :
  le graphique de chaque coussin (3 objets, `GElement` → `GInstance`) place par une matrice rigide un symbole qui lui est
  propre (880 symboles distincts, d'identifiants 751 687 et suivants, contre 719 757 et suivants pour les instances), et la
  forme adaptée à ses points est l'unique face de ce symbole : une surface réglée entre deux droites qui passent par les quatre
  points adaptatifs, de 2 à 2 048 triangles (400 en moyenne). Les points adaptatifs sont d'autres éléments (`GGTag` et `GPoint`, sans
  surface) ; le panneau de toiture (`ROOF-PANEL-4PT`) cite ses 16 coussins par `GComponentRef`, ce qui les laisse se dessiner
  eux-mêmes. La boîte que Revit enregistre pour l'instance est celle du symbole déplacé par la matrice (880 sur 880, à 1 mm),
  non celle de ses surfaces : elle dépasse le maillage de plus d'un mètre. Une face ouverte, dessinée des deux côtés.
- **Instances à cibles interdites.** `GInstance.m_forbiddenTarget.m_targets` ≠ 0 valait « ce n'est pas dessiné par cet
  élément » chez rvt-rs et dans la lecture d'un projet tiers (baleti/rvt-reader : « dessinée par son propre élément », comme
  la lisse d'un garde-corps). Les données disent autre chose pour le masque 10 (bits 1 et 3) : ses 1 021 instances sont
  toutes visibles et seules dans le graphique de leur élément (880 coussins, 120 chaises M_Chair-Breuer de `rac_advanced` et de
  `mega_advanced`, 21 symboles de plan de RE1-Electrical qui n'ont que des lignes). Aucun doublon : aucun autre élément ne place
  le symbole d'un coussin, aucun ne dessine les mêmes triangles, 48 autres chaises de `rac_advanced`, sans cibles interdites, placent le
  symbole des chaises à masque 10 (même famille, même forme), et la boîte serrée de chaque chaise est l'étendue de son maillage à 5 mm près. Les masques `0xCFFE` et `0x8FFE` (presque toutes les cibles) ne sont portés que par des instances de
  visibilité 1 ou hors du modèle : ils restent un diagnostic quand leur symbole porte des surfaces. Le sens de chaque bit n'est
  pas établi (rien dans rvt-rs) : la règle ne dit que ce que les octets montrent, `m_targets & !0b1010 = 0` se dessine.
- **Symbole « résolu dans la vue ».** `m_resolveSymInView` vrai est admis quand le graphique du symbole n'a aucune condition
  (aucun `GFilter` à condition) : il ne peut pas dépendre de la vue. Ce sont les 8 balayages de mur (`WallSweep`) des murs « Parapet
  Wall » de `rac_advanced` et de `mega_advanced`. Un balayage est un élément à part entière, avec sa fiche et son identifiant : comme
  une instance imbriquée (`GComponentRef`), il se dessine par lui-même et le mur ne le redessine pas. Le mur se lit alors en entier
  (24 triangles pour le mur 167548 ; le balayage garde ses 1 020, inchangés bit à bit) ; sa boîte serrée contient celle du balayage,
  que Revit y compte. Ce n'est pas la règle des volées d'un escalier ou de la lisse d'un garde-corps, dont l'instance n'est pas résolue
  dans la vue et dont la forme se dessine par leur hôte.
- **Groupe étiqueté `GGTag`.** Un `GGroup` qui porte un identifiant de sélection : les poignées de sommets d'une toiture de face
  (pastilles `GBitmap` de 10 × 10 pixels et points) et les flèches de retournement de rives de dalle. Il se visite comme un
  groupe ; `GBitmap` et `GText` sont des surcouches 2D sans surface.
- **Surface d'Hermite (`HermiteSurf`).** Un maillage de nœuds `m_uParams` × `m_vParams` (le nœud (i, j) à l'indice `j · nu + i`)
  avec point, tangentes `∂P/∂u` et `∂P/∂v` et dérivée mixte, interpolés par un carreau bicubique d'Hermite par maille. Les
  panneaux de toiture de Vignette-04 (54), les bols de SampleModel (4), les sculptures de `revit-curtainwall-byprofile_v21` (2)
  et la coque de `ShellFamily.rfa` en portent. Les points d'arête que Revit enregistre se retrouvent à 0,08 mm près
  (`examples/faces.rs`, couples `HermiteSurf/Plane` et `HermiteSurf/HermiteSurf`).

- **DWG importée dans une famille (les voitures de `wadduwa.rvt`).** Une DWG importée dans une famille est un `MasterImportSymbol`
  (« Peugeot 208.DWG », « Citroen C4.DWG ») : un graphique de maillages de facettes (`GPolyMesh`, une dizaine par voiture, un par calque), de
  polylignes (`GPolyLine`, qui ne se dessinent pas) et d'instances (`GInstance`) de blocs, des `SlaveImportSymbol` (calques vides comme
  `.AVE_RENDER` et `.AVE_GLOBAL`, qui ne sont qu'un `GElement`, et les roues). Le symbole de la voiture (« Blue Car », « Red Car ») le place par une instance, et la
  forme de chaque voiture pèse 120 000 à 140 000 triangles (148 926 pour la Peugeot, dont 7 120 de roues, 123 868 pour la Citroën). Ces deux enregistrements
  sont les plus gros des fichiers d'essai (3 769 685 et 3 363 927 octets, 1 970 695 et 1 739 483 valeurs, 198 et 451 objets) : 1,9 octet par valeur. Le
  budget de décodage d'un graphique (`saved::GRAPH_LIMIT`, 1 million de valeurs et d'objets) les refusait, et les cinq voitures
  n'étaient que des boîtes « Inconnue ». Deux budgets, désormais (`revit/src/geometry/saved.rs`, `graph_limit`) :
  - les graphiques que l'on dessine (canal 103) : **3 millions** de valeurs et d'objets (`GEOMETRY_GRAPH_LIMIT`), une marge d'un tiers
    sur les 1,97 million de la Peugeot ; un enregistrement de moins de 8 Mo en tient dès qu'il pèse 2,7 octets par valeur ou moins ;
  - les enregistrements d'éléments (canal 102, les propriétés) : **1 million**, comme avant (`GRAPH_LIMIT`).
  La borne en octets qui écarte un enregistrement avant de le décoder (`native::records::MAX_RECORD_BYTES`) ne suit pas le budget : elle reste
  celle du million de valeurs, 1 000 000 × 8 = **8 000 000 octets**, pour les deux canaux. Sans elle, élever le budget laissait décoder (pour le refuser ensuite)
  le `DirectShapeType` de 16,5 Mo de `2024_Core_Interior` (130286) : le pic de ce fichier passait de 274 à 1 356 Mo sans rien changer à sa
  sortie (mesuré avec un budget de 4 millions). Il reste refusé d'emblée, sans rien coûter. Le graphe décodé d'un tel symbole (157 Mo pour la Peugeot, 148 Mo pour la Citroën, soit 42 à 44 fois leur enregistrement)
  ne vit que le temps de son parcours : le cache des symboles garde la forme et les nœuds maillés (`GPolyMesh` en f64, un sommet par coin de facette : environ
  23 Mo pour la Peugeot, 19 Mo pour la Citroën), jamais le graphe. Le pic de `wadduwa.rvt` passe de 716 à 970 Mo environ en natif (`/usr/bin/time -l`, maillage sur
  plusieurs fils ; 703 à 838 Mo sur un seul) et la mémoire de l'instance WebAssembly de 254 à 418 Mio, pour une sortie qui passe de 340 000 à 1,01 million de triangles ; celui d'aucun fichier
  dont la sortie ne change pas ne bouge, au bruit près (± 3 %).
  - *Les instances à échelle.* Les instances de blocs de chaque voiture (9 pour la Citroën, 17 pour la Peugeot) ont `m_bHasScale` vrai (matrice
    identité), et le lecteur refusait toute instance à échelle (rvt-rs aussi). L'échelle est dans la matrice 3 × 3 de `InstanceInfo.m_Trf`
    (aucun autre champ d'`InstanceInfo` n'en porte) : toutes celles des fichiers d'essai sont une rotation ou un miroir multipliés
    par un nombre (colonnes orthogonales et de même longueur, à 1e-9 près en valeur relative : `faces::select::uniform_scale`), de l'identité
    de ces blocs à 0,125 chez `rac_advanced` et 25,4, 75 ou 2 413,27 chez les plans DWG de `wadduwa.rvt` (aucune échelle non uniforme). Une
    telle instance **se place comme toute autre** : le symbole est maillé dans ses unités, une fois pour toutes ses instances (`faces::decode`),
    puis ses sommets passent par la matrice et ses normales par l'inverse transposée, renormalisées (comme le miroir d'une instance) ; une
    condition de direction de filtre se lit sur la direction de la matrice, sans son échelle. La flèche de maillage (1 mm) est donc celle des
    unités du symbole, et vaut 75 mm à l'échelle 75 : sans effet sur les fichiers d'essai, dont les symboles à échelle ne portent que des
    `GPolyMesh` (les facettes sont reprises telles quelles) et des faces planes, qui ne se tessellent pas à une flèche. Une matrice qui n'est pas
    une échelle uniforme (étirement, cisaillement) n'a pas de lecture établie : un symbole qui porte des surfaces reste un diagnostic
    (« instance à échelle non uniforme non prise en charge », forme partielle) ; un symbole sans surface (calque vide comme `.AVE_RENDER`,
    lignes seulement) n'a rien à perdre, l'instance se saute. Les deux voitures sont donc entières : « Forme Revit ». Les imports CAD du projet (`ImportInstance`) n'ont aucune
    exception : leurs blocs à échelle (25,4 ; 75 ; 2 413,27 chez les plans DWG de `wadduwa.rvt`) se placent comme les autres (voir « Imports CAD du
    projet » plus bas).
  - *La couleur.* Les facettes n'ont ni matériau ni style de rendu (`m_materialID` et `m_interiorGStyleID` à −1) : rvt-rs les résout au gris du
    viewport. Leur couleur est dans le `GStyleElem` que cite `GInfo.m_categoryId` du groupe de leur calque (type 3, possédé par
    le `MasterImportSymbol`), par son `GStyle.m_materialElemId` : un style d'objet, que Revit applique à une surface sans matériau. Le `CategoryElem`
    du calque (« 0 ») n'a pas de matériau propre, et la couleur de ligne du style (`GStyle.m_color`, avec `m_penNumber`) vaut 0 pour les 34 styles d'import
    des deux voitures : elle ne dit rien, elle n'est pas utilisée. Le matériau passe par le résolveur ordinaire (couleur d'apparence, rattrapée par la couleur
    d'ombrage quand elle est noire, voir `geometry::materials`). Résultat, par part des triangles de l'élément :
    « Blue Car » 35,0 % bleu (15 21 143), 29,2 % noir (4 4 5), 13,8 % noir (0 0 0), 11,9 % blanc (7,1 % de calque blanc, 4,8 % de roues), 5,6 % gris 105, 3,1 % vitre (15 15 18, 30 % de
    transparence), 1,0 % feux (53 19 20), 0,4 % gris ; « Red Car » 40,1 % rouge (130 0 0), 19,6 % gris foncé (25 25 34), 15,7 % (21 21 21),
    12,4 % gris clair (173), 6,3 % (15 15 18, transparent), 2,8 % (15 15 18), 2,4 % rouge vif (255 0 0), 0,5 % (53 19 20), 0,1 % gris et 0,1 % bleu. La
    carrosserie est bleue ou rouge, les parties communes (pneus, calandre, vitre) sont les mêmes. Des anomalies de données, que le
    résolveur n'invente pas : des matériaux des deux imports partagent un même élément d'apparence (`m_appearanceAssetId`), dont la couleur n'est pas celle de
    leur ombrage : « CITROEN C4 7 » (ombrage 155 0 0) a l'apparence de la vitre de la Peugeot et se dessine en vitre (6,3 %), « CITROEN C4 9 » celle de la
    carrosserie bleue (0,1 %), « CITROEN C4 5 » (ombrage 66 66 66) une apparence rouge vive (2,4 %). La carrosserie, elle, ne change pas de couleur.
    Les huit roues de la Peugeot (7 120 triangles) sont blanches : leur groupe est celui du calque « 0 » (style de type 1, `GStyleElem` 367827,
    matériau « Render Material 255-255-255 »), pas celui du bloc qui les place ; le lecteur suit les octets du fichier.
- **Imports CAD du projet.** Une DWG, un SAT… importé dans le modèle (et non dans une famille) est un élément `ImportInstance`. Il se dessine
  comme tout élément du modèle, et son dessin est réglé en surcouche (voir plus bas). Il suffit pour cela que ses blocs à échelle (`m_bHasScale`,
  voir ci-dessus) se placent : ils étaient refusés, et un élément d'une classe qui n'est pas de modèle dont la forme ne se lit pas était écarté en
  silence (`geometry::nothing_to_lose`). Cette exception est supprimée pour les imports : un import lisible se dessine, un import qui ne se lit qu'en partie
  est « Forme Revit partielle », un import illisible se montre par la boîte que Revit a enregistrée (« Inconnue », avec l'avertissement habituel), et
  un import sans surface (des polylignes seulement, comme `existingSite-elk.dwg` de `Vignette-04`) est compté sans géométrie.
  - *Propre à une vue ou au modèle.* Un import placé « vue actuelle seulement » a une vue propriétaire (`m_ownerDBViewId` ≠ −1) : Revit ne le montre jamais en
    3D, et il reste écarté avec les annotations (`classes::excluded_relation`, « propre à une vue »). Mesuré par fichier (model / propres à une vue) :
    `wadduwa.rvt` 5 / 0, `Vignette-04-BaseFile` 2 / 0, `dynamo-nyc-site-2013` 1 / 0, `rac_advanced_sample_project` et `mega_advanced_sample_file`
    0 / 1 (« Roofing Detail.dwg », propre à la vue 228707, jamais dessiné) ; les 21 imports de `drone-hangar-building-2014` sont ceux d'une famille chargée (écartés par la règle des
    familles chargées d'avant 2015).
  - *Le nom.* Un import est nommé par le fichier importé : le nom de son symbole d'import (`MasterImportSymbol`, que son `InstanceInfo` désigne par
    `m_symbolId`), « MAN-GF.dwg », et rangé dans la catégorie que le fichier donne à ce symbole (`MasterImportSymbol.m_categoryId`) : le `CategoryElem`
    de même nom (Revit les liste sous « Catégories importées »), ou une catégorie de Revit (« Styles d'objet d'importation » pour `SiteModel.dwg`). Son niveau est
    celui de sa fiche (`m_assocLevelId`). Sans symbole lisible, il garde le libellé d'un élément sans type.
  - *Ce que cela fait dessiner.* `wadduwa.rvt` : 5 plans DWG (« MAN-GF.dwg », « MAN-1F.dwg », « MAN-2F.dwg », « MAN-RF.dwg », « MAN-URF.dwg », de 128 à 773 triangles),
    des régions pleines à plat à la hauteur de chaque niveau, donc exactement dans le plan du dessus des dalles : c'est la surcouche qui les montre. Le {3D} enregistré de ce
    fichier les cache d'ailleurs tous les cinq (`hiddenElements`) : dans cette vue, ils ne sont pas montrés. Ce {3D}, seule vue 3D du fichier, cache aussi 3 murs « Mur de base : BRICK WALL 100mm » (562167, 559829, 559574) : ces 8 éléments démarrent donc masqués
    dans le viewer, comme dans Revit (il masque à l'ouverture ce que toutes les vues enregistrées masquent). Ils restent dans l'arbre, œil éteint, et « Tout afficher » les montre. `Vignette-04-BaseFile` : `existingSite-meerkat.sat` (308836), un
    import SAT de 5 708 faces et 16 632 triangles qui s'étend sur 1,5 km (x de 501 à 2 073 m, y jusqu'à 508 m), est dans une famille sur place de masse (« Mass 1 ») : il se
    lit, mais il n'est pas dessiné, comme les masses (« Familles sur place », ci-dessous). `dynamo-nyc-site-2013` : `SiteModel.dwg` (230266), 56 916 triangles en forme partielle (une face `Plane` au contour non raccordé), dans la famille
    sur place « Site 1 », dont l'instance (230269) en dessine le même contenu 555 m plus loin : cet import n'est donc pas dessiné à son tour, à l'endroit où la famille a
    été créée (« Familles sur place », ci-dessous).
- **Familles sur place : leur contenu est dessiné par leur instance.** Une famille créée dans l'éditeur de modèle sur place (`Family.m_inPlace` vrai : une
  armoire, un cadre de fenêtre, un site, une poutre) écrit ses formes parmi les éléments du projet, dans le repère du projet, là où l'auteur les a créées : extrusions,
  balayages, fusions, révolutions et formes de masse (`catalog::is_family_form`), et les imports CAD qu'elle contient (`ImportInstance`). Chaque forme a pour propriétaire
  d'ElemTable (`Identity::owning_element_id`) la `Family`, directement ou par des intermédiaires (un groupe, une courbe : la chaîne se remonte comme celle des familles
  chargées, 16 maillons au plus, `native::families::in_place_family`). La `FamilyInstance` de la famille (celle qui place un `FamilySymbol` dont `m_familyId` est la `Family`)
  dessine ces mêmes formes à l'endroit où elle est aujourd'hui, et Revit ne montre que l'instance. Le lecteur dessinait les deux : **deux fois au même endroit** quand l'instance n'a
  pas bougé (`wadduwa.rvt` : l'extrusion 752500 et l'instance 752689, les mêmes 32 triangles), **en fantôme** quand l'instance a été déplacée (l'extrusion 760354, copie de
  la famille précédente, restait à l'endroit d'origine, sur 752500, alors que son instance 760361 est 3,56 m plus bas), **empilées** (`drone-hangar-building-2014` : les formes de quatre
  familles « Generic Models » au même point, de trois autres à un autre, leurs instances ailleurs) ou **à 555 m** de l'instance (`dynamo-nyc-site-2013`, l'import de « Site 1 » : 460 m en x et 310 m en z).
  - *La règle, de toute année.* Une forme ou un import dont la chaîne mène à une `Family` sur place, qui n'est pas celle du document (un `.rfa` dessine ses propres formes), **n'est pas
    dessiné** quand la lecture a dessiné une instance de cette famille par sa forme enregistrée (source 0 ou 1, non par sa boîte) avec au moins autant de triangles que tout le contenu de la famille :
    raison « contenu d'une famille sur place, dessiné par son instance » (`classes::RELATION_REASONS`, comptée dans le recensement). Sinon (instance masquée, vide, illisible, absente,
    ou qui ne porte pas tout ce que la famille a écrit), le contenu est dessiné comme avant et un avertissement le compte (« … éléments du contenu de familles sur place sont dessinés à l'endroit où les familles
    ont été créées »). Rien n'est perdu en silence. La décision se prend à la fin de la lecture (`geometry::Rules::release_in_place`) : le contenu attend hors de la sortie, pour les seules
    familles qu'une instance non écartée d'avance (ni masquée, ni masse que Revit masque par défaut) peut dessiner ; les autres le dessinent tout de suite, dans l'ordre, comme avant.
  - *Une famille de masse.* Le contenu suit la règle de visibilité de son instance : quand l'instance de la famille est écartée comme une masse (`RELATION_REASONS[5]`, « masse (masquée par
    défaut dans Revit) »), son contenu l'est aussi, avec la même raison, et compte dans les masses que l'avertissement des masses annonce (`Stats::masses_hidden`) ; aucun avertissement ne lui est propre. Ce sont les formes
    de masse « Main Building » (139682) et « Pavillion » (139763) de `rac_advanced_sample_project` et de `mega_advanced_sample_file` (28 et 12 triangles, 66 m × 53 m pour la première) et l'import SAT 308836 de `Vignette-04-BaseFile`
    (famille « Mass 1 », 16 632 triangles : les imports de famille suivent leur famille, la décision de dessiner les imports du projet ne vaut pas pour eux). Les vues 3D enregistrées de rac et de mega cachent d'ailleurs déjà la
    catégorie « Masses » (`hiddenCategories` : `Catégorie` = `Masses`), dans laquelle ces formes étaient rangées : elles étaient cachées dans ces vues, et dessinées dans la vue libre. Seule une instance masquée pour une autre raison (invisible),
    illisible ou absente laisse le contenu dessiné, avec l'avertissement.
  - *Ce qui reste dessiné.* Un élément que la famille possède sans être une forme de sa définition est un élément du modèle, que l'instance ne dessine pas : les murs 757897 et
    760541 de `wadduwa.rvt` (« BRICK WALL 100mm », niveau 1F, avec leur GUID : 12 triangles chacun, dont l'étendue dépasse de 5 cm celle des murs 549376 et 548874, qu'ils doublent sur 37,5 et 24,4 m² de faces coplanaires), les toitures 198779
    et 199509 et le mur 198010 du hangar, la toiture 201344 de la poutre courbe de rac et de mega, les 4 murs de « water » dans les quatre `DynamoSample`. L'instance du cadre de wadduwa a 32 triangles, la forme et le mur de sa famille en font 44 : elle ne dessine pas le mur.
  - *Mesuré* (`cargo run --release --example inplace -- <fichier>`, un tableau par forme : famille, forme, instance, source, triangles, boîtes, déplacement) : 25 formes écartées par leur instance dans 8 fichiers, toutes avec une instance
    dessinée en source 0 (une en source 1, l'import de nyc) et exactement les triangles de leur famille ; les sommets de chaque forme, translatés de son déplacement, se retrouvent dans l'instance à 1 mm près,
    sauf pour trois : le cadre 752500 et sa copie 760354 (l'instance a 6,5 cm d'épaisseur au lieu de 9 cm : elle est tronquée d'un côté) et le mur sur place 180076 de `clockwork-wall-stuff-2014` (la forme est la tranche de 0,25 m du bas de l'instance, qui a 8 m de haut, sur le même
    contour). L'instance porte le même libellé, la même catégorie, la même famille et le même type que la forme qu'elle remplace (24 paires sur 24 ; l'import de nyc est nommé « SiteModel.dwg », son instance « Site 1 : Site 1 »).
    Par fichier (formes écartées par leur instance ; il n'y a aucune forme gardée avec avertissement dans les fichiers d'essai) : `wadduwa.rvt` 3 ; `SampleModel` 3 (les deux armoires et le caisson de hotte) ; `clockwork-roof-floor-stuff-2014` 1 (68 486 triangles) ; `clockwork-wall-stuff-2014` 1 ;
    `drone-hangar-building-2014` 14 (douze familles) ; `dynamo-nyc-site-2013` 1 (56 916 triangles, à 555 m) ; `rac_advanced_sample_project` et `mega_advanced_sample_file` 1 écartée (la poutre
    courbe 201286) et 2 formes de masse masquées (139682 et 139763, leurs instances étant des masses que Revit masque par défaut) ; `Vignette-04-BaseFile` 1 forme de masse masquée (l'import 308836) ; aucun
    changement, octet pour octet, dans les autres fichiers (`DynamoSample_2014` à `2025` ont une famille sur place, « water », dont seul le contenu qui n'est pas une forme se dessine).
    Les vues 3D enregistrées (`hiddenElements`, `hiddenCategories`) sont identiques partout, sauf dans rac et dans mega : leurs sept vues cachent la catégorie « Masses » (`hiddenCategories`), et l'entrée disparaît des sept vues, parce
    que cette liste ne nomme que les catégories des éléments dessinés (`views/write.rs`) et que les deux formes de masse 139682 et 139763 étaient les seuls éléments « Masses » : aucune masse n'est plus dessinée dans aucune vue, ce que ces vues demandaient déjà.
  - *Limites.* Le critère est le nombre de triangles, non la forme : une instance qui en porte autant mais pas les mêmes les ferait écarter (jamais vu : les 25 paires sont vérifiées sommet par sommet). Le cas « dessiné comme avant, avec un avertissement » (instance masquée pour une autre raison, illisible, absente, ou plus petite que le contenu) n'arrive sur aucun fichier d'essai : il n'est essayé que par les essais unitaires de `geometry`. Le contenu tenu en attente occupe la mémoire
    des formes des seules familles à instance dessinable (la plus lourde est celle de nyc, 56 916 triangles) jusqu'à la fin de la lecture : le pic de mémoire (`/usr/bin/time -l`, `examples/dump`, le plus grand de deux lectures) ne bouge
    pas de plus de 2,4 % sur les sept fichiers concernés (`wadduwa.rvt` 982 → 975 Mo, `SampleModel` 391 → 382, `rac_advanced` 475 → 478, `mega_advanced` 451 → 458, `dynamo-nyc-site-2013` 228 → 225, `drone-hangar-building-2014` 280 → 286, `Vignette-04` 545 → 538 : le bruit d'une lecture à l'autre).
- **Priorité de profondeur : qui l'emporte entre des faces coplanaires.** Des faces de deux éléments exactement dans le même plan (à 0 mm, de même normale, qui se
  recouvrent) se disputent les mêmes pixels et le viewer les montre en scintillant (« z-fighting ») : le dessus d'un poteau au niveau du dessus de la dalle qui l'entoure,
  le côté d'un limon d'escalier contre le mur qui le longe, un cadre de fenêtre à fleur de façade, l'empreinte d'un arbre sur le sol, un plan importé sur une dalle.
  Chaque face a donc une priorité, l'octet 6 de la table des matériaux (`geometry::pack::Depth`), qui ne change ni les triangles ni leur couleur :
  - **0 ordinaire** : tout le reste (familles, escaliers, garde-corps, poteaux, imports de famille…), sans décalage ;
  - **2 hôte** : les hôtes système, d'après la classe de l'élément (`geometry::classes::HOST_CATEGORIES`, la table des classes que lit la géométrie) : `SWall`, `FaceWall`,
    `ArcWall` (murs), `Floor` (sols, sans les nez de dalle `EdgeSlab` ni les fondations filantes `ContFooting`), `Roof`, `ProfileRoof`, `FaceRoof` (toitures), `Ceiling`
    (plafonds), `SiteSurface` (topographie) et `BuildingPad` (plateformes). Aucun schéma des fichiers d'essai n'a de classe de toposolide ; elle n'est pas dans la table ;
  - **1 surcouche** : le `GPolyMesh` voisin d'un `GImposter` (la silhouette et l'empreinte au sol d'un arbre RPC, `faces::select::Selected::overlay` : les 14 triangles
    horizontaux de l'empreinte d'un arbre de `wadduwa.rvt` sont à −6,53 m, le dessus de la dalle 575046), et toute la géométrie des `ImportInstance` du projet.
  Le viewer dessine chaque priorité dans son propre lot et son propre matériau (jamais fusionnés avec des triangles de même couleur d'une autre priorité) avec un décalage
  de profondeur négatif (`polygonOffset`, `DEPTH_POLYGON_OFFSET` dans `src/engine/buildModel.ts`) : hôte facteur −1 et unités −2, surcouche facteur −2 et unités −6. À faces
  coïncidentes, la surcouche l'emporte sur l'hôte, et l'hôte sur l'ordinaire : le mur cache la face du limon qui est dans son plan, la dalle le dessus du poteau, la surcouche le dessus de la dalle.
  L'export GLB n'a pas de décalage de profondeur possible, ni la carte Cesium : rien n'y change. `exact_fingerprint` (les essais de non-régression) ne distingue pas les priorités.
  Limites, mesurées sur `wadduwa.rvt` (recherche des faces coplanaires sur le GLB de `examples/glb`, **restreint aux éléments que la lecture dessine** : les nœuds dont
  l'identifiant est dans les métadonnées de la lecture, 437 ; `examples/glb` dessine aussi 25 nœuds que la lecture écarte, dont les volées, paliers et supports d'un escalier que son propriétaire dessine déjà et
  les formes de familles sur place, et leurs recouvrements ne comptent pas : les 69,3 m² « d'un escalier contre ses propres volées » d'une première mesure venaient de là) : 213 paires de faces coplanaires de même sens qui se
  recouvrent, 233,8 m² ; 105,5 m² (93 paires) ont des priorités différentes et sont départagés ; 128,3 m² d'hôte contre hôte restent à priorité égale (101,9 m² de murs contre murs, 8 paires de murs en double, jusqu'à 37,5 m², dont deux
  sont les murs 757897 et 760541 que possèdent des familles sur place ; 26,4 m² de sols contre murs, 109 paires) ; ordinaire contre ordinaire, 3 paires de moins de 0,01 m² chacune (un poteau et un cadre de fenêtre, une lisse et son garde-corps, une porte et un escalier). L'escalier
  contre les murs (la ligne en pointillé de l'utilisateur) est une bande étroite de 0,08 m² : le mur 567439 contre les escaliers 676369 et 680413, départagée (le mur, hôte, passe devant). Avant que le contenu des familles sur place soit dessiné par leur instance, la même mesure
  donnait 217 paires et 243,1 m², dont 9,2 m² d'ordinaire contre ordinaire : quatre paires entre les cadres de fenêtre 752500, 752831 et 760354 (des formes) et leurs instances (« Familles sur place », ci-dessus), qui
  se superposaient ; elles ont disparu avec les trois formes. Le décalage dépend de la pente de la face (le facteur) : à incidence rasante, un hôte
  peut passer devant un objet qui le touche de quelques millimètres.
- **Les textures ne sont pas dans le fichier.** Les 359 chemins d'image de `wadduwa.rvt` (`1/Mats/…jpg`) désignent la bibliothèque de
  matériaux d'Autodesk sur la machine de l'auteur : aucun flux d'image n'existe dans le fichier, sauf l'aperçu `RevitPreview4.0`. Le
  lecteur ne dessine donc que les couleurs des matériaux, jamais de texture.

Ne sont pas dessinés, comme dans une vue 3D de Revit et comme l'`IfcSpace` du convertisseur IFC :
pièces, surfaces, espaces, niveaux, axes, plans de référence, caméras et vues, boîtes de coupe et
catégories d'annotation. Un élément sans aucune géométrie est compté dans `report.withoutGeometry`.

### Triangles et budget

Chaque face courbe est maillée à une flèche de 0,003 pied (un millimètre) au plus entre la surface et ses triangles
(`revit/src/geometry/faces/tess.rs`, `CHORD_ERROR`), pour les cylindres de rvt-rs comme pour les surfaces de ce module.
C'était 0,001 pied (0,3 mm, la flèche par défaut de rvt-rs pour ses cylindres), appliquée aussi aux détails des
familles : mesuré sur les 32 fichiers d'essai, 0,003 pied ramène leurs 8,17 millions de triangles à 5,46 (67 %), Vignette-04
de 2 747 486 à 988 664, rac_advanced de 2 087 559 à 1 655 639, mega_advanced de 1 639 943 à 1 294 979, SampleModel de
1 048 501 à 928 957, sans toucher aux fichiers sans face courbe (Core Interior, Refinery) ; à l'écran, un panneau ondulé de
4 m vu à 1 m et les poteaux de rac_advanced sont identiques à l'œil en ombré (seul le fil de fer montre des triangles plus
longs). Sur les 15 013 éléments en forme Revit des fichiers d'essai, 1 972 (ceux qui ont une face courbe) changent de
triangles, aucun ne change de source. L'affinage des arêtes partagées entre deux faces (`faces/refine.rs`) mesure la
flèche des mailles qu'il choisit et en ajoute tant qu'elle dépasse : sur un arc de 90° le modèle « la flèche décroît
comme le carré de la longueur » (exact pour une parabole) en laissait 5 % de trop, 23 % sur un demi-cercle ; un
fichier aux arcs larges (`revit-curtainwall-byprofile_v21`) gagne ainsi 2 % de triangles au lieu d'en perdre.

**Coutures.** Une arête partagée par deux faces porte les mêmes sommets des deux côtés, même quand l'une est maillée par
rvt-rs et l'autre par ce module : un plan qui touche un cône, une surface d'Hermite, un cylindre ou une surface réglée est
maillé ici (`faces/mod.rs`, `PLANE_NEIGHBOURS_FOR_US`), et l'arête qu'un cylindre ou une surface de révolution de rvt-rs
partage avec une face d'ici reçoit exactement la grille de rvt-rs (`faces/refine.rs`, `Grid`). Avant, un tronc de cône à
fond plat laissait une fente de 2,6 mm (rayon d'un pied, polygone enregistré à 15°), un trou rond dans une dalle 0,6 mm.
Mesuré sur les fichiers d'essai (`tests/faces.rs`, détecteur de fentes par arête partagée) : 70 954 sommets en fente →
19 483, tous entre deux faces que rvt-rs maille seul (révolution contre révolution ou cylindre, au plus 2,9 mm), que ce
module ne touche pas. Les grilles des surfaces réglées et d'Hermite ne doublent plus un axe qui ne réduit pas l'écart
(deux demi-cercles de 50 pieds : 32 514 triangles → environ 512), et la grille intérieure d'une grande face tient toujours
dans `MAX_INTERIOR_POINTS` (éclaircie uniformément au lieu de perdre ses dernières rangées). Sur les 15 013 éléments en
forme Revit : 1 024 changent, aucun n'est perdu ni ne change de source, 5,46 → 5,33 millions de triangles (Vignette-04
910 804, rac_advanced 1 632 606, mega_advanced 1 277 106, SampleModel 926 239, curtainwall 277 058).

Ce n'était pas le cas des surfaces réglées. `Vignette-04-BaseFile.rvt` (Revit 2016, une tour de 130 pieds de large aux
dalles et aux panneaux courbes) faisait 19,6 millions de triangles, dont 1,17 million pour un seul élément, et 31 s de
lecture à un seul fil : rvt-rs maille une surface réglée à une maille par pied du plus long profil de toute sa
composante connexe (117 × 117 mailles, 27 000 triangles, pour chacune de ses faces, grande ou petite, plate ou gauche),
notre propre maillage à une maille par pied aussi (31 000 triangles pour une dalle plane de 40 mètres), et rvt-rs
reporte cette grille sur les plans qui touchent une surface réglée (960 points pour une face de 9 points enregistrés,
puis une découpe en oreilles de 0,8 s la face). Désormais :

- une surface réglée se maille d'abord par ce module, à la grille la plus grossière dont les triangles restent à
  `CHORD_ERROR` de la surface : deux triangles pour une surface entre deux droites coplanaires, quelle que soit sa
  taille ; entre deux droites gauches, une grille qui suit la flèche du gauchissement (1/(nu·nv)) ; entre deux arcs,
  celle des profils (1/nu²), avec au plus 128 × 128 mailles par face. Les côtés du contour qui courent le long d'une
  isoligne droite reçoivent les points de la grille, pour que les triangles de bord restent à la même flèche. rvt-rs
  reste le recours si ce module échoue ;
- un plan qui touche une surface réglée se maille aussi par ce module, avec les points enregistrés par Revit ;
- un cylindre se maille par rvt-rs (`cylinder_face`), mais au profil de ce module (`CHORD_ERROR`, un pied au plus
  entre deux rangs) : les 126 cylindres de RE1-Architecture et les 71 de DynamoSample sont les seules primitives de
  rvt-rs que les fichiers publics ne retrouvent plus à l'identique (`tests/faces.rs`, `Replaced`) ; les faces voisines
  d'un cylindre restent celles de rvt-rs, avec le contour qu'il lit ;
- une surface d'Hermite se maille à 0,01 pied (3 mm : `tess::HERMITE_CHORD_ERROR`), pas à `CHORD_ERROR`. Ces surfaces
  libres sont courbes dans toute leur étendue, et leurs triangles croissent comme 1 / flèche : à 0,001 pied les deux
  sculptures `DirectShape` de `revit-curtainwall-byprofile_v21` dépassaient 250 000 triangles chacune (des boîtes), et
  dix éléments de Vignette-04 étaient ramenés à leur boîte par le garde-fou des triangles maillés ; à 0,005 pied elles
  font 232 956 triangles (93 % du plafond d'un élément) et Vignette-04 2,85 millions ; à 0,01 pied, 128 000 et 2,75
  millions (à la flèche générale de 0,001 d'alors). La grille se règle sur seize mailles par axe, chaque axe grossissant
  comme la racine de l'écart qu'il doit rattraper, avec au plus 128 × 128 mailles par face ; les normales viennent de la
  surface, par sommet ;
- la triangulation d'une région rend ses triangles dans un ordre qui ne dépend que de la région : `spade` parcourt des
  tables de hachage à graine aléatoire, et la même lecture sortait d'un lancement à l'autre avec un ordre de
  triangles (donc de sommets) différent.

Vignette-04 : 910 804 triangles (988 664 avant les coutures et grilles corrigées ci-dessus, 2,75 millions à 0,001 pied, 19,6 avant les surfaces réglées), 2,3 s en natif ; le plus
dense de ses éléments passe de 1,17 million à moins de 100 000. Les étendues des éléments les plus denses sont celles du
maillage de rvt-rs (à la flèche près), et les faces que les deux maillent ont la même aire à 1 % près (`tests/legacy.rs`,
`tests/faces.rs`).

Budget. Un fichier ne peut pas dépasser ce qu'un navigateur tient en mémoire : le budget de triangles de la lecture
(`Options::triangle_budget`, `geometry::MAX_TRIANGLES` à défaut, 3 millions). Le viewer le règle d'après la mémoire de
l'appareil (`triangleBudgetFor`, `src/revit/readRevit.ts` : 2,5 millions de triangles par Go de `navigator.deviceMemory`,
entre 2 et 20 millions ; 10 millions quand le navigateur ne dit rien, voir § 7). Les formes partent au fil du maillage :
le budget se dépense dans l'ordre où elles s'achèvent, et chaque forme qui n'y tient plus est montrée par sa boîte
englobante, source 3 « Inconnue », avec un avertissement qui les compte (« Le fichier dépasse N triangles, ce que ce
navigateur peut afficher : les K éléments dont la forme ne tenait plus dans ce budget sont montrés par leur boîte
englobante et marqués « Inconnue ». ») ; une forme plus petite lue ensuite, qui tient encore, reste dessinée. (Avant
que la sortie parte par morceaux, le lecteur gardait tout et retirait d'abord les éléments les plus denses.) Un élément
seul ne garde pas plus de `saved::MAX_ELEMENT_TRIANGLES` (250 000) : au-delà il est aussi montré par sa boîte, avec son
avertissement. Pendant le maillage, un garde-fou (`Scene::hard_limit` : `saved::HARD_TRIANGLE_LIMIT`, 5 millions de
triangles maillés, ou le double du budget s'il est plus grand) cesse de mailler les éléments restants. Aucun fichier
d'essai n'atteint ces plafonds : le plus lourd, `rac_advanced_sample_project.rvt`, a 1,66 million de triangles (55 % de
3 millions) ; le plus dense des éléments, une sculpture de mur-rideau, a 128 000 triangles (51 % du plafond d'un
élément). Une forme refusée pour sa densité est toujours montrée par sa boîte, de quelque classe qu'elle soit : elle
s'écartait en silence quand aucun élément de sa classe n'avait de forme gardée (`geometry::nothing_to_lose`).

### Familles (.rfa)

Un document de famille se lit comme un projet : même conteneur, mêmes enregistrements, mêmes règles de dessin. Il se
reconnaît à son flux `PartAtom` (un projet a `ProjectInformation`, `revit/src/native/records.rs`, `is_family`). Ce que la
vue 3D d'un éditeur de famille montre, et que le lecteur dessine : les formes de la famille (extrusions, fusions,
balayages, révolutions, formes volumiques, mélanges, formes de masse conceptuelle comme les panneaux adaptatifs) et les
instances de familles chargées dans la famille. Pour un document de famille, la règle des masses est levée : dans un
projet, une masse est masquée par défaut, dans une famille les formes d'une masse sont la famille. Dans un projet, un
avertissement compte les masses non dessinées : seulement les éléments d'une classe qui porte de la géométrie (une
instance de famille de masse), pas les enregistrements de la catégorie Masse que contient tout gabarit (il en annonçait
2 sur des fichiers qui n'en ont aucune). Les plans de référence,
niveaux, esquisses, vues, annotations (régions remplies, texte, cotes) et courbes ne se dessinent pas, comme dans un projet.
Une famille sans aucune forme (une masse vide) se lit sans erreur et ne dessine rien : le viewer dit alors qu'elle ne
contient aucun élément à afficher.

Mesuré sur les familles d'essai : `AdaptivePanel.rfa` (2027) 4 formes volumiques ; `FamilyDocumentTests.rfa` (2020) 4 extrusions,
4 mélanges et 2 balayages ; `ShellFamily.rfa` (2016) 2 formes et 2 instances imbriquées ; `MassWithBoxAndCone.rfa` (2016) aucune.
Les vides (extrusions de coupe) ne se dessinent que par ce qu'ils retranchent à la fusion qui les porte.

### Repère

Revit travaille en pieds, axe Z vers le haut. Le viewer travaille en mètres, axe Y vers le haut :
`(x, y, z)` pieds devient `(x, z, -y) × 0,3048` mètres. Ce changement d'axes inverse l'orientation,
et le lecteur en tient compte pour l'ordre des triangles. Les positions sont écrites relativement
au centre du modèle (calculé en double précision), qui est rendu dans `origin` : le modèle reste
net même loin de l'origine, et `origin` devient le `Model.offset` du viewer, donc les coordonnées de
projet affichées et exportées restent justes.

## 4. Propriétés

Le JSON suit le contrat habituel : un objet par élément, indexé par la clé.

En tête de fiche : `Catégorie` (nom français), `Famille`, `Type`, `Niveau`, `Identifiant Revit`
(l'ElementId, un nombre), `GUID IFC`, `Phase de création`, `Matériaux` (liste de noms) et
`Source de la géométrie`. Viennent ensuite un objet imbriqué par groupe de paramètres de Revit
(`Contraintes`, `Cotes`, `Données d'identification`, `Phase de construction`, `Autre`…), qui contient
tous les paramètres que rvt-rs lit pour l'élément. Les paramètres d'instance viennent d'abord, puis
ceux du type, dont le nom porte le suffixe « (type) ». Cela vaut pour toutes les catégories, murs,
sols, toits et plafonds compris : le type est retrouvé par l'identifiant de type de l'élément.

La `Catégorie` vient, dans l'ordre (`properties/fiche.rs`, `category_of`) :

1. de la famille du type, pour une instance de famille ;
2. du paramètre de catégorie de l'élément (`ELEM_CATEGORY_PARAM`) ;
3. de ce que le fichier dit de l'élément et qui l'emporte sur sa classe : une forme (extrusion, balayage, mélange,
   révolution, forme libre) prend la catégorie de la famille qui la possède, sur place ou celle du document (une extrusion
   d'une famille de mobilier est « Systèmes de mobilier », non « Modèles génériques ») ; un sol dont le type a
   `m_footingType` = 1 est une dalle de fondation, « Fondations porteuses » ;
4. de sa classe, quand tous les éléments de la classe sont d'une seule catégorie (murs, toits par extrusion ou par face,
   semelles filantes, escaliers, systèmes de murs-rideaux, sols de masse, surfaces divisées…) ;
5. de ce que le fichier enregistre pour les classes qui n'ont pas de catégorie propre : la classe du type pour un nez de
   dalle, un bandeau ou une gouttière (`SweepHost`), la catégorie choisie par son auteur pour une `DirectShape`, celle du mur
   qui le possède pour un profilé intégré au type d'un mur (`WallSweep` à `m_fixed`, que Revit traite comme une partie du
   mur : « Murs », non « Corniches »).

Chaque règle est vérifiée sur les fichiers d'essai par une seconde source du fichier, les styles graphiques que Revit
enregistre avec la forme de l'élément : ils portent la même catégorie. Une source manquante ou ambiguë ne range pas :
l'élément garde « Classe Revit » et se groupe sous « (non défini) ». Sur les 15 642 éléments dessinés des fichiers d'essai (15 667 avant que le contenu des
familles sur place soit dessiné par leur instance, § 3 : 21 formes de moins, et 4 formes de masses masquées),
aucun ne reste sans catégorie. Les 5 surfaces divisées d'une famille de masse de 2013 (`DividedSurface`) sont « Surface
divisée » (OST_DividedSurface, -2003323) : leur propriétaire dit « Masses », mais tous les styles dont elles sont dessinées sont
des sous-catégories de cette catégorie (`_Nodes`, `_Gridlines`, `_PatternLines`, `_PatternFill`), et une sous-catégorie est
toujours sous la catégorie de l'élément. C'est une catégorie interne (genre I) que seules les fiches lisent
(`FICHE_CLASS_CATEGORIES`) : la géométrie l'écarterait du dessin, et ne la voit pas.

La `Famille` et le `Type` suivent ce que Revit montre (« Famille : Type »), non l'année d'enregistrement : le même modèle
enregistré en 2014, 2023, 2024 et 2025 a les mêmes noms, et l'export IFC de Revit 2026 de RE1-Architecture (`ObjectType`
« Famille:Type ») donne les mêmes noms pour 72 éléments sur 73, le 73e étant le garde-corps (« Railing:- »). Le type de l'élément est
le premier de `m_masterSymbolId`, `m_typeId`, puis des autres champs qui désignent un type (dont `m_idType`), à condition de
désigner un enregistrement de type ; la famille est celle du type, à défaut la famille système de sa classe
(`catalog::system_family`). Cinq cas particuliers : un garde-corps a pour type `m_stairsRailingAttrId` (`StairsRailingAttr`),
famille système « Garde-corps » ; une lisse haute a pour type son `m_typeId` (`TopRailType`) et non le symbole interne
(`ContinuousRailSymbol`, « 1 », « 3 »…) que le balayage prenait ; une gaine et un tuyau l'ont dans `m_idType` ; un profilé de mur
intégré à un type de mur (`WallSweep` à `m_fixed`), sans type, prend la famille et le type du mur qui le possède (ElemTable), et son
libellé. Une forme d'une famille sur place (extrusion, balayage, forme de masse…) n'est plus un élément dessiné : c'est l'instance de sa famille qui est
dessinée et décrite (§ 3, « Familles sur place »), avec le même libellé, la même catégorie, la même famille et le même type que la forme qu'elle remplace (24 formes sur 24 mesurées), et la forme d'une
famille de masse, comme son instance, n'est pas dessinée (masses masquées par défaut). Le nom que prendrait une forme encore dessinée (aucune dans les fichiers d'essai) est le nom de la `Family` qui la
possède et le type du `FamilySymbol` qui possède cette `Family`, accepté si ce symbole est un type de cette famille (sinon le type reste vide) : ni l'un ni l'autre ne reçoit les paramètres de type d'un autre élément
(essais unitaires de `properties::fiche`). Une forme de la famille d'un `.rfa` n'a ni famille ni type :
son libellé est sa sorte (Extrusion, Raccordement, Balayage, Raccordement par balayage, Révolution, Forme, Forme libre) et son
identifiant. Sur les 15 667 éléments des fichiers d'essai d'alors (dont les 25 formes de familles sur place, qui ne sont plus dessinées), 271 étaient sans famille et 176 sans type ; il en reste 61 et 61, que
Revit ne nomme pas non plus : 25 topographies, 8 sols de masse, 20 formes d'un `.rfa`, 5 surfaces divisées et 3 formes directes
(`m_typeId` à -1).

Valeurs : texte, nombre, booléen. Un paramètre qui désigne un autre élément (ElementId) donne le nom
de sa cible. Les valeurs décimales sont enregistrées dans les unités internes de Revit et converties
en unités SI (voir « Unités » ci-dessous) ; l'unité entre dans le nom du paramètre (`Hauteur non
contrainte (m)`, `Surface (m²)`, `Volume (m³)`, `Angle (°)`, `Débit (L/s)`) et la valeur est arrondie à
douze chiffres significatifs (le bruit des conversions est au seizième ; un nombre saisi, un coût ou une coordonnée
ne perd rien). Un paramètre absent du catalogue s'appelle `Paramètre Revit <identifiant>`.

### Unités

Revit enregistre toute valeur décimale dans un système cohérent dont les unités de base sont le pied
(longueur), la seconde, le kilogramme, le kelvin, l'ampère et la candela, et dont les unités dérivées
s'en construisent sans coefficient : un débit d'air est en pieds cubes par seconde, une pression en
kg/(pi·s²), une puissance en kg·pi²/s³, une tension en kg·pi²/(s³·A), un éclairement en lm/pi².
Seul le pied diffère du SI : la valeur SI d'une grandeur dont la dimension porte la longueur à la
puissance n vaut donc la valeur enregistrée × 0,3048ⁿ (une puissance : n = 2, 1 enregistré = 0,0929 W).
`revit/src/catalog/units.rs` écrit, pour chaque nature de spec, cette puissance, le facteur de l'unité
d'affichage et le suffixe du nom ; un essai par nature donne la valeur calculée à la main. Les
grandeurs converties sont les suivantes.

| Nature (spec) | Affichage | Dimension interne |
| --- | --- | --- |
| longueur, distance, tailles de gaine et de tuyau, rugosité… | m | pi |
| surface, volume, angle | m², m³, ° | pi², pi³, rad |
| débit d'air, débit (tuyauterie) | L/s | pi³/s |
| débit d'air par surface | L/(s·m²) | pi/s |
| vitesse | m/s | pi/s |
| pression, contrainte, force par surface | Pa, N/m² | kg/(pi·s²) |
| perte de charge linéique, viscosité | Pa/m, Pa·s | kg/(pi²·s²), kg/(pi·s) |
| masse volumique, masse linéique, surfacique | kg/m³, kg/m, kg/m² | kg/pi³, kg/pi, kg/pi² |
| température, écart de température | °C (du kelvin, −273,15), K | K |
| puissance, gain de chaleur, charges thermiques | W | kg·pi²/s³ |
| puissance par surface | W/m² | kg·pi²/s³ par pi² |
| puissance apparente | VA | kg·pi²/s³ |
| tension | V | kg·pi²/(s³·A) |
| courant, fréquence | A, Hz | A, 1/s |
| éclairement, luminance, efficacité lumineuse | lx, cd/m², lm/W | lm/pi², cd/pi², lm/(kg·pi²/s³) |
| flux lumineux, intensité lumineuse | lm, cd | lm, cd |
| masse | kg | kg |
| force, moment, énergie | N, N·m, J | kg·pi/s², kg·pi²/s² |
| force linéique | N/m | kg/s² |
| pente (montée / course) | % | rapport sans dimension, × 100 |
| accélération, moment d'inertie, module de section | m/s², m⁴, m³ | pi/s², pi⁴, pi³ |

D'où vient la spec d'un paramètre.

- Un paramètre de famille, partagé ou de projet (identifiant positif) a sa spec dans le fichier, par
  son `ForgeTypeId` (`autodesk.spec.aec.hvac:airFlow-2.0.0`) : la conversion est exacte.
- Un paramètre de famille d'un fichier de Revit 2012 à 2020 n'a pas de spec : la définition (`ParamDefValue`) porte
  `m_unitType`, le numéro de l'ancienne énumération `UnitType` de l'API (0 longueur, 1 surface, 3 angle, 12 pression de
  gaine, 19 courant, 20 tension, 24 puissance, 26 force, 34 puissance apparente, 37 débit…). `revit/src/catalog/unit_types.rs`
  lui donne la spec que Revit 2022 donne à ce numéro, de sorte que sa valeur se convertit comme dans un fichier récent
  (à partir de Revit 2021, les fichiers portent déjà `m_specTypeId`). La table est établie sur trois sources : quinze
  numéros observés sur les octets, `SampleModel.rvt` (Revit 2017) et `DynamoSample_2023.rvt` étant le même modèle enregistré
  par deux versions (230 définitions décimales communes, chaque numéro y a toujours la même spec dans le fichier de 2023) ;
  les valeurs de l'énumération `UnitType` de `RevitAPI.dll` (133 membres, de `UT_Length = 0` à `UT_Stationing = 132`), dont les
  quinze numéros observés portent exactement les noms que les specs donnent (12 = `UT_HVAC_Pressure`, 74 =
  `UT_Electrical_Wattage`…) et qui n'a jamais été complétée qu'à la fin ; la correspondance de nom `UT_X` vers `SpecTypeId.X`
  de l'API de Revit 2022. Ne sont retenus que les numéros dont la grandeur est connue de `units.rs` (97 numéros), plus le
  wattage observé ; tous les autres, ou un numéro inconnu (−1 personnalisé, au-delà de 132), laissent la valeur brute, sans
  suffixe. Un essai par numéro donne la valeur SI calculée à la main (`cargo test --lib unit_types`), et
  `tests/legacy.rs` compare les fiches des 234 éléments que `SampleModel.rvt` (2017) et `DynamoSample_2023.rvt` ont en commun :
  226 sont identiques (le groupe « Modèle analytique », né en 2023, mis à part), les autres diffèrent par des modifications du
  modèle, jamais par une unité.
- Un paramètre intégré (identifiant négatif) n'en a pas : Revit ne l'enregistre pas et
  Rhino.Inside.Revit ne la publie pas. Le catalogue lui donne sa grandeur de deux façons : une table
  écrite à la main pour les noms qui disent la grandeur sans ambiguïté
  (`revit/src/catalog/source/parameter-specs.tsv` : débit, pression, température, puissance,
  tension…), puis une devinette sur le nom pour la longueur, la surface, le volume et l'angle
  (`specOf` dans `scripts/gen-revit-catalog.mjs`). Un nom de la forme « X par Y » prend la nature de
  X : un débit d'air par surface n'est pas une surface.
- Un nombre sans dimension (facteur, rapport) garde la valeur du fichier. Une grandeur dont l'unité
  interne n'est pas établie (conductivité thermique, poids, coût…) aussi : **aucune unité n'est
  inscrite dans le nom**, pour ne pas présenter comme du SI un nombre dont on ne sait pas ce qu'il
  vaut. `cargo run --release --example props -- fichier.rvt` compte ces valeurs (« unités : … »).

Vérifié sur les fichiers d'essai : dans `DuctSegmentFlow.rvt`, la bouche de soufflage enregistre
8,33333 pi³/s et 4,27015 kg/(pi·s²), soit 235,974 L/s (500 pi³/min) et 14,0097 Pa ; dans
`RE1-Electrical.rvt`, les tensions valent 120 et 240 V, les puissances apparentes 0, 9, 21, 180, 1 000,
2 000 VA et les fréquences 50 et 60 Hz, des valeurs rondes que seuls les bons facteurs donnent
(`tests/properties.rs`).

Les noms des paramètres intégrés viennent d'une table générée à partir de Rhino.Inside.Revit
(identifiant numérique, nom d'énumération, `ForgeTypeId`, catégories, groupes). Les libellés français
sont rédigés pour ce projet : ceux de Revit en français pour les paramètres courants, une
lecture française de l'identifiant pour les autres.

`readOnly` liste tous les noms de premier niveau et tous les noms de groupe utilisés : les données
de Revit sont en lecture seule, comme celles d'un IFC. Le bloc `georeference` est écrit quand
rvt-rs donne l'emplacement du site (voir `src/geo/georeference.ts` pour sa forme) ; la carte du viewer
s'en sert. Les blocs `phases` et `views` (§ 4 bis, plans d'étage compris) viennent des mêmes enregistrements que la géométrie décode déjà
(`properties::Retained`, module `revit/src/views/`) : aucune passe de plus sur le fichier.

### Position sur Terre

L'emplacement actif (`ActiveGeoLocationTrackingElement`) désigne un `GeoLocation`, dont le `GeoSite`
donne la latitude, la longitude, l'altitude et le nom du lieu. Un lieu au nom vide est celui du
gabarit (Waltham) : il n'est pas recopié. La transformation `m_Trf` du `GeoLocation` place le site
dans le projet, comme celle de toute instance place son symbole : `p_projet = M · p_site + m_or`
(matrice lue par lignes, translation en pieds). Le repère du site est celui des coordonnées partagées
(X est, Y nord vrai, Z haut), d'où :

- `trueNorth` : le nord vrai vu dans le projet, **colonne 1** de `M` (normalisée) ;
- `origin` : le point du projet qui est à cette latitude et à cette longitude, `m_or` converti en
  mètres (Z vers le haut, comme le contrat) ;
- `elevation` : l'altitude du site, en mètres.

Le sens a été établi sur les données : dans les trois DynamoSample, l'emplacement « Project »
(matrice identité) a pour translation exactement la position, dans le projet, du point de relevé,
l'origine des coordonnées partagées ; l'origine du site est donc bien à `m_or`, et le sens inverse
mettrait ce point de relevé à deux fois sa position au lieu de zéro. L'export IFC de rvt-rs ne peut
pas arbitrer : il écrit un `IfcSite` sans position ni nord vrai. Seuls les DynamoSample ont un emplacement
actif non trivial (rotation de 37,0°, nord vrai (0,6018 ; 0,7986), soit 37° dans le sens horaire de
l'axe Y du projet ; origine à 27,151 m et 3,091 m) ; tous les autres fichiers d'essai ont la matrice
identité et une translation nulle. Aucune référence extérieure (un export IFC de Revit du même
fichier, avec nord vrai ou `IfcMapConversion`) n'existe pour un fichier d'essai dont l'emplacement est
non trivial : le signe de la rotation repose sur le sens de `m_Trf` ci-dessus
(`tests/properties.rs`, `le_sens_de_la_transformation_d_un_emplacement`).

## 4 bis. Phases, vues 3D et plans d'étage enregistrés

### Phases

Revit range la suite des phases du projet dans `AllProjectPhases.m_phaseIds`, dans l'ordre chronologique, et chaque phase dans un
enregistrement `ProjectPhase` (son nom). Un élément porte sa phase de création et de démolition (`m_createdPhaseId`,
`m_demolishedPhaseId`, `-1` pour aucune). Attention : l'identifiant d'une phase peut être **0** (la phase « New Construction »
de `RefineryPrimer-*` et « A10 - Substructure » de `revit-curtainwall-byprofile_v21.rvt`) ; un 0 pris pour « aucune phase » retirait
la propriété à tous les éléments de cette phase.

Un filtre de phase est un enregistrement `PhaseFilterElem` : `m_phaseStatusPresentation` a sept entrées, une par état d'un élément
dans la phase d'une vue (`ElementOnPhaseStatus` de l'API de Revit : 0 aucun, 1 passé, 2 existant, 3 démoli, 4 nouveau, 5
temporaire, 6 futur), valant 0 (ne pas afficher), 1 (afficher selon la catégorie) ou 2 (afficher remplacé). Le décodage se vérifie
sur les filtres que Revit livre : « Show All » = `[0,0,2,2,1,2,0]` (existant, démoli et temporaire remplacés, nouveau tel quel),
« Show Complete » = `[0,0,1,0,1,0,0]`, « Show New » = `[0,0,0,0,1,0,0]`, « Show Previous + Demo » = `[0,0,2,2,0,0,0]` : ce
que la documentation de Revit annonce.

Le remplacement graphique de chaque état est dans `AllProjectPhases.m_arrPhasingOverrides` : un `PhasingOverrides` par état
(existant, démoli, nouveau, temporaire), avec un matériau de remplacement (`Phase - Exist` : gris 127 ; `Phase - Demo` : rouge,
transparence 0,4 ; `Phase - Temporary` : bleu foncé, transparence 0,4). Son `m_color` est un COLORREF de Windows (octets rouge,
vert, bleu de poids croissant : 255 = rouge, 8 323 072 = 0x7F0000 = bleu 127). Le lecteur en tire la couleur et l'opacité de
`overrides` ; un gabarit sans matériau de remplacement (`-1`, comme `Revit_IFC5_Einhoven.rvt`) n'en écrit pas.

Ce que le fichier dit de chaque état se lit dans le JSON de métadonnées sous `phases` (voir
[contrat-metadonnees.md](contrat-metadonnees.md), § 2 quinquies). **Aucun fichier d'essai n'a d'élément démoli** : tous les éléments
dessinés sont créés dans une seule phase (la dernière du projet pour la plupart, « Working Drawings », la deuxième de trois, pour
`DynamoSample_*` et `SampleModel`) et aucun `m_demolishedPhaseId` n'est renseigné (`cargo run --release --example views -- fichier --scan`).
Ceux qui ont plusieurs phases : `DynamoSample_2023/2024/2025` et `SampleModel` (trois phases, 296 et 547 enregistrements d'éléments créés dans la
deuxième : *nouveaux* dans « Working Drawings », *existants* dans « Learning Content », *futurs* dans « Existing ») et
`revit-curtainwall-byprofile_v21.rvt` (neuf phases, une vue par phase avec son filtre : 131 éléments créés dans « Project
Completion », donc masqués dans toutes les vues de phases antérieures). Les états *démoli*, *temporaire* et *passé* ne se
vérifient donc que par des essais sur des données écrites à la main (`tests/phases.test.ts`).

### Vues 3D enregistrées

Une vue 3D est un enregistrement `DBView3d` (le nom, `m_viewName`) lié à un `Viewer3d` (la caméra) et, par lui, à un `ModelClipBox`
(la boîte de coupe). Le lecteur retient les vues 3D qui ne sont pas des gabarits (`m_isTemplate`) et qui ont une caméra : la vue
par défaut `{3D}` en fait partie, les vues « Façade », « Coupe en perspective »… nommées par l'utilisateur aussi. Les vues de coupe,
d'élévation, de nomenclature et de feuille ne sont pas des vues 3D et ne sont pas lues ; les plans d'étage se lisent à part (« Plans d'étage »,
ci-dessous).

- **Caméra.** `m_origin` est l'œil (pieds) ; `m_vertDir` le haut ; `m_viewDir` le sens **inverse** du regard (vérifié : pour « Cuisine »,
  l'œil est dans la maison et regarde +X alors que `m_viewDir` vaut −X) ; la droite est regard × haut, comme dans l'API de Revit.
  `Viewer3d.m_projMethodType` vaut 1 en projection parallèle et 2 en perspective (relevé sur les vues « Perspective… » et
  « {3D} » des fichiers d'essai).
- **Champ de la perspective.** `Viewer3d.m_boundedSpace` est la fenêtre de recadrage : pour chaque axe, deux décalages (haut et
  bas, ou droite et gauche) en pieds, et si le bord est actif. En perspective ils sont écrits sur le plan à `m_projDist` (0,1 pied)
  de l'œil : le champ vertical en vient (arc tangente du décalage haut sur 0,1 plus celui du bas), et le centre de la fenêtre,
  rarement sur l'axe, donne le regard (la caméra regarde le centre de la fenêtre : jusqu'à 11° pour « From Yard »). C'est une
  **hypothèse** : le plan de la fenêtre n'est pas confronté à Revit, mais elle donne 25° à 92° sur les 42 perspectives des fichiers
  d'essai, alors que la profondeur de découpe proche (qui n'est pas toujours 0,1 : le millième de la profondeur lointaine) donnerait
  24° à des vues extérieures. Sans fenêtre réglée (décalages ±100 pieds, ou côtés inactifs), le champ du viewer reste.
- **Fenêtre de la projection parallèle.** `{3D}` garde dans les mêmes décalages la fenêtre qu'elle montrait (328 × 158 pieds pour
  `DynamoSample`) : `size`. Les vues dont les décalages valent ±100 pieds n'ont pas de fenêtre enregistrée : la maquette est cadrée.
- **Boîte de coupe.** `ModelClipBox.m_boundedSpace` : un repère (`m_basis`, une ligne par axe), une origine, des décalages haut et bas par
  axe et `m_isOn`, qui dit si la boîte est active (`Solar Analysis`, `Section Perspective`, `{3D}` de `SampleModel`…). Une boîte
  inactive garde ses dimensions dans le fichier et n'est pas écrite. Les boîtes des fichiers d'essai ont toutes un repère identique
  aux axes du projet (aucune rotation) ; une rotation autour de la verticale est convertie en `rotation`, toute autre (qu'aucun outil de
  Revit ne produit) fait ignorer la boîte.
- **Éléments et catégories masqués.** `HiddenElementsViewSettings.m_hiddenElements` (identifiants d'éléments, repris s'ils sont dessinés :
  une vue peut masquer sa propre boîte de coupe) et `IckyExcludedCategoriesSetPtrWrapper.m_categoryIds` (catégories masquées,
  identifiants négatifs de BuiltInCategory : leur nom français est celui de la propriété `Catégorie` des éléments ; un identifiant positif
  est l'élément `CategoryElem` d'une catégorie du projet, voir « Ce que les vues masquent », ci-dessous). Seules les
  catégories que portent des éléments dessinés sont écrites : un gabarit masque quelque 70 catégories (analytique, annotations,
  masses…), dont presque aucune n'a d'élément dessiné. Dans les fichiers d'essai : « Demo Export » de `2024_Core_Interior.rvt`
  (les murs, et 146 éléments), « 3D Plumbing » de `DuctSegmentFlow.rvt` (bouches d'air, gaines, raccords) et des éléments masqués dans les
  vues de `Vignette-04-BaseFile.rvt`.
- **Phase et filtre de phase de la vue.** Deux paramètres d'élément du jeu de la vue : `VIEW_PHASE` (-1012102) et
  `VIEW_PHASE_FILTER` (-1012103).
- **Gabarits de vue.** Un gabarit (`m_isTemplate`) est un `DBView3d` sans caméra, que `m_viewTemplateId` désigne. Il n'est pas listé et le
  lecteur ne le suit pas : la vue a déjà enregistré les valeurs qu'il lui a appliquées. Revit ne dit pas ici quels paramètres le
  gabarit pilote (`m_nonPropagatedTemplateParamIds` dit ceux qu'il ne pilote pas) : une vue dont le gabarit a changé depuis peut
  donc être décalée par rapport à lui.

Coordonnées : mètres, axe Y vers le haut, `(x, y, z)` pieds → `(x, z, −y) × 0,3048`, **sans** soustraire l'origine du modèle : ce sont celles du
repère du GLB (celui des `positions` plus `origin`), que le viewer recentre avec `Model.offset`. Les vecteurs sont ceux de Revit passés
par le même changement d'axes.

**Ce qui est ignoré** : les remplacements graphiques par catégorie, par élément et par filtre de vue (`GraphicOverrides`, `FilterOverrides`), le
niveau de détail, le style visuel (`m_modelDisplayMode`), les ombres et l'arrière-plan, la profondeur de découpe, les liens Revit et les
sous-projets (worksets), les options de conception, et les vues qui ne sont ni des vues 3D ni des plans d'étage.

Mesuré sur les fichiers d'essai. Avant 2015, les vues 3D et les phases de chaque famille chargée (« {3D} », « View 1 », ses phases et
ses filtres de phase) sont écrites parmi celles du projet, possédées par leur `Family` : elles sont écartées comme ses éléments (§ 6), et
`DynamoSample_2014.rvt` rend exactement les vues, caméras comprises, et les phases de `DynamoSample_2023.rvt` (41 vues sans la règle).
Vues retenues : `DynamoSample_*` 7 (dont 2 avec boîte de coupe, 1 avec un élément masqué), `SampleModel` 7 (3 boîtes),
`mega_advanced_sample_file` et `rac_advanced_sample_project` 7 (3 boîtes), `Vignette-04-BaseFile` 7, `revit-curtainwall-byprofile_v21` 10, les
autres 0 à 2 (les familles `.rfa` ont aussi leurs vues 3D, sans phases). Les vues 3D de `RoomsAndExits.rvt` et `singleDirectShape.rvt` sont des
gabarits sans caméra : leur section `views` ne compte que leurs plans d'étage (3 chacun). Les sections `phases` et `views` s'écrivent dans le JSON de
métadonnées : le module wasm n'a pas d'autre sortie à ce sujet.

### Plans d'étage

Un plan d'étage est un enregistrement `DBViewPlan` dont `m_planViewType` vaut 1 (le plan regarde vers le bas) et qui n'est pas un gabarit
(`m_isTemplate`). Il a les champs d'une vue 3D (nom, repère `m_horzDir` / `m_vertDir` / `m_viewDir`, éléments et catégories masqués, phase et
filtre de phase, dans les mêmes objets du graphe) et sa plage de vue en plus. Il s'écrit dans `views[]` avec `"kind": "plan"`, après les vues 3D
(voir [contrat-metadonnees.md](contrat-metadonnees.md), § 2 sexies) : le viewer l'ouvre en 2D, vu de dessus, coupé à sa hauteur de coupe, entre sa
profondeur de vue et sa coupe, comme Revit (`wadduwa.rvt` : le plan « GF » montre `MAN-GF.dwg`, le plan « 2F » masque `MAN-2F.dwg`).

- **Enregistrements.** `DBViewPlan` (le plan), `Viewer` (son recadrage, `m_boundedSpace`, décodé comme celui d'une vue 3D) et `DBViewType`
  (`SymbolInfo.m_name` : « Floor Plan », « Structural Plan », « E-Working Plan »…). Un plan de surface (Revit : « Area Plan ») a aussi
  `m_planViewType` 1 ; son type est d'une classe à part, `DBViewTypeAreaPlan` (« Gross Building »). Ces classes étaient écartées avant tout décodage
  (`classes::excluded_class` : « vue, coupe ou caméra ») ; ce sont maintenant des classes d'appui (`views::is_view_class`), que
  `geometry::saved::read_records` décode avec les autres dans la même passe sur les enregistrements d'éléments : **aucune passe de plus** sur le fichier.
  Seul ce qui sert est gardé, sans graphe (`Digest` : un `Plan` par plan, le recadrage de chaque `Viewer`, le nom de chaque type), et
  `Digest::settle` ne garde que les `Viewer` et les types que les plans retenus désignent. Le coût (mémoire, durée) est mesuré au § 7.
- **Ce que les fichiers d'essai contiennent.** 905 enregistrements `DBViewPlan` dans les 55 fichiers lisibles : 161 gabarits, 201 plans de plafond (`m_planViewType` 2)
  et 543 plans vus de dessus (484 « Floor Plan », 51 « Structural Plan », 1 « E-Working Plan » et 7 plans de surface). Avant 2015, 370 de ces 543 sont des pièces des
  familles chargées, que le projet écrit parmi les siens (`DynamoSample_2014.rvt` : 66 enregistrements contre 3 en 2023) : écartés comme les
  vues 3D (§ 6), ils laissent **173 plans d'étage** écrits sur les 55 fichiers (153 « Floor Plan », 12 « Structural Plan », 1 « E-Working Plan », 6 « Gross Building » et 1 « Rentable » :
  les 7 plans de surface), dont 26 recadrés (6 recadrages tournés) et 51 sans profondeur de vue. Aucun n'a été écarté faute de pouvoir être lu.
- **Plage de vue.** `m_cutPlaneElev`, `m_bottomClipElev` et `m_topClipElev` sont des altitudes absolues en pieds, déjà résolues par Revit à partir du niveau et
  des décalages ; au-delà de 1e8 en valeur absolue (±999 999 999,99 : un bas « niveau en dessous » sans niveau en dessous), c'est « illimité ». Les niveaux et
  les décalages qui les ont donnés sont dans `PlanViewRange2` (`m_viewDepthPlaneLevelIds` et `m_viewDepthPlaneOffsets` dans les fichiers récents, `m_levelIds`
  et `m_offsets` dans les autres, 492 plans sur 543 : même sens) ou, à défaut, dans `PlanViewRange` (`m_levelPos`, `m_offsets` ; aucun plan des fichiers d'essai n'a
  que celui-là), cinq entrées chacun, dans l'ordre **coupe, haut, bas, profondeur de vue, (inutilisée)**. L'ordre se vérifie sur les plans dont la coupe et le haut (ou le
  bas) sont sur le même niveau : coupe − décalage de coupe = haut − décalage du haut (527 plans sur 527) = bas − décalage du bas (502 sur 502). Un niveau d'identifiant
  -1 est illimité, -4 « le niveau en dessous » ; -2 et -3 sont les niveaux relatifs des gabarits.
  Le plan montre le modèle entre sa **profondeur de vue** et sa **coupe** : `range.top` est la coupe, `range.bottom` la profondeur (absente si elle est illimitée). La
  profondeur est (`views::ViewRange::depth_feet`) : 1. si son niveau est celui du bas de la plage (même identifiant, ou même position de niveau ; pas -1), `m_bottomClipElev` −
  décalage du bas + décalage de la profondeur (« GF » de wadduwa : coupe à 4,921 pieds = 1,50 m, bas et profondeur au niveau 0,984 pied = 0,30 m ; son plan de structure « 1F » : bas −3,937,
  profondeur −5,906 pieds du niveau, soit 2,10 m à 4,20 m) ; 2. sinon, si le niveau de la profondeur est « illimité » (-1) ou si le bas l'est, pas de limite ; 3. sinon (une profondeur sur
  un autre niveau, dont le fichier ne donne pas l'altitude : 110 plans sur 543), `m_bottomClipElev`, qui est prudent (le plan montre au plus ce que Revit montre). **Le haut de la plage
  (`m_topClipElev`) n'est pas lu** : le viewer ne montre rien au-dessus de la coupe. Un plan dont la coupe est absente ou illimitée (aucun, hors gabarit), dont le `Viewer` est introuvable, dont le
  recadrage actif n'est pas un rectangle de plan ou dont la profondeur est au-dessus de la coupe n'est pas écrit : rien n'est inventé.
- **Caméra.** Parallèle, droit vers le bas (`direction` `[0, -1, 0]`), `up` = `m_vertDir` converti comme toute direction, `(x, y, z)` → `(x, z, −y)`. **`m_vertDir` porte déjà
  la rotation du nord vrai** : le plan est orienté sur le nord vrai quand `m_bUseTrueNorth` est vrai (11 plans des fichiers d'essai), et son `m_vertDir` est alors le nord vrai
  du projet. Dans `DynamoSample_2014` à `_2025` et `SampleModel` (le même modèle), le plan « Site » a `m_vertDir` = (0,6018 ; 0,7986) et `m_horzDir` = (0,7986 ; −0,6018) : la rotation
  de 37° de l'emplacement actif que `properties::geo` lit, au chiffre près (`georeference.trueNorth`) ; les plans de ces fichiers qui n'ont pas l'indicateur ont (0 ; 1). Les six autres plans
  « nord vrai » (`2D Site` de quatre fichiers, deux plans analytiques de `dynamo-structural-framing-2014`) sont dans des fichiers dont le nord vrai est (0 ; 1), et leur `m_vertDir` aussi.
  Le nord vrai de l'emplacement n'est donc **pas relu** : le composer
  avec `m_vertDir` compterait la rotation deux fois (`tests/plans.rs`, `le_haut_d_un_plan_nord_vrai_est_m_vert_dir_qui_porte_deja_la_rotation` : `up` est le nord vrai de `georeference`).
- **Recadrage.** Le `Viewer` du plan a un `m_boundedSpace` dont le repère est exactement celui de la vue (`m_basis` = `m_horzDir`, `m_vertDir`, `−m_viewDir` sur les 543 plans) : deux décalages
  (côté positif, côté négatif) par axe, depuis `m_orig`, et `m_boundActive` par côté. Le recadrage est actif sur les deux côtés des deux axes (26 plans) ou sur aucun (517) ; `m_isOn` est toujours vrai.
  Actif : `camera.size` est sa largeur (le long de la droite de la vue) et sa hauteur (le long de son haut), en mètres, `camera.position` son centre à la hauteur de coupe, et `sectionBox` son
  rectangle (x et z, avec sa `rotation` quand la vue est tournée : −37° pour « Site » de `DynamoSample`, −29° pour `ROOF_02` de `Vignette-04-BaseFile`), avec pour y la plage du plan (`range.bottom`, ou `-10000` sans
  profondeur : le JSON n'a pas d'infini ; `range.top`). Sans recadrage : ni taille ni boîte, la position est l'origine de la vue à la hauteur de coupe, et le viewer cadre le modèle.
- **Ce que les vues masquent** (plans et vues 3D). Les catégories masquées (`IckyExcludedCategoriesSetPtrWrapper.m_categoryIds`) : un identifiant négatif est une catégorie de Revit, écrite sous son nom
  français comme avant ; un identifiant positif est un élément `CategoryElem`, soit la catégorie d'un import CAD (nommée comme le fichier : « MAN-GF.dwg »), soit une **sous-catégorie** (le calque d'un import, « A-Area », ou « Plan Swing »). La
  catégorie d'un import **dessiné** est écrite sous le libellé que la fiche de cet import porte dans `Catégorie` (`Resolver::imports`, la même résolution que la fiche : `import_symbol`). Une
  sous-catégorie est ignorée : elle masque une partie d'une forme (un calque d'un DWG), ce que le viewer ne sait pas faire ; les plans de `wadduwa.rvt` masquent ainsi des calques (« A-Area », « A-GinI Kathira »…) sans masquer leur DWG, et c'est
  `HiddenElementsViewSettings.m_hiddenElements` qui masque le DWG entier (`MAN-2F.dwg` dans « 2F », `MAN-RF.dwg` dans le plan « RF » de type « Floor Plan », `MAN-URF.dwg` dans « URF » ; « GF » et le plan de structure « RF » n'en masquent aucun).
  `IckyExcludedCategoriesSetPtrWrapper.m_importsExcluded` (vrai sur 2 plans sur 744, plans de plafond compris, et 1 vue 3D sur 354) ajoute à `hiddenElements` les clés de tous les imports CAD dessinés. Dans les fichiers
  d'essai, 4 vues 3D hors gabarit sur 354 masquent des catégories positives et 1 masque les imports : comparées avant et après (`dump` de chaque fichier), aucune des 128 vues 3D écrites ne change de ce fait.
- **Phase et filtre de phase.** Comme une vue 3D (`VIEW_PHASE`, `VIEW_PHASE_FILTER`).
- **Ordre.** Les vues 3D d'abord, comme avant (`{3D}`, puis par nom), puis les plans par hauteur de coupe croissante (au millimètre), par nom, par identifiant. `type` distingue deux plans de même nom (le plan d'étage et
  le plan de structure d'un même niveau).
- **Avant 2015.** Le plan, son `Viewer` (possédé par lui) et son `DBViewType` sont enregistrés avec leur propriétaire d'ElemTable, et `Digest::settle` écarte ceux d'une famille chargée comme les vues 3D : `DynamoSample_2014.rvt`
  et `DynamoSample_2023.rvt` rendent les mêmes 3 plans, `drone-hangar-building-2014.rvt` ses 7 (sur 65 plans vus de dessus enregistrés).
- **Ce qui n'est pas lu** (le viewer ne dessine que des triangles, sans traits ni motifs) : les plans de plafond (`m_planViewType` 2) ; les calques sous-jacents (`m_idUnderlayLevel`, `m_underlayOrientation`…) ; les zones de plan
  (`m_planRegionIds`, qui changent la plage de vue sur un rectangle) ; la visibilité des sous-catégories ; les styles et épaisseurs de ligne, les remplacements graphiques et les filtres de vue ; les motifs de coupe et de surface ;
  les lignes « au-delà » (ce qui est sous la profondeur de vue, vu en traits) ; les annotations (étiquettes, cotes, textes, repères, pièces et surfaces) ; le gabarit de vue (le plan en a déjà enregistré les valeurs, comme une vue 3D) ; l'échelle et
  le niveau de détail ; le haut de la plage de vue (`m_topClipElev`) ; et, pour un plan de surface, ses limites et ses remplissages. Un élément que la coupe traverse est coupé par la boîte de coupe, non dessiné avec le motif de coupe de Revit.

## 5. Identifiant des éléments

La clé d'un élément est le GlobalId IFC tel que le calcule l'exporteur IFC de Revit lui-même, que
rvt-rs sait reproduire. Conséquence pratique : un JSON de propriétés ou de planning écrit pour un
export IFC du même modèle se relie aussi au `.rvt`. Quand ce GlobalId manque, la clé est
`rvt-<ElementId>`.

Un JSON déposé avec le `.rvt` est proposé comme candidat : le viewer garde celui dont les clés
correspondent au plus grand nombre d'éléments, et préfère les métadonnées du fichier à égalité.

## 6. Versions de Revit

| Année du fichier | Lecture |
| --- | --- |
| 2012 à 2027 | Complète : formes enregistrées par Revit, couleurs de ses matériaux, paramètres, types, phases, unités. |
| Avant 2012 | Refusée : « Revit antérieur à 2012 : ce fichier a été enregistré par Revit 2011, dont les enregistrements ne se lisent pas ici… ». |
| Après 2027 | Lecture de secours : les éléments sont reconstruits par l'export IFC de rvt-rs, avec un avertissement. |
| Sans étiquette, schéma connu | Complète, aux règles de l'année du schéma (Project Vasari : schémas de Revit 2012 et 2014), avec un avertissement ; `release` reste `null`. |
| Année illisible | Expérimentale : le lecteur ne peut pas savoir ce qu'il lit. |

Chaque fichier de 2012 à 2027 passe par le même chemin, `revit/src/native/records.rs` : un portage (Apache-2.0, voir
`revit/THIRD_PARTY.md`, § 5) de l'extraction des enregistrements de rvt-rs, que rvt-rs réserve à 2023–2027 tant que leur
encadrement n'est pas mesuré pour les autres années. Les tests (`tests/native_records.rs`) vérifient qu'il rend, sur les
fichiers de 2023 et plus, exactement les enregistrements, les graphes et le bilan de rvt-rs, et sur ceux de 2012 à 2022 les
taux de décodage mesurés. Ce que Revit écrit change avec l'année, et le portage le vérifie sur les octets, groupe par
groupe, sans jamais rien deviner (une erreur dit ce qui a été essayé) :

| Année | Identifiant d'enregistrement | Taille de corps déclarée par la marque de segment |
| --- | --- | --- |
| 2012 à 2017 | 4 octets | somme des corps, plus 4 par enregistrement (la longueur répétée en fin d'enregistrement est comptée) |
| 2018 à 2023 | 4 octets | somme des corps |
| 2024 à 2027 | 8 octets | somme des corps |

Mesuré sur plus de 120 fichiers publics de 2015 à 2022 (dont 14 d'essai) et 51 de 2012 à 2014 ou de Project Vasari (3 817 groupes) : aucune exception. D'une année à l'autre, il y a aussi :

- `InstanceInfo.m_GRepId`, que le parcours des graphiques de rvt-rs exige à 0, n'existe qu'à partir de 2023 : les graphes
  d'avant sont complétés (`normalize_legacy`) ;
- les champs d'entité du stockage extensible n'ont pas de `m_specTypeId` en 2016 à 2020, que rvt-rs exige : un
  catalogue indulgent (`lenient_es_catalog`) évite de perdre les `FamilyInstance` qui portent une entité (54 fenêtres d'un
  fichier de 2019) ;
- les paramètres décimaux ont `m_unitType` jusqu'en 2020 et `m_specTypeId` ensuite (§ 4) ;
- `BasicFileInfo.version` de rvt-rs est le premier nombre de 2014 à 2030 du texte, qui tombe dans la date de version d'un
  fichier de Revit 2013 (20120221 donne « 2022 ») : l'année est lue de l'étiquette « Autodesk Revit Architecture 2013 (Build: … »
  quand elle y est (`native::release`). Sur les builds où rvt-rs ne trouve aucun nombre et refuse le flux (20110309 de
  Revit 2012, 20120828 et 20120928 de Revit 2013), l'étiquette se lit dans le flux brut, en UTF-16 aux deux alignements, et
  seulement suivie de « (Build: » (un chemin « Autodesk Revit 2020\… » ne compte pas).

### Revit 2012 à 2014

Les fichiers de Revit 2012, 2013 et 2014 ont le même conteneur, les mêmes partitions et les mêmes enregistrements que ceux de
2015 (canal 102 décodé à 99,0–99,5 %, canal 103 à 100 %, comme en 2015–2017). Quatre règles mesurées, toutes vérifiées sur les
octets, les distinguent ; chacune ne s'applique qu'aux années où elle a été mesurée, et une valeur inattendue fait échouer la
lecture en disant ce qui a été essayé :

| Ce qui change | 2012 et 2013 | 2014 | 2015 et après |
| --- | --- | --- | --- |
| Schéma (`Formats/Latest`) : compte d'entrées opaques de 4 octets après chaque classe | absent | présent | présent |
| Pointeur `m_pSource` de l'index des éléments (`Global/ElemTable`) | 2 | 2 | `0xFFFFFFFF` |
| Drapeaux de face (`GFace`) | `m_faceFlags` (classe v8) | `m_faceFlags_v9` | `m_faceFlags_v9` |
| Définitions des familles chargées | parmi les éléments du projet | parmi les éléments du projet | sections à part, sautées |

- **Schéma** (`native/schema.rs`, portage de `schema_registry::parse` de rvt-rs) : rvt-rs d'abord ; s'il refuse un fichier
  de 2012 ou 2013, le schéma est relu sans le compte, et n'est accepté que s'il est consommé exactement, classes numérotées
  à la suite, jusqu'au terminateur de 8 octets nuls (3 154 classes en 2012, 3 519 en 2013, 3 619 en 2014). Chaque année
  n'écrit qu'un seul schéma, octet pour octet, quel que soit le build : son empreinte sha256 date aussi un fichier sans
  étiquette (Project Vasari).
- **Index des éléments** (`native/elemtable.rs`) : mêmes champs et mêmes lignes de 28 octets qu'en 2015 ; seul le jeton du
  pointeur `m_pSource` vaut 2 (dans les 51 fichiers), là où rvt-rs exige `0xFFFFFFFF`. Toute autre valeur échoue en la nommant.
- **Drapeaux de face** (`normalize_legacy`) : en 2012 et 2013 le champ s'appelle `m_faceFlags` ; sa valeur est recopiée dans
  `m_faceFlags_v9` seulement si elle vaut 4 ou 6, les deux seules mesurées (le bit 2 retourne la face, comme ensuite). Le sens
  est établi par la fermeture des corps (un corps aux faces bien orientées a une aire vectorielle nulle) et par la même famille
  enregistrée en 2013 et en 2014, identique au bit près sur 11 éléments sur 12 (le douzième a été modifié entre-temps).
- **Définitions des familles chargées** : avant 2015, les éléments qui définissent une famille chargée dans le projet
  (extrusions, balayages, familles imbriquées, vues et phases de la famille…) sont écrits parmi ceux du projet, avec pour
  propriétaire (ElemTable) l'élément `Family`, directement ou par quelques intermédiaires (une vue, sa caméra, sa boîte de
  coupe). Dessinés, ils s'empilent à l'origine du projet. Un élément ou un enregistrement dont la chaîne des propriétaires
  (16 maillons au plus, 3 mesurés) mène à une `Family` qui n'est ni sur place (`m_inPlace`) ni celle du document
  (`ADocument.m_ownerFamilyId`, la famille d'un `.rfa`) n'est ni dessiné, ni décrit, ni compté dans les vues et les phases
  (raison « définition d'une famille chargée », `native/families.rs`). Si un maillon ne se lit pas, ou si la famille du
  document n'est pas une `Family` qui existe, rien n'est écarté et un avertissement compte les éléments concernés. Vérifié par huit fichiers d'essai de DynamoRevit d'avant 2015 et leur
  réenregistrement dans Revit 2016, qui range ces définitions à part : mêmes éléments, mêmes triangles des deux côtés ; et
  par `DynamoSample_2014.rvt` et `DynamoSample_2023.rvt`, le même modèle : les 257 mêmes éléments (114 définitions écartées).
  Sur les fichiers de 2015 et après, la règle ne s'applique pas et n'écarterait rien de ce qui est dessiné. Ce que possède une famille *sur place* est dans le
  modèle, à toute année : ses formes sont dessinées par l'instance de la famille, non à leur place d'origine (§ 3, « Familles sur place »).

L'export IFC de rvt-rs rend un projet vide sur tous les fichiers d'avant 2015 essayés : la lecture native est la seule.

Couverture mesurée sur les fichiers d'essai de 2012 à 2014 (éléments dessinés, après l'exclusion des définitions) :

| Fichier | Année | Éléments | Forme Revit | Partielle | Triangles |
| --- | --- | --- | --- | --- | --- |
| void-cutter-2012.rfa | 2012 | 2 | 2 | 0 | 24 |
| AdaptiveComponent-Revit2013.rfa | 2013 | 5 | 5 | 0 | 23 334 |
| dynamo-nyc-site-2013.rvt | 2013 | 1 | 0 | 1 | 56 916 |
| dynamo-tower-6-ds-2013.rfa | 2013 | 6 | 6 | 0 | 5 156 |
| DynamoSample_2014.rvt | 2014 | 257 | 257 | 0 | 57 845 |
| drone-hangar-building-2014.rvt | 2014 | 265 | 265 | 0 | 57 460 |
| clockwork-wall-stuff-2014.rvt | 2014 | 64 | 63 | 1 | 7 040 |
| clockwork-roof-floor-stuff-2014.rvt | 2014 | 8 | 7 | 1 | 85 432 |

Les trois formes partielles viennent de trous du mailleur qui existent à toutes les années : une face `Plane` au contour non raccordé (site de
2013 ; ses instances à échelle uniforme se placent depuis, § 3), une face `OffsetSurf` (toit) et des faces `SharedSurface` (système de murs-rideaux). Plusieurs projets d'essai de
Dynamo sont des gabarits vides dont seules les familles sont chargées : ils ne dessinent rien, comme leur réenregistrement de
2016. Restent non lus : Revit 2011 et avant (aucun fichier public sous licence libre ; une famille de 2007 montre une autre
disposition des partitions : elle est refusée par la date de son build, « Revit antérieur à 2012 : ce fichier a été enregistré
par une version de Revit compilée en 2007 (build 20070829)… »), et les modèles partagés d'avant 2015 (aucun fichier d'essai).

Si la lecture native échoue (un groupe dont l'encadrement ne convient à aucune règle, par exemple), les éléments sont
reconstruits par l'export IFC de rvt-rs et leurs propriétés viennent de la reconstruction IFC, avec un avertissement qui
nomme l'échec, et `report.experimental` est vrai. Une copie locale d'un modèle partagé (workshared, fichier local ou cache
de BIM 360), que rvt-rs refuse dès le préambule (« global/local increment routing tables differ »), ne passe plus par là :
voir « Modèles partagés » ci-dessous.

Le préambule (schéma, index des éléments, incréments, catalogue du stockage extensible) est lu une fois par fichier et gardé
(`native::preamble`, par empreinte des cinq flux qui le déterminent) ; la lecture le libère à sa fin, résultat ou erreur
(`clear_preamble_cache`).

Couverture mesurée (éléments dessinés, `report.sources`) :

| Fichier | Année | Éléments | Forme Revit | Partielle | Reconstruite | Inconnue (boîte) | Triangles |
| --- | --- | --- | --- | --- | --- | --- | --- |
| singleDirectShape | 2015 | 1 | 1 | 0 | 0 | 0 | 2 168 |
| Vignette-04-BaseFile | 2016 | 953 | 953 | 0 | 0 | 0 | 2 747 486 |
| SampleModel | 2017 | 472 | 472 | 0 | 0 | 0 | 1 048 445 |
| RiR-Template-2018 (modèle de projet) | 2018 | 0 | 0 | 0 | 0 | 0 | 0 |
| rac_advanced_sample_project | 2019 | 5 571 | 5 571 | 0 | 0 | 0 | 2 084 775 |
| mega_advanced_sample_file | 2020 | 5 523 | 5 523 | 0 | 0 | 0 | 1 637 159 |
| ConnectorTestR20 | 2020 | 3 | 3 | 0 | 0 | 0 | 6 808 |
| RoomsAndExits | 2021 | 12 | 12 | 0 | 0 | 0 | 464 |
| revit-curtainwall-byprofile_v21 | 2021 | 123 | 123 | 0 | 0 | 0 | 280 838 |
| CeilingType | 2022 | 1 | 1 | 0 | 0 | 0 | 12 |
| revit-openings_v22 | 2022 | 15 | 15 | 0 | 0 | 0 | 6 520 |

Avant, ces fichiers n'avaient que la reconstruction IFC de rvt-rs : `SampleModel` 56 corps reconstruits et 397 boîtes
(6 564 triangles), `Vignette-04` 953 boîtes, `rac_advanced` 182 reconstruits et 5 381 boîtes. Ensuite, la lecture par les graphiques
laissait 1 001 boîtes et 82 formes partielles : les 880 coussins ETFE de Vignette-04 et 60 chaises de chacun de `rac_advanced` et
`mega_advanced` (instances à cibles interdites), 54 + 4 + 2 éléments à surfaces d'Hermite (plus une boîte dans `ShellFamily.rfa`), les
8 murs de parapet (symbole résolu dans la vue) et 3 éléments à poignées `GGTag` par fichier. Plus aucun fichier d'essai n'a de boîte ni de forme partielle (§ 3). `SampleModel.rvt` (2017) et
`DynamoSample_2023.rvt` sont le même modèle : sur leurs 234 éléments communs, la source de la forme et les libellés sont
identiques (234), les couleurs aussi (234), les triangles pour 219 et les boîtes à 1 cm pour 186 (les autres sont des
modifications du modèle : un mur de 9,2 m devenu 6 m, des jonctions), les fiches pour 226 (`tests/legacy.rs`).

### Modèles partagés (copies locales, BIM 360)

Un modèle partagé (worksharing) a un fichier **central** et, pour chaque utilisateur, une **copie locale** : un fichier
enregistré par Revit en mode « Local » (`BasicFileInfo`, « Worksharing: Local »), sur le disque de l'utilisateur ou, pour un
modèle de BIM 360 / Autodesk Docs, dans le cache de collaboration de Revit. Ces fichiers contiennent les mêmes
enregistrements qu'un projet ordinaire ; seul diffère le flux `Global/DocumentIncrementTable`, qui dit dans quelle
partition (`Partitions/N`) est l'enregistrement courant de chaque élément. (Ne pas confondre : les partitions de stockage,
`Partitions/N`, n'ont rien à voir avec les sous-projets, « worksets », que `Global/PartitionTable` et `m_partitionId` d'un
élément désignent.)

Ce flux porte deux tables, `m_increments` et `m_localIncrements`. rvt-rs exige qu'elles soient égales, ce qui est vrai d'un
fichier non partagé et d'un central. Dans une copie locale :

- `m_increments` est l'historique des incréments du **central** à la dernière synchronisation de la copie ;
- `m_localIncrements` décrit les incréments **écrits dans ce fichier**, donc les partitions qu'il contient.

Mesuré sur trois fichiers de Revit 2020 de DynamoRevit (`Project1`, Apache-2.0) :

| Fichier | `m_increments` | `m_localIncrements` | Partitions |
| --- | --- | --- | --- |
| `Project1-Central.rvt` | 3 lignes (épisodes 583, 584, 584) | les mêmes | 0, 1, 2 |
| `Project1-LocalFile.rvt` (copie locale) | celles du central | 1 ligne (épisode 584, 43 008 éléments) | 0 |
| `Project1-BIM360-Local.rvt` (cache de BIM 360) | 2 lignes : le central du nuage a fusionné l'incrément 0 dans le 1 | 1 ligne | 0 |

Router la copie locale par la table globale envoie 6 537 de ses 6 664 éléments vers `Partitions/1`, qu'elle n'a pas ; la table
locale les envoie tous vers `Partitions/0`, où chacun a son seul enregistrement. **La table locale fait donc foi pour lire le
fichier tel qu'il a été enregistré** : elle seule décrit ses partitions.

`revit/src/native/increments.rs` (`storage_increments`) appelle d'abord la fonction de rvt-rs. Si elle lit, c'est son
résultat qui sert (`Routing::Shared`, `Preamble::routing`) : un central ou un fichier non partagé est lu exactement comme
avant. Si elle refuse, le module décode la table avec le décodeur public de rvt-rs et retient la table locale
(`Routing::Local`) à ces conditions seulement : les deux tables diffèrent, la locale n'est pas vide, ses lignes passent les
contrôles de rvt-rs (reportés de sa fonction privée `decode_increment_rows`), et la permutation d'épisodes est vide (rvt-rs
ne l'interprète que pour un seul incrément partagé). Dans tout autre cas, c'est le refus d'origine de rvt-rs qui est rendu,
et le lecteur retombe sur l'export IFC avec son avertissement : rien n'est deviné. Le reste de l'extraction (routage des
épisodes, repli sur la dernière partition qui détient un enregistrement) est le même pour tous les fichiers.

**« Tel que cet utilisateur l'a enregistré ».** La copie locale est l'état du modèle au dernier enregistrement local de son
utilisateur : ses propres modifications enregistrées et ce que ses synchronisations avec le central y ont apporté. Les
modifications que d'autres utilisateurs ont synchronisées depuis n'y figurent pas, et le central peut avoir changé. Le
rapport l'écrit en tête de ses avertissements : « Copie locale d'un modèle partagé : le modèle est lu tel que cet utilisateur
l'a enregistré (les synchronisations ultérieures des autres utilisateurs n'y figurent pas). » Pour le modèle à jour, ouvrir le
central, ou resynchroniser la copie dans Revit puis l'enregistrer. Le propriétaire des éléments et leur emprunt (borrowing)
ne sont pas décrits.

Vérifié sur les trois fichiers (`cargo test --release --test workshared`) :

- les enregistrements des canaux 102 et 103 de la copie locale sont, élément par élément, ceux du central (6 664 sur 6 664,
  graphes égaux), sans copie historique : le central en garde 6 537 en plus ;
- la copie de BIM 360 est un autre document (l'envoi au nuage est un « enregistrer sous ») : elle diffère du central par 104
  enregistrements du canal 102 (les `FamilySurrogate` et le `GeoSite`), aucun du canal 103 ;
- `read()` rend, pour les deux copies, les mêmes clés, noms, tableaux et métadonnées que pour le central, la même lecture
  native de bout en bout (aucune forme reconstruite, pas d'export IFC, pas de lecture expérimentale) et les mêmes
  avertissements, plus la note de copie locale ;
- le central de Rhino.Inside.Revit (`revit-docs_v20_project_ws.rvt`, MIT) et tous les autres fichiers de `revit/samples`
  gardent la table de rvt-rs, ligne pour ligne (`Routing::Shared`) ; le fichier d'essai versionné aussi, sans téléchargement.

Durée de `read` (Apple M4 Pro, secondes, la meilleure de trois) : en natif, central 0,31, copie locale 0,29, copie de BIM 360
0,28 (le central de Rhino.Inside, 4 éléments dessinés : 0,08) ; en WebAssembly (Node 24, module livré), 0,40, 0,38 et 0,38.
Lire un central ne coûte rien de plus : la fonction de rvt-rs lit d'abord et rend seule son résultat.

Ce qui n'est pas vérifié, faute de fichier d'essai (si rvt-rs refuse et que la table locale ne convient pas, le refus d'origine
est rendu : repli sur l'export IFC, avec avertissement) :

- une copie locale dont l'utilisateur a enregistré des modifications **non synchronisées** : la table locale aurait alors
  plusieurs lignes, avec des épisodes au-delà du dernier du central, et davantage de partitions ;
- une copie enregistrée par Revit 2023 ou plus (identifiants de 8 octets à partir de 2024), un modèle de nuage à un seul
  utilisateur, un fichier « détaché » ;
- un modèle partagé qui contient de la géométrie : les trois fichiers d'essai sont des gabarits (6 664 éléments dont une seule
  instance de famille, trois niveaux, et les deux enregistrements de la catégorie Masse que contient tout gabarit, sans
  forme). Ils ne dessinent rien, comme le
  central : la comparaison porte sur les 6 664 enregistrements entiers et sur la sortie de `read()`, pas sur des formes.

L'export IFC de rvt-rs, `native_saved_scene` et `native_element_parameters` lisent les incréments par leur propre
préambule privé, qui ne connaît que la table commune : sur une copie locale ils refusent ou dégradent sans le dire (l'export
IFC des deux copies d'essai rend 0 niveau, le central 2). Notre lecteur ne les emprunte pas quand la lecture native
réussit, c'est pourquoi la copie locale ne retombe plus sur eux ; ils ne servent que de repli.

## 7. Vitesse, mémoire, taille, erreurs

### Vitesse

Décoder un graphe d'objets de rvt-rs (une fiche d'élément, un graphique) coûte à peu près 8 µs par
objet et fait l'essentiel de la lecture : 2,1 s des 4,3 s de `2024_Core_Interior.rvt` (34 Mo,
26 425 enregistrements d'éléments) quand on les décodait tous, puis encore une fois, pour les
propriétés. Le lecteur évite donc tout décodage inutile :

- **Rien n'est décodé deux fois.** La géométrie décode les enregistrements d'éléments (canal 102)
  pour savoir quoi dessiner et y lit au passage les définitions de paramètres ; elle projette tout de
  suite pour les fiches (`properties::Retained`) ce qui servira aux propriétés (éléments qui peuvent se
  dessiner, types, familles, niveaux, phases, matériaux, emplacement du site), sans garder les
  graphes. Les propriétés ne relisent le fichier que pour ce qui manque, par exemple l'élément
  qu'un paramètre désigne et que rien n'a décodé.
- **Un premier balayage lit sans décoder.** La classe de chaque enregistrement est dans sa balise, le
  propriétaire dans l'index des éléments : 50 ms. On ne décode alors ni les classes que la règle de
  dessin écarte (courbes, pièces, esquisses, vues…), ni ce qui appartient à un élément qui n'est pas
  placé (11 622 des 12 221 instances de famille de Core Interior sont des panneaux de murs-rideaux
  de définitions de groupe). Core Interior : 5 470 enregistrements décodés sur 26 425. Les
  graphiques (canal 103) ne se décodent que pour les éléments dessinés et pour les seuls symboles
  de famille qu'ils placent (22 sur 555 pour Core Interior).
- **Inflation plus rapide.** rvt-rs inflate toutes les partitions du fichier (188 Mo pour Core
  Interior) avec flate2 ; la caisse `revit` lui demande son moteur zlib-rs (Rust pur) au lieu de
  miniz_oxide : 0,53 s deviennent 0,30 s en natif.

Les raccourcis ne changent rien au résultat : `Options::exhaustive` (essai `revit/tests/shortcuts.rs`)
lit tout sans raccourci, et les deux lectures rendent les mêmes éléments, les mêmes tableaux et les
mêmes métadonnées sur les fichiers d'essai.

Mesuré sur un Apple M4 Pro, durée de `readRevit` (secondes, la meilleure de plusieurs lectures) :

| Fichier | natif avant | natif après | WebAssembly avant | WebAssembly après |
| --- | --- | --- | --- | --- |
| 2024_Core_Interior (34 Mo) | 4,34 | 2,24 | 8,18 | 4,10 |
| DynamoSample_2024 (6,8 Mo) | 1,00 | 0,64 | 1,94 | 1,20 |
| RE1-Architecture (6,6 Mo) | 0,77 | 0,48 | 1,49 | 0,90 |
| RefineryPrimer-2026 (19 Mo) | 1,42 | 0,78 | 2,75 | 1,43 |

WebAssembly : Node 24, module livré, SIMD 128 bits ; le natif maille sur tous les cœurs, le
WebAssembly sur un seul. `report.stages` donne le détail de chaque lecture ; pour Core Interior,
en natif puis en WebAssembly :

| Étape | natif | WebAssembly |
| --- | --- | --- |
| balayage des classes, inflation des partitions | 0,33 | 0,51 |
| enregistrements d'éléments (décodage, matériaux, propriétés) | 1,23 | 2,15 |
| symboles de famille placés | 0,06 | 0,16 |
| graphiques des éléments et maillage | 0,60 | 1,23 |
| assemblage, JSON des propriétés | < 0,01 | 0,01 |

Ce qui reste lent : le décodage des enregistrements d'éléments, un seul fil en WebAssembly (849 murs
non placés de Core Interior ne se reconnaissent qu'une fois décodés). L'export IFC de rvt-rs, que
déclenchaient des formes enregistrées illisibles (2,5 s en WebAssembly sur `RE1-Electrical.rvt`), n'est plus
calculé pour un fichier de 2023 ou plus : plus aucune forme n'y est illisible, et il n'en redessinait aucune.
Le levier suivant est de répartir les partitions du fichier entre plusieurs workers.

Revit 2015 à 2022 : avant la phase « natif de bout en bout », ces fichiers passaient par l'export IFC de rvt-rs et n'avaient
presque que des boîtes ; ils se lisent maintenant par leurs formes enregistrées, ce qui est plus long parce qu'il y a plus à
mailler. Durée de `readRevit` en WebAssembly (Node 24, une lecture, secondes), éléments, triangles et sources des formes
(forme Revit, partielle, reconstruite, inconnue) :

| Fichier (année) | avant : s, triangles, sources | après : s, triangles, sources |
| --- | --- | --- |
| singleDirectShape (2015, 5,5 Mo) | 0,86 ; 12 ; 1 inconnue | 0,55 ; 2 168 ; 1 Revit |
| CeilingType (2022, 5,4 Mo) | 0,93 ; 12 ; 1 inconnue | 0,46 ; 12 ; 1 Revit |
| ConnectorTestR20 (2020, 9,5 Mo) | 1,53 ; 36 ; 3 inconnues | 0,70 ; 6 808 ; 3 Revit |
| RoomsAndExits (2021, 5,4 Mo) | 0,70 ; 144 ; 8 reconstruites, 4 inconnues | 0,49 ; 464 ; 12 Revit |
| revit-curtainwall-byprofile_v21 (10 Mo) | 1,28 ; 1 476 ; 1 reconstruite, 122 inconnues | 0,77 ; 85 670 ; 121 Revit, 2 partielles |
| SampleModel (2017, 16,6 Mo) | 1,61 ; 6 564 ; 56 reconstruites, 397 inconnues | 4,13 ; 1 046 949 ; 471 Revit, 4 partielles |
| Vignette-04-BaseFile (2016, 21,5 Mo) | 1,51 ; 11 436 ; 953 inconnues | 7,48 ; 2 228 860 ; 19 Revit, 54 partielles, 880 inconnues |
| mega_advanced (2020, 16,8 Mo) | 1,59 ; 72 216 ; 182 reconstruites, 5 384 inconnues | 9,95 ; 1 264 343 ; 5 455 Revit, 11 partielles, 60 inconnues |
| rac_advanced (2019, 15,9 Mo) | 2,24 ; 72 180 ; 182 reconstruites, 5 381 inconnues | 11,42 ; 1 711 959 ; 5 503 Revit, 11 partielles, 60 inconnues |

Les lignes de Vignette-04, SampleModel, mega_advanced, rac_advanced et curtainwall datent de cette étape : leurs boîtes et leurs formes
partielles ont disparu depuis (tableau suivant).

Les fichiers de 2023 et plus passent par le même chemin d'enregistrements et leur durée est celle du tableau précédent (sur cette série :
DynamoSample_2023 0,78 s, Core Interior 2,85 s). Les durées de cette série et celles du tableau précédent viennent de séries de
mesures différentes, sur une machine qui n'était pas au repos : comparer les ordres de grandeur, non les décimales.

Coût des dernières formes (composants adaptatifs, instances à cibles interdites, groupes étiquetés, surfaces d'Hermite ; § 3) : durée de
`readRevit`, la meilleure de cinq lectures entrelacées, avant et après le même module compilé (SIMD 128 bits) avec et sans ces règles
(Node 24, Apple M4 Pro, machine partagée : comparer les ordres de grandeur) ; natif sur tous les cœurs, WebAssembly sur un seul.

| Fichier | natif avant → après (s) | WebAssembly avant → après (s) | Mémoire WebAssembly (Mo) | Triangles | Sources (Revit, partielle, boîte) |
| --- | --- | --- | --- | --- | --- |
| Vignette-04 (2016) | 1,67 → 1,72 | 7,17 → 7,89 | 969 → 991 | 2 228 860 → 2 747 486 | 19, 54, 880 → 953, 0, 0 |
| mega_advanced (2020) | 2,06 → 2,01 | 9,89 → 10,16 | 1 045 → 1 063 | 1 264 343 → 1 639 943 | 5 455, 11, 60 → 5 526, 0, 0 |
| rac_advanced (2019) | 1,95 → 1,94 | 10,96 → 11,53 | 1 079 → 1 097 | 1 711 959 → 2 087 559 | 5 503, 11, 60 → 5 574, 0, 0 |
| 2024_Core_Interior | 1,50 → 1,49 | 2,85 → 2,83 | 582 → 582 | 34 504 | 856, 0, 0 (inchangé) |
| SampleModel (2017) | 1,02 → 1,03 | 4,19 → 4,17 | 701 → 701 | 1 046 949 → 1 048 501 | 471, 4, 0 → 475, 0, 0 |
| revit-curtainwall-byprofile_v21 | 0,42 → 0,52 | 0,77 → 1,07 | 154 → 185 | 85 670 → 280 838 | 121, 2, 0 → 123, 0, 0 |

Les 520 000 triangles de plus de Vignette-04 (880 coussins, 54 panneaux d'Hermite) coûtent 0,7 s à WebAssembly ; ses 2,75 millions de triangles
restent sous le budget (3 millions) et ses 59 % du garde-fou de maillage (2,93 millions sur 5). Le plus dense des éléments est une sculpture de
mur-rideau, 128 000 triangles (plafond : 250 000). Les fichiers qui n'ont aucune de ces formes (Core Interior, SampleModel hors ses quatre bols) ne
changent ni de durée ni de mémoire.

Depuis, le fichier reste hors du module, les symboles sont parcourus une fois, les enregistrements ne sont inflatés qu'à la
demande, la sortie part par morceaux pendant le maillage et les faces courbes sont maillées au millimètre (§ 3, « Mémoire et
taille » ci-dessous). Durée de `readRevitFile` dans une instance neuve (Node 24, SIMD, un seul fil, machine au repos,
médiane de trois lectures) et de `read` en natif (tous les cœurs) :

| Fichier | WebAssembly avant → après (s) | natif (s) | Mémoire WebAssembly avant → après (Mo) | Triangles avant → après |
| --- | --- | --- | --- | --- |
| Vignette-04 (2016) | 15,1 → 5,65 → 3,60 | 2,3 | 1 040 → 350 → 295 | 2 747 486 → 988 664 |
| mega_advanced (2020) | 14,9 → 3,65 → 3,33 | 2,4 | 1 113 → 233 → 187 | 1 639 943 → 1 294 979 |
| rac_advanced (2019) | 16,9 → 3,81 → 3,47 | 2,5 | 1 149 → 266 → 191 | 2 087 559 → 1 655 639 |
| SampleModel (2017) | 7,9 → 1,92 → 1,81 | 1,2 | 735 → 168 → 153 | 1 048 501 → 928 957 |
| 2024_Core_Interior | 3,0 → 1,88 → 1,85 | 1,3 | 610 → 133 → 94 | 34 504 |
| RefineryPrimer-2026 | 0,75 → 0,75 | 0,5 | 322 → 89 → 90 | 7 378 |
| RE1-Electrical (2025) | 0,77 → 0,77 | 0,5 | 234 → 99 → 101 | 15 009 → 14 153 |
| DynamoSample_2023 | 0,65 → 0,63 | 0,5 | 149 → 89 → 63 | 60 015 → 57 883 |

(Trois colonnes de durée : le module livré avant ces travaux, après la première série — fichier dehors, symboles parcourus une
fois, inflation à la demande, sortie par morceaux assemblée à la fin —, après la seconde — morceaux pendant le maillage, flèche
d'un millimètre, lots bornés.) Dans le navigateur, le modèle apparaît dès le premier morceau : rac_advanced se montre en 7
morceaux pendant ses 3,5 s. Les durées du navigateur ne valent que pour un onglet au premier plan : un onglet caché ou une
fenêtre recouverte passe en priorité basse (sur un Mac à puce Apple, sur les cœurs économes) et la même lecture y prend
3 à 4 fois plus (Vignette-04 : 3,3 s au premier plan, 12 à 14 s en arrière-plan) ; mesurer au premier plan, ou en Node.

### Mémoire et taille

Le lecteur ne garde en mémoire ni le fichier ni le modèle. Le fichier reste dans le `File` du navigateur : le module
en demande des fenêtres de 1 Mio (`readRevitFile`, § 1), les partitions se lisent par tranches à la demande d'un index
des groupes d'enregistrements (un groupe inflaté à la fois, 32 Mo de cache). Le modèle part par morceaux de 250 000
triangles pendant le maillage : chaque forme achevée rejoint le morceau en cours, qui est transféré au fil principal et
oublié. Chaque symbole de famille est parcouru une fois, sa forme et ses nœuds maillés gardés, son graphe libéré ; les
graphes décodés de rvt-rs (de 61 à 142 fois les octets d'un enregistrement) ne vivent que le temps d'un lot, borné en
octets (128 Kio d'enregistrements sur un seul fil ; les files d'attente des définitions et des symboles, 1 et 2 Mio) ;
un enregistrement de plus de 8 000 000 octets (`native::records::MAX_RECORD_BYTES`) n'est pas décodé, et un graphique (canal 103) l'est jusqu'à 3 millions de valeurs (§ 3) ; une instance dont le symbole
n'est pas encore lu n'attend plus avec son graphe, son placement est rejoué après la lecture des symboles, par tranches
de 128 éléments.

Mémoire linéaire de l'instance WebAssembly, mesurée après la lecture (une instance neuve par fichier, Node 24, le fichier
lu par tranches, les morceaux jetés comme le worker les transfère), sur les 30 fichiers publics lisibles de
`revit/samples` ; pic natif (`examples/peak.rs`, allocateur compteur, un fil) ; triangles à la flèche de 1 mm (§ 3).

| Fichier | Mo | Mémoire (Mo) | × le fichier | avant cette lecture | Triangles | Morceaux |
| --- | --- | --- | --- | --- | --- | --- |
| RiR-Template-2018.rte, revit-docs_v20, MassWithBoxAndCone.rfa, revit-openings_v22, FamilyDocumentTests.rfa, ShellFamily.rfa, Revit_IFC5_Einhoven, AdaptivePanel.rfa | 0,5 à 1,0 | 18 à 30 | 24 à 57 (l'encombrement fixe : module, préambule) | 17 à 36 | 0 à 25 546 | 0 ou 1 |
| CeilingType, RoomsAndExits, singleDirectShape, Project1 (× 3) | 5,4 à 7,2 | 76 à 90 | 12 à 16 | 75 à 89 | 0 à 2 168 | 0 ou 1 |
| DynamoSample_2023 / 2024 / 2025 | 6,5 à 6,8 | 62 à 68 | 9 à 10 | 89 à 93 | 57 883 | 1 |
| RE1-Architecture, ConnectorTestR20, DuctSegmentFlow, RE1-Electrical | 6,6 à 13,4 | 61 à 101 | 7,5 à 9,3 | 59 à 99 | 88 à 22 729 | 1 |
| revit-curtainwall-byprofile_v21 | 10,0 | 136 | 13,6 | 128 | 287 354 | 2 |
| RefineryPrimer-2023 / 2024 / 2026 | 18,0 à 19,3 | 90 à 94 | 4,7 à 5,2 | 87 à 93 | 7 378 | 1 |
| SampleModel (2017, 475 éléments) | 16,6 | 153 | 9,2 | 168 (701 avant la série précédente) | 928 957 | 4 |
| mega_advanced (2020, 5 526 éléments) | 16,8 | 187 | 11,1 | 233 (1 063) | 1 294 979 | 6 |
| rac_advanced (2019, 5 574 éléments) | 15,9 | 191 | 12,0 | 266 (1 097) | 1 655 639 | 7 |
| Vignette-04 (2016, 953 éléments) | 21,5 | 295 | 13,8 | 350 (991) | 988 664 | 4 |
| 2024_Core_Interior (856 éléments) | 33,7 | 94 | 2,8 | 133 (582) | 34 504 | 1 |

Le rapport à la taille du fichier n'a plus de sens : le plus gros fichier (Core Interior, 34 Mo) est le moins cher au Mo. Ce
qui pèse, par étape (`examples/peak.rs --etapes`) :

- le préambule (schéma, index de tous les éléments, incréments) et le recensement des enregistrements : de 150 à 250
  octets par élément indexé, 5 à 13 Mo sur les fichiers d'essai, 90 à 110 Mo après les enregistrements de Core Interior
  (26 425 enregistrements, 5 476 décodés) ;
- les nœuds maillés des symboles de famille, gardés jusqu'à la fin (f64) : 70 Mo sur rac_advanced et mega_advanced ;
- le plus gros graphe rvt-rs du fichier : un symbole de 224 Mo dans Vignette-04, qui fait à lui seul le pic du fichier
  (394 Mo en natif à l'étape des symboles, 143 Mo à la fin de l'étape) ;
- le lot en cours (128 Kio d'enregistrements, décodés) et le morceau en cours (7 à 10 Mo) : des dizaines de Mo.

Les plans d'étage (§ 4 bis) ne coûtent ni passe ni mémoire mesurable. Les `DBViewPlan` et les `Viewer` sont décodés dans la passe des enregistrements d'éléments
qui existait déjà, avec les autres classes d'appui : 4 323 enregistrements de plus sur les 56 fichiers d'essai (395 824 → 400 147, 1,1 %), 37 pour `2024_Core_Interior`,
557 pour `drone-hangar-building-2014.rvt` (106 plans et 451 `Viewer`). Les `DBViewType` l'étaient déjà (une classe dont le nom finit par « Type » est une définition), mais leur
graphe attendait la fin des définitions pour être projeté en fiche : 1 734 pour le hangar, qui n'attendent plus (les fiches n'en ont pas besoin). `examples/dump` (`/usr/bin/time -l`,
médiane de 5 lectures, un fichier par processus) avant et après : `2024_Core_Interior` 1,25 s et 284 Mo → 1,25 s et 285 Mo ; `drone-hangar-building-2014` 1,14 s et 283 Mo → 1,16 s et
275 Mo ; `wadduwa` 3,17 s et 975 Mo → 3,16 s et 977 Mo. Le pic de l'allocateur compteur (`examples/peak.rs`) ne bouge pas non plus (199 → 199 Mo, 203 → 203 Mo pour les deux premiers).

Deux limites restent, dites en « mémoire insuffisante », que le viewer traduit comme tout manque de mémoire (`isMemoryFailure`,
`src/revit/readRevit.ts`) : plus de 4 millions d'éléments indexés (`MAX_INDEXED_ELEMENTS`, `revit/src/lib.rs` : le préambule
seul atteindrait le gigaoctet, au-delà de ce qui a été essayé), et plus de 150 Mo quand il faut reconstruire les formes par
l'export IFC de rvt-rs (`MAX_EXPORT_BYTES` : lecture native échouée, ou année postérieure à 2027 ; l'export lit le fichier entier
en mémoire et le décode tout entier, 17 à 23 fois sa taille). Il n'y a plus de limite de taille de fichier
(`MAX_REVIT_BYTES`, 140 Mo, et `MAX_LEGACY_BYTES`, 45 Mo, ont disparu) : rien dans le lecteur ne grandit plus avec elle.

Le modèle, lui, est borné par le budget de triangles (§ 3), réglé au fil principal d'après la mémoire de l'appareil
(`triangleBudgetFor` : 2,5 millions de triangles par Go de `navigator.deviceMemory`, entre 2 et 20 millions, 10 millions
quand le navigateur ne dit rien). Ce que coûte un triangle au fil principal, mesuré sur une maquette de 759 Mo et 12,4
millions de triangles : ≈ 56 octets de tas JavaScript (les tableaux du modèle, copiés une fois à la cuisson) et ≈ 27
octets de mémoire graphique, ≈ 100 octets avec three.js ; un quart de la mémoire de l'appareil va donc au modèle. Projection
pour cette maquette (759 Mo, 14 896 éléments, 12,4 millions de triangles, qu'aucun fichier d'essai n'approche) : le module
tiendrait en 0,5 à 0,8 Go (préambule et index ≈ 100 Mo, nœuds de symboles et transitoires bornés, le plus gros graphe
d'un enregistrement ≤ 300 Mo), la lecture durerait 35 à 50 s sur un seul worker (index ≈ 15 ms par Mo, maillage ≈ 2 µs par
triangle), et le modèle 1,2 Go au fil principal : lisible entière à partir de 8 Go de mémoire, par ses boîtes au-delà du
budget sinon. Si la mémoire manque malgré tout, la lecture échoue avec le message « … trop volumineux pour être lu dans
le navigateur : la mémoire disponible ne suffit pas. Réessayez sur un appareil qui a plus de mémoire, enregistrez un
modèle plus léger (un seul bâtiment ou un seul lot, sans liens), ou exportez-le en IFC depuis Revit … ».

### Erreurs

Un fichier d'avant Revit 2012 donne « Impossible de lire « nom » : Revit antérieur à 2012 : ce fichier a été enregistré par Revit
2011, dont les enregistrements ne se lisent pas ici (la lecture commence à Revit 2012). Ouvrez-le dans Revit 2012 ou plus récent
et enregistrez-le de nouveau. ». Un fichier qui n'est pas du Revit, ou qui est tronqué, donne « Impossible de lire « nom » : » suivi
du texte du lecteur, par exemple « le fichier n'est pas un fichier Revit lisible ». Un fichier qui a
disparu entre son choix et sa lecture est signalé à part.

## 8. Licences

- **rvt-rs** (Apache-2.0, Griffin Long) : dépendance Cargo épinglée sur le commit
  `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`, avec la fonction `unstable-research`, utilisée sans
  modification. Son NOTICE est repris dans le fichier `NOTICE` à la racine.
- **Rhino.Inside.Revit** (MIT, McNeel) : source des noms de paramètres et de catégories. Seules des
  données sont reprises, avec l'attribution dans `NOTICE` et `revit/THIRD_PARTY.md`.
- **Bibliothèques Rust** compilées dans le module : MIT, Apache-2.0, BSD-3-Clause, Zlib. Textes
  complets dans `revit/THIRD_PARTY.md`.
- **Fichiers d'essai** : `Revit_IFC5_Einhoven.rvt` (MIT, magnetar-io/revit-test-datasets) est
  versionné deux fois, dans `revit/tests/fixtures/` et sous le nom `public/samples/revit-demo.rvt`,
  chacun avec sa note de licence. Les autres échantillons sont téléchargés à la demande ; chacun
  porte sa licence dans `revit/samples.json` (MIT ou Apache-2.0).

« Autodesk » et « Revit » sont des marques déposées d'Autodesk, Inc. Ce projet n'est ni affilié à
Autodesk, ni approuvé ou parrainé par elle.

## 9. Reconstruire et tester

Pour lancer, tester ou construire le viewer, aucun outil Rust n'est nécessaire : le module compilé est
dans le dépôt.

```bash
npm test                     # dont tests/revitReader.test.ts, tests/revitRead.test.ts, tests/buildModelRaw.test.ts
npm run build                # le module apparaît dans dist/assets/revit_bg-*.wasm
```

Pour modifier `revit/`, il faut Rust :

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --locked --version <version de revit/Cargo.lock>
npm run build:revit          # compile (SIMD 128 bits), génère la glue dans src/revit/pkg/
cargo test --release --manifest-path revit/Cargo.toml
cargo run --release --manifest-path revit/Cargo.toml --example measure -- fichier.rvt
```

`scripts/build-revit.mjs` refuse de continuer si le `wasm-bindgen` installé n'a pas exactement la
version du `Cargo.lock` : la glue et le module doivent venir de la même.

Pour mesurer sur de vrais fichiers : `npm run samples:revit` télécharge dans `revit/samples/` les
échantillons de `revit/samples.json` (32 fichiers de 2013 à 2027, projets, un central et deux copies locales de modèle partagé,
modèle de projet et familles ; dépôts publics, empreinte sha256 vérifiée), et `measure` donne pour chacun la durée, le nombre d'éléments et de triangles, et la
répartition des sources. Pour vérifier qu'un changement de la règle de dessin ne touche pas ce qui était lu en entier :
`measure --empreintes <sortie> fichier...` écrit, par élément, sa source, ses triangles et une empreinte exacte (bit à bit) de sa forme
finale, et `measure --comparer <sortie> fichier...` y compare une nouvelle lecture (les éléments en source 0 doivent rester identiques, ceux
qui disparaissent sont listés) ; `faces --empreintes` et `faces --comparer` font de même pour les primitives de chaque graphique, sur tous les
fichiers de 2015 à 2027. `census` (parties 3 à 5) donne, pour chaque élément en boîte ou en forme partielle, les diagnostics exacts, ce que
portent les instances à cibles interdites et les classes de symboles que les instances placent ; `graph --classes` recense les nœuds
graphiques de tous les éléments, `graph <fichier> <id> --classe <Nom>` imprime les champs de tous les objets d'une classe.
`records` (`cargo run --release --example records -- fichier...`) donne, par canal, le décodage des
enregistrements et l'encadrement constaté (`--rvt-rs` compare à rvt-rs pour 2023 et plus, `--champs` compte les champs qui
changent d'une année à l'autre) ; `cargo test --release --test legacy` vérifie la parité de `SampleModel.rvt` (2017) avec
`DynamoSample_2023.rvt`, la couverture de chaque fichier ancien et les familles ; `cargo test --release --test workshared`
celle des copies locales de modèles partagés avec leur central (§ 6). `cargo test --release --test views` vérifie les phases (ordre, filtres,
remplacements, phase d'identifiant 0) et les vues (caméra qui regarde le bâtiment, boîtes de coupe dans les étendues du modèle, clés des
éléments masqués), `cargo test --release --test plans` les plans d'étage (plage de vue, caméra et nord vrai, recadrage, DWG masqués par plan de `wadduwa.rvt`, mêmes plans avant et après 2015) ;
`cargo run --release --example views -- fichier` montre les sections `phases` et `views` d'un fichier,
`--classes`, `--dump` et `--id` les enregistrements bruts, `--scan` les phases de création et de démolition de tous les éléments.

Le test de bout en bout (`tests/revitRead.test.ts`) lit `Revit_IFC5_Einhoven.rvt` avec le vrai module
WebAssembly dans Node, en fait un `RawModel`, appelle `buildModel` et vérifie que les clés du modèle
retrouvent leurs métadonnées. Tant que le lecteur ne rend aucun élément, ce test est marqué ignoré.

## 10. Limites connues et suite

Limites actuelles.

- Fichiers volumineux : le fichier reste hors du module et la sortie part par morceaux pendant le maillage ; ce qui
  grandit encore avec le fichier est le préambule (l'index de tous ses éléments, 150 à 250 octets chacun : refusé au-delà
  de 4 millions d'éléments indexés, `MAX_INDEXED_ELEMENTS`) et le plus gros graphe rvt-rs d'un seul enregistrement (un
  symbole de 224 Mo dans Vignette-04). La reconstruction par l'export IFC de rvt-rs (lecture native échouée, ou année
  postérieure à 2027) lit encore le fichier entier : refusée au-delà de 150 Mo (`MAX_EXPORT_BYTES`). Un seul worker
  maille : la suite prévue en répartit le travail entre plusieurs (§ 7).
- Revit antérieur à 2012 : refusé (aucun fichier d'essai de 2010 ou 2011). Revit 2012 à 2014 : lu nativement (§ 6), sur
  48 fichiers publics (dont 18 d'essai) et 3 de Project Vasari, sans modèle partagé ni gros projet parmi eux. Revit 2015 à 2022 : formes et paramètres natifs, comme à partir de 2023, sans plus aucune boîte ni forme
  partielle sur les fichiers d'essai (composants adaptatifs, instances à cibles interdites de masque 10, symboles résolus dans la vue sans
  condition, groupes étiquetés et surfaces d'Hermite se dessinent, § 3) ; un fichier dense de ces années ne pèse plus que 9 à 15
  fois sa taille en mémoire pendant la lecture, contre 44 à 72 avant (§ 7).
- Une DWG importée dans une famille se dessine en couleurs de calque (§ 3), avec ses blocs à échelle uniforme ; une instance à échelle non uniforme
  qui porte des surfaces reste un diagnostic (forme partielle), aucune n'existe dans les fichiers d'essai. Les textures des matériaux ne sont pas dans le
  fichier (§ 3).
- Les imports CAD du projet se dessinent tous, hors ceux propres à une vue (§ 3). Ce que Revit en montre dans une vue 3D donnée (catégories d'import visibles ou non, éléments
  cachés d'une vue) n'est pas reconstitué hors des vues enregistrées. La priorité de profondeur départage des faces coplanaires de priorités différentes, jamais de même
  priorité : murs contre murs (doublons), sols contre murs, et les pièces d'un escalier entre elles restent coplanaires (§ 3).
- Ce que les fichiers d'essai ne tranchent pas reste un diagnostic, donc une forme partielle : les masques de cibles interdites autres que
  10 sur une instance visible dont le symbole porte des surfaces (aucun n'existe dans les fichiers d'essai), un symbole résolu dans la vue
  dont le graphique contient des conditions, une surface d'Hermite périodique. Les surfaces d'Hermite sont maillées à 3 mm (0,01 pied) au
  lieu du millimètre des autres surfaces, pour tenir le plafond d'un élément (§ 3).
- Modèles partagés : une copie locale (workshared local, cache de BIM 360) se lit par sa table locale d'incréments, telle que
  son utilisateur l'a enregistrée, sans les synchronisations ultérieures des autres ; le central, lui, se lit comme un projet
  ordinaire. Essayé sur des gabarits de Revit 2020 seulement : pour une copie aux modifications non synchronisées, une copie de
  Revit 2023 ou plus ou un modèle de nuage à un seul utilisateur, rien n'est garanti, et si la table locale ne convient pas le
  lecteur retombe sur l'export IFC de rvt-rs, dégradé sur une copie locale (§ 6).
- Familles (.rfa) : les formes et les familles imbriquées se dessinent ; les vides ne se montrent pas, pas plus que les
  repères et les annotations. Les paramètres d'une famille (types, formules) ne sont pas décrits à part.
- Modèles liés : ils ne sont pas suivis. Ouvrir chaque fichier séparément.
- Une forme reconstruite ou une boîte englobante n'est pas la forme exacte de Revit. La propriété
  « Source de la géométrie » dit lesquelles. Un nœud graphique ou une surface que le lecteur ne
  comprend pas encore donne une forme partielle.
- Plans d'étage (§ 4 bis) : le modèle, vu de dessus, entre la profondeur de vue et la coupe, sans ce que Revit dessine en traits ou en motifs : plans de plafond, calques sous-jacents, zones de
  plan, sous-catégories (le calque d'un DWG), styles de ligne, motifs de coupe, lignes « au-delà », annotations, et le haut de la plage de vue ; un plan de surface est lu comme un plan
  d'étage, sans ses limites ni ses remplissages. Une profondeur sur un autre niveau que le bas de la plage est prise au bas de la plage (prudent).
- Un seul état du modèle par défaut : celui de la vue 3D complète. Les phases, les vues 3D et les plans d'étage enregistrés se reprennent (§ 4 bis) ; les
  filtres de vue, les remplacements graphiques par catégorie ou par élément, le niveau de détail, le style visuel et les nomenclatures ne
  sont pas reconstitués. Un remplacement graphique de phase est une couleur et une opacité, pas les traits ni les motifs de Revit.

Feuille de route, sans ordre de priorité : plusieurs workers pour mailler un fichier de plusieurs centaines de mégaoctets
en moins d'une minute (§ 7), les enregistrements géants décodés sans construire tout leur graphe (dans rvt-rs), la file
des définitions en deux lectures plutôt qu'en attente, remplacements graphiques par catégorie et filtres de vue, vues de
coupe et de façade enregistrées, plans de plafond.
