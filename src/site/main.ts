import '../styles.css';
import './site.css';
import { SitePage } from './SitePage.ts';

const page = new SitePage(document.getElementById('app')!);

// Accès depuis la console du navigateur pendant le développement.
if (import.meta.env.DEV) (window as unknown as { site: SitePage }).site = page;
