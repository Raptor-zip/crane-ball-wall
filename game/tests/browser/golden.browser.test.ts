// Cross-engine determinism (GAME_DESIGN.md §10.7, §11 M10): the golden replays and the detmath bit patterns
// must come out exactly as in Node on chromium, firefox and webkit. Owner: O1.
import { describe, expect, it } from 'vitest';
import golden from '../fixtures/golden_replays.json';
import bot11 from '../fixtures/bot_1-1_success.json';
import { atan2k, sincos } from '../../src/sim/detmath';
import { b64urlDecode } from '../../src/sim/b64';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { Status } from '../../src/sim/run';
import { checkGolden, type GoldenFile } from '../sim/golden_check';
import { ATAN2_VECTORS, f64hex, SINCOS_VECTORS } from '../sim/detmath_vectors';
import { fixedLevel } from '../sim/levels_fixed';

describe(`determinism in ${navigator.userAgent}`, () => {
  it('sincos / atan2k reproduce the fixed bit patterns', () => {
    const out = new Float64Array(2);
    const bad: string[] = [];
    for (const [x, s, c] of SINCOS_VECTORS) {
      sincos(x, out);
      if (f64hex(out[0]!) !== s || f64hex(out[1]!) !== c) bad.push(`sincos(${x})`);
    }
    for (const [y, x, want] of ATAN2_VECTORS) if (f64hex(atan2k(y, x)) !== want) bad.push(`atan2k(${y}, ${x})`);
    expect(bad).toEqual([]);
  });

  it('re-simulates the 20 golden replays bit for bit and the bots regenerate them', () => {
    expect(checkGolden(golden as unknown as GoldenFile)).toEqual([]);
  });

  it('clears 1-1 with the bot fixture', () => {
    const { qs } = decodeReplay(b64urlDecode(bot11.replay));
    const r = simulateReplay(fixedLevel('1-1'), qs);
    expect(r.status).toBe(Status.Success);
    expect(r.score).toBe(bot11.score);
    expect(r.stateHash).toBe(bot11.stateHash);
  });
});
