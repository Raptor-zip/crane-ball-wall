// Goldens of today's look (skins spec §5.2, §5.9-1). Owner: O5.
//
// Captured before the skin refactor: canvas call streams of the brick / floor / hazard / paper textures, the vertex
// data of the board, floor, trolley and gantry, the brick instance colours and matrices, and the confetti colours.
// The default skin must reproduce every one of them exactly (same values, same random draws, same order).
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BufferGeometry, InstancedMesh } from 'three';
import { Color } from 'three';
import levelsFile from '../../src/data/levels.json';
import type { LevelDef } from '../../src/sim/level';
import { createTextures } from '../../src/render/textures';
import type { Textures } from '../../src/render/textures';
import { createScene } from '../../src/render/scene';
import { createCrane } from '../../src/render/crane';
import { createBricks } from '../../src/render/bricks';
import { DEFAULT_CONFETTI, Particles, S_RECT } from '../../src/render/particles';
import { Z_GANTRY_LEG } from '../../src/render/scene';
import { BEAM_TOP } from '../../src/render/crane';
import { DEFAULT_LOOK, LOOKS, confettiPalette } from '../../src/render/skinLooks';
import type { StageLook } from '../../src/render/skinLooks';
import { hashNums, installRecorder, recorderCount, recorderOf, recordersSince } from './recorder';

const LEVELS = (levelsFile as unknown as { levels: LevelDef[] }).levels;
const walls = (id: string): LevelDef['physics']['walls'] => LEVELS.find((l) => l.id === id)!.physics.walls;

/** Golden hashes of today's render (captured at c831abf, before any skin code). */
const GOLDEN = {
  tex: { brick: '532443a3', floor: '14d96a12', hazard: 'f043ece2', paper: 'f55167a5' },
  board: { initial: '10c97b0c', fitted: '3cc19406', index: 'c570ad06' },
  floor: '836606ee',
  trolley: '42261f24',
  gantry: { '1-1': '348d82d5', '5-4': '5c6053c6' },
  bricks: { '2-2': '99d3dc7f', '4-1': 'bfa31d89', '5-2': 'c8fced29' },
  confetti: 'a17cf42e',
};

function geoHash(g: BufferGeometry, keys: string[] = ['position', 'normal', 'color']): string {
  const arrs: ArrayLike<number>[] = [];
  for (const k of keys) {
    const a = g.getAttribute(k);
    arrs.push(a ? (a.array as ArrayLike<number>) : []);
  }
  const idx = g.getIndex();
  arrs.push(idx ? (idx.array as ArrayLike<number>) : []);
  return hashNums(...arrs);
}

function bricksHash(m: InstancedMesh): string {
  const n = m.count;
  const col = m.instanceColor ? (m.instanceColor.array as Float32Array).subarray(0, n * 3) : new Float32Array(0);
  return hashNums(col, (m.instanceMatrix.array as Float32Array).subarray(0, n * 16));
}

function confettiHash(emit: (p: Particles) => void): string {
  const p = new Particles();
  const out: number[] = [];
  const orig = p.emit.bind(p);
  p.emit = (e) => {
    out.push(e.color.r, e.color.g, e.color.b, e.shape);
    orig(e);
  };
  emit(p);
  return hashNums(out);
}

let uninstall: () => void = () => undefined;
let tex: Textures;
beforeAll(() => {
  uninstall = installRecorder();
  tex = createTextures();
});
afterAll(() => uninstall());

/** GOLDEN_PRINT=<file>: write the computed hashes there instead of comparing (to capture new goldens). */
const PRINT = typeof process !== 'undefined' ? process.env.GOLDEN_PRINT ?? '' : '';
const got: Record<string, unknown> = {};
function check(path: string, value: string, want: string): void {
  got[path] = value;
  if (PRINT) return;
  expect(value, path).toBe(want);
}
afterAll(() => {
  if (PRINT) writeFileSync(PRINT, JSON.stringify(got, null, 2));
});

describe('default look goldens (today)', () => {
  it('texture canvases draw the same call streams', () => {
    check('tex.brick', recorderOf(tex.brick.image).hash(), GOLDEN.tex.brick);
    check('tex.floor', recorderOf(tex.floor.image).hash(), GOLDEN.tex.floor);
    check('tex.hazard', recorderOf(tex.hazard.image).hash(), GOLDEN.tex.hazard);
    check('tex.paper', recorderOf(tex.paper.image).hash(), GOLDEN.tex.paper);
    expect(recorderOf(tex.paper.image).log.length).toBeGreaterThan(400);
  });

  it('board and floor vertex data', () => {
    const st = createScene(tex);
    const g = st.board.geometry;
    check('board.initial', hashNums(g.getAttribute('color').array as ArrayLike<number>, g.getAttribute('position').array as ArrayLike<number>), GOLDEN.board.initial);
    st.fitShadow(-1.3, 3.5);
    check('board.fitted', hashNums(g.getAttribute('color').array as ArrayLike<number>), GOLDEN.board.fitted);
    check('board.index', geoHash(g, ['position', 'normal', 'uv']), GOLDEN.board.index);
    check('floor', geoHash(st.floor.geometry, ['position', 'normal', 'uv', 'color']), GOLDEN.floor);
    expect(new Color().copy((st.scene.background as Color)).getHexString()).toBe('f3eee4');
    st.dispose();
  });

  it('trolley and gantry vertex data', () => {
    const cr = createCrane(tex.hazard, null);
    check('trolley', geoHash(cr.trolley.geometry), GOLDEN.trolley);
    cr.setRail([-0.6, 2.4]);
    check('gantry.1-1', geoHash(cr.gantry.geometry), GOLDEN.gantry['1-1']);
    cr.setRail([-1, 3.2]);
    check('gantry.5-4', geoHash(cr.gantry.geometry), GOLDEN.gantry['5-4']);
    cr.dispose();
  });

  it('brick instance colours and matrices', () => {
    for (const id of ['2-2', '4-1', '5-2'] as const) {
      const b = createBricks(walls(id), tex.brick);
      check(`bricks.${id}`, bricksHash(b.bricks), GOLDEN.bricks[id]);
      b.dispose();
    }
  });

  it('90 confetti pieces draw the same colours', () => {
    check('confetti', confettiHash((p) => p.confetti(1.2, 2.0, 0.5, 90)), GOLDEN.confetti);
  });
});

// ------------------------------------------------------------------------------------------------ after the skin refactor

const STAGE_LOOKS = Object.values(LOOKS.stage);
const CRANE_LOOKS = Object.values(LOOKS.crane);
/**
 * Hashes of a restyle / setHazard: each canvas is painted in a fresh canvas (its whole call stream) and copied into
 * the texture's own canvas. Returns the fresh canvases' hashes in paint order, after checking the copies.
 */
function redrawHashes(targets: unknown[], draw: () => void): string[] {
  const recs = targets.map((c) => recorderOf(c));
  for (const r of recs) r.log.length = 0;
  const n0 = recorderCount();
  draw();
  const fresh = recordersSince(n0);
  expect(fresh.length).toBe(targets.length);
  for (const r of recs) {
    expect(r.log.map((e) => e[0])).toEqual(['save', 'set', 'drawImage', 'restore']);
    expect(r.log[1]).toEqual(['set', 'globalCompositeOperation', 'copy']);
  }
  return fresh.map((r) => r.hash());
}

describe('the default look reproduces the goldens', () => {
  it('createTextures(DEFAULT_LOOK) draws the same canvases', () => {
    const t = createTextures(DEFAULT_LOOK);
    expect(recorderOf(t.brick.image).hash()).toBe(GOLDEN.tex.brick);
    expect(recorderOf(t.floor.image).hash()).toBe(GOLDEN.tex.floor);
    expect(recorderOf(t.hazard.image).hash()).toBe(GOLDEN.tex.hazard);
    expect(recorderOf(t.paper.image).hash()).toBe(GOLDEN.tex.paper);
    t.dispose();
  });

  it('restyle to every board and back redraws the golden canvases (same canvases, same textures)', () => {
    const t = createTextures(DEFAULT_LOOK);
    const [paper, floor, brick, hazard] = [t.paper, t.floor, t.brick, t.hazard];
    const v0 = paper.version;
    const golden = [GOLDEN.tex.paper, GOLDEN.tex.floor, GOLDEN.tex.brick];
    for (const st of STAGE_LOOKS) {
      const other = redrawHashes([paper.image, floor.image, brick.image], () => t.restyle(st));
      if (st.id !== DEFAULT_LOOK.stage.id) expect(other[0], st.id).not.toBe(GOLDEN.tex.paper);
      expect(redrawHashes([paper.image, floor.image, brick.image], () => t.restyle(DEFAULT_LOOK.stage)), st.id).toEqual(golden);
    }
    for (const cr of CRANE_LOOKS) {
      t.setHazard(cr.hazard[0], cr.hazard[1]);
      expect(redrawHashes([hazard.image], () => t.setHazard(DEFAULT_LOOK.crane.hazard[0], DEFAULT_LOOK.crane.hazard[1])), cr.id)
        .toEqual([GOLDEN.tex.hazard]);
    }
    expect([t.paper, t.floor, t.brick, t.hazard]).toEqual([paper, floor, brick, hazard]);
    expect(paper.version).toBeGreaterThan(v0);
    expect(hazard.repeat.x).toBe(1);
    t.dispose();
  });

  it('board, floor, trolley, gantry, bricks and confetti with DEFAULT_LOOK equal the goldens', () => {
    const st = createScene(tex, DEFAULT_LOOK.stage);
    const g = st.board.geometry;
    expect(hashNums(g.getAttribute('color').array as ArrayLike<number>, g.getAttribute('position').array as ArrayLike<number>)).toBe(GOLDEN.board.initial);
    st.fitShadow(-1.3, 3.5);
    expect(hashNums(g.getAttribute('color').array as ArrayLike<number>)).toBe(GOLDEN.board.fitted);
    expect(geoHash(st.floor.geometry, ['position', 'normal', 'uv', 'color'])).toBe(GOLDEN.floor);
    st.dispose();
    const cr = createCrane(tex.hazard, null, DEFAULT_LOOK.crane, DEFAULT_LOOK.ball.body);
    expect(geoHash(cr.trolley.geometry)).toBe(GOLDEN.trolley);
    cr.setRail([-0.6, 2.4]);
    expect(geoHash(cr.gantry.geometry)).toBe(GOLDEN.gantry['1-1']);
    cr.dispose();
    for (const id of ['2-2', '4-1', '5-2'] as const) {
      const b = createBricks(walls(id), tex.brick, DEFAULT_LOOK.stage);
      expect(bricksHash(b.bricks), id).toBe(GOLDEN.bricks[id]);
      b.dispose();
    }
    expect(confettiHash((p) => p.confetti(1.2, 2.0, 0.5, 90, DEFAULT_CONFETTI, S_RECT))).toBe(GOLDEN.confetti);
    expect(confettiHash((p) => p.confetti(1.2, 2.0, 0.5, 90, confettiPalette(DEFAULT_LOOK), S_RECT))).toBe(GOLDEN.confetti);
  });

  it('scene.setLook to every board and back gives the golden board and floor', () => {
    const st = createScene(tex, DEFAULT_LOOK.stage);
    st.fitShadow(-1.3, 3.5);
    const board = st.board.geometry, floor = st.floor.geometry;
    const pos0 = geoHash(board, ['position', 'normal', 'uv']), fpos0 = geoHash(floor, ['position', 'normal', 'uv']);
    for (const look of STAGE_LOOKS) {
      st.setLook(look);
      expect(geoHash(board, ['position', 'normal', 'uv']), look.id).toBe(pos0);
      expect(geoHash(floor, ['position', 'normal', 'uv']), look.id).toBe(fpos0);
      expect(new Color().copy(st.scene.background as Color).getHexString(), look.id).toBe(look.paper1.slice(1).toLowerCase());
      st.setLook(DEFAULT_LOOK.stage);
      expect(hashNums(board.getAttribute('color').array as ArrayLike<number>), look.id).toBe(GOLDEN.board.fitted);
      expect(geoHash(floor, ['position', 'normal', 'uv', 'color']), look.id).toBe(GOLDEN.floor);
    }
    st.dispose();
  });

  it('crane.setLook to every crane and back gives the golden trolley and gantry', () => {
    const cr = createCrane(tex.hazard, null);
    cr.setRail([-1, 3.2]);
    for (const look of CRANE_LOOKS) {
      cr.setLook(look, '#384354');
      cr.setLook(DEFAULT_LOOK.crane, DEFAULT_LOOK.ball.body);
      expect(geoHash(cr.trolley.geometry), look.id).toBe(GOLDEN.trolley);
      expect(geoHash(cr.gantry.geometry), look.id).toBe(GOLDEN.gantry['5-4']);
    }
    cr.dispose();
  });

  it('bricks.recolor to every board (same rowH) and back gives the golden instances', () => {
    for (const id of ['2-2', '4-1', '5-2'] as const) {
      const b = createBricks(walls(id), tex.brick);
      for (const look of STAGE_LOOKS) {
        b.recolor(look);
        b.recolor(DEFAULT_LOOK.stage);
        expect(bricksHash(b.bricks), `${id} ${look.id}`).toBe(GOLDEN.bricks[id]);
      }
      b.dispose();
    }
  });
});

describe('skins are cosmetic only (§1.2)', () => {
  it('every crane keeps the trolley geometry and the gantry shape (bands stay inside the leg boxes)', () => {
    const base = createCrane(tex.hazard, null);
    const shape = (g: BufferGeometry): string => geoHash(g, ['position', 'normal']);
    const trolley0 = shape(base.trolley.geometry);
    for (const rail of [[-0.6, 2.4], [-1, 3.2], [-0.6, 3.6]] as [number, number][]) {
      base.setRail(rail);
      const gantry0 = shape(base.gantry.geometry);
      const p0 = base.gantry.geometry.getAttribute('position');
      const known = new Set<string>();
      for (let i = 0; i < p0.count; i++) known.add(`${p0.getX(i).toFixed(5)},${p0.getY(i).toFixed(5)},${p0.getZ(i).toFixed(5)}`);
      base.gantry.geometry.computeBoundingBox();
      const box0 = base.gantry.geometry.boundingBox!.clone();
      const legX = [rail[0] - 0.15, rail[1] + 0.15];
      for (const look of CRANE_LOOKS) {
        const cr = createCrane(tex.hazard, null, look, '#E0312B');
        cr.setRail(rail);
        expect(shape(cr.trolley.geometry), look.id).toBe(trolley0);
        const g = cr.gantry.geometry;
        if (!look.legBands) {
          expect(shape(g), look.id).toBe(gantry0);
        } else {
          g.computeBoundingBox();
          expect(g.boundingBox!.equals(box0), look.id).toBe(true);
          const p = g.getAttribute('position');
          for (let i = 0; i < p.count; i++) {
            const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
            if (known.has(`${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`)) continue;
            const inLeg = legX.some((lx) => Math.abs(x - lx) <= 0.035 + 1e-6)
              && y >= 0.012 - 1e-6 && y <= BEAM_TOP + 1e-6 && Math.abs(z - Z_GANTRY_LEG) <= 0.035 + 1e-6;
            expect(inLeg, `${look.id} vertex ${x},${y},${z}`).toBe(true);
          }
          // +~200 triangles at most (§1.7).
          expect((g.getIndex()!.count - base.gantry.geometry.getIndex()!.count) / 3, look.id).toBeLessThanOrEqual(200);
        }
        cr.dispose();
      }
    }
    base.dispose();
  });

  it('bricks keep their matrices for the same rowH and stay inside the wall box for every board', () => {
    for (const id of ['2-2', '4-1', '5-2', '5-4', '3-3'] as const) {
      const ws = walls(id);
      const def = createBricks(ws, tex.brick);
      const m0 = (def.bricks.instanceMatrix.array as Float32Array).subarray(0, def.bricks.count * 16);
      for (const look of STAGE_LOOKS as StageLook[]) {
        const b = createBricks(ws, tex.brick, look);
        const m = (b.bricks.instanceMatrix.array as Float32Array).subarray(0, b.bricks.count * 16);
        if (look.rowH === DEFAULT_LOOK.stage.rowH) expect(hashNums(m), `${id} ${look.id}`).toBe(hashNums(m0));
        // Every brick box inside its wall's slab (x0..x1, 0..h, z +-0.25).
        for (let i = 0; i < b.bricks.count; i++) {
          const e = m.subarray(i * 16, i * 16 + 16);
          const sx = e[0]!, sy = e[5]!, sz = e[10]!, x = e[12]!, y = e[13]!, z = e[14]!;
          const w = ws.find((q) => x >= q.x0 - 1e-6 && x <= q.x1 + 1e-6)!;
          expect(w, `${id} ${look.id} brick ${i}`).toBeTruthy();
          expect(x - sx / 2).toBeGreaterThanOrEqual(w.x0 - 1e-6);
          expect(x + sx / 2).toBeLessThanOrEqual(w.x1 + 1e-6);
          expect(y - sy / 2).toBeGreaterThanOrEqual(-1e-6);
          expect(y + sy / 2).toBeLessThanOrEqual(w.h + 1e-6);
          expect(Math.abs(z) + sz / 2).toBeLessThanOrEqual(0.25 + 1e-6);
        }
        expect(b.rowH).toBe(look.rowH);
        b.dispose();
      }
      def.dispose();
    }
  });
});
