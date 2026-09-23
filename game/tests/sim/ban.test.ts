// Grep ban for the deterministic simulation (GAME_DESIGN.md §4.3, §10.7). Owner: O1 (written by O0 at M0).
// Second line of defence next to the ESLint rules in eslint.config.js: every src/sim/**/*.ts
// except display.ts must not use banned Math functions, `**`, Float32Array, Date or performance, nor reach the
// global object (globalThis / self / global) or build code from strings (eval, Function(...) / new Function).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SIM_DIR = fileURLToPath(new URL('../../src/sim', import.meta.url));
const EXEMPT = new Set(['display.ts']);

/** Allowed Math members: the functions of §4.3 plus the (exact) constants. Everything else is banned. */
const ALLOWED_MATH = new Set([
  'abs', 'min', 'max', 'floor', 'ceil', 'round', 'trunc', 'sign', 'imul',
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
]);
const BANNED_IDENTIFIERS = ['Float32Array', 'Date', 'performance'];
/** The global object (eslint no-restricted-globals); a property of the same name (`o.self`) is fine. */
const BANNED_GLOBALS = ['globalThis', 'self', 'global'];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/**
 * Replaces comments and string / template-literal text with spaces (newlines kept, so line
 * numbers stay valid). Code inside template `${...}` is kept.
 */
export function codeOnly(src: string): string {
  const out: string[] = [];
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  const n = src.length;
  let i = 0;
  let depth = 0;
  const tplStack: number[] = [];

  const readTemplate = (): void => {
    const start = i;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        out.push(blank(src.slice(start, i)), ' ');
        i++;
        return;
      }
      if (ch === '$' && src[i + 1] === '{') {
        out.push(blank(src.slice(start, i)), '  ');
        i += 2;
        tplStack.push(depth);
        depth++;
        return;
      }
      i++;
    }
    out.push(blank(src.slice(start)));
  };

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const j = src.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out.push(blank(src.slice(i, end)));
      i = end;
    } else if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out.push(blank(src.slice(i, end)));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const end = Math.min(n, j + 1);
      out.push(blank(src.slice(i, end)));
      i = end;
    } else if (c === '`') {
      out.push(' ');
      i++;
      readTemplate();
    } else if (c === '{') {
      depth++;
      out.push(c);
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (tplStack.length > 0 && tplStack[tplStack.length - 1] === depth) {
        tplStack.pop();
        out.push(' ');
        readTemplate();
      } else {
        out.push(c);
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/** Returns human-readable violations ("line N: ...") of the §4.3 ban in one source text. */
export function findViolations(src: string): string[] {
  const code = codeOnly(src);
  const lines = code.split('\n');
  const found: string[] = [];
  lines.forEach((line, k) => {
    const at = `line ${k + 1}`;
    if (line.includes('**')) found.push(`${at}: '**' operator`);
    for (const m of line.matchAll(/\bMath\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      if (!ALLOWED_MATH.has(m[1]!)) found.push(`${at}: Math.${m[1]}`);
    }
    if (/\bMath\s*\[/.test(line)) found.push(`${at}: computed Math[...] access`);
    if (/\bMath\b(?!\s*[.[])/.test(line)) found.push(`${at}: bare Math reference (aliasing)`);
    for (const id of BANNED_IDENTIFIERS) {
      if (new RegExp(`\\b${id}\\b`).test(line)) found.push(`${at}: ${id}`);
    }
    for (const id of BANNED_GLOBALS) {
      if (new RegExp(`(?<![.\\w$])${id}(?![\\w$])(?!\\s*:)`).test(line)) found.push(`${at}: ${id}`);
    }
    // eslint no-eval / no-new-func
    if (/(?<![.\w$])eval(?![\w$])/.test(line)) found.push(`${at}: eval`);
    if (/(?<![.\w$])Function\s*\(|\bnew\s+Function\b/.test(line)) found.push(`${at}: Function constructor`);
  });
  return found;
}

describe('src/sim ban (§4.3)', () => {
  const files = listTs(SIM_DIR).filter((p) => !EXEMPT.has(relative(SIM_DIR, p)));

  it('finds the simulation sources', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('uses no banned API in src/sim (display.ts exempt)', () => {
    const violations: string[] = [];
    for (const f of files) {
      for (const v of findViolations(readFileSync(f, 'utf8'))) violations.push(`${relative(SIM_DIR, f)} ${v}`);
    }
    expect(violations).toEqual([]);
  });

  it('detects banned APIs and ignores comments and strings (scanner self-test)', () => {
    expect(findViolations('const y = Math.sin(x);')).toEqual(['line 1: Math.sin']);
    expect(findViolations('const y = Math.sqrt(x) + Math.log2(x);')).toEqual(['line 1: Math.sqrt', 'line 1: Math.log2']);
    expect(findViolations('const a = b ** 2;\nc **= 3;')).toEqual(["line 1: '**' operator", "line 2: '**' operator"]);
    expect(findViolations("const a = Math['cos'](x);")).toEqual(['line 1: computed Math[...] access']);
    expect(findViolations('const M = Math;')).toEqual(['line 1: bare Math reference (aliasing)']);
    expect(findViolations('const t = Date.now(); const f = new Float32Array(2); performance.now();')).toEqual([
      'line 1: Float32Array', 'line 1: Date', 'line 1: performance',
    ]);
    expect(findViolations('const s = `${Math.exp(1)} ok`;')).toEqual(['line 1: Math.exp']);
    expect(findViolations('/** doc with Math.sin and ** */\n// Math.cos(x) ** 2\nconst s = "Math.tan ** Date";')).toEqual([]);
    expect(findViolations('const s = `Math.sin ${a + 1} Date`;')).toEqual([]);
    expect(findViolations('const y = Math.abs(Math.floor(x) * Math.PI) + Math.imul(a, b);')).toEqual([]);
    expect(findViolations('const g = globalThis.crypto;')).toEqual(['line 1: globalThis']);
    expect(findViolations('self.x = 1; const k = global;')).toEqual(['line 1: self', 'line 1: global']);
    expect(findViolations('eval("1"); const f = Function("return this"); const h = new Function("a", "b");')).toEqual([
      'line 1: eval', 'line 1: Function constructor',
    ]);
    expect(findViolations('const o = { self: 1, global: 2 }; o.self = o.global; const selfish = 3; let evaluate = 0;')).toEqual([]);
  });
});
