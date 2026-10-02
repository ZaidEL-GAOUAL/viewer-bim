# Viewer BIM

Viewer 3D pour maquettes au format GLB ou glTF, accompagnées d'un fichier JSON de métadonnées.
La seule bibliothèque utilisée à l'exécution est three.js : pas d'ifc.js, de xeokit ni d'OpenIFC.
Les coupes, les mesures, le picking, l'arborescence et les filtres sont écrits dans ce dépôt.

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

- **Affichage** de fichiers GLB et de dossiers glTF (avec `.bin` et textures en sous-dossier),
  y compris compressés (Draco, Meshopt).
- **Sélection** d'un élément (clic), de plusieurs (Ctrl, Cmd ou Maj + clic) ou d'un groupe depuis
  l'arborescence. La fiche à droite affiche les métadonnées, regroupées par catégorie.
- **Arborescence** calculée à partir d'une ou plusieurs propriétés choisies dans « Grouper par » :
  la première donne les groupes, les suivantes les sous-groupes.
- **Couleurs et filtres** : pour une propriété, chaque valeur distincte reçoit une couleur
  (modifiable) et une case pour afficher ou masquer ses éléments.
- **Coupes** : trois plans alignés sur les axes, chacun avec sa position et son sens, et le
  remplissage des sections coupées.
- **Mesures** : distance entre deux points (avec accroche aux sommets), surface d'une face plane,
  volume et surface totale d'un élément.

- **Isoler** : n'affiche que la sélection ; un second clic sur le même bouton rétablit
  l'affichage d'avant. **Tout afficher** réaffiche tous les éléments et recadre le modèle entier.
- **Panneaux repliables** : les boutons aux deux extrémités de la barre d'outils masquent ou
  affichent le panneau de gauche et celui de droite.

Raccourcis : `F` cadrer, `H` masquer la sélection, `I` isoler ou ne plus isoler, `A` tout
afficher, `Échap` annuler puis désélectionner. Double-clic sur un élément pour le cadrer.

## Mise en ligne

Chaque envoi sur la branche `main` lance le workflow `.github/workflows/deploy.yml` : tests,
build, puis publication sur GitHub Pages. Le site étant entièrement statique, il ne demande ni
serveur ni base de données.

## Architecture

```
src/
  data/      métadonnées : lecture du JSON, index des propriétés, regroupements, palette
  engine/    moteur 3D : chargement, fusion de la géométrie, rendu, picking, coupes, mesures
  ui/        interface : barre d'outils et panneaux, en DOM natif
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
- Un verre décrit par l'extension « transmission » est rendu par une simple transparence.
- Les éléments transparents ne sont pas triés entre eux : des vitrages superposés de couleurs
  très différentes peuvent se mélanger de façon approximative.
