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

export const integer = new Intl.NumberFormat('fr-FR');
