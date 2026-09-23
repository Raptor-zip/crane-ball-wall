// Level select by world pages (GAME_DESIGN.md §9.4, §7.2 titles, §5.1 unlock rule). Owner: O7.
import type { LevelDef } from '../../sim/level';
import type { LevelProgress, SaveV1 } from '../../store/save';
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import { h } from '../dom';
import { coin, crownBadge, icon, rackBall } from '../icons';
import { fmtTime, levelConcept, levelName, t } from '../i18n/format';

export const RANK_THRESHOLDS = [0, 3, 8, 13, 18] as const;

/** Crowns shown the last time the select screen was drawn (the counter pops when it grew, §9.5 "王冠が x/18 へ飛ぶ"). */
let lastShownCrowns: number | null = null;

/** Title index from the crown count (§7.2): 見習い 0 → 玉掛け 3 → 熟練オペレーター 8 → 最適制御ハンター 13 → 人類代表 18. */
export function rankIndex(crowns: number): number {
  let r = 0;
  for (let i = 0; i < RANK_THRESHOLDS.length; i++) if (crowns >= RANK_THRESHOLDS[i]!) r = i;
  return r;
}

export function worldsOf(levels: readonly LevelDef[]): Map<number, LevelDef[]> {
  const m = new Map<number, LevelDef[]>();
  for (const l of levels) {
    if (l.world < 1) continue;
    const a = m.get(l.world) ?? [];
    a.push(l);
    m.set(l.world, a);
  }
  for (const a of m.values()) a.sort((x, y) => x.order - y.order);
  return m;
}

const done = (p: LevelProgress | undefined): boolean => !!p && (p.cleared || p.skipped);

/** §5.1: a world opens when the previous world has (size − 1) clears (skips count); levels open in order. */
export function defaultUnlocked(levels: readonly LevelDef[], save: SaveV1 | null, id: string): boolean {
  const lv = levels.find((l) => l.id === id);
  if (!lv) return false;
  const prog = save?.levels ?? {};
  const worlds = worldsOf(levels);
  if (lv.world > 1) {
    const prev = worlds.get(lv.world - 1) ?? [];
    const n = prev.filter((l) => done(prog[l.id])).length;
    if (n < prev.length - 1) return false;
  }
  const list = worlds.get(lv.world) ?? [];
  const i = list.indexOf(lv);
  return i <= 0 || done(prog[list[i - 1]!.id]);
}

export function worldUnlocked(levels: readonly LevelDef[], unlocked: (id: string) => boolean, world: number): boolean {
  const first = worldsOf(levels).get(world)?.[0];
  return !!first && unlocked(first.id);
}

/** Science note w opens when every level of world w is cleared (§5.4). */
export function noteUnlocked(levels: readonly LevelDef[], save: SaveV1 | null, world: number): boolean {
  const list = worldsOf(levels).get(world) ?? [];
  return list.length > 0 && list.every((l) => !!save?.levels[l.id]?.cleared);
}

export function renderSelectScreen(root: HTMLElement, screen: Extract<Screen, { id: 'select' }>, env: ScreenEnv): ScreenHandle {
  const levels = env.levels();
  const save = env.save();
  const prog = save?.levels ?? {};
  const unlocked = (id: string): boolean => {
    try {
      return env.ctx.unlocked ? env.ctx.unlocked(id) : defaultUnlocked(levels, save, id);
    } catch {
      return defaultUnlocked(levels, save, id);
    }
  };
  const worlds = worldsOf(levels);
  const worldIds = [...worlds.keys()].sort((a, b) => a - b);
  const total = levels.filter((l) => l.world > 0).length || 18;
  const crowns = levels.filter((l) => prog[l.id]?.crown).length;
  const rank = rankIndex(crowns);
  const nextAt = RANK_THRESHOLDS[rank + 1];

  // ---- header
  // Unlocked skins not seen yet (§7.14): the red dot on the gear, the way to the skins row in the settings (a toast
  // after a run can miss a small phone; the dot stays until the skins' tab was opened).
  let skinsNew = false;
  try {
    skinsNew = (env.ctx.skins?.()?.unseen ?? 0) > 0;
  } catch {
    skinsNew = false;
  }
  const settingsBtn = h('button', { class: `btn btn--icon${skinsNew ? ' has-skin-dot' : ''}`, type: 'button', 'aria-label': skinsNew ? t('select.settingsNew') : t('title.settings'), title: t('title.settings') },
    icon('gear'), skinsNew ? h('span', { class: 'skin-dot', 'aria-hidden': 'true' }) : null);
  settingsBtn.addEventListener('click', () => env.open({ id: 'settings' }));
  const aboutBtn = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('title.about'), title: t('title.about') }, icon('info'));
  aboutBtn.addEventListener('click', () => env.open({ id: 'about' }));
  const head = h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, t('select.title')), aboutBtn, settingsBtn);

  // ---- 人類 vs AI
  const grew = lastShownCrowns !== null && crowns > lastShownCrowns && !env.reducedMotion();
  const prevCrowns = lastShownCrowns ?? crowns;
  lastShownCrowns = crowns;
  const bar = h('div', { class: 'hva-bar', 'aria-hidden': 'true' });
  for (let i = 0; i < total; i++) bar.appendChild(h('i', { class: i < crowns ? (grew && i >= prevCrowns ? 'on is-new' : 'on') : '' }));
  const hva = h('section', { class: `sheet hva${grew ? ' is-grew' : ''}`, 'aria-label': `${t('select.humanVsAi')} ${crowns}/${total}` },
    crownBadge(),
    h('div', { style: 'flex:1 1 auto;min-width:0' },
      h('div', { class: 'hva-label' }, t('select.humanVsAi')),
      h('div', { style: 'display:flex;align-items:baseline;gap:12px;flex-wrap:wrap' },
        h('div', { class: 'hva-count num' }, String(crowns), h('small', null, `/${total}`)),
        h('div', { class: 'hva-rank' }, t(`select.rank.${rank}` as 'select.rank.0'))),
      bar,
      h('div', { class: 'hva-next', style: 'margin-top:4px' }, nextAt === undefined ? t('select.maxRank') : t('select.nextRank', { n: nextAt - crowns }))));

  // ---- daily card
  let dailyView = null as ReturnType<NonNullable<typeof env.ctx.daily>> | null;
  try {
    dailyView = env.ctx.daily?.() ?? null;
  } catch {
    dailyView = null;
  }
  // §7.5: opens with 1-2 cleared; the game may also open it earlier (a #d link, ctx.unlocked of the daily id).
  let dailyOpen = !!prog['1-2']?.cleared;
  if (!dailyOpen && dailyView && env.ctx.unlocked) {
    try {
      dailyOpen = env.ctx.unlocked(dailyView.level.id);
    } catch {
      dailyOpen = false;
    }
  }
  const dcard = h('button', { class: 'sheet dcard', type: 'button' });
  if (dailyOpen) {
    const balls = dailyView?.balls ?? [null, null, null, null, null];
    const used = balls.filter((b) => b !== null).length;
    dcard.append(
      h('div', { class: 'dcard-main' },
        h('div', { class: 'dcard-title' }, icon('star'), h('span', { class: 'dcard-name' }, t('select.daily')), dailyView ? h('span', { class: 'num', style: 'color:var(--ink-2)' }, t('daily.number', { n: dailyView.n })) : null),
        h('div', { class: 'dcard-sub' }, dailyView ? levelName(dailyView.level) : t('daily.rules')),
        h('div', { class: 'rack' }, ...balls.map((b) => rackBall(b)))),
      h('span', { class: `btn dcard-go ${used >= 5 ? '' : 'btn--gold'}`, 'aria-hidden': 'true' }, h('span', { class: 'dcard-go-label' }, used >= 5 ? t('daily.board') : t('select.dailyPlay')), icon('next')));
    dcard.setAttribute('aria-label', `${t('select.daily')} ${used >= 5 ? t('select.dailyDone') : t('select.dailyLeft', { n: 5 - used })}`);
    dcard.addEventListener('click', () => env.emit('openDaily'));
  } else {
    dcard.disabled = true;
    dcard.append(h('div', { class: 'dcard-main' },
      h('div', { class: 'dcard-title', style: 'color:var(--ink-3)' }, icon('lock'), h('span', { class: 'dcard-name' }, t('select.daily'))),
      h('div', { class: 'dcard-sub' }, t('select.dailyLocked'))));
  }
  const top = h('div', { class: 'sel-top' }, hva, dcard);

  // ---- world tabs & pages
  const tabs = h('div', { class: 'wtabs', role: 'tablist', 'aria-label': t('select.title') });
  const pages = h('div', { class: 'wpages' });
  const tabEls: HTMLButtonElement[] = [];
  const pageEls: HTMLElement[] = [];
  const reduce = env.reducedMotion();

  worldIds.forEach((w, wi) => {
    const list = worlds.get(w)!;
    const open = worldUnlocked(levels, unlocked, w);
    const tab = h('button', { class: `wtab ${open ? '' : 'is-locked'}`, type: 'button', role: 'tab', 'aria-selected': 'false', id: `wtab-${w}` },
      h('b', null, String(w)), open ? t(`select.world.${w}` as 'select.world.1') : icon('lock'));
    tab.setAttribute('aria-label', `${t('select.world', { n: w })} ${t(`select.world.${w}` as 'select.world.1')}`);
    tab.addEventListener('click', () => go(wi, true));
    tabs.appendChild(tab);
    tabEls.push(tab);

    const tiles = h('div', { class: 'tiles' });
    for (const lv of list) tiles.appendChild(tile(lv));
    const pageHead = h('div', { class: 'wpage-head' },
      h('h2', { class: 'wpage-title' }, t(`select.world.${w}` as 'select.world.1')),
      h('span', { class: 'wpage-sub' }, t(`select.worldSub.${w}` as 'select.worldSub.1')));
    const lockNote = open ? null : h('div', { class: 'wpage-lock' }, icon('lock'),
      t('select.worldLock', { prev: w - 1, n: Math.max(1, (worlds.get(w - 1)?.length ?? 1) - 1) }));
    const nOpen = noteUnlocked(levels, save, w);
    const seen = save?.seen.notes ?? [];
    const note = h('button', { class: 'sheet notecard', type: 'button', disabled: !nOpen },
      icon(nOpen ? 'book' : 'lock'),
      h('div', null,
        h('div', { class: 'notecard-title' }, t('select.noteTitle', { w, title: t(`notes.w${w}.title` as 'notes.w1.title') })),
        h('div', { class: 'notecard-sub' }, nOpen ? t(`notes.w${w}.formula` as 'notes.w1.formula') : t('select.noteLocked'))),
      nOpen && !seen.includes(w) ? h('span', { class: 'newdot' }, t('select.noteNew')) : null);
    note.addEventListener('click', () => env.open({ id: 'notes', world: w }));
    const page = h('section', { class: 'wpage', role: 'tabpanel', 'aria-labelledby': `wtab-${w}` }, pageHead, lockNote, tiles, note);
    pages.appendChild(page);
    pageEls.push(page);
  });

  function tile(lv: LevelDef): HTMLElement {
    const p = prog[lv.id];
    const open = unlocked(lv.id);
    const sum = env.summary(lv.id);
    const name = levelName(lv);
    if (!open) {
      const el = h('button', { class: 'tile is-locked', type: 'button', 'aria-disabled': 'true', 'data-level': lv.id },
        h('div', { class: 'tile-top' }, h('span', { class: 'idchip' }, lv.id)),
        h('div', { class: 'tile-name' }, name),
        h('div', { class: 'tile-lock' }, icon('lock'), t('select.levelLock')));
      el.setAttribute('aria-label', `${lv.id} ${name} ${t('select.levelLock')}`);
      el.addEventListener('click', () => {
        if (reduce) return;
        el.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 240 });
      });
      return el;
    }
    const medals = h('div', { class: 'tile-medals' }, coin(p?.medal ?? 0), p?.crown ? crownBadge() : null);
    const times = h('div', { class: 'tile-times' },
      sum ? h('span', { class: 't-ai' }, h('i', null, t('select.ai')), fmtTime(sum.parSub)) : null,
      p?.bestSub !== null && p?.bestSub !== undefined
        ? h('span', { class: 't-pb' }, h('i', null, t('select.pb')), fmtTime(p.bestSub))
        : h('span', { class: 't-none' }, p?.skipped ? t('select.skipped') : t('select.notCleared')));
    const el = h('button', {
      class: `tile ${p?.crown ? 'is-crown' : ''} ${p?.skipped && !p.cleared ? 'is-skipped' : ''}`, type: 'button', 'data-level': lv.id,
    },
      h('div', { class: 'tile-top' }, h('span', { class: 'idchip' }, lv.id)),
      h('div', { class: 'tile-name' }, name),
      h('div', { class: 'tile-concept' }, levelConcept(lv)),
      h('div', { class: 'tile-foot' }, times, medals),
      p?.skipped && !p.cleared ? h('span', { class: 'tile-skip' }, t('select.skipped')) : null);
    const medalName = p?.crown ? t('results.medal.crown') : p?.medal ? t(`results.medal.${p.medal}` as 'results.medal.1') : '';
    el.setAttribute('aria-label', [lv.id, name, medalName, sum ? `AI ${fmtTime(sum.parSub)}` : '', p?.bestSub ? `PB ${fmtTime(p.bestSub)}` : ''].filter(Boolean).join(' '));
    el.addEventListener('click', () => env.emit('openLevel', lv.id));
    return el;
  }

  let cur = Math.max(0, worldIds.indexOf(screen.world));
  function mark(i: number): void {
    tabEls.forEach((tb, k) => tb.setAttribute('aria-selected', k === i ? 'true' : 'false'));
    tabEls[i]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function go(i: number, focusTab = false): void {
    cur = Math.max(0, Math.min(worldIds.length - 1, i));
    const page = pageEls[cur];
    if (page) pages.scrollTo?.({ left: page.offsetLeft - pages.offsetLeft, behavior: reduce ? 'auto' : 'smooth' });
    mark(cur);
    if (focusTab) tabEls[cur]?.focus({ preventScroll: true });
  }
  let raf = 0;
  pages.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const w = pages.clientWidth || 1;
      const i = Math.round(pages.scrollLeft / (w + 16));
      if (i !== cur) {
        cur = i;
        mark(i);
      }
    });
  });

  const prevBtn = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('select.prevWorld') }, icon('back'));
  const nextBtn = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('select.nextWorld') }, icon('next'));
  prevBtn.addEventListener('click', () => go(cur - 1));
  nextBtn.addEventListener('click', () => go(cur + 1));
  const tabRow = h('div', { style: 'display:flex;gap:10px;align-items:center' }, h('div', { style: 'flex:1 1 auto;min-width:0' }, tabs), h('div', { class: 'sel-nav' }, prevBtn, nextBtn));

  const body = h('div', { class: 'page-body' }, h('div', { class: 'page-inner' }, top, tabRow, pages));
  const page = h('div', { class: 'page screen-enter' }, head, body);
  root.appendChild(page);
  // Initial page without animation; focus the first open level of it.
  requestAnimationFrame(() => {
    const pg = pageEls[cur];
    if (pg) pages.scrollLeft = pg.offsetLeft - pages.offsetLeft;
    mark(cur);
  });
  const firstTile = pageEls[cur]?.querySelector<HTMLElement>('.tile:not(.is-locked)');
  firstTile?.setAttribute('data-autofocus', '');

  return {
    onKey(e) {
      const tgt = e.target as HTMLElement;
      if (e.key === 'PageDown' || e.key === ']') {
        go(cur + 1);
        return true;
      }
      if (e.key === 'PageUp' || e.key === '[') {
        go(cur - 1);
        return true;
      }
      if (tgt.classList.contains('wtab') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        go(cur + (e.key === 'ArrowRight' ? 1 : -1), true);
        return true;
      }
      if (!tgt.classList.contains('tile') || !e.key.startsWith('Arrow')) return false;
      const grid = [...(pageEls[cur]?.querySelectorAll<HTMLElement>('.tile') ?? [])];
      const i = grid.indexOf(tgt);
      if (i < 0) return false;
      const cols = getComputedStyle(tgt.parentElement!).gridTemplateColumns.split(' ').length || 2;
      let j = i;
      if (e.key === 'ArrowRight') j = i + 1;
      if (e.key === 'ArrowLeft') j = i - 1;
      if (e.key === 'ArrowDown') j = i + cols;
      if (e.key === 'ArrowUp') j = i - cols;
      if (j >= grid.length && e.key === 'ArrowRight') {
        go(cur + 1);
        requestAnimationFrame(() => pageEls[cur]?.querySelector<HTMLElement>('.tile')?.focus({ preventScroll: true }));
        return true;
      }
      if (j < 0 && e.key === 'ArrowLeft') {
        go(cur - 1);
        requestAnimationFrame(() => {
          const all = pageEls[cur]?.querySelectorAll<HTMLElement>('.tile');
          all?.[all.length - 1]?.focus({ preventScroll: true });
        });
        return true;
      }
      if (j < 0) {
        tabEls[cur]?.focus();
        return true;
      }
      grid[Math.min(grid.length - 1, j)]?.focus();
      return true;
    },
  };
}
