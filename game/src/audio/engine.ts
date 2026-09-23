// Audio contract and WebAudio engine (GAME_DESIGN.md §9.6, §10.4 "音"). Owner: O6.
//
// Graph (built once per context):
//
//   game one-shots ────────────────────────────┐
//   MotorVoice ─> centre (−3 dB) ─┬─> bed ──────┴─> game gate ─┐
//   WindVoice ────────────────────┘                             ├─> bus ─> master (volume² · trim, mute) ─> ½ ─> soft limiter ─> out
//   UI clicks ──────────────────────────────────────────────────┘
//
// - The AudioContext is created lazily on the first user gesture (unlock), never at import or construction,
//   so there is no autoplay warning and environments without WebAudio simply get a silent engine.
// - The context is suspended while the tab is hidden (§9.6) and resumed when it is visible again; gestures
//   also resume it (e.g. after the iOS "interrupted" state).
// - suspend() / resume() (the pause menu) close / open the game gate only: game sounds stop and game events are
//   ignored, but UI clicks in the pause menu and the settings still sound. A hold riser in progress waits: its
//   remaining steps sound once the run is running again after resume() (the next update() with running: true),
//   where the paused simulation's hold picks up; if the player left the run from the pause menu instead, they
//   never sound.
// - The hold riser follows simulation time (update().timeScale, D7): its steps are 0.1 s of sim time apart, so
//   they stretch in practice (0.5×) and in slow motion, wait through a hit-stop (0×), and are re-timed whenever
//   the time scale changes mid-riser. Everything else is wall-clock audio (it follows events, not a sim clock).
// - Continuous sounds glide with setTargetAtTime (no zipper noise). One-shots are rate-limited per effect
//   and capped at MAX_VOICES with priorities; low-priority ticks are dropped first.
import type { GameEvent } from '../core/bus';
import {
  CELEBRATION_DELAY_S, HOLD_STEP_S, holdStepInto, motorParams, nearMissTier, playSfx, windParams,
  type SfxId,
} from './sfx';
import {
  CENTER_PAN_GAIN, MotorVoice, Voice, WindVoice, clamp, limiterCurve,
  type MotorParams, type SfxVoice, type WindParams,
} from './synth';

/** Per-frame input of AudioEngine.update(). */
export interface AudioUpdate {
  running: boolean; v: number; F: number; Fmax: number; saturated: boolean; ballSpeed: number; panX: number;
  /**
   * Sim seconds per wall-clock second for the coming frame (the loop's timeScale: practice 0.5, near-miss slow-mo
   * 0.35, hit-stop 0; default 1). Time-based sequences that belong to the simulation (the hold riser) follow it.
   */
  timeScale?: number;
}

export interface AudioEngine {
  unlock(): void; setVolume(v: number): void; setMuted(m: boolean): void; suspend(): void; resume(): void;
  /** Once per frame. */
  update(p: AudioUpdate): void;
  fx(e: GameEvent): void;
}

export type AudioState = 'locked' | 'running' | 'suspended' | 'unavailable';

export interface AudioEngineOptions {
  /** Use this context instead of creating an AudioContext on unlock (tests pass an OfflineAudioContext). */
  context?: BaseAudioContext;
  /**
   * Listen on window/document for first gestures (unlock), visibility (suspend while hidden) and clicks on
   * buttons (UI click; opt out with data-sfx="none" on the element or an ancestor, the nearest data-sfx wins).
   * Default: true when no context is given and a DOM exists.
   */
  autoWire?: boolean;
  /** Initial volume 0..1 (default 0.8) and mute. */
  volume?: number;
  muted?: boolean;
  /**
   * Called for every one-shot that is actually scheduled (dev page log, tests). Hold steps report id 'hold',
   * param = step; a step re-timed by a timeScale change or a pause is reported again with its new time.
   */
  onSound?: (id: SfxId, when: number, param: number | undefined) => void;
}

/** What createAudioEngine returns: the §10.4 contract plus helpers for the demo page, UI and tests. */
export interface AudioEngineExt extends AudioEngine {
  /** Plays one effect now (UI sounds, demo page). Dropped while locked or suspended, and (all but 'ui') while paused. */
  play(id: SfxId, param?: number, pan?: number): void;
  readonly state: AudioState;
  /** Whether game sounds are paused by suspend() (UI clicks still play). */
  readonly paused: boolean;
  readonly context: BaseAudioContext | null;
  /** Final node before the destination (for meters in dev pages). */
  readonly output: AudioNode | null;
  /** One-shot voices currently sounding or scheduled. */
  readonly activeVoices: number;
  dispose(): void;
}

/**
 * Make-up gain applied after volume². The recipe levels in sfx.ts are conservative, and every one-shot goes
 * through a StereoPanner, which puts a centred mono sound 3 dB lower per channel (1.4 · √2).
 */
export const MASTER_TRIM = 2.0;
/** Sub-mix of the continuous motor + wind bed (-3 dB), so the musical apex ticks sit on top of it. */
export const BED_TRIM = 0.7;
/** Upper bound on simultaneously sounding / scheduled one-shot voices. */
export const MAX_VOICES = 24;
/** Minimum spacing between two starts of the same effect (s). */
const MIN_GAP: Readonly<Record<SfxId, number>> = {
  apex: 0.05, chime: 0.12, snap: 0.04, stop: 0.06, crash: 0.1, nearMiss: 0.08, hold: 0, success: 0.3, fanfare: 0.5,
  split: 0.08, timeout: 0.3, ui: 0.025, holdReset: 0.1, pb: 0.3, phase: 0.2, whoosh: 0.12, rewind: 0.2,
};
/** When the voice cap is reached, a new sound may replace an active one of strictly lower priority. */
const PRIORITY: Readonly<Record<SfxId, number>> = {
  ui: 1, apex: 1, whoosh: 1, split: 2, snap: 2, stop: 2, holdReset: 2, rewind: 2, nearMiss: 3, hold: 3, chime: 3, phase: 3,
  pb: 4, success: 5, fanfare: 5, crash: 5, timeout: 5,
};
/** Scale of the ball's screen x for one-shot panning (subtler than the wind). */
const ONESHOT_PAN = 0.6;
/**
 * A HoldBegin this soon after the previous riser's first note does not strike that note again (the sim's hold
 * flickers when the cart speed hovers at REST_V: e.g. 1-1 HoldBegin, HoldReset 3 substeps later, HoldBegin again).
 */
const RISER_RETRIGGER_S = 0.12;
/** Steps of the hold riser (§9.6: C5 D5 E5 G5 A5). */
const RISER_STEPS = 5;
/** Game gate / pause fade time constant (s). */
const GATE_TAU = 0.025;
/**
 * Sounds may be scheduled this long after a resume() request that has not resolved yet (s): Firefox and Safari
 * start a new context a few ms after the gesture, and the click that unlocked audio should still click. Longer
 * than that, sounds would pile up and play in a burst when the context finally runs.
 */
const RESUME_GRACE_S = 0.3;

type Ctor = new (opts?: AudioContextOptions) => AudioContext;

/** Elements whose clicks get the UI click sound (unless an ancestor or the element says data-sfx="none"). */
const CLICKABLE = [
  'button', '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="radio"]', '[role="switch"]', '[role="checkbox"]',
  'a[href]', 'summary', 'select', 'input[type="checkbox"]', 'input[type="radio"]',
].join(', ');

function audioContextCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function isRealtime(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof (ctx as AudioContext).resume === 'function' && typeof (ctx as OfflineAudioContext).startRendering !== 'function';
}

function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

class Engine implements AudioEngineExt {
  private ctx: BaseAudioContext | null = null;
  private readonly ownsContext: boolean;
  private unavailable = false;
  private unlocked = false;
  private userSuspended = false;
  private hidden = false;
  private primed = false;
  private disposed = false;
  /** clock() time of a resume() request that has not resolved yet (-Infinity: none). */
  private resumeAt = -Infinity;

  private bus: GainNode | null = null;
  private game: GainNode | null = null;
  private master: GainNode | null = null;
  private out: AudioNode | null = null;
  private motor: MotorVoice | null = null;
  private wind: WindVoice | null = null;

  private volume: number;
  private muted: boolean;
  private panX = 0;
  private chimeArmed = true;
  private lastReq: number | null = null;

  private readonly slots: (SfxVoice | null)[] = new Array<SfxVoice | null>(MAX_VOICES).fill(null);
  private readonly slotPrio = new Int8Array(MAX_VOICES);
  private readonly lastAt = new Map<SfxId, number>();
  /** Sim seconds per wall second, from the last update() (D7). */
  private timeScale = 1;
  /**
   * The hold riser in progress. Its clock is piecewise linear: at context time `riserAnchor` the hold had lasted
   * `riserSim` sim seconds, and it advances at `riserScale` sim s per s from there (0 while paused or in a
   * hit-stop). `riserSteps[k]` is the voice of step k (null: not scheduled yet, or re-timed); steps below
   * `riserFrom` belong to the previous riser (flicker).
   */
  private riserOn = false;
  private riserFrom = 0;
  private riserSim = 0;
  private riserAnchor = 0;
  private riserScale = 1;
  /** Set by resume(): the riser stays frozen until the next update() says whether the run goes on. */
  private riserAwaitRun = false;
  private readonly riserSteps: (SfxVoice | null)[] = new Array<SfxVoice | null>(RISER_STEPS).fill(null);
  private riserFirstAt = -Infinity;
  private readonly pending: SfxVoice[] = [];
  private readonly onSound: AudioEngineOptions['onSound'];
  private readonly mp: MotorParams = { freq: 60, cutoff: 600, gain: 0, growl: 0 };
  private readonly wp: WindParams = { center: 400, gain: 0, pan: 0 };
  private readonly unwire: (() => void)[] = [];

  constructor(opts: AudioEngineOptions) {
    this.volume = clamp(finite(opts.volume ?? 0.8, 0.8), 0, 1);
    this.muted = opts.muted ?? false;
    this.onSound = opts.onSound;
    this.ownsContext = !opts.context;
    if (opts.context) {
      this.ctx = opts.context;
      this.unlocked = true;
      this.build();
    }
    const dom = typeof window !== 'undefined' && typeof document !== 'undefined';
    if ((opts.autoWire ?? !opts.context) && dom) this.wire();
  }

  // ---- contract -------------------------------------------------------------------------------

  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      if (this.unavailable) return;
      // Only create the context once the page has user activation, so the browser never warns.
      const ua = typeof navigator !== 'undefined' ? navigator.userActivation : undefined;
      if (ua && !ua.hasBeenActive && !ua.isActive) return;
      const C = audioContextCtor();
      if (!C) {
        this.unavailable = true;
        return;
      }
      try {
        this.ctx = new C({ latencyHint: 'interactive' });
      } catch {
        this.unavailable = true;
        return;
      }
      this.build();
    }
    this.unlocked = true;
    const ctx = this.ctx;
    const stalled = isRealtime(ctx) && ctx.state !== 'running';
    this.sync();
    if (isRealtime(ctx) && (!this.primed || stalled)) {
      // iOS: starting any source inside the gesture unlocks output for good. Repeated while the context is not
      // running, because a first attempt outside a real gesture (e.g. a touch pointerdown) does not count.
      this.primed = true;
      try {
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.start();
      } catch {
        // Harmless: priming is best-effort.
      }
    }
  }

  setVolume(v: number): void {
    const x = finite(v, this.volume);
    this.volume = clamp(x > 1 ? x / 100 : x, 0, 1);
    this.applyMaster(0.03);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMaster(0.015);
  }

  suspend(): void {
    if (this.userSuspended) return;
    this.userSuspended = true;
    this.applyGate();
    // The paused simulation keeps its hold: the rest of the riser waits for resume().
    this.retimeRiser(true);
    // Behind the closing gate: slower than the gate, so the two fades do not multiply into a click.
    this.silenceContinuous(0.05);
  }

  resume(): void {
    if (!this.userSuspended) return;
    this.userSuspended = false;
    this.applyGate();
    // Core also resumes when the player leaves the run from the pause menu: the rest of the riser only comes back
    // if the next frame is still running (update()).
    if (this.riserOn) this.riserAwaitRun = true;
  }

  update(p: AudioUpdate): void {
    const ts = p.timeScale;
    // Clamped to a sane range: a garbage value must not schedule the riser minutes away.
    this.timeScale = ts === undefined ? 1 : clamp(finite(ts, 1), 0, 16);
    if (this.riserAwaitRun) {
      this.riserAwaitRun = false;
      if (!p.running) this.cancelRiser(false);
    }
    this.retimeRiser(false);
    const ctx = this.ctx;
    if (!ctx || !this.gameLive()) return;
    const t = ctx.currentTime;
    this.panX = clamp(finite(p.panX), -1, 1);
    const run = !!p.running;
    motorParams(p.v, p.F, p.Fmax, !!p.saturated, run, this.mp);
    windParams(p.ballSpeed, this.panX, run, this.wp);
    this.motor?.set(this.mp, t);
    this.wind?.set(this.wp, t);
  }

  fx(e: GameEvent): void {
    if (!this.ctx) return;
    switch (e.t) {
      case 'runStart':
        // A run cannot start while paused: if the caller missed resume(), do not stay silent for the whole run.
        if (this.userSuspended) this.resume();
        this.resetRun();
        break;
      case 'levelLoaded':
      case 'ready':
        this.resetRun();
        break;
      case 'retry':
        this.resetRun();
        this.silenceContinuous();
        break;
      case 'rewind':
        // D3 practice rewind: the pose, the clock and the hold jump back, so the riser of the discarded future
        // (and anything else still scheduled, e.g. a crash crumble when rewinding out of the crash beat) goes.
        // The motor / wind bed follows update() again on the next frame.
        this.resetRun();
        this.trigger('rewind');
        break;
      case 'saturate':
        // The growl follows update().saturated; the haptic pulse is haptics.ts.
        break;
      case 'apex': {
        const amp = Math.abs(finite(e.ampDeg));
        if (amp <= 3) break;
        this.trigger('apex', amp, this.panX * ONESHOT_PAN);
        if (e.reqDeg !== this.lastReq) {
          this.lastReq = e.reqDeg;
          this.chimeArmed = true;
        }
        if (e.reached && e.reqDeg !== null) {
          if (this.chimeArmed) this.trigger('chime', undefined, this.panX * ONESHOT_PAN * 0.5);
          this.chimeArmed = false;
        } else {
          this.chimeArmed = true;
        }
        break;
      }
      case 'slack':
        // §9.5: no sound (the snap that follows is the cue). This is also why the extra 'slack' that core emits
        // with a StopHit whose string went slack (D5) can never double up with the SlackBegin one.
        break;
      case 'snap':
        this.trigger('snap', e.J, this.panX * ONESHOT_PAN);
        break;
      case 'stop':
        // Core only emits hits from 0.1 m/s (D5); the floor here just keeps a stray zero-speed event silent.
        if (finite(e.speed) >= 0.05) this.trigger('stop', e.speed, e.side * 0.5);
        break;
      case 'cross': {
        const tier = nearMissTier(e.gapMm);
        if (tier >= 0) this.trigger('nearMiss', tier, this.panX * ONESHOT_PAN);
        if (finite(e.speed) >= 3) this.trigger('whoosh', undefined, this.panX * ONESHOT_PAN);
        break;
      }
      case 'split':
        this.trigger('split', e.deltaSub);
        break;
      case 'holdStart':
        this.startRiser();
        break;
      case 'holdReset': {
        // "惜しい" (≥ 30 % filled): cut the riser and play the falling tone. A flicker at the very start of a
        // hold only drops the steps that have not sounded; the note already sounding rings out naturally.
        const big = finite(e.frac) >= 0.3;
        this.cancelRiser(big);
        if (big) this.trigger('holdReset');
        break;
      }
      case 'phase':
        this.trigger('phase');
        break;
      case 'success':
        this.trigger('success', e.medal);
        if (e.firstCrown) this.schedule('fanfare', CELEBRATION_DELAY_S);
        else if (e.pb) this.schedule('pb', CELEBRATION_DELAY_S);
        break;
      case 'crash':
        this.cancelRiser(true);
        this.silenceContinuous();
        this.trigger('crash', e.kind, this.panX * ONESHOT_PAN);
        break;
      case 'timeout':
        this.cancelRiser(true);
        this.silenceContinuous();
        this.trigger('timeout');
        break;
    }
  }

  // ---- extras ---------------------------------------------------------------------------------

  play(id: SfxId, param?: number, pan = 0): void {
    this.trigger(id, param, pan);
  }

  get state(): AudioState {
    if (this.unavailable) return 'unavailable';
    const ctx = this.ctx;
    if (!ctx) return 'locked';
    if (!isRealtime(ctx)) return 'running';
    return ctx.state === 'running' ? 'running' : 'suspended';
  }

  get paused(): boolean {
    return this.userSuspended;
  }

  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  get output(): AudioNode | null {
    return this.out;
  }

  get activeVoices(): number {
    const now = this.ctx ? this.ctx.currentTime : 0;
    let n = 0;
    for (const v of this.slots) if (v && v.end > now) n++;
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.unwire) f();
    this.unwire.length = 0;
    this.motor?.dispose();
    this.wind?.dispose();
    const ctx = this.ctx;
    if (ctx && this.ownsContext && isRealtime(ctx)) ctx.close().catch(() => undefined);
  }

  // ---- internals ------------------------------------------------------------------------------

  private build(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.bus = ctx.createGain();
    this.master = ctx.createGain();
    const half = ctx.createGain();
    half.gain.value = 0.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = limiterCurve();
    shaper.oversample = 'none';
    this.game = ctx.createGain();
    this.game.gain.value = this.userSuspended ? 0 : 1;
    this.game.connect(this.bus);
    const bed = ctx.createGain();
    bed.gain.value = BED_TRIM;
    bed.connect(this.game);
    // The motor is a mono source like the one-shots: give it the level of a centred panner.
    const centre = ctx.createGain();
    centre.gain.value = CENTER_PAN_GAIN;
    centre.connect(bed);
    this.bus.connect(this.master);
    this.master.connect(half);
    half.connect(shaper);
    shaper.connect(ctx.destination);
    this.out = shaper;
    this.master.gain.value = this.masterGain();
    this.motor = new MotorVoice(ctx, centre, t);
    this.wind = new WindVoice(ctx, bed, t);
  }

  private masterGain(): number {
    return this.muted ? 0 : this.volume * this.volume * MASTER_TRIM;
  }

  private applyMaster(tau: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.masterGain(), ctx.currentTime, tau);
  }

  /**
   * Clock for rate limits and the riser retrigger window (s). The audio clock of a live context advances in
   * device-sized chunks (Android: 20..40 ms; seen stalled for 36 ms right after creation) and can lag real time,
   * so two clicks 30 ms apart could read the same currentTime; real time is used there. Offline renders (tests)
   * use the context time, which is what their scripted events follow.
   */
  private clock(): number {
    const ctx = this.ctx;
    if (ctx && !isRealtime(ctx)) return ctx.currentTime;
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  private applyGate(): void {
    const ctx = this.ctx;
    if (!ctx || !this.game) return;
    this.game.gain.cancelScheduledValues(ctx.currentTime);
    this.game.gain.setTargetAtTime(this.userSuspended ? 0 : 1, ctx.currentTime, GATE_TAU);
  }

  /**
   * Whether sounds may be scheduled now: the context runs, or a resume requested by a gesture is about to
   * complete (see RESUME_GRACE_S). A suspended context would play them late in a burst.
   */
  private live(): boolean {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return false;
    if (!isRealtime(ctx) || ctx.state === 'running') return true;
    return !this.hidden && this.clock() - this.resumeAt < RESUME_GRACE_S;
  }

  /** live() and not paused by suspend(): game sounds may be scheduled. */
  private gameLive(): boolean {
    return !this.userSuspended && this.live();
  }

  private sync(): void {
    const ctx = this.ctx;
    if (!ctx || !isRealtime(ctx) || this.disposed) return;
    const want = this.unlocked && !this.hidden;
    const st = ctx.state as string;
    if (st === 'closed') return;
    if (want && st !== 'running') {
      const at = this.clock();
      this.resumeAt = at;
      const done = (): void => {
        if (this.resumeAt === at) this.resumeAt = -Infinity;
      };
      try {
        // Old WebKit returns undefined instead of a promise.
        const p = ctx.resume() as Promise<void> | undefined;
        if (p && typeof p.then === 'function') p.then(done, done);
        else done();
      } catch {
        done();
      }
    } else if (!want && st === 'running') {
      this.resumeAt = -Infinity;
      try {
        const p = ctx.suspend() as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        // Nothing to do: the context keeps running.
      }
    }
  }

  private wire(): void {
    const onGesture = (): void => {
      const ctx = this.ctx;
      if (ctx && isRealtime(ctx) && ctx.state === 'running' && this.primed) return;
      this.unlock();
    };
    const gestures = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown', 'click'] as const;
    for (const g of gestures) window.addEventListener(g, onGesture, { capture: true, passive: true });
    this.unwire.push(() => {
      for (const g of gestures) window.removeEventListener(g, onGesture, { capture: true });
    });
    const onVis = (): void => {
      this.hidden = document.visibilityState === 'hidden';
      this.sync();
    };
    document.addEventListener('visibilitychange', onVis);
    this.unwire.push(() => document.removeEventListener('visibilitychange', onVis));
    this.hidden = document.visibilityState === 'hidden';
    const onClick = (ev: MouseEvent): void => {
      const el = ev.target instanceof Element ? ev.target : null;
      if (!el) return;
      const hit = el.closest(CLICKABLE);
      if (!hit || hit.closest('[data-sfx]')?.getAttribute('data-sfx') === 'none') return; // nearest data-sfx wins
      if ((hit as HTMLButtonElement).disabled || hit.getAttribute('aria-disabled') === 'true') return;
      this.trigger('ui');
    };
    document.addEventListener('click', onClick, true);
    this.unwire.push(() => document.removeEventListener('click', onClick, true));
  }

  /**
   * Starts one effect `delay` s from now, respecting rate limits and the voice cap. UI clicks go straight to the
   * bus (they also sound in the pause menu); everything else goes through the game gate.
   */
  private trigger(id: SfxId, param?: number, pan = 0, delay = 0): SfxVoice | null {
    const ctx = this.ctx;
    const ui = id === 'ui';
    const dest = ui ? this.bus : this.game;
    if (!ctx || !dest || !(ui ? this.live() : this.gameLive())) return null;
    const now = ctx.currentTime;
    const when = now + delay;
    const gap = MIN_GAP[id];
    const at = this.clock() + delay;
    const last = this.lastAt.get(id);
    if (gap > 0 && last !== undefined && at - last < gap && at >= last) return null;
    const slot = this.acquire(now, PRIORITY[id]);
    if (slot < 0) return null;
    const v = playSfx(ctx, dest, id, when, param, pan);
    this.lastAt.set(id, at);
    this.slots[slot] = v;
    this.slotPrio[slot] = PRIORITY[id];
    this.onSound?.(id, when, param);
    return v;
  }

  /** A free slot, or the slot of the quietest-priority voice lower than `prio` (which is cut), or -1. */
  private acquire(now: number, prio: number): number {
    let victim = -1;
    let victimPrio = prio;
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.slots[i];
      if (!v || v.end <= now) return i;
      const p = this.slotPrio[i] as number;
      if (p < victimPrio) {
        victim = i;
        victimPrio = p;
      }
    }
    if (victim >= 0) this.slots[victim]?.cancel(now);
    return victim;
  }

  private schedule(id: SfxId, delay: number): void {
    const v = this.trigger(id, undefined, 0, delay);
    if (!v) return;
    this.prune(this.pending);
    this.pending.push(v);
  }

  /**
   * The 5-step hold riser: one voice per step so a HoldReset can cut the steps that have not sounded yet.
   * Step k sounds when the hold has lasted k·0.1 s of sim time (planRiser); when the hold restarts within
   * RISER_RETRIGGER_S of the previous first note (flicker), that note is still ringing and is not struck again.
   */
  private startRiser(): void {
    this.cancelRiser(false);
    const ctx = this.ctx;
    if (!ctx || !this.game || !this.gameLive()) return;
    const c0 = this.clock();
    const first = c0 - this.riserFirstAt < RISER_RETRIGGER_S ? 1 : 0;
    if (first === 0) this.riserFirstAt = c0;
    this.riserOn = true;
    this.riserAwaitRun = false;
    this.riserFrom = first;
    this.riserSim = 0;
    this.riserAnchor = ctx.currentTime;
    this.riserScale = this.simScale();
    this.planRiser();
  }

  /** Sim seconds per second of context time right now: 0 while paused (the simulation is frozen). */
  private simScale(): number {
    return this.userSuspended || this.riserAwaitRun ? 0 : this.timeScale;
  }

  /**
   * Schedules every riser step that is not scheduled yet at the context time its sim time falls on, at the
   * current rate (nothing while the rate is 0). A step that is already due (it could not get a voice) is skipped
   * rather than played late.
   */
  private planRiser(): void {
    const ctx = this.ctx;
    const dest = this.game;
    if (!ctx || !dest || !this.riserOn || !(this.riserScale > 0)) return;
    const now = ctx.currentTime;
    for (let k = this.riserFrom; k < RISER_STEPS; k++) {
      if (this.riserSteps[k]) continue;
      const ahead = k * HOLD_STEP_S - this.riserSim;
      if (ahead < -1e-6) continue;
      const at = Math.max(now, this.riserAnchor + Math.max(0, ahead) / this.riserScale);
      const slot = this.acquire(now, PRIORITY.hold);
      if (slot < 0) break;
      const v = new Voice(ctx, dest, 0);
      holdStepInto(v, at, k);
      this.slots[slot] = v;
      this.slotPrio[slot] = PRIORITY.hold;
      this.riserSteps[k] = v;
      this.onSound?.('hold', at, k);
    }
  }

  /**
   * Follows a change of the sim rate (timeScale, pause) in the middle of a riser: the riser clock is re-anchored
   * now, steps that have not started are cut and planned again at the new rate. With `fadeSounding` (pause) the
   * step that is sounding fades too, so it does not come back half-rung when the gate reopens.
   */
  private retimeRiser(fadeSounding: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.riserOn) return;
    const scale = this.simScale();
    if (scale === this.riserScale && !fadeSounding) return;
    const now = ctx.currentTime;
    this.riserSim += Math.max(0, now - this.riserAnchor) * this.riserScale;
    this.riserAnchor = now;
    this.riserScale = scale;
    let left = false;
    for (let k = 0; k < RISER_STEPS; k++) {
      const v = this.riserSteps[k];
      if (!v) {
        if (k >= this.riserFrom) left = true;
        continue;
      }
      if (v.start > now) {
        v.cancel(now);
        this.riserSteps[k] = null;
        left = true;
      } else if (fadeSounding && v.end > now) {
        v.cancel(now);
      }
    }
    // Every step has sounded: the riser is over, later rate changes do not concern it.
    if (!left) this.riserOn = false;
    else this.planRiser();
  }

  /** Cuts the riser steps that have not started; with `fadeSounding` also fades the one that is sounding. */
  private cancelRiser(fadeSounding: boolean): void {
    this.riserOn = false;
    this.riserAwaitRun = false;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    for (let k = 0; k < RISER_STEPS; k++) {
      const v = this.riserSteps[k];
      this.riserSteps[k] = null;
      if (!v || !ctx || v.end <= now) continue;
      if (fadeSounding || v.start > now) v.cancel(now);
    }
  }

  private resetRun(): void {
    this.cancelRiser(true);
    this.riserFirstAt = -Infinity;
    const ctx = this.ctx;
    if (ctx) {
      const now = ctx.currentTime;
      for (const v of this.pending) if (v.start > now) v.cancel(now);
    }
    this.pending.length = 0;
    this.chimeArmed = true;
    this.lastReq = null;
  }

  private silenceContinuous(tau?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.motor?.silence(t, tau);
    this.wind?.silence(t, tau);
  }

  private prune(list: SfxVoice[]): void {
    const now = this.ctx ? this.ctx.currentTime : 0;
    let j = 0;
    for (const v of list) if (v.end > now) list[j++] = v;
    list.length = j;
  }
}

/**
 * Creates the engine. Safe to call anywhere (no AudioContext is created until unlock(); without WebAudio
 * every method is a no-op). Core wiring: `bus.on(e => audio.fx(e))`, `audio.update(...)` once per frame,
 * settings -> setVolume(0..1) / setMuted, pause or hidden tab -> suspend() / resume().
 */
export function createAudioEngine(opts: AudioEngineOptions = {}): AudioEngineExt {
  return new Engine(opts);
}
