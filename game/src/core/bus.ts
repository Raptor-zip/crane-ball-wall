// Typed game event bus (GAME_DESIGN.md §10.3). Owner: O3.
// Only core emits; render / audio / ui subscribe.
import type { LevelDef } from '../sim/level';
import type { CrashKind } from '../sim/run';
import type { GhostKind } from '../render/renderer';

/**
 * levelLoaded.label: what to call the level on screen: the id for campaign levels ("2-2"), 「#N」 for today's
 * daily (the number of the share text) and the daily's name for another day's daily. Never the raw daily id "d:16".
 * rewind: a practice rewind (§3.5, D3) moved the run back to tick `ticks` (sim phase `phase`); the pose, the
 * clock and the hold jump back. The renderer's trail / debris were already cleared by resetFx().
 */
export type GameEvent =
  | { t: 'levelLoaded'; level: LevelDef; label?: string }
  | { t: 'ready' } | { t: 'runStart' } | { t: 'retry' }
  | { t: 'rewind'; ticks: number; phase: number }
  | { t: 'saturate'; on: boolean }
  | { t: 'apex'; ampDeg: number; reqDeg: number | null; reached: boolean; x: number; y: number }
  | { t: 'slack'; x: number; y: number }
  | { t: 'snap'; J: number; x: number; y: number }
  | { t: 'stop'; side: -1 | 1; speed: number }
  | { t: 'cross'; wall: number; dir: 1 | -1; gapMm: number; speed: number; px: number; py: number }
  | { t: 'split'; index: number; deltaSub: number; vs: GhostKind }
  | { t: 'holdStart'; phase: number } | { t: 'holdReset'; phase: number; frac: number }
  | { t: 'phase'; index: number }
  | { t: 'success'; score: number; medal: Medal; crown: boolean; firstCrown: boolean; pb: boolean; badges: BadgeId[] }
  | { t: 'crash'; kind: CrashKind; wall: number; x: number; y: number; overlapMm: number }
  | { t: 'timeout'; reason: 'swing' | 'speed' | 'zone' | 'none'; value: number };
export type Medal = 0 | 1 | 2 | 3;               // none / bronze / silver / gold (crown is a separate flag)
export type BadgeId = 'kamihitoe' | 'ippatsu' | 'hashidon' | 'pashi' | 'buranko' | 'yasashisa';

export type GameEventListener = (e: GameEvent) => void;

/** Minimal synchronous emitter. */
export class Bus {
  private readonly listeners: GameEventListener[] = [];

  /** Subscribes; returns an unsubscribe function. */
  on(cb: GameEventListener): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(e: GameEvent): void {
    for (const cb of this.listeners.slice()) cb(e);
  }
}
