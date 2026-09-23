// Leaderboard (top 100, server-verified) (GAME_DESIGN.md §7.7, §9.4). Owner: O7.
// Renders at once from the boot top 10 (skeleton rows below) and is replaced by GET /api/board/<key>. My row is marked,
// flashed once and scrolled to; when I am not in the list, a pinned 「あなた」 row says where my best stands (§9.4).
// Replays (§7.5 item 6): 「1位のリプレイを見る」 in the header and a ▶ on every watchable row (tap the row or the ▶)
// open the replay viewer. Opening the ranking asks for no replay (ctx.replayAvail is synchronous, without I/O); a tap
// asks core to load one (ctx.loadReplay: at most one /api/ghost request) and emits 'replay'. Back from the viewer the
// screen comes with `focusRank`: that row is scrolled to and its ▶ focused, and my row does not flash again.
import type { BoardRow } from '../../shared/api';
import type { Screen, ScreenHandle } from '../ui';
import type { ReplayAvail, ReplayLoad, ScreenEnv } from '../context';
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

/** The ▶ of a ranking row (a real button: keyboard and screen readers reach every watchable row). Loading: a spinner, or
 *  with reduced motion a still hourglass (styles.css). */
function playButton(rank: number, name: string, busy: boolean): HTMLElement {
  return h('button', {
    class: `b-play-btn${busy ? ' is-busy' : ''}`, type: 'button', 'data-rank': rank,
    'aria-label': t('board.watchRow', { rank, name }), 'aria-busy': busy ? 'true' : null,
  }, icon('play'), icon('wait', 'ico ico-wait'));
}

/** What a failed load says (ReplayLoad reasons), and its toast: the no-connection one only when it is the connection. */
const LOAD_TOAST = {
  offline: 'toast.replayOffline', budget: 'toast.replayLimit', missing: 'toast.replayGone', bad: 'toast.replayBad', stale: 'toast.replayGone',
} as const;

/**
 * The ranking table. `partial`: `rows` is only the head of the list (the boot top 10), so an AI slower than all of them
 * is not placed after the last row (it can be anywhere below). `replay` (the ranking screen only, not the daily hub's top
 * 10): a narrow last column with the ▶ of every row it says can be watched, when a row below #1 can be (#1 alone has
 * the header's button: offline / low quota the column would stand empty); a watchable row is tapped as a whole either
 * way. `busy`: the rank whose replay is loading.
 */
export function boardTable(rows: BoardRow[], opts: {
  mePidh?: string | null; parSub?: number | null; startRank?: number; partial?: boolean;
  replay?: (rank: number, row: BoardRow) => ReplayAvail; busy?: number | null;
}): HTMLElement {
  const tbody = h('tbody');
  const first = opts.startRank ?? 1;
  const avails: ReplayAvail[] = rows.map((r, i) => {
    if (!opts.replay) return null;
    try {
      return opts.replay(first + i, r);
    } catch {
      return null;
    }
  });
  const play = avails.some((a, i) => a !== null && first + i > 1);
  const playCell = (c: Node | null): HTMLElement | null => (play ? h('td', { class: 'b-play' }, c) : null);
  let aiPlaced = opts.parSub === null || opts.parSub === undefined;
  const aiRow = (): HTMLElement => h('tr', { class: 'is-ai' },
    h('td', null, icon('crown', 'ico')),
    h('td', { class: 'b-name' }, t('board.aiRow')),
    h('td', { class: 'b-num' }, fmtTime(opts.parSub!)),
    h('td', { class: 'b-num' }, ''),
    playCell(null));
  rows.forEach((r, i) => {
    const [pidh, seed, t120, gapUm] = r;
    if (!aiPlaced && t120 >= opts.parSub!) {
      tbody.appendChild(aiRow());
      aiPlaced = true;
    }
    const rank = first + i;
    const me = !!opts.mePidh && pidh === opts.mePidh;
    const name = safeName(seed, pidh);
    const avail = avails[i] ?? null;
    const cls = [me ? 'is-me' : '', avail ? 'is-watch' : ''].filter(Boolean).join(' ');
    tbody.appendChild(h('tr', { class: cls, 'data-rank': rank },
      h('td', null, String(rank)),
      h('td', { class: 'b-name' }, h('div', { class: 'b-name-wrap' }, h('span', null, name), me ? h('span', { class: 'me-chip' }, t('common.you')) : null)),
      h('td', { class: 'b-num' }, fmtTime(t120)),
      h('td', { class: 'b-num' }, gapCell(gapUm)),
      playCell(avail ? playButton(rank, name, opts.busy === rank) : null)));
  });
  if (!aiPlaced && rows.length < 100 && !opts.partial) tbody.appendChild(aiRow());
  return h('table', { class: `board${play ? ' board--play' : ''}` },
    h('thead', null, h('tr', null,
      h('th', null, t('board.col.rank')), h('th', null, t('board.col.name')), h('th', { style: 'text-align:right' }, t('board.col.time')), h('th', { style: 'text-align:right' }, t('board.col.gap')),
      play ? h('th', { class: 'b-play' }, h('span', { class: 'sr-only' }, t('board.col.replay'))) : null)),
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
  // Back from the replay viewer the watched row takes the focus (data-autofocus moves to it when it is on screen).
  const back = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('common.back'), 'data-autofocus': screen.focusRank === undefined ? '' : null }, icon('back'));
  back.addEventListener('click', () => env.back());
  const sumRow = h('div', { class: 'board-sum' });
  const list = h('div', null, ...Array.from({ length: 8 }, () => h('div', { class: 'skel' })));
  // 「1位のリプレイを見る」 lives in the header: it stays in view while the list scrolls to my row (tall: its own row
  // under the title, which stays beside the back button and is cut short there, as without the button).
  const wrSlot = h('div', { class: 'board-wr-slot' });
  const page = h('div', { class: 'page screen-enter' },
    h('header', { class: 'page-head board-head' }, back,
      h('div', { class: 'board-head-title', style: 'min-width:0;flex:1 1 0' },
        h('div', { class: 'eyebrow' }, t('board.title')),
        h('h1', { class: 'page-title', style: 'display:flex;align-items:center;gap:8px' }, idChip ? h('span', { class: 'idchip' }, idChip) : null, h('span', { style: 'overflow:hidden;text-overflow:ellipsis' }, title))),
      wrSlot),
    h('div', { class: 'page-body' }, h('div', { class: 'page-inner', style: 'max-width:640px' }, sumRow, list)));
  root.appendChild(page);

  const reduce = env.reducedMotion();
  const still = !!root.closest('.yp--still');
  const save = env.save();
  const me = save?.id.pidh ?? null;
  /** performance.now() when my row started its one flash (null: not yet on this screen). */
  let flashAt: number | null = null;
  let alive = true;
  // ---- replays (§7.5 item 6) ----
  const avail = env.ctx.replayAvail && env.ctx.loadReplay ? env.ctx.replayAvail : null;
  const replayOf = avail ? (rank: number, row: BoardRow): ReplayAvail => avail(screen.key, rank, row) : undefined;
  /** The snapshot on screen: a tap reads its row from here (the same rows the table shows). */
  let current: BoardView | null = null;
  /** The rank whose replay is loading (single flight; the full list may replace the table meanwhile). */
  let busy: number | null = null;
  /** Back from the viewer: the rank to bring back into view, until a snapshot holding it is shown (ranks > 10: the full list). */
  let focusRank: number | null = screen.focusRank ?? null;
  let focused: HTMLElement | null = null;
  // Back from the viewer: my row flashed when the ranking first opened; it does not flash (or pull the scroll) again.
  if (focusRank !== null) flashAt = -Infinity;

  const pinOf = (v: BoardView): PinInfo | null => {
    try {
      if (key?.kind === 'L') return levelPin(v, save, screen.key);
      if (key?.kind === 'D') return dailyPin(v, save, screen.key, env.ctx.daily?.() ?? null);
    } catch {
      /* no pinned row */
    }
    return null;
  };

  /** The ▶ (or for #1 the big button) of a rank in the list shown. */
  const watchEl = (rank: number): HTMLElement | null =>
    (rank === 1 ? wrSlot.querySelector<HTMLElement>('.board-wr') : null) ?? list.querySelector<HTMLElement>(`.b-play-btn[data-rank="${rank}"]`);

  /** Focuses the rank's ▶ (scrolling its row to the middle); false when this snapshot does not hold it. */
  const placeFocus = (rank: number, scroll: boolean): boolean => {
    const el = watchEl(rank);
    const row = list.querySelector<HTMLElement>(`tr[data-rank="${rank}"]`);
    if (!el && !row) return false;
    if (scroll) row?.scrollIntoView?.({ block: 'center', behavior: 'auto' });
    if (el) {
      el.setAttribute('data-autofocus', '');
      el.focus({ preventScroll: true });
      focused = el;
    }
    return true;
  };

  /** Marks the loading rank's buttons (a spinner, a static 「…」 with reduced motion) without redrawing the list. */
  const paintBusy = (): void => {
    for (const b of page.querySelectorAll<HTMLElement>('.b-play-btn, .board-wr')) {
      const on = busy !== null && Number(b.dataset.rank) === busy;
      b.classList.toggle('is-busy', on);
      if (on) b.setAttribute('aria-busy', 'true');
      else b.removeAttribute('aria-busy');
    }
  };

  const watch = async (rank: number): Promise<void> => {
    const row = current?.top[rank - 1];
    if (busy !== null || !row || !env.ctx.loadReplay) return;
    busy = rank;
    paintBusy();
    let res: ReplayLoad;
    try {
      res = (await env.ctx.loadReplay({ key: screen.key, rank, pidh: row[0], nameSeed: row[1], t120: row[2] })) ?? { ok: false, reason: 'offline' };
    } catch {
      res = { ok: false, reason: 'offline' };
    }
    busy = null;
    if (!alive) return;
    if (res.ok) {
      env.emit('replay', { id: res.id });
      return;
    }
    paintBusy();
    env.toast(t(LOAD_TOAST[res.reason] ?? 'toast.replayBad'), res.reason === 'offline' ? 'warn' : 'notice');
  };

  // One listener for every row: the whole row is the touch target (its height), the ▶ is the keyboard's.
  page.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const hit = el.closest<HTMLElement>('.board-wr, .b-play-btn') ?? el.closest<HTMLElement>('tr.is-watch');
    if (!hit || !page.contains(hit)) return;
    void watch(Number(hit.dataset.rank));
  });

  /**
   * 「1位のリプレイを見る」: #1's name and time under it (the same row as the table's first); the time stays whole, the
   * name is cut if it must be. Narrow landscape phones: 「1位のリプレイ」 and the time only, so the title keeps its room.
   */
  const wrButton = (v: BoardView): HTMLElement | null => {
    const row = v.top[0];
    if (!replayOf || !row || !replayOf(1, row)) return null;
    const time = fmtTime(row[2]);
    const name = safeName(row[1], row[0]);
    const [pre = '', post = ''] = t('board.watchSub', { name: '\u0001', t: time }).split('\u0001');
    return h('button', {
      class: `btn btn--primary board-wr${busy === 1 ? ' is-busy' : ''}`, type: 'button', 'data-rank': 1, 'data-row': `${row[0]}:${row[2]}`,
      'aria-busy': busy === 1 ? 'true' : null,
    },
      icon('play'), icon('wait', 'ico ico-wait'),
      h('span', { class: 'btn-stack' },
        h('span', null, h('span', { class: 'board-wr-long' }, t('board.watchWr')), h('span', { class: 'board-wr-short' }, t('board.watchWrShort'))),
        h('span', { class: 'btn-sub board-wr-sub' }, h('span', { class: 'board-wr-name' }, pre + name), h('span', { class: 'board-wr-time' }, post)),
        h('span', { class: 'btn-sub board-wr-subtime' }, t('unit.s', { v: time }))));
  };

  /** The table and the pinned row always come from the same snapshot. */
  const show = (v: BoardView, tail: HTMLElement[]): void => {
    current = v;
    // The full list replaces the table under a focused ▶: the focus goes to the same rank's ▶ in the new one.
    const keepFocus = focused !== null && document.activeElement === focused ? Number(focused.dataset.rank) : null;
    sumRow.replaceChildren(
      h('span', { class: 'chip' }, icon('list'), t('board.players', { n: fmtCount(v.n) })),
      h('span', { class: 'chip chip--ai' }, icon('crown'), t('board.aiBeaten', { n: fmtCount(v.aiBeaten) })),
      h('span', { class: 'chip' }, t('board.par', { t: fmtTime(v.par) })));
    const pin = pinOf(v);
    const body: HTMLElement[] = [];
    if (!v.top.length) {
      body.push(h('div', { class: 'empty' }, icon('trophy'), t('board.empty')));
    } else {
      const table = boardTable(v.top, { mePidh: me, parSub: v.par, partial: !v.complete, replay: replayOf, busy });
      // 「⋮」 says "further down": only for a pin that is below the 100th row (an estimate or 100位圏外), not for a time
      // that belongs among the rows (反映待ち / 未送信 with no rank).
      if (pin && (pin.rank !== null || pin.status === 'out') && v.complete && v.top.length >= BOARD_TOP_N) {
        table.querySelector('tbody')!.appendChild(h('tr', { class: 'is-gap', 'aria-hidden': 'true' }, h('td', { colspan: table.classList.contains('board--play') ? 5 : 4 }, '⋮')));
      }
      body.push(table);
    }
    const wr = v.top.length ? wrButton(v) : null;
    // The same button element stays while it shows the same row (a keyboard focus on it survives the full list).
    const old = wrSlot.querySelector<HTMLElement>('.board-wr');
    if (!wr) wrSlot.replaceChildren();
    else if (!old || old.dataset.row !== wr.dataset.row) wrSlot.replaceChildren(wr);
    list.replaceChildren(...body, ...tail, ...(pin ? [pinRow(pin)] : []));
    if (focusRank !== null) {
      if (placeFocus(focusRank, true)) focusRank = null;
    } else if (keepFocus !== null) {
      placeFocus(keepFocus, false);
    }
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
