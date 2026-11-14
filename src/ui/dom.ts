type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** Crée un élément HTML avec ses classes, ses attributs et ses enfants. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  if (props.attrs) for (const [name, value] of Object.entries(props.attrs)) element.setAttribute(name, value);
  for (const child of children) if (child) element.append(child);
  return element;
}

export function button(label: string, onClick: (event: MouseEvent) => void, props: Props = {}): HTMLButtonElement {
  const element = h('button', { ...props, attrs: { type: 'button', ...props.attrs } }, label);
  element.addEventListener('click', onClick);
  return element;
}

export function clear(element: Element): void {
  element.replaceChildren();
}

/** Fait télécharger `blob` par le navigateur sous ce nom de fichier. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  h('a', { attrs: { href: url, download: filename } }).click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `localStorage` sans exception : en navigation privée ou stockage bloqué, rien n'est lu ni gardé et le choix ne vaut que pour la session. */
export const stored = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  /** Une valeur vide (ou null) efface la clé. */
  set(key: string, value: string | null): void {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      // stockage indisponible
    }
  },
};
