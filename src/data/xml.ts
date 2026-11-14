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
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code: string) => {
  if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10));
  const entity = ENTITIES[code];
  if (entity === undefined) throw new Error(`Entité XML inconnue : ${all}`);
  return entity;
});
const local = (name: string) => name.slice(name.indexOf(':') + 1);

/** Lit un document XML ; rend la racine `#document`, dont l'élément principal est le premier enfant. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let at = 0;
  for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
    const between = xml.slice(at, match.index);
    if (between.includes('<')) throw new Error('XML mal formé : balise illisible.');
    stack[stack.length - 1].text += decode(between);
    at = tag.lastIndex;
    if (match[1] !== undefined) stack[stack.length - 1].text += match[1];
    if (!match[3]) continue; // commentaire, déclaration
    const name = local(match[3]);
    if (match[2]) {
      if (stack.length < 2 || stack[stack.length - 1].name !== name) throw new Error(`XML mal formé : </${match[3]}> ne ferme rien.`);
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of match[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[local(attribute[1])] = decode(attribute[2] ?? attribute[3]);
    const node: XmlNode = { name, attributes, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!match[5]) stack.push(node);
  }
  if (xml.slice(at).includes('<')) throw new Error('XML mal formé : balise illisible.');
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
