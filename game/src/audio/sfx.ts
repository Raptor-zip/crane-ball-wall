// Sound effect recipes (GAME_DESIGN.md §9.6). Owner: O6.
//
// Every effect is synthesised (no audio files, §9.1). A recipe schedules nodes on any BaseAudioContext at
// time `when` into `dest` and returns a handle (end time + cancel), so the engine can limit voices and cut
// pending sounds on retry. Levels are "pre-master": the engine applies volume, a trim and a soft limiter.
import {
  Voice, clamp, midiHz, mulberry32, noteEnv, percEnv, sharedKs,
  type MotorParams, type SfxVoice, type WindParams,
} from './synth';

/**
 * One-shot effects. The first twelve are the §9.6 / §9.5 sounds; then the smaller §9.5 cues (HoldReset "惜しい",
 * PB arpeggio, phase done, fast-pass wind accent) and the practice rewind (D3: a short "tape rewind" chirp).
 *
 * `param` per id:
 * - apex: swing amplitude in degrees (0..90 -> 15 pentatonic steps C4..C7)
 * - snap: impulse J in N·s (volume ∝ min(1, J/2))
 * - stop: cart speed |v| in m/s at the end stop
 * - crash: CrashKind (1 ball, 2 string, 3 beam, 4 floor, 5 egg)
 * - nearMiss: tier 0..4 (<40, <20, <10, <5, <2 mm); each tier starts one semitone higher
 * - hold: riser step 0..4 (C5 D5 E5 G5 A5); omitted = the whole 5-step riser, one step every 0.1 s
 * - success: medal 0..3 (silver adds C6, gold adds E6 on top of the C-E-G chord)
 * - split: delta in 1/120 s (<= 0 ahead -> 880 Hz, > 0 behind -> 440 Hz)
 */
export type SfxId =
  | 'apex' | 'chime' | 'snap' | 'stop' | 'crash' | 'nearMiss' | 'hold' | 'success' | 'fanfare' | 'split' | 'timeout' | 'ui'
  | 'holdReset' | 'pb' | 'phase' | 'whoosh' | 'rewind';

export const SFX_IDS: readonly SfxId[] = [
  'apex', 'chime', 'snap', 'stop', 'crash', 'nearMiss', 'hold', 'success', 'fanfare', 'split', 'timeout', 'ui',
  'holdReset', 'pb', 'phase', 'whoosh', 'rewind',
];

/**
 * Pre-master levels (peak gains of the layers). Balanced by A-weighted 50 ms loudness (and a 400 Hz high-passed
 * "phone speaker" variant), centred: the big moments (crash, success, crown, near miss, hard snap) sit 2..5 dB above
 * a mid-swing apex tick, the ticks above the motor / wind bed, UI and minor cues below the ticks.
 */
export const MIX = {
  apex: 0.3, chime: 0.2,
  snap: 0.42, snapClick: 0.2,
  stop: 0.55, stopPhone: 0.4, stopNoise: 0.3, stopPing: 0.05,
  crash: 0.3, crashPhone: 0.55, crashKnock: 0.22, crashNoise: 0.5, crumble: 0.26, clang: 0.07, crack: 0.14,
  near: 0.12, nearSh: 0.05,
  hold: 0.13, chord: 0.065,
  fanfare: 0.09,
  split: 0.12, timeout: 0.17, ui: 0.18,
  holdReset: 0.11, pb: 0.11, phase: 0.12, whoosh: 0.45,
  rewind: 0.3, rewindBlip: 0.07,
} as const;

/** Seconds between the Success event and the RESULTS card (SUCCESS_BEAT: 0.15 s freeze + 0.6 s stamp, §9.4). */
export const CELEBRATION_DELAY_S = 0.75;
/** The success chord lands with the "ピタッ!" stamp, two riser beats after the wood block. */
export const SUCCESS_CHORD_DELAY_S = 0.2;
/** Riser beat (§9.6: one step every 0.1 s). */
export const HOLD_STEP_S = 0.1;

// ---------------------------------------------------------------------------------------------
// Pitch helpers
// ---------------------------------------------------------------------------------------------

const PENTA = [0, 2, 4, 7, 9] as const; // C D E G A
/** C major pentatonic from C4 (MIDI 60): step 0 = C4, 5 = C5, 10 = C6, 15 = C7. */
export function pentaMidi(step: number): number {
  const s = clamp(Math.floor(step), 0, 15);
  return 60 + 12 * Math.floor(s / 5) + (PENTA[s % 5] as number);
}

/** §9.6: amplitude 0..90° over 15 pentatonic steps (6° each) from C4; 90° and above is C7. */
export function apexStep(ampDeg: number): number {
  if (!Number.isFinite(ampDeg)) return 0;
  return clamp(Math.floor(Math.abs(ampDeg) / 6), 0, 15);
}

/** §9.5 near-miss tiers: <40 ニアミス 0, <20 ギリギリ 1, <10 スレスレ 2, <5 紙一重 3, <2 神業 4; -1 = none. */
export function nearMissTier(gapMm: number): number {
  if (!(gapMm < 40)) return -1;
  if (gapMm < 2) return 4;
  if (gapMm < 5) return 3;
  if (gapMm < 10) return 2;
  if (gapMm < 20) return 1;
  return 0;
}

const HOLD_NOTES = [72, 74, 76, 79, 81] as const; // C5 D5 E5 G5 A5

// ---------------------------------------------------------------------------------------------
// Continuous sounds (§9.6 table rows "モーター" and "風切り")
// ---------------------------------------------------------------------------------------------

function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/** Motor (writes into `out`, no allocation per frame): frequency 60 + 40|v| Hz, low-pass 600 + 800|F|/Fmax Hz, gain 0.15|F|/Fmax, growl square 0.05 while saturated. */
export function motorParams(
  v: number, F: number, Fmax: number, saturated: boolean, running: boolean,
  out: MotorParams = { freq: 60, cutoff: 600, gain: 0, growl: 0 },
): MotorParams {
  const u = Fmax > 0 ? clamp(Math.abs(finite(F)) / Fmax, 0, 1) : 0;
  out.freq = clamp(60 + 40 * Math.abs(finite(v)), 20, 1000);
  out.cutoff = 600 + 800 * u;
  out.gain = running ? 0.15 * u : 0;
  out.growl = running && saturated ? 0.05 : 0;
  return out;
}

/** Wind (writes into `out`): band-pass centre 400 + 300·speed Hz, gain 0.08·max(0, speed − 1)² (≤ 0.3), panned by the ball's screen x. */
export function windParams(
  speed: number, panX: number, running: boolean,
  out: WindParams = { center: 400, gain: 0, pan: 0 },
): WindParams {
  const s = Math.max(0, finite(speed));
  const over = Math.max(0, s - 1);
  out.center = clamp(400 + 300 * s, 100, 8000);
  out.gain = running ? Math.min(0.3, 0.08 * over * over) : 0;
  out.pan = clamp(finite(panX), -1, 1) * 0.8;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

/** Wood block (拍子木): sine + 2.4× sine at 0.4, plus a 5 ms noise click; 40 ms decay. */
function woodBlock(v: Voice, t: number, midi: number, level: number): void {
  const f = midiHz(midi);
  const tilt = 1 - 0.3 * clamp((midi - 60) / 36, 0, 1); // the ear is more sensitive up high
  const peak = MIX.apex * tilt * level;
  const g1 = v.gain();
  v.osc('sine', f, g1, t, percEnv(g1.gain, t, peak, 0.0008, 0.018));
  const g2 = v.gain();
  v.osc('sine', f * 2.4, g2, t, percEnv(g2.gain, t, peak * 0.4, 0.0005, 0.009));
  const bp = v.filter('bandpass', 2600, 0.8, v.out); // a woody knock, not a hiss
  const gc = v.gain(bp);
  v.buffer(gc, t, percEnv(gc.gain, t, peak * 0.5, 0.0002, 0.0011));
}

function apex(v: Voice, t: number, ampDeg: number): void {
  woodBlock(v, t, pentaMidi(apexStep(ampDeg)), 1);
}

/** Key-tone chime: C6 triangle, 0.4 s decay (with a faint C7 sine for a bell-like attack). */
function chime(v: Voice, t: number): void {
  const f = midiHz(84);
  const g = v.gain();
  v.osc('triangle', f, g, t, percEnv(g.gain, t, MIX.chime, 0.003, 0.11));
  const g2 = v.gain();
  v.osc('sine', f * 2, g2, t, percEnv(g2.gain, t, MIX.chime * 0.25, 0.002, 0.04));
}

/** String snap: 2 ms click + Karplus-Strong (1/220 s, 0.996, 80 ms). Volume ∝ min(1, J/2); brighter for big J. */
function snap(v: Voice, t: number, J: number): void {
  const vol = clamp(finite(J) / 2, 0, 1);
  if (vol <= 0) return;
  const bp = v.filter('bandpass', 3200, 0.7, v.out);
  const gc = v.gain(bp);
  v.buffer(gc, t, percEnv(gc.gain, t, MIX.snapClick * vol, 0.0001, 0.0005));
  const variant = J < 0.4 ? 0 : J < 1.2 ? 1 : 2;
  const buf = sharedKs(v.ctx, variant);
  const lp = v.filter('lowpass', 4500 + 1500 * variant, 0.7, v.out);
  const gk = v.gain(lp, MIX.snap * vol);
  v.buffer(gk, t, t + buf.duration, buf, 0);
}

/**
 * A low sine thud `f0 → f1` Hz whose envelope (peak `drive`, 0..1) feeds both the clean sub layer (`sub` level)
 * and a saturated copy low-passed at `lpHz` (`phone` level): the harmonics make the thud audible on phone
 * speakers, which reproduce nothing below ~300 Hz. Softer hits drive the shaper less, so they stay cleaner.
 */
function thud(v: Voice, t: number, f0: number, f1: number, glideS: number, drive: number, sub: number, phone: number, lpHz: number,
  env: (p: AudioParam, peak: number) => number): void {
  const gSub = v.gain(v.out, sub);
  const e = v.gain(gSub);
  const lp = v.filter('lowpass', lpHz, 0.7, v.out);
  const gPhone = v.gain(lp, phone);
  e.connect(v.drive(gPhone));
  const o = v.osc('sine', f0, e, t, env(e.gain, drive));
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + glideS);
}

/**
 * End-stop hit: 90 Hz sine (120 ms decay; a short 130 → 90 Hz drop for punch) + 1 kHz low-passed noise 30 ms.
 * Loudness follows the impact speed: a slow bump of a resting cart (≈0.05..0.3 m/s, it repeats with every swing)
 * is a soft knock, a slam (≥ 2 m/s) is full level with a steel "ガンッ" ring from 1 m/s.
 */
function stop(v: Voice, t: number, speed: number): void {
  const s = Math.max(0, finite(speed));
  const k = clamp(0.12 + 0.44 * s, 0.12, 1);
  thud(v, t, 130, 90, 0.03, k, MIX.stop, MIX.stopPhone * Math.sqrt(k), 1300, (p, peak) => percEnv(p, t, peak, 0.002, 0.03));
  const lp = v.filter('lowpass', 1000, 0.7, v.out);
  const gn = v.gain(lp);
  v.buffer(gn, t, percEnv(gn.gain, t, MIX.stopNoise * k, 0.001, 0.007));
  if (s >= 1) {
    // "ガンッ": a faint inharmonic ring of the steel bumper for the hard hits.
    const gp = v.gain();
    v.osc('sine', 1180, gp, t, percEnv(gp.gain, t, MIX.stopPing * k, 0.001, 0.035));
    const gq = v.gain();
    v.osc('sine', 1733, gq, t, percEnv(gq.gain, t, MIX.stopPing * 0.6 * k, 0.001, 0.02));
  }
}

let crashSeed = 7;

/**
 * Crash: sine 70 → 40 Hz (200 ms), 400 Hz low-passed noise 150 ms, and 8 high-passed clicks scattered over
 * 0.5 s (bricks crumbling) when a wall was hit. A driven copy of the sine and a short 160 → 70 Hz knock make the
 * "ゴンッ" audible on phone speakers. Beam hits ring like steel instead of crumbling; a broken egg cracks.
 */
function crash(v: Voice, t: number, kind: number): void {
  thud(v, t, 70, 40, 0.2, 1, MIX.crash, MIX.crashPhone, 1000, (p, peak) => noteEnv(p, t, peak, 0.003, 0.05, 0.06));
  const gk = v.gain();
  const ok = v.osc('triangle', 160, gk, t, percEnv(gk.gain, t, MIX.crashKnock, 0.002, 0.025));
  ok.frequency.setValueAtTime(160, t);
  ok.frequency.exponentialRampToValueAtTime(70, t + 0.06);
  const lp = v.filter('lowpass', 400, 0.8, v.out);
  const gn = v.gain(lp);
  v.buffer(gn, t, noteEnv(gn.gain, t, MIX.crashNoise, 0.002, 0.04, 0.035));

  const rnd = mulberry32(crashSeed++);
  if (kind === 3) {
    // Beam: steel bar modes (1 : 2.76 : 5.40).
    const base = 420;
    const modes = [[1, 1, 0.14], [2.76, 0.6, 0.08], [5.4, 0.35, 0.045]] as const;
    for (const [ratio, amp, tau] of modes) {
      const gm = v.gain();
      v.osc('sine', base * ratio, gm, t + 0.002, percEnv(gm.gain, t + 0.002, MIX.clang * amp, 0.001, tau));
    }
    return;
  }
  if (kind === 5) {
    // Egg: a dry crackle in the first 90 ms.
    const soft = v.filter('lowpass', 9000, 0.7, v.out);
    for (let i = 0; i < 10; i++) {
      const tk = t + 0.004 + 0.085 * Math.pow(i / 10, 1.2) + rnd() * 0.006;
      const hp = v.filter('highpass', 3500 + rnd() * 2500, 0.8, soft);
      const gc = v.gain(hp);
      v.buffer(gc, tk, percEnv(gc.gain, tk, MIX.crack * (0.5 + 0.5 * rnd()), 0.0002, 0.0008));
    }
    return;
  }
  if (kind === 4) return; // Floor: no bricks involved.
  // Bricks: high-passed clicks, softened above 6 kHz so they clack rather than hiss.
  const soft = v.filter('lowpass', 6000, 0.7, v.out);
  for (let i = 0; i < 8; i++) {
    const tk = t + 0.035 + 0.45 * Math.pow((i + rnd() * 0.6) / 8, 1.35);
    const amp = MIX.crumble * (1 - 0.08 * i) * (0.6 + 0.4 * rnd());
    const hp = v.filter('highpass', 1200 + rnd() * 2000, 0.9, soft);
    const gc = v.gain(hp);
    v.buffer(gc, tk, percEnv(gc.gain, tk, amp, 0.0003, 0.0022 + rnd() * 0.0016));
  }
}

/** Near miss "シャン": a breathy "sh" and a sine glide 2.4 → 3.2 kHz in 120 ms, one semitone higher per tier. */
function nearMiss(v: Voice, t: number, tier: number): void {
  const tr = clamp(Math.round(finite(tier)), 0, 4);
  const r = Math.pow(2, tr / 12);
  const hp = v.filter('highpass', 5500, 0.7, v.out);
  const gs = v.gain(hp);
  v.buffer(gs, t, percEnv(gs.gain, t, MIX.nearSh, 0.001, 0.012));
  const glideAt = (t0: number, f0: number, f1: number, peak: number, hold: number): void => {
    const g = v.gain();
    const o = v.osc('sine', f0, g, t0, noteEnv(g.gain, t0, peak, 0.004, hold, 0.05));
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + 0.12);
  };
  glideAt(t, 2400 * r, 3200 * r, MIX.near, 0.07);
  if (tr >= 2) glideAt(t, 3600 * r, 4800 * r, MIX.near * 0.28, 0.05);
  if (tr >= 3) glideAt(t + 0.09, 2400 * r * 1.26, 3200 * r * 1.26, MIX.near * 0.5, 0.05);
  if (tr >= 4) glideAt(t + 0.18, 2400 * r * 1.5, 3200 * r * 1.5, MIX.near * 0.38, 0.06);
}

/** One step of the hold riser: sine C5 D5 E5 G5 A5 (with a faint octave so it carries on small speakers). */
export function holdStepInto(v: Voice, t: number, step: number): void {
  const k = clamp(Math.floor(step), 0, 4);
  const f = midiHz(HOLD_NOTES[k] as number);
  const peak = MIX.hold * (0.85 + 0.075 * k);
  const g = v.gain();
  v.osc('sine', f, g, t, noteEnv(g.gain, t, peak, 0.006, 0.035, 0.045));
  const g2 = v.gain();
  v.osc('sine', f * 2, g2, t, percEnv(g2.gain, t, peak * 0.18, 0.004, 0.03));
}

/** Major chord C5-E5-G5 in triangles (two slightly detuned per note), 0.6 s (then a short release). */
function chord(v: Voice, t: number, notes: readonly number[], level: number): void {
  for (let i = 0; i < notes.length; i++) {
    const f = midiHz(notes[i] as number);
    const lvl = MIX.chord * level * (i < 3 ? 1 : 0.6);
    for (const det of [-4, 4]) {
      const g = v.gain();
      v.osc('triangle', f, g, t, noteEnv(g.gain, t, lvl, 0.01, 0.22, 0.12), det);
    }
  }
}

/** Success: wood block now, then the C major chord with the stamp (silver adds C6, gold adds E6). */
function success(v: Voice, t: number, medal: number): void {
  woodBlock(v, t, 84, 1.1);
  const notes: number[] = [72, 76, 79];
  if (medal >= 2) notes.push(84);
  if (medal >= 3) notes.push(88);
  chord(v, t + SUCCESS_CHORD_DELAY_S, notes, 1);
}

/** Crown fanfare: three detuned (±7 cent) saws, G4-C5-E5-G5 at 0.12 s, low-pass 2.5 kHz; the last note holds over a C-E chord. */
function fanfare(v: Voice, t: number): void {
  const notes = [67, 72, 76, 79];
  const dt = 0.12;
  const holdLast = 0.45;
  const lp = v.filter('lowpass', 2500, 0.8, v.out);
  const amp = v.gain(lp);
  const tl = t + dt * (notes.length - 1);
  const end = tl + holdLast + 0.08 * 7;
  const peak = MIX.fanfare;
  const oscs = [-7, 0, 7].map((det) => v.osc('sawtooth', midiHz(notes[0] as number), amp, t, end, det));
  amp.gain.setValueAtTime(0, t);
  for (let i = 0; i < notes.length; i++) {
    const tn = t + i * dt;
    const f = midiHz(notes[i] as number);
    for (const o of oscs) o.frequency.setValueAtTime(f, tn);
    // Brass-like swell of the filter on every note.
    lp.frequency.setValueAtTime(1100, tn);
    lp.frequency.setTargetAtTime(2500, tn, 0.03);
    amp.gain.linearRampToValueAtTime(peak, tn + 0.012);
    if (i < notes.length - 1) {
      amp.gain.linearRampToValueAtTime(peak * 0.8, tn + dt - 0.015);
      amp.gain.linearRampToValueAtTime(peak * 0.45, tn + dt);
    }
  }
  amp.gain.linearRampToValueAtTime(peak * 0.85, tl + holdLast);
  amp.gain.setTargetAtTime(0, tl + holdLast, 0.08);
  // Harmony under the held G5.
  const gh = v.gain(lp);
  noteEnv(gh.gain, tl, peak * 0.5, 0.02, holdLast - 0.02, 0.08);
  for (const m of [72, 76]) for (const det of [-7, 7]) v.osc('sawtooth', midiHz(m), gh, tl, end, det);
}

/** Split: a short 880 Hz tone when ahead, 440 Hz when behind. */
function split(v: Voice, t: number, deltaSub: number): void {
  const f = finite(deltaSub) <= 0 ? 880 : 440;
  const g = v.gain();
  v.osc('sine', f, g, t, noteEnv(g.gain, t, MIX.split, 0.004, 0.05, 0.03));
  const g2 = v.gain();
  v.osc('triangle', f, g2, t, noteEnv(g2.gain, t, MIX.split * 0.35, 0.004, 0.05, 0.03));
}

/** Timeout: a low two-pulse buzzer ("ブッブー"), two beating squares through a 750 Hz low-pass. */
function timeout(v: Voice, t: number): void {
  const lp = v.filter('lowpass', 750, 1.2, v.out);
  const amp = v.gain(lp);
  const pulses = [[0, 0.13], [0.19, 0.55]] as const;
  const end = t + 0.56;
  const a = v.osc('square', 110, amp, t, end);
  const b = v.osc('square', 116.5, amp, t, end);
  a.frequency.setValueAtTime(98, t + 0.16);
  b.frequency.setValueAtTime(103.8, t + 0.16);
  amp.gain.setValueAtTime(0, t);
  for (const [p0, p1] of pulses) {
    amp.gain.setValueAtTime(0, t + p0);
    amp.gain.linearRampToValueAtTime(MIX.timeout, t + p0 + 0.008);
    amp.gain.linearRampToValueAtTime(MIX.timeout * 0.85, t + p1 - 0.025);
    amp.gain.linearRampToValueAtTime(0, t + p1);
  }
}

/** UI: a 30 ms 1.2 kHz sine click. */
function ui(v: Voice, t: number): void {
  const g = v.gain();
  v.osc('sine', 1200, g, t, percEnv(g.gain, t, MIX.ui, 0.001, 0.0045));
}

/** HoldReset (≥ 30 % filled): a short falling tone, A5 → D5. */
function holdReset(v: Voice, t: number): void {
  const g = v.gain();
  const o = v.osc('triangle', 880, g, t, noteEnv(g.gain, t, MIX.holdReset, 0.005, 0.06, 0.05));
  o.frequency.setValueAtTime(880, t);
  o.frequency.exponentialRampToValueAtTime(587, t + 0.16);
}

/** PB: a short rising arpeggio C6 E6 G6 C7. */
function pb(v: Voice, t: number): void {
  const notes = [84, 88, 91, 96];
  for (let i = 0; i < notes.length; i++) {
    const tn = t + i * 0.06;
    const last = i === notes.length - 1;
    const g = v.gain();
    v.osc('triangle', midiHz(notes[i] as number), g, tn, percEnv(g.gain, tn, MIX.pb * (last ? 0.8 : 1), 0.003, last ? 0.14 : 0.06));
  }
}

/** Phase done (two-zone levels): G5 → C6 "ding-ding". */
function phase(v: Voice, t: number): void {
  const g1 = v.gain();
  v.osc('triangle', midiHz(79), g1, t, percEnv(g1.gain, t, MIX.phase, 0.004, 0.08));
  const g2 = v.gain();
  v.osc('triangle', midiHz(84), g2, t + 0.09, percEnv(g2.gain, t + 0.09, MIX.phase, 0.004, 0.15));
}

/** Fast pass over a wall: a band-passed noise swoosh sweeping 500 → 2600 Hz. */
function whoosh(v: Voice, t: number): void {
  const bp = v.filter('bandpass', 500, 1.6, v.out);
  bp.frequency.setValueAtTime(500, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.22);
  const g = v.gain(bp);
  v.buffer(g, t, noteEnv(g.gain, t, MIX.whoosh, 0.07, 0.03, 0.06));
}

/** Practice rewind (D3): the whoosh played backwards (2600 -> 600 Hz) under a quick falling E6 -> C6 blip. */
function rewind(v: Voice, t: number): void {
  const bp = v.filter('bandpass', 2600, 1.8, v.out);
  bp.frequency.setValueAtTime(2600, t);
  bp.frequency.exponentialRampToValueAtTime(600, t + 0.16);
  const g = v.gain(bp);
  v.buffer(g, t, noteEnv(g.gain, t, MIX.rewind, 0.02, 0.08, 0.06));
  const notes = [88, 84];
  for (let i = 0; i < notes.length; i++) {
    const tn = t + i * 0.05;
    const gb = v.gain();
    v.osc('triangle', midiHz(notes[i] as number), gb, tn, percEnv(gb.gain, tn, MIX.rewindBlip, 0.003, 0.05));
  }
}

/**
 * Schedules one effect on ctx at time `when` into `dest` (optionally panned, -1..1) and returns its handle.
 * Never throws for odd params (NaN / out of range are clamped).
 */
export function playSfx(ctx: BaseAudioContext, dest: AudioNode, id: SfxId, when: number, param?: number, pan = 0): SfxVoice {
  const v = new Voice(ctx, dest, pan);
  const t = Math.max(0, when);
  switch (id) {
    case 'apex': apex(v, t, param ?? 30); break;
    case 'chime': chime(v, t); break;
    case 'snap': snap(v, t, param ?? 1); break;
    case 'stop': stop(v, t, param ?? 1.5); break;
    case 'crash': crash(v, t, param ?? 1); break;
    case 'nearMiss': nearMiss(v, t, param ?? 0); break;
    case 'hold':
      if (param === undefined) for (let k = 0; k < 5; k++) holdStepInto(v, t + k * HOLD_STEP_S, k);
      else holdStepInto(v, t, param);
      break;
    case 'success': success(v, t, param ?? 1); break;
    case 'fanfare': fanfare(v, t); break;
    case 'split': split(v, t, param ?? -1); break;
    case 'timeout': timeout(v, t); break;
    case 'ui': ui(v, t); break;
    case 'holdReset': holdReset(v, t); break;
    case 'pb': pb(v, t); break;
    case 'phase': phase(v, t); break;
    case 'whoosh': whoosh(v, t); break;
    case 'rewind': rewind(v, t); break;
  }
  v.release(); // no-op unless the recipe scheduled nothing
  return v;
}
