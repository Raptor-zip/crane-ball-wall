// Per-tick simulation event buffer (GAME_DESIGN.md §10.4). Owner: O1.
// Fixed capacity, no allocation after construction.

export const enum Ev {
  Snap = 1, SlackBegin = 2, StopHit = 3, WallCross = 4, Apex = 5,
  HoldBegin = 6, HoldReset = 7, PhaseDone = 8, Success = 9, Crash = 10, Timeout = 11,
}

export const SIM_EVENTS_CAPACITY = 64;

/**
 * Pre-allocated, non-ring buffer of the events of one tick. stepTick clears it first, so after the call it
 * holds exactly that tick's events, in the order they happened.
 * Payloads: Snap(a=J,b=bx,c=by) SlackBegin(a=T,b=bx,c=by) StopHit(a=side,b=|v|,c=taut?1:0)
 * WallCross(a=wall,b=dir,c=minD2Window) Apex(a=th,b=E,c=0) HoldBegin(a=phase) HoldReset(a=phase,b=hold)
 * PhaseDone(a=phase,b=holdStart) Success(a=score) Crash(a=kind,b=px,c=py) Timeout()
 * `sub` is the substep count at the end of the substep in which the event happened (the same count as
 * SimState.substep, score and the AI ghosts' parSub / splitSub: 1..).
 * E of Apex is the swing energy per unit mass 0.5*L^2*w^2 + G*L*(1 - cos th) (§4.6); the amplitude is
 * acos(1 - E/(G*L)). Apex also fires for tiny oscillations of a resting ball, and StopHit for slow bumps,
 * so effects should gate on the amplitude / speed.
 */
export class SimEvents {
  n = 0;
  kind = new Int32Array(SIM_EVENTS_CAPACITY);
  sub = new Int32Array(SIM_EVENTS_CAPACITY);
  a = new Float64Array(SIM_EVENTS_CAPACITY);
  b = new Float64Array(SIM_EVENTS_CAPACITY);
  c = new Float64Array(SIM_EVENTS_CAPACITY);

  clear(): void {
    this.n = 0;
  }

  /** Appends an event (dropped when the buffer is full). */
  push(kind: Ev, sub: number, a: number, b: number, c: number): void {
    const i = this.n;
    if (i >= SIM_EVENTS_CAPACITY) return;
    this.kind[i] = kind;
    this.sub[i] = sub;
    this.a[i] = a;
    this.b[i] = b;
    this.c[i] = c;
    this.n = i + 1;
  }

  /**
   * Appends an event with a = b = c = 0 and returns its index (-1 when full) so the caller can write
   * float payloads straight into a / b / c. The stepper uses this instead of push() so that no double
   * crosses a call boundary (V8 boxes those into fresh HeapNumbers when the call is not inlined).
   */
  slot(kind: Ev, sub: number): number {
    const i = this.n;
    if (i >= SIM_EVENTS_CAPACITY) return -1;
    this.kind[i] = kind;
    this.sub[i] = sub;
    this.a[i] = 0;
    this.b[i] = 0;
    this.c[i] = 0;
    this.n = i + 1;
    return i;
  }
}
