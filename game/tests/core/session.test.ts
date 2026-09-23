// The run session on the real simulator (GAME_DESIGN.md §4.6-§4.8, §7.2, §7.6, §9.5, §10.7). Owner: O3.
// Never depends on exact par values (the ghost pipeline rewrites the data files).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../src/core/bus';
import { STOP_FX_MIN_SPEED, createSession } from '../../src/core/session';
import { createGameData } from '../../src/core/data';
import { medalFor } from '../../src/core/progress';
import { trackFromReplay } from '../../src/core/ghosts';
import { challengeUrl, parseHash, resolveLink } from '../../src/core/links';
import goldenFile from '../fixtures/golden_replays.json';
import { servoQ } from '../../src/input/servo';
import { Mode, Status } from '../../src/sim/run';
import { Ev } from '../../src/sim/events';
import { decodeReplay, simulateReplay, DeviceTag, ReplayFlag } from '../../src/sim/replay';
import { b64urlDecode } from '../../src/sim/b64';
import type { LevelDef } from '../../src/sim/level';

const data = createGameData();
const L = (id: string): LevelDef => data.level(id)!;

// O1's golden replays depend on the physics only (never on the AI ghost files, which the pipeline rewrites).
const golden = (goldenFile as unknown as { replays: { id: string; level: string; replay: string; expect: { status: number; score: number | null } }[] }).replays;
const goldenQs = (id: string): number[] => Array.from(decodeReplay(b64urlDecode(golden.find((r) => r.id === id)!.replay)).qs);
/** 2-2 success over wall A into the pocket (the recorded research plan + a fine servo). */
const SUCCESS_22 = '2-2/ai-open-loop';

function runOpenLoop(level: LevelDef, qs: number[], emit: (e: GameEvent) => void = () => {}) {
  const ai = data.track(level, 'ai');
  const s = createSession(level, { emit, compare: () => ai });
  let st: Status = Status.Ready;
  const touch = { intent: { kind: 'idle' as const }, fine: false, device: DeviceTag.Touch, targetX: null };
  for (let i = 0; i < qs.length; i++) {
    st = s.tick(qs[i] === 0 && i === 0 ? 1 : qs[i]!, touch);
    if (s.started && st !== Status.Running) return s;
  }
  return s;
}

describe('READY / tick 0 (§4.7)', () => {
  it('stays READY and silent while q == 0; the first q != 0 is tick 0', () => {
    const ev: GameEvent[] = [];
    const s = createSession(L('1-2'), { emit: (e) => ev.push(e) });
    for (let i = 0; i < 10; i++) expect(s.tick(0)).toBe(Status.Ready);
    expect([s.started, s.ticks, ev.length]).toEqual([false, 0, 0]);
    expect(s.tick(5)).toBe(Status.Running);
    expect([s.started, s.ticks]).toEqual([true, 1]);
    expect(ev.map((e) => e.t)).toEqual(['runStart']);
    expect(Array.from(s.replayQs())).toEqual([5]);
    s.tick(0);
    expect(Array.from(s.replayQs())).toEqual([5, 0]); // zeros after tick 0 are recorded
  });

  it('retry resets in place and replays deterministically', () => {
    const lv = L('2-2');
    const qs = goldenQs(SUCCESS_22);
    const a = runOpenLoop(lv, qs);
    const r1 = a.result()!;
    const rep1 = a.replay();
    a.retry();
    expect([a.started, a.ticks, a.status(), a.result()]).toEqual([false, 0, Status.Ready, null]);
    expect(a.replay()).toBeNull();
    for (let i = 0; i < qs.length && a.status() <= Status.Running; i++) a.tick(qs[i] || (i === 0 ? 1 : 0));
    const b = runOpenLoop(lv, qs);
    expect(b.result()).toEqual(r1);
    expect(b.replay()).toBe(rep1);
  });
});

describe('events -> bus (§9.5, §10.3)', () => {
  it('2-2 golden success: wall crossing with its gap, a split vs the AI, hold, success', () => {
    const lv = L('2-2');
    const ev: GameEvent[] = [];
    const s = runOpenLoop(lv, goldenQs(SUCCESS_22), (e) => ev.push(e));
    const res = s.result()!;
    expect(res.status).toBe(Status.Success);
    expect(res.score).toBe(golden.find((r) => r.id === SUCCESS_22)!.expect.score);
    const cross = ev.find((e) => e.t === 'cross' && e.wall === 0 && e.dir === 1) as Extract<GameEvent, { t: 'cross' }>;
    expect(cross).toBeTruthy();
    // the plan passes over wall A with about 2 cm (a "ギリギリ" near miss); the run's minimum is never larger
    expect(cross.gapMm).toBeGreaterThan(5);
    expect(cross.gapMm).toBeLessThan(40);
    expect(res.gapMm).toBeLessThanOrEqual(cross.gapMm);
    expect(cross.speed).toBeGreaterThan(0);
    const split = ev.find((e) => e.t === 'split') as Extract<GameEvent, { t: 'split' }>;
    expect(split).toMatchObject({ index: 0, vs: 'ai' });
    // delta = my split substep - the AI ghost's split substep (whatever the pipeline's current AI is)
    expect(split.deltaSub).toBe(res.splits[0]! - data.track(lv, 'ai')!.splitSub[0]!);
    expect(ev.indexOf(split)).toBeGreaterThan(ev.indexOf(cross));
    expect(ev.some((e) => e.t === 'holdStart')).toBe(true);
    expect(ev.some((e) => e.t === 'apex')).toBe(true);
    for (const e of ev) if (e.t === 'apex') expect(e.ampDeg).toBeGreaterThan(3);
    // results
    expect(res.score).toBeGreaterThan(0);
    expect(res.gapMm).toBeGreaterThanOrEqual(0);
    expect(res.splits[0]).toBeGreaterThan(0);
    expect(res.peakF).toBeLessThanOrEqual(40 + 1e-9);
    expect(s.holdFrac()).toBe(1);
  });

  it('2-2 golden pump run hits wall A: crash event with kind, wall, contact point and overlap', () => {
    const lv = L('2-2');
    const ev: GameEvent[] = [];
    const s = runOpenLoop(lv, goldenQs('2-2/pump'), (e) => ev.push(e));
    const res = s.result()!;
    expect(res.status).toBe(Status.Crash);
    const crash = ev.find((e) => e.t === 'crash') as Extract<GameEvent, { t: 'crash' }>;
    expect(crash).toMatchObject({ kind: 1, wall: 0 });
    expect(crash.overlapMm).toBeCloseTo((0.06 - Math.sqrt(res.crash!.d2)) * 1000, 9);
    expect(crash.overlapMm).toBeGreaterThan(0);
    expect([crash.x, crash.y]).toEqual([res.crash!.px, res.crash!.py]);
    expect(ev.at(-1)!.t === 'crash' || ev.at(-1)!.t === 'saturate').toBe(true);
    expect(res.gapMm).toBeLessThan(0);
  });

  it('near-miss slow-mo: requested once per wall pass while the gap shrinks below 20 mm, re-armed after leaving', () => {
    // a wall 40 mm in front of the hanging ball; creep towards it, back off > 10 cm, creep in again
    const base = L('1-2');
    const lv: LevelDef = { ...base, physics: { ...base.physics, walls: [{ x0: 0.1, x1: 0.2, h: 0.5 }] } };
    let slowmo = 0;
    const s = createSession(lv, { emit: () => {}, onSlowMo: () => slowmo++ });
    const gaps: number[] = [];
    const drive = (x: number, ticks: number): void => {
      const f = { intent: { kind: 'target' as const, x }, fine: true, device: DeviceTag.Keyboard, targetX: x };
      for (let i = 0; i < ticks && s.status() <= Status.Running; i++) {
        s.tick(servoQ(f, s.run.s, lv.physics, false) || 1, f);
        gaps.push(s.nearGapMm() ?? Infinity);
      }
    };
    drive(0.013, 240);
    expect(s.status(), `min gap ${Math.min(...gaps)}`).toBe(Status.Running);
    const minGap1 = Math.min(...gaps);
    expect(minGap1).toBeLessThan(20);
    expect(slowmo).toBe(1); // the gap kept shrinking for many ticks, but one pass = one slow-mo
    drive(-0.3, 240);       // leave the wall (> 10 cm)
    expect(Math.max(...gaps.slice(-60))).toBeGreaterThan(100);
    expect(slowmo).toBe(1);
    drive(0.013, 240);      // a new pass
    expect(slowmo).toBe(2);
  });

  it('saturation: on after 3 ticks of |q| = 127, off when released', () => {
    const ev: GameEvent[] = [];
    const s = createSession(L('1-1'), { emit: (e) => ev.push(e) });
    s.tick(127);
    s.tick(127);
    expect(ev.filter((e) => e.t === 'saturate')).toEqual([]);
    s.tick(127);
    expect(ev.filter((e) => e.t === 'saturate')).toEqual([{ t: 'saturate', on: true }]);
    expect(s.saturated()).toBe(true);
    s.tick(100);
    expect(ev.filter((e) => e.t === 'saturate')).toEqual([{ t: 'saturate', on: true }, { t: 'saturate', on: false }]);
  });

  it('crash into the beam / wall on 1-2 at full force', () => {
    const ev: GameEvent[] = [];
    const s = createSession(L('1-2'), { emit: (e) => ev.push(e) });
    let st: Status = Status.Ready;
    for (let i = 0; i < 600 && st <= Status.Running; i++) st = s.tick(127);
    expect(st).toBe(Status.Crash);
    const c = ev.find((e) => e.t === 'crash')!;
    expect(c).toBeTruthy();
    expect(s.result()).toMatchObject({ status: Status.Crash, score: null });
    expect(s.result()!.crash).not.toBeNull();
    s.tick(0);
    expect(s.status()).toBe(Status.Crash); // frozen until retry
  });

  it('time-up reports why it did not succeed', () => {
    const ev: GameEvent[] = [];
    const s = createSession(L('1-1'), { emit: (e) => ev.push(e) });
    s.tick(1); // start, then leave it hanging at the start (outside the pad)
    let st: Status = Status.Running;
    while (st === Status.Running) st = s.tick(0);
    expect(st).toBe(Status.Timeout);
    expect(ev.at(-1)).toMatchObject({ t: 'timeout', reason: 'zone' });
    expect(s.result()!.timeout).toMatchObject({ reason: 'zone' });
    expect(s.ticks).toBe(3600);
  });
});

describe('end-stop feedback (D5)', () => {
  /** Runs 1-1 with q(t); per tick: the emitted GameEvents and the sim's StopHits (speed, c, taut before). */
  function stops(q: (t: number) => number, ticks: number) {
    const out: { t: number; ev: GameEvent[]; hits: { b: number; c: number }[]; tautBefore: boolean }[] = [];
    let cur: GameEvent[] = [];
    const s = createSession(L('1-1'), { emit: (e) => cur.push(e) });
    for (let t = 0; t < ticks && s.status() <= Status.Running; t++) {
      cur = [];
      const tautBefore = s.run.s.mode === Mode.Taut;
      s.tick(q(t) || (t === 0 ? 1 : 0));
      const hits: { b: number; c: number }[] = [];
      for (let k = 0; k < s.events.n; k++) if (s.events.kind[k] === Ev.StopHit) hits.push({ b: s.events.b[k]!, c: s.events.c[k]! });
      out.push({ t, ev: cur, hits, tautBefore });
    }
    return out;
  }

  it('a stop that throws the ball off a taut string emits stop + slack; a taut stop only stop', () => {
    const ticks = stops((t) => (t < 5 ? -127 : 0), 120); // a flick to the left: the trolley slams into x_min
    const slackStop = ticks.find((k) => k.hits.some((h) => h.c === 0 && h.b >= STOP_FX_MIN_SPEED) && k.tautBefore)!;
    expect(slackStop).toBeTruthy();
    const kinds = slackStop.ev.map((e) => e.t);
    expect(kinds).toContain('stop');
    expect(kinds.indexOf('slack')).toBeGreaterThan(kinds.indexOf('stop'));
    const sl = slackStop.ev.find((e) => e.t === 'slack') as Extract<GameEvent, { t: 'slack' }>;
    expect(Number.isFinite(sl.x) && Number.isFinite(sl.y)).toBe(true);
    const tautStop = ticks.find((k) => k.hits.some((h) => h.c === 1 && h.b >= STOP_FX_MIN_SPEED))!;
    expect(tautStop).toBeTruthy();
    expect(tautStop.ev.filter((e) => e.t === 'stop')).toHaveLength(1);
    expect(tautStop.ev.some((e) => e.t === 'slack')).toBe(false);
  });

  it('bumps slower than 0.1 m/s are silent', () => {
    const ticks = stops((t) => (t < 400 ? -127 : 0), 430);
    const slow = ticks.filter((k) => k.hits.length > 0 && k.hits.every((h) => h.b < STOP_FX_MIN_SPEED));
    expect(slow.length).toBeGreaterThan(0);
    for (const k of slow) expect(k.ev.some((e) => e.t === 'stop' || e.t === 'slack')).toBe(false);
  });

  it('a stop during slack flight does not announce the slack a second time', () => {
    const ticks = stops((t) => (t < 20 ? 127 : 0), 60);
    const flight = ticks.find((k) => k.hits.some((h) => h.c === 0) && (!k.tautBefore || k.ev.some((e) => e.t === 'slack')))!;
    expect(flight).toBeTruthy();
    expect(flight.ev.some((e) => e.t === 'stop')).toBe(true);
    expect(flight.ev.filter((e) => e.t === 'slack').length).toBeLessThanOrEqual(1);
    if (!flight.tautBefore) expect(flight.ev.some((e) => e.t === 'slack')).toBe(false);
  });
});

describe('replays (§10.4) and challenge ghosts (M11)', () => {
  it('the recorded replay re-simulates to the same result; device and flags are stamped', () => {
    const lv = L('2-2');
    const s = runOpenLoop(lv, goldenQs(SUCCESS_22));
    const res = s.result()!;
    const b64 = s.replay()!;
    const { h, qs } = decodeReplay(b64urlDecode(b64));
    expect(h.nTicks).toBe(res.ticks);
    expect(h.levelHash).toBe(data.hash(lv));
    expect(h.device).toBe(DeviceTag.Touch);
    expect(h.flags & ReplayFlag.Practice).toBe(0);
    const r = simulateReplay(lv.physics, qs);
    expect(r.status).toBe(res.status);
    expect(r.score).toBe(res.score);
  });

  it('a challenge link round trip yields a ghost whose run has the same stateHash', () => {
    const lv = L('2-2');
    const s = runOpenLoop(lv, goldenQs(SUCCESS_22));
    const b64 = s.replay()!;
    const link = parseHash(new URL(challengeUrl('https://y.example', lv.id, b64)).hash);
    const resolved = resolveLink(link, {
      findLevel: (id) => data.level(id),
      replayLevelHash: (x) => decodeReplay(b64urlDecode(x)).h.levelHash,
      levelHash: (p) => data.hash({ physics: p } as LevelDef),
    });
    expect(resolved).toMatchObject({ kind: 'challenge', stale: false, replay: b64 });
    const ghost = trackFromReplay(lv, (resolved as { replay: string }).replay, 'challenge', '挑戦状');
    expect(ghost.finishSub).toBe(s.result()!.score);
    expect(ghost.n).toBe(s.ticks + 1);
    const own = s.track();
    expect(Array.from(ghost.bx)).toEqual(Array.from(own.bx));
    expect(ghost.splitSub).toEqual(s.result()!.splits);
    const original = simulateReplay(lv.physics, s.replayQs());
    const again = simulateReplay(lv.physics, decodeReplay(b64urlDecode((resolved as { replay: string }).replay)).qs);
    expect(again.stateHash).toBe(original.stateHash);
  });
});

describe('bot_1-1_success.json through the session (§10.7)', () => {
  const f = JSON.parse(readFileSync(new URL('../fixtures/bot_1-1_success.json', import.meta.url), 'utf8')) as {
    levelId: string; replay?: string; qs?: number[]; score?: number;
  };

  it('succeeds with a medal', () => {
    const lv = L(f.levelId ?? '1-1');
    const qs = f.qs ?? Array.from(decodeReplay(b64urlDecode(f.replay!)).qs);
    const ev: GameEvent[] = [];
    const s = createSession(lv, { emit: (e) => ev.push(e) });
    let st: Status = Status.Ready;
    for (const q of qs) st = s.tick(q);
    expect(st).toBe(Status.Success);
    const res = s.result()!;
    if (f.score !== undefined) expect(res.score).toBe(f.score);
    const m = medalFor(res.score!, data.parSub(lv));
    expect(m.medal).toBeGreaterThanOrEqual(1);
    expect(ev[0]).toEqual({ t: 'runStart' });
    expect(ev.some((e) => e.t === 'holdStart')).toBe(true);
    expect(s.replay()).not.toBeNull();
  });
});

describe('practice rewind (§3.5)', () => {
  it('goes back 5 s through the ring; the rewound run has no replay', () => {
    const lv = L('1-1');
    const s = createSession(lv);
    s.practice = true;
    expect(s.rewind(0)).toBe(false); // allocates the ring (READY)
    for (let i = 0; i < 400; i++) s.tick(i < 20 ? 50 : 0);
    expect(s.status()).toBe(Status.Running);
    const xAt = (t: number): number => s.track().x[t]!;
    const x100 = xAt(100);
    expect(s.rewind(5)).toBe(true);
    expect(s.ticks).toBe(100);
    expect(s.run.s.x).toBeCloseTo(x100, 5);
    expect(s.recorder.n).toBe(101);
    expect(s.replay()).toBeNull();
    s.tick(0);
    expect(s.ticks).toBe(101);
    const plain = createSession(lv);
    expect(plain.rewind(5)).toBe(false); // not in practice
  });

  it('forgets the splits reached after the rewind point (they can be reached again)', () => {
    const lv = L('2-2');
    const qs = goldenQs(SUCCESS_22);
    const ref = runOpenLoop(lv, qs);
    const cross = ref.result()!.splits[0]!;
    expect(Number.isFinite(cross)).toBe(true);
    const ev: GameEvent[] = [];
    const ai = data.track(lv, 'ai');
    const s = createSession(lv, { emit: (e) => ev.push(e), compare: () => ai });
    s.practice = true;
    s.rewind(0);
    const crossTick = Math.ceil(cross / 2);
    for (let i = 0; i < crossTick + 30; i++) s.tick(qs[i] || (i === 0 ? 1 : 0));
    expect(Number.isFinite(s.recorder.splits()[0]!)).toBe(true);
    expect(s.rewind(1)).toBe(true); // back to 30 ticks ago: before the crossing
    expect(Number.isNaN(s.recorder.splits()[0]!)).toBe(true);
    const splitsBefore = ev.filter((e) => e.t === 'split').length;
    for (let i = s.ticks; i < crossTick + 30; i++) s.tick(qs[i] ?? 0);
    expect(ev.filter((e) => e.t === 'split').length).toBe(splitsBefore + 1); // reached again, announced again
    expect(s.recorder.splits()[0]).toBe(cross);
  });

  it('can rewind a run that just crashed: it runs again from 5 s before', () => {
    const lv = L('1-2');
    const s = createSession(lv);
    s.practice = true;
    s.rewind(0);
    let st: Status = Status.Ready;
    for (let i = 0; i < 600 && st <= Status.Running; i++) st = s.tick(127);
    expect(st).toBe(Status.Crash);
    const t = s.ticks;
    expect(s.rewind(5)).toBe(true);
    expect(s.status()).toBe(Status.Running);
    expect(s.result()).toBeNull();
    expect(s.run.s.crash).toBeNull();
    expect(s.ticks).toBe(Math.max(0, t - 300));
    expect(s.tick(0)).toBe(Status.Running);
    const plain = createSession(lv);
    for (let i = 0; i < 600 && plain.status() <= Status.Running; i++) plain.tick(127);
    plain.practice = false;
    expect(plain.rewind(5)).toBe(false);
  });
});
