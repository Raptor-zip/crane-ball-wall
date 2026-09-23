// Synthesis building blocks: oscillators, noise, Karplus-Strong, envelopes (GAME_DESIGN.md §9.6). Owner: O6.
//
// Everything here works on a BaseAudioContext, so the same code renders in a live AudioContext and in an
// OfflineAudioContext (tests/browser/audio.browser.test.ts). Buffers that every effect needs (white noise,
// Karplus-Strong plucks, the limiter curve) are computed once per context and cached; one-shot voices only
// create the few lightweight nodes WebAudio requires (sources cannot be restarted) and disconnect themselves
// when their last source ends.

/** Deterministic PRNG (mulberry32). Audio does not need Math.random, and a seed keeps renders reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** MIDI note number to Hz (A4 = 69 = 440 Hz). */
export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Cents offset as a frequency ratio. */
export function cents(c: number): number {
  return Math.pow(2, c / 1200);
}

// ---------------------------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------------------------

/** A fresh mono white-noise buffer (uniform in [-1, 1], zero mean), deterministic for a given seed. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 0x5eed): AudioBuffer {
  const n = Math.max(1, Math.round(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(seed);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const v = rnd() * 2 - 1;
    d[i] = v;
    mean += v;
  }
  mean /= n;
  for (let i = 0; i < n; i++) d[i] = (d[i] as number) - mean;
  return buf;
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
/** Length of the shared noise buffer; one-shots read short random slices of it. */
export const SHARED_NOISE_S = 2;

/** The per-context shared 2 s noise buffer (created on first use, then reused by every voice). */
export function sharedNoise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = createNoiseBuffer(ctx, SHARED_NOISE_S);
    noiseCache.set(ctx, b);
  }
  return b;
}

export interface KsOptions {
  /** Fundamental in Hz; the delay line is sampleRate / freq samples (§9.6: 1/220 s). */
  freq: number;
  /** Loss per period of the averaging loop (§9.6: 0.996). */
  decay: number;
  /** Total length in seconds (§9.6: 80 ms). The tail is faded to exactly 0. */
  seconds: number;
  /** 0 = soft (strongly low-passed excitation) .. 1 = bright (lightly low-passed). */
  brightness: number;
  seed: number;
}

/**
 * Karplus-Strong plucked string rendered into a buffer. The excitation is DC-free, optionally low-passed noise;
 * the loop is the classic two-point average scaled by `decay`. An exponential envelope plus a raised-cosine fade
 * over the last 15 ms makes the 80 ms clip end at exactly zero (no click when the source stops).
 */
export function karplusStrong(ctx: BaseAudioContext, o: KsOptions): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(2, Math.round(o.seconds * sr));
  const period = Math.max(2, Math.round(sr / o.freq));
  const buf = ctx.createBuffer(1, n, sr);
  const out = buf.getChannelData(0);
  const rnd = mulberry32(o.seed);
  // Excitation: one period of noise, one-pole low-passed for the soft variants, DC removed, peak-normalised.
  const exc = new Float32Array(period);
  const a = 0.9 - 0.5 * clamp(o.brightness, 0, 1);
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < period; i++) {
    const w = rnd() * 2 - 1;
    lp = a * lp + (1 - a) * w;
    exc[i] = lp;
    mean += lp;
  }
  mean /= period;
  let peak = 1e-9;
  for (let i = 0; i < period; i++) {
    exc[i] = (exc[i] as number) - mean;
    peak = Math.max(peak, Math.abs(exc[i] as number));
  }
  for (let i = 0; i < period; i++) exc[i] = (exc[i] as number) / peak;
  // Loop: y[i] = decay * (y[i-P] + y[i-P-1]) / 2, seeded with the excitation.
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (i < period) y[i] = exc[i] as number;
    else y[i] = o.decay * 0.5 * ((y[i - period] as number) + (i - period - 1 >= 0 ? (y[i - period - 1] as number) : 0));
  }
  // Envelope: fast exponential body + raised-cosine fade to 0 over the last 15 ms; 0.3 ms fade-in.
  const fade = Math.min(n, Math.round(0.015 * sr));
  const fin = Math.max(1, Math.round(0.0003 * sr));
  const tau = o.seconds * 0.45;
  for (let i = 0; i < n; i++) {
    let g = Math.exp(-i / sr / tau);
    if (i < fin) g *= i / fin;
    const k = n - 1 - i;
    if (k < fade) g *= 0.5 - 0.5 * Math.cos((Math.PI * k) / fade);
    out[i] = (y[i] as number) * g;
  }
  return buf;
}

const ksCache = new WeakMap<BaseAudioContext, AudioBuffer[]>();
/** Number of cached string variants (soft, medium, bright). */
export const KS_VARIANTS = 3;

/** Cached Karplus-Strong plucks for the Snap sound (§9.6: delay 1/220 s, decay 0.996, 80 ms). */
export function sharedKs(ctx: BaseAudioContext, variant: number): AudioBuffer {
  let arr = ksCache.get(ctx);
  if (!arr) {
    arr = [];
    for (let v = 0; v < KS_VARIANTS; v++) {
      // Brightness 0 .. 0.6: the raw-noise excitation (1.0) is harsh on phone speakers.
      arr.push(karplusStrong(ctx, { freq: 220, decay: 0.996, seconds: 0.08, brightness: (0.6 * v) / (KS_VARIANTS - 1), seed: 101 + v }));
    }
    ksCache.set(ctx, arr);
  }
  return arr[clamp(Math.floor(variant), 0, KS_VARIANTS - 1)] as AudioBuffer;
}

const driveCache = new WeakMap<BaseAudioContext, Float32Array<ArrayBuffer>>();

/**
 * Saturation curve for the "phone speaker" layer of low thuds (crash, end stop): tanh(12·x)/tanh(12), odd and
 * therefore DC-free (a biased curve turned the envelope into a sub-10 Hz pulse). A 40..130 Hz sine is inaudible on
 * phone speakers; driven through this curve it becomes nearly square, and its odd harmonics (3..11×, 200..800 Hz)
 * are heard as the same low pitch (missing fundamental). Cached per context (WaveShaperNode copies the curve).
 */
export function driveCurve(ctx: BaseAudioContext): Float32Array<ArrayBuffer> {
  const points = 1025;
  let c = driveCache.get(ctx);
  if (!c) {
    c = new Float32Array(points);
    const k = 12;
    const norm = Math.tanh(k);
    for (let i = 0; i < points; i++) {
      const x = (i / (points - 1)) * 2 - 1;
      c[i] = Math.tanh(k * x) / norm;
    }
    c[(points - 1) / 2] = 0;
    driveCache.set(ctx, c);
  }
  return c;
}

/**
 * Soft limiter transfer curve for a WaveShaperNode that is fed x/2 (so it covers x in [-2, 2]):
 * exactly linear for |x| <= 0.6, then a tanh knee that approaches 0.98. The output can never exceed 0.98,
 * and the slope is continuous, so the knee adds no click. Odd length so that f(0) is sampled exactly.
 */
export function limiterCurve(points = 2049): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  const knee = 0.6;
  const room = 0.98 - knee;
  for (let i = 0; i < points; i++) {
    const x = ((i / (points - 1)) * 2 - 1) * 2;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

/** Multiples of the time constant after which an exponential decay is below -60 dB. */
export const TAU_TO_SILENCE = 7;

/**
 * Percussive envelope on `p`: 0 at `when`, linear rise to `peak` in `attack`, then exponential decay with time
 * constant `tau`. Returns the time at which it has decayed below -60 dB (a safe, click-free stop time).
 */
export function percEnv(p: AudioParam, when: number, peak: number, attack: number, tau: number): number {
  p.setValueAtTime(0, when);
  p.linearRampToValueAtTime(peak, when + attack);
  p.setTargetAtTime(0, when + attack, tau);
  return when + attack + tau * TAU_TO_SILENCE;
}

/**
 * Note envelope: 0 at `when`, linear rise to `peak` in `attack`, hold (with a gentle 15% sag) for `hold`,
 * then exponential release with time constant `tau`. Returns the -60 dB stop time.
 */
export function noteEnv(p: AudioParam, when: number, peak: number, attack: number, hold: number, tau: number): number {
  p.setValueAtTime(0, when);
  p.linearRampToValueAtTime(peak, when + attack);
  p.linearRampToValueAtTime(peak * 0.85, when + attack + hold);
  p.setTargetAtTime(0, when + attack + hold, tau);
  return when + attack + hold + tau * TAU_TO_SILENCE;
}

// ---------------------------------------------------------------------------------------------
// One-shot voices
// ---------------------------------------------------------------------------------------------

/** Handle of a scheduled one-shot sound. */
export interface SfxVoice {
  /** Context time at which the last source stops. */
  readonly start: number;
  readonly end: number;
  /**
   * Fades the voice out from `at` (15 ms) and stops every source no later than `at + 0.1`; a voice that has not
   * started yet is silenced at once and never starts. Safe to call twice.
   */
  cancel(at: number): void;
}

/** Level of a mono source panned to the centre by a StereoPannerNode (equal-power law): cos(π/4) per channel. */
export const CENTER_PAN_GAIN = Math.SQRT1_2;

/**
 * Collects the nodes of one one-shot sound. Every source goes through `out` (a unity gain used only for
 * cancellation) and a stereo panner. The panner is used even at pan 0, so a sound has the same loudness whether
 * it is centred or panned by 0.01 (a plain mono node would be up-mixed 3 dB louder than a centred panner).
 * When the last source ends the voice disconnects itself.
 */
export class Voice implements SfxVoice {
  readonly out: GainNode;
  private readonly tail: AudioNode;
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private readonly stops: number[] = [];
  private live = 0;
  private cancelled = false;
  start = Infinity;
  end = 0;

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode, pan = 0) {
    this.out = ctx.createGain();
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(Number.isFinite(pan) ? pan : 0, -1, 1);
      this.out.connect(p);
      p.connect(dest);
      this.tail = p;
    } else {
      // No panner (very old engines): match the centred panner's level.
      const g = ctx.createGain();
      g.gain.value = CENTER_PAN_GAIN;
      this.out.connect(g);
      g.connect(dest);
      this.tail = g;
    }
  }

  /** Whether any source was scheduled (a recipe may decide to play nothing, e.g. a Snap with J = 0). */
  get empty(): boolean {
    return this.srcs.length === 0;
  }

  /** Releases a voice that scheduled no source (otherwise it would stay connected forever). */
  release(): void {
    if (this.srcs.length === 0) this.disconnect();
  }

  /** A WaveShaper with the shared drive curve (see driveCurve) into `dest`. */
  drive(dest: AudioNode): WaveShaperNode {
    const w = this.ctx.createWaveShaper();
    w.curve = driveCurve(this.ctx);
    w.oversample = '2x';
    w.connect(dest);
    return w;
  }

  /** A gain node (initial value 0) connected to `dest` (default: the voice output). */
  gain(dest: AudioNode = this.out, initial = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = initial;
    g.connect(dest);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    return f;
  }

  osc(type: OscillatorType, freq: number, dest: AudioNode, when: number, stop: number, detuneCents = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detuneCents !== 0) o.detune.value = detuneCents;
    o.connect(dest);
    this.track(o, when, stop);
    return o;
  }

  /** Plays a slice of `buf` (default: the shared noise) from a pseudo-random offset. */
  buffer(dest: AudioNode, when: number, stop: number, buf: AudioBuffer | null = null, offset = -1, rate = 1): AudioBufferSourceNode {
    const b = buf ?? sharedNoise(this.ctx);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    if (rate !== 1) s.playbackRate.value = rate;
    s.connect(dest);
    const dur = Math.max(0, stop - when);
    let off = offset;
    if (off < 0) off = buf ? 0 : noiseOffset(b.duration - dur);
    this.track(s, when, stop, off);
    return s;
  }

  private track(s: AudioScheduledSourceNode, when: number, stop: number, offset?: number): void {
    const t0 = Math.max(0, when);
    const t1 = Math.max(t0 + 0.001, stop);
    if (offset !== undefined) (s as AudioBufferSourceNode).start(t0, offset);
    else s.start(t0);
    s.stop(t1);
    this.srcs.push(s);
    this.stops.push(t1);
    this.live++;
    s.onended = () => {
      if (--this.live === 0) this.disconnect();
    };
    if (t0 < this.start) this.start = t0;
    if (t1 > this.end) this.end = t1;
  }

  cancel(at: number): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    let hard: number;
    if (at <= this.start) {
      // Nothing has sounded yet: silence at once and never start (a fade would let a source that is due within
      // the fade start at half level, e.g. the next hold step).
      g.setValueAtTime(0, at);
      hard = at;
    } else {
      g.setValueAtTime(1, at);
      g.setTargetAtTime(0, at, 0.015);
      hard = at + 0.1;
    }
    for (let i = 0; i < this.srcs.length; i++) {
      const s = this.srcs[i] as AudioScheduledSourceNode;
      const was = this.stops[i] as number;
      if (hard < was) {
        try {
          s.stop(hard);
          this.stops[i] = hard;
        } catch {
          // Already stopped: nothing to do.
        }
      }
    }
    if (hard < this.end) this.end = hard;
  }

  private disconnect(): void {
    try {
      this.out.disconnect();
      this.tail.disconnect();
    } catch {
      // Ignore: the graph may already be closed.
    }
  }
}

const noiseRnd = mulberry32(0xabcdef);
/** Random read offset into the shared noise buffer, so consecutive bursts are not identical. */
function noiseOffset(maxStart: number): number {
  return maxStart > 0 ? noiseRnd() * maxStart : 0;
}

// ---------------------------------------------------------------------------------------------
// Continuous voices (created once per context, parameters glide with setTargetAtTime)
// ---------------------------------------------------------------------------------------------

/**
 * Sets `p` towards `v` with time constant `tau` unless the last target is already within `eps`
 * (keeps the automation timeline short; setTargetAtTime starts from the current value, so no zipper noise).
 */
export function glide(p: AudioParam, last: { v: number }, v: number, t: number, tau: number, eps: number): void {
  if (!Number.isFinite(v)) return;
  if (Math.abs(v - last.v) <= eps) return;
  last.v = v;
  p.setTargetAtTime(v, t, tau);
}

export interface MotorParams { freq: number; cutoff: number; gain: number; growl: number }

/**
 * Motor (§9.6): sawtooth -> low-pass -> gain. While saturated, a square wave at twice the frequency is mixed
 * into the same low-pass (the "growl"). Oscillators run continuously; silence is gain 0.
 */
export class MotorVoice {
  private readonly saw: OscillatorNode;
  private readonly sq: OscillatorNode;
  private readonly sqGain: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly amp: GainNode;
  private readonly last = { f: { v: 60 }, f2: { v: 120 }, c: { v: 600 }, g: { v: 0 }, s: { v: 0 } };

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode, when = ctx.currentTime) {
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = 60;
    this.sq = ctx.createOscillator();
    this.sq.type = 'square';
    this.sq.frequency.value = 120;
    this.sqGain = ctx.createGain();
    this.sqGain.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 600;
    this.lp.Q.value = 0.9;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.saw.connect(this.lp);
    this.sq.connect(this.sqGain);
    this.sqGain.connect(this.lp);
    this.lp.connect(this.amp);
    this.amp.connect(dest);
    this.saw.start(when);
    this.sq.start(when);
  }

  set(p: MotorParams, t: number): void {
    glide(this.saw.frequency, this.last.f, p.freq, t, 0.03, 0.05);
    glide(this.sq.frequency, this.last.f2, p.freq * 2, t, 0.03, 0.1);
    glide(this.lp.frequency, this.last.c, p.cutoff, t, 0.03, 2);
    glide(this.amp.gain, this.last.g, p.gain, t, 0.025, 0.0005);
    glide(this.sqGain.gain, this.last.s, p.growl, t, 0.02, 0.0005);
  }

  /** Fades to silence quickly (retry, crash; `tau` s, default 12 ms). */
  silence(t: number, tau = 0.012): void {
    glide(this.amp.gain, this.last.g, 0, t, tau, 0);
    glide(this.sqGain.gain, this.last.s, 0, t, tau, 0);
  }

  dispose(): void {
    try {
      this.saw.stop();
      this.sq.stop();
      this.amp.disconnect();
    } catch {
      // Already stopped.
    }
  }
}

export interface WindParams { center: number; gain: number; pan: number }

/**
 * Wind (§9.6): looping white noise -> band-pass (Q 1.2) -> gain -> stereo panner. A gentle low-pass at three
 * times the centre removes the >8 kHz hiss the second-order band-pass lets through (air, not static).
 */
export class WindVoice {
  private readonly src: AudioBufferSourceNode;
  private readonly bp: BiquadFilterNode;
  private readonly lp: BiquadFilterNode;
  private readonly amp: GainNode;
  private readonly panner: StereoPannerNode | null;
  private readonly last = { c: { v: 400 }, l: { v: 1500 }, g: { v: 0 }, p: { v: 0 } };

  constructor(readonly ctx: BaseAudioContext, dest: AudioNode, when = ctx.currentTime) {
    this.src = ctx.createBufferSource();
    this.src.buffer = sharedNoise(ctx);
    this.src.loop = true;
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 400;
    this.bp.Q.value = 1.2;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 1500;
    this.lp.Q.value = 0.5;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.src.connect(this.bp);
    this.bp.connect(this.lp);
    this.lp.connect(this.amp);
    if (typeof ctx.createStereoPanner === 'function') {
      this.panner = ctx.createStereoPanner();
      this.amp.connect(this.panner);
      this.panner.connect(dest);
    } else {
      this.panner = null;
      this.amp.connect(dest);
    }
    this.src.start(when, 0.37);
  }

  set(p: WindParams, t: number): void {
    glide(this.bp.frequency, this.last.c, p.center, t, 0.05, 3);
    glide(this.lp.frequency, this.last.l, clamp(p.center * 3, 1500, 9000), t, 0.05, 10);
    glide(this.amp.gain, this.last.g, p.gain, t, 0.06, 0.0005);
    if (this.panner) glide(this.panner.pan, this.last.p, clamp(p.pan, -1, 1), t, 0.05, 0.005);
  }

  /** Fades to silence (`tau` s, default 30 ms). */
  silence(t: number, tau = 0.03): void {
    glide(this.amp.gain, this.last.g, 0, t, tau, 0);
  }

  dispose(): void {
    try {
      this.src.stop();
      this.amp.disconnect();
    } catch {
      // Already stopped.
    }
  }
}
