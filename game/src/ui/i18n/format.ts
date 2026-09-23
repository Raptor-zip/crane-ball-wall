// i18n lookup, number formats and fmtLevelText (GAME_DESIGN.md §5.3). Owner: O7.
// fmtLevelText replaces the §5.3 placeholders ({h0}, {req0}, {beam}, {gap}, {Fmax}, {Tmax}, {period}) with levelFacts values.
import type { LevelDef } from '../../sim/level';
import { levelFacts } from '../../sim/display';
import type { LevelFacts } from '../../sim/display';
import { ja } from './ja';
import type { I18nKey } from './ja';
import { en } from './en';

export type Lang = 'ja' | 'en';
export type { I18nKey };

const TABLES: Record<Lang, Record<I18nKey, string>> = { ja, en };
let current: Lang = 'ja';

export function setLang(l: Lang): void {
  current = l;
}

export function getLang(): Lang {
  return current;
}

/** First-run default: Japanese for a Japanese browser (navigator.language ja*), English otherwise (§3.5). */
export function defaultLang(): Lang {
  if (typeof navigator === 'undefined') return 'ja';
  const first = navigator.language || navigator.languages?.[0] || 'ja';
  return /^ja\b/i.test(first) ? 'ja' : 'en';
}

/** Looks up a string and fills {name} slots. Unknown slots are left as they are. */
export function t(key: I18nKey, vars?: Record<string, string | number>, lang: Lang = current): string {
  const raw = TABLES[lang][key] ?? TABLES.ja[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

// ---------------------------------------------------------------- numbers

export const SUB_HZ = 120;
export const MINUS = '−';

/** Shown instead of a number that is not known (NaN / ±Infinity from missing data). */
export const NO_VALUE = '–';

/** Substeps -> seconds. 3 decimals (final values) round; 2 decimals (running clock) floor so the clock never runs ahead. */
export function fmtTime(sub: number, digits: 2 | 3 = 3): string {
  if (!Number.isFinite(sub)) return NO_VALUE;
  const sec = Math.max(0, sub) / SUB_HZ;
  if (digits === 2) return (Math.floor(sec * 100 + 1e-9) / 100).toFixed(2);
  return sec.toFixed(3);
}

/** Signed delta in seconds with a real minus sign: "−0.083", "+0.410". */
export function fmtDelta(deltaSub: number, digits = 3): string {
  if (!Number.isFinite(deltaSub)) return NO_VALUE;
  const v = deltaSub / SUB_HZ;
  const a = Math.abs(v).toFixed(digits);
  if (Number(a) === 0) return `±${a}`;
  return (v < 0 ? MINUS : '+') + a;
}

export function fmtNum(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : NO_VALUE;
}

const COUNT_FMT: Partial<Record<Lang, Intl.NumberFormat>> = {};

/** An integer count with the language's grouping: 1,065 (ja and en both group by thousands). Ranks and player counts. */
export function fmtCount(n: number, lang: Lang = current): string {
  if (!Number.isFinite(n)) return NO_VALUE;
  let f = COUNT_FMT[lang];
  if (!f) {
    try {
      f = new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US', { maximumFractionDigits: 0 });
    } catch {
      return String(Math.round(n));
    }
    COUNT_FMT[lang] = f;
  }
  return f.format(Math.round(n));
}

/** Integer millimetres for display (never negative). */
export function fmtMm(mm: number): string {
  if (!Number.isFinite(mm)) return NO_VALUE;
  return String(Math.max(0, Math.round(mm)));
}

/** Gap gauge label: "3.4 cm" at 1 cm and above, "7 mm" below. */
export function fmtGap(mm: number): string {
  if (!Number.isFinite(mm)) return NO_VALUE;
  if (mm >= 10) return t('unit.cm', { v: (mm / 10).toFixed(1) });
  return t('unit.mm', { v: fmtMm(mm) });
}

/** True for a number that can be shown (not NaN / Infinity / null / undefined). */
export function known(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------- level text

const factsCache = new WeakMap<object, LevelFacts>();
const RAIL_Y = 1.25;
const BALL_R = 0.06;
const BEAM_Y = 1.3;
const G = 9.81;

/**
 * Same definitions as O1's levelFacts (§5.3); used only if levelFacts is unavailable,
 * so a half-built sim never shows raw placeholders to players.
 */
function fallbackFacts(level: LevelDef): LevelFacts {
  const p = level.physics;
  const deg = (c: number): number => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
  const pocket = p.phases.find((z) => z.kind === 'pocket');
  return {
    wallH: p.walls.map((w) => w.h),
    reqDeg: p.walls.map((w) => deg((RAIL_Y - w.h - BALL_R) / p.L)),
    beamDeg: deg((RAIL_Y + BALL_R - BEAM_Y) / p.L), // by + r >= BEAM_Y  <=>  cos(th) <= 0.01 / L
    gapCm: pocket ? (pocket.xb - pocket.xa) * 100 : null,
    periodS: 2 * Math.PI * Math.sqrt(p.L / G),
  };
}

export function factsOf(level: LevelDef): LevelFacts {
  const phys = level.physics;
  const hit = factsCache.get(phys);
  if (hit) return hit;
  let f: LevelFacts;
  try {
    f = levelFacts(phys);
  } catch {
    f = fallbackFacts(level);
  }
  factsCache.set(phys, f);
  return f;
}

const DASH = '–';

function placeholder(name: string, level: LevelDef, f: LevelFacts): string | null {
  let m = /^h([0-3])$/.exec(name);
  if (m) {
    const v = f.wallH[Number(m[1])] ?? level.physics.walls[Number(m[1])]?.h;
    return v === undefined ? DASH : v.toFixed(2);
  }
  m = /^req([0-3])$/.exec(name);
  if (m) {
    const v = f.reqDeg[Number(m[1])];
    return v === undefined || !Number.isFinite(v) ? DASH : String(Math.round(v));
  }
  switch (name) {
    case 'beam':
      return Number.isFinite(f.beamDeg) ? String(Math.round(f.beamDeg)) : DASH;
    case 'gap':
      return f.gapCm !== null && Number.isFinite(f.gapCm) ? String(Math.round(f.gapCm)) : DASH;
    case 'Fmax':
      return String(Math.round(level.physics.Fmax));
    case 'Tmax':
      return level.physics.egg ? String(Math.round(level.physics.egg.Tmax)) : DASH;
    case 'period':
      return Number.isFinite(f.periodS) ? f.periodS.toFixed(2) : DASH;
    default:
      return null;
  }
}

/** Replaces §5.3 placeholders with values from levelFacts(level.physics). Unknown {names} are left untouched. */
export function fmtLevelText(text: string, level: LevelDef): string {
  if (!text.includes('{')) return text;
  const f = factsOf(level);
  return text.replace(/\{(\w+)\}/g, (m, name: string) => placeholder(name, level, f) ?? m);
}

/** Localised, placeholder-resolved level name (falls back to Japanese, §5.3). */
export function levelName(level: LevelDef, lang: Lang = current): string {
  return fmtLevelText(level.name[lang] || level.name.ja, level);
}

export function levelConcept(level: LevelDef, lang: Lang = current): string {
  return fmtLevelText(level.concept[lang] || level.concept.ja, level);
}

/** Hint i (0..2) for the READY line (English falls back to Japanese). */
export function levelHint(level: LevelDef, i: number, lang: Lang = current): string | null {
  const hs = level.hints?.[lang] ?? level.hints?.ja;
  const h = hs?.[i] || level.hints?.ja[i];
  return h ? fmtLevelText(h, level) : null;
}

/** Display id: campaign "2-2"; daily "#<n>" is handled by the callers. */
export function levelLabel(level: LevelDef, lang: Lang = current): string {
  return t('common.level', { id: level.id, name: levelName(level, lang) }, lang);
}

/** One-line failure cause for the failed results card (§9.4), from the 'timeout' event. */
export function failReasonText(reason: 'swing' | 'speed' | 'zone' | 'none', value: number, restDeg: number, lang: Lang = current): string {
  switch (reason) {
    case 'swing':
      return t('fail.swing', { v: fmtNum(value, 1), rest: fmtRest(restDeg) }, lang);
    case 'speed':
      return t('fail.speed', { v: fmtNum(Math.abs(value), 2) }, lang);
    case 'zone':
      return t('fail.zone', undefined, lang);
    default:
      return t('fail.none', undefined, lang);
  }
}

/** A rest angle in degrees as the spec writes it: 3, 5, 2.5. */
export function fmtRest(d: number): string {
  return Number.isInteger(d) ? String(d) : d.toFixed(1);
}

/** Near-miss tier (§9.5): <40 near, <20 close, <10 razor, <5 paper, <2 god. null when >= 40 mm. */
export type NearTier = 'near' | 'close' | 'razor' | 'paper' | 'god';
export function nearTier(mm: number): NearTier | null {
  if (mm < 2) return 'god';
  if (mm < 5) return 'paper';
  if (mm < 10) return 'razor';
  if (mm < 20) return 'close';
  if (mm < 40) return 'near';
  return null;
}
