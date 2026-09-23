// stepTick allocates nothing once optimised (GAME_DESIGN.md §10.4, §12.1 "アロケーションしないループ"). Owner: O1.
//
// Node has no allocation counter, so this watches the young generation: over 20 passes of the 20 mixed golden runs
// (~150k ticks; a mix, so rarely taken branches such as the crash paths get type feedback too) there must be no
// minor GC and the new-space usage may grow only by what the once-per-run paths (resetRun, a crash, a rail stop)
// allocate. A per-substep allocation of even one HeapNumber (16 B) adds ~5 MB here and fails. An unrelated GC
// that happens to fall into the window only makes the attempt inconclusive, so it is retried.
import { constants, PerformanceObserver } from 'node:perf_hooks';
import { getHeapSpaceStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { b64urlDecode } from '../../src/sim/b64';
import { SimEvents } from '../../src/sim/events';
import { decodeReplay } from '../../src/sim/replay';
import { createRun, resetRun, stepTick, type Run } from '../../src/sim/run';
import golden from '../fixtures/golden_replays.json';
import type { GoldenFile } from './golden_check';

const g = golden as unknown as GoldenFile;
const runs: { run: Run; qs: Int8Array }[] = g.replays.map((e) => ({
  run: createRun(g.levels[e.level]!),
  qs: decodeReplay(b64urlDecode(e.replay)).qs,
}));
const ev = new SimEvents();
const step = stepTick; // a local binding: no module-runner getter in the loop
const reset = resetRun;

function pass(): number {
  let n = 0;
  for (let j = 0; j < runs.length; j++) {
    const { run, qs } = runs[j]!;
    reset(run);
    for (let i = 0; i < qs.length; i++) {
      if (step(run, qs[i]!, ev) !== 1) break; // 1 = Status.Running
      n++;
    }
  }
  return n;
}

function newSpaceUsed(): number {
  return getHeapSpaceStatistics().find((s) => s.space_name === 'new_space')!.space_used_size;
}

describe('allocation', () => {
  it('stepTick allocates nothing once optimised (mixed golden runs, ~150k ticks)', async () => {
    for (let i = 0; i < 60; i++) pass(); // warm up to the optimising tier
    const attempts: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      let minor = 0;
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if ((e as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
        }
      });
      obs.observe({ entryTypes: ['gc'] });
      const before = newSpaceUsed();
      let ticks = 0;
      for (let i = 0; i < 20; i++) ticks += pass();
      const grew = newSpaceUsed() - before;
      await new Promise((r) => setTimeout(r, 20)); // let the gc entries arrive
      obs.disconnect();
      attempts.push(`${ticks} ticks: ${minor} minor GC, new space +${(grew / 1024).toFixed(0)} KB`);
      if (minor === 0) {
        expect(ticks).toBeGreaterThan(100_000);
        // resetRun and the crash / rail-stop paths box a few numbers once per run: a few KB per pass
        expect(grew, attempts.join('; ')).toBeLessThan(512 * 1024);
        return;
      }
    }
    expect.fail(`a minor GC in every attempt (the loop allocates): ${attempts.join('; ')}`);
  }, 60_000);
});
