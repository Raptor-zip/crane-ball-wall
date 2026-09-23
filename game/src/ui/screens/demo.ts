// AI demo overlay (GAME_DESIGN.md §7.5 item 5, §8.4 item 6): the calm ghost plays at ×0.5 in the scene; this overlay
// shows a small F(t) graph (calm force and, if any, your last run's force), the AI gap and a skip button. The graph
// panel stays off the ball and the goal zone: tall on the deck, wide a low strip on the bench front under the floor
// (styles.css). Owner: O7.
// The same viewer plays a ranking row's replay (screen.replay, §7.5 item 6): that player's force against the AI par
// ghost's and your best's, a clock that stops on the ranked time, the re-simulation's gap and peak force, and
// 「このゴーストと勝負」 / 「戻る」. It holds on the last frame (core) until the player leaves; any other key returns.
import type { Screen, ScreenHandle, HudState } from '../ui';
import type { DemoInfo, ReplayView, ScreenEnv } from '../context';
import { h, s, setAttr, setText } from '../dom';
import { icon } from '../icons';
import { fmtMm, fmtTime, levelName, t } from '../i18n/format';

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
  if (screen.replay) return renderReplayViewer(root, screen.level, screen.replay, env);
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
  // Quiet lines: thinner strokes and fainter guides than the results graphs, the playhead in secondary ink.
  const playhead = s('line', { x1: 0, x2: 0, y1: 0, y2: H, stroke: '#4B5670', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' });
  const svg = s('svg', { class: 'demo-graph', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('demo.force') },
    s('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: 'rgba(30,42,68,.2)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: 6, y2: 6, stroke: 'rgba(229,72,77,.35)', 'stroke-dasharray': '6 5', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: H - 6, y2: H - 6, stroke: 'rgba(229,72,77,.35)', 'stroke-dasharray': '6 5', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    info?.meF ? s('path', { d: path(info.meF, n, Fmax, W, H), fill: 'none', stroke: '#C99700', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke', opacity: 0.8 }) : null,
    info ? s('path', { d: path(info.aiF, n, Fmax, W, H), fill: 'none', stroke: '#19C3FF', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }) : null,
    playhead);

  const aiGap = info?.aiGapMm ?? sum?.minGapMm ?? null;
  const aiPeak = info?.aiPeakF ?? sum?.peakF ?? null;
  // Two short lines (what the graph shows; the AI's numbers): beside the graph in the wide strip, above it when tall.
  const nums = h('div', { class: 'demo-row demo-nums' },
    aiGap !== null && level.physics.walls.length ? h('span', null, t('demo.gap'), ' ', h('span', { class: 'num' }, t('unit.mm', { v: fmtMm(aiGap) }))) : null,
    aiPeak !== null ? h('span', null, t('demo.peak'), ' ', h('span', { class: 'num' }, t('unit.N', { v: aiPeak.toFixed(1) }))) : null);
  const stats = h('div', { class: 'demo-stats' },
    h('div', { class: 'demo-row' },
      h('span', null, t('demo.force'), ' ', h('span', { class: 'num demo-range' }, `±${Math.round(Fmax)} N`)),
      h('span', { class: 'demo-legend' }, h('i', { style: 'background:#19C3FF' }), t('demo.aiLegend')),
      info?.meF ? h('span', { class: 'demo-legend' }, h('i', { style: 'background:#C99700' }), t('demo.youLegend')) : null),
    nums.childElementCount ? nums : null);
  const panel = h('div', { class: 'demo-panel' }, stats, svg, h('div', { class: 'note demo-hint' }, t('demo.anyKey')));
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
      // The first render gets the HUD of the screen before (a crash time, the results card's): not the demo's clock.
      if (hs.mode !== 'demo') return;
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

const GRAPH_W = 600;
const GRAPH_H = 140;
/** Keys in the viewer's first moments do not go back (core's DEMO_SKIP_GUARD_S for the commands of the input manager). */
export const REPLAY_KEY_GUARD_MS = 350;

/** The replay viewer's overlay (§7.5 item 6, §8.4 item 6): the demo's top bar and F(t) panel for a ranked run. */
function renderReplayViewer(root: HTMLElement, level: Extract<Screen, { id: 'demo' }>['level'], rv: ReplayView, env: ScreenEnv): ScreenHandle {
  const tall = env.layoutKind() === 'tall';
  const back = (): void => env.emit('retry', { from: 'replay' });
  const backBtn = h('button', { class: 'btn demo-back', type: 'button', 'data-autofocus': '', 'aria-label': t('replay.back') },
    icon('back'), h('span', { class: 'demo-back-label' }, t('replay.back')));
  backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    back();
  });
  // Not for my own run (racing yourself is the PB ghost's job). 「勝負」 on phones and short bars (the name chip first).
  const race = rv.mine ? null : h('button', { class: 'btn btn--gold demo-race', type: 'button', 'aria-label': t('replay.race') },
    icon('ghost'), h('span', { class: 'demo-race-full' }, t('replay.race')), h('span', { class: 'demo-race-short' }, t('replay.raceShort')));
  race?.addEventListener('click', (e) => {
    e.stopPropagation();
    env.emit('raceGhost', { id: rv.id });
  });
  // wide: who is playing, and the ranked time (in the chip the time stays whole, the name is cut if it must be). tall:
  // the tag on the crane and the clock say it.
  const whoName = h('span', { class: 'demo-who-name' }, rv.name);
  const who = tall ? null : h('span', { class: 'chip demo-level demo-who' },
    whoName, h('span', { class: 'num demo-who-time' }, `・${t('unit.s', { v: fmtTime(rv.t120) })}`));
  const top = h('div', { class: `demo-top demo-top--replay${tall ? ' is-race-short' : ''}` },
    h('span', { class: `demo-title demo-title--replay is-${rv.kind}` }, icon('play'),
      h('span', { class: 'demo-title-text' }, t('replay.title', { rank: rv.rank })),
      h('span', { class: 'demo-title-short' }, t('replay.legendPlayer', { rank: rv.rank })),
      h('span', { class: 'num demo-speed' }, t('demo.speed'))),
    who,
    h('span', { class: 'demo-top-gap' }),
    race, backBtn);

  const W = GRAPH_W;
  const H = GRAPH_H;
  const Fmax = rv.Fmax;
  const n = Math.max(rv.f.length, rv.aiF?.length ?? 0, rv.meF?.length ?? 0, 2);
  const playhead = s('line', { x1: 0, x2: 0, y1: 0, y2: H, stroke: '#4B5670', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' });
  const line = (f: Float32Array, cls: string): SVGElement =>
    s('path', { class: `demo-line ${cls}`, d: path(f, n, Fmax, W, H), fill: 'none', 'vector-effect': 'non-scaling-stroke' });
  // Drawn you -> AI -> the player (on top).
  const svg = s('svg', { class: 'demo-graph', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('demo.force') },
    s('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: 'rgba(30,42,68,.2)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: 6, y2: 6, stroke: 'rgba(229,72,77,.35)', 'stroke-dasharray': '6 5', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: H - 6, y2: H - 6, stroke: 'rgba(229,72,77,.35)', 'stroke-dasharray': '6 5', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    rv.meF ? line(rv.meF, 'demo-line--you') : null,
    rv.aiF ? line(rv.aiF, 'demo-line--ai') : null,
    line(rv.f, `demo-line--${rv.kind}`),
    playhead);

  const clock = h('span', { class: 'num demo-clock' }, t('unit.s', { v: fmtTime(0, 2) }));
  const legend = (cls: string, text: string): HTMLElement => h('span', { class: 'demo-legend' }, h('i', { class: cls }), text);
  // The numbers are this player's (the re-simulation's): the row starts with the player's own legend (■12位), so
  // they never read as the AI's or yours. The first row holds the graph's other lines.
  const nums = h('div', { class: 'demo-row demo-nums' },
    h('span', { class: 'demo-legend demo-owner' }, h('i', { class: `demo-sw--${rv.kind}` }), t('replay.legendPlayer', { rank: rv.rank })),
    h('span', null, h('span', { class: 'demo-time-label' }, t('replay.time'), ' '), clock),
    rv.gapMm !== null && level.physics.walls.length ? h('span', null, t('replay.gap'), ' ', h('span', { class: 'num' }, t('unit.mm', { v: fmtMm(rv.gapMm) }))) : null,
    Number.isFinite(rv.peakF) ? h('span', { class: 'demo-peak' }, t('replay.peak'), ' ', h('span', { class: 'num' }, t('unit.N', { v: rv.peakF.toFixed(1) }))) : null);
  const stats = h('div', { class: 'demo-stats' },
    h('div', { class: 'demo-row' },
      h('span', null, t('demo.force'), ' ', h('span', { class: 'num demo-range' }, `±${Math.round(Fmax)} N`)),
      rv.aiF ? legend('demo-sw--ai', t('replay.legendAi')) : null,
      rv.meF ? legend('demo-sw--you', t('replay.legendYou')) : null),
    nums);
  const panel = h('div', { class: 'demo-panel' }, stats, svg, h('div', { class: 'note demo-hint' }, t('replay.anyKey')));
  const el = h('div', { class: 'demo demo--replay' }, top, panel);
  root.appendChild(el);
  // Narrow bars (landscape phones, 125 % text): the buttons stay whole and the name chip readable. Step by step:
  // 「勝負」 for 「このゴーストと勝負」, the title 「12位」, no ×0.5, then 戻る as an icon. The name gives way last.
  const fits = (): boolean =>
    top.scrollWidth <= top.clientWidth + 1 && (!who || whoName.scrollWidth <= whoName.clientWidth + 1);
  const tighten = (): void => {
    for (const step of ['is-race-short', 'is-tight', 'is-tighter', 'is-back-icon']) {
      if (fits()) break;
      top.classList.add(step);
    }
  };
  tighten();
  // Web fonts arriving later are wider than the fallback: measure again.
  void document.fonts?.ready?.then(() => {
    if (top.isConnected) tighten();
  }, () => {});
  // Any input returns to the ranking (§2.1): a tap anywhere outside the panel and the bar, or any key.
  root.addEventListener('pointerdown', onTap);
  function onTap(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('.demo-panel, .demo-top')) return;
    back();
  }
  let done = false;
  /** A frame before the ranked time was on screen: 勝負 pops when the ball gets there, not on a re-render at the end. */
  let before = false;
  // The key that opened the viewer (Enter on a ▶, held and repeating) must not close it at once (core: the demo's guard).
  const opened = performance.now();
  return {
    onHud(hs: HudState) {
      // Only the viewer's own clock: the first render gets the results card's HUD (my finished time).
      if (hs.mode !== 'demo') return;
      // core's clock stops on the finish time when the hold starts: the ranked time (t120)
      const sub = Math.min(hs.timeSub, rv.t120);
      const x = Math.max(0, Math.min(W, ((sub / 120) * rv.hz) / Math.max(1, n - 1) * W));
      setAttr(playhead, 'x1', x.toFixed(1));
      setAttr(playhead, 'x2', x.toFixed(1));
      setText(clock, t('unit.s', { v: fmtTime(sub, sub >= rv.t120 ? 3 : 2) }));
      if (sub < rv.t120) before = true;
      else if (!done && before) {
        // The ball has reached the ranked time: the offer to race stands out once (no motion when reduced).
        done = true;
        race?.classList.add('is-done');
      }
    },
    onKey(e) {
      if (e.key === 'Tab' || e.key === 'Shift' || e.metaKey || e.ctrlKey || e.altKey) return false;
      // Enter / Space press the focused button (勝負 from the keyboard); every other key goes back.
      const btn = (e.target as HTMLElement).closest?.('button');
      if ((e.key === 'Enter' || e.key === ' ') && btn && btn !== backBtn) return false;
      if (!e.repeat && performance.now() - opened >= REPLAY_KEY_GUARD_MS) back();
      return true;
    },
    onEscape: back,
    dispose() {
      root.removeEventListener('pointerdown', onTap);
    },
  };
}
