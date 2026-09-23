// Portrait control deck: force bar, mini rail, control surface (GAME_DESIGN.md §3.3). Owner: O7.
// The whole deck element is the touch surface for O4's relative clutch drag. There are no buttons in it.
// Layout from the top: force bar (8 px), mini rail (72 px), control surface (the rest). The fine band is the
// bottom third of `.deck-surface` (O4 reads its rect: deckEl.querySelector('.deck-surface')).
import type { HudState } from './ui';
import type { GhostKind } from '../render/renderer';
import { h, s, setAttr } from './dom';
import { ghostShapeMarkup, icon } from './icons';
import { createForceBar } from './hud';
import { t } from './i18n/format';
import { DECK_FORCE_H, DECK_RAIL_H } from './layout';

export interface Deck {
  readonly el: HTMLElement;
  /** The control surface (O4's fine band is its bottom third). */
  readonly surface: HTMLElement;
  update(deck: NonNullable<HudState['deck']>): void;
  force(F: number, Fmax: number, aiF: number | null, saturated: boolean): void;
  onboarding(kind: 'hand' | 'keys' | null): void;
  /** READY: "move to start" written on the control surface under the grip (tall has no READY pill in the HUD). */
  ready(on: boolean): void;
  dispose(): void;
}

const RAIL_Y = 14;
const FLOOR_Y = 60;
const BALL_Y = 42;

export function createDeck(parent: HTMLElement): Deck {
  const fbar = createForceBar();
  const forceEl = h('div', { class: 'deck-force' }, fbar.el);
  const svg = s('svg', { 'aria-label': t('hud.rail'), role: 'img' }) as SVGSVGElement;
  const staticG = s('g');
  const ghostsG = s('g');
  const target = s('g', { opacity: 0 },
    s('line', { x1: 0, x2: 0, y1: RAIL_Y - 10, y2: FLOOR_Y, stroke: '#1E2A44', 'stroke-width': 1.2, 'stroke-dasharray': '3 3' }),
    s('circle', { cx: 0, cy: RAIL_Y, r: 6.5, fill: 'none', stroke: '#1E2A44', 'stroke-width': 2 }));
  const string = s('line', { stroke: '#2B2B2B', 'stroke-width': 1.6, y1: RAIL_Y + 3, y2: BALL_Y });
  const trolley = s('rect', { width: 18, height: 9, rx: 3, y: RAIL_Y - 4.5, fill: '#39455F', stroke: '#1E2A44', 'stroke-width': 1.5 });
  const ball = s('circle', { r: 5.5, cy: BALL_Y, fill: '#E0312B', stroke: '#1E2A44', 'stroke-width': 1.5 });
  svg.append(staticG, target, ghostsG, string, trolley, ball);
  // Nothing to show before the first frame of a level (the title has no run): no stray trolley at x = 0.
  svg.setAttribute('visibility', 'hidden');
  let drawn = false;
  const railEl = h('div', { class: 'deck-rail' }, svg);

  const fine = h('div', { class: 'deck-fine' }, h('span', { class: 'deck-fine-label' }, t('hud.fine')));
  const grip = h('div', { class: 'deck-grip', 'aria-hidden': 'true' }, icon('arrowL'), h('span', { class: 'deck-grip-bar' }), icon('arrowR'));
  const hand = h('div', { class: 'deck-hand', 'aria-hidden': 'true' }, h('span', { class: 'deck-hand-track' }), h('span', { class: 'deck-hand-finger' }, icon('hand')));
  const keys = h('div', { class: 'keycaps', 'aria-hidden': 'true' }, h('span', { class: 'keycap' }, '←'), h('span', { class: 'keycap' }, '→'));
  hand.style.display = 'none';
  keys.style.display = 'none';
  // The same "READY" marker the wide HUD shows in its band, where the thumb goes.
  const readyEl = h('div', { class: 'deck-ready', role: 'status' }, t('hud.ready'));
  readyEl.style.display = 'none';
  const surface = h('div', { class: 'deck-surface' }, fine, grip, hand, keys, readyEl);

  const el = h('div', { class: 'yp-deck', 'data-force-h': DECK_FORCE_H, 'data-rail-h': DECK_RAIL_H }, forceEl, railEl, surface);
  parent.appendChild(el);

  let W = 0;
  let readyOn = false;
  // What the static part was drawn for (references: core passes the level's own arrays every frame).
  let drawnW = -1;
  let drawnRail: readonly number[] | null = null;
  let drawnWalls: readonly unknown[] | null = null;
  let drawnZones: readonly unknown[] | null = null;
  let X0 = -1.3;
  let X1 = 3.5;
  const px = (x: number): number => ((x - X0) / (X1 - X0)) * W;
  const ghostKinds: GhostKind[] = [];
  const ghostEls: SVGElement[] = [];

  function rebuild(d: NonNullable<HudState['deck']>): void {
    X0 = d.rail[0] - 0.3;
    X1 = d.rail[1] + 0.3;
    svg.setAttribute('viewBox', `0 0 ${W} ${DECK_RAIL_H}`);
    const parts: SVGElement[] = [];
    // Floor and zones.
    parts.push(s('line', { x1: 0, x2: W, y1: FLOOR_Y, y2: FLOOR_Y, stroke: '#1E2A44', 'stroke-width': 1.5 }));
    for (const z of d.zones) {
      const x = px(z.xa);
      const w = Math.max(3, px(z.xb) - x);
      parts.push(s('rect', { x, y: RAIL_Y + 8, width: w, height: FLOOR_Y - RAIL_Y - 8, fill: 'rgba(34,181,115,.14)' }));
      parts.push(s('rect', { x, y: FLOOR_Y - 3, width: w, height: 4, rx: 1.5, fill: '#22B573' }));
    }
    // Walls scaled to height (0..1.3 m -> floor..rail).
    for (const w of d.walls) {
      const x = px(w.x0);
      const ww = Math.max(3, px(w.x1) - x);
      const hh = (w.h / 1.3) * (FLOOR_Y - RAIL_Y - 4);
      parts.push(s('rect', { x, y: FLOOR_Y - hh, width: ww, height: hh, fill: '#C8643F', stroke: '#1E2A44', 'stroke-width': 1.2 }));
    }
    // Beam / rail with hazard ends.
    const r0 = px(d.rail[0]);
    const r1 = px(d.rail[1]);
    parts.push(s('rect', { x: r0 - 6, y: RAIL_Y - 2.5, width: r1 - r0 + 12, height: 5, rx: 2.5, fill: '#F2B705', stroke: '#1E2A44', 'stroke-width': 1.2 }));
    for (const x of [r0 - 9, r1 + 3]) parts.push(s('rect', { x, y: RAIL_Y - 6, width: 6, height: 12, rx: 1.5, fill: '#1E1E1E' }));
    staticG.replaceChildren(...parts);
  }

  // Width is measured only when the layout changes (never per frame).
  let measured = 0;
  const measure = (): number => {
    measured = svg.clientWidth || Math.max(0, railEl.clientWidth - 20);
    return measured;
  };
  let ro: ResizeObserver | null = null;
  try {
    ro = new ResizeObserver(() => measure());
    ro.observe(railEl);
  } catch {
    /* measure lazily below */
  }

  function update(d: NonNullable<HudState['deck']>): void {
    const w = measured || measure();
    if (w > 0 && (w !== drawnW || d.rail !== drawnRail || d.walls !== drawnWalls || d.zones !== drawnZones)) {
      W = w;
      drawnW = w;
      drawnRail = d.rail;
      drawnWalls = d.walls;
      drawnZones = d.zones;
      rebuild(d);
    }
    if (W <= 0 || !Number.isFinite(d.x) || !Number.isFinite(d.bx)) return;
    if (!drawn) {
      drawn = true;
      svg.removeAttribute('visibility');
    }
    const tx = px(d.x);
    setAttr(trolley, 'x', (tx - 9).toFixed(1));
    setAttr(string, 'x1', tx.toFixed(1));
    const bx = px(d.bx);
    setAttr(string, 'x2', bx.toFixed(1));
    setAttr(ball, 'cx', bx.toFixed(1));
    if (d.targetX === null || !Number.isFinite(d.targetX)) {
      setAttr(target, 'opacity', '0');
    } else {
      setAttr(target, 'opacity', '1');
      setAttr(target, 'transform', `translate(${px(d.targetX).toFixed(1)} 0)`);
    }
    let same = ghostKinds.length === d.ghostXs.length;
    for (let i = 0; same && i < ghostKinds.length; i++) same = ghostKinds[i] === d.ghostXs[i]!.kind;
    if (!same) {
      ghostKinds.length = 0;
      ghostEls.length = 0;
      ghostsG.replaceChildren(...d.ghostXs.map((g) => {
        const e = s('g', { opacity: 0.95 });
        e.innerHTML = ghostShapeMarkup(g.kind, 13);
        ghostKinds.push(g.kind);
        ghostEls.push(e);
        return e;
      }));
    }
    for (let i = 0; i < d.ghostXs.length; i++) {
      const e = ghostEls[i];
      const gx = d.ghostXs[i]!.x;
      if (e && Number.isFinite(gx)) setAttr(e, 'transform', `translate(${(px(gx) - 6.5).toFixed(1)} ${RAIL_Y - 20})`);
    }
  }

  return {
    el,
    surface,
    update,
    force: (F, Fmax, aiF, sat) => fbar.update(F, Fmax, aiF, sat),
    onboarding(kind) {
      hand.style.display = kind === 'hand' ? '' : 'none';
      keys.style.display = kind === 'keys' ? '' : 'none';
      grip.style.display = kind ? 'none' : '';
      el.toggleAttribute('data-onboarding', !!kind);
    },
    ready(on) {
      if (on === readyOn) return;
      readyOn = on;
      readyEl.style.display = on ? '' : 'none';
    },
    dispose() {
      ro?.disconnect();
      el.remove();
    },
  };
}
