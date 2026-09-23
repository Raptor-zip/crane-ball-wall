// Settings (GAME_DESIGN.md §3.5 accessibility, §3.3 keyboard mode, §3.5 ghost shapes, §7.7 generated name). Owner: O7.
import type { SaveV1 } from '../../store/save';
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import type { GhostKind } from '../../render/renderer';
import { h } from '../dom';
import { ghostShape, icon } from '../icons';
import { fmtNum, t } from '../i18n/format';
import { KEY_RAMP, KEY_TAP } from '../../input/keyboard';
import { FRAGILE } from '../../input/servo';
import type { I18nKey } from '../i18n/format';
import { safeName } from './board';

type Settings = SaveV1['settings'];

export function renderSettingsScreen(root: HTMLElement, _screen: Extract<Screen, { id: 'settings' }>, env: ScreenEnv): ScreenHandle {
  let st: Settings = { ...env.settings() };
  const commit = (patch: Partial<Settings>): void => {
    st = { ...st, ...patch };
    env.applySettings(st);
  };

  /** Segmented radio group (keyboard: arrows move the selection). `picked`: called after a choice is committed. */
  function seg<K extends keyof Settings>(key: K, label: string, options: [Settings[K], string][], picked?: (v: Settings[K]) => void): HTMLElement {
    const group = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label, 'data-seg': String(key) });
    const buttons = options.map(([val, text]) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': st[key] === val ? 'true' : 'false', tabindex: st[key] === val ? '0' : '-1' }, text);
      b.addEventListener('click', () => {
        buttons.forEach((x, i) => {
          const on = options[i]![0] === val;
          x.setAttribute('aria-checked', on ? 'true' : 'false');
          x.setAttribute('tabindex', on ? '0' : '-1');
        });
        commit({ [key]: val } as Partial<Settings>);
        picked?.(val);
      });
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        e.stopPropagation();
        const i = buttons.indexOf(b);
        const n = buttons[(i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]!;
        n.focus();
        n.click();
      });
      return b;
    });
    group.append(...buttons);
    return group;
  }

  const row = (label: string, control: HTMLElement, note?: string | HTMLElement): HTMLElement =>
    h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, label, typeof note === 'string' ? h('span', { class: 'note' }, note) : note ?? null), control);

  const onOff = (key: 'haptics' | 'muted' | 'steady', label: string): HTMLElement => seg(key, label, [[true, t('common.on')], [false, t('common.off')]] as [Settings[typeof key], string][]);

  // Volume slider.
  const volVal = h('span', { class: 'num' }, String(st.volume));
  const vol = h('input', { type: 'range', min: 0, max: 100, step: 5, value: st.volume, 'aria-label': t('settings.volume') }) as HTMLInputElement;
  vol.addEventListener('input', () => {
    volVal.textContent = vol.value;
  });
  vol.addEventListener('change', () => commit({ volume: Number(vol.value) }));
  // The slider keeps its own arrow keys; Escape and Tab still reach the screen.
  vol.addEventListener('keydown', (e) => {
    if (/^(Arrow|Home|End|Page)/.test(e.key)) e.stopPropagation();
  });

  // Keyboard controls (§3.3, R10): the note follows the chosen mode. Speed: hold to run, a tap steps the hold point,
  // Shift / Z slow (and a smaller step); egg levels cap the speed. Direct force: full force, Shift / Z a quarter.
  const cm = (m: number): string => String(Math.round(m * 100));
  const kbNoteText = (mode: Settings['keyboard']): string => mode === 'force'
    ? t('settings.keyboardNoteForce')
    : t('settings.keyboardNote', { step: cm(KEY_TAP.stepM), stepFine: cm(KEY_TAP.stepFineM), fine: fmtNum(KEY_RAMP.capFine / KEY_RAMP.perMps, 1), egg: fmtNum(FRAGILE.vCap, 1) });
  const kbNote = h('span', { class: 'note', 'data-note': 'keyboard' }, kbNoteText(st.keyboard));

  const hasVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  const save = env.save();

  // Player name (generated only, §7.7).
  const nameEl = h('b', null, save ? safeName(save.id.nameSeed, save.id.pidh) : '—');
  const reroll = h('button', { class: 'btn', type: 'button', disabled: !save }, icon('retry'), t('settings.reroll'));
  reroll.addEventListener('click', () => {
    env.emit('rerollName');
    // core updates the store synchronously or shortly after.
    const upd = (): void => {
      const s = env.save();
      if (s) nameEl.textContent = safeName(s.id.nameSeed, s.id.pidh);
    };
    upd();
    setTimeout(upd, 50);
  });

  const legendKinds: [GhostKind, I18nKey][] = [['ai', 'ghost.ai'], ['pb', 'ghost.pb'], ['wr', 'ghost.wr'], ['rival', 'ghost.rival'], ['challenge', 'ghost.challenge']];
  const legend = h('div', { class: 'legend' }, ...legendKinds.map(([k, key]) => h('span', null, ghostShape(k), t(key))));

  const back = h('button', { class: 'btn btn--icon', type: 'button', 'aria-label': t('common.back'), 'data-autofocus': '' }, icon('back'));
  back.addEventListener('click', () => env.back());

  const warn = env.ctx.store && !env.ctx.store.persistent ? h('div', { class: 'warnbox' }, icon('offline'), t('settings.storage')) : null;

  // Skins (§7.14): from the menus only (never over the pause menu or a results card: skins change outside a run and
  // the sheet shows them on the title attract).
  let skinsRow: HTMLElement | null = null;
  try {
    const v = env.ctx.skins?.();
    const host = env.host();
    if (v && (host === 'title' || host === 'select' || host === 'daily')) {
      const open = h('button', { class: 'btn set-skins', type: 'button', 'aria-label': v.unseen > 0 ? t('title.skinsNew') : t('settings.skins') },
        icon('brush'), t('settings.skinsOpen'), v.unseen > 0 ? h('span', { class: 'skin-dot', 'aria-hidden': 'true' }) : null);
      open.addEventListener('click', () => env.open({ id: 'skins' }));
      skinsRow = row(t('settings.skins'), open, t('settings.skinsNote'));
    }
  } catch {
    skinsRow = null;
  }

  const page = h('div', { class: 'page screen-enter' },
    h('header', { class: 'page-head' }, back, h('h1', { class: 'page-title' }, t('settings.title'))),
    h('div', { class: 'page-body' }, h('div', { class: 'page-inner', style: 'max-width:680px' },
      warn,
      h('section', { class: 'sheet set-section' },
        h('h2', null, t('settings.section.display')),
        row(t('settings.lang'), seg('lang', t('settings.lang'), [['ja', '日本語'], ['en', 'English']], () => commit({ langPicked: true }))),
        row(t('settings.textScale'), seg('textScale', t('settings.textScale'), [[100, '100%'], [125, '125%']])),
        row(t('settings.motion'), seg('motion', t('settings.motion'), [['auto', t('common.auto')], ['on', t('common.on')], ['off', t('common.off')]]), t('settings.motionNote')),
        row(t('settings.quality'), seg('quality', t('settings.quality'), [['auto', t('settings.quality.auto')], ['high', t('settings.quality.high')], ['low', t('settings.quality.low')]])),
        skinsRow),
      h('section', { class: 'sheet set-section' },
        h('h2', null, t('settings.section.sound')),
        row(t('settings.volume'), h('div', { class: 'range' }, vol, volVal)),
        row(t('settings.mute'), onOff('muted', t('settings.mute'))),
        hasVibrate ? row(t('settings.haptics'), onOff('haptics', t('settings.haptics'))) : null),
      h('section', { class: 'sheet set-section' },
        h('h2', null, t('settings.section.controls')),
        row(t('settings.steady'), onOff('steady', t('settings.steady')), t('settings.steadyNote')),
        row(t('settings.keyboard'), seg('keyboard', t('settings.keyboard'), [['speed', t('settings.keyboard.speed')], ['force', t('settings.keyboard.force')]], (v) => {
          kbNote.textContent = kbNoteText(v);
        }), kbNote)),
      h('section', { class: 'sheet set-section' },
        h('h2', null, t('settings.section.ghosts')),
        row(t('settings.aiLine'), seg('aiLine', t('settings.aiLine'), [[null, t('settings.aiLine.auto')], [true, t('common.on')], [false, t('common.off')]]), t('settings.aiLineNote')),
        row(t('settings.ghostLegend'), legend)),
      h('section', { class: 'sheet set-section' },
        h('h2', null, t('settings.section.player')),
        row(t('settings.name'), h('div', { class: 'namebox' }, nameEl, reroll), t('settings.nameNote'))))));
  root.appendChild(page);
  return {};
}
