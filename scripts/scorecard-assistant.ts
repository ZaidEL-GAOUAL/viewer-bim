// Barème « indépendant du modèle » : pour chaque fournisseur enregistré par scripts/record-assistant.ts,
// combien de phrases du corpus donnent l'action attendue une fois relues par parseAction (couche 2),
// et, pour comparaison, combien la couche 1 (sans modèle) en traite seule. Lit seulement les
// enregistrements de tests/fixtures/assistant/replies/recorded/ : aucun appel réseau, aucun quota.
//
//   node scripts/scorecard-assistant.ts

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAction, type Action, type ProtocolError } from '../src/assistant/protocol.ts';
import { fold } from '../src/data/text.ts';

export type Expect = null | { undo: true } | { ambiguity: string[] } | { tool: string; args: Record<string, unknown> };
export type Score = 'ok' | 'wrong' | 'invalid' | 'skipped';

type Loose = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? fold(value) : JSON.stringify(value));
const conditions = (list: unknown) => (Array.isArray(list) ? list : []).map((item: Loose) => `${text(item.property)}|${item.op ?? 'equals'}|${item.op === 'missing' ? '' : text(item.value)}`).sort().join(' & ');
/** Ce qui compte dans une valeur d'argument : filtres comme ensembles, règles par conditions et effet (ni id ni nom), textes sans accents ni casse. */
function normal(key: string, value: unknown): string {
  if (key === 'filters') return conditions(value);
  if (key === 'rules') return (Array.isArray(value) ? value : []).map((rule: Loose) => `${conditions(rule.conditions)}|${text(rule.color ?? '')}|${rule.opacity ?? ''}`).join(' ; ');
  return Array.isArray(value) ? value.map(text).join(' > ') : text(value);
}

/** Une réponse relue, comparée à l'attente du corpus. Une question posée au lieu d'agir compte juste quand la phrase est ambiguë. */
export function scoreAction(action: Action | ProtocolError, expect: Expect): Score {
  if (expect === null || 'undo' in expect) return 'skipped';
  if ('error' in action) return 'invalid';
  if ('ambiguity' in expect) return 'answer' in action ? 'ok' : 'wrong';
  if ('answer' in action || action.tool !== expect.tool) return 'wrong';
  for (const [key, value] of Object.entries(expect.args)) if (normal(key, value) !== normal(key, action.args[key])) return 'wrong';
  // Une action de plus que demandé (isoler au lieu de sélectionner) est fausse ; les défauts explicites ne le sont pas.
  for (const [key, value] of Object.entries(action.args)) if (!(key in expect.args) && value === true) return 'wrong';
  return 'ok';
}

function main(): void {
  const root = join(fileURLToPath(new URL('..', import.meta.url)));
  const corpus = JSON.parse(readFileSync(join(root, 'tests/fixtures/assistant/corpus.json'), 'utf8')) as { cases: { text: string; expect: Expect }[] };
  const folder = join(root, 'tests/fixtures/assistant/replies/recorded');
  if (!existsSync(folder)) {
    console.log('Aucun enregistrement : lancez d’abord scripts/record-assistant.ts (il appelle un modèle et consomme du quota).');
    return;
  }
  const scored = corpus.cases.filter((item) => item.expect !== null && !('undo' in item.expect)).length;
  console.log(`Corpus : ${corpus.cases.length} phrases, dont ${scored} notées (les refus attendus de la couche 1 et « annule » ne le sont pas).\n`);
  for (const provider of readdirSync(folder).filter((name) => !name.startsWith('.') && !name.startsWith('._'))) {
    const totals: Record<Score, number> = { ok: 0, wrong: 0, invalid: 0, skipped: 0 };
    let model = '';
    const misses: string[] = [];
    for (const file of readdirSync(join(folder, provider)).filter((name) => name.endsWith('.json') && !name.startsWith('._'))) {
      const record = JSON.parse(readFileSync(join(folder, provider, file), 'utf8')) as { case: number; text: string; model: string; raw: string | null };
      model = record.model;
      // Le corpus a pu bouger depuis l'enregistrement : la phrase fait foi, le numéro sert de repli.
      const item = corpus.cases.find((candidate) => candidate.text === record.text) ?? corpus.cases[record.case];
      if (!item) continue;
      const score = record.raw === null ? 'invalid' : scoreAction(parseAction(record.raw), item.expect);
      totals[score]++;
      if (score === 'wrong' || score === 'invalid') misses.push(`  ${score === 'wrong' ? '≠' : '✗'} « ${item.text} » → ${(record.raw ?? '(erreur HTTP)').slice(0, 140).replace(/\s+/g, ' ')}`);
    }
    const graded = totals.ok + totals.wrong + totals.invalid;
    console.log(`${provider} (${model}) : ${totals.ok}/${graded} actions attendues, ${totals.wrong} autres actions, ${totals.invalid} sorties illisibles.`);
    for (const line of misses.slice(0, 15)) console.log(line);
    if (misses.length > 15) console.log(`  … et ${misses.length - 15} autres.`);
    console.log('');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
