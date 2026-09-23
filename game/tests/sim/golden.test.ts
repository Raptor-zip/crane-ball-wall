// Golden replays in Node (GAME_DESIGN.md §10.7) + the 1-1 bot fixture. Owner: O1.
//
//   npm run golden:update   (GOLDEN_UPDATE=1) rewrites tests/fixtures/golden_replays.json and
//                           tests/fixtures/bot_1-1_success.json from the bots. Do this only for an intended
//                           simulation change, and bump SIM_VERSION when results change (§4, §7.8).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { b64urlDecode } from '../../src/sim/b64';
import { SIM_VERSION } from '../../src/sim/constants';
import { levelHash, type LevelsFile } from '../../src/sim/level';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { Status } from '../../src/sim/run';
import levelsJson from '../../src/data/levels.json';
import plans from '../fixtures/plans_py.json';
import { bangBang, qOfForce, runBot, servoTarget } from './bots';
import {
  botReplay, checkGolden, expectOf, GOLDEN_BOTS, replayText, type GoldenEntry, type GoldenFile,
} from './golden_check';
import { fixedLevel } from './levels_fixed';

const GOLDEN_PATH = fileURLToPath(new URL('../fixtures/golden_replays.json', import.meta.url));
const BOT11_PATH = fileURLToPath(new URL('../fixtures/bot_1-1_success.json', import.meta.url));
const UPDATE = process.env.GOLDEN_UPDATE === '1';

interface Plan { name: string; T: number; N: number; dt: number; U: number[] }
const planByName = (n: string): Plan => {
  const p = (plans as { plans: Plan[] }).plans.find((x) => x.name === n);
  if (!p) throw new Error(`plans_py.json has no ${n}`);
  return p;
};
/** The plan force held on [t_k, t_k+1), sampled at the middle of 60 Hz tick k and quantised. */
const planQ = (p: Plan, k: number): number => qOfForce(p.U[Math.min(p.N - 1, Math.floor((k + 0.5) / 60 / p.dt))]!, 40);

/** Recorded inputs: the research planner's forces played open loop, then the fine servo with the assist. */
function recorded(id: string): Int8Array {
  if (id === '2-2/ai-open-loop') {
    const p = fixedLevel('2-2');
    const ai = planByName('2-2/ai');
    const n = Math.round(ai.T * 60);
    return runBot(p, (s, k) => (k < n ? planQ(ai, k) : servoTarget(s, p, 1.63, true, true)), 1800);
  }
  if (id === '5-4/full-course') {
    const p = fixedLevel('5-4');
    const ai = planByName('2-2/ai');
    const esc = planByName('escape_fast');
    const nIn = Math.round(ai.T * 60);
    const nOut = Math.round(esc.T * 60);
    let k1 = -1;
    return runBot(p, (s, k) => {
      if (s.phase === 0) return k < nIn ? planQ(ai, k) : servoTarget(s, p, 1.63, true, true);
      if (k1 < 0) k1 = k;
      return k - k1 < nOut ? planQ(esc, k - k1) : servoTarget(s, p, 0, true, true);
    }, 3600);
  }
  throw new Error(`no recorder for ${id}`);
}

function loadGolden(): GoldenFile | null {
  return existsSync(GOLDEN_PATH) ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenFile) : null;
}

function buildGolden(old: GoldenFile | null): GoldenFile {
  const levels: GoldenFile['levels'] = {};
  const replays: GoldenEntry[] = [];
  for (const def of GOLDEN_BOTS) {
    const phys = fixedLevel(def.level);
    levels[def.level] = phys;
    let qs = botReplay(def, phys);
    if (!qs) {
      const prev = old?.replays.find((e) => e.id === def.id);
      if (prev) qs = decodeReplay(b64urlDecode(prev.replay)).qs;
      else qs = recorded(def.id);
    }
    replays.push({ id: def.id, level: def.level, bot: def.bot, maxTicks: def.maxTicks, replay: replayText(phys, qs), expect: expectOf(phys, qs) });
  }
  return {
    format: 1,
    sim: SIM_VERSION,
    about: 'Golden replays (GAME_DESIGN.md §10.7): 20 deterministic-bot runs on 6 levels. replay = b64url(encodeReplay); '
      + 'expect = simulateReplay summary (floats as IEEE-754 hex, stateHash = FNV-1a of every event and the final state). '
      + 'Must be identical in Node, chromium, firefox, webkit and workerd. Regenerate with npm run golden:update.',
    levels,
    replays,
  };
}

/** Grid search of the bang-bang opening for the fastest clear of 1-1 (deterministic). */
function search11(): { a: number; b: number; qs: Int8Array; score: number } {
  const p = fixedLevel('1-1');
  let best: { a: number; b: number; qs: Int8Array; score: number } | null = null;
  for (let a = 5; a <= 60; a++) {
    for (let b = 0; b <= 60; b++) {
      const qs = runBot(p, bangBang(a, b)(p), 900);
      const r = simulateReplay(p, qs);
      if (r.status === Status.Success && (!best || r.score! < best.score)) best = { a, b, qs, score: r.score! };
    }
  }
  if (!best) throw new Error('no bang-bang opening clears 1-1');
  return best;
}

if (UPDATE) {
  describe('golden:update', () => {
    it('rewrites golden_replays.json and bot_1-1_success.json', () => {
      const g = buildGolden(loadGolden());
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(g, null, 1)}\n`);
      const best = search11();
      const p = fixedLevel('1-1');
      const res = simulateReplay(p, best.qs);
      const fixture = {
        format: 1,
        about: 'A q sequence (60 Hz ticks) that clears level 1-1, made by the deterministic bot of tests/sim/bots.ts: '
          + `bangBang(${best.a}, ${best.b}) = q +127 for ${best.a} ticks, -127 for ${best.b} ticks, then the fine servo with the `
          + 'anti-sway assist holding the trolley (grid search a 5..60, b 0..60 for the best score). '
          + 'replay = b64url(encodeReplay) with device 0 and no flags. Owner: O1 (npm run golden:update).',
        levelId: '1-1',
        levelHash: levelHash(p),
        sim: SIM_VERSION,
        physics: p,
        bot: `bangBang(${best.a}, ${best.b})`,
        replay: replayText(p, best.qs),
        nTicks: best.qs.length,
        score: res.score,
        timeS: res.score! / 120,
        stateHash: res.stateHash,
        qs: Array.from(best.qs),
      };
      writeFileSync(BOT11_PATH, `${JSON.stringify(fixture, null, 1)}\n`);
      expect(checkGolden(g)).toEqual([]);
    }, 120_000);
  });
} else {
  describe('golden replays (Node)', () => {
    const g = loadGolden();
    it('exists', () => {
      expect(g, 'run npm run golden:update').not.toBeNull();
    });
    it('re-simulates all 20 replays bit-identically and the bots regenerate them', () => {
      expect(checkGolden(g!)).toEqual([]);
    });
    it('covers the interesting paths (success, every crash kind but the floor, time-up, every event kind)', () => {
      const statuses = new Set(g!.replays.map((e) => e.expect.status));
      expect(statuses).toEqual(new Set([Status.Running, Status.Success, Status.Crash, Status.Timeout]));
      const crashKinds = new Set(g!.replays.filter((e) => e.expect.crash).map((e) => e.expect.crash!.kind));
      for (const k of [1, 2, 3, 5]) expect(crashKinds.has(k), `crash kind ${k}`).toBe(true);
      const ev = (k: number): number => g!.replays.reduce((n, e) => n + (e.expect.events[String(k)] ?? 0), 0);
      for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) expect(ev(k), `event ${k}`).toBeGreaterThan(0);
    });
  });

  describe('bot_1-1_success.json', () => {
    const f = JSON.parse(readFileSync(BOT11_PATH, 'utf8')) as {
      levelId: string; levelHash: string; physics: typeof levelsJson.levels[0]['physics']; replay: string; nTicks: number; score: number; qs: number[]; stateHash: number;
    };
    it('clears 1-1 with the stored score', () => {
      const { h, qs } = decodeReplay(b64urlDecode(f.replay));
      expect(Array.from(qs)).toEqual(f.qs);
      expect(h.nTicks).toBe(f.nTicks);
      expect(qs[0]).not.toBe(0); // tick 0 is the first non-zero q (§4.7)
      const r = simulateReplay(fixedLevel('1-1'), qs);
      expect(r.status).toBe(Status.Success);
      expect(r.score).toBe(f.score);
      expect(r.ticks).toBe(f.nTicks);
      expect(r.stateHash).toBe(f.stateHash);
    });
    it('matches the current 1-1 of levels.json', () => {
      const l11 = (levelsJson as unknown as LevelsFile).levels.find((l) => l.id === '1-1')!;
      expect(levelHash(l11.physics)).toBe(f.levelHash);
      const r = simulateReplay(l11.physics, Int8Array.from(f.qs));
      expect(r.status).toBe(Status.Success);
    });
  });
}
