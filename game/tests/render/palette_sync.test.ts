// The default look, the 3D palette, the 2D side view palette and the CSS tokens agree (skins spec §5.2, §5.9-2).
// Owner: O5. A skin never changes these sources: this pins DEFAULT_LOOK (today) to them, and them to each other.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DirectionalLight, HemisphereLight } from 'three';
import { PAL, createScene } from '../../src/render/scene';
import { C } from '../../src/ui/sideview';
import { DEFAULT_LOOK, confettiPalette } from '../../src/render/skinLooks';
import { ballMaterialParams } from '../../src/render/renderer';
import { DEFAULT_CONFETTI } from '../../src/render/particles';
import { createTextures } from '../../src/render/textures';
import { installRecorder } from './recorder';

const css = readFileSync(resolve(process.cwd(), 'src/ui/tokens.css'), 'utf8');
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`token --${name} missing`);
  return m[1]!.trim();
}
const same = (a: string, b: string): void => expect(a.toLowerCase(), `${a} vs ${b}`).toBe(b.toLowerCase());

describe('palette sources agree', () => {
  it('PAL, sideview C and tokens.css share their keys case-insensitively', () => {
    const cssName: Record<string, string> = {
      paper1: 'paper-1', paper2: 'paper-2', floor: 'floor', grid: 'grid', brick1: 'brick-1', brick2: 'brick-2', mortar: 'mortar',
      gantry: 'gantry', hazard: 'hazard', rail: 'rail', ball: 'ball', string: 'string', egg: 'egg', eggSpeckle: 'egg-speckle',
      ink: 'ink', goal: 'goal', danger: 'danger', ai: 'ai', pb: 'pb-solid', wr: 'wr', rival: 'rival', challenge: 'challenge', stamp: 'stamp',
    };
    for (const [k, v] of Object.entries(PAL)) {
      if (cssName[k]) same(token(cssName[k]!), v);
      if (k in C) same((C as Record<string, string>)[k]!, v);
    }
    // sideview's 2D trolley (#39455F) is a drawing literal, not a palette key: the 3D trolley (#33405C) is not in C.
    expect(Object.values(C).map((x) => x.toLowerCase())).not.toContain('#39455f');
  });

  it('DEFAULT_LOOK is today: every literal pinned to its source', () => {
    const d = DEFAULT_LOOK;
    // Ball (PAL.ball, renderer.ts ball material, outline).
    same(d.ball.body, PAL.ball);
    same(d.ball.outline, '#7A1712');
    expect(d.ball.pattern).toBeNull();
    expect(d.ball.trail).toBeUndefined();
    // Crane (PAL.gantry / rail, crane.ts literals, hazard texture).
    same(d.crane.beam, PAL.gantry);
    same(d.crane.beamDark, '#D99F00');
    same(d.crane.foot, '#4B5563');
    expect([d.crane.legs, d.crane.legCap, d.crane.brace, d.crane.legBands]).toEqual([undefined, undefined, undefined, undefined]);
    expect([d.crane.body, d.crane.bodyTop, d.crane.plate, d.crane.tyre, d.crane.hub, d.crane.steel].map((x) => x.toUpperCase()))
      .toEqual(['#33405C', '#46557A', '#26314A', '#1B1F27', '#B8C0CA', '#9AA3AE']);
    expect(d.crane.accent).toBe('ball');
    same(d.crane.hazard[0], PAL.gantry);
    same(d.crane.hazard[1], PAL.hazard);
    expect(d.crane.paint).toEqual({ roughness: 0.42, metalness: 0.08, envMapIntensity: 0.55 });
    expect(d.crane.trolleyMat).toEqual({ roughness: 0.38, metalness: 0.25, envMapIntensity: 0.8 });
    // Trail (PAL.string, ribbon / strobe in the ball colour, brick confetti).
    same(d.trail.string, PAL.string);
    same(d.trail.stringEdge, PAL.string);
    expect(d.trail.ribbon).toEqual({ color: 'ball', width: 1 });
    expect(d.trail.strobe).toEqual({ color: 'ball', shape: 'ring' });
    expect(d.trail.confetti).toEqual({ palette: 'auto', shape: 'rect' });
    expect(confettiPalette(d)).toEqual(DEFAULT_CONFETTI);
    expect(DEFAULT_CONFETTI).toEqual([PAL.brick1, PAL.brick2, PAL.mortar, PAL.gantry, PAL.goal, PAL.stamp, PAL.brick2]);
    // Stage (PAL paper / floor / grid / bricks, textures.ts literals, scene.ts tint, blob).
    const s = d.stage;
    same(s.paper1, PAL.paper1);
    same(s.paper2, PAL.paper2);
    same(s.floor, PAL.floor);
    same(s.floorTex.grid, PAL.grid);
    expect([s.floorTex.noise, s.floorTex.edge].map((x) => x.toLowerCase())).toEqual(['#8d8577', '#b3aa9b']);
    expect(s.floorTex.minor).toBe(true);
    expect(s.floorTint).toEqual([1, 0.975, 0.93]);
    same(s.brick1, PAL.brick1);
    same(s.brick2, PAL.brick2);
    same(s.mortar, PAL.mortar);
    expect([s.brickTex, s.rowH]).toEqual(['clay', 0.06]);
    same(s.blob, '#3a2a20');
    expect([s.dust, s.spark, s.floorDust]).toEqual([undefined, undefined, undefined]);
    expect(s.paperTex).toEqual({
      fibre: 'short', fibreDark: 'rgba(150,130,100,0.10)', fibreLight: 'rgba(255,255,255,0.5)', noiseDark: '#A89878', noiseLight: '#FFFFFF',
      grid: { rgb: [150, 170, 200], alpha: [0.42, 0.3, 0.2] },
    });
  });

  it('the renderer builds the plain ball from ballMaterialParams(DEFAULT_LOOK.ball) = today', () => {
    expect(ballMaterialParams(DEFAULT_LOOK.ball)).toEqual({
      color: '#E0312B', roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.26, envMapIntensity: 0.7, transparent: true, opacity: 1,
    });
  });

  it('the light rig is fixed (no look touches it)', () => {
    const undo = installRecorder();
    const st = createScene(createTextures());
    undo();
    const hemi = st.scene.children.find((o) => (o as HemisphereLight).isHemisphereLight) as HemisphereLight;
    const dirs = st.scene.children.filter((o) => (o as DirectionalLight).isDirectionalLight) as DirectionalLight[];
    expect([hemi.color.getHexString(), hemi.groundColor.getHexString(), hemi.intensity]).toEqual(['fff8ee', 'cdbfa8', 1.35]);
    expect(dirs.map((l) => [l.color.getHexString(), l.intensity])).toEqual([['fff0da', 1.85], ['e4eeff', 0.35]]);
    expect(st.key.position.toArray()).toEqual([-1.1, 5.2, 2.2]);
    st.dispose();
  });
});
