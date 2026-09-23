// String (taut line / slack bezier) (GAME_DESIGN.md §9.5). Owner: O5.
//
// A thin ribbon in the ball plane with a constant on-screen width. Taut: straight pivot -> ball.
// Slack: a quadratic Bezier whose sag grows with (L - chord) and wobbles a little. Snap: 80 ms
// white flash along the string. Egg levels tint it by tension (amber >= 0.75 Tmax, red >= 0.9 Tmax).
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Mesh, ShaderMaterial,
} from 'three';
import { PAL, col } from './scene';

const SEG = 24;

const VS = /* glsl */ `
attribute float aSide;
varying float vSide;
void main() {
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FS = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uEdge;
uniform float uFlash;
uniform float uAlpha;
varying float vSide;
void main() {
  float s = abs(vSide);
  float aa = max(fwidth(s), 1e-3);
  float a = 1.0 - smoothstep(1.0 - aa, 1.0, s);
  vec3 c = mix(uColor, uEdge, smoothstep(0.35, 0.8, s));
  c = mix(c, vec3(1.0), uFlash);
  gl_FragColor = vec4(c, a * uAlpha);
  #include <colorspace_fragment>
}`;

export interface StringLine {
  readonly mesh: Mesh;
  /** Pivot (px, py), ball (bx, by); slack uses the rope length L. Widths in world metres. */
  update(px: number, py: number, bx: number, by: number, L: number, slack: boolean, width: number, time: number): void;
  setColor(c: Color, edge: Color): void;
  setFlash(v: number): void;
  dispose(): void;
}

export function createString(z = 0.0): StringLine {
  const nv = (SEG + 1) * 2;
  const pos = new Float32Array(nv * 3);
  const side = new Float32Array(nv);
  for (let i = 0; i <= SEG; i++) {
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
  }
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
  g.setAttribute('aSide', new BufferAttribute(side, 1));
  g.setIndex(idx);
  const mat = new ShaderMaterial({
    vertexShader: VS, fragmentShader: FS,
    uniforms: {
      uColor: { value: col(PAL.string) }, uEdge: { value: col(PAL.string) }, uFlash: { value: 0 }, uAlpha: { value: 1 },
    },
    transparent: true, depthWrite: false, side: DoubleSide,
  });
  const mesh = new Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  const px = new Float32Array(SEG + 1), py = new Float32Array(SEG + 1);

  return {
    mesh,
    update(ax, ay, bx, by, L, slack, width, time) {
      const dx = bx - ax, dy = by - ay;
      const chord = Math.hypot(dx, dy);
      let cx = (ax + bx) / 2, cy = (ay + by) / 2;
      if (slack && chord < L) {
        // Parabolic sag for the extra length: arc ~ c + 8 s^2 / (3 c) -> s = sqrt(3 c (L - c) / 8).
        const c = Math.max(chord, 0.02);
        let s = Math.sqrt((3 * c * (L - chord)) / 8);
        s = Math.min(s, L * 0.45);
        s *= 1 + 0.12 * Math.sin(time * 19);
        // Perpendicular to the chord, pointing downward (gravity side).
        let nx = -dy / (chord || 1), ny = dx / (chord || 1);
        if (ny > 0) { nx = -nx; ny = -ny; }
        if (chord < 1e-3) { nx = 0; ny = -1; }
        cx += nx * 2 * s;
        cy += ny * 2 * s;
      }
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG, u = 1 - t;
        px[i] = u * u * ax + 2 * u * t * cx + t * t * bx;
        py[i] = u * u * ay + 2 * u * t * cy + t * t * by;
      }
      const hw = width / 2;
      for (let i = 0; i <= SEG; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(SEG, i + 1);
        let tx = (px[i1] as number) - (px[i0] as number), ty = (py[i1] as number) - (py[i0] as number);
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;
        const k = i * 6;
        pos[k] = (px[i] as number) - ty * hw; pos[k + 1] = (py[i] as number) + tx * hw; pos[k + 2] = z;
        pos[k + 3] = (px[i] as number) + ty * hw; pos[k + 4] = (py[i] as number) - tx * hw; pos[k + 5] = z;
      }
      (g.getAttribute('position') as BufferAttribute).needsUpdate = true;
    },
    setColor(c, edge) {
      ((mat.uniforms.uColor as { value: Color }).value).copy(c);
      ((mat.uniforms.uEdge as { value: Color }).value).copy(edge);
    },
    setFlash(v) {
      (mat.uniforms.uFlash as { value: number }).value = v;
    },
    dispose() {
      g.dispose();
      mat.dispose();
    },
  };
}
