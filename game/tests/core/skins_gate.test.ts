// Readability gate over every skin combination (skins spec §3, §5.3, §5.8, §5.9-4). Owner: O5.
import { describe, expect, it } from 'vitest';
import { SphereGeometry } from 'three';
import { DEFAULT_LOOK, LOOKS, SKIN_PARTS, confettiPalette, patternAt } from '../../src/render/skinLooks';
import type { SkinLook } from '../../src/render/skinLooks';
import { ghostStyle } from '../../src/render/ghosts';
import type { GhostKind } from '../../src/render/renderer';
import {
  BASELINE, CVD_MATRICES, GHOST_LOOKS, audit, contrast, de2000, gate, hex, reservedHit,
} from './skinAudit';

const balls = Object.values(LOOKS.ball), cranes = Object.values(LOOKS.crane), trails = Object.values(LOOKS.trail), stages = Object.values(LOOKS.stage);
const name = (l: SkinLook, egg: boolean): string => `${l.ball.id}/${l.crane.id}/${l.trail.id}/${l.stage.id}${egg ? '/egg' : ''}`;

describe('the readability gate (§5.8)', () => {
  it('passes every combination of the catalog, on ball levels and on 4-3', () => {
    let n = 0;
    const fails: string[] = [];
    for (const ball of balls) for (const crane of cranes) for (const trail of trails) for (const stage of stages) {
      for (const egg of [false, true]) {
        n++;
        const look = { ball, crane, trail, stage };
        for (const r of gate(look, egg)) {
          if (!r.ok) fails.push(`${r.id} = ${r.v} (need ${r.max ? '<=' : '>='} ${r.need}) at ${name(look, egg)}${r.note ? ` — ${r.note}` : ''}`);
        }
      }
    }
    expect(n).toBe(balls.length * cranes.length * trails.length * stages.length * 2);
    expect(n).toBe(1750);
    expect(fails.slice(0, 30)).toEqual([]);
  });

  it('audit(DEFAULT_LOOK) equals the BASELINE table (today), both cargos', () => {
    const seen = new Set<string>();
    for (const egg of [false, true]) {
      for (const c of audit(DEFAULT_LOOK, egg)) {
        seen.add(c.id);
        if (c.id.startsWith('P9') || c.id === 'P10') continue;
        expect(BASELINE[c.id], c.id).toBeDefined();
        expect(Math.abs(c.v - BASELINE[c.id]!), `${c.id}: ${c.v} vs ${BASELINE[c.id]}`).toBeLessThanOrEqual(0.01);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(BASELINE).sort());
    // Spot values from the spec (§5.8 [today]).
    expect([BASELINE.B1, BASELINE.B4, BASELINE.P5, BASELINE.S5, BASELINE.K7, BASELINE.K9, BASELINE.E1]).toEqual([10.42, 3.81, 18.35, 6.1, 12.07, 1.67, 4.6]);
    // Today passes its own gate.
    for (const egg of [false, true]) expect(gate(DEFAULT_LOOK, egg).filter((r) => !r.ok)).toEqual([]);
  });

  it('known-bad colours fail (the thresholds are honest, §3)', () => {
    const D = DEFAULT_LOOK;
    const failing = (look: SkinLook, egg = false): string[] => gate(look, egg).filter((r) => !r.ok).map((r) => r.id.split(' ')[0]!);
    const ball = (body: string, outline: string): SkinLook => ({ ...D, ball: { ...D.ball, body, outline } });
    expect(failing(ball('#E8B321', '#7A5A08'))).toEqual(expect.arrayContaining(['P5', 'P7', 'P8'])); // gold ball
    expect(failing(ball('#0E9C8E', '#054A44'))).toEqual(expect.arrayContaining(['R1', 'S5']));       // teal ball
    expect(failing(ball('#8C949E', '#2B313B'))).toContain('P5');                                    // light chrome
    expect(failing({ ...D, crane: { ...D.crane, beam: '#F1F0EB' } })).toContain('K6');              // white beam
    expect(failing({ ...D, crane: { ...D.crane, beam: '#C5CAD0' } })).toContain('K6');              // stainless beam
    expect(failing({ ...D, trail: { ...D.trail, string: '#A9B0B8' } })).toContain('S1');            // light chain
    expect(failing({ ...D, trail: { ...D.trail, string: '#F7F3EA' } })).toContain('S1');            // mizuhiki white
    expect(failing({ ...D, trail: { ...D.trail, stringEdge: '#F7F3EA' } })).toContain('S1');        // a light edge too
    expect(failing({ ...D, stage: { ...D.stage, brick1: '#E4E2DB', brick2: '#ECEAE3' } })).toContain('B4'); // line-art walls
    const board = failing({ ...D, stage: { ...D.stage, paper1: '#2F4A3F', paper2: '#263D34' } });  // blackboard
    expect(board).toEqual(expect.arrayContaining(['B1', 'B10']));
    expect(board.length).toBeGreaterThanOrEqual(8);
    // Reserved hues: a green or cyan skin colour anywhere.
    expect(failing({ ...D, crane: { ...D.crane, legs: '#3FA66A' } })).toContain('R2');
    expect(failing({ ...D, trail: { ...D.trail, confetti: { palette: ['#19C3FF', '#FFFFFF', '#D8342B'], shape: 'rect' } } })).toContain('R2');
    // Grid far weaker or stronger than today.
    expect(failing({ ...D, stage: { ...D.stage, paperTex: { ...D.stage.paperTex, grid: { rgb: [150, 170, 200], alpha: [0.1, 0.3, 0.2] } } } })).toContain('G1');
    expect(failing({ ...D, stage: { ...D.stage, paperTex: { ...D.stage.paperTex, grid: { rgb: [40, 60, 120], alpha: [0.42, 0.3, 0.2] } } } })).toContain('G1');
    // A metal ball needs the extra margin (P10), a patterned one gates its pattern (P9).
    const metal: SkinLook = { ...D, ball: { ...D.ball, body: '#56607A', outline: '#1B2230', mat: { ...D.ball.mat, metalness: 0.5 } } };
    expect(failing(metal)).toContain('P10');
    const patterned: SkinLook = { ...D, ball: { ...LOOKS.ball['ball.kinobi']!, pattern: [{ kind: 'band', color: '#FFC23D', width: 0.18, axes: ['y'] }] } };
    expect(failing(patterned)).toContain('P9');
  });

  it('GHOST_LOOKS mirror the renderer ghost styles for every kind', () => {
    const kinds: GhostKind[] = ['ai', 'calm', 'research_fast', 'research_pump', 'reverse_hint', 'pb', 'wr', 'rival', 'challenge', 'daily_pb'];
    expect(Object.keys(GHOST_LOOKS).sort()).toEqual([...kinds].sort());
    for (const k of kinds) {
      const st = ghostStyle(k), g = GHOST_LOOKS[k]!;
      expect(`#${st.color.getHexString()}`, k).toBe(g.c.toLowerCase());
      expect([st.alpha, st.scan], k).toEqual([g.a, g.scan]);
      expect(st.outline ? `#${st.outline.getHexString()}` : null, k).toBe(g.ring ? g.ring.toLowerCase() : null);
    }
  });

  it('colour maths: CIEDE2000 (Sharma pair 1), WCAG contrast, CVD matrices', () => {
    expect(de2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(de2000([50, -1, 2], [50, 0, 0])).toBeCloseTo(2.3669, 4); // Sharma pair 7
    expect(contrast(hex('#000000'), hex('#FFFFFF'))).toBeCloseTo(21, 10);
    expect(contrast(hex('#777777'), hex('#777777'))).toBe(1);
    for (const m of Object.values(CVD_MATRICES)) {
      for (let r = 0; r < 3; r++) expect(m[r * 3]! + m[r * 3 + 1]! + m[r * 3 + 2]!).toBeCloseTo(1, 2);
    }
    expect(reservedHit('#22B573')).toMatch(/^goal/);
    expect(reservedHit('#19C3FF')).toMatch(/^ai/);
    expect(reservedHit('#E0312B')).toBeNull();
  });
});

describe('look data rules (§1, §5.3)', () => {
  /** Every key path of a value ("ball.mat.roughness", "stage.paperTex.grid.alpha"). */
  function keyPaths(v: unknown, path = ''): string[] {
    if (v === null || typeof v !== 'object') return [];
    if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${path}[]`));
    return Object.entries(v).flatMap(([k, x]) => {
      const p = path ? `${path}.${k}` : k;
      return [p, ...keyPaths(x, p)];
    });
  }
  const ALLOWED = new Set([
    'id', 'body', 'outline', 'trail', 'mat', 'mat.roughness', 'mat.metalness', 'mat.clearcoat', 'mat.clearcoatRoughness', 'mat.envMapIntensity',
    'pattern', 'pattern[].kind', 'pattern[].color', 'pattern[].cover', 'pattern[].seed', 'pattern[].width', 'pattern[].axes',
    'beam', 'beamDark', 'legs', 'legCap', 'brace', 'legBands', 'legBands.a', 'legBands.b', 'legBands.pitch', 'foot',
    'bodyTop', 'plate', 'tyre', 'hub', 'steel', 'accent', 'hazard', 'paint', 'paint.roughness', 'paint.metalness', 'paint.envMapIntensity',
    'trolleyMat', 'trolleyMat.roughness', 'trolleyMat.metalness', 'trolleyMat.envMapIntensity',
    'string', 'stringEdge', 'ribbon', 'ribbon.color', 'ribbon.width', 'strobe', 'strobe.color', 'strobe.shape',
    'confetti', 'confetti.palette', 'confetti.shape',
    'paper1', 'paper2', 'paperTex', 'paperTex.fibre', 'paperTex.fibreDark', 'paperTex.fibreLight', 'paperTex.noiseDark', 'paperTex.noiseLight',
    'paperTex.grid', 'paperTex.grid.rgb', 'paperTex.grid.alpha', 'floor', 'floorTex', 'floorTex.noise', 'floorTex.grid', 'floorTex.edge',
    'floorTex.minor', 'floorTint', 'brick1', 'brick2', 'mortar', 'brickTex', 'rowH', 'blob', 'dust', 'spark', 'floorDust',
  ]);
  const BANNED = /ghost|goal|danger|amber|ink|egg|tier|opacity|emissive|blending|transmission|sheen|size|radius|linewidth|stringwidth/i;

  it('looks only use whitelisted keys (no meaning colours, sizes, alphas or glow)', () => {
    for (const p of SKIN_PARTS) {
      for (const look of Object.values(LOOKS[p])) {
        for (const k of keyPaths(look)) {
          expect(ALLOWED.has(k), `${look.id}: ${k}`).toBe(true);
          expect(BANNED.test(k), `${look.id}: ${k}`).toBe(false);
          // "alpha" appears once, as the paper grid's line alphas (a texture detail, not object opacity).
          if (/alpha/i.test(k)) expect(k).toBe('paperTex.grid.alpha');
        }
      }
    }
  });

  it('material, trail, wall and effect values stay in range', () => {
    for (const b of balls) {
      expect(b.mat.clearcoat, b.id).toBeGreaterThanOrEqual(0.02);
      expect(b.mat.clearcoat, b.id).toBeLessThanOrEqual(1);
      expect(b.mat.metalness, b.id).toBeLessThanOrEqual(0.5);
      expect(b.mat.envMapIntensity, b.id).toBeLessThanOrEqual(1);
      for (const k of ['roughness', 'clearcoatRoughness'] as const) expect(b.mat[k] >= 0 && b.mat[k] <= 1, `${b.id} ${k}`).toBe(true);
    }
    for (const c of cranes) {
      for (const m of [c.paint, c.trolleyMat]) {
        expect(m.metalness, c.id).toBeLessThanOrEqual(0.5);
        expect(m.envMapIntensity, c.id).toBeLessThanOrEqual(1);
      }
      if (c.legBands) expect(c.legBands.pitch, c.id).toBeGreaterThanOrEqual(0.15);
    }
    for (const t of trails) {
      expect(t.ribbon.width >= 0.55 && t.ribbon.width <= 1, t.id).toBe(true);
      const pal = t.confetti.palette === 'auto' ? confettiPalette({ ...DEFAULT_LOOK, trail: t }) : t.confetti.palette;
      expect(pal.length >= 3 && pal.length <= 7, t.id).toBe(true);
      expect(['rect', 'disc', 'spark'], t.id).toContain(t.confetti.shape);
      expect(['ring', 'disc'], t.id).toContain(t.strobe.shape);
      for (const h of pal) expect(h, t.id).toMatch(/^#[0-9A-F]{6}$/i);
      // The string edge is the same colour or darker (edge L* <= string L*).
      expect(contrast(hex(t.stringEdge), hex('#FFFFFF')), t.id).toBeGreaterThanOrEqual(contrast(hex(t.string), hex('#FFFFFF')) - 1e-9);
    }
    for (const s of stages) {
      expect([0.06, 0.1], s.id).toContain(s.rowH);
      expect(['clay', 'block', 'stone', 'print'], s.id).toContain(s.brickTex);
      // Paper / floor detail alphas never exceed today's (.10 dark fibres, .5 light fibres).
      for (const [css, max] of [[s.paperTex.fibreDark, 0.1], [s.paperTex.fibreLight, 0.5]] as const) {
        const a = Number(/rgba\([^)]*,\s*([0-9.]+)\)/.exec(css)?.[1] ?? '1');
        expect(a, `${s.id} ${css}`).toBeLessThanOrEqual(max);
      }
      s.paperTex.grid.alpha.forEach((a) => expect(a >= 0 && a <= 0.42, s.id).toBe(true));
    }
  });

  it('patterned balls keep the body colour on >= 60 % of the surface (area-weighted, the real sphere)', () => {
    const g = new SphereGeometry(0.06, 48, 32);
    const p = g.getAttribute('position');
    for (const b of balls) {
      if (!b.pattern) continue;
      let base = 0, all = 0;
      for (let i = 0; i < p.count; i++) {
        const w = Math.sqrt(Math.max(0, 1 - (p.getY(i) / 0.06) ** 2));
        all += w;
        if (patternAt(b.pattern, p.getX(i), p.getY(i), p.getZ(i), 0.06)[0] < 0) base += w;
      }
      expect(base / all, b.id).toBeGreaterThanOrEqual(0.6);
      expect(base / all, b.id).toBeLessThan(1);
    }
    g.dispose();
  });
});
