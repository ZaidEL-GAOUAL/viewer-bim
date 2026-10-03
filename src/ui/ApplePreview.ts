import { button, h } from './dom.ts';

export type ApplePreviewMode = 'quick-look' | 'model' | 'unavailable';

/** rel="ar" n'ouvre Quick Look que sur les appareils mobiles Apple, même si un Mac le reconnaît. */
export function applePreviewMode(
  device: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>,
  supportsAr: boolean,
  supportsModel: boolean,
): ApplePreviewMode {
  const mobileApple = /iPhone|iPad|iPod/.test(device.userAgent)
    || (/Macintosh/.test(device.userAgent) && device.maxTouchPoints > 1);
  if (mobileApple && supportsAr) return 'quick-look';
  if (supportsModel) return 'model';
  return 'unavailable';
}

interface NativeModelElement extends HTMLElement {
  readonly ready: Promise<unknown>;
}

/** Aperçu rendu par Safari lui-même, sans téléchargement ni viewer JavaScript supplémentaire. */
export class ApplePreview {
  readonly mode = applePreviewMode(navigator, document.createElement('a').relList.supports('ar'),
    'ready' in document.createElement('model'));
  private dialog: HTMLDialogElement | null = null;

  show(url: string | null, name: string): void {
    this.close();
    const title = h('h2', { text: 'Aperçu Apple', attrs: { id: 'apple-preview-title' } });
    const dialog = h('dialog', {
      class: 'apple-preview', attrs: { 'aria-labelledby': 'apple-preview-title' },
    }, h('div', { class: 'apple-preview-heading' }, title,
      button('Fermer', () => dialog.close(), { attrs: { autofocus: '' } })));
    this.dialog = dialog;
    // Échap ferme le dialogue ; les raccourcis du viewer restent inactifs pendant l'aperçu.
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (this.dialog === dialog) this.dialog = null;
    });

    if (this.mode === 'model' && url) {
      const status = h('p', { text: 'Chargement du modèle…', attrs: { role: 'status' } });
      const model = document.createElement('model') as NativeModelElement;
      model.className = 'apple-preview-model';
      model.setAttribute('stagemode', 'orbit');
      model.setAttribute('aria-label', name || 'Maquette 3D');
      model.setAttribute('src', url);
      dialog.append(model, status, h('p', { class: 'apple-preview-hint', text: 'Faites glisser pour tourner le modèle.' }));
      void model.ready.then(() => { status.hidden = true; }).catch(() => {
        model.hidden = true;
        status.textContent = 'Safari ne parvient pas à ouvrir ce modèle dans son aperçu natif. Vous pouvez continuer à le consulter dans le viewer BIM.';
        dialog.querySelector('.apple-preview-hint')?.remove();
      });
    } else {
      dialog.classList.add('apple-preview-unavailable');
      dialog.append(h('p', { text: 'Sur Mac, l’aperçu 3D natif dans la page nécessite Safari 27 ou une version ultérieure.' }),
        h('p', { text: 'Sur iPhone et iPad, ouvrez cette page dans Safari pour utiliser Quick Look. Vous pouvez aussi continuer à consulter la maquette dans le viewer BIM.' }));
    }
    document.body.append(dialog);
    dialog.showModal();
  }

  /** Ferme l'aperçu avant de libérer l'URL ou de changer de modèle. */
  close(): void {
    this.dialog?.close();
    this.dialog?.remove();
    this.dialog = null;
  }
}
