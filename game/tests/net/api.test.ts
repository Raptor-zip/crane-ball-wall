// API client: enablement, boot cache, silent offline + backoff, outbox discipline (GAME_DESIGN.md §7.7, §7.9, §7.12). Owner: O8.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MINUTES, BOOT_CACHE_KEY, BOOT_TIMEOUT_MS, GHOST_MAX_PER_SESSION, SEND_MIN_INTERVAL_MS, backoffDelayMs,
  createApi, netAllowed, type ApiOptions, type NetApi,
} from '../../src/net/api';
import { dailyPendingRun, levelPendingRun, nTicksForScore, type PendingRun } from '../../src/net/outbox';
import { SAVE_KEY, createStore, ensureLevel, type LocalStore, type SaveV1 } from '../../src/store/save';
import { MemStorage } from '../store/helpers';
import { D, FakeServer, L, bootRes } from './fakeServer';
import type { BootResponse } from '../../src/shared/api';

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

  it('at most one send per 120 s for menu / select / pagehide without a daily', async () => {
    const api = mkApi();
    await api.boot(23);
    api.enqueue(pb(300));
    await api.flush('menu');
    api.enqueue(pb(1, '1-1', L('1-1', '11111111')));
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
  it('level PB: only when faster than the boot cutoff, or while the board has < 100 rows', async () => {
    const api = mkApi();
    await api.boot(23);                                   // 2-2: cutoff 402, par 318
    api.enqueue(pb(402));                                 // not faster than the 100th, not below par
    api.enqueue(pb(450));
    expect(store.data().outbox).toEqual([]);
    api.enqueue(pb(401));
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
    store.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').bestSub = 300; });
    api.enqueue(pb(330));                                 // above par: dropped
    expect(store.data().outbox).toEqual([]);
    api.enqueue(pb(300));                                 // below par, first time: queued
    expect(store.data().outbox).toHaveLength(1);
    server.submitStatus = () => ({ status: 'accepted', rank: null, aiBeaten: true });
    await api.flush('menu');
    expect(store.data().levels['2-2']!.aiBeatenSent).toBe(true);
    api.enqueue(pb(290));                                 // already counted: not again
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
