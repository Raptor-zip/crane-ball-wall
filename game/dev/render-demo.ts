// dev/render-demo.html: feeds fake RenderFrames (scripted motion + ghosts + fx) to the renderer
// for any of the 18 levels (GAME_DESIGN.md §11 M4). Owner: O5.
//
// URL parameters
//   level=2-2            level id (default 2-2); daily levels too ("d:16", from daily_pool.json)
//   label=#23            the levelLoaded.label core would send (daily board heading: 「今日の5球 #23」)
//   scenario=run|crash|stop|slack   run = kinematic replay of the AI path (default); crash = naive
//                        dash to the goal (into the first wall); stop = slam into the right rail end
//                        (4-2 style); slack = 1.63 m dash-and-stop (Appendix B). crash / stop / slack
//                        run the REAL simulation (src/sim) with the §3.2 servo.
//   t=auto|end|snap|<sec> freeze at a time (auto = just after the first wall crossing / the event of
//                        the scenario, end = after the run ended); omitted = animate in a loop
//   ghosts=ai,pb,challenge   ghost set (ai, pb, wr, rival, challenge, calm, daily_pb)
//   q=auto|high|low      renderer quality (default high)
//   rm=1                 reduced motion
//   shot=1               hide the control panel (screenshots)
//   hud=0                hide the mock HUD / deck / popups
//   split=0.62           tall only: the old fixed 62 % scene / 38 % deck split with a 56 px HUD band instead
//                        of O7's layout (src/ui/layout.ts), to check the camera on other rects
//   skin=ball.steel,crane.wood,trail.wire,stage.site   cosmetic skin per part (skins spec §5.1), any combination,
//                        straight from src/render/skinLooks.ts LOOKS (never the save; locked or not). "ball:steel"
//                        works too; parts left out keep their default. Applied before renderer.init (the boot path);
//                        __RENDER_DEMO__.setSkin(spec) switches later (the settings path).
import levelsJson from '../src/data/levels.json';
import type { LevelDef, LevelsFile } from '../src/sim/level';
import type { GameEvent } from '../src/core/bus';
import type { GhostKind, Layout } from '../src/render/renderer';
import { createRenderer } from '../src/render/renderer';
import { computeLayout as uiLayout } from '../src/ui/layout';
import * as qualityMod from '../src/render/quality';
import * as shakeMod from '../src/render/shake';
import * as decalsMod from '../src/render/decals';
import * as particlesMod from '../src/render/particles';
import * as cameraMod from '../src/render/camera';
import * as mapperMod from '../src/render/mapper';
import { DEFAULT_LOOK, LOOKS, SKIN_PARTS, partLook } from '../src/render/skinLooks';
import type { SkinLook, SkinPart } from '../src/render/skinLooks';
import { SimRun, TrackRun, decodeTrack, frameOf, trackPose } from './render-demo-sim';
import type { DemoSource, GhostFile, GhostSpec, Track } from './render-demo-sim';

type Scenario = 'run' | 'crash' | 'stop' | 'slack';

declare global {
  interface Window {
    __RENDER_DEMO__?: {
      ready: boolean;
      levels: string[];
      load(opts: Partial<DemoOpts>): Promise<void>;
      stats(): ReturnType<ReturnType<typeof createRenderer>['stats']>;
      mapperCheck(): { maxErrMm: number; samples: number };
      shakeCheck(): { viewDiffPx: number; mapperErrMm: number };
      fx(e: GameEvent): void;
      time(): number;
      benchCpu(frames: number): number;
      /** Event types emitted since the last load (in order). */
      events(): string[];
      /** Every GameEvent emitted since the last load. */
      eventLog(): GameEvent[];
      pxPerM(): number;
      /** Runs `frames` frames of the current state with the given dt (s). */
      step(frames: number, dt: number): void;
      /** Feeds one frame with NaN alpha / dt / pose, then good frames; reports whether things recovered. */
      nanCheck(): { finite: boolean; screen: { x: number; y: number } };
      setOptions(o: { quality?: 'auto' | 'high' | 'low'; reducedMotion?: boolean }): void;
      /** Number of visible mock popups (O7 stand-ins). */
      popups(): number;
      /** Screen position (viewport CSS px) and radius of the player's cargo, via renderer.worldToScreen. */
      ball(): { x: number; y: number; r: number; egg: boolean };
      /** Renderer pixel probe (sRGB 0..255) at viewport CSS px. */
      probe(x: number, y: number): [number, number, number] | null;
      /** Ghost tags of the last frame (viewport CSS px). */
      tags(): ReturnType<ReturnType<typeof createRenderer>['ghostTags']>;
      /** Board heading + AI margin. */
      labels(): { board: string; aiMarginMm: number };
      /** Framing (viewport CSS px). */
      frame(): ReturnType<ReturnType<typeof createRenderer>['frame']>;
      /** The last layout handed to the renderer. */
      layout(): Layout;
      /** Current player pose (world metres). */
      pose(): { x: number; bx: number; by: number };
      /** renderer.worldToScreenBase (viewport CSS px). */
      toScreen(x: number, y: number): { x: number; y: number };
      setAiMarginMm(mm: number): void;
      /** renderer.loadLevel of the current level again, without a levelLoaded event (core does this for dailies). */
      reload(): void;
      /** Applies a skin spec ("ball.steel,crane.wood" / "ball:steel"; "" = default) through renderer.setSkin. */
      setSkin(spec: string): Record<SkinPart, string>;
      /** Ids of the skin in use (renderer.skin()). */
      skin(): Record<SkinPart, string>;
      /** The pure render modules, for in-page unit checks from the spec. */
      mods: {
        quality: typeof qualityMod; shake: typeof shakeMod; decals: typeof decalsMod; particles: typeof particlesMod;
        camera: typeof cameraMod; mapper: typeof mapperMod;
      };
    };
  }
}

interface DemoOpts {
  level: string; scenario: Scenario; t: string | null; ghosts: string[]; q: 'auto' | 'high' | 'low'; rm: boolean;
  /** levelLoaded.label (core's on-screen level name); undefined = none. */
  label?: string;
  /** D8: pretend the level data has ai.marginMm = this (null = as in the data). */
  marginMm?: number | null;
}

const LEVELS = (levelsJson as unknown as LevelsFile).levels;
const ghostLoaders = import.meta.glob<GhostFile>('../src/data/ghosts/*.json', { import: 'default' });
const params = new URLSearchParams(location.search);

const opts: DemoOpts = {
  level: params.get('level') ?? '2-2',
  scenario: (params.get('scenario') as Scenario) ?? 'run',
  t: params.get('t'),
  ghosts: (params.get('ghosts') ?? 'ai,pb,challenge').split(',').filter(Boolean),
  q: (params.get('q') as DemoOpts['q']) ?? 'high',
  rm: params.get('rm') === '1',
  label: params.get('label') ?? undefined,
};
const shot = params.get('shot') === '1';
const showHud = params.get('hud') !== '0';

const root = document.getElementById('demo') as HTMLDivElement;
const canvas = document.createElement('canvas');
canvas.className = 'scene';
root.appendChild(canvas);
const hud = document.getElementById('hud') as HTMLDivElement;
const deck = document.getElementById('deck') as HTMLDivElement;
const forceBar = document.getElementById('forcebar') as HTMLDivElement;
const panel = document.getElementById('panel') as HTMLDivElement;
const popLayer = document.getElementById('pops') as HTMLDivElement;
if (shot) panel.style.display = 'none';
if (!showHud) {
  hud.style.display = 'none';
  deck.style.display = 'none';
  forceBar.style.display = 'none';
  popLayer.style.display = 'none';
}

/** Look of a skin spec: comma-separated ids ("ball.steel" or "ball:steel"); unknown tokens are ignored. */
function lookOf(spec: string): SkinLook {
  const out: SkinLook = { ...DEFAULT_LOOK };
  for (const raw of spec.split(',')) {
    const tok = raw.trim().replace(':', '.');
    const part = tok.split('.')[0] as SkinPart;
    if (!SKIN_PARTS.includes(part) || !Object.prototype.hasOwnProperty.call(LOOKS[part], tok)) continue;
    (out as Record<SkinPart, SkinLook[SkinPart]>)[part] = partLook(part, tok);
  }
  return out;
}

const renderer = createRenderer();
renderer.setSkin(lookOf(params.get('skin') ?? ''));
renderer.init(canvas, { quality: opts.q, reducedMotion: opts.rm });

const split = Number(params.get('split'));
function computeLayout(): Layout {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (h / w >= 1.25 && split > 0 && split < 1) {
    const sh = Math.round(h * split);
    return { kind: 'tall', w, h, dpr, scene: { x: 0, y: 0, w, h: sh }, deck: { x: 0, y: sh, w, h: h - sh }, hudTop: 56 };
  }
  // The real game's layout (O7).
  return uiLayout(w, h, dpr, 0);
}

let layout = computeLayout();
function applyLayout(): void {
  layout = computeLayout();
  canvas.style.left = `${layout.scene.x}px`;
  canvas.style.top = `${layout.scene.y}px`;
  renderer.setLayout(layout);
  document.body.dataset.layout = layout.kind;
  const hudPanel = document.getElementById('hudpanel') as HTMLDivElement;
  hudPanel.style.height = `${Math.max(0, layout.hudTop - 56 - 8)}px`;
  if (!showHud) hudPanel.style.display = 'none';
  if (layout.deck) {
    deck.style.display = showHud ? 'block' : 'none';
    deck.style.top = `${layout.deck.y}px`;
    deck.style.height = `${layout.deck.h}px`;
  } else {
    deck.style.display = 'none';
  }
}
applyLayout();

let run: DemoSource | null = null;
let ghosts: GhostSpec[] = [];
let level: LevelDef | null = null;
let acc = 0;
let frozen = false;
let endHold = 0;
let aiPathNow: Float32Array | null = null;
let aiLine = true;
let margin = true;
let log: GameEvent[] = [];

const LABELS: Record<string, string> = { ai: 'AI', pb: 'PB', wr: 'WR', rival: 'ライバル', challenge: '挑戦状', calm: 'AI(お手本)', daily_pb: '今日のベスト' };

let dailyPool: LevelDef[] | null = null;
async function dailyLevel(id: string): Promise<LevelDef | null> {
  if (!id.startsWith('d:')) return null;
  if (!dailyPool) dailyPool = ((await import('../src/data/daily_pool.json')).default as unknown as { pool: LevelDef[] }).pool;
  return dailyPool.find((l) => l.id === id) ?? null;
}

async function loadTracks(id: string): Promise<Track[]> {
  if (id.startsWith('d:')) {
    const file = (await import('../src/data/daily_ghosts.json')).default as unknown as { ghosts: Record<string, GhostFile['ghosts']> };
    return (file.ghosts[id] ?? []).map(decodeTrack);
  }
  const key = `../src/data/ghosts/${id}.json`;
  const loader = ghostLoaders[key];
  if (!loader) return [];
  const file = await loader();
  return file.ghosts.map(decodeTrack);
}

function sourceFor(lv: LevelDef, scenario: Scenario, tracks: Track[]): DemoSource {
  const ph = lv.physics;
  if (scenario === 'crash') {
    const goal = lv.ai.xGoal[0] ?? ph.rail[1];
    return new SimRun(lv, () => goal, 0.6);
  }
  if (scenario === 'slack') {
    // Appendix B: dash 1.63 m from rest and stop -> the string goes slack while braking, then snaps.
    return new SimRun(lv, () => ph.startX + 1.63, 0.6);
  }
  if (scenario === 'stop') {
    return new SimRun(lv, (t) => (t < 2.2 ? ph.rail[1] + 0.3 : ph.rail[1] - 0.05), 0.6);
  }
  const calm = tracks.find((t) => t.kind === 'calm') ?? tracks.find((t) => t.kind === 'ai');
  if (calm) return new TrackRun(lv, calm, 0.6);
  // No ghost data: a scripted back-swing then a dash, on the real simulation.
  const goal = lv.ai.xGoal[0] ?? ph.startX + 1;
  return new SimRun(lv, (t) => (t < 0.8 ? ph.startX - 0.3 : goal), 0.6);
}

function ghostSpecs(tracks: Track[], names: string[]): GhostSpec[] {
  const ai = tracks.find((t) => t.kind === 'ai');
  const calm = tracks.find((t) => t.kind === 'calm');
  const fast = tracks.find((t) => t.kind === 'research_fast');
  if (!ai) return [];
  const out: GhostSpec[] = [];
  for (const n of names.slice(0, 4)) {
    const kind = n as GhostKind;
    const label = LABELS[n] ?? n;
    if (n === 'ai') out.push({ kind, label, track: ai, slow: 1, delay: 0 });
    else if (n === 'calm' && calm) out.push({ kind, label, track: calm, slow: 1, delay: 0 });
    else if (n === 'pb') out.push({ kind, label, track: ai, slow: 1.18, delay: 0.1 });
    else if (n === 'wr') out.push({ kind, label, track: ai, slow: 1.04, delay: 0 });
    else if (n === 'rival') out.push({ kind, label, track: fast ?? ai, slow: 1.1, delay: 0.05 });
    else if (n === 'challenge') out.push({ kind, label, track: fast ?? ai, slow: 1.0, delay: 0.25 });
    else if (n === 'daily_pb') out.push({ kind, label, track: ai, slow: 1.25, delay: 0 });
  }
  return out;
}

// ---- mock popups (the real ones are O7's DOM, positioned with renderer.worldToScreen) ----------
interface Pop { el: HTMLDivElement; born: number; life: number }
const pops: Pop[] = [];
const TIERS: [number, string, string][] = [[2, '神業', '#b44dff'], [5, '紙一重', '#e5484d'], [10, 'スレスレ', '#ff9f43'], [20, 'ギリギリ', '#ffe066'], [40, 'ニアミス', '#ffffff']];
function simTime(): number {
  return run ? run.s.t : 0;
}
function addPop(html: string, x: number, y: number, cls: string, life: number): void {
  const el = document.createElement('div');
  el.className = `mock-pop ${cls}`;
  el.innerHTML = html;
  el.style.left = `${Math.round(Math.min(window.innerWidth - 70, Math.max(70, x)))}px`;
  el.style.top = `${Math.round(y)}px`;
  popLayer.appendChild(el);
  pops.push({ el, born: simTime(), life });
  while (pops.length > 6) (pops.shift() as Pop).el.remove();
}
function prunePops(): void {
  const t = simTime();
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i] as Pop;
    if (t - p.born > p.life || t < p.born) {
      p.el.remove();
      pops.splice(i, 1);
    }
  }
}
function clearPops(): void {
  for (const p of pops) p.el.remove();
  pops.length = 0;
}
function mockUi(e: GameEvent): void {
  if (e.t === 'cross' && e.gapMm < 40) {
    const tier = TIERS.find(([lim]) => e.gapMm < lim) as [number, string, string];
    const p = renderer.worldToScreen(e.px, e.py);
    const mm = e.gapMm < 10 ? e.gapMm.toFixed(1) : String(Math.round(e.gapMm));
    addPop(`<b>ギリ ${mm}mm</b><i style="background:${tier[2]}">${tier[1]}</i>`, p.x, p.y - 78, 'near', 1.2);
  } else if (e.t === 'crash') {
    const p = renderer.worldToScreen(e.x, e.y);
    const cause = ['', 'ゴツン', '紐が引っかかった', 'レールに激突', '床に激突', 'たまごが割れた'][e.kind] ?? '';
    addPop('ゴンッ', p.x, p.y - 30, 'bang', 0.8);
    addPop(`<b>−${e.overlapMm.toFixed(1)}mm</b><i>${cause}</i>`, p.x, p.y + 16, 'crashinfo', 0.8);
  } else if (e.t === 'snap' && e.J >= 0.5) {
    const p = renderer.worldToScreen(e.x, e.y);
    addPop('パシッ', p.x + 40, p.y - 36, 'bang', 0.8);
  } else if (e.t === 'retry' || e.t === 'ready') {
    clearPops();
  }
}

function emit(evs: GameEvent[]): void {
  for (const e of evs) {
    log.push(e);
    renderer.fx(e);
    mockUi(e);
  }
}

/** Runs the demo timeline to `t` with fixed 1/60 frames, rendering only the last one. */
function runTo(t: number): void {
  if (!run) return;
  const frames = Math.max(1, Math.round((t + 0.6) * 60));
  renderer.skipRender = true;
  for (let i = 0; i < frames; i++) {
    emit(run.advance());
    if (i === frames - 1) renderer.skipRender = false;
    renderer.draw(frameOf(run, ghosts, 1, { showAiLine: aiLine, showMargin: margin }), 1 / 60);
    prunePops();
  }
  renderer.skipRender = false;
  updateMock();
}

function autoTime(lv: LevelDef, tracks: Track[], scenario: Scenario, which: string): number {
  const probe = sourceFor(lv, scenario, tracks);
  let crossT = -1, endT = -1, slackT = -1;
  for (let i = 0; i < 60 * 40; i++) {
    const evs = probe.advance();
    for (const e of evs) {
      if (e.t === 'cross' && crossT < 0) crossT = probe.s.t;
      if (e.t === 'success' || e.t === 'timeout' || e.t === 'crash') endT = probe.s.t;
      if (e.t === 'stop' && scenario === 'stop' && e.speed > 1 && endT < 0) endT = probe.s.t;
      if (e.t === 'slack' && scenario === 'slack' && slackT < 0) slackT = probe.s.t;
      if (e.t === 'snap' && scenario === 'slack' && which === 'snap' && endT < 0) endT = probe.s.t;
    }
    if (endT >= 0) break;
  }
  if (scenario === 'stop') return endT >= 0 ? endT + 0.07 : 1.9;
  if (scenario === 'slack') return which === 'snap' ? (endT >= 0 ? endT + 0.02 : 1) : slackT >= 0 ? slackT + 0.12 : 1;
  if (scenario === 'crash') return endT >= 0 ? endT + 0.12 : 3;
  if (which === 'end') return endT >= 0 ? endT + 0.7 : 6;
  if (crossT >= 0) return crossT + 0.28;
  const calm = tracks.find((t) => t.kind === 'calm') ?? tracks[0];
  return calm ? (calm.x.length / 60) * 0.45 : 1.5;
}

async function load(o: Partial<DemoOpts>): Promise<void> {
  Object.assign(opts, o);
  const demo = window.__RENDER_DEMO__;
  if (demo) demo.ready = false;
  const lv0 = (await dailyLevel(opts.level)) ?? LEVELS.find((l) => l.id === opts.level) ?? (LEVELS[0] as LevelDef);
  const lv: LevelDef = typeof opts.marginMm === 'number' ? { ...lv0, ai: { ...lv0.ai, marginMm: opts.marginMm } as LevelDef['ai'] } : lv0;
  level = lv;
  const tracks = await loadTracks(lv.id);
  const ai = tracks.find((t) => t.kind === 'ai');
  let aiPath: Float32Array | null = null;
  if (ai) {
    aiPath = new Float32Array(ai.x.length * 2);
    for (let i = 0; i < ai.x.length; i++) {
      const p = trackPose(ai, i / 60, lv.physics.L);
      aiPath[i * 2] = p.bx;
      aiPath[i * 2 + 1] = p.by;
    }
  }
  aiLine = lv.world <= 2;
  margin = lv.world <= 2;
  (document.getElementById('aiLine') as HTMLInputElement).checked = aiLine;
  (document.getElementById('margin') as HTMLInputElement).checked = margin;
  log = [];
  clearPops();
  aiPathNow = aiPath;
  renderer.loadLevel(lv, aiPath, lv.cargo === 'egg');
  // As core does (D8): the level's own AI margin (ghosts_summary's aiMarginMm would win in the game).
  const mm = (lv.ai as { marginMm?: number }).marginMm;
  renderer.setAiMarginMm(typeof mm === 'number' && mm > 0 ? mm : 20);
  renderer.fx(opts.label !== undefined ? { t: 'levelLoaded', level: lv, label: opts.label } : { t: 'levelLoaded', level: lv });
  renderer.fx({ t: 'ready' });
  ghosts = ghostSpecs(tracks, opts.ghosts);
  run = sourceFor(lv, opts.scenario, tracks);
  acc = 0;
  endHold = 0;
  frozen = false;
  (document.getElementById('title') as HTMLSpanElement).textContent = `${lv.world === 0 ? '今日の5球' : lv.id}  ${lv.name.ja}`;
  (document.getElementById('levelSel') as HTMLSelectElement).value = lv.id;
  if (opts.t !== null) {
    const t = opts.t === 'auto' || opts.t === 'end' || opts.t === 'snap' ? autoTime(lv, tracks, opts.scenario, opts.t) : Number(opts.t);
    runTo(Number.isFinite(t) ? t : 1);
    frozen = true;
  }
  // Two RAFs so the frame is on screen before `ready`.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  if (window.__RENDER_DEMO__) window.__RENDER_DEMO__.ready = true;
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (run && level && !frozen) {
    acc += dt;
    let n = 0;
    while (acc >= 1 / 60 && n < 4) {
      emit(run.advance());
      acc -= 1 / 60;
      n++;
    }
    if (acc > 1 / 60) acc = 0;
    const st = run.s.status as number;
    if (st >= 2) {
      endHold += dt;
      if (endHold > 2.4) {
        renderer.fx({ t: 'retry' });
        void load({});
      }
    }
    renderer.draw(frameOf(run, ghosts, acc * 60, { showAiLine: aiLine, showMargin: margin }), dt);
    prunePops();
    updateMock();
  }
  requestAnimationFrame(loop);
}

// ---- mock HUD / deck (the real ones are O7's DOM) ----------------------------------------------
const clock = document.getElementById('clock') as HTMLSpanElement;
const fbFill = document.getElementById('fbfill') as HTMLDivElement;
function updateMock(): void {
  if (!run) return;
  clock.textContent = Math.max(0, run.s.t).toFixed(2);
  const k = run.phys.Fmax > 0 ? run.s.F / run.phys.Fmax : 0;
  fbFill.style.left = k < 0 ? `${50 + k * 50}%` : '50%';
  fbFill.style.width = `${Math.abs(k) * 50}%`;
  fbFill.style.background = Math.abs(k) > 0.99 ? 'var(--danger)' : 'var(--ink)';
}

// ---- control panel -----------------------------------------------------------------------------
const sel = document.getElementById('levelSel') as HTMLSelectElement;
for (const l of LEVELS) {
  const o = document.createElement('option');
  o.value = l.id;
  o.textContent = `${l.id} ${l.name.ja}`;
  sel.appendChild(o);
}
sel.addEventListener('change', () => void load({ level: sel.value, t: null }));
const fxButtons: [string, () => GameEvent | null][] = [
  ['snap', () => run && { t: 'snap', J: 1.3, x: run.cur.bx, y: run.cur.by }],
  ['stop', () => ({ t: 'stop', side: 1, speed: 3.2 })],
  ['near', () => {
    const w = level?.physics.walls[0];
    return w ? { t: 'cross', wall: 0, dir: 1, gapMm: 6.2, speed: 2.4, px: w.x0, py: w.h } : null;
  }],
  ['crash', () => {
    const w = level?.physics.walls[0];
    return w ? { t: 'crash', kind: 1, wall: 0, x: w.x0, y: w.h * 0.8, overlapMm: 4 } : { t: 'crash', kind: 4, wall: -1, x: 1, y: 0, overlapMm: 0 };
  }],
  ['success', () => ({ t: 'success', score: 300, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] })],
  ['apex', () => run && { t: 'apex', ampDeg: 60, reqDeg: 50, reached: true, x: run.cur.x, y: 1.25 }],
  ['retry', () => ({ t: 'retry' })],
];
const fxBox = document.getElementById('fxButtons') as HTMLDivElement;
for (const [name, mk] of fxButtons) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => {
    const e = mk();
    if (e) emit([e]);
  });
  fxBox.appendChild(b);
}
// Skin pickers (one select per part).
{
  const box = document.createElement('div');
  for (const part of SKIN_PARTS) {
    const s = document.createElement('select');
    s.dataset.part = part;
    for (const id of Object.keys(LOOKS[part])) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      s.appendChild(o);
    }
    s.value = renderer.skin()[part];
    s.addEventListener('change', () => {
      const cur = renderer.skin();
      cur[part] = s.value;
      renderer.setSkin(lookOf(Object.values(cur).join(',')));
      if (frozen) void load({});
    });
    box.appendChild(s);
  }
  fxBox.appendChild(box);
}
for (const sc of ['run', 'crash', 'stop', 'slack'] as const) {
  const b = document.createElement('button');
  b.textContent = `▶ ${sc}`;
  b.addEventListener('click', () => void load({ scenario: sc, t: null }));
  fxBox.appendChild(b);
}
(document.getElementById('aiLine') as HTMLInputElement).addEventListener('change', (e) => { aiLine = (e.target as HTMLInputElement).checked; });
(document.getElementById('margin') as HTMLInputElement).addEventListener('change', (e) => { margin = (e.target as HTMLInputElement).checked; });

// Clicking the scene shows where the rail mapper puts the target (wide).
canvas.addEventListener('pointerdown', (e) => {
  const x = renderer.mapper.screenToRailX(e.clientX, e.clientY);
  if (x !== null) (document.getElementById('mapped') as HTMLSpanElement).textContent = `x = ${x.toFixed(3)} m`;
});

window.addEventListener('resize', () => {
  applyLayout();
  if (frozen && opts.t !== null) void load({});
});

const frame = (): ReturnType<typeof frameOf> | null => (run ? frameOf(run, ghosts, 1, { showAiLine: aiLine, showMargin: margin }) : null);

window.__RENDER_DEMO__ = {
  ready: false,
  levels: LEVELS.map((l) => l.id),
  load,
  stats: () => renderer.stats(),
  fx: (e) => emit([e]),
  time: () => (run ? run.s.t : 0),
  events: () => log.map((e) => e.t),
  eventLog: () => log.slice(),
  pxPerM: () => renderer.pxPerM(),
  popups: () => pops.length,
  ball() {
    if (!run || !level) return { x: NaN, y: NaN, r: 0, egg: false };
    const p = renderer.worldToScreen(run.cur.bx, run.cur.by);
    return { x: p.x, y: p.y, r: 0.06 * renderer.pxPerM(), egg: level.cargo === 'egg' };
  },
  probe: (x, y) => renderer.probe(x, y),
  tags: () => renderer.ghostTags(),
  labels: () => renderer.labels(),
  frame: () => renderer.frame(),
  layout: () => layout,
  pose: () => (run ? { x: run.cur.x, bx: run.cur.bx, by: run.cur.by } : { x: NaN, bx: NaN, by: NaN }),
  toScreen: (x, y) => renderer.worldToScreenBase(x, y),
  setAiMarginMm: (mm) => renderer.setAiMarginMm(mm),
  reload() {
    if (level) renderer.loadLevel(level, aiPathNow, level.cargo === 'egg');
  },
  mods: { quality: qualityMod, shake: shakeMod, decals: decalsMod, particles: particlesMod, camera: cameraMod, mapper: mapperMod },
  setSkin(spec) {
    renderer.setSkin(lookOf(spec));
    return renderer.skin();
  },
  skin: () => renderer.skin(),
  setOptions: (o) => renderer.setOptions(o),
  step(frames, dt) {
    const f = frame();
    if (!f) return;
    for (let i = 0; i < frames; i++) renderer.draw(f, dt);
  },
  benchCpu(frames) {
    // Average CPU ms of draw() without the GPU submit (scene update, batches, particles).
    const f = frame();
    if (!f) return NaN;
    renderer.skipRender = true;
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) renderer.draw(f, 1 / 60);
    renderer.skipRender = false;
    return (performance.now() - t0) / frames;
  },
  nanCheck() {
    const f = frame();
    if (!f || !level) return { finite: false, screen: { x: NaN, y: NaN } };
    const bad = { ...f, alpha: NaN, L: NaN, prev: { ...f.prev, x: NaN, bx: NaN }, cur: { ...f.cur, by: NaN } };
    renderer.draw(bad, NaN);
    renderer.fx({ t: 'snap', J: NaN, x: NaN, y: NaN });
    renderer.fx({ t: 'stop', side: 1, speed: NaN });
    for (let i = 0; i < 5; i++) renderer.draw(f, 1 / 60);
    const s = renderer.worldToScreen(level.physics.startX, 0.6);
    return { finite: Number.isFinite(s.x) && Number.isFinite(s.y), screen: s };
  },
  shakeCheck() {
    // Big shake (stop + snap), one frame: the rendered camera moves, the rail mapper must not.
    // (In tall the follow camera may also move; the mapper must match the unshaken base camera.)
    if (!run || !level) return { viewDiffPx: NaN, mapperErrMm: NaN };
    const x = (level.physics.rail[0] + level.physics.rail[1]) / 2;
    renderer.fx({ t: 'stop', side: 1, speed: 4 });
    renderer.fx({ t: 'snap', J: 5, x: run.cur.bx, y: run.cur.by });
    renderer.draw(frameOf(run, ghosts, 1, { showAiLine: aiLine, showMargin: margin }), 1 / 60);
    const view = renderer.worldToScreen(x, 0.6);
    const base = renderer.worldToScreenBase(x, 0.6);
    const back = renderer.mapper.screenToRailX(base.x, base.y);
    return {
      viewDiffPx: Math.hypot(view.x - base.x, view.y - base.y),
      mapperErrMm: back === null ? NaN : Math.abs(back - x) * 1000,
    };
  },
  mapperCheck() {
    // Round trip: world x on the ball plane -> screen -> rail x, over the level's x range.
    let maxErr = 0, n = 0;
    if (!level) return { maxErrMm: NaN, samples: 0 };
    const [a, b] = [level.physics.rail[0] - 0.3, level.physics.rail[1] + 0.3];
    for (let x = a; x <= b; x += 0.05) {
      for (const y of [0.2, 0.7, 1.2]) {
        const p = renderer.worldToScreenBase(x, y);
        const back = renderer.mapper.screenToRailX(p.x, p.y);
        if (back === null) continue;
        maxErr = Math.max(maxErr, Math.abs(back - x) * 1000);
        n++;
      }
    }
    return { maxErrMm: maxErr, samples: n };
  },
};

void load({}).then(() => requestAnimationFrame(loop));
