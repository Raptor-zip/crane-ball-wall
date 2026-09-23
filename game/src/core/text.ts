// User-facing strings the core itself shows (toasts). Owner: O3.
// Every string lives in the UI's i18n tables (src/ui/i18n); this module only looks them up.
import { ja } from '../ui/i18n/ja';
import { getLang, t, type I18nKey, type Lang } from '../ui/i18n/format';
import type { TrickId } from './badges';

/**
 * Core toast text from the UI's i18n tables. tests/ui/i18n.test.ts scans src/core for every 'toast.*' / 'trick.*'
 * key and fails when one is missing from ja or en, so a key never shows raw; the key itself is the last resort.
 */
export function ct(key: string, vars?: Record<string, string | number>, lang: Lang = getLang()): string {
  if (Object.prototype.hasOwnProperty.call(ja, key)) return t(key as I18nKey, vars, lang);
  return key;
}

export function trickName(id: TrickId, lang: Lang = getLang()): string {
  return ct(`trick.${id}`, undefined, lang);
}

/** Ghost tag labels (§3.5, §8.2): AI labels come from the ghost JSON in Japanese; English uses these. */
const AI_LABEL_EN: Record<string, string> = { AI: 'AI', 'AI(お手本)': 'AI (demo)', 'AI(省エネ)': 'AI (efficient)', 'AI(ブランコ)': 'AI (swing)' };
export function aiLabel(jsonLabel: string, lang: Lang = getLang()): string {
  return lang === 'en' ? AI_LABEL_EN[jsonLabel] ?? jsonLabel : jsonLabel;
}
