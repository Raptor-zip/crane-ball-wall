// Gantry, trolley and hook models (GAME_DESIGN.md §9.1). Owner: O5.
//
// Gantry: I-beam with its underside at y = 1.30 (0.10 tall), legs 0.15 m outside the rail ends at
// z = -0.40 (behind the walls), joined to the beam by arms running back in z. The trolley hangs
// from the lower flange: wheels at z = +-0.08, y = 1.32; body 0.24 x 0.05 x 0.20 at y 1.25..1.30;
// the hook (string pivot) at the body's underside centre, y = 1.25; nothing hangs lower. Rail-end bumpers are one
// InstancedMesh with the hazard stripe texture and flex on StopHit.
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4,
  Mesh, MeshStandardMaterial, Object3D, Quaternion, TorusGeometry, Vector3,
} from 'three';
import type { Texture } from 'three';
import { PAL, Z_GANTRY_LEG, col } from './scene';

export const BEAM_BOTTOM = 1.3;
export const BEAM_TOP = 1.4;
export const HOOK_Y = 1.25;
export const TROLLEY_HALF_W = 0.12;
export const BUMPER_W = 0.09;

/** Merges primitives with per-vertex colours into one BufferGeometry. */
class Builder {
  private readonly P: number[] = [];
  private readonly N: number[] = [];
  private readonly C: number[] = [];
  private readonly I: number[] = [];
  private readonly m = new Matrix4();
  private readonly nm = new Matrix4();
  private readonly v = new Vector3();

  add(g: BufferGeometry, pos: Vector3, rot: Quaternion | null, scale: Vector3 | null, c: Color): void {
    this.m.compose(pos, rot ?? new Quaternion(), scale ?? new Vector3(1, 1, 1));
    this.nm.copy(this.m).invert().transpose();
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), idx = g.getIndex();
    const base = this.P.length / 3;
    for (let i = 0; i < p.count; i++) {
      this.v.fromBufferAttribute(p, i).applyMatrix4(this.m);
      this.P.push(this.v.x, this.v.y, this.v.z);
      this.v.fromBufferAttribute(n, i).transformDirection(this.nm);
      this.N.push(this.v.x, this.v.y, this.v.z);
      this.C.push(c.r, c.g, c.b);
    }
    if (idx) for (let i = 0; i < idx.count; i++) this.I.push(base + idx.getX(i));
    else for (let i = 0; i < p.count; i++) this.I.push(base + i);
    g.dispose();
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: Color): void {
    this.add(new BoxGeometry(1, 1, 1), new Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), null,
      new Vector3(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), c);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.C, 3));
    g.setIndex(this.I);
    return g;
  }
}

const xAxis = new Vector3(1, 0, 0);

function trolleyGeometry(): BufferGeometry {
  const b = new Builder();
  const body = col('#33405C'), bodyTop = col('#46557A'), plate = col('#26314A');
  const tyre = col('#1B1F27'), hub = col('#B8C0CA'), steel = col('#9AA3AE'), accent = col(PAL.ball);
  const hw = TROLLEY_HALF_W;
  // Body with a lighter top chamfer strip.
  b.box(-hw, 1.25, -0.1, hw, 1.293, 0.1, body);
  b.box(-hw + 0.004, 1.293, -0.097, hw - 0.004, 1.3, 0.097, bodyTop);
  // Front face details: accent stripe and 4 bolts.
  b.box(-hw + 0.02, 1.262, 0.1, hw - 0.02, 1.268, 0.1025, accent);
  for (const x of [-hw + 0.022, hw - 0.022]) {
    for (const y of [1.258, 1.285]) {
      const q = new Quaternion().setFromAxisAngle(xAxis, Math.PI / 2);
      b.add(new CylinderGeometry(0.0045, 0.0045, 0.004, 10), new Vector3(x, y, 0.1015), q, null, steel);
    }
  }
  // Side plates carrying the axles above the flange.
  for (const z of [-0.096, 0.096]) b.box(-0.105, 1.296, z - 0.004, 0.105, 1.345, z + 0.004, plate);
  // Wheels (axis along z) resting on the lower flange.
  for (const x of [-0.075, 0.075]) {
    for (const z of [-0.08, 0.08]) {
      const q = new Quaternion().setFromAxisAngle(xAxis, Math.PI / 2);
      b.add(new CylinderGeometry(0.0155, 0.0155, 0.012, 18), new Vector3(x, 1.3205, z), q, null, tyre);
      b.add(new CylinderGeometry(0.0065, 0.0065, 0.0135, 10), new Vector3(x, 1.3205, z), q, null, hub);
    }
  }
  // Hook: an eye bolt on the front face whose lowest point is the pivot at y = 1.25 (§9.1: no part
  // reaches lower than 1.25, 5 cm under the beam), plus a small boss marking the pivot underneath.
  b.add(new TorusGeometry(0.0075, 0.0024, 8, 16), new Vector3(0, 1.25 + 0.0075 + 0.0024, 0.1022), null, null, steel);
  b.box(-0.006, 1.25, -0.006, 0.006, 1.2515, 0.006, steel);
  return b.build();
}

function gantryGeometry(rail: [number, number]): BufferGeometry {
  const b = new Builder();
  const yellow = col(PAL.gantry), yellowDark = col('#D99F00'), railC = col(PAL.rail), foot = col('#4B5563');
  const legX = [rail[0] - 0.15, rail[1] + 0.15];
  const xa = (legX[0] as number) - 0.05, xb = (legX[1] as number) + 0.05;
  // I-beam: lower flange (running rail), web, top flange.
  b.box(xa, BEAM_BOTTOM, -0.09, xb, BEAM_BOTTOM + 0.006, 0.09, railC);
  b.box(xa, BEAM_BOTTOM + 0.006, -0.016, xb, BEAM_TOP - 0.008, 0.016, yellow);
  b.box(xa, BEAM_TOP - 0.008, -0.07, xb, BEAM_TOP, 0.07, yellow);
  // Stiffener ribs every 0.5 m on the web (visible between flanges).
  for (let x = Math.ceil(xa * 2) / 2; x <= xb; x += 0.5) {
    b.box(x - 0.005, BEAM_BOTTOM + 0.006, -0.06, x + 0.005, BEAM_TOP - 0.008, 0.06, yellowDark);
  }
  // End caps.
  for (const x of [xa, xb]) b.box(x - 0.006, BEAM_BOTTOM, -0.075, x + 0.006, BEAM_TOP, 0.075, yellowDark);
  for (const lx of legX) {
    // Arm from the beam back to the leg top.
    b.box(lx - 0.035, BEAM_TOP - 0.07, Z_GANTRY_LEG - 0.035, lx + 0.035, BEAM_TOP, 0.0, yellow);
    // Leg.
    b.box(lx - 0.035, 0.012, Z_GANTRY_LEG - 0.035, lx + 0.035, BEAM_TOP, Z_GANTRY_LEG + 0.035, yellow);
    // Knee brace in the y-z plane.
    const p0 = new Vector3(lx, 1.02, Z_GANTRY_LEG), p1 = new Vector3(lx, BEAM_TOP - 0.035, -0.12);
    const d = p1.clone().sub(p0);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize());
    b.add(new BoxGeometry(0.03, 1, 0.03), p0.clone().add(p1).multiplyScalar(0.5), q, new Vector3(1, d.length(), 1), yellowDark);
    // Foot plate and bolts.
    b.box(lx - 0.085, 0, Z_GANTRY_LEG - 0.085, lx + 0.085, 0.012, Z_GANTRY_LEG + 0.085, foot);
    // Hazard-free cap on the leg top.
    b.box(lx - 0.04, BEAM_TOP, Z_GANTRY_LEG - 0.04, lx + 0.04, BEAM_TOP + 0.008, Z_GANTRY_LEG + 0.04, yellowDark);
  }
  return b.build();
}

export interface Crane {
  readonly group: Group;
  readonly gantry: Mesh;
  readonly trolley: Mesh;
  readonly bumpers: InstancedMesh;
  setRail(rail: [number, number]): void;
  setTrolleyX(x: number): void;
  /** Bumper flex impulse on side -1 / +1 with strength 0..1. */
  hit(side: -1 | 1, strength: number): void;
  update(dt: number): void;
  reset(): void;
  dispose(): void;
}

export function createCrane(hazard: Texture, env: Texture | null): Crane {
  const group = new Group();
  const paint = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.08, envMap: env, envMapIntensity: 0.55 });
  const gantry = new Mesh(new BufferGeometry(), paint);
  gantry.castShadow = true;
  gantry.receiveShadow = true;
  const tMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.25, envMap: env, envMapIntensity: 0.8 });
  const trolley = new Mesh(trolleyGeometry(), tMat);
  trolley.castShadow = true;
  const bMat = new MeshStandardMaterial({ map: hazard, roughness: 0.5, metalness: 0.05 });
  hazard.repeat.set(0.5, 1);
  const bumpers = new InstancedMesh(new BoxGeometry(1, 1, 1), bMat, 2);
  bumpers.castShadow = true;
  bumpers.frustumCulled = false;
  group.add(gantry, trolley, bumpers);
  let railR: [number, number] = [-1, 3.2];
  const flex = [0, 0], flexV = [0, 0];
  const o = new Object3D();

  const placeBumpers = (): void => {
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const f = Math.max(-0.2, Math.min(0.55, flex[i] as number));
      const w = BUMPER_W * (1 - f);
      const outer = side < 0 ? railR[0] - TROLLEY_HALF_W - BUMPER_W : railR[1] + TROLLEY_HALF_W + BUMPER_W;
      const cx = outer - side * (w / 2);
      o.position.set(cx, 1.268, 0);
      o.scale.set(w, 0.064 * (1 + f * 0.25), 0.18 * (1 + f * 0.15));
      o.updateMatrix();
      bumpers.setMatrixAt(i, o.matrix);
    }
    bumpers.instanceMatrix.needsUpdate = true;
  };

  return {
    group, gantry, trolley, bumpers,
    setRail(rail) {
      railR = [rail[0], rail[1]];
      gantry.geometry.dispose();
      gantry.geometry = gantryGeometry(railR);
      flex[0] = flex[1] = flexV[0] = flexV[1] = 0;
      placeBumpers();
    },
    setTrolleyX(x) {
      trolley.position.x = x;
    },
    hit(side, strength) {
      const i = side < 0 ? 0 : 1;
      flexV[i] = (flexV[i] as number) + 9 * strength;
    },
    update(dt) {
      // Damped spring back to rest (underdamped for a rubbery wobble).
      const k = 900, c = 22;
      const steps = Math.max(1, Math.ceil(dt / 0.004));
      const h = dt / steps;
      let moving = false;
      for (let s = 0; s < steps; s++) {
        for (let i = 0; i < 2; i++) {
          const a = -k * (flex[i] as number) - c * (flexV[i] as number);
          flexV[i] = (flexV[i] as number) + a * h;
          flex[i] = (flex[i] as number) + (flexV[i] as number) * h;
          if (Math.abs(flex[i] as number) > 1e-4 || Math.abs(flexV[i] as number) > 1e-3) moving = true;
        }
      }
      if (moving) placeBumpers();
    },
    reset() {
      flex[0] = flex[1] = flexV[0] = flexV[1] = 0;
      placeBumpers();
    },
    dispose() {
      gantry.geometry.dispose();
      trolley.geometry.dispose();
      bumpers.geometry.dispose();
      paint.dispose();
      tMat.dispose();
      bMat.dispose();
    },
  };
}

