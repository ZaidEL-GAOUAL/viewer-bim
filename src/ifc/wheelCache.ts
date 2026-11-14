// Le paquet IfcOpenShell (14,6 Mo) est gardé dans le Cache Storage du navigateur, sous son
// empreinte SHA-256 : une fois téléchargé, il ne l'est plus. Les octets viennent toujours du site
// d'IfcOpenShell vers le navigateur de l'utilisateur ; ce site ne les distribue pas.
// Le cache peut être vidé (Safari), indisponible (fenêtre privée) ou corrompu : chaque accès est
// protégé, l'empreinte est revérifiée à chaque lecture, et on retombe sur le réseau.

const CACHE_NAME = 'ifcopenshell-wheel-v1';

/** Le morceau de l'API Cache dont on a besoin (les tests en fournissent une fausse). */
export interface WheelCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface WheelIo {
  fetch(url: string): Promise<Response>;
  openCache(): Promise<WheelCache>;
}

export interface WheelBytes {
  bytes: ArrayBuffer;
  source: 'cache' | 'network';
}

/** Empreinte SHA-256 des octets, en hexadécimal minuscule. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const browserWheelIo: WheelIo = {
  fetch: (url) => fetch(url),
  openCache: () => caches.open(CACHE_NAME),
};

/**
 * Renvoie les octets du paquet, depuis le cache s'ils y sont et correspondent à l'empreinte,
 * sinon depuis le réseau (puis les range dans le cache). Un paquet du réseau qui ne correspond pas
 * à l'empreinte est refusé et n'est jamais mis en cache.
 */
export async function loadWheel(url: string, sha256: string, io: WheelIo = browserWheelIo): Promise<WheelBytes> {
  const expected = sha256.toLowerCase();
  const key = `${url}?sha256=${expected}`;

  let cache: WheelCache | null = null;
  try {
    cache = await io.openCache();
    const hit = await cache.match(key);
    if (hit) {
      const bytes = await hit.arrayBuffer();
      if ((await sha256Hex(bytes)) === expected) return { bytes, source: 'cache' };
      await cache.delete(key); // entrée abîmée : on la jette et on retélécharge
    }
  } catch {
    // Cache Storage absent, refusé ou en panne : le réseau suffit.
  }

  const response = await io.fetch(url);
  if (!response.ok) throw new Error(`Le téléchargement d’IfcOpenShell a échoué (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  if ((await sha256Hex(bytes)) !== expected) {
    throw new Error('Le paquet IfcOpenShell téléchargé ne correspond pas à la version 0.8.5 attendue : conversion annulée.');
  }
  try {
    await cache?.put(key, new Response(bytes.slice(0)));
  } catch {
    // Quota dépassé ou cache indisponible : le paquet sera simplement retéléchargé la prochaine fois.
  }
  return { bytes, source: 'network' };
}
