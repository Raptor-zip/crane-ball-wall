// Level histogram, rank estimates and the results-card standing (GAME_DESIGN.md §7.7 「面のヒストグラムと順位の推定」). Owner: O9.
import { describe, expect, it } from 'vitest';
import { BOARD_TOP_N, HIST_BINS, MAX_RANKED_T120, histBin, type BoardRow } from '../../src/shared/api';
import {
  LEVEL_HIST_BINS, estimateDailyRank, estimateLevelRank, levelBin, levelBinRange, levelPct, localRank, padHist, stampKind,
  sumHist, trimHist, type BoardSnapshot,
} from '../../src/shared/rank';

/** Deterministic PRNG (the same LCG as the spec check script). */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** The dense level histogram of `times`. */
function histOf(times: readonly number[]): number[] {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  for (const t of times) h[levelBin(t)]! += 1;
  return h;
}

/** A random crowd of 150..3150 sorted times (a skewed spread over 1..26 s) and its histogram / cutoff. */
function crowd(r: () => number): { times: number[]; hist: number[]; cutoff: number } {
  const times = Array.from({ length: 150 + Math.floor(r() * 3000) }, () => Math.floor(120 + r() * r() * 3000)).sort((a, b) => a - b);
  return { times, hist: histOf(times), cutoff: times[BOARD_TOP_N - 1]! };
}

/** A board row of player `pidh` with time t (created orders equal times). */
const row = (pidh: string, t: number, created = 1000 + t): BoardRow => [pidh, 1, t, 5000, 1, created];

describe('levelBin / levelBinRange', () => {
  it('maps the bin edges as specified', () => {
    const ts = [0, 5, 6, 479, 480, 503, 504, 1439, 1440, 1559, 1560, 5279, 5280, 5341];
    const bs = [0, 0, 1, 79, 80, 80, 81, 119, 120, 120, 121, 151, 152, 152];
    expect(ts.map(levelBin)).toEqual(bs);
  });

  it('is monotonic, uses all 153 bins over 0..5341, and clamps outside it', () => {
    const used = new Set<number>();
    let prev = 0;
    for (let t = 0; t <= MAX_RANKED_T120; t++) {
      const b = levelBin(t);
      expect(b).toBeGreaterThanOrEqual(prev);
      used.add(b);
      prev = b;
    }
    expect(used.size).toBe(LEVEL_HIST_BINS);
    expect(levelBin(-5)).toBe(0);
    expect(levelBin(99_999)).toBe(152);
    expect(levelBin(6.9)).toBe(1);
  });

  it('tiles 0..5341 with no gap or overlap, and levelBin(t) === b inside [lo, hi)', () => {
    expect(levelBinRange(0)[0]).toBe(0);
    expect(levelBinRange(LEVEL_HIST_BINS - 1)[1]).toBe(MAX_RANKED_T120 + 1);
    for (let b = 0; b < LEVEL_HIST_BINS; b++) {
      const [lo, hi] = levelBinRange(b);
      expect(hi).toBeGreaterThan(lo);
      if (b + 1 < LEVEL_HIST_BINS) expect(levelBinRange(b + 1)[0]).toBe(hi);
      for (let t = lo; t < hi; t++) expect(levelBin(t)).toBe(b);
    }
  });
});

describe('padHist / trimHist / sumHist', () => {
  it('pads a short array to a dense one and keeps the counts', () => {
    const h = padHist([0, 3, 0, 7], LEVEL_HIST_BINS)!;
    expect(h).toHaveLength(LEVEL_HIST_BINS);
    expect(h.slice(0, 5)).toEqual([0, 3, 0, 7, 0]);
    expect(sumHist(h)).toBe(10);
    expect(padHist([], HIST_BINS)).toEqual(new Array<number>(HIST_BINS).fill(0));
  });

  it('rejects non-arrays, arrays longer than bins, negative and non-integer entries', () => {
    for (const bad of [null, undefined, 3, '[1,2]', { 0: 1 }]) expect(padHist(bad, LEVEL_HIST_BINS)).toBeNull();
    expect(padHist(new Array<number>(LEVEL_HIST_BINS + 1).fill(0), LEVEL_HIST_BINS)).toBeNull();
    expect(padHist(new Array<number>(LEVEL_HIST_BINS).fill(1), LEVEL_HIST_BINS)).not.toBeNull();
    expect(padHist([1, -1], LEVEL_HIST_BINS)).toBeNull();
    expect(padHist([1, 0.5], LEVEL_HIST_BINS)).toBeNull();
    expect(padHist([1, NaN], LEVEL_HIST_BINS)).toBeNull();
    expect(padHist([1, Infinity], LEVEL_HIST_BINS)).toBeNull();
    expect(padHist([1, '2'], LEVEL_HIST_BINS)).toBeNull();
    expect(padHist([1, null], LEVEL_HIST_BINS)).toBeNull();
  });

  it('trims trailing zeros only', () => {
    expect(trimHist([0, 2, 0, 1, 0, 0])).toEqual([0, 2, 0, 1]);
    expect(trimHist([0, 0, 0])).toEqual([]);
    expect(trimHist([])).toEqual([]);
    const h = histOf([100, 900, 2000]);
    expect(padHist(trimHist(h), LEVEL_HIST_BINS)).toEqual(h);
  });
});

describe('estimateLevelRank', () => {
  it('is monotonic over 300 random crowds, >= 101 and <= n from the cutoff on, and 101 on a tie with the cutoff', () => {
    const r = rng(7);
    const bad: string[] = [];
    for (let trial = 0; trial < 300; trial++) {
      const { hist, cutoff } = crowd(r);
      if (estimateLevelRank(hist, cutoff, cutoff, null)!.rank !== 101) bad.push(`#${trial} tie`);
      let prev = 0;
      for (let t = 0; t <= MAX_RANKED_T120; t += trial % 10 === 0 ? 1 : 7) {
        const e = estimateLevelRank(hist, cutoff, t, null)!;
        if (e.rank < prev) bad.push(`#${trial} t=${t} not monotonic`);
        if (t >= cutoff ? e.rank < 101 || e.rank > e.n : e.rank > 100) bad.push(`#${trial} t=${t} rank ${e.rank} n ${e.n}`);
        prev = e.rank;
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('stays within a few ranks of the truth on a 1-1-like crowd of 1,065 players', () => {
    const r = rng(7);
    const times = Array.from({ length: 1065 }, () => Math.floor(180 + Math.abs(r() + r() + r() - 1.5) * 300 + r() * 60)).sort((a, b) => a - b);
    const hist = histOf(times);
    const cutoff = times[99]!;
    let maxErr = 0;
    for (let i = 100; i < times.length; i += 7) {
      const t = times[i]!;
      const truth = times.filter((x) => x < t).length + 1;   // strictly faster + 1 (ties: optimistic, like the estimator)
      maxErr = Math.max(maxErr, Math.abs(estimateLevelRank(hist, cutoff, t, t)!.rank - truth));
    }
    expect(maxErr).toBeLessThanOrEqual(12);   // 7 with this seed (spec check: 11 on another draw)
  });

  it('interpolates inside a bin in the top-100 region and clamps to min(100, n)', () => {
    const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
    h[10] = 12;                      // [60, 66)
    h[20] = 6;                       // [120, 126)
    expect(estimateLevelRank(h, null, 0, null)).toEqual({ rank: 1, n: 19 });
    expect(estimateLevelRank(h, null, 60, null)).toEqual({ rank: 1, n: 19 });
    expect(estimateLevelRank(h, null, 63, null)).toEqual({ rank: 7, n: 19 });    // 12 * 3/6 = 6 faster
    expect(estimateLevelRank(h, null, 66, null)).toEqual({ rank: 13, n: 19 });
    expect(estimateLevelRank(h, null, 5000, null)).toEqual({ rank: 19, n: 19 }); // cutoff null: at most n
    h[30] = 200;                     // [180, 186)
    expect(estimateLevelRank(h, 185, 182, null)!.rank).toBe(85);                 // 18 + 200 * 2/6 = 84.7 faster
    expect(estimateLevelRank(h, 185, 184, null)!.rank).toBe(100);                // 18 + 200 * 4/6 = 151.3: clamped to 100
  });

  it('is null for an empty histogram in the top region and while Σh < 100 from the cutoff on', () => {
    const empty = new Array<number>(LEVEL_HIST_BINS).fill(0);
    expect(estimateLevelRank(empty, null, 300, null)).toBeNull();
    expect(estimateLevelRank([], 400, 300, null)).toBeNull();
    const h = histOf(Array.from({ length: 99 }, (_, i) => 200 + i));
    expect(estimateLevelRank(h, 298, 298, null)).toBeNull();
    expect(estimateLevelRank(h, 298, 900, null)).toBeNull();
    expect(estimateLevelRank(h, 298, 250, null)).not.toBeNull();                 // the top region still estimates
    h[levelBin(900)]! += 1;
    expect(estimateLevelRank(h, 298, 900, null)).toEqual({ rank: 101, n: 101 });
  });

  it('removes `own` first: n does not count the player twice, and a bin never goes below 0', () => {
    const times = Array.from({ length: 300 }, (_, i) => 150 + 3 * i);
    const h = histOf(times);
    const cutoff = times[99]!;
    const t = times[200]!;
    const withOwn = estimateLevelRank(h, cutoff, t, t)!;
    expect(withOwn.n).toBe(300);                                   // already counted: n = Σh
    expect(estimateLevelRank(h, cutoff, t, null)!.n).toBe(301);    // not counted yet: + 1
    expect(estimateLevelRank(h, cutoff, t + 1, t)!.n).toBe(300);   // same bin: n unchanged
    // own in an empty bin: nothing to remove, the count is not negative
    const e = estimateLevelRank(h, cutoff, 3000, 5000)!;
    expect(e.n).toBe(301);
    expect(e.rank).toBeLessThanOrEqual(301);
    // removing own lowers the rank of a slower time by at most 1
    const slow = times[250]!;
    expect(estimateLevelRank(h, cutoff, slow, null)!.rank - estimateLevelRank(h, cutoff, slow, t)!.rank).toBeLessThanOrEqual(1);
  });

  it('carries K = the rows of the cutoff bin beyond the top 100', () => {
    // 90 times in bin 30 ([180, 186)), then 30 times at 186..191 in bin 31: 10 of them are in the top 100.
    const times = [...Array.from({ length: 90 }, () => 181), ...Array.from({ length: 30 }, (_, i) => 186 + (i % 6))].sort((a, b) => a - b);
    const h = histOf(times);
    const cutoff = times[99]!;
    expect(levelBin(cutoff)).toBe(31);
    const [, hi] = levelBinRange(31);
    const K = 90 + 30 - 100;
    expect(estimateLevelRank(h, cutoff, cutoff, null)!.rank).toBe(101);
    expect(estimateLevelRank(h, cutoff, hi - 1, null)!.rank).toBe(101 + Math.floor((K * (hi - 1 - cutoff)) / (hi - cutoff)));
    expect(estimateLevelRank(h, cutoff, hi, null)!.rank).toBe(101 + K);    // continuous at the bin edge
    expect(estimateLevelRank(h, cutoff, 5000, null)).toEqual({ rank: 121, n: 121 });
  });

  it('pads short or trimmed arrays and ignores bins past 153', () => {
    const r = rng(11);
    const { hist, cutoff } = crowd(r);
    const trimmed = trimHist(hist);
    for (const t of [0, 150, cutoff - 1, cutoff, cutoff + 40, 1500, 5341]) {
      expect(estimateLevelRank(trimmed, cutoff, t, 700)).toEqual(estimateLevelRank(hist, cutoff, t, 700));
      expect(estimateLevelRank([...hist, 99, 99], cutoff, t, 700)).toEqual(estimateLevelRank(hist, cutoff, t, 700));
    }
  });
});

describe('levelPct', () => {
  it('rounds rank/n up to one decimal', () => {
    expect(levelPct(342, 1065)).toBe(32.2);
    expect(levelPct(1, 3)).toBe(33.4);
    expect(levelPct(1, 10)).toBe(10);
    expect(levelPct(101, 101)).toBe(100);
  });

  it('clamps to 0.1..100', () => {
    expect(levelPct(1, 1_000_000)).toBe(0.1);
    expect(levelPct(5, 3)).toBe(100);
  });
});

describe('stampKind', () => {
  it('stamps only accepted answers within the top 100', () => {
    expect(stampKind('unranked', 37, null)).toBeNull();
    expect(stampKind('notBetter', 37, 37)).toBeNull();
    expect(stampKind('rejected', 1, null)).toBeNull();
    expect(stampKind('deferred', 1, null)).toBeNull();
    expect(stampKind('accepted', null, null)).toBeNull();
    expect(stampKind('accepted', 101, 300)).toBeNull();
  });

  it('wr for rank 1, in from outside, up for a better rank, nothing for the same rank', () => {
    expect(stampKind('accepted', 1, null)).toBe('wr');
    expect(stampKind('accepted', 1, 1)).toBe('wr');
    expect(stampKind('accepted', 1, 5)).toBe('wr');
    expect(stampKind('accepted', 37, null)).toBe('in');
    expect(stampKind('accepted', 37, 101)).toBe('in');
    expect(stampKind('accepted', 100, 342)).toBe('in');
    expect(stampKind('accepted', 37, 45)).toBe('up');
    expect(stampKind('accepted', 37, 37)).toBeNull();
    expect(stampKind('accepted', 37, 30)).toBeNull();
  });
});

describe('localRank', () => {
  const ME = 'me00000000000000';
  const tenRows = (): BoardRow[] => Array.from({ length: 10 }, (_, i) => row(`p${String(i).padStart(15, '0')}`, 200 + 10 * i));
  /** A 1,000-player crowd: 200, 202, ..., the top 100 at 200..398 (cutoff 398). */
  const bigTimes = Array.from({ length: 1000 }, (_, i) => 200 + 2 * i);
  const bigHist = histOf(bigTimes);
  const boot = (top: BoardRow[], hist: number[] | null = bigHist, cutoff: number | null = 398): BoardSnapshot => ({ top, cutoff, hist, complete: false });

  it('inside the boot top 10: the slot among the others, exact only for my own row', () => {
    const top = tenRows();
    expect(localRank(boot(top), 225, ME, null)).toMatchObject({ rank: 4, candidate: true, exact: false, pct: null });
    const mine = [...top.slice(0, 3), row(ME, 225, 1), ...top.slice(3, 9)];
    expect(localRank(boot(mine), 225, ME, 225)).toMatchObject({ rank: 4, candidate: true, exact: true });
    expect(localRank(boot(mine), 212, ME, 225)).toMatchObject({ rank: 3, candidate: true, exact: false });
  });

  it('ties keep the earlier row ahead; my own row keeps its place among equal times', () => {
    const top = tenRows();
    expect(localRank(boot(top), 220, ME, null).rank).toBe(4);   // behind the 220 already there
    const tied = [row('a000000000000000', 220, 1), row(ME, 220, 2), row('b000000000000000', 220, 3), ...top.slice(3, 10)];
    expect(localRank(boot(tied), 220, ME, 220)).toMatchObject({ rank: 2, exact: true });
  });

  it('excludes my own row from the others', () => {
    // I am 1st at 200; a new time of 205 would still be 1st (my old row does not count against me).
    const top = [row(ME, 200, 1), ...tenRows().slice(1)];
    expect(localRank(boot(top), 205, ME, 200)).toMatchObject({ rank: 1, candidate: true, exact: false });
  });

  it('a boot list shorter than 10 rows is complete', () => {
    const top = tenRows().slice(0, 4);
    const h = histOf([200, 210, 220, 230]);
    const r = localRank({ top, cutoff: null, hist: h, complete: false }, 900, ME, null);
    expect(r).toMatchObject({ rank: 5, n: 5, candidate: true, exact: false, pct: null });
    expect(localRank({ top, cutoff: null, hist: null, complete: false }, 900, ME, null)).toMatchObject({ rank: 5, n: null });
  });

  it('a complete list (BoardResponse) gives the slot up to 100, the estimate after', () => {
    const top = bigTimes.slice(0, 100).map((t, i) => row(`p${String(i).padStart(15, '0')}`, t));
    const snap: BoardSnapshot = { top, cutoff: 398, hist: bigHist, complete: true };
    expect(localRank(snap, 301, ME, null)).toMatchObject({ rank: 52, candidate: true, exact: false });
    expect(localRank(snap, 397, ME, null)).toMatchObject({ rank: 100, candidate: true });
    const out = localRank(snap, 398, ME, null);
    expect(out).toMatchObject({ rank: 101, candidate: false, exact: false });
    expect(out.pct).toBe(levelPct(101, out.n!));
  });

  it('between the boot top 10 and the cutoff: the estimate clamped to [others + 1, 100]', () => {
    const top = tenRows();   // 200..290
    const r = localRank(boot(top), 300, ME, null);
    expect(r).toMatchObject({ rank: estimateLevelRank(bigHist, 398, 300, null)!.rank, n: 1001, candidate: true, pct: null });
    expect(r.rank).toBe(51);
    // A histogram that disagrees with the list (stale): 5 players faster by the hist, 10 by the list -> 11.
    const sparse = histOf([...new Array<number>(5).fill(100), ...new Array<number>(500).fill(2000)]);
    expect(localRank(boot(top, sparse, null), 295, ME, null)).toMatchObject({ rank: 11, n: 506, candidate: true });
    const fast = localRank(boot(bigTimes.slice(0, 10).map((t, i) => row(`p${i}`, t))), 397, ME, null);
    expect(fast).toMatchObject({ rank: 99, candidate: true, pct: null });
    expect(localRank(boot(top, null), 300, ME, null)).toMatchObject({ rank: null, n: null, candidate: true });
  });

  it('from the cutoff on: not a candidate, the estimate with pct', () => {
    const top = bigTimes.slice(0, 10).map((t, i) => row(`p${i}`, t));
    const r = localRank(boot(top), 1200, ME, null);
    const e = estimateLevelRank(bigHist, 398, 1200, null)!;
    expect(r).toEqual({ rank: e.rank, n: e.n, pct: levelPct(e.rank, e.n), candidate: false, exact: false });
    expect(r.rank).toBeGreaterThanOrEqual(101);
    // counted: my own histogram entry is removed first
    const again = localRank(boot(top), 1200, ME, 1300);
    expect(again.n).toBe(1000);
    expect(localRank(boot(top, null), 1200, ME, null)).toEqual({ rank: null, n: null, pct: null, candidate: false, exact: false });
  });
});

describe('estimateDailyRank', () => {
  /** worker/routes/submit.ts estimateRank before it moved to src/shared/rank.ts. */
  function oldEstimateRank(hist: readonly number[], t: number): number {
    const b = histBin(t);
    let faster = 0;
    for (let i = 0; i < b; i++) faster += hist[i]!;
    return Math.max(BOARD_TOP_N + 1, Math.floor(faster + hist[b]! / 2) + 1);
  }

  it('gives the same result as the old worker estimate', () => {
    const r = rng(3);
    for (let trial = 0; trial < 50; trial++) {
      const h = Array.from({ length: HIST_BINS }, () => (r() < 0.4 ? 0 : Math.floor(r() * 40)));
      for (let t = 0; t <= 3700; t += 13) expect(estimateDailyRank(h, t)).toBe(oldEstimateRank(h, t));
    }
    const flat = new Array<number>(HIST_BINS).fill(0);
    expect(estimateDailyRank(flat, 500)).toBe(101);
    flat[0] = 300;
    flat[10] = 51;
    expect(estimateDailyRank(flat, 245)).toBe(326);   // 300 faster + 51 / 2
  });

  it('pads a trimmed (wire) histogram', () => {
    const h = new Array<number>(HIST_BINS).fill(0);
    h[3] = 200;
    h[7] = 9;
    for (const t of [0, 80, 170, 180, 3600]) expect(estimateDailyRank(trimHist(h), t)).toBe(estimateDailyRank(h, t));
  });
});
