// Planning illustratif du petit modèle livré avec le viewer, sans modifier sa géométrie
// ni ses métadonnées. Les dates sont fictives et ne constituent pas un planning d'exécution.
//   node scripts/make-demo-planning.mjs          → public/samples/demo-planning.json
//   node scripts/make-demo-planning.mjs --check  → vérifie que le fichier est à jour
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
const metadata = JSON.parse(readFileSync(join(directory, 'demo.json'), 'utf8')).elements;
const binary = readFileSync(join(directory, 'demo.glb'));
assert.equal(binary.readUInt32LE(0), 0x46546c67, 'GLB de démonstration invalide');
const gltf = JSON.parse(binary.subarray(20, 20 + binary.readUInt32LE(12)).toString('utf8'));
const nodes = gltf.nodes.filter((node) => node.extras?.id);
const modelIds = new Set(nodes.map((node) => node.extras.id));
assert.equal(modelIds.size, 220, 'Le petit modèle a changé : revoir les postes du planning');
assert.equal(Object.keys(metadata).length, 219, 'Les métadonnées du petit modèle ont changé');
for (const id of Object.keys(metadata)) assert.ok(modelIds.has(id), `Objet absent du GLB : ${id}`);

// make-sample.mjs omet volontairement les métadonnées de ce seul poteau pour tester
// les imports incomplets. Sa liaison vient du GLB et de son étage, jamais d'un ID inventé.
const missing = nodes.filter((node) => !metadata[node.extras.id]);
assert.equal(missing.length, 1);
assert.equal(missing[0].name, 'Poteau 1-3');
const missingIndex = gltf.nodes.indexOf(missing[0]);
assert.equal(gltf.nodes.find((node) => node.children?.includes(missingIndex))?.name, 'Niveau RDC');
const elements = Object.entries(metadata).map(([id, element]) => ({ id, ...element }));
elements.push({ id: missing[0].extras.id, label: missing[0].name, properties: { Catégorie: 'Poteau', Niveau: 'RDC' } });

// Calendrier simplifié lundi-vendredi. Les périodes sont inclusives ; les jours fériés
// et les ressources ne sont pas calculés par cet exemple.
function date(workday) {
  const calendarDays = Math.floor(workday / 5) * 7 + workday % 5;
  return new Date(Date.UTC(2026, 0, 5 + calendarDays)).toISOString().slice(0, 10);
}

const roots = [];
const leafIds = new Set();
function group(parent, id, name) {
  const node = { id, name, children: [] };
  (parent ? parent.children : roots).push(node);
  return node;
}
function leaf(parent, element, name, start, duration) {
  assert.ok(!leafIds.has(element.id), `Objet planifié deux fois : ${element.label}`);
  leafIds.add(element.id);
  parent.children.push({ id: `object:${element.id}`, name, start: date(start), end: date(start + duration - 1), elementIds: [element.id] });
}
const atLevel = (level, predicate) => elements.filter((element) => element.properties.Niveau === level && predicate(element.properties));
const numerical = (a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true });

const platform = group(null, 'lot-00', '00 · Dalle RDC — plateforme de départ');
const initialSlab = elements.find((element) => element.label === 'Dalle RDC');
assert.equal(initialSlab.properties.Phase, 'Existant');
// L'objet est déjà déclaré « Existant » dans le modèle. Cette première ligne situe
// la plateforme dans la démonstration ; elle ne prétend pas dater sa construction réelle.
leaf(platform, initialSlab, 'Dalle RDC — état initial de la plateforme', 0, 3);

const structure = group(null, 'lot-01', '01 · Gros œuvre — élévation par niveau');
const roof = group(null, 'lot-02', '02 · Toiture-terrasse — clos et couvert');
const glazing = group(null, 'lot-03', '03 · Menuiseries extérieures');
const partitions = group(null, 'lot-04', '04 · Cloisons et impostes');
const doors = group(null, 'lot-05', '05 · Menuiseries intérieures');

for (const [index, level] of ['RDC', 'R+1', 'R+2'].entries()) {
  const tag = index === 0 ? 'rdc' : `r${index}`;
  const base = 4 + index * 28;
  const storey = group(structure, `structure-${tag}`, level);
  if (index > 0) {
    const slab = atLevel(level, (props) => props.Catégorie === 'Dalle');
    assert.equal(slab.length, 1);
    leaf(storey, slab[0], `Plancher ${level} — coffrage, ferraillage et coulage`, base - 8, 5);
  }
  const columns = group(storey, `columns-${tag}`, 'Poteaux — progression par travée');
  const columnElements = atLevel(level, (props) => props.Catégorie === 'Poteau').sort(numerical);
  assert.equal(columnElements.length, 12);
  columnElements.forEach((element, position) => leaf(columns, element, `${element.label} — ${level}`, base + Math.floor(position / 2), 2));

  for (const [side, delay] of [['sud', 0], ['nord', 2]]) {
    const facade = group(storey, `facade-${tag}-${side}`, `Façade ${side} — trumeaux, allèges et linteaux`);
    const walls = atLevel(level, (props) => props.Catégorie === 'Mur' && ['Trumeau', 'Allège', 'Linteau'].includes(props.Type))
      .filter((element) => element.label.includes(`façade ${side}`));
    assert.equal(walls.length, 20);
    walls.sort(numerical).forEach((element) => {
      const bay = Number(element.label.match(/façade (?:sud|nord) (\d+)/)?.[1]);
      assert.ok(bay >= 1 && bay <= 5);
      const offset = element.properties.Type === 'Trumeau' ? 4 + Number(element.label.endsWith('droit')) : element.properties.Type === 'Allège' ? 6 : 7;
      leaf(facade, element, `${element.label} — ${level}`, base + delay + (bay - 1) * 2 + offset, element.properties.Type === 'Trumeau' ? 2 : 1);
    });
  }
  const gables = group(storey, `gables-${tag}`, 'Murs pignons');
  const gableElements = atLevel(level, (props) => props.Catégorie === 'Mur' && props.Type === 'Mur').sort(numerical);
  assert.equal(gableElements.length, 2);
  for (const element of gableElements) leaf(gables, element, `${element.label} — ${level}`, base + (element.label.endsWith('ouest') ? 5 : 12), 3);

  // Les lots se chevauchent : les châssis bas peuvent être posés pendant que le gros
  // œuvre continue plus haut. Chaque baie conserve son propre objet et sa propre date.
  const windowsStart = base + 35;
  const windowLevel = group(glazing, `windows-${tag}`, level);
  for (const [side, delay] of [['sud', 0], ['nord', 5]]) {
    const facade = group(windowLevel, `windows-${tag}-${side}`, `Pose des châssis — façade ${side}`);
    const windows = atLevel(level, (props) => props.Catégorie === 'Fenêtre')
      .filter((element) => element.label.includes(`façade ${side}`)).sort(numerical);
    assert.equal(windows.length, 5);
    windows.forEach((element, position) => leaf(facade, element, `${element.label} — ${level}`, windowsStart + delay + position, 1));
  }

  // Le cloisonnement commence après la couverture et la fermeture du niveau.
  const partitionsStart = Math.max(88 + index * 6, windowsStart + 11);
  const partitionLevel = group(partitions, `partitions-${tag}`, level);
  const doorLevel = group(doors, `doors-${tag}`, level);
  for (const [zoneIndex, axis] of [6, 14].entries()) {
    const zone = group(partitionLevel, `partitions-${tag}-${axis}`, `Zone ${zoneIndex + 1} — axe ${axis} m`);
    const labels = [`Cloison ${axis} A`, `Cloison ${axis} B`, `Imposte ${axis}`];
    labels.forEach((label, position) => {
      const matches = atLevel(level, (props) => props.Catégorie === 'Mur').filter((element) => element.label === label);
      assert.equal(matches.length, 1);
      leaf(zone, matches[0], `${label} — ${level}`, partitionsStart + zoneIndex * 3 + position, 2);
    });
    const entry = atLevel(level, (props) => props.Catégorie === 'Porte').find((element) => element.label === `Porte ${axis}`);
    assert.ok(entry);
    leaf(doorLevel, entry, `Pose et réglage ${entry.label.toLowerCase()} — ${level}`, partitionsStart + zoneIndex * 3 + 6, 2);
  }
}

const roofElements = elements.filter((element) => element.properties.Catégorie === 'Toiture');
assert.equal(roofElements.length, 1);
leaf(roof, roofElements[0], 'Toiture-terrasse — support, étanchéité et contrôle', 80, 6);
assert.equal(leafIds.size, modelIds.size, 'Tous les objets du modèle doivent avoir leur tâche');
for (const id of modelIds) assert.ok(leafIds.has(id), `Objet non planifié : ${id}`);

// Parents uniquement graphiques : leurs dates encadrent exactement leurs enfants,
// sans réappliquer la construction à tous les objets d'un étage ou d'un lot.
function flatten(node, parentId) {
  const { children, ...task } = node;
  if (parentId) task.parentId = parentId;
  if (!children) return [task];
  const ordered = children.every((child) => !child.children)
    ? [...children].sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name, 'fr', { numeric: true }))
    : children;
  const descendants = ordered.flatMap((child) => flatten(child, node.id));
  task.start = descendants.reduce((first, child) => child.start < first ? child.start : first, '9999-12-31');
  task.end = descendants.reduce((last, child) => child.end > last ? child.end : last, '0001-01-01');
  return [task, ...descendants];
}
const schedule = {
  type: 'bim-schedule', version: 1,
  name: 'Chantier R+2 · lots, postes et objets — dates fictives',
  tasks: roots.flatMap((root) => flatten(root)),
};
const output = `${JSON.stringify(schedule, null, 2)}\n`;
const outputPath = join(directory, 'demo-planning.json');
if (process.argv.includes('--check')) assert.equal(readFileSync(outputPath, 'utf8'), output, 'Régénérer avec node scripts/make-demo-planning.mjs');
else writeFileSync(outputPath, output);
console.log(`${schedule.tasks.length} lignes : ${roots.length} lots, ${schedule.tasks.length - leafIds.size} regroupements, ${leafIds.size} tâches d'objets ; dates fictives.`);
