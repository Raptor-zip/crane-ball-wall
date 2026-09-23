// Leaderboard (top 100, server-verified) (GAME_DESIGN.md §7.7, §9.4). Owner: O7.
import type { BoardRow } from '../../shared/api';
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import { parseBoardKey } from '../../shared/api';
import { displayName } from '../../shared/names';
import { h } from '../dom';
import { icon } from '../icons';
import { fmtTime, getLang, levelName, t } from '../i18n/format';

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

/** Closest-gap column: '—' on levels without walls (gapUm < 0, NO_WALL_GAP_UM), empty when unknown. */
export function gapCell(gapUm: number | null | undefined): string {
  if (gapUm === null || gapUm === undefined || !Number.isFinite(gapUm) || gapUm >= 1e7) return '';
  if (gapUm < 0) return NO_GAP;
  return t('unit.mm', { v: Math.round(gapUm / 1000) });
}

/** Shown in the gap column when the level has no walls (1-1): there is no clearance to measure. */
export const NO_GAP = '—';

export function boardTable(rows: BoardRow[], opts: { mePidh?: string | null; parSub?: number | null; startRank?: number }): HTMLElement {
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
  if (!aiPlaced && rows.length < 100) tbody.appendChild(aiRow());
  return h('table', { class: 'board' },
    h('thead', null, h('tr', null,
      h('th', null, t('board.col.rank')), h('th', null, t('board.col.name')), h('th', { style: 'text-align:right' }, t('board.col.time')), h('th', { style: 'text-align:right' }, t('board.col.gap')))),
    tbody);
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

  let alive = true;
  const offline = (): void => {
    list.replaceChildren(h('div', { class: 'empty' }, icon('offline'), t('board.offline')));
  };
  if (!env.ctx.fetchBoard) {
    offline();
  } else {
    env.ctx.fetchBoard(screen.key).then((r) => {
      if (!alive) return;
      if (!r) return offline();
      sumRow.replaceChildren(
        h('span', { class: 'chip' }, icon('list'), t('board.players', { n: r.n })),
        h('span', { class: 'chip chip--ai' }, icon('crown'), t('board.aiBeaten', { n: r.aiBeaten })),
        h('span', { class: 'chip' }, t('board.par', { t: fmtTime(r.par) })));
      if (!r.top.length) {
        list.replaceChildren(h('div', { class: 'empty' }, icon('trophy'), t('board.empty')));
        return;
      }
      list.replaceChildren(boardTable(r.top, { mePidh: env.save()?.id.pidh ?? null, parSub: r.par }));
      list.querySelector('tr.is-me')?.scrollIntoView?.({ block: 'center' });
    }, () => alive && offline());
  }
  return {
    dispose() {
      alive = false;
    },
  };
}
