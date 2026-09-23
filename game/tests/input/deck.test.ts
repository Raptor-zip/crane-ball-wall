// Touch deck clutch, fine band, wide absolute mapping and mouse rules (GAME_DESIGN.md §3.3). Owner: O4.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlSurface, deckTargetX, inFineBand } from '../../src/input/pointer';
import { createInputManager, type InputManagerImpl } from '../../src/input/manager';
import type { Command, RailMapper } from '../../src/input/types';
import { level, restState } from './plant';
import { box, layoutTall, layoutWide, ptr } from './helpers';

describe('deck geometry (pure)', () => {
  it('maps the deck width onto the whole rail: 390 px ≈ 1.1 cm/px, fine ≈ 3.6 mm/px', () => {
    const rail: [number, number] = [-1, 3.2];
    expect(deckTargetX(0, 0, 1, 1, rail, 390)).toBeCloseTo(0.010769, 6);
    expect(deckTargetX(0, 0, 1, 1 / 3, rail, 390)).toBeCloseTo(0.00359, 5);
    expect(deckTargetX(0.5, 100, 490, 1, rail, 390)).toBeCloseTo(0.5 + 4.2, 12); // full width = full rail
  });

  it('control surface = deck minus the 8 px force bar and 72 px mini rail; fine band = its bottom third', () => {
    const deck = { left: 0, top: 523, width: 390, height: 321 };
    const surf = controlSurface(deck);
    expect(surf).toEqual({ left: 0, top: 603, width: 390, height: 241 });
    const edge = 603 + 241 * (2 / 3);
    expect(inFineBand(edge - 0.5, surf)).toBe(false);
    expect(inFineBand(edge + 0.5, surf)).toBe(true);
    expect(inFineBand(600, surf)).toBe(false); // mini rail: coarse
    // A UI-provided [data-input-surface] element wins.
    expect(controlSurface(deck, { left: 0, top: 700, width: 390, height: 90 })).toEqual({ left: 0, top: 700, width: 390, height: 90 });
  });
});

describe('pointer input through the manager', () => {
  let m: InputManagerImpl;
  let cmds: Command[];
  const s = restState(0);
  beforeEach(() => {
    document.body.innerHTML = '';
    m = createInputManager();
    cmds = [];
    m.onCommand((c) => cmds.push(c));
    m.setLevel(level());
    m.resetForRun(0);
  });
  afterEach(() => m.dispose());

  function tall(): { scene: HTMLElement; deck: HTMLElement; yCoarse: number; yFine: number } {
    const L = layoutTall();
    const scene = box(0, 0, 390, L.scene.h);
    const deck = box(0, L.scene.h, 390, L.deck!.h);
    m.attach(scene, deck, { screenToRailX: () => null }, L);
    const top = L.scene.h + 80, h = L.deck!.h - 80;
    return { scene, deck, yCoarse: top + h * 0.2, yFine: top + h * 0.9 };
  }

  it('touch-down records (px0, xt0) without moving the target; release leaves it in place', () => {
    const { deck, yCoarse } = tall();
    ptr(deck, 'pointerdown', 50, yCoarse);
    let f = m.sample(s);
    expect(f.targetX).toBe(0);
    expect(f.device).toBe(0); // a touch that has not moved anything does not tag the run yet
    ptr(deck, 'pointermove', 89, yCoarse);
    f = m.sample(s);
    expect(f.targetX).toBeCloseTo(0.42, 12);
    expect(f.device).toBe(1); // touch
    expect(f.intent).toEqual({ kind: 'target', x: f.targetX });
    ptr(deck, 'pointerup', 89, yCoarse);
    // A new touch anywhere continues from the current target: no jump, no sudden brake.
    ptr(deck, 'pointerdown', 350, yCoarse, { id: 2 });
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
    ptr(deck, 'pointermove', 311, yCoarse, { id: 2 });
    expect(m.sample(s).targetX).toBeCloseTo(0, 12);
  });

  it('a second finger is ignored', () => {
    const { deck, yCoarse, yFine } = tall();
    ptr(deck, 'pointerdown', 100, yCoarse, { id: 1 });
    ptr(deck, 'pointerdown', 300, yFine, { id: 2, primary: false });
    ptr(deck, 'pointermove', 10, yFine, { id: 2, primary: false });
    expect(m.sample(s).targetX).toBe(0);
    ptr(deck, 'pointermove', 139, yCoarse, { id: 1 });
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
    expect(cmds.filter((c) => c === 'any')).toHaveLength(1);
  });

  it('the fine band is chosen at touch-down: k = 1/3 and fine = true for the whole drag', () => {
    const { deck, yFine, yCoarse } = tall();
    ptr(deck, 'pointerdown', 100, yFine);
    ptr(deck, 'pointermove', 217, yCoarse); // leaving the band does not switch to k = 1
    const f = m.sample(s);
    expect(f.targetX).toBeCloseTo(0.42, 12);
    expect(f.fine).toBe(true);
    expect(m.debug().drag).toMatchObject({ mode: 'clutch', fine: true });
  });

  it('the target is clamped to rail ± 0.30 and re-anchored there (moving back responds at once)', () => {
    const { deck, yCoarse } = tall();
    ptr(deck, 'pointerdown', 0, yCoarse);
    ptr(deck, 'pointermove', 390, yCoarse); // +4.2 m -> clamp to 3.5
    expect(m.sample(s).targetX).toBeCloseTo(3.5, 12);
    ptr(deck, 'pointermove', 380, yCoarse);
    expect(m.sample(s).targetX).toBeCloseTo(3.5 - (10 * 4.2) / 390, 12);
    ptr(deck, 'pointermove', -2000, yCoarse);
    expect(m.sample(s).targetX).toBeCloseTo(-1.3, 12);
  });

  it('tall: the 3D view does not steer (the deck does), but a tap there is still "any input"', () => {
    const { scene } = tall();
    ptr(scene, 'pointerdown', 200, 300);
    ptr(scene, 'pointermove', 300, 300);
    expect(m.sample(s).targetX).toBeNull();
    expect(cmds).toEqual(['any']);
  });

  it('tall + mouse: relative deck drag, only while the button is held (hover never moves)', () => {
    const { deck, yCoarse } = tall();
    ptr(deck, 'pointermove', 200, yCoarse, { type: 'mouse', buttons: 0 });
    expect(m.sample(s).targetX).toBeNull();
    ptr(deck, 'pointerdown', 100, yCoarse, { type: 'mouse' });
    ptr(deck, 'pointermove', 139, yCoarse, { type: 'mouse' });
    const f = m.sample(s);
    expect(f.targetX).toBeCloseTo(0.42, 12);
    expect(f.device).toBe(2); // mouse
    ptr(deck, 'pointerup', 139, yCoarse, { type: 'mouse' });
    ptr(deck, 'pointermove', 300, yCoarse, { type: 'mouse', buttons: 0 });
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
  });

  it('orientation change / re-attach resets the clutch but keeps the target', () => {
    const { deck, yCoarse } = tall();
    ptr(deck, 'pointerdown', 100, yCoarse);
    ptr(deck, 'pointermove', 139, yCoarse);
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
    window.dispatchEvent(new Event('orientationchange'));
    ptr(deck, 'pointermove', 300, yCoarse); // the old drag is over
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
    expect(m.debug().drag).toBeNull();

    ptr(deck, 'pointerdown', 100, yCoarse, { id: 5 });
    const L = layoutWide(844, 390);
    const scene2 = box(0, 0, 844, 390);
    m.attach(scene2, null, { screenToRailX: () => 2 }, L); // the new layout arrives
    ptr(deck, 'pointermove', 300, yCoarse, { id: 5 });
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
    expect(deck.style.touchAction).toBe(''); // the old deck is released
    expect(scene2.style.touchAction).toBe('none');
  });

  it('wide: absolute mapping below the HUD band; mouse press-drag only; the mapper output is clamped', () => {
    const L = layoutWide();
    const scene = box(0, 0, 1280, 720);
    const mapper: RailMapper = { screenToRailX: (x) => x / 100 - 2 };
    m.attach(scene, null, mapper, L);
    ptr(scene, 'pointermove', 400, 400, { type: 'mouse', buttons: 0 }); // hover
    expect(m.sample(s).targetX).toBeNull();
    ptr(scene, 'pointerdown', 400, 30, { type: 'mouse' }); // HUD band
    expect(m.sample(s).targetX).toBeNull();
    ptr(scene, 'pointerup', 400, 30, { type: 'mouse' });
    ptr(scene, 'pointerdown', 400, 400, { type: 'mouse' });
    expect(m.sample(s).targetX).toBeCloseTo(2, 12); // absolute: jumps to the pointer
    ptr(scene, 'pointermove', 500, 600, { type: 'mouse' });
    expect(m.sample(s).targetX).toBeCloseTo(3, 12);
    ptr(scene, 'pointermove', 1200, 600, { type: 'mouse' });
    expect(m.sample(s).targetX).toBeCloseTo(3.5, 12); // rail1 + 0.30
    ptr(scene, 'pointerup', 1200, 600, { type: 'mouse' });
    ptr(scene, 'pointermove', 100, 600, { type: 'mouse', buttons: 0 });
    expect(m.sample(s).targetX).toBeCloseTo(3.5, 12);
  });

  it('wide: a null from the mapper keeps the previous target', () => {
    const L = layoutWide();
    const scene = box(0, 0, 1280, 720);
    let out: number | null = 1;
    m.attach(scene, null, { screenToRailX: () => out }, L);
    ptr(scene, 'pointerdown', 400, 400);
    expect(m.sample(s).targetX).toBe(1);
    out = null;
    ptr(scene, 'pointermove', 410, 400);
    expect(m.sample(s).targetX).toBe(1);
  });

  it('right click = retry; the context menu is suppressed on the scene and the deck', () => {
    const { scene, deck, yCoarse } = tall();
    ptr(scene, 'pointerdown', 100, 100, { type: 'mouse', button: 2, buttons: 2 });
    expect(cmds).toEqual(['retry', 'any']);
    expect(m.sample(s).targetX).toBeNull();
    for (const el of [scene, deck]) {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: yCoarse });
      el.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('sets touch-action: none on the scene and the deck', () => {
    const { scene, deck } = tall();
    expect(scene.style.touchAction).toBe('none');
    expect(deck.style.touchAction).toBe('none');
  });

  it('presses on UI buttons inside the deck are left to the UI', () => {
    const { deck, yCoarse } = tall();
    const b = document.createElement('button');
    deck.appendChild(b);
    ptr(b, 'pointerdown', 100, yCoarse);
    ptr(b, 'pointermove', 200, yCoarse);
    expect(m.sample(s).targetX).toBeNull();
    expect(cmds).toEqual([]);
  });

  it('a deck nested inside the scene element handles each press once', () => {
    const L = layoutTall();
    const scene = box(0, 0, 390, 844);
    const deck = document.createElement('div');
    deck.getBoundingClientRect = () => new DOMRect(0, L.scene.h, 390, L.deck!.h);
    scene.appendChild(deck);
    m.attach(scene, deck, { screenToRailX: () => null }, L);
    ptr(deck, 'pointerdown', 100, L.scene.h + 120);
    ptr(deck, 'pointermove', 139, L.scene.h + 120);
    expect(cmds).toEqual(['any']);
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
  });

  it('without a deck element in tall, the scene acts as the deck (layout.deck rect fallback)', () => {
    const L = layoutTall();
    const scene = document.createElement('div'); // happy-dom: zero-size rect -> layout rects are used
    document.body.appendChild(scene);
    m.attach(scene, null, { screenToRailX: () => null }, L);
    ptr(scene, 'pointerdown', 100, 200);
    ptr(scene, 'pointermove', 139, 200);
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
  });

  it('resetForRun clears the target; a finger still down keeps steering from the new start', () => {
    const { deck, yCoarse } = tall();
    ptr(deck, 'pointerdown', 100, yCoarse);
    ptr(deck, 'pointermove', 200, yCoarse);
    expect(m.sample(s).targetX).toBeCloseTo(1.0769, 4);
    m.resetForRun(0.25);
    const f0 = m.sample(restState(0.25));
    expect(f0.targetX).toBeNull();
    expect(f0.device).toBe(0);
    ptr(deck, 'pointermove', 239, yCoarse);
    const f = m.sample(restState(0.25));
    expect(f.targetX).toBeCloseTo(0.25 + 0.42, 12);
    expect(f.device).toBe(1);
  });

  it("uses the UI's .deck-surface element (O7) for the fine band, e.g. with a 2 px border and a safe-area inset", () => {
    const L = layoutTall();
    const scene = box(0, 0, 390, L.scene.h);
    const deck = box(0, L.scene.h, 390, L.deck!.h);
    // Surface starts 2 + 8 + 72 px below the deck top and has a 34 px home-indicator inset at the bottom
    // (the UI's fine tint is 1/3 of this whole element, like inFineBand).
    const surfTop = L.scene.h + 82, surfH = L.deck!.h - 82;
    const surf = document.createElement('div');
    surf.className = 'deck-surface';
    surf.getBoundingClientRect = () => new DOMRect(0, surfTop, 390, surfH);
    deck.appendChild(surf);
    m.attach(scene, deck, { screenToRailX: () => null }, L);
    const edge = surfTop + (surfH * 2) / 3;
    ptr(surf, 'pointerdown', 100, edge - 1); // just above the tint: coarse
    expect(m.debug().drag).toMatchObject({ fine: false });
    ptr(surf, 'pointerup', 100, edge - 1);
    ptr(surf, 'pointerdown', 100, edge + 1, { id: 2 }); // just inside the tint: fine
    expect(m.debug().drag).toMatchObject({ fine: true, k: 1 / 3 });
  });

  it('a press with the id of a drag whose pointerup was lost starts a new drag (the click is not swallowed)', () => {
    const L = layoutWide();
    const scene = box(0, 0, 1280, 720);
    m.attach(scene, null, { screenToRailX: (x) => x / 100 - 2 }, L);
    ptr(scene, 'pointerdown', 300, 400, { type: 'mouse' });
    expect(m.sample(s).targetX).toBeCloseTo(1, 12);
    // The button was released outside the window without capture: no pointerup, no move.
    ptr(scene, 'pointerdown', 450, 400, { type: 'mouse' });
    expect(m.sample(s).targetX).toBeCloseTo(2.5, 12);
    expect(cmds).toEqual(['any', 'any']);
  });

  it('a right press during a left mouse drag (a chorded pointermove) is a retry; releasing left ends the drag', () => {
    const L = layoutWide();
    const scene = box(0, 0, 1280, 720);
    m.attach(scene, null, { screenToRailX: (x) => x / 100 - 2 }, L);
    ptr(scene, 'pointerdown', 300, 400, { type: 'mouse' });
    ptr(scene, 'pointermove', 300, 400, { type: 'mouse', buttons: 3 });
    expect(cmds).toEqual(['any', 'retry', 'any']);
    ptr(scene, 'pointermove', 310, 400, { type: 'mouse', buttons: 3 }); // still held: no repeat
    expect(cmds).toHaveLength(3);
    ptr(scene, 'pointermove', 500, 400, { type: 'mouse', buttons: 2 }); // left released: no more steering
    expect(m.debug().drag).toBeNull();
    expect(m.sample(s).targetX).toBeCloseTo(1.1, 12);
  });

  it('resetForRun with a finger still down in the fine band keeps fine mode for that drag', () => {
    const { deck, yFine } = tall();
    ptr(deck, 'pointerdown', 100, yFine);
    ptr(deck, 'pointermove', 110, yFine);
    expect(m.sample(s).fine).toBe(true);
    m.resetForRun(0);
    ptr(deck, 'pointermove', 139, yFine);
    const f = m.sample(restState(0));
    expect(f.fine).toBe(true);
    expect(f.targetX).toBeCloseTo((29 * 4.2) / 390 / 3, 12);
  });

  it('pointercancel ends the drag and keeps the target', () => {
    const { deck, yCoarse } = tall();
    ptr(deck, 'pointerdown', 100, yCoarse);
    ptr(deck, 'pointermove', 139, yCoarse);
    ptr(deck, 'pointercancel', 139, yCoarse);
    ptr(deck, 'pointermove', 300, yCoarse);
    expect(m.sample(s).targetX).toBeCloseTo(0.42, 12);
  });
});
