// Mock data for dev/ui-demo.html (O7). Not part of the game bundle.
import type { LevelDef } from '../src/sim/level';
import type { SaveV1, Store, LevelProgress } from '../src/store/save';
import type { BoardResponse, BootResponse } from '../src/shared/api';
import type { BoardRow } from '../src/shared/api';
import type { DailyView, GhostSummary, ResultsData } from '../src/ui/ui';
import type { CompareTracks, DemoInfo, UiContext } from '../src/ui/context';
import { BUNDLED_LEVELS, BUNDLED_SUMMARY } from '../src/ui/ui';

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

/** Ranking rows; `walls` false gives the gap column -1 (NO_WALL_GAP_UM, e.g. 1-1). */
export function mockRows(parSub: number, n: number, mePidh: string, meRank = 7, walls = true): BoardRow[] {
  const rows: BoardRow[] = [];
  for (let i = 0; i < n; i++) {
    const t120 = Math.round(parSub * (0.9 + i * 0.012 + (i > 20 ? i * 0.01 : 0)));
    const pidh = i === meRank - 1 ? mePidh : hex(i + 3);
    rows.push([pidh, SEEDS[i % SEEDS.length]! + i, t120, walls ? 2000 + ((i * 3137) % 18000) : -1, (i % 4) + 1, 1790000000000 - i * 1000]);
  }
  return rows;
}

export function mockBoot(): BootResponse {
  const boards: BootResponse['boards'] = {};
  for (const l of BUNDLED_LEVELS) {
    const par = BUNDLED_SUMMARY[l.id]?.parSub ?? 300;
    boards[l.id] = { key: `L:${l.id}:00000000:s1`, n: 812, aiBeaten: 37, par, cutoff: Math.round(par * 1.8), top: mockRows(par, 10, 'zz'), wr: null };
  }
  return {
    v: 1, sim: 1, now: 1790000000000, day: 22, lite: false, readOnly: false, boards,
    daily: { key: 'D:00022:1c0e77aa:s1', n: 5012, cleared: 3811, aiBeaten: 120, par: 402, top: mockRows(402, 10, 'a1b2c3d4e5f60718', 4), hist: [], wr: null },
  };
}

export function mockBoard(key: string): BoardResponse {
  const id = key.split(':')[1] ?? '2-2';
  const par = BUNDLED_SUMMARY[id]?.parSub ?? 402;
  const walls = (BUNDLED_LEVELS.find((l) => l.id === id)?.physics.walls.length ?? 1) > 0;
  return { key, n: 812, aiBeaten: 37, par, cutoff: Math.round(par * 1.9), top: mockRows(par, 100, 'a1b2c3d4e5f60718', 37, walls) };
}

export function mockDaily(): DailyView {
  const base = level('2-2');
  const lv = { ...base, id: 'd:17', world: 0 as const, order: 17, name: { ja: 'いれる × 短い紐', en: 'Enter × Short string' }, tier: 3, template: 'enter', parSub: 402 } as unknown as LevelDef;
  return {
    dayIndex: 22, n: 23, level: lv, balls: ['fail', 'ok', 'crown', null, null], bestSub: 396, parSub: 402,
    top: mockRows(402, 10, 'a1b2c3d4e5f60718', 4), rank: 480, pct: 9.6, streak: 5, shareText: '',
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

export function mockContext(save: SaveV1 | null, opts: { offline?: boolean } = {}): UiContext {
  return {
    store: save ? mockStore(save) : null,
    boot: () => (opts.offline ? null : mockBoot()),
    fetchBoard: (key) => new Promise((res) => setTimeout(() => res(opts.offline ? null : mockBoard(key)), 30)),
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
