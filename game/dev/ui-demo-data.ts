// Mock data for dev/ui-demo.html (O7). Not part of the game bundle.
import type { LevelDef } from '../src/sim/level';
import type { SaveV1, Store, LevelProgress } from '../src/store/save';
import type { BoardResponse, BootResponse } from '../src/shared/api';
import type { BoardRow } from '../src/shared/api';
import { HIST_BINS, histBin } from '../src/shared/api';
import type { Standing } from '../src/shared/rank';
import { LEVEL_HIST_BINS, levelBin, levelPct, trimHist } from '../src/shared/rank';
import type { DailyView, GhostSummary, ResultsData } from '../src/ui/ui';
import type { CompareTracks, DemoInfo, ReplayAvail, ReplayLoad, ReplayView, UiContext } from '../src/ui/context';
import { BUNDLED_LEVELS, BUNDLED_SUMMARY } from '../src/ui/ui';
import { displayName } from '../src/shared/names';

// ---------------------------------------------------------------- ghost decoding (same codec as §8.2, display only)

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeChannel(s: string, scale: number): Float32Array {
  const bytes = b64urlBytes(s);
  const vals: number[] = [];
  let i = 0;
  let acc = 0;
  let first = true;
  while (i < bytes.length) {
    let shift = 0;
    let u = 0;
    for (;;) {
      const b = bytes[i++]!;
      u += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const z = u % 2 === 0 ? u / 2 : -(u + 1) / 2;
    acc = first ? z : acc + z;
    first = false;
    vals.push(acc / scale);
  }
  return Float32Array.from(vals);
}

interface GhostJson { kind: string; label: string; n: number; parSub: number; planT: number; peakF: number; minGapMm: number | null; pumps: number; x: string; th: string; f: string }
const files = import.meta.glob('../src/data/ghosts/*.json', { eager: true }) as Record<string, { default?: unknown } & { ghosts?: GhostJson[] }>;

export interface Track { x: Float32Array; th: Float32Array; f: Float32Array; bx: Float32Array; by: Float32Array; meta: GhostJson }

export function ghostTrack(levelId: string, kind: 'ai' | 'calm'): Track | null {
  const mod = files[`../src/data/ghosts/${levelId}.json`];
  const data = ((mod as { default?: { ghosts: GhostJson[] } })?.default ?? mod) as { ghosts: GhostJson[] } | undefined;
  const g = data?.ghosts?.find((x) => x.kind === kind);
  const lv = BUNDLED_LEVELS.find((l) => l.id === levelId);
  if (!g || !lv) return null;
  const x = decodeChannel(g.x, 1e4);
  const th = decodeChannel(g.th, 1e4);
  const f = decodeChannel(g.f, 10);
  const L = lv.physics.L;
  const bx = new Float32Array(x.length);
  const by = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    bx[i] = x[i]! + L * Math.sin(th[i]!);
    by[i] = 1.25 - L * Math.cos(th[i]!);
  }
  return { x, th, f, bx, by, meta: g };
}

export function pairs(t: Track, every = 1): Float32Array {
  const n = Math.floor(t.bx.length / every);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = t.bx[i * every]!;
    out[i * 2 + 1] = t.by[i * every]!;
  }
  return out;
}

export function level(id: string): LevelDef {
  return BUNDLED_LEVELS.find((l) => l.id === id) ?? BUNDLED_LEVELS[0]!;
}

// ---------------------------------------------------------------- save / store

const prog = (p: Partial<LevelProgress>): LevelProgress => ({
  hash: '00000000', cleared: false, skipped: false, attempts: 3, fails: 2, consecutiveCrashes: 0, bestSub: null, bestReplay: null,
  medal: 0, crown: false, badges: [], hintsSeen: 0, briefed: true, demoShown: false, aiBeatenSent: false, ...p,
});

export function mockSave(lang: 'ja' | 'en', variant: 'fresh' | 'mid' = 'mid'): SaveV1 {
  const levels: Record<string, LevelProgress> = {};
  if (variant === 'mid') {
    const par = (id: string): number => BUNDLED_SUMMARY[id]?.parSub ?? 300;
    levels['1-1'] = prog({ cleared: true, medal: 3, crown: true, bestSub: par('1-1') - 4, attempts: 14 });
    levels['1-2'] = prog({ cleared: true, medal: 3, bestSub: Math.floor(par('1-2') * 1.12), attempts: 9 });
    levels['1-3'] = prog({ cleared: true, medal: 2, bestSub: Math.floor(par('1-3') * 1.4), attempts: 21 });
    levels['1-4'] = prog({ cleared: true, medal: 1, bestSub: Math.floor(par('1-4') * 1.8), attempts: 6 });
    levels['2-1'] = prog({ cleared: true, medal: 3, crown: true, bestSub: par('2-1') - 9, attempts: 30 });
    levels['2-2'] = prog({ cleared: true, medal: 2, bestSub: Math.floor(par('2-2') * 1.33), attempts: 44 });
    levels['2-3'] = prog({ skipped: true, attempts: 12, fails: 12 });
    levels['2-4'] = prog({ attempts: 2 });
  }
  return {
    v: 1,
    id: { secret: 'x', pidh: 'a1b2c3d4e5f60718', nameSeed: 1234 },
    settings: { lang, langPicked: false, volume: 80, muted: false, haptics: true, motion: 'auto', keyboard: 'speed', ghostSet: 0, steady: true, aiLine: null, textScale: 100, quality: 'auto' },
    levels,
    daily: { dayIndex: 22, balls: ['fail', 'ok', 'crown', null, null], bestSub: 400, bestReplay: null, submitted: 'partial', lastSentT120: 412, streak: 5, lastPlayedDay: 22 },
    outbox: [],
    seen: { onboarding: true, notes: [1], aiLostCard: false, storageNotice: true, tricks: [] },
  };
}

export function mockStore(save: SaveV1): Store {
  return {
    persistent: true,
    data: () => save,
    update: (fn) => fn(save),
    flush: () => undefined,
  };
}

// ---------------------------------------------------------------- online

const SEEDS = [5121, 812, 33, 4097, 222, 1900, 77, 3021, 640, 15, 999, 2048];
function hex(n: number): string {
  return (n * 2654435761 >>> 0).toString(16).padStart(8, '0') + (n * 40503 >>> 0).toString(16).padStart(8, '0');
}

/**
 * A synthetic crowd of `n` sorted times (t120) around `par`: a few players near the AI, most well behind it, a long slow
 * tail (the shape of the real 1-1 board). Deterministic.
 */
export function mockCrowd(par: number, n = 1065, seed = 7): number[] {
  let x = seed >>> 0;
  const rnd = (): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return (x + 0.5) / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // log-normal-ish spread: exp(N(0.45, 0.42))
    const g = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    out.push(Math.round(par * (0.9 + 0.35 * Math.exp(0.45 + 0.42 * g) - 0.35)));
  }
  return out.sort((a, b) => a - b);
}

/** Level histogram of a crowd (LEVEL_HIST_BINS layout, trimmed), as the hourly rebuild stores it. */
export function levelHistOfCrowd(times: readonly number[]): number[] {
  const h = new Array<number>(LEVEL_HIST_BINS).fill(0);
  for (const t of times) h[levelBin(t)]! += 1;
  return trimHist(h);
}

/** Daily histogram of a crowd (150 bins of 0.2 s). */
export function dailyHistOfCrowd(times: readonly number[]): number[] {
  const h = new Array<number>(HIST_BINS).fill(0);
  for (const t of times) h[histBin(t)]! += 1;
  return h;
}

/** Ranking rows of a crowd's first `n` times; `meRank` (1-based, 0 = none) is my row. */
export function crowdRows(times: readonly number[], n: number, mePidh: string, meRank: number, walls = true): BoardRow[] {
  return times.slice(0, n).map((t120, i): BoardRow => [
    i === meRank - 1 ? mePidh : hex(i + 3), SEEDS[i % SEEDS.length]! + i, t120, walls ? 2000 + ((i * 3137) % 18000) : -1, (i % 4) + 1, 1790000000000 - i * 1000,
  ]);
}

const parOf = (id: string): number => BUNDLED_SUMMARY[id]?.parSub ?? 300;
const wallsOf = (id: string): boolean => (BUNDLED_LEVELS.find((l) => l.id === id)?.physics.walls.length ?? 1) > 0;
/** Today's mock daily: 5,012 players, par 402; my best (396) is 480th. */
const DAILY_KEY = 'D:00022:1c0e77aa:s1';
const DAILY_PAR = 402;
function dailyCrowd(): number[] {
  const c = mockCrowd(DAILY_PAR, 5012, 11);
  // my best (396, see mockDaily) sits at 480
  const shift = 396 - c[479]!;
  return c.map((t) => Math.max(200, t + shift));
}

export function mockBoot(): BootResponse {
  const boards: BootResponse['boards'] = {};
  for (const l of BUNDLED_LEVELS) {
    const par = parOf(l.id);
    const c = mockCrowd(par);
    boards[l.id] = {
      key: `L:${l.id}:00000000:s1`, n: c.length, aiBeaten: c.filter((t) => t < par).length, par, cutoff: c[99]!,
      top: crowdRows(c, 10, 'a1b2c3d4e5f60718', 0, wallsOf(l.id)), wr: null, hist: levelHistOfCrowd(c),
    };
  }
  const dc = dailyCrowd();
  return {
    v: 1, sim: 1, now: 1790000000000, day: 22, lite: false, readOnly: false, boards,
    daily: { key: DAILY_KEY, n: dc.length, cleared: 3811, aiBeaten: dc.filter((t) => t < DAILY_PAR).length, par: DAILY_PAR, top: crowdRows(dc, 10, 'zz', 0), hist: dailyHistOfCrowd(dc), wr: null },
  };
}

/** How the demo ranking answers: me = my row at 37; pin = I am not in the top 100 (pinned row); hang / fail: no answer. */
export type BoardMock = 'me' | 'pin' | 'hang' | 'fail';

export function mockBoard(key: string, variant: BoardMock = 'me'): BoardResponse {
  if (key.startsWith('D:')) {
    const dc = dailyCrowd();
    return { key, n: dc.length, aiBeaten: dc.filter((t) => t < DAILY_PAR).length, par: DAILY_PAR, cutoff: dc[99]!, top: crowdRows(dc, 100, 'a1b2c3d4e5f60718', variant === 'me' ? 37 : 0), hist: trimHist(dailyHistOfCrowd(dc)), cleared: 3811 };
  }
  const id = key.split(':')[1] ?? '2-2';
  const par = parOf(id);
  const c = mockCrowd(par);
  return {
    key, n: c.length, aiBeaten: c.filter((t) => t < par).length, par, cutoff: c[99]!,
    top: crowdRows(c, 100, 'a1b2c3d4e5f60718', variant === 'me' ? 37 : 0, wallsOf(id)), hist: levelHistOfCrowd(c),
  };
}

/**
 * My progress on a demo level for a pinned-row scenario: est = best at 342 (counted), unsent = the same best, not
 * counted yet (未送信), pending = a top-100 time the list does not have yet (反映待ち).
 */
export function pinSave(save: SaveV1, id: string, kind: 'est' | 'unsent' | 'pending'): void {
  const c = mockCrowd(parOf(id));
  const p = save.levels[id] ?? prog({ cleared: true, medal: 1 });
  const best = kind === 'pending' ? c[36]! - 1 : c[341]! + 1;
  save.levels[id] = { ...p, cleared: true, bestSub: best, sentSub: kind === 'unsent' ? undefined : best };
  if (kind === 'unsent') delete save.levels[id]!.sentSub;
}

export function mockDaily(): DailyView {
  const base = level('2-2');
  const lv = { ...base, id: 'd:17', world: 0 as const, order: 17, name: { ja: 'いれる × 短い紐', en: 'Enter × Short string' }, tier: 3, template: 'enter', parSub: 402 } as unknown as LevelDef;
  return {
    dayIndex: 22, n: 23, level: lv, balls: ['fail', 'ok', 'crown', null, null], bestSub: 396, parSub: 402,
    top: crowdRows(dailyCrowd(), 10, 'a1b2c3d4e5f60718', 0), rank: 480, pct: 9.6, streak: 5, shareText: '',
  };
}

// ---------------------------------------------------------------- results

export function mockResults(id: string, variant: 'ok' | 'fail' | 'crown' | 'practice'): ResultsData {
  const lv = level(id);
  const par = BUNDLED_SUMMARY[id]?.parSub ?? 300;
  const ai = ghostTrack(id, 'ai');
  const score = variant === 'crown' ? par - 10 : Math.round(par * 1.14);
  const strobe = ai ? pairs(ai, 6) : new Float32Array();
  // Make "your" strobe a slightly different path from the AI one.
  for (let i = 0; i < strobe.length; i += 2) strobe[i] = strobe[i]! + 0.04 * Math.sin(i * 0.05);
  return {
    level: lv, ok: variant !== 'fail', score: variant === 'fail' ? null : score, parSub: par, pbSub: variant === 'crown' ? par + 20 : Math.round(par * 1.2), wrSub: Math.round(par * 0.93),
    medal: variant === 'practice' ? 0 : 3, crown: variant === 'crown', nextMedalSub: variant === 'crown' || variant === 'practice' ? null : par - 1,
    gapMm: 6.4, aiGapMm: BUNDLED_SUMMARY[id]?.minGapMm ?? 20, peakF: 38.2, aiPeakF: BUNDLED_SUMMARY[id]?.peakF ?? 40,
    badges: variant === 'crown' ? ['kamihitoe', 'pashi'] : ['pashi'], failReason: null, rank: variant === 'fail' ? null : 37, aiBeaten: 37,
    replay: 'WVABAQ-mock-replay', strobe,
  };
}

/** Results-card rank rows (GAME_DESIGN.md §9.4), one per row of the table: ?screen=results&rank=<kind>. */
export const RANK_KINDS = ['in', 'in-from', 'up', 'wr', 'wr-again', 'exact', 'local', 'est', 'est-up', 'pending', 'pending-range', 'queued', 'held', 'out', 'nonpb'] as const;
export type RankKind = (typeof RANK_KINDS)[number];

export function mockStanding(kind: RankKind, data: ResultsData): Standing {
  const key = `L:${data.level.id}:00000000:s1`;
  const n = 1065;
  const base: Standing = { runKey: `${key}:${data.score}`, forPb: true, rank: null, n, pct: null, was: null, exact: false, candidate: true, phase: 'local', stamp: null };
  const est = (rank: number, was: number | null = null): Standing => ({ ...base, rank, pct: levelPct(rank, n), was, candidate: false });
  switch (kind) {
    case 'in': return { ...base, rank: 37, exact: true, phase: 'confirmed', stamp: 'in' };
    case 'in-from': return { ...base, rank: 37, was: 342, exact: true, phase: 'confirmed', stamp: 'in' };
    case 'up': return { ...base, rank: 37, was: 49, exact: true, phase: 'confirmed', stamp: 'up' };
    case 'wr': return { ...base, rank: 1, was: 4, exact: true, phase: 'confirmed', stamp: 'wr' };
    case 'wr-again': return { ...base, rank: 1, was: 1, exact: true, phase: 'confirmed', stamp: 'wr' };
    case 'exact': return { ...base, rank: 37, was: 37, exact: true, phase: 'confirmed' };
    case 'local': return { ...base, rank: 37 };
    case 'est': return est(342);
    case 'est-up': return est(342, 400);
    case 'pending': return { ...base, rank: 37, phase: 'pending' };
    case 'pending-range': return { ...base, n: null, phase: 'pending' };
    case 'queued': return { ...base, rank: 37, phase: 'queued' };
    case 'held': return { ...base, rank: 37, phase: 'held' };
    case 'out': return { ...base, n: null, candidate: false };
    case 'nonpb': return { ...est(342), forPb: false };
  }
}

/**
 * The ranking's replays (§7.5 item 6) in the demo: on = every row can be watched (#1 and my row at once, the others with
 * a request that answers after 400 ms); lite = only #1 (offline / low-quota mode); hang = a load never answers (the ▶
 * spins); limit = a request is refused (this session's replay budget is spent).
 */
export type ReplayMock = 'on' | 'lite' | 'hang' | 'limit';

const ME_PIDH = 'a1b2c3d4e5f60718';

/** The mock ranking's row at `rank` (the same rows as mockBoard / mockBoot). */
export function mockRow(key: string, rank: number): BoardRow {
  const b = mockBoard(key, 'me');
  return b.top[rank - 1] ?? b.top[0]!;
}

/** A warped copy of a force channel (another player's run: a little slower, rougher). */
function warpF(a: Float32Array, k: number, amp: number, phase = 0): Float32Array {
  const n = Math.round(a.length * k);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[Math.min(a.length - 1, Math.floor(i / k))]! * (1 + amp * Math.sin(i / 13 + phase));
  return out;
}

/** The replay viewer's data for a row of the mock ranking (the scene plays the AI track in its place). */
export function mockReplayView(key: string, rank: number, lang: 'ja' | 'en'): ReplayView {
  const id = key.split(':')[1] ?? '2-2';
  const lv = level(key.startsWith('D:') ? '2-2' : id);
  const row = mockRow(key, rank);
  const ai = ghostTrack(lv.id, 'ai');
  const f = ai ? warpF(ai.f, Math.max(1, row[2] / (ai.meta.parSub || row[2])), 0.18, rank) : new Float32Array(120);
  const mine = row[0] === ME_PIDH;
  return {
    id: `${key}|${row[0]}|${row[2]}`, rank, name: displayName(row[1], row[0], lang), t120: row[2], kind: rank === 1 ? 'wr' : 'rival', mine,
    hz: 60, f, aiF: ai?.f ?? null, meF: !mine && ai ? warpF(ai.f, 1.22, 0.25, 2) : null, Fmax: lv.physics.Fmax,
    gapMm: lv.physics.walls.length ? 3 + (rank % 7) * 2.3 : null, peakF: Math.min(lv.physics.Fmax, 31.4 + (rank % 5)),
  };
}

function replayMocks(mode: ReplayMock): Pick<UiContext, 'replayAvail' | 'loadReplay'> {
  return {
    replayAvail: (_key, rank, row): ReplayAvail => (rank === 1 || (mode !== 'lite' && row[0] === ME_PIDH) ? 'ready' : mode === 'lite' ? null : 'fetch'),
    loadReplay: (req): Promise<ReplayLoad> => {
      const ok: ReplayLoad = { ok: true, id: `${req.key}|${req.pidh}|${req.t120}` };
      if (req.rank === 1 || req.pidh === ME_PIDH) return Promise.resolve(ok);
      if (mode === 'hang') return new Promise(() => undefined);
      if (mode === 'limit') return Promise.resolve({ ok: false, reason: 'budget' });
      return new Promise((res) => setTimeout(() => res(ok), 400));
    },
  };
}

export function mockContext(save: SaveV1 | null, opts: { offline?: boolean; board?: BoardMock; replay?: ReplayMock | null } = {}): UiContext {
  return {
    ...(opts.replay ? replayMocks(opts.replay) : {}),
    store: save ? mockStore(save) : null,
    boot: () => (opts.offline ? null : mockBoot()),
    fetchBoard: (key) => opts.board === 'hang' ? new Promise(() => undefined)
      : new Promise((res) => setTimeout(() => res(opts.offline || opts.board === 'fail' ? null : mockBoard(key, opts.board)), 30)),
    daily: () => mockDaily(),
    briefing: (lv): GhostSummary | null => {
      const calm = ghostTrack(lv.id, 'calm') ?? ghostTrack(lv.id, 'ai');
      const s = BUNDLED_SUMMARY[lv.id];
      if (!calm || !s) return null;
      return { parSub: s.parSub, planT: s.planT ?? 0, peakF: s.peakF, minGapMm: s.minGapMm ?? NaN, pumps: s.pumps, calmPath: pairs(calm) };
    },
    demo: (lv): DemoInfo | null => {
      const calm = ghostTrack(lv.id, 'calm');
      const ai = ghostTrack(lv.id, 'ai');
      if (!calm) return null;
      return { hz: 60, aiF: calm.f, meF: ai ? ai.f.map((v, i) => v * 0.85 + 6 * Math.sin(i / 9)) : null, aiGapMm: calm.meta.minGapMm, aiPeakF: calm.meta.peakF, Fmax: lv.physics.Fmax };
    },
    compare: (d): CompareTracks | null => {
      const ai = ghostTrack(d.level.id, 'ai');
      if (!ai) return null;
      const warp = (a: Float32Array, k: number, amp: number): Float32Array => {
        const n = Math.round(a.length * k);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = a[Math.min(a.length - 1, Math.floor(i / k))]! * (1 + amp * Math.sin(i / 17));
        return out;
      };
      return { hz: 60, ai: { x: ai.x, th: ai.th, f: ai.f }, me: { x: warp(ai.x, 1.12, 0.03), th: warp(ai.th, 1.12, 0.12), f: warp(ai.f, 1.12, 0.2) } };
    },
    aiPath: (id) => {
      const ai = ghostTrack(id, 'ai');
      return ai ? pairs(ai) : null;
    },
    pause: () => ({ practiceAvailable: true, skipAvailable: false, assistOffered: true, reverseHint: false }),
  };
}
