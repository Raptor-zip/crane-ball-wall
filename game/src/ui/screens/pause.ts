// Pause menu (GAME_DESIGN.md §9.4): resume / retry / practice (+ 5 s rewind while it is on) / AI demo / ghost set /
// AI line / notes / mute / level select / settings, plus the key-less equivalents of G, H, F1, M (§3.3) and the
// optional skip, assist, reverse. Owner: O7.
import type { LevelDef } from '../../sim/level';
import type { Screen, ScreenHandle } from '../ui';
import type { PauseInfo, ScreenEnv } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import type { IconName } from '../icons';
import { levelName, t } from '../i18n/format';

export function renderPauseScreen(root: HTMLElement, _screen: Extract<Screen, { id: 'pause' }>, env: ScreenEnv, pi: PauseInfo, level: LevelDef | null): ScreenHandle {
  const btn = (ic: IconName, label: string, opts: { kbd?: string; cls?: string; state?: string; stateOn?: boolean; sub?: string; disabled?: boolean } = {}): HTMLButtonElement => {
    const b = h('button', { class: `btn ${opts.cls ?? ''}`, type: 'button', disabled: !!opts.disabled },
      icon(ic),
      opts.sub || opts.state !== undefined
        ? h('span', { class: 'btn-stack' }, h('span', null, label),
          opts.sub ? h('span', { class: 'btn-sub' }, opts.sub) : null,
          opts.state !== undefined ? h('span', { class: `btn-state ${opts.stateOn ? 'is-on' : ''}` }, opts.state) : null)
        : h('span', null, label),
      opts.kbd && opts.state === undefined ? h('span', { class: 'kbd' }, opts.kbd) : null);
    b.setAttribute('aria-label', [label, opts.state, opts.sub, opts.kbd ? `(${opts.kbd})` : ''].filter(Boolean).join(' '));
    return b;
  };

  const resume = btn('play', t('pause.resume'), { kbd: 'Esc', cls: 'btn--primary btn--lg btn--wide' });
  resume.setAttribute('data-autofocus', '');
  resume.addEventListener('click', () => env.emit('resume'));
  const retry = btn('retry', t('pause.retry'), { kbd: 'R' });
  retry.addEventListener('click', () => env.emit('retry'));
  const demo = btn('demo', t('pause.demo'), { cls: 'btn--ai' });
  demo.addEventListener('click', () => env.emit('demo'));
  const practice = btn('practice', pi.practice ? t('pause.practiceOff') : t('pause.practice'), {
    sub: pi.practiceAvailable || pi.practice ? t('pause.practiceNote') : t('pause.practiceLocked'),
    disabled: !pi.practiceAvailable && !pi.practice,
    cls: 'btn--wide',
  });
  practice.addEventListener('click', () => env.emit('practice', { on: !pi.practice }));
  // Practice mode: rewind 5 s and play on from there (§3.5, D3; R held for 300 ms does the same while playing).
  let rewind: HTMLButtonElement | null = null;
  if (pi.practice) {
    rewind = btn('practice', t('pause.rewind'), { kbd: t('pause.rewindKey'), cls: 'btn--practice btn--wide' });
    rewind.setAttribute('aria-keyshortcuts', 'R');
    rewind.addEventListener('click', () => {
      env.emit('rewind', { seconds: 5 });
      env.emit('resume');
    });
  }

  const ghostSetText = (set: number): string => t(`pause.ghostSet.${set}` as 'pause.ghostSet.0');
  // 「AI＋自己ベスト」 may wrap after the ＋ on narrow phones (the badge is keep-all): a <wbr>, not in textContent.
  const fillState = (el: Element, text: string): void => {
    const i = text.search(/[＋+]/u);
    if (i < 0) el.textContent = text;
    else el.replaceChildren(text.slice(0, i + 1), h('wbr', null), text.slice(i + 1));
  };
  const ghosts = btn('ghost', t('pause.ghosts'), { state: ghostSetText(pi.ghostSet), stateOn: pi.ghostSet !== 4 });
  const ghostState = ghosts.querySelector('.btn-state');
  if (ghostState) fillState(ghostState, ghostSetText(pi.ghostSet));
  ghosts.addEventListener('click', () => {
    env.emit('ghostCycle');
    sync();
  });
  const aiLine = btn('line', t('pause.aiLine'), { state: pi.aiLine ? t('common.on') : t('common.off'), stateOn: pi.aiLine });
  aiLine.addEventListener('click', () => {
    env.emit('aiLine');
    sync();
  });
  const notes = btn('book', t('pause.notes'), { kbd: '?' });
  notes.addEventListener('click', () => env.emit('notes', { world: level?.world || 1 }));
  const mute = btn(pi.muted ? 'mute' : 'sound', t('pause.mute'), { state: pi.muted ? t('common.on') : t('common.off'), stateOn: pi.muted });
  mute.addEventListener('click', () => {
    env.emit('mute');
    sync();
  });

  // The labels show what the game actually did (core skips ghost sets that are not available, e.g. WR offline, and
  // the G / H / M keys also work while paused): re-read after every tap and a few times a second.
  let shown = '';
  function setState(b: HTMLButtonElement | null, label: string, text: string, on: boolean, kbd: string, toggle = true): void {
    if (!b) return;
    const st = b.querySelector('.btn-state');
    if (st) {
      fillState(st, text);
      st.classList.toggle('is-on', on);
    }
    b.setAttribute('aria-label', kbd ? `${label} ${text} (${kbd})` : `${label} ${text}`);
    if (toggle) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function sync(): void {
    let now: PauseInfo;
    try {
      now = env.pauseInfo();
    } catch {
      return;
    }
    const key = `${now.ghostSet}|${now.aiLine}|${now.muted}|${now.assist}`;
    if (key === shown) return;
    shown = key;
    const onOff = (on: boolean): string => (on ? t('common.on') : t('common.off'));
    setState(ghosts, t('pause.ghosts'), t(`pause.ghostSet.${now.ghostSet}` as 'pause.ghostSet.0'), now.ghostSet !== 4, 'G', false);
    setState(aiLine, t('pause.aiLine'), onOff(now.aiLine), now.aiLine, 'H');
    setState(mute, t('pause.mute'), onOff(now.muted), now.muted, 'M');
    mute.querySelector('svg')?.replaceWith(icon(now.muted ? 'mute' : 'sound'));
    assistOn = now.assist;
    setState(assistBtn, t('pause.assist'), onOff(now.assist), now.assist, '');
  }
  const settings = btn('gear', t('pause.settings'));
  settings.addEventListener('click', () => env.open({ id: 'settings' }));
  const select = btn('list', t('pause.select'));
  select.addEventListener('click', () => env.emit('select', { from: 'pause' }));

  const extras: HTMLElement[] = [];
  let assistOn = pi.assist;
  let assistBtn: HTMLButtonElement | null = null;
  if (pi.reverseHint) {
    const rev = btn('reverse', t('pause.reverse'), { cls: 'btn--ai btn--wide' });
    rev.addEventListener('click', () => env.emit('reverseHint'));
    extras.push(rev);
  }
  if (pi.assistOffered) {
    const as = btn('assist', t('pause.assist'), { sub: t('pause.assistNote'), state: pi.assist ? t('common.on') : t('common.off'), stateOn: pi.assist, cls: 'btn--wide' });
    as.addEventListener('click', () => {
      env.emit('assistAccept', { on: !assistOn });
      sync();
    });
    assistBtn = as;
    extras.push(as);
  }
  if (pi.skipAvailable) {
    const sk = btn('skip', t('pause.skip'), { cls: 'btn--wide' });
    sk.addEventListener('click', () => env.emit('skip'));
    extras.push(sk);
  }

  sync();

  const card = h('section', { class: 'sheet card screen-enter', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('pause.title') },
    h('div', { class: 'card-body' },
      h('div', { style: 'display:flex;align-items:center;gap:10px' },
        h('h2', { class: 'sheet-title' }, t('pause.title')),
        level ? h('span', { class: 'idchip', style: 'margin-left:auto' }, level.world === 0 ? t('hud.daily') : level.id) : null,
        level ? h('span', { style: 'font-weight:800;font-size:.85rem;color:var(--ink-2);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, levelName(level)) : null),
      h('div', { class: 'pause-grid' }, resume, retry, demo, practice, rewind, ghosts, aiLine, notes, mute, ...extras, select, settings)));
  root.appendChild(h('div', { class: 'center-wrap' }, card));
  let frames = 0;
  return {
    onHud() {
      if (++frames % 12 === 0) sync();
    },
    onKey(e) {
      if (!e.key.startsWith('Arrow')) return false;
      const items = [...card.querySelectorAll<HTMLButtonElement>('.pause-grid .btn:not([disabled])')];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return false;
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      items[(i + d + items.length) % items.length]!.focus();
      return true;
    },
  };
}
