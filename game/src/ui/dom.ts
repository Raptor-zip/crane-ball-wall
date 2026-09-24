// Tiny DOM builder shared by the UI modules. Owner: O7.

export type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(el: Element, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) {
    for (const x of c) append(el, x);
    return;
  }
  el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
}

function setAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') {
      el.addEventListener(k.startsWith('on') ? k.slice(2) : k, v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

/** HTML element: h('button', { class: 'btn', onclick: fn }, 'Go'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  for (const c of children) append(el, c);
  return el;
}

/** SVG element in the SVG namespace. */
export function s(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  setAttrs(el, attrs);
  for (const c of children) append(el, c);
  return el;
}

/** Parses a trusted, code-owned SVG string (icons only). */
export function svgFrom(markup: string): SVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild as SVGElement;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Sets textContent only when it changed (the HUD calls this every frame). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/**
 * Descendants in the Tab order, in DOM order (focus trapping). The items of a roving group that are not its tab stop
 * (tabindex="-1": the other tabs, the other skin cards) are left out: Tab never lands on them.
 */
export function focusables(root: Element): HTMLElement[] {
  const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((e) => e.tabIndex >= 0 && !e.closest('[hidden]') && !e.closest('[inert]'));
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Modal overlay inside `root`: every other child of `root` becomes inert (not focusable, not clickable, hidden from
 * assistive tech) until the returned function is called.
 */
export function makeModal(root: Element, keep: Element): () => void {
  const changed: Element[] = [];
  for (const c of Array.from(root.children)) {
    if (c === keep || c.hasAttribute('inert')) continue;
    c.setAttribute('inert', '');
    changed.push(c);
  }
  return () => {
    for (const c of changed) c.removeAttribute('inert');
  };
}
