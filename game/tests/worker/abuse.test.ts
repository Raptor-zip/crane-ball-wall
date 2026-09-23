// Abuse cases of the public API (pre-release review, findings worker-1 .. worker-6). Owner: O9.
//   worker-1  a public replay re-submitted under fresh secrets (copies, re-encoded copies, lightly edited copies)
//   worker-2  rate-limit keys: one IPv6 /64 is one client; the fallback bucket map is never cleared by a key flood
//   worker-3  cross-site "simple" POSTs to /api/submit
//   worker-4  a forged daily `prev` resent again and again
//   worker-5  submits that end early still reach the request counter
//   worker-6  a write batch that committed before its error surfaced is answered, not deferred
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RANKED_T120, histBin, type BoardResponse, type BootResponse, type SubmitResponse, type SubmitResult, type SubmitRun,
} from '../../src/shared/api';
import { simulateReplay } from '../../src/sim/replay';
import { Status } from '../../src/sim/run';
import { b64urlDecode, b64urlEncode } from '../../src/sim/b64';
import { FP_LENGTH, FP_SEGMENTS, isDuplicateRun, runFingerprint } from '../../worker/dup';
import { parseTop, type TopRow } from '../../worker/db';
import { allowRequest, jstDate, pendingForTest, rateKey } from '../../worker/limits';
import { decide, type DecideInput } from '../../worker/routes/submit';
import { setParOverrideForTest } from '../../worker/verify';
import type { Env } from '../../worker/index';
import {
  BOARD_UPDATE_SQL, NOW, awayFromMinuteBoundary, boardRow, call, dailyAt, encode, fakeDailyPool, fakeRows, level, levelKey,
  pidhOf, proxyDb, request, resetAll, runRow, seedBoard, submit, successBot, type BotRun,
} from './helpers';

const P11 = level('1-1').physics;
const KEY = levelKey('1-1');
const POOL = fakeDailyPool(3000);
let wrBot: BotRun | null = null;
const wr = (): BotRun => (wrBot ??= successBot(P11, { moveS: 4.5 }));
const run11 = (bot: BotRun, over: Partial<SubmitRun> = {}): SubmitRun =>
  ({ board: KEY, level: '1-1', replay: bot.replay, t120: bot.t120, device: 1, ...over });

/** A fresh random identity, as an attacker would make one per copy. */
function freshBody(runs: SubmitRun[], nameSeed = 7): unknown {
  return { v: 1, secret: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))), nameSeed, runs };
}
async function first(res: Response): Promise<SubmitResult> {
  expect(res.status).toBe(200);
  return ((await res.json()) as SubmitResponse).results[0]!;
}

/** The replay with its header's device byte changed: other bytes, the same inputs. */
function withDevice(replay: string, device: number): string {
  const bytes = b64urlDecode(replay);
  bytes[8] = device;
  return b64urlEncode(bytes);
}

/** Single-tick +-1 edits of `bot` that keep its exact time and length (what a blind copier hopes for). */
function scoreKeepingEdits(bot: BotRun, phys = P11, max = 8): { k: number; d: number }[] {
  const out: { k: number; d: number }[] = [];
  for (let k = 1; k < bot.qs.length && out.length < max; k += 3) {
    for (const d of [1, -1]) {
      const q = bot.qs[k]! + d;
      if (q < -127 || q > 127) continue;
      const qs = bot.qs.slice();
      qs[k] = q;
      const r = simulateReplay(phys, qs);
      if (r.status === Status.Success && r.score === bot.t120 && r.ticks === qs.length) {
        out.push({ k, d });
        break;
      }
    }
  }
  return out;
}

beforeEach(async () => {
  await resetAll({ pool: POOL });
});

// ---- worker-1 ----

describe('worker-1: copies of a public replay', () => {
  it('fingerprints the decoded inputs: constant ranges are 000, the device byte does not matter', () => {
    const fp = runFingerprint(wr().qs);
    expect(fp).toMatch(new RegExp(`^[0-9a-f]{${FP_LENGTH}}$`));
    expect(runFingerprint(new Int8Array(160).fill(5)).slice(8)).toBe('000'.repeat(FP_SEGMENTS));
    const dec = b64urlDecode(withDevice(wr().replay, 0));
    expect(dec[8]).toBe(0);
    expect(withDevice(wr().replay, 0)).not.toBe(wr().replay);
  });

  it('isDuplicateRun: same length and >= 12 identical non-constant ranges of 16, or the same whole run', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 200) - 100;
    const base = Int8Array.from({ length: 320 }, () => rnd());
    const t120 = 2 * 320 - 60;   // a time whose replay has 320 ticks
    const row = (qs: Int8Array, t = t120): TopRow => ['other', 1, t, -1, 0, 0, runFingerprint(qs)];
    const editRanges = (n: number): Int8Array => {
      const qs = base.slice();
      for (let s = 0; s < n; s++) qs[s * 20 + 3] = qs[s * 20 + 3]! === 100 ? 99 : qs[s * 20 + 3]! + 1;
      return qs;
    };
    expect(isDuplicateRun(runFingerprint(base), t120, [row(base)])).toBe(true);
    expect(isDuplicateRun(runFingerprint(editRanges(4)), t120, [row(base)])).toBe(true);    // 12 of 16 still identical
    expect(isDuplicateRun(runFingerprint(editRanges(5)), t120, [row(base)])).toBe(false);   // 11 of 16
    expect(isDuplicateRun(runFingerprint(base), t120 + 2, [row(base)])).toBe(false);        // another length
    expect(isDuplicateRun(runFingerprint(base), t120, [['old', 1, t120, -1, 0, 0]])).toBe(false);   // row without fingerprint
    // Ranges where both runs just hold one value (idle, a held key, full force) are no evidence.
    const flat = base.slice();
    flat.fill(0, 0, 260);
    const other = flat.slice();
    for (let i = 260; i < 320; i++) other[i] = 40 + (i % 3);
    expect(isDuplicateRun(runFingerprint(other), t120, [row(flat)])).toBe(false);
  });

  it('30 fresh identities posting the WR replay (and a re-encoded variant) are all rejected; nobody is displaced', async () => {
    const bot = wr();
    const real = fakeRows(99, bot.t120 + 50);
    await seedBoard(KEY, real);
    expect(await first(await submit(request(1, [run11(bot)])))).toMatchObject({ status: 'accepted', rank: 1, n: 100 });
    const boot = (await (await call('/api/boot?day=9')).json()) as BootResponse;
    const stolen = boot.boards['1-1']!.wr!;
    expect(stolen).toBe(bot.replay);
    const variant = withDevice(stolen, 0);
    for (let i = 0; i < 30; i++) {
      const rep = i % 2 === 0 ? stolen : variant;
      expect(await first(await submit(freshBody([run11(bot, { replay: rep })], i)))).toEqual({ board: KEY, status: 'rejected', reason: 'dup' });
    }
    const br = (await boardRow(KEY))!;
    const top = JSON.parse(br.top) as unknown[][];
    expect(top.filter((r) => r[2] === bot.t120)).toHaveLength(1);
    expect(top).toHaveLength(100);
    expect(br.n).toBe(100);
    expect((await runRow(KEY, real[98]![0]))!.replay).not.toBeNull();   // the 100th real player keeps the replay
  });

  it('copies with a few single-tick edits that keep the exact time are rejected too', async () => {
    const bot = wr();
    const edits = scoreKeepingEdits(bot);
    expect(edits.length).toBeGreaterThanOrEqual(4);
    await submit(request(1, [run11(bot)]));
    // each edit alone, and up to four of them together
    const variants: Int8Array[] = edits.map(({ k, d }) => {
      const qs = bot.qs.slice();
      qs[k] = qs[k]! + d;
      return qs;
    });
    for (let m = 2; m <= 4; m++) {
      const qs = bot.qs.slice();
      for (const { k, d } of edits.slice(0, m)) qs[k] = qs[k]! + d;
      const r = simulateReplay(P11, qs);
      if (r.status === Status.Success && r.score === bot.t120) variants.push(qs);
    }
    for (const qs of variants) {
      expect(await first(await submit(freshBody([run11(bot, { replay: encode(P11, qs) })])))).toMatchObject({ status: 'rejected', reason: 'dup' });
    }
    expect(JSON.parse((await boardRow(KEY))!.top)).toHaveLength(1);
  });

  it('a different run with the same time is not a dup', async () => {
    const seen = new Map<number, BotRun>();
    let pair: [BotRun, BotRun] | null = null;
    for (let m = 40; m <= 120 && !pair; m++) {
      for (let w = 0; w <= 6 && !pair; w++) {
        const r = successBot(P11, { moveS: m / 20, waitTicks: w });
        const o = seen.get(r.t120);
        if (o && o.replay !== r.replay) pair = [o, r];
        else seen.set(r.t120, r);
      }
    }
    expect(pair).not.toBeNull();
    expect(await first(await submit(request(1, [run11(pair![0])])))).toMatchObject({ status: 'accepted', rank: 1 });
    expect(await first(await submit(request(2, [run11(pair![1])])))).toMatchObject({ status: 'accepted', rank: 2 });
  });

  it('an AI-beaten-only copy below the 100th is rejected and not counted', async () => {
    setParOverrideForTest({ '1-1': 5000 });
    const bot = wr();
    await seedBoard(KEY, fakeRows(99, 10));
    expect(await first(await submit(request(1, [run11(bot)])))).toMatchObject({ status: 'accepted', rank: 100, aiBeaten: true });
    const before = (await boardRow(KEY))!;
    expect(await first(await submit(freshBody([run11(bot)])))).toMatchObject({ status: 'rejected', reason: 'dup' });
    const after = (await boardRow(KEY))!;
    expect([after.n, after.ai_beaten, after.ver]).toEqual([before.n, before.ai_beaten, before.ver]);
  });

  it('the daily WR from boot cannot be posted again: n, cleared, hist and ai_beaten stay', async () => {
    const d = dailyAt(POOL, NOW);
    const bot = successBot(d.phys, { moveS: 5 });
    const drun = (replay: string): SubmitRun => ({ board: d.key, level: d.levelId, replay, t120: bot.t120, device: 1, tries: 1, balls: 'O----' });
    expect(await first(await submit(request(1, [drun(bot.replay)])))).toMatchObject({ status: 'accepted', rank: 1 });
    const boot = (await (await call('/api/boot?day=9')).json()) as BootResponse;
    const before = (await boardRow(d.key))!;
    for (const rep of [boot.daily.wr!, withDevice(boot.daily.wr!, 3)]) {
      expect(await first(await submit(freshBody([drun(rep)])))).toMatchObject({ status: 'rejected', reason: 'dup' });
    }
    const after = (await boardRow(d.key))!;
    expect([after.n, after.cleared, after.ai_beaten, after.hist, after.top]).toEqual([before.n, before.cleared, before.ai_beaten, before.hist, before.top]);
  });

  it('keeps the fingerprint on the server: boot and board answer 6-element rows', async () => {
    await submit(request(1, [run11(wr())]));
    expect(parseTop((await boardRow(KEY))!.top)[0]).toHaveLength(7);
    const boot = (await (await call('/api/boot?day=9')).json()) as BootResponse;
    expect(boot.boards['1-1']!.top[0]).toHaveLength(6);
    const board = (await (await call(`/api/board/${KEY}`)).json()) as BoardResponse;
    expect(board.top[0]).toHaveLength(6);
  });
});

// ---- worker-2 ----

describe('worker-2: rate-limit keys', () => {
  it('rateKey: IPv4 as is, IPv6 cut to its /64, IPv4-mapped IPv6 as IPv4', () => {
    const k = rateKey('2001:db8:aa:cc::1');
    expect(k).toBe('2001:0db8:00aa:00cc::/64');
    expect(rateKey('2001:db8:aa:cc:ffff::14')).toBe(k);
    expect(rateKey('2001:0DB8:00AA:00CC:0000:0000:0000:0001')).toBe(k);
    expect(rateKey('[2001:db8:aa:cc::99]')).toBe(k);
    expect(rateKey('2001:db8:aa:cd::1')).not.toBe(k);
    expect(rateKey('::1')).toBe('0000:0000:0000:0000::/64');
    expect(rateKey('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
    expect(rateKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rateKey('::ffff:c000:201')).toBe('192.0.2.1');
    expect(rateKey('64:ff9b::192.0.2.1')).toBe('0064:ff9b:0000:0000::/64');
    expect(rateKey('192.0.2.1')).toBe('192.0.2.1');
    expect(rateKey('1::2::3')).toBe('1::2::3');   // unparsable: verbatim
  });

  it('429 on the 7th submit within a minute from 7 addresses of one /64; another /64 is not affected', { timeout: 10_000 }, async () => {
    await awayFromMinuteBoundary();
    const h = [...crypto.getRandomValues(new Uint16Array(3))].map((x) => x.toString(16));
    const net = `2001:db8:${h[0]}:${h[1]}`;
    const codes: number[] = [];
    for (let i = 1; i <= 7; i++) codes.push((await submit('{}', { ip: `${net}:${h[2]}::${i.toString(16)}` })).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 400, 429]);
    expect((await submit('{}', { ip: `2001:db8:${h[0]}:${h[1] === 'ffff' ? '0' : 'ffff'}::1` })).status).toBe(400);
  });

  it('the fallback bucket: a flood of 6000 new keys does not reset a client that is being throttled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const noBinding = { ...(env as unknown as Env), RL_SUBMIT: undefined };
    const allow = (key: string): Promise<boolean> => allowRequest(noBinding, 'submit', key);
    const results: boolean[] = [];
    for (let i = 0; i < 7; i++) results.push(await allow('203.0.113.9'));
    expect(results).toEqual([true, true, true, true, true, true, false]);
    // The map holds 5000 buckets. It used to be cleared when full, which gave every client a fresh budget.
    const later: boolean[] = [];
    for (let i = 0; i < 6000; i++) {
      await allow(`198.18.${i >> 8}.${i & 255}`);
      if (i % 100 === 99) later.push(await allow('203.0.113.9'));
    }
    expect(later.every((ok) => !ok)).toBe(true);
    log.mockRestore();
  });
});

// ---- worker-3 ----

describe('worker-3: only the game page may submit', () => {
  const body = (): string => JSON.stringify(request(5, [run11(wr())]));
  const post = (headers: Record<string, string>): Promise<Response> => call('/api/submit', { method: 'POST', headers, body: body() });

  it('refuses text/plain (a CORS simple request), other sites and a foreign Origin, before any work', async () => {
    const p = proxyDb(env.DB);
    const cases: [Record<string, string>, number, string][] = [
      [{ 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' }, 415, 'badRequest'],
      [{ 'Content-Type': 'text/plain' }, 415, 'badRequest'],
      [{}, 415, 'badRequest'],
      [{ 'Content-Type': 'application/jsonp' }, 415, 'badRequest'],
      [{ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, 403, 'forbidden'],
      [{ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site', Origin: 'https://www.yurapita.test' }, 403, 'forbidden'],
      [{ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, 403, 'forbidden'],
      [{ 'Content-Type': 'application/json', Origin: 'null' }, 403, 'forbidden'],
    ];
    for (const [headers, status, error] of cases) {
      const res = await call('/api/submit', { method: 'POST', headers, body: body() }, { DB: p.db });
      expect([res.status, ((await res.json()) as { error: string }).error], JSON.stringify(headers)).toEqual([status, error]);
    }
    expect(p.count()).toBe(0);
    expect(await boardRow(KEY)).toBeNull();
  });

  it('accepts the game page (same origin) and header-less clients', async () => {
    expect(await first(await post({ 'content-type': 'application/json', Origin: 'https://yurapita.test', 'Sec-Fetch-Site': 'same-origin' }))).toMatchObject({ status: 'accepted' });
    await resetAll({ pool: POOL });
    expect(await first(await post({ 'Content-Type': 'application/json; charset=utf-8', Origin: 'https://yurapita.test' }))).toMatchObject({ status: 'accepted' });
    await resetAll({ pool: POOL });
    // a dev proxy may rewrite the host: the browser's same-origin verdict wins over the Origin comparison
    expect(await first(await post({ 'Content-Type': 'application/json', Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' }))).toMatchObject({ status: 'accepted' });
    await resetAll({ pool: POOL });
    expect(await first(await post({ 'Content-Type': 'application/json' }))).toMatchObject({ status: 'accepted' });
  });
});

// ---- worker-4 ----

describe('worker-4: a forged daily prev', () => {
  async function seedDaily(par: number): Promise<{ key: string; bot: BotRun; h0: number[] }> {
    const pool = fakeDailyPool(par);
    await resetAll({ pool });
    const d = dailyAt(pool, NOW);
    const h0 = new Array<number>(150).fill(0);
    for (const r of fakeRows(100, 10)) h0[histBin(r[2])]! += 1;
    h0[149] = 50;   // 50 slow players in the last bin
    await seedBoard(d.key, fakeRows(100, 10), { n: 150, cleared: 150, hist: h0, par });
    return { key: d.key, bot: successBot(d.phys, { moveS: 6 }), h0 };
  }
  const drun = (key: string, bot: BotRun, prev: number): SubmitRun =>
    ({ board: key, level: dailyAt(POOL, NOW).levelId, replay: bot.replay, t120: bot.t120, device: 1, tries: 5, balls: 'OOOOO', prev });

  it('one identity resending a below-par run with prev = the slowest time 20 times counts once', async () => {
    const { key, bot, h0 } = await seedDaily(3000);
    const st: string[] = [];
    for (let k = 0; k < 20; k++) st.push((await first(await submit(request(1, [drun(key, bot, MAX_RANKED_T120)])))).status);
    expect(st).toEqual(['accepted', ...new Array<string>(19).fill('notBetter')]);
    const br = (await boardRow(key))!;
    const h = JSON.parse(br.hist!) as number[];
    expect([br.n, br.cleared, br.ai_beaten]).toEqual([150, 150, 1]);
    expect([h[149], h[histBin(bot.t120)]]).toEqual([49, h0[histBin(bot.t120)]! + 1]);
    expect((await runRow(key, pidhOf(1)))!.replay).toBeNull();   // outside the top 100: a runs row without a replay
  });

  it('the same above par: the histogram moves once, not on every resend', async () => {
    const { key, bot } = await seedDaily(100);
    for (let k = 0; k < 5; k++) await submit(request(1, [drun(key, bot, MAX_RANKED_T120)]));
    const br = (await boardRow(key))!;
    const h = JSON.parse(br.hist!) as number[];
    expect([br.n, br.cleared, br.ai_beaten, h[149]]).toEqual([150, 150, 0, 49]);
  });

  it('a prev beyond the longest ranked run is a malformed request (400)', async () => {
    const { key, bot } = await seedDaily(3000);
    expect((await submit(request(1, [drun(key, bot, 999_999)]))).status).toBe(400);
    expect((await submit(request(1, [drun(key, bot, MAX_RANKED_T120 + 1)]))).status).toBe(400);
  });

  it('decide keeps ai_beaten <= cleared <= n whatever prev says', () => {
    const d: DecideInput = {
      kind: 'D', board: 'D:00009:00000000:s1', par: 3000, lite: false, now: NOW, pidh: 'fresh', nameSeed: 1, device: 1,
      t120: 500, gapUm: null, peakCn: 1000, replay: null, fp: null, prev: MAX_RANKED_T120,
      state: { exists: true, ver: 3, top: fakeRows(100, 10), n: 5, cleared: 5, aiBeaten: 5, hist: new Array<number>(150).fill(0) },
      own: null,
    };
    const r = decide(d);
    expect(r.write).toBe(true);
    if (r.write) expect([r.n, r.cleared, r.aiBeaten]).toEqual([5, 5, 5]);
  });
});

// ---- worker-5 ----

describe('worker-5: early-return submits reach the request counter', () => {
  it('100 refused submits (400 / 415) flush the request count like any other route', async () => {
    for (let i = 0; i < 100; i++) {
      if (i % 2 === 0) await submit('{}');
      else await call('/api/submit', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    }
    expect(await env.DB.prepare('SELECT n FROM counters WHERE k = ?').bind(`req:${jstDate(NOW)}`).first('n')).toBe(100);
    expect(pendingForTest().req).toBe(0);
  });
});

// ---- worker-6 ----

describe('worker-6: a committed write batch whose answer was lost', () => {
  const participation = (): SubmitRun => {
    const d = dailyAt(POOL, NOW);
    return { board: d.key, level: d.levelId, replay: null, t120: null, device: 1, tries: 5, balls: 'XXXXX' };
  };

  it('is answered from the request tok (accepted, n = 1), so the client does not count the player again', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = env.DB;
    let lost = 0;
    const flaky = {
      prepare: (sql: string) => real.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        const r = await real.batch(stmts);
        if (lost === 0 && r.some((x) => (x.meta?.changes ?? 0) > 0)) {
          lost++;
          throw new Error('D1_ERROR: Network connection lost.');
        }
        return r;
      },
    } as unknown as D1Database;
    const d = dailyAt(POOL, NOW);
    expect(await first(await submit(request(1, [participation()]), { env: { DB: flaky } }))).toEqual({ board: d.key, status: 'accepted', rank: null, n: 1 });
    expect(lost).toBe(1);
    // the client, having seen `accepted`, reports the day again only with prev (here: a participation, prev null)
    expect(await first(await submit(request(1, [{ ...participation(), prev: null }])))).toMatchObject({ status: 'notBetter', n: 1 });
    expect((await boardRow(d.key))!.n).toBe(1);
    err.mockRestore();
  });

  it('a write batch that failed without committing is still deferred', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = proxyDb(env.DB, async (sqls) => {
      if (sqls.some((s) => s.startsWith(BOARD_UPDATE_SQL))) throw new Error('D1_ERROR: simulated');
    });
    expect(await first(await submit(request(1, [participation()]), { env: { DB: p.db } }))).toMatchObject({ status: 'deferred' });
    expect(p.sqls).toContain('SELECT tok FROM boards WHERE board = ?');
    expect((await boardRow(dailyAt(POOL, NOW).key))?.n ?? 0).toBe(0);
    err.mockRestore();
  });
});
