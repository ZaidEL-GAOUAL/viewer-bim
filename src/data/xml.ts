// XML sans DOM : un lecteur strict et minimal (éléments, attributs, texte, commentaires, CDATA), le même dans le navigateur
// et dans les tests, et un écrivain qui échappe tout ce qu'il écrit. Servent à l'IDS (data/requirements.ts) et au BCF
// (data/bcf.ts). Les préfixes d'espace de noms sont retirés à la lecture (`ids:entity` → `entity`).

export interface XmlNode {
  /** Nom local, sans préfixe d'espace de noms. */
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// Les entités propres au document (DOCTYPE) ne sont jamais développées : une entité inconnue est une erreur.
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code: string) => {
  if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  if (!Object.hasOwn(ENTITIES, code)) throw new Error(`Entité XML inconnue : ${all}`);
  return ENTITIES[code];
});
const local = (name: string) => name.slice(name.indexOf(':') + 1);

/** Caractères au plus d'un document, et éléments imbriqués au plus : au-delà, refusé avec un message. */
export const MAX_XML_LENGTH = 50_000_000;
export const MAX_XML_DEPTH = 256;

/** Ce qui se saute jusqu'à sa fin, cherchée une seule fois (jamais de retour en arrière sur un début sans fin). */
const SKIPPED: [opening: string, closing: string][] = [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>'], ['<!DOCTYPE', '>']];
const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

/** Lit un document XML ; rend la racine `#document`, dont l'élément principal est le premier enfant. */
export function parseXml(xml: string): XmlNode {
  if (xml.length > MAX_XML_LENGTH) throw new Error(`XML trop grand (plus de ${MAX_XML_LENGTH / 1e6} millions de caractères).`);
  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let at = 0;
  for (let open = xml.indexOf('<'); open >= 0; open = xml.indexOf('<', at)) {
    const top = stack[stack.length - 1];
    top.text += decode(xml.slice(at, open));
    const skipped = SKIPPED.find(([opening]) => xml.startsWith(opening, open));
    if (skipped) {
      const [opening, closing] = skipped;
      const end = xml.indexOf(closing, open + opening.length);
      if (end < 0) throw new Error(`XML mal formé : ${opening} sans fin.`);
      if (opening === '<![CDATA[') top.text += xml.slice(open + opening.length, end);
      at = end + closing.length;
      continue;
    }
    TAG.lastIndex = open;
    const match = TAG.exec(xml);
    if (!match) throw new Error('XML mal formé : balise illisible.');
    at = TAG.lastIndex;
    const name = local(match[2]);
    if (match[1]) {
      if (stack.length < 2 || top.name !== name) throw new Error(`XML mal formé : </${match[2]}> ne ferme rien.`);
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of match[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[local(attribute[1])] = decode(attribute[2] ?? attribute[3]);
    const node: XmlNode = { name, attributes, children: [], text: '' };
    top.children.push(node);
    if (match[4]) continue;
    if (stack.length > MAX_XML_DEPTH) throw new Error(`XML mal formé : plus de ${MAX_XML_DEPTH} niveaux d’imbrication.`);
    stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`XML mal formé : <${stack[stack.length - 1].name}> n’est pas fermé.`);
  return root;
}

export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined => node?.children.find((item) => item.name === name);
export const children = (node: XmlNode | undefined, name: string): XmlNode[] => node?.children.filter((item) => item.name === name) ?? [];

// ------------------------------------------------------------------ écriture

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Le texte prêt pour XML : caractères interdits par XML 1.0 retirés, `& < > " '` échappés. */
export const escapeXml = (text: string): string =>
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

type Attributes = Record<string, string | number | boolean | undefined>;
const attributesText = (attributes: Attributes): string =>
  Object.entries(attributes).filter(([, value]) => value !== undefined).map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`).join('');

/** Un élément qui contient des éléments déjà écrits (les vides sont ignorés). */
export function xmlElement(name: string, attributes: Attributes, content: readonly string[]): string {
  const inner = content.filter(Boolean).join('');
  return inner ? `<${name}${attributesText(attributes)}>${inner}</${name}>` : `<${name}${attributesText(attributes)}/>`;
}

/** Un élément texte ; une valeur absente n'écrit rien. */
export const xmlText = (name: string, value: string | number | undefined, attributes: Attributes = {}): string =>
  value === undefined ? '' : `<${name}${attributesText(attributes)}>${escapeXml(String(value))}</${name}>`;
