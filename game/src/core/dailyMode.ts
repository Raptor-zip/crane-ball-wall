// "今日の5球" mode: ball consumption, daily record, streak, share line (GAME_DESIGN.md §7.5, §7.13). Owner: O3.
// Pure functions over SaveV1['daily'] (app.ts applies them inside store.update()).
import { DAILY_BALLS, dayStartMs, jstDayNumber } from '../shared/daily';
import type { SaveV1 } from '../store/save';
import { medalThresholds } from './progress';

export type DailyBall = 'ok' | 'gold' | 'crown' | 'fail' | null;
export type DailySave = SaveV1['daily'];

export function emptyRack(): DailyBall[] {
  return new Array<DailyBall>(DAILY_BALLS).fill(null);
}

/** Consumes one ball with the given outcome (first unused slot); returns the new rack (unchanged copy when all are used). */
export function consumeBall(balls: readonly DailyBall[], outcome: Exclude<DailyBall, null>): DailyBall[] {
  const out = normaliseRack(balls);
  const i = out.indexOf(null);
  if (i >= 0) out[i] = outcome;
  return out;
}

/** Replaces the outcome of slot i (a ball is consumed as 'fail' at tick 0 and upgraded when the run succeeds). */
export function settleBall(balls: readonly DailyBall[], i: number, outcome: Exclude<DailyBall, null>): DailyBall[] {
  const out = normaliseRack(balls);
  if (i >= 0 && i < out.length) out[i] = outcome;
  return out;
}

export function ballsUsed(balls: readonly DailyBall[]): number {
  let n = 0;
  for (const b of balls) if (b !== null) n++;
  return n;
}

export function rackFull(balls: readonly DailyBall[]): boolean {
  return ballsUsed(normaliseRack(balls)) >= DAILY_BALLS;
}

function normaliseRack(balls: readonly DailyBall[]): DailyBall[] {
  const out = emptyRack();
  for (let i = 0; i < DAILY_BALLS && i < balls.length; i++) out[i] = balls[i] ?? null;
  return out;
}

/** Colour of a finished ball (§7.5): crown < P, green <= floor(1.2P), yellow otherwise; crashes / time-ups / retries are 'fail'. */
export function ballOutcome(score: number | null, parSub: number): Exclude<DailyBall, null> {
  if (score === null) return 'fail';
  const t = medalThresholds(parSub);
  return score <= t.crown ? 'crown' : score <= t.gold ? 'gold' : 'ok';
}

/** "XXOC-" for the submit body: X fail, O ok, G gold, C crown, - unused. */
export function ballsString(balls: readonly DailyBall[]): string {
  return normaliseRack(balls)
    .map((b) => (b === 'fail' ? 'X' : b === 'ok' ? 'O' : b === 'gold' ? 'G' : b === 'crown' ? 'C' : '-'))
    .join('');
}

/** 5 squares of the share line: 👑 crown, 🟩 gold or better, 🟨 other success, 🟥 fail, ⬜ unused. */
export function ballsEmoji(balls: readonly DailyBall[]): string {
  return normaliseRack(balls)
    .map((b) => (b === 'crown' ? '\u{1F451}' : b === 'gold' ? '\u{1F7E9}' : b === 'ok' ? '\u{1F7E8}' : b === 'fail' ? '\u{1F7E5}' : '⬜'))
    .join('');
}

/** JST calendar day that starts dayIndex (exact from dayIndex 1; dayIndex 0 also stands for every day before the epoch). */
export function jstDayOfIndex(dayIndex: number): number {
  return dayIndex < 0 ? -1 : jstDayNumber(dayStartMs(dayIndex));
}

/** JST calendar day of the rack (-1: no rack yet). Saves without SaveV1.daily.jstDay fall back to their dayIndex. */
export function rackDay(d: DailySave): number {
  if (d.dayIndex < 0) return -1;
  return typeof d.jstDay === 'number' && d.jstDay >= 0 ? d.jstDay : jstDayOfIndex(d.dayIndex);
}

/** The rack belongs to the day (dayIndex, JST calendar day jstDay). */
export function rackIsOn(d: DailySave, dayIndex: number, jstDay: number = jstDayOfIndex(dayIndex)): boolean {
  return d.dayIndex === dayIndex && rackDay(d) === jstDay;
}

/**
 * New JST day: fresh rack and record. The streak is kept here and advanced by markPlayed().
 * The day is (dayIndex, JST calendar day): the calendar day tells apart the days before DAILY_EPOCH (all dayIndex 0).
 * Returns true when the save changed.
 */
export function rolloverDaily(d: DailySave, dayIndex: number, jstDay: number = jstDayOfIndex(dayIndex)): boolean {
  if (rackIsOn(d, dayIndex, jstDay)) {
    let changed = false;
    if (d.jstDay !== jstDay) {
      d.jstDay = jstDay;
      changed = true;
    }
    if (!Array.isArray(d.balls) || d.balls.length !== DAILY_BALLS) {
      d.balls = normaliseRack(d.balls ?? []);
      changed = true;
    }
    return changed;
  }
  d.dayIndex = dayIndex;
  d.jstDay = jstDay;
  d.balls = emptyRack();
  d.bestSub = null;
  d.bestReplay = null;
  d.submitted = 'none';
  d.lastSentT120 = null;
  return true;
}

/** JST calendar day of the last official ball (-1: never). */
function lastPlayedJst(d: DailySave): number {
  if (d.lastPlayedDay < 0) return -1;
  return typeof d.lastPlayedJst === 'number' && d.lastPlayedJst >= 0 ? d.lastPlayedJst : jstDayOfIndex(d.lastPlayedDay);
}

/** First official ball of the day: consecutive days extend the streak, a gap restarts it at 1. */
export function markPlayed(d: DailySave, dayIndex: number, jstDay: number = jstDayOfIndex(dayIndex)): void {
  const last = lastPlayedJst(d);
  if (last === jstDay) return;
  d.streak = last >= 0 && last === jstDay - 1 && d.streak > 0 ? d.streak + 1 : 1;
  d.lastPlayedDay = dayIndex;
  d.lastPlayedJst = jstDay;
}

/** Streak to display today (0 once a day has been missed). */
export function currentStreak(d: DailySave, dayIndex: number, jstDay: number = jstDayOfIndex(dayIndex)): number {
  const last = lastPlayedJst(d);
  return last >= 0 && last >= jstDay - 1 ? d.streak : 0;
}

/** Records a successful official ball; returns true when it is the day's new best. */
export function recordDailyBest(d: DailySave, score: number, replay: string | null): boolean {
  if (d.bestSub !== null && score >= d.bestSub) return false;
  d.bestSub = score;
  d.bestReplay = replay;
  return true;
}

// ------------------------------------------------------------------------------------ histogram, top %

export const HIST_BINS = 150;
export const HIST_BIN_SUB = 24; // 0.2 s

export function histBin(t120: number): number {
  return Math.max(0, Math.min(HIST_BINS - 1, Math.floor(t120 / HIST_BIN_SUB)));
}

/** "上位 n%" = 100 * (players in faster bins + players in my bin / 2) / cleared, 1 decimal, at least 1 (§7.13). */
export function topPercent(hist: readonly number[], cleared: number, t120: number): number | null {
  if (!(cleared > 0) || !Array.isArray(hist) || hist.length === 0) return null;
  const b = histBin(t120);
  let faster = 0;
  for (let i = 0; i < b && i < hist.length; i++) faster += hist[i] ?? 0;
  const mine = hist[b] ?? 0;
  const pct = (100 * (faster + mine / 2)) / cleared;
  return Math.max(1, Math.round(pct * 10) / 10);
}

// ------------------------------------------------------------------------------------ share text

export interface DailyShareInput {
  lang: 'ja' | 'en';
  n: number;                   // #N = dayIndex + 1
  balls: readonly DailyBall[];
  bestSub: number | null;
  parSub: number;
  gapMm: number | null;        // min gap of the best run (null: unknown / no walls)
  pct: number | null;          // null offline
  streak: number;
  origin: string | null;       // null: leave the URL out (single HTML on file://)
}

/** One decimal, trailing ".0" dropped, "1" below 1 % (§7.13; same rule as the UI's share.ts). */
function fmtPct(p: number): string {
  return p < 1 ? '1' : p.toFixed(1).replace(/\.0$/, '');
}

/** The four-line share text of §7.13. */
export function dailyShareText(x: DailyShareInput): string {
  const ja = x.lang === 'ja';
  const time = x.bestSub === null ? (ja ? '記録なし' : 'no clear') : ja ? `${(x.bestSub / 120).toFixed(3)}秒` : `${(x.bestSub / 120).toFixed(3)} s`;
  const head = ja ? `ゆらしてピタッ 今日の5球 #${x.n} ${time}` : `Swing & Stick Daily 5 #${x.n} ${time}`;
  const parts: string[] = [];
  if (x.bestSub !== null) {
    const d = (x.bestSub - x.parSub) / 120;
    const sign = d < 0 ? '−' : '+';
    parts.push(ja ? `AI差 ${sign}${Math.abs(d).toFixed(2)}秒` : `vs AI ${sign}${Math.abs(d).toFixed(2)} s`);
    if (x.gapMm !== null && Number.isFinite(x.gapMm)) {
      const g = Math.max(0, Math.round(x.gapMm));
      parts.push(ja ? `ギリ ${g}mm` : `Gap ${g} mm`);
    }
    if (x.pct !== null) parts.push(ja ? `上位 ${fmtPct(x.pct)}%` : `Top ${fmtPct(x.pct)}%`);
  }
  if (x.streak > 0) parts.push(ja ? `連続 ${x.streak}日` : `Streak ${x.streak} ${x.streak === 1 ? 'day' : 'days'}`);
  const tail = x.origin ? `#ゆらピタ ${x.origin}/#d` : '#ゆらピタ';
  return [head, ballsEmoji(x.balls), parts.join(ja ? '｜' : ' | '), tail].filter((l) => l !== '').join('\n');
}
