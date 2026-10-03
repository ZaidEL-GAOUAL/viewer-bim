# Planning 4D : tâches, dates et liens avec la maquette

Le Gantt est la représentation graphique du planning. Le JSON ci-dessous est le format
d’échange de ce viewer, pas un format universel de Gantt. Le planning reste séparé du GLB,
de l’USD et du JSON de propriétés : modifier ses dates ne nécessite pas de réexporter la maquette.

## Utilisation

Ouvrir **Planning 4D**, en bas du viewer, puis **Importer un planning…**. Le lecteur propose
lecture/pause, retour au début, date, curseur et vitesse en jours par seconde. Cliquer une tâche
met la lecture en pause, rejoint son début et sélectionne ses objets. **Planning JSON ↓**
exporte le planning courant, ou un modèle de fichier lorsqu’aucun planning n’est chargé.
Le petit bâtiment de démonstration possède aussi un **Planning d’exemple**, aux dates fictives
du 5 janvier au 16 juin 2026 : six lots, 42 regroupements et une tâche pour chacun des 220 objets.
Les lots se chevauchent et se décomposent par niveau, poste et objet : plateforme RDC, gros œuvre,
toiture, menuiseries extérieures, cloisons et menuiseries intérieures. Les départs sont décalés
par travée et par baie, sur 83 dates distinctes, au lieu de faire apparaître un étage complet.
Ce scénario utilise uniquement les ouvrages présents dans le petit modèle ; il ne constitue
pas un planning d’exécution. `node scripts/make-demo-planning.mjs` le régénère ; `--check`
vérifie sa cohérence avec les fichiers de démonstration.

Ouvrir le planning active directement l’affichage à la date choisie ; **Objets hors planning**
conserve ou masque les objets sans tâche. Fermer le panneau ou retirer le planning rétablit la vue habituelle.
Les lots se déplient jusqu’aux tâches par objet. Cliquer un groupe sélectionne les objets de ses
sous-tâches, sans changer leurs dates ni leurs liaisons de simulation.
Les fichiers et la lecture sont traités dans le navigateur, sans appel à l’assistant ni consommation
de jetons d’IA. Les modifications ne sont pas écrites dans les fichiers ouverts sur disque.

## Format JSON, version 1

Deux façons de lier des objets sont disponibles : leurs identifiants exacts, ou une valeur de
propriété commune. Cet exemple illustre les deux alternatives sur des tâches différentes :

```json
{
  "type": "bim-schedule",
  "version": 1,
  "name": "Construction du bâtiment A",
  "tasks": [
    {
      "id": "T001",
      "name": "Dalle du rez-de-chaussée",
      "start": "2026-10-05",
      "end": "2026-10-09",
      "elementIds": ["2O2Fr$t4X7Zf8NOew3FLOH"]
    },
    {
      "id": "T002",
      "name": "Murs du rez-de-chaussée",
      "start": "2026-10-12",
      "end": "2026-10-16",
      "match": { "property": "Planning / Code tâche", "values": ["T002"] }
    }
  ]
}
```

Remplacer les identifiants et valeurs d’exemple par ceux du modèle chargé.

| Champ | Règle |
| --- | --- |
| `type` | Facultatif ; s’il est présent, vaut `"bim-schedule"`. Recommandé pour identifier le fichier. |
| `version` | Obligatoire, vaut `1`. |
| `name` | Nom facultatif du planning. |
| `tasks` | Liste non vide de tâches. |
| `id`, `name` | Textes non vides obligatoires ; chaque `id` de tâche est unique. |
| `start`, `end` | Dates prévues obligatoires au format strict `AAAA-MM-JJ`, avec `end >= start`. |
| `elementIds` | Liste facultative de chaînes correspondant aux IDs de la maquette, donc aux clés du JSON de métadonnées. Pour nos conversions IFC, ce sont les `GlobalId`. |
| `match` | Liaison facultative par nom exact de propriété et valeurs exactes. `1`, `"1"` et `true` sont distincts ; aucun rapprochement par nom d’objet. |
| `parentId` | Identifiant facultatif d’une autre tâche, pour la hiérarchie dépliable du Gantt. Aucun cycle n’est accepté. |

Utiliser de préférence une seule méthode de liaison par tâche. Si `elementIds` et `match`
sont présents ensemble, leurs résultats sont **réunis**, sans doublons. Une propriété imbriquée
utilise son chemin complet, par exemple `Planning / Code tâche`. Les liens par propriété sont
réévalués lorsque les métadonnées changent.

Une tâche parente organise l’affichage ; elle n’hérite ni des objets ni des dates de ses enfants.
Elle porte donc aussi ses propres dates. Un groupe sans objet lié est valable. Les dates ne sont
pas recalculées à partir de dépendances, de durées ou de calendriers de travail.

## Dates et comportement de la simulation

Les deux dates sont **inclusives** : une tâche du 5 au 9 reste en cours le 9 et passe à terminée
le 10. Deux dates identiques représentent une journée. Les jours sont calculés sans décalage
lié au fuseau horaire ou au changement d’heure ; les horodatages et dates comme `05/10/2026`
ne sont pas acceptés.

- Avant sa première tâche, un objet lié est masqué.
- Pendant une tâche active, il apparaît en orange.
- Après une tâche, il retrouve ses couleurs habituelles et reste visible entre deux phases.
- Si plusieurs tâches se chevauchent sur le même objet, une tâche active suffit à le mettre
  en évidence ; une tâche future ne le masque pas de nouveau.

Les objets révélés pendant la lecture ou un déplacement du curseur apparaissent par un fondu
de 240 ms, sans mouvement ni croissance. Le fondu multiplie l’opacité existante, respecte la
préférence système de réduction des animations et s’arrête dès que le planning est fermé.
Revenir à une date où un objet est à venir le masque immédiatement.

Ces états montrent la **prévision**, pas un avancement réel constaté sur le chantier. La durée
écoulée ne représente pas un pourcentage de matière construite. La simulation ne transforme
aucun maillage et ne modifie aucune propriété ni aucun matériau exporté. Les masques manuels
et les règles d’opacité restent appliqués. La teinte orange remplace temporairement la couleur
des objets actifs ; la fermeture révèle les couleurs et filtres courants, y compris les changements
effectués pendant la lecture.

## Réutiliser des dates déjà dans les métadonnées

**Depuis les métadonnées…** permet de choisir explicitement les propriétés de début et de fin,
puis, éventuellement, un code tâche. Sans code, chaque objet daté donne une tâche. Avec un code,
les objets de même code sont réunis et doivent avoir les mêmes dates. Aucun nom de propriété
ni aucune date ne sont devinés. Le planning résultant peut être téléchargé séparément ; tant
qu’il reste lié dans l’onglet, les modifications de ces propriétés actualisent ses dates et ses liens.

Le panneau indique les objets liés et hors planning. **Détail des liaisons** identifie les tâches
sans objet, les IDs introuvables et les objets liés à plusieurs tâches. Les groupes sans liaison
explicite sont exclus des alertes « sans objet ». Pour la conversion depuis
les métadonnées, les dates absentes ou invalides et les codes manquants sont comptés ; une tâche
aux dates contradictoires est exclue entièrement. Un document JSON invalide ne remplace pas
le planning déjà chargé.

## Périmètre et références métier

Cette version lit un planning de **construction** : elle n’édite pas un échéancier, ne calcule
pas de chemin critique et n’importe pas directement Microsoft Project (`.mpp`) ou Primavera.
Les tâches de démolition ou les ouvrages temporaires nécessitent d’autres comportements et
ne sont pas pris en charge ; un champ de tâche `type` ou `action` différent de `"construction"`
est refusé.

Le principe « planning externe → tâches → objets → simulation » suit le workflow documenté
par [Autodesk TimeLiner](https://help.autodesk.com/cloudhelp/2025/ENU/Navisworks-Timeliner/files/GUID-D0D36E3D-F1D0-43B6-AB4E-2E7799B340A3.htm).
Les contrôles de lecture et les objets non liés sont aussi décrits dans
[Autodesk Simulate Model](https://help.autodesk.com/cloudhelp/ENU/Build-Schedule/files/work-schedule/schedule-model/Schedule_Simulate_Model.html).
En IFC, les [tâches](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcTask.htm)
et leurs [informations temporelles](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcTaskTime.htm)
sont des entités distinctes des éléments physiques. Le présent JSON est un contrat léger du
viewer ; ce n’est pas une implémentation complète de ces entités IFC.
