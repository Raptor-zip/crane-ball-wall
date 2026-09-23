// Keyboard ramps, key taps (R10), fragile-cargo caps (R10), direct force and the §3.3 command table. Owner: O4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_RAMP, KEY_TAP, SpeedRamp, createKeyboardSource, type KeyboardSource } from '../../src/input/keyboard';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import { FRAGILE, servoVcmd, speedCap } from '../../src/input/servo';
import type { Command, InputFrame, Intent } from '../../src/input/types';
import { level, restState } from './plant';
import { box, fakePad, key, layoutTall, ptr } from './helpers';

describe('SpeedRamp (§3.3, Appendix A)', () => {
  const run = (r: SpeedRamp, dir: -1 | 0 | 1, fine: boolean, n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(r.step(dir, fine));
    return out;
  };

  // Command after each of the first n ticks of a ramp from rest (units of 0.1 m/s -> m/s), up to cap.
  const ramp = (n: number, step: number = KEY_RAMP.up, cap: number = KEY_RAMP.cap): number[] =>
    Array.from({ length: n }, (_, i) => Math.min(cap, (i + 1) * step) / KEY_RAMP.perMps);
  const FULL = KEY_RAMP.cap / KEY_RAMP.up; // ticks from rest to full speed (20)

  it('0.2 m/s per tick up (20 ticks to 4.0), 0.8 down (5 ticks to 0)', () => {
    expect(FULL).toBe(20);
    const r = new SpeedRamp();
    const up = run(r, 1, false, FULL + 1);
    expect(up.slice(0, 5)).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    expect(up).toEqual(ramp(FULL + 1));
    expect(up[FULL - 2]).toBe(3.8);
    expect(up.slice(FULL - 1)).toEqual([4, 4]);
    expect(run(r, 0, false, 6)).toEqual([3.2, 2.4, 1.6, 0.8, 0, 0]);
    expect(run(r, -1, false, FULL)[FULL - 1]).toBe(-4);
  });

  it('opposite key: brakes to 0 at 0.8 per tick, then ramps up the other way', () => {
    const r = new SpeedRamp();
    run(r, 1, false, FULL);
    const rev = run(r, -1, false, 5 + FULL);
    expect(rev.slice(0, 5)).toEqual([3.2, 2.4, 1.6, 0.8, 0]);
    expect(rev.slice(5, 8)).toEqual([-0.2, -0.4, -0.6]);
    expect(rev.slice(5)).toEqual(ramp(FULL).map((v) => -v));
  });

  it('fine: cap 0.5 (R10), 0.2 per tick up; switching fine on at speed comes down at 0.8 per tick', () => {
    const r = new SpeedRamp();
    expect(run(r, -1, true, 5)).toEqual([-0.2, -0.4, -0.5, -0.5, -0.5]);
    const q = new SpeedRamp();
    run(q, 1, false, FULL);
    expect(run(q, 1, true, 6)).toEqual([3.2, 2.4, 1.6, 0.8, 0.5, 0.5]);
  });

  it('setCaps: egg levels cap at 2.0 (10 ticks), a lowered cap brings a faster command down at the brake rate', () => {
    const r = new SpeedRamp();
    r.setCaps(2.0, 0.5);
    expect(run(r, 1, false, 11)).toEqual([0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2]);
    expect(run(r, 1, true, 3)).toEqual([1.2, 0.5, 0.5]);
    const q = new SpeedRamp();
    run(q, 1, false, FULL);
    q.setCaps(2.0, 0.5);
    expect(run(q, 1, false, 4)).toEqual([3.2, 2.4, 2, 2]);
    q.setCaps(NaN, -1); // nonsense falls back to the defaults
    expect([q.cap, q.capFine]).toEqual([40, 5]);
  });

  it('seed: a delayed ramp continues from the trolley speed (floored to 0.1 m/s, never against it, at most the cap)', () => {
    const r = new SpeedRamp();
    r.seed(1, 0.27, false);
    expect(r.u).toBe(2);
    expect(r.step(1, false)).toBe(0.4); // 0.2 + one 0.2 step
    r.seed(-1, 0.27, false); // moving the other way: from 0
    expect(r.u).toBe(0);
    r.seed(-1, -9, true);
    expect(r.u).toBe(-5);
    r.seed(0, 3, false);
    expect(r.u).toBe(-5); // no direction: unchanged
    r.seed(1, NaN, false);
    expect(r.u).toBe(-5);
  });

  it('a short tap brakes within one tick', () => {
    const r = new SpeedRamp();
    expect(run(r, 1, false, 1)).toEqual([0.2]);
    expect(run(r, 0, false, 1)).toEqual([0]);
  });
});

describe('keyboard source', () => {
  let kb: KeyboardSource;
  let cmds: Command[];
  beforeEach(() => {
    document.body.innerHTML = '';
    kb = createKeyboardSource(window);
    cmds = [];
    kb.onCommand((c) => cmds.push(c));
  });
  afterEach(() => kb.dispose());

  it('maps the §3.3 key table to commands, each followed by any', () => {
    const table: [string, Command, boolean?][] = [
      ['KeyR', 'retry'], ['Backspace', 'retry'], ['Enter', 'confirm'], ['Space', 'confirm'], ['KeyN', 'next'],
      ['Escape', 'pause'], ['KeyP', 'pause'], ['KeyG', 'ghostCycle'], ['KeyH', 'aiLine'], ['F1', 'notes'],
      ['Slash', 'notes', true], ['KeyM', 'mute'],
    ];
    for (const [code, want, shift] of table) {
      cmds = [];
      key('keydown', code, { shift });
      key('keyup', code, { shift });
      expect(cmds, code).toEqual([want, 'any']);
    }
  });

  it('prevents the browser default for game keys (scroll, back, help, quick find) but not for Escape', () => {
    expect(key('keydown', 'Space').defaultPrevented).toBe(true);
    expect(key('keydown', 'Backspace').defaultPrevented).toBe(true);
    expect(key('keydown', 'ArrowRight').defaultPrevented).toBe(true);
    expect(key('keydown', 'F1').defaultPrevented).toBe(true);
    expect(key('keydown', 'Slash', { shift: true }).defaultPrevented).toBe(true);
    expect(key('keydown', 'Escape').defaultPrevented).toBe(false);
  });

  it('keeps the scrolling default of Space / ←→ inside a UI panel that can scroll (notes, level pager)', () => {
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    panel.style.overflowX = 'auto';
    Object.defineProperty(panel, 'scrollHeight', { value: 900 });
    Object.defineProperty(panel, 'clientHeight', { value: 400 });
    Object.defineProperty(panel, 'scrollWidth', { value: 1200 });
    Object.defineProperty(panel, 'clientWidth', { value: 390 });
    const item = document.createElement('p');
    item.tabIndex = 0;
    panel.appendChild(item);
    document.body.appendChild(panel);
    expect(key('keydown', 'Space', {}, item).defaultPrevented).toBe(false);
    expect(key('keydown', 'ArrowRight', {}, item).defaultPrevented).toBe(false);
    expect(cmds).toEqual(['confirm', 'any', 'any']); // still reported to the game
    key('keyup', 'ArrowRight', {}, item);
    panel.style.overflowY = 'hidden'; // a panel that does not scroll: the game keeps the key
    expect(key('keydown', 'Space', {}, item).defaultPrevented).toBe(true);
  });

  it('ignores auto-repeat, browser shortcuts and typing into form fields', () => {
    key('keydown', 'KeyR', { repeat: true });
    key('keydown', 'KeyR', { ctrl: true }); // Ctrl+R reloads, it is not a retry
    const input = document.createElement('input');
    document.body.appendChild(input);
    key('keydown', 'KeyR', {}, input);
    key('keydown', 'ArrowLeft', {}, input);
    expect(cmds).toEqual([]);
    expect(kb.dir()).toBe(0);
  });

  it('Enter / Space on a focused button are left to the browser (it clicks the button)', () => {
    const b = document.createElement('button');
    document.body.appendChild(b);
    key('keydown', 'Enter', {}, b);
    key('keydown', 'Space', {}, b);
    expect(cmds).toEqual([]);
    key('keydown', 'KeyR', {}, b); // other commands still work
    expect(cmds).toEqual(['retry', 'any']);
  });

  it('works under a Japanese IME (key = "Process") through the physical key', () => {
    key('keydown', 'KeyN', { key: 'Process' });
    expect(cmds).toEqual(['next', 'any']);
  });

  it('letters follow the layout; the physical key is used only when the layout gives no Latin letter', () => {
    key('keydown', 'KeyR', { key: 'к' }); // Russian layout: physical R -> retry
    key('keydown', 'KeyM', { key: ',' }); // AZERTY: the ',' key sits on physical KeyM -> not mute
    key('keydown', 'Semicolon', { key: 'm' }); // AZERTY 'm' -> mute
    key('keydown', 'KeyM', { key: '?', shift: true }); // AZERTY '?' (Shift + ',') -> notes
    expect(cmds).toEqual(['retry', 'any', 'any', 'mute', 'any', 'notes', 'any']);
  });

  it('numpad arrows (NumLock off) move like the arrow keys', () => {
    key('keydown', 'Numpad4', { key: 'ArrowLeft' });
    expect(kb.dir()).toBe(-1);
    key('keyup', 'Numpad4', { key: 'ArrowLeft' });
    expect(kb.dir()).toBe(0);
    key('keydown', 'Numpad6', { key: 'ArrowRight' });
    expect(kb.dir()).toBe(1);
    key('keydown', 'Numpad6', { key: '6' }); // NumLock on: a digit, not a move (and no stuck key)
    key('keyup', 'Numpad6', { key: 'ArrowRight' });
    expect(kb.dir()).toBe(0);
  });

  it('Shift held with the arrow (real modifier state) is fine mode; releasing Shift leaves it', () => {
    key('keydown', 'ShiftLeft');
    key('keydown', 'ArrowRight', { shift: true });
    expect(kb.tick(40)).toMatchObject({ engaged: true, v: 0.2, fine: true });
    key('keyup', 'ShiftLeft');
    expect(kb.tick(40)).toMatchObject({ v: 0.4, fine: false }); // back to the normal ramp (0.2 per tick, cap 4.0)
    expect(kb.tick(40)).toMatchObject({ v: 0.6, fine: false }); // past the fine cap 0.5
  });

  it('without the rest flag (the default) a press ramps at once and reports no taps', () => {
    key('keydown', 'ArrowRight');
    expect(kb.tick(40)).toEqual({ engaged: true, v: 0.2, f: 0, fine: false, step: 0, stepping: false, snap: false });
    key('keyup', 'ArrowRight');
    expect(kb.tick(40)).toMatchObject({ engaged: false, v: 0, step: 0, snap: false });
  });

  it('bare modifiers do not count as "any input"', () => {
    key('keydown', 'ShiftLeft');
    key('keydown', 'Tab');
    expect(cmds).toEqual([]);
    key('keydown', 'KeyQ');
    expect(cmds).toEqual(['any']);
  });

  it('the most recently pressed direction wins; releasing it falls back to the other', () => {
    key('keydown', 'ArrowLeft');
    key('keydown', 'KeyD');
    expect(kb.dir()).toBe(1);
    key('keyup', 'KeyD');
    expect(kb.dir()).toBe(-1);
    key('keyup', 'ArrowLeft');
    expect(kb.dir()).toBe(0);
  });

  it('window blur releases held keys (no stuck arrow after alt-tab)', () => {
    key('keydown', 'ArrowRight');
    key('keydown', 'ShiftLeft');
    window.dispatchEvent(new Event('blur'));
    expect(kb.dir()).toBe(0);
    expect(kb.fineHeld()).toBe(false);
  });

  it('direct force mode: ±Fmax, Shift ±0.25 Fmax, 0 when released (no taps)', () => {
    kb.setMode('force');
    expect(kb.tick(40, true, 0)).toEqual({ engaged: false, v: 0, f: 0, fine: false, step: 0, stepping: false, snap: false });
    key('keydown', 'ArrowLeft');
    expect(kb.tick(40).f).toBe(-40);
    key('keydown', 'ShiftLeft');
    expect(kb.tick(40)).toMatchObject({ engaged: true, f: -10, fine: true });
    key('keyup', 'ShiftLeft');
    key('keyup', 'ArrowLeft');
    expect(kb.tick(40, true, 0)).toMatchObject({ engaged: false, f: 0, step: 0 });
    key('keydown', 'ArrowRight'); // a quick press in force mode is a force pulse, not a tap
    key('keyup', 'ArrowRight');
    expect(kb.tick(40, true, 0)).toMatchObject({ engaged: false, f: 0, step: 0 });
  });
});

describe('keyboard through the manager', () => {
  let m: InputManagerImpl;
  beforeEach(() => {
    document.body.innerHTML = '';
    m = createInputManager();
    m.setLevel(level());
    m.resetForRun(0);
  });
  afterEach(() => m.dispose());

  it('speed mode tags the run as keyboard; the intent is velocity, targetX is null while moving', () => {
    const s = restState(0);
    expect(m.sample(s)).toEqual({ intent: { kind: 'idle' }, fine: false, device: 0, targetX: null });
    s.v = -0.5; // moving: a press ramps at once (no tap window)
    key('keydown', 'ArrowLeft');
    expect(m.sample(s)).toEqual({ intent: { kind: 'velocity', v: -0.2 }, fine: false, device: 3, targetX: null });
  });

  it('direct force mode: force intents, force 0 after release (no hold servo)', () => {
    m.setKeyboardMode('force');
    const s = restState(0);
    key('keydown', 'ArrowRight');
    expect(m.sample(s).intent).toEqual({ kind: 'force', f: 40 });
    key('keyup', 'ArrowRight');
    s.v = 1.5;
    for (let i = 0; i < 20; i++) expect(m.sample(s).intent).toEqual({ kind: 'force', f: 0 });
    m.setKeyboardMode('speed');
    key('keydown', 'ArrowRight');
    expect(m.sample(s).intent).toEqual({ kind: 'velocity', v: 0.2 });
  });

  it('a held arrow survives a retry: the next run starts from the ramp at once', () => {
    const s = restState(0);
    key('keydown', 'ArrowRight');
    for (let i = 0; i < 10; i++) m.sample(s);
    m.resetForRun(0);
    expect(m.sample(restState(0)).intent).toEqual({ kind: 'velocity', v: 0.2 });
  });

  it('after the stop the frame is idle (assist may act), holding the stop point', () => {
    const s = restState(0.3);
    s.v = 0.5; // moving: a plain velocity press, then the dead-man stop
    key('keydown', 'ArrowRight');
    m.sample(s);
    key('keyup', 'ArrowRight');
    const stop = m.sample(s);
    expect(stop.intent).toEqual({ kind: 'target', x: 0.3 });
    s.v = 0;
    const next = m.sample(s);
    expect(next).toMatchObject({ intent: { kind: 'idle' }, targetX: 0.3, device: 3 });
  });
});

describe('key taps (R10 keyboard parity)', () => {
  let m: InputManagerImpl;
  beforeEach(() => {
    document.body.innerHTML = '';
    m = createInputManager();
    m.setLevel(level());
    m.resetForRun(0);
  });
  afterEach(() => m.dispose());
  const W = KEY_TAP.windowTicks;

  it('a press from rest steps the hold point by 5 cm at once; released within the window it stays a 5 cm step', () => {
    const s = restState(0.3);
    key('keydown', 'ArrowRight');
    for (let i = 0; i < 4; i++) {
      expect(m.sample(s)).toEqual({ intent: { kind: 'target', x: 0.35 }, fine: false, device: 3, targetX: 0.35 });
    }
    key('keyup', 'ArrowRight');
    const kinds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const f = m.sample(s);
      kinds.push(f.intent.kind);
      expect(f.targetX).toBe(0.35);
    }
    expect(kinds.every((k) => k === 'idle')).toBe(true); // the keyboard hold (assist may act)
    expect(m.debug().tapHold).toBe(true);
  });

  it('taps step from the current hold point (not the trolley x) and add up; Shift or Z taps are 1 cm', () => {
    const s = restState(0);
    const tapKey = (code: string, o: { shift?: boolean } = {}): void => {
      key('keydown', code, o);
      m.sample(s);
      m.sample(s);
      key('keyup', code, o);
      m.sample(s);
    };
    tapKey('ArrowRight');
    s.x = 0.043; // tugged by the swing: the next tap still steps from the hold point
    tapKey('KeyD');
    expect(m.debug().targetX).toBeCloseTo(0.1, 12);
    tapKey('ArrowLeft', { shift: true });
    expect(m.debug().targetX).toBeCloseTo(0.09, 12);
    key('keydown', 'KeyZ');
    tapKey('ArrowRight');
    tapKey('ArrowRight');
    key('keyup', 'KeyZ');
    expect(m.debug().targetX).toBeCloseTo(0.11, 12);
    tapKey('KeyA');
    expect(m.debug().targetX).toBeCloseTo(0.06, 12);
    expect(m.sample(s).device).toBe(3);
  });

  it('quick taps keep adding up while the trolley still travels to the tap target (it is not "at rest")', () => {
    const s = restState(0);
    for (let i = 0; i < 4; i++) {
      key('keydown', 'ArrowRight');
      expect(m.sample(s).intent.kind).toBe('target');
      key('keyup', 'ArrowRight');
      m.sample(s);
      s.v = 0.9; // travelling towards the growing target
    }
    expect(m.debug().targetX).toBeCloseTo(0.2, 12);
  });

  it('held past the window the ramp starts on tick W+1 from the trolley speed (≤ 120 ms added latency)', () => {
    const s = restState(0);
    key('keydown', 'ArrowRight');
    const frames = [];
    for (let i = 0; i < W + 3; i++) {
      if (i === W) s.v = 0.23; // the trolley already moves towards the 5 cm step
      frames.push(m.sample(s));
    }
    expect(frames.slice(0, W).map((f) => f.intent)).toEqual(Array(W).fill({ kind: 'target', x: 0.05 }));
    expect(W / 60).toBeLessThanOrEqual(0.12);
    expect(frames.slice(W).map((f) => f.intent)).toEqual([0.4, 0.6, 0.8].map((v) => ({ kind: 'velocity', v }))); // seeded at 0.2, then +0.2 per tick
    expect(frames[W].targetX).toBeNull();
    expect(m.debug().tapHold).toBe(false);
  });

  it('released 1-2 ticks after the ramp started (still ≤ 150 ms): the burst is cancelled, back to the 5 cm step', () => {
    for (const extra of [1, 2]) {
      m.resetForRun(0);
      const s = restState(0);
      key('keydown', 'ArrowRight');
      for (let i = 0; i < W + extra - 1; i++) m.sample(s);
      expect(m.sample(s).intent.kind).toBe('velocity'); // ramp tick number 'extra'
      key('keyup', 'ArrowRight');
      expect(m.sample(s)).toMatchObject({ intent: { kind: 'target', x: 0.05 }, targetX: 0.05 });
      expect(m.sample(s)).toMatchObject({ intent: { kind: 'idle' }, targetX: 0.05 });
      expect(m.debug().keyV).toBe(0); // no 5-tick dead-man ramp: the servo holds the step at once
    }
  });

  it('held longer than 150 ms it is a normal press: brake ramp and the stop latch', () => {
    const s = restState(0);
    key('keydown', 'ArrowRight');
    const held = W + 6; // 6 ramp ticks after the window: 1.2 m/s
    expect(held).toBeGreaterThan(KEY_TAP.maxTicks);
    for (let i = 0; i < held; i++) m.sample(s);
    expect(m.debug().keyV).toBe(1.2);
    key('keyup', 'ArrowRight');
    const f = m.sample(s);
    expect(f.intent).toEqual({ kind: 'velocity', v: 0.4 }); // braking from 1.2 at 0.8 per tick
    expect(m.sample(s).intent).toEqual({ kind: 'target', x: 0 });
  });

  it('a press while the trolley moves (≥ 0.3 m/s) ramps at once; a short one stays a burst', () => {
    const s = restState(0);
    s.v = KEY_TAP.restV + 0.05;
    key('keydown', 'ArrowLeft');
    expect(m.sample(s).intent).toEqual({ kind: 'velocity', v: -0.2 });
    key('keyup', 'ArrowLeft');
    expect(m.sample(s).intent).toEqual({ kind: 'target', x: 0 }); // the dead-man stop, not a step
  });

  it('a second movement key during the window: not a tap, the ramp takes over in the newest direction', () => {
    const s = restState(0);
    key('keydown', 'ArrowRight');
    expect(m.sample(s).intent).toEqual({ kind: 'target', x: 0.05 });
    key('keydown', 'ArrowLeft');
    s.v = 0.1;
    expect(m.sample(s).intent).toEqual({ kind: 'velocity', v: -0.2 });
    key('keyup', 'ArrowLeft');
    key('keyup', 'ArrowRight');
    m.sample(s);
    expect(m.sample(s).intent.kind).not.toBe('velocity');
    // a press while the other key is held is not a tap either
    key('keydown', 'ArrowLeft');
    for (let i = 0; i < 12; i++) m.sample(restState(0));
    key('keydown', 'ArrowRight');
    const f = m.sample(restState(0));
    expect(f.intent.kind).toBe('velocity');
    key('keyup', 'ArrowRight');
    key('keyup', 'ArrowLeft');
  });

  it('a tap pressed and released between two ticks still counts, unless the next tick comes late (pause menu)', () => {
    vi.useFakeTimers();
    try {
      const s = restState(0);
      key('keydown', 'ArrowRight');
      key('keyup', 'ArrowRight');
      expect(m.sample(s)).toMatchObject({ intent: { kind: 'target', x: 0.05 }, device: 3 });
      key('keydown', 'ArrowRight'); // e.g. walking the pause menu with the arrows
      key('keyup', 'ArrowRight');
      vi.advanceTimersByTime(KEY_TAP.staleMs + 50);
      expect(m.sample(s)).toMatchObject({ intent: { kind: 'idle' }, targetX: 0.05 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetForRun forgets pending taps; window blur drops the press', () => {
    const s = restState(0);
    key('keydown', 'ArrowRight');
    key('keyup', 'ArrowRight');
    m.resetForRun(0); // e.g. the arrow was the "any input" that retried
    expect(m.sample(s)).toMatchObject({ intent: { kind: 'idle' }, targetX: null, device: 0 });
    key('keydown', 'ArrowRight');
    window.dispatchEvent(new Event('blur'));
    expect(m.sample(s)).toMatchObject({ intent: { kind: 'idle' }, targetX: null });
  });

  it('a tap takes over from a finger drag and steps from the drag target', () => {
    const L = layoutTall();
    const scene = box(0, 0, 390, L.scene.h), deckEl = box(0, L.scene.h, 390, L.deck!.h);
    m.attach(scene, deckEl, { screenToRailX: () => null }, L);
    const y = L.scene.h + 100;
    const s = restState(0);
    ptr(deckEl, 'pointerdown', 100, y);
    ptr(deckEl, 'pointermove', 139, y); // +39 px = +0.42 m on the 4.2 m rail
    m.sample(s);
    key('keydown', 'ArrowRight');
    expect(m.sample(s).targetX).toBeCloseTo(0.47, 12);
    key('keyup', 'ArrowRight');
    ptr(deckEl, 'pointermove', 300, y); // the drag has ended: no jump
    expect(m.sample(s).targetX).toBeCloseTo(0.47, 12);
    expect(m.debug().drag).toBeNull();
  });

  it('a rewind re-anchors a tap hold at the restored x', () => {
    const s = restState(0);
    key('keydown', 'ArrowRight');
    m.sample(s);
    key('keyup', 'ArrowRight');
    s.substep = 600;
    m.sample(s);
    const back = restState(1.2);
    back.substep = 300;
    expect(m.sample(back)).toMatchObject({ targetX: 1.2 });
    expect(m.debug().tapHold).toBe(false);
  });
});

describe('fragile cargo (R10): egg levels cap every device at 2.0 m/s (fine 0.5)', () => {
  const egg = level({ egg: { Tmax: 18, Jmax: 0.3 } });
  let m: InputManagerImpl;
  let pads: (Gamepad | null)[];
  beforeEach(() => {
    document.body.innerHTML = '';
    pads = [];
    m = createInputManager({ getPads: () => pads });
    m.setLevel(egg);
    m.resetForRun(0);
  });
  afterEach(() => m.dispose());

  it('keyboard: the ramp tops out at 2.0 (fine 0.5) on egg levels, 4.0 again on a ball level', () => {
    const s = restState(0);
    s.v = 1; // moving: no tap window
    key('keydown', 'ArrowRight');
    const vs: number[] = [];
    for (let i = 0; i < 12; i++) vs.push((m.sample(s).intent as { v: number }).v);
    expect(vs).toEqual([0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2, 2]);
    key('keydown', 'ShiftLeft');
    expect(m.sample(s)).toMatchObject({ intent: { kind: 'velocity', v: 1.2 }, fine: true });
    expect((m.sample(s).intent as { v: number }).v).toBe(0.5);
    key('keyup', 'ShiftLeft');
    m.setLevel(level());
    const n = (KEY_RAMP.cap - KEY_RAMP.capFine) / KEY_RAMP.up; // 0.5 -> 4.0 at 0.2 per tick: 18 ticks
    for (let i = 0; i < n - 1; i++) expect((m.sample(s).intent as { v: number }).v).toBeLessThan(4);
    expect((m.sample(s).intent as { v: number }).v).toBe(4);
    key('keyup', 'ArrowRight');
  });

  it('gamepad: full stick = 2.0 m/s (LB 0.5), the D-pad ramp stops at 2.0', () => {
    const s = restState(0);
    pads = [fakePad([1, 0])];
    expect(m.sample(s).intent).toEqual({ kind: 'velocity', v: 2 });
    pads = [fakePad([-1, 0], [4])];
    expect(m.sample(s)).toMatchObject({ intent: { kind: 'velocity', v: -0.5 }, fine: true });
    pads = [fakePad([0, 0], [15])];
    const vs: number[] = [];
    for (let i = 0; i < 12; i++) vs.push((m.sample(s).intent as { v: number }).v);
    expect(Math.max(...vs)).toBe(2);
  });

  it('servo: target, velocity and idle intents are capped at 2.0 (fine 0.5) by speedCap', () => {
    const s = restState(0);
    const f = (intent: Intent, fine = false, targetX: number | null = null): InputFrame => ({ intent, fine, device: 1, targetX }) as InputFrame;
    expect(speedCap(egg, false)).toBe(FRAGILE.vCap);
    expect(speedCap(egg, true)).toBe(FRAGILE.vCapFine);
    expect(speedCap(level(), false)).toBe(4);
    expect(speedCap(level(), true)).toBe(1);
    expect(servoVcmd(f({ kind: 'target', x: 3 }), s, egg, false)).toBe(2);
    expect(servoVcmd(f({ kind: 'target', x: -3 }, true), s, egg, false)).toBe(-0.5);
    expect(servoVcmd(f({ kind: 'velocity', v: 4 }), s, egg, false)).toBe(2);
    expect(servoVcmd(f({ kind: 'idle' }, false, 2.5), s, egg, false)).toBe(2);
    expect(servoVcmd(f({ kind: 'target', x: 3 }), s, level(), false)).toBe(4);
  });
});
