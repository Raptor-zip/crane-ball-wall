// Science notes (GAME_DESIGN.md §5.4) and the one-time "why the AI lost" card. Owner: O7.
// Text and captions live in i18n/{ja,en}.ts; formulas are plain Unicode; figures are small inline SVG drawings.
import type { LevelDef } from '../../sim/level';
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import { h, makeModal, svgFrom } from '../dom';
import { icon } from '../icons';
import { fmtRest, t } from '../i18n/format';
import { noteUnlocked } from './select';

const INK = '#1E2A44';
const BALL = '#E0312B';
const AI = '#19C3FF';
const GOAL = '#22B573';

const RAIL = `<rect x="10" y="18" width="300" height="9" rx="3" fill="#F2B705" stroke="${INK}" stroke-width="2"/>`;
const FLOOR = `<line x1="6" y1="140" x2="314" y2="140" stroke="${INK}" stroke-width="2"/>`;
const trolley = (x: number, fill = '#39455F'): string => `<rect x="${x - 16}" y="27" width="32" height="9" rx="3" fill="${fill}" stroke="${INK}" stroke-width="1.8"/>`;
const ball = (x: number, y: number, fill = BALL, op = 1): string => `<circle cx="${x}" cy="${y}" r="9" fill="${fill}" stroke="${INK}" stroke-width="1.8" opacity="${op}"/>`;
const str = (x1: number, y1: number, x2: number, y2: number, dash = ''): string => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#2B2B2B" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
const arrow = (x1: number, y1: number, x2: number, y2: number, c = INK): string => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx1 = x2 - 9 * Math.cos(a - 0.45);
  const hy1 = y2 - 9 * Math.sin(a - 0.45);
  const hx2 = x2 - 9 * Math.cos(a + 0.45);
  const hy2 = y2 - 9 * Math.sin(a + 0.45);
  return `<path d="M${x1} ${y1}L${x2} ${y2}M${hx1.toFixed(1)} ${hy1.toFixed(1)}L${x2} ${y2}L${hx2.toFixed(1)} ${hy2.toFixed(1)}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
};
const brick = (x: number, w: number, hgt: number): string => `<rect x="${x}" y="${140 - hgt}" width="${w}" height="${hgt}" fill="#C8643F" stroke="${INK}" stroke-width="2"/>`
  + Array.from({ length: Math.floor(hgt / 9) }, (_, i) => `<line x1="${x}" x2="${x + w}" y1="${140 - (i + 1) * 9}" y2="${140 - (i + 1) * 9}" stroke="#E8DCC8" stroke-width="1.4"/>`).join('');

const FIGS: Record<number, string> = {
  1: `${RAIL}${FLOOR}
    <path d="M120 125 A 95 95 0 0 0 200 125" fill="none" stroke="${INK}" stroke-dasharray="4 4" opacity=".5"/>
    ${trolley(150, 'rgba(57,69,95,.3)')}${str(150, 36, 150, 122, '3 4')}${ball(150, 122, BALL, 0.25)}
    ${trolley(178)}${str(178, 36, 205, 118)}${ball(205, 118)}
    ${arrow(160, 50, 210, 50, GOAL)}
    <rect x="180" y="137" width="60" height="5" rx="2" fill="${GOAL}"/>`,
  2: `${RAIL}${FLOOR}${brick(120, 16, 70)}${brick(186, 16, 70)}
    <path d="M60 116 C 110 20, 150 30, 160 110" fill="none" stroke="${AI}" stroke-width="3"/>
    ${arrow(146, 60, 158, 104, AI)}
    <path d="M166 110 C 176 30, 216 20, 268 116" fill="none" stroke="${BALL}" stroke-width="3" stroke-dasharray="7 5"/>
    ${arrow(250, 88, 266, 112, BALL)}
    ${ball(160, 116, AI, 0.6)}`,
  3: `${RAIL}${FLOOR}${trolley(160)}
    <path d="M140 118 A 88 88 0 0 0 180 118" fill="none" stroke="${INK}" stroke-width="2" opacity=".35"/>
    <path d="M118 108 A 88 88 0 0 0 202 108" fill="none" stroke="${INK}" stroke-width="2" opacity=".55"/>
    <path d="M96 90 A 88 88 0 0 0 224 90" fill="none" stroke="${INK}" stroke-width="2.4"/>
    ${str(160, 36, 224, 92)}${ball(224, 92)}
    ${arrow(130, 52, 96, 52, BALL)}${arrow(236, 70, 262, 58, INK)}`,
  4: `${RAIL}${FLOOR}${trolley(110)}
    <path d="M110 36 Q 150 90 176 58" fill="none" stroke="#2B2B2B" stroke-width="2"/>
    <path d="M150 96 Q 180 20 230 70" fill="none" stroke="${BALL}" stroke-width="2.6" stroke-dasharray="6 5"/>
    ${ball(176, 58)}${arrow(208, 50, 232, 72, BALL)}
    <text x="238" y="42" font-family="ui-monospace,monospace" font-size="15" font-weight="800" fill="${INK}">T &lt; 0</text>`,
  5: `${RAIL}${FLOOR}
    ${trolley(130)}${str(130, 36, 190, 110)}${ball(190, 110)}
    <circle cx="150" cy="60" r="5" fill="#fff" stroke="${INK}" stroke-width="2"/><path d="M150 55v10M145 60h10" stroke="${INK}" stroke-width="1.5"/>
    ${arrow(122, 50, 90, 50, INK)}${arrow(200, 126, 236, 126, BALL)}
    <text x="100" y="18" font-family="ui-monospace,monospace" font-size="14" font-weight="800" fill="${INK}">M</text>
    <text x="206" y="104" font-family="ui-monospace,monospace" font-size="14" font-weight="800" fill="${INK}">m</text>`,
};

export function noteFigure(world: number): SVGElement {
  return svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 150" role="img" aria-hidden="true">${FIGS[world] ?? ''}</svg>`);
}

/** Marks a note as read (seen.notes) so the NEW badge disappears. */
function markSeen(env: ScreenEnv, world: number): void {
  try {
    env.ctx.store?.update((d) => {
      if (!d.seen.notes.includes(world)) d.seen.notes.push(world);
    });
  } catch {
    /* store handles its own failures */
  }
}

export function renderNotesScreen(root: HTMLElement, screen: Extract<Screen, { id: 'notes' }>, env: ScreenEnv): ScreenHandle {
  const levels = env.levels();
  const save = env.save();
  // Without a store (dev / tests) every note is readable.
  const open = (w: number): boolean => !env.ctx.store || noteUnlocked(levels, save, w);
  let world = Math.min(5, Math.max(1, screen.world || 1));
  const back = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('common.back') }, icon('back'));
  back.addEventListener('click', () => env.back());
  const tabs = h('div', { class: 'ntabs', role: 'tablist' });
  const tabEls: HTMLButtonElement[] = [];
  const pageBox = h('div');
  for (let w = 1; w <= 5; w++) {
    const b = h('button', { class: `wtab ${open(w) ? '' : 'is-locked'}`, type: 'button', role: 'tab', 'aria-selected': 'false' },
      h('b', null, `W${w}`), open(w) ? null : icon('lock'));
    b.setAttribute('aria-label', `W${w} ${t(`notes.w${w}.title` as 'notes.w1.title')}`);
    b.addEventListener('click', () => select(w));
    tabs.appendChild(b);
    tabEls.push(b);
  }
  function select(w: number): void {
    world = w;
    tabEls.forEach((b, i) => b.setAttribute('aria-selected', i + 1 === w ? 'true' : 'false'));
    if (!open(w)) {
      pageBox.replaceChildren(h('div', { class: 'sheet lockpage' }, icon('lock'), t('notes.locked', { n: w })));
      return;
    }
    const k = (x: string): string => t(`notes.w${w}.${x}` as 'notes.w1.title');
    pageBox.replaceChildren(h('article', { class: 'sheet notepage' },
      h('div', { class: 'eyebrow', style: 'margin-left:30px' }, `${t('notes.title')} · W${w}`),
      h('h2', null, k('title')),
      h('p', null, k('body')),
      h('div', { class: 'formula', role: 'math', 'aria-label': k('formula') }, k('formula')),
      h('figure', { class: 'notefig', style: 'margin-inline-end:0' }, noteFigure(w), h('figcaption', null, k('caption')))));
    markSeen(env, w);
  }
  const page = h('div', { class: 'page screen-enter' },
    h('header', { class: 'page-head' }, back, h('h1', { class: 'page-title' }, t('notes.title'))),
    h('div', { class: 'page-body' }, h('div', { class: 'page-inner' }, tabs, pageBox)));
  root.appendChild(page);
  select(world);
  back.setAttribute('data-autofocus', '');
  return {
    onKey(e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const w = Math.min(5, Math.max(1, world + (e.key === 'ArrowRight' ? 1 : -1)));
        select(w);
        tabEls[w - 1]?.focus();
        return true;
      }
      return false;
    },
  };
}

/** "AIが負けた理由" (§5.4): shown once on the first crown; numbers from ghosts_summary.json. */
export function openAiLostCard(root: HTMLElement, env: ScreenEnv, level: LevelDef): HTMLElement {
  const sum = env.summary(level.id);
  const mm = sum?.aiMarginMm ?? 20;
  const n = sum?.aiTensionMinN ?? 1.5;
  const prev = document.activeElement as HTMLElement | null;
  const scrim = h('div', { class: 'yp-layer', 'data-kind': 'scrim', style: 'z-index:45', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('ailost.title') });
  const ok = h('button', { class: 'btn btn--primary btn--lg btn--block', type: 'button' }, t('ailost.ok'));
  let unmodal = (): void => undefined;
  const close = (): void => {
    unmodal();
    scrim.remove();
    prev?.focus?.({ preventScroll: true });
  };
  ok.addEventListener('click', close);
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  scrim.append(h('div', { class: 'center-wrap' }, h('div', { class: 'sheet card screen-enter' },
    h('div', { class: 'card-body' },
      h('div', { class: 'eyebrow' }, t('ailost.lead')),
      h('h2', { class: 'sheet-title', style: 'margin-top:6px' }, t('ailost.title')),
      h('ul', { class: 'rules' },
        h('li', null, t('ailost.r1', { mm })),
        h('li', null, t('ailost.r2', { n })),
        h('li', null, t('ailost.r3')),
        h('li', null, t('ailost.r4', { rest: fmtRest(level.physics.restDeg) })),
        h('li', null, t('ailost.r5'))),
      h('p', { class: 'closing' }, t('ailost.close'))),
    h('div', { class: 'card-foot' }, ok))));
  root.appendChild(scrim);
  unmodal = makeModal(root, scrim);
  ok.focus({ preventScroll: true });
  try {
    env.ctx.store?.update((d) => {
      d.seen.aiLostCard = true;
    });
  } catch {
    /* ignore */
  }
  return scrim;
}
