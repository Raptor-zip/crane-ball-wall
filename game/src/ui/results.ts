// Results card (success and failure versions) (GAME_DESIGN.md §9.4, §2.2, §8.4 item 9, §12.1 aiBeaten). Owner: O7.
import type { ResultsData, ScreenHandle } from './ui';
import type { Standing } from '../shared/rank';
import { BOARD_TOP_N } from '../shared/api';
import type { Channels, PauseInfo, ScreenEnv } from './context';
import type { BadgeId } from '../core/bus';
import type { LevelDef } from '../sim/level';
import { h, s } from './dom';
import { coin, crownBadge, icon } from './icons';
import type { IconName } from './icons';
import { NO_VALUE, fmtCount, fmtDelta, fmtMm, fmtNum, fmtTime, known, levelName, t } from './i18n/format';
import type { I18nKey } from './i18n/format';
import { fmtPct } from './share';
import { openShareSheet } from './sharesheet';
import { openAiLostCard } from './screens/notes';
import { wideRange } from './sideview';

export interface ResultsOpts { failText: string | null; pause: PauseInfo }

/** Results already announced (the card is re-rendered when coming back from the ranking or after a rotation). */
const announced = new WeakSet<ResultsData>();
/** Results cards whose rank stamp was pressed on screen: it animates once per card; re-renders show the final state. */
const stamped = new WeakSet<ResultsData>();

/** The rank stamp is pressed after the count-up (650 ms) and the medal fly, or when the answer arrives if later. */
const STAMP_AT_MS = 900;
/** How long the first-crown 「AIが負けた理由」 card waits for a rank-in answer that is still on its way. */
const AI_LOST_WAIT_MS = 3500;

/** Scrolls the card just enough that `row` is fully inside it (nothing when it already is). */
function revealRow(scroll: HTMLElement, row: HTMLElement, smooth: boolean): void {
  const s = scroll.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const pad = 8;
  let dy = Math.max(0, r.bottom - (s.bottom - pad));
  dy = Math.min(dy, Math.max(0, r.top - (s.top + pad)));   // never push the row's top out
  if (dy < 1) return;
  if (typeof scroll.scrollBy === 'function') scroll.scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'auto' });
  else scroll.scrollTop += dy;
}

/** What the rank row shows; the row is re-rendered only when this changes (checked on HUD frames). */
export function standingKey(s: Standing | null | undefined): string {
  return s ? `${s.phase}|${s.rank}|${s.n}|${s.pct}|${s.was}|${s.stamp}|${s.exact}|${s.candidate}|${s.forPb}` : '';
}

function stampWord(s: Standing): string {
  if (s.stamp === 'wr') return s.was === 1 ? t('results.stampWrAgain') : t('results.stampWr');
  return s.stamp === 'up' ? t('results.stampUp') : t('results.stampIn');
}

/**
 * The world rank row under the time (GAME_DESIGN.md §9.4 「結果カードの世界順位の行」). Honesty rule (§7.7): a rank shows without 約
 * only when the server confirmed it (`exact`, <= 100); every other number is an estimate and says so.
 * `press`: the stamp animates now (null: the final frame at once). Fills `el` and returns nothing.
 */
export function renderRankRow(el: HTMLElement, s: Standing, press: { delayMs: number } | null): void {
  el.replaceChildren();
  el.className = 'res-rank';
  const cnt = fmtCount;
  if (s.phase === 'confirmed' && s.stamp && s.rank !== null) {
    // Confirmed top 100: the stamp (ランクイン！ / ランクアップ！ / 世界一！) with the rank, pressed once per card.
    el.classList.add('res-rank--stamp');
    const word = stampWord(s);
    const stamp = h('div', { class: `stamp stamp--rank${s.stamp === 'wr' ? ' stamp--wr' : ''}`, 'aria-hidden': 'true' },
      h('span', { class: 'stamp-word' }, word), h('span', { class: 'stamp-num' }, t('unit.rank', { n: cnt(s.rank) })));
    const meta: string[] = [];
    if (s.stamp === 'in' && s.was !== null && s.was > BOARD_TOP_N) meta.push(t('results.rankFrom', { n: cnt(s.was) }));
    if (s.n !== null && s.n >= s.rank) meta.push(t('results.rankOf', { n: cnt(s.n) }));
    const climb = s.stamp === 'up' && s.was !== null && s.was > s.rank ? s.was - s.rank : null;
    const up = climb !== null ? h('span', { class: 'rank-up', 'aria-hidden': 'true' }, t('results.rankUpBy', { n: cnt(climb) })) : null;
    const subs = meta.map((m) => h('span', { class: 'res-rank-sub' }, m));
    if (press) {
      // The meta lines (N人中, 約N位から) come with the stamp, not before it: alone they read as loose fragments.
      const at = (x: HTMLElement, ms: number): void => {
        x.classList.add('is-new');
        x.style.setProperty('--rank-delay', `${Math.round(press.delayMs + ms)}ms`);
      };
      at(stamp, 0);
      for (const m of subs) at(m, 150);
      if (up) at(up, 350);
    }
    const aria = t('results.rankAria', { stamp: word, n: cnt(s.rank) });
    el.append(stamp,
      h('div', { class: 'res-rank-side' }, up, ...subs),
      h('span', { class: 'sr-only' }, climb !== null ? `${aria} ${t('results.rankUpAria', { n: cnt(climb) })}` : aria));
    return;
  }
  if (!s.forPb) {
    // A slower clear: where the personal best stands, muted.
    el.classList.add('res-rank--muted');
    el.append(h('span', { class: 'res-rank-pre' }, t('results.rankPbPrefix')));
  }
  const main = (text: string, quiet = false): HTMLElement => h('span', { class: `res-rank-main${quiet ? ' is-quiet' : ''}` }, text);
  const sub = (...parts: (string | null)[]): HTMLElement[] => {
    const p = parts.filter((x): x is string => !!x);
    return p.length ? [h('span', { class: 'res-rank-sub' }, p.join(t('results.rankSep')))] : [];
  };
  el.prepend(icon('trophy'));
  const r = s.rank;
  if (r !== null && r > BOARD_TOP_N) {
    // Outside the top 100: always an estimate from the histogram (約), with the crowd size and 上位 x %.
    el.append(main(t('results.rankApprox', { n: cnt(r) })),
      ...sub(s.n !== null ? t('results.rankOf', { n: cnt(s.n) }) : null, s.pct !== null ? t('results.rankTop', { p: fmtPct(s.pct) }) : null));
    if (s.forPb && s.was !== null && s.was > r) {
      el.append(h('span', { class: 'rank-up rank-up--muted', 'aria-hidden': 'true' }, t('results.rankUpByApprox', { n: cnt(s.was - r) })),
        h('span', { class: 'sr-only' }, t('results.rankUpApproxAria', { n: cnt(s.was - r) })));
    }
    return;
  }
  if (s.phase === 'pending') {
    el.classList.add('res-rank--wait');
    el.append(main(r !== null ? t('results.rankPending', { n: cnt(r) }) : t('results.rankPendingRange'), true));
    return;
  }
  if (s.phase === 'queued') {
    el.classList.add('res-rank--wait');
    el.append(main(r !== null ? t('results.rankQueued', { n: cnt(r) }) : t('results.rankQueuedNoNum'), true));
    return;
  }
  if (s.phase === 'held') {
    el.classList.add('res-rank--wait');
    el.append(main(r !== null ? t('results.rankHeld', { n: cnt(r) }) : t('results.rankHeldNoNum'), true));
    return;
  }
  if (r !== null) {
    el.append(main(s.exact ? t('results.rank', { n: cnt(r) }) : t('results.rankApprox', { n: cnt(r) })),
      ...sub(s.n !== null && s.n >= r ? t('results.rankOf', { n: cnt(s.n) }) : null));
    return;
  }
  el.append(main(s.candidate ? t('results.rankRange') : t('results.rankOut'), true));
}

const BADGE_GLYPH: Record<BadgeId, string> = { kamihitoe: '5', ippatsu: '1', hashidon: '端', pashi: 'J', buranko: '∿', yasashisa: '♡' };

function countUp(el: HTMLElement, target: number, reduce: boolean): void {
  if (reduce || typeof requestAnimationFrame !== 'function') {
    el.textContent = fmtTime(target);
    return;
  }
  const t0 = performance.now();
  const dur = 650;
  const step = (now: number): void => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtTime(Math.round(target * e));
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = fmtTime(0);
  requestAnimationFrame(step);
}

function bar(label: string, me: number, ai: number, fmt: (v: number) => string, max: number): HTMLElement {
  const frac = (v: number): number => Math.max(0.02, Math.min(1, v / max));
  const row = (who: string, v: number, cls: string): HTMLElement =>
    h('div', { class: 'cmp-bar' }, h('span', null, who),
      h('div', { class: 'cmp-track' }, known(v) && max > 0 ? h('div', { class: `cmp-fill ${cls}`, style: `width:${(frac(v) * 100).toFixed(1)}%` }) : null),
      h('span', { class: 'num' }, known(v) ? fmt(v) : NO_VALUE));
  return h('div', null,
    h('div', { class: 'cmp-row-label' }, h('span', null, label)),
    row(t('common.you'), me, 'cmp-fill--me'),
    row(t('common.ai'), ai, 'cmp-fill--ai'));
}

/** Largest known value (for a bar scale), at least `floor`. */
function scaleMax(floor: number, ...vals: number[]): number {
  let m = floor;
  for (const v of vals) if (known(v) && v > m) m = v;
  return m;
}

function polyline(vals: ArrayLike<number>, n: number, lo: number, hi: number, stride = 1, offset = 0): string {
  const pts: string[] = [];
  const count = Math.floor((vals.length - offset) / stride);
  if (count < 2) return '';
  const step = Math.max(1, Math.floor(count / 160));
  for (let i = 0; i < count; i += step) {
    const v = vals[offset + i * stride]!;
    const x = (i / (n - 1)) * 100;
    const y = 40 - ((v - lo) / (hi - lo || 1)) * 36 - 2;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

function graph(label: string, me: ArrayLike<number> | null, ai: ArrayLike<number> | null, stride = 1, offset = 0, meStride = stride, meOffset = offset, nMe?: number, nAi?: number): HTMLElement {
  const all: number[] = [];
  for (const [a, st, of] of [[me, meStride, meOffset], [ai, stride, offset]] as const) {
    if (!a) continue;
    for (let i = of; i < a.length; i += st) all.push(a[i]!);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of all) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = -1;
    hi = 1;
  }
  const pad = (hi - lo) * 0.08 || 0.1;
  lo -= pad;
  hi += pad;
  const lenMe = me ? nMe ?? Math.floor((me.length - meOffset) / meStride) : 0;
  const lenAi = ai ? nAi ?? Math.floor((ai.length - offset) / stride) : 0;
  const n = Math.max(lenMe, lenAi, 2);
  const svg = s('svg', { viewBox: '0 0 100 40', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    lo < 0 && hi > 0 ? s('line', { x1: 0, x2: 100, y1: 40 - ((0 - lo) / (hi - lo)) * 36 - 2, y2: 40 - ((0 - lo) / (hi - lo)) * 36 - 2, stroke: 'rgba(30,42,68,.18)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }) : null,
    ai ? s('polyline', { points: polyline(ai, n, lo, hi, stride, offset), fill: 'none', stroke: '#19C3FF', 'stroke-width': 2.2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }) : null,
    me ? s('polyline', { points: polyline(me, n, lo, hi, meStride, meOffset), fill: 'none', stroke: '#1E2A44', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }) : null);
  return h('div', { class: 'graph' }, h('div', { class: 'graph-label' }, label), svg);
}

let graphsSeq = 0;

/**
 * You vs the AI graphs (x, θ, F; the ball height when only the strobe is known). Few players read them, so they start
 * closed behind a quiet text toggle under the bars and take no room on the card until it is pressed.
 */
function graphs(env: ScreenEnv, data: ResultsData): HTMLElement | null {
  let tracks = null;
  try {
    tracks = env.ctx.compare?.(data) ?? null;
  } catch {
    tracks = null;
  }
  const id = `res-graphs-${++graphsSeq}`;
  const body = h('div', { class: 'graphs', id, role: 'group', 'aria-label': t('results.graphs'), hidden: true });
  if (tracks && (tracks.me || tracks.ai)) {
    const me: Channels | null = tracks.me;
    const ai: Channels | null = tracks.ai;
    const toDeg = (a: Float32Array | undefined): Float32Array | null => (a ? a.map((v) => (v * 180) / Math.PI) : null);
    body.append(
      graph(t('results.graph.x'), me?.x ?? null, ai?.x ?? null),
      graph(t('results.graph.th'), toDeg(me?.th), toDeg(ai?.th)),
      graph(t('results.graph.f'), me?.f ?? null, ai?.f ?? null));
  } else {
    // Fallback: ball height from the strobe (10 Hz) against the AI ball path (60 Hz pairs).
    let aiPath: Float32Array | null = null;
    try {
      aiPath = env.ctx.aiPath?.(data.level.id) ?? null;
    } catch {
      aiPath = null;
    }
    if (data.strobe.length < 4 && !aiPath) return null;
    const nMe = data.strobe.length / 2;
    const nAi = aiPath ? aiPath.length / 2 : 0;
    // Put both on the same time axis: strobe 0.1 s, AI 1/60 s.
    const tMax = Math.max(nMe * 0.1, nAi / 60);
    const resample = (a: ArrayLike<number>, dt: number, off: number): Float32Array => {
      const out = new Float32Array(120);
      for (let i = 0; i < 120; i++) {
        const tt = (i / 119) * tMax;
        const k = Math.min(a.length / 2 - 1, Math.floor(tt / dt));
        out[i] = a[k * 2 + off]!;
      }
      return out;
    };
    body.append(graph(t('results.graph.y'), data.strobe.length >= 4 ? resample(data.strobe, 0.1, 1) : null, aiPath ? resample(aiPath, 1 / 60, 1) : null));
  }
  body.append(h('div', { class: 'graph-legend' },
    h('span', null, h('i', { style: 'background:#1E2A44' }), t('common.you')),
    h('span', null, h('i', { style: 'background:#19C3FF' }), t('common.ai'))));
  const label = h('span', null, t('results.graphsShow'));
  const btn = h('button', { class: 'btn btn--flat graphs-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': id }, label, icon('next'));
  btn.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    label.textContent = open ? t('results.graphsHide') : t('results.graphsShow');
  });
  return h('div', { class: 'res-graphs' }, btn, body);
}

/**
 * G / H / ? / M without keys (§3.3). The state shown is re-read from the game after every tap (core skips ghost sets
 * that are not available, e.g. WR offline) and on every HUD frame (the G / H / M keys work on this screen too).
 */
function keyButtons(env: ScreenEnv, data: ResultsData): { el: HTMLElement; sync(): void } {
  const mk = (ic: IconName, label: string, kbd: string, a: 'ghostCycle' | 'aiLine' | 'notes' | 'mute', payload?: unknown, state = false): { b: HTMLButtonElement; label: HTMLElement; state: HTMLElement | null } => {
    const labelEl = h('span', null, label);
    const stateEl = state ? h('span', { class: 'btn-state' }) : null;
    const b = h('button', { class: 'btn', type: 'button', title: `${label} (${kbd})` }, icon(ic), labelEl, stateEl, h('span', { class: 'kbd' }, kbd));
    b.addEventListener('click', () => {
      env.emit(a, payload);
      sync();
    });
    return { b, label: labelEl, state: stateEl };
  };
  const ghost = mk('ghost', '', 'G', 'ghostCycle');
  const line = mk('line', t('pause.aiLine'), 'H', 'aiLine', undefined, true);
  const notes = mk('book', t('pause.notes'), '?', 'notes', { world: data.level.world });
  notes.b.setAttribute('aria-label', `${t('pause.notes')} (?)`);
  const mute = mk('sound', t('pause.mute'), 'M', 'mute', undefined, true);
  let shown = '';
  function sync(): void {
    let pi: PauseInfo;
    try {
      pi = env.pauseInfo();
    } catch {
      return;
    }
    const key = `${pi.ghostSet}|${pi.aiLine}|${pi.muted}`;
    if (key === shown) return;
    shown = key;
    const set = t(`pause.ghostSet.${pi.ghostSet}` as 'pause.ghostSet.0');
    ghost.label.textContent = set;
    ghost.b.setAttribute('aria-label', `${t('pause.ghosts')} ${set} (G)`);
    const onOff = (on: boolean): string => (on ? t('common.on') : t('common.off'));
    line.state!.textContent = onOff(pi.aiLine);
    line.state!.classList.toggle('is-on', pi.aiLine);
    line.b.setAttribute('aria-label', `${t('pause.aiLine')} ${onOff(pi.aiLine)} (H)`);
    line.b.setAttribute('aria-pressed', pi.aiLine ? 'true' : 'false');
    mute.state!.textContent = onOff(pi.muted);
    mute.state!.classList.toggle('is-on', pi.muted);
    mute.b.setAttribute('aria-label', `${t('pause.mute')} ${onOff(pi.muted)} (M)`);
    mute.b.setAttribute('aria-pressed', pi.muted ? 'true' : 'false');
    mute.b.querySelector('svg')?.replaceWith(icon(pi.muted ? 'mute' : 'sound'));
  }
  sync();
  return { el: h('div', { class: 'res-keys', role: 'group', 'aria-label': t('results.more') }, ghost.b, line.b, notes.b, mute.b), sync };
}

/** wide: the side of the screen the results card takes (away from the goal zone, which stays visible). */
export function resultsSide(lv: LevelDef): 'left' | 'right' {
  const wr = wideRange(lv);
  const last = lv.physics.phases[lv.physics.phases.length - 1];
  if (!last) return 'right';
  return (last.xa + last.xb) / 2 > (wr.x0 + wr.x1) / 2 ? 'left' : 'right';
}

export function renderResults(root: HTMLElement, data: ResultsData, env: ScreenEnv, opts?: ResultsOpts): ScreenHandle {
  const pi: PauseInfo = opts?.pause ?? env.pauseInfo();
  const reduce = env.reducedMotion();
  const still = !!root.closest('.yp--still');
  const openAt = performance.now();
  let rankEl: HTMLElement | null = null;
  let rankKey = '';
  let syncRank: (() => void) | null = null;
  /** performance.now() when this card's rank stamp has finished landing (null: no stamp pressed on this card). */
  let stampLandsAt: number | null = null;
  const lv = data.level;
  const run = env.lastRun();
  const unrecorded = run.practice || run.assist;
  const side = resultsSide(lv);
  const card = h('section', { class: 'sheet res screen-enter', 'data-side': side, role: 'dialog', 'aria-label': `${t('results.label')} ${lv.id} ${levelName(lv)}` });
  const head = h('div', { class: 'res-head' }, h('span', { class: 'idchip' }, lv.world === 0 ? t('hud.daily') : lv.id), h('span', { class: 'res-name' }, levelName(lv)));
  const scroll = h('div', { class: 'res-scroll' }, head);

  const retry = h('button', { class: 'btn btn--primary btn--lg', type: 'button', 'data-autofocus': '' }, icon('retry'), t('results.retry'), h('span', { class: 'kbd' }, 'R'));
  retry.addEventListener('click', () => env.emit('retry'));
  const demo = h('button', { class: 'btn btn--ai', type: 'button' }, icon('demo'), t('results.demo'));
  demo.addEventListener('click', () => env.emit('demo'));

  let online = false;
  try {
    online = !!env.ctx.boot?.() || data.rank !== null || data.aiBeaten !== null;
  } catch {
    online = data.rank !== null || data.aiBeaten !== null;
  }

  const foot = h('div', { class: 'res-foot' });
  let keys: { el: HTMLElement; sync(): void } | null = null;

  if (data.ok && known(data.score)) {
    const score = data.score;
    card.append(h('div', { class: 'res-stamp', 'aria-hidden': 'true' }, h('div', { class: 'stamp stamp--sm' }, t('pop.stamp'))));
    // Time. The ribbon follows the game's own verdict (the 'success' event) when there is one: practice and assisted
    // runs never become a PB (§3.5, §3.6).
    const num = h('span', { class: 'num' }, fmtTime(score));
    // core's pb flag means "beat an existing best" (false on a first clear), so a first clear is read from pbSub.
    const firstClear = data.pbSub === null;
    const isPb = !firstClear && (run.pb ?? score < data.pbSub!);
    const ribbon = unrecorded
      ? h('span', { class: 'ribbon ribbon--muted' }, run.assist ? t('results.assisted') : t('results.practice'))
      : firstClear || isPb
        ? h('span', { class: 'ribbon' }, firstClear ? t('results.firstClear') : t('results.newPb'))
        : null;
    const timeRow = h('div', { class: 'res-time', 'aria-label': `${t('results.time')} ${fmtTime(score)}` }, num, h('small', null, t('unit.s', { v: '' }).trim()), ribbon);
    scroll.append(timeRow);
    countUp(num, score, reduce || still);

    // World rank row (level clears with a standing from core; never the daily, practice or assist).
    syncRank = (): void => {
      const st = data.standing ?? null;
      const k = !unrecorded && lv.world !== 0 ? standingKey(st) : '';
      if (k === rankKey) return;
      rankKey = k;
      if (!k || !st) {
        rankEl?.remove();
        rankEl = null;
        return;
      }
      if (!rankEl) {
        rankEl = h('div', { class: 'res-rank', 'aria-live': 'polite' });
        timeRow.after(rankEl);
      }
      let press: { delayMs: number } | null = null;
      if (st.phase === 'confirmed' && st.stamp && !stamped.has(data)) {
        press = { delayMs: still ? 0 : Math.max(0, openAt + STAMP_AT_MS - performance.now()) };
        if (!still) stampLandsAt = performance.now() + press.delayMs + (reduce ? 300 : 450);
        // Pressed once the card stays on screen: a card drawn and replaced at once (back from the replay viewer core
        // shows the card, then the ranking over it) presses when it is really shown.
        const row = rankEl;
        queueMicrotask(() => {
          if (root.contains(row)) stamped.add(data);
        });
      }
      renderRankRow(rankEl, st, press);
      if (press) {
        // A short card (a phone held sideways) can have the row below the fold: bring it in just before the press.
        const row = rankEl;
        const lead = reduce || still ? 0 : 280;
        window.setTimeout(() => {
          if (row.isConnected) revealRow(scroll, row, !reduce && !still);
        }, Math.max(0, press.delayMs - lead));
      }
    };
    syncRank();

    // Medal.
    const medalEl = data.crown ? crownBadge('crown medal-fly') : coin(data.medal, 'coin medal-fly');
    const medalName = data.crown ? t('results.medal.crown') : t(`results.medal.${data.medal}` as 'results.medal.0');
    let nextText = '';
    if (data.crown) nextText = t('results.allMedals');
    else if (data.nextMedalSub !== null && known(data.nextMedalSub)) {
      const nextName = data.medal >= 3 ? t('results.short.crown') : t(`results.short.${data.medal + 1}` as 'results.short.1');
      nextText = t('results.nextMedal', { medal: nextName, s: fmtTime(Math.max(1, score - data.nextMedalSub)) });
    }
    const slots = h('div', { class: 'res-slots', 'aria-hidden': 'true' }, coin(data.medal >= 1 ? 1 : 0), coin(data.medal >= 2 ? 2 : 0), coin(data.medal >= 3 ? 3 : 0), data.crown ? crownBadge() : h('span', { style: 'width:26px;height:26px;border:2px dashed currentColor;border-radius:50%;display:inline-block' }));
    scroll.append(h('div', { class: 'res-medal' }, medalEl, h('div', null, h('div', { class: 'res-medal-name' }, medalName), nextText ? h('div', { class: 'res-medal-next' }, nextText) : null), slots));

    // Deltas.
    const dl = (label: string, d: number | null, cls = ''): HTMLElement | null =>
      d === null || !known(d) ? null : h('div', { class: `dlt ${cls} ${d < 0 ? 'dlt--good' : d > 0 ? 'dlt--bad' : ''}` }, h('div', { class: 'dlt-label' }, label), h('div', { class: 'dlt-val' }, fmtDelta(d)));
    scroll.append(h('div', { class: 'res-deltas' },
      dl(t('results.pbDelta'), data.pbSub !== null ? score - data.pbSub : null),
      dl(t('results.aiDelta'), score - data.parSub, 'dlt--ai'),
      dl(t('results.wrDelta'), data.wrSub !== null ? score - data.wrSub : null)));

    // You vs AI bars (§2.2: cyan and gold). Unknown AI values (missing summary) show a dash, never "NaN".
    const cmp = h('div', { class: 'cmp' },
      bar(t('results.time'), score, data.parSub, (v) => fmtTime(v), scaleMax(0, score, data.parSub) * 1.08));
    if (lv.physics.walls.length > 0 && known(data.gapMm)) {
      cmp.append(bar(t('results.gap'), data.gapMm, data.aiGapMm, (v) => t('unit.mm', { v: fmtMm(v) }), scaleMax(40, data.gapMm, data.aiGapMm) * 1.08));
    }
    if (known(data.peakF)) cmp.append(bar(t('results.peak'), data.peakF, data.aiPeakF, (v) => t('unit.N', { v: fmtNum(v, 1) }), scaleMax(lv.physics.Fmax, data.peakF, data.aiPeakF)));
    scroll.append(cmp);

    const g = graphs(env, data);
    if (g) scroll.append(g);

    if (data.badges.length && !announced.has(data)) {
      // §7.3: badges are announced with a toast on the results card, one after another.
      announced.add(data);
      data.badges.forEach((b, i) => {
        window.setTimeout(() => {
          if (card.isConnected) env.toast(t('badge.toast', { name: t(`badge.${b}` as 'badge.kamihitoe') }), 'cardBadge');
        }, still ? 0 : 700 + i * 450);
      });
    }
    if (data.badges.length) {
      scroll.append(h('div', { class: 'eyebrow', style: 'margin-bottom:6px' }, t('results.badges')),
        h('div', { class: 'badges' }, ...data.badges.map((b) => h('span', { class: 'badge', title: t(`badge.${b}.desc` as 'badge.kamihitoe.desc') },
          h('span', { class: 'badge-dot' }, BADGE_GLYPH[b]), t(`badge.${b}` as 'badge.kamihitoe')))));
    }
    if (data.skins?.length) {
      // Skins this run unlocked (§7.14): their toast can find no room next to the card on a small phone; this line stays.
      scroll.append(h('div', { class: 'eyebrow', style: 'margin-bottom:6px' }, t('results.skins')),
        h('div', { class: 'badges res-skins' }, ...data.skins.map((id) => h('span', { class: 'badge' },
          h('span', { class: 'badge-dot', 'aria-hidden': 'true' }, icon('brush')), t(`skin.${id}.name` as I18nKey)))));
    }
    const onlineChips = h('div', { class: 'res-online' },
      data.aiBeaten !== null ? h('span', { class: 'chip chip--ai' }, icon('crown'), t('results.aiBeaten', { n: fmtCount(data.aiBeaten) })) : null);
    if (onlineChips.childElementCount) scroll.append(onlineChips);

    // Footer buttons.
    const next = h('button', { class: 'btn btn--lg', type: 'button' }, t('results.next'), h('span', { class: 'kbd' }, 'N'), icon('next'));
    next.addEventListener('click', () => env.emit('next'));
    const share = h('button', { class: 'btn btn--gold', type: 'button' }, icon('share'), t('results.share'));
    share.addEventListener('click', () => {
      // Daily runs share the Wordle-style daily line (§7.13); campaign runs the strobe card and the challenge link.
      let daily = null;
      if (lv.world === 0) {
        try {
          daily = env.ctx.daily?.() ?? null;
        } catch {
          daily = null;
        }
      }
      env.emit('share', { kind: daily ? 'daily' : 'level', level: lv.id });
      openShareSheet(root, env, daily ? { kind: 'daily', view: daily } : { kind: 'level', data });
    });
    const board = h('button', { class: 'btn', type: 'button', disabled: !online }, icon('trophy'), t('results.board'));
    board.addEventListener('click', () => env.emit('board', { level: lv.id }));
    foot.append(
      h('div', { class: 'res-main' }, retry, lv.world === 0 ? h('span') : next),
      h('div', { class: 'res-row' }, demo, online ? board : null, share));
    keys = keyButtons(env, data);
    scroll.append(keys.el);
    if (!online) foot.querySelector('.res-row')!.setAttribute('style', 'grid-template-columns:repeat(2,minmax(0,1fr))');

    // "Why the AI lost" (first crown ever, once, §5.4). A first crown is often a rank-in too: the card waits for the
    // rank stamp to land (and for a rank-in answer still on its way, up to AI_LOST_WAIT_MS) so it never covers it.
    const save = env.save();
    if (data.crown && save && !save.seen.aiLostCard) {
      const openAiLost = (): void => {
        if (!root.isConnected || !card.isConnected) return;
        if (!still) {
          syncRank?.();
          const now = performance.now();
          if (stampLandsAt !== null && now < stampLandsAt + 250) {
            window.setTimeout(openAiLost, stampLandsAt + 250 - now);
            return;
          }
          if (data.standing?.phase === 'pending' && now - openAt < AI_LOST_WAIT_MS) {
            window.setTimeout(openAiLost, 200);
            return;
          }
        }
        openAiLostCard(root, env, lv);
      };
      window.setTimeout(openAiLost, reduce || still ? 0 : 1100);
    }
  } else {
    card.append(h('div', { class: 'res-stamp', 'aria-hidden': 'true' }, h('div', { class: 'stamp stamp--sm stamp--fail' }, '×')));
    scroll.append(
      h('div', { class: 'res-time res-time--fail' }, h('span', { class: 'num res-fail-title' }, t('fail.title')),
        unrecorded ? h('span', { class: 'ribbon ribbon--muted' }, run.assist ? t('results.assisted') : t('results.practice')) : null),
      h('div', { class: 'eyebrow' }, t('fail.lead')),
      h('div', { class: 'res-fail-cause', role: 'status' }, icon('close'), h('span', null, opts?.failText ?? data.failReason ?? t('fail.none'))));
    const sel = h('button', { class: 'btn', type: 'button' }, icon('list'), t('results.select'));
    sel.addEventListener('click', () => env.emit('select', { from: 'results' }));
    const extra: HTMLElement[] = [];
    if (pi.skipAvailable) {
      const sk = h('button', { class: 'btn', type: 'button' }, icon('skip'), t('pause.skip'));
      sk.addEventListener('click', () => env.emit('skip'));
      extra.push(sk);
    }
    if (pi.assistOffered && !pi.assist) {
      const as = h('button', { class: 'btn btn-stack', type: 'button' }, h('span', null, t('pause.assist')), h('span', { class: 'btn-sub' }, t('pause.assistNote')));
      as.addEventListener('click', () => {
        env.emit('assistAccept', { on: true });
        as.setAttribute('disabled', '');
        env.toast(`${t('pause.assist')}: ${t('common.on')}`, 'info');
      });
      extra.push(as);
    }
    card.setAttribute('data-fail', '');
    keys = keyButtons(env, data);
    scroll.append(keys.el);
    foot.append(
      h('div', { class: 'res-main' }, retry, demo),
      h('div', { class: 'res-row', style: `grid-template-columns:repeat(${1 + extra.length},minmax(0,1fr))` }, sel, ...extra));
  }

  card.append(scroll, foot);
  root.appendChild(card);
  let frames = 0;
  return {
    onHud() {
      // Keys pressed on this screen (G / H / M) change the state behind the buttons: follow it a few times a second.
      if (++frames % 12 === 0) keys?.sync();
      // core replaces data.standing when the server answers (rank-in send): the rank row follows it.
      if (frames % 6 === 0) syncRank?.();
    },
    onEscape() {
      // the same as the ⏸ corner button here: to the level select (core; the run is over)
      env.emit('pause');
    },
  };
}
