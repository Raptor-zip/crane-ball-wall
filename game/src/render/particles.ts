// Pooled particles, max 300 (GAME_DESIGN.md §9.7). Owner: O5.
//
// PointsBatch is one THREE.Points with a shape-aware point shader (disc, soft glow, rect/streak,
// ring, sparkle). The particle pool and the ball trail both write into the same batch per frame.
import {
  BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Points, ShaderMaterial,
} from 'three';
import { PAL, col } from './scene';

export const S_DISC = 0, S_SOFT = 1, S_RECT = 2, S_RING = 3, S_SPARK = 4;

const PT_VS = /* glsl */ `
attribute vec4 aCol;
attribute float aSize;
attribute float aShape;
attribute float aRot;
attribute float aStretch;
uniform float uPx;
varying vec4 vCol;
varying float vShape;
varying float vRot;
varying float vStretch;
void main() {
  vCol = aCol; vShape = aShape; vRot = aRot; vStretch = aStretch;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, aSize * uPx);
}`;

const PT_FS = /* glsl */ `
varying vec4 vCol;
varying float vShape;
varying float vRot;
varying float vStretch;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float c = cos(vRot), s = sin(vRot);
  p = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  float a = 0.0;
  vec3 rgb = vCol.rgb;
  float r = length(p);
  float aa = max(fwidth(r), 1e-3) * 1.2;
  if (vShape < 0.5) {
    a = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  } else if (vShape < 1.5) {
    a = exp(-r * r * 4.0) * step(r, 1.0);
  } else if (vShape < 2.5) {
    vec2 q = abs(p) / vec2(1.0, 1.0 / max(vStretch, 1.0));
    float e = max(q.x, q.y);
    float ea = max(fwidth(e), 1e-3) * 1.2;
    a = 1.0 - smoothstep(1.0 - ea, 1.0, e);
  } else if (vShape < 3.5) {
    float fillA = 0.42;
    float ring = smoothstep(0.80 - aa, 0.80, r);
    a = (1.0 - smoothstep(1.0 - aa, 1.0, r)) * mix(fillA, 1.0, ring);
    rgb = mix(rgb, rgb * 0.55, ring);
  } else {
    float star = max(0.0, 1.0 - (abs(p.x * p.y) * 9.0 + r * 0.85));
    a = clamp(star * 1.6, 0.0, 1.0) + exp(-r * r * 12.0) * 0.8;
    rgb = mix(rgb, vec3(1.0), exp(-r * r * 10.0) * 0.8);
  }
  a *= vCol.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}`;

export class PointsBatch {
  readonly points: Points;
  private readonly pos: Float32Array;
  private readonly colr: Float32Array;
  private readonly size: Float32Array;
  private readonly shape: Float32Array;
  private readonly rot: Float32Array;
  private readonly stretch: Float32Array;
  private n = 0;
  readonly material: ShaderMaterial;

  constructor(readonly max: number) {
    this.pos = new Float32Array(max * 3);
    this.colr = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.shape = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.stretch = new Float32Array(max);
    const g = new BufferGeometry();
    const dyn = (a: BufferAttribute): BufferAttribute => a.setUsage(DynamicDrawUsage);
    g.setAttribute('position', dyn(new BufferAttribute(this.pos, 3)));
    g.setAttribute('aCol', dyn(new BufferAttribute(this.colr, 4)));
    g.setAttribute('aSize', dyn(new BufferAttribute(this.size, 1)));
    g.setAttribute('aShape', dyn(new BufferAttribute(this.shape, 1)));
    g.setAttribute('aRot', dyn(new BufferAttribute(this.rot, 1)));
    g.setAttribute('aStretch', dyn(new BufferAttribute(this.stretch, 1)));
    g.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader: PT_VS, fragmentShader: PT_FS,
      uniforms: { uPx: { value: 1 } },
      transparent: true, depthWrite: false,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
  }

  get count(): number { return this.n; }
  set pixelRatio(v: number) { (this.material.uniforms.uPx as { value: number }).value = v; }

  begin(): void { this.n = 0; }

  add(x: number, y: number, z: number, sizePx: number, c: Color, a: number, shape: number, rot = 0, stretch = 1): void {
    if (this.n >= this.max || a <= 0.003 || sizePx <= 0.2) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.colr[i * 4] = c.r; this.colr[i * 4 + 1] = c.g; this.colr[i * 4 + 2] = c.b; this.colr[i * 4 + 3] = a;
    this.size[i] = sizePx; this.shape[i] = shape; this.rot[i] = rot; this.stretch[i] = stretch;
  }

  end(): void {
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const k of ['position', 'aCol', 'aSize', 'aShape', 'aRot', 'aStretch']) {
      const a = g.getAttribute(k) as BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Particle pool.

export const MAX_PARTICLES = 300;

interface Emit {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; size: number; color: Color; alpha: number; shape: number;
  gravity?: number; drag?: number; rot?: number; spin?: number; stretch?: number; flutter?: number; shrink?: boolean;
}

export class Particles {
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pz = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly vz = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly alpha = new Float32Array(MAX_PARTICLES);
  private readonly shape = new Uint8Array(MAX_PARTICLES);
  private readonly grav = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly rot = new Float32Array(MAX_PARTICLES);
  private readonly spin = new Float32Array(MAX_PARTICLES);
  private readonly stretch = new Float32Array(MAX_PARTICLES);
  private readonly flutter = new Float32Array(MAX_PARTICLES);
  private readonly shrink = new Uint8Array(MAX_PARTICLES);
  private readonly color: Color[] = Array.from({ length: MAX_PARTICLES }, () => new Color());
  private next = 0;
  private live = 0;
  private seed = 1234567;
  private readonly tmp = new Color();

  /** Deterministic-enough random for effects (never touches the simulation). */
  rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  get active(): number { return this.live; }

  emit(e: Emit): void {
    // Ring allocation: overwrite the oldest when full.
    let i = -1;
    for (let k = 0; k < MAX_PARTICLES; k++) {
      const j = (this.next + k) % MAX_PARTICLES;
      if ((this.life[j] as number) <= 0) { i = j; break; }
    }
    if (i < 0) i = this.next;
    this.next = (i + 1) % MAX_PARTICLES;
    this.px[i] = e.x; this.py[i] = e.y; this.pz[i] = e.z;
    this.vx[i] = e.vx; this.vy[i] = e.vy; this.vz[i] = e.vz;
    this.life[i] = e.life; this.maxLife[i] = e.life;
    this.size[i] = e.size; this.alpha[i] = e.alpha; this.shape[i] = e.shape;
    this.grav[i] = e.gravity ?? 0; this.drag[i] = e.drag ?? 0;
    this.rot[i] = e.rot ?? 0; this.spin[i] = e.spin ?? 0; this.stretch[i] = e.stretch ?? 1;
    this.flutter[i] = e.flutter ?? 0; this.shrink[i] = e.shrink === false ? 0 : 1;
    (this.color[i] as Color).copy(e.color);
  }

  clear(): void {
    this.life.fill(0);
    this.live = 0;
  }

  update(dt: number): void {
    let live = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if ((this.life[i] as number) <= 0) continue;
      this.life[i] = (this.life[i] as number) - dt;
      if ((this.life[i] as number) <= 0) continue;
      live++;
      const d = Math.exp(-(this.drag[i] as number) * dt);
      this.vx[i] = (this.vx[i] as number) * d;
      this.vy[i] = (this.vy[i] as number) * d - (this.grav[i] as number) * dt;
      this.vz[i] = (this.vz[i] as number) * d;
      const fl = this.flutter[i] as number;
      if (fl > 0) this.vx[i] = (this.vx[i] as number) + Math.sin((this.life[i] as number) * 9 + i) * fl * dt;
      this.px[i] = (this.px[i] as number) + (this.vx[i] as number) * dt;
      this.py[i] = (this.py[i] as number) + (this.vy[i] as number) * dt;
      this.pz[i] = (this.pz[i] as number) + (this.vz[i] as number) * dt;
      this.rot[i] = (this.rot[i] as number) + (this.spin[i] as number) * dt;
      if ((this.py[i] as number) < 0.004 && (this.vy[i] as number) < 0) {
        this.py[i] = 0.004;
        this.vy[i] = -(this.vy[i] as number) * 0.25;
        this.vx[i] = (this.vx[i] as number) * 0.5;
        this.spin[i] = (this.spin[i] as number) * 0.3;
        this.flutter[i] = 0;
      }
    }
    this.live = live;
  }

  write(b: PointsBatch): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const l = this.life[i] as number;
      if (l <= 0) continue;
      const t = l / (this.maxLife[i] as number); // 1 -> 0
      const sh = this.shape[i] as number;
      let size = this.size[i] as number;
      if (this.shrink[i]) size *= 0.35 + 0.65 * t;
      let stretch = this.stretch[i] as number;
      let rot = this.rot[i] as number;
      if (sh === S_RECT && (this.flutter[i] as number) > 0) {
        // Tumbling confetti: fake the flip by squashing the rect.
        stretch = 1 + Math.abs(Math.sin(rot * 1.7)) * ((this.stretch[i] as number) + 1.5);
      }
      if (sh === S_RECT && (this.flutter[i] as number) === 0 && (this.stretch[i] as number) > 2) {
        // Streak along the velocity.
        rot = Math.atan2(this.vy[i] as number, this.vx[i] as number) + Math.PI / 2;
      }
      const a = (this.alpha[i] as number) * Math.min(1, t * 3);
      b.add(this.px[i] as number, this.py[i] as number, this.pz[i] as number, size, this.color[i] as Color, a, sh, rot, stretch);
    }
  }

  // ---- emitters -------------------------------------------------------------------------

  /** Hot sparks (streaks) from a point, biased along (dx, dy). */
  sparks(x: number, y: number, z: number, n: number, dx: number, dy: number, speed: number, tint: string = PAL.gantry): void {
    const hot = col('#FFF4C2'), c = col(tint), mid = col('#FF8A1E');
    for (let k = 0; k < n; k++) {
      const a = Math.atan2(dy, dx) + (this.rand() - 0.5) * 2.2;
      const s = speed * (0.4 + this.rand() * 0.9);
      const pick = this.rand();
      this.emit({
        x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 0.4, vz: (this.rand() - 0.2) * s * 0.4,
        life: 0.22 + this.rand() * 0.3, size: 3 + this.rand() * 3,
        color: pick < 0.3 ? hot : pick < 0.7 ? mid : c, alpha: 1, shape: S_RECT, stretch: 4 + this.rand() * 3,
        gravity: 5, drag: 2.5,
      });
    }
  }

  /** Soft dust puff (mortar / paper coloured). */
  dust(x: number, y: number, z: number, n: number, tint: string = PAL.mortar, spread = 0.6): void {
    const c = col(tint);
    for (let k = 0; k < n; k++) {
      const a = this.rand() * Math.PI * 2;
      const s = spread * (0.2 + this.rand() * 0.8);
      this.emit({
        x, y, z, vx: Math.cos(a) * s, vy: Math.abs(Math.sin(a)) * s * 0.8 + 0.1, vz: (this.rand() - 0.3) * s * 0.5,
        life: 0.45 + this.rand() * 0.45, size: 10 + this.rand() * 14, color: c, alpha: 0.55, shape: S_SOFT,
        gravity: -0.15, drag: 3, shrink: false,
      });
    }
  }

  /** Brick-coloured confetti burst from the goal (§9.5 success): pops up, then flutters down. */
  confetti(xa: number, xb: number, y0: number, n: number): void {
    const pal = [PAL.brick1, PAL.brick2, PAL.mortar, PAL.gantry, PAL.goal, PAL.stamp, PAL.brick2];
    const cx = (xa + xb) / 2;
    for (let k = 0; k < n; k++) {
      const c = this.tmp.set(pal[Math.floor(this.rand() * pal.length)] as string);
      const a = Math.PI / 2 + (this.rand() - 0.5) * 1.5;
      const s = 2.2 + this.rand() * 2.2;
      this.emit({
        x: cx + (xb - xa) * (this.rand() - 0.5) * 0.6, y: y0 + this.rand() * 0.1, z: 0.05 + this.rand() * 0.3,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: (this.rand() - 0.5) * 0.4,
        life: 1.8 + this.rand() * 1.2, size: 6 + this.rand() * 4, color: c, alpha: 1, shape: S_RECT,
        rot: this.rand() * 6.28, spin: (this.rand() - 0.5) * 14, stretch: 1.6, flutter: 2.5 + this.rand() * 3,
        gravity: 3.2, drag: 2.2, shrink: false,
      });
    }
  }

  /** Speed lines behind a fast ball (fast wall pass). */
  streaks(x: number, y: number, z: number, dir: number, n: number): void {
    const c = col('#FFFFFF');
    for (let k = 0; k < n; k++) {
      this.emit({
        x: x - dir * (0.05 + this.rand() * 0.15), y: y + (this.rand() - 0.5) * 0.12, z,
        vx: -dir * (0.6 + this.rand() * 0.6), vy: 0, vz: 0,
        life: 0.18 + this.rand() * 0.12, size: 10 + this.rand() * 8, color: c, alpha: 0.9, shape: S_RECT,
        stretch: 7, rot: Math.PI / 2, drag: 1,
      });
    }
  }

  /** Twinkles (amplitude reached / goal). */
  sparkle(x: number, y: number, z: number, n: number, tint: string, r = 0.08): void {
    const c = col(tint);
    for (let k = 0; k < n; k++) {
      const a = this.rand() * Math.PI * 2, d = r * Math.sqrt(this.rand());
      this.emit({
        x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, z, vx: Math.cos(a) * 0.15, vy: Math.sin(a) * 0.15 + 0.1, vz: 0,
        life: 0.35 + this.rand() * 0.35, size: 9 + this.rand() * 8, color: c, alpha: 1, shape: S_SPARK,
        rot: this.rand() * 0.8, drag: 2,
      });
    }
  }

  /** Egg crash: yolk and shell bits. */
  yolk(x: number, y: number, z: number): void {
    const yellow = col('#FFC21A'), white = col('#FFFDF5'), shell = col(PAL.egg);
    for (let k = 0; k < 22; k++) {
      const a = this.rand() * Math.PI * 2, s = 0.5 + this.rand() * 1.4;
      const pick = this.rand();
      this.emit({
        x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 0.6, vz: (this.rand() - 0.3) * 0.6,
        life: 0.5 + this.rand() * 0.4, size: pick < 0.5 ? 6 + this.rand() * 6 : 4 + this.rand() * 4,
        color: pick < 0.45 ? yellow : pick < 0.7 ? white : shell, alpha: 1, shape: pick < 0.7 ? S_DISC : S_RECT,
        rot: this.rand() * 6, spin: (this.rand() - 0.5) * 10, stretch: 1.5, gravity: 7, drag: 1.2,
      });
    }
  }
}
