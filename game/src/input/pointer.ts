// Touch (deck clutch drag / absolute) and mouse drag (GAME_DESIGN.md §3.3). Owner: O4.
//
// tall layout: anywhere in the deck is a *relative clutch drag*. On touch-down we store (px0, xt0)
//   (xt0 = the current target, else the trolley x) and then x_t = xt0 + k (px - px0) (rail1 - rail0) / deckWidthPx.
//   The deck width always spans the whole rail, so the mapping never depends on the follow camera.
//   Fine band: the bottom third of the control surface (deck minus the 8 px force bar and 72 px mini
//   rail) uses k = 1/3 and fine = true; the band is chosen at touch-down and kept for the whole drag.
// wide layout: below the HUD band, x_t = mapper.screenToRailX(clientX, clientY) (absolute; the mapper
//   uses the unshaken reference camera).
// Mouse: only while the left button is held (never on hover). tall + mouse = deck clutch drag.
//   Right click = retry. Only the first pointer counts; a second finger is ignored.
import type { Layout, Rect } from '../render/renderer';
import type { DeviceTag } from '../sim/replay';
import type { Command, RailMapper } from './types';

/** Deck content above the control surface (§3.3): force bar 8 px + mini rail 72 px. */
export const DECK_LAYOUT = { forceBarPx: 8, miniRailPx: 72 } as const;
/** Fine band: the bottom third of the control surface, with a third of the sensitivity (Appendix A). */
export const FINE_BAND = { frac: 1 / 3, gain: 1 / 3 } as const;

const TAG_TOUCH = 1 as DeviceTag;
const TAG_MOUSE = 2 as DeviceTag;

/** Elements whose presses belong to the UI, never to the trolley (buttons inside the scene/deck etc.). */
const UI_SELECTOR = 'button, a[href], input, select, textarea, summary, [role="button"], [data-no-input]';
/** The deck's control surface element: [data-input-surface], or O7's `.deck-surface` (src/ui/deck.ts). */
export const SURFACE_SELECTOR = '[data-input-surface], .deck-surface';

export interface Box { left: number; top: number; width: number; height: number }

/** The deck clutch mapping of §3.3 (pure). */
export function deckTargetX(xt0: number, px0: number, px: number, k: number, rail: readonly [number, number], deckWidthPx: number): number {
  return xt0 + (k * (px - px0) * (rail[1] - rail[0])) / deckWidthPx;
}

/** Control surface of the deck: the UI's surface element (SURFACE_SELECTOR) if it has a size, else deck minus 80 px. */
export function controlSurface(deck: Box, surfaceEl: Box | null = null): Box {
  if (surfaceEl && surfaceEl.height > 0) return surfaceEl;
  const top = deck.top + DECK_LAYOUT.forceBarPx + DECK_LAYOUT.miniRailPx;
  return { left: deck.left, top, width: deck.width, height: Math.max(0, deck.top + deck.height - top) };
}

/** Is a touch-down at clientY inside the fine band (bottom third of the control surface)? */
export function inFineBand(clientY: number, surface: Box): boolean {
  if (!(surface.height > 0)) return false;
  return clientY >= surface.top + surface.height * (1 - FINE_BAND.frac);
}

export interface PointerHost {
  /** Current target, else the trolley x (the clutch origin xt0). */
  baseTarget(): number;
  rail(): readonly [number, number] | null;
  clampTarget(x: number): number;
  /** A drag started: take control (keeps the target where it is; sets it to the trolley x if there was none). */
  begin(device: DeviceTag, fine: boolean): void;
  /** Pointer-driven target update. */
  setTarget(x: number, device: DeviceTag): void;
  command(c: Command): void;
}

export interface PointerSource {
  /** (Re)bind to the current elements and layout. Always resets the clutch; the target is kept. */
  bind(scene: HTMLElement, deck: HTMLElement | null, mapper: RailMapper, layout: Layout): void;
  unbind(): void;
  dragging(): boolean;
  /** Clutch reset (orientation change, another device took over): ignore the rest of the current drag. */
  endDrag(): void;
  /** New run while a finger is still down: keep the drag, restart the clutch from host.baseTarget(). */
  rebase(): void;
  /** Debug view of the active drag. */
  info(): { mode: 'clutch' | 'abs'; fine: boolean; k: number; device: DeviceTag } | null;
  dispose(): void;
}

interface Drag {
  id: number;
  mode: 'clutch' | 'abs';
  device: DeviceTag;
  fine: boolean;
  k: number;
  px0: number;
  xt0: number;
  widthPx: number;
  lastX: number;
  lastY: number;
  /** Mouse buttons seen last (chorded right press = retry). */
  buttons: number;
}

function boxOf(el: Element | null, fallback: Rect | null): Box | null {
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return fallback ? { left: fallback.x, top: fallback.y, width: fallback.w, height: fallback.h } : null;
}

function isUiTarget(t: EventTarget | null, host: Element): boolean {
  const el = t && typeof (t as Element).closest === 'function' ? (t as Element) : null;
  if (!el || el === host) return false;
  const hit = el.closest(UI_SELECTOR);
  return !!hit && host.contains(hit) && hit !== host;
}

export function createPointerSource(host: PointerHost, win: Window = window): PointerSource {
  let scene: HTMLElement | null = null;
  let deck: HTMLElement | null = null;
  let mapper: RailMapper | null = null;
  let layout: Layout | null = null;
  let drag: Drag | null = null;
  const saved = new Map<HTMLElement, string>();

  function mapAbs(cx: number, cy: number): number | null {
    const x = mapper ? mapper.screenToRailX(cx, cy) : null;
    return x !== null && Number.isFinite(x) ? host.clampTarget(x) : null;
  }

  function moveTo(d: Drag, cx: number, cy: number): void {
    d.lastX = cx;
    d.lastY = cy;
    if (d.mode === 'abs') {
      const x = mapAbs(cx, cy);
      if (x !== null) host.setTarget(x, d.device);
      return;
    }
    const rail = host.rail();
    if (!rail || !(d.widthPx > 0)) return;
    const raw = deckTargetX(d.xt0, d.px0, cx, d.k, rail, d.widthPx);
    const x = host.clampTarget(raw);
    if (x !== raw) {
      // Hit the target limit: re-anchor so that moving back responds at once (no dead travel).
      d.xt0 = x;
      d.px0 = cx;
    }
    host.setTarget(x, d.device);
  }

  function startClutch(e: PointerEvent, area: HTMLElement, rect: Rect | null, device: DeviceTag, withBand: boolean): void {
    const box = boxOf(area, rect);
    let fine = false;
    if (withBand && box) {
      const surfEl = area.querySelector(SURFACE_SELECTOR);
      fine = inFineBand(e.clientY, controlSurface(box, boxOf(surfEl, null)));
    }
    const widthPx = box?.width || layout?.deck?.w || win.innerWidth || 1;
    host.begin(device, fine);
    drag = {
      id: e.pointerId, mode: 'clutch', device, fine, k: fine ? FINE_BAND.gain : 1,
      px0: e.clientX, xt0: host.baseTarget(), widthPx, lastX: e.clientX, lastY: e.clientY, buttons: e.buttons,
    };
  }

  const seen = new WeakSet<Event>();
  const onDown = (e: PointerEvent): void => {
    if (seen.has(e)) return; // the deck nested inside the scene element: handle a press once
    seen.add(e);
    const el = e.currentTarget as HTMLElement;
    if (isUiTarget(e.target, el)) return;
    const isMouse = e.pointerType === 'mouse';
    if (isMouse && e.button === 2) {
      e.preventDefault();
      host.command('retry');
      host.command('any');
      return;
    }
    if (isMouse && e.button !== 0) return;
    // A second finger / second pointer is ignored entirely. A press with the *same* id as the current
    // drag means its pointerup was lost (released outside the window without capture): start anew.
    if (drag && drag.id !== e.pointerId) return;
    drag = null;
    host.command('any');
    if (!layout) return;
    const device = isMouse ? TAG_MOUSE : TAG_TOUCH;
    if (el === deck) {
      startClutch(e, deck, layout.deck, device, true);
    } else if (el === scene) {
      if (layout.kind === 'wide') {
        const top = boxOf(scene, layout.scene)?.top ?? 0;
        if (e.clientY - top < layout.hudTop) return; // HUD band: not a control area
        const x = mapAbs(e.clientX, e.clientY);
        host.begin(device, false);
        drag = {
          id: e.pointerId, mode: 'abs', device, fine: false, k: 1, px0: e.clientX, xt0: 0, widthPx: 0,
          lastX: e.clientX, lastY: e.clientY, buttons: e.buttons,
        };
        if (x !== null) host.setTarget(x, device);
      } else if (!deck) {
        startClutch(e, scene, layout.scene, device, false); // tall without a deck element: whole scene is the deck
      } else {
        return; // tall: the scene itself does not steer (the deck does)
      }
    } else {
      return;
    }
    e.preventDefault(); // no text selection / native drag / compatibility mouse events
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // capture is optional: window listeners below still see the moves
    }
  };

  const onMove = (e: PointerEvent): void => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (e.pointerType === 'mouse') {
      // A right press during a left drag is a chorded button change: a pointermove, not a pointerdown.
      if (e.buttons & 2 && !(d.buttons & 2)) {
        host.command('retry');
        host.command('any');
      }
      d.buttons = e.buttons;
      if ((e.buttons & 1) === 0) {
        drag = null; // the left button was released (or released where we could not see it)
        return;
      }
    }
    if (e.clientX === d.lastX && e.clientY === d.lastY) return;
    moveTo(d, e.clientX, e.clientY);
  };

  const onUp = (e: PointerEvent): void => {
    if (drag && e.pointerId === drag.id) drag = null; // the target stays where it is
  };

  const onContextMenu = (e: Event): void => {
    e.preventDefault(); // right click = retry, long press must not open a menu
  };
  const onTouchMove = (e: TouchEvent): void => {
    // Belt and braces with touch-action: none (old iOS), only during our own drag so that a
    // scrollable UI panel inside the scene still scrolls.
    if (drag && drag.device === TAG_TOUCH && e.cancelable) e.preventDefault();
  };

  const elListeners: [string, EventListener, AddEventListenerOptions][] = [
    ['pointerdown', onDown as EventListener, { passive: false }],
    ['contextmenu', onContextMenu, { passive: false }],
    ['touchmove', onTouchMove as EventListener, { passive: false }],
  ];

  function unbind(): void {
    for (const el of [scene, deck]) {
      if (!el) continue;
      for (const [t, fn, o] of elListeners) el.removeEventListener(t, fn, o);
      if (saved.has(el)) el.style.touchAction = saved.get(el) ?? '';
    }
    saved.clear();
    scene = deck = null;
    drag = null;
  }

  win.addEventListener('pointermove', onMove, { passive: true });
  win.addEventListener('pointerup', onUp);
  win.addEventListener('pointercancel', onUp);

  return {
    bind(sc, dk, mp, ly) {
      unbind();
      scene = sc;
      deck = dk;
      mapper = mp;
      layout = ly;
      for (const el of [scene, deck]) {
        if (!el) continue;
        for (const [t, fn, o] of elListeners) el.addEventListener(t, fn, o);
        saved.set(el, el.style.touchAction);
        el.style.touchAction = 'none';
      }
    },
    unbind,
    dragging: () => drag !== null,
    endDrag() {
      drag = null;
    },
    rebase() {
      const d = drag;
      if (!d || d.mode !== 'clutch') return;
      d.px0 = d.lastX;
      d.xt0 = host.baseTarget();
    },
    info: () => (drag ? { mode: drag.mode, fine: drag.fine, k: drag.k, device: drag.device } : null),
    dispose() {
      unbind();
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onUp);
      win.removeEventListener('pointercancel', onUp);
    },
  };
}
