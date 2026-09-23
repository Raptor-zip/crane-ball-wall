// Screen -> rail x mapping against the unshaken reference camera (GAME_DESIGN.md §3.3). Owner: O5.
//
// x_t = x of the intersection of the camera ray through (clientX, clientY) with the plane z = 0.
// The reference camera is the base camera BEFORE shake, so the target never moves with the shake.
import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { RailMapper } from '../input/types';
import type { Rect } from './renderer';

export function createRailMapper(getCamera: () => PerspectiveCamera | null, getRect: () => Rect | null): RailMapper {
  const p = new Vector3();
  const o = new Vector3();
  return {
    screenToRailX(clientX: number, clientY: number): number | null {
      const cam = getCamera();
      const r = getRect();
      if (!cam || !r || r.w <= 0 || r.h <= 0) return null;
      const nx = ((clientX - r.x) / r.w) * 2 - 1;
      const ny = -(((clientY - r.y) / r.h) * 2 - 1);
      o.setFromMatrixPosition(cam.matrixWorld);
      p.set(nx, ny, 0.5).unproject(cam).sub(o);
      if (Math.abs(p.z) < 1e-9) return null;
      const t = -o.z / p.z;
      if (!(t > 0) || !Number.isFinite(t)) return null;
      return o.x + p.x * t;
    },
  };
}
