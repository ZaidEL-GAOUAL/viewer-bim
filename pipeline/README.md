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
- Un élément dont IfcOpenShell ne parvient pas à calculer la géométrie est absent du GLB et du
  JSON ; le convertisseur en indique le nombre.
- Dans le navigateur, la conversion utilise un seul cœur : elle est environ six fois plus lente
  qu'en ligne de commande, et limitée par la mémoire du navigateur pour les très gros fichiers.

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
