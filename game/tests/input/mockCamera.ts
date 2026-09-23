// A mock of the wide-layout camera and RailMapper (GAME_DESIGN.md §3.3, §9.2) for the input tests. Owner: O4.
//
// PerspectiveCamera FOV 24°, looking down 6°, yaw 4°, placed so that x ∈ [rail0 − 0.3, rail1 + 0.3] and
// y ∈ [−0.35, 1.6] fit below the 56 px HUD band. The mapper intersects the camera ray with the plane z = 0
// using the *reference* (unshaken) camera; the shaken camera is only what the picture is drawn with.
import { PerspectiveCamera, Plane, Ray, Vector2, Vector3 } from 'three';
import type { RailMapper } from '../../src/input/types';

export interface MockView {
  base: PerspectiveCamera;
  shaken: PerspectiveCamera;
  mapper: RailMapper;
  /** World point (x, y, 0) -> client px through the reference camera. */
  toScreen(x: number, y: number, cam?: PerspectiveCamera): { x: number; y: number };
  /** Apply the trauma shake of §9.2 (offset 0.05 m·trauma², roll 1.2°·trauma²) to the shaken camera. */
  shake(trauma: number, phase: number): void;
}

export function mockWideView(rail: [number, number], w = 1280, h = 720, hudTop = 56): MockView {
  const fov = 24, pitch = (6 * Math.PI) / 180, yaw = (4 * Math.PI) / 180;
  const x0 = rail[0] - 0.3, x1 = rail[1] + 0.3, y0 = -0.35, y1 = 1.6;
  // The composition sits in the region below the HUD band (the camera renders that region).
  const viewH = h - hudTop;
  const aspect = w / viewH;
  const halfV = Math.tan((fov * Math.PI) / 360);
  const dist = Math.max((x1 - x0) / 2 / (halfV * aspect), (y1 - y0) / 2 / halfV) * 1.04;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  const base = new PerspectiveCamera(fov, aspect, 0.1, 100);
  base.position.set(cx + dist * Math.sin(yaw) * Math.cos(pitch), cy + dist * Math.sin(pitch), dist * Math.cos(yaw) * Math.cos(pitch));
  base.lookAt(cx, cy, 0);
  base.updateMatrixWorld(true);
  base.updateProjectionMatrix();
  const shaken = base.clone();

  const plane = new Plane(new Vector3(0, 0, 1), 0);
  const ray = new Ray();
  const hit = new Vector3();
  const ndc = new Vector2();

  function toScreen(x: number, y: number, cam = base): { x: number; y: number } {
    const p = new Vector3(x, y, 0).project(cam);
    return { x: ((p.x + 1) / 2) * w, y: hudTop + ((1 - p.y) / 2) * viewH };
  }

  const mapper: RailMapper = {
    screenToRailX(clientX: number, clientY: number): number | null {
      if (clientY < hudTop) return null;
      ndc.set((clientX / w) * 2 - 1, 1 - ((clientY - hudTop) / viewH) * 2);
      ray.origin.setFromMatrixPosition(base.matrixWorld);
      ray.direction.set(ndc.x, ndc.y, 0.5).unproject(base).sub(ray.origin).normalize();
      return ray.intersectPlane(plane, hit) ? hit.x : null;
    },
  };

  function shake(trauma: number, phase: number): void {
    const t2 = trauma * trauma;
    shaken.position.copy(base.position).add(new Vector3(Math.sin(phase * 7.1), Math.cos(phase * 5.3), 0).multiplyScalar(0.05 * t2));
    shaken.quaternion.copy(base.quaternion);
    shaken.rotateZ(((1.2 * Math.PI) / 180) * t2 * Math.sin(phase * 3.7)); // roll about the view axis
    shaken.updateMatrixWorld(true);
  }

  return { base, shaken, mapper, toScreen, shake };
}
