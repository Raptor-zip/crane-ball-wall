// The ghost tags' row above the beam under the HUD's READY pill (ghosts.ts keepOut), and where the wall-height labels
// go (overlays.ts heightLabels): what the audit of the play screens found (tags cut by the pill at 568x320 / in
// practice, "0.75 m" read "5 m" at the left edge of the portrait title). Owner: O5.
import { beforeEach, describe, expect, it } from 'vitest';
import levelsFile from '../../src/data/levels.json';
import type { LevelDef } from '../../src/sim/level';
import { drawGhosts, lastTagRects, resetGhostTags, tagRow1 } from '../../src/render/ghosts';
import { heightLabels } from '../../src/render/overlays';
import type { QuadBatch } from '../../src/render/overlays';
import type { GhostPose } from '../../src/render/renderer';
import { BEAM_TOP } from '../../src/render/crane';

const LEVELS = (levelsFile as unknown as { levels: LevelDef[] }).levels;
const noop = (): void => undefined;
const batch = {
  begin: noop, end: noop, rect: noop, line: noop, quad: noop, icon: noop, label: () => 0,
  atlasShape: () => ({}), atlasLabelAspect: () => 1.2,
} as unknown as QuadBatch;
/** Metres per CSS px at the ghosts (568x320). */
const PX = 1 / 130;
const VIS: [number, number] = [-1, 3];
const ghost = (kind: GhostPose['kind'], label: string, x: number): GhostPose => ({ kind, label, x, bx: x, by: 0.25, slack: false, visible: true });
/** READY: every ghost on the player's trolley at x = 0 (the start pose). */
const START = [ghost('ai', 'AI', 0), ghost('pb', 'PB', 0)];
const draw = (ghosts: GhostPose[], keepOut: [number, number][] | null = null): ReturnType<typeof lastTagRects> => {
  drawGhosts(batch, ghosts, 1, PX, 0, 1, VIS, 0, 0, keepOut);
  return lastTagRects();
};

beforeEach(() => resetGhostTags());

describe('ghost tags under the READY pill (keepOut)', () => {
  it('without one, [AI][PB] sit side by side over the start in the row above the beam', () => {
    const r = draw(START);
    expect(r.map((t) => [t.label, t.row])).toEqual([['AI', 1], ['PB', 1]]);
    expect((Math.min(...r.map((t) => t.x0)) + Math.max(...r.map((t) => t.x1))) / 2).toBeCloseTo(0, 6);
    expect(r[0]!.y0).toBeGreaterThan(BEAM_TOP);
    expect((r[0]!.y0 + r[0]!.y1) / 2).toBeCloseTo(tagRow1(PX).y, 6);
  });

  it('a group under a keep-out range moves to the nearest free side, at most its own width away', () => {
    const r0 = draw(START);
    const w = Math.max(...r0.map((t) => t.x1)) - Math.min(...r0.map((t) => t.x0));
    resetGhostTags();
    // the pill starts just right of the trolley (568x320: the tags' right half was under it)
    const pill: [number, number] = [0.05, 1.1];
    const r = draw(START, [pill]);
    expect(r.map((t) => t.label)).toEqual(['AI', 'PB']);
    expect(Math.max(...r.map((t) => t.x1))).toBeLessThanOrEqual(pill[0] - 0.03 + 1e-9);
    expect(Math.min(...r0.map((t) => t.x0)) - Math.min(...r.map((t) => t.x0))).toBeLessThanOrEqual(w + 1e-9);
    // rows other than 1 and ranges elsewhere change nothing
    resetGhostTags();
    expect(draw(START, [[2, 2.5]])).toEqual(r0);
  });

  it('no room within its width (the chip column on one side, the pill on the other): no tag rather than a cut one', () => {
    const r0 = draw(START);
    const w = Math.max(...r0.map((t) => t.x1)) - Math.min(...r0.map((t) => t.x0));
    resetGhostTags();
    expect(draw(START, [[-1, -w * 0.4], [w * 0.1, 1]])).toEqual([]);
    // one ghost alone (narrower) fits the same gap if it is wide enough for it
    resetGhostTags();
    const one = draw([START[0]!]);
    const w1 = one[0]!.x1 - one[0]!.x0;
    resetGhostTags();
    const r = draw([START[0]!], [[-1, -w1 * 0.8 - 0.06], [w1 * 0.3, 1]]);
    expect(r.map((t) => t.label)).toEqual(['AI']);
    // once the pill is gone (the run started) it is drawn over its trolley again
    expect(draw([START[0]!])[0]!.x0).toBeCloseTo(one[0]!.x0, 6);
  });
});

describe('wall-height labels (heightLabels)', () => {
  const walls = LEVELS.find((l) => l.id === '2-2')!.physics.walls;
  const x0 = Math.min(...walls.map((w) => w.x0));

  it('wide: 0.85 m before the first wall; tall (follow camera): 0.6 m, inside the ~2 m window whenever that wall top is', () => {
    const wide = heightLabels(walls, 130, false);
    const tall = heightLabels(walls, 190, true);
    expect(wide.map((l) => l.text)).toEqual(['0.75 m']);
    expect(wide[0]!.xa).toBeCloseTo(x0 - 0.85, 9);
    expect(tall[0]!.xa).toBeCloseTo(x0 - 0.6, 9);
    // the 2-2 title attract rests on the goal with the window's left edge at about 0.60 m (390x844): it used to
    // start at 0.45 m ("5 m" on screen)
    expect(tall[0]!.xa).toBeGreaterThan(0.6 + 0.05);
    // clear of the wall top (near-miss dimensions) and of the stub at the wall
    expect(tall[0]!.xa + tall[0]!.w).toBeLessThan(tall[0]!.wallX - 0.1);
    expect(tall[0]!.w).toBeCloseTo(tall[0]!.th * 0.6 * 6, 9);
  });

  it('one label per distinct height (5-4 and friends)', () => {
    for (const l of LEVELS) {
      const hs = new Set(l.physics.walls.map((w) => w.h.toFixed(3)));
      expect(heightLabels(l.physics.walls, 130, false), l.id).toHaveLength(hs.size);
    }
  });
});
