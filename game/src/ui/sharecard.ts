// Strobe share card, canvas 2D 1200x630 PNG (GAME_DESIGN.md §7.13). Owner: O7.
// Paper-figure style: side view with brick hatch, rail and floor grid, your ball every 0.1 s (older = fainter),
// the AI ball path as a thin cyan line, level name, big time, medal, "AI比 −0.08s", closest gap and #ゆらピタ. No author credit.
import type { ResultsData } from './ui';
import { fmtDelta, fmtMm, fmtTime, levelName, t } from './i18n/format';
import { C, FONT_STACK, NUM_STACK, SideCam, drawSideView, drawStamp, fitRange } from './sideview';
import { factsOf } from './i18n/format';

export const SHARE_CARD_W = 1200;
export const SHARE_CARD_H = 630;

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function coin(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, medal: number, crown: boolean): void {
  g.save();
  coinInner(g, cx, cy, r, medal, crown);
  g.restore();
}

function coinInner(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, medal: number, crown: boolean): void {
  if (crown) {
    g.save();
    g.translate(cx, cy);
    const s = r / 16;
    g.scale(s, s);
    g.translate(-20, -20);
    g.fillStyle = '#B7860B';
    g.beginPath();
    g.moveTo(6, 17); g.lineTo(13.5, 24); g.lineTo(20, 12); g.lineTo(26.5, 24); g.lineTo(34, 17); g.lineTo(31, 32); g.lineTo(9, 32); g.closePath();
    g.fill();
    g.fillStyle = C.gantry;
    g.strokeStyle = C.ink;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(6, 15); g.lineTo(13.5, 22); g.lineTo(20, 10); g.lineTo(26.5, 22); g.lineTo(34, 15); g.lineTo(31, 30); g.lineTo(9, 30); g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = C.ball;
    g.beginPath();
    g.arc(20, 9, 2.6, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
    return;
  }
  const faces: Record<number, [string, string]> = { 1: ['#C98A52', '#8E5427'], 2: ['#C9D1DA', '#7D8795'], 3: ['#F5C83A', '#B7860B'] };
  const [face, edge] = faces[medal] ?? ['#FBF8F1', '#C9C2B6'];
  g.fillStyle = edge;
  g.beginPath();
  g.arc(cx, cy + r * 0.12, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = face;
  g.strokeStyle = C.ink;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.strokeStyle = edge;
  g.lineWidth = 2;
  g.setLineDash([2, 3.5]);
  g.beginPath();
  g.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  if (medal > 0) {
    g.fillStyle = edge;
    g.font = `800 ${r * 0.9}px ${NUM_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(4 - medal), cx, cy + r * 0.06);
  }
}

function paperBackground(g: CanvasRenderingContext2D, w: number, h: number): void {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, C.paper1);
  grad.addColorStop(1, C.paper2);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.lineWidth = 1;
  for (let x = 0; x <= w; x += 15) {
    g.strokeStyle = x % 75 === 0 ? 'rgba(201,194,182,0.55)' : 'rgba(201,194,182,0.25)';
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, h);
    g.stroke();
  }
  for (let y = 0; y <= h; y += 15) {
    g.strokeStyle = y % 75 === 0 ? 'rgba(201,194,182,0.55)' : 'rgba(201,194,182,0.25)';
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(w, y + 0.5);
    g.stroke();
  }
}

function fitText(g: CanvasRenderingContext2D, text: string, weight: number, size: number, maxW: number, family = FONT_STACK): number {
  let s = size;
  g.font = `${weight} ${s}px ${family}`;
  while (g.measureText(text).width > maxW && s > 10) {
    s -= 1;
    g.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

/** Draws the 1200x630 card. Returns the canvas even where 2D canvas is unavailable (then blank). */
export function drawShareCard(data: ResultsData, aiPath: Float32Array | null): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = SHARE_CARD_W;
  cv.height = SHARE_CARD_H;
  let g: CanvasRenderingContext2D | null = null;
  try {
    g = cv.getContext('2d');
  } catch {
    g = null;
  }
  if (!g || typeof g.fillRect !== 'function') return cv;
  const W = SHARE_CARD_W;
  const H = SHARE_CARD_H;
  const level = data.level;
  paperBackground(g, W, H);

  // Drawing border (double frame like a drafting sheet).
  g.strokeStyle = C.ink;
  g.lineWidth = 4;
  roundRect(g, 22, 22, W - 44, H - 44, 22);
  g.stroke();
  g.lineWidth = 1.5;
  roundRect(g, 32, 32, W - 64, H - 64, 15);
  g.stroke();

  // ---- left column
  const LX = 64;
  const colW = 380;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = C.ink;
  g.font = `800 30px ${FONT_STACK}`;
  g.fillText(t('app.title'), LX, 92);
  g.font = `500 17px ${FONT_STACK}`;
  g.fillStyle = 'rgba(30,42,68,0.62)';
  g.fillText(t('app.titleAlt'), LX, 118);

  // Level chip + name.
  const idText = level.world === 0 ? t('hud.daily') : level.id;
  g.font = `800 26px ${level.world === 0 ? FONT_STACK : NUM_STACK}`;
  const idW = g.measureText(idText).width + 26;
  g.fillStyle = C.ink;
  roundRect(g, LX, 146, idW, 42, 12);
  g.fill();
  g.fillStyle = C.paper1;
  g.fillText(idText, LX + 13, 176);
  const name = levelName(level);
  g.fillStyle = C.ink;
  fitText(g, name, 800, 34, colW - idW - 14);
  g.fillText(name, LX + idW + 14, 179);

  // Time.
  const time = data.score !== null ? fmtTime(data.score) : '–';
  g.fillStyle = C.ink;
  const ts = fitText(g, time, 800, 118, colW - 70, NUM_STACK);
  g.fillText(time, LX - 4, 318);
  const tw = g.measureText(time).width;
  g.font = `800 ${Math.round(ts * 0.34)}px ${FONT_STACK}`;
  g.fillText(t('unit.s', { v: '' }).trim() || 's', LX + tw + 6, 318);

  // Medal + AI delta.
  coin(g, LX + 34, 378, 30, data.medal, data.crown);
  const medalLabel = data.crown ? t('results.medal.crown') : t(`results.medal.${data.medal}` as 'results.medal.0');
  g.fillStyle = C.ink;
  fitText(g, medalLabel, 800, 28, colW - 90);
  g.textBaseline = 'middle';
  g.fillText(medalLabel, LX + 80, 380);
  g.textBaseline = 'alphabetic';

  const delta = data.score !== null ? fmtDelta(data.score - data.parSub) : '–';
  const aiText = t('card.aiDelta', { d: delta });
  g.font = `800 30px ${FONT_STACK}`;
  const aw = g.measureText(aiText).width + 32;
  g.fillStyle = data.score !== null && data.score < data.parSub ? C.gantry : C.ai;
  roundRect(g, LX, 428, aw, 50, 14);
  g.fill();
  g.strokeStyle = C.ink;
  g.lineWidth = 2.5;
  g.stroke();
  g.fillStyle = C.ink;
  g.fillText(aiText, LX + 16, 464);

  if (level.physics.walls.length > 0 && Number.isFinite(data.gapMm)) {
    const gapText = Number.isFinite(data.aiGapMm) ? t('card.gap', { me: fmtMm(data.gapMm), ai: fmtMm(data.aiGapMm) }) : t('card.gapMe', { me: fmtMm(data.gapMm) });
    g.fillStyle = C.ink;
    fitText(g, gapText, 800, 26, colW);
    g.fillText(gapText, LX, 522);
  }
  g.fillStyle = C.stamp;
  g.font = `800 34px ${FONT_STACK}`;
  g.fillText(t('app.hashtag'), LX, 578);

  // ---- right figure
  const fig = { x: 470, y: 66, w: 668, h: 498 };
  g.fillStyle = 'rgba(251,248,241,0.85)';
  roundRect(g, fig.x, fig.y, fig.w, fig.h, 16);
  g.fill();
  g.save();
  roundRect(g, fig.x, fig.y, fig.w, fig.h, 16);
  g.clip();
  const range = fitRange(level, [data.strobe, aiPath], 2.6, 0.35);
  const cam = new SideCam({ x: fig.x, y: fig.y + 44, w: fig.w, h: fig.h - 44 }, { ...range, y1: 1.45 }, 'center');
  const lastX = data.strobe.length >= 2 ? data.strobe[data.strobe.length - 2]! : level.physics.startX;
  const lastY = data.strobe.length >= 2 ? data.strobe[data.strobe.length - 1]! : 1.25 - level.physics.L;
  drawSideView(g, level, cam, {
    grid: true,
    strobe: data.strobe.length > 2 ? data.strobe.subarray(0, data.strobe.length - 2) : null,
    aiPath,
    aiPathStep: 1,
    trolleyX: lastX,
    ball: { x: lastX, y: lastY },
    egg: level.cargo === 'egg',
    lineScale: 1.4,
    reqDeg: factsOf(level).reqDeg,
  });
  g.restore();
  g.strokeStyle = C.ink;
  g.lineWidth = 2.5;
  roundRect(g, fig.x, fig.y, fig.w, fig.h, 16);
  g.stroke();
  // Figure caption strip.
  g.fillStyle = C.ink;
  g.font = `800 19px ${FONT_STACK}`;
  g.textBaseline = 'middle';
  g.fillText(`${t('card.figure', { id: idText })}  ${t('card.strobe')}`, fig.x + 20, fig.y + 24);
  // Legend.
  g.font = `500 17px ${FONT_STACK}`;
  const lg = t('card.aiTrace');
  const lgW = g.measureText(lg).width;
  g.strokeStyle = C.ai;
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(fig.x + fig.w - lgW - 64, fig.y + 24);
  g.lineTo(fig.x + fig.w - lgW - 32, fig.y + 24);
  g.stroke();
  g.fillStyle = C.ink;
  g.fillText(lg, fig.x + fig.w - lgW - 22, fig.y + 25);
  g.textBaseline = 'alphabetic';

  // Stamp overlapping the frame corner.
  if (data.ok) drawStamp(g, fig.x + fig.w - 70, fig.y + 104, 54, t('pop.stamp'), -0.22);
  return cv;
}

/** Waits for the web font (when available) and renders the card to a PNG blob. */
export async function shareCardPng(data: ResultsData, aiPath: Float32Array | null): Promise<{ canvas: HTMLCanvasElement; blob: Blob | null }> {
  try {
    await Promise.race([
      Promise.all([document.fonts.load(`800 40px ${FONT_STACK}`), document.fonts.load(`500 20px ${FONT_STACK}`)]),
      new Promise((r) => setTimeout(r, 1200)),
    ]);
  } catch {
    /* fonts API missing: fall back */
  }
  const canvas = drawShareCard(data, aiPath);
  const blob = await new Promise<Blob | null>((res) => {
    try {
      canvas.toBlob((b) => res(b), 'image/png');
    } catch {
      res(null);
    }
  });
  return { canvas, blob };
}
