// Génère le catalogue des paramètres et des catégories de Revit (revit/src/catalog/*.tsv) à partir
// de Rhino.Inside.Revit (MIT, © Robert McNeel & Associates), dossier
// src/RhinoInside.Revit.External/DB/Schemas/, épinglé sur un commit :
//
//   node scripts/gen-revit-catalog.mjs            génère les trois tables
//   node scripts/gen-revit-catalog.mjs --tokens   liste les mots d'identifiant sans traduction
//   node scripts/gen-revit-catalog.mjs --check    ne génère rien, échoue si les tables diffèrent
//
// Ce qu'on prend à Rhino.Inside : l'identifiant numérique de chaque paramètre intégré, son nom
// d'énumération (WALL_BASE_OFFSET), son identifiant ForgeTypeId ; les groupes de paramètres ; les
// catégories (identifiant, nom OST_, modèle ou annotation). Aucun libellé d'Autodesk n'est copié.
//
// Les libellés français sont les nôtres, écrits dans revit/src/catalog/source/ :
//   parameters-fr.tsv  nom d'énumération ou identifiant, libellé, groupe, nature de la valeur  (à la main)
//   parameter-specs.tsv nom d'énumération, nature de la spec (revit/src/catalog/units.rs)        (à la main)
//   groups-fr.tsv      groupe ForgeTypeId sans version, libellé                                 (à la main)
//   categories-fr.tsv  nom OST_, libellé                                                        (à la main)
//   words-fr.tsv       mot d'identifiant, genre, traduction                                     (rendu automatique)
// Un paramètre, un groupe ou une catégorie sans libellé écrit à la main reçoit un rendu français de
// son identifiant (mots traduits un à un, réordonnés à la française). La colonne « origine » dit
// lequel : m (écrit à la main) ou r (rendu).
//
// Aucune dépendance : Node 18+ et fetch.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Commit de Rhino.Inside.Revit (branche 1.x, 26 octobre 2026). Le changer = régénérer et relire. */
export const SHA = 'c8e2c5c3b6e70f89a3c66d71ee0015c3702d420f';
const BASE = `https://raw.githubusercontent.com/mcneel/rhino.inside-revit/${SHA}/src/RhinoInside.Revit.External/DB/Schemas`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const catalogDir = join(root, 'revit/src/catalog');
const sourceDir = join(catalogDir, 'source');

const args = process.argv.slice(2);
const wantTokens = args.includes('--tokens');
const check = args.includes('--check');

// ---------------------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------------------

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BASE}/${path}`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      if (attempt >= 4) throw new Error(`${path} : ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lecture des tables de Rhino.Inside
// ---------------------------------------------------------------------------------------------

/**
 * ParameterId.Enum.cs (identifiant → nom de propriété et nom d'énumération Revit) et
 * ParameterId.Values.cs (nom de propriété → ForgeTypeId). Le fichier de la racine vaut pour les
 * versions antérieures à 2025 (`#if !REVIT_2025`) ; ceux de 2025, 2026 et 2027 valent chacun pour leur
 * année.
 */
const PARAMETER_SETS = [
  { years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024], dir: '', guard: '#if !REVIT_2025' },
  { years: [2025], dir: '2025/' },
  { years: [2026], dir: '2026/' },
  { years: [2027], dir: '2027/' },
];

const ENUM_ROW = /\{\s*(\w+),\s*(-?\d+)\s*\},\s*\/\/\s*(\w+)/g;
const VALUE_ROW = /public static ParameterId (\w+) => new ParameterId\("([^"]*)"\)/g;

async function readParameterSets() {
  const parameters = new Map(); // id → { names: Map(nom → Set(années)), forge: Map(forge → Set(années)) }
  const notes = [];
  for (const set of PARAMETER_SETS) {
    const [enumText, valuesText] = await Promise.all([get(`${set.dir}ParameterId.Enum.cs`), get(`${set.dir}ParameterId.Values.cs`)]);
    if (set.guard && !enumText.includes(set.guard)) throw new Error(`${set.dir}ParameterId.Enum.cs n'est plus gardé par ${set.guard}`);
    const forgeOf = new Map([...valuesText.matchAll(VALUE_ROW)].map((match) => [match[1], match[2]]));
    for (const [, property, idText, name] of enumText.matchAll(ENUM_ROW)) {
      const id = Number(idText);
      let entry = parameters.get(id);
      if (!entry) parameters.set(id, (entry = { names: new Map(), forge: new Map() }));
      for (const year of set.years) {
        if (!entry.names.has(name)) entry.names.set(name, new Set());
        entry.names.get(name).add(year);
        const forge = forgeOf.get(property);
        if (forge) {
          if (!entry.forge.has(forge)) entry.forge.set(forge, new Set());
          entry.forge.get(forge).add(year);
        } else notes.push(`${set.dir || 'racine/'} : ${name} (${id}) sans ForgeTypeId`);
      }
    }
  }
  return { parameters, notes };
}

const GROUP_ENUM_ROW = /\{\s*(\w+),\s*(-?\d+)\s*\},\s*\/\/\s*(\w+)/g;
const GROUP_VALUE_ROW = /public static ParameterGroup (\w+) => new ParameterGroup\("([^"]*)"\)/g;

async function readGroups() {
  const [enumText, valuesText] = await Promise.all([get('ParameterGroup.Enum.cs'), get('ParameterGroup.Values.cs')]);
  const forgeOf = new Map([...valuesText.matchAll(GROUP_VALUE_ROW)].map((match) => [match[1], match[2]]));
  const groups = [];
  for (const [, property, id, name] of enumText.matchAll(GROUP_ENUM_ROW)) {
    const forge = forgeOf.get(property);
    if (forge) groups.push({ id: Number(id), name, key: stripVersion(forge) });
  }
  return groups;
}

/** « autodesk.parameter.group:constraints-1.0.0 » → « autodesk.parameter.group:constraints ». */
function stripVersion(forge) {
  return forge.replace(/-\d+(\.\d+)*$/, '');
}

const YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027];
const CATEGORY_ROW = /new Definition\(\s*"[^"]*",\s*CT\.(\w+),\s*(?:true|false),\s*\/\*\s*(-?\d+)\*\/\s*BIC\.\w+,\s*\/\*\s*(-?\d+)\*\/\s*BIC\.(\w+),/g;

async function readCategories() {
  const categories = new Map(); // id → { names: Map(nom → Set(années)), kinds: Set }
  for (const year of YEARS) {
    const text = await get(`${year}/BuiltInCategory.cs`);
    const total = (text.match(/new Definition\(/g) ?? []).length;
    let parsed = 0;
    for (const [, kind, , idText, name] of text.matchAll(CATEGORY_ROW)) {
      parsed++;
      const id = Number(idText);
      let entry = categories.get(id);
      if (!entry) categories.set(id, (entry = { names: new Map(), kinds: new Set() }));
      if (!entry.names.has(name)) entry.names.set(name, new Set());
      entry.names.get(name).add(year);
      entry.kinds.add(kind);
    }
    if (parsed !== total) throw new Error(`${year}/BuiltInCategory.cs : ${parsed} lignes lues sur ${total}`);
  }
  return categories;
}

// ---------------------------------------------------------------------------------------------
// Sources écrites à la main
// ---------------------------------------------------------------------------------------------

function readTsv(name) {
  const file = join(sourceDir, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'));
}

/** Clé de parameters-fr.tsv (nom d'énumération ou identifiant) → { label, group, spec }, avant résolution des noms. */
const handParameterRows = readTsv('parameters-fr.tsv').map(([key, label, group, spec]) => ({
  key,
  label,
  // « constraints » → autodesk.parameter.group:constraints ; « revit:curtainGrid » → autodesk.revit.group:curtainGrid ; « - » : aucun.
  group: !group || group === '-' ? '-' : group.includes(':') ? group.replace(/^revit:/, 'autodesk.revit.group:') : `autodesk.parameter.group:${group}`,
  spec: spec || '-',
}));
/**
 * nom d'énumération → nature de la spec (« airFlow »). Le fichier n'enregistre pas la spec d'un paramètre
 * intégré et Rhino.Inside ne la publie pas : cette table, écrite à la main pour les noms qui disent la grandeur
 * sans ambiguïté, passe avant la nature que `specOf` devine. Les natures valides sont celles de
 * revit/src/catalog/units.rs (un essai Rust le vérifie).
 */
const handSpecs = new Map(readTsv('parameter-specs.tsv').map(([key, kind]) => [key, kind]));
const usedSpecs = new Set();
const handGroups = new Map(readTsv('groups-fr.tsv').map(([key, label]) => [key, label]));
/** nom OST_ → libellé. */
const handCategories = new Map(readTsv('categories-fr.tsv').map(([name, label]) => [name, label]));
/** token → { kind, fr } ; kind : nm, nf (noms), a (adjectif « masc|fém »), x (mot ignoré). */
const words = new Map(readTsv('words-fr.tsv').map(([token, kind, fr]) => [token, { kind, fr: fr ?? '' }]));

// ---------------------------------------------------------------------------------------------
// Rendu français d'un identifiant
// ---------------------------------------------------------------------------------------------

const VOWEL = /^[aeiouyàâäéèêëîïôöùûüœh]/i;

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** « de » devant le mot, avec élision (« d'isolation »). */
function de(word) {
  return VOWEL.test(word) && !/^h(?:au|and|ors)/i.test(word) ? `d'${word}` : `de ${word}`;
}

const unknownTokens = new Map();

function lookup(token) {
  const word = words.get(token);
  if (!word) unknownTokens.set(token, (unknownTokens.get(token) ?? 0) + 1);
  return word;
}

/**
 * Rend en français une suite de mots d'identifiant (« WALL », « TOP », « OFFSET »). En anglais un groupe de
 * noms se lit de droite à gauche : le dernier nom est la tête (« Décalage »), ceux qui le précèdent le
 * complètent (« de mur »), et chaque adjectif qualifie le nom qui le suit (« STRUCTURAL SECTION » : « section
 * structurelle »). On met donc la tête d'abord, puis les compléments du plus proche au plus lointain :
 * « STRUCTURAL_SECTION_CANTILEVER_LENGTH » donne « Longueur de porte-à-faux de section structurelle ». Des
 * adjectifs en fin de suite (« …_IS_ATTACHED ») qualifient la tête.
 * @returns {{ text: string, complete: boolean }}
 */
function render(tokens) {
  // « X_PER_Y » : « X par Y ».
  const per = tokens.indexOf('PER');
  if (per > 0 && per < tokens.length - 1) {
    const left = render(tokens.slice(0, per));
    const right = render(tokens.slice(per + 1));
    return { text: `${left.text} par ${right.text.charAt(0).toLowerCase()}${right.text.slice(1)}`, complete: left.complete && right.complete };
  }
  let complete = true;
  const numbers = [];
  /** Groupes nominaux : { noun, adjectives }. */
  const chunks = [];
  let pending = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      numbers.push(token);
      continue;
    }
    const word = lookup(token);
    if (!word) complete = false;
    const item = word ?? { kind: 'nm', fr: token.toLowerCase() };
    if (item.kind === 'x') continue;
    if (item.kind === 'a') {
      pending.push(item);
    } else {
      chunks.push({ noun: item, adjectives: pending });
      pending = [];
    }
  }
  if (chunks.length === 0) {
    // Que des adjectifs : on les rend tels quels, au masculin.
    const text = pending.map((item) => item.fr.split('|')[0]).concat(numbers).join(' ');
    return { text: capitalize(text || tokens.join(' ').toLowerCase()), complete: complete && text !== '' };
  }
  chunks[chunks.length - 1].adjectives.push(...pending);
  const phrase = (chunk) => {
    const kind = /^n([mf])(p?)$/.exec(chunk.noun.kind);
    const feminine = kind?.[1] === 'f';
    const plural = kind?.[2] === 'p';
    const adjectives = chunk.adjectives.map((item) => {
      const [masculine, feminineForm] = item.fr.split('|');
      const form = feminine ? (feminineForm ?? masculine) : masculine;
      return plural && !/[sx]$/.test(form) ? `${form}s` : form;
    });
    return [chunk.noun.fr, ...adjectives].join(' ');
  };
  const head = chunks[chunks.length - 1];
  const parts = [phrase(head)];
  for (let i = chunks.length - 2; i >= 0; i--) parts.push(de(phrase(chunks[i])));
  return { text: capitalize([...parts, ...numbers].join(' ')), complete };
}

/** « OST_StructuralColumns » → ['STRUCTURAL', 'COLUMNS']. */
function camelTokens(name) {
  return name
    .replace(/^OST_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split('_')
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}

// ---------------------------------------------------------------------------------------------
// Classement des paramètres intégrés : nature de la valeur et groupe
// ---------------------------------------------------------------------------------------------

const has = (tokens, ...wanted) => wanted.some((word) => tokens.includes(word));

/**
 * Nature d'une valeur, d'après son nom : L longueur (pieds → m), A surface (pi² → m²), V volume
 * (pi³ → m³), R angle (radians → °), B oui/non (entier 0 ou 1), - autre. Une heuristique, relue à la main pour les
 * paramètres des échantillons (revit/src/catalog/source/parameters-fr.tsv corrige ce qui est faux).
 * Elle ne sert que si la valeur enregistrée est de la bonne sorte (décimale, ou entière pour B).
 */
function specOf(tokens) {
  // « X_PER_Y » : la nature est celle de X (SPACE_AREA_PER_PERSON : une surface ; SPACE_AIRFLOW_PER_AREA : un débit
  // par surface, que la table parameter-specs.tsv précise, mais en aucun cas une surface).
  const per = tokens.indexOf('PER');
  if (per > 0) tokens = tokens.slice(0, per);
  if (has(tokens, 'IS', 'HAS', 'ENABLED', 'ALLOW', 'ALLOWED', 'SHOW', 'VISIBLE', 'FLIPPED', 'HIDDEN', 'BOUNDING', 'ATTACHED', 'LOCKED', 'MIRRORED', 'INCLUDE', 'INCLUDED')) return 'B';
  if (has(tokens, 'FACTOR', 'RATIO', 'COEFFICIENT', 'AIRFLOW', 'MULTIPLIER', 'PERCENT', 'PERCENTAGE', 'SCALE', 'COUNT', 'NUMBER', 'SLOPE', 'GRADE', 'TEMPERATURE', 'FLOW', 'PRESSURE', 'VELOCITY', 'POWER', 'LOAD', 'FORCE', 'MOMENT', 'STRESS', 'DENSITY', 'COST', 'SPEED', 'RESISTANCE', 'CAPACITY', 'CURRENT', 'VOLTAGE', 'FREQUENCY', 'WEIGHT', 'MASS', 'ENERGY', 'HEAT', 'THERMAL', 'LUMINOUS', 'ILLUMINANCE', 'LUMINANCE', 'EFFICIENCY', 'DEMAND', 'VISCOSITY', 'ROUGHNESS', 'FRICTION', 'HUMIDITY', 'TIME', 'DURATION', 'SPACING_TYPE', 'DISTRIBUTION')) return '-';
  if (has(tokens, 'ANGLE', 'ROTATION', 'ROTATE', 'AZIMUTH', 'BEARING')) return 'R';
  if (has(tokens, 'VOLUME')) return 'V';
  if (has(tokens, 'AREA')) return 'A';
  if (has(tokens, 'HEIGHT', 'WIDTH', 'LENGTH', 'THICK', 'THICKNESS', 'DEPTH', 'OFFSET', 'DIAMETER', 'RADIUS', 'DISTANCE', 'ELEVATION', 'SPACING', 'COVER', 'EXTENSION', 'GAP', 'PERIMETER', 'DIM', 'DIMENSION', 'SIZE', 'CLEARANCE', 'ECCENTRICITY', 'MARGIN', 'OVERHANG', 'PROJECTION')) return 'L';
  return '-';
}

/** Groupe de paramètres des intégrés, d'après leur nom : le fichier ne le dit pas (Revit le code en dur). */
function groupOf(tokens) {
  const g = (name) => `autodesk.parameter.group:${name}`;
  if (has(tokens, 'PHASE', 'PHASING')) return g('phasing');
  if (has(tokens, 'IFC')) return g('ifc');
  if (has(tokens, 'MARK', 'COMMENTS', 'DESCRIPTION', 'MANUFACTURER', 'MODEL', 'URL', 'KEYNOTE', 'ASSEMBLY', 'COST', 'IMAGE', 'FAMILY', 'TYPE_NAME', 'NAME')) return g('identityData');
  if (has(tokens, 'CONSTRAINT', 'LEVEL', 'OFFSET', 'ELEVATION', 'BASE', 'TOP')) return g('constraints');
  if (has(tokens, 'MATERIAL', 'FINISH')) return g('materials');
  if (has(tokens, 'HEIGHT', 'WIDTH', 'LENGTH', 'AREA', 'VOLUME', 'THICK', 'THICKNESS', 'DEPTH', 'DIAMETER', 'RADIUS', 'PERIMETER', 'ANGLE', 'SIZE')) return g('geometry');
  if (has(tokens, 'ANALYTICAL')) return g('analyticalModel');
  if (has(tokens, 'STRUCTURAL', 'REBAR')) return g('structural');
  if (has(tokens, 'ELEC', 'ELECTRICAL', 'CIRCUIT', 'PANEL')) return g('electrical');
  if (has(tokens, 'MECHANICAL', 'DUCT', 'HVAC', 'AIR')) return g('mechanical');
  if (has(tokens, 'PIPE', 'PLUMBING', 'FIXTURE')) return g('plumbing');
  if (has(tokens, 'TEXT', 'FONT')) return g('text');
  if (has(tokens, 'GRAPHIC', 'COLOR', 'PATTERN', 'VISIBILITY', 'LINE')) return g('graphics');
  return '-';
}

// ---------------------------------------------------------------------------------------------
// Mise en forme
// ---------------------------------------------------------------------------------------------

/** {2017..2024} → « 17-24 », {2025, 2027} → « 25,27 ». */
function yearsText(years) {
  const sorted = [...years].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const first = String(sorted[i] % 100).padStart(2, '0');
    parts.push(j > i ? `${first}-${String(sorted[j] % 100).padStart(2, '0')}` : first);
    i = j + 1;
  }
  return parts.join(',');
}

const union = (sets) => new Set([...sets].flatMap((set) => [...set]));
const latest = (map) => [...map.entries()].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))[0][0];

function tsv(header, rows) {
  return `${header.map((line) => `# ${line}`).join('\n')}\n${rows.map((row) => row.join('\t')).join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Génération
// ---------------------------------------------------------------------------------------------

const { parameters, notes } = await readParameterSets();
const groups = await readGroups();
const categories = await readCategories();
const report = [];

// -- paramètres
const idsByName = new Map();
for (const [id, entry] of parameters) for (const name of entry.names.keys()) idsByName.set(name, id);
const handParameters = new Map();
const orphanHand = [];
for (const row of handParameterRows) {
  const id = /^-?\d+$/.test(row.key) ? Number(row.key) : idsByName.get(row.key);
  if (id === undefined) orphanHand.push(row.key);
  else handParameters.set(id, row);
}
const conflicts = [];
const parameterRows = [];
let manual = 0;
let rendered = 0;
let incomplete = 0;
for (const id of [...parameters.keys()].sort((a, b) => a - b)) {
  const entry = parameters.get(id);
  if (entry.names.size > 1) conflicts.push(`paramètre ${id} : ${[...entry.names.entries()].map(([name, years]) => `${name} (${yearsText(years)})`).join(' / ')}`);
  const name = latest(entry.names);
  const forge = entry.forge.size > 0 ? latest(entry.forge) : '-';
  const tokens = name.split('_').filter(Boolean);
  const hand = handParameters.get(id);
  let label;
  let origin;
  if (hand?.label) {
    label = hand.label;
    origin = 'm';
    manual++;
  } else {
    const result = render(tokens);
    label = result.text;
    origin = 'r';
    rendered++;
    if (!result.complete) incomplete++;
  }
  const specName = [...entry.names.keys()].find((candidate) => handSpecs.has(candidate));
  if (specName) usedSpecs.add(specName);
  const spec = specName ? handSpecs.get(specName) : hand ? hand.spec : specOf(tokens);
  const group = hand ? hand.group : groupOf(tokens);
  parameterRows.push([id, name, forge.replace('autodesk.revit.parameter:', ''), yearsText(union(entry.names.values())), spec, group, label, origin]);
}
// Des paramètres que Revit emploie et que Rhino.Inside.Revit ne publie pas : on garde leur libellé écrit à la main.
let unpublished = 0;
for (const [id, hand] of handParameters) {
  if (parameters.has(id)) continue;
  unpublished++;
  parameterRows.push([id, '-', '-', '-', hand.spec, hand.group, hand.label, 'm']);
  manual++;
}
parameterRows.sort((a, b) => a[0] - b[0]);
// Un même nom pour deux identifiants.
const byName = new Map();
for (const [id, entry] of parameters) for (const name of entry.names.keys()) byName.set(name, [...(byName.get(name) ?? []), id]);
for (const [name, ids] of byName) if (ids.length > 1) conflicts.push(`nom ${name} : identifiants ${ids.join(', ')}`);
// Des ForgeTypeId qui ne diffèrent que par la version.
let forgeVersions = 0;
for (const entry of parameters.values()) if (entry.forge.size > 1) forgeVersions++;

// -- groupes
const groupRows = groups
  .sort((a, b) => b.id - a.id)
  .map(({ id, name, key }) => {
    const hand = handGroups.get(key);
    const label = hand ?? capitalize(render(camelTokens(key.split(':')[1])).text);
    return [key, id, name, label, hand ? 'm' : 'r'];
  });
// Des groupes que les fichiers emploient et que Rhino.Inside ne liste pas (« dimensions »).
for (const [key, label] of handGroups) if (!groupRows.some((row) => row[0] === key)) groupRows.push([key, 0, '-', label, 'm']);
const groupsManual = groupRows.filter((row) => row[4] === 'm').length;

// -- catégories
const categoryRows = [];
let categoriesManual = 0;
const usedCategories = new Set();
const categoryConflicts = [];
for (const id of [...categories.keys()].sort((a, b) => b - a)) {
  const entry = categories.get(id);
  const live = new Map([...entry.names].filter(([name]) => !/Deprecated/i.test(name)));
  const pool = live.size > 0 ? live : entry.names;
  if (pool.size > 1) categoryConflicts.push(`catégorie ${id} : ${[...pool.entries()].map(([name, years]) => `${name} (${yearsText(years)})`).join(' / ')}`);
  const name = latest(pool);
  const kind = { Model: 'M', Annotation: 'A', Internal: 'I', AnalyticalModel: 'N' }[[...entry.kinds][0]] ?? '?';
  const hand = handCategories.get(name);
  if (hand) usedCategories.add(name);
  const label = hand ?? render(camelTokens(name)).text;
  if (hand) categoriesManual++;
  categoryRows.push([id, name, label, kind, yearsText(union(entry.names.values())), hand ? 'm' : 'r']);
}
const orphanCategories = [...handCategories.keys()].filter((name) => !usedCategories.has(name));
const orphanSpecs = [...handSpecs.keys()].filter((name) => !usedSpecs.has(name));

const outputs = {
  'parameters.tsv': tsv(
    [
      `Paramètres intégrés de Revit, générés par scripts/gen-revit-catalog.mjs (Rhino.Inside.Revit ${SHA}, MIT).`,
      'id  nom d\'énumération  ForgeTypeId  années de Revit  valeur (L m, A m², V m³, R °, B oui/non, - inconnue, ou nature d\'une spec : airFlow, power…)  groupe  libellé français  origine (m main, r rendu)',
    ],
    parameterRows,
  ),
  'groups.tsv': tsv(
    [`Groupes de paramètres de Revit (Rhino.Inside.Revit ${SHA}, MIT), générés par scripts/gen-revit-catalog.mjs.`, 'ForgeTypeId sans version  id  nom d\'énumération  libellé français  origine'],
    groupRows,
  ),
  'categories.tsv': tsv(
    [`Catégories de Revit (Rhino.Inside.Revit ${SHA}, MIT), générées par scripts/gen-revit-catalog.mjs.`, 'id  nom OST_  libellé français  M modèle A annotation I interne N analytique  années  origine'],
    categoryRows,
  ),
};

report.push(`Rhino.Inside.Revit ${SHA}`);
report.push(`paramètres : ${parameterRows.length} identifiants (années ${yearsText(union([...parameters.values()].map((entry) => union(entry.names.values()))))}), ${manual} libellés écrits à la main, ${rendered} rendus (${incomplete} avec un mot non traduit)`);
report.push(`  dont ${unpublished} paramètres absents de Rhino.Inside.Revit (identifiants rencontrés dans des fichiers)`);
report.push(`  ForgeTypeId changeant de version selon l'année : ${forgeVersions}`);
report.push(`groupes : ${groupRows.length}, ${groupsManual} à la main, ${groupRows.length - groupsManual} rendus`);
report.push(`catégories : ${categoryRows.length}, ${categoriesManual} à la main, ${categoryRows.length - categoriesManual} rendues`);
report.push(`conflits d'identifiants : ${conflicts.length + categoryConflicts.length}`);
for (const line of [...conflicts, ...categoryConflicts].slice(0, 40)) report.push(`  ${line}`);
if (notes.length > 0) report.push(`ForgeTypeId absents : ${notes.length} (ex. ${notes.slice(0, 3).join(' ; ')})`);
if (orphanHand.length > 0) report.push(`libellés écrits pour des identifiants inconnus : ${orphanHand.join(', ')}`);
if (orphanCategories.length > 0) report.push(`libellés de catégories pour des identifiants inconnus : ${orphanCategories.join(', ')}`);
if (orphanSpecs.length > 0) report.push(`natures de spec pour des noms inconnus : ${orphanSpecs.join(', ')}`);

if (wantTokens) {
  const sorted = [...unknownTokens.entries()].sort((a, b) => b[1] - a[1]);
  console.log(sorted.map(([token, count]) => `${token}\t${count}`).join('\n'));
  console.error(`${sorted.length} mots sans traduction`);
  process.exit(0);
}

console.log(report.join('\n'));

if (check) {
  let stale = 0;
  for (const [name, text] of Object.entries(outputs)) {
    const file = join(catalogDir, name);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
      console.error(`${name} n'est pas à jour`);
      stale++;
    }
  }
  process.exit(stale > 0 ? 1 : 0);
}

mkdirSync(catalogDir, { recursive: true });
for (const [name, text] of Object.entries(outputs)) writeFileSync(join(catalogDir, name), text);
