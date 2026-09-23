// Scene graph setup: palette, lights, environment, back board, floor, goal glow, blob shadows
// (GAME_DESIGN.md §9.1). Owner: O5.
import {
  BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute,
  HemisphereLight, InstancedBufferAttribute, InstancedMesh, Mesh, MeshBasicMaterial, MeshLambertMaterial, NormalBlending,
  Object3D, PlaneGeometry, Scene, ShaderMaterial,
} from 'three';
import type { Texture } from 'three';
import type { ZoneDef } from '../sim/level';
import type { Textures } from './textures';
import { DEFAULT_LOOK } from './skinLooks';
import type { StageLook } from './skinLooks';

/** §9.1 palette (same values as src/ui/tokens.css). */
export const PAL = {
  paper1: '#F3EEE4', paper2: '#E6DCCB', floor: '#D9D4CB', grid: '#C9C2B6',
  brick1: '#B5553A', brick2: '#C8643F', mortar: '#E8DCC8',
  gantry: '#F2B705', hazard: '#1E1E1E', rail: '#6B7280',
  ball: '#E0312B', string: '#2B2B2B', egg: '#F4EAD5', eggSpeckle: '#C9B89A',
  ink: '#1E2A44', goal: '#22B573', danger: '#E5484D',
  ai: '#19C3FF', pb: '#FFC23D', wr: '#FF3FA4', rival: '#FF8A3D', challenge: '#FFFFFF',
  amber: '#F59E0B', stamp: '#D8342B',
} as const;

/** Linear-space THREE.Color for a palette hex (ColorManagement converts from sRGB). */
export function col(hex: string): Color {
  return new Color(hex);
}

// Fixed world layout (§9.1).
export const Z_BOARD = -0.6;
export const Z_FLOOR_FRONT = 0.32;
export const Z_WALL_HALF = 0.25;
export const Z_GANTRY_LEG = -0.4;
export const Z_GHOST = -0.12;
export const FINGER_BAND = 0.35;

export interface Stage {
  readonly scene: Scene;
  readonly key: DirectionalLight;
  readonly board: Mesh;
  readonly floor: Mesh;
  /** Shadow frustum around the level's x range. */
  fitShadow(x0: number, x1: number): void;
  setShadows(on: boolean): void;
  /** Board skin: background, the board's paper-1 -> paper-2 shading (at the last fitted range), the floor tint. */
  setLook(stage: StageLook): void;
  dispose(): void;
}

export function createScene(tex: Textures, look: StageLook = DEFAULT_LOOK.stage): Stage {
  let st = look;
  const scene = new Scene();
  scene.background = col(st.paper1);

  const hemi = new HemisphereLight(col('#FFF8EE'), col('#CDBFA8'), 1.35);
  scene.add(hemi);
  const key = new DirectionalLight(col('#FFF0DA'), 1.85);
  key.position.set(-1.1, 5.2, 2.2);
  key.target.position.set(1.2, 0.4, 0);
  scene.add(key, key.target);
  const fill = new DirectionalLight(col('#E4EEFF'), 0.35);
  fill.position.set(4, 1.5, 3);
  scene.add(fill);
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.012;

  // Back board (paper + graph grid), z = -0.6. UVs are world metres so the 1 m tile aligns.
  // Vertex colours add a soft vignette around the level and a contact shade above the floor.
  const BX0 = -5, BX1 = 9, BY0 = -1, BY1 = 6;
  const boardGeo = new PlaneGeometry(BX1 - BX0, BY1 - BY0, 56, 28);
  {
    const uv = boardGeo.getAttribute('uv') as BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, BX0 + uv.getX(i) * (BX1 - BX0), BY0 + uv.getY(i) * (BY1 - BY0));
    boardGeo.setAttribute('color', new Float32BufferAttribute(new Float32Array(uv.count * 3), 3));
  }
  tex.paper.repeat.set(1, 1);
  // Unlit so the paper keeps the exact palette; vertex colours carry the paper-1 -> paper-2 gradient.
  const board = new Mesh(boardGeo, new MeshBasicMaterial({ map: tex.paper, vertexColors: true }));
  board.position.set((BX0 + BX1) / 2, (BY0 + BY1) / 2, Z_BOARD);
  board.receiveShadow = false;
  scene.add(board);
  let shadeAt: [number, number] = [1.1, 2.6];
  const shadeBoard = (cx: number, halfW: number): void => {
    shadeAt = [cx, halfW];
    const p = boardGeo.getAttribute('position') as BufferAttribute;
    const c = boardGeo.getAttribute('color') as BufferAttribute;
    const ss = (a: number, b: number, x: number): number => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const p1 = col(st.paper1), p2 = col(st.paper2);
    const r2 = p2.r / p1.r, g2 = p2.g / p1.g, b2 = p2.b / p1.b;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + (BX0 + BX1) / 2, y = p.getY(i) + (BY0 + BY1) / 2;
      const dx = Math.abs(x - cx) / halfW;
      // 0 at the level centre -> 1 towards the edges and the top of the board.
      const t = Math.min(1, 0.85 * ss(0.35, 1.25, dx) + 0.55 * ss(1.2, 3.4, y));
      let k = 1 - 0.14 * (1 - ss(0.0, 0.42, y)); // contact shade where the board meets the floor
      k *= 1.02;
      c.setXYZ(i, k * (1 + (r2 - 1) * t), k * (1 + (g2 - 1) * t), k * (1 + (b2 - 1) * t));
    }
    c.needsUpdate = true;
  };
  shadeBoard(1.1, 2.6);

  // Floor: top (y = 0) and the front cross-section (the "finger band", §9.2) in one mesh.
  // Vertex colours: the top reads light, the cross-section darkens downward like a bench edge.
  const fz0 = Z_BOARD, fz1 = Z_FLOOR_FRONT;
  const pos: number[] = [], nrm: number[] = [], uvs: number[] = [], cols: number[] = [], idx: number[] = [], shades: number[] = [];
  const tint = (kk: number, t: StageLook['floorTint']): [number, number, number] => [kk * t[0], kk * t[1], kk * t[2]];
  const quad = (v: number[][], n: number[], uv: number[][], k: number[]): void => {
    const b = pos.length / 3;
    v.forEach((p, i) => {
      pos.push(p[0] as number, p[1] as number, p[2] as number);
      nrm.push(n[0] as number, n[1] as number, n[2] as number);
      uvs.push((uv[i] as number[])[0] as number, (uv[i] as number[])[1] as number);
      const kk = k[i] as number;
      shades.push(kk);
      cols.push(...tint(kk, st.floorTint));
    });
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  quad([[BX0, 0, fz0], [BX1, 0, fz0], [BX1, 0, fz1], [BX0, 0, fz1]], [0, 1, 0],
    [[BX0, -fz0], [BX1, -fz0], [BX1, -fz1], [BX0, -fz1]], [0.97, 0.97, 1.03, 1.03]);
  const rows = [0, -0.018, -0.35, -1.0, -3.0], shade = [1.12, 1.02, 1.0, 0.9, 0.84];
  for (let r = 0; r + 1 < rows.length; r++) {
    const y0 = rows[r] as number, y1 = rows[r + 1] as number;
    quad([[BX0, y0, fz1], [BX1, y0, fz1], [BX1, y1, fz1], [BX0, y1, fz1]], [0, 0, 1],
      [[BX0, y0], [BX1, y0], [BX1, y1], [BX0, y1]], [shade[r] as number, shade[r] as number, shade[r + 1] as number, shade[r + 1] as number]);
  }
  const floorGeo = new BufferGeometry();
  floorGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  floorGeo.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  floorGeo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  floorGeo.setAttribute('color', new Float32BufferAttribute(cols, 3));
  floorGeo.setIndex(idx);
  const floor = new Mesh(floorGeo, new MeshLambertMaterial({ map: tex.floor, vertexColors: true }));
  floor.receiveShadow = true;
  scene.add(floor);

  return {
    scene, key, board, floor,
    fitShadow(x0: number, x1: number) {
      const cx = (x0 + x1) / 2;
      shadeBoard(cx, (x1 - x0) / 2);
      key.target.position.set(cx, 0.5, 0);
      key.position.set(cx - 1.1, 5.2, 2.2);
      const cam = key.shadow.camera;
      const half = (x1 - x0) / 2 + 0.8;
      cam.left = -half;
      cam.right = half;
      cam.top = 2.2;
      cam.bottom = -2.2;
      cam.near = 0.5;
      cam.far = 14;
      cam.updateProjectionMatrix();
    },
    setShadows(on: boolean) {
      key.castShadow = on;
    },
    setLook(next: StageLook) {
      st = next;
      (scene.background as Color).set(st.paper1);
      shadeBoard(shadeAt[0], shadeAt[1]);
      const c = floorGeo.getAttribute('color') as BufferAttribute;
      for (let i = 0; i < shades.length; i++) {
        const [r, g, b] = tint(shades[i] as number, st.floorTint);
        c.setXYZ(i, r, g, b);
      }
      c.needsUpdate = true;
    },
    dispose() {
      boardGeo.dispose();
      floorGeo.dispose();
      (board.material as MeshBasicMaterial).dispose();
      (floor.material as MeshLambertMaterial).dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Goal glow: hatched pad on the floor + a light curtain in the ball plane + bright edge posts.
// One mesh for all phases; the active phase is bright, others dim.

const GOAL_VS = /* glsl */ `
attribute float aZone;
attribute float aKind;
attribute vec2 aUv;
varying float vZone;
varying float vKind;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vZone = aZone; vKind = aKind; vUv = aUv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GOAL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uActive;
uniform float uHold;
uniform float uTime;
uniform float uFlash;
uniform float uReady;
uniform float uWobble;
varying float vZone;
varying float vKind;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float act = abs(vZone - uActive) < 0.5 ? 1.0 : 0.3;
  float a = 0.0;
  vec3 c = uColor;
  if (vKind < 0.5) {
    // Floor plate with drafting hatch.
    float h = step(0.55, fract((vWorld.x + vWorld.z) * 14.0));
    float edge = smoothstep(0.035, 0.0, min(vUv.x, 1.0 - vUv.x));
    a = (0.22 + 0.18 * h + 0.55 * edge) * act;
    a += uFlash * 0.4;
    c = mix(c, vec3(1.0), 0.15 * h);
  } else if (vKind < 1.5) {
    // Curtain: fades upward, fills with the hold progress.
    float v = vUv.y;
    float base = pow(1.0 - v, 2.2) * (0.16 + 0.05 * sin(uTime * 3.0 + vWorld.x * 6.0) * uReady);
    float fill = step(v, uHold * 0.85) * (0.10 + 0.25 * (1.0 - v));
    float edges = smoothstep(0.02, 0.0, min(vUv.x, 1.0 - vUv.x)) * (1.0 - v) * 0.35;
    a = (base + fill + edges + uHold * 0.08) * act + uFlash * (1.0 - v) * 0.5;
    // HoldReset ("so close"): the curtain shivers for a moment.
    a *= 1.0 - uWobble * (0.5 + 0.5 * sin(uTime * 48.0));
  } else {
    a = 0.85 * act;
    c = mix(uColor, vec3(0.05, 0.35, 0.2), 0.25);
  }
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

export interface Goal {
  readonly mesh: Mesh;
  set(zones: readonly ZoneDef[], L: number): void;
  update(active: number, hold: number, time: number, flash: number, ready: boolean, wobble?: number): void;
  dispose(): void;
}

export function createGoal(): Goal {
  const mat = new ShaderMaterial({
    vertexShader: GOAL_VS,
    fragmentShader: GOAL_FS,
    uniforms: {
      uColor: { value: col(PAL.goal) }, uActive: { value: 0 }, uHold: { value: 0 },
      uTime: { value: 0 }, uFlash: { value: 0 }, uReady: { value: 1 }, uWobble: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
  });
  const mesh = new Mesh(new BufferGeometry(), mat);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return {
    mesh,
    set(zones, L) {
      const P: number[] = [], Z: number[] = [], K: number[] = [], U: number[] = [], I: number[] = [];
      const quad = (pts: number[], zone: number, kind: number): void => {
        const b = P.length / 3;
        P.push(...pts);
        for (let i = 0; i < 4; i++) {
          Z.push(zone);
          K.push(kind);
        }
        U.push(0, 0, 1, 0, 1, 1, 0, 1);
        I.push(b, b + 1, b + 2, b, b + 2, b + 3);
      };
      const hang = Math.max(0.35, 1.25 - L + 0.35);
      zones.forEach((z, i) => {
        quad([z.xa, 0.004, Z_FLOOR_FRONT - 0.01, z.xb, 0.004, Z_FLOOR_FRONT - 0.01, z.xb, 0.004, -0.22, z.xa, 0.004, -0.22], i, 0);
        quad([z.xa, 0.0, 0.0, z.xb, 0.0, 0.0, z.xb, hang, 0.0, z.xa, hang, 0.0], i, 1);
        const w = 0.006;
        for (const x of [z.xa, z.xb]) {
          quad([x - w, -0.005, Z_FLOOR_FRONT + 0.002, x + w, -0.005, Z_FLOOR_FRONT + 0.002, x + w, 0.09, Z_FLOOR_FRONT + 0.002, x - w, 0.09, Z_FLOOR_FRONT + 0.002], i, 2);
        }
      });
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(P, 3));
      g.setAttribute('aZone', new Float32BufferAttribute(Z, 1));
      g.setAttribute('aKind', new Float32BufferAttribute(K, 1));
      g.setAttribute('aUv', new Float32BufferAttribute(U, 2));
      g.setIndex(I);
      mesh.geometry.dispose();
      mesh.geometry = g;
    },
    update(active, hold, time, flash, ready, wobble = 0) {
      const u = mat.uniforms;
      (u.uWobble as { value: number }).value = wobble;
      (u.uActive as { value: number }).value = active;
      (u.uHold as { value: number }).value = hold;
      (u.uTime as { value: number }).value = time;
      (u.uFlash as { value: number }).value = flash;
      (u.uReady as { value: number }).value = ready ? 1 : 0;
    },
    dispose() {
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Blob shadows (low quality, §9.1): under the ball on the floor and on the wall top below it.

const BLOB_VS = /* glsl */ `
attribute float aStr;
varying float vStr;
varying vec2 vUv;
void main() {
  vStr = aStr; vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const BLOB_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying float vStr;
varying vec2 vUv;
void main() {
  float a = texture2D(uMap, vUv).a * vStr;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

export interface Blobs {
  readonly mesh: InstancedMesh;
  /** Places blob i at (x, y) with a diameter and strength 0..1 (0 hides). */
  set(i: number, x: number, y: number, d: number, strength: number): void;
  /** Shadow colour (board skin). */
  setColor(hex: string): void;
  dispose(): void;
}

export function createBlobs(soft: Texture, color: string = DEFAULT_LOOK.stage.blob): Blobs {
  const N = 3;
  const geo = new PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const str = new InstancedBufferAttribute(new Float32Array(N), 1);
  geo.setAttribute('aStr', str);
  const mat = new ShaderMaterial({
    vertexShader: BLOB_VS, fragmentShader: BLOB_FS,
    uniforms: { uMap: { value: soft }, uColor: { value: col(color) } },
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new InstancedMesh(geo, mat, N);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  const o = new Object3D();
  return {
    mesh,
    set(i, x, y, d, strength) {
      o.position.set(x, y + 0.002, 0.02);
      const s = strength > 0.01 ? d : 0;
      o.scale.set(s, 1, s * 0.75);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      str.setX(i, strength);
      str.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
    },
    setColor(hex) {
      ((mat.uniforms.uColor as { value: Color }).value).set(hex);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Crash vignette (§9.5 "赤いビネット"): a screen-space quad with a red edge falloff, drawn last.
// Invisible (no draw call) unless a crash is on screen. No post-processing pass (§9.7).

const VIG_VS = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
const VIG_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying vec2 vP;
void main() {
  // Edges and corners only: ~0.12 at the middle of an edge, ~0.5 in the corners, clear centre.
  float k = smoothstep(0.6, 1.42, length(vP));
  float a = uStrength * 0.5 * k * k;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

export interface Vignette {
  readonly mesh: Mesh;
  /** 0 hides the quad. */
  set(strength: number): void;
  dispose(): void;
}

export function createVignette(): Vignette {
  const geo = new PlaneGeometry(2, 2);
  const mat = new ShaderMaterial({
    vertexShader: VIG_VS, fragmentShader: VIG_FS,
    uniforms: { uColor: { value: col('#C81E28') }, uStrength: { value: 0 } },
    transparent: true, depthTest: false, depthWrite: false,
  });
  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.visible = false;
  return {
    mesh,
    set(strength) {
      const s = strength > 0 ? Math.min(1, strength) : 0;
      (mat.uniforms.uStrength as { value: number }).value = s;
      mesh.visible = s > 0.004;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
