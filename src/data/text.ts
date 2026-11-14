// Texte et nombres à la française, en un seul endroit : comparaison sans accents ni casse,
// pluriels, formats de nombres.

/** Texte comparable : sans accents, sans majuscules, sans espaces autour. « Été » et « ete » se valent. */
export function fold(value: unknown): string {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('fr').trim();
}

export const integer = new Intl.NumberFormat('fr-FR');
export const oneDecimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
/** Quatre décimales au plus, sans séparateur de milliers : ne dénature ni un numéro ni une année. */
export const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4, useGrouping: false });

export const megabytes = (bytes: number): string => Math.round(bytes / 1e6).toLocaleString('fr-FR');

/** « s » à partir de 2, comme le veut le français : « 0 élément », « 1 élément », « 2 éléments ». */
export const s = (count: number): string => (count > 1 ? 's' : '');

/**
 * Une cellule de CSV (`;`) ou de TSV (`\t`) : un texte qui commencerait une formule dans un tableur (= + - @, tabulation,
 * retour) est préfixé de « ' », puis mis entre guillemets s'il le faut. Un nombre, ou un texte qui n'est qu'un nombre
 * (« -5 », « -1 234,5 »), reste un nombre.
 */
export function csvCell(value: string | number, separator = ';'): string {
  const text = typeof value === 'number' || /^-?\d[\d   ]*(?:[.,]\d+)?$/.test(value) || !/^[=+\-@\t\r]/.test(value) ? String(value) : `'${value}`;
  return text.includes(separator) || /["\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** « 1 élément », « 2 éléments », « 0 élément » (le pluriel est `singulier + s` sauf indication). */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${integer.format(count)} ${count > 1 ? pluralForm : singular}`;
