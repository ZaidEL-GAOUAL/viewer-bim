// Identifiants des éléments créés dans le viewer, au format GlobalId de l'IFC (22 caractères),
// pour qu'ils restent valides si le modèle repasse un jour par un IFC.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Compresse 16 octets aléatoires en GlobalId : 2 bits, puis 21 groupes de 6 bits. */
export function guidFromBytes(bytes: Uint8Array): string {
  let bits = 0n;
  for (let i = 0; i < 16; i++) bits = (bits << 8n) | BigInt(bytes[i]);
  let out = '';
  for (let i = 21; i >= 0; i--) {
    const shift = BigInt(i * 6);
    out += ALPHABET[Number((bits >> shift) & 63n)];
  }
  // Le premier caractère ne porte que 2 bits : il est borné à 3.
  return ALPHABET[Number((bits >> 126n) & 3n)] + out.slice(1);
}

export function newGuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return guidFromBytes(bytes);
}
