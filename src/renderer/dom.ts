/** Tiny DOM helpers. Text always goes through textContent, never innerHTML. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

/** A button that disables itself while its async handler runs and reports errors instead of throwing. */
export function button(text: string, onClick: () => Promise<unknown> | void, onError: (message: string) => void = console.error): HTMLButtonElement {
  const b = el('button', { text });
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (e) {
      onError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
