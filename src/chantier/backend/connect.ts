// Le serveur du suivi de chantier pour cette page : Supabase si l'adresse et la clé publique sont configurées
// (VITE_SUPABASE_URL, VITE_SUPABASE_KEY, dans .env.production et .env.development), sinon aucun (l'appareil seul). En
// développement, `?demo=1` prend le serveur en mémoire (gardé dans ce navigateur) et une base locale à part.

import { openKv } from '../kv.ts';
import type { BackendPort } from './port.ts';

/** Vrai en développement avec `?demo=1` dans l'adresse. */
export const isDemo = (): boolean => import.meta.env.DEV && new URLSearchParams(location.search).has('demo');

/** Le nom de la base de l'appareil (la démonstration a la sienne). */
export const localDatabase = (): string => (isDemo() ? 'suivi-de-chantier-demo' : 'suivi-de-chantier');

export async function connectBackend(): Promise<BackendPort | null> {
  // `import.meta.env.DEV` écrit ici : le serveur de démonstration n'entre pas dans le build de production.
  if (import.meta.env.DEV && isDemo()) {
    const { MemoryBackend, emptyMemoryState } = await import('./memory.ts');
    const kv = await openKv('suivi-de-chantier-demo-serveur');
    const saved = await kv.get('meta', 'server');
    return new MemoryBackend((saved as ReturnType<typeof emptyMemoryState> | undefined) ?? emptyMemoryState(), { persist: (state) => kv.write([{ store: 'meta', key: 'server', value: state }]), resume: true });
  }
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const key = (import.meta.env.VITE_SUPABASE_KEY as string | undefined)?.trim();
  if (!url || !key) return null;
  const { supabaseBackend } = await import('./supabase.ts');
  return supabaseBackend(url, key);
}
