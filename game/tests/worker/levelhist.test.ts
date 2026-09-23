// The level rules of decide() (§7.8 step 6, GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」) as pure tables. Owner: O9.
// A 1-1-like crowd of 500 counted players: the top 100 at 400..598 (cutoff 598), then a long tail to ~26 s.
import { describe, expect, it } from 'vitest';
import { BOARD_TOP_N, HIST_BINS, MAX_RANKED_T120, type SubmitResult } from '../../src/shared/api';
import { LEVEL_HIST_BINS, estimateLevelRank, levelBin, levelPct, stampKind } from '../../src/shared/rank';
import { runFingerprint } from '../../worker/dup';
import type { TopRow } from '../../worker/db';
import { decide, type BoardState, type Decision, type DecideInput } from '../../worker/routes/submit';

const KEY = 'L:1-1:13e2284e:s1';
const NOW = 1_800_000_000_000;
const PAR = 700;
const ME = 'e000000000000001';
const REPLAY = new Uint8Array([1, 2, 3]);

const crowdPidh = (i: number): string => `c${String(i).padStart(15, '0')}`;
/** 500 sorted times: 100 at 400 + 2i, then 400 spread to ~26 s (denser near the cutoff, like 1-1). */
const TIMES: number[] = [
  ...Array.from({ length: 100 }, (_, i) => 400 + 2 * i),
  ...Array.from({ length: 400 }, (_, j) => 600 + Math.floor((j + 1) ** 1.5 / 4)),
];
const CUTOFF = TIMES[BOARD_TOP_N - 1]!;
const TOP: TopRow[] = TIMES.slice(0, BOARD_TOP_N).map((t, i) => [crowdPidh(i), i, t, -1, 1, 1_000_000 + i]);

function histOf(times: readonly number[]): number[] {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  for (const t of times) h[levelBin(t)]! += 1;
  return h;
}

/**
 * The board as the server reads it. `counted`: my plays.t120 (then I am in the histogram too: 501 players);
 * `topAt`: my row replaces the crowd row with that time in `top` (I am that counted player).
 */
function board(opts: { counted?: number | null; topAt?: number } = {}): BoardState {
  const top = TOP.map((r) => [...r] as TopRow);
  const times = [...TIMES];
  if (opts.topAt !== undefined) {
    const i = top.findIndex((r) => r[2] === opts.topAt);
    top[i]![0] = ME;
  } else if (opts.counted !== undefined && opts.counted !== null) {
    times.push(opts.counted);
  }
  return { exists: true, ver: 5, top, n: times.length, cleared: 0, aiBeaten: 40, hist: histOf(times) };
}

function input(t120: number, over: Partial<DecideInput> = {}): DecideInput {
  return {
    kind: 'L', board: KEY, par: PAR, lite: false, soft: false, now: NOW, pidh: ME, nameSeed: 7, device: 1,
    t120, gapUm: null, peakCn: 1000, replay: REPLAY, fp: null, prev: undefined,
    state: board(), own: null, play: null, ...over,
  };
}

/** The answer the shared estimator gives for time t (own removed), as decide() builds it. */
function estimated(s: BoardState, t: number, own: number | null, nAfter = s.n): { rank: number; n: number; pct: number } {
  const e = estimateLevelRank(s.hist, CUTOFF, t, own)!;
  expect(e).not.toBeNull();
  const n = Math.max(nAfter, e.n, e.rank);
  return { rank: e.rank, n, pct: levelPct(e.rank, n) };
}

const noWrite = (d: Decision): Extract<Decision, { write: false }> => {
  expect(d.write).toBe(false);
  return d as Extract<Decision, { write: false }>;
};
const written = (d: Decision): Extract<Decision, { write: true }> => {
  expect(d.write).toBe(true);
  return d as Extract<Decision, { write: true }>;
};

describe('the crowd', () => {
  it('is 1-1-like: 500 counted, cutoff 598, the tail spans the 0.2 s and 1 s bins', () => {
    expect(TIMES).toHaveLength(500);
    expect(CUTOFF).toBe(598);
    expect(TIMES.at(-1)!).toBeGreaterThan(1440);
    expect(board().hist.reduce((a, x) => a + x, 0)).toBe(500);
  });
});

describe('(1) notBetter first: t >= known = min(runs, plays.t120)', () => {
  it('t >= counted without a runs row: no statement, counted stays, the rank is the estimate of the counted time', () => {
    const s = board({ counted: 1500 });
    for (const t of [1500, 1600, 4000]) {
      const d = noWrite(decide(input(t, { state: s, play: { t120: 1500 } })));
      expect(d.play).toBeUndefined();
      expect(d.touchOwn).toBe(false);
      const e = estimated(s, 1500, 1500);
      expect(d.result).toEqual({
        board: KEY, status: 'notBetter', rank: e.rank, n: e.n, cutoff: CUTOFF, aiBeaten: false, was: e.rank, counted: 1500, pct: e.pct,
      } satisfies SubmitResult);
    }
  });

  it('is checked before the out-of-top rule (an old server said unranked), and before dup and lite', () => {
    const s = board({ counted: 900 });
    expect(decide(input(900, { state: s, play: { t120: 900 } })).result.status).toBe('notBetter');
    expect(decide(input(950, { state: s, play: { t120: 900 }, lite: true })).result.status).toBe('notBetter');
  });

  it('a top-100 player resending: rank = its exact position, was = the same', () => {
    const s = board({ topAt: 500 });
    const d = noWrite(decide(input(520, { state: s, own: { t120: 500 }, play: { t120: 500 } })));
    expect(d.play).toBeUndefined();
    expect(d.result).toMatchObject({ status: 'notBetter', rank: 51, was: 51, counted: 500 });
    expect(d.result.pct).toBeUndefined();
  });

  it('t >= runs with no histogram position: heals once (play = the runs time); not under soft or lite', () => {
    // An AI-beaten runs holder below the top 100 that the seed missed (population row only, or no plays row at all).
    for (const play of [{ t120: null }, null]) {
      const s = board();
      const d = noWrite(decide(input(690, { state: s, own: { t120: 650 }, play })));
      expect(d.play).toBe(650);
      const e = estimated(s, 650, null);
      expect(d.result).toMatchObject({ status: 'notBetter', rank: e.rank, counted: 650, was: null, pct: e.pct });
      for (const valve of [{ soft: true }, { lite: true }]) {
        const v = noWrite(decide(input(690, { state: s, own: { t120: 650 }, play, ...valve })));
        expect(v.play).toBeUndefined();
        expect(v.result).toMatchObject({ status: 'notBetter', counted: null });
      }
    }
  });
});

describe('(2) copies of another player\'s top-100 run', () => {
  const qs = Int8Array.from({ length: 230 }, (_, i) => ((i * 37) % 200) - 100);
  const T = 2 * qs.length - 60;   // the time of a 230-tick replay (400)
  const withCopy = (): BoardState => {
    const s = board();
    s.top[0]!.push(runFingerprint(qs));
    expect(s.top[0]![2]).toBe(T);
    return s;
  };

  it('rejected dup; a population row only when the player has none, and none under soft or lite', () => {
    const s = withCopy();
    const fp = runFingerprint(qs);
    const d = noWrite(decide(input(T, { state: s, fp })));
    expect(d.result).toEqual({ board: KEY, status: 'rejected', reason: 'dup' });
    expect(d.play).toBeNull();
    expect(noWrite(decide(input(T, { state: s, fp, play: { t120: null } }))).play).toBeUndefined();
    expect(noWrite(decide(input(T, { state: s, fp, play: { t120: 3000 } }))).play).toBeUndefined();
    expect(noWrite(decide(input(T, { state: s, fp, soft: true }))).play).toBeUndefined();
    const lite = noWrite(decide(input(T, { state: s, fp, lite: true })));
    expect([lite.result.reason, lite.play]).toEqual(['dup', undefined]);
  });
});

describe('(3) lite: level runs other than top-10 entries', () => {
  it('an out-of-top first send is rejected lite with no plays row (stays queued on the client)', () => {
    for (const t of [1000, 650]) {   // 650: a first AI-beaten run outside the top 100
      const d = noWrite(decide(input(t, { lite: true })));
      expect(d.result).toEqual({ board: KEY, status: 'rejected', reason: 'lite' });
      expect(d.play).toBeUndefined();
    }
  });

  it('a top-10 entry is accepted (with its histogram position); ranks 11..100 are rejected lite', () => {
    const top10 = written(decide(input(405, { lite: true })));
    expect(top10.result).toMatchObject({ status: 'accepted', rank: 4, counted: 405 });
    expect(top10.play).toBe(405);
    for (const t of [419, 450, 597]) {
      const d = noWrite(decide(input(t, { lite: true })));
      expect(d.result).toEqual({ board: KEY, status: 'rejected', reason: 'lite' });
      expect(d.play).toBeUndefined();
    }
  });
});

describe('(4) top 100 or first AI-beaten', () => {
  it('a brand-new entry: exact rank, was null, nDelta 1, play = t; the 100th row drops', () => {
    const s = board();
    const d = written(decide(input(451, { state: s })));
    expect(d.result).toEqual({
      board: KEY, status: 'accepted', rank: 27, n: 501, cutoff: 596, aiBeaten: true, was: null, counted: 451,
    } satisfies SubmitResult);
    expect([d.n, d.nDelta, d.aiBeaten, d.hist, d.play, d.drop]).toEqual([501, 1, 41, null, 451, crowdPidh(99)]);
    expect(d.top).toHaveLength(BOARD_TOP_N);
    expect(d.top[26]![0]).toBe(ME);
    expect(d.runs).toMatchObject({ t120: 451, replay: REPLAY });
    expect(stampKind(d.result.status, d.result.rank!, d.result.was!)).toBe('in');
  });

  it('an out-of-top counted player entering the top: was = the estimate of the counted time, no nDelta', () => {
    const s = board({ counted: 1200 });
    const d = written(decide(input(451, { state: s, play: { t120: 1200 } })));
    const was = estimated(s, 1200, 1200).rank;
    expect(was).toBeGreaterThan(BOARD_TOP_N);
    expect(d.result).toMatchObject({ status: 'accepted', rank: 27, was, counted: 451 });
    expect([d.nDelta, d.n, d.play]).toEqual([0, s.n, 451]);
    expect(stampKind('accepted', 27, was)).toBe('in');
  });

  it('an improvement inside the top: was = the old exact rank; play only on a bin change', () => {
    const s = board({ topAt: 500 });
    const up = written(decide(input(440, { state: s, own: { t120: 500 }, play: { t120: 500 } })));
    expect(up.result).toMatchObject({ status: 'accepted', rank: 22, was: 51, counted: 440 });
    expect([up.nDelta, up.play, up.drop]).toEqual([0, 440, null]);
    expect(stampKind(up.result.status, up.result.rank!, up.result.was!)).toBe('up');
    // 497 and 500 share bin 80: the boards write only; counted stays 500.
    expect(levelBin(497)).toBe(levelBin(500));
    const same = written(decide(input(497, { state: s, own: { t120: 500 }, play: { t120: 500 } })));
    expect(same.result).toMatchObject({ status: 'accepted', rank: 50, was: 51, counted: 500 });
    expect(same.play).toBeUndefined();
  });

  it('a runs holder without a plays row entering the top: placed (play = t), not a new player for n', () => {
    const s = board();
    const d = written(decide(input(451, { state: s, own: { t120: 650 }, play: null })));
    expect([d.nDelta, d.play, d.aiBeaten]).toEqual([0, 451, 40]);   // already AI-beaten with 650
  });

  it('a first AI-beaten run outside the top 100: accepted, rank >= 101 from the histogram, runs replay NULL', () => {
    const s = board();
    const d = written(decide(input(650, { state: s })));
    const e = estimated(s, 650, null, s.n + 1);
    expect(e.rank).toBeGreaterThan(BOARD_TOP_N);
    expect(d.result).toEqual({
      board: KEY, status: 'accepted', rank: e.rank, n: e.n, cutoff: CUTOFF, aiBeaten: true, was: null, counted: 650, pct: e.pct,
    } satisfies SubmitResult);
    expect([d.aiBeaten, d.nDelta, d.drop, d.wr, d.play]).toEqual([41, 1, null, null, 650]);
    expect(d.top).toEqual(s.top);
    expect(d.runs).toMatchObject({ t120: 650, replay: null });
    expect(stampKind(d.result.status, d.result.rank!, d.result.was!)).toBeNull();
  });

  it('the boards write and its histogram position are kept under soft', () => {
    const d = written(decide(input(451, { soft: true })));
    expect([d.play, d.nDelta, d.result.counted]).toEqual([451, 1, 451]);
  });
});

describe('(5) outside the top 100', () => {
  it('a first placement: play = t, counted = t, rank = the shared estimate, pct', () => {
    const s = board();
    const d = noWrite(decide(input(1000, { state: s })));
    expect(d.play).toBe(1000);
    const e = estimated(s, 1000, null);
    expect(d.result).toEqual({
      board: KEY, status: 'unranked', rank: e.rank, n: e.n, cutoff: CUTOFF, aiBeaten: false, was: null, counted: 1000, pct: e.pct,
    } satisfies SubmitResult);
  });

  it('a faster time in a new bin moves the position; the same bin writes nothing and keeps counted', () => {
    const s = board({ counted: 1200 });
    const was = estimated(s, 1200, 1200).rank;
    const move = noWrite(decide(input(1000, { state: s, play: { t120: 1200 } })));
    expect(move.play).toBe(1000);
    expect(move.result).toMatchObject({ status: 'unranked', rank: estimated(s, 1000, 1200).rank, was, counted: 1000 });
    expect(move.result.rank!).toBeLessThan(was);

    const s2 = board({ counted: 1000 });
    expect(levelBin(990)).toBe(levelBin(1000));
    const same = noWrite(decide(input(990, { state: s2, play: { t120: 1000 } })));
    expect(same.play).toBeUndefined();
    expect(same.result).toMatchObject({ status: 'unranked', rank: estimated(s2, 990, 1000).rank, counted: 1000 });
  });

  it('soft: nothing is written; counted stays (null for a first-timer)', () => {
    const first = noWrite(decide(input(1000, { soft: true })));
    expect(first.play).toBeUndefined();
    expect(first.result).toMatchObject({ status: 'unranked', counted: null });
    const s = board({ counted: 1200 });
    const moved = noWrite(decide(input(1000, { state: s, play: { t120: 1200 }, soft: true })));
    expect(moved.play).toBeUndefined();
    expect(moved.result).toMatchObject({ status: 'unranked', counted: 1200 });
  });

  it('no usable histogram (NULL until the first rebuild, or < 100 counted): rank null, no pct', () => {
    const s: BoardState = { ...board(), hist: new Array<number>(LEVEL_HIST_BINS).fill(0), n: 100 };
    const d = noWrite(decide(input(1000, { state: s })));
    expect(d.result).toEqual({ board: KEY, status: 'unranked', rank: null, n: 100, cutoff: CUTOFF, aiBeaten: false, was: null, counted: 1000 });
  });
});

describe('prev and daily', () => {
  it('a level prev is ignored', () => {
    const cases: [number, Partial<DecideInput>][] = [
      [1000, {}], [451, {}], [650, {}], [1500, { state: board({ counted: 1500 }), play: { t120: 1500 } }],
      [690, { own: { t120: 650 } }], [440, { state: board({ topAt: 500 }), own: { t120: 500 }, play: { t120: 500 } }],
    ];
    for (const [t, over] of cases) {
      for (const prev of [null, 0, 300, MAX_RANKED_T120]) expect(decide(input(t, { ...over, prev }))).toEqual(decide(input(t, over)));
    }
  });

  it('daily: a population row (play null) when the player has none and the day is not soft', () => {
    const daily = (over: Partial<DecideInput>): Decision => decide({
      ...input(500), kind: 'D', board: 'D:00009:1c0e77aa:s1', par: 3000,
      state: { exists: true, ver: 1, top: [], n: 3, cleared: 3, aiBeaten: 3, hist: new Array<number>(HIST_BINS).fill(0) }, ...over,
    });
    expect(written(daily({})).play).toBeNull();
    expect(written(daily({ soft: true })).play).toBeUndefined();
    expect(written(daily({ play: { t120: null } })).play).toBeUndefined();
    expect(written(daily({ t120: null, replay: null })).play).toBeNull();                                // participation
    expect(noWrite(daily({ own: { t120: 400 } })).play).toBeNull();                                     // notBetter
    expect(noWrite(daily({ own: { t120: 400 }, soft: true })).play).toBeUndefined();
    const res = written(daily({})).result;
    expect(res.counted).toBeUndefined();
    expect(res.was).toBeUndefined();
  });
});
