// AI demo overlay (GAME_DESIGN.md §7.5 item 5, §8.4 item 6): the calm ghost plays at ×0.5 in the scene; this overlay
// shows the F(t) graph (calm force and, if any, your last run's force), the AI gap and a skip button. Owner: O7.
import type { Screen, ScreenHandle, HudState } from '../ui';
import type { DemoInfo, ScreenEnv } from '../context';
import { h, s, setAttr } from '../dom';
import { icon } from '../icons';
import { fmtMm, levelName, t } from '../i18n/format';

function path(f: ArrayLike<number>, n: number, Fmax: number, W: number, H: number): string {
  if (f.length < 2) return '';
  const step = Math.max(1, Math.floor(f.length / 400));
  let d = '';
  for (let i = 0; i < f.length; i += step) {
    const x = (i / (n - 1)) * W;
    const y = H / 2 - (Math.max(-Fmax, Math.min(Fmax, f[i]!)) / Fmax) * (H / 2 - 6);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

export function renderDemoScreen(root: HTMLElement, screen: Extract<Screen, { id: 'demo' }>, env: ScreenEnv): ScreenHandle {
  const level = screen.level;
  let info: DemoInfo | null = null;
  try {
    info = env.ctx.demo?.(level) ?? null;
  } catch {
    info = null;
  }
  const sum = env.summary(level.id);
  const skip = (): void => env.emit('retry', { from: 'demo' });
  const skipBtn = h('button', { class: 'btn', type: 'button', 'data-autofocus': '' }, icon('skip'), t('demo.skip'));
  skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    skip();
  });
  const top = h('div', { class: 'demo-top' },
    h('span', { class: 'demo-title' }, icon('demo'), t('demo.title'), h('span', { class: 'num' }, t('demo.speed'))),
    env.layoutKind() === 'wide' ? h('span', { class: 'chip demo-level' }, `${level.world === 0 ? '' : `${level.id} `}${levelName(level)}`) : null,
    skipBtn);

  const W = 600;
  const H = 140;
  const Fmax = info?.Fmax ?? level.physics.Fmax;
  const n = info ? Math.max(info.aiF.length, info.meF?.length ?? 0, 2) : 2;
  const playhead = s('line', { x1: 0, x2: 0, y1: 0, y2: H, stroke: '#1E2A44', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
  const svg = s('svg', { class: 'demo-graph', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('demo.force') },
    s('rect', { x: 0, y: 0, width: W, height: H, fill: '#FFFDF8' }),
    s('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: 'rgba(30,42,68,.35)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: 6, y2: 6, stroke: 'rgba(229,72,77,.5)', 'stroke-dasharray': '6 5', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: H - 6, y2: H - 6, stroke: 'rgba(229,72,77,.5)', 'stroke-dasharray': '6 5', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    info?.meF ? s('path', { d: path(info.meF, n, Fmax, W, H), fill: 'none', stroke: '#C99700', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', opacity: 0.9 }) : null,
    info ? s('path', { d: path(info.aiF, n, Fmax, W, H), fill: 'none', stroke: '#19C3FF', 'stroke-width': 2.6, 'vector-effect': 'non-scaling-stroke' }) : null,
    playhead);

  const aiGap = info?.aiGapMm ?? sum?.minGapMm ?? null;
  const aiPeak = info?.aiPeakF ?? sum?.peakF ?? null;
  const stats = h('div', { class: 'demo-stats' },
    h('span', null, t('demo.force'), ' ', h('span', { class: 'num', style: 'color:var(--ink-2)' }, `±${Math.round(Fmax)} N`)),
    h('span', { class: 'demo-legend' }, h('i', { style: 'background:#19C3FF' }), t('demo.aiLegend')),
    info?.meF ? h('span', { class: 'demo-legend' }, h('i', { style: 'background:#C99700' }), t('demo.youLegend')) : null,
    aiGap !== null && level.physics.walls.length ? h('span', null, t('demo.gap'), ' ', h('span', { class: 'num' }, t('unit.mm', { v: fmtMm(aiGap) }))) : null,
    aiPeak !== null ? h('span', null, t('demo.peak'), ' ', h('span', { class: 'num' }, t('unit.N', { v: aiPeak.toFixed(1) }))) : null);
  const panel = h('div', { class: 'demo-panel' }, stats, svg, h('div', { class: 'note', style: 'text-align:right;margin-top:4px' }, t('demo.anyKey')));
  const el = h('div', { class: 'demo' }, top, panel);
  root.appendChild(el);
  // Any input skips (§2.1): a tap anywhere outside the panel, or any key.
  root.addEventListener('pointerdown', onTap);
  function onTap(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('.demo-panel, .demo-top')) return;
    skip();
  }
  const hz = info?.hz ?? 60;
  return {
    onHud(hs: HudState) {
      const tSec = hs.timeSub / 120;
      const x = Math.max(0, Math.min(W, (tSec * hz) / Math.max(1, n - 1) * W));
      setAttr(playhead, 'x1', x.toFixed(1));
      setAttr(playhead, 'x2', x.toFixed(1));
    },
    onKey(e) {
      if (e.key === 'Tab' || e.key === 'Shift' || e.metaKey || e.ctrlKey || e.altKey) return false;
      skip();
      return true;
    },
    onEscape: skip,
    dispose() {
      root.removeEventListener('pointerdown', onTap);
    },
  };
}
