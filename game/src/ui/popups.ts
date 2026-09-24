// DOM popups anchored to world positions (max 6) and onomatopoeia (max 3) (GAME_DESIGN.md §9.3, §9.5), and the
// toasts. Owner: O7.
import { h } from './dom';
import { icon } from './icons';
import type { IconName } from './icons';
import { fmtDelta, fmtMm, nearTier, t } from './i18n/format';

export const MAX_POPUPS = 6;
export const MAX_WORDS = 3;

export type PopKind = 'word' | 'crash' | 'snap' | 'bang' | 'whoosh';

/** A rectangle in CSS px relative to the UI root. */
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Where a near-miss label goes: beside the wall's top corner on the side the ball came from (§9.3). */
export interface NearPlace {
  /** Screen x of the wall face on the approach side, and the screen y of the wall top. */
  x: number;
  y: number;
  /** -1: the label goes to the left of x, +1: to the right. */
  side: -1 | 1;
  /** Keep the label's top edge below this y (the gantry beam and the ghost tags above it). */
  minTop?: number;
}

/**
 * Where the celebration banners (crown, PB) go: centred at (x, y) in CSS px relative to the UI root, their top edge
 * kept at or below `minTop`, scaled down to `maxW` when wider. They open right before the results card and stay on
 * top of it, so the free area next to the card is where they belong (ui.ts: bannerPlace).
 */
export interface BannerPlace { x: number; y: number; maxW: number; minTop?: number }

/** Banner kinds drawn above the screen layer (the results card): the success celebrations. */
export const TOP_BANNERS: ReadonlySet<string> = new Set(['crown', 'pb']);

/** Crown / PB banners: shown this long after the success stamp, and when the x/18 counter ticks (ms). */
export const BANNER_DELAY_MS = 150;
export const BANNER_TICK_MS = 350;

export interface Popups {
  /**
   * Generic onomatopoeia at a screen position (CSS px in the UI root). Returns the y it was centred on after keeping
   * it inside the bounds (a label under it keeps its distance: the crash word and its info pill).
   */
  show(text: string, x: number, y: number, kind?: string): number;
  /** Near-miss label: at (x, y), or beside a wall when `at` is given (x / y are then ignored). */
  near(mm: number, x: number, y: number, at?: NearPlace): void;
  /** overlapMm null: a crash without a depth (the string caught on a wall, the egg cracked): only the cause. */
  crashInfo(overlapMm: number | null, cause: string, x: number, y: number): void;
  split(deltaSub: number, x: number, y: number): void;
  stamp(text: string, x: number, y: number): void;
  /**
   * Banner. 'almost': x / y are offsets from its home position (centre, 26 % from the top), in the popup layer.
   * 'crown' / 'pb': in their own layer above the screen layer, at the banner place (setBannerPlace) when there is one.
   * `counter`: 人類 vs AI x/18 tick.
   */
  banner(kind: 'crown' | 'pb' | 'almost', text: string, x?: number, y?: number, counter?: { from: number; to: number; total: number }): void;
  /** The area popups are kept inside (the 3D view under the HUD). Default: the whole root. */
  setBounds(b: (() => Box | null) | null): void;
  /** Where crown / PB banners go (null: their stylesheet home, centre and 26 % from the top). */
  setBannerPlace(p: (() => BannerPlace | null) | null): void;
  /** Re-place the live crown / PB banners (the results card opened, the layout changed). */
  placeBanners(): void;
  /** Box of the live crown / PB banners (null when there is none): toasts keep out of it. */
  bannerBox(): Box | null;
  /** Called when a crown / PB banner appears or goes (the free room for toasts changed). */
  onBannerChange(cb: (() => void) | null): void;
  /** Removes the crown / PB banners (the player left the results for another screen). */
  clearBanners(): void;
  clear(): void;
  count(): number;
}

export function createPopups(root: HTMLElement): Popups {
  const layer = h('div', { class: 'yp-pop', 'aria-hidden': 'true' });
  root.appendChild(layer);
  // Crown / PB banners: above the screen layer (the results card opens 0.75 s after the success, §9.5), below toasts.
  const topLayer = h('div', { class: 'yp-banner', 'aria-hidden': 'true' });
  root.appendChild(topLayer);
  const live: HTMLElement[] = [];
  let bannerPlace: (() => BannerPlace | null) | null = null;
  let bannerCb: (() => void) | null = null;

  const isTop = (el: HTMLElement): boolean => el.parentElement === topLayer;
  function bannerChanged(): void {
    try {
      bannerCb?.();
    } catch {
      /* the listener reports its own failures */
    }
  }

  function drop(el: HTMLElement): void {
    const i = live.indexOf(el);
    if (i >= 0) live.splice(i, 1);
    const top = isTop(el);
    el.remove();
    if (top) bannerChanged();
  }

  function readPlace(): BannerPlace | null {
    try {
      const p = bannerPlace?.() ?? null;
      return p && Number.isFinite(p.x + p.y + p.maxW) && p.maxW > 0 ? p : null;
    } catch {
      return null;
    }
  }

  /** Puts a crown / PB banner at the banner place (centred, scaled to fit, top edge kept below minTop). */
  function placeTop(el: HTMLElement): void {
    const p = readPlace();
    const inner = el.firstElementChild as HTMLElement | null;
    if (!p || !inner) {
      el.style.left = el.style.top = '';
      el.style.removeProperty('--bs');
      return;
    }
    el.style.removeProperty('--bs');
    const w = inner.offsetWidth;
    if (w > p.maxW) el.style.setProperty('--bs', Math.max(0.55, p.maxW / w).toFixed(3));
    const hh = inner.offsetHeight / 2;
    const y = p.minTop !== undefined ? Math.max(p.y, p.minTop + hh) : p.y;
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  let bounds: (() => Box | null) | null = null;
  function box(): Box {
    let b: Box | null = null;
    try {
      b = bounds?.() ?? null;
    } catch {
      b = null;
    }
    const W = layer.clientWidth;
    const H = layer.clientHeight;
    if (!b || !(b.x1 > b.x0) || !(b.y1 > b.y0)) return { x0: 0, y0: 0, x1: W, y1: H };
    return { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: W > 0 ? Math.min(W, b.x1) : b.x1, y1: H > 0 ? Math.min(H, b.y1) : b.y1 };
  }

  /**
   * Adds a popup centred on (x, y) (its animation keeps it centred there), clamped so the label stays inside the
   * bounds. `rise`: how far the animation lifts the label, as a fraction of its height (kept inside too).
   * `beside`: place the label next to (x, y) on that side instead of centring it there. Returns the final centre y.
   */
  function add(el: HTMLElement, x: number, y: number, ttl: number, word = false, opt: { rise?: number; beside?: -1 | 1; minTop?: number } = {}): number {
    if (word) {
      const words = live.filter((e) => e.classList.contains('pop--word'));
      while (words.length >= MAX_WORDS) drop(words.shift()!);
    }
    while (live.length >= MAX_POPUPS) drop(live[0]!);
    const top = el.classList.contains('pop--banner') && TOP_BANNERS.has(el.dataset.kind ?? '');
    (top ? topLayer : layer).appendChild(el);
    if (top) placeTop(el);
    // Keep the label fully inside the bounds (it is centred on (x, y) by its own animation).
    const inner = el.firstElementChild as HTMLElement | null;
    if (inner && !el.classList.contains('pop--banner') && layer.clientWidth > 0) {
      const b = box();
      const hw = inner.offsetWidth / 2 + 6;
      const hh = inner.offsetHeight / 2 + 6;
      const rise = (opt.rise ?? 0) * inner.offsetHeight;
      if (opt.beside) x += opt.beside * hw;
      if (opt.minTop !== undefined) y = Math.max(y, opt.minTop + hh + rise);
      x = b.x1 - b.x0 >= 2 * hw ? Math.max(b.x0 + hw, Math.min(b.x1 - hw, x)) : (b.x0 + b.x1) / 2;
      y = b.y1 - b.y0 >= 2 * hh + rise ? Math.max(b.y0 + hh + rise, Math.min(b.y1 - hh, y)) : (b.y0 + b.y1) / 2;
    }
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    live.push(el);
    if (top) bannerChanged();
    window.setTimeout(() => {
      // Still frames (dev screenshots) keep the popups in the scene; crown / PB banners over a card still go, so
      // that the card is shown the way the player sees it once the celebration is over.
      if (top || !layer.closest('.yp--still')) drop(el);
    }, ttl);
    return Math.round(y);
  }

  return {
    show(text, x, y, kind = 'word') {
      const el = h('div', { class: `pop pop--word pop--${kind}` }, h('div', { class: 'pop-in' }, text));
      return add(el, x, y, 800, true, { rise: 0.7 });
    },
    near(mm, x, y, at) {
      const tier = nearTier(mm);
      if (!tier) return;
      const el = h('div', { class: 'pop pop--near', 'data-tier': tier },
        h('div', { class: 'pop-in' },
          h('div', { class: 'pop-near-mm' }, t('pop.close', { mm: fmtMm(mm) })),
          h('div', { class: 'pop-near-tier' }, t(`pop.tier.${tier}` as 'pop.tier.near'))));
      // yp-near lifts the label by 35 % of its height over its life.
      if (at) add(el, at.x, at.y, 1200, false, { rise: 0.35, beside: at.side, minTop: at.minTop });
      else add(el, x, y - 34, 1200, false, { rise: 0.35 });
    },
    crashInfo(overlapMm, cause, x, y) {
      const el = h('div', { class: 'pop pop--crashinfo' },
        h('div', { class: 'pop-in' },
          overlapMm === null ? null : h('div', { class: 'pop-crash-mm' }, t('pop.overlap', { mm: fmtMm(overlapMm) })),
          cause ? h('div', { class: 'pop-crash-cause' }, cause) : null));
      add(el, x, y - 40, 800, false, { rise: 0.35 });
    },
    split(deltaSub, x, y) {
      const el = h('div', { class: 'pop pop--split', 'data-behind': deltaSub > 0 ? '1' : '0' }, h('div', { class: 'pop-in' }, fmtDelta(deltaSub, 2)));
      add(el, x, y, 900);
    },
    stamp(text, x, y) {
      const el = h('div', { class: 'pop pop--stamp' }, h('div', { class: 'pop-in' }, h('div', { class: 'stamp' }, text)));
      add(el, x, y, 1600);
    },
    banner(kind, text, x, y, counter) {
      const ico: Partial<Record<typeof kind, IconName>> = { crown: 'crown', pb: 'star' };
      const name = ico[kind];
      let count: HTMLElement | null = null;
      let num: HTMLElement | null = null;
      if (counter) {
        const calm = !!layer.closest('.yp--reduce, .yp--still');
        num = h('span', { class: 'num' }, String(calm ? counter.to : counter.from));
        count = h('span', { class: 'pop-banner-count' }, num, h('small', null, `/${counter.total}`));
        if (!calm) {
          window.setTimeout(() => {
            num!.textContent = String(counter.to);
            count!.classList.add('is-tick');
          }, BANNER_TICK_MS);
        }
      }
      const el = h('div', { class: 'pop pop--banner', 'data-kind': kind }, h('div', { class: 'pop-in' }, name ? icon(name) : null, ' ', text, count));
      add(el, x ?? 0, y ?? 0, counter ? 2100 : kind === 'pb' ? 1700 : 1500);
    },
    setBounds(b) {
      bounds = b;
    },
    setBannerPlace(p) {
      bannerPlace = p;
    },
    placeBanners() {
      let n = 0;
      for (const el of live) {
        if (!isTop(el)) continue;
        placeTop(el);
        n++;
      }
      if (n) bannerChanged();
    },
    bannerBox() {
      let b: Box | null = null;
      for (const el of live) {
        if (!isTop(el)) continue;
        const inner = el.firstElementChild as HTMLElement | null;
        if (!inner || inner.offsetWidth === 0) continue;
        // Layout box (offsets: the entering animation does not move it); the inner label is centred on (left, top)
        // and already has its --bs scale in its size.
        const cx = el.offsetLeft;
        const cy = el.offsetTop;
        const hw = inner.offsetWidth / 2;
        const hh = inner.offsetHeight / 2;
        const r = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
        b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r;
      }
      return b;
    },
    onBannerChange(cb) {
      bannerCb = cb;
    },
    clearBanners() {
      for (const el of live.filter(isTop)) drop(el);
    },
    clear() {
      while (live.length) drop(live[0]!);
    },
    count() {
      return live.length;
    },
  };
}

// ---------------------------------------------------------------- toasts

/**
 * Where toasts may appear right now (CSS px relative to the UI root). The stack grows down from `top` or up from
 * `bottom`, centred between x0 and x1; toasts that would pass `limit` (the other end) wait in a queue.
 */
export interface ToastArea { x0: number; x1: number; top?: number; bottom?: number; limit: number; max?: number }

/** 'skin': a skin unlock, drawn like 'info' (a kind of its own so that it can be dropped with the run's badges). */
export type ToastKind = 'info' | 'badge' | 'warn' | 'notice' | 'skin';

export interface Toasts {
  show(text: string, kind?: ToastKind): void;
  clear(): void;
  /**
   * The free area changed (screen, layout, a card opened): re-place the stack. Visible toasts that no longer fit go
   * back to the front of the queue and come back when there is room again (e.g. after the results card closes).
   */
  refresh(): void;
  /** Toasts waiting for room. */
  pending(): number;
  /** Drops the visible and waiting toasts of one kind (badges belong to the run and its results card). */
  drop(kind: ToastKind): void;
}

const TOAST_MS = 2900;
const TOAST_MAX = 3;
/**
 * A toast that waited longer than this is dropped (it would be about something long gone: two screens back). An area
 * that shows fewer than TOAST_MAX at a time adds TOAST_MS per missing slot, so that a burst still drains in order
 * (after a crash: a badge from the run, then the hint, skip and assist offers, one after the other).
 */
const TOAST_STALE_MS = 8000;
/** On screen this long, a toast has been read: a relayout that has no room for it drops it instead of replaying it. */
const TOAST_SEEN_MS = 1200;
/** A toast area narrower than this (CSS px) is marked data-narrow: no phrase-keeping line breaks there. */
export const TOAST_NARROW = 200;

export function createToasts(root: HTMLElement, area: () => ToastArea | null = () => null): Toasts {
  const box = h('div', { class: 'yp-toasts', role: 'status', 'aria-live': 'polite' });
  root.appendChild(box);
  interface Item { text: string; kind: ToastKind; at: number; el: HTMLElement | null; timer: number; shownAt: number }
  const queue: Item[] = [];
  const shown: Item[] = [];
  let current: ToastArea | null = null;

  function readArea(): ToastArea | null {
    try {
      return area();
    } catch {
      return null;
    }
  }

  /** Positions the stack for the current area (null: the stylesheet default). */
  function placeBox(a: ToastArea | null): void {
    const st = box.style;
    if (!a) {
      st.left = st.right = st.top = st.bottom = st.width = st.transform = st.flexDirection = '';
      box.removeAttribute('data-narrow');
      return;
    }
    const w = Math.max(0, a.x1 - a.x0);
    // Too narrow for a whole ja phrase on a line (styles.css keeps the normal line breaks then).
    box.toggleAttribute('data-narrow', w < TOAST_NARROW);
    st.left = `${Math.round(a.x0)}px`;
    st.width = `${Math.round(w)}px`;
    st.right = 'auto';
    st.transform = 'none';
    if (a.top !== undefined) {
      st.top = `${Math.round(a.top)}px`;
      st.bottom = 'auto';
      st.flexDirection = 'column';
    } else {
      st.top = 'auto';
      st.bottom = `${Math.round(root.clientHeight - (a.bottom ?? 0))}px`;
      st.flexDirection = 'column-reverse';
    }
  }

  /** Does the stack fit the area? (Always true without an area or before layout.) */
  function fits(a: ToastArea | null): boolean {
    if (!a || !box.isConnected || root.clientHeight === 0) return true;
    if (shown.length > (a.max ?? TOAST_MAX)) return false;
    const r = box.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    if (r.height === 0) return true;
    return a.top !== undefined ? r.bottom - o.top <= a.limit + 0.5 : r.top - o.top >= a.limit - 0.5;
  }

  function make(it: Item): HTMLElement {
    // info: done (✓); warn: no connection; notice: something did not work, not the connection (ⓘ).
    const ic: IconName = it.kind === 'badge' ? 'star' : it.kind === 'warn' ? 'offline' : it.kind === 'notice' ? 'info' : 'check';
    return h('div', { class: `toast toast--${it.kind === 'skin' ? 'info' : it.kind}` }, icon(ic), h('span', null, it.text));
  }

  function expire(it: Item): void {
    const i = shown.indexOf(it);
    if (i >= 0) shown.splice(i, 1);
    it.el?.remove();
    it.el = null;
    pump();
  }

  function pump(): void {
    const now = performance.now();
    const slots = Math.max(1, Math.min(TOAST_MAX, current?.max ?? TOAST_MAX));
    const stale = TOAST_STALE_MS + (TOAST_MAX - slots) * TOAST_MS;
    while (queue.length && now - queue[0]!.at > stale) queue.shift();
    while (queue.length && shown.length < TOAST_MAX) {
      const it = queue[0]!;
      it.el = make(it);
      box.appendChild(it.el);
      shown.push(it);
      if (!fits(current)) {
        // No room for this one now: it waits (a visible toast expiring or refresh() tries again).
        shown.pop();
        it.el.remove();
        it.el = null;
        return;
      }
      queue.shift();
      it.shownAt = now;
      it.timer = window.setTimeout(() => expire(it), TOAST_MS);
    }
  }

  function refresh(): void {
    current = readArea();
    placeBox(current);
    // Newest first back into the queue until the rest fits; one that was already on screen for a while has been
    // read and goes (a screen change must not replay it on the next screen).
    const now = performance.now();
    while (shown.length && !fits(current)) {
      const it = shown.pop()!;
      window.clearTimeout(it.timer);
      it.el?.remove();
      it.el = null;
      if (now - it.shownAt < TOAST_SEEN_MS) queue.unshift(it);
    }
    pump();
  }

  return {
    show(text, kind = 'info') {
      queue.push({ text, kind, at: performance.now(), el: null, timer: 0, shownAt: 0 });
      while (queue.length > 6) queue.shift();
      current = readArea();
      placeBox(current);
      pump();
    },
    clear() {
      for (const it of shown) window.clearTimeout(it.timer);
      shown.length = 0;
      queue.length = 0;
      box.replaceChildren();
    },
    refresh,
    pending: () => queue.length,
    drop(kind) {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.kind === kind) queue.splice(i, 1);
      for (const it of shown.filter((x) => x.kind === kind)) {
        window.clearTimeout(it.timer);
        expire(it);
      }
    },
  };
}
