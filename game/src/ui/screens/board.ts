// Leaderboard (top 100, server-verified) (GAME_DESIGN.md §7.7, §9.4). Owner: O7.
// Renders at once from the boot top 10 (skeleton rows below) and is replaced by GET /api/board/<key>. My row is marked,
// flashed once and scrolled to; when I am not in the list, a pinned 「あなた」 row says where my best stands (§9.4).
import type { BoardRow } from '../../shared/api';
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import type { SaveV1 } from '../../store/save';
import { BOARD_TOP_N, BOOT_TOP_N, HIST_BINS, histBin, parseBoardKey, pctFromHist } from '../../shared/api';
import { LEVEL_HIST_BINS, estimateLevelRank, levelBin, levelPct, localRank, padHist } from '../../shared/rank';
import { displayName } from '../../shared/names';
import { h } from '../dom';
import { icon } from '../icons';
import { fmtCount, fmtTime, getLang, levelName, t } from '../i18n/format';
import { fmtPct } from '../share';

/** Generated display name (§7.7); falls back to "#0000" while the word lists are unavailable. */
export function safeName(nameSeed: number, pidh: string): string {
  try {
    const n = displayName(nameSeed, pidh, getLang());
    if (n) return n;
  } catch {
    /* names.ts not ready */
  }
  const num = (parseInt(pidh.slice(0, 4), 16) || 0) % 10000;
  return `#${String(num).padStart(4, '0')}`;
}

/** The one-time flash of my row (styles.css yp-me-flash). */
const ME_FLASH_MS = 1400;

/** Closest-gap column: '—' on levels without walls (gapUm < 0, NO_WALL_GAP_UM), empty when unknown. */
export function gapCell(gapUm: number | null | undefined): string {
  if (gapUm === null || gapUm === undefined || !Number.isFinite(gapUm) || gapUm >= 1e7) return '';
  if (gapUm < 0) return NO_GAP;
  return t('unit.mm', { v: Math.round(gapUm / 1000) });
}

/** Shown in the gap column when the level has no walls (1-1): there is no clearance to measure. */
export const NO_GAP = '—';

/**
 * The ranking table. `partial`: `rows` is only the head of the list (the boot top 10), so an AI slower than all of them
 * is not placed after the last row (it can be anywhere below).
 */
export function boardTable(rows: BoardRow[], opts: { mePidh?: string | null; parSub?: number | null; startRank?: number; partial?: boolean }): HTMLElement {
  const tbody = h('tbody');
  let aiPlaced = opts.parSub === null || opts.parSub === undefined;
  const aiRow = (): HTMLElement => h('tr', { class: 'is-ai' },
    h('td', null, icon('crown', 'ico')),
    h('td', { class: 'b-name' }, t('board.aiRow')),
    h('td', { class: 'b-num' }, fmtTime(opts.parSub!)),
    h('td', { class: 'b-num' }, ''));
  rows.forEach((r, i) => {
    const [pidh, seed, t120, gapUm] = r;
    if (!aiPlaced && t120 >= opts.parSub!) {
      tbody.appendChild(aiRow());
      aiPlaced = true;
    }
    const rank = (opts.startRank ?? 1) + i;
    const me = !!opts.mePidh && pidh === opts.mePidh;
    tbody.appendChild(h('tr', { class: me ? 'is-me' : '', 'data-rank': rank },
      h('td', null, String(rank)),
      h('td', { class: 'b-name' }, h('div', { class: 'b-name-wrap' }, h('span', null, safeName(seed, pidh)), me ? h('span', { class: 'me-chip' }, t('common.you')) : null)),
      h('td', { class: 'b-num' }, fmtTime(t120)),
      h('td', { class: 'b-num' }, gapCell(gapUm))));
  });
  if (!aiPlaced && rows.length < 100 && !opts.partial) tbody.appendChild(aiRow());
  return h('table', { class: 'board' },
    h('thead', null, h('tr', null,
      h('th', null, t('board.col.rank')), h('th', null, t('board.col.name')), h('th', { style: 'text-align:right' }, t('board.col.time')), h('th', { style: 'text-align:right' }, t('board.col.gap')))),
    tbody);
}

/** One board as the screen shows it: the boot copy (top 10, `complete` false) or the /api/board answer (top 100). */
export interface BoardView {
  n: number; aiBeaten: number; par: number; cutoff: number | null; top: BoardRow[];
  hist: number[] | null;         // padded (level 153 / daily 150 bins); null when absent or malformed
  cleared: number | null;        // daily only
  complete: boolean;             // top is the whole top 100 (or the whole board), not the boot top 10
}

/** Where my best stands when I am not in the list (the pinned 「あなた」 row). */
export interface PinInfo {
  time: number;
  rank: number | null;           // null: unknown (shown as –)
  approx: boolean;               // 約: every rank the server did not confirm, and every rank >= 101
  pct: number | null;
  status: 'pending' | 'out' | null;   // pending: in the top-100 range but not in the list yet; out: outside, no estimate
  unsent: boolean;               // the server does not count this time yet
}

/** The level progress hash a board key belongs to (core/progress.ts progressHash: sim 1 keeps the bare level hash). */
const progressHashOf = (levelHash: string, sim: number): string => (sim === 1 ? levelHash : `${levelHash}:s${sim}`);

/** The pinned row of a level board: my stored best on this board's hash (§9.4). Null when I am in the list or have no best. */
export function levelPin(v: BoardView, save: SaveV1 | null, key: string): PinInfo | null {
  const k = parseBoardKey(key);
  if (!save || !k || k.kind !== 'L') return null;
  const p = save.levels[k.levelId];
  const me = save.id.pidh;
  if (!p || p.hash !== progressHashOf(k.levelHash, k.sim) || p.bestSub === null || !Number.isFinite(p.bestSub)) return null;
  if (v.top.some((r) => r[0] === me)) return null;
  const best = p.bestSub;
  const counted = p.sentSub ?? null;
  const unsent = counted === null || levelBin(best) !== levelBin(counted);
  if (v.cutoff === null || best < v.cutoff) {
    // The top-100 range. My best belongs among the rows shown but is not there: the server has not got (or not
    // ranked) it yet.
    const last = v.top[v.top.length - 1];
    if (v.complete || v.top.length < BOOT_TOP_N || (last && best < last[2])) return { time: best, rank: null, approx: true, pct: null, status: unsent ? null : 'pending', unsent };
    // Only the boot top 10: somewhere below them (a local estimate).
    const L = localRank({ top: v.top, cutoff: v.cutoff, hist: v.hist, complete: false }, best, me, counted);
    return { time: best, rank: L.rank, approx: true, pct: null, status: null, unsent };
  }
  const e = v.hist ? estimateLevelRank(v.hist, v.cutoff, best, counted) : null;
  if (!e) return { time: best, rank: null, approx: true, pct: null, status: 'out', unsent };
  return { time: best, rank: e.rank, approx: true, pct: levelPct(e.rank, e.n), status: null, unsent };
}

/** Daily rank from the 150-bin histogram without the 101 floor (estimateDailyRank clamps; here <= 100 means "not below the list"). */
function dailyRawRank(hist: readonly number[], t120: number): number {
  const b = histBin(t120);
  let faster = 0;
  for (let i = 0; i < b; i++) faster += hist[i] ?? 0;
  return Math.floor(faster + (hist[b] ?? 0) / 2) + 1;
}

/**
 * The pinned row of today's daily board: the rank of the last submit answer (`day.rank`), else the histogram estimate.
 * Ranks above 100 are estimates (約). A best that belongs in the list shown but is not there is 反映待ち (or 未送信).
 */
export function dailyPin(v: BoardView, save: SaveV1 | null, key: string, day: { dayIndex: number; bestSub: number | null; rank: number | null; pct: number | null } | null): PinInfo | null {
  const k = parseBoardKey(key);
  if (!save || !k || k.kind !== 'D' || !day || day.dayIndex !== k.dayIndex || day.bestSub === null) return null;
  if (v.top.some((r) => r[0] === save.id.pidh)) return null;
  const best = day.bestSub;
  const d = save.daily;
  const unsent = d.dayIndex !== k.dayIndex || d.lastSentT120 === null || best < d.lastSentT120;
  const pct = day.pct ?? (v.hist && v.cleared !== null ? pctFromHist(v.hist, best, v.cleared) : null);
  const last = v.top[v.top.length - 1] ?? null;
  // Where the best falls against the rows shown: in them, below the 100th, or below the boot top 10 (unknown).
  const where = v.complete
    ? v.top.length >= BOARD_TOP_N && last !== null && best >= last[2] ? 'below' : 'in'
    : v.top.length < BOOT_TOP_N || (last !== null && best < last[2]) ? 'in' : 'unknown';
  if (where === 'in') return { time: best, rank: null, approx: true, pct: null, status: unsent ? null : 'pending', unsent };
  let rank = day.rank !== null && (day.rank > BOARD_TOP_N || where === 'unknown') ? day.rank : null;
  if (rank === null && v.hist) {
    const raw = dailyRawRank(v.hist, best);
    if (raw > BOARD_TOP_N) rank = raw;
  }
  if (rank === null) return { time: best, rank: null, approx: true, pct, status: where === 'below' ? 'out' : null, unsent };
  return { time: best, rank, approx: rank > BOARD_TOP_N, pct, status: null, unsent };
}

function pinRow(p: PinInfo): HTMLElement {
  const rankText = p.rank === null ? '–' : p.approx ? t('board.meApprox', { n: fmtCount(p.rank) }) : t('unit.rank', { n: fmtCount(p.rank) });
  const sub = p.status === 'pending' ? t('board.mePending') : p.status === 'out' ? t('board.meOut') : p.pct !== null ? t('board.meTop', { p: fmtPct(p.pct) }) : null;
  return h('div', { class: 'board-pin', role: 'group', 'aria-label': `${t('common.you')} ${p.rank === null ? '' : rankText} ${fmtTime(p.time)}`.replace(/\s+/g, ' ') },
    h('span', { class: 'board-pin-rank' }, rankText),
    h('span', { class: 'board-pin-who' },
      h('span', { class: 'board-pin-line' }, h('span', { class: 'me-chip' }, t('common.you')), p.unsent ? h('span', { class: 'board-pin-tag' }, t('board.meUnsent')) : null),
      sub ? h('span', { class: 'board-pin-sub' }, sub) : null),
    h('span', { class: 'board-pin-time' }, fmtTime(p.time)));
}

/** The boot copy of this board (instant render; the whole board when it has fewer than 10 rows), or null when boot has no board with this key. */
function bootView(env: ScreenEnv, key: string): BoardView | null {
  let boot = null;
  try {
    boot = env.ctx.boot?.() ?? null;
  } catch {
    boot = null;
  }
  if (!boot) return null;
  const k = parseBoardKey(key);
  if (k?.kind === 'L') {
    const b = boot.boards[k.levelId];
    if (!b || b.key !== key) return null;
    return { n: b.n, aiBeaten: b.aiBeaten, par: b.par, cutoff: b.cutoff, top: b.top, hist: b.hist === undefined ? null : padHist(b.hist, LEVEL_HIST_BINS), cleared: null, complete: b.top.length < BOOT_TOP_N };
  }
  if (k?.kind === 'D' && boot.daily.key === key) {
    const d = boot.daily;
    return { n: d.n, aiBeaten: d.aiBeaten, par: d.par, cutoff: null, top: d.top, hist: padHist(d.hist, HIST_BINS), cleared: d.cleared, complete: d.top.length < BOOT_TOP_N };
  }
  return null;
}

export function renderBoardScreen(root: HTMLElement, screen: Extract<Screen, { id: 'board' }>, env: ScreenEnv): ScreenHandle {
  const key = parseBoardKey(screen.key);
  let title = t('board.title');
  let idChip = '';
  if (key?.kind === 'L') {
    const lv = env.levels().find((l) => l.id === key.levelId);
    idChip = key.levelId;
    if (lv) title = levelName(lv);
  } else if (key?.kind === 'D') {
    idChip = t('hud.daily');
    try {
      const d = env.ctx.daily?.();
      if (d) title = levelName(d.level);
    } catch {
      /* ignore */
    }
  }
  const back = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('common.back'), 'data-autofocus': '' }, icon('back'));
  back.addEventListener('click', () => env.back());
  const sumRow = h('div', { class: 'board-sum' });
  const list = h('div', null, ...Array.from({ length: 8 }, () => h('div', { class: 'skel' })));
  const page = h('div', { class: 'page screen-enter' },
    h('header', { class: 'page-head' }, back,
      h('div', { style: 'min-width:0;flex:1 1 auto' },
        h('div', { class: 'eyebrow' }, t('board.title')),
        h('h1', { class: 'page-title', style: 'display:flex;align-items:center;gap:8px' }, idChip ? h('span', { class: 'idchip' }, idChip) : null, h('span', { style: 'overflow:hidden;text-overflow:ellipsis' }, title)))),
    h('div', { class: 'page-body' }, h('div', { class: 'page-inner', style: 'max-width:640px' }, sumRow, list)));
  root.appendChild(page);

  const reduce = env.reducedMotion();
  const still = !!root.closest('.yp--still');
  const save = env.save();
  const me = save?.id.pidh ?? null;
  /** performance.now() when my row started its one flash (null: not yet on this screen). */
  let flashAt: number | null = null;
  let alive = true;

  const pinOf = (v: BoardView): PinInfo | null => {
    try {
      if (key?.kind === 'L') return levelPin(v, save, screen.key);
      if (key?.kind === 'D') return dailyPin(v, save, screen.key, env.ctx.daily?.() ?? null);
    } catch {
      /* no pinned row */
    }
    return null;
  };

  /** The table and the pinned row always come from the same snapshot. */
  const show = (v: BoardView, tail: HTMLElement[]): void => {
    sumRow.replaceChildren(
      h('span', { class: 'chip' }, icon('list'), t('board.players', { n: fmtCount(v.n) })),
      h('span', { class: 'chip chip--ai' }, icon('crown'), t('board.aiBeaten', { n: fmtCount(v.aiBeaten) })),
      h('span', { class: 'chip' }, t('board.par', { t: fmtTime(v.par) })));
    const pin = pinOf(v);
    const body: HTMLElement[] = [];
    if (!v.top.length) {
      body.push(h('div', { class: 'empty' }, icon('trophy'), t('board.empty')));
    } else {
      const table = boardTable(v.top, { mePidh: me, parSub: v.par, partial: !v.complete });
      // 「⋮」 says "further down": only for a pin that is below the 100th row (an estimate or 100位圏外), not for a time
      // that belongs among the rows (反映待ち / 未送信 with no rank).
      if (pin && (pin.rank !== null || pin.status === 'out') && v.complete && v.top.length >= BOARD_TOP_N) {
        table.querySelector('tbody')!.appendChild(h('tr', { class: 'is-gap', 'aria-hidden': 'true' }, h('td', { colspan: 4 }, '⋮')));
      }
      body.push(table);
    }
    list.replaceChildren(...body, ...tail, ...(pin ? [pinRow(pin)] : []));
    const mine = list.querySelector<HTMLElement>('tr.is-me');
    if (!mine) return;
    if (flashAt === null) {
      // Once per screen: the instant render and the full list can both hold my row.
      flashAt = performance.now();
      if (!reduce && !still) mine.classList.add('is-flash');
      mine.scrollIntoView?.({ block: 'center', behavior: reduce || still ? 'auto' : 'smooth' });
      return;
    }
    // The full list replaced the instant one while my row was still flashing: the new row carries on from there.
    const run = performance.now() - flashAt;
    if (!reduce && !still && run < ME_FLASH_MS) {
      mine.classList.add('is-flash');
      mine.style.setProperty('--flash-delay', `${-Math.round(run)}ms`);
    }
  };

  const instant = bootView(env, screen.key);
  if (instant) show(instant, instant.complete ? [] : Array.from({ length: 6 }, () => h('div', { class: 'skel' })));
  const failed = (): void => {
    if (!alive) return;
    if (instant) show(instant, instant.complete ? [] : [h('div', { class: 'board-partial' }, icon('offline'), t('board.partial'))]);
    else list.replaceChildren(h('div', { class: 'empty' }, icon('offline'), t('board.offline')));
  };
  if (!env.ctx.fetchBoard) {
    failed();
  } else {
    env.ctx.fetchBoard(screen.key).then((r) => {
      if (!alive) return;
      if (!r) return failed();
      const hist = r.hist === undefined ? null : padHist(r.hist, key?.kind === 'D' ? HIST_BINS : LEVEL_HIST_BINS);
      show({ n: r.n, aiBeaten: r.aiBeaten, par: r.par, cutoff: r.cutoff, top: r.top, hist, cleared: typeof r.cleared === 'number' ? r.cleared : null, complete: true }, []);
    }, failed);
  }
  return {
    dispose() {
      alive = false;
    },
  };
}
