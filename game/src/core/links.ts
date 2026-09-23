// Deep links: #d, #c=<levelId>.<replay>, #l=<levelId> (GAME_DESIGN.md §7.5, §7.13). Owner: O3.
// parseHash never throws. resolveLink validates against the level table and the replay header.
import type { LevelDef, LevelPhysics } from '../sim/level';
import { SIM_VERSION } from '../sim/constants';

export type LinkTarget =
  | { kind: 'none' }
  | { kind: 'daily' }
  | { kind: 'challenge'; levelId: string; replay: string }
  | { kind: 'level'; levelId: string }
  | { kind: 'invalid'; raw: string };   // looked like #c= / #l= but is malformed ("この挑戦状は開けませんでした")

/** Campaign ids "1-1".."5-9" and daily ids "d:<n>". */
const LEVEL_ID = /^(?:[1-5]-[1-9]|d:[0-9]{1,4})$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** Longest share URL that still carries the replay (§7.13). */
export const MAX_CHALLENGE_URL = 1500;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Never throws; malformed #c= / #l= links yield { kind: 'invalid' }. */
export function parseHash(hash: string): LinkTarget {
  if (typeof hash !== 'string') return { kind: 'none' };
  let h = safeDecode(hash.trim());
  if (h.startsWith('#')) h = h.slice(1);
  h = h.trim();
  if (h === '') return { kind: 'none' };
  if (h === 'd' || h === 'd/' || /^d[?&]/.test(h)) return { kind: 'daily' };
  if (h.startsWith('c=')) {
    const body = h.slice(2).replace(/[\s=]+$/g, '');
    const dot = body.indexOf('.');
    if (dot <= 0) return { kind: 'invalid', raw: h };
    const levelId = body.slice(0, dot);
    const replay = body.slice(dot + 1).replace(/\s+/g, '');
    if (!LEVEL_ID.test(levelId) || replay.length === 0 || !B64URL.test(replay)) return { kind: 'invalid', raw: h };
    return { kind: 'challenge', levelId, replay };
  }
  if (h.startsWith('l=')) {
    const levelId = h.slice(2).trim();
    if (!LEVEL_ID.test(levelId)) return { kind: 'invalid', raw: h };
    return { kind: 'level', levelId };
  }
  return { kind: 'none' };
}

export function challengeUrl(origin: string, levelId: string, replay: string): string {
  return `${origin}/#c=${levelId}.${replay}`;
}

export function levelUrl(origin: string, levelId: string): string {
  return `${origin}/#l=${levelId}`;
}

export function dailyUrl(origin: string): string {
  return `${origin}/#d`;
}

/** The share URL of §7.13: the challenge link, or #l= when there is no replay or the link would exceed 1,500 characters. */
export function shareLevelUrl(origin: string, levelId: string, replay: string | null): string {
  if (replay) {
    const u = challengeUrl(origin, levelId, replay);
    if (u.length <= MAX_CHALLENGE_URL) return u;
  }
  return levelUrl(origin, levelId);
}

/**
 * Origin for share links: VITE_PUBLIC_ORIGIN when set, else location.origin on http(s), else null
 * (single HTML on file:// or inside an Artifact: the URL is left out of the share text).
 */
export function shareOrigin(publicOrigin: string | undefined, loc: { protocol: string; origin: string } | null): string | null {
  if (publicOrigin) return publicOrigin.replace(/\/+$/, '');
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) return loc.origin;
  return null;
}

// ------------------------------------------------------------------------------------------- resolution

export interface LinkDeps {
  findLevel(id: string): LevelDef | null;
  /** decodeReplay(b64urlDecode(b64)).h.levelHash; must throw on a broken replay. */
  replayLevelHash(b64: string): string;
  /**
   * decodeReplay(b64urlDecode(b64)).h.sim. A replay of another simulation version (SIM_VERSION was bumped since the
   * link was shared) would take a different path here, so it is stale like a level-hash mismatch. Optional.
   */
  replaySim?(b64: string): number;
  levelHash(phys: LevelPhysics): string;
}

export type ResolvedLink =
  | { kind: 'none' }
  | { kind: 'daily' }
  | { kind: 'level'; level: LevelDef }
  | { kind: 'challenge'; level: LevelDef; replay: string | null; stale: boolean }   // stale: "古いバージョン", opened without the ghost
  | { kind: 'error' };                                                             // "この挑戦状は開けませんでした" -> level select

/** Checks a parsed link against the data (§7.5 3). Never throws. */
export function resolveLink(t: LinkTarget, deps: LinkDeps): ResolvedLink {
  try {
    switch (t.kind) {
      case 'none':
      case 'daily':
        return t;
      case 'invalid':
        return { kind: 'error' };
      case 'level': {
        const level = deps.findLevel(t.levelId);
        return level ? { kind: 'level', level } : { kind: 'error' };
      }
      case 'challenge': {
        const level = deps.findLevel(t.levelId);
        if (!level) return { kind: 'error' };
        let h: string;
        let sim = SIM_VERSION;
        try {
          h = deps.replayLevelHash(t.replay);
          if (deps.replaySim) sim = deps.replaySim(t.replay);
        } catch {
          return { kind: 'error' };
        }
        const stale = h !== deps.levelHash(level.physics) || sim !== SIM_VERSION;
        return { kind: 'challenge', level, replay: stale ? null : t.replay, stale };
      }
    }
  } catch {
    return { kind: 'error' };
  }
  return { kind: 'none' };
}
