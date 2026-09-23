// DOM helpers for the input tests (happy-dom). Owner: O4.
import type { Layout } from '../../src/render/renderer';

export function layoutTall(w = 390, h = 844): Layout {
  const sh = Math.round(h * 0.62);
  return { kind: 'tall', w, h, dpr: 1, scene: { x: 0, y: 0, w, h: sh }, deck: { x: 0, y: sh, w, h: h - sh }, hudTop: 56 };
}

export function layoutWide(w = 1280, h = 720): Layout {
  return { kind: 'wide', w, h, dpr: 1, scene: { x: 0, y: 0, w, h }, deck: null, hudTop: 56 };
}

/** An element in document.body whose getBoundingClientRect returns the given rect. */
export function box(x: number, y: number, w: number, h: number, tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  el.getBoundingClientRect = () => new DOMRect(x, y, w, h);
  document.body.appendChild(el);
  return el;
}

export interface PtrOpts { id?: number; type?: 'touch' | 'mouse' | 'pen'; button?: number; buttons?: number; primary?: boolean }

export function ptr(target: EventTarget, kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, o: PtrOpts = {}): PointerEvent {
  const type = o.type ?? 'touch';
  const down = kind === 'pointerdown' || kind === 'pointermove';
  const e = new PointerEvent(kind, {
    pointerId: o.id ?? 1, pointerType: type, isPrimary: o.primary ?? true, clientX: x, clientY: y,
    button: kind === 'pointermove' ? -1 : (o.button ?? 0), buttons: o.buttons ?? (down ? 1 : 0),
    bubbles: true, cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

export interface KeyOpts { shift?: boolean; ctrl?: boolean; repeat?: boolean; key?: string }

const KEY_OF: Record<string, string> = {
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Space: ' ', Enter: 'Enter', Escape: 'Escape', Backspace: 'Backspace',
  F1: 'F1', Slash: '/', ShiftLeft: 'Shift', Tab: 'Tab', NumpadEnter: 'Enter',
};

export function key(kind: 'keydown' | 'keyup', code: string, o: KeyOpts = {}, target: EventTarget = document.body): KeyboardEvent {
  let k = o.key ?? KEY_OF[code] ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code);
  if (o.shift && k.length === 1) k = k === '/' ? '?' : k.toUpperCase();
  const e = new KeyboardEvent(kind, {
    code, key: k, shiftKey: !!o.shift || (code.startsWith('Shift') && kind === 'keydown'), ctrlKey: !!o.ctrl,
    repeat: !!o.repeat, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}

/** A stand-in for navigator.getGamepads() results. */
export function fakePad(axes: number[] = [0, 0], pressedButtons: number[] = [], index = 0): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressedButtons.includes(i), touched: false, value: pressedButtons.includes(i) ? 1 : 0 }));
  return { axes, buttons, connected: true, id: 'fake', index, mapping: 'standard', timestamp: 0, hapticActuators: [], vibrationActuator: null } as unknown as Gamepad;
}
