// i18n tables: identical keys in ja and en (key diff 0), no empty strings, same {slots} (GAME_DESIGN.md §10.7). Owner: O7.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ja } from '../../src/ui/i18n/ja';
import { en } from '../../src/ui/i18n/en';

// Vitest runs from the game directory (the happy-dom environment has no file: import.meta.url).
const SRC = resolve(process.cwd(), 'src');
/** Every string literal in src/core that looks like a UI text key ('toast.x', 'trick.y', ...). */
function coreKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.ts')) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/['"`]((?:toast|trick|badge|hud|pop|pause|results|daily|crash|fail)\.[A-Za-z0-9_.]+)['"`]/g)) keys.set(m[1]!, p.slice(SRC.length + 1));
        // Template keys: `toast.ghostSet${s}` (0..4) and `trick.${id}` (the TrickId list in core/badges.ts).
        if (/`toast\.ghostSet\$\{/.test(text)) for (let i = 0; i < 5; i++) keys.set(`toast.ghostSet${i}`, p.slice(SRC.length + 1));
      }
    }
  };
  walk(join(SRC, 'core'));
  const badges = readFileSync(join(SRC, 'core/badges.ts'), 'utf8');
  const tricks = /TrickId\s*=\s*([^;]+);/.exec(badges)?.[1] ?? '';
  for (const m of tricks.matchAll(/'(\w+)'/g)) keys.set(`trick.${m[1]}`, 'core/badges.ts');
  return keys;
}

const slots = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('i18n tables', () => {
  const jaKeys = Object.keys(ja).sort();
  const enKeys = Object.keys(en).sort();

  it('ja and en have exactly the same keys (diff 0)', () => {
    const onlyJa = jaKeys.filter((k) => !(k in en));
    const onlyEn = enKeys.filter((k) => !(k in ja));
    expect(onlyJa).toEqual([]);
    expect(onlyEn).toEqual([]);
    expect(enKeys).toEqual(jaKeys);
  });

  it('has no empty strings', () => {
    for (const k of jaKeys) {
      expect(ja[k as keyof typeof ja].trim(), `ja ${k}`).not.toBe('');
      expect(en[k as keyof typeof en].trim(), `en ${k}`).not.toBe('');
    }
  });

  it('uses the same {slots} in both languages', () => {
    for (const k of jaKeys) {
      expect(slots(en[k as keyof typeof en]), k).toEqual(slots(ja[k as keyof typeof ja]));
    }
  });

  it('keeps the spec wording where it is fixed', () => {
    expect(ja['app.title']).toBe('ゆらしてピタッ');
    expect(en['app.title']).toBe('Swing & Stick');
    expect(ja['app.tagline']).toBe('最適制御AIに、人間の指で勝て。');
    expect(ja['about.credit']).toBe('制作 貝淵蒼馬');
    expect(ja['about.antiCheat']).toBe('記録は物理的に正しいことを検証していますが、人の操作かどうかは判定できません');
    expect(ja['ailost.close']).toBe('AIは自分のルールの中では最適。あなたはルールの外で勝った');
    expect(ja['pop.stamp']).toBe('ピタッ!');
    expect(ja['hud.ready']).toBe('動かすとスタート');
    // Titles by crown count (§7.2).
    expect([0, 1, 2, 3, 4].map((i) => ja[`select.rank.${i}` as 'select.rank.0'])).toEqual(['見習い', '玉掛け', '熟練オペレーター', '最適制御ハンター', '人類代表']);
  });

  it('every UI text key the core uses (toasts, tricks, ...) resolves in both languages', () => {
    const keys = coreKeys();
    expect(keys.size).toBeGreaterThan(30);
    for (const k of ['toast.tutorialDoneDaily', 'toast.tutorialDoneLevel', 'trick.toast', 'trick.chaseDamp', 'toast.ghostSet4']) expect(keys.has(k), k).toBe(true);
    const missing = [...keys].filter(([k]) => !(k in ja) || !(k in en)).map(([k, f]) => `${k} (${f})`);
    expect(missing).toEqual([]);
  });

  it('practice mode teaches the rewind key in the fixed wording', () => {
    expect(ja['hud.rewindHint']).toBe('R長押しで5秒もどす');
  });

  it('never credits tools or dates in About (§7.13)', () => {
    for (const table of [ja, en]) {
      const about = `${table['about.credit']} ${table['about.inspired']} ${table['about.antiCheat']}`;
      expect(about).not.toMatch(/Claude|Anthropic|Vite|three\.js|20\d\d/i);
    }
  });
});
