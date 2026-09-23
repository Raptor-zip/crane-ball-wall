// Level data types, levelHash and validateLevel (GAME_DESIGN.md §6.1). Owner: O1.
import { segSlabDist2, pointSlabDist2 } from './collide';
import { BALL_R, G, RAIL_Y } from './constants';
import { fnv1a } from './fnv';

export interface WallDef { x0: number; x1: number; h: number }           // m
export interface ZoneDef { kind: 'pad' | 'pocket'; xa: number; xb: number } // ball-centre x range [m]
export interface EggDef { Tmax: number; Jmax: number }                   // N, N*s

/** The part the simulation reads. Only this is hashed by levelHash. */
export interface LevelPhysics {
  M: number; m: number; L: number;       // kg, kg, m
  Fmax: number;                          // N
  rail: [number, number];                // trolley range [x_min, x_max]
  startX: number;                        // trolley start (at rest, theta = 0)
  walls: WallDef[];                      // 0..4, ascending x0
  phases: ZoneDef[];                     // 1 or 2
  restDeg: number;                       // A_rest [deg]
  egg?: EggDef;
}

export type SplitDef = { wall: number; dir: 1 | -1 } | { phase: number };
export type ResearchSeed = 'enter_fast' | 'enter_pump' | 'escape_fast' | 'escape_pump';
export type FallbackStep =
  | { op: 'raiseT'; by: number; max: number }
  | { op: 'lowerWall'; walls: number[]; by: number; min: number }
  | { op: 'moveWall'; wall: number; by: number; maxGap: number }
  | { op: 'raiseTmax'; by: number; max: number };

export interface LevelDef {
  id: string;                            // "2-2"; daily levels are "d:<index>"
  world: 1 | 2 | 3 | 4 | 5 | 0;          // 0 = daily
  order: number;
  name: { ja: string; en: string };      // may contain §5.3 placeholders
  concept: { ja: string; en: string };
  cargo: 'ball' | 'egg';
  physics: LevelPhysics;
  splits: SplitDef[];
  hints?: { ja: [string, string, string]; en: [string, string, string] };
  ai: {
    xGoal: number[];
    tHi: number;
    seeds?: ResearchSeed[];
    extras?: ResearchSeed[];
    compose?: [string, number, string];
    tensionMax?: number;
    /** AI wall margin [mm] the planner keeps on this level (margin_ball = margin_string; default 20). Not in levelHash. */
    marginMm?: number;
    fallback: FallbackStep[];
  };
  badges?: { gentleN?: number };
  view?: { portraitWindow?: number; wideX?: [number, number] };
}

export interface LevelsFile { format: 1; levels: LevelDef[] }

/** One entry of daily_pool.json. */
export interface DailyDef extends LevelDef {
  world: 0;
  tier: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  template: 'hop' | 'hurdles' | 'enter' | 'escape' | 'weak';
  parSub: number;
}
export interface DailyPoolFile { format: 1; pool: DailyDef[] }

/** Sorted keys, no whitespace, numbers via String(n), undefined keys omitted (§6.1). */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value) parts.push(item === undefined ? 'null' : canonicalJson(item));
        return `[${parts.join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      const parts: string[] = [];
      for (const k of keys) parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

const UTF8 = new TextEncoder();

/** FNV-1a 32 of canonicalJson(phys) as 8 lowercase hex digits. */
export function levelHash(phys: LevelPhysics): string {
  const h = fnv1a(UTF8.encode(canonicalJson(phys)));
  return h.toString(16).padStart(8, '0');
}

const MAX_WALLS = 4;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
}

/** Throws with a reason if the level violates any rule of §6.1. */
export function validateLevel(def: LevelDef): void {
  const id = def && typeof def.id === 'string' ? def.id : '?';
  const fail = (why: string): never => {
    throw new Error(`level ${id}: ${why}`);
  };
  if (!def || typeof def !== 'object') fail('not an object');
  if (typeof def.id !== 'string' || def.id.length === 0) fail('missing id');
  if (![0, 1, 2, 3, 4, 5].includes(def.world)) fail(`world ${String(def.world)} is not 0..5`);
  const p = def.physics;
  if (!p || typeof p !== 'object') fail('missing physics');
  for (const k of ['M', 'm', 'L', 'Fmax', 'startX', 'restDeg'] as const) {
    if (!isNum(p[k])) fail(`physics.${k} is not a finite number`);
  }
  if (!Array.isArray(p.rail) || p.rail.length !== 2 || !isNum(p.rail[0]) || !isNum(p.rail[1])) fail('physics.rail must be [x_min, x_max]');
  const [r0, r1] = p.rail;
  if (!(r0 < r1)) fail(`rail [${r0}, ${r1}] is empty`);
  if (!(r0 < p.startX && p.startX < r1)) fail(`startX ${p.startX} is not inside the rail (${r0}, ${r1})`);
  if (!(p.L >= 0.3 && p.L <= 1.0)) fail(`L ${p.L} is not in [0.3, 1.0]`);
  if (!(p.m > 0)) fail(`m ${p.m} must be > 0`);
  if (!(p.M > 0)) fail(`M ${p.M} must be > 0`);
  if (!(p.Fmax > 0 && p.Fmax <= 40)) fail(`Fmax ${p.Fmax} is not in (0, 40]`);
  if (!(p.restDeg > 0 && p.restDeg <= 6)) fail(`restDeg ${p.restDeg} is not in (0, 6]`);

  // walls: ascending x0, no overlap, 0 < width, 0 < h <= 0.95, within [rail0 - 0.5, rail1 + 0.5]
  if (!Array.isArray(p.walls)) fail('physics.walls must be an array');
  if (p.walls.length > MAX_WALLS) fail(`${p.walls.length} walls (max ${MAX_WALLS})`);
  p.walls.forEach((w, i) => {
    if (!w || !isNum(w.x0) || !isNum(w.x1) || !isNum(w.h)) fail(`wall ${i} is not {x0, x1, h}`);
    if (!(w.x1 - w.x0 > 0)) fail(`wall ${i} has no width`);
    if (!(w.h > 0 && w.h <= 0.95)) fail(`wall ${i} height ${w.h} is not in (0, 0.95]`);
    if (!(w.x0 >= r0 - 0.5 && w.x1 <= r1 + 0.5)) fail(`wall ${i} is outside [rail0 - 0.5, rail1 + 0.5]`);
    if (i > 0) {
      const prev = p.walls[i - 1]!;
      if (!(w.x0 > prev.x0)) fail(`walls are not in ascending x0 order at ${i}`);
      if (w.x0 < prev.x1) fail(`walls ${i - 1} and ${i} overlap`);
    }
  });

  // phases: 1..2 zones, xa < xb, zone centre inside the rail
  if (!Array.isArray(p.phases) || p.phases.length < 1 || p.phases.length > 2) fail('physics.phases must have 1 or 2 zones');
  p.phases.forEach((z, i) => {
    if (!z || (z.kind !== 'pad' && z.kind !== 'pocket') || !isNum(z.xa) || !isNum(z.xb)) fail(`phase ${i} is not {kind, xa, xb}`);
    if (!(z.xa < z.xb)) fail(`phase ${i} zone [${z.xa}, ${z.xb}] is empty`);
    const c = 0.5 * (z.xa + z.xb);
    if (!(c >= r0 && c <= r1)) fail(`phase ${i} zone centre ${c} is outside the rail`);
  });

  // start: hanging ball >= 1 cm from every wall, string clear of every wall, not already in zone 0
  const bx = p.startX;
  const by = RAIL_Y - p.L;
  const minD = BALL_R + 0.01;
  p.walls.forEach((w, i) => {
    if (pointSlabDist2(bx, by, w) < minD * minD) fail(`the hanging ball is closer than 1 cm to wall ${i}`);
    if (segSlabDist2(p.startX, RAIL_Y, bx, by, w) === 0) fail(`the hanging string touches wall ${i}`);
  });
  const z0 = p.phases[0]!;
  if (z0.xa <= bx && bx <= z0.xb) fail('the ball starts inside the phase-0 zone');

  // egg
  if (def.cargo !== 'ball' && def.cargo !== 'egg') fail(`cargo ${String(def.cargo)} is not ball | egg`);
  // the simulator cracks whatever carries physics.egg, so only an egg level may have it
  if (def.cargo === 'ball' && p.egg !== undefined) fail('physics.egg is set on a ball level (cargo must be "egg")');
  if (def.cargo === 'egg') {
    const e = p.egg;
    if (!e || !isNum(e.Tmax) || !isNum(e.Jmax)) fail('an egg level needs physics.egg {Tmax, Jmax}');
    if (!(e!.Tmax > p.m * G)) fail(`egg Tmax ${e!.Tmax} N would crack at rest (m*G = ${p.m * G})`);
    if (!(e!.Jmax > 0)) fail('egg Jmax must be > 0');
  }

  // AI goals (not for composed levels)
  const ai = def.ai;
  if (!ai || !Array.isArray(ai.xGoal)) fail('missing ai.xGoal');
  if (!ai.compose) {
    if (ai.xGoal.length !== p.phases.length) fail(`ai.xGoal has ${ai.xGoal.length} entries for ${p.phases.length} phases`);
    ai.xGoal.forEach((x, i) => {
      const z = p.phases[i]!;
      if (!(isNum(x) && z.xa <= x && x <= z.xb)) fail(`ai.xGoal[${i}] = ${x} is outside zone [${z.xa}, ${z.xb}]`);
    });
  }

  // splits
  if (!Array.isArray(def.splits)) fail('missing splits');
  def.splits.forEach((sp, i) => {
    if ('wall' in sp) {
      if (!(Number.isInteger(sp.wall) && sp.wall >= 0 && sp.wall < p.walls.length)) fail(`split ${i} points at missing wall ${sp.wall}`);
      if (sp.dir !== 1 && sp.dir !== -1) fail(`split ${i} dir must be 1 or -1`);
    } else if ('phase' in sp) {
      if (!(Number.isInteger(sp.phase) && sp.phase >= 0 && sp.phase < p.phases.length)) fail(`split ${i} points at missing phase ${sp.phase}`);
    } else {
      fail(`split ${i} is neither {wall, dir} nor {phase}`);
    }
  });

  // campaign levels carry the three hints in both languages
  if (def.world >= 1) {
    const h = def.hints;
    const ok3 = (a: unknown): boolean => Array.isArray(a) && a.length === 3 && a.every((t) => typeof t === 'string' && t.length > 0);
    if (!h || !ok3(h.ja) || !ok3(h.en)) fail('a campaign level needs hints.ja and hints.en with 3 entries each');
  }
}
