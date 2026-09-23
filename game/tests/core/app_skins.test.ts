// @vitest-environment happy-dom
// Skins in the state machine (GAME_DESIGN.md §7.14): the equipped look reaches the renderer before init, unlocks toast
// after a run (never while RUNNING), the share card gets the ball colour, and the スキン sheet runs on the live title
// attract, from the title or from the settings over a menu page, and hands the menu back when it closes. Owner: O3.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App, type AppDeps } from '../../src/core/app';
import { createGameData } from '../../src/core/data';
import { createSession } from '../../src/core/session';
import { servoQ } from '../../src/input/servo';
import { Status } from '../../src/sim/run';
import type { LevelDef } from '../../src/sim/level';
import type { SkinLook } from '../../src/render/skinLooks';
import { defaultLevelProgress } from '../../src/store/save';
import { progressHash } from '../../src/core/progress';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import { t } from '../../src/ui/i18n/format';
import { FakeInput, FakeRenderer, FakeUI, MemStore } from './fakes';

const data = createGameData();
const L = (id: string): LevelDef => data.level(id)!;

/** FakeRenderer plus the RendererExtras skin hook, recording the order against init. */
class SkinRenderer extends FakeRenderer {
  log: string[] = [];
  looks: SkinLook[] = [];
  override init(c: HTMLCanvasElement, o: { quality: 'auto' | 'high' | 'low'; reducedMotion: boolean }): void {
    this.log.push('init');
    super.init(c, o);
  }
  setSkin(l: SkinLook): void {
    this.log.push(`skin:${l.ball.id},${l.crane.id},${l.trail.id},${l.stage.id}`);
    this.looks.push(l);
  }
  get last(): string[] {
    const l = this.looks.at(-1)!;
    return [l.ball.id, l.crane.id, l.trail.id, l.stage.id];
  }
}

interface Rig { app: App; ui: FakeUI | null; root: HTMLElement; renderer: SkinRenderer; input: FakeInput; store: MemStore }
const apps: App[] = [];
afterEach(() => {
  while (apps.length) apps.pop()!.dispose();
  vi.useRealTimers();
});

/** fakeUi false: the real UI (createUI through the app's own forwarding context) mounted in happy-dom. */
function rig(store = new MemStore(), fakeUi = true): Rig {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  const ui = fakeUi ? new FakeUI() : null;
  const renderer = new SkinRenderer();
  const input = new FakeInput();
  const deps: Partial<AppDeps> = {
    renderer, input, store, api: null, audio: null, haptics: null, data, autoStart: false,
    now: () => DAILY_EPOCH + 10 * DAY_MS + 3600_000,
    location: { hash: '', protocol: 'https:', origin: 'https://y.example' },
    prefersReducedMotion: () => true,
  };
  if (ui) deps.ui = ui;
  const app = createApp(root, deps);
  apps.push(app);
  return { app, ui, root, renderer, input, store };
}

const clear = (s: MemStore, id: string, e: Record<string, unknown> = {}): void => {
  s.d.levels[id] = { ...defaultLevelProgress(progressHash(data.hash(L(id)))), cleared: true, attempts: 1, ...e };
};

function replay11(): string {
  const lv = L('1-1');
  const s = createSession(lv);
  const frame = { intent: { kind: 'target' as const, x: 1.5 }, fine: false, device: 1, targetX: 1.5 };
  for (let i = 0; i < 3600; i++) {
    if (s.tick(servoQ(frame, s.run.s, lv.physics, false), frame) !== Status.Running && s.started) break;
  }
  return s.replay()!;
}

describe('boot', () => {
  it('the equipped look goes to the renderer BEFORE init (painted once), then not again while unchanged', () => {
    const store = new MemStore();
    store.d.skins = { owned: ['ball.steel', 'stage.diazo'], seen: [], bestStreak: 0 };
    store.d.settings.skin = { ball: 'ball.steel', stage: 'stage.diazo', crane: 'crane.tancho' };   // tancho: locked
    const r = rig(store);
    expect(r.renderer.log[0]).toBe('skin:ball.steel,crane.yellow,trail.ink,stage.diazo');
    expect(r.renderer.log[1]).toBe('init');
    expect(r.renderer.looks).toHaveLength(1);
    r.ui!.emit('settingsChanged', { lang: 'ja' });
    expect(r.renderer.looks).toHaveLength(1);
  });

  it('an existing player: every skin already earned is owned at boot, with one summary toast on the title', () => {
    const store = new MemStore();
    for (const id of ['1-1', '1-2', '1-3', '1-4']) clear(store, id, { medal: 3 });
    const r = rig(store);
    expect(r.app.state()).toBe('TITLE');
    expect(store.d.skins!.owned).toEqual(['ball.steel', 'trail.pencil']);
    expect(r.ui!.toasts).toContainEqual({ text: t('skin.toastMany', { n: 2 }), kind: 'info' });
  });
});

describe('after a run', () => {
  it('the first clear unlocks 鉛筆と消しカス: a named toast at the results (none while RUNNING), the card gets no ball fill', async () => {
    const r = rig();
    r.input.command('any');
    const toastsAt = (): string[] => r.ui!.toasts.map((x) => x.text);
    const res = await r.app.playReplay('1-1', replay11());
    expect(res.state).toBe('RESULTS');
    expect(r.store.d.skins!.owned).toContain('trail.pencil');
    expect(toastsAt()).toContain(t('skin.toast', { name: t('skin.trail.pencil.name') }));
    const shown = r.ui!.last as { id: string; data: { ballFill?: string; skins?: string[] } };
    expect(shown.id).toBe('results');
    expect(shown.data.ballFill).toBeUndefined();
    expect(shown.data.skins).toEqual(['trail.pencil']);   // also on the card (a small phone's toast can miss)
  });

  it('the results card carries the equipped ball colour for the share card', async () => {
    const store = new MemStore();
    clear(store, '1-1');
    store.d.skins = { owned: ['ball.kinobi', 'trail.pencil'], seen: [], bestStreak: 0 };
    store.d.settings.skin = { ball: 'ball.kinobi' };
    const r = rig(store);
    r.ui!.emit('openLevel', '1-1');
    const res = await r.app.playReplay('1-1', replay11());
    expect(res.state).toBe('RESULTS');
    expect((r.ui!.last as { data: { ballFill?: string } }).data.ballFill).toBe('#2A2B30');
  });

  it('the daily streak at boot is kept as bestStreak and unlocks the streak skins (markPlayed may reset it later)', () => {
    const store = new MemStore();
    clear(store, '1-1');
    clear(store, '1-2');
    store.d.daily = { ...store.d.daily, streak: 9, dayIndex: 9, lastPlayedDay: 9 };
    const r = rig(store);
    expect(store.d.skins!.bestStreak).toBe(9);   // boot check
    expect(store.d.skins!.owned).toEqual(expect.arrayContaining(['ball.moss', 'crane.primer']));
    expect(r.app.state()).toBe('TITLE');
  });
});

describe('the スキン sheet (real UI)', () => {
  const yp = (r: Rig): HTMLElement => r.root.querySelector<HTMLElement>('.yp')!;
  const click = (r: Rig, sel: string): void => {
    const el = r.root.querySelector<HTMLElement>(sel);
    expect(el, sel).not.toBeNull();
    el!.click();
  };

  it('over the title: equip an unlocked skin, try a locked one on (debounced), closing goes back to the equipped look', () => {
    vi.useFakeTimers();
    const store = new MemStore();
    store.d.skins = { owned: ['ball.steel'], seen: [], bestStreak: 0 };
    const r = rig(store, false);
    expect(yp(r).dataset.screen).toBe('title');
    expect(r.root.querySelector('.title-skins .skin-dot')).not.toBeNull();   // ball.steel is new
    click(r, '.title-skins');
    expect(yp(r).dataset.screen).toBe('skins');
    expect(r.app.state()).toBe('TITLE');   // the attract keeps running behind the sheet
    expect(store.d.skins!.seen).toEqual(['ball.steel']);   // the ball tab opened first (it has the new skin)

    click(r, '[data-skin="ball.steel"]');
    expect(store.d.settings.skin).toEqual({ ball: 'ball.steel' });
    expect(r.renderer.last).toEqual(['ball.steel', 'crane.yellow', 'trail.ink', 'stage.note']);
    expect(r.root.querySelector('[data-skin="ball.steel"]')!.getAttribute('aria-checked')).toBe('true');

    click(r, '#skins-tab-stage');
    const n = r.renderer.looks.length;
    click(r, '[data-skin="stage.castle"]');
    expect(r.renderer.looks.length).toBe(n);   // debounced
    expect(r.root.querySelector<HTMLElement>('.skins-try')!.hidden).toBe(false);
    vi.advanceTimersByTime(200);
    expect(r.renderer.last).toEqual(['ball.steel', 'crane.yellow', 'trail.ink', 'stage.castle']);
    expect(store.d.settings.skin).toEqual({ ball: 'ball.steel' });   // a try-on is never stored

    // Stray confirm / any (a key off the controls, a gamepad button) keep the sheet: the title does not start.
    r.input.command('confirm');
    r.input.command('any');
    expect(r.app.state()).toBe('TITLE');
    expect(yp(r).dataset.screen).toBe('skins');

    click(r, '.skins-close');
    expect(yp(r).dataset.screen).toBe('title');
    expect(r.renderer.last).toEqual(['ball.steel', 'crane.yellow', 'trail.ink', 'stage.note']);
    expect(r.root.querySelector('.title-skins .skin-dot')).toBeNull();
    // Closed: the title starts again on any key.
    r.input.command('any');
    expect(r.app.state()).not.toBe('TITLE');
  });

  it('from the settings over the level select: the attract runs behind the sheet, the select comes back on close', () => {
    const store = new MemStore();
    clear(store, '1-1');
    const r = rig(store, false);
    r.input.command('any');
    expect(r.app.state()).toBe('LEVEL_SELECT');
    // 鉛筆と消しカス (1-1 cleared) waits unseen: the select's gear carries the NEW dot to the settings' skins row.
    expect(r.root.querySelector('.page-head .has-skin-dot .skin-dot')).not.toBeNull();
    expect(r.root.querySelector('.page-head .has-skin-dot')!.getAttribute('aria-label')).toBe(t('select.settingsNew'));
    click(r, '.page-head .btn--icon[title="設定"]');
    expect(yp(r).dataset.screen).toBe('settings');
    click(r, '.set-skins');
    expect(yp(r).dataset.screen).toBe('skins');
    expect(r.app.state()).toBe('TITLE');
    expect(r.renderer.loaded.at(-1)).toBe('2-2');
    r.app.advance(0.5);
    expect(r.renderer.lastFrame!.ghosts.map((g) => g.kind)).toEqual(['ai']);
    // The title attract behind the sheet never starts: confirm / any key or gamepad button do nothing.
    r.input.command('confirm');
    r.input.command('any');
    expect(r.app.state()).toBe('TITLE');
    expect(yp(r).dataset.screen).toBe('skins');
    click(r, '.skins-close');
    expect(yp(r).dataset.screen).toBe('settings');
    expect(r.app.state()).toBe('LEVEL_SELECT');
    // Esc on the settings page: back on the select, still a working menu (a level opens).
    r.app.command('back');
    expect(yp(r).dataset.screen).toBe('select');
    expect(r.app.state()).toBe('LEVEL_SELECT');
    r.input.command('back');
    expect(r.app.state()).toBe('TITLE');
  });

  it('never over the pause menu: the settings opened there have no skins row', () => {
    const store = new MemStore();
    clear(store, '1-1');
    const r = rig(store, false);
    r.input.command('any');
    click(r, '.tile[data-level="1-1"]');
    expect(r.app.state()).toBe('READY');
    r.input.command('pause');
    expect(r.app.state()).toBe('PAUSED');
    const settingsBtn = [...r.root.querySelectorAll<HTMLElement>('.pause-grid .btn')].find((b) => (b.textContent ?? '').includes(t('pause.settings')));
    expect(settingsBtn).toBeDefined();
    settingsBtn!.click();
    expect(yp(r).dataset.screen).toBe('settings');
    expect(r.root.querySelector('.set-skins')).toBeNull();
  });
});
