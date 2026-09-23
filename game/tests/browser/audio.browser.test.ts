// Audio acceptance (GAME_DESIGN.md §11 M5, §10.7): every effect rendered into an OfflineAudioContext
// (chromium only, see vitest.config.ts) has no NaN, is not silent, and never exceeds 1.0. Owner: O6.
//
// Extra checks: effects start from silence and end in silence (no clicks, no stuck voices), the continuous
// motor / wind voices glide without jumps, the full engine (volume, limiter, voice cap, event mapping, pause
// gate, hold riser, which follows sim time) stays within [-1, 1] under a storm of events, real event streams from the simulator
// (golden replays) render cleanly, the engine wires itself to a real page (unlock on the first gesture, UI
// clicks, hidden tab), and the haptics mapping follows §9.5.
//
// VITE_AUDIO_DUMP=1 additionally writes every render as a WAV to test-results/audio-dump/ (for listening).
import { describe, expect, it, vi } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import type { GameEvent } from '../../src/core/bus';
import { MAX_VOICES, createAudioEngine, type AudioEngineExt, type AudioUpdate } from '../../src/audio/engine';
import { STOP_HAPTIC_MIN_SPEED, createHaptics, hapticPatternFor } from '../../src/audio/haptics';
import {
  SFX_IDS, apexStep, motorParams, nearMissTier, pentaMidi, playSfx, windParams, type SfxId,
} from '../../src/audio/sfx';
import { MotorVoice, WindVoice, driveCurve, limiterCurve, midiHz } from '../../src/audio/synth';
import golden from '../fixtures/golden_replays.json';
import { b64urlDecode } from '../../src/sim/b64';
import { BALL_R, HOLD_SUB } from '../../src/sim/constants';
import { levelFacts } from '../../src/sim/display';
import { Ev } from '../../src/sim/events';
import type { LevelPhysics } from '../../src/sim/level';
import { decodeReplay, simulateReplay } from '../../src/sim/replay';
import { Status, type CrashKind } from '../../src/sim/run';

const SR = 48000;
const DUMP = !!import.meta.env.VITE_AUDIO_DUMP;

function offline(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * SR), sampleRate: SR });
}

interface Stats { nan: number; peak: number; rms: number; head: number; tailPeak: number; maxWinJump: number }

/** Peak/RMS over both channels, the first sample, the peak of the last 20 ms, and the largest 5 ms RMS step. */
function stats(buf: AudioBuffer, tailS = 0.02): Stats {
  let nan = 0;
  let peak = 0;
  let sum = 0;
  let head = 0;
  let tailPeak = 0;
  const n = buf.length;
  const tail0 = n - Math.round(tailS * buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    head = Math.max(head, Math.abs(d[0] as number));
    for (let i = 0; i < n; i++) {
      const x = d[i] as number;
      if (!Number.isFinite(x)) {
        nan++;
        continue;
      }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      if (i >= tail0 && a > tailPeak) tailPeak = a;
      sum += x * x;
    }
  }
  // Envelope smoothness: RMS in 5 ms windows of channel 0; the largest step between neighbours.
  const w = Math.round(0.005 * buf.sampleRate);
  const d0 = buf.getChannelData(0);
  let prev = -1;
  let maxWinJump = 0;
  for (let s = 0; s + w <= n; s += w) {
    let e = 0;
    for (let i = s; i < s + w; i++) e += (d0[i] as number) ** 2;
    const r = Math.sqrt(e / w);
    if (prev >= 0) maxWinJump = Math.max(maxWinJump, Math.abs(r - prev));
    prev = r;
  }
  return { nan, peak, rms: Math.sqrt(sum / (n * buf.numberOfChannels)), head, tailPeak, maxWinJump };
}

function wavBase64(buf: AudioBuffer): string {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const bytes = new Uint8Array(44 + n * ch * 2);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, (chans[c] as Float32Array)[i] as number));
      dv.setInt16(o, Math.round(x * 32767), true);
      o += 2;
    }
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function dump(name: string, buf: AudioBuffer): Promise<void> {
  if (!DUMP) return;
  await commands.writeFile(`test-results/audio-dump/${name}.wav`, wavBase64(buf), 'base64');
}

/** Representative params per effect, including the extremes of each range. */
const CASES: [string, SfxId, number | undefined][] = [
  ['apex-5deg', 'apex', 5], ['apex-45deg', 'apex', 45], ['apex-90deg', 'apex', 90],
  ['chime', 'chime', undefined],
  ['snap-J0.05', 'snap', 0.05], ['snap-J0.6', 'snap', 0.6], ['snap-J3', 'snap', 3],
  ['stop-0.3', 'stop', 0.3], ['stop-2.5', 'stop', 2.5],
  ['crash-ball', 'crash', 1], ['crash-string', 'crash', 2], ['crash-beam', 'crash', 3], ['crash-floor', 'crash', 4], ['crash-egg', 'crash', 5],
  ['nearMiss-0', 'nearMiss', 0], ['nearMiss-2', 'nearMiss', 2], ['nearMiss-4', 'nearMiss', 4],
  ['hold-riser', 'hold', undefined], ['hold-step4', 'hold', 4],
  ['success-0', 'success', 0], ['success-3', 'success', 3],
  ['fanfare', 'fanfare', undefined],
  ['split-ahead', 'split', -12], ['split-behind', 'split', 12],
  ['timeout', 'timeout', undefined], ['ui', 'ui', undefined],
  ['holdReset', 'holdReset', undefined], ['pb', 'pb', undefined], ['phase', 'phase', undefined], ['whoosh', 'whoosh', undefined],
  ['rewind', 'rewind', undefined],
];

describe('sfx recipes (OfflineAudioContext, 1 s each)', () => {
  it('covers every SfxId', () => {
    for (const id of SFX_IDS) expect(CASES.some((c) => c[1] === id), id).toBe(true);
  });

  for (const [name, id, param] of CASES) {
    it(`${name}: no NaN, not silent, peak <= 1.0, starts and ends silent`, async () => {
      const ctx = offline(1);
      const v = playSfx(ctx, ctx.destination, id, 0, param, 0);
      const buf = await ctx.startRendering();
      await dump(`sfx-${name}`, buf);
      const s = stats(buf);
      expect(s.nan).toBe(0);
      expect(s.rms).toBeGreaterThan(1e-4);
      expect(s.peak).toBeGreaterThan(5e-3);
      expect(s.peak).toBeLessThanOrEqual(1.0);
      expect(s.head).toBeLessThan(0.01);
      // Every voice ends by itself: render past its end and require silence at the very end.
      expect(v.end).toBeGreaterThan(0);
      const long = offline(Math.max(1, v.end + 0.15));
      playSfx(long, long.destination, id, 0, param, 0);
      const t = stats(await long.startRendering());
      expect(t.tailPeak).toBeLessThan(1e-4);
    });
  }

  it('pans: a voice panned hard left is louder on the left', async () => {
    const ctx = offline(1);
    playSfx(ctx, ctx.destination, 'apex', 0, 40, -1);
    const buf = await ctx.startRendering();
    const e = (c: number): number => buf.getChannelData(c).reduce((a, x) => a + x * x, 0);
    expect(e(0)).toBeGreaterThan(e(1) * 10);
  });

  it('cancel() silences a scheduled voice before it starts and fades a sounding one', async () => {
    const ctx = offline(1);
    const later = playSfx(ctx, ctx.destination, 'fanfare', 0.5, undefined, 0);
    later.cancel(0.1);
    const now = playSfx(ctx, ctx.destination, 'chime', 0, undefined, 0);
    void ctx.suspend(128 * 40 / SR).then(() => {
      now.cancel(ctx.currentTime);
      void ctx.resume();
    });
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let after = 0;
    for (let i = Math.round(0.2 * SR); i < d.length; i++) after = Math.max(after, Math.abs(d[i] as number));
    expect(after).toBeLessThan(1e-4);
  });

  it('cancel() just before a voice is due: it never sounds (no half-faded blip)', async () => {
    const ctx = offline(0.5);
    const due = playSfx(ctx, ctx.destination, 'hold', 0.1 + 0.01, 0, 0); // 10 ms after the cancel
    due.cancel(0.1);
    // A reference voice elsewhere proves the render works.
    playSfx(ctx, ctx.destination, 'ui', 0.3, undefined, 0);
    const d = (await ctx.startRendering()).getChannelData(0);
    let early = 0;
    for (let i = 0; i < Math.round(0.28 * SR); i++) early = Math.max(early, Math.abs(d[i] as number));
    expect(early).toBe(0);
    expect(due.end).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('a source stopped before its start still fires onended (cancelled voices disconnect, no node leak)', async () => {
    const ctx = offline(0.6);
    const o = ctx.createOscillator();
    o.connect(ctx.destination);
    let ended = false;
    o.onended = () => {
      ended = true;
    };
    o.start(0.4);
    o.stop(0.1);
    await ctx.startRendering();
    await vi.waitFor(() => expect(ended).toBe(true), { timeout: 1000 });
  });

  it('pans the same at 0 as near 0 (every voice goes through the panner)', async () => {
    const energy = async (pan: number): Promise<number> => {
      const ctx = offline(0.3);
      playSfx(ctx, ctx.destination, 'split', 0, -1, pan);
      const b = await ctx.startRendering();
      return b.getChannelData(0).reduce((a, x) => a + x * x, 0) + b.getChannelData(1).reduce((a, x) => a + x * x, 0);
    };
    const e0 = await energy(0);
    const e1 = await energy(0.001);
    expect(Math.abs(10 * Math.log10(e0 / e1))).toBeLessThan(0.1);
  });
});

describe('pitch and mapping helpers', () => {
  it('apex: 0..90° over 15 pentatonic steps from C4 to C7', () => {
    expect(apexStep(0)).toBe(0);
    expect(apexStep(5.9)).toBe(0);
    expect(apexStep(6)).toBe(1);
    expect(apexStep(89.9)).toBe(14);
    expect(apexStep(90)).toBe(15);
    expect(apexStep(140)).toBe(15);
    expect(apexStep(Number.NaN)).toBe(0);
    const names = Array.from({ length: 16 }, (_, s) => pentaMidi(s));
    expect(names).toEqual([60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96]);
    expect(midiHz(60)).toBeCloseTo(261.626, 2);
    expect(midiHz(96)).toBeCloseTo(2093.0, 0);
  });

  it('apex ticks sound at their pentatonic pitch (Goertzel over the 16 candidate notes)', async () => {
    const goertzel = (d: Float32Array, f: number): number => {
      const k = (2 * Math.PI * f) / SR;
      const c = 2 * Math.cos(k);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < d.length; i++) {
        const s0 = (d[i] as number) + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    const cands = Array.from({ length: 16 }, (_, s) => midiHz(pentaMidi(s)));
    for (const amp of [4, 13, 20, 33, 45, 58, 70, 84, 90]) {
      const ctx = offline(0.2);
      playSfx(ctx, ctx.destination, 'apex', 0, amp, 0);
      const d = (await ctx.startRendering()).getChannelData(0);
      const e = cands.map((f) => goertzel(d, f));
      expect(e.indexOf(Math.max(...e)), `${amp}°`).toBe(apexStep(amp));
    }
  });

  it('near-miss tiers follow §9.5', () => {
    expect([45, 39.9, 19.9, 9.9, 4.9, 1.9, 0].map(nearMissTier)).toEqual([-1, 0, 1, 2, 3, 4, 4]);
    expect(nearMissTier(Number.NaN)).toBe(-1);
  });

  it('motor and wind parameters follow §9.6', () => {
    const m = motorParams(2, -10, 20, true, true);
    expect(m.freq).toBeCloseTo(140);
    expect(m.cutoff).toBeCloseTo(1000);
    expect(m.gain).toBeCloseTo(0.075);
    expect(m.growl).toBeCloseTo(0.05);
    expect(motorParams(2, 10, 20, true, false).gain).toBe(0);
    expect(motorParams(Number.NaN, Number.NaN, 20, false, true).gain).toBe(0);
    const w = windParams(3, 1, true);
    expect(w.center).toBeCloseTo(1300);
    expect(w.gain).toBeCloseTo(0.3); // 0.08·4 = 0.32 -> capped
    expect(windParams(2, 0, true).gain).toBeCloseTo(0.08);
    expect(windParams(0.9, 0, true).gain).toBe(0);
    expect(w.pan).toBeGreaterThan(0);
  });

  it('the drive curve is odd (no DC pulse), silent at 0 and bounded', () => {
    const c = driveCurve(offline(0.1));
    const n = c.length;
    expect(c[(n - 1) / 2]).toBe(0);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(c[i] as number)).toBeLessThanOrEqual(1);
      expect((c[i] as number) + (c[n - 1 - i] as number)).toBeCloseTo(0, 6);
    }
  });

  it('the limiter curve is linear below 0.6 and never exceeds 0.98', () => {
    const c = limiterCurve();
    const at = (x: number): number => c[Math.round(((x / 2 + 1) / 2) * (c.length - 1))] as number;
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBeCloseTo(0.5, 2);
    expect(at(-0.5)).toBeCloseTo(-0.5, 2);
    for (const y of c) expect(Math.abs(y)).toBeLessThanOrEqual(0.98);
  });
});

describe('continuous voices', () => {
  it('motor (saturated, full force) renders 1 s within range', async () => {
    const ctx = offline(1);
    const m = new MotorVoice(ctx, ctx.destination, 0);
    m.set(motorParams(3, 20, 20, true, true), 0);
    const buf = await ctx.startRendering();
    await dump('motor-saturated', buf);
    const s = stats(buf);
    expect(s.nan).toBe(0);
    expect(s.rms).toBeGreaterThan(1e-3);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    expect(s.head).toBeLessThan(0.01);
  });

  it('wind at 4 m/s panned right renders 1 s within range and louder on the right', async () => {
    const ctx = offline(1);
    const w = new WindVoice(ctx, ctx.destination, 0);
    w.set(windParams(4, 1, true), 0);
    const buf = await ctx.startRendering();
    await dump('wind-4ms-right', buf);
    const s = stats(buf);
    expect(s.nan).toBe(0);
    expect(s.rms).toBeGreaterThan(1e-3);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    const e = (c: number): number => buf.getChannelData(c).reduce((a, x) => a + x * x, 0);
    expect(e(1)).toBeGreaterThan(e(0) * 3);
  });

  it('per-frame parameter changes glide (no zipper steps, no clicks)', async () => {
    const ctx = offline(2);
    const m = new MotorVoice(ctx, ctx.destination, 0);
    const w = new WindVoice(ctx, ctx.destination, 0);
    const frames = 120;
    for (let f = 1; f < frames; f++) {
      const t = f / 60;
      // Bang-bang force with a jittery servo: the worst case for zipper noise.
      const F = (Math.floor(f / 20) % 2 ? -20 : 20) * (0.6 + 0.4 * Math.sin(f * 1.7));
      void ctx.suspend(Math.round((t * SR) / 128) * 128 / SR).then(() => {
        m.set(motorParams(4 * Math.sin(t * 3), F, 20, Math.abs(F) > 15, f < 100), ctx.currentTime);
        w.set(windParams(4.5 * Math.abs(Math.sin(t * 2)), Math.sin(t * 5), f < 100), ctx.currentTime);
        void ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    await dump('continuous-glide', buf);
    const s = stats(buf, 0.05);
    expect(s.nan).toBe(0);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    expect(s.rms).toBeGreaterThan(1e-3);
    expect(s.maxWinJump).toBeLessThan(0.05);
    expect(s.tailPeak).toBeLessThan(1e-3); // running=false after frame 100 -> faded out
  });
});

/** A scheduled one-shot: id, context time it sounds at, param, and the frame whose script scheduled it. */
interface Played { id: SfxId; at: number; param: number | undefined; frame: number }

/** Drives an engine on an OfflineAudioContext with per-frame callbacks (60 Hz) and timed events. */
async function renderEngine(
  seconds: number,
  script: (frame: number, t: number, engine: AudioEngineExt) => void,
  opts: { volume?: number; muted?: boolean } = {},
): Promise<{ buf: AudioBuffer; maxVoices: number; played: Played[] }> {
  const ctx = offline(seconds);
  const played: Played[] = [];
  let frame = -1;
  const engine = createAudioEngine({
    context: ctx, autoWire: false, volume: opts.volume ?? 1, muted: opts.muted ?? false,
    onSound: (id, at, param) => played.push({ id, at, param, frame }),
  });
  let maxVoices = 0;
  const frames = Math.floor(seconds * 60) - 1;
  for (let f = 0; f < frames; f++) {
    const at = Math.round(((f / 60) * SR) / 128) * 128 / SR;
    void ctx.suspend(at).then(() => {
      frame = f;
      script(f, ctx.currentTime, engine);
      maxVoices = Math.max(maxVoices, engine.activeVoices);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  engine.dispose();
  return { buf, maxVoices, played };
}

/** Peak |x| of channel 0 between t0 and t1 seconds. */
function peakIn(buf: AudioBuffer, t0: number, t1: number): number {
  const d = buf.getChannelData(0);
  let p = 0;
  for (let i = Math.round(t0 * buf.sampleRate); i < Math.min(d.length, Math.round(t1 * buf.sampleRate)); i++) p = Math.max(p, Math.abs(d[i] as number));
  return p;
}

/** Largest step between neighbouring RMS windows (`win` s, longer than the lowest period) of channel 0 in [t0, t1]. */
function maxJumpIn(buf: AudioBuffer, t0: number, t1: number, win = 0.02): number {
  const w = Math.round(win * buf.sampleRate);
  let prev = -1;
  let j = 0;
  for (let s = Math.round(t0 * buf.sampleRate); s + w <= Math.round(t1 * buf.sampleRate); s += w) {
    const r = rmsIn(buf, s / buf.sampleRate, (s + w) / buf.sampleRate);
    if (prev >= 0) j = Math.max(j, Math.abs(r - prev));
    prev = r;
  }
  return j;
}

/** RMS of channel 0 between t0 and t1 seconds. */
function rmsIn(buf: AudioBuffer, t0: number, t1: number): number {
  const d = buf.getChannelData(0);
  let e = 0;
  const i0 = Math.round(t0 * buf.sampleRate);
  const i1 = Math.round(t1 * buf.sampleRate);
  for (let i = i0; i < i1; i++) e += (d[i] as number) ** 2;
  return Math.sqrt(e / Math.max(1, i1 - i0));
}

describe('engine (OfflineAudioContext)', () => {
  it('a full run: motor, growl, wind, ticks, chime, near miss, snap, stop, hold, success + crown fanfare', async () => {
    const ev = (f: number, at: number, e: GameEvent, engine: ReturnType<typeof createAudioEngine>): void => {
      if (f === Math.round(at * 60)) engine.fx(e);
    };
    const { buf } = await renderEngine(5, (f, t, engine) => {
      const running = t < 3.0;
      const F = t < 0.5 ? 20 : t < 0.9 ? -20 : 6 * Math.sin(t * 6);
      const v = t < 0.5 ? t * 6 : Math.max(0, 3 - (t - 0.5) * 5);
      engine.update({ running, v, F, Fmax: 20, saturated: t < 0.6, ballSpeed: 3.5 * Math.abs(Math.sin(t * 3)), panX: Math.sin(t) });
      if (f === 0) engine.fx({ t: 'runStart' });
      ev(f, 0.1, { t: 'saturate', on: true }, engine);
      ev(f, 0.7, { t: 'apex', ampDeg: 22, reqDeg: 40, reached: false, x: 0.4, y: 0.6 }, engine);
      ev(f, 1.1, { t: 'cross', wall: 0, dir: 1, gapMm: 7, speed: 3.4, px: 1, py: 0.5 }, engine);
      ev(f, 1.3, { t: 'apex', ampDeg: 48, reqDeg: 40, reached: true, x: 1.2, y: 0.8 }, engine);
      ev(f, 1.5, { t: 'snap', J: 1.1, x: 1, y: 0.5 }, engine);
      ev(f, 1.7, { t: 'stop', side: 1, speed: 1.6 }, engine);
      ev(f, 1.8, { t: 'split', index: 0, deltaSub: -20, vs: 'ai' }, engine);
      ev(f, 2.0, { t: 'holdStart', phase: 0 }, engine);
      ev(f, 2.5, { t: 'success', score: 300, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] }, engine);
    });
    await dump('engine-run', buf);
    const s = stats(buf, 0.1);
    expect(s.nan).toBe(0);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    expect(s.rms).toBeGreaterThan(1e-3);
    expect(s.tailPeak).toBeLessThan(1e-3);
  });

  it('pumping swing: rising then falling pentatonic ticks over a light motor bed', async () => {
    const amps = [6, 12, 19, 27, 35, 44, 52, 61, 66, 58, 41, 26, 14, 7];
    const period = 0.62;
    const { buf } = await renderEngine(amps.length * period + 0.8, (f, t, engine) => {
      const i = Math.floor(t / period);
      const running = i < amps.length;
      const ph = (t / period) * Math.PI;
      engine.update({ running, v: 0.8 * Math.cos(ph), F: 8 * Math.cos(ph), Fmax: 20, saturated: false,
        ballSpeed: running ? 0.05 * (amps[i] ?? 0) * Math.abs(Math.sin(ph)) : 0, panX: 0.5 * Math.cos(ph) });
      if (f === 0) engine.fx({ t: 'runStart' });
      if (running && f === Math.round(i * period * 60) + 20) {
        const a = amps[i] as number;
        engine.fx({ t: 'apex', ampDeg: a, reqDeg: 50, reached: a >= 50, x: 0, y: 0 });
      }
    });
    await dump('engine-pump', buf);
    const s = stats(buf, 0.1);
    expect(s.nan).toBe(0);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    expect(s.tailPeak).toBeLessThan(1e-3);
  });

  it('crash, then retry: continuous sounds stop and pending sounds are cancelled', async () => {
    const { buf } = await renderEngine(3, (f, _t, engine) => {
      engine.update({ running: f < 30, v: 2, F: 20, Fmax: 20, saturated: true, ballSpeed: 4, panX: -0.5 });
      if (f === 0) engine.fx({ t: 'runStart' });
      if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
      if (f === 13) engine.fx({ t: 'holdReset', phase: 0, frac: 0.4 });
      if (f === 30) engine.fx({ t: 'crash', kind: 1 as never, wall: 0, x: 1, y: 0.3, overlapMm: 4 });
      if (f === 60) engine.fx({ t: 'success', score: 1, medal: 1, crown: false, firstCrown: false, pb: true, badges: [] });
      if (f === 70) engine.fx({ t: 'retry' }); // the PB arpeggio (due at +0.75 s) must not play
    });
    await dump('engine-crash-retry', buf);
    const s = stats(buf, 0.3);
    expect(s.nan).toBe(0);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    expect(s.tailPeak).toBeLessThan(1e-4);
    // Nothing after the success chord (1.0 s + ~1.1 s): the PB arpeggio at 1.75 s was cancelled.
    const d = buf.getChannelData(0);
    let pbWindow = 0;
    for (let i = Math.round(2.2 * SR); i < Math.round(2.6 * SR); i++) pbWindow = Math.max(pbWindow, Math.abs(d[i] as number));
    expect(pbWindow).toBeLessThan(1e-3);
  });

  it('suspend() (pause menu) silences game sounds and ignores game events, UI clicks still sound; resume() restores', async () => {
    let pausedSeen = false;
    const { buf, played } = await renderEngine(2, (f, _t, engine) => {
      engine.update({ running: true, v: 2, F: 20, Fmax: 20, saturated: false, ballSpeed: 0, panX: 0 });
      if (f === 30) engine.suspend();
      if (f === 40) {
        pausedSeen = engine.paused;
        engine.fx({ t: 'apex', ampDeg: 40, reqDeg: null, reached: false, x: 0, y: 0 });
        engine.fx({ t: 'holdStart', phase: 0 });
      }
      if (f === 50) engine.play('ui');
      if (f === 70) engine.resume();
      if (f === 90) engine.fx({ t: 'apex', ampDeg: 45, reqDeg: null, reached: false, x: 0, y: 0 });
    });
    await dump('engine-pause', buf);
    expect(pausedSeen).toBe(true);
    const ids = played.map((p) => `${p.id}@${Math.round(p.at * 60)}`);
    expect(ids).toEqual(['ui@50', 'apex@90']);
    expect(peakIn(buf, 0.1, 0.45)).toBeGreaterThan(1e-3); // motor before the pause
    expect(peakIn(buf, 0.65, 0.83)).toBeLessThan(1e-4); // gate closed within 150 ms
    expect(peakIn(buf, 0.834, 0.87)).toBeGreaterThan(1e-3); // the UI click in the pause menu
    expect(peakIn(buf, 0.9, 1.16)).toBeLessThan(1e-4);
    expect(peakIn(buf, 1.3, 1.45)).toBeGreaterThan(1e-3); // motor back after resume()
    // The gate fades (no click) when it closes and when it opens again (20 ms windows: the motor hum is 140 Hz).
    const steady = rmsIn(buf, 0.3, 0.45);
    expect(maxJumpIn(buf, 0.4, 0.65)).toBeLessThan(0.45 * steady);
    expect(maxJumpIn(buf, 1.1, 1.45)).toBeLessThan(0.45 * steady);
  });

  it('runStart re-opens the game gate if the caller forgot resume()', async () => {
    const { played } = await renderEngine(0.6, (f, _t, engine) => {
      if (f === 1) engine.suspend();
      if (f === 5) engine.fx({ t: 'runStart' });
      if (f === 10) engine.fx({ t: 'apex', ampDeg: 20, reqDeg: null, reached: false, x: 0, y: 0 });
    });
    expect(played.map((p) => p.id)).toEqual(['apex']);
  });

  it('hold riser: a flicker does not re-strike the first note or chop it; a big reset plays the falling tone', async () => {
    const { buf, played } = await renderEngine(2.2, (f, _t, engine) => {
      if (f === 0) engine.fx({ t: 'runStart' });
      if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
      if (f === 12) engine.fx({ t: 'holdReset', phase: 0, frac: 2 / HOLD_SUB }); // flicker (sim: hold=2)
      if (f === 14) engine.fx({ t: 'holdStart', phase: 0 });
      if (f === 60) engine.fx({ t: 'holdReset', phase: 0, frac: 0.5 });
      if (f === 90) engine.fx({ t: 'holdStart', phase: 0 });
    });
    const steps = (frame: number): number[] => played.filter((p) => p.id === 'hold' && p.frame === frame).map((p) => p.param as number);
    expect(steps(10)).toEqual([0, 1, 2, 3, 4]); // the full riser was scheduled (steps 1..4 later cut)
    expect(steps(14)).toEqual([1, 2, 3, 4]); // restarted 67 ms later: C5 still rings, not struck again
    expect(steps(90)).toEqual([0, 1, 2, 3, 4]);
    expect(played.filter((p) => p.id === 'holdReset').length).toBe(1);
    // The C5 of the first riser rings through the flicker instead of being cut 33 ms in.
    const before = rmsIn(buf, 10 / 60 + 0.005, 10 / 60 + 0.03);
    const through = rmsIn(buf, 12 / 60 + 0.01, 12 / 60 + 0.03);
    expect(through).toBeGreaterThan(0.45 * before);
    // Exactly one note per 0.1 s beat after the restart: D5 at 14/60 + 0.1, nothing from the cut first riser.
    const d5 = midiHz(74);
    const goertzel = (t0: number, t1: number, f: number): number => {
      const d = buf.getChannelData(0).subarray(Math.round(t0 * SR), Math.round(t1 * SR));
      const k = (2 * Math.PI * f) / SR;
      const c = 2 * Math.cos(k);
      let s1 = 0;
      let s2 = 0;
      for (const x of d) {
        const s0 = x + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    // The first riser's D5 was due at 10/60 + 0.1 = 0.267 s and was cut; the restarted one is due at 0.333 s.
    expect(goertzel(0.268, 0.33, d5)).toBeLessThan(0.05 * goertzel(0.335, 0.4, d5));
  });

  describe('hold riser in sim time (D7: update().timeScale)', () => {
    /** Context time of the render quantum where renderEngine runs frame f. */
    const q = (f: number): number => Math.round(((f / 60) * SR) / 128) * 128 / SR;
    /** A running frame with a silent bed (no force, ball at rest), so only the riser sounds. */
    const idle = (timeScale?: number, running = true): AudioUpdate => ({ running, v: 0, F: 0, Fmax: 20, saturated: false, ballSpeed: 0, panX: 0, timeScale });
    /** The schedule that stands: the last report per step (re-timed steps are reported again). */
    const finalSteps = (played: Played[]): Map<number, number> => {
      const m = new Map<number, number>();
      for (const p of played) if (p.id === 'hold') m.set(p.param as number, p.at);
      return m;
    };
    const goertzel = (buf: AudioBuffer, t0: number, t1: number, f: number): number => {
      const d = buf.getChannelData(0).subarray(Math.round(t0 * SR), Math.round(t1 * SR));
      const k = (2 * Math.PI * f) / SR;
      const c = 2 * Math.cos(k);
      let s1 = 0;
      let s2 = 0;
      for (const x of d) {
        const s0 = x + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    const NOTES = [72, 74, 76, 79, 81].map(midiHz); // C5 D5 E5 G5 A5

    it('default (no timeScale) and 1× keep the 0.1 s beat; a bad timeScale falls back to 1', async () => {
      for (const ts of [undefined, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const { played } = await renderEngine(1, (f, _t, engine) => {
          engine.update(idle(ts));
          if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
        });
        const steps = finalSteps(played);
        expect([...steps.keys()], String(ts)).toEqual([0, 1, 2, 3, 4]);
        for (const [k, at] of steps) expect(at, `${ts} step ${k}`).toBeCloseTo(q(10) + 0.1 * k, 6);
        expect(played.filter((p) => p.id === 'hold').length).toBe(5); // nothing re-timed
      }
    });

    it('practice (0.5×): the steps are 0.2 s apart and sound at those times', async () => {
      const { buf, played } = await renderEngine(1.6, (f, _t, engine) => {
        engine.update(idle(0.5));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
      });
      await dump('engine-riser-practice', buf);
      const t0 = q(10);
      const steps = finalSteps(played);
      for (let k = 0; k < 5; k++) expect(steps.get(k), `step ${k}`).toBeCloseTo(t0 + 0.2 * k, 6);
      // Heard: each note where it belongs, and not where the 1× beat would have put it.
      for (let k = 1; k < 5; k++) {
        const f = NOTES[k] as number;
        const here = goertzel(buf, t0 + 0.2 * k + 0.005, t0 + 0.2 * k + 0.05, f);
        const wrong = goertzel(buf, t0 + 0.1 * k + 0.005, t0 + 0.1 * k + 0.05, f);
        expect(wrong, `step ${k}`).toBeLessThan(0.05 * here);
      }
    });

    it('slow-mo in the middle of a riser re-times the steps that have not sounded (no double notes)', async () => {
      const { buf, played } = await renderEngine(1.4, (f, _t, engine) => {
        engine.update(idle(f >= 20 && f < 35 ? 0.35 : 1));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
      });
      await dump('engine-riser-slowmo', buf);
      const t0 = q(10);
      const simAt20 = q(20) - t0;
      const simAt35 = simAt20 + (q(35) - q(20)) * 0.35;
      const want = [
        t0, t0 + 0.1,
        q(20) + (0.2 - simAt20) / 0.35, // E5 falls inside the slow-mo
        q(35) + (0.3 - simAt35), q(35) + (0.4 - simAt35), // back at 1×
      ];
      const steps = finalSteps(played);
      for (let k = 0; k < 5; k++) expect(steps.get(k), `step ${k}`).toBeCloseTo(want[k] as number, 6);
      // The notes that were due at the old 1× times were cut before they started.
      for (let k = 2; k < 5; k++) {
        const f = NOTES[k] as number;
        const old = t0 + 0.1 * k;
        const now = want[k] as number;
        expect(goertzel(buf, old + 0.003, old + 0.04, f), `step ${k}`).toBeLessThan(0.05 * goertzel(buf, now + 0.003, now + 0.04, f));
      }
      const s = stats(buf, 0.05);
      expect(s.nan).toBe(0);
      expect(s.peak).toBeLessThanOrEqual(1.0);
      expect(s.tailPeak).toBeLessThan(1e-4);
    });

    it('a hit-stop (0×) and a pause both hold the riser; it resumes from where the hold was', async () => {
      // Hit-stop from frame 20 to 32.
      const hit = await renderEngine(1.2, (f, _t, engine) => {
        engine.update(idle(f >= 20 && f < 32 ? 0 : 1));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
      });
      const t0 = q(10);
      const sim = q(20) - t0;
      let steps = finalSteps(hit.played);
      for (let k = 2; k < 5; k++) expect(steps.get(k), `hit-stop step ${k}`).toBeCloseTo(q(32) + 0.1 * k - sim, 6);

      // Pause menu from frame 20 to 50: the gate closes (the sounding D5 fades), nothing sounds while paused.
      const pause = await renderEngine(1.6, (f, _t, engine) => {
        engine.update(idle(1));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
        if (f === 20) engine.suspend();
        if (f === 50) engine.resume();
      });
      await dump('engine-riser-pause', pause.buf);
      steps = finalSteps(pause.played);
      expect([...steps.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
      // resume() at frame 50; the riser goes on from the next running frame (51).
      for (let k = 2; k < 5; k++) expect(steps.get(k), `paused step ${k}`).toBeCloseTo(q(51) + 0.1 * k - sim, 6);
      expect(peakIn(pause.buf, q(20) + 0.15, q(50))).toBeLessThan(1e-4);
      expect(peakIn(pause.buf, (steps.get(2) as number) + 0.005, (steps.get(2) as number) + 0.04)).toBeGreaterThan(1e-3);
      // A retry from the pause menu drops the riser for good.
      const retry = await renderEngine(1.4, (f, _t, engine) => {
        engine.update(idle(1));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
        if (f === 20) engine.suspend();
        if (f === 30) engine.fx({ t: 'retry' });
        if (f === 40) engine.resume();
      });
      expect(retry.played.filter((p) => p.id === 'hold').map((p) => p.param)).toEqual([0, 1, 2, 3, 4]);
      expect(peakIn(retry.buf, q(20) + 0.15, 1.4)).toBeLessThan(1e-4);
      // Leaving the run from the pause menu: core calls resume(), then the frames are not running any more.
      const leave = await renderEngine(1.4, (f, _t, engine) => {
        engine.update(idle(1, f < 40));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
        if (f === 20) engine.suspend();
        if (f === 40) engine.resume();
      });
      expect(leave.played.filter((p) => p.id === 'hold').map((p) => p.param)).toEqual([0, 1, 2, 3, 4]);
      expect(peakIn(leave.buf, q(20) + 0.15, 1.4)).toBeLessThan(1e-4);
    });

    it('HoldReset during a slow-mo riser cuts the re-timed steps', async () => {
      const run = (reset: boolean): ReturnType<typeof renderEngine> => renderEngine(1.4, (f, _t, engine) => {
        engine.update(idle(f >= 15 ? 0.35 : 1));
        if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
        if (reset && f === 40) engine.fx({ t: 'holdReset', phase: 0, frac: 0.2 });
      });
      const [ref, cut] = [await run(false), await run(true)];
      const late = [...finalSteps(cut.played)].filter(([, at]) => at > q(40));
      expect(late.map(([k]) => k)).toEqual([3, 4]); // still pending at the reset (slow-mo stretched them) ...
      for (const [k, at] of late) {
        const f = NOTES[k] as number;
        const heard = goertzel(cut.buf, at + 0.003, at + 0.04, f);
        expect(heard, `step ${k}`).toBeLessThan(0.01 * goertzel(ref.buf, at + 0.003, at + 0.04, f)); // ... and never sounded
      }
    });
  });

  it('D3: a practice rewind cuts the rest of the riser and plays the rewind chirp once', async () => {
    const q = (f: number): number => Math.round(((f / 60) * SR) / 128) * 128 / SR;
    const idle: AudioUpdate = { running: true, v: 0, F: 0, Fmax: 20, saturated: false, ballSpeed: 0, panX: 0, timeScale: 0.5 };
    const run = (rewind: boolean): ReturnType<typeof renderEngine> => renderEngine(1.4, (f, _t, engine) => {
      engine.update(idle);
      if (f === 10) engine.fx({ t: 'holdStart', phase: 0 });
      if (rewind && f === 30) engine.fx({ t: 'rewind', ticks: 120, phase: 0 });
    });
    const energy = (buf: AudioBuffer, t0: number, t1: number, f: number): number => {
      const d = buf.getChannelData(0).subarray(Math.round(t0 * SR), Math.round(t1 * SR));
      const c = 2 * Math.cos((2 * Math.PI * f) / SR);
      let s1 = 0;
      let s2 = 0;
      for (const x of d) {
        const s0 = x + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    const [ref, cut] = [await run(false), await run(true)];
    expect(cut.played.filter((p) => p.id === 'rewind').map((p) => p.frame)).toEqual([30]);
    expect(ref.played.some((p) => p.id === 'rewind')).toBe(false);
    // 0.5×: steps 0.2 s apart from q(10); G5 (step 3) and A5 (step 4) are still ahead at the rewind (0.5 s).
    for (const k of [3, 4]) {
      const at = q(10) + 0.2 * k;
      const f = midiHz([72, 74, 76, 79, 81][k] as number);
      const heard = energy(cut.buf, at + 0.003, at + 0.04, f);
      expect(heard, `step ${k}`).toBeLessThan(0.01 * energy(ref.buf, at + 0.003, at + 0.04, f));
    }
  });

  it('D5: a stop whose string went slack (stop + slack, SlackBegin a substep later) sounds once', async () => {
    const { played } = await renderEngine(0.8, (f, _t, engine) => {
      if (f === 0) engine.fx({ t: 'runStart' });
      if (f === 10) {
        engine.fx({ t: 'stop', side: 1, speed: 1.4 });
        engine.fx({ t: 'slack', x: 1, y: 0.4 }); // core: StopHit with c = 0
      }
      if (f === 11) engine.fx({ t: 'slack', x: 1, y: 0.4 }); // sim: SlackBegin
      if (f === 30) engine.fx({ t: 'slack', x: 1, y: 0.4 }); // a lone SlackBegin
    });
    expect(played.map((p) => `${p.id}@${p.frame}`)).toEqual(['stop@10']);
    const calls: (number | number[])[] = [];
    let t = 0;
    const h = createHaptics({ vibrate: (p) => (calls.push(p), true), activated: () => true, now: () => t });
    h.fx({ t: 'stop', side: 1, speed: 1.4 });
    h.fx({ t: 'slack', x: 1, y: 0.4 });
    t = 8;
    h.fx({ t: 'slack', x: 1, y: 0.4 });
    expect(calls).toEqual([15]);
  });

  it('an event storm stays within the voice cap and within [-1, 1]', async () => {
    const { buf, maxVoices } = await renderEngine(2, (f, _t, engine) => {
      engine.update({ running: true, v: 4, F: 20, Fmax: 20, saturated: true, ballSpeed: 5, panX: 1 });
      for (const id of SFX_IDS) engine.play(id, id === 'snap' ? 5 : undefined);
      engine.fx({ t: 'holdStart', phase: 0 });
      engine.fx({ t: 'apex', ampDeg: (f * 7) % 90, reqDeg: 30, reached: f % 2 === 0, x: 0, y: 0 });
      engine.fx({ t: 'crash', kind: 2 as never, wall: 0, x: 0, y: 0, overlapMm: 1 });
    });
    await dump('engine-storm', buf);
    const s = stats(buf);
    expect(s.nan).toBe(0);
    expect(s.peak).toBeLessThanOrEqual(1.0);
    expect(maxVoices).toBeLessThanOrEqual(MAX_VOICES);
    expect(maxVoices).toBeGreaterThan(8);
  });

  it('mute and volume 0 silence everything; the engine is inert before unlock', async () => {
    const muted = await renderEngine(1, (f, _t, engine) => {
      engine.update({ running: true, v: 2, F: 20, Fmax: 20, saturated: true, ballSpeed: 4, panX: 0 });
      if (f === 10) engine.fx({ t: 'crash', kind: 1 as never, wall: 0, x: 0, y: 0, overlapMm: 1 });
    }, { muted: true });
    expect(stats(muted.buf).peak).toBeLessThan(1e-4);
    // Muting while sounding glides down in ~15 ms (no click) and stays silent.
    const later = await renderEngine(1, (f, _t, engine) => {
      engine.update({ running: true, v: 2, F: 20, Fmax: 20, saturated: true, ballSpeed: 4, panX: 0 });
      if (f === 30) engine.setMuted(true);
    });
    const d = later.buf.getChannelData(0);
    let after = 0;
    for (let i = Math.round(0.75 * SR); i < d.length; i++) after = Math.max(after, Math.abs(d[i] as number));
    expect(after).toBeLessThan(1e-4);
    expect(stats(later.buf).maxWinJump).toBeLessThan(0.05);
    const quiet = await renderEngine(1, (f, _t, engine) => {
      if (f === 10) engine.fx({ t: 'crash', kind: 1 as never, wall: 0, x: 0, y: 0, overlapMm: 1 });
    }, { volume: 0 });
    expect(stats(quiet.buf).peak).toBeLessThan(1e-3);

    const idle = createAudioEngine({ autoWire: false });
    expect(idle.paused).toBe(false);
    expect(idle.state === 'locked' || idle.state === 'unavailable').toBe(true);
    idle.fx({ t: 'runStart' });
    idle.update({ running: true, v: 1, F: 1, Fmax: 1, saturated: false, ballSpeed: 1, panX: 0 });
    idle.play('ui');
    expect(idle.activeVoices).toBe(0);
    idle.dispose();
  });
});

/** One 60 Hz frame of a simulated run: the GameEvents core would emit (src/core/session.ts) and update() inputs. */
interface SimFrame { events: GameEvent[]; running: boolean; v: number; F: number; saturated: boolean; ballSpeed: number; panX: number }

/** Runs a replay through the real simulator and converts its events the way core does (simplified). */
function simFrames(phys: LevelPhysics, qs: Int8Array): SimFrame[] {
  const frames: SimFrame[] = [];
  const req = levelFacts(phys).reqDeg;
  const [r0, r1] = phys.rail;
  let sat = 0;
  let saturated = false;
  let reached = false;
  simulateReplay(phys, qs, {
    onTick(tick, s, ev) {
      const out: GameEvent[] = [];
      if (tick === 0) out.push({ t: 'runStart' });
      sat = Math.abs(qs[tick] ?? 0) === 127 ? sat + 1 : 0;
      if (!saturated && sat >= 3) {
        saturated = true;
        out.push({ t: 'saturate', on: true });
      } else if (saturated && sat === 0) {
        saturated = false;
        out.push({ t: 'saturate', on: false });
      }
      for (let k = 0; k < ev.n; k++) {
        const a = ev.a[k] as number;
        const b = ev.b[k] as number;
        const c = ev.c[k] as number;
        switch (ev.kind[k] as Ev) {
          case Ev.Snap: out.push({ t: 'snap', J: a, x: b, y: c }); break;
          case Ev.SlackBegin: out.push({ t: 'slack', x: b, y: c }); break;
          case Ev.StopHit:
            // D5: hits from 0.1 m/s; a hit that left the string slack (c = 0) also reports 'slack'.
            if (b >= 0.1) out.push({ t: 'stop', side: a < 0 ? -1 : 1, speed: b });
            if (c === 0) out.push({ t: 'slack', x: s.bx, y: s.by });
            break;
          case Ev.WallCross:
            out.push({
              t: 'cross', wall: a, dir: b > 0 ? 1 : -1, gapMm: Number.isFinite(c) ? (Math.sqrt(Math.max(0, c)) - BALL_R) * 1000 : Infinity,
              speed: Math.hypot(s.bvx, s.bvy), px: s.bx, py: s.by,
            });
            break;
          case Ev.Apex: {
            const amp = (Math.abs(a) * 180) / Math.PI;
            if (amp <= 3) break;
            const r = req[0] ?? null;
            const hit = r !== null && amp >= r && !reached;
            if (hit) reached = true;
            out.push({ t: 'apex', ampDeg: amp, reqDeg: r, reached: hit, x: s.x, y: 0 });
            break;
          }
          case Ev.HoldBegin: out.push({ t: 'holdStart', phase: a }); break;
          case Ev.HoldReset: out.push({ t: 'holdReset', phase: a, frac: Math.min(1, b / HOLD_SUB) }); break;
          case Ev.PhaseDone: out.push({ t: 'phase', index: a }); break;
          case Ev.Success: out.push({ t: 'success', score: a, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] }); break;
          case Ev.Crash: out.push({ t: 'crash', kind: a as CrashKind, wall: -1, x: b, y: c, overlapMm: 1 }); break;
          case Ev.Timeout: out.push({ t: 'timeout', reason: 'none', value: 0 }); break;
          default: break;
        }
      }
      frames.push({
        events: out, running: s.status === Status.Running, v: s.v, F: s.F, saturated,
        ballSpeed: Math.hypot(s.bvx, s.bvy), panX: Math.max(-1, Math.min(1, (2 * (s.bx - r0)) / (r1 - r0) - 1)),
      });
    },
  });
  return frames;
}

describe('real simulator event streams (golden replays through src/sim)', () => {
  const g = golden as unknown as { levels: Record<string, LevelPhysics>; replays: { id: string; level: string; replay: string }[] };
  for (const id of ['1-1/bang-bang', '1-1/random', '2-2/pump', '4-2/slam-stop', '4-2/dash-brake', '5-4/full-course']) {
    it(`${id}: every event gets its sound, the mix stays within range, silence after the run`, async () => {
      const rep = g.replays.find((r) => r.id === id);
      const phys = rep ? g.levels[rep.level] : undefined;
      expect(rep && phys).toBeTruthy();
      const frames = simFrames(phys as LevelPhysics, decodeReplay(b64urlDecode((rep as { replay: string }).replay)).qs);
      const all = frames.flatMap((f) => f.events);
      const count = (t: GameEvent['t']): number => all.filter((e) => e.t === t).length;
      const Fmax = (phys as LevelPhysics).Fmax;
      // Tail: the crown fanfare starts 0.75 s after Success and rings ~1.1 s.
      const { buf, maxVoices, played } = await renderEngine(frames.length / 60 + 2.4, (f, _t, engine) => {
        const fr = frames[f];
        if (!fr) {
          engine.update({ running: false, v: 0, F: 0, Fmax, saturated: false, ballSpeed: 0, panX: 0 });
          return;
        }
        for (const e of fr.events) engine.fx(e);
        engine.update({ running: fr.running, v: fr.v, F: fr.F, Fmax, saturated: fr.saturated, ballSpeed: fr.ballSpeed, panX: fr.panX });
      });
      await dump(`sim-${id.replace('/', '_')}`, buf);
      const n = (sid: SfxId): number => played.filter((p) => p.id === sid).length;
      // One wood-block tick per apex (> 3°), pitched by the amplitude; the chime when the required angle is reached.
      expect(n('apex')).toBe(count('apex'));
      const apexes = all.filter((e): e is Extract<GameEvent, { t: 'apex' }> => e.t === 'apex');
      expect(played.filter((p) => p.id === 'apex').map((p) => apexStep(p.param as number))).toEqual(apexes.map((e) => apexStep(e.ampDeg)));
      expect(n('chime')).toBe(apexes.filter((e) => e.reached).length);
      expect(n('crash')).toBe(count('crash'));
      expect(n('success')).toBe(count('success'));
      expect(n('fanfare')).toBe(count('success'));
      expect(n('timeout')).toBe(count('timeout'));
      const stops = count('stop');
      expect(n('stop')).toBeLessThanOrEqual(stops);
      if (stops > 0) expect(n('stop')).toBeGreaterThan(0);
      expect(n('snap')).toBeLessThanOrEqual(count('snap'));
      if (count('snap') > 0) expect(n('snap')).toBeGreaterThan(0);
      // Hold: each HoldBegin starts a riser (5 steps, or 4 when the first note is still ringing).
      expect(played.filter((p) => p.id === 'hold' && p.param === 4).length).toBe(count('holdStart'));
      const s = stats(buf, 0.1);
      expect(s.nan).toBe(0);
      expect(s.peak).toBeLessThanOrEqual(1.0);
      expect(s.rms).toBeGreaterThan(1e-3);
      expect(s.tailPeak).toBeLessThan(1e-3);
      expect(maxVoices).toBeLessThanOrEqual(MAX_VOICES);
    });
  }
});

describe('page wiring (real AudioContext, autoWire)', () => {
  it('unlocks on the first gesture, clicks buttons (data-sfx="none" opts out), suspends while hidden, pauses without muting UI', async () => {
    const played: SfxId[] = [];
    const engine = createAudioEngine({ onSound: (id) => played.push(id) });
    const root = document.createElement('div');
    const btn = document.createElement('button');
    btn.textContent = 'play';
    const quiet = document.createElement('div');
    quiet.dataset.sfx = 'none';
    const quietBtn = document.createElement('button');
    quietBtn.textContent = 'quiet';
    quiet.append(quietBtn);
    const off = document.createElement('button');
    off.textContent = 'off';
    off.setAttribute('aria-disabled', 'true');
    root.append(btn, quiet, off);
    document.body.append(root);
    // Clicks at a human pace: Playwright can click twice within the 25 ms UI-click rate limit.
    const click = async (el: HTMLElement): Promise<void> => {
      await new Promise((r) => setTimeout(r, 40));
      await userEvent.click(el, { force: true });
    };
    try {
      if (!navigator.userActivation?.hasBeenActive) expect(engine.state).toBe('locked');
      await click(btn);
      await vi.waitFor(() => expect(engine.state).toBe('running'), { timeout: 3000 });
      expect(engine.context).not.toBeNull();
      played.length = 0;
      await click(btn); // the audio clock may not have moved since the first click: still a click
      await click(quietBtn);
      await click(off); // aria-disabled: silent
      expect(played).toEqual(['ui']);

      engine.suspend(); // pause menu: the context keeps running, game sounds are gated
      expect(engine.state).toBe('running');
      played.length = 0;
      engine.play('apex', 30);
      await click(btn);
      expect(played).toEqual(['ui']);
      engine.resume();

      const setVis = (v: DocumentVisibilityState | null): void => {
        if (v === null) delete (document as unknown as { visibilityState?: string }).visibilityState;
        else Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      setVis('hidden');
      await vi.waitFor(() => expect(engine.state).toBe('suspended'), { timeout: 3000 });
      played.length = 0;
      engine.play('apex', 30);
      expect(played).toEqual([]); // nothing piles up while hidden
      setVis(null);
      await vi.waitFor(() => expect(engine.state).toBe('running'), { timeout: 3000 });
      engine.play('apex', 30);
      expect(played).toEqual(['apex']);
    } finally {
      const ctx = engine.context as AudioContext | null;
      engine.dispose();
      root.remove();
      if (ctx) await vi.waitFor(() => expect(ctx.state).toBe('closed'), { timeout: 3000 });
    }
  });

  it('the first click both unlocks and sounds', async () => {
    const played: SfxId[] = [];
    const engine = createAudioEngine({ onSound: (id) => played.push(id) });
    const btn = document.createElement('button');
    btn.textContent = 'first';
    document.body.append(btn);
    try {
      await userEvent.click(btn);
      expect(played).toEqual(['ui']);
    } finally {
      engine.dispose();
      btn.remove();
    }
  });
});

describe('haptics (§9.5)', () => {
  const base = { x: 0, y: 0 };
  it('maps events to the §9.5 patterns', () => {
    expect(hapticPatternFor({ t: 'saturate', on: true })).toBe(6);
    expect(hapticPatternFor({ t: 'saturate', on: false })).toBeNull();
    expect(hapticPatternFor({ t: 'cross', wall: 0, dir: 1, gapMm: 19, speed: 1, px: 0, py: 0 })).toBe(8);
    expect(hapticPatternFor({ t: 'cross', wall: 0, dir: 1, gapMm: 25, speed: 1, px: 0, py: 0 })).toBeNull();
    expect(hapticPatternFor({ t: 'snap', J: 0.5, ...base })).toBe(10);
    expect(hapticPatternFor({ t: 'snap', J: 0.4, ...base })).toBeNull();
    expect(hapticPatternFor({ t: 'stop', side: -1, speed: 1 })).toBe(15);
    expect(hapticPatternFor({ t: 'stop', side: 1, speed: STOP_HAPTIC_MIN_SPEED - 0.01 })).toBeNull(); // resting bumps
    expect(hapticPatternFor({ t: 'success', score: 1, medal: 1, crown: false, firstCrown: false, pb: false, badges: [] })).toBe(20);
    const crown = hapticPatternFor({ t: 'success', score: 1, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] });
    expect(Array.isArray(crown) && crown.slice(2)).toEqual([20, 30, 20, 30, 60]);
    expect(hapticPatternFor({ t: 'crash', kind: 1 as never, wall: 0, x: 0, y: 0, overlapMm: 1 })).toEqual([30, 40, 30]);
    expect(hapticPatternFor({ t: 'apex', ampDeg: 30, reqDeg: null, reached: false, x: 0, y: 0 })).toBeNull();
  });

  it('respects enabled, support and activation, and does not machine-gun short pulses', () => {
    const calls: (number | number[])[] = [];
    let t = 0;
    let active = false;
    const h = createHaptics({ vibrate: (p) => (calls.push(p), true), activated: () => active, now: () => t });
    expect(h.supported).toBe(true);
    h.fire(10);
    expect(calls).toEqual([]); // no user activation yet
    active = true;
    h.fire(10);
    t = 10;
    h.fire(10); // too close: merged
    t = 100;
    h.fx({ t: 'crash', kind: 1 as never, wall: 0, x: 0, y: 0, overlapMm: 1 });
    t = 120;
    h.fire(15); // does not cut the running crash pattern
    h.enabled = false;
    t = 1000;
    h.fire(20);
    expect(calls).toEqual([10, [30, 40, 30]]);
    const none = createHaptics({ vibrate: undefined, activated: () => true });
    expect(typeof none.supported).toBe('boolean');
    none.fire(10); // never throws
  });
});
