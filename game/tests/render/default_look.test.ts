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
import { Particles } from '../../src/render/particles';
import { hashNums, installRecorder, recorderOf } from './recorder';

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
