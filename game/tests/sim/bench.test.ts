// CPU budget of the verifier (GAME_DESIGN.md §7.8, §10.7): simulateReplay of 5400 substeps (a 45 s ranked run)
// must take <= 5 ms once warm. Owner: O1.
import { describe, expect, it } from 'vitest';
import { b64urlDecode } from '../../src/sim/b64';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { RANKED_MAX_TICKS } from '../../src/sim/constants';
import { Status } from '../../src/sim/run';
import golden from '../fixtures/golden_replays.json';
import type { GoldenFile } from './golden_check';

describe('bench', () => {
  it('simulateReplay: 5400 substeps in <= 5 ms warm', () => {
    const g = golden as unknown as GoldenFile;
    // the 60 s time-up run on 3-3 (two walls, taut the whole time), cut to the ranked maximum of 2700 ticks
    const e = g.replays.find((r) => r.id === '3-3/carry-away')!;
    const phys = g.levels[e.level]!;
    const qs = decodeReplay(b64urlDecode(e.replay)).qs.slice(0, RANKED_MAX_TICKS);
    expect(qs.length).toBe(RANKED_MAX_TICKS);
    const first = simulateReplay(phys, qs);
    expect(first.status).toBe(Status.Running);
    expect(first.ticks * 2).toBe(5400);
    // warm up the JIT like worker/warmup.ts does, then time several runs
    for (let i = 0; i < 30; i++) simulateReplay(phys, qs);
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const r = simulateReplay(phys, qs);
      times.push(performance.now() - t0);
      expect(r.stateHash).toBe(first.stateHash);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    console.info(`bench: 5400 substeps, min ${times[0]!.toFixed(3)} ms, median ${median.toFixed(3)} ms`);
    expect(median).toBeLessThanOrEqual(5);
  });
});
