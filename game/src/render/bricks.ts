// Instanced brick walls (GAME_DESIGN.md §9.1). Owner: O5.
//
// Each wall is a slab x0..x1, 0..h, z in [-0.25, 0.25]. It is drawn as a recessed mortar core
// (one merged mesh for all walls) plus bricks 0.24 (z) x rowH (y: 0.06, or 0.1 for block / stone skins) x wall width (x) in running
// bond, as one InstancedMesh (<= 400 instances) with a per-brick hue jitter. Crash debris uses a
// second small InstancedMesh with the same geometry and material.
import {
  BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh,
  MeshLambertMaterial, MeshStandardMaterial, Object3D, Quaternion, Vector3,
} from 'three';
import type { Texture } from 'three';
import type { WallDef } from '../sim/level';
import { PAL, Z_WALL_HALF, col } from './scene';
import { DEFAULT_LOOK } from './skinLooks';
import type { StageLook } from './skinLooks';

const BRICK_Z = 0.24;
const JOINT = 0.009;
const MAX_BRICKS = 400;
export const MAX_DEBRIS = 8;

interface BrickInfo { wall: number; x: number; y: number; z: number; sx: number; sy: number; sz: number }

export interface Bricks {
  readonly group: Group;
  readonly bricks: InstancedMesh;
  readonly mortar: Mesh;
  readonly debris: InstancedMesh;
  /** Knocks out up to n bricks of wall `wall` nearest to (x, y) and launches them as debris. */
  burst(wall: number, x: number, y: number, n: number): void;
  /** Advances the debris (wall-clock seconds, with the §9.5 slow-motion timeline). */
  update(dt: number): void;
  /** Restores knocked-out bricks and clears debris (retry). */
  reset(): void;
  /** Board skin with the same rowH: replays the same jitter draws with its colours; the mortar colour in place. */
  recolor(stage: StageLook): void;
  /** Row height the bricks were laid with (a different rowH needs a rebuild). */
  readonly rowH: number;
  dispose(): void;
}

/** Per-brick colour between a and b with a small hue / saturation / lightness jitter (5 draws of r). */
function jitterColor(r: () => number, out: Color, a: Color, b: Color): Color {
  out.copy(a).lerp(b, r());
  const hsl = { h: 0, s: 0, l: 0 };
  out.getHSL(hsl);
  hsl.h += (r() - 0.5) * 0.035;
  hsl.s *= 0.9 + r() * 0.2;
  hsl.l *= 0.86 + r() * 0.26;
  if (r() < 0.07) hsl.l *= 0.78; // an occasional over-fired brick
  out.setHSL(hsl.h, hsl.s, hsl.l);
  return out;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createBricks(walls: readonly WallDef[], brickTex: Texture, stage: StageLook = DEFAULT_LOOK.stage): Bricks {
  const ROW_H = stage.rowH;
  const group = new Group();
  const geo = new BoxGeometry(1, 1, 1);
  const mat = new MeshStandardMaterial({ map: brickTex, roughness: 0.92, metalness: 0 });
  const bricks = new InstancedMesh(geo, mat, MAX_BRICKS);
  bricks.castShadow = true;
  bricks.receiveShadow = true;
  bricks.frustumCulled = false;
  const info: BrickInfo[] = [];
  const o = new Object3D();
  const c = new Color();
  const c1 = new Color(), c2 = new Color();
  /** Instance colours: the same rng(7) sequence over `info` in order, whatever the colours. */
  const paint = (st: StageLook): void => {
    const r = rng(7);
    c1.set(st.brick1);
    c2.set(st.brick2);
    info.forEach((_, i) => bricks.setColorAt(i, jitterColor(r, c, c1, c2)));
    if (bricks.instanceColor) bricks.instanceColor.needsUpdate = true;
  };

  walls.forEach((w, wi) => {
    const rows = Math.max(1, Math.round(w.h / ROW_H));
    const rh = w.h / rows;
    const cx = (w.x0 + w.x1) / 2, sx = w.x1 - w.x0 - 0.004;
    for (let k = 0; k < rows; k++) {
      const y = (k + 0.5) * rh;
      // Running bond along z: even rows 2 full bricks, odd rows half + full + half.
      const spans: [number, number][] = k % 2 === 0
        ? [[-Z_WALL_HALF, 0], [0, Z_WALL_HALF]]
        : [[-Z_WALL_HALF, -BRICK_Z / 2], [-BRICK_Z / 2, BRICK_Z / 2], [BRICK_Z / 2, Z_WALL_HALF]];
      for (const [za, zb] of spans) {
        if (info.length >= MAX_BRICKS) break;
        const bz = (za + zb) / 2, lz = zb - za - JOINT;
        info.push({ wall: wi, x: cx, y, z: bz, sx, sy: rh - JOINT, sz: lz });
      }
    }
  });
  info.forEach((b, i) => {
    o.position.set(b.x, b.y, b.z);
    o.scale.set(b.sx, b.sy, b.sz);
    o.rotation.set(0, 0, 0);
    o.updateMatrix();
    bricks.setMatrixAt(i, o.matrix);
  });
  paint(stage);
  bricks.count = info.length;
  bricks.instanceMatrix.needsUpdate = true;
  group.add(bricks);

  // Mortar cores (recessed a few mm so the joints read as grooves).
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const box = new BoxGeometry(1, 1, 1);
  const bp = box.getAttribute('position'), bn = box.getAttribute('normal'), bi = box.getIndex();
  for (const w of walls) {
    const base = P.length / 3;
    const sx = w.x1 - w.x0 - 0.012, sy = w.h - 0.004, sz = 2 * Z_WALL_HALF - 0.012;
    const cx = (w.x0 + w.x1) / 2, cy = sy / 2;
    for (let i = 0; i < bp.count; i++) {
      P.push(cx + bp.getX(i) * sx, cy + bp.getY(i) * sy, bp.getZ(i) * sz);
      N.push(bn.getX(i), bn.getY(i), bn.getZ(i));
    }
    if (bi) for (let i = 0; i < bi.count; i++) I.push(base + bi.getX(i));
  }
  box.dispose();
  const mortarGeo = new BufferGeometry();
  mortarGeo.setAttribute('position', new Float32BufferAttribute(P, 3));
  mortarGeo.setAttribute('normal', new Float32BufferAttribute(N, 3));
  mortarGeo.setIndex(I);
  const mortar = new Mesh(mortarGeo, new MeshLambertMaterial({ color: col(stage.mortar) }));
  mortar.receiveShadow = true;
  mortar.visible = walls.length > 0;
  group.add(mortar);

  // Debris.
  const debris = new InstancedMesh(geo, mat, MAX_DEBRIS);
  debris.count = 0;
  debris.castShadow = true;
  debris.frustumCulled = false;
  group.add(debris);
  const hidden: number[] = [];
  const dPos: Vector3[] = [], dVel: Vector3[] = [], dSpin: Vector3[] = [], dScale: Vector3[] = [];
  const dRot: Quaternion[] = [];
  let dT = -1;
  const q = new Quaternion(), qs = new Quaternion(), m = new Matrix4(), v = new Vector3(), e = new Vector3();
  const zeroM = new Matrix4().makeScale(0, 0, 0);

  const restore = (): void => {
    for (const i of hidden) {
      const b = info[i] as BrickInfo;
      o.position.set(b.x, b.y, b.z);
      o.scale.set(b.sx, b.sy, b.sz);
      o.rotation.set(0, 0, 0);
      o.updateMatrix();
      bricks.setMatrixAt(i, o.matrix);
    }
    if (hidden.length) bricks.instanceMatrix.needsUpdate = true;
    hidden.length = 0;
    debris.count = 0;
    dT = -1;
  };

  return {
    group, bricks, mortar, debris,
    burst(wall, x, y, n) {
      restore();
      const cand = info
        .map((b, i) => ({ i, b, d: (b.x - x) ** 2 + (b.y - y) ** 2 + 0.3 * (b.z - 0.12) ** 2 }))
        .filter((c) => c.b.wall === wall)
        .sort((a, b) => a.d - b.d)
        .slice(0, Math.min(n, MAX_DEBRIS));
      const rr = rng(Math.floor(x * 1000) ^ Math.floor(y * 977));
      cand.forEach((cnd, k) => {
        hidden.push(cnd.i);
        bricks.setMatrixAt(cnd.i, zeroM);
        const b = cnd.b;
        dPos[k] = new Vector3(b.x, b.y, b.z);
        const away = Math.sign(b.x - x) || (rr() < 0.5 ? -1 : 1);
        dVel[k] = new Vector3(away * (0.6 + rr() * 1.1), 0.9 + rr() * 1.6, 0.4 + rr() * 1.4);
        dSpin[k] = new Vector3((rr() - 0.5) * 16, (rr() - 0.5) * 16, (rr() - 0.5) * 16);
        dRot[k] = new Quaternion();
        dScale[k] = new Vector3(b.sx, b.sy, b.sz);
        debris.setColorAt(k, bricks.instanceColor ? c.fromBufferAttribute(bricks.instanceColor, cnd.i) : c.set(PAL.brick1));
      });
      bricks.instanceMatrix.needsUpdate = true;
      debris.count = cand.length;
      if (debris.instanceColor) debris.instanceColor.needsUpdate = true;
      dT = 0;
    },
    update(dt) {
      if (dT < 0 || debris.count === 0) return;
      dT += dt;
      // §9.5: 80 ms hit-stop, 0.25 s at 0.35x, then 1x for 0.35 s, fading at the end.
      const scale = dT < 0.08 ? 0 : dT < 0.33 ? 0.35 : 1;
      const h = dt * scale;
      const fade = dT < 0.58 ? 1 : Math.max(0, 1 - (dT - 0.58) / 0.12);
      for (let k = 0; k < debris.count; k++) {
        const p = dPos[k] as Vector3, vel = dVel[k] as Vector3, sp = dSpin[k] as Vector3, rot = dRot[k] as Quaternion;
        vel.y -= 9.81 * h;
        p.addScaledVector(vel, h);
        const half = (dScale[k] as Vector3).y / 2;
        if (p.y < half) {
          p.y = half;
          vel.y = Math.abs(vel.y) * 0.3;
          vel.x *= 0.6;
          vel.z *= 0.6;
          sp.multiplyScalar(0.6);
        }
        e.copy(sp).multiplyScalar(h);
        qs.setFromAxisAngle(v.copy(e).normalize(), e.length());
        if (e.lengthSq() > 0) rot.premultiply(qs);
        q.copy(rot);
        m.compose(p, q, v.copy(dScale[k] as Vector3).multiplyScalar(fade));
        debris.setMatrixAt(k, m);
      }
      debris.instanceMatrix.needsUpdate = true;
      if (fade <= 0) debris.count = 0;
    },
    reset: restore,
    rowH: ROW_H,
    recolor(st) {
      paint(st);
      (mortar.material as MeshLambertMaterial).color.set(st.mortar);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      mortarGeo.dispose();
      (mortar.material as MeshLambertMaterial).dispose();
      bricks.dispose();
      debris.dispose();
    },
  };
}
