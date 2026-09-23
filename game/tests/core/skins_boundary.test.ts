// Skins stay cosmetic at the module level (skins spec §1.1, §5.9-5, §6.1). Owner: O3.
// Nothing the simulation, the server, the network layer, the shared code or the ghost codec runs can reach any skin
// module, directly or through (relative) re-exports: skin ids can never end up in replays, boards, links, outbox rows
// or ghost payloads. The save layer (src/store) stores skin ids (settings.skin, skins.owned / seen in PART B), so it
// may reach the import-free id list core/skinIds.ts, and only that: never the look data or the unlock rules
// (core/skins.ts imports store/save, so store -> core/skins would also be an import cycle).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GAME = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const abs = (p: string): string => join(GAME, p);
const LOOKS_AND_RULES = ['src/render/skinLooks.ts', 'src/core/skins.ts'].map(abs);
const IDS = abs('src/core/skinIds.ts');
const STRICT_ROOTS = ['src/sim', 'worker', 'src/net', 'src/shared', 'src/core/ghostcodec.ts'];
const STORE_ROOTS = ['src/store'];

function tsFiles(p: string): string[] {
  const a = abs(p);
  if (!existsSync(a)) return [];
  if (statSync(a).isFile()) return a.endsWith('.ts') ? [a] : [];
  return readdirSync(a).flatMap((n) => tsFiles(join(p, n)));
}

/** Every import / export-from / dynamic-import statement of a source text (type-only ones included). */
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Relative import / export / dynamic-import specifiers of a file, resolved to .ts files. `import type` and
 * `export type` statements are erased at build time (no runtime code, no values), so they are not edges.
 */
function deps(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
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

/** Breadth-first walk of value imports from `roots`: file -> the file it was first reached from (null for a root). */
function reach(roots: readonly string[]): Map<string, string | null> {
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
  return parent;
}

function chain(parent: Map<string, string | null>, target: string): string {
  const out: string[] = [];
  for (let at: string | null | undefined = target; at; at = parent.get(at)) out.unshift(relative(GAME, at));
  return out.join(' -> ');
}

describe('skin modules are unreachable from sim / worker / net / shared / ghost codec; store reaches only the id list', () => {
  it('no import chain from sim / worker / net / shared / the ghost codec reaches any skin module', () => {
    const roots = STRICT_ROOTS.flatMap(tsFiles);
    expect(roots.length).toBeGreaterThan(20);
    const parent = reach(roots);
    for (const s of [...LOOKS_AND_RULES, IDS]) expect(parent.has(s), `reached ${relative(GAME, s)} via ${chain(parent, s)}`).toBe(false);
  });

  it('no import chain from src/store reaches the look data or the unlock rules (only core/skinIds.ts is allowed)', () => {
    const roots = STORE_ROOTS.flatMap(tsFiles);
    expect(roots.length).toBeGreaterThan(0);
    const parent = reach(roots);
    for (const s of LOOKS_AND_RULES) expect(parent.has(s), `reached ${relative(GAME, s)} via ${chain(parent, s)}`).toBe(false);
  });

  it('core/skinIds.ts and render/skinLooks.ts import nothing, so reaching the id list pulls in no other module', () => {
    for (const f of [IDS, LOOKS_AND_RULES[0]!]) {
      const src = readFileSync(f, 'utf8');
      expect([...src.matchAll(IMPORT_RE)].map((m) => m[0]), relative(GAME, f)).toEqual([]);
      expect(/\brequire\s*\(/.test(src), relative(GAME, f)).toBe(false);
    }
  });

  it('the scanner sees real imports and skips type-only ones (sanity)', () => {
    const save = abs('src/store/save.ts');
    expect(deps(save).map((d) => relative(GAME, d))).toEqual(expect.arrayContaining(['src/net/outbox.ts', 'src/shared/names.ts']));
    expect(deps(save).map((d) => relative(GAME, d))).not.toContain('src/core/bus.ts'); // import type only
    const skins = abs('src/core/skins.ts');
    expect(deps(skins).map((d) => relative(GAME, d))).toEqual(
      expect.arrayContaining(['src/render/skinLooks.ts', 'src/core/skinIds.ts', 'src/store/save.ts']),
    );
    // What a walk reports: core/skins reaches the id list directly, and store/save through core/skins (the cycle a
    // store -> core/skins import would close).
    const parent = reach([skins]);
    expect(chain(parent, IDS)).toBe('src/core/skins.ts -> src/core/skinIds.ts');
    expect(chain(parent, save)).toBe('src/core/skins.ts -> src/store/save.ts');
  });
});
