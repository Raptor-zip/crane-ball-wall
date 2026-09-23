// Physics and rule constants (GAME_DESIGN.md §4.1, Appendix A). Owner: O1.
// Pure TS: no DOM, no three, no banned Math functions (§4.3).

/** Bumped whenever the simulation changes results; part of every ranking key and replay header. */
export const SIM_VERSION = 1;

export const G = 9.81;              // m/s^2
export const B_TROLLEY = 0.3;       // N*s/m, trolley viscous friction
export const C_PIVOT = 0.002;       // N*m*s/rad, pivot damping
export const RAIL_Y = 1.25;         // m, pivot (hook) height
export const BALL_R = 0.06;         // m, ball (egg) radius
export const BEAM_Y = 1.30;         // m, underside of the rail beam

export const SUB_HZ = 120;          // substeps per second
export const TICK_HZ = 60;          // input ticks per second (2 substeps each)
export const H = 1 / 120;           // s, substep length

export const HOLD_SUB = 60;         // substeps of rest needed for success (0.5 s)
export const REST_V = 0.05;         // m/s, trolley speed limit for "at rest"
export const MAX_SUB = 7200;        // 60 s time-up
export const RANKED_MAX_TICKS = 2700; // 45 s; longer runs are not submitted

export const Q_MAX = 127;           // |q| limit of the quantised force
export const SNAP_EV_MIN_J = 0.05;  // N*s; smaller re-tension impulses emit no Snap event
export const REPLAY_MAX_BYTES = 6144;
