// Ghost tracks from the bundled AI ghosts (GAME_DESIGN.md §8.2, §8.4, §10.4). Owner: O3.
// Never depends on exact par values (the ghost pipeline rewrites the data files).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import { RAIL_Y } from '../../src/sim/constants';
import {
  ballPath, forceAt, newGhostPose, poseAt, reversed, strobe, trackAndHashFromReplay, trackDuration, trackFromAiGhost, type GhostFileJson,
} from '../../src/core/ghosts';
import { decodeReplay, rankedScore, simulateReplay } from '../../src/sim/replay';
import { b64urlDecode } from '../../src/sim/b64';
import { createRun, Mode, Status, stepTick } from '../../src/sim/run';
import { SimEvents } from '../../src/sim/events';

const levels = (JSON.parse(readFileSync(new URL('../../src/data/levels.json', import.meta.url), 'utf8')) as LevelsFile).levels;
const byId = (id: string): LevelDef => levels.find((l) => l.id === id)!;
const ghostFile = (id: string): GhostFileJson =>
  JSON.parse(readFileSync(new URL(`../../src/data/ghosts/${id}.json`, import.meta.url), 'utf8')) as GhostFileJson;

describe('trackFromAiGhost', () => {
  const ids = readdirSync(new URL('../../src/data/ghosts/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

  it('decodes every bundled ghost into a consistent track', () => {
    expect(ids.length).toBe(18);
    for (const id of ids) {
      const level = byId(id);
      const file = ghostFile(id);
      const L = level.physics.L;
      for (const g of file.ghosts) {
        const t = trackFromAiGhost(g, L, level);
        expect(t.kind).toBe(g.kind);
        expect(t.label).toBe(g.label);
        expect(t.hz).toBe(60);
        expect(t.n).toBe(g.n);
        expect(t.finishSub).toBe(g.parSub);
        expect(t.splitSub.length).toBe(level.splits.length);
        // sample 0 is the level's start pose: trolley at startX, ball hanging below it
        expect(t.x[0]).toBeCloseTo(level.physics.startX, 3);
        expect(t.bx[0]).toBeCloseTo(level.physics.startX, 3);
        expect(t.by[0]).toBeCloseTo(RAIL_Y - L, 3);
        for (let k = 0; k < t.n; k += 7) {
          const dx = t.bx[k]! - t.x[k]!;
          const dy = t.by[k]! - RAIL_Y;
          expect(Math.hypot(dx, dy)).toBeCloseTo(L, 4); // taut string of length L
          expect(Math.abs(t.f[k]!)).toBeLessThanOrEqual(level.physics.Fmax + 0.05);
        }
        // ends at rest in the last zone
        const zone = level.physics.phases.at(-1)!;
        expect(t.bx[t.n - 1]).toBeGreaterThanOrEqual(zone.xa - 1e-3);
        expect(t.bx[t.n - 1]).toBeLessThanOrEqual(zone.xb + 1e-3);
        // the finish (parSub, 120 Hz) lies inside the track (60 Hz) with the 1 s rest padding
        expect(t.finishSub! + 60).toBeLessThanOrEqual(t.n * 2 + 2);
      }
    }
  });

  it('keeps the JSON split times (null -> NaN) in level.splits order', () => {
    const level = byId('5-4');
    const g = ghostFile('5-4').ghosts.find((x) => x.kind === 'ai')!;
    const t = trackFromAiGhost(g, 1, level);
    expect(t.splitSub).toEqual(g.splitSub);
    const withNull = trackFromAiGhost({ ...g, splitSub: [g.splitSub[0]!, null as unknown as number] }, 1, level);
    expect(withNull.splitSub[0]).toBe(g.splitSub[0]);
    expect(Number.isNaN(withNull.splitSub[1])).toBe(true);
    expect(Number.isNaN(withNull.splitSub[2])).toBe(true);
  });
});

describe('poseAt', () => {
  const level = byId('2-2');
  const t = trackFromAiGhost(ghostFile('2-2').ghosts[0]!, 1, level);
  const out = newGhostPose();

  it('interpolates linearly between samples and clamps at both ends', () => {
    poseAt(t, 10 / 60, out);
    expect(out.x).toBeCloseTo(t.x[10]!, 6);
    poseAt(t, 10.5 / 60, out);
    expect(out.x).toBeCloseTo((t.x[10]! + t.x[11]!) / 2, 6);
    expect(out.by).toBeCloseTo((t.by[10]! + t.by[11]!) / 2, 6);
    expect(out.visible).toBe(true);
    expect(out.kind).toBe('ai');
    poseAt(t, -1, out);
    expect(out.x).toBe(t.x[0]);
    poseAt(t, 1e6, out);
    expect(out.x).toBe(t.x[t.n - 1]);
    poseAt(t, Number.NaN, out);
    expect(out.x).toBe(t.x[0]);
  });

  it('forceAt holds the force of each 60 Hz interval', () => {
    expect(forceAt(t, 3.2 / 60)).toBe(t.f[3]);
    expect(forceAt(t, 1e6)).toBe(0);
    expect(trackDuration(t)).toBeCloseTo((t.n - 1) / 60, 12);
  });

  it('ball path and strobe', () => {
    const p = ballPath(t);
    expect(p.length).toBe(2 * t.n);
    expect(p[2 * 5]).toBe(t.bx[5]);
    const s = strobe(t, 60);
    expect(s.length).toBe(2 * 11); // samples 0, 6, ..., 60
    expect(s[2]).toBe(t.bx[6]);
  });
});

describe('reversed (2-3 reverse hint = 2-2 AI in reverse)', () => {
  it('starts where 2-3 starts and ends at the 2-2 start, moving from tick 0', () => {
    const src = trackFromAiGhost(ghostFile('2-2').ghosts.find((g) => g.kind === 'ai')!, 1, byId('2-2'));
    const r = reversed(src);
    expect(r.kind).toBe('reverse_hint');
    expect(r.finishSub).toBeNull();
    expect(r.splitSub.every(Number.isNaN)).toBe(true);
    expect(r.n).toBeLessThan(src.n); // trailing rest trimmed
    expect(r.x[0]).toBeCloseTo(src.x[src.n - 1]!, 4);
    expect(r.x[r.n - 1]).toBeCloseTo(src.x[0]!, 4);
    expect(r.bx[r.n - 1]).toBeCloseTo(src.bx[0]!, 4);
    expect(Math.abs(r.x[0]! - byId('2-3').physics.startX)).toBeLessThan(0.05);
    // it moves right away
    expect(Math.abs(r.x[3]! - r.x[0]!) + Math.abs(r.bx[3]! - r.bx[0]!)).toBeGreaterThan(1e-5);
    // reversing twice is the trimmed track itself
    const rr = reversed(r);
    expect(rr.x[0]).toBeCloseTo(src.x[0]!, 6);
  });
});

describe('trackAndHashFromReplay (the replay viewer, §7.5 item 6)', () => {
  const bot = JSON.parse(readFileSync(new URL('../fixtures/bot_1-1_success.json', import.meta.url), 'utf8')) as { replay: string; score: number; stateHash: number; nTicks: number };
  const level = byId('1-1');

  it('is one simulateReplay: the same result and stateHash as without a recorder (the recorder only reads the state)', () => {
    const built = trackAndHashFromReplay(level, bot.replay, 'wr', 'X');
    const { qs } = decodeReplay(b64urlDecode(bot.replay));
    const plain = simulateReplay(level.physics, qs);
    expect(built.result).toEqual(plain);
    expect(built.stateHash).toBe(plain.stateHash);
    expect(built.stateHash).toBe(bot.stateHash);
    expect(built.nTicks).toBe(bot.nTicks);
    expect(rankedScore(built.nTicks, built.result)).toBe(bot.score);
    expect(built.track.finishSub).toBe(bot.score);
    expect(built.track.n).toBe(bot.nTicks + 1);
    expect(built.header.levelHash).toBe('13e2284e');
    expect(built.phases).toEqual([]);
  });

  it('every sample is the simulator state after that tick (poseAt at k/60 s, float32)', () => {
    const built = trackAndHashFromReplay(level, bot.replay, 'wr', 'X');
    const { qs } = decodeReplay(b64urlDecode(bot.replay));
    const run = createRun(level.physics);
    const ev = new SimEvents();
    const pose = newGhostPose();
    const tr = built.track;
    for (let k = 1; k <= qs.length; k++) {
      stepTick(run, qs[k - 1]!, ev);
      // the samples are the sim's own doubles stored as float32
      expect(tr.x[k]).toBe(Math.fround(run.s.x));
      expect(tr.bx[k]).toBe(Math.fround(run.s.bx));
      expect(tr.by[k]).toBe(Math.fround(run.s.by));
      expect(tr.slack[k]).toBe(run.s.mode === Mode.Slack ? 1 : 0);
      expect(tr.f[k - 1]).toBe(Math.fround(run.s.F));
      // what the viewer draws at t = k/60 s (poseAt interpolates between ticks only)
      poseAt(tr, k / 60, pose);
      expect(pose.x).toBeCloseTo(run.s.x, 6);
      expect(pose.bx).toBeCloseTo(run.s.bx, 6);
      expect(pose.by).toBeCloseTo(run.s.by, 6);
      expect(forceAt(tr, (k - 1 + 0.5) / 60)).toBe(Math.fround(run.s.F));
    }
    expect(run.s.status).toBe(Status.Success);
  });

  it('records when a phase completes (5-4 has two goal zones): the viewer moves the goal on then', () => {
    const golden = JSON.parse(readFileSync(new URL('../fixtures/golden_replays.json', import.meta.url), 'utf8')) as {
      levels: Record<string, LevelDef['physics']>; replays: { id: string; replay: string }[];
    };
    const l54: LevelDef = { ...byId('5-4'), physics: golden.levels['5-4']! };
    const r = golden.replays.find((x) => x.id === '5-4/full-course')!;
    const built = trackAndHashFromReplay(l54, r.replay, 'rival', 'X');
    expect(built.result.status).toBe(Status.Success);
    expect(built.phases).toHaveLength(1);
    expect(built.phases[0]!.index).toBe(0);
    // the first zone is done well before the finish (the hold of the second zone starts at score)
    expect(built.phases[0]!.t).toBeGreaterThan(0);
    expect(built.phases[0]!.t).toBeLessThan(built.result.score! / 120);
  });
});
