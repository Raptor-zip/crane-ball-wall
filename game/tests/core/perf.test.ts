// @vitest-environment happy-dom
// Core frame cost (GAME_DESIGN.md §9.7: JS + draw <= 10 ms per frame; the core's share must stay small). Owner: O3.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/core/app';
import { createGameData } from '../../src/core/data';
import { DAILY_EPOCH, DAY_MS } from '../../src/shared/daily';
import { FakeApi, FakeInput, FakeRenderer, FakeUI, MemStore } from './fakes';

describe('core frame cost', () => {
  it('a 2-2 run with 3 ghosts costs well under 1 ms of core time per 60 Hz frame', () => {
    const data = createGameData();
    const store = new MemStore();
    for (const id of ['1-1', '1-2', '1-3', '1-4', '2-1']) {
      store.d.levels[id] = {
        hash: data.hash(data.level(id)!), cleared: true, skipped: false, attempts: 1, fails: 0, consecutiveCrashes: 0, bestSub: null,
        bestReplay: null, medal: 0, crown: false, badges: [], hintsSeen: 0, briefed: true, demoShown: false, aiBeatenSent: false,
      };
    }
    const ui = new FakeUI();
    const renderer = new FakeRenderer();
    renderer.draw = () => {}; // measure the core, not the fake's copying
    const input = new FakeInput();
    const app = createApp(document.createElement('div'), {
      ui, renderer, input, store, api: new FakeApi(), audio: null, haptics: null, data, autoStart: false,
      now: () => DAILY_EPOCH + 3 * DAY_MS, location: null, prefersReducedMotion: () => false,
    });
    app.command('openLevel:2-2');
    app.command('ghostCycle'); // AI only
    app.command('ghostCycle'); // research set: AI + 2 research ghosts = 3 ghosts
    expect(app.debugState().ghosts.length).toBe(3);
    input.target(0.5); // swing in front of wall A: a long run without a crash
    const frames = 600;
    for (let i = 0; i < 30; i++) app.advance(1 / 60); // warm up
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      if (i === 300) input.target(0.2);
      app.advance(1 / 60);
    }
    const perFrame = (performance.now() - t0) / frames;
    expect(app.state(), JSON.stringify(app.debugState().last)).toBe('RUNNING');
    expect(app.debugState().ticks, JSON.stringify([app.debugState().last, ui.fxs.filter((e) => e.t === 'crash' || e.t === 'retry' || e.t === 'timeout').slice(0, 5)])).toBeGreaterThan(600);
    console.log(`core frame cost: ${perFrame.toFixed(3)} ms`);
    expect(perFrame).toBeLessThan(2);
  });
});
