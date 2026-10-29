# Viewer BIM

Viewer 3D pour maquettes au format GLB ou glTF, accompagnées d'un fichier JSON de métadonnées.
L'affichage ne repose que sur three.js : pas d'ifc.js, de xeokit ni d'OpenIFC. Les coupes, les
mesures, le picking, l'arborescence et les filtres sont écrits dans ce dépôt.

Un fichier **IFC** peut aussi être déposé directement : il est converti en GLB + JSON, ou en
**USD** (`.usdz`) selon le format choisi dans la barre d'outils (« Export : GLB | USD »), par le convertisseur du dossier
[pipeline/](pipeline/README.md), qui s'appuie sur IfcOpenShell et conserve l'identifiant de
chaque élément pour relier la géométrie aux métadonnées. Le viewer lit les deux formats avec les
mêmes fonctions.

Un fichier **Revit** (`.rvt` projet, ou `.rfa` famille) se dépose aussi tel quel. Un lecteur écrit en Rust, compilé en
WebAssembly, en lit la géométrie et les propriétés dans un worker du navigateur, sans Revit, sans
service Autodesk et sans IFC ni GLB intermédiaire. Détails dans
[docs/lecture-revit.md](docs/lecture-revit.md).

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
| `npm run build:revit` | Recompile le lecteur Revit (`revit/`, Rust) en WebAssembly dans `src/revit/pkg/`. Inutile pour lancer, tester ou construire le viewer : le résultat est versionné |
| `npm run samples:revit` | Télécharge dans `revit/samples/` (ignoré par git) les fichiers Revit d'essai publics, empreinte sha256 vérifiée |

## Fonctions

- **Ouverture d'un IFC** : converti sur place dans le navigateur, sans serveur. Le convertisseur
  (Python et IfcOpenShell en WebAssembly, environ 30 Mo) n'est téléchargé qu'au premier IFC
  ouvert : Pyodide depuis jsDelivr, IfcOpenShell depuis son propre site, avec vérification de
  son empreinte SHA-256 (ce site ne le distribue pas). La conversion utilise plusieurs workers
  (jusqu’à quatre, selon les ressources signalées par le navigateur et la taille du fichier) ; il
  ne s’agit pas de cœurs physiques réservés. Le GLB et le JSON produits peuvent être téléchargés.
- **Ouverture d'un fichier Revit (.rvt, .rfa, gabarits .rte et .rft)** : lu sur place, sans serveur, par le lecteur du dossier
  `revit/` (Rust, rvt-rs, environ 5 Mo de WebAssembly). Ce module n'est
  téléchargé qu'au premier fichier Revit ouvert, et tourne dans un worker : l'interface reste libre
  pendant la lecture. Le menu « Exemples… » propose une maquette Revit 2023.
  - *Ce qui est lu.* La géométrie avec les couleurs des matériaux de Revit, et les propriétés de
    chaque élément : catégorie, famille, type, niveau, phase, matériaux, puis tous les paramètres
    d'instance et de type, regroupés comme dans Revit. Les valeurs sont en unités SI, avec l'unité
    dans le nom : longueurs, surfaces, volumes et angles, mais aussi débits (L/s), vitesses (m/s),
    pressions (Pa), températures (°C), puissances (W, VA), tensions (V), courants (A), éclairements
    (lx), masses, efforts… Une grandeur dont l'unité interne n'est pas établie reste telle quelle,
    sans unité dans le nom. Tout est en lecture seule, comme pour un IFC. Chaque élément est
    relié à son JSON par le GlobalId IFC que calcule l'export IFC de Revit : un JSON écrit pour un
    export IFC du même modèle s'applique donc aussi au `.rvt`. La position sur Terre est reprise
    quand le fichier la donne : latitude, longitude, altitude, nord vrai et décalage de l'origine du
    site par rapport à celle du projet.
  - *D'où vient chaque forme.* La propriété « Source de la géométrie » le dit, avec quatre
    valeurs, essayées dans cet ordre et jamais une boîte en silence. « Forme Revit » est la forme
    d'affichage enregistrée par Revit. « Forme Revit partielle » est la même, avec quelques faces
    que le lecteur n'a pas su tracer. « Forme reconstruite » est refaite à partir des données de
    l'élément (murs, dalles, toits, poteaux, poutres, escaliers, tuyaux…). « Inconnue (boîte
    englobante) » n'a que sa boîte englobante, dessinée telle quelle. Pour retrouver les formes
    approchées, choisissez « Source de la géométrie » dans « Grouper par ». La carte qui suit la
    lecture compte les éléments de chaque sorte.
  - *Versions.* Revit 2012 à 2027 : lecture complète, par les enregistrements natifs du fichier :
    formes enregistrées par Revit, couleurs, paramètres et unités (y compris les paramètres de
    famille de 2012 à 2020, dont l'unité est un ancien numéro `UnitType`). Avant 2015, Revit écrit
    les définitions des familles chargées parmi les éléments du projet : elles sont écartées, comme
    Revit 2015 et après les range à part. Avant Revit 2012 : le fichier est refusé, avec un message
    qui le dit. Si la lecture native échoue, les éléments sont
    reconstruits par l'export IFC de rvt-rs et la carte signale une lecture expérimentale. Une copie
    locale d'un modèle partagé (workshared, ou celle du cache de BIM 360) se lit aussi par ses
    enregistrements natifs : voir « Limites ».
  - *Familles (.rfa).* Une famille s'ouvre comme un projet et montre ce que montre la vue 3D de son
    éditeur : ses formes (extrusions, balayages, mélanges, formes volumiques, masses conceptuelles)
    et les familles chargées dedans. Une famille sans forme ne contient rien à afficher.
  - *Ce qui n'est pas dessiné*, comme dans une vue 3D de Revit : pièces, surfaces, espaces,
    niveaux, axes, plans de référence, caméras, boîtes de coupe et annotations. Un élément sans
    aucune géométrie est compté dans la carte.
  - *Limites.* Plus de limite de taille : le fichier reste hors du module (lu par tranches) et le
    modèle part par morceaux pendant la lecture, qui s'affiche au fur et à mesure (on peut déjà
    tourner autour ou le visiter : la vue n'est recadrée à la fin que si on n'y a pas touché, et un
    .json de métadonnées déposé pendant la lecture est gardé pour la fin). La mémoire du
    lecteur vaut de 4 à 15 fois la taille du fichier sur les fichiers d'essai (jusqu'à 72 avant), et ce
    qui grandit encore est le nombre d'éléments (refus au-delà de 4 millions d'éléments indexés) ; la
    reconstruction par l'export IFC (lecture native échouée, ou année postérieure à 2027) lit encore tout le fichier : refusée au-delà
    de 150 Mo. Un manque de mémoire en cours de route est dit comme tel. Le modèle est borné par un
    budget de triangles réglé sur la mémoire de l'appareil (2,5 millions par Go, entre 2 et 20 millions) :
    au-delà, les formes qui ne tiennent plus sont remplacées par leur boîte englobante, avec un
    avertissement. Si une erreur interne du
    lecteur interrompt la lecture, le fichier est relu une fois en mode prudent (formes de rvt-rs
    seules) et la carte le signale : des formes peuvent alors être incomplètes. Une copie locale d'un
    modèle partagé est lue telle que son utilisateur l'a enregistrée, sans les synchronisations
    ultérieures des autres utilisateurs (la carte le dit) : pour le modèle à jour, ouvrez le central,
    ou resynchronisez la copie dans Revit et enregistrez-la. Les modèles liés ne
    sont pas suivis : ouvrez chaque fichier à part. Les phases et les vues 3D enregistrées sont
    reprises (voir ci-dessous) ; les filtres de vue et les remplacements graphiques par catégorie ne le
    sont pas. Voir la feuille de route dans [docs/lecture-revit.md](docs/lecture-revit.md).
  - *Phases.* Le lecteur écrit la liste ordonnée des phases du projet, ses filtres de phase (« Tout
    afficher », « Afficher nouveau »… : par état, masqué, tel quel ou remplacé) et la couleur de remplacement
    de chaque état. En tête de « Couleurs et filtres », « Phase » et « Filtre de phase » montrent le
    modèle comme une vue de Revit : l'élément créé dans la phase est nouveau, celui d'une phase
    antérieure existant, celui démoli dans la phase démoli ; les états que le filtre masque
    disparaissent, ceux qu'il remplace prennent leur couleur (gris, rouge translucide…). Les règles
    d'apparence restent prioritaires.
  - *Vues enregistrées.* Les vues 3D nommées du projet apparaissent dans le bouton « Vues » : un clic
    glisse la caméra (perspective avec son champ, ou parallèle), pose la boîte de coupe de la vue (six
    plans, case dans « Coupes »), masque ses éléments et catégories masqués, et choisit sa phase et son
    filtre. « Vue par défaut » rétablit l'affichage normal et la caméra d'avant. Le détail de ce qui est
    repris ou ignoré est dans [docs/lecture-revit.md](docs/lecture-revit.md), § 4 bis.
- **Affichage** de fichiers GLB et de dossiers glTF (avec `.bin` et textures en sous-dossier),
  y compris compressés (Draco, Meshopt), et de fichiers USD (`.usdz`, `.usda`) : ceux du
  convertisseur, avec leurs métadonnées embarquées, ou des scènes USD simples venues d'ailleurs.
- **Format GLB ou USD** : le choix en haut à gauche décide dans quel format un IFC est converti,
  affiché et téléchargé. Il est mémorisé d'une visite à l'autre.
- **Sélection** d'un élément (clic), de plusieurs (Ctrl, Cmd ou Maj + clic) ou d'un groupe depuis
  l'arborescence. La fiche à droite affiche les propriétés du GLB puis celles du JSON, regroupées
  par catégories repliables, puis l'emprise de la sélection selon les axes.
- **Métadonnées** : le JSON peut être fourni avec le modèle, dans son dossier, ou ajouté après
  coup avec le bouton « Métadonnées… ». Le lien avec les objets 3D se fait par identifiant.
- **Modification manuelle des métadonnées** : dans la fiche, chaque propriété se modifie sur place
  (texte, nombre, booléen ou date), pour un élément ou pour toute la sélection. On peut ajouter
  ou supprimer une propriété et annuler/rétablir ces changements depuis la barre d’outils. Les propriétés `readOnly` (pour un IFC : classe,
  type, niveau, matériaux, quantités…) s'affichent avec un cadenas. « JSON ↓ » télécharge les
  métadonnées modifiées ; « Annuler les modifications » revient aux fichiers chargés.
- **Arborescence** calculée à partir d'une ou plusieurs propriétés choisies dans « Grouper par » :
  la première donne les groupes, les suivantes les sous-groupes. Le sélecteur présente d’abord
  les propriétés générales et partagées. La recherche et « Toutes les propriétés » donnent aussi
  accès aux champs rares propres à quelques objets, sans supprimer ni renommer les données IFC.
- **Règles de couleur et d’opacité** : une seule pile de règles, avec deux entrées de création :
  « Par valeur de propriété » et « Par condition ». Les règles sont modifiables, activables,
  supprimables et réordonnables. Les conditions lisent les propriétés, ainsi que le nom affiché et l'identifiant de chaque élément (égalité, texte, comparaisons numériques,
  valeurs absentes). La dernière règle correspondante gagne séparément pour la couleur et
  l’opacité : « CO2 > 1 000 → gris », puis « Bâtiment A → bleu », puis « Avancement → opacité ».
  Pour une propriété en pourcentage, 100 donne une opacité de 1 et 50 une opacité de 0,5 ;
  l’échelle 0–1 est aussi proposée explicitement. Une valeur manquante laisse l’opacité précédente.
  La palette par valeur ajoute des règles à cette même liste. Une section **Visibilité** distincte
  permet d’afficher ou masquer les objets par valeur de propriété.
- **Planning 4D** : un Gantt repliable en bas du viewer relie un planning JSON séparé aux IDs
  des objets ou à une propriété commune. Des dates déjà présentes dans les métadonnées peuvent
  aussi être utilisées après choix explicite des champs. Lecture/pause, date, curseur et vitesse
  montrent les travaux prévus : objets futurs masqués, travaux en cours en orange, puis couleurs
  habituelles. Un fondu discret accompagne l’apparition des objets, sans croissance. Les filtres
  manuels sont conservés et les objets hors planning restent contrôlables. L’exemple propose
  six lots dépliables et 220 tâches par objet, avec des dates fictives décalées et des lots simultanés.
  Tout s’exécute localement sans IA ni modification de géométrie ; voir le
  [contrat du planning et ses exemples](docs/contrat-planning.md).
- **Carte** : la maquette posée sur la Terre, dans son environnement réel — plan OpenStreetMap,
  photo aérienne ou plan IGN (France), gratuits et sans clé. Le globe est dessiné par CesiumJS,
  chargé à la demande (quelques mégaoctets, une fois) sous le canvas du viewer, dont la caméra
  suit celle du globe. Sur la carte, c'est Cesium qui dessine la maquette : le viewer lui envoie
  sa géométrie (un GLB bâti à la volée, quel que soit le fichier d'origine) et lui recopie son
  état à chaque changement — sélection, masquage, couleurs et opacités des règles, planning 4D,
  plans de coupe — de sorte que fiche, coupes, mesures, règles d'apparence, planning et
  assistant fonctionnent sur la carte comme ailleurs. La position vient de l'IFC
  (`IfcSite`), du JSON (`georeference`, voir le contrat), ou se saisit — latitude, longitude,
  altitude, orientation du nord — ou se prend d'un clic sur la carte ; « JSON ↓ » l'enregistre.
  Autour de la maquette, au choix : le relief mondial (Terrain Tiles, AWS Open Data, gratuit et
  sans clé, affiché par défaut ; « Au sol » pose la maquette dessus, « Placer au clic » la centre
  sous le curseur, au sol) et les bâtiments du quartier lus dans OpenStreetMap (API Overpass,
  gratuite), extrudés d'après leur hauteur. Avec une clé, en option et jamais par défaut :
  Cesium World Terrain et Cesium OSM Buildings (jeton Cesium ion), ou les tuiles 3D
  photoréalistes de Google (clé Google Maps Platform) ; les clés restent dans le navigateur,
  jamais dans les fichiers. Les altitudes sont comptées au-dessus de la mer, comme dans l'IFC :
  le viewer les convertit pour le globe avec le géoïde EGM96 (`public/geo`), et pose les
  bâtiments Cesium sur le relief affiché.
  CesiumJS est la seule bibliothèque utilisée en plus de three.js, et seulement pour la carte.
- **Coupes** : trois plans initialement alignés sur les axes, chacun avec sa position et son sens,
  et le remplissage des sections coupées. « Placer par clic » pose un plan sur la surface
  cliquée, orienté comme elle, en retirant ce qui est devant (une façade cliquée s'ouvre sur
  l'intérieur, une dalle cliquée du dessus donne un plan d'étage). Le plan actif est visible dans
  la vue, translucide, avec ses poignées : flèche bleue pour le déplacer le long de sa normale,
  flèches rouge et verte pour déplacer les poignées dans le plan, cercles pour l'incliner ;
  tourner conserve le centre de la poignée. « Réaligner » restaure l’orientation de l’axe sans
  déplacer ce centre.
- **Vue 2D** : le bouton « 2D » passe en projection orthographique, sans perspective ni rotation
  (déplacement et zoom seulement), avec les vues Face, Arrière, Gauche, Droite, Haut et Bas
  sous la barre. Combinée à une coupe, la vue de dessus donne un plan d'étage, une vue de côté
  une coupe d'élévation. La carte, qui pilote une caméra en perspective, la suspend.
- **Phases et vues enregistrées** : pour un fichier qui décrit des phases et des vues (la section
  `phases` et `views` du JSON, écrite par le lecteur Revit ; voir
  [docs/contrat-metadonnees.md](docs/contrat-metadonnees.md)), « Couleurs et filtres » propose la phase
  et son filtre, et la barre un bouton « Vues ». Le viewer ne connaît aucun nom de propriété : le
  fichier désigne lui-même la propriété de création et de démolition des éléments, et celle de leur
  catégorie. La phase et les masquages d'une vue écrivent la visibilité des éléments (comme l'arbre) :
  « Tout afficher » les lève.
- **Mode visite** : le bouton « Visite » (ou `V`) pose la caméra à 1,70 m au-dessus du sol sous le
  point de pivot de l'orbite, à l'horizontale dans le sens de la vue, et la fait marcher dans la
  maquette, comme la marche de Revit ou de Navisworks. `Z Q S D`, `W A S D` ou les flèches avancent
  (par position de touche : identique sur AZERTY et QWERTY), `Maj` court (×3 ; 1,4 m/s en marchant),
  un glissement regarde autour, la molette règle la vitesse (affichée un instant), un double-clic
  se place à l'endroit touché. `Échap` ou le bouton quitte et rend l'orbite, autour de ce que l'on
  regardait. Avec la **gravité** (par défaut), les yeux suivent le sol, une marche de moins de 0,4 m
  se monte et une chute est progressive ; sans elle, vol libre (`E` ou Espace monte, `C` descend).
  Avec les **collisions**, on s'arrête à 0,3 m d'un mur que l'on longe (une porte fermée est un
  mur : masquez-la ou décochez). Le sol et les murs viennent du lancer de rayon du picking : les
  éléments masqués ou isolés ne comptent pas, ni ce qu'un plan de coupe retire. Une carte d'aide
  rappelle les touches et se ferme. Perspective seulement : la vue 2D, la carte, « Cadrer » ou
  l'ouverture d'un autre modèle terminent la visite.
- **Mesures** : un menu de la barre d'outils réunit les outils. **Distance** entre deux points
  (avec accroche aux sommets), **Surface** d'une face plane, **Volume** et surface totale d'un
  élément : chaque résultat dans la vue porte une croix pour le supprimer, ses détails sont
  accessibles au survol, et une icône de la barre efface toutes les mesures. **Cotes** donne,
  pour la sélection — un ou plusieurs éléments, Ctrl, Cmd ou Maj + clic pour en ajouter —
  longueur, largeur, hauteur, surface et volume calculés depuis le maillage. Longueur et largeur
  sont celles du rectangle minimal au sol, justes même pour un élément de biais. Pour plusieurs
  éléments, la carte donne l'ensemble (emprise commune, surfaces et volumes additionnés) puis
  chaque élément ; « Copier le tableau » les copie pour un tableur. Les valeurs sont marquées
  « approx. » quand un maillage n'est pas une enveloppe fermée.

- **Isoler** : n'affiche que la sélection ; un second clic sur le même bouton rétablit
  l'affichage d'avant. **Masquer** cache la sélection ; le même bouton devient « Démasquer » et
  la fait revenir, même après avoir désélectionné. **Tout afficher** réaffiche tous les éléments
  et recadre le modèle entier.
- **Téléchargement** : « GLB ↓ » / « USD ↓ » et « JSON ↓ » incluent les métadonnées courantes.
  Quand le GLB source est disponible, ses métadonnées sont actualisées sans réécrire les buffers
  de géométrie et de textures. Les autres sources (un `.rvt`, par exemple) nécessitent une réécriture
  en couleurs par sommet, depuis le modèle affiché.
  Les règles de présentation ne modifient pas la géométrie ni les matériaux des fichiers exportés.
- **Aperçu Apple** : « Voir sur Apple » ouvre Quick Look dans Safari sur iPhone et iPad.
  Sur Mac avec Safari 27 ou ultérieur, il affiche le USDZ dans un aperçu natif intégré à la page
  (élément HTML `model`). Si le navigateur ne dispose pas de cet aperçu, le bouton explique
  la compatibilité requise et ne télécharge aucun fichier. Un USDZ chargé ou issu de la conversion
  d'un IFC est prêt immédiatement ; sinon, le clic prépare un USDZ à jour et ouvre l'aperçu.
  Quick Look sur mobile nécessite alors un second clic. Le fichier reste local, sans envoi à un serveur.
- **Panneaux repliables** : les boutons aux deux extrémités de la barre d'outils masquent ou
  affichent le panneau de gauche et celui de droite.
- **Assistant sur les données** : recherches, comptages et calculs utilisent exclusivement les
  métadonnées ; l’assistant n’accède pas aux maillages et ne modifie aucun objet 3D. Il peut
  ajouter ou modifier des propriétés (« ajoute une propriété Lot = Gros œuvre aux murs »,
  valeur fixe ou formule par élément) et préparer un planning prévisionnel : « ajoute une date
  de début et une date de fin à chaque objet, chantier du 04/01/2026 au 12/12/2027, 15 à 45 jours
  par objet, ordonnés par code étage » écrit `Planning / Date début` et `Planning / Date fin`
  puis ouvre le Planning 4D, en construisant du bas vers le haut d’après la hauteur des objets
  dans la maquette, quels que soient les noms des étages (GF, 1F, RDC, R+1…). Ces écritures passent par l’historique des propriétés : une seule
  étape, annulable, et rien n’est écrit dans les fichiers sans export. Il peut aussi sélectionner, isoler (« n’affiche que le bâtiment A, le reste
  invisible »), masquer ou réafficher (« masque le niveau R+2 », « tout afficher »), mettre en
  évidence (« fais ressortir le bâtiment A » : surbrillance, le reste atténué par deux règles
  d’opacité retirables), configurer les mêmes règles de couleur/opacité que le panneau manuel et
  organiser l’arbre par propriétés (« Bâtiment, puis Niveau, puis Classe IFC »). Il vise un
  élément par son nom (« Mur pignon est ») ou, sans ambiguïté, par son identifiant, et vérifie
  les noms des éléments touchés avant de répondre. Les calculs et règles s’exécutent dans le navigateur ; seuls
  le résumé, la conversation et des résultats bornés sont envoyés au modèle. Les contrôles
  manuels ne consomment aucun jeton d’IA.
- **API pour les agents** : les outils de l’assistant sont offerts à tout agent qui pilote la
  page, sans passer par le service d’IA du site. `window.viewerBim.tools` les décrit (nom,
  description, schéma JSON des arguments) et `window.viewerBim.call('plan_dates', {...})` les
  exécute ; un agent qui exécute du JavaScript dans l’onglet (extension de navigateur, Playwright)
  s’en sert directement. Les navigateurs qui proposent WebMCP (`document.modelContext`) les
  reçoivent aussi comme outils déclarés. Les données restent dans l’onglet.
- **Usage et API** : l’assistant affiche les jetons d’entrée/sortie/total communiqués pendant
  la session ; `?` signale une mesure indisponible, sans estimation inventée. Les réglages permettent
  d’utiliser une API compatible personnelle ou d’entreprise via le relais. Les paramètres et
  la clé restent en mémoire dans l’onglet. Les adresses d’entreprise doivent être autorisées
  par `AI_ALLOWED_ENDPOINTS` côté relais ; voir [worker/README.md](worker/README.md).

Raccourcis : `F` cadrer, `H` masquer ou démasquer, `I` isoler ou ne plus isoler, `A` tout
afficher, `V` visiter (marcher dans la maquette), `Échap` annuler puis désélectionner. Double-clic sur un élément pour le cadrer.

Le viewer ne propose pas de création, déplacement, duplication ou suppression d’objets 3D,
ni d’export IFC d’auteur. L’édition porte uniquement sur les métadonnées via les contrôles manuels.
Les tests de l’assistant utilisent des réponses simulées, sans appeler de modèle réel.

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
  revit/     lecture des .rvt dans le navigateur : worker, module WebAssembly livré dans pkg/, rapport
  usd/       lecture des fichiers USD (usda, usdz)
  assistant/ outils, message système et dialogue avec le worker de l'assistant
  ui/        interface : barre d'outils et panneaux, en DOM natif
pipeline/    convertisseur IFC → GLB ou USD + JSON (Python, IfcOpenShell) et ses tests
revit/       lecteur de fichiers Revit (Rust, rvt-rs) compilé en WebAssembly, ses tests et ses échantillons
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
8. **Revit sans GLB intermédiaire** (`revit/`, `src/revit/`, `engine/buildModel.ts`). Le lecteur
   tourne dans un worker, lit le fichier par tranches sans le copier, et rend des tableaux typés
   par morceaux de 250 000 triangles pendant le maillage : positions, normales, indices, matériaux.
   Ils passent au fil principal par transfert, sans copie, puis `ModelBuilder` les fusionne dans les
   lots avec le même code que pour un glTF, et le modèle grandit à l'écran morceau par morceau.
   Aucun GLB n'est écrit puis relu, et aucun objet three.js n'est créé par élément. Un GLB
   n'existe que si l'utilisateur clique sur « GLB ↓ ».
9. **Visite à coût borné** (`engine/WalkControls.ts`, `engine/walkMath.ts`). La caméra seule
   bouge : les lots fusionnés se dessinent comme en orbite. Le sol et les murs viennent du lancer
   de rayon du picking, limité en portée (`maxDistance`, les éléments trop loin ne sont même pas
   triés) : un rayon vers le bas toutes les 100 ms ou tous les 0,2 m, deux rayons horizontaux par
   image seulement pendant que l'on avance contre des collisions. Un rayon coûte de 0,02 à 0,12 ms
   sur la tour de 22 561 éléments comme sur un modèle Revit de 2,2 millions de triangles ; le
   calcul de la visite pèse environ 0,3 ms par image en marchant avec les collisions, 0,05 ms
   sans, et presque rien à l'arrêt (un rayon toutes les 250 ms).

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
  s'arrête. Une machine rapide n'est jamais concernée. Seuls les mouvements menés par
  l'utilisateur (caméra, poignées de coupe) sont mesurés : la lecture du planning 4D, ses fondus
  et les changements de couleur sont toujours rendus en pleine résolution — un pas de planning
  toutes les 100 ms passait sinon pour une machine à 10 images par seconde.
- **Fluidité affichée**. La barre d'état en bas de la vue 3D indique le nombre d'images par
  seconde mesuré pendant le dernier mouvement, et signale une résolution réduite. C'est le moyen
  le plus simple de vérifier le comportement sur un autre ordinateur.

### Conversion d'un IFC : mesures

Maquette de structure exportée de Revit (IFC2x3, 21 Mo, 3 179 éléments, 226 000 triangles),
sur un Apple M4 Pro :

| Mode | Durée |
| --- | --- |
| Ligne de commande, tous les cœurs | 2 s |
| Navigateur, 4 workers, premier IFC de la session | 11,5 s (dont 6 s de mise en route du convertisseur) |
| Navigateur, 4 workers, moteur déjà initialisé | 5 s |

Chaque convertisseur occupe en mémoire environ quinze fois la taille de l'IFC (320 Mo pour ce
fichier). Le viewer en lance d'autant moins que le fichier est gros et la mémoire limitée.
Ces mesures historiques ne comparent pas le parallélisme à conditions identiques. Les workers
supplémentaires sont libérés après la conversion et le dernier après 30 secondes d’inactivité.

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
- Fichiers Revit : limite de taille, refus avant Revit 2012, formes approchées
  signalées par « Source de la géométrie », copie locale d'un modèle partagé lue telle qu'enregistrée. Liste complète dans [docs/lecture-revit.md](docs/lecture-revit.md).
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

## Licence

View-only code: © 2026 Zaid EL GAOUAL, all rights reserved. You may read the code and use the
official site to display your own files; any other use needs written consent (see
[LICENSE](LICENSE)). Third-party components keep their own licences: see [NOTICE](NOTICE),
[revit/THIRD_PARTY.md](revit/THIRD_PARTY.md) and the site's « Licences » page.
