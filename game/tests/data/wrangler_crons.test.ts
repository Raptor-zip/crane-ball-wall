// wrangler.jsonc cron triggers against worker/cron.ts (GAME_DESIGN.md §7.7 構成, §10.5). Owner: O9.
// worker/index.ts scheduled() dispatches on the cron string, so a trigger that is renamed on one side only would
// silently run the wrong job. worker/ is not part of this (DOM / node) project, so cron.ts is read as text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/** JSONC -> JSON: drops line and block comments outside strings, and trailing commas. */
function parseJsonc(src: string): unknown {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

describe('cron triggers', () => {
  it('wrangler.jsonc runs the 00:30 JST cleanup and the hourly histogram rebuild, as worker/cron.ts names them', () => {
    const cfg = parseJsonc(read('wrangler.jsonc')) as { triggers?: { crons?: unknown } };
    expect(cfg.triggers?.crons).toEqual(['30 15 * * *', '7 * * * *']);
    const cron = read('worker/cron.ts');
    expect(cron).toContain("export const CRON_DAILY = '30 15 * * *';");
    expect(cron).toContain("export const CRON_HIST = '7 * * * *';");
  });
});
