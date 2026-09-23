// Strategy card (作戦図, GAME_DESIGN.md §8.4 item 5): 2D drawing with dimension lines and the required-angle arc,
// the calm strobe path, the pumps line, F_max, par and medal times. Any input closes it. Owner: O7.
import type { LevelDef } from '../../sim/level';
import type { GhostSummary, Screen, ScreenHandle } from '../ui';
import type { ScreenEnv } from '../context';
import { h } from '../dom';
import { coin, crownBadge, icon } from '../icons';
import { factsOf, fmtMm, fmtNum, fmtTime, levelConcept, levelName, t } from '../i18n/format';
import { FRAGILE } from '../../input/servo';
import { BALL_R, C, SideCam, drawSideView, fitRange } from '../sideview';

/** Medal thresholds (§7.2) in substeps: bronze floor(2P), silver floor(1.5P), gold floor(1.2P), crown < P. */
export function medalThresholds(parSub: number): { bronze: number; silver: number; gold: number; crown: number } {
  // Integer arithmetic (floor(1.2P) = floor(6P/5)): 1.2 * P in floating point can land just below an integer.
  const P = Math.round(parSub);
  return { bronze: 2 * P, silver: Math.floor((3 * P) / 2), gold: Math.floor((6 * P) / 5), crown: P };
}

export function drawStrategy(cv: HTMLCanvasElement, level: LevelDef, calm: Float32Array | null, cssW: number, dpr: number): { cam: SideCam; base: HTMLCanvasElement } | null {
  const cssH = Math.round(cssW * 0.5);
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  cv.style.aspectRatio = `${cssW} / ${cssH}`;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = C.paper1;
  g.fillRect(0, 0, cssW, cssH);
  const range = fitRange(level, [calm], 2.4, 0.3);
  const cam = new SideCam({ x: 6, y: 22, w: cssW - 12, h: cssH - 28 }, { ...range, y0: -0.08, y1: 1.46 }, 'bottom');
  const f = factsOf(level);
  const lw = Math.max(0.7, Math.min(1.2, cssW / 520));
  drawSideView(g, level, cam, {
    grid: true, dims: true, reqDeg: f.reqDeg, gapCm: f.gapCm, lineScale: lw, egg: level.cargo === 'egg',
    labels: { m: (v) => t('unit.m', { v }), cm: (v) => t('unit.cm', { v }), deg: (v) => t('unit.deg', { v }) },
  });
  // Calm strobe: AI demo every 0.1 s (6 samples at 60 Hz) as cyan rings.
  if (calm && calm.length >= 4) {
    g.save();
    const n = calm.length / 2;
    for (let i = 0; i < n; i += 6) {
      const a = 0.25 + 0.6 * (i / n);
      g.globalAlpha = a;
      g.strokeStyle = '#0f8ab8';
      g.fillStyle = 'rgba(25,195,255,0.35)';
      g.lineWidth = 1.4 * lw;
      g.beginPath();
      g.arc(cam.X(calm[i * 2]!), cam.Y(calm[i * 2 + 1]!), BALL_R * cam.s * 0.8, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.restore();
  }
  const base = document.createElement('canvas');
  base.width = cv.width;
  base.height = cv.height;
  base.getContext('2d')?.drawImage(cv, 0, 0);
  return { cam, base };
}

export function renderBriefingScreen(root: HTMLElement, screen: Extract<Screen, { id: 'briefing' }>, env: ScreenEnv): ScreenHandle {
  const { level, ai } = screen;
  const reduce = env.reducedMotion();
  const sum = env.summary(level.id);
  const done = (): void => {
    env.emit('resume', { from: 'briefing' });
    env.open({ id: 'hud' });
  };
  const cv = h('canvas', { role: 'img', 'aria-label': `${t('briefing.title')} ${level.id}` });
  const fig = h('div', { class: 'brief-fig' }, cv, h('span', { class: 'brief-cap' }, t('briefing.calm')));
  const pumps = ai.pumps > 0 ? t('briefing.pumps', { n: ai.pumps }) : t('briefing.pumps0');
  const th = medalThresholds(ai.parSub);
  const f = factsOf(level);
  const reqTxt = f.reqDeg.length ? f.reqDeg.map((d) => `${Math.round(d)}°`).join(' / ') : '–';
  const gapMm = Number.isFinite(ai.minGapMm) ? ai.minGapMm : sum?.minGapMm ?? null;

  const facts = h('div', { class: 'facts' },
    h('div', { class: 'fact' }, h('div', { class: 'fact-label' }, t('briefing.fmax')), h('div', { class: 'fact-val' }, t('unit.N', { v: Math.round(level.physics.Fmax) }))),
    h('div', { class: 'fact' }, h('div', { class: 'fact-label' }, t('briefing.req')), h('div', { class: 'fact-val' }, reqTxt)),
    h('div', { class: 'fact' }, h('div', { class: 'fact-label' }, t('briefing.par')), h('div', { class: 'fact-val', style: 'color:#0b7fad' }, t('unit.s', { v: fmtTime(ai.parSub) }))),
    h('div', { class: 'fact' }, h('div', { class: 'fact-label' }, t('demo.gap')), h('div', { class: 'fact-val' }, gapMm !== null && level.physics.walls.length ? t('unit.mm', { v: fmtMm(gapMm) }) : '–')));

  const mt = (el: SVGElement, sub: number, label: string, lt = false): HTMLElement =>
    h('div', { class: 'mt' }, el, h('span', null, `${lt ? '<' : '≤'}${fmtTime(sub)}`), h('small', null, label));
  const medals = h('div', { class: 'medal-times', 'aria-label': t('briefing.medals') },
    mt(crownBadge(), th.crown, t('briefing.crown'), true),
    mt(coin(3), th.gold, t('results.medal.3')),
    mt(coin(2), th.silver, t('results.medal.2')),
    mt(coin(1), th.bronze, t('results.medal.1')));

  const notes: string[] = [t('briefing.rest', { v: level.physics.restDeg })];
  // Egg levels: the servo caps every speed at FRAGILE.vCap (R10), so the trolley feels slower here.
  if (level.physics.egg) notes.unshift(t('briefing.egg', { v: Math.round(level.physics.egg.Tmax) }), t('briefing.eggSpeed', { v: fmtNum(FRAGILE.vCap, 1) }));
  if (level.physics.phases.length > 1) notes.unshift(t('briefing.phase2'));

  const start = h('button', { class: 'btn btn--primary btn--lg btn--block', type: 'button', 'data-autofocus': '' }, icon('play'), t('briefing.start'));
  start.addEventListener('click', (e) => {
    e.stopPropagation();
    done();
  });
  const card = h('section', { class: 'sheet card brief-card screen-enter', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('briefing.title'), style: 'max-width:640px' },
    h('div', { class: 'card-body' },
      h('div', { class: 'eyebrow' }, t('briefing.title')),
      h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:6px' }, h('span', { class: 'idchip' }, level.world === 0 ? t('hud.daily') : level.id), h('h2', { class: 'sheet-title' }, levelName(level))),
      h('div', { class: 'note', style: 'margin-top:4px' }, levelConcept(level)),
      h('div', { class: 'brief-grid' },
        h('div', null, fig, h('div', { class: 'pump-line' }, icon('demo'), pumps)),
        h('div', null, facts, medals, h('div', { class: 'note', style: 'margin-top:10px' }, notes.join(' · '))))),
    h('div', { class: 'card-foot' }, start));
  const wrap = h('div', { class: 'center-wrap' }, card);
  root.appendChild(wrap);
  // Any tap closes it (§8.4).
  wrap.addEventListener('click', () => done());

  // Draw after layout so the canvas matches its CSS width.
  let raf = 0;
  let alive = true;
  requestAnimationFrame(() => {
    if (!alive) return;
    const cssW = Math.max(240, Math.round(fig.clientWidth || 320));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const calm = ai.calmPath && ai.calmPath.length >= 4 ? ai.calmPath : null;
    const drawn = drawStrategy(cv, level, calm, cssW, dpr);
    if (!drawn || !calm || reduce) return;
    const g = cv.getContext('2d')!;
    const n = calm.length / 2;
    const t0 = performance.now();
    const tick = (now: number): void => {
      if (!alive) return;
      const i = Math.floor(((now - t0) / 1000) * 60) % (n + 40);
      const k = Math.min(n - 1, i);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(drawn.base, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bx = drawn.cam.X(calm[k * 2]!);
      const by = drawn.cam.Y(calm[k * 2 + 1]!);
      g.fillStyle = C.ai;
      g.strokeStyle = C.ink;
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(bx, by, BALL_R * drawn.cam.s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  return {
    onKey(e) {
      if (e.key === 'Tab' || e.key === 'Shift' || e.metaKey || e.ctrlKey || e.altKey) return false;
      done();
      return true;
    },
    onEscape: done,
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
    },
  };
}

export type { GhostSummary };
