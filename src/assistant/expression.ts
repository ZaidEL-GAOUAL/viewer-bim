// Petites formules évaluées par le viewer sur chaque élément, écrites par l'assistant :
//   [Qto_WallBaseQuantities / NetVolume] - [Length] * [Height] * 0.2
//   [Pset_WallCommon / LoadBearing] == true and [FireRating] == null
// Les propriétés sont entre crochets ; nombres, textes entre guillemets, true/false/null,
// + - * /, comparaisons, and/or/not, abs/min/max/round. Rien n'est exécuté comme du code.

import type { PropValue } from '../data/metadata.ts';

export type Value = number | string | boolean | null;

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ref'; path: string }
  | { kind: 'unary'; op: '-' | 'not'; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

interface Token {
  type: 'number' | 'string' | 'ref' | 'word' | 'op' | 'end';
  text: string;
}

const OPERATORS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '/', '(', ')', ','];
const FUNCTIONS = new Set(['abs', 'min', 'max', 'round']);

export class ExpressionError extends Error {}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const c = text[at];
    if (/\s/.test(c)) {
      at++;
      continue;
    }
    if (c === '[') {
      const end = text.indexOf(']', at);
      if (end < 0) throw new ExpressionError('crochet « ] » manquant');
      tokens.push({ type: 'ref', text: text.slice(at + 1, end).trim() });
      at = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, at + 1);
      if (end < 0) throw new ExpressionError('guillemet fermant manquant');
      tokens.push({ type: 'string', text: text.slice(at + 1, end) });
      at = end + 1;
      continue;
    }
    const number = /^\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/i.exec(text.slice(at));
    if (number) {
      tokens.push({ type: 'number', text: number[0].replace(',', '.') });
      at += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
    if (word) {
      tokens.push({ type: 'word', text: word[0].toLowerCase() });
      at += word[0].length;
      continue;
    }
    const op = OPERATORS.find((item) => text.startsWith(item, at));
    if (op) {
      tokens.push({ type: 'op', text: op });
      at += op.length;
      continue;
    }
    throw new ExpressionError(`caractère inattendu « ${c} »`);
  }
  tokens.push({ type: 'end', text: '' });
  return tokens;
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];
  private readonly resolve: (name: string) => string;

  constructor(tokens: Token[], resolve: (name: string) => string) {
    this.tokens = tokens;
    this.resolve = resolve;
  }

  private peek(): Token {
    return this.tokens[this.at];
  }

  private accept(type: Token['type'], text?: string): Token | null {
    const token = this.peek();
    if (token.type === type && (text === undefined || token.text === text)) {
      this.at++;
      return token;
    }
    return null;
  }

  parse(): Node {
    const node = this.or();
    if (this.peek().type !== 'end') throw new ExpressionError(`« ${this.peek().text} » inattendu`);
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.accept('word', 'or')) left = { kind: 'binary', op: 'or', left, right: this.and() };
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.accept('word', 'and')) left = { kind: 'binary', op: 'and', left, right: this.not() };
    return left;
  }

  private not(): Node {
    if (this.accept('word', 'not')) return { kind: 'unary', op: 'not', arg: this.not() };
    return this.comparison();
  }

  private comparison(): Node {
    const left = this.sum();
    for (const op of ['<=', '>=', '==', '!=', '<', '>']) {
      if (this.accept('op', op)) return { kind: 'binary', op, left, right: this.sum() };
    }
    return left;
  }

  private sum(): Node {
    let left = this.product();
    for (;;) {
      if (this.accept('op', '+')) left = { kind: 'binary', op: '+', left, right: this.product() };
      else if (this.accept('op', '-')) left = { kind: 'binary', op: '-', left, right: this.product() };
      else return left;
    }
  }

  private product(): Node {
    let left = this.unary();
    for (;;) {
      if (this.accept('op', '*')) left = { kind: 'binary', op: '*', left, right: this.unary() };
      else if (this.accept('op', '/')) left = { kind: 'binary', op: '/', left, right: this.unary() };
      else return left;
    }
  }

  private unary(): Node {
    if (this.accept('op', '-')) return { kind: 'unary', op: '-', arg: this.unary() };
    return this.primary();
  }

  private primary(): Node {
    const token = this.peek();
    if (this.accept('op', '(')) {
      const node = this.or();
      if (!this.accept('op', ')')) throw new ExpressionError('parenthèse fermante manquante');
      return node;
    }
    if (this.accept('number')) return { kind: 'number', value: Number(token.text) };
    if (this.accept('string')) return { kind: 'string', value: token.text };
    if (this.accept('ref')) return { kind: 'ref', path: this.resolve(token.text) };
    if (this.accept('word')) {
      if (token.text === 'true' || token.text === 'false') return { kind: 'boolean', value: token.text === 'true' };
      if (token.text === 'null' || token.text === 'none' || token.text === 'vide') return { kind: 'null' };
      if (FUNCTIONS.has(token.text)) {
        if (!this.accept('op', '(')) throw new ExpressionError(`« ${token.text} » doit être suivi d'une parenthèse`);
        const args: Node[] = [];
        if (!this.accept('op', ')')) {
          do args.push(this.or());
          while (this.accept('op', ','));
          if (!this.accept('op', ')')) throw new ExpressionError('parenthèse fermante manquante');
        }
        return { kind: 'call', name: token.text, args };
      }
      throw new ExpressionError(`« ${token.text} » inconnu : les propriétés s'écrivent entre crochets, [Nom]`);
    }
    throw new ExpressionError(token.type === 'end' ? 'formule incomplète' : `« ${token.text} » inattendu`);
  }
}

/** Formule compilée : `paths` sont les propriétés qu'elle lit. */
export interface Expression {
  evaluate(lookup: (path: string) => PropValue | undefined): Value;
  paths: string[];
}

function toNumber(value: Value): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(',', '.'));
    return value.trim() === '' ? NaN : parsed;
  }
  return NaN;
}

function truthy(value: Value): boolean {
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value !== '';
  return value === true;
}

function equal(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = toNumber(a);
    const y = toNumber(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a).toLowerCase() === String(b).toLowerCase();
  return String(a).trim().toLocaleLowerCase('fr') === String(b).trim().toLocaleLowerCase('fr');
}

function run(node: Node, lookup: (path: string) => PropValue | undefined): Value {
  switch (node.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'ref': {
      const value = lookup(node.path);
      return value === undefined || value === '' ? null : value;
    }
    case 'unary': {
      const arg = run(node.arg, lookup);
      return node.op === 'not' ? !truthy(arg) : -toNumber(arg);
    }
    case 'call': {
      const args = node.args.map((arg) => toNumber(run(arg, lookup)));
      switch (node.name) {
        case 'abs':
          return Math.abs(args[0] ?? NaN);
        case 'min':
          return Math.min(...args);
        case 'max':
          return Math.max(...args);
        case 'round':
          return args.length > 1 ? Number((args[0] ?? NaN).toFixed(args[1])) : Math.round(args[0] ?? NaN);
        default:
          return NaN;
      }
    }
    case 'binary': {
      if (node.op === 'and') return truthy(run(node.left, lookup)) && truthy(run(node.right, lookup));
      if (node.op === 'or') return truthy(run(node.left, lookup)) || truthy(run(node.right, lookup));
      const left = run(node.left, lookup);
      const right = run(node.right, lookup);
      if (node.op === '==') return equal(left, right);
      if (node.op === '!=') return !equal(left, right);
      const a = toNumber(left);
      const b = toNumber(right);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
        case '>':
          return a > b;
        case '>=':
          return a >= b;
        default:
          return NaN;
      }
    }
    default:
      return null;
  }
}

/** Compile une formule ; `resolve` traduit chaque [référence] en chemin de propriété ou lève une erreur. */
export function compileExpression(text: string, resolve: (name: string) => string): Expression {
  if (text.trim() === '') throw new ExpressionError('formule vide');
  const node = new Parser(tokenize(text), resolve).parse();
  const paths = new Set<string>();
  const collect = (item: Node): void => {
    if (item.kind === 'ref') paths.add(item.path);
    else if (item.kind === 'unary') collect(item.arg);
    else if (item.kind === 'binary') {
      collect(item.left);
      collect(item.right);
    } else if (item.kind === 'call') item.args.forEach(collect);
  };
  collect(node);
  return { evaluate: (lookup) => run(node, lookup), paths: [...paths] };
}
