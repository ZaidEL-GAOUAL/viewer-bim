import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-semi-condensed/400.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '../styles.css';
import './chantier.css';
import { applyTheme } from '../ui/Shell.ts';
import { ChantierPage } from './ChantierPage.ts';
import { connectBackend, isDemo, localDatabase } from './backend/connect.ts';
import { openKv } from './kv.ts';
import { ChantierStore } from './store.ts';

applyTheme();

void (async () => {
  const backend = await connectBackend().catch(() => null);
  const store = await ChantierStore.open(await openKv(localDatabase()), backend);
  store.autoSync = true;
  const demo = isDemo() && backend && 'offline' in backend ? backend as { offline: boolean } : null;
  const page = new ChantierPage(document.getElementById('app')!, store, {
    demo: demo ? { get offline() { return demo.offline; }, setOffline: (offline) => { demo.offline = offline; } } : undefined,
  });
  // Demander un stockage durable (sinon le navigateur peut effacer un site peu utilisé, surtout sur iPhone).
  void navigator.storage?.persist?.().catch(() => false);
  // La coquille de la page en cache pour démarrer hors ligne : en production seulement, et seulement pour cette page.
  if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('./chantier-sw.js', { scope: './chantier' }).catch(() => undefined);
  // Accès depuis la console du navigateur pendant le développement.
  if (import.meta.env.DEV) Object.assign(window, { chantier: { page, store, backend } });
})();
