import './styles.css';
import { App } from './ui/App.ts';

const app = new App(document.getElementById('app')!);

// Accès depuis la console du navigateur pendant le développement.
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
