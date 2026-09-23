// Bundled game data: levels, AI ghosts, ghosts summary, daily pool (GAME_DESIGN.md §6, §8.2, §8.4). Owner: O3.
//
// Campaign ghosts are bundled eagerly (the title attract and the first level need them at once; no loading
// screen, §2.2). The daily pool / daily ghosts are optional files (import.meta.glob yields nothing when a
// file does not exist yet), daily ghosts are loaded lazily. Never depends on exact par values: the ghost
// pipeline may rewrite the files at any time.
import levelsJson from '../data/levels.json';
import summaryJson from '../data/ghosts_summary.json';
import type { DailyDef, DailyPoolFile, LevelDef, LevelsFile } from '../sim/level';
import { levelHash } from '../sim/level';
import { ballPath, trackFromAiGhost, type AiGhostJson, type GhostFileJson, type GhostTrack } from './ghosts';

/** One entry of ghosts_summary.json "levels" (§8.2). minGapMm / headroom can be null (1-1 has no walls). */
export interface SummaryEntry {
  hash?: string; parSub: number; tMin?: number; planT?: number; calmT?: number; peakF: number;
  minGapMm: number | null; pumps: number; headroom?: string | null; aiMarginMm?: number; aiTensionMinN?: number;
  fallbackApplied?: unknown[]; mode?: string;
}
export interface SummaryFile { format: 1; levels: Record<string, SummaryEntry> }
export interface DailyGhostsFile { format: 1; ghosts: Record<string, AiGhostJson[]> }

export interface GameData {
  readonly levels: readonly LevelDef[];          // 18 campaign levels in campaign order
  readonly summary: Readonly<Record<string, SummaryEntry>>;
  readonly dailyPool: readonly DailyDef[];
  /** Campaign level or daily level ("d:<i>"). */
  level(id: string): LevelDef | null;
  hash(level: LevelDef): string;
  /** AI par in substeps: summary / ghost parSub for campaign levels, DailyDef.parSub for daily ones. */
  parSub(level: LevelDef): number;
  summaryOf(level: LevelDef): SummaryEntry | null;
  /** Decoded AI ghosts of a level (kind 'ai', 'calm', 'research_*'), cached. Daily levels need loadDailyGhosts first. */
  tracks(level: LevelDef): GhostTrack[];
  track(level: LevelDef, kind: AiGhostJson['kind']): GhostTrack | null;
  ghostJson(level: LevelDef, kind: AiGhostJson['kind']): AiGhostJson | null;
  /** AI ball path (bx,by pairs at 60 Hz) of the 'ai' ghost, or null. */
  aiPath(level: LevelDef): Float32Array | null;
  /** Loads daily_ghosts.json (lazy chunk). Resolves false when it is not bundled. */
  loadDailyGhosts(): Promise<boolean>;
}

const ghostModules = import.meta.glob<GhostFileJson>('../data/ghosts/*.json', { eager: true, import: 'default' });
const poolModules = import.meta.glob<DailyPoolFile>('../data/daily_pool.json', { eager: true, import: 'default' });
const dailyGhostLoaders = import.meta.glob<DailyGhostsFile>('../data/daily_ghosts.json', { import: 'default' });

function campaignOrder(levels: readonly LevelDef[]): LevelDef[] {
  return levels.filter((l) => l.world !== 0).slice().sort((a, b) => a.world - b.world || a.order - b.order);
}

export interface GameDataSources {
  levels: LevelsFile;
  summary: SummaryFile;
  ghosts: Record<string, GhostFileJson>;       // by level id
  dailyPool?: DailyPoolFile | null;
  loadDailyGhosts?: (() => Promise<DailyGhostsFile | null>) | null;
}

export function bundledSources(): GameDataSources {
  const ghosts: Record<string, GhostFileJson> = {};
  for (const [path, file] of Object.entries(ghostModules)) {
    const id = file?.levelId ?? /([^/]+)\.json$/.exec(path)?.[1];
    if (id && file) ghosts[id] = file;
  }
  const pool = Object.values(poolModules)[0] ?? null;
  const loader = Object.values(dailyGhostLoaders)[0] ?? null;
  return {
    levels: levelsJson as unknown as LevelsFile,
    summary: summaryJson as unknown as SummaryFile,
    ghosts,
    dailyPool: pool,
    loadDailyGhosts: loader ? () => loader().catch(() => null) : null,
  };
}

export function createGameData(src: GameDataSources = bundledSources()): GameData {
  const levels = campaignOrder(src.levels.levels ?? []);
  const summary = src.summary?.levels ?? {};
  const dailyPool = (src.dailyPool?.pool ?? []).filter((d) => d && typeof d.id === 'string');
  const byId = new Map<string, LevelDef>();
  for (const l of levels) byId.set(l.id, l);
  for (const d of dailyPool) byId.set(d.id, d);
  const hashes = new WeakMap<LevelDef, string>();
  const trackCache = new Map<string, GhostTrack[]>();
  let dailyGhosts: Record<string, AiGhostJson[]> = {};
  let dailyPromise: Promise<boolean> | null = null;

  const ghostList = (level: LevelDef): AiGhostJson[] => {
    if (level.world === 0) return dailyGhosts[level.id] ?? [];
    return src.ghosts[level.id]?.ghosts ?? [];
  };

  const data: GameData = {
    levels,
    summary,
    dailyPool,
    level: (id) => byId.get(id) ?? null,
    hash(level) {
      let h = hashes.get(level);
      if (h === undefined) {
        h = levelHash(level.physics);
        hashes.set(level, h);
      }
      return h;
    },
    parSub(level) {
      const daily = (level as Partial<DailyDef>).parSub;
      if (level.world === 0 && typeof daily === 'number' && daily > 0) return daily;
      const s = summary[level.id]?.parSub;
      if (typeof s === 'number' && s > 0) return s;
      const g = ghostList(level).find((x) => x.kind === 'ai')?.parSub;
      if (typeof g === 'number' && g > 0) return g;
      // No AI data at all (should not ship): a lenient par from the planner's known-feasible time.
      return Math.max(120, Math.round((level.ai?.tHi || 5) * 120));
    },
    summaryOf: (level) => summary[level.id] ?? null,
    tracks(level) {
      const key = level.id;
      let t = trackCache.get(key);
      if (!t) {
        t = [];
        for (const g of ghostList(level)) {
          try {
            t.push(trackFromAiGhost(g, level.physics.L, level));
          } catch {
            // a malformed ghost is skipped, the game still runs
          }
        }
        if (level.world !== 0 || t.length > 0) trackCache.set(key, t);
      }
      return t;
    },
    track(level, kind) {
      return data.tracks(level).find((t) => t.kind === kind) ?? null;
    },
    ghostJson(level, kind) {
      return ghostList(level).find((g) => g.kind === kind) ?? null;
    },
    aiPath(level) {
      const t = data.track(level, 'ai');
      return t ? ballPath(t) : null;
    },
    loadDailyGhosts() {
      if (!src.loadDailyGhosts) return Promise.resolve(false);
      if (!dailyPromise) {
        dailyPromise = src.loadDailyGhosts().then((f) => {
          if (!f || typeof f.ghosts !== 'object') return false;
          dailyGhosts = f.ghosts;
          for (const k of [...trackCache.keys()]) if (k.startsWith('d:')) trackCache.delete(k);
          return true;
        }, () => false);
      }
      return dailyPromise;
    },
  };
  return data;
}
