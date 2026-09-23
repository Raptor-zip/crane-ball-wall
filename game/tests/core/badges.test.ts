// Trick toasts and badges from scripted sim events (GAME_DESIGN.md §7.3). Owner: O3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import { Ev, SimEvents } from '../../src/sim/events';
import { Mode, Status, type SimState } from '../../src/sim/run';
import { amplitudeDeg, createBadgeTracker, type TrickId } from '../../src/core/badges';

const levels = (JSON.parse(readFileSync(new URL('../../src/data/levels.json', import.meta.url), 'utf8')) as LevelsFile).levels;
const byId = (id: string): LevelDef => levels.find((l) => l.id === id)!;
const DEG = Math.PI / 180;

function state(p: Partial<SimState> = {}): SimState {
  return {
    mode: Mode.Taut, pinned: 0, x: 0, v: 0, th: 0, w: 0, bx: 0, by: 0.25, bvx: 0, bvy: 0, F: 0, T: 9.81,
    substep: 0, status: Status.Running, phase: 0, hold: 0, holdStart: 0, score: 0, minD2: Infinity, peakF: 0,
    near: { wall: -1, d2: Infinity, px: 0, py: 0 }, crash: null, ...p,
  };
}

/** Feeds ticks; `script(t)` returns the state and the events of tick t. Collects every trick reported. */
function play(level: LevelDef, ticks: number, script: (t: number, ev: SimEvents) => Partial<SimState>) {
  const tr = createBadgeTracker(level);
  const ev = new SimEvents();
  const tricks: TrickId[] = [];
  let s = state();
  for (let t = 0; t < ticks; t++) {
    ev.clear();
    s = state({ substep: 2 * (t + 1), ...script(t, ev) });
    tricks.push(...tr.onTick(s, ev));
  }
  return { tr, tricks, s };
}

describe('trick toasts (§7.3)', () => {
  it('ブレーキ振り出し: a forward WallCross after the trolley lost >= 1.5 m/s within 0.6 s', () => {
    const { tricks } = play(byId('1-2'), 100, (t, ev) => {
      const v = t < 50 ? 2.5 : Math.max(0.5, 2.5 - (t - 50) * 0.1); // brake from 2.5 to 0.5 m/s in 20 ticks
      if (t === 80) ev.push(Ev.WallCross, 160, 0, 1, 0.01);
      return { v, x: t * 0.03 };
    });
    expect(tricks).toEqual(['brakeFling']);
  });

  it('no ブレーキ振り出し when the brake was more than 0.6 s before the crossing, or too soft', () => {
    const early = play(byId('1-2'), 120, (t, ev) => {
      if (t === 110) ev.push(Ev.WallCross, 220, 0, 1, 0.01);
      return { v: t < 20 ? 3 : 0.5 };
    });
    expect(early.tricks).toEqual([]);
    const soft = play(byId('1-2'), 100, (t, ev) => {
      if (t === 80) ev.push(Ev.WallCross, 160, 0, 1, 0.01);
      return { v: t < 60 ? 2 : 0.6 };
    });
    expect(soft.tricks).toEqual([]);
  });

  it('逆振りの溜め: backed up >= 0.2 m before the first forward crossing', () => {
    const { tricks } = play(byId('2-1'), 120, (t, ev) => {
      if (t === 100) ev.push(Ev.WallCross, 200, 0, 1, 0.01);
      return { x: t < 40 ? -t * 0.006 : -0.24 + (t - 40) * 0.03, v: 1 };
    });
    expect(tricks).toContain('windUp');
    const shallow = play(byId('2-1'), 120, (t, ev) => {
      if (t === 100) ev.push(Ev.WallCross, 200, 0, 1, 0.01);
      return { x: t < 40 ? -t * 0.004 : 0, v: 1 };
    });
    expect(shallow.tricks).not.toContain('windUp');
  });

  it('端ドン only for a taut StopHit >= 1.5 m/s; パシッ for J >= 1.0', () => {
    const { tricks } = play(byId('4-2'), 10, (t, ev) => {
      if (t === 1) ev.push(Ev.StopHit, 3, 1, 1.4, 1);
      if (t === 2) ev.push(Ev.StopHit, 5, 1, 2.0, 0); // slack: no trick
      if (t === 3) ev.push(Ev.Snap, 7, 0.9, 0, 0);
      if (t === 4) ev.push(Ev.StopHit, 9, 1, 1.6, 1);
      if (t === 5) ev.push(Ev.Snap, 11, 1.2, 0, 0);
      if (t === 6) ev.push(Ev.Snap, 13, 2.2, 0, 0); // once per run
      return {};
    });
    expect(tricks).toEqual(['endSlam', 'snap']);
  });

  it('共振ポンプ: three rising apexes in a row reaching 20 deg', () => {
    const amps = [5, 9, 7, 11, 15, 19, 23, 26];
    const { tricks } = play(byId('3-1'), 20, (t, ev) => {
      if (t < amps.length) ev.push(Ev.Apex, 2 * t, (t % 2 ? -1 : 1) * amps[t]! * DEG, 0, 0);
      return {};
    });
    expect(tricks).toEqual(['resonancePump']);
    const low = play(byId('3-1'), 20, (t, ev) => {
      if (t < 6) ev.push(Ev.Apex, 2 * t, [3, 6, 9, 12, 15, 18][t]! * DEG, 0, 0);
      return {};
    });
    expect(low.tricks).toEqual([]);
  });

  it('追いかけ減衰 (D6): >= 15 deg within the 1.5 s before HoldBegin and the trolley moved >= 2 cm since', () => {
    const L = 1;
    // swinging 18 deg until 1.3 s before the hold, then damped by chasing it (the trolley moves 3 cm)
    const chase = play(byId('1-1'), 200, (t, ev) => {
      if (t === 150) ev.push(Ev.HoldBegin, 300, 0, 0, 0);
      const amp = t < 70 ? 18 : 2;
      return { th: amp * DEG, w: 0, x: 1.5 + 0.03 * Math.sin(t / 5), mode: Mode.Taut };
    });
    expect(chase.tricks).toEqual(['chaseDamp']);
    // the spec's old 8 deg threshold no longer counts: a 12 deg swing settling into the hold is ordinary
    const small = play(byId('1-1'), 200, (t, ev) => {
      if (t === 150) ev.push(Ev.HoldBegin, 300, 0, 0, 0);
      return { th: (t < 70 ? 12 : 2) * DEG, x: 1.5 + 0.03 * Math.sin(t / 5) };
    });
    expect(small.tricks).toEqual([]);
    // the trolley stood still: the swing died on its own
    const still = play(byId('1-1'), 200, (t, ev) => {
      if (t === 150) ev.push(Ev.HoldBegin, 300, 0, 0, 0);
      return { th: (t < 70 ? 18 : 2) * DEG, x: 1.5 };
    });
    expect(still.tricks).toEqual([]);
    expect(amplitudeDeg(12 * DEG, 0, L)).toBeCloseTo(12, 9);
  });

  it('追いかけ減衰 (D6): the big swing must be within 1.5 s of the hold; the move counts only after it', () => {
    // 18 deg until 1.6 s before the hold: too long ago, even though the trolley moved a lot
    const late = play(byId('1-1'), 200, (t, ev) => {
      if (t === 150) ev.push(Ev.HoldBegin, 300, 0, 0, 0);
      return { th: (t < 54 ? 18 : 2) * DEG, x: 1.5 + 0.05 * Math.sin(t / 5) };
    });
    expect(late.tricks).toEqual([]);
    // exactly at the 1.5 s edge (sample 90 ticks before the hold) still counts
    const edge = play(byId('1-1'), 200, (t, ev) => {
      if (t === 150) ev.push(Ev.HoldBegin, 300, 0, 0, 0);
      return { th: (t <= 60 ? 18 : 2) * DEG, x: t <= 60 ? 1.5 : 1.5 + 0.025 };
    });
    expect(edge.tricks).toEqual(['chaseDamp']);
    // inside the window, but the trolley moved before the big swing, then stood still: no chase
    const none = play(byId('1-1'), 200, (t, ev) => {
      if (t === 150) ev.push(Ev.HoldBegin, 300, 0, 0, 0);
      return { th: (t >= 100 && t <= 110 ? 18 : 2) * DEG, x: t < 80 ? 1.4 : 1.5 };
    });
    expect(none.tricks).toEqual([]); // the move happened before the swing
  });
});

describe('badges on success (§7.3)', () => {
  it('紙一重, 一発, 端ドン, パシッ, ブランコ, やさしさ', () => {
    const amps = [5, 9, 14, 21];
    const { tr, s } = play(byId('2-2'), 12, (t, ev) => {
      if (t < amps.length) ev.push(Ev.Apex, 2 * t, amps[t]! * DEG, 0, 0);
      if (t === 5) ev.push(Ev.StopHit, 11, -1, 1.5, 0);
      if (t === 6) ev.push(Ev.Snap, 13, 1.0, 0, 0);
      return { minD2: (0.06 + 0.004) ** 2, peakF: 12.28 };
    });
    expect(tr.badgesOnSuccess(s, true).sort()).toEqual(['buranko', 'hashidon', 'ippatsu', 'kamihitoe', 'pashi', 'yasashisa']);
  });

  it('none for an ordinary run; やさしさ only on levels with gentleN', () => {
    const plain = play(byId('2-2'), 5, () => ({ minD2: 0.1 ** 2, peakF: 40 }));
    expect(plain.tr.badgesOnSuccess(plain.s, false)).toEqual([]);
    const noWalls = play(byId('1-1'), 5, () => ({ minD2: Infinity, peakF: 5 }));
    expect(noWalls.tr.badgesOnSuccess(noWalls.s, false)).toEqual([]);
  });

  it('reset clears everything for the next run', () => {
    const { tr, s } = play(byId('4-2'), 3, (t, ev) => {
      if (t === 1) ev.push(Ev.StopHit, 3, 1, 2, 1);
      return {};
    });
    expect(tr.badgesOnSuccess(s, false)).toEqual(['hashidon']);
    tr.reset();
    expect(tr.badgesOnSuccess(s, false)).toEqual([]);
    const ev = new SimEvents();
    ev.push(Ev.StopHit, 3, 1, 2, 1);
    expect(tr.onTick(state(), ev)).toEqual(['endSlam']); // detectable again after reset
  });
});
