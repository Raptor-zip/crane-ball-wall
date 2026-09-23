// Device arbitration, device tags, idle detection and the gamepad (GAME_DESIGN.md §3.3, §3.6). Owner: O4.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGamepadSource, stickToVelocity } from '../../src/input/gamepad';
import { KEY_RAMP, KEY_TAP } from '../../src/input/keyboard';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import type { Command } from '../../src/input/types';
import { level, restState } from './plant';
import { box, fakePad, key, layoutTall, ptr } from './helpers';

describe('gamepad stick curve (§3.3)', () => {
  it('dead zone 0.10, exponent 1.6, 4 m/s at full deflection', () => {
    expect(stickToVelocity(0)).toBe(0);
    expect(stickToVelocity(0.1)).toBe(0);
    expect(stickToVelocity(-0.1)).toBe(0);
    expect(stickToVelocity(1)).toBe(4);
    expect(stickToVelocity(-1)).toBe(-4);
    expect(stickToVelocity(0.55)).toBeCloseTo(4 * Math.pow(0.5, 1.6), 12);
    expect(stickToVelocity(-0.55)).toBeCloseTo(-4 * Math.pow(0.5, 1.6), 12);
    expect(stickToVelocity(1.3)).toBe(4);
    expect(stickToVelocity(NaN)).toBe(0);
    expect(stickToVelocity(1, 1)).toBe(1); // LB fine: the whole stick travel for 0..1 m/s
  });

  it('buttons: A confirm, B back, Y ghostCycle, Start pause, Back retry; edges only, each followed by any', () => {
    let pads: (Gamepad | null)[] = [fakePad()];
    const g = createGamepadSource(() => pads, null);
    const cmds: Command[] = [];
    g.onCommand((c) => cmds.push(c));
    g.poll();
    for (const [b, c] of [[0, 'confirm'], [1, 'back'], [3, 'ghostCycle'], [9, 'pause'], [8, 'retry']] as const) {
      cmds.length = 0;
      pads = [fakePad([0, 0], [b])];
      g.poll();
      g.poll(); // held: no repeat
      pads = [fakePad()];
      g.poll();
      expect(cmds).toEqual([c, 'any']);
    }
    g.dispose();
  });

  it('LB = fine (whole stick for 0..1 m/s), disconnected pads are skipped', () => {
    let pads: (Gamepad | null)[] = [null, fakePad([1, 0], [4])];
    const g = createGamepadSource(() => pads, null);
    expect(g.poll()).toEqual({ engaged: true, v: 1, fine: true });
    pads = [{ ...fakePad([1, 0]), connected: false } as Gamepad];
    expect(g.poll()).toEqual({ engaged: false, v: 0, fine: false });
    g.dispose();
  });

  it('D-pad is digital: it uses the keyboard ramp (20 ticks to 4.0, 5 ticks to stop, fine 0.5), the stick overrides it', () => {
    let pads: (Gamepad | null)[] = [fakePad([0.02, 0], [15])];
    const g = createGamepadSource(() => pads, null);
    const up: number[] = [];
    const full = KEY_RAMP.cap / KEY_RAMP.up; // 20 ticks at 0.2 m/s per tick
    for (let i = 0; i < full + 1; i++) up.push(g.poll().v);
    expect(up).toEqual(Array.from({ length: full + 1 }, (_, i) => Math.min(KEY_RAMP.cap, (i + 1) * KEY_RAMP.up) / KEY_RAMP.perMps));
    expect(up.slice(0, 3)).toEqual([0.2, 0.4, 0.6]);
    expect(up.slice(full - 2)).toEqual([3.8, 4, 4]);
    pads = [fakePad([0, 0])];
    const down: [boolean, number][] = [];
    for (let i = 0; i < 6; i++) {
      const t = g.poll();
      down.push([t.engaged, t.v]);
    }
    expect(down).toEqual([[true, 3.2], [true, 2.4], [true, 1.6], [true, 0.8], [false, 0], [false, 0]]);
    pads = [fakePad([0, 0], [14, 4])]; // left + LB: fine ramp 0.2 per tick up to 0.5 (the keyboard's fine cap, R10)
    const fine: number[] = [];
    for (let i = 0; i < 4; i++) fine.push(g.poll().v);
    expect(fine).toEqual([-0.2, -0.4, -0.5, -0.5]);
    pads = [fakePad([0.55, 0], [14])]; // the stick wins while it is out of the dead zone
    expect(g.poll().v).toBeCloseTo(4 * Math.pow(0.5, 1.6), 12);
    g.dispose();
  });

  it('polling does not allocate a new result (same object every tick)', () => {
    const pads: (Gamepad | null)[] = [fakePad([0.5, 0])];
    const g = createGamepadSource(() => pads, null);
    expect(g.poll()).toBe(g.poll());
    g.dispose();
  });
});

describe('InputManager arbitration', () => {
  let m: InputManagerImpl;
  let pads: (Gamepad | null)[];
  const s = restState(0);
  beforeEach(() => {
    document.body.innerHTML = '';
    pads = [];
    m = createInputManager({ getPads: () => pads });
    m.setLevel(level());
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

  it('device tag: Unknown until used, then the device, Mixed once two kinds are used; reset per run', () => {
    const { el, y } = deck();
    expect(m.sample(s).device).toBe(0);
    ptr(el, 'pointerdown', 100, y);
    ptr(el, 'pointermove', 120, y);
    expect(m.sample(s).device).toBe(1);
    ptr(el, 'pointerup', 120, y);
    key('keydown', 'ArrowRight');
    expect(m.sample(s).device).toBe(5);
    key('keyup', 'ArrowRight');
    m.resetForRun(0);
    pads = [fakePad([0.8, 0])];
    expect(m.sample(s).device).toBe(4);
  });

  it('commands (keys, pointer, pad buttons) do not count as a device', () => {
    key('keydown', 'KeyG');
    key('keyup', 'KeyG');
    pads = [fakePad([0, 0], [3])];
    expect(m.sample(s).device).toBe(0);
  });

  it('pointer target becomes idle after 15 unchanged ticks (§3.6)', () => {
    const { el, y } = deck();
    ptr(el, 'pointerdown', 100, y);
    ptr(el, 'pointermove', 139, y);
    const kinds: string[] = [];
    for (let i = 0; i < 17; i++) kinds.push(m.sample(s).intent.kind);
    expect(kinds.slice(0, 15)).toEqual(Array(15).fill('target'));
    expect(kinds.slice(15)).toEqual(['idle', 'idle']);
    ptr(el, 'pointermove', 140, y); // any change restarts the count
    expect(m.sample(s).intent.kind).toBe('target');
  });

  it('the device whose push started last wins; a finger lift hands back to a held key', () => {
    const { el, y } = deck();
    key('keydown', 'ArrowRight');
    for (let i = 0; i < KEY_TAP.windowTicks; i++) expect(m.sample(s).intent.kind).toBe('target'); // tap window (R10)
    expect(m.sample(s).intent.kind).toBe('velocity');
    ptr(el, 'pointerdown', 100, y);
    let f = m.sample(s);
    expect(f.intent).toEqual({ kind: 'target', x: 0 }); // grabbed at the trolley x
    ptr(el, 'pointermove', 139, y);
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
    ptr(el, 'pointerup', 139, y);
    f = m.sample(s);
    expect(f.intent.kind).toBe('velocity'); // the arrow is still held
    expect(f.targetX).toBeNull();
    key('keyup', 'ArrowRight');
  });

  it('a key press during a drag takes over and ends the drag (no jump back on the next move)', () => {
    const { el, y } = deck();
    ptr(el, 'pointerdown', 100, y);
    ptr(el, 'pointermove', 139, y);
    m.sample(s);
    const moving = restState(0);
    moving.v = 0.5; // the trolley chases the drag target: a press ramps at once (no tap window)
    key('keydown', 'ArrowLeft');
    expect(m.sample(moving).intent).toEqual({ kind: 'velocity', v: -0.2 });
    ptr(el, 'pointermove', 300, y);
    expect(m.sample(moving).intent.kind).toBe('velocity');
    key('keyup', 'ArrowLeft');
    let f = m.sample(s);
    expect(f.intent).toEqual({ kind: 'target', x: 0 }); // stopped: hold here
    ptr(el, 'pointerdown', 50, y, { id: 7 }); // grabbing again starts from the hold point
    ptr(el, 'pointermove', 89, y, { id: 7 });
    f = m.sample(s);
    expect(f.targetX).toBeCloseTo(0.42, 12);
  });

  it('gamepad: stick -> velocity; back in the dead zone -> hold the trolley x', () => {
    pads = [fakePad([1, 0])];
    let f = m.sample(s);
    expect(f.intent).toEqual({ kind: 'velocity', v: 4 });
    expect(f.device).toBe(4);
    pads = [fakePad([0.05, 0])];
    const s2 = restState(0.8);
    f = m.sample(s2);
    expect(f.intent).toEqual({ kind: 'target', x: 0.8 });
    expect(m.sample(s2)).toMatchObject({ intent: { kind: 'idle' }, targetX: 0.8 });
  });

  it('gamepad D-pad: velocity ramp, then the stop tick holds the trolley x like the keyboard', () => {
    pads = [fakePad([0, 0], [15])];
    for (let i = 0; i < KEY_RAMP.cap / KEY_RAMP.up - 1; i++) expect(m.sample(s).intent.kind).toBe('velocity');
    expect(m.sample(s).intent).toEqual({ kind: 'velocity', v: 4 }); // 20 ticks at 0.2 m/s per tick
    pads = [fakePad([0, 0])];
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) kinds.push(m.sample(s).intent.kind);
    expect(kinds).toEqual(['velocity', 'velocity', 'velocity', 'velocity', 'target', 'idle']);
    expect(m.sample(s).device).toBe(4);
  });

  it('gamepad commands are forwarded', () => {
    const cmds: Command[] = [];
    m.onCommand((c) => cmds.push(c));
    pads = [fakePad([0, 0], [9])];
    m.sample(s);
    expect(cmds).toEqual(['pause', 'any']);
  });

  it('setLevel clamps an existing target into the new rail range', () => {
    const { el, y } = deck();
    ptr(el, 'pointerdown', 0, y);
    ptr(el, 'pointermove', 390, y);
    expect(m.sample(s).targetX).toBeCloseTo(3.5, 12);
    m.setLevel(level({ rail: [-0.6, 2.4] }));
    expect(m.sample(s).targetX).toBeCloseTo(2.7, 12);
  });

  it('a throwing command listener does not stop the others', () => {
    const got: Command[] = [];
    m.onCommand(() => {
      throw new Error('boom');
    });
    m.onCommand((c) => got.push(c));
    const err = console.error;
    console.error = () => {};
    try {
      key('keydown', 'KeyM');
    } finally {
      console.error = err;
    }
    expect(got).toEqual(['mute', 'any']);
  });

  it('dispose removes every listener', () => {
    const { el, y } = deck();
    const got: Command[] = [];
    m.onCommand((c) => got.push(c));
    m.dispose();
    key('keydown', 'KeyR');
    ptr(el, 'pointerdown', 100, y);
    expect(got).toEqual([]);
    expect(el.style.touchAction).toBe('');
    m = createInputManager({ getPads: () => pads }); // for afterEach
  });
});

describe('gamepad re-arm', () => {
  it('a stick overridden by another device must return to the dead zone before it steers again', () => {
    document.body.innerHTML = '';
    let pads: (Gamepad | null)[] = [fakePad([0.3, 0])];
    const m = createInputManager({ getPads: () => pads });
    m.setLevel(level());
    m.resetForRun(0);
    const s = restState(0);
    expect(m.sample(s).intent.kind).toBe('velocity');
    key('keydown', 'ArrowLeft'); // the keyboard takes over while the stick still rests at 0.3
    expect(m.sample(s).intent).toEqual({ kind: 'target', x: -0.05 }); // a tap from rest (R10)
    key('keyup', 'ArrowLeft');
    for (let i = 0; i < 3; i++) m.sample(s);
    expect(m.sample(s)).toMatchObject({ intent: { kind: 'idle' }, targetX: -0.05 }); // holds; the drifting stick does not grab control
    pads = [fakePad([0, 0])];
    m.sample(s);
    pads = [fakePad([0.3, 0])];
    expect(m.sample(s).intent.kind).toBe('velocity'); // re-armed by a deliberate push
    m.dispose();
  });
});
