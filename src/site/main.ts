import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-semi-condensed/400.css';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import '../styles.css';
import './site.css';
import { SitePage } from './SitePage.ts';
import { applyTheme } from '../ui/Shell.ts';

applyTheme();

const page = new SitePage(document.getElementById('app')!);

// Accès depuis la console du navigateur pendant le développement.
if (import.meta.env.DEV) (window as unknown as { site: SitePage }).site = page;
