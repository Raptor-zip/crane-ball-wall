// Cosmetic save fields: the equipped skins and the skins record (GAME_DESIGN.md §7.14, §10.4 "保存"). Owner: O8.
//
// - settings.skin: the equipped id per part. The UI writes it like every other setting. Kept as stored (strings of
//   known parts, at most 32 characters): core/skins.ts resolveSelection() falls back to the part's default for an
//   unknown, foreign or locked id at apply time, and the save is never rewritten for it.
// - skins: { owned, seen, bestStreak }. core adds unlocked ids to `owned` (never removed: an unlock stays even when a
//   later save would no longer meet its rule) and keeps the best daily streak (markPlayed resets the streak after a
//   gap). The UI adds the ids the player has looked at to `seen` (the NEW dots), like seen.notes.
// The skin id vocabulary comes from the import-free core/skinIds.ts, the only skin module src/store may import
// (tests/core/skins_boundary.test.ts). Skins are cosmetic only: nothing here reaches replays, boards or the outbox.
import type { SaveV1 } from './save';
import { SKIN_ID_PARTS, isDefaultSkinId, isSkinId } from '../core/skinIds';
import type { SkinIdPart } from '../core/skinIds';

/** Equipped id per part (settings.skin). A missing part is that part's default. */
export type SkinSelectionSave = Partial<Record<SkinIdPart, string>>;

/** The skins record (SaveV1.skins). */
export interface SkinRecord {
  /** Unlocked non-default ids, in unlock order (catalog ids only, never a default). */
  owned: string[];
  /** Unlocked ids the player has seen on the skins screen (a subset of owned is not required: filtered like owned). */
  seen: string[];
  /** Best daily streak ever (the skins' streak rules use max(daily.streak, bestStreak)). */
  bestStreak: number;
}

const BIG = 2 ** 31 - 1;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** settings.skin from anything: strings of at most 32 characters under the known part keys; undefined when empty. */
export function parseSkinSelection(x: unknown): SkinSelectionSave | undefined {
  if (!isObj(x)) return undefined;
  const out: SkinSelectionSave = {};
  let any = false;
  for (const part of SKIN_ID_PARTS) {
    const v = x[part];
    if (typeof v === 'string' && v.length > 0 && v.length <= 32) {
      out[part] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** A list of catalog ids without defaults and duplicates, in stored order. */
function idList(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const v of x) if (isSkinId(v) && !isDefaultSkinId(v) && !out.includes(v)) out.push(v);
  return out;
}

export function emptySkinRecord(): SkinRecord {
  return { owned: [], seen: [], bestStreak: 0 };
}

/**
 * SaveV1.skins from anything (undefined when absent or not an object). `dailyStreak` is the parsed daily streak:
 * bestStreak is never below it.
 */
export function parseSkinRecord(x: unknown, dailyStreak = 0): SkinRecord | undefined {
  if (!isObj(x)) return undefined;
  const best = typeof x.bestStreak === 'number' && Number.isInteger(x.bestStreak) && x.bestStreak >= 0 && x.bestStreak <= BIG ? x.bestStreak : 0;
  const ds = Number.isFinite(dailyStreak) ? Math.min(BIG, Math.max(0, Math.floor(dailyStreak))) : 0;
  return { owned: idList(x.owned), seen: idList(x.seen), bestStreak: Math.max(best, ds) };
}

/** The skins record of a save, created when missing. Call inside store.update(). */
export function ensureSkinRecord(d: SaveV1): SkinRecord {
  if (!d.skins) d.skins = emptySkinRecord();
  return d.skins;
}

/** Keeps the best daily streak (call right after markPlayed, inside the same store.update). */
export function noteBestStreak(d: SaveV1): void {
  const s = d.daily?.streak ?? 0;
  if (!(s > (d.skins?.bestStreak ?? 0))) return;
  ensureSkinRecord(d).bestStreak = Math.min(BIG, s);
}

/** Adds unlocked ids to `owned` (catalog ids, never defaults, no duplicates). Returns the ids that were added. */
export function addOwnedSkins(d: SaveV1, ids: readonly string[]): string[] {
  const fresh = idList(ids).filter((id) => !(d.skins?.owned ?? []).includes(id));
  if (!fresh.length) return [];
  ensureSkinRecord(d).owned.push(...fresh);
  return fresh;
}

/** The UI marks skins as seen (the NEW dots go away). */
export function markSkinsSeen(d: SaveV1, ids: readonly string[]): void {
  const fresh = idList(ids).filter((id) => !(d.skins?.seen ?? []).includes(id));
  if (fresh.length) ensureSkinRecord(d).seen.push(...fresh);
}
