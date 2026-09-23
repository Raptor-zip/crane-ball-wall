// Local save (GAME_DESIGN.md §7.4, §10.4 "保存"). Owner: O8.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORRUPT_KEY, SAVE_KEY, SAVE_THROTTLE_MS, createStore, defaultSave, ensureLevel, parseSave, reconcileLevelHashes,
  type LocalStore, type SaveV1,
} from '../../src/store/save';
import { pidhFromSecret } from '../../src/shared/names';
import type { PendingRun } from '../../src/net/outbox';
import { MemStorage, ThrowingStorage } from './helpers';

const stores: LocalStore[] = [];
function make(opts: Parameters<typeof createStore>[0] = {}): LocalStore {
  const s = createStore({ listen: false, lang: 'ja', ...opts });
  stores.push(s);
  return s;
}
afterEach(() => {
  while (stores.length) stores.pop()!.dispose();
  vi.useRealTimers();
});

const saved = (m: MemStorage): SaveV1 => JSON.parse(m.getItem(SAVE_KEY)!) as SaveV1;

function run(board: string, t120: number | null, over: Partial<PendingRun> = {}): PendingRun {
  return { board, level: '2-2', replay: t120 === null ? null : `r${t120}`, t120, device: 1, nTicks: t120 === null ? 0 : 300, queuedAt: 1, ...over };
}

describe('defaults', () => {
  it('a fresh save is complete and valid', () => {
    const d = defaultSave('ja');
    expect(d.v).toBe(1);
    expect(d.id.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(d.id.pidh).toBe(pidhFromSecret(d.id.secret));
    expect(d.id.pidh).toMatch(/^[0-9a-f]{16}$/);
    expect(d.id.nameSeed).toBeGreaterThanOrEqual(0);
    expect(d.id.nameSeed).toBeLessThanOrEqual(65535);
    expect(d.settings).toEqual({
      lang: 'ja', langPicked: false, volume: 80, muted: false, haptics: true, motion: 'auto', keyboard: 'speed', ghostSet: 0, steady: true,
      aiLine: null, textScale: 100, quality: 'auto',
    });
    expect(d.levels).toEqual({});
    expect(d.daily).toEqual({
      dayIndex: -1, jstDay: -1, balls: [null, null, null, null, null], bestSub: null, bestReplay: null,
      submitted: 'none', lastSentT120: null, streak: 0, lastPlayedDay: -1, lastPlayedJst: -1,
    });
    expect(d.outbox).toEqual([]);
    expect(d.seen).toEqual({ onboarding: false, notes: [], aiLostCard: false, storageNotice: false, tricks: [] });
  });

  it('the first language is Japanese whatever navigator.language says; English only when the player picked it', () => {
    const spy = vi.spyOn(navigator, 'language', 'get');
    spy.mockReturnValue('en-US');
    expect(createStore({ storage: new MemStorage(), listen: false }).data().settings.lang).toBe('ja');
    spy.mockRestore();
    // a save from the old navigator.language default (no langPicked) goes back to Japanese; a picked English stays
    expect(parseSave({ v: 1, settings: { lang: 'en' } }, 'ja').settings.lang).toBe('ja');
    expect(parseSave({ v: 1, settings: { lang: 'en', langPicked: true } }, 'ja').settings.lang).toBe('en');
  });

  it('ensureLevel creates a default entry once', () => {
    const d = defaultSave('en');
    const p = ensureLevel(d, '1-1', 'aaaaaaaa');
    expect(p).toMatchObject({ hash: 'aaaaaaaa', cleared: false, attempts: 0, bestSub: null, medal: 0, crown: false, badges: [], aiBeatenSent: false, demoShown: false });
    p.attempts = 3;
    expect(ensureLevel(d, '1-1', 'bbbbbbbb').attempts).toBe(3);
  });
});

describe('persistence', () => {
  it('writes the save at startup and keeps the identity across reloads', () => {
    const m = new MemStorage();
    const a = make({ storage: m });
    expect(a.persistent).toBe(true);
    expect(m.getItem(SAVE_KEY)).not.toBeNull();
    const id = a.data().id;
    const b = make({ storage: m });
    expect(b.data().id).toEqual(id);
  });

  it('update() is throttled to one write per 250 ms; flush() writes at once', () => {
    vi.useFakeTimers();
    const m = new MemStorage();
    const s = make({ storage: m });
    const w0 = m.writes;
    s.update((d) => { d.settings.volume = 10; });
    s.update((d) => { d.settings.volume = 20; });
    s.update((d) => { d.settings.muted = true; });
    expect(s.data().settings.volume).toBe(20);   // the in-memory state changes immediately
    expect(m.writes).toBe(w0);
    vi.advanceTimersByTime(SAVE_THROTTLE_MS - 1);
    expect(m.writes).toBe(w0);
    vi.advanceTimersByTime(1);
    expect(m.writes).toBe(w0 + 1);
    expect(saved(m).settings).toMatchObject({ volume: 20, muted: true });

    // Updates spread over time: at most one write per 250 ms window.
    for (let i = 0; i < 20; i++) {
      s.update((d) => { d.settings.volume = i; });
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(SAVE_THROTTLE_MS);
    expect(m.writes - (w0 + 1)).toBeLessThanOrEqual(5);
    expect(saved(m).settings.volume).toBe(19);

    s.update((d) => { d.seen.onboarding = true; });
    const w1 = m.writes;
    s.flush();
    expect(m.writes).toBe(w1 + 1);
    expect(saved(m).seen.onboarding).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(m.writes).toBe(w1 + 1);  // the pending throttled write was cancelled by flush()
  });

  it('flushes on pagehide and when the page becomes hidden', () => {
    vi.useFakeTimers();
    const m = new MemStorage();
    const s = createStore({ storage: m, lang: 'ja' });
    stores.push(s);
    s.update((d) => { d.settings.volume = 33; });
    window.dispatchEvent(new Event('pagehide'));
    expect(saved(m).settings.volume).toBe(33);

    s.update((d) => { d.settings.volume = 44; });
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(saved(m).settings.volume).toBe(44);
    vis.mockRestore();

    s.dispose();
    s.update((d) => { d.settings.volume = 55; });
    window.dispatchEvent(new Event('pagehide'));
    expect(saved(m).settings.volume).toBe(44);   // listeners removed
  });

  it('a throwing update callback still schedules the save and rethrows', () => {
    vi.useFakeTimers();
    const m = new MemStorage();
    const s = make({ storage: m });
    expect(() => s.update((d) => { d.settings.volume = 5; throw new Error('boom'); })).toThrow('boom');
    vi.advanceTimersByTime(SAVE_THROTTLE_MS);
    expect(saved(m).settings.volume).toBe(5);
  });
});

describe('two tabs', () => {
  function tabs(): { m: MemStorage; a: LocalStore; b: LocalStore } {
    const m = new MemStorage();
    const a = createStore({ storage: m, lang: 'ja' });
    const b = createStore({ storage: m, lang: 'ja' });   // opened later: loads what A saved
    stores.push(a, b);
    return { m, a, b };
  }

  it('an idle tab being hidden or closed does not put its stale copy over newer progress', () => {
    const { m, a, b } = tabs();
    expect(b.data().id).toEqual(a.data().id);
    a.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').cleared = true; });
    a.flush();
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));    // B goes to the background
    vis.mockRestore();
    window.dispatchEvent(new Event('pagehide'));              // B is closed (A has nothing new either)
    b.flush();                                                // core's own pagehide flush
    expect(saved(m).levels['2-2']!.cleared).toBe(true);
  });

  it("an idle tab adopts the other tab's save (same root object), a busy one keeps its own", () => {
    const { m, a, b } = tabs();
    const root = b.data();
    a.update((d) => { ensureLevel(d, '2-2', '9f3a12bc').bestSub = 301; });
    a.flush();
    window.dispatchEvent(new StorageEvent('storage', { key: SAVE_KEY, newValue: m.getItem(SAVE_KEY) }));
    expect(b.data()).toBe(root);
    expect(b.data().levels['2-2']!.bestSub).toBe(301);

    vi.useFakeTimers();
    b.update((d) => { d.settings.volume = 7; });              // B has unsaved changes now
    a.update((d) => { d.settings.muted = true; });
    a.flush();
    window.dispatchEvent(new StorageEvent('storage', { key: SAVE_KEY, newValue: m.getItem(SAVE_KEY) }));
    expect(b.data().settings).toMatchObject({ volume: 7, muted: false });
  });

  it('ignores storage events for other keys and for saves without a valid identity', () => {
    const { b } = tabs();
    const id = b.data().id.secret;
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '{}' }));
    window.dispatchEvent(new StorageEvent('storage', { key: SAVE_KEY, newValue: '{"v":1,"levels":{"1-1":{"cleared":true}}}' }));
    window.dispatchEvent(new StorageEvent('storage', { key: SAVE_KEY, newValue: '{broken' }));
    expect(b.data().id.secret).toBe(id);
    expect(b.data().levels).toEqual({});
  });

  it('flush() without changes writes nothing', () => {
    const m = new MemStorage();
    const s = make({ storage: m });
    const w = m.writes;
    s.flush();
    s.flush();
    expect(m.writes).toBe(w);
  });
});

describe('storage failures fall back to memory with a one-time notice', () => {
  it('getItem throws: memory mode, the game still works, notice once', () => {
    const s = make({ storage: new ThrowingStorage(true, true) });
    expect(s.persistent).toBe(false);
    s.update((d) => { d.settings.volume = 12; });
    s.flush();
    expect(s.data().settings.volume).toBe(12);
    expect(s.data().id.pidh).toMatch(/^[0-9a-f]{16}$/);
    expect(s.takeStorageNotice()).toBe(true);
    expect(s.data().seen.storageNotice).toBe(true);
    expect(s.takeStorageNotice()).toBe(false);
    expect(s.takeStorageNotice()).toBe(false);
  });

  it('setItem throws (read-only / quota 0): detected at startup', () => {
    const t = new ThrowingStorage(false, true);
    const s = make({ storage: t });
    expect(s.persistent).toBe(false);
    expect(s.takeStorageNotice()).toBe(true);
    expect(s.takeStorageNotice()).toBe(false);
  });

  it('the localStorage getter itself throws (SecurityError)', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('no', 'SecurityError'); } });
    try {
      const s = createStore({ listen: false, lang: 'en' });
      stores.push(s);
      expect(s.persistent).toBe(false);
      s.update((d) => { d.seen.onboarding = true; });
      s.flush();
      expect(s.data().seen.onboarding).toBe(true);
      expect(s.takeStorageNotice()).toBe(true);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    }
  });

  it('storage: null means memory only', () => {
    const s = make({ storage: null });
    expect(s.persistent).toBe(false);
    expect(s.takeStorageNotice()).toBe(true);
  });

  it('a write failing mid-session (quota) switches to memory and stops writing', () => {
    vi.useFakeTimers();
    const t = new ThrowingStorage(false, false);
    const s = make({ storage: t });
    expect(s.persistent).toBe(true);
    expect(s.takeStorageNotice()).toBe(false);   // nothing to tell while saving works
    t.throwOnSet = true;
    s.update((d) => { d.settings.volume = 1; });
    vi.advanceTimersByTime(SAVE_THROTTLE_MS);
    expect(s.persistent).toBe(false);
    expect(s.takeStorageNotice()).toBe(true);
    t.throwOnSet = false;
    const w = t.writes;
    s.update((d) => { d.settings.volume = 2; });
    s.flush();
    expect(t.writes).toBe(w);                     // stays in memory for the session
    expect(s.data().settings.volume).toBe(2);
    expect(s.takeStorageNotice()).toBe(false);
  });

  it('a persisted storageNotice flag does not suppress the notice of a new session', () => {
    const m = new MemStorage();
    const d = defaultSave('ja');
    d.seen.storageNotice = true;
    m.setItem(SAVE_KEY, JSON.stringify(d));
    const t = new ThrowingStorage(false, true);
    t.map.set(SAVE_KEY, m.getItem(SAVE_KEY)!);
    const s = make({ storage: t });
    expect(s.data().id).toEqual(d.id);
    expect(s.takeStorageNotice()).toBe(true);
  });
});

describe('migration-safe parsing', () => {
  it('corrupt JSON: starts fresh and keeps a copy of the old text', () => {
    const m = new MemStorage();
    m.setItem(SAVE_KEY, '{"v":1,"id":{"secr');
    const s = make({ storage: m });
    expect(s.persistent).toBe(true);
    expect(s.data().v).toBe(1);
    expect(m.getItem(CORRUPT_KEY)).toBe('{"v":1,"id":{"secr');
    expect(saved(m).id).toEqual(s.data().id);
  });

  it.each([null, 42, 'text', [], true])('a non-object save (%j) becomes the default', (raw) => {
    const d = parseSave(raw, 'en');
    expect(d.settings.lang).toBe('en');
    expect(d.levels).toEqual({});
  });

  it('daily.jstDay / lastPlayedJst: kept when valid, -1 when broken or without a day', () => {
    const base = { dayIndex: 0, balls: [], bestSub: null, bestReplay: null, submitted: 'none', lastSentT120: null, streak: 2 };
    const ok = parseSave({ v: 1, daily: { ...base, jstDay: 20722, lastPlayedDay: 0, lastPlayedJst: 20721 } }, 'ja').daily;
    expect([ok.jstDay, ok.lastPlayedJst]).toEqual([20722, 20721]);
    const bad = parseSave({ v: 1, daily: { ...base, jstDay: 'x', lastPlayedDay: 0, lastPlayedJst: 1.5 } }, 'ja').daily;
    expect([bad.jstDay, bad.lastPlayedJst]).toEqual([-1, -1]);
    const none = parseSave({ v: 1, daily: { ...base, dayIndex: -1, jstDay: 20722, lastPlayedDay: -1, lastPlayedJst: 20721 } }, 'ja').daily;
    expect([none.jstDay, none.lastPlayedJst]).toEqual([-1, -1]);
  });

  it('keeps valid fields, defaults broken ones, never trusts a stored pidh', () => {
    const good = defaultSave('ja');
    const raw = {
      v: 1,
      id: { secret: good.id.secret, pidh: 'ffffffffffffffff', nameSeed: 70000 },
      settings: { lang: 'en', langPicked: true, volume: 250, muted: 'yes', haptics: false, motion: 'sideways', keyboard: 'force', ghostSet: 7, steady: 'no', aiLine: true, textScale: 125, quality: 'low', extra: 1 },
      levels: {
        '2-2': { hash: '9f3a12bc', cleared: true, attempts: 12, fails: -3, bestSub: 301, bestReplay: 'WVAB', medal: 3, crown: true, badges: ['ippatsu', 'bogus', 'pashi'], hintsSeen: 2, demoShown: true, aiBeatenSent: true },
        '1-1': 'garbage',
        '1-2': { bestSub: 0, bestReplay: 'x', medal: 9 },
      },
      daily: { dayIndex: 23, balls: ['ok', 'nope', 'crown'], bestSub: 455, bestReplay: 'AB', submitted: 'partial', lastSentT120: 455, streak: 4, lastPlayedDay: 23 },
      outbox: [run('L:2-2:9f3a12bc:s1', 301), { board: 5 }, run('L:2-2:9f3a12bc:s1', 290), run('L:2-2:9f3a12bc:s1', null)],
      seen: { onboarding: true, notes: [1, 1, 'x', 3], aiLostCard: true, storageNotice: true, tricks: ['brake', 3, 'brake'] },
      future: { anything: true },
    };
    const d = parseSave(raw, 'ja');
    expect(d.id.secret).toBe(good.id.secret);
    expect(d.id.pidh).toBe(pidhFromSecret(good.id.secret));
    expect(d.id.nameSeed).toBeGreaterThanOrEqual(0);
    expect(d.id.nameSeed).toBeLessThanOrEqual(65535);
    expect(d.settings).toEqual({ lang: 'en', langPicked: true, volume: 100, muted: false, haptics: false, motion: 'auto', keyboard: 'force', ghostSet: 0, steady: true, aiLine: true, textScale: 125, quality: 'low' });
    // steady (§3.7) is on unless a boolean says otherwise
    expect(parseSave({ ...raw, settings: { steady: false } }, 'ja').settings.steady).toBe(false);
    expect(d.levels['2-2']).toMatchObject({ hash: '9f3a12bc', cleared: true, attempts: 12, fails: 0, bestSub: 301, bestReplay: 'WVAB', medal: 3, crown: true, badges: ['ippatsu', 'pashi'], hintsSeen: 2, demoShown: true, aiBeatenSent: true, briefed: false });
    expect(d.levels['1-1']).toBeUndefined();
    expect(d.levels['1-2']).toMatchObject({ bestSub: null, bestReplay: null, medal: 0 });
    // a save from before SaveV1.daily.jstDay / lastPlayedJst: unknown (-1), derived from the day indices when read
    expect(d.daily).toEqual({ dayIndex: 23, jstDay: -1, balls: ['ok', null, 'crown', null, null], bestSub: 455, bestReplay: 'AB', submitted: 'partial', lastSentT120: 455, streak: 4, lastPlayedDay: 23, lastPlayedJst: -1 });
    // Invalid entries dropped; the valid ones collapse to the best per board.
    expect(d.outbox).toHaveLength(1);
    expect(d.outbox[0]!.t120).toBe(290);
    expect(d.seen).toEqual({ onboarding: true, notes: [1, 3], aiLostCard: true, storageNotice: false, tricks: ['brake'] });
    expect(Object.keys(d)).toEqual(['v', 'id', 'settings', 'levels', 'daily', 'outbox', 'seen']);
  });

  it('a "__proto__" (or otherwise odd) level key in a hand-edited save is ignored', () => {
    const raw = JSON.parse('{"v":1,"levels":{"__proto__":{"cleared":true,"medal":3},"1-1":{"cleared":true},"a b":{"cleared":true}}}') as unknown;
    const d = parseSave(raw, 'ja');
    expect(Object.getPrototypeOf(d.levels)).toBe(Object.prototype);
    expect(Object.keys(d.levels)).toEqual(['1-1']);
    expect((d.levels as Record<string, unknown>).cleared).toBeUndefined();
  });

  it('queued runs the Worker would refuse are dropped at load; an unknown device becomes 0 (Unknown)', () => {
    const d = parseSave({
      v: 1,
      outbox: [
        run('L:2-2:9f3a12bc:s1', 301, { device: 9 as never }),
        run('L:x:9f3a12bc:s1', 301),
        run('L:1-1:9f3a12bc:s1', 301, { level: '1-1', replay: 'not base64!' }),
        run('L:1-2:9f3a12bc:s1', 301, { level: '1-2' }),
      ],
    }, 'ja');
    expect(d.outbox.map((r) => [r.board, r.device])).toEqual([['L:2-2:9f3a12bc:s1', 0], ['L:1-2:9f3a12bc:s1', 1]]);
  });

  it('a malformed identity is replaced by a new valid one', () => {
    const d = parseSave({ v: 1, id: { secret: 'short', pidh: 'x', nameSeed: 3 } }, 'ja');
    expect(d.id.secret).not.toBe('short');
    expect(d.id.pidh).toBe(pidhFromSecret(d.id.secret));
  });

  it('an old save missing whole sections loads with defaults (and is rewritten complete)', () => {
    const m = new MemStorage();
    const secret = defaultSave('ja').id.secret;
    m.setItem(SAVE_KEY, JSON.stringify({ v: 1, id: { secret, nameSeed: 5 }, levels: { '1-1': { cleared: true, medal: 2 } } }));
    const s = make({ storage: m });
    expect(s.data().id.secret).toBe(secret);
    expect(s.data().id.nameSeed).toBe(5);
    expect(s.data().levels['1-1']).toMatchObject({ cleared: true, medal: 2, hash: '', bestSub: null });
    expect(saved(m).daily.balls).toHaveLength(5);
    expect(saved(m).settings.keyboard).toBe('speed');
  });
});

describe('level hash change', () => {
  function withLevels(): SaveV1 {
    const d = defaultSave('ja');
    const a = ensureLevel(d, '2-2', '9f3a12bc');
    Object.assign(a, { cleared: true, bestSub: 301, bestReplay: 'WVAB', medal: 3, crown: true, badges: ['ippatsu'], attempts: 7, aiBeatenSent: true });
    const b = ensureLevel(d, '1-1', '11111111');
    Object.assign(b, { cleared: true, bestSub: 200, bestReplay: 'QQ', medal: 2 });
    ensureLevel(d, '1-2', '');
    d.outbox = [run('L:2-2:9f3a12bc:s1', 301), { ...run('L:1-1:11111111:s1', 200), level: '1-1' }, run('D:00023:1c0e77aa:s1', 455, { level: 'd:17', tries: 2, balls: 'XO---' })];
    return d;
  }

  it('wipes the PB of a level whose physics changed and keeps medals, crown and clears', () => {
    const d = withLevels();
    expect(reconcileLevelHashes(d, { '2-2': 'deadbeef', '1-1': '11111111', '1-2': '22222222' })).toBe(true);
    expect(d.levels['2-2']).toMatchObject({ hash: 'deadbeef', bestSub: null, bestReplay: null, medal: 3, crown: true, cleared: true, badges: ['ippatsu'], attempts: 7, aiBeatenSent: false });
    expect(d.levels['1-1']).toMatchObject({ hash: '11111111', bestSub: 200, bestReplay: 'QQ', medal: 2 });
    expect(d.levels['1-2']!.hash).toBe('22222222');   // no hash yet: adopted, nothing wiped
    // The queued run for the old 2-2 ranking is dropped (it would be `stale`); others stay.
    expect(d.outbox.map((r) => r.board)).toEqual(['L:1-1:11111111:s1', 'D:00023:1c0e77aa:s1']);
    expect(reconcileLevelHashes(d, { '2-2': 'deadbeef', '1-1': '11111111', '1-2': '22222222' })).toBe(false);
  });

  it('is applied at load through createStore({ levelHashes }) and persisted', () => {
    const m = new MemStorage();
    m.setItem(SAVE_KEY, JSON.stringify(withLevels()));
    const s = make({ storage: m, levelHashes: { '2-2': 'deadbeef' } });
    expect(s.data().levels['2-2']).toMatchObject({ bestSub: null, medal: 3, crown: true });
    expect(saved(m).levels['2-2']!.bestSub).toBeNull();
    expect(saved(m).levels['1-1']!.bestSub).toBe(200);
  });

  it('applyLevelHashes() works later in the session too', () => {
    vi.useFakeTimers();
    const m = new MemStorage();
    m.setItem(SAVE_KEY, JSON.stringify(withLevels()));
    const s = make({ storage: m });
    s.applyLevelHashes({ '1-1': '99999999' });
    expect(s.data().levels['1-1']).toMatchObject({ hash: '99999999', bestSub: null, medal: 2 });
    vi.advanceTimersByTime(SAVE_THROTTLE_MS);
    expect(saved(m).levels['1-1']!.bestSub).toBeNull();
  });
});

describe('with the real happy-dom localStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it('round-trips through window.localStorage by default', () => {
    const a = createStore({ listen: false });
    stores.push(a);
    a.update((d) => { ensureLevel(d, '1-1', 'abcdabcd').bestSub = 250; });
    a.flush();
    expect(JSON.parse(localStorage.getItem(SAVE_KEY)!).levels['1-1'].bestSub).toBe(250);
    const b = createStore({ listen: false });
    stores.push(b);
    expect(b.data().levels['1-1']!.bestSub).toBe(250);
    expect(b.data().id).toEqual(a.data().id);
  });
});
