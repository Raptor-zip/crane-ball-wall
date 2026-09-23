// API client: enablement, boot cache, silent offline + backoff, outbox discipline (GAME_DESIGN.md §7.7, §7.9, §7.12). Owner: O8.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MINUTES, BOOT_CACHE_KEY, BOOT_TIMEOUT_MS, GHOST_MAX_PER_SESSION, RANKIN_MIN_INTERVAL_MS, SEND_MIN_INTERVAL_MS, backoffDelayMs,
  boardHistOf, createApi, levelClass, levelHistOf, netAllowed, type ApiOptions, type NetApi,
} from '../../src/net/api';
import { dailyPendingRun, levelPendingRun, nTicksForScore, type PendingRun } from '../../src/net/outbox';
import { SAVE_KEY, createStore, defaultSave, ensureLevel, type LocalStore, type SaveV1 } from '../../src/store/save';
import { MemStorage } from '../store/helpers';
import { D, FakeServer, L, bootRes, type Call } from './fakeServer';
import type { BootResponse } from '../../src/shared/api';
import { LEVEL_HIST_BINS, estimateLevelRank, levelBin, stampKind, trimHist } from '../../src/shared/rank';

const MIN = 60_000;
let t = 1_790_000_000_000;
let server: FakeServer;
let session: MemStorage;
let store: LocalStore;
let disk: MemStorage;
const stores: LocalStore[] = [];

function mkStore(): LocalStore {
  disk = new MemStorage();
  const s = createStore({ storage: disk, listen: false, lang: 'ja' });
  stores.push(s);
  return s;
}
function mkApi(opts: ApiOptions = {}): NetApi {
  return createApi(store, { fetch: server.fetch, now: () => t, session, net: undefined, protocol: 'https:', ...opts });
}
/** A fetch that holds /api/submit requests until release() (the answer arrives later, or never). */
function gatedFetch(): { fetch: typeof fetch; release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const f = (async (u: RequestInfo | URL, i?: RequestInit) => {
    if (String(u) === '/api/submit') {
      const p = server.fetch(u, i);   // recorded now (fetch is called synchronously)
      await gate;
      return p;
    }
    return server.fetch(u, i);
  }) as typeof fetch;
  return { fetch: f, release: open };
}
/** A level PB for 2-2 (board of the default boot) or another level. */
function pb(t120: number, level = '2-2', board = L(level)): PendingRun {
  return levelPendingRun(board, level, `R${level}-${t120}`, t120, 1, t);
}
/** Sets today's daily state and returns the run §7.9 says is due (or null). */
function daily(state: Partial<SaveV1['daily']>): PendingRun | null {
  store.update((d) => Object.assign(d.daily, { dayIndex: 23, ...state }));
  return dailyPendingRun(store.data().daily, { board: D(23), level: 'd:17', device: 1, now: t });
}

beforeEach(() => {
  t = 1_790_000_000_000;
  server = new FakeServer();
  session = new MemStorage();
  store = mkStore();
});
afterEach(() => {
  while (stores.length) stores.pop()!.dispose();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('enablement (§7.12)', () => {
  it('netAllowed: VITE_NET !== "off" and an http(s) page', () => {
    expect(netAllowed(undefined, 'https:')).toBe(true);
    expect(netAllowed('on', 'http:')).toBe(true);
    expect(netAllowed('off', 'https:')).toBe(false);
    expect(netAllowed(undefined, 'file:')).toBe(false);
    expect(netAllowed(undefined, 'about:')).toBe(false);
    expect(netAllowed(undefined, '')).toBe(false);
  });

  it('reads import.meta.env.VITE_NET and location.protocol by default', () => {
    expect(location.protocol).toMatch(/^https?:$/);
    expect(netAllowed()).toBe(true);
    vi.stubEnv('VITE_NET', 'off');
    expect(netAllowed()).toBe(false);
  });

  it.each([
    ['VITE_NET=off', { net: 'off', protocol: 'https:' }],
    ['file:', { protocol: 'file:' }],
  ] as const)('%s: never calls fetch, everything answers null, nothing is queued', async (_, o) => {
    const api = mkApi(o);
    expect(await api.boot(23)).toBeNull();
    api.enqueue(pb(300));
    expect(store.data().outbox).toEqual([]);
    expect(await api.flush('menu')).toBeNull();
    expect(await api.flush('pagehide')).toBeNull();
    expect(await api.ghost(L('2-2'), 3)).toBeNull();
    expect(await api.board(L('2-2'))).toBeNull();
    expect(api.enabled).toBe(false);
    expect(server.calls).toEqual([]);
  });

  it('VITE_NET=off via the env (single HTML build): createApi never fetches', async () => {
    vi.stubEnv('VITE_NET', 'off');
    const f = vi.fn(server.fetch);
    const api = createApi(store, { fetch: f, now: () => t, session });
    expect(await api.boot(23)).toBeNull();
    expect(await api.flush('dailyDone')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('is enabled after a successful boot', async () => {
    const api = mkApi();
    expect(api.enabled).toBe(false);
    const b = await api.boot(23);
    expect(b).toEqual(server.boot);
    expect(api.enabled).toBe(true);
    expect(api.lite).toBe(false);
    expect(api.lastBoot()).toEqual(server.boot);
    expect(server.paths()).toEqual(['GET /api/boot?day=23']);
  });

  it('booting is true only while the first boot is on its way (no offline chip flash at startup)', async () => {
    const g = gatedFetch();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const api = mkApi({ fetch: (async (u: RequestInfo | URL, i?: RequestInit) => { await gate; return g.fetch(u, i); }) as typeof fetch });
    expect(api.booting).toBe(false);
    const p = api.boot(23);
    expect(api.booting).toBe(true);
    expect(api.enabled).toBe(false);
    release();
    await p;
    expect(api.booting).toBe(false);
    expect(api.enabled).toBe(true);
    // A failed boot is not "booting" (the chip shows), nor is a disallowed origin.
    server.handler = () => 'network';
    const off = mkApi();
    await off.boot(24);
    expect(off.booting).toBe(false);
    expect(mkApi({ protocol: 'file:' }).booting).toBe(false);
  });

  it('a boot slower than 3 s counts as failure (offline)', async () => {
    vi.useFakeTimers();
    server.handler = () => 'hang';
    const api = mkApi();
    const p = api.boot(23);
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS - 1);
    let done = false;
    void p.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeNull();
    expect(api.enabled).toBe(false);
    expect(server.calls[0]!.signal!.aborted).toBe(true);
  });
});

describe('boot time limit vs a blocked main thread (a slow first frame)', () => {
  /** A fetch whose headers and body arrive when the test says so. */
  function manualFetch(): { fetch: typeof fetch; headers: () => void; body: () => void; signal: () => AbortSignal | null } {
    let openHeaders!: () => void;
    let openBody!: () => void;
    let sig: AbortSignal | null = null;
    const h = new Promise<void>((r) => { openHeaders = r; });
    const b = new Promise<void>((r) => { openBody = r; });
    const f = (async (_u: RequestInfo | URL, i?: RequestInit) => {
      sig = i?.signal ?? null;
      await h;
      return {
        status: 200, ok: true,
        json: async () => {
          await b;
          return bootRes();
        },
      } as Response;
    }) as typeof fetch;
    return { fetch: f, headers: openHeaders, body: openBody, signal: () => sig };
  }

  it('a timer that fires late (the thread was blocked) waits once more: the answer behind it still counts', async () => {
    vi.useFakeTimers();
    const m = manualFetch();
    const api = mkApi({ fetch: m.fetch });
    const p = api.boot(23);
    t += BOOT_TIMEOUT_MS + 4000;              // a 4 s long task: the timer runs 4 s late ...
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
    m.headers();                              // ... and the answer, which came long ago, is handled right after it
    m.body();
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).not.toBeNull();
    expect(api.enabled).toBe(true);
    expect(m.signal()!.aborted).toBe(false);
  });

  it('headers in time, body slow: one more period for the body, then offline', async () => {
    vi.useFakeTimers();
    const m = manualFetch();
    const api = mkApi({ fetch: m.fetch });
    const p = api.boot(23);
    m.headers();
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS + 500);
    m.body();
    expect(await p).not.toBeNull();

    const m2 = manualFetch();
    const api2 = mkApi({ fetch: m2.fetch, session: null });
    const p2 = api2.boot(23);
    m2.headers();
    await vi.advanceTimersByTimeAsync(2 * BOOT_TIMEOUT_MS);
    expect(await p2).toBeNull();
    expect(api2.enabled).toBe(false);
    expect(m2.signal()!.aborted).toBe(true);
  });

  it('a timer on time with nothing received still gives up at exactly 3 s', async () => {
    vi.useFakeTimers();
    const m = manualFetch();
    const api = mkApi({ fetch: m.fetch, session: null });
    const p = api.boot(23);
    t += BOOT_TIMEOUT_MS + 100;               // late by less than LATE_TIMER_MS: a normal timer
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
    expect(await p).toBeNull();
    expect(m.signal()!.aborted).toBe(true);
  });
});

describe('boot cache (sessionStorage, 10 min)', () => {
  it('one fetch per session and day; a new page load reuses the cache for 10 minutes', async () => {
    const a = mkApi();
    await a.boot(23);
    await a.boot(23);
    expect(server.calls).toHaveLength(1);
    expect(JSON.parse(session.getItem(BOOT_CACHE_KEY)!).day).toBe(23);

    t += 9 * MIN;
    const b = mkApi();                     // reload within 10 minutes
    expect(await b.boot(23)).toEqual(server.boot);
    expect(b.enabled).toBe(true);
    expect(server.calls).toHaveLength(1);

    t += 2 * MIN;                          // 11 minutes old
    const c = mkApi();
    await c.boot(23);
    expect(server.calls).toHaveLength(2);

    await c.boot(24);                      // another day is another cache entry
    expect(server.paths().at(-1)).toBe('GET /api/boot?day=24');
  });

  it('concurrent boots share one request', async () => {
    const api = mkApi();
    const [x, y] = await Promise.all([api.boot(23), api.boot(23)]);
    expect(x).toEqual(y);
    expect(server.calls).toHaveLength(1);
  });

  it('a broken cache entry or a broken session storage is ignored', async () => {
    session.setItem(BOOT_CACHE_KEY, '{nope');
    await mkApi().boot(23);
    expect(server.calls).toHaveLength(1);
    const throwing = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    const api = mkApi({ session: throwing });
    expect(await api.boot(23)).toEqual(server.boot);
  });
});

describe('silent offline and exponential backoff', () => {
  it.each([
    ['429', { status: 429, body: { error: 'rate' } }],
    ['500', { status: 500, body: {} }],
    ['503 READ_ONLY', { status: 503, body: { error: 'readOnly' } }],
    ['network error', 'network'],
    ['HTML error page (1027)', { status: 200, html: true }],
    ['malformed JSON shape', { status: 200, body: { v: 2 } }],
    ['404 (no API behind this host)', { status: 404, body: {} }],
  ] as const)('%s on boot: null, offline, no throw, no console output', async (_, reply) => {
    const spies = (['error', 'warn', 'log'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    server.handler = () => reply;
    const api = mkApi();
    expect(await api.boot(23)).toBeNull();
    expect(api.enabled).toBe(false);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });

  it.each([
    ['a board without aiBeaten', (b: BootResponse) => { delete (b.boards['2-2'] as Partial<BootResponse['boards'][string]>).aiBeaten; }],
    ['a board with a text cutoff', (b: BootResponse) => { (b.boards['2-2'] as unknown as { cutoff: string }).cutoff = '402'; }],
    ['a daily without cleared', (b: BootResponse) => { delete (b.daily as Partial<BootResponse['daily']>).cleared; }],
    ['a daily histogram with holes', (b: BootResponse) => { (b.daily.hist as unknown[])[3] = null; }],
    ['a numeric wr', (b: BootResponse) => { (b.boards['2-2'] as unknown as { wr: number }).wr = 5; }],
    ['daily: null', (b: BootResponse) => { (b as unknown as { daily: null }).daily = null; }],
  ])('a boot answer with %s is treated as offline (the UI never shows NaN)', async (_, spoil) => {
    const b = bootRes();
    spoil(b);
    server.boot = b;
    const api = mkApi();
    expect(await api.boot(23)).toBeNull();
    expect(api.enabled).toBe(false);
  });

  it('backoffDelayMs: 1 -> 2 -> 4 -> 8 -> 16 -> 30 -> 30 minutes', () => {
    expect(BACKOFF_MINUTES).toEqual([1, 2, 4, 8, 16, 30]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelayMs(n) / MIN)).toEqual([0, 1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it('retries are only attempted after 1, 2, 4, 8, 16, 30, 30 minutes', async () => {
    server.handler = () => ({ status: 503, body: {} });
    const api = mkApi();
    const start = t;
    const attempts: number[] = [];
    for (let m = 0; m <= 130; m += 0.5) {
      t = start + m * MIN;
      const before = server.calls.length;
      await api.boot(23);
      await api.board(L('2-2'));
      await api.flush('menu');
      if (server.calls.length > before) attempts.push(m);
      expect(server.calls.length - before).toBeLessThanOrEqual(1);
    }
    const gaps = attempts.slice(1).map((m, i) => m - attempts[i]!);
    expect(attempts[0]).toBe(0);
    expect(gaps).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it('a success after the wait brings the API back and resets the backoff', async () => {
    const api = mkApi();
    await api.boot(23);
    expect(api.enabled).toBe(true);
    server.handler = (c) => (c.url === '/api/submit' ? 'network' : undefined);
    api.enqueue(pb(300));
    expect(await api.flush('menu')).toBeNull();
    expect(api.enabled).toBe(false);          // offline chip
    expect(store.data().outbox).toHaveLength(1);

    t += 30 * 1000;
    expect(await api.board(L('2-2'))).toBeNull();
    expect(server.calls).toHaveLength(2);     // still waiting: no request

    server.handler = null;
    t += 3 * MIN;
    expect(await api.flush('menu')).not.toBeNull();
    expect(api.enabled).toBe(true);
    expect(store.data().outbox).toEqual([]);

    server.handler = () => 'network';
    t += 3 * MIN;
    await api.board(L('1-1', '11111111'));
    const n = server.calls.length;
    t += MIN - 1;
    await api.board(L('1-1', '11111111'));
    expect(server.calls).toHaveLength(n);
    t += 1;
    await api.board(L('1-1', '11111111'));
    expect(server.calls).toHaveLength(n + 1);  // the wait restarted at 1 minute
  });

  it('boots lazily before the first send when boot() was never called', async () => {
    const api = mkApi();
    store.update((d) => { d.daily.dayIndex = 23; });
    api.enqueue(pb(300));
    expect(await api.flush('select')).not.toBeNull();
    expect(server.paths()).toEqual(['GET /api/boot?day=23', 'POST /api/submit']);
  });
});

describe('flush: timing and request shape (§7.9)', () => {
  it('sends queued runs with keepalive, the identity and §7.7 wire runs', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    const res = await api.flush('menu');
    expect(res?.results[0]).toMatchObject({ board: L('2-2'), status: 'accepted' });
    const call = server.calls.at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.keepalive).toBe(true);
    expect(call.body).toEqual({
      v: 1, secret: store.data().id.secret, nameSeed: store.data().id.nameSeed,
      runs: [{ board: L('2-2'), level: '2-2', replay: 'R2-2-300', t120: 300, device: 1 }],
    });
    expect(store.data().outbox).toEqual([]);
    expect(await api.flush('menu')).toBeNull();   // nothing left: no request
  });

  it('at most one send per 120 s for menu / select / pagehide without a daily or a rank-in run', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    await api.flush('menu');
    api.enqueue(pb(999, '5-9', L('5-9')));                 // unknown to boot: neither rank-in nor lazy
    t += SEND_MIN_INTERVAL_MS - 1;
    expect(await api.flush('select')).toBeNull();
    expect(await api.flush('pagehide')).toBeNull();
    expect(server.submits()).toHaveLength(1);
    t += 1;
    expect(await api.flush('select')).not.toBeNull();
    expect(server.submits()).toHaveLength(2);
  });

  it('dailyDone (and pagehide with a daily waiting) are not held back by the 120 s interval', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    await api.flush('menu');
    t += 1000;
    api.enqueue(daily({ balls: ['ok', 'fail', 'gold', 'fail', 'crown'], bestSub: 455, bestReplay: 'D455' })!);
    const res = await api.flush('dailyDone');
    expect(res?.results.map((r) => r.board)).toEqual([D(23)]);
    expect(server.submits()).toHaveLength(2);
  });

  it('two flushes waiting for the same lazy boot still make one send per 120 s', async () => {
    const api = mkApi();
    store.update((d) => { d.daily.dayIndex = 23; });
    for (let i = 1; i <= 6; i++) api.enqueue(pb(100 + i, `3-${i}`, L(`3-${i}`)));
    await Promise.all([api.flush('menu'), api.flush('select')]);
    expect(server.paths()).toEqual(['GET /api/boot?day=23', 'POST /api/submit']);
    expect(store.data().outbox).toHaveLength(2);
  });

  it('a flush with nothing new does not rewrite the save', async () => {
    const api = mkApi();
    await api.boot(23);
    vi.useFakeTimers();
    const w = disk.writes;
    expect(await api.flush('menu')).toBeNull();
    expect(await api.flush('select')).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(disk.writes).toBe(w);
  });

  it('pagehide fires the request synchronously (no await before fetch)', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    const n = server.calls.length;
    const p = api.flush('pagehide');
    expect(server.calls).toHaveLength(n + 1);
    expect(server.calls.at(-1)!.keepalive).toBe(true);
    await p;
  });

  it('pagehide never boots (there is no time): offline sessions just keep the queue', async () => {
    const api = mkApi();
    api.enqueue(pb(300));
    expect(await api.flush('pagehide')).toBeNull();
    expect(server.calls).toEqual([]);
    expect(store.data().outbox).toHaveLength(1);
  });

  it('batches 4 runs per request; the rest wait for the next opportunity', async () => {
    const api = mkApi();
    await api.boot(23);
    for (let i = 1; i <= 6; i++) api.enqueue(pb(100 + i, `3-${i}`, L(`3-${i}`)));
    expect(store.data().outbox).toHaveLength(6);
    await api.flush('menu');
    expect(server.submits()[0]!.runs).toHaveLength(4);
    expect(store.data().outbox.map((r) => r.level)).toEqual(['3-5', '3-6']);
    t += SEND_MIN_INTERVAL_MS;
    await api.flush('menu');
    expect(server.submits()[1]!.runs.map((r) => r.level)).toEqual(['3-5', '3-6']);
    expect(store.data().outbox).toEqual([]);
  });

  it('never sends while the server is READ_ONLY', async () => {
    server.boot = bootRes({ readOnly: true });
    const api = mkApi();
    await api.boot(23);
    expect(api.readOnly).toBe(true);
    api.enqueue(pb(300));
    expect(await api.flush('dailyDone')).toBeNull();
    expect(server.submits()).toHaveLength(0);
    expect(store.data().outbox).toHaveLength(1);
  });

  it('drops daily runs older than yesterday before sending (the server would refuse them)', async () => {
    const api = mkApi();
    await api.boot(23);
    store.update((d) => {
      d.daily.dayIndex = 23;
      d.outbox = [
        { board: D(21), level: 'd:3', replay: null, t120: null, device: 1, tries: 5, balls: 'XXXXX', nTicks: 0, queuedAt: 1 },
        { board: D(22), level: 'd:4', replay: null, t120: null, device: 1, tries: 5, balls: 'XXXXX', nTicks: 0, queuedAt: 2 },
      ];
    });
    await api.flush('menu');
    expect(server.submits()[0]!.runs.map((r) => r.board)).toEqual([D(22)]);
  });
});

describe('server answers', () => {
  async function sendAll(status: (b: string) => object): Promise<NetApi> {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    api.enqueue(pb(150, '1-1', L('1-1', '11111111')));
    api.enqueue(pb(120, '3-1', L('3-1')));
    api.enqueue(pb(130, '3-2', L('3-2')));
    server.submitStatus = (r) => status(r.board) as never;
    await api.flush('menu');
    return api;
  }

  it('accepted / unranked / notBetter / rejected are dropped; deferred stays', async () => {
    await sendAll((b) => ({
      [L('2-2')]: { status: 'deferred' },
      [L('1-1', '11111111')]: { status: 'unranked' },
      [L('3-1')]: { status: 'notBetter' },
      [L('3-2')]: { status: 'rejected', reason: 'mismatch' },
    })[b]!);
    expect(store.data().outbox.map((r) => r.board)).toEqual([L('2-2')]);
  });

  it('a run the server did not answer for stays queued', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    api.enqueue(pb(150, '1-1', L('1-1', '11111111')));
    server.handler = (c) => (c.url === '/api/submit' ? { status: 200, body: { ok: true, lite: false, results: [{ board: L('2-2'), status: 'accepted' }] } } : undefined);
    await api.flush('menu');
    expect(store.data().outbox.map((r) => r.board)).toEqual([L('1-1', '11111111')]);
  });

  it.each([
    ['429', { status: 429, body: {} }],
    ['503 READ_ONLY', { status: 503, body: {} }],
    ['network error', 'network'],
    ['1027 HTML page', { status: 200, html: true }],
  ] as const)('%s on submit: runs stay queued, silently offline, retried after the backoff', async (_, reply) => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    server.handler = (c) => (c.url === '/api/submit' ? reply : undefined);
    expect(await api.flush('menu')).toBeNull();
    expect(store.data().outbox).toHaveLength(1);
    expect(api.enabled).toBe(false);
    server.handler = null;
    t += SEND_MIN_INTERVAL_MS;                 // 2 min: past the 1-minute wait and the 120 s interval
    expect(await api.flush('menu')).not.toBeNull();
    expect(store.data().outbox).toEqual([]);
    expect(api.enabled).toBe(true);
  });

  it('400 / 413: the batch is dropped (it can never succeed) and the API stays online', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    server.handler = (c) => (c.url === '/api/submit' ? { status: 400, body: { error: 'bad' } } : undefined);
    expect(await api.flush('menu')).toBeNull();
    expect(store.data().outbox).toEqual([]);
    expect(api.enabled).toBe(true);
  });

  it('a run improved while its send was in flight is kept', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = server.fetch;
    server.handler = null;
    const api2 = createApi(store, {
      fetch: (async (u: RequestInfo | URL, i?: RequestInit) => { await gate; return orig(u, i); }) as typeof fetch,
      now: () => t, session, protocol: 'https:',
    });
    await api2.boot(23);
    const p = api2.flush('menu');
    api2.enqueue(pb(280));              // a better PB lands while the request is out
    release();
    await p;
    expect(store.data().outbox).toHaveLength(1);
    expect(store.data().outbox[0]!.t120).toBe(280);
    void api;
  });
});

describe('enqueue filters (§7.9)', () => {
  it('level runs: not queued when the server would write nothing for them (levelClass null)', async () => {
    const api = mkApi();
    await api.boot(23);                                   // 2-2: cutoff 402, par 318
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').sentSub = 455; });   // counted with 455 (bin 75)
    api.enqueue(pb(452));                                 // not faster than the 100th, the same bin as 455
    api.enqueue(pb(460));                                 // slower than the counted time
    expect(store.data().outbox).toEqual([]);
    api.enqueue(pb(449));                                 // bin 74: my histogram position moves (lazy)
    expect(store.data().outbox.map((r) => r.t120)).toEqual([449]);
    api.enqueue(pb(401));                                 // faster than the 100th (rank-in)
    expect(store.data().outbox.map((r) => r.t120)).toEqual([401]);
    api.enqueue(pb(999, '1-1', L('1-1', '11111111')));     // 1-1: cutoff null (fewer than 100)
    expect(store.data().outbox).toHaveLength(2);
    api.enqueue(pb(999, '5-9', L('5-9')));                 // unknown to boot: unconditionally
    expect(store.data().outbox).toHaveLength(3);
    api.enqueue(pb(999, '2-2', L('2-2', 'deadbeef')));     // our key differs from the server's: no filter
    expect(store.data().outbox).toHaveLength(4);
  });

  it('before boot or offline, level PBs are queued unconditionally', async () => {
    const api = mkApi();
    api.enqueue(pb(999));
    expect(store.data().outbox).toHaveLength(1);
    store.update((d) => { d.outbox = []; });
    server.handler = () => 'network';
    await api.boot(23);
    api.enqueue(pb(999));
    expect(store.data().outbox).toHaveLength(1);
  });

  it('beating the AI for the first time is reported even outside the top 100', async () => {
    const boot = bootRes();
    boot.boards['2-2']!.cutoff = 250;                     // top 100 is already faster than par 318
    server.boot = boot;
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { const p = ensureLevel(d, '2-2', '9f3a12bc'); p.bestSub = 305; p.sentSub = 305; });
    api.enqueue(pb(330));                                 // above par, slower than the counted time: dropped
    expect(store.data().outbox).toEqual([]);
    api.enqueue(pb(302));                                 // below par, first time (same histogram bin as 305): queued
    expect(store.data().outbox).toHaveLength(1);
    server.submitStatus = () => ({ status: 'accepted', rank: 180, aiBeaten: true, counted: 302 });
    await api.flush('menu');
    expect(store.data().levels['2-2']).toMatchObject({ aiBeatenSent: true, sentSub: 302 });
    api.enqueue(pb(301));                                 // already counted as AI-beaten, same bin: not again
    expect(store.data().outbox).toEqual([]);
  });

  it('an unranked / notBetter answer for a sub-par run also marks the AI-beaten report as done', async () => {
    const boot = bootRes();
    boot.boards['2-2']!.cutoff = 250;
    server.boot = boot;
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc'); });
    api.enqueue(pb(300));
    server.submitStatus = () => ({ status: 'unranked' });
    await api.flush('menu');
    expect(store.data().levels['2-2']!.aiBeatenSent).toBe(true);
    expect(store.data().outbox).toEqual([]);
  });
});

describe('first placement (§7.9 sentSub)', () => {
  it('sends the first clear whatever the cutoff; the answer\'s counted time becomes sentSub (and playSent is set)', async () => {
    const api = mkApi();
    await api.boot(23);                                   // 2-2: cutoff 402
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc'); });
    api.enqueue(pb(900));                                 // far below the 100th: still the first placement (lazy)
    expect(store.data().outbox.map((r) => r.t120)).toEqual([900]);
    server.submitStatus = () => ({ status: 'unranked', rank: 700, counted: 900 });
    await api.flush('pagehide');                          // lazy runs ride the pagehide
    expect(store.data().levels['2-2']).toMatchObject({ playSent: true, sentSub: 900 });
    expect(store.data().outbox).toEqual([]);
    api.enqueue(pb(890));                                 // counted, the same bin (97): the server would write nothing
    expect(store.data().outbox).toEqual([]);
    api.enqueue(pb(800));                                 // another bin: queued again
    expect(store.data().outbox.map((r) => r.t120)).toEqual([800]);
  });

  it('a deferred answer keeps sentSub unset', async () => {
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc'); });
    api.enqueue(pb(900));
    server.submitStatus = () => ({ status: 'deferred' });
    await api.flush('pagehide');
    expect(store.data().levels['2-2']!.sentSub).toBeUndefined();
    expect(store.data().levels['2-2']!.playSent).toBeUndefined();
    expect(store.data().outbox).toHaveLength(1);
  });
});

describe('daily discipline (§7.9)', () => {
  it('first send omits prev; the accepted t120 becomes lastSentT120 and the next prev', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['fail', 'ok', null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    await api.flush('menu');
    const first = server.submits()[0]!.runs[0]!;
    expect(first).toEqual({ board: D(23), level: 'd:17', replay: 'D455', t120: 455, device: 1, tries: 2, balls: 'XO---' });
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: 455 });

    // Not improved: nothing more to send, even when all balls are used.
    expect(daily({ balls: ['fail', 'ok', 'fail', 'fail', 'fail'] })).toBeNull();
    api.enqueue({ ...first, nTicks: nTicksForScore(455), queuedAt: t, tries: 5, balls: 'XOXXX' } as PendingRun);
    expect(store.data().outbox).toEqual([]);

    // Improved: one more send with prev = 455; the final rack makes it 'final'.
    api.enqueue(daily({ balls: ['fail', 'ok', 'fail', 'crown', 'fail'], bestSub: 300, bestReplay: 'D300' })!);
    const res = await api.flush('dailyDone');
    expect(res).not.toBeNull();
    expect(server.submits()[1]!.runs[0]).toMatchObject({ t120: 300, tries: 5, balls: 'XOXCX', prev: 455 });
    expect(store.data().daily).toMatchObject({ submitted: 'final', lastSentT120: 300 });

    // After the final send only a strict improvement of the record still goes out (R8 safety net: something may
    // have marked the day 'final' early with a worse run -- an optimistic pagehide commit -- and the day's real
    // best must not be dropped unsent). dailySendDue() never builds such a run once the rack is complete, so in
    // the game this branch only catches a run that was already queued.
    api.enqueue({ board: D(23), level: 'd:17', replay: 'D300', t120: 300, device: 1, tries: 5, balls: 'XOXCX', nTicks: 180, queuedAt: t });
    expect(store.data().outbox, 'not better than the last accepted send: dropped').toEqual([]);
    api.enqueue({ board: D(23), level: 'd:17', replay: 'D200', t120: 200, device: 1, tries: 5, balls: 'XOXCX', nTicks: 130, queuedAt: t });
    expect(store.data().outbox.map((r) => r.t120), 'a strict improvement is kept').toEqual([200]);
    await api.flush('dailyDone');
    expect(server.submits()[2]!.runs[0]).toMatchObject({ t120: 200, prev: 300 });
    expect(store.data().outbox).toEqual([]);
  });

  it('a day without success is reported as participation (replay/t120 null), then prev = null', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['fail', 'fail', null, null, null], bestSub: null, bestReplay: null })!);
    await api.flush('menu');
    expect(server.submits()[0]!.runs[0]).toEqual({ board: D(23), level: 'd:17', replay: null, t120: null, device: 1, tries: 2, balls: 'XX---' });
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: null });
    t += SEND_MIN_INTERVAL_MS;
    api.enqueue(daily({ balls: ['fail', 'fail', 'ok', null, null], bestSub: 500, bestReplay: 'D500' })!);
    await api.flush('menu');
    expect(server.submits()[1]!.runs[0]).toMatchObject({ t120: 500, prev: null, tries: 3 });
  });

  it('pagehide commits the daily send up front so a lost answer is not counted twice', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    server.handler = (c) => (c.url === '/api/submit' ? 'hang' : undefined);   // the page dies before the answer
    void api.flush('pagehide');
    expect(server.submits()).toHaveLength(1);
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: 455 });
    expect(store.data().outbox).toEqual([]);

    // The next session the same day: an improved record goes out with prev = 455.
    server.handler = null;
    const api2 = mkApi();
    await api2.boot(23);
    api2.enqueue(daily({ balls: ['ok', 'crown', null, null, null], bestSub: 300, bestReplay: 'D300' })!);
    await api2.flush('menu');
    expect(server.submits().at(-1)!.runs[0]).toMatchObject({ t120: 300, prev: 455 });
  });

  it('pagehide while offline: the daily run just enqueued is persisted for the next session', async () => {
    server.handler = () => 'network';
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', 'fail', null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    expect(await api.flush('pagehide')).toBeNull();
    const onDisk = JSON.parse(disk.getItem(SAVE_KEY)!) as SaveV1;
    expect(onDisk.outbox.map((r) => r.board)).toEqual([D(23)]);
    expect(onDisk.daily.submitted).toBe('none');
  });

  it('pagehide: the optimistic daily commit is on disk before the answer comes', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    server.handler = (c) => (c.url === '/api/submit' ? 'hang' : undefined);
    void api.flush('pagehide');
    const onDisk = JSON.parse(disk.getItem(SAVE_KEY)!) as SaveV1;
    expect(onDisk.daily).toMatchObject({ submitted: 'partial', lastSentT120: 455 });
    expect(onDisk.outbox).toEqual([]);
  });

  it('pagehide: when the page survives and the send failed, the daily commit is rolled back', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    server.handler = (c) => (c.url === '/api/submit' ? 'network' : undefined);
    expect(await api.flush('pagehide')).toBeNull();
    expect(store.data().daily).toMatchObject({ submitted: 'none', lastSentT120: null });
    expect(store.data().outbox.map((r) => r.board)).toEqual([D(23)]);
    expect('prev' in store.data().outbox[0]!).toBe(false);
  });

  it('deferred dailies stay queued and are retried with a fresh prev', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    server.submitStatus = () => ({ status: 'deferred' });
    await api.flush('menu');
    expect(store.data().outbox).toHaveLength(1);
    expect(store.data().daily.submitted).toBe('none');
    server.submitStatus = () => ({ status: 'accepted', rank: 5, pct: 1.2 });
    t += SEND_MIN_INTERVAL_MS;
    const res = await api.flush('menu');
    expect(res?.results[0]).toMatchObject({ status: 'accepted', pct: 1.2 });
    expect(store.data().outbox).toEqual([]);
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: 455 });
  });

  it('pagehide while a dailyDone send is still out: the day is committed too (no double count next session)', async () => {
    const g = gatedFetch();
    const api = mkApi({ fetch: g.fetch });
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', 'fail', 'gold', 'fail', 'crown'], bestSub: 455, bestReplay: 'D455' })!);
    void api.flush('dailyDone');                 // the answer never comes: the tab closes right after
    expect(server.submits()).toHaveLength(1);
    expect(store.data().daily.submitted).toBe('none');
    void api.flush('pagehide');
    expect(server.submits()).toHaveLength(1);    // not sent twice
    const onDisk = JSON.parse(disk.getItem(SAVE_KEY)!) as SaveV1;
    expect(onDisk.daily).toMatchObject({ submitted: 'final', lastSentT120: 455 });
    expect(onDisk.outbox).toEqual([]);
  });

  it('...and when the page survives and that send fails, the commit is rolled back and the run re-queued', async () => {
    let fail!: () => void;
    const gate = new Promise<void>((r) => { fail = r; });
    const f = (async (u: RequestInfo | URL, i?: RequestInit) => {
      if (String(u) === '/api/submit') {
        server.fetch(u, i).catch(() => {});
        await gate;
        throw new TypeError('Failed to fetch');
      }
      return server.fetch(u, i);
    }) as typeof fetch;
    const api = mkApi({ fetch: f });
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', 'fail', null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    const p = api.flush('dailyDone');
    void api.flush('pagehide');
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: 455 });
    fail();
    expect(await p).toBeNull();
    expect(store.data().daily).toMatchObject({ submitted: 'none', lastSentT120: null });
    expect(store.data().outbox.map((r) => r.board)).toEqual([D(23)]);
  });

  it('a daily entry merged while its first send was out is not sent again unless the record improved', async () => {
    const g = gatedFetch();
    const api = mkApi({ fetch: g.fetch });
    await api.boot(23);
    api.enqueue(daily({ balls: ['ok', 'fail', null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    const p = api.flush('menu');
    // One more ball (a fail) while the request is out: the queued entry now differs (3 tries) and stays.
    api.enqueue(daily({ balls: ['ok', 'fail', 'fail', null, null] })!);
    g.release();
    await p;
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: 455 });
    t += SEND_MIN_INTERVAL_MS;
    expect(await api.flush('menu')).toBeNull();  // §7.9: only an improvement is sent after a partial send
    expect(server.submits()).toHaveLength(1);
    expect(store.data().outbox).toEqual([]);
  });

  it('a daily best slower than 44.5 s (not rankable) is sent as a participation, not silently lost', async () => {
    const api = mkApi();
    await api.boot(23);
    store.update((d) => Object.assign(d.daily, { dayIndex: 23, balls: ['ok', 'fail', null, null, null], bestSub: 6000 }));
    // Built the way core/app.ts builds it: the replay and the time of the day's best, nTicks from the replay.
    api.enqueue({ board: D(23), level: 'd:17', replay: 'D6000', t120: 6000, device: 1, tries: 2, balls: 'OX---', nTicks: 3030, queuedAt: t });
    await api.flush('menu');
    expect(server.submits()[0]!.runs[0]).toEqual({ board: D(23), level: 'd:17', replay: null, t120: null, device: 1, tries: 2, balls: 'OX---' });
    expect(store.data().daily).toMatchObject({ submitted: 'partial', lastSentT120: null });
  });

  it('a daily with no ball used is never queued', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue({ board: D(23), level: 'd:17', replay: null, t120: null, device: 1, tries: 0, balls: '-----', nTicks: 0, queuedAt: t });
    expect(store.data().outbox).toEqual([]);
  });
});

describe('lite (§7.8 10)', () => {
  it('boot lite: no rival fetch, no boards, level runs wait, dailies still go', async () => {
    server.boot = bootRes({ lite: true });
    const api = mkApi();
    await api.boot(23);
    expect(api.lite).toBe(true);
    expect(await api.ghost(L('2-2'), 5)).toBeNull();
    expect(await api.board(L('2-2'))).toBeNull();
    api.enqueue(pb(300));
    api.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    await api.flush('menu');
    expect(server.paths()).toEqual(['GET /api/boot?day=23', 'POST /api/submit']);
    expect(server.submits()[0]!.runs.map((r) => r.board)).toEqual([D(23)]);
    expect(store.data().outbox.map((r) => r.board)).toEqual([L('2-2')]);
  });

  it('a submit answer with lite:true, or rejected:lite, switches lite on and keeps the run', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    server.submitStatus = () => ({ status: 'rejected', reason: 'lite' });
    await api.flush('menu');
    expect(api.lite).toBe(true);
    expect(store.data().outbox).toHaveLength(1);

    server.submitLite = true;
    const api2 = mkApi();
    await api2.boot(23);
    expect(api2.lite).toBe(false);
    api2.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    await api2.flush('dailyDone');
    expect(api2.lite).toBe(true);
    // Stays on for the session even though the (cached) boot answer says lite: false.
    expect((await api2.boot(23))?.lite).toBe(false);
    expect(api2.lite).toBe(true);
    expect(await api2.ghost(L('2-2'), 3)).toBeNull();
  });
});

describe('ghost and board reads', () => {
  it('fetches a rival ghost at most 3 times per session (cache hits are free)', async () => {
    const api = mkApi();
    await api.boot(23);
    const g = await api.ghost(L('2-2'), 37);
    expect(g).toMatchObject({ key: L('2-2'), rank: 37, replay: 'WVAB' });
    expect(server.paths().at(-1)).toBe(`GET /api/ghost/${L('2-2')}/37`);
    expect(await api.ghost(L('2-2'), 37)).toEqual(g);
    await api.ghost(L('2-2'), 36);
    await api.ghost(L('1-1', '11111111'), 1);
    expect(await api.ghost(L('2-2'), 35)).toBeNull();
    expect(server.calls.filter((c) => c.url.startsWith('/api/ghost/'))).toHaveLength(GHOST_MAX_PER_SESSION);
    // The count survives a reload within the browser session.
    const api2 = mkApi();
    await api2.boot(23);
    expect(await api2.ghost(L('2-2'), 10)).toBeNull();
    expect(server.calls.filter((c) => c.url.startsWith('/api/ghost/'))).toHaveLength(GHOST_MAX_PER_SESSION);
  });

  it('refuses malformed keys and ranks without a request', async () => {
    const api = mkApi();
    await api.boot(23);
    const n = server.calls.length;
    expect(await api.ghost('L:2-2/../x', 1)).toBeNull();
    expect(await api.ghost(L('2-2'), 0)).toBeNull();
    expect(await api.ghost(L('2-2'), 101)).toBeNull();
    expect(await api.ghost(L('2-2'), 1.5)).toBeNull();
    expect(await api.board('nope')).toBeNull();
    expect(server.calls).toHaveLength(n);
  });

  it('a missing ghost (404) is null without going offline', async () => {
    const api = mkApi();
    await api.boot(23);
    server.handler = (c) => (c.url.startsWith('/api/ghost/') ? { status: 404, body: {} } : undefined);
    expect(await api.ghost(L('2-2'), 99)).toBeNull();
    expect(api.enabled).toBe(true);
  });

  it('board(): top 100 of a ranking, cached for 60 s', async () => {
    const api = mkApi();
    await api.boot(23);
    const b = await api.board(D(23));
    expect(b).toMatchObject({ key: D(23), n: 3, top: [['0123456789abcdef', 7, 300, 5000, 1, 1]] });
    expect(server.paths().at(-1)).toBe(`GET /api/board/${D(23)}`);
    await api.board(D(23));
    expect(server.calls.filter((c) => c.url.startsWith('/api/board/'))).toHaveLength(1);
    t += 61_000;
    await api.board(D(23));
    expect(server.calls.filter((c) => c.url.startsWith('/api/board/'))).toHaveLength(2);
  });

  it('a board answer without the AI-beaten count is null', async () => {
    const api = mkApi();
    await api.boot(23);
    server.handler = (c) => (c.url.startsWith('/api/board/') ? { status: 200, body: { key: L('2-2'), n: 3, par: 318, cutoff: null, top: [] } } : undefined);
    expect(await api.board(L('2-2'))).toBeNull();
  });

  it('a malformed board answer is null and counts as offline', async () => {
    const api = mkApi();
    await api.boot(23);
    server.handler = (c) => (c.url.startsWith('/api/board/') ? { status: 200, body: { top: 'x' } } : undefined);
    expect(await api.board(L('2-2'))).toBeNull();
    expect(api.enabled).toBe(false);
  });
});

// ---- stage 2: level classes, rank-in, lazy sends, the answers' counted time (§7.9) ----

/**
 * 2-2 with `n` counted players (par 318): the top 100 at 303..402 (cutoff 402), the others spread over 403..999.
 * Returns the boot answer; `server` also gets the full board for its §5.3 level rules.
 */
function crowdBoot(n = 500): BootResponse {
  const boot = bootRes();
  const times = Array.from({ length: n }, (_, i) => (i < 100 ? 303 + i : 403 + Math.floor((597 * (i - 100)) / (n - 100))));
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  for (const x of times) h[levelBin(x)]! += 1;
  const top = times.slice(0, 100).map((x, i) => ({ pidh: `c${String(i).padStart(15, '0')}`, t120: x }));
  boot.boards['2-2'] = {
    ...boot.boards['2-2']!, n, cutoff: 402, hist: trimHist(h),
    top: top.slice(0, 10).map((r) => [r.pidh, 1, r.t120, 5000, 1, 1]),
  };
  server.levelBoards.set(L('2-2'), { top, runs: new Map(), counted: new Map(top.map((r) => [r.pidh, r.t120])), hist: h, n, par: 318 });
  return boot;
}

describe('levelClass (§7.9)', () => {
  const board = (over: Partial<BootResponse['boards'][string]> = {}): BootResponse['boards'][string] =>
    ({ key: L('2-2'), n: 812, aiBeaten: 37, par: 318, cutoff: 402, top: [], wr: null, ...over });
  const save = (p: Partial<SaveV1['levels'][string]> = {}): SaveV1 => {
    const d = defaultSave('ja');
    Object.assign(ensureLevel(d, '2-2', '9f3a12bc'), p);
    return d;
  };

  it('rankIn / urgent / lazy / null', () => {
    expect(levelClass(pb(999), save({ sentSub: 300 }), board({ cutoff: null }))).toBe('rankIn');   // fewer than 100 rows
    expect(levelClass(pb(401), save({ sentSub: 300 }), board())).toBe('rankIn');                  // faster than the 100th
    expect(levelClass(pb(402), save({ sentSub: 300 }), board())).toBeNull();                      // a tie with the 100th is out
    expect(levelClass(pb(300), save({ sentSub: 305 }), board({ cutoff: 250 }))).toBe('urgent');   // first AI-beaten
    expect(levelClass(pb(301), save({ sentSub: 305, aiBeatenSent: true }), board({ cutoff: 250 }))).toBeNull();
    expect(levelClass(pb(900), save(), board())).toBe('lazy');                                     // not counted yet
    expect(levelClass(pb(900, '2-2'), defaultSave('ja'), board())).toBe('lazy');                   // no progress at all
    expect(levelClass(pb(449), save({ sentSub: 455 }), board())).toBe('lazy');                     // another bin (74 < 75)
    expect(levelClass(pb(451), save({ sentSub: 455 }), board())).toBeNull();                       // the same bin
    expect(levelClass(pb(460), save({ sentSub: 455 }), board())).toBeNull();                       // slower than counted
  });

  it('lite is not a class: a top-100 run stays queued through lite (only takeBatch holds level runs back)', async () => {
    server.boot = bootRes({ lite: true });
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').sentSub = 390; });
    api.enqueue(pb(389));                                  // the same bin as 390, but faster than the 100th
    expect(store.data().outbox.map((r) => r.t120)).toEqual([389]);
  });

  it('a queued run whose class became null is dropped before a send (not while lite or soft)', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(900));                                  // lazy: not counted yet
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').sentSub = 890; });   // counted meanwhile (another tab)
    expect(await api.flush('pagehide')).toBeNull();
    expect(store.data().outbox).toEqual([]);
    expect(server.submits()).toEqual([]);
  });
});

describe('lazy runs (§7.9: first placements and histogram moves wait for a pagehide)', () => {
  function lazyRuns(api: NetApi, n: number): void {
    for (let i = 1; i <= n; i++) {
      store.update((d) => { ensureLevel(d, `3-${i}`, '9f3a12bc'); });
      api.enqueue(pb(900 + i, `3-${i}`, L(`3-${i}`)));
    }
  }
  function boot3(): BootResponse {
    const boot = bootRes();
    for (let i = 1; i <= 9; i++) boot.boards[`3-${i}`] = { key: L(`3-${i}`), n: 900, aiBeaten: 3, par: 318, cutoff: 402, top: [], wr: null };
    return boot;
  }

  it('menu / select skip a lazy-only batch of < 4 without using up the 120 s interval; 4 go at once', async () => {
    server.boot = boot3();
    server.submitStatus = (r) => ({ status: 'unranked', counted: r.t120 });
    const api = mkApi();
    await api.boot(23);
    lazyRuns(api, 3);
    expect(await api.flush('menu')).toBeNull();
    expect(await api.flush('select')).toBeNull();
    expect(server.submits()).toEqual([]);
    // the interval was not used: a rank-in class run goes out with the next select at once, the lazy ones ride along
    api.enqueue(pb(300));
    expect(await api.flush('select')).not.toBeNull();
    expect(server.submits()[0]!.runs.map((r) => r.level)).toEqual(['2-2', '3-1', '3-2', '3-3']);
    // four lazy runs fill a request: sent
    t += SEND_MIN_INTERVAL_MS;
    lazyRuns(api, 7);                                      // 3-4 .. 3-7 are new; 3-1 .. 3-3 were answered
    expect(await api.flush('menu')).not.toBeNull();
    expect(server.submits()[1]!.runs.map((r) => r.level)).toEqual(['3-4', '3-5', '3-6', '3-7']);
  });

  it('pagehide sends lazy runs', async () => {
    server.boot = boot3();
    const api = mkApi();
    await api.boot(23);
    lazyRuns(api, 2);
    expect(await api.flush('pagehide')).not.toBeNull();
    expect(server.submits()[0]!.runs.map((r) => r.level)).toEqual(['3-1', '3-2']);
  });

  it('runs queued before this session are never lazy: they ride the first flush', async () => {
    server.boot = boot3();
    store.update((d) => {
      ensureLevel(d, '3-1', '9f3a12bc');
      d.outbox = [pb(901, '3-1', L('3-1'))];
      d.outbox[0]!.queuedAt = t - 1;
    });
    const api = mkApi();                                   // sessionStart = t
    await api.boot(23);
    expect(await api.flush('menu')).not.toBeNull();
    expect(server.submits()[0]!.runs.map((r) => r.level)).toEqual(['3-1']);
  });

  it('soft (boot or an answer, then sticky): lazy runs stay queued, others still go', async () => {
    server.boot = { ...boot3(), soft: true };
    const api = mkApi();
    await api.boot(23);
    expect(api.soft).toBe(true);
    lazyRuns(api, 2);
    expect(await api.flush('pagehide')).toBeNull();
    api.enqueue(pb(300));                                  // rank-in
    expect(await api.flush('pagehide')).not.toBeNull();
    expect(server.submits()[0]!.runs.map((r) => r.level)).toEqual(['2-2']);
    expect(store.data().outbox.map((r) => r.level)).toEqual(['3-1', '3-2']);

    // an answer says soft: sticky for the session, whatever the (cached) boot says
    store.update((d) => { d.outbox = []; });
    server.boot = boot3();
    server.submitSoft = true;
    session = new MemStorage();
    const api2 = mkApi();
    await api2.boot(23);
    expect(api2.soft).toBe(false);
    api2.enqueue(pb(299));
    await api2.flush('select');
    expect(api2.soft).toBe(true);
    lazyRuns(api2, 2);
    t += SEND_MIN_INTERVAL_MS;
    expect(await api2.flush('pagehide')).toBeNull();
    expect(store.data().outbox.map((r) => r.level)).toEqual(['3-1', '3-2']);
  });
});

describe("flush('rankIn') (§7.9: a top-100 candidate at the success tick)", () => {
  it('is exempt from the 120 s interval and puts its board first', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(999, '5-9', L('5-9')));
    await api.flush('menu');
    api.enqueue(daily({ balls: ['ok', null, null, null, null], bestSub: 455, bestReplay: 'D455' })!);
    api.enqueue(pb(999, '5-8', L('5-8')));
    api.enqueue(pb(300));
    t += 1000;
    const res = await api.flush('rankIn', { first: L('2-2') });
    expect(res?.results[0]).toMatchObject({ board: L('2-2'), status: 'accepted' });
    expect(server.submits()[1]!.runs.map((r) => r.board)).toEqual([L('2-2'), D(23), L('5-8')]);
  });

  it('a second rank-in within 15 s is deferred (not dropped) and goes when the gap ends; the newest board goes first', async () => {
    vi.useFakeTimers();
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    await api.flush('rankIn', { first: L('2-2') });
    t += 5000;
    api.enqueue(pb(150, '1-1', L('1-1', '11111111')));
    const p1 = api.flush('rankIn', { first: L('1-1', '11111111') });
    api.enqueue(pb(999, '5-9', L('5-9')));
    const p2 = api.flush('rankIn', { first: L('5-9') });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(server.submits()).toHaveLength(1);
    t += 10_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(server.submits()).toHaveLength(2);
    expect(server.submits()[1]!.runs.map((r) => r.board)).toEqual([L('5-9'), L('1-1', '11111111')]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(r1?.results).toHaveLength(2);
  });

  it('returns the answer of the request already carrying the same run', async () => {
    const g = gatedFetch();
    const api = mkApi({ fetch: g.fetch });
    await api.boot(23);
    api.enqueue(pb(300));
    const p1 = api.flush('rankIn', { first: L('2-2') });
    const p2 = api.flush('rankIn', { first: L('2-2') });
    g.release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(server.submits()).toHaveLength(1);
    expect(r2).toBe(r1);
  });

  it('a faster run queued while the first one flies follows once that request is back', async () => {
    vi.useFakeTimers();
    const g = gatedFetch();
    const api = mkApi({ fetch: g.fetch });
    await api.boot(23);
    api.enqueue(pb(300));
    void api.flush('rankIn', { first: L('2-2') });
    api.enqueue(pb(290));
    const p2 = api.flush('rankIn', { first: L('2-2') });
    g.release();
    t += RANKIN_MIN_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(RANKIN_MIN_INTERVAL_MS);
    const r2 = await p2;
    expect(server.submits().map((b) => b.runs[0]!.t120)).toEqual([300, 290]);
    expect(r2?.results[0]?.board).toBe(L('2-2'));
    expect(store.data().outbox).toEqual([]);
  });

  it('null when lite, READ_ONLY, offline, or the board is not queued', async () => {
    const api = mkApi();
    expect(await api.flush('rankIn', { first: L('2-2') })).toBeNull();          // nothing queued
    api.enqueue(pb(300));
    server.handler = () => 'network';
    expect(await api.flush('rankIn', { first: L('2-2') })).toBeNull();          // offline (the lazy boot fails)
    expect(store.data().outbox).toHaveLength(1);

    for (const over of [{ lite: true }, { readOnly: true }]) {
      server.handler = null;
      server.boot = bootRes(over);
      session = new MemStorage();
      const a = mkApi();
      await a.boot(23);
      const n = server.submits().length;
      expect(await a.flush('rankIn', { first: L('2-2') })).toBeNull();
      expect(server.submits()).toHaveLength(n);
    }
    expect(store.data().outbox).toHaveLength(1);
  });

  it('a pagehide takes over a deferred rank-in: the run goes first in its send, the waiting caller gets that answer', async () => {
    vi.useFakeTimers();
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    await api.flush('rankIn', { first: L('2-2') });
    t += 3000;
    api.enqueue(pb(150, '1-1', L('1-1', '11111111')));
    const waiting = api.flush('rankIn', { first: L('1-1', '11111111') });
    expect(server.submits()).toHaveLength(1);
    const ph = api.flush('pagehide');                     // within 120 s of the last send: exempt for the rank-in run
    expect(server.submits()).toHaveLength(2);
    expect(server.submits()[1]!.runs.map((r) => r.board)).toEqual([L('1-1', '11111111')]);
    expect(await waiting).toEqual(await ph);
    await vi.advanceTimersByTimeAsync(RANKIN_MIN_INTERVAL_MS);
    expect(server.submits()).toHaveLength(2);             // the timer is gone
  });
});

describe('level answers (§7.9: counted, the boot patch, no-store, onResults)', () => {
  it('counted: a number becomes sentSub, null removes it, absent (an older server) keeps it', async () => {
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').sentSub = 700; });
    const answer = async (t120: number, counted: number | null | undefined): Promise<number | undefined> => {
      api.enqueue(pb(t120));
      server.submitStatus = () => ({ status: 'accepted', rank: 5, ...(counted !== undefined ? { counted } : {}) });
      t += SEND_MIN_INTERVAL_MS;
      await api.flush('menu');
      expect(store.data().outbox).toEqual([]);
      return store.data().levels['2-2']!.sentSub;
    };
    expect(await answer(380, 380)).toBe(380);
    expect(await answer(370, undefined)).toBe(380);       // an older server: unknown, kept
    expect(await answer(360, null)).toBeUndefined();       // not counted
    expect(await answer(350, 12.5)).toBeUndefined();       // malformed: ignored
  });

  it('accepted: the next board() skips both caches once (cache: no-store)', async () => {
    const api = mkApi();
    await api.boot(23);
    await api.board(L('2-2'));
    await api.board(L('2-2'));
    const boards = (): Call[] => server.calls.filter((c) => c.url.startsWith('/api/board/'));
    expect(boards().map((c) => c.cache)).toEqual(['default']);
    api.enqueue(pb(300));
    await api.flush('rankIn', { first: L('2-2') });
    await api.board(L('2-2'));
    await api.board(L('2-2'));                             // cached again
    expect(boards().map((c) => c.cache)).toEqual(['default', 'no-store']);
    // an unranked answer changes nothing
    server.submitStatus = () => ({ status: 'unranked', rank: 300, counted: 900 });
    store.update((d) => { ensureLevel(d, '1-2', '9f3a12bc'); });
    api.enqueue(pb(900, '1-2', L('1-2')));
    await api.flush('pagehide');
    t += 61_000;
    await api.board(L('1-2'));
    expect(boards().at(-1)!.cache).toBe('default');
  });

  it('the boot board follows the answer (cutoff, n, my histogram bin), also in the sessionStorage copy', async () => {
    server.boot = crowdBoot(500);
    const api = mkApi();
    await api.boot(23);
    const before = levelHistOf(api.lastBoot()!.boards['2-2']!)!;
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').sentSub = 700; });
    api.enqueue(pb(600));
    server.submitStatus = () => ({ status: 'unranked', rank: 170, n: 520, cutoff: 398, counted: 600 });
    await api.flush('pagehide');
    const b = api.lastBoot()!.boards['2-2']!;
    expect([b.cutoff, b.n]).toEqual([398, 520]);
    const after = levelHistOf(b)!;
    expect(after[levelBin(700)]).toBe(before[levelBin(700)]! - 1);
    expect(after[levelBin(600)]).toBe(before[levelBin(600)]! + 1);
    // a new page load in the same browser session reads the patched copy (same `at`: it expires as before)
    const cached = JSON.parse(session.getItem(BOOT_CACHE_KEY)!) as { at: number; res: BootResponse };
    expect(cached.at).toBe(1_790_000_000_000);
    expect(cached.res.boards['2-2']).toMatchObject({ cutoff: 398, n: 520, hist: b.hist });
    const api2 = mkApi();
    expect((await api2.boot(23))!.boards['2-2']!.cutoff).toBe(398);
    expect(server.paths().filter((x) => x.startsWith('GET /api/boot'))).toHaveLength(1);
  });

  it('a bad histogram in boot keeps the boot valid; levelHistOf / boardHistOf are null then', async () => {
    const boot = bootRes();
    (boot.boards['2-2'] as { hist?: unknown }).hist = [1, -2, 'x'];
    (boot.boards['1-1'] as { hist?: unknown }).hist = 'nope';
    server.boot = boot;
    const api = mkApi();
    const b = await api.boot(23);
    expect(b).not.toBeNull();
    expect(api.enabled).toBe(true);
    expect(levelHistOf(b!.boards['2-2']!)).toBeNull();
    expect(levelHistOf(b!.boards['1-1']!)).toBeNull();
    expect(levelHistOf(crowdBoot(10).boards['2-2']!)).toHaveLength(LEVEL_HIST_BINS);
    expect(boardHistOf({ key: D(23), n: 1, aiBeaten: 0, par: 1, cutoff: null, top: [], hist: [1] })).toHaveLength(150);
    expect(boardHistOf({ key: L('2-2'), n: 1, aiBeaten: 0, par: 1, cutoff: null, top: [], hist: [1] })).toHaveLength(LEVEL_HIST_BINS);
    expect(boardHistOf({ key: L('2-2'), n: 1, aiBeaten: 0, par: 1, cutoff: null, top: [] })).toBeNull();
  });

  it('onResults gets (sent, results) after the save was updated; unsubscribe works; a throwing listener breaks nothing', async () => {
    const api = mkApi();
    await api.boot(23);
    const seen: { levels: string[]; boards: string[]; sentSub: number | undefined }[] = [];
    api.onResults(() => { throw new Error('boom'); });
    const stop = api.onResults((sent, results) => {
      seen.push({ levels: sent.map((r) => r.level), boards: results.map((r) => r.board), sentSub: store.data().levels['2-2']?.sentSub });
    });
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc'); });
    api.enqueue(pb(300));
    server.submitStatus = () => ({ status: 'accepted', rank: 3, counted: 300 });
    expect(await api.flush('rankIn', { first: L('2-2') })).not.toBeNull();
    expect(seen).toEqual([{ levels: ['2-2'], boards: [L('2-2')], sentSub: 300 }]);
    expect(store.data().outbox).toEqual([]);
    stop();
    api.enqueue(pb(290));
    t += RANKIN_MIN_INTERVAL_MS;
    await api.flush('rankIn', { first: L('2-2') });
    expect(seen).toHaveLength(1);
  });
});

describe('the §5.3 level rules end to end (fakeServer levelRules)', () => {
  it('a device sends only what moves the server: first placement, a new bin, a top-100 entry; never a same-bin PB', async () => {
    server.boot = crowdBoot(500);
    server.levelRules = true;
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc'); });
    // first placement: lazy, rides the pagehide; counted = 700, rank estimated from the histogram
    api.enqueue(pb(700));
    const r1 = await api.flush('pagehide');
    const want = estimateLevelRank(server.levelBoard(L('2-2'), '2-2').hist, 402, 700, null)!;
    expect(want.rank).toBeGreaterThan(100);
    expect(r1?.results[0]).toMatchObject({ status: 'unranked', counted: 700, rank: want.rank, n: 501, was: null });
    expect(store.data().levels['2-2']!.sentSub).toBe(700);
    expect(server.playWrites).toBe(1);
    // a faster PB in the same bin: the server would write nothing, so it is never sent
    api.enqueue(pb(698));                                 // bin 89 = [696, 720), like 700
    expect(store.data().outbox).toEqual([]);
    // a new bin: one row, `was` is the estimate of the old position
    api.enqueue(pb(600));
    t += SEND_MIN_INTERVAL_MS;
    const r2 = await api.flush('pagehide');
    expect(r2?.results[0]).toMatchObject({ status: 'unranked', counted: 600 });
    expect(r2!.results[0]!.was).toBeGreaterThan(r2!.results[0]!.rank!);
    expect(server.playWrites).toBe(2);
    // a top-100 entry: rank-in, exact rank, accepted
    api.enqueue(pb(401));
    const r3 = await api.flush('rankIn', { first: L('2-2') });
    expect(r3?.results[0]).toMatchObject({ status: 'accepted', rank: 100, counted: 401, cutoff: 401 });
    expect(stampKind(r3!.results[0]!.status, r3!.results[0]!.rank!, r3!.results[0]!.was!)).toBe('in');
    expect(server.playWrites).toBe(3);
  });

  it('soft: an out-of-top first placement is answered without being counted; lite: rejected and kept', async () => {
    server.boot = crowdBoot(500);
    server.levelRules = true;
    server.submitSoft = true;
    const api = mkApi();
    await api.boot(23);
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc'); });
    api.enqueue(pb(700));
    const r = await api.flush('pagehide');                // not soft yet on this client: it goes, the server writes 0
    expect(r?.results[0]).toMatchObject({ status: 'unranked', counted: null });
    expect(server.playWrites).toBe(0);
    expect(store.data().levels['2-2']!.sentSub).toBeUndefined();
    expect(api.soft).toBe(true);

    server.submitSoft = false;
    server.submitLite = true;
    session = new MemStorage();
    const api2 = mkApi();
    await api2.boot(23);
    api2.enqueue(pb(650));
    await api2.flush('pagehide');
    expect(api2.lite).toBe(true);
    expect(store.data().outbox.map((x) => x.t120)).toEqual([650]);
    expect(server.playWrites).toBe(0);
  });
});
