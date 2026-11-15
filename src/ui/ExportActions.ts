import { capturePng } from '../engine/capture.ts';
import { withoutExtension } from '../engine/fileKinds.ts';
import type { App } from './App.ts';
import { button, download } from './dom.ts';
import { DxfDialog } from './DxfDialog.ts';
import { PrintDialog } from './PrintDialog.ts';

/** Pourquoi les trois exports image sont grisés en mode carte : le globe dessine la maquette, pas le viewer. */
export const MAP_MODE_REASON = 'Indisponible en mode carte : la maquette y est dessinée par le globe. Fermez la carte pour imprimer, exporter ou copier la vue.';

/** Largeur de l'image copiée : celle de l'écran, à la densité de l'écran (2 au plus). */
async function copyImage(app: App): Promise<void> {
  const { viewer } = app;
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const { width, height } = viewer.size;
  await viewer.cut.ready();
  const png = capturePng(viewer, Math.round(width * scale), Math.round(height * scale), { lineScale: scale });
  try {
    // Le presse-papiers reçoit la promesse : Safari exige l'appel dans le geste de l'utilisateur.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    app.toast('Image copiée.');
  } catch {
    download(await png, `${withoutExtension(app.fileName || 'maquette')}.png`);
    app.toast('Le presse-papiers refuse l’image : elle est téléchargée.');
  }
}

/**
 * Les trois exports de la vue affichée : « Imprimer / PDF… » et « DXF… » ouvrent leur carte, « Copier l'image » copie la vue
 * (PNG). `buttons` va dans la zone des exports de la barre d'outils, `cards` avec les autres cartes.
 */
export class ExportActions {
  readonly buttons: HTMLButtonElement[];
  readonly cards: HTMLElement[];

  constructor(app: App) {
    const print = new PrintDialog(app), dxf = new DxfDialog(app);
    this.buttons = [
      button('Imprimer en PDF…', () => print.toggle(), { title: 'Imprimer la vue, à l’échelle pour un plan ou une coupe, en PDF' }),
      button('DXF…', () => dxf.toggle(), { title: 'DXF (AutoCAD, BricsCAD, Revit) : les lignes de coupe du plan ou de la coupe affichée' }),
      button('Copier l’image', () => void copyImage(app).catch((error) => app.toast(error instanceof Error ? error.message : String(error), true)), { title: 'Copier la vue (PNG) dans le presse-papiers' }),
    ];
    this.cards = [print.el, dxf.el];
    const titles = this.buttons.map((item) => item.title);
    const sync = () => this.buttons.forEach((item, i) => {
      item.disabled = app.mapOpen;
      item.title = app.mapOpen ? MAP_MODE_REASON : titles[i];
    });
    app.viewer.onExternalCameraChange.add(sync);
    app.on('model', sync);
  }
}
