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
  const skins = skinsButton(env);
  const tagline = h('div', { class: 'tagline' }, t('app.tagline'));

  const el = h('div', { class: 'title', tabindex: '-1', 'data-autofocus': '', 'aria-label': `${t('app.title')} — ${t('title.hint')}` });
  if (wide) {
    // DOM order = Tab order = reading order: the top-left スキン, the top-right corner, then あそぶ at the bottom.
    el.append(
      h('div', { class: 'title-logo' }, logo(), tagline),
      ...(skins ? [h('div', { class: 'title-corner title-corner--left' }, skins)] : []),
      h('div', { class: 'title-corner' }, about, settings),
      h('div', { class: 'title-foot' }, play, h('div', { class: 'title-hint' }, t('title.hint'))));
  } else {
    el.append(
      h('div', { class: 'title-logo' }, logo(), h('div', { class: 'logo-sub' }, t('app.titleAlt'))),
      h('div', { class: 'title-foot' }, skins ? h('div', { class: 'title-float' }, skins) : null, tagline, play, h('div', { class: 'title-hint' }, t('title.hint')), h('div', { class: 'title-links' }, settings, about)));
  }
  // Tap anywhere (outside the small buttons) = start.
  el.addEventListener('click', start);
  root.appendChild(el);
  return {
    onKey(e) {
      if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return false;
      const tgt = e.target as HTMLElement;
      if ((e.key === 'Enter' || e.key === ' ') && tgt.closest('.title-corner, .title-links, .title-float')) return false;
      start();
      return true;
    },
  };
}

/**
 * The スキン button (GAME_DESIGN.md §7.14), only when core provides the skins data: a labelled pill on the left. wide: the
 * top-left corner, inside the room the logo row already keeps free for the corner buttons (the logo and the tagline do
 * not move); tall: over the scene's lower left corner, above the footer (the footer's links row has no room for a third
 * link on a 320 px phone; the attract's walls and goal are in the middle and its ball lands there). A red dot while
 * unlocked skins wait unseen: the toast that announced them is gone after a few seconds, the dot stays until their tab
 * was opened on the skins screen.
 */
function skinsButton(env: ScreenEnv): HTMLButtonElement | null {
  let unseen = 0;
  try {
    const v = env.ctx.skins?.();
    if (!v) return null;
    unseen = v.unseen;
  } catch {
    return null;
  }
  const label = unseen > 0 ? t('title.skinsNew') : t('title.skins');
  const b = h('button', { class: 'btn title-skins title-skins--pill', type: 'button', 'aria-label': label }, icon('brush'), t('title.skins'));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    env.open({ id: 'skins' });
  });
  if (unseen > 0) b.append(h('span', { class: 'skin-dot', 'aria-hidden': 'true' }));
  return b;
}
