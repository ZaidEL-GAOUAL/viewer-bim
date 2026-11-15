// Suivi de chantier (chantier.html) : la coquille de la page (le HTML, ses scripts, ses styles, ses icônes) gardée pour démarrer
// sans réseau. Jamais les réponses du serveur de données (autre origine) ni les photos : les données viennent d'IndexedDB.
// Enregistré par chantier.html seulement, en production, avec la portée « ./chantier » : le viewer et l'étude de site ne passent
// jamais par lui.

const CACHE = 'suivi-de-chantier-v1';
const PAGE = 'chantier.html';

/**
 * Garde la page et les fichiers qu'elle cite (scripts, styles, manifeste, icônes), puis les morceaux que ses scripts chargent à
 * la demande (connexion au serveur, rapport PDF) : la page démarre et sert hors ligne dès la première visite.
 */
async function storePage(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  await cache.put(PAGE, response);
  const page = new URL(PAGE, self.registration.scope);
  const queue = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]).filter((url) => !/^(?:[a-z]+:|\/\/|#)/i.test(url)).map((url) => new URL(url, page));
  const seen = new Set();
  while (queue.length > 0 && seen.size < 60) {
    const url = queue.shift();
    if (url.origin !== self.location.origin || seen.has(url.href)) continue;
    seen.add(url.href);
    const asset = await fetch(url);
    if (!asset.ok) continue;
    await cache.put(url, asset.clone());
    if (url.pathname.endsWith('.js')) for (const match of (await asset.text()).matchAll(/["'`](\.\.?\/[^"'`\s]+\.js)["'`]/g)) queue.push(new URL(match[1], url));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(fetch(PAGE, { cache: 'no-cache' }).then((response) => (response.ok ? storePage(response) : undefined)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('suivi-de-chantier-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // La page : le réseau d'abord (une version plus récente), la copie gardée s'il ne répond pas dans les 4 secondes.
    event.respondWith((async () => {
      try {
        const response = await Promise.race([fetch(request), new Promise((_, reject) => setTimeout(() => reject(new Error('réseau lent')), 4000))]);
        if (response.ok) event.waitUntil(storePage(response.clone()).catch(() => undefined));
        return response;
      } catch {
        return (await caches.match(PAGE)) ?? Response.error();
      }
    })());
    return;
  }
  // Scripts, styles, icônes : leur nom change à chaque version, la copie gardée d'abord ; un morceau chargé à la demande
  // (rapport PDF, connexion au serveur) est gardé à sa première utilisation.
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
    if (response.ok && url.pathname.includes('/assets/')) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
    }
    return response;
  })));
});
