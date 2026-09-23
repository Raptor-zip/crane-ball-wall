// E2E test hook window.__YP_TEST__ (GAME_DESIGN.md §10.7). Owner: O3.
// Exposed in VITE_TEST=1 builds (dist-test/) and in any build opened with ?yptest=1 (the single-HTML E2E).
// Client-only convenience: whatever it plays is still verified by the server like any other run.
//
//   playReplay(levelId, b64) -> Promise<{ status, score, ticks, state }>
//       opens the level (even if locked), feeds the replay's q sequence through the real session,
//       then waits for the success / crash beat to finish (RESULTS or READY).
//   state()                  -> JSON snapshot: { state, level, mode, status, ticks, substep, ghosts, last, bestSub, ... }
//   command(c)               -> an input Command ('retry', 'pause', 'next', 'confirm', 'back', 'ghostCycle', 'aiLine',
//                               'mute', 'notes', 'rewind', 'any') or a UI action ('resume', 'select', 'practice', 'demo', 'skip',
//                               'openDaily', 'openLevel:<id>', ...), dispatched exactly like the real input.
//   toScreen(x, y)           -> CSS px of the world point (x, y) (rail x, height) through the unshaken camera.

export interface YpTestApi {
  playReplay(levelId: string, b64: string): Promise<unknown>;
  state(): unknown;
  command(c: string): void;
  toScreen?(x: number, y: number): { x: number; y: number } | null;
}

declare global {
  interface Window { __YP_TEST__?: YpTestApi }
}

export function testHooksEnabled(): boolean {
  if (import.meta.env.VITE_TEST === '1') return true;
  try {
    return new URLSearchParams(location.search).has('yptest');
  } catch {
    return false;
  }
}

/** Installs the hook when enabled. Missing methods throw a clear error (the app failed to start). */
export function installTestHooks(api?: Partial<YpTestApi>): void {
  if (!testHooksEnabled()) return;
  const missing = (name: string) => (): never => {
    throw new Error(`__YP_TEST__.${name}: the app is not running`);
  };
  window.__YP_TEST__ = {
    playReplay: api?.playReplay ?? missing('playReplay'),
    state: api?.state ?? missing('state'),
    command: api?.command ?? missing('command'),
    toScreen: api?.toScreen ?? missing('toScreen'),
  };
}
