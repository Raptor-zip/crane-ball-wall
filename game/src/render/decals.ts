// Red crash crosses on walls (last 5 per level, session only) (GAME_DESIGN.md §9.5). Owner: O5.
//
// The crosses are drawn through the depth-tested ink batch each frame; this module only keeps
// the list per level id for the session (they survive retries and level switches, not reloads).

export interface Decal { x: number; y: number; z: number; rot: number; size: number }

export const DECALS_PER_LEVEL = 5;

export interface DecalStore {
  add(levelId: string, d: Decal): void;
  list(levelId: string): readonly Decal[];
  /** Age in seconds of the newest decal (for the "stamp" pop-in), or Infinity. */
  newestAge(levelId: string): number;
  tick(dt: number): void;
}

export function createDecals(): DecalStore {
  const byLevel = new Map<string, Decal[]>();
  const born = new Map<string, number>();
  let clock = 0;
  return {
    add(levelId, d) {
      const l = byLevel.get(levelId) ?? [];
      l.push(d);
      while (l.length > DECALS_PER_LEVEL) l.shift();
      byLevel.set(levelId, l);
      born.set(levelId, clock);
    },
    list(levelId) {
      return byLevel.get(levelId) ?? [];
    },
    newestAge(levelId) {
      const b = born.get(levelId);
      return b === undefined ? Infinity : clock - b;
    },
    tick(dt) {
      clock += dt;
    },
  };
}
