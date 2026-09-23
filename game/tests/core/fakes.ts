// Test doubles for the app state machine (GAME_DESIGN.md §9.4). Owner: O3.
// Every fake implements the §10.4 contract only; the simulation, servo and data are the real ones.
import type { GameEvent } from '../../src/core/bus';
import type { Command, InputFrame, InputManager, RailMapper } from '../../src/input/types';
import type { Layout, RenderFrame, Renderer } from '../../src/render/renderer';
import type { HudState, Screen, UI, UiAction, UiElements } from '../../src/ui/ui';
import type { SaveV1, Store } from '../../src/store/save';
import { defaultSave } from '../../src/store/save';
import type { Api, FlushReason, GhostOpts, ResultsListener } from '../../src/net/api';
import type { UiContext } from '../../src/ui/context';
import type { PendingRun } from '../../src/net/outbox';
import type { BootResponse, GhostResponse, SubmitResponse, SubmitResult } from '../../src/shared/api';
import type { LevelDef } from '../../src/sim/level';

export const LAYOUT: Layout = { kind: 'wide', w: 1280, h: 720, dpr: 1, scene: { x: 0, y: 0, w: 1280, h: 720 }, deck: null, hudTop: 56 };

export class FakeUI implements UI {
  screens: Screen[] = [];
  huds: HudState[] = [];
  toasts: { text: string; kind?: string }[] = [];
  fxs: GameEvent[] = [];
  handlers = new Map<string, ((p?: unknown) => void)[]>();
  /** The UiContext core hands to the UI (app.ts attachContext). */
  ctx: UiContext | null = null;
  attachContext(ctx: UiContext): void {
    this.ctx = ctx;
  }
  mount(): Layout {
    return LAYOUT;
  }
  elements(): UiElements {
    return { canvas: {} as HTMLCanvasElement, sceneEl: {} as HTMLElement, deckEl: null };
  }
  layoutCb: ((l: Layout) => void) | null = null;
  onLayout(cb: (l: Layout) => void): void {
    this.layoutCb = cb;
  }
  show(s: Screen): void {
    this.screens.push(s);
  }
  hud(h: HudState): void {
    this.huds.push(h);
    if (this.huds.length > 50) this.huds.shift();
  }
  fx(e: GameEvent): void {
    this.fxs.push(e);
  }
  toast(text: string, kind?: 'info' | 'badge' | 'warn'): void {
    this.toasts.push({ text, kind });
  }
  on(a: UiAction, cb: (payload?: unknown) => void): void {
    const l = this.handlers.get(a) ?? [];
    l.push(cb);
    this.handlers.set(a, l);
  }
  /** Simulates a button of the UI. */
  emit(a: string, payload?: unknown): void {
    for (const cb of this.handlers.get(a) ?? []) cb(payload);
  }
  get last(): Screen | undefined {
    return this.screens.at(-1);
  }
}

export class FakeRenderer implements Renderer {
  loaded: string[] = [];
  /** RendererExtras (optional, duck-typed by core) */
  margins: number[] = [];
  options: { quality?: 'auto' | 'high' | 'low'; reducedMotion?: boolean }[] = [];
  initOpts: { quality: 'auto' | 'high' | 'low'; reducedMotion: boolean } | null = null;
  frames = 0;
  lastFrame: RenderFrame | null = null;
  resets = 0;
  fxs: GameEvent[] = [];
  readonly mapper: RailMapper = { screenToRailX: () => null };
  init(_c: HTMLCanvasElement, o: { quality: 'auto' | 'high' | 'low'; reducedMotion: boolean }): void {
    this.initOpts = o;
  }
  setLayout(): void {}
  loadLevel(level: LevelDef): void {
    this.loaded.push(level.id);
  }
  setAiMarginMm(mm: number): void {
    this.margins.push(mm);
  }
  setOptions(o: { quality?: 'auto' | 'high' | 'low'; reducedMotion?: boolean }): void {
    this.options.push(o);
  }
  draw(f: RenderFrame): void {
    this.frames++;
    this.lastFrame = { ...f, ghosts: f.ghosts.map((g) => ({ ...g })) };
  }
  fx(e: GameEvent): void {
    this.fxs.push(e);
  }
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: 640 + x * 200, y: 600 - y * 200 };
  }
  resetFx(): void {
    this.resets++;
  }
  dispose(): void {}
}

/** Input whose frame the test sets directly (the real servo turns it into q). */
export class FakeInput implements InputManager {
  frame: InputFrame = { intent: { kind: 'idle' }, fine: false, device: 0, targetX: null };
  cmd: ((c: Command) => void) | null = null;
  samples = 0;
  resets: number[] = [];
  practice: boolean[] = [];
  attach(): void {}
  setLevel(): void {}
  resetForRun(startX: number): void {
    this.resets.push(startX);
    this.frame = { intent: { kind: 'idle' }, fine: false, device: 0, targetX: null };
  }
  sample(): InputFrame {
    this.samples++;
    return this.frame;
  }
  onCommand(cb: (c: Command) => void): void {
    this.cmd = cb;
  }
  setKeyboardMode(): void {}
  setPractice(on: boolean): void {
    this.practice.push(on);
  }
  dispose(): void {}
  target(x: number, device = 1): void {
    this.frame = { intent: { kind: 'target', x }, fine: false, device, targetX: x };
  }
  push(f: number): void {
    this.frame = { intent: { kind: 'force', f }, fine: false, device: 3, targetX: null };
  }
  idle(): void {
    this.frame = { intent: { kind: 'idle' }, fine: false, device: 0, targetX: null };
  }
  command(c: Command): void {
    this.cmd?.(c);
  }
}

export class MemStore implements Store {
  readonly persistent = true;
  flushes = 0;
  constructor(public d: SaveV1 = defaultSave('ja')) {}
  data(): SaveV1 {
    return this.d;
  }
  update(fn: (d: SaveV1) => void): void {
    fn(this.d);
  }
  flush(): void {
    this.flushes++;
  }
}

export class FakeApi implements Api {
  enabled = true;
  lite = false;
  booting = false;
  soft = false;
  readOnly = false;
  queued: PendingRun[] = [];
  flushes: string[] = [];
  /** Every flush with its options (rank-in: `first`). */
  flushCalls: { reason: string; first?: string }[] = [];
  /** The answer of a flush (default: null, nothing was sent). */
  flushReply: ((reason: FlushReason, opts?: { first?: string }) => Promise<SubmitResponse | null>) | null = null;
  bootRes: BootResponse | null = null;
  readonly listeners = new Set<ResultsListener>();
  boot(): Promise<BootResponse | null> {
    return Promise.resolve(this.bootRes);
  }
  lastBoot(): BootResponse | null {
    return this.bootRes;
  }
  flush(reason: FlushReason, opts?: { first?: string }): Promise<SubmitResponse | null> {
    this.flushes.push(reason);
    this.flushCalls.push(opts?.first !== undefined ? { reason, first: opts.first } : { reason });
    return this.flushReply ? this.flushReply(reason, opts) : Promise.resolve(null);
  }
  enqueue(r: PendingRun): void {
    this.queued.push(r);
  }
  /** Every /api/ghost call (the rival and the replay viewer). */
  ghostCalls: { key: string; rank: number; opts?: GhostOpts }[] = [];
  /** The answer of ghost() (default: null). */
  ghostReply: ((key: string, rank: number, opts?: GhostOpts) => Promise<GhostResponse | null>) | null = null;
  /** ghostsLeft() (NetApi extra): requests left this session. */
  left = 3;
  ghost(key: string, rank: number, opts?: GhostOpts): Promise<GhostResponse | null> {
    this.ghostCalls.push(opts ? { key, rank, opts } : { key, rank });
    if (this.left <= 0) return Promise.resolve(null);
    this.left--;
    return this.ghostReply ? this.ghostReply(key, rank, opts) : Promise.resolve(null);
  }
  ghostsLeft(): number {
    return this.left;
  }
  board(): Promise<null> {
    return Promise.resolve(null);
  }
  onResults(cb: ResultsListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  /** A submit answer arriving (what NetApi does after applying it to the save). */
  answer(sent: readonly PendingRun[], results: readonly SubmitResult[]): void {
    for (const cb of this.listeners) cb(sent, results);
  }
}
