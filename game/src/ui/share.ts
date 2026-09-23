// Share texts and share paths (navigator.share / X intent / clipboard / textarea) (GAME_DESIGN.md §7.13). Owner: O7.
import type { DailyView, ResultsData } from './ui';
import { fmtDelta, fmtMm, fmtTime, levelName, t } from './i18n/format';
import type { Lang } from './i18n/format';

/** Longest share text that still carries the challenge replay (§7.13). */
export const SHARE_MAX_CHARS = 1500;
export const X_INTENT = 'https://x.com/intent/post?text=';

/** VITE_PUBLIC_ORIGIN, else location.origin on http(s), else null (file:// or an embedded single HTML). */
export function shareOrigin(override?: string | null): string | null {
  if (override !== undefined) return override ? override.replace(/\/+$/, '') : null;
  const env = import.meta.env.VITE_PUBLIC_ORIGIN;
  if (env) return env.replace(/\/+$/, '');
  try {
    if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  } catch {
    /* no location */
  }
  return null;
}

function hasWalls(data: ResultsData): boolean {
  return data.level.physics.walls.length > 0;
}

/**
 * Level share text (§7.13):
 * ゆらしてピタッ 2-2『原典：いれる』2.617秒 AI比 −0.083秒 最小すき間 6mm（AIは20mm）#ゆらピタ {url}
 * {url} = {origin}/#c=<id>.<replay>, or {origin}/#l=<id> above 1,500 characters or without a replay; omitted without an origin.
 */
export function levelShareText(data: ResultsData, aiParSub: number, origin: string | null, lang: 'ja' | 'en'): string {
  const score = data.score ?? NaN;
  const parts = [
    t('share.levelText', { id: data.level.id, name: levelName(data.level, lang), time: fmtTime(score), delta: fmtDelta(score - aiParSub) }, lang),
  ];
  if (hasWalls(data) && Number.isFinite(data.gapMm)) {
    // The AI's gap comes from ghosts_summary.json; without it the bracket is left out rather than printing "NaN".
    parts.push(Number.isFinite(data.aiGapMm)
      ? t('share.gapPart', { me: fmtMm(data.gapMm), ai: fmtMm(data.aiGapMm) }, lang)
      : t('share.gapPartMe', { me: fmtMm(data.gapMm) }, lang));
  }
  const body = parts.join(' ');
  // §7.13 writes "（AIは20mm）#ゆらピタ" with no space after the full-width bracket; everything else needs one.
  const head = `${body}${lang === 'ja' && body.endsWith('）') ? '' : ' '}${t('app.hashtag', undefined, lang)}`;
  if (!origin) return head;
  if (data.replay) {
    const full = `${head} ${origin}/#c=${data.level.id}.${data.replay}`;
    if (full.length <= SHARE_MAX_CHARS) return full;
  }
  return `${head} ${origin}/#l=${data.level.id}`;
}

const SQUARE = { crown: '\u{1F451}', gold: '\u{1F7E9}', ok: '\u{1F7E8}', fail: '\u{1F7E5}', empty: '⬜' } as const;

export function rackSquares(balls: readonly ('ok' | 'gold' | 'crown' | 'fail' | null)[]): string {
  let s = '';
  for (let i = 0; i < 5; i++) {
    const b = balls[i] ?? null;
    s += b === null ? SQUARE.empty : SQUARE[b];
  }
  return s;
}

/** "上位 n%": one decimal, trailing ".0" dropped, and "1" below 1 % (§7.13). */
export function fmtPct(pct: number): string {
  if (pct < 1) return '1';
  const s = pct.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Daily share text (§7.13), newline separated:
 * ゆらしてピタッ 今日の5球 #23 3.870秒 / {5 squares} / AI差 +0.92秒｜ギリ 6mm｜上位 8%｜連続 5日 / #ゆらピタ {origin}/#d
 * Items without data (no clear, offline pct, unknown gap) are left out.
 */
export function dailyShareText(view: DailyView, origin: string | null, lang: 'ja' | 'en', extra?: { gapMm?: number | null }): string {
  const time = view.bestSub === null ? t('share.dailyNoTime', undefined, lang) : t('share.dailyTime', { v: fmtTime(view.bestSub) }, lang);
  const line1 = t('share.dailyHead', { n: view.n, time }, lang);
  const items: string[] = [];
  if (view.bestSub !== null) items.push(t('share.dailyAi', { d: fmtDelta(view.bestSub - view.parSub, 2) }, lang));
  const gap = extra?.gapMm;
  if (view.bestSub !== null && gap !== undefined && gap !== null && Number.isFinite(gap) && view.level.physics.walls.length > 0) {
    items.push(t('share.dailyGap', { mm: fmtMm(gap) }, lang));
  }
  if (view.pct !== null && Number.isFinite(view.pct)) items.push(t('share.dailyPct', { p: fmtPct(view.pct) }, lang));
  if (view.streak > 0) items.push(t('share.dailyStreak', { n: view.streak }, lang));
  const lines = [line1, rackSquares(view.balls)];
  if (items.length) lines.push(items.join(t('share.sep', undefined, lang)));
  lines.push(origin ? `${t('app.hashtag', undefined, lang)} ${origin}/#d` : t('app.hashtag', undefined, lang));
  return lines.join('\n');
}

// ---------------------------------------------------------------- share paths

export type SharePath = 'native' | 'download+x' | 'clipboard' | 'textarea' | 'cancelled';

export interface ShareCaps { native: boolean; nativeFiles: boolean; x: boolean; clipboard: boolean }

/** What the current environment can do (§7.13): X intent needs a real web origin (not file:// or the single HTML). */
export function shareCaps(png: Blob | null): ShareCaps {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  let web = false;
  try {
    web = location.protocol === 'http:' || location.protocol === 'https:';
  } catch {
    web = false;
  }
  const native = !!nav && typeof nav.share === 'function' && web;
  let nativeFiles = false;
  if (native && png && typeof nav!.canShare === 'function') {
    try {
      nativeFiles = nav!.canShare({ files: [new File([png], 'yurapita.png', { type: 'image/png' })] });
    } catch {
      nativeFiles = false;
    }
  }
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return {
    native: native && (coarse || nativeFiles),
    nativeFiles,
    x: web && import.meta.env.VITE_NET !== 'off',
    clipboard: !!nav?.clipboard && typeof nav.clipboard.writeText === 'function',
  };
}

export function xIntentUrl(text: string): string {
  return X_INTENT + encodeURIComponent(text);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** navigator.share with the PNG when possible (mobile). Must run inside the click handler. */
export async function shareNative(text: string, url: string | null, png: Blob | null): Promise<SharePath> {
  const data: ShareData = { text };
  if (url) data.url = url;
  if (png) {
    const file = new File([png], 'yurapita.png', { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) data.files = [file];
    } catch {
      /* files unsupported */
    }
  }
  try {
    await navigator.share(data);
    return 'native';
  } catch (e) {
    return (e as { name?: string })?.name === 'AbortError' ? 'cancelled' : 'clipboard';
  }
}

/** Desktop path: download the PNG and open the X compose window. */
export function shareDownloadAndX(text: string, png: Blob | null, fileName: string): SharePath {
  if (png) downloadBlob(png, fileName);
  window.open(xIntentUrl(text), '_blank', 'noopener');
  return 'download+x';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Splits "text {url}" produced above into the text and the trailing URL (for navigator.share). */
export function splitUrl(text: string): { text: string; url: string | null } {
  const m = /\s(https?:\/\/\S+)$/.exec(text);
  if (!m) return { text, url: null };
  return { text: text.slice(0, m.index), url: m[1]! };
}

export type { Lang };
