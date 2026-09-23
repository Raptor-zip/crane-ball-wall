// Skins catalog and unlock rules (skins spec §2, §4, §5.7). Owner: O3.
// Pure functions over the existing save (no DOM, no three; same style as progress.ts). Every rule is monotone over
// fields the save already has, so current players unlock at once and never lose an unlock (the daily streak is the
// exception: PART B keeps a bestStreak and a permanent `owned` list for it).
// Skins are cosmetic only: nothing under src/sim, worker/, src/net, src/shared, src/store or the ghost codec imports
// this module (tests/core/skins_boundary.test.ts), and skin ids never reach replays, boards, links or ghosts.
import type { BadgeId } from './bus';
import type { LevelDef } from '../sim/level';
import type { SaveV1 } from '../store/save';
import { BADGE_IDS } from '../store/save';
import { crownCount } from './progress';
import { TRICK_IDS } from './badges';
import { SKIN_PARTS, partLook } from '../render/skinLooks';
import type { SkinLook, SkinPart } from '../render/skinLooks';

export type { SkinLook, SkinPart } from '../render/skinLooks';
export { SKIN_PARTS } from '../render/skinLooks';

export type SkinSet = 'original' | 'lab' | 'site' | 'textbook' | 'tancho' | 'bonus';
export type UnlockRule =
  | { k: 'always' }
  | { k: 'clears'; n: number | 'all' }   // campaign levels (world >= 1) with cleared === true; skips do NOT count
  | { k: 'level'; id: string }           // that campaign level cleared (not skipped)
  | { k: 'world'; w: number }            // every level of world w cleared (== ui/screens/select.ts noteUnlocked)
  | { k: 'notes'; n: number }            // number of worlds fully cleared
  | { k: 'tricks'; n: number | 'all' }   // |seen.tricks ∩ TRICK_IDS|; 'all' = TRICK_IDS.length
  | { k: 'badge'; id: BadgeId }          // any campaign level's badges include it
  | { k: 'fails'; n: number }            // Σ campaign levels[*].fails
  | { k: 'attempts'; n: number }         // Σ campaign levels[*].attempts
  | { k: 'golds'; n: number }            // campaign levels with medal === 3 (a crown implies gold)
  | { k: 'crowns'; n: number | 'all' }   // crownCount(); 'all' = number of campaign levels
  | { k: 'streak'; n: number };          // max(save.daily.streak, extra.bestStreak ?? 0)

export interface SkinDef { id: string; part: SkinPart; set: SkinSet; rule: UnlockRule }

/** The catalog in screen order (§2.1). Thresholds live only here. */
export const SKINS: readonly SkinDef[] = [
  { id: 'ball.red', part: 'ball', set: 'original', rule: { k: 'always' } },
  { id: 'ball.steel', part: 'ball', set: 'lab', rule: { k: 'world', w: 1 } },
  { id: 'ball.wrecker', part: 'ball', set: 'site', rule: { k: 'fails', n: 50 } },
  { id: 'ball.point', part: 'ball', set: 'textbook', rule: { k: 'notes', n: 3 } },
  { id: 'ball.moss', part: 'ball', set: 'bonus', rule: { k: 'streak', n: 7 } },
  { id: 'ball.kinobi', part: 'ball', set: 'bonus', rule: { k: 'golds', n: 5 } },
  { id: 'ball.lapis', part: 'ball', set: 'tancho', rule: { k: 'crowns', n: 'all' } },
  { id: 'crane.yellow', part: 'crane', set: 'original', rule: { k: 'always' } },
  { id: 'crane.wood', part: 'crane', set: 'lab', rule: { k: 'tricks', n: 3 } },
  { id: 'crane.primer', part: 'crane', set: 'site', rule: { k: 'streak', n: 3 } },
  { id: 'crane.lineart', part: 'crane', set: 'textbook', rule: { k: 'badge', id: 'yasashisa' } },
  { id: 'crane.tancho', part: 'crane', set: 'tancho', rule: { k: 'crowns', n: 8 } },
  { id: 'trail.ink', part: 'trail', set: 'original', rule: { k: 'always' } },
  { id: 'trail.pencil', part: 'trail', set: 'lab', rule: { k: 'clears', n: 1 } },
  { id: 'trail.wire', part: 'trail', set: 'site', rule: { k: 'badge', id: 'hashidon' } },
  { id: 'trail.proof', part: 'trail', set: 'textbook', rule: { k: 'tricks', n: 'all' } },
  { id: 'trail.kumihimo', part: 'trail', set: 'tancho', rule: { k: 'crowns', n: 1 } },
  { id: 'stage.note', part: 'stage', set: 'original', rule: { k: 'always' } },
  { id: 'stage.diazo', part: 'stage', set: 'lab', rule: { k: 'level', id: '2-2' } },
  { id: 'stage.site', part: 'stage', set: 'site', rule: { k: 'attempts', n: 300 } },
  { id: 'stage.textbook', part: 'stage', set: 'textbook', rule: { k: 'clears', n: 'all' } },
  { id: 'stage.castle', part: 'stage', set: 'tancho', rule: { k: 'crowns', n: 13 } },
];

export const DEFAULT_SKIN_IDS: Readonly<Record<SkinPart, string>> = {
  ball: 'ball.red', crane: 'crane.yellow', trail: 'trail.ink', stage: 'stage.note',
};

const SKIN_BY_ID: ReadonlyMap<string, SkinDef> = new Map(SKINS.map((s) => [s.id, s]));
const DEFAULT_IDS: ReadonlySet<string> = new Set(Object.values(DEFAULT_SKIN_IDS));

/** The catalog entry of an id (undefined for unknown ids). */
export function skinDef(id: string): SkinDef | undefined {
  return SKIN_BY_ID.get(id);
}

export interface SkinFacts {
  /** Number of campaign levels (world >= 1). */
  campaign: number;
  /** Cleared campaign levels (skips do not count). */
  clears: number;
  cleared: ReadonlySet<string>;
  /** Worlds with every level cleared. */
  worldsDone: ReadonlySet<number>;
  worldSize: ReadonlyMap<number, number>;
  worldCleared: ReadonlyMap<number, number>;
  tricks: number;
  trickTotal: number;
  badges: ReadonlySet<BadgeId>;
  fails: number;
  attempts: number;
  golds: number;
  crowns: number;
  streak: number;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Achievement facts of a save over the campaign levels. `extra.bestStreak` is PART B's stored best daily streak. */
export function skinFacts(save: SaveV1, levels: readonly LevelDef[], extra?: { bestStreak?: number }): SkinFacts {
  const prog = save.levels ?? {};
  const campaign = levels.filter((l) => l.world >= 1);
  const cleared = new Set<string>();
  const worldSize = new Map<number, number>();
  const worldCleared = new Map<number, number>();
  const badges = new Set<BadgeId>();
  let fails = 0, attempts = 0, golds = 0;
  for (const l of campaign) {
    worldSize.set(l.world, (worldSize.get(l.world) ?? 0) + 1);
    if (!worldCleared.has(l.world)) worldCleared.set(l.world, 0);
    const p = Object.prototype.hasOwnProperty.call(prog, l.id) ? prog[l.id] : undefined;
    if (!p) continue;
    if (p.cleared === true) {
      cleared.add(l.id);
      worldCleared.set(l.world, (worldCleared.get(l.world) ?? 0) + 1);
    }
    fails += count(p.fails);
    attempts += count(p.attempts);
    if (p.medal === 3 || p.crown === true) golds++;
    if (Array.isArray(p.badges)) for (const b of p.badges) if ((BADGE_IDS as readonly string[]).includes(b)) badges.add(b);
  }
  const worldsDone = new Set<number>();
  for (const [w, n] of worldSize) if (n > 0 && (worldCleared.get(w) ?? 0) >= n) worldsDone.add(w);
  const seenTricks = Array.isArray(save.seen?.tricks) ? new Set(save.seen.tricks) : new Set<string>();
  const tricks = TRICK_IDS.filter((t) => seenTricks.has(t)).length;
  const streak = Math.max(count(save.daily?.streak), count(extra?.bestStreak));
  return {
    campaign: campaign.length, clears: cleared.size, cleared, worldsDone, worldSize, worldCleared,
    tricks, trickTotal: TRICK_IDS.length, badges, fails, attempts, golds, crowns: crownCount(levels, prog), streak,
  };
}

/** Progress of a rule: `have` / `need` feed the locked card's {have}/{need}; met = unlocked. */
export function ruleProgress(rule: UnlockRule, f: SkinFacts): { have: number; need: number; met: boolean } {
  const res = (have: number, need: number): { have: number; need: number; met: boolean } => ({ have, need, met: need > 0 && have >= need });
  switch (rule.k) {
    case 'always': return { have: 1, need: 1, met: true };
    case 'clears': return res(f.clears, rule.n === 'all' ? f.campaign : rule.n);
    case 'level': return res(f.cleared.has(rule.id) ? 1 : 0, 1);
    case 'world': return res(f.worldCleared.get(rule.w) ?? 0, f.worldSize.get(rule.w) ?? 0);
    case 'notes': return res(f.worldsDone.size, rule.n);
    case 'tricks': return res(f.tricks, rule.n === 'all' ? f.trickTotal : rule.n);
    case 'badge': return res(f.badges.has(rule.id) ? 1 : 0, 1);
    case 'fails': return res(f.fails, rule.n);
    case 'attempts': return res(f.attempts, rule.n);
    case 'golds': return res(f.golds, rule.n);
    case 'crowns': return res(f.crowns, rule.n === 'all' ? f.campaign : rule.n);
    case 'streak': return res(f.streak, rule.n);
    default: return { have: 0, need: 1, met: false };
  }
}

/** Every skin whose rule is met, in catalog order (defaults included). */
export function eligibleSkins(f: SkinFacts): string[] {
  return SKINS.filter((s) => ruleProgress(s.rule, f).met).map((s) => s.id);
}

/** Eligible skins not yet owned (defaults never count), in catalog order. Idempotent. */
export function newlyUnlocked(f: SkinFacts, owned: readonly string[]): string[] {
  const have = new Set(owned);
  return eligibleSkins(f).filter((id) => !DEFAULT_IDS.has(id) && !have.has(id));
}

export type SkinSelection = Partial<Record<SkinPart, string>>;

/**
 * Equipped ids per part: an unknown id, an id of another part or a locked id falls back to that part's default
 * (the save itself is not rewritten). `owned` holds the unlocked non-default ids.
 */
export function resolveSelection(sel: SkinSelection | undefined, owned: ReadonlySet<string>): Record<SkinPart, string> {
  const out = { ...DEFAULT_SKIN_IDS } as Record<SkinPart, string>;
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return out;
  for (const part of SKIN_PARTS) {
    const id = (sel as Record<string, unknown>)[part];
    if (typeof id !== 'string') continue;
    const def = SKIN_BY_ID.get(id);
    if (!def || def.part !== part) continue;
    if (DEFAULT_IDS.has(id) || owned.has(id)) out[part] = id;
  }
  return out;
}

/** The resolved look of equipped ids (unknown ids give the part's default). */
export function skinLook(ids: Record<SkinPart, string>): SkinLook {
  return {
    ball: partLook('ball', ids.ball), crane: partLook('crane', ids.crane),
    trail: partLook('trail', ids.trail), stage: partLook('stage', ids.stage),
  };
}
