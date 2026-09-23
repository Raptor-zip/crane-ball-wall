// @vitest-environment happy-dom
// App wiring of the lead decisions D3 / D5 / D7 / D8 and the review fixes of this round (§9.4, §3.5, §7.9). Owner: O3.
// Fake UI / renderer / input / store / api / audio; the real sim, servo and data.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, aiMarginMmOf, showStatus, showHoldFrac, type App, type AppDeps } from '../../src/core/app';
import { bundledSources, createGameData, type GameData } from '../../src/core/data';
import { Status } from '../../src/sim/run';
import type { DailyDef, LevelDef } from '../../src/sim/level';
import type { AudioEngine } from '../../src/audio/engine';
import type { GameEvent } from '../../src/core/bus';
import { DAILY_EPOCH, DAY_MS, pickDaily } from '../../src/shared/daily';
import { t } from '../../src/ui/i18n/format';
import { FakeApi, FakeInput, FakeRenderer, FakeUI, MemStore } from './fakes';

const data = createGameData();
const L = (id: string): LevelDef => data.level(id)!;
const NOW = DAILY_EPOCH + 10 * DAY_MS + 3600_000;

class FakeAudio implements AudioEngine {
  updates: Parameters<AudioEngine['update']>[0][] = [];
  unlock(): void {}
  setVolume(): void {}
  setMuted(): void {}
  suspend(): void {}
  resume(): void {}
  update(p: Parameters<AudioEngine['update']>[0]): void {
    this.updates.push({ ...p });
    if (this.updates.length > 20) this.updates.shift();
  }
  fx(): void {}
}

interface Rig { app: App; ui: FakeUI; renderer: FakeRenderer; input: FakeInput; store: MemStore; api: FakeApi | null; audio: FakeAudio }

const apps: App[] = [];
afterEach(() => {
  while (apps.length) apps.pop()!.dispose();
});

function rig(o: { hash?: string; store?: MemStore; api?: FakeApi | null; data?: GameData; ui?: FakeUI; root?: HTMLElement } = {}): Rig {
  const ui = o.ui ?? new FakeUI();
  const renderer = new FakeRenderer();
  const input = new FakeInput();
  const store = o.store ?? new MemStore();
  const api = o.api === undefined ? null : o.api;
  const audio = new FakeAudio();
  const deps: Partial<AppDeps> = {
    ui, renderer, input, store, api, audio, haptics: null, data: o.data ?? data, autoStart: false, now: () => NOW,
    location: { hash: o.hash ?? '', protocol: 'https:', origin: 'https://y.example' }, prefersReducedMotion: () => false,
  };
  const app = createApp(o.root ?? document.createElement('div'), deps);
  apps.push(app);
  return { app, ui, renderer, input, store, api, audio };
}

function until(r: Rig, pred: () => boolean, maxFrames = 3000, dt = 1 / 15): number {
  for (let i = 0; i < maxFrames; i++) {
    if (pred()) return i;
    r.app.advance(dt);
  }
  return pred() ? maxFrames : -1;
}

function emptyP(hash: string) {
  return {
    hash, cleared: false, skipped: false, attempts: 0, fails: 0, consecutiveCrashes: 0, bestSub: null, bestReplay: null,
    medal: 0 as const, crown: false, badges: [], hintsSeen: 0, briefed: false, demoShown: false, aiBeatenSent: false,
  };
}

function cleared(...ids: string[]): MemStore {
  const store = new MemStore();
  for (const id of ids) store.d.levels[id] = { ...emptyP(data.hash(L(id))), cleared: true, briefed: true };
  return store;
}

/** 84 daily entries made from a campaign level (tier = i % 7 + 1), optionally with an AI margin of their own. */
function dailyData(base: string, marginMm?: number): GameData {
  const src = bundledSources();
  const lv = L(base);
  const pool: DailyDef[] = Array.from({ length: 84 }, (_, i) => ({
    ...lv, id: `d:${i}`, world: 0, order: i, tier: ((i % 7) + 1) as DailyDef['tier'], template: 'hop', parSub: 300, hints: undefined,
    name: { ja: 'ハードル × ふつう', en: 'Hurdles × Plain' },
    ai: marginMm === undefined ? lv.ai : { ...lv.ai, marginMm } as LevelDef['ai'],
  }));
  return createGameData({ ...src, dailyPool: { format: 1, pool } });
}

const fxOf = <K extends GameEvent['t']>(r: Rig, k: K): Extract<GameEvent, { t: K }>[] =>
  r.renderer.fxs.filter((e): e is Extract<GameEvent, { t: K }> => e.t === k);

// ------------------------------------------------------------------------------------------------ D3 rewind

describe('practice rewind (D3)', () => {
  it("the 'rewind' command goes 5 s back in a running practice run; input practice follows the play", () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    expect(r.input.practice.at(-1)).toBe(false);
    r.ui.emit('practice', { on: true });
    expect(r.app.debugState().mode).toBe('practice');
    expect(r.input.practice.at(-1)).toBe(true);
    r.input.target(0.4);
    until(r, () => r.app.debugState().ticks >= 360);
    const before = r.app.debugState().ticks;
    const resets = r.renderer.resets;
    r.input.command('rewind');
    r.input.command('any'); // the long press also sends 'any': ignored while running
    expect(r.app.state()).toBe('RUNNING');
    expect(r.app.debugState().ticks).toBe(before - 300);
    expect(r.renderer.resets).toBe(resets + 1); // trail / debris of the discarded future cleared
    expect(fxOf(r, 'rewind').at(-1)).toEqual({ t: 'rewind', ticks: before - 300, phase: 0 });
    r.app.advance(1 / 15);
    expect(r.app.debugState().ticks).toBeGreaterThan(before - 300);
    r.ui.emit('notes'); // the notes open over the pause menu: no rewind key there ...
    expect(r.app.state()).toBe('PAUSED');
    expect(r.input.practice.at(-1)).toBe(false);
    r.ui.emit('resume'); // ... and it is back with the run
    expect(r.app.state()).toBe('RUNNING');
    expect(r.input.practice.at(-1)).toBe(true);
    r.ui.emit('select');
    expect(r.input.practice.at(-1)).toBe(false);
  });

  it('does nothing outside practice, and the HUD button (UI action) works like the key', () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    r.input.target(0.4);
    until(r, () => r.app.debugState().ticks >= 360);
    const t0 = r.app.debugState().ticks;
    r.input.command('rewind');
    expect(r.app.debugState().ticks).toBe(t0);
    expect(fxOf(r, 'rewind')).toEqual([]);
    r.ui.emit('practice', { on: true });
    r.input.target(0.4);
    until(r, () => r.app.debugState().ticks >= 360);
    const t1 = r.app.debugState().ticks;
    r.ui.emit('rewind', { seconds: 5 });
    expect(r.app.debugState().ticks).toBe(t1 - 300);
  });

  it('holding R right after a practice crash rewinds out of the crash beat', () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    r.ui.emit('practice', { on: true });
    r.input.push(40);
    until(r, () => r.app.state() === 'CRASH_BEAT', 400);
    r.input.idle();
    const crashTicks = r.app.debugState().ticks;
    r.input.command('rewind');
    r.input.command('any'); // same key press: must not end anything
    expect(r.app.state()).toBe('RUNNING');
    expect(r.app.debugState().status).toBe(Status.Running);
    expect(r.app.debugState().ticks).toBe(Math.max(0, crashTicks - 300));
    r.app.advance(1 / 15);
    expect(r.app.state()).toBe('RUNNING');
    expect(r.renderer.lastFrame!.status).toBe(Status.Running);
  });
});

// ------------------------------------------------------------------------------------------------ menus

describe("Esc / 'pause' is 'back' in menus", () => {
  it("level select -> title, and the same key press's 'any' does not start the title again", () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('select', { from: 'title' });
    expect(r.app.state()).toBe('LEVEL_SELECT');
    r.input.command('pause');
    r.input.command('any');
    expect(r.app.state()).toBe('TITLE');
    r.app.advance(1 / 60);
    r.input.command('any'); // a later key press starts it as usual
    expect(r.app.state()).toBe('LEVEL_SELECT');
  });

  it('Esc (pause + any) and gamepad B (back + any) on the title do not start the game', () => {
    const r = rig({ store: cleared('1-1') });
    expect(r.app.state()).toBe('TITLE');
    r.input.command('pause');
    r.input.command('any');
    expect(r.app.state()).toBe('TITLE');
    r.app.advance(1 / 60);
    r.input.command('back');
    r.input.command('any');
    expect(r.app.state()).toBe('TITLE');
    r.app.advance(1 / 60);
    r.input.command('any'); // any other key does
    expect(r.app.state()).toBe('LEVEL_SELECT');
  });

  it('daily hub -> level select; briefing -> the level (briefed)', () => {
    const r = rig({ store: cleared('1-1', '1-2', '1-3'), data: dailyData('1-2'), api: new FakeApi() });
    r.ui.emit('openDaily');
    expect(r.app.state()).toBe('DAILY_HUB');
    r.input.command('pause');
    expect(r.app.state()).toBe('LEVEL_SELECT');
    r.store.d.levels['2-1'] = { ...emptyP(data.hash(L('2-1'))) };
    r.ui.emit('openLevel', '2-1');
    expect(r.app.state()).toBe('BRIEFING');
    r.input.command('pause');
    expect(r.app.state()).toBe('READY');
    expect(r.store.d.levels['2-1']!.briefed).toBe(true);
  });

  it("a UI sub-screen on top goes first: the UI's back() hook", () => {
    class BackUI extends FakeUI {
      backs = 0;
      open = true;
      back(): boolean {
        this.backs++;
        const was = this.open;
        this.open = false;
        return was;
      }
    }
    const ui = new BackUI();
    const r = rig({ store: cleared('1-1'), ui });
    r.ui.emit('select', { from: 'title' });
    r.input.command('pause'); // settings on top of the select: closes the settings only
    expect(ui.backs).toBe(1);
    expect(r.app.state()).toBe('LEVEL_SELECT');
    r.input.command('pause'); // nothing on top any more: back to the title
    expect(r.app.state()).toBe('TITLE');
  });

  it('without the hook, a synthetic Escape on the UI layer closes a sub-screen (focus was outside the layer)', () => {
    const root = document.createElement('div');
    const yp = document.createElement('div');
    yp.className = 'yp';
    const layer = document.createElement('div');
    layer.className = 'yp-layer';
    yp.appendChild(layer);
    root.appendChild(yp);
    const keys: string[] = [];
    layer.addEventListener('keydown', (e) => {
      keys.push(e.key);
      e.stopPropagation();
    });
    const r = rig({ store: cleared('1-1'), root });
    r.ui.emit('select', { from: 'title' });
    yp.dataset.screen = 'settings';
    r.input.command('pause');
    expect(keys).toEqual(['Escape']);
    expect(r.app.state()).toBe('LEVEL_SELECT');
    yp.dataset.screen = 'select';
    r.input.command('pause');
    expect(keys).toEqual(['Escape']);
    expect(r.app.state()).toBe('TITLE');
  });

  it("N on the results opens the next level's briefing and its 'any' does not skip the briefing", () => {
    const r = rig({ store: cleared('1-1', '1-2', '1-3') });
    r.ui.emit('openLevel', '1-4');
    r.input.target(-0.3); // start, then hang around off the pad until the time is up
    until(r, () => r.app.state() === 'RESULTS', 2000);
    expect(r.app.state()).toBe('RESULTS');
    r.input.command('next');
    r.input.command('any');
    expect(r.app.state()).toBe('BRIEFING');
    expect(r.app.debugState().level).toBe('2-1');
  });

  it('the ⏸ button during the crash beat ends it and opens the pause menu (like Esc)', () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    r.input.target(1.0); // carry the hanging ball into the knee-high fence
    until(r, () => r.app.state() === 'CRASH_BEAT', 2000);
    expect(r.app.state()).toBe('CRASH_BEAT');
    r.ui.emit('pause');
    expect(r.app.state()).toBe('PAUSED');
    r.ui.emit('resume');
    expect(r.app.state()).toBe('READY');
  });

  it('Esc and the ⏸ corner button (「面選択」 there) go from the results card to the level select', () => {
    for (const how of ['key', 'button'] as const) {
      const r = rig({ store: cleared('1-1', '1-2', '1-3') });
      r.ui.emit('openLevel', '1-4');
      r.input.target(-0.3);
      until(r, () => r.app.state() === 'RESULTS', 2000);
      expect(r.app.state()).toBe('RESULTS');
      if (how === 'key') {
        r.input.command('pause');
        r.input.command('any');
      } else {
        r.ui.emit('pause');
      }
      expect(r.app.state(), how).toBe('LEVEL_SELECT');
    }
  });
});

// ------------------------------------------------------------------------------------------------ select world

describe('level select page', () => {
  it('opens the highest unlocked world when the last played world is still locked (a #l= link)', () => {
    const r = rig({ store: cleared('1-1', '1-2', '1-3'), hash: '#l=5-4' });
    expect(r.app.debugState().level).toBe('5-4');
    r.ui.emit('select');
    expect(r.ui.last).toEqual({ id: 'select', world: 2 });
    r.ui.emit('openLevel', '1-3');
    r.ui.emit('select');
    expect(r.ui.last).toEqual({ id: 'select', world: 1 }); // the last played world when it is open
  });
});

// ------------------------------------------------------------------------------------------------ demo / attract

describe('the AI demo and the title attract are drawn as runs', () => {
  it('Running while the demo plays, Success once its hold completes (never the reset session\'s Ready)', () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    const resets = r.renderer.resets;
    r.ui.emit('demo');
    expect(r.app.state()).toBe('DEMO');
    expect(r.renderer.resets).toBe(resets + 1);
    const statuses: number[] = [];
    let maxHold = 0;
    r.app.advance(1 / 30);
    until(r, () => {
      if (r.app.state() !== 'DEMO') return true;
      statuses.push(r.renderer.lastFrame!.status);
      maxHold = Math.max(maxHold, r.renderer.lastFrame!.holdFrac);
      return false;
    }, 3000, 1 / 30);
    expect(statuses[0]).toBe(Status.Running);
    expect(statuses).not.toContain(Status.Ready);
    const firstSuccess = statuses.indexOf(Status.Success);
    expect(firstSuccess).toBeGreaterThan(10);
    expect(statuses.slice(firstSuccess).every((s) => s === Status.Success)).toBe(true);
    expect(maxHold).toBe(1);
    expect(r.app.state()).toBe('READY');
    r.app.advance(1 / 60);
    expect(r.renderer.lastFrame!.status).toBe(Status.Ready);
  });

  it('the demo clock stops at the AI time once the hold completes', () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    r.ui.emit('demo');
    const ai = data.track(L('1-2'), 'calm') ?? data.track(L('1-2'), 'ai')!;
    until(r, () => r.renderer.lastFrame?.status === Status.Success && r.app.state() === 'DEMO', 3000, 1 / 30);
    expect(r.ui.huds.at(-1)!.timeSub).toBe(ai.finishSub);
  });

  it('the title attract loops as Running -> Success with a fresh trail each loop', () => {
    const r = rig();
    const ai = data.track(L('2-2'), 'ai')!;
    r.app.advance(0.1);
    expect(r.renderer.lastFrame!.status).toBe(Status.Running);
    const resets = r.renderer.resets;
    const statuses = new Set<number>();
    for (let i = 0; i < Math.ceil((ai.n / 60 + 3) * 10); i++) {
      r.app.advance(0.1);
      statuses.add(r.renderer.lastFrame!.status);
    }
    expect([...statuses].sort()).toEqual([Status.Running, Status.Success]);
    expect(r.renderer.resets).toBeGreaterThan(resets);
  });

  it('showStatus / showHoldFrac follow finishSub + the 0.5 s hold', () => {
    const tr = data.track(L('2-2'), 'ai')!;
    const fin = tr.finishSub! / 120;
    expect(showStatus(tr, 0)).toBe(Status.Running);
    expect(showStatus(tr, fin + 0.49)).toBe(Status.Running);
    expect(showStatus(tr, fin + 0.5)).toBe(Status.Success);
    expect(showHoldFrac(tr, fin - 0.1)).toBe(0);
    expect(showHoldFrac(tr, fin + 0.25)).toBeCloseTo(0.5, 6);
    expect(showHoldFrac(tr, fin + 2)).toBe(1);
    const open = { ...tr, finishSub: null };
    expect(showStatus(open, (tr.n - 1) / 60 - 0.01)).toBe(Status.Running);
    expect(showStatus(open, (tr.n - 1) / 60 + 0.01)).toBe(Status.Success);
  });
});

// ------------------------------------------------------------------------------------------------ renderer extras

describe('renderer extras and labels (D8, settings, daily label)', () => {
  it('setAiMarginMm after every loadLevel: summary aiMarginMm, else LevelDef.ai.marginMm, else 20', () => {
    const r = rig();
    expect(r.renderer.loaded).toEqual(['2-2']);
    expect(r.renderer.margins).toEqual([20]);
    const src = bundledSources();
    const custom = createGameData({ ...src, summary: { format: 1, levels: { ...src.summary.levels, '2-2': { ...src.summary.levels['2-2']!, aiMarginMm: 35 } } } });
    const r2 = rig({ data: custom });
    expect(r2.renderer.margins).toEqual([35]);
    const dd = dailyData('1-2', 28);
    const today = pickDaily(dd.dailyPool, NOW).level;
    expect(aiMarginMmOf(today, dd)).toBe(28);
    expect(aiMarginMmOf(L('1-2'), { summaryOf: () => null })).toBe(20);
    expect(aiMarginMmOf(L('1-2'), { summaryOf: () => ({ parSub: 1, peakF: 1, minGapMm: 1, pumps: 0, aiMarginMm: -3 }) })).toBe(20);
  });

  it('settings apply to the renderer without a reload, once per change', () => {
    const r = rig();
    expect(r.renderer.initOpts).toEqual({ quality: 'auto', reducedMotion: false });
    expect(r.renderer.options).toEqual([]);
    r.ui.emit('settingsChanged', { quality: 'low' });
    expect(r.renderer.options).toEqual([{ quality: 'low', reducedMotion: false }]);
    r.ui.emit('settingsChanged', { volume: 50 });
    expect(r.renderer.options).toHaveLength(1);
    r.ui.emit('settingsChanged', { motion: 'off' });
    expect(r.renderer.options.at(-1)).toEqual({ quality: 'low', reducedMotion: true });
  });

  it("levelLoaded carries a human label: the id, or 「#N」 for today's daily (never 'd:16')", () => {
    const r = rig();
    expect(fxOf(r, 'levelLoaded').at(-1)!.label).toBe('2-2');
    const dd = dailyData('1-2');
    const r2 = rig({ data: dd, store: cleared('1-1', '1-2'), api: new FakeApi() });
    r2.ui.emit('openDaily');
    r2.ui.emit('openLevel', pickDaily(dd.dailyPool, NOW).level.id);
    const ev = fxOf(r2, 'levelLoaded').at(-1)!;
    expect(ev.level.world).toBe(0);
    expect(ev.label).toBe('#11');
    const other = dd.dailyPool.find((l) => l.id !== pickDaily(dd.dailyPool, NOW).level.id)!;
    r2.app.command(`openLevel:${other.id}`);
    expect(fxOf(r2, 'levelLoaded').at(-1)!.label).toBe('ハードル × ふつう');
  });
});

// ------------------------------------------------------------------------------------------------ audio (D7)

describe('audio.update gets the sim time scale (D7)', () => {
  it('1 normally, 0.5 in practice', () => {
    const r = rig({ store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    r.app.advance(1 / 60);
    expect(r.audio.updates.at(-1)).toMatchObject({ timeScale: 1 });
    r.ui.emit('practice', { on: true });
    r.app.advance(1 / 60);
    expect(r.audio.updates.at(-1)).toMatchObject({ timeScale: 0.5 });
  });
});

// ------------------------------------------------------------------------------------------------ net / store

describe('offline chip, storage notice, leaving the page', () => {
  it('no 「オフライン」 while the first boot is still on its way', () => {
    const api = new FakeApi();
    api.enabled = false;
    api.booting = true;
    const r = rig({ api, store: cleared('1-1') });
    r.ui.emit('openLevel', '1-2');
    r.app.advance(1 / 60);
    expect(r.ui.huds.at(-1)!.offline).toBe(false);
    expect(r.app.debugState().offline).toBe(false);
    api.booting = false;
    r.app.advance(1 / 60);
    expect(r.ui.huds.at(-1)!.offline).toBe(true);
    api.enabled = true;
    r.app.advance(1 / 60);
    expect(r.ui.huds.at(-1)!.offline).toBe(false);
  });

  it('a save that fails later (after a results screen) is announced once, never mid-run', () => {
    class FailingStore extends MemStore {
      failed = false;
      taken = false;
      takeStorageNotice(): boolean {
        if (!this.failed || this.taken) return false;
        this.taken = true;
        return true;
      }
    }
    const store = new FailingStore();
    store.d.levels['1-1'] = { ...emptyP(data.hash(L('1-1'))), cleared: true };
    const r = rig({ store });
    r.ui.emit('openLevel', '1-2');
    r.input.target(0.3);
    until(r, () => r.app.state() === 'RUNNING');
    store.failed = true;
    r.app.advance(1 / 15);
    const warn = t('toast.storage' as 'toast.storage', undefined, 'ja');
    expect(r.ui.toasts.filter((x) => x.text === warn)).toEqual([]);
    r.input.command('retry');
    r.app.advance(1 / 60);
    expect(r.ui.toasts.filter((x) => x.text === warn)).toEqual([{ text: warn, kind: 'warn' }]);
    r.app.advance(1 / 60);
    expect(r.ui.toasts.filter((x) => x.text === warn)).toHaveLength(1);
  });

  it('a hidden tab pauses the run and sends the daily / outbox once (pagehide right after does not repeat it)', () => {
    const api = new FakeApi();
    const dd = dailyData('1-2');
    const r = rig({ api, data: dd, store: cleared('1-1', '1-2') });
    r.ui.emit('openDaily');
    r.ui.emit('openLevel', pickDaily(dd.dailyPool, NOW).level.id);
    r.input.target(0.3);
    until(r, () => r.app.state() === 'RUNNING');
    const setVis = (v: 'hidden' | 'visible'): void => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      const flushes = r.store.flushes;
      setVis('hidden');
      expect(r.app.state()).toBe('PAUSED');
      expect(api.flushes.filter((x) => x === 'pagehide')).toHaveLength(1);
      expect(api.queued.at(-1)).toMatchObject({ level: expect.stringMatching(/^d:/), tries: 1 });
      expect(r.store.flushes).toBe(flushes + 1);
      window.dispatchEvent(new Event('pagehide'));
      expect(api.flushes.filter((x) => x === 'pagehide')).toHaveLength(1);
      setVis('visible');
      window.dispatchEvent(new Event('pagehide')); // desktop close after coming back
      expect(api.flushes.filter((x) => x === 'pagehide')).toHaveLength(2);
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
  });
});
