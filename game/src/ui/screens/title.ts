// Title screen (GAME_DESIGN.md §2.2 0:00, §9.4). Owner: O7.
// The attract loop (2-2 AI) is drawn by the renderer in the scene behind this overlay; the overlay only adds
// the logo, the tagline and the pulsing "あそぶ". Any tap or key starts (§2.2 0:03).
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { getLang, t } from '../i18n/format';

export function logo(big = true): HTMLElement {
  const ja = getLang() === 'ja';
  const main = ja
    ? h('h1', { class: 'logo', 'aria-label': t('app.title') }, h('span', { class: 'logo-a' }, 'ゆらして'), h('span', { class: 'logo-b' }, 'ピタッ'))
    : h('h1', { class: 'logo', 'aria-label': t('app.title') }, h('span', { class: 'logo-a' }, 'Swing & '), h('span', { class: 'logo-b' }, 'Stick'));
  if (!big) main.style.fontSize = '2.2rem';
  return main;
}

export function renderTitleScreen(root: HTMLElement, _screen: Extract<Screen, { id: 'title' }>, env: ScreenEnv): ScreenHandle {
  const start = (): void => env.emit('select', { from: 'title' });
  const wide = env.layoutKind() === 'wide';
  const play = h('button', { class: 'btn btn--primary btn--lg title-play', type: 'button' }, icon('play'), t('title.play'));
  play.addEventListener('click', (e) => {
    e.stopPropagation();
    start();
  });
  const mk = (ic: 'gear' | 'info', label: string, open: () => void): HTMLButtonElement => {
    const b = wide
      ? h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': label, title: label }, icon(ic))
      : h('button', { class: 'btn btn--flat', type: 'button' }, icon(ic), label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
    return b;
  };
  const settings = mk('gear', t('title.settings'), () => env.open({ id: 'settings' }));
  const about = mk('info', t('title.about'), () => env.open({ id: 'about' }));
  const tagline = h('div', { class: 'tagline' }, t('app.tagline'));

  const el = h('div', { class: 'title', tabindex: '-1', 'data-autofocus': '', 'aria-label': `${t('app.title')} — ${t('title.hint')}` });
  if (wide) {
    el.append(
      h('div', { class: 'title-logo' }, logo(), tagline),
      h('div', { class: 'title-corner' }, about, settings),
      h('div', { class: 'title-foot' }, play, h('div', { class: 'title-hint' }, t('title.hint'))));
  } else {
    el.append(
      h('div', { class: 'title-logo' }, logo(), h('div', { class: 'logo-sub' }, t('app.titleAlt'))),
      h('div', { class: 'title-foot' }, tagline, play, h('div', { class: 'title-hint' }, t('title.hint')), h('div', { class: 'title-links' }, settings, about)));
  }
  // Tap anywhere (outside the small buttons) = start.
  el.addEventListener('click', start);
  root.appendChild(el);
  return {
    onKey(e) {
      if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return false;
      const tgt = e.target as HTMLElement;
      if ((e.key === 'Enter' || e.key === ' ') && tgt.closest('.title-corner, .title-links')) return false;
      start();
      return true;
    },
  };
}
