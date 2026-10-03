# Viewer BIM

Viewer 3D pour maquettes au format GLB ou glTF, accompagnées d'un fichier JSON de métadonnées.
L'affichage ne repose que sur three.js : pas d'ifc.js, de xeokit ni d'OpenIFC. Les coupes, les
mesures, le picking, l'arborescence et les filtres sont écrits dans ce dépôt.

Un fichier **IFC** peut aussi être déposé directement : il est converti en GLB + JSON, ou en
**USD** (`.usdz`) selon le format choisi dans la barre d'outils, par le convertisseur du dossier
[pipeline/](pipeline/README.md), qui s'appuie sur IfcOpenShell et conserve l'identifiant de
chaque élément pour relier la géométrie aux métadonnées. Le viewer lit les deux formats avec les
mêmes fonctions.

Le viewer est générique : il ne connaît aucun standard BIM et découvre les propriétés dans le
JSON. Le format attendu est décrit dans [docs/contrat-metadonnees.md](docs/contrat-metadonnees.md).

**En ligne : https://zaidel-gaoual.github.io/viewer-bim/**

Tout se passe dans le navigateur : les fichiers ouverts ne sont envoyés à aucun serveur.

## Démarrer

```bash
npm install --no-bin-links
npm run dev
```

Puis ouvrir http://localhost:5173 et déposer un `.glb` et son `.json`, ou choisir un modèle dans
« Exemples… ».

Un `.gltf` vient avec des fichiers voisins (`.bin`, dossier de textures) : déposez le **dossier
entier** dans la fenêtre, ou ouvrez-le avec le bouton « Dossier… ». Le `.gltf` seul ne suffit pas,
et le viewer indique alors quel fichier lui manque.

`--no-bin-links` n'est nécessaire que si le projet est sur un disque exFAT, qui ne gère pas les
liens symboliques. Les scripts appellent donc les outils par leur chemin dans `node_modules`.

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement |
| `npm run build` | Vérification des types puis build de production dans `dist/` |
| `npm test` | Tests unitaires et d'intégration (lanceur de tests intégré à Node, version 24 ou plus) |
| `npm run sample` | Régénère le bâtiment de démonstration (`-- --large` pour la tour de 22 500 éléments) |

## Fonctions

- **Ouverture d'un IFC** : converti sur place dans le navigateur, sans serveur. Le convertisseur
  (Python et IfcOpenShell en WebAssembly, environ 30 Mo) n'est téléchargé qu'au premier IFC
  ouvert. La conversion est répartie sur plusieurs cœurs (jusqu'à quatre, selon la machine et la
  taille du fichier). Le GLB et le JSON produits peuvent être téléchargés.
- **Affichage** de fichiers GLB et de dossiers glTF (avec `.bin` et textures en sous-dossier),
  y compris compressés (Draco, Meshopt), et de fichiers USD (`.usdz`, `.usda`) : ceux du
  convertisseur, avec leurs métadonnées embarquées, ou des scènes USD simples venues d'ailleurs.
- **Format GLB ou USD** : le choix en haut à gauche décide dans quel format un IFC est converti,
  affiché et téléchargé. Il est mémorisé d'une visite à l'autre.
- **Sélection** d'un élément (clic), de plusieurs (Ctrl, Cmd ou Maj + clic) ou d'un groupe depuis
  l'arborescence. La fiche à droite affiche les propriétés du GLB puis celles du JSON, regroupées
  par catégories repliables.
- **Métadonnées** : le JSON peut être fourni avec le modèle, dans son dossier, ou ajouté après
  coup avec le bouton « Métadonnées… ». Le lien avec les objets 3D se fait par identifiant.
- **Modification des métadonnées** : dans la fiche, chaque propriété se modifie sur place (texte,
  nombre, case à cocher), pour un élément ou pour toute la sélection, et « Ajouter une propriété »
  en crée de nouvelles. Les propriétés que le fichier déclare `readOnly` (pour un IFC : classe,
  type, niveau, matériaux, quantités…) s'affichent avec un cadenas. « JSON ↓ » télécharge les
  métadonnées modifiées ; « Annuler les modifications » revient aux fichiers chargés.
- **Arborescence** calculée à partir d'une ou plusieurs propriétés choisies dans « Grouper par » :
  la première donne les groupes, les suivantes les sous-groupes.
- **Couleurs et filtres** : pour une propriété, chaque valeur distincte reçoit une couleur
  (modifiable) et une case pour afficher ou masquer ses éléments.
- **Coupes** : trois plans alignés sur les axes, chacun avec sa position et son sens, et le
  remplissage des sections coupées.
- **Mesures** : distance entre deux points (avec accroche aux sommets), surface d'une face plane,
  volume et surface totale d'un élément.

- **Isoler** : n'affiche que la sélection ; un second clic sur le même bouton rétablit
  l'affichage d'avant. **Masquer** cache la sélection ; le même bouton devient « Démasquer » et
  la fait revenir, même après avoir désélectionné. **Tout afficher** réaffiche tous les éléments
  et recadre le modèle entier.
- **Téléchargement** : « GLB ↓ » (ou « USD ↓ », selon le format choisi) télécharge le fichier 3D
  dès qu'un modèle est affiché. Après la conversion d'un IFC, c'est le fichier produit ; dès que
  la géométrie a changé (déplacements, ajouts) ou pour un modèle ouvert tel quel, le viewer
  réécrit le fichier depuis ce qui est affiché (couleurs par sommet, sans textures). « JSON ↓ »
  télécharge les métadonnées, modifications comprises.
- **Quick Look Apple** : « Voir sur Apple » ouvre le USDZ dans le viewer natif de Safari sur
  iPhone et iPad. Sur Mac, le lien télécharge le USDZ : sélectionnez-le dans le Finder et
  appuyez sur Espace. Un USDZ chargé ou issu de la conversion d'un IFC est prêt immédiatement ;
  pour les autres formats ou après une modification, le premier clic prépare un USDZ à jour,
  puis un second clic l'ouvre. Le fichier est préparé localement, sans envoi à un serveur.
- **Panneaux repliables** : les boutons aux deux extrémités de la barre d'outils masquent ou
  affichent le panneau de gauche et celui de droite.
- **Assistant** (onglet de gauche) : une conversation avec un modèle de langage qui interroge
  et complète les métadonnées — « combien d'éléments par niveau ? », « quels murs n'ont pas de
  résistance au feu ? », « mets le lot Gros œuvre sur les murs du RDC », « surface totale des
  dalles du R+1 ? », « quels murs ont un volume incohérent avec leurs dimensions ? ». Le modèle
  ne reçoit jamais le fichier : il appelle des outils (compter, chercher, lire une fiche,
  sélectionner, calculer une formule sur tous les éléments, modifier) exécutés dans le
  navigateur, et seuls leurs résultats lui sont envoyés — les chiffres viennent du code. Il lit
  aussi la géométrie (centre, emprise, bas et haut de chaque élément) et peut **déplacer,
  dupliquer et créer des éléments** : « ajoute une pièce de 4 × 4 m avec quatre murs et un sol
  à côté du bâtiment ». Les propriétés verrouillées lui sont interdites comme à tout le monde,
  ses modifications se comptent et s'annulent comme les vôtres. Le service tourne sur un worker
  Cloudflare gratuit (voir `worker/README.md`) ; sans lui, l'onglet le signale et tout le reste
  fonctionne.
- **Déplacer, dupliquer, créer** : dans la fiche, « Déplacer ou dupliquer » décale la sélection
  d'un vecteur en mètres ou en fait une copie décalée (propriétés comprises). Les éléments créés
  (boîtes : murs provisoires, réservations, zones, mobilier simplifié) reçoivent un identifiant
  au format IFC et une fiche qui garde leurs paramètres (`Boîte / Centre X`, `Taille X`,
  `Rotation`…), de quoi les recréer ailleurs — dans un IFC, par exemple. « Annuler les
  modifications » défait tout.

Raccourcis : `F` cadrer, `H` masquer ou démasquer, `I` isoler ou ne plus isoler, `A` tout
afficher, `Échap` annuler puis désélectionner. Double-clic sur un élément pour le cadrer.

## Mise en ligne

Chaque envoi sur la branche `main` lance le workflow `.github/workflows/deploy.yml` : tests,
build, puis publication sur GitHub Pages. Le site étant entièrement statique, il ne demande ni
serveur ni base de données.

Seul l'assistant a besoin d'un service : un worker Cloudflare (plan gratuit, sans carte
bancaire), déployé par le même workflow quand les secrets `CLOUDFLARE_API_TOKEN` et
`CLOUDFLARE_ACCOUNT_ID` sont renseignés dans le dépôt. Mode d'emploi dans `worker/README.md`.

## Architecture

```
src/
  data/      métadonnées : lecture du JSON, index des propriétés, regroupements, palette
  engine/    moteur 3D : chargement, fusion de la géométrie, rendu, picking, coupes, mesures
  ifc/       lancement du convertisseur IFC dans le navigateur (fil d'exécution séparé)
  usd/       lecture des fichiers USD (usda, usdz)
  assistant/ outils, message système et dialogue avec le worker de l'assistant
  ui/        interface : barre d'outils et panneaux, en DOM natif
pipeline/    convertisseur IFC → GLB ou USD + JSON (Python, IfcOpenShell) et ses tests
worker/      service de l'assistant (Cloudflare Workers) : relais vers le modèle de langage
tests/       tests des modules de données et du moteur
scripts/     générateur du modèle de démonstration
```

### Pourquoi c'est rapide

Un modèle BIM contient des dizaines de milliers d'objets. Dessiner un objet three.js par élément
coûte un appel de dessin par élément et fait chuter la fluidité. Le viewer procède autrement :

1. **Fusion en lots** (`engine/buildModel.ts`). Au chargement, toute la géométrie est fusionnée
   en quelques tampons, avec les transformations déjà appliquées. La tour de démonstration
   (22 561 éléments, 1,06 million de triangles) se dessine en 4 appels.
2. **État par élément sur le GPU** (`engine/elementState.ts`). Chaque sommet porte le numéro de
   son élément ; une petite texture contient, par élément, sa visibilité, sa couleur imposée et
   son état de sélection. Masquer ou colorer des milliers d'éléments revient à écrire quelques
   octets, sans toucher à la géométrie.
3. **Picking sans bibliothèque externe** (`engine/Model.ts`, `engine/triangleBlocks.ts`). Le rayon
   est d'abord testé contre les boîtes englobantes des éléments visibles, puis contre les seuls
   triangles des éléments traversés, du plus proche au plus lointain. Les éléments très détaillés
   sont en plus découpés en blocs de 256 triangles voisins, chacun avec sa boîte.
4. **Textures utiles seulement** (`engine/loadModel.ts`). Seule la texture de couleur est
   affichée ; les autres (relief, rugosité) sont retirées du glTF avant lecture, donc ni
   téléchargées ni décodées.
5. **Coupes sur le GPU** (`engine/Sections.ts`, `engine/Viewer.ts`). Déplacer un plan ne change
   que des uniformes. Le remplissage des sections utilise le tampon de pochoir, en deux passes
   légères par plan actif, limitées aux solides fermés.
6. **Rendu à la demande**. Une image n'est calculée que si la caméra bouge ou si l'état change.
7. **Interface paresseuse**. L'arbre ne construit un groupe qu'à son ouverture et pagine les
   listes d'éléments par 200.

Mesures relevées sur un Apple M4 Pro :

| Modèle | Chargement | Une image | Un picking |
| --- | --- | --- | --- |
| Tour de démonstration : 22 561 éléments, 1,06 million de triangles | 0,45 s | 1,8 ms (3,1 ms avec une coupe remplie) | 0,14 ms |
| Modèle Sketchfab texturé : 14 gros maillages, 1,5 million de triangles | 0,6 s | 1,9 ms | 0,12 ms |

Masquer ou colorer plusieurs milliers d'éléments prend moins de 1 ms.

### Sur une machine moins puissante

- **Résolution adaptative** (`engine/AdaptiveResolution.ts`). Si la carte graphique ne tient pas
  environ 30 images par seconde pendant un mouvement de caméra, la vue est calculée avec moins de
  pixels (jusqu'à moitié moins dans chaque direction), puis en pleine résolution dès que la caméra
  s'arrête. Une machine rapide n'est jamais concernée.
- **Fluidité affichée**. La barre d'état en bas de la vue 3D indique le nombre d'images par
  seconde mesuré pendant le dernier mouvement, et signale une résolution réduite. C'est le moyen
  le plus simple de vérifier le comportement sur un autre ordinateur.

### Conversion d'un IFC : mesures

Maquette de structure exportée de Revit (IFC2x3, 21 Mo, 3 179 éléments, 226 000 triangles),
sur un Apple M4 Pro :

| Mode | Durée |
| --- | --- |
| Ligne de commande, tous les cœurs | 2 s |
| Navigateur, 4 cœurs, premier IFC de la session | 11,5 s (dont 6 s de mise en route du convertisseur) |
| Navigateur, 4 cœurs, IFC suivants | 5 s |
| Navigateur, 1 cœur volontairement bridé (cœurs économes en basse priorité) | 108 s |

Chaque convertisseur occupe en mémoire environ quinze fois la taille de l'IFC (320 Mo pour ce
fichier). Le viewer en lance d'autant moins que le fichier est gros et la mémoire limitée.

### Précautions d'affichage

- Le modèle est **recentré sur l'origine** au chargement, en double précision : un modèle
  géoréférencé, loin de l'origine, ne tremble pas à l'écran.
- Les plans proche et lointain de la caméra suivent le modèle à chaque image pour garder un
  maximum de précision de profondeur.
- Les nœuds posés **en miroir** (échelle négative) voient l'ordre de leurs sommets rétabli, pour
  que leurs faces restent orientées vers l'extérieur.
- Un clic sur une section coupée renvoie un point sur le plan de coupe, pas sur la face
  intérieure du solide : les distances prises sur une coupe sont exactes.
- Un clic ne touche que ce qui est réellement affiché : ni l'envers d'une face à simple face, ni
  l'intérieur d'un solide coupé quand le remplissage des sections est désactivé.
- Un maillage sans normales est ombré à facettes, comme le demande le format glTF.
- Deux éléments dont des faces sont exactement dans le même plan (une poutre noyée dans une dalle
  de même épaisseur, par exemple) ne scintillent pas : chaque élément reçoit une légère avance en
  profondeur, d'autant plus grande qu'il est petit. Le plus petit des deux est donc affiché, et
  c'est aussi lui que l'on clique.

## Limites connues

- Les fonctions BIM (sélection par objet, métadonnées, arborescence, filtres) supposent que le
  fichier contient un nœud par objet du bâtiment. Un modèle « décoratif » fusionné, comme ceux de
  Sketchfab, s'affiche, se coupe et se mesure, mais ses morceaux ne correspondent à aucun objet réel.

- Les mesures supposent des modèles en mètres, comme l'impose glTF.
- Le volume est calculé à partir du maillage. Si celui-ci n'est pas un solide fermé, la valeur
  est signalée comme indicative.
- Le remplissage des coupes ne s'applique qu'aux éléments opaques dont le maillage est fermé.
- La surface mesurée est celle d'une face plane ; sur une surface courbe, chaque facette compte
  séparément.
- Seule la texture de couleur des matériaux est affichée. Les animations, les lignes et les
  nuages de points du glTF sont ignorés, de même que les scènes autres que la scène par défaut.
- Les textures compressées KTX2 ne sont pas décodées : le modèle s'affiche avec ses couleurs de
  base et un avertissement.
- USD : seul le format texte (`.usda`, seul ou dans un `.usdz`) est lu, avec les maillages
  polygonaux, les transformations par matrice, les références internes et les matériaux
  UsdPreviewSurface. Le format binaire (`.usdc`) et les scènes plus riches (variantes, fichiers
  liés, textures) ne sont pas pris en charge. Un USD texte est bien plus volumineux qu'un GLB
  (environ quatre fois).
- Un verre décrit par l'extension « transmission » est rendu par une simple transparence.
- Les éléments transparents ne sont pas triés entre eux : des vitrages superposés de couleurs
  très différentes peuvent se mélanger de façon approximative.
