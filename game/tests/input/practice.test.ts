// Practice mode input (GAME_DESIGN.md §3.5, lead decision D3): R long press = 'rewind', short press =
// 'retry' on key-up; and the re-anchoring of the hold point after any practice rewind. Owner: O4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_RAMP, KEY_TAP, REWIND_KEY, createKeyboardSource, type KeyboardSource } from '../../src/input/keyboard';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import type { Command } from '../../src/input/types';
import type { SimState } from '../../src/sim/run';
import { level, restState } from './plant';
import { box, key, layoutTall, ptr } from './helpers';

describe('keyboard R in practice mode (D3)', () => {
  let kb: KeyboardSource;
  let cmds: Command[];
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    kb = createKeyboardSource(window);
    cmds = [];
    kb.onCommand((c) => cmds.push(c));
  });
  afterEach(() => {
    kb.dispose();
    vi.useRealTimers();
  });

  it('outside practice R retries on key-down, and holding it never rewinds', () => {
    expect(kb.practice()).toBe(false);
    key('keydown', 'KeyR');
    expect(cmds).toEqual(['retry', 'any']);
    vi.advanceTimersByTime(2000);
    key('keyup', 'KeyR');
    expect(cmds).toEqual(['retry', 'any']);
  });

  it('short press: nothing on key-down, retry + any on key-up (also at 299 ms)', () => {
    kb.setPractice(true);
    expect(key('keydown', 'KeyR').defaultPrevented).toBe(true);
    expect(cmds).toEqual([]);
    vi.advanceTimersByTime(80);
    key('keyup', 'KeyR');
    expect(cmds).toEqual(['retry', 'any']);
    cmds = [];
    key('keydown', 'KeyR');
    vi.advanceTimersByTime(REWIND_KEY.holdMs - 1);
    key('keyup', 'KeyR');
    expect(cmds).toEqual(['retry', 'any']);
    vi.advanceTimersByTime(2000); // no timer left behind
    expect(cmds).toEqual(['retry', 'any']);
  });

  it('held ≥ 300 ms: rewind + any, then rewind every 300 ms while held; never retry', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    vi.advanceTimersByTime(REWIND_KEY.holdMs - 1);
    expect(cmds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(cmds).toEqual(['rewind', 'any']);
    vi.advanceTimersByTime(REWIND_KEY.repeatMs);
    expect(cmds).toEqual(['rewind', 'any', 'rewind']);
    vi.advanceTimersByTime(2 * REWIND_KEY.repeatMs + 100);
    expect(cmds).toEqual(['rewind', 'any', 'rewind', 'rewind', 'rewind']);
    key('keyup', 'KeyR');
    vi.advanceTimersByTime(2000);
    expect(cmds).toEqual(['rewind', 'any', 'rewind', 'rewind', 'rewind']);
  });

  it('auto-repeat key-downs while R is held do not restart the timing', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    for (let t = 0; t < 9; t++) {
      vi.advanceTimersByTime(33);
      key('keydown', 'KeyR', { repeat: true });
    }
    vi.advanceTimersByTime(REWIND_KEY.holdMs - 9 * 33);
    expect(cmds).toEqual(['rewind', 'any']);
    key('keyup', 'KeyR');
  });

  it('Backspace stays an immediate retry in practice', () => {
    kb.setPractice(true);
    key('keydown', 'Backspace');
    expect(cmds).toEqual(['retry', 'any']);
    vi.advanceTimersByTime(1000);
    key('keyup', 'Backspace');
    expect(cmds).toEqual(['retry', 'any']);
  });

  it('other keys are unchanged in practice (movement, commands)', () => {
    kb.setPractice(true);
    key('keydown', 'KeyG');
    key('keydown', 'Escape');
    key('keydown', 'ArrowRight');
    expect(cmds).toEqual(['ghostCycle', 'any', 'pause', 'any', 'any']);
    expect(kb.dir()).toBe(1);
  });

  it('works with Shift held, under an IME and on a non-Latin layout (physical R)', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR', { shift: true });
    key('keyup', 'KeyR', { shift: true });
    key('keydown', 'KeyR', { key: 'Process' });
    key('keyup', 'KeyR', { key: 'r' });
    key('keydown', 'KeyR', { key: 'к' });
    vi.advanceTimersByTime(REWIND_KEY.holdMs);
    key('keyup', 'KeyR', { key: 'к' });
    expect(cmds).toEqual(['retry', 'any', 'retry', 'any', 'rewind', 'any']);
  });

  it('only the R key ends the timed press (other key-ups do not)', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    key('keydown', 'ArrowLeft');
    key('keyup', 'ArrowLeft');
    expect(cmds).toEqual(['any']); // the arrow's own "any"
    vi.advanceTimersByTime(REWIND_KEY.holdMs);
    expect(cmds).toEqual(['any', 'rewind', 'any']);
    key('keyup', 'KeyR');
  });

  it('window blur while R is down drops the press: no retry, no rewind', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(1000);
    key('keyup', 'KeyR');
    expect(cmds).toEqual([]);
  });

  it('leaving practice while R is down cancels the press; afterwards R is an immediate retry again', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    kb.setPractice(false);
    vi.advanceTimersByTime(1000);
    key('keyup', 'KeyR');
    expect(cmds).toEqual([]);
    key('keydown', 'KeyR');
    expect(cmds).toEqual(['retry', 'any']);
  });

  it('a listener that leaves practice on the first rewind stops the repeats', () => {
    kb.setPractice(true);
    kb.onCommand((c) => {
      if (c === 'rewind') kb.setPractice(false);
    });
    key('keydown', 'KeyR');
    vi.advanceTimersByTime(5 * REWIND_KEY.repeatMs);
    key('keyup', 'KeyR');
    expect(cmds).toEqual(['rewind', 'any']); // this press's 'any' still follows its command, then nothing
  });

  it('a second fresh R press whose previous key-up was lost restarts the timing', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    vi.advanceTimersByTime(200);
    key('keydown', 'KeyR'); // not a repeat: the first key-up never arrived
    vi.advanceTimersByTime(200);
    expect(cmds).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(cmds).toEqual(['rewind', 'any']);
    key('keyup', 'KeyR');
  });

  it('dispose while R is held leaves no timer behind', () => {
    kb.setPractice(true);
    key('keydown', 'KeyR');
    kb.dispose();
    vi.advanceTimersByTime(2000);
    expect(cmds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    kb = createKeyboardSource(window); // for afterEach
  });

  it('typing R into a form field is ignored in practice too', () => {
    kb.setPractice(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    key('keydown', 'KeyR', {}, input);
    vi.advanceTimersByTime(1000);
    key('keyup', 'KeyR', {}, input);
    expect(cmds).toEqual([]);
  });
});

describe('InputManager.setPractice (D3)', () => {
  let m: InputManagerImpl;
  let cmds: Command[];
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    m = createInputManager({ getPads: () => [] });
    cmds = [];
    m.onCommand((c) => cmds.push(c));
    m.setLevel(level());
    m.resetForRun(0);
  });
  afterEach(() => {
    m.dispose();
    vi.useRealTimers();
  });

  it('forwards practice to the keyboard: R long press reaches onCommand as rewind', () => {
    m.setPractice(true);
    expect(m.debug().practice).toBe(true);
    key('keydown', 'KeyR');
    vi.advanceTimersByTime(REWIND_KEY.holdMs);
    key('keyup', 'KeyR');
    expect(cmds).toEqual(['rewind', 'any']);
    m.setPractice(false);
    expect(m.debug().practice).toBe(false);
    key('keydown', 'KeyR');
    expect(cmds).toEqual(['rewind', 'any', 'retry', 'any']);
  });

  it('practice survives resetForRun (a short-press retry keeps the next R timed)', () => {
    m.setPractice(true);
    key('keydown', 'KeyR');
    key('keyup', 'KeyR');
    m.resetForRun(0);
    key('keydown', 'KeyR');
    expect(cmds).toEqual(['retry', 'any']);
    key('keyup', 'KeyR');
    expect(cmds).toEqual(['retry', 'any', 'retry', 'any']);
  });

  it('window blur (via the manager) drops a timed R press', () => {
    m.setPractice(true);
    key('keydown', 'KeyR');
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(1000);
    expect(cmds).toEqual([]);
  });
});

/** A state at trolley x / velocity v and a substep counter (the manager reads x, v and substep). */
function at(x: number, v: number, substep: number): SimState {
  const s = restState(x);
  s.v = v;
  s.substep = substep;
  return s;
}

describe('re-anchoring after a practice rewind (§3.5)', () => {
  let m: InputManagerImpl;
  beforeEach(() => {
    document.body.innerHTML = '';
    m = createInputManager({ getPads: () => [] });
    m.setLevel(level({ rail: [-1, 4] }));
    m.resetForRun(0);
  });
  afterEach(() => m.dispose());

  function deck(): { el: HTMLElement; y: number } {
    const L = layoutTall();
    const sc = box(0, 0, 390, L.scene.h);
    const el = box(0, L.scene.h, 390, L.deck!.h);
    m.attach(sc, el, { screenToRailX: () => null }, L);
    return { el, y: L.scene.h + 100 };
  }

  it('keyboard hold: the hold point jumps to the restored x (not the stale stop point)', () => {
    key('keydown', 'ArrowRight');
    m.sample(at(0, 0, 0)); // a tap from rest (R10): hold point 0.05
    key('keyup', 'ArrowRight');
    m.sample(at(0.01, 0, 2));
    expect(m.sample(at(2.5, 0, 600))).toMatchObject({ intent: { kind: 'idle' }, targetX: 0.05 });
    // rewind: the restored state is older (smaller substep) and the trolley stands at 1.2
    const f = m.sample(at(1.2, 0, 300));
    expect(f).toMatchObject({ intent: { kind: 'idle' }, targetX: 1.2, device: 3 });
    expect(m.debug().latching).toBe(false);
    expect(m.sample(at(1.21, 0, 302)).targetX).toBe(1.2); // and holds there
  });

  it('a trolley restored mid-motion is latched: the hold point follows it until it has braked', () => {
    key('keydown', 'ArrowRight');
    m.sample(at(0, 0, 0));
    key('keyup', 'ArrowRight');
    m.sample(at(0, 0, 2));
    m.sample(at(0, 0, 900));
    expect(m.sample(at(1.0, 2.0, 400)).targetX).toBe(1.0);
    expect(m.debug().latching).toBe(true);
    expect(m.sample(at(1.03, 1.5, 402)).targetX).toBe(1.03);
    expect(m.sample(at(1.05, 0.02, 404)).targetX).toBe(1.03); // at rest: latch ends, holds
    expect(m.debug().latching).toBe(false);
  });

  it('a restored trolley that only moves with the swing tug (< 0.3 m/s) is held at the restored x exactly', () => {
    key('keydown', 'ArrowRight');
    m.sample(at(0, 0, 0));
    key('keyup', 'ArrowRight');
    m.sample(at(0, 0, 2));
    m.sample(at(0, 0, 900));
    expect(m.sample(at(0.8, 0.2, 400)).targetX).toBe(0.8);
    expect(m.debug().latching).toBe(false);
    expect(m.sample(at(0.83, 0.2, 402)).targetX).toBe(0.8);
  });

  it('pointer target: the target moves to the restored x, then idles after 15 unchanged ticks', () => {
    const { el, y } = deck();
    ptr(el, 'pointerdown', 100, y);
    ptr(el, 'pointermove', 178, y); // +78 px = +1.0 m (390 px span the 5 m rail)
    ptr(el, 'pointerup', 178, y);
    for (let t = 0; t < 30; t++) m.sample(at(0, 0, 2 * t));
    expect(m.sample(at(1.4, 0, 60))).toMatchObject({ intent: { kind: 'idle' } });
    const f = m.sample(at(0.4, 0, 20));
    expect(f).toMatchObject({ intent: { kind: 'target', x: 0.4 }, targetX: 0.4, device: 1 });
    const kinds: string[] = [];
    for (let t = 0; t < 16; t++) kinds.push(m.sample(at(0.4, 0, 22 + 2 * t)).intent.kind);
    expect(kinds.at(-1)).toBe('idle');
    expect(kinds.filter((k) => k === 'target').length).toBe(14);
  });

  it('a finger still down keeps steering, relative to the restored x (no jump back)', () => {
    const { el, y } = deck();
    ptr(el, 'pointerdown', 100, y);
    ptr(el, 'pointermove', 178, y); // +78 px = +1.0 m
    const before = m.sample(at(0, 0, 10)).targetX as number;
    expect(before).toBeGreaterThan(0.9);
    expect(m.sample(at(0.3, 1.2, 4)).targetX).toBe(0.3); // rewound while the finger rests
    expect(m.debug().latching).toBe(false); // no latch under a finger
    ptr(el, 'pointermove', 217, y); // +39 px from the finger's current spot = +0.5 m
    expect(m.sample(at(0.3, 1.2, 6)).targetX).toBeCloseTo(0.8, 12);
  });

  it('a held arrow keeps driving through a rewind', () => {
    key('keydown', 'ArrowRight');
    const n = KEY_TAP.windowTicks + KEY_RAMP.cap / KEY_RAMP.up + 3; // tap window (7 ticks), then 20 ticks of ramp to 4.0
    for (let t = 0; t < n; t++) m.sample(at(0, 0, 2 * t));
    const f = m.sample(at(0.5, 1, 4));
    expect(f.intent).toEqual({ kind: 'velocity', v: 4 });
    expect(f.targetX).toBeNull();
    key('keyup', 'ArrowRight');
  });

  it('direct force mode holds nothing after a rewind (F = 0)', () => {
    m.setKeyboardMode('force');
    key('keydown', 'ArrowRight');
    m.sample(at(0, 0, 0));
    key('keyup', 'ArrowRight');
    m.sample(at(0, 0, 200));
    const f = m.sample(at(0.5, 1, 100));
    expect(f).toMatchObject({ intent: { kind: 'force', f: 0 }, targetX: null });
  });

  it('a new run (resetForRun) is not mistaken for a rewind', () => {
    key('keydown', 'ArrowRight');
    m.sample(at(0, 0, 0));
    key('keyup', 'ArrowRight');
    m.sample(at(0.5, 0, 500));
    m.resetForRun(0);
    expect(m.sample(at(0, 0, 0))).toEqual({ intent: { kind: 'idle' }, fine: false, device: 0, targetX: null });
  });

  it('a state without a usable substep counter never triggers a rewind', () => {
    key('keydown', 'ArrowRight');
    m.sample(at(0, 0, 0)); // a tap: hold point 0.05
    key('keyup', 'ArrowRight');
    m.sample(at(0.2, 0, 2));
    expect(m.sample(at(0.9, 0, NaN)).targetX).toBe(0.05);
    expect(m.sample(at(0.9, 0, 4)).targetX).toBe(0.05);
  });
});
