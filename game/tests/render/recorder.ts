// Recording 2D canvas context for render / sideview golden tests (skins spec §5.9). Owner: O5.
//
// happy-dom has no canvas backend: getContext('2d') is stubbed with a recorder that logs every call with its
// arguments (numbers rounded to 1e-6) and, on each drawing call, the fill / stroke state. Colour strings are parsed
// to RGBA numbers, so '#d9d4cb' vs '#D9D4CB' or '0.30' vs '0.3' never matter. Gradients are recorded objects.
// FNV-1a over the JSON of a log gives a short golden hash.

export type Rgba = [number, number, number, number];

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Parses '#rgb', '#rrggbb', 'rgb(...)', 'rgba(...)' to RGBA (0..255, alpha 0..1); anything else stays a string. */
export function parseColour(s: string): Rgba | string {
  const t = s.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(t);
  if (m) {
    const h = m[1]!;
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16), 1];
  }
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) {
    const h = m[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const p = m[1]!.split(',').map((x) => Number(x.trim()));
    return [r6(p[0] ?? 0), r6(p[1] ?? 0), r6(p[2] ?? 0), r6(p[3] ?? 1)];
  }
  if (t === 'black') return [0, 0, 0, 1];
  if (t === 'white') return [255, 255, 255, 1];
  return s;
}

export class GradientRec {
  readonly stops: [number, Rgba | string][] = [];
  constructor(readonly kind: string, readonly args: number[]) {}
  addColorStop(o: number, c: string): void {
    this.stops.push([r6(o), parseColour(c)]);
  }
  toJSON(): unknown {
    return { g: this.kind, a: this.args, s: this.stops };
  }
}

type Style = string | GradientRec | unknown;
const styleOf = (s: Style): unknown => (typeof s === 'string' ? parseColour(s) : s instanceof GradientRec ? s.toJSON() : String(s));
const argOf = (a: unknown): unknown => (typeof a === 'number' ? r6(a) : typeof a === 'string' ? a : a instanceof GradientRec ? a.toJSON() : Array.isArray(a) ? a.map(argOf) : typeof a);

/** Drawing calls that log the current fill / stroke state with them. */
const DRAWS = new Set(['fill', 'fillRect', 'stroke', 'strokeRect', 'fillText', 'strokeText', 'clearRect', 'drawImage']);

export interface Recorder {
  readonly canvas: HTMLCanvasElement;
  readonly log: unknown[][];
  hash(): string;
}

/** A recording CanvasRenderingContext2D (only what the game uses; any other method is logged by name). */
export function recordingContext(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; rec: Recorder } {
  const log: unknown[][] = [];
  const state = {
    fillStyle: '#000000' as Style, strokeStyle: '#000000' as Style, globalAlpha: 1, lineWidth: 1,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter',
    globalCompositeOperation: 'source-over', lineDashOffset: 0, miterLimit: 10, imageSmoothingEnabled: true,
    filter: 'none',
  };
  const stack: (typeof state)[] = [];
  const target: Record<string, unknown> = {
    canvas,
    save: () => { stack.push({ ...state }); log.push(['save']); },
    restore: () => { const s = stack.pop(); if (s) Object.assign(state, s); log.push(['restore']); },
    createRadialGradient: (...a: number[]) => new GradientRec('radial', a.map(r6)),
    createLinearGradient: (...a: number[]) => new GradientRec('linear', a.map(r6)),
    measureText: (s: string) => ({ width: 10 * String(s).length, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    getLineDash: () => [],
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    isPointInPath: () => false,
  };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string') return undefined;
      if (key in t) return t[key];
      if (key in state) return state[key as keyof typeof state];
      return (...args: unknown[]) => {
        const e: unknown[] = [key, ...args.map(argOf)];
        if (DRAWS.has(key)) {
          e.push({
            f: styleOf(state.fillStyle), s: styleOf(state.strokeStyle), a: r6(state.globalAlpha), w: r6(state.lineWidth),
            op: state.globalCompositeOperation,
          });
        }
        log.push(e);
      };
    },
    set(_t, key, value) {
      if (typeof key !== 'string') return false;
      if (key in state) {
        (state as Record<string, unknown>)[key] = typeof value === 'number' ? value : value;
        if (key !== 'fillStyle' && key !== 'strokeStyle' && key !== 'globalAlpha' && key !== 'lineWidth') log.push(['set', key, argOf(value)]);
        return true;
      }
      log.push(['set', key, argOf(value)]);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const rec: Recorder = { canvas, log, hash: () => fnv1a(JSON.stringify(log)) };
  return { ctx, rec };
}

/** 32-bit FNV-1a of a string, as 8 hex digits. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash of numeric arrays, each value rounded to 1e-6 (-0 and 0 are the same). */
export function hashNums(...arrs: ArrayLike<number>[]): string {
  const parts: string[] = [];
  for (const a of arrs) {
    const out: number[] = [];
    for (let i = 0; i < a.length; i++) out.push(r6(a[i]!) + 0);
    parts.push(out.join(','));
  }
  return fnv1a(parts.join('|'));
}

const recorders = new WeakMap<HTMLCanvasElement, Recorder>();
/** Recorders in the order their contexts were created (for canvases a function makes internally). */
const made: Recorder[] = [];

/** Number of recording contexts created so far. */
export function recorderCount(): number {
  return made.length;
}

/** Recorders created after `since` (a recorderCount() value), in creation order. */
export function recordersSince(since: number): Recorder[] {
  return made.slice(since);
}
let installed: PropertyDescriptor | undefined;

/** Stubs HTMLCanvasElement.prototype.getContext('2d') with a recorder per canvas. Returns an uninstaller. */
export function installRecorder(): () => void {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  installed = Object.getOwnPropertyDescriptor(proto, 'getContext');
  const ctxs = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  Object.defineProperty(proto, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement, kind: string) {
      if (kind !== '2d') return null;
      let c = ctxs.get(this);
      if (!c) {
        const r = recordingContext(this);
        c = r.ctx;
        ctxs.set(this, c);
        recorders.set(this, r.rec);
        made.push(r.rec);
      }
      return c;
    },
  });
  return () => {
    if (installed) Object.defineProperty(proto, 'getContext', installed);
    else delete proto.getContext;
  };
}

/** The recorder of a canvas made while installRecorder() was active. */
export function recorderOf(canvas: unknown): Recorder {
  const r = recorders.get(canvas as HTMLCanvasElement);
  if (!r) throw new Error('no recorder for this canvas');
  return r;
}
