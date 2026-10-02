# Convertisseur IFC → GLB + JSON

`ifc_to_glb.py` transforme un fichier IFC en deux fichiers que le viewer sait lire :

- un **GLB** pour la géométrie ;
- un **JSON** pour les métadonnées, au format décrit dans
  [docs/contrat-metadonnees.md](../docs/contrat-metadonnees.md).

Le lien entre les deux est l'identifiant IFC de chaque élément (son `GlobalId`). Il est écrit
dans `extras.id` du nœud glTF et sert de clé dans le JSON : il n'est jamais perdu ni renuméroté.

La lecture de l'IFC et le calcul de la géométrie sont faits par
[IfcOpenShell](https://ifcopenshell.org/).

## Deux façons de l'utiliser

**Dans le viewer.** Déposer un `.ifc` dans la fenêtre : la conversion se fait dans le navigateur,
avec ce même script, puis le modèle s'affiche. Rien n'est envoyé à un serveur. Les deux fichiers
produits peuvent être téléchargés depuis la carte « IFC converti ».

**En ligne de commande**, plus rapide et sans limite de taille :

```bash
pip install -r pipeline/requirements.txt
```

```bash
python pipeline/ifc_to_glb.py maquette.ifc
```

Cela écrit `maquette.glb` et `maquette.json` à côté de l'IFC. Options :

| Option | Effet |
| --- | --- |
| `-o dossier/` | écrit les fichiers dans un autre dossier |
| `--classes IfcWall,IfcSlab` | ne convertit que ces classes IFC (sous-classes comprises) |
| `--ids id1,id2` | ne convertit que ces `GlobalId` |
| `--espaces` | exporte aussi les locaux (`IfcSpace`), écartés par défaut |
| `--threads N` | nombre de fils d'exécution (tous les cœurs par défaut) |

Les éléments conservés par un filtre gardent leur identifiant et toutes leurs propriétés.

## Ce qui est produit

**Géométrie**

- Un nœud glTF par élément IFC, avec `extras.id` = `GlobalId` et `name` = nom de l'élément.
- Unités converties en mètres, axe vertical converti de Z (IFC) vers Y (glTF).
- Les ouvertures (`IfcOpeningElement`) sont soustraites des murs et dalles, puis écartées.
- Les éléments qui partagent une même forme (même type) partagent un seul maillage.
- Les coordonnées de projet, même très grandes (géoréférencement), sont conservées dans la
  position des nœuds ; le viewer recentre le modèle à l'affichage.
- Couleurs et transparence reprises des styles de surface et des matériaux IFC.
- Un solide fermé est exporté en simple face, une surface ouverte en double face.

**Métadonnées**, pour chaque élément :

| Propriété | Origine dans l'IFC |
| --- | --- |
| `Classe IFC` | la classe de l'élément (`IfcWall`, `IfcDoor`…) |
| `Nom`, `Description`, `Repère`, `Type d'objet` | attributs de l'élément |
| `Type`, `Type prédéfini` | type associé (`IfcWallType`…) et `PredefinedType` |
| `Site`, `Bâtiment`, `Niveau`, `Local` | structure spatiale qui contient l'élément |
| `Matériaux` | matériaux associés |
| une catégorie par jeu | jeux de propriétés (`Pset_…`) et de quantités (`Qto_…`), ceux du type compris |

La structure spatiale devient de simples propriétés : dans le viewer, « Grouper par » `Niveau`
puis `Classe IFC` reconstruit l'arborescence voulue.

## Limites

- Les valeurs des propriétés et des quantités sont recopiées telles qu'elles sont dans l'IFC,
  donc dans l'unité du projet (une longueur peut être en millimètres). Seule la géométrie est
  convertie en mètres.
- Les axes de trame (`IfcGrid`), les annotations et tout ce qui n'est dessiné qu'en lignes n'ont
  pas de volume : ils sont laissés de côté et comptés à part, sans être signalés comme des échecs.
- Un élément dont IfcOpenShell ne parvient pas à calculer la géométrie est absent du GLB et du
  JSON ; le convertisseur donne alors sa classe, son nom et son identifiant.
- Dans le navigateur, un IFC de plus de 100 Mo est refusé avec un message qui propose un fichier
  plus léger ou la ligne de commande. Si la mémoire manque en cours de route, la conversion est
  retentée sur un seul cœur avant d'abandonner.
- Dans le navigateur, la conversion est répartie sur un à quatre cœurs, mais reste deux à cinq
  fois plus lente qu'en ligne de commande. Elle est aussi limitée par la mémoire : chaque
  convertisseur occupe environ quinze fois la taille de l'IFC, et le navigateur ne lui accorde pas
  plus de quelques gigaoctets. Au-delà d'une centaine de mégaoctets d'IFC, préférer la ligne de
  commande.

## Version d'IfcOpenShell dans le navigateur

Le viewer embarque le paquet 0.8.5. À partir de la 0.8.6, le paquet pour navigateur publié par
IfcOpenShell est « modulaire » : un noyau, auquel les schémas IFC et le moteur géométrique
s'ajoutent comme modules séparés. Le paquet 0.9.0 ne contient que le noyau (son binaire fait
5,8 Mo contre 53,6 Mo) et ses modules ne sont pas publiés : lire un IFC le fait planter (« memory
access out of bounds »). Le jeu de modules 0.8.6 lit bien un IFC une fois son dossier déclaré avec
`ifcopenshell.set_plugin_search_paths`, mais le calcul de la géométrie y échoue encore. Avant de
changer de version, vérifier qu'un IFC4 et un IFC2x3 se convertissent entièrement.

## Tests

```bash
pip install pytest
```

```bash
pytest pipeline/tests
```

`tests/make_sample_ifc.py` fabrique le bâtiment IFC de démonstration (IFC4 ou IFC2x3) utilisé
par les tests et par l'exemple « Maquette IFC » du viewer.

## Licence d'IfcOpenShell

IfcOpenShell est distribué sous licence LGPL-3.0. La version pour navigateur servie avec le
viewer (`public/wheels/`) est le paquet officiel non modifié, publié sur
https://ifcopenshell.github.io/wasm-wheels/ ; son code source est sur
https://github.com/IfcOpenShell/IfcOpenShell.
