// HUD overlay: top band, 3D-anchored meters, force bar (GAME_DESIGN.md §9.3), tall dock (D10). Owner: O7.
import type { HudState, HudAnchors } from './ui';
import type { LevelDef } from '../sim/level';
import type { GameEvent } from '../core/bus';
import type { GhostKind, Layout } from '../render/renderer';
import { h, s, setAttr, setText, toggleClass } from './dom';
import { icon, rackBall } from './icons';
import { NO_VALUE, fmtDelta, fmtGap, fmtTime, levelName, t } from './i18n/format';

// ---------------------------------------------------------------- force bar (deck in tall, bottom centre in wide)

export interface ForceBar { readonly el: HTMLElement; update(F: number, Fmax: number, aiF: number | null, saturated: boolean): void }

export function createForceBar(): ForceBar {
  const fill = h('div', { class: 'fbar-fill' });
  // The AI tick sits in a full-width track so that translateX(%) is a fraction of the bar width (no layout reads per frame).
  const aiTrack = h('div', { class: 'fbar-aitrack' }, h('div', { class: 'fbar-ai' }));
  const el = h('div', { class: 'fbar', role: 'meter', 'aria-label': t('hud.force'), 'aria-valuemin': -1, 'aria-valuemax': 1 }, fill, h('div', { class: 'fbar-mid' }), aiTrack);
  let lastF = NaN;
  let lastAi = NaN;
  let lastSat = false;
  aiTrack.style.display = 'none';
  return {
    el,
    update(F, Fmax, aiF, saturated) {
      const f = Fmax > 0 ? Math.max(-1, Math.min(1, F / Fmax)) : 0;
      if (Math.abs(f - lastF) > 0.002) {
        // Origin is the centre line: a negative scale mirrors the bar to the left.
        fill.style.transform = `scaleX(${f.toFixed(4)})`;
        lastF = f;
      }
      if (aiF === null) {
        if (!Number.isNaN(lastAi)) {
          aiTrack.style.display = 'none';
          lastAi = NaN;
        }
      } else {
        const a = Fmax > 0 ? Math.max(-1, Math.min(1, aiF / Fmax)) : 0;
        if (Number.isNaN(lastAi)) aiTrack.style.display = '';
        if (Math.abs(a - lastAi) > 0.002 || Number.isNaN(lastAi)) {
          aiTrack.style.transform = `translateX(${(a * 50).toFixed(2)}%)`;
          lastAi = a;
        }
      }
      if (saturated !== lastSat) {
        toggleClass(el, 'fbar--sat', saturated);
        lastSat = saturated;
      }
    },
  };
}

// ---------------------------------------------------------------- HUD

/** Times to beat shown in the tall scoreboard (substeps): the AI par and your best on this level. */
export interface HudTargets { ai: number | null; pb: number | null }

export interface HudDeps {
  emit(a: 'retry' | 'pause' | 'reverseHint' | 'skip' | 'rewind', payload?: unknown): void;
  /** READY-time chips that depend on game state (re-read on level/run changes, not every frame). */
  chips(): { info: boolean; reverse: boolean; skip: boolean };
  /**
   * Practice MODE (×0.5 and the 5 s rewind, §3.5) is on. HudState.mode 'practice' also covers unrecorded play at
   * normal speed (the daily after the 5 balls, §7.5), which has neither.
   */
  practiceSlow?(): boolean;
  /** AI par / personal best of the current level for the tall scoreboard (re-read with the chips). */
  targets?(): HudTargets;
  openInfo(): void;
}

export interface Hud {
  readonly el: HTMLElement;
  update(hs: HudState): void;
  setLevel(level: LevelDef | null): void;
  setLayout(l: Layout): void;
  fx(e: GameEvent): void;
  /** tall: shows a split delta in the scoreboard and returns true; false in wide (the caller pops it over the scene). */
  split(deltaSub: number, vs: GhostKind, index: number): boolean;
  refreshChips(): void;
  /**
   * On the results card the ⏸ corner button is the way to the level select (a run that is over has nothing to
   * pause): list icon and 「面選択」 label. It still emits 'pause'; core takes that as "to the level select" there.
   */
  setMenu(on: boolean): void;
  dispose(): void;
}

const RAD = Math.PI / 180;

function sameBalls(a: readonly (string | null)[] | null, b: readonly (string | null)[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function arcPath(r: number, a0: number, a1: number): string {
  // Angles from straight down (screen y down), positive to the right.
  const x0 = r * Math.sin(a0 * RAD);
  const y0 = r * Math.cos(a0 * RAD);
  const x1 = r * Math.sin(a1 * RAD);
  const y1 = r * Math.cos(a1 * RAD);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 0 : 1;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} ${sweep} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** Who a split delta is measured against, as a short label. */
function vsKey(vs: GhostKind): 'hud.who.ai' | 'hud.who.pb' | 'hud.who.wr' | 'hud.who.rival' | 'hud.who.challenge' {
  switch (vs) {
    case 'pb':
    case 'daily_pb':
      return 'hud.who.pb';
    case 'wr':
      return 'hud.who.wr';
    case 'rival':
      return 'hud.who.rival';
    case 'challenge':
      return 'hud.who.challenge';
    default:
      return 'hud.who.ai';
  }
}

/**
 * A HUD button pressed with a mouse / finger never keeps the keyboard focus, so that Space / Enter reach the game
 * (confirm / retry) instead of pressing the button again. Keyboard activation (Tab + Enter) keeps the focus.
 */
function pointerButton<T extends HTMLButtonElement>(b: T, onClick: () => void): T {
  let pointerAt = -1e9;
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // the canvas / deck must not treat HUD presses as drags
    pointerAt = performance.now();
  });
  // No focus from a mouse / touch press in the first place (no focus ring flash either).
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.detail > 0 || performance.now() - pointerAt < 1500) b.blur();
    pointerAt = -1e9;
    onClick();
  });
  return b;
}

export function createHud(root: HTMLElement, deps?: HudDeps): Hud {
  const d: HudDeps = deps ?? { emit: () => undefined, chips: () => ({ info: false, reverse: false, skip: false }), openInfo: () => undefined };
  const slowNow = (mode: HudState['mode']): boolean => {
    if (mode !== 'practice') return false;
    try {
      return d.practiceSlow ? d.practiceSlow() : true;
    } catch {
      return true;
    }
  };

  // --- top band: ↺ | level (+ clock and READY / rack / mode in wide) | offline, ⏸
  const retryBtn = pointerButton(h('button', { class: 'hud-btn', type: 'button', 'aria-label': t('hud.retry'), title: t('hud.retry') }, icon('retry')), () => d.emit('retry'));
  const pauseBtn = pointerButton(h('button', { class: 'hud-btn hud-btn--pause', type: 'button', 'aria-label': t('hud.pause'), title: t('hud.pause') },
    icon('pause', 'ico ico-pause'), icon('list', 'ico ico-menu')), () => d.emit('pause'));
  let menuMode = false;
  function setMenu(on: boolean): void {
    if (on === menuMode) return;
    menuMode = on;
    pauseBtn.toggleAttribute('data-menu', on);
    const label = on ? t('results.select') : t('hud.pause');
    pauseBtn.setAttribute('aria-label', label);
    pauseBtn.setAttribute('title', label);
  }

  const levelEl = h('div', { class: 'hud-level' });
  const clockNum = h('span', { class: 'num' }, '0.000');
  const clock = h('div', { class: 'hud-clock', role: 'timer', 'aria-label': t('hud.time') }, clockNum);
  const ready = h('span', { class: 'hud-ready' }, t('hud.ready'));
  const rack = h('span', { class: 'hud-rack', 'aria-label': t('hud.daily') });
  const modeChip = h('span', { class: 'chip hud-mode' });
  const sub = h('div', { class: 'hud-sub' });
  const center = h('div', { class: 'hud-center' });
  const offline = h('span', { class: 'chip chip--offline', title: t('hud.offline'), 'aria-label': t('hud.offline'), role: 'status' }, icon('offline'), h('span', { class: 'chip-text' }, t('hud.offline')));
  const right = h('div', { class: 'hud-right' });
  const band = h('div', { class: 'hud-band' }, retryBtn, center, right);

  // --- READY chips and the practice rewind (wide: a column under the band; tall: the status row)
  const chipBtn = (cls: string, ic: Parameters<typeof icon>[0], label: string, onClick: () => void): HTMLButtonElement =>
    pointerButton(h('button', { class: `chip chip-btn ${cls}`, type: 'button', 'aria-label': label, title: label }, icon(ic), h('span', { class: 'chip-label' }, label)), onClick);
  const infoBtn = chipBtn('', 'info', t('hud.info'), () => d.openInfo());
  const revBtn = chipBtn('chip--ai', 'reverse', t('hud.reverse'), () => d.emit('reverseHint'));
  const skipBtn = chipBtn('', 'skip', t('hud.skip'), () => d.emit('skip'));
  // Practice mode: 5 s rewind (§3.5, D3), available while running too. R held for 300 ms does the same.
  const rewindBtn = chipBtn('chip--practice', 'practice', t('hud.rewind'), () => d.emit('rewind', { seconds: 5 }));
  rewindBtn.setAttribute('aria-label', `${t('hud.rewind')} (${t('pause.rewindKey')})`);
  rewindBtn.setAttribute('aria-keyshortcuts', 'R');
  const rewindHint = h('div', { class: 'hud-rewind-hint' }, h('span', { class: 'kbd' }, 'R'), t('hud.rewindHint'));
  const chips = h('div', { class: 'hud-chips' });

  // --- egg tension gauge
  const tenFill = h('div', { class: 'hud-tension-fill' });
  const tenVal = h('span', { class: 'num' });
  const tension = h('div', { class: 'hud-tension', role: 'meter', 'aria-label': t('hud.tension') },
    h('div', { class: 'hud-tension-row' }, h('span', null, t('hud.tension')), tenVal),
    h('div', { class: 'hud-tension-bar' }, tenFill,
      h('i', { class: 'hud-tension-tick', style: 'left:75%' }), h('i', { class: 'hud-tension-tick', style: 'left:90%' })));

  // --- READY hint (wide: bottom centre; tall: the dock, never over the deck)
  const hintText = h('span');
  const hint = h('div', { class: 'hud-hint', role: 'status' }, h('span', { class: 'hud-hint-mark', 'aria-hidden': 'true' }, '!'), hintText);
  const fbar = createForceBar();
  const fbarWrap = h('div', { class: 'hud-force' }, fbar.el);

  // --- tall dock under the band (D10): status row, then the scoreboard (AI par | clock + split | PB) or the READY hint
  const cell = (cls: string, label: string): { el: HTMLElement; val: HTMLElement } => {
    const val = h('span', { class: 'hud-cell-val num' }, NO_VALUE);
    return { el: h('div', { class: `hud-cell ${cls}` }, h('span', { class: 'hud-cell-label' }, label), val), val };
  };
  const aiCell = cell('hud-cell--ai', t('hud.who.ai'));
  const pbCell = cell('hud-cell--pb', t('hud.who.pb'));
  const splitVal = h('span', { class: 'num' });
  const splitWho = h('span', { class: 'hud-split-who' });
  const splitEl = h('div', { class: 'hud-split', 'aria-live': 'polite' }, splitVal, splitWho);
  const clockCol = h('div', { class: 'hud-clockcol' });
  const board = h('div', { class: 'hud-board' }, aiCell.el, clockCol, pbCell.el);
  const statusEnd = h('div', { class: 'hud-status-end' });
  const status = h('div', { class: 'hud-status' });
  const panel = h('div', { class: 'hud-panel' });
  const dock = h('div', { class: 'hud-dock' }, status, panel);

  // --- world-anchored meters (SVG)
  const svg = s('svg', { class: 'hud-anchors', width: 10, height: 10, 'aria-hidden': 'true' }) as SVGSVGElement;
  const mBg = s('path', { fill: 'none', stroke: 'rgba(30,42,68,.35)', 'stroke-width': 2, 'stroke-linecap': 'round' });
  const mBand = s('path', { class: 'anc-meter-band', fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', opacity: 0.55 });
  const mAmp = s('path', { class: 'anc-meter-amp', fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
  const mTicks = s('path', { fill: 'none', stroke: 'rgba(30,42,68,.45)', 'stroke-width': 1.5 });
  const mLabel = s('text', { 'text-anchor': 'middle', 'font-size': 12, fill: '#1E2A44', stroke: '#F3EEE4', 'stroke-width': 3, 'paint-order': 'stroke' });
  const meter = s('g', { class: 'anc-meter' }, mBg, mTicks, mBand, mAmp, mLabel);

  const rGuide = s('path', { fill: 'none', stroke: '#1E2A44', 'stroke-width': 1.6, 'stroke-dasharray': '4 4', opacity: 0.6 });
  const rFill = s('path', { class: 'anc-req-fill', fill: 'none', 'stroke-width': 3.5, 'stroke-linecap': 'round' });
  const rLine = s('path', { class: 'anc-req-line', fill: 'none', stroke: '#1E2A44', 'stroke-width': 1.4, 'stroke-dasharray': '5 4' });
  const rLabel = s('text', { class: 'anc-req-label', 'font-size': 15, fill: '#1E2A44', stroke: '#F3EEE4', 'stroke-width': 4, 'paint-order': 'stroke', 'text-anchor': 'middle' });
  const rSpark = s('circle', { class: 'anc-req-spark', r: 10, fill: 'none', stroke: '#22B573', 'stroke-width': 3, opacity: 0 });
  const req = s('g', { class: 'anc-req' }, rGuide, rLine, rFill, rSpark, rLabel);

  const gPill = s('rect', { class: 'anc-gap-pill', rx: 9, ry: 9, height: 22, fill: '#1E2A44' });
  const gText = s('text', { x: 8, y: 15.5, 'font-size': 13, fill: '#FBF8F1' });
  const gTrack = s('rect', { x: 0, y: 26, height: 6, rx: 3, fill: 'rgba(30,42,68,.14)' });
  const gFill = s('rect', { x: 0, y: 26, height: 6, rx: 3, fill: '#22B573' });
  const gTick = s('rect', { y: 23, width: 2, height: 12, fill: '#1E2A44' });
  const gTickLabel = s('text', { y: 45, 'font-size': 9, fill: '#1E2A44', stroke: '#F3EEE4', 'stroke-width': 3, 'paint-order': 'stroke', 'text-anchor': 'middle' });
  const gap = s('g', { class: 'anc-gap' }, gPill, gText, gTrack, gFill, gTick, gTickLabel);

  const hBg = s('circle', { fill: 'none', stroke: 'rgba(34,181,115,.25)', 'stroke-width': 5 });
  const hRing = s('circle', { class: 'anc-hold-ring', fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round' });
  const hold = s('g', { class: 'anc-hold' }, hBg, hRing);
  svg.append(req, meter, gap, hold);

  const el = h('div', { class: 'yp-hud' }, svg, band, dock, chips, tension, hint, fbarWrap);
  root.appendChild(el);

  // --- state
  let level: LevelDef | null = null;
  let layout: Layout | null = null;
  let lastRunning: boolean | null = null;
  let lastReady: boolean | null = null;
  let lastMode = '';
  let lastSlow = false;
  let lastBalls: (string | null)[] | null = null;
  let lastHint: string | null | undefined;
  let lastHintShown: boolean | null = null;
  let lastTen = '';
  let lastOffline: boolean | null = null;
  let lastTension: boolean | null = null;
  let slackEv = false;
  let lastAmp = 0;
  let reached = false;
  let chipState = { info: false, reverse: false, skip: false };
  let targets: HudTargets = { ai: null, pb: null };
  let splitShown = false;
  const vis = new Map<Element, boolean>();
  const show = (e: HTMLElement | SVGElement, on: boolean): void => {
    if (vis.get(e) === on) return;
    vis.set(e, on);
    e.style.display = on ? '' : 'none';
  };
  show(tension, false);
  show(rewindBtn, false);
  show(rewindHint, false);
  show(hint, false);
  show(offline, false);
  show(modeChip, false);
  show(rack, false);
  for (const g of [meter, req, gap, hold]) show(g, false);

  // ------------------------------------------------------------ placement (wide corners / tall band + dock)

  let placed: 'wide' | 'tall' | null = null;
  function place(kind: 'wide' | 'tall'): void {
    if (placed === kind) return;
    placed = kind;
    if (kind === 'tall') {
      chips.replaceChildren(rewindBtn, infoBtn, revBtn, skipBtn);
      center.replaceChildren(levelEl, sub);
      sub.replaceChildren(ready);
      right.replaceChildren(pauseBtn);
      statusEnd.replaceChildren(tension, modeChip, rack, offline);
      status.replaceChildren(chips, statusEnd);
      clockCol.replaceChildren(clock, splitEl);
      panel.replaceChildren(hint, board, rewindHint);
    } else {
      center.replaceChildren(levelEl, clock, sub);
      sub.replaceChildren(ready, rack, modeChip);
      right.replaceChildren(offline, pauseBtn);
      chips.replaceChildren(rewindBtn, rewindHint, infoBtn, revBtn, skipBtn);
      status.replaceChildren();
      panel.replaceChildren();
      el.append(chips, tension, hint, fbarWrap);
    }
    fitDock();
  }

  /**
   * tall: the status row must never overflow sideways (320 px phones, long English labels). Measured only when its
   * content changes: first the offline chip drops its word, then the chip buttons their labels (44 px icon buttons with
   * aria-labels), then the mode chip and the rack get smaller, and last the offline chip goes.
   */
  function fitDock(): void {
    status.classList.remove('is-snug', 'is-tight', 'is-tighter', 'is-tightest');
    if (placed !== 'tall') return;
    let any = false;
    for (const c of [...chips.children, ...statusEnd.children]) if ((c as HTMLElement).style.display !== 'none') any = true;
    status.toggleAttribute('data-empty', !any);
    if (!any || !status.isConnected || status.clientWidth === 0) return;
    if (status.scrollWidth <= status.clientWidth + 1) return;
    // the 「オフライン」 chip (§7.12) keeps its word while there is room, and is the first to give it up
    status.classList.add('is-snug');
    if (status.scrollWidth <= status.clientWidth + 1) return;
    status.classList.add('is-tight');
    if (status.scrollWidth <= status.clientWidth + 1) return;
    status.classList.add('is-tighter');
    if (status.scrollWidth <= status.clientWidth + 1) return;
    status.classList.add('is-tightest');
  }
  place('wide');
  try {
    void document.fonts?.ready.then(() => fitDock());
  } catch {
    /* no font loading API */
  }

  let modeDirty = false;
  function refreshChips(): void {
    chipState = level ? d.chips() : { info: false, reverse: false, skip: false };
    try {
      targets = level && d.targets ? d.targets() : { ai: null, pb: null };
    } catch {
      targets = { ai: null, pb: null };
    }
    setText(aiCell.val, targets.ai !== null && Number.isFinite(targets.ai) ? fmtTime(targets.ai) : NO_VALUE);
    setText(pbCell.val, targets.pb !== null && Number.isFinite(targets.pb) ? fmtTime(targets.pb) : NO_VALUE);
    show(aiCell.el, targets.ai !== null);
    show(pbCell.el, targets.pb !== null);
    modeDirty = true; // practice mode may have been switched from the pause menu: re-read it on the next frame
    applyChips();
  }
  function applyChips(): void {
    const readyNow = lastReady === true;
    show(infoBtn, readyNow && chipState.info);
    show(revBtn, readyNow && chipState.reverse);
    show(skipBtn, readyNow && chipState.skip);
    fitDock();
  }

  function setLevel(l: LevelDef | null): void {
    level = l;
    if (l) {
      levelEl.replaceChildren(h('b', null, l.world === 0 ? t('hud.daily') : l.id), h('span', { class: 'hud-level-name' }, levelName(l)));
      levelEl.setAttribute('title', `${l.world === 0 ? t('hud.daily') : l.id} ${levelName(l)}`);
    } else {
      levelEl.replaceChildren();
    }
    refreshChips();
  }

  function resetSplit(): void {
    splitShown = false;
    show(splitEl, false);
  }

  function split(deltaSub: number, vs: GhostKind, index: number): boolean {
    if (placed !== 'tall' || !Number.isFinite(deltaSub)) return false;
    const n = level?.splits?.length ?? 1;
    setText(splitVal, fmtDelta(deltaSub, 2));
    setText(splitWho, `${n > 1 ? t('hud.splitN', { n: index + 1 }) : t('hud.split')} · ${t(vsKey(vs))}`);
    splitEl.setAttribute('data-behind', deltaSub > 0 ? '1' : '0');
    show(splitEl, true);
    splitEl.classList.remove('is-pop');
    void splitEl.offsetWidth; // restart the pop animation
    splitEl.classList.add('is-pop');
    splitShown = true;
    return true;
  }

  function hideAnchors(): void {
    show(meter, false);
    show(req, false);
    show(gap, false);
    show(hold, false);
  }

  function updateAnchors(hs: HudState, a: HudAnchors | null | undefined): void {
    if (!a || !level || hs.mode === 'demo') {
      hideAnchors();
      return;
    }
    // After the run (crash / success beat, pause of a started run): only the hold ring stays (it completes on
    // success, §9.5); the meters would clutter the stamp and the crash text.
    if (!hs.running && hs.timeSub > 0) {
      show(meter, false);
      show(req, false);
      show(gap, false);
      updateHold(a, hs, a.pxPerM && a.pxPerM > 0 ? a.pxPerM : Math.hypot(a.ball.x - a.pivot.x, a.ball.y - a.pivot.y) / level.physics.L);
      return;
    }
    const L = level.physics.L;
    const dx = a.ball.x - a.pivot.x;
    const dy = a.ball.y - a.pivot.y;
    const scale = a.pxPerM && a.pxPerM > 0 ? a.pxPerM : Math.hypot(dx, dy) / L;
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(a.pivot.x + a.pivot.y + a.ball.x + a.ball.y)) {
      hideAnchors();
      return;
    }
    const slack = a.slack ?? slackEv;
    const amp = slack ? lastAmp : Math.max(0, Math.min(90, Number.isFinite(hs.ampDeg) ? hs.ampDeg : 0));
    if (!slack) lastAmp = amp;

    // Swing meter under the trolley.
    const Rm = Math.max(26, Math.min(62, 0.3 * L * scale));
    show(meter, true);
    setAttr(meter, 'transform', `translate(${a.pivot.x.toFixed(1)} ${a.pivot.y.toFixed(1)})`);
    const span = 60;
    const bgD = arcPath(Rm, -span, span);
    if (mBg.getAttribute('d') !== bgD) {
      mBg.setAttribute('d', bgD);
      let ticks = '';
      for (let k = -span; k <= span; k += 15) {
        const r0 = Rm - (k === 0 ? 7 : 4);
        ticks += `M${(r0 * Math.sin(k * RAD)).toFixed(1)} ${(r0 * Math.cos(k * RAD)).toFixed(1)}L${(Rm * Math.sin(k * RAD)).toFixed(1)} ${(Rm * Math.cos(k * RAD)).toFixed(1)}`;
      }
      mTicks.setAttribute('d', ticks);
      setAttr(mLabel, 'y', (Rm + 16).toFixed(1));
    }
    const rest = hs.restDeg;
    setAttr(mBand, 'd', arcPath(Rm, -Math.min(rest, span), Math.min(rest, span)));
    const shown = Math.min(amp, span);
    setAttr(mAmp, 'd', shown < 0.4 ? '' : arcPath(Rm, -shown, shown));
    setAttr(meter, 'data-ok', amp <= rest ? '1' : '0');
    setAttr(meter, 'data-slack', slack ? '1' : '0');
    setText(mLabel, `${amp.toFixed(amp < 10 ? 1 : 0)}°`);

    // Required-angle arc toward the next wall.
    if (a.reqDeg !== null && a.reqDeg !== undefined && Number.isFinite(a.reqDeg)) {
      show(req, true);
      const dir = a.reqDir ?? 1;
      const Rr = Math.max(46, 0.56 * L * scale);
      const r = a.reqDeg;
      setAttr(req, 'transform', `translate(${a.pivot.x.toFixed(1)} ${a.pivot.y.toFixed(1)})`);
      setAttr(rGuide, 'd', arcPath(Rr, 0, dir * r));
      const f = Math.min(amp, r);
      setAttr(rFill, 'd', f < 0.5 ? '' : arcPath(Rr, 0, dir * f));
      const ex = Math.sin(dir * r * RAD);
      const ey = Math.cos(r * RAD);
      setAttr(rLine, 'd', `M0 0L${(ex * (Rr + 10)).toFixed(1)} ${(ey * (Rr + 10)).toFixed(1)}`);
      setAttr(rLabel, 'x', (ex * (Rr + 26)).toFixed(1));
      setAttr(rLabel, 'y', (ey * (Rr + 26) + 5).toFixed(1));
      setAttr(rSpark, 'cx', (ex * Rr).toFixed(1));
      setAttr(rSpark, 'cy', (ey * Rr).toFixed(1));
      setText(rLabel, `${Math.round(r)}°`);
      const now = amp >= r && !slack;
      if (now !== reached) {
        reached = now;
        setAttr(req, 'data-reached', now ? '1' : '0');
      }
    } else {
      show(req, false);
    }

    // Gap gauge next to the ball.
    const g = hs.nearGapMm;
    const ballR = 0.06 * scale;
    if (g !== null && g <= 250 && hs.running) {
      show(gap, true);
      const label = fmtGap(Math.max(0, g));
      setText(gText, label);
      const pillW = 16 + label.length * 7.6;
      setAttr(gPill, 'width', pillW.toFixed(0));
      const barW = Math.max(64, pillW);
      setAttr(gTrack, 'width', barW.toFixed(0));
      const frac = Math.sqrt(Math.max(0, Math.min(250, g)) / 250);
      setAttr(gFill, 'width', Math.max(3, frac * barW).toFixed(1));
      setAttr(gFill, 'fill', g <= 20 ? '#E5484D' : '#22B573');
      const tickX = Math.sqrt(20 / 250) * barW;
      setAttr(gTick, 'x', (tickX - 1).toFixed(1));
      setAttr(gTickLabel, 'x', tickX.toFixed(1));
      setText(gTickLabel, t('hud.paperLine'));
      setAttr(gap, 'data-red', g <= 20 ? '1' : '0');
      const W = layout?.w ?? 1e4;
      const flip = a.ball.x + ballR + 14 + barW > W - 8;
      const gx = flip ? a.ball.x - ballR - 14 - barW : a.ball.x + ballR + 14;
      setAttr(gap, 'transform', `translate(${gx.toFixed(1)} ${(a.ball.y - ballR - 30).toFixed(1)})`);
    } else {
      show(gap, false);
    }

    updateHold(a, hs, scale);
  }

  /** Hold ring around the ball: fills in 0.5 s while holding (§9.3). */
  function updateHold(a: HudAnchors, _hs: HudState, scale: number): void {
    const hf = a.holdFrac ?? 0;
    if (!(hf > 0) || !Number.isFinite(scale) || scale <= 0) {
      show(hold, false);
      return;
    }
    show(hold, true);
    const rr = 0.06 * scale + 9;
    const circ = 2 * Math.PI * rr;
    setAttr(hBg, 'r', rr.toFixed(1));
    setAttr(hRing, 'r', rr.toFixed(1));
    setAttr(hRing, 'stroke-dasharray', circ.toFixed(1));
    setAttr(hRing, 'stroke-dashoffset', ((1 - Math.min(1, hf)) * circ).toFixed(1));
    setAttr(hold, 'transform', `translate(${a.ball.x.toFixed(1)} ${a.ball.y.toFixed(1)}) rotate(-90)`);
  }

  function update(hs: HudState): void {
    // Clock: 2 decimals while running, 3 when final (§9.3).
    setText(clockNum, fmtTime(hs.timeSub, hs.running ? 2 : 3));
    let dockChanged = false;
    if (hs.running !== lastRunning) {
      lastRunning = hs.running;
      applyChips();
    }
    const isReady = !hs.running && hs.timeSub === 0 && hs.mode !== 'demo';
    if (isReady !== lastReady) {
      lastReady = isReady;
      show(ready, isReady);
      applyChips();
    }
    if (hs.offline !== lastOffline) {
      lastOffline = hs.offline;
      show(offline, hs.offline);
      dockChanged = true;
    }
    const slow = hs.mode === 'practice' && (hs.mode !== lastMode || modeDirty ? slowNow(hs.mode) : lastSlow);
    modeDirty = false;
    if (hs.mode !== lastMode || slow !== lastSlow) {
      lastMode = hs.mode;
      lastSlow = slow;
      show(rewindBtn, slow);
      show(rewindHint, slow);
      const m = hs.mode;
      if (m === 'practice' || m === 'demo' || m === 'challenge') {
        modeChip.className = `chip hud-mode ${m === 'practice' ? (slow ? 'chip--practice' : '') : m === 'demo' ? 'chip--ai' : ''}`;
        modeChip.replaceChildren(
          icon(m === 'practice' ? 'practice' : m === 'demo' ? 'demo' : 'star'),
          h('span', { class: 'chip-label' }, t(m === 'practice' ? (slow ? 'hud.practice' : 'hud.practiceFree') : m === 'demo' ? 'hud.demo' : 'hud.challenge')),
        );
        show(modeChip, true);
      } else {
        show(modeChip, false);
      }
      dockChanged = true;
    }
    if (!sameBalls(hs.dailyBalls, lastBalls)) {
      lastBalls = hs.dailyBalls ? hs.dailyBalls.slice() : null;
      rack.replaceChildren(...(hs.dailyBalls ?? []).map((b) => rackBall(b)));
      rack.setAttribute('aria-label', `${t('hud.daily')} ${(hs.dailyBalls ?? []).map((b) => t(`daily.ball.${b ?? 'empty'}` as 'daily.ball.ok')).join(', ')}`);
      show(rack, !!hs.dailyBalls);
      dockChanged = true;
    }
    const hasTen = hs.Tmax !== null && hs.Tmax > 0;
    if (hasTen !== lastTension) {
      lastTension = hasTen;
      show(tension, hasTen);
      dockChanged = true;
    }
    if (hasTen) {
      const T = Number.isFinite(hs.T) ? Math.max(0, hs.T) : 0;
      const f = Math.min(1, T / hs.Tmax!);
      const fs = f.toFixed(3);
      if (fs !== lastTen) {
        lastTen = fs;
        tenFill.style.transform = `scaleX(${fs})`;
      }
      setAttr(tension, 'data-level', f >= 0.9 ? 'red' : f >= 0.75 ? 'amber' : 'ok');
      setText(tenVal, `${T.toFixed(1)} / ${hs.Tmax!.toFixed(0)} N`);
    }
    if (hs.hint !== lastHint) {
      lastHint = hs.hint;
      if (hs.hint) setText(hintText, hs.hint);
    }
    const hintOn = !!hs.hint && !hs.running && hs.timeSub === 0;
    if (hintOn !== lastHintShown) {
      lastHintShown = hintOn;
      show(hint, hintOn);
      // tall: the READY hint takes the scoreboard's place until the run starts.
      show(board, !hintOn);
    }
    if (dockChanged) fitDock();
    fbar.update(hs.F, hs.Fmax, hs.aiF, hs.saturated);
    updateAnchors(hs, hs.anchors);
  }

  function fx(e: GameEvent): void {
    switch (e.t) {
      case 'slack':
        slackEv = true;
        break;
      case 'snap':
      case 'ready':
      case 'retry':
      case 'runStart':
        slackEv = false;
        if (e.t !== 'snap') {
          reached = false;
          setAttr(req, 'data-reached', '0');
        }
        if (e.t === 'ready' || e.t === 'retry' || (e.t === 'runStart' && splitShown)) resetSplit();
        break;
      case 'levelLoaded':
        resetSplit();
        break;
      case 'holdReset':
        if (e.frac >= 0.3) {
          hold.classList.remove('shake');
          void (hold as unknown as HTMLElement).getBoundingClientRect?.();
          hold.classList.add('shake');
        }
        break;
      default:
        break;
    }
  }

  function setLayout(l: Layout): void {
    layout = l;
    svg.setAttribute('width', String(l.w));
    svg.setAttribute('height', String(l.h));
    svg.setAttribute('viewBox', `0 0 ${l.w} ${l.h}`);
    el.style.setProperty('--hud-top', `${l.hudTop}px`);
    show(fbarWrap, l.kind === 'wide');
    place(l.kind);
    fitDock();
  }

  return {
    el,
    update,
    setLevel,
    setLayout,
    fx,
    split,
    refreshChips,
    setMenu,
    dispose() {
      el.remove();
    },
  };
}
