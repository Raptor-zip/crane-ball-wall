// Split times vs. the comparison ghost (GAME_DESIGN.md §7.6, §8.2 8). Owner: O3.
//
// A split is the first time its SplitDef is achieved: a WallCross of that wall in that direction, or the
// holdStart of that phase's completed hold (same definitions as tools/common.py split_subs, so a player's
// split is comparable with the AI's JSON splitSub). Splits are taken in order: split i can only be reached
// after split i-1 (5-4 must not record "back over wall A" during the approach). For sane runs this equals
// the Python rule.
import type { LevelDef, SplitDef } from '../sim/level';
import type { GhostKind } from '../render/renderer';

export interface SplitTracker {
  /** Returns the index of a split reached on this event, or -1. */
  onWallCross(wall: number, dir: 1 | -1, substep: number): number;
  onPhaseDone(phase: number, substep: number): number;
  times(): number[];  // substep per split, NaN when not reached
  reset(): void;
  /** Practice rewind: forgets the splits reached after `substep` (they can be reached again). */
  truncate(substep: number): void;
}

export function createSplitTracker(level: LevelDef): SplitTracker {
  const splits: readonly SplitDef[] = level.splits ?? [];
  const t = new Array<number>(splits.length).fill(NaN);
  let next = 0;

  const hit = (i: number, substep: number): number => {
    t[i] = substep;
    next = i + 1;
    return i;
  };

  return {
    onWallCross(wall, dir, substep) {
      const s = splits[next];
      if (s && 'wall' in s && s.wall === wall && s.dir === dir) return hit(next, substep);
      return -1;
    },
    onPhaseDone(phase, substep) {
      const s = splits[next];
      if (s && 'phase' in s && s.phase === phase) return hit(next, substep);
      return -1;
    },
    times() {
      return t.slice();
    },
    reset() {
      t.fill(NaN);
      next = 0;
    },
    truncate(substep) {
      for (let i = 0; i < t.length; i++) {
        if (Number.isFinite(t[i]!) && t[i]! > substep) t[i] = NaN;
      }
      next = 0;
      while (next < t.length && Number.isFinite(t[next]!)) next++;
    },
  };
}

/**
 * The comparison ghost (§7.6): the first non-AI ghost of the shown set (PB / WR / rival / challenge), else the AI.
 * `shown` is in display order.
 */
export function comparisonGhost<T extends { kind: GhostKind }>(shown: readonly T[]): T | null {
  const nonAi = shown.find((g) => g.kind === 'pb' || g.kind === 'wr' || g.kind === 'rival' || g.kind === 'challenge' || g.kind === 'daily_pb');
  return nonAi ?? shown.find((g) => g.kind === 'ai') ?? null;
}

/** Player split minus ghost split in substeps (negative = ahead), or null when the ghost never reached it. */
export function splitDelta(playerSub: number, ghostSplits: readonly number[], index: number): number | null {
  const g = ghostSplits[index];
  return g === undefined || !Number.isFinite(g) ? null : playerSub - g;
}
