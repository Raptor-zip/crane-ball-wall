// Ball trail and success strobe (GAME_DESIGN.md §9.5). Owner: O5.
//
// While running: a short fading dotted trail behind the ball. Every 0.1 s of simulated time the
// ball position is also kept; on success the trail "freezes" into those stroboscopic ball
// copies, like the strobe photograph on the share card.
import type { Color } from 'three';
import { PAL, col } from './scene';
import { PointsBatch, S_RING } from './particles';
import type { QuadBatch } from './overlays';

/** Trail skin: ribbon colour and width (x today's), strobe copy colour and shape (S_RING or S_DISC). */
export interface TrailStyle { ribbon: Color; width: number; strobe: Color; shape: number }

const RECENT = 40;       // frames of fading trail
const MAX_STROBE = 600;  // 60 s at 10 Hz

export class Trail {
  private readonly rx = new Float32Array(RECENT);
  private readonly ry = new Float32Array(RECENT);
  private head = 0;
  private n = 0;
  private readonly sx = new Float32Array(MAX_STROBE);
  private readonly sy = new Float32Array(MAX_STROBE);
  private ns = 0;
  private simT = 0;
  private nextStrobe = 0;
  private lastBx = NaN;
  private lastBy = NaN;
  frozen = false;
  private freezeT = 0;
  private readonly cRibbon: Color = col(PAL.ball);
  private readonly cStrobe: Color = col(PAL.ball);
  private widthK = 1;
  private strobeShape = S_RING;

  /** Skin: colours are copied (the caller may reuse its Color objects). */
  setLook(s: TrailStyle): void {
    this.cRibbon.copy(s.ribbon);
    this.cStrobe.copy(s.strobe);
    this.widthK = s.width;
    this.strobeShape = s.shape;
  }

  reset(): void {
    this.n = 0;
    this.head = 0;
    this.ns = 0;
    this.simT = 0;
    this.nextStrobe = 0;
    this.frozen = false;
    this.lastBx = NaN;
    this.lastBy = NaN;
  }

  /** Called every frame while the run is live. simDt = dtReal * timeScale. */
  push(bx: number, by: number, simDt: number): void {
    if (this.frozen) return;
    const moved = bx !== this.lastBx || by !== this.lastBy;
    this.lastBx = bx;
    this.lastBy = by;
    if (!moved) return;
    this.rx[this.head] = bx;
    this.ry[this.head] = by;
    this.head = (this.head + 1) % RECENT;
    this.n = Math.min(RECENT, this.n + 1);
    if (this.ns === 0 || this.simT >= this.nextStrobe) {
      if (this.ns < MAX_STROBE) {
        this.sx[this.ns] = bx;
        this.sy[this.ns] = by;
        this.ns++;
      }
      this.nextStrobe += 0.1;
    }
    this.simT += simDt;
  }

  /** Success: keep the strobe copies on screen. */
  freeze(): void {
    this.frozen = true;
    this.freezeT = 0;
  }

  /** Strobe copies after success (points). */
  write(b: PointsBatch, dt: number, ballPx: number): void {
    if (!this.frozen) return;
    this.freezeT += dt;
    const appear = Math.min(1, this.freezeT / 0.35);
    const shown = Math.floor(this.ns * appear);
    for (let i = 0; i < shown; i++) {
      const age = this.ns > 1 ? i / (this.ns - 1) : 1;
      b.add(this.sx[i] as number, this.sy[i] as number, -0.005, Math.max(5, ballPx * (0.38 + 0.12 * age)), this.cStrobe, 0.35 + 0.45 * age, this.strobeShape);
    }
  }

  /** Live motion streak: a tapered ribbon through the recent positions (ink batch). */
  ribbon(b: QuadBatch, width: number, headX: number, headY: number, fade = 1): void {
    if (this.frozen || this.n < 2) return;
    const n = this.n + 1;
    this.px[0] = headX;
    this.py[0] = headY;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - 1 - k + RECENT * 2) % RECENT;
      this.px[k + 1] = this.rx[i] as number;
      this.py[k + 1] = this.ry[i] as number;
    }
    const w = width * this.widthK;
    b.strip(this.px, this.py, n, -0.012, this.cRibbon,
      (i) => w * (0.2 + 0.8 * (1 - i / n)),
      (i) => { const t = 1 - i / n; return 0.34 * t * t * fade; });
  }

  private readonly px = new Float32Array(RECENT + 1);
  private readonly py = new Float32Array(RECENT + 1);
}
