// A scriptable fake of the §7.7 HTTP API for tests/net. Owner: O8.
import type { BootResponse, SubmitRequest, SubmitResult, SubmitRun } from '../../src/shared/api';
import { BOARD_TOP_N } from '../../src/shared/api';
import { LEVEL_HIST_BINS, estimateLevelRank, levelBin, levelPct, padHist } from '../../src/shared/rank';
import { pidhFromSecret } from '../../src/shared/names';

export interface Call {
  url: string; method: string; body: SubmitRequest | null; keepalive: boolean; signal: AbortSignal | null;
  cache: RequestCache | null;
}

/** One level board of the §5.3 model: the top 100 (pidh, t120), ranking records, histogram positions (plays.t120). */
export interface FakeLevelBoard {
  top: { pidh: string; t120: number }[]; runs: Map<string, number>; counted: Map<string, number>;
  hist: number[]; n: number; par: number;
}
const minOf = (...xs: (number | undefined | null)[]): number | null => {
  let m: number | null = null;
  for (const x of xs) if (typeof x === 'number' && (m === null || x < m)) m = x;
  return m;
};
export type Reply = { status: number; body?: unknown; html?: boolean } | 'network' | 'hang';

export const L = (id: string, h = '9f3a12bc'): string => `L:${id}:${h}:s1`;
export const D = (day: number, h = '1c0e77aa'): string => `D:${String(day).padStart(5, '0')}:${h}:s1`;

export function bootRes(over: Partial<BootResponse> = {}): BootResponse {
  return {
    v: 1, sim: 1, now: 1_790_000_000_000, day: 23, lite: false, readOnly: false,
    boards: {
      '2-2': { key: L('2-2'), n: 812, aiBeaten: 37, par: 318, cutoff: 402, top: [['a1b2c3d4e5f60718', 5121, 301, 6400, 1, 1790000000000]], wr: 'WVABAQ' },
      '1-1': { key: L('1-1', '11111111'), n: 12, aiBeaten: 0, par: 200, cutoff: null, top: [], wr: null },
    },
    daily: { key: D(23), n: 5012, cleared: 3811, aiBeaten: 120, par: 402, top: [], hist: new Array<number>(150).fill(0), wr: null },
    ...over,
  };
}

/** Default server: boots, accepts every run, serves ghosts and boards. `handler` can override per call. */
export class FakeServer {
  calls: Call[] = [];
  handler: ((c: Call) => Reply | undefined) | null = null;
  boot: BootResponse = bootRes();
  submitStatus: (run: SubmitRequest['runs'][number]) => Partial<SubmitResult> = () => ({ status: 'accepted', rank: 1 });
  submitLite = false;
  /** The soft valve (§7.8 9b): `soft: true` in the answer; the level rules skip optional plays writes. */
  submitSoft = false;
  /** Level runs are answered by the §5.3 rules (levelAnswer) instead of submitStatus. */
  levelRules = false;
  readonly levelBoards = new Map<string, FakeLevelBoard>();
  /** plays.t120 rows the level rules wrote (the D1 writes the client caused with its level sends). */
  playWrites = 0;

  readonly fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const c: Call = {
      url, method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as SubmitRequest) : null,
      keepalive: init?.keepalive === true, signal: init?.signal ?? null, cache: init?.cache ?? null,
    };
    this.calls.push(c);
    const r = this.handler?.(c) ?? this.route(c);
    if (r === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    if (r === 'hang') {
      return new Promise((_, reject) => {
        c.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return Promise.resolve({
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => {
        if (r.html) throw new SyntaxError('Unexpected token <');
        return JSON.parse(JSON.stringify(r.body ?? null)) as unknown;
      },
    } as Response);
  }) as typeof fetch;

  route(c: Call): Reply {
    const p = c.url;
    if (p.startsWith('/api/boot')) return { status: 200, body: this.boot };
    if (p === '/api/submit') {
      const pidh = pidhFromSecret(c.body!.secret) ?? '';
      const results = c.body!.runs.map((r) =>
        this.levelRules && r.board.startsWith('L:') ? this.levelAnswer(pidh, r) : { board: r.board, ...this.submitStatus(r) });
      return { status: 200, body: { ok: true, lite: this.submitLite, ...(this.submitSoft ? { soft: true } : {}), results } };
    }
    const g = /^\/api\/ghost\/([^/]+)\/(\d+)$/.exec(p);
    if (g) return { status: 200, body: { key: g[1], rank: Number(g[2]), pidh: '0123456789abcdef', nameSeed: 7, t120: 300, replay: 'WVAB' } };
    const b = /^\/api\/board\/([^/]+)$/.exec(p);
    if (b) return { status: 200, body: { key: b[1], n: 3, aiBeaten: 1, par: 318, cutoff: null, top: [['0123456789abcdef', 7, 300, 5000, 1, 1]] } };
    return { status: 404, body: { error: 'notFound' } };
  }

  /** The model board of `key` (created from the boot board of `level`, or empty). */
  levelBoard(key: string, level: string): FakeLevelBoard {
    let b = this.levelBoards.get(key);
    if (!b) {
      const bb = Object.values(this.boot.boards).find((x) => x.key === key) ?? this.boot.boards[level];
      b = {
        top: bb?.key === key ? bb.top.map((r) => ({ pidh: r[0], t120: r[2] })) : [],
        runs: new Map(), counted: new Map(),
        hist: (bb?.key === key ? padHist(bb.hist ?? [], LEVEL_HIST_BINS) : null) ?? new Array<number>(LEVEL_HIST_BINS).fill(0),
        n: bb?.key === key ? bb.n : 0, par: bb?.par ?? 318,
      };
      this.levelBoards.set(key, b);
    }
    return b;
  }

  /** worker/routes/submit.ts decide(), level branch (§5.3 (1)-(5); no dup check, no heal). */
  levelAnswer(pidh: string, run: SubmitRun): SubmitResult {
    const b = this.levelBoard(run.board, run.level);
    const t = run.t120!;
    const cutoffOf = (): number | null => (b.top.length >= BOARD_TOP_N ? b.top[BOARD_TOP_N - 1]!.t120 : null);
    const cutoff = cutoffOf();
    const ownIdx = b.top.findIndex((r) => r.pidh === pidh);
    const others = b.top.filter((r) => r.pidh !== pidh);
    const counted = b.counted.get(pidh) ?? null;
    const ownBest = minOf(b.runs.get(pidh), ownIdx >= 0 ? b.top[ownIdx]!.t120 : null);
    const known = minOf(ownBest, counted);
    let pos = 0;
    while (pos < others.length && others[pos]!.t120 <= t) pos++;
    const rank = pos + 1;
    const inTop = rank <= BOARD_TOP_N;
    const firstAi = t < b.par && !(ownBest !== null && ownBest < b.par);
    const ownRank = ownIdx >= 0 ? ownIdx + 1 : null;
    const est = (x: number, own: number | null): { rank: number; n: number } | null => estimateLevelRank(b.hist, cutoff, x, own);
    const was = ownRank ?? (counted !== null ? est(counted, counted)?.rank ?? null : null);
    const res = (status: 'accepted' | 'unranked' | 'notBetter', rk: number | null, cnt: number | null, e: { n: number } | null): SubmitResult => {
      const n = Math.max(b.n, e?.n ?? 0, rk ?? 0);
      const r: SubmitResult = { board: run.board, status, rank: rk, n, cutoff, aiBeaten: t < b.par, was, counted: cnt };
      if (rk !== null && rk > BOARD_TOP_N) r.pct = levelPct(rk, n);
      return r;
    };
    if (known !== null && t >= known) {
      const e = est(known, counted);
      return res('notBetter', ownRank ?? e?.rank ?? null, counted, e);
    }
    if (this.submitLite && !(inTop && rank <= 10)) return { board: run.board, status: 'rejected', reason: 'lite' };
    const moves = counted === null || levelBin(t) !== levelBin(counted);
    if (inTop || firstAi) {
      if (inTop) b.top = [...others.slice(0, pos), { pidh, t120: t }, ...others.slice(pos)].slice(0, BOARD_TOP_N);
      if (counted === null && ownBest === null) b.n++;
      b.runs.set(pidh, t);
      const e = est(t, counted);
      if (moves) {
        b.counted.set(pidh, t);
        this.playWrites++;
      }
      const r = res('accepted', inTop ? rank : e?.rank ?? null, moves ? t : counted, e);
      r.cutoff = cutoffOf();
      return r;
    }
    const place = moves && !this.submitSoft;
    const e = est(t, counted);
    if (place) {
      b.counted.set(pidh, t);
      this.playWrites++;
    }
    return res('unranked', e?.rank ?? null, place ? t : counted, e);
  }

  paths(): string[] {
    return this.calls.map((c) => `${c.method} ${c.url}`);
  }
  submits(): SubmitRequest[] {
    return this.calls.filter((c) => c.url === '/api/submit').map((c) => c.body!);
  }
}
