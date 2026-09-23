// "今日の5球" hub (GAME_DESIGN.md §7.5 mode 2, §9.4): 5-ball rack, today's level miniature, top 10,
// your rank and top n %, streak, share. Owner: O7.
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import type { DailyDef } from '../../sim/level';
import { h } from '../dom';
import { icon, rackBall } from '../icons';
import { fmtDelta, fmtTime, levelConcept, levelName, t } from '../i18n/format';
import { fmtPct } from '../share';
import { openShareSheet } from '../sharesheet';
import { SideCam, drawSideView, fitRange } from '../sideview';
import { boardTable } from './board';

export function renderDailyScreen(root: HTMLElement, screen: Extract<Screen, { id: 'daily' }>, env: ScreenEnv): ScreenHandle {
  const v = screen.data;
  const lv = v.level;
  const used = v.balls.filter((b) => b !== null).length;
  const left = Math.max(0, 5 - used);
  const tier = (lv as Partial<DailyDef>).tier;

  const back = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('common.back') }, icon('back'));
  // Back = level select (shown right away; 'select' is emitted so core follows).
  back.addEventListener('click', () => env.back());
  const head = h('header', { class: 'page-head' }, back,
    h('div', { style: 'min-width:0;flex:1 1 auto' },
      h('div', { class: 'eyebrow' }, t('daily.title')),
      h('h1', { class: 'page-title' }, `${t('daily.title')} `, h('span', { class: 'num' }, t('daily.number', { n: v.n })))));

  // Level card with the miniature.
  const cv = h('canvas', { role: 'img', 'aria-label': levelName(lv) });
  const mini = h('div', { class: 'daily-mini' }, cv);
  const stars = tier ? h('span', { class: 'chip', title: t('daily.tier', { day: t(`weekday.${tier - 1}` as 'weekday.0') }) },
    t(`weekday.${tier - 1}` as 'weekday.0'), ' ', '★'.repeat(tier), h('span', { style: 'opacity:.25' }, '★'.repeat(7 - tier))) : null;
  const levelCard = h('section', { class: 'sheet daily-card' },
    h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, h('h2', { class: 'sheet-title daily-name', style: 'flex:1 1 auto' }, levelName(lv)), stars),
    h('div', { class: 'note' }, levelConcept(lv)),
    mini,
    h('div', { class: 'bigrack', role: 'img', 'aria-label': v.balls.map((b) => t(`daily.ball.${b ?? 'empty'}` as 'daily.ball.ok')).join(', ') }, ...v.balls.map((b) => rackBall(b))),
    h('div', { class: 'note', style: 'text-align:center;margin-bottom:12px' }, left > 0 ? t('daily.rules') : t('daily.done')));

  const play = h('button', { class: `btn btn--lg ${left > 0 ? 'btn--primary' : ''}`, type: 'button', 'data-autofocus': '' },
    icon('play'), left > 0 ? h('span', { class: 'btn-stack' }, h('span', null, t('daily.play')), h('span', { class: 'btn-sub' }, t('daily.ballsLeft', { n: left }))) : t('daily.practice'));
  play.addEventListener('click', () => env.emit('openLevel', lv.id));
  const share = h('button', { class: 'btn btn--gold btn--lg', type: 'button', disabled: used === 0 }, icon('share'), t('daily.share'));
  share.addEventListener('click', () => {
    env.emit('share', { kind: 'daily' });
    openShareSheet(root, env, { kind: 'daily', view: v });
  });
  levelCard.append(h('div', { class: 'btnrow' }, play, share));

  // Stats and board.
  const stat = (label: string, val: string | HTMLElement, sub?: string): HTMLElement =>
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-val' }, val, sub ? h('small', null, sub) : null));
  const stats = h('div', { class: 'stats' },
    stat(t('daily.best'), v.bestSub !== null ? t('unit.s', { v: fmtTime(v.bestSub) }) : t('daily.noBest')),
    stat(t('daily.vsAi'), v.bestSub !== null ? fmtDelta(v.bestSub - v.parSub) : '–', `AI ${fmtTime(v.parSub)}`),
    stat(t('daily.rank'), v.rank !== null ? t('unit.rank', { n: v.rank }) : '–', v.pct !== null ? t('daily.pct', { p: fmtPct(v.pct) }) : undefined),
    stat(t('daily.streakLabel'), t('unit.days', { n: v.streak })));
  const boardBox = h('section', { class: 'sheet daily-card' }, h('div', { class: 'eyebrow', style: 'margin-bottom:8px' }, t('daily.top10')));
  if (v.top && v.top.length) {
    boardBox.append(boardTable(v.top.slice(0, 10), { mePidh: env.save()?.id.pidh ?? null, parSub: v.parSub }));
  } else if (v.top) {
    boardBox.append(h('div', { class: 'empty' }, icon('trophy'), t('board.empty')));
  } else {
    boardBox.append(h('div', { class: 'empty' }, icon('offline'), t('daily.offline')));
  }
  const right = h('div', null, stats, boardBox);
  const page = h('div', { class: 'page screen-enter' }, head,
    h('div', { class: 'page-body' }, h('div', { class: 'page-inner' }, h('div', { class: 'daily-grid' }, levelCard, right))));
  root.appendChild(page);

  requestAnimationFrame(() => {
    const cssW = Math.max(220, mini.clientWidth || 300);
    const cssH = Math.round(cssW * 0.42);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = '#F3EEE4';
    g.fillRect(0, 0, cssW, cssH);
    const r = fitRange(lv, [], 2.4, 0.3);
    const cam = new SideCam({ x: 4, y: 4, w: cssW - 8, h: cssH - 8 }, { ...r, y0: -0.06, y1: 1.45 }, 'bottom');
    drawSideView(g, lv, cam, { grid: true, trolleyX: lv.physics.startX, lineScale: 0.9, egg: lv.cargo === 'egg' });
  });
  return {};
}
