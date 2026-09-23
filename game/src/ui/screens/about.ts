// About (GAME_DESIGN.md §7.13 "About 画面", §7.11): the credit 「制作 貝淵蒼馬」 only, the MathWorks blog inspiration
// link and the one-line anti-cheat limitation. No tool or date credits. Owner: O7.
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { t } from '../i18n/format';
import { logo } from './title';
import { noteFigure } from './notes';

export const MATHWORKS_BLOG_URL = 'https://blogs.mathworks.com/community/2026/07/31/simulate-in-matlab-animate-in-blender/';

export function renderAboutScreen(root: HTMLElement, _screen: Extract<Screen, { id: 'about' }>, env: ScreenEnv): ScreenHandle {
  const back = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('common.back'), 'data-autofocus': '' }, icon('back'));
  back.addEventListener('click', () => env.back());
  // "制作 貝淵蒼馬" / "Made by 貝淵蒼馬": drawn like the title block of a drawing (label | name).
  const credit = t('about.credit');
  const cut = credit.lastIndexOf(' ');
  const page = h('div', { class: 'page screen-enter' },
    h('header', { class: 'page-head' }, back, h('h1', { class: 'page-title' }, t('about.title'))),
    h('div', { class: 'page-body' },
      h('section', { class: 'sheet about' },
        logo(false),
        h('div', { class: 'logo-sub', style: 'margin-top:8px' }, t('app.titleAlt')),
        h('p', { class: 'about-credit', 'aria-label': credit }, h('span', null, credit.slice(0, cut)), h('b', null, credit.slice(cut + 1))),
        h('figure', { class: 'notefig', 'aria-hidden': 'true' }, noteFigure(2)),
        h('p', null, h('a', { href: MATHWORKS_BLOG_URL, target: '_blank', rel: 'noopener' }, t('about.inspired'))),
        h('p', { class: 'about-fine' }, t('about.antiCheat')))));
  root.appendChild(page);
  return {};
}
