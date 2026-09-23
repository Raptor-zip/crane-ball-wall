// Side view ball fill for skins (skins spec §5.6, §5.9-6). Owner: O7.
// SideOpts.ballFill recolours only the player's ball body (strobe copies and the final ball); undefined or C.ball
// draws exactly today's calls, the egg never changes, and the required-angle illustration keeps C.ball.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import levelsFile from '../../src/data/levels.json';
import type { LevelDef } from '../../src/sim/level';
import { C, SideCam, drawSideView, wideRange } from '../../src/ui/sideview';
import type { SideOpts } from '../../src/ui/sideview';
import { installRecorder, parseColour, recorderOf } from '../render/recorder';

const levels = (levelsFile as unknown as { levels: LevelDef[] }).levels;
const lv = levels.find((l) => l.id === '2-2')!;
const egg = levels.find((l) => l.id === '4-3')!;

let undo: () => void = () => undefined;
beforeAll(() => { undo = installRecorder(); });
afterAll(() => undo());

function draw(level: LevelDef, o: SideOpts): unknown[][] {
  const cv = document.createElement('canvas');
  cv.width = 1200;
  cv.height = 630;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  drawSideView(g, level, new SideCam({ x: 0, y: 0, w: 1200, h: 630 }, wideRange(level)), o);
  return recorderOf(cv).log;
}

const base = (extra: Partial<SideOpts> = {}, isEgg = false): SideOpts => ({
  grid: true, trolleyX: 1.6, ball: { x: 1.63, y: 0.25 }, L: 1,
  strobe: new Float32Array([0, 0.25, 0.4, 0.3, 0.9, 0.7, 1.2, 0.8, 1.63, 0.25]),
  aiPath: new Float32Array([0, 0.25, 0.8, 0.6, 1.63, 0.25]),
  ghost: { x: 1.5, bx: 1.55, by: 0.3 },
  dims: true, reqDeg: [38], gapCm: 2, labels: { m: (v) => `${v} m`, cm: (v) => `${v} cm`, deg: (v) => `${v}°` },
  egg: isEgg, ...extra,
});

describe('drawSideView ballFill', () => {
  it('undefined and C.ball draw the identical call stream', () => {
    const a = draw(lv, base());
    const b = draw(lv, base({ ballFill: C.ball }));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.length).toBeGreaterThan(50);
  });

  /** The recorder logs the whole fill / stroke state with every drawing call; keep only what the call uses. */
  const used = (log: unknown[][]): unknown[][] => log.map((e) => {
    const st = e[e.length - 1] as { f?: unknown; s?: unknown; w?: unknown } | undefined;
    if (!st || typeof st !== 'object' || !('f' in st)) return e;
    const fills = e[0] === 'fill' || e[0] === 'fillRect' || e[0] === 'fillText';
    const rest = fills ? { ...st, s: 0, w: 0 } : { ...st, f: 0 };
    return [...e.slice(0, -1), rest];
  });

  it('another fill changes only the non-egg ball body fills (strobe copies + the final ball)', () => {
    const a = used(draw(lv, base()));
    const c = used(draw(lv, base({ ballFill: '#384354' })));
    expect(c.length).toBe(a.length);
    const red = parseColour(C.ball), steel = parseColour('#384354');
    const diffs: number[] = [];
    a.forEach((e, i) => {
      if (JSON.stringify(e) === JSON.stringify(c[i])) return;
      diffs.push(i);
      expect(e[0]).toBe('fill');
      const sa = e[e.length - 1] as { f: unknown }, sc = c[i]![c[i]!.length - 1] as { f: unknown };
      expect(sa.f).toEqual(red);
      expect(sc.f).toEqual(steel);
      expect({ ...sa, f: 0 }).toEqual({ ...sc, f: 0 });
    });
    expect(diffs.length).toBe(5 + 1); // 5 strobe copies, the final ball
    // The required-angle illustration (its arc, label and faint ball) keeps the meaning colour.
    const redUses = c.filter((e) => JSON.stringify(e).includes(JSON.stringify(red))).length;
    expect(redUses).toBeGreaterThanOrEqual(3);
  });

  it('the egg never follows the ball fill', () => {
    const a = draw(egg, base({}, true));
    const c = draw(egg, base({ ballFill: '#384354' }, true));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });
});
