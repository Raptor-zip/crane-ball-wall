// Skins stay cosmetic at the module level (skins spec §1.1, §5.9-5). Owner: O3.
// Nothing the simulation, the server, the network layer, the shared code, the save or the ghost codec runs can reach
// the skin modules, directly or through (relative) re-exports: skin ids can never end up in replays, boards, links,
// outbox rows or ghost payloads.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GAME = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const SKIN_MODULES = ['src/render/skinLooks.ts', 'src/core/skins.ts'].map((p) => join(GAME, p));
const ROOTS = ['src/sim', 'worker', 'src/net', 'src/shared', 'src/store', 'src/core/ghostcodec.ts'];

function tsFiles(p: string): string[] {
  const abs = join(GAME, p);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return abs.endsWith('.ts') ? [abs] : [];
  return readdirSync(abs).flatMap((n) => tsFiles(join(p, n)));
}

/**
 * Relative import / export / dynamic-import specifiers of a file, resolved to .ts files. `import type` and
 * `export type` statements are erased at build time (no runtime code, no values), so they are not edges.
 */
function deps(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) {
    if (/^(?:import|export)\s+type\s/.test(m[0])) continue;
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith('.')) continue;
    const base = resolve(dirname(file), spec);
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(cand) && statSync(cand).isFile() && cand.endsWith('.ts')) {
        out.push(cand);
        break;
      }
    }
  }
  return out;
}

describe('skin modules are unreachable from sim / worker / net / shared / store / ghost codec', () => {
  it('no import chain from those roots reaches skinLooks or core/skins', () => {
    const roots = ROOTS.flatMap(tsFiles);
    expect(roots.length).toBeGreaterThan(20);
    const parent = new Map<string, string | null>();
    const queue = [...roots];
    for (const r of roots) parent.set(r, null);
    while (queue.length) {
      const f = queue.shift()!;
      for (const d of deps(f)) {
        if (parent.has(d)) continue;
        parent.set(d, f);
        queue.push(d);
      }
    }
    for (const s of SKIN_MODULES) {
      const chain: string[] = [];
      for (let at: string | null | undefined = s; at; at = parent.get(at)) chain.unshift(relative(GAME, at));
      expect(parent.has(s), `reached ${relative(GAME, s)} via ${chain.join(' -> ')}`).toBe(false);
    }
  });

  it('the scanner sees real imports and skips type-only ones (sanity)', () => {
    const save = join(GAME, 'src/store/save.ts');
    expect(deps(save).map((d) => relative(GAME, d))).toEqual(expect.arrayContaining(['src/net/outbox.ts', 'src/shared/names.ts']));
    expect(deps(save).map((d) => relative(GAME, d))).not.toContain('src/core/bus.ts'); // import type only
    const skins = join(GAME, 'src/core/skins.ts');
    expect(deps(skins).map((d) => relative(GAME, d))).toContain('src/render/skinLooks.ts');
  });
});
