// A scriptable fake of the §7.7 HTTP API for tests/net. Owner: O8.
import type { BootResponse, SubmitRequest, SubmitResult } from '../../src/shared/api';

export interface Call { url: string; method: string; body: SubmitRequest | null; keepalive: boolean; signal: AbortSignal | null }
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

  readonly fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const c: Call = {
      url, method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as SubmitRequest) : null,
      keepalive: init?.keepalive === true, signal: init?.signal ?? null,
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
      const results = c.body!.runs.map((r) => ({ board: r.board, ...this.submitStatus(r) }));
      return { status: 200, body: { ok: true, lite: this.submitLite, results } };
    }
    const g = /^\/api\/ghost\/([^/]+)\/(\d+)$/.exec(p);
    if (g) return { status: 200, body: { key: g[1], rank: Number(g[2]), pidh: '0123456789abcdef', nameSeed: 7, t120: 300, replay: 'WVAB' } };
    const b = /^\/api\/board\/([^/]+)$/.exec(p);
    if (b) return { status: 200, body: { key: b[1], n: 3, aiBeaten: 1, par: 318, cutoff: null, top: [['0123456789abcdef', 7, 300, 5000, 1, 1]] } };
    return { status: 404, body: { error: 'notFound' } };
  }

  paths(): string[] {
    return this.calls.map((c) => `${c.method} ${c.url}`);
  }
  submits(): SubmitRequest[] {
    return this.calls.filter((c) => c.url === '/api/submit').map((c) => c.body!);
  }
}
