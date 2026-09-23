// Audio & haptics demo page (GAME_DESIGN.md §9.5, §9.6, §11 M5). Owner: O6.
// Every effect has a button, the continuous motor / wind have sliders, and three scripted scenarios play the
// sounds in context through the real event mapping (engine.fx). Dev-only: labels are inline ja / en.
import { createAudioEngine } from '../src/audio/engine';
import { createHaptics } from '../src/audio/haptics';
import { apexStep, nearMissTier, pentaMidi, type SfxId } from '../src/audio/sfx';
import type { GameEvent } from '../src/core/bus';

// Auto-wired: unlock on the first gesture, suspend while hidden, UI clicks on buttons. Every scheduled sound is logged.
const engine = createAudioEngine({ onSound: (id, _at, param) => onSound(id, param) });
const haptics = createHaptics();
const FMAX = 20;
const soundCounts = new Map<SfxId, number>();
function onSound(id: SfxId, param: number | undefined): void {
  soundCounts.set(id, (soundCounts.get(id) ?? 0) + 1);
  if (id !== 'hold') log(`♪ ${id}${param !== undefined ? ` ${Math.round(param * 100) / 100}` : ''}`);
}

// ---- tiny DOM helpers -------------------------------------------------------------------------

type Kid = Node | string | null | false;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k) e.append(k);
  return e;
}
function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function slider(name: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string,
  onInput: (v: number) => void): { root: HTMLLabelElement; input: HTMLInputElement; set(v: number): void } {
  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute('aria-label', name);
  const out = el('output', '', fmt(value));
  const root = el('label', 'slider', el('span', '', name), input, out);
  const upd = (): void => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    onInput(v);
  };
  input.addEventListener('input', upd);
  return { root, input, set: (v: number) => { input.value = String(v); upd(); } };
}
function checkbox(name: string, value: boolean, onChange: (v: boolean) => void): { root: HTMLLabelElement; input: HTMLInputElement } {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return { root: el('label', '', input, name), input };
}
function select<T extends string>(name: string, options: [T, string][], onChange: (v: T) => void): HTMLLabelElement {
  const s = el('select');
  for (const [v, l] of options) {
    const o = el('option', '', l);
    o.value = v;
    s.append(o);
  }
  s.setAttribute('aria-label', name);
  s.addEventListener('change', () => onChange(s.value as T));
  return el('label', '', name, s);
}
function card(title: string, sub: string, desc: string, ...kids: Kid[]): HTMLElement {
  return el('section', 'card', el('h3', '', title, el('span', '', sub)), desc ? el('p', '', desc) : null, ...kids);
}

const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (m: number): string => `${NOTE[m % 12] ?? '?'}${Math.floor(m / 12) - 1}`;

// ---- events, log ------------------------------------------------------------------------------

const logEl = el('pre');
logEl.id = 'log';
const logLines: string[] = [];
function log(s: string): void {
  logLines.unshift(`${(performance.now() / 1000).toFixed(2).padStart(7)}  ${s}`);
  logLines.length = Math.min(logLines.length, 40);
  logEl.textContent = logLines.join('\n');
}
function emit(e: GameEvent): void {
  engine.fx(e);
  haptics.fx(e);
  const { t, ...rest } = e;
  log(`${t} ${JSON.stringify(rest)}`);
}
function play(id: SfxId, param?: number, pan = 0): void {
  engine.play(id, param, pan);
}

// ---- continuous state + scenarios -------------------------------------------------------------

interface Cont { running: boolean; v: number; f: number; saturated: boolean; ballSpeed: number; panX: number }
const manual: Cont = { running: false, v: 0, f: 0, saturated: false, ballSpeed: 0, panX: 0 };

interface Scenario { name: string; duration: number; frame(t: number): Cont; events: [number, GameEvent][] }
/** Scenario clock in sim seconds (advances at timeScale, like the game loop). */
let active: { s: Scenario; t: number; next: number } | null = null;

// Sim clock (D7): the game's timeScale (practice 0.5, near-miss slow-mo 0.35, hit-stop 0) is passed to
// engine.update(); scenarios and the hold demos below run on this clock, so the riser can be heard stretching.
let timeScale = 1;
let simNow = 0;
const simTimers: { at: number; fn: () => void }[] = [];
/** Sim time until which a hold demo counts as a running run (update() running: true), like the game. */
let holdingUntil = -1;
function afterSim(seconds: number, fn: () => void): void {
  simTimers.push({ at: simNow + seconds, fn });
  simTimers.sort((a, b) => a.at - b.at);
}

function pendulum(): Scenario {
  const T = 2.0;
  const w = (2 * Math.PI) / T;
  const grow = 9;
  const tau = 2.2;
  const amp = (t: number): number => (t < grow ? 5 + 65 * (t / grow) : Math.max(1, 70 * Math.exp(-(t - grow) / tau)));
  const duration = grow + tau * Math.log(70 / 2.5);
  const events: [number, GameEvent][] = [[0, { t: 'runStart' }]];
  for (let k = 0; ; k++) {
    const tk = (k + 0.5) * (T / 2);
    if (tk > duration) break;
    const a = amp(tk);
    events.push([tk, { t: 'apex', ampDeg: a, reqDeg: 50, reached: a >= 50, x: 0, y: 0 }]);
  }
  return {
    name: '振り子（こぐ→止める）/ Pumping swing',
    duration,
    events,
    frame(t) {
      const a = (amp(t) * Math.PI) / 180;
      const th = a * Math.sin(w * t);
      const pumping = t < grow;
      return {
        running: true,
        v: (pumping ? 0.55 : -0.25) * Math.cos(w * t),
        f: (pumping ? 0.45 : -0.3) * Math.cos(w * t),
        saturated: false,
        ballSpeed: 1.0 * a * w * Math.abs(Math.cos(w * t)),
        panX: 0.1 + 0.6 * Math.sin(th),
      };
    },
  };
}

function fullRun(crash: boolean): Scenario {
  const events: [number, GameEvent][] = [
    [0, { t: 'runStart' }],
    [0.1, { t: 'saturate', on: true }],
    [0.55, { t: 'saturate', on: false }],
    [0.9, { t: 'apex', ampDeg: 28, reqDeg: 45, reached: false, x: 0.6, y: 0.6 }],
  ];
  if (crash) {
    events.push([1.25, { t: 'crash', kind: 1 as never, wall: 0, x: 1.1, y: 0.28, overlapMm: 4 }]);
  } else {
    events.push(
      [1.15, { t: 'cross', wall: 0, dir: 1, gapMm: 12, speed: 3.3, px: 1.1, py: 0.3 }],
      [1.5, { t: 'apex', ampDeg: 52, reqDeg: 45, reached: true, x: 1.5, y: 0.8 }],
      [1.9, { t: 'snap', J: 0.8, x: 1.6, y: 0.6 }],
      [2.2, { t: 'stop', side: 1, speed: 1.2 }],
      [2.4, { t: 'split', index: 0, deltaSub: -28, vs: 'ai' }],
      [2.8, { t: 'holdStart', phase: 0 }],
      [3.3, { t: 'success', score: 336, medal: 3, crown: true, firstCrown: true, pb: true, badges: [] }],
    );
  }
  const end = crash ? 1.25 : 3.3;
  return {
    name: crash ? 'クラッシュ / Crash run' : '1 ラン（王冠）/ Full run with crown',
    duration: end + 2.2,
    events,
    frame(t) {
      if (t >= end) return { running: false, v: 0, f: 0, saturated: false, ballSpeed: 0, panX: 0 };
      const f = t < 0.55 ? 1 : t < 1.0 ? -0.8 : 0.35 * Math.sin(t * 7);
      const v = t < 0.55 ? t * 6 : Math.max(0, 3.3 - (t - 0.55) * 6);
      const ballSpeed = t < 0.5 ? t * 3 : 3.6 * Math.abs(Math.sin((t - 0.5) * 2.2)) * Math.max(0, 1 - (t - 2.4) / 1.2);
      return { running: true, v, f, saturated: t > 0.1 && t < 0.55, ballSpeed, panX: -0.6 + 0.45 * t };
    },
  };
}

function runScenario(s: Scenario): void {
  engine.fx({ t: 'retry' });
  simTimers.length = 0;
  active = { s, t: 0, next: 0 };
  log(`▶ ${s.name}`);
}

// ---- page -------------------------------------------------------------------------------------

const app = document.getElementById('app') as HTMLElement;

const stateChip = el('span', 'chip', el('i'), el('b', '', 'locked'));
const header = el('header', '',
  el('h1', '', 'ゆらしてピタッ 音と振動', el('small', '', 'Audio & haptics demo (§9.5, §9.6)')),
  stateChip,
  button('音を出す / Enable audio', () => engine.unlock(), 'primary'),
  el('span', 'hint', '最初のクリックで AudioContext を開始します。M キーでミュート。/ First click starts audio; M toggles mute.'),
);

// Master bar + meter
const vol = slider('音量 Volume', 0, 100, 1, 80, (v) => `${v}`, (v) => engine.setVolume(v / 100));
const mute = checkbox('ミュート Mute (M)', false, (m) => engine.setMuted(m));
const canvas = el('canvas');
const meterTxt = el('span', '', 'peak — dBFS');
const master = el('div', 'bar',
  el('div', '', vol.root), mute.root,
  button('一時停止 pause (suspend)', () => { engine.suspend(); log('suspend() — game sounds gated, UI clicks still sound'); }, 'small'),
  button('再開 resume', () => { engine.resume(); log('resume()'); }, 'small'),
);
engine.setVolume(0.8);

// One-shots
let apexAmp = 30;
const apexNote = el('span', 'note', '');
const updApexNote = (): void => { apexNote.textContent = `${noteName(pentaMidi(apexStep(apexAmp)))} (step ${apexStep(apexAmp)})`; };
const apexSlider = slider('振れ幅 amp', 0, 95, 1, apexAmp, (v) => `${v}°`, (v) => { apexAmp = v; updApexNote(); });
updApexNote();
const playScale = (): void => {
  const amps = Array.from({ length: 16 }, (_, k) => 3 + 6 * k);
  const seq = [...amps, ...amps.slice(0, -1).reverse()];
  seq.forEach((a, i) => setTimeout(() => play('apex', a), i * 170));
};

let snapJ = 1;
let stopSpeed = 1.5;
let stopSide: -1 | 1 = 1;
let crashKind = 1;
let medal = 3;
let crown = true;
let pb = true;

const oneShots = el('div', 'grid',
  card('拍子木', 'Apex tick', '振れ幅 0〜90° → C4〜C7 ペンタトニック 15 段。BGM の代わり。',
    apexSlider.root, el('div', 'row', apexNote),
    el('div', 'row',
      button('鳴らす Play', () => emit({ t: 'apex', ampDeg: apexAmp, reqDeg: null, reached: false, x: 0, y: 0 })),
      button('音階 Scale', playScale, 'small'))),
  card('主音チャイム', 'Key-tone chime', '振れ幅が必要角に届いたとき（C6 三角波）。',
    button('鳴らす Play', () => play('chime'))),
  card('紐の張り直し', 'String snap', 'Karplus-Strong 220 Hz、音量 ∝ min(1, J/2)。',
    slider('J (N·s)', 0.05, 3, 0.05, snapJ, (v) => v.toFixed(2), (v) => { snapJ = v; }).root,
    button('鳴らす Play', () => emit({ t: 'snap', J: snapJ, x: 0, y: 0 }))),
  card('端の打撃', 'End stop', '90 Hz の打撃 + ノイズ。s ≥ 1 で「ガンッ」の金属音。',
    slider('速さ m/s', 0.05, 4, 0.05, stopSpeed, (v) => v.toFixed(2), (v) => { stopSpeed = v; }).root,
    select<'1' | '-1'>('側 side', [['1', '右 right'], ['-1', '左 left']], (v) => { stopSide = v === '1' ? 1 : -1; }),
    el('div', 'row',
      button('鳴らす Play', () => emit({ t: 'stop', side: stopSide, speed: stopSpeed })),
      button('＋たるみ + slack (D5)', () => {
        // D5: a hit whose string went slack also emits 'slack', and the sim's SlackBegin can follow a substep
        // later. Slack has no sound (§9.5), so the log shows exactly one ♪ stop.
        emit({ t: 'stop', side: stopSide, speed: stopSpeed });
        emit({ t: 'slack', x: 0, y: 0 });
        afterSim(1 / 120, () => emit({ t: 'slack', x: 0, y: 0 }));
      }, 'small'))),
  card('クラッシュ', 'Crash', '70→40 Hz、ローパスのノイズ、レンガの崩れ（壁のとき）。',
    select('種類 kind', [['1', 'ボール×壁 ball'], ['2', '紐×壁 string'], ['3', '梁 beam'], ['4', '床 floor'], ['5', 'たまご egg']],
      (v) => { crashKind = Number(v); }),
    button('鳴らす Play', () => emit({ t: 'crash', kind: crashKind as never, wall: 0, x: 0, y: 0, overlapMm: 4 }))),
  card('ニアミス', 'Near miss', '2.4→3.2 kHz のグライド。区分ごとに半音上がる。',
    el('div', 'row',
      ...([['ニアミス', 35], ['ギリギリ', 15], ['スレスレ', 7], ['紙一重', 3], ['神業', 1]] as const).map(([name, gap]) =>
        button(`${name} ${gap}mm`, () => emit({ t: 'cross', wall: 0, dir: 1, gapMm: gap, speed: 1.5, px: 0, py: 0 }),
          `small tier${nearMissTier(gap)}`)),
      button('速い通過 fast pass', () => emit({ t: 'cross', wall: 0, dir: 1, gapMm: 80, speed: 3.6, px: 0, py: 0 }), 'small'))),
  card('静止保持と成功', 'Hold & success', '5 段の上昇音（シム時間で 0.1 s ごと。timeScale と一時停止に追従）→ 拍子木 + 長三和音。',
    el('div', 'row',
      select('メダル', [['3', '金 gold'], ['2', '銀 silver'], ['1', '銅 bronze'], ['0', 'なし none']], (v) => { medal = Number(v); }),
      checkbox('王冠 crown', crown, (v) => { crown = v; }).root,
      checkbox('PB', pb, (v) => { pb = v; }).root),
    el('div', 'row',
      select<'1' | '0.5' | '0.35' | '0'>('timeScale', [
        ['1', '1× 通常'], ['0.5', '0.5× 練習'], ['0.35', '0.35× スロー'], ['0', '0× 停止'],
      ], (v) => { timeScale = Number(v); log(`timeScale ${v}`); })),
    el('div', 'row',
      button('保持→成功 Hold→success', () => {
        // The sim's hold lasts 0.5 s of sim time (HOLD_SUB); at 0.5× it takes 1 s.
        emit({ t: 'holdStart', phase: 0 });
        holdingUntil = simNow + 0.5;
        afterSim(0.5, () => emit({ t: 'success', score: 300, medal: medal as 0 | 1 | 2 | 3, crown, firstCrown: crown, pb, badges: [] }));
      }),
      button('保持 holdStart', () => { emit({ t: 'holdStart', phase: 0 }); holdingUntil = simNow + 0.5; }, 'small'),
      button('ちらつき flicker', () => {
        // The sim's hold flickers when the cart speed hovers at REST_V: begin, reset 3 substeps later, begin again.
        emit({ t: 'holdStart', phase: 0 });
        holdingUntil = simNow + 0.57;
        afterSim(0.035, () => emit({ t: 'holdReset', phase: 0, frac: 3 / 60 }));
        afterSim(0.07, () => emit({ t: 'holdStart', phase: 0 }));
        afterSim(0.57, () => emit({ t: 'success', score: 300, medal: medal as 0 | 1 | 2 | 3, crown: false, firstCrown: false, pb: false, badges: [] }));
      }, 'small'),
      button('惜しい holdReset', () => emit({ t: 'holdReset', phase: 0, frac: 0.6 }), 'small'),
      button('成功 success', () => emit({ t: 'success', score: 300, medal: medal as 0 | 1 | 2 | 3, crown, firstCrown: crown, pb, badges: [] }), 'small'))),
  card('ファンファーレ', 'Crown fanfare', '±7 cent のノコギリ波 3 本、G4-C5-E5-G5。',
    button('鳴らす Play', () => play('fanfare'))),
  card('PB / フェーズ', 'PB / phase', '短い上昇アルペジオ / 2 ゾーン面の途中完了。',
    el('div', 'row', button('PB', () => play('pb')), button('フェーズ phase', () => emit({ t: 'phase', index: 1 })))),
  card('スプリット', 'Split', '先行 880 Hz / 遅れ 440 Hz。',
    el('div', 'row',
      button('先行 −0.23', () => emit({ t: 'split', index: 0, deltaSub: -28, vs: 'ai' })),
      button('遅れ +0.41', () => emit({ t: 'split', index: 0, deltaSub: 49, vs: 'ai' })))),
  card('タイムアップ', 'Timeout', '低いブザー。',
    button('鳴らす Play', () => emit({ t: 'timeout', reason: 'swing', value: 5.2 }))),
  card('UI', 'UI click', '30 ms、1.2 kHz。ゲーム内のボタンは自動で鳴る（data-sfx="none" で除外）。',
    el('div', 'row', button('鳴らす Play', () => play('ui')),
      // The page opts out of automatic UI clicks (data-sfx="none" on <main>); this wrapper opts back in.
      (() => { const d = el('div', 'row', button('普通のボタン (auto)', () => undefined, 'small')); d.dataset.sfx = 'ui'; return d; })())),
);

// Continuous
const cont = el('div', 'card',
  el('h3', '', 'モーターと風切り', el('span', '', 'Motor & wind (update() every frame)')),
  el('p', '', 'モーター：ノコギリ波 60+40|v| Hz → LPF 600+800|F|/Fmax、ゲイン 0.15|F|/Fmax、飽和で 2 倍の矩形波。風：BPF 400+300·speed Hz、0.08·(speed−1)²。'),
  checkbox('走行中 running', manual.running, (v) => { manual.running = v; }).root,
  slider('台車 v', -4, 4, 0.05, 0, (v) => `${v.toFixed(2)} m/s`, (v) => { manual.v = v; }).root,
  slider('力 F/Fmax', -1, 1, 0.01, 0, (v) => v.toFixed(2), (v) => { manual.f = v; }).root,
  checkbox('飽和 saturated（うなり）', manual.saturated, (v) => {
    manual.saturated = v;
    if (v) emit({ t: 'saturate', on: true });
  }).root,
  slider('ボール speed', 0, 6, 0.05, 0, (v) => `${v.toFixed(2)} m/s`, (v) => { manual.ballSpeed = v; }).root,
  slider('パン panX', -1, 1, 0.01, 0, (v) => v.toFixed(2), (v) => { manual.panX = v; }).root,
);

const scenarios = el('div', 'card',
  el('h3', '', 'シナリオ', el('span', '', 'Scenarios (real event mapping)')),
  el('p', '', 'こぐと拍子音が上がっていき、50° に届くと主音のチャイム。止めていくと下がる。'),
  el('div', 'row',
    button('振り子 Pumping swing', () => runScenario(pendulum())),
    button('1 ラン Full run', () => runScenario(fullRun(false))),
    button('クラッシュ Crash', () => runScenario(fullRun(true))),
    button('停止 Stop', () => { active = null; emit({ t: 'retry' }); }, 'small')),
);

const hapticsCard = el('div', 'card',
  el('h3', '', '振動', el('span', '', `Haptics — navigator.vibrate ${haptics.supported ? 'あり available' : 'なし unavailable'}`)),
  checkbox('有効 enabled', haptics.enabled, (v) => { haptics.enabled = v; }).root,
  el('div', 'row',
    ...([['飽和 6', 6], ['ニアミス 8', 8], ['張り直し 10', 10], ['端 15', 15], ['成功 20', 20],
      ['王冠', [20, 30, 20, 30, 60]], ['クラッシュ', [30, 40, 30]]] as const).map(([name, p]) =>
      button(name, () => { haptics.fire(typeof p === 'number' ? p : [...p]); log(`vibrate ${JSON.stringify(p)}`); }, 'small'))),
);

app.append(
  header,
  master,
  el('h2', '', 'メーター', el('span', '', 'Output (after the limiter; never above 0.98)')),
  el('div', 'card', canvas, el('div', 'meter', meterTxt)),
  el('h2', '', '効果音', el('span', '', 'One-shots')),
  oneShots,
  el('h2', '', '連続音とシナリオ', el('span', '', 'Continuous & scenarios')),
  el('div', 'cols', cont, el('div', 'stack', scenarios, hapticsCard)),
  el('h2', '', 'イベント', el('span', '', 'Event log')),
  el('div', 'card', logEl),
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') {
    mute.input.checked = !mute.input.checked;
    engine.setMuted(mute.input.checked);
  }
});

// ---- frame loop: update(), scenarios, meter ----------------------------------------------------

let analyser: AnalyserNode | null = null;
let wave: Float32Array<ArrayBuffer> | null = null;
let peakHold = 0;
let peakHoldAt = 0;
let peakMax = 0;

let lastFrame = performance.now() / 1000;

function frame(): void {
  const now = performance.now() / 1000;
  // Like the game loop: at most 4 ticks of 1/60 s per frame (a background tab does not jump ahead), frozen while
  // paused (the pause buttons above call suspend() / resume() like the game's pause menu).
  const dt = engine.paused ? 0 : Math.min(4 / 60, Math.max(0, now - lastFrame)) * timeScale;
  lastFrame = now;
  simNow += dt;
  while (simTimers.length > 0 && (simTimers[0] as { at: number }).at <= simNow) (simTimers.shift() as { fn: () => void }).fn();
  let c: Cont = manual;
  if (active) {
    active.t += dt;
    const t = active.t;
    const ev = active.s.events;
    while (active.next < ev.length && (ev[active.next] as [number, GameEvent])[0] <= t) {
      emit((ev[active.next] as [number, GameEvent])[1]);
      active.next++;
    }
    c = active.s.frame(t);
    if (t > active.s.duration) {
      log(`■ ${active.s.name}`);
      active = null;
    }
  }
  engine.update({
    // A hold in progress is part of a running run: after a pause, the rest of the riser only plays while running.
    running: c.running || simNow < holdingUntil, v: c.v, F: c.f * FMAX, Fmax: FMAX, saturated: c.saturated, ballSpeed: c.ballSpeed, panX: c.panX, timeScale,
  });

  const st = engine.state;
  stateChip.dataset.state = engine.paused && st === 'running' ? 'suspended' : st;
  const ctx = engine.context;
  (stateChip.querySelector('b') as HTMLElement).textContent = ctx
    ? `${st}${engine.paused ? ' (paused)' : ''} · ${ctx.sampleRate} Hz${'baseLatency' in ctx ? ` · ${(((ctx as AudioContext).baseLatency || 0) * 1000).toFixed(0)} ms` : ''} · voices ${engine.activeVoices}`
    : st;

  if (!analyser && ctx && engine.output) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    engine.output.connect(analyser);
    wave = new Float32Array(analyser.fftSize);
  }
  drawMeter(now);
  requestAnimationFrame(frame);
}

function drawMeter(now: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.fillStyle = '#1e2a44';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(243,238,228,0.18)';
  g.lineWidth = 1;
  for (const y of [0.25, 0.5, 0.75]) {
    g.beginPath();
    g.moveTo(0, y * h);
    g.lineTo(w, y * h);
    g.stroke();
  }
  let peak = 0;
  if (analyser && wave) {
    analyser.getFloatTimeDomainData(wave);
    g.strokeStyle = '#22b573';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    for (let i = 0; i < wave.length; i++) {
      const x = (i / (wave.length - 1)) * w;
      const s = wave[i] as number;
      peak = Math.max(peak, Math.abs(s));
      const y = h / 2 - s * (h / 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  if (peak >= peakHold || now - peakHoldAt > 1.5) {
    peakHold = peak;
    peakHoldAt = now;
  }
  peakMax = Math.max(peakMax, peak);
  const db = (x: number): string => (x > 1e-5 ? (20 * Math.log10(x)).toFixed(1) : '−∞');
  meterTxt.textContent = `peak ${db(peakHold)} dBFS · max ${db(peakMax)} dBFS`;
  g.fillStyle = peakHold > 0.9 ? '#e5484d' : '#f2b705';
  g.fillRect(w - 10 * dpr, h - peakHold * h, 8 * dpr, peakHold * h);
}

requestAnimationFrame(frame);

// For Playwright checks of this page.
(window as unknown as { __audioDemo: unknown }).__audioDemo = {
  engine,
  haptics,
  emit,
  peakMax: () => peakMax,
  resetPeak: () => { peakMax = 0; },
  soundCounts: () => Object.fromEntries(soundCounts),
  setTimeScale: (v: number) => { timeScale = v; },
};
