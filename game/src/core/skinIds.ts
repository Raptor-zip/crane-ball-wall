// Skin ids: the id vocabulary of the skins catalog, and nothing else (skins spec §1.1, §6.1). Owner: O3.
//
// This module has NO imports (tests/core/skins_boundary.test.ts checks it). It is the one skin module the save layer
// may import: PART B's src/store/cosmetic.ts filters the saved `owned` / `seen` lists to catalog ids and keeps the
// defaults out of them with these values, without reaching the look data (render/skinLooks.ts) or the unlock rules
// (core/skins.ts, which itself imports store/save: store -> core/skins would be an import cycle).
// core/skins.ts builds on this list (tests/core/skins.test.ts keeps SKINS in step with SKIN_IDS, in order).
// Still cosmetic only: nothing under src/sim, worker/, src/net, src/shared or the ghost codec may reach this module.

/** Every catalog id, in screen order (the first id of each part is its default). */
export const SKIN_IDS = [
  'ball.red', 'ball.steel', 'ball.wrecker', 'ball.point', 'ball.moss', 'ball.kinobi', 'ball.lapis',
  'crane.yellow', 'crane.wood', 'crane.primer', 'crane.lineart', 'crane.tancho',
  'trail.ink', 'trail.pencil', 'trail.wire', 'trail.proof', 'trail.kumihimo',
  'stage.note', 'stage.diazo', 'stage.site', 'stage.textbook', 'stage.castle',
] as const;
export type SkinId = (typeof SKIN_IDS)[number];

/** Today's look, part by part: always unlocked, never stored in `owned` / `seen`. */
export const DEFAULT_SKIN_IDS = {
  ball: 'ball.red', crane: 'crane.yellow', trail: 'trail.ink', stage: 'stage.note',
} as const satisfies Readonly<Record<string, SkinId>>;

/** The skinnable parts (the keys of `settings.skin`). */
export type SkinIdPart = keyof typeof DEFAULT_SKIN_IDS;
export const SKIN_ID_PARTS: readonly SkinIdPart[] = ['ball', 'crane', 'trail', 'stage'];

const ID_SET: ReadonlySet<string> = new Set(SKIN_IDS);
const DEFAULT_SET: ReadonlySet<string> = new Set(Object.values(DEFAULT_SKIN_IDS));

/** A catalog id (any part, defaults included). */
export function isSkinId(v: unknown): v is SkinId {
  return typeof v === 'string' && ID_SET.has(v);
}

/** One of the four default ids. */
export function isDefaultSkinId(v: unknown): boolean {
  return typeof v === 'string' && DEFAULT_SET.has(v);
}

/** The part an id belongs to (its prefix), or null when it is not a catalog id. */
export function skinIdPart(v: unknown): SkinIdPart | null {
  if (!isSkinId(v)) return null;
  const p = v.slice(0, v.indexOf('.'));
  return (SKIN_ID_PARTS as readonly string[]).includes(p) ? (p as SkinIdPart) : null;
}
