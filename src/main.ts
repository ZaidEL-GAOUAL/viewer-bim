import './styles.css';
import { createViewerApi, registerWebMcp } from './assistant/agentApi.ts';
import { App } from './ui/App.ts';
import { toolContext } from './ui/toolContext.ts';

const app = new App(document.getElementById('app')!);

// Accès depuis la console du navigateur pendant le développement.
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;

// Les outils du chat IA, offerts à tout agent qui pilote cette page : window.viewerBim, et WebMCP
// quand le navigateur le propose.
const api = createViewerApi(() => (app.model ? toolContext(app) : null));
Object.defineProperty(window, 'viewerBim', { value: api, configurable: true });
registerWebMcp(api, (document as { modelContext?: unknown }).modelContext ?? (navigator as { modelContext?: unknown }).modelContext);
