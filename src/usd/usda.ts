// Lecture du format USD texte (usda). Sous-ensemble suffisant pour les fichiers de ce projet
// et pour des scènes simples : prims, attributs, relations, métadonnées de prim (références,
// customData), grands tableaux numériques.

export type UsdValue = string | number | boolean | null | UsdPath | UsdValue[] | Float64Array | Int32Array | UsdDictionary;
export type UsdDictionary = { [key: string]: UsdValue };
export interface UsdPath {
  path: string;
}

export interface UsdAttribute {
  type: string;
  value: UsdValue | undefined;
  /** Métadonnées entre parenthèses après la valeur (interpolation, par exemple). */
  meta: UsdDictionary;
}

export interface UsdPrim {
  specifier: 'def' | 'class' | 'over';
  type: string;
  name: string;
  path: string;
  meta: UsdDictionary;
  attributes: Map<string, UsdAttribute>;
  relationships: Map<string, UsdPath[]>;
  children: UsdPrim[];
}

export interface UsdLayer {
  meta: UsdDictionary;
  prims: UsdPrim[];
  /** Tous les prims, par chemin. */
  byPath: Map<string, UsdPrim>;
}

const NUMERIC_ARRAY = /^(int|uint|float|double|half|point3[fdh]|normal3[fdh]|vector3[fdh]|color3[fdh]|float[234]|double[234]|int[234]|texCoord2[fdh])\[\]$/;
const LIST_OPS = new Set(['prepend', 'append', 'delete', 'add', 'reorder']);
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_:.]/;

class Parser {
  private at = 0;
  private readonly text: string;
  readonly byPath = new Map<string, UsdPrim>();

  constructor(text: string) {
    this.text = text;
  }

  error(message: string): never {
    const line = this.text.slice(0, this.at).split('\n').length;
    throw new Error(`Fichier USD illisible (ligne ${line}) : ${message}`);
  }

  // ----------------------------------------------------------------- lexique

  skipSpace(): void {
    const text = this.text;
    for (;;) {
      const c = text.charCodeAt(this.at);
      if (c === 32 || c === 9 || c === 10 || c === 13) this.at++;
      else if (c === 35 /* # */) {
        while (this.at < text.length && text.charCodeAt(this.at) !== 10) this.at++;
      } else break;
    }
  }

  peek(): string {
    this.skipSpace();
    return this.text[this.at] ?? '';
  }

  accept(char: string): boolean {
    if (this.peek() === char) {
      this.at++;
      return true;
    }
    return false;
  }

  expect(char: string): void {
    if (!this.accept(char)) this.error(`« ${char} » attendu`);
  }

  identifier(): string {
    this.skipSpace();
    const start = this.at;
    if (!IDENTIFIER_START.test(this.text[this.at] ?? '')) this.error('identifiant attendu');
    while (this.at < this.text.length && IDENTIFIER_PART.test(this.text[this.at])) this.at++;
    return this.text.slice(start, this.at);
  }

  /** Nom de type, avec son éventuel suffixe de tableau (`point3f[]`). */
  typeName(word: string): string {
    if (this.text.startsWith('[]', this.at)) {
      this.at += 2;
      return `${word}[]`;
    }
    return word;
  }

  string(): string {
    this.skipSpace();
    const quote = this.text[this.at];
    if (quote !== '"' && quote !== "'") this.error('chaîne attendue');
    if (this.text.startsWith(quote.repeat(3), this.at)) {
      const end = this.text.indexOf(quote.repeat(3), this.at + 3);
      if (end < 0) this.error('chaîne non terminée');
      const value = this.text.slice(this.at + 3, end);
      this.at = end + 3;
      return value;
    }
    let out = '';
    this.at++;
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) this.error('chaîne non terminée');
      this.at++;
      if (c === quote) break;
      if (c === '\\') {
        const next = this.text[this.at++];
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      } else out += c;
    }
    return out;
  }

  path(): UsdPath {
    this.expect('<');
    const end = this.text.indexOf('>', this.at);
    if (end < 0) this.error('chemin non terminé');
    const path = this.text.slice(this.at, end);
    this.at = end + 1;
    return { path };
  }

  /** Lit tous les nombres jusqu'au crochet fermant, sans passer par les valeurs intermédiaires. */
  numberArray(integer: boolean): Float64Array | Int32Array {
    const text = this.text;
    let depth = 1;
    let end = this.at;
    while (end < text.length && depth > 0) {
      const c = text.charCodeAt(end);
      if (c === 91) depth++;
      else if (c === 93) depth--;
      end++;
    }
    if (depth !== 0) this.error('tableau non terminé');
    const slice = text.slice(this.at, end - 1);
    this.at = end;
    const parts = slice.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|-?inf|nan/g) ?? [];
    const out = integer ? new Int32Array(parts.length) : new Float64Array(parts.length);
    for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
    return out;
  }

  // ----------------------------------------------------------------- valeurs

  value(): UsdValue {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === '<') return this.path();
    if (c === '[') {
      this.at++;
      const items: UsdValue[] = [];
      while (!this.accept(']')) {
        items.push(this.value());
        this.accept(',');
      }
      return items;
    }
    if (c === '(') {
      this.at++;
      const items: UsdValue[] = [];
      while (!this.accept(')')) {
        items.push(this.value());
        this.accept(',');
      }
      return items;
    }
    if (c === '{') return this.dictionary();
    if (/[-+.\d]/.test(c)) {
      const match = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.text.slice(this.at, this.at + 64));
      if (!match) this.error('nombre attendu');
      this.at += match[0].length;
      return Number(match[0]);
    }
    const word = this.identifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'None') return null;
    return word;
  }

  /** Dictionnaire typé : `string nom = "..."`, `dictionary nom = { ... }`… */
  dictionary(): UsdDictionary {
    this.expect('{');
    const out: UsdDictionary = {};
    while (!this.accept('}')) {
      const type = this.typeName(this.identifier());
      const key = this.peek() === '"' ? this.string() : this.identifier();
      this.expect('=');
      const value = type === 'dictionary' ? this.dictionary() : NUMERIC_ARRAY.test(type) && this.peek() === '[' ? (this.at++, this.numberArray(type.startsWith('int') || type.startsWith('uint'))) : this.value();
      out[key] = value;
      this.accept(';');
    }
    return out;
  }

  /** Métadonnées entre parenthèses : `clé = valeur`, avec opérateurs de liste éventuels. */
  metadata(): UsdDictionary {
    const out: UsdDictionary = {};
    if (!this.accept('(')) return out;
    while (!this.accept(')')) {
      if (this.peek() === '"') {
        // Commentaire de documentation nu.
        out.doc = this.string();
        continue;
      }
      let key = this.identifier();
      if (LIST_OPS.has(key)) key = this.identifier();
      if (key === 'dictionary') key = this.identifier();
      if (this.accept('=')) {
        out[key] = key === 'customData' || key === 'assetInfo' ? this.dictionary() : this.value();
      }
      this.accept(';');
    }
    return out;
  }

  // ------------------------------------------------------------------- prims

  layer(): UsdLayer {
    if (!this.text.startsWith('#usda')) this.error('ce n’est pas un fichier USD texte (usda)');
    const meta = this.metadata();
    const prims: UsdPrim[] = [];
    while (this.peek() !== '') prims.push(this.prim(''));
    return { meta, prims, byPath: this.byPath };
  }

  prim(parentPath: string): UsdPrim {
    const specifier = this.identifier() as UsdPrim['specifier'];
    if (specifier !== 'def' && specifier !== 'class' && specifier !== 'over') this.error(`« ${specifier} » inattendu`);
    let type = '';
    if (this.peek() !== '"') type = this.identifier();
    const name = this.string();
    const path = `${parentPath}/${name}`;
    const prim: UsdPrim = { specifier, type, name, path, meta: this.metadata(), attributes: new Map(), relationships: new Map(), children: [] };
    this.byPath.set(path, prim);
    this.expect('{');
    while (!this.accept('}')) this.statement(prim);
    return prim;
  }

  statement(prim: UsdPrim): void {
    const save = this.at;
    let word = this.identifier();
    if (word === 'def' || word === 'class' || word === 'over') {
      this.at = save;
      prim.children.push(this.prim(prim.path));
      return;
    }
    while (word === 'custom' || word === 'uniform' || word === 'varying' || LIST_OPS.has(word)) word = this.identifier();
    if (word === 'rel') {
      const name = this.identifier();
      let targets: UsdPath[] = [];
      if (this.accept('=')) {
        const value = this.value();
        targets = Array.isArray(value) ? (value as UsdPath[]) : [value as UsdPath];
      }
      prim.relationships.set(name, targets);
      this.metadata();
      return;
    }
    const type = this.typeName(word);
    const name = this.identifier();
    let value: UsdValue | undefined;
    if (this.accept('=')) {
      value = NUMERIC_ARRAY.test(type) && this.peek() === '[' ? (this.at++, this.numberArray(type.startsWith('int') || type.startsWith('uint'))) : this.value();
    }
    const meta = this.metadata();
    prim.attributes.set(name, { type, value, meta });
  }
}

export function parseUsda(text: string): UsdLayer {
  return new Parser(text).layer();
}
