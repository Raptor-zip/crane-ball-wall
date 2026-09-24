// UI contract (GAME_DESIGN.md §10.4 "UI") and its implementation. Owner: O7.
import type { DailyDef, LevelDef } from '../sim/level';
import { BEAM_Y, RAIL_Y } from '../sim/constants';
import type { Layout } from '../render/renderer';
import type { BadgeId, GameEvent, Medal } from '../core/bus';
import type { BoardRow } from '../shared/api';
import type { Standing } from '../shared/rank';
import type { SaveV1 } from '../store/save';
import levelsFile from '../data/levels.json';
import summaryFile from '../data/ghosts_summary.json';
import type { PauseInfo, ReplayView, ScreenEnv, SummaryEntry, UiContext } from './context';
import { HUD_BAND, computeLayout, sameLayout, tallPanelH } from './layout';
import { createHud } from './hud';
import type { Hud } from './hud';
import { createDeck } from './deck';
import type { Deck } from './deck';
import { BANNER_DELAY_MS, createPopups, createToasts } from './popups';
import type { BannerPlace, Box, NearPlace, Popups, ToastArea, Toasts } from './popups';
import { focusables, h, prefersReducedMotion } from './dom';
import { icon } from './icons';
import { defaultLang, failReasonText, getLang, nearTier, setLang, t } from './i18n/format';
import { renderTitleScreen } from './screens/title';
import { renderSelectScreen } from './screens/select';
import { renderBriefingScreen } from './screens/briefing';
import { renderPauseScreen } from './screens/pause';
import { renderResults, resultsSide } from './results';
import { renderDemoScreen } from './screens/demo';
import { renderBoardScreen } from './screens/board';
import { renderDailyScreen } from './screens/daily';
import { renderSettingsScreen } from './screens/settings';
import { renderAboutScreen } from './screens/about';
import { renderNotesScreen } from './screens/notes';
import { renderSkinsScreen } from './screens/skins';
import type { SkinPart } from '../render/skinLooks';

// BoardRow is defined next to the API wire types (the Worker must not depend on src/ui); re-exported here.
export type { BoardRow } from '../shared/api';
export type { UiContext, PauseInfo, SummaryEntry, DemoInfo, CompareTracks, ReplayView, ReplayReq, ReplayLoad, ReplayAvail } from './context';

/**
 * Optional per-frame screen anchors for the world-following meters (§9.3). CSS px relative to the UI root
 * (core computes them with renderer.worldToScreen). Without them the meters are simply hidden.
 */
export interface HudAnchors {
  pivot: { x: number; y: number };        // hook (x, RAIL_Y)
  ball: { x: number; y: number };         // ball centre (bx, by)
  pxPerM?: number;                        // screen scale at the ball plane (default |ball - pivot| / L)
  slack?: boolean;                        // string slack: the swing meter greys out and keeps its last value
  holdFrac?: number;                      // 0..1 hold ring
  reqDeg?: number | null;                 // required angle of the next wall within 1.2 m (RenderFrame.reqDeg)
  reqDir?: 1 | -1;                        // side of that wall relative to the trolley
}

export interface HudState {
  timeSub: number; running: boolean; F: number; Fmax: number; aiF: number | null; saturated: boolean;
  ampDeg: number; restDeg: number; T: number; Tmax: number | null;
  nearGapMm: number | null; offline: boolean; mode: 'campaign' | 'daily' | 'challenge' | 'practice' | 'demo';
  hint: string | null;                           // one line under READY (already fmtLevelText'ed); null while running
  dailyBalls: ('ok' | 'gold' | 'crown' | 'fail' | null)[] | null;
  anchors?: HudAnchors | null;                   // optional (O7 addition, non-breaking)
}
export type Screen =
  | { id: 'title' } | { id: 'select'; world: number } | { id: 'briefing'; level: LevelDef; ai: GhostSummary }
  | { id: 'hud' } | { id: 'pause' } | { id: 'results'; data: ResultsData }
  // replay: the ranking's replay viewer (§7.5 item 6); without it the AI demo
  | { id: 'demo'; level: LevelDef; replay?: ReplayView }
  // focusRank: back from the replay viewer, scrolled to that row (its ▶ focused, no second flash of my row)
  | { id: 'board'; key: string; focusRank?: number }
  | { id: 'daily'; data: DailyView } | { id: 'settings' } | { id: 'about' } | { id: 'notes'; world: number }
  | { id: 'skins'; part?: SkinPart };   // O7 addition (§7.14): the skins sheet over the live title attract
export interface GhostSummary { parSub: number; planT: number; peakF: number; minGapMm: number; pumps: number; calmPath: Float32Array }
export interface ResultsData {
  level: LevelDef; ok: boolean; score: number | null; parSub: number; pbSub: number | null; wrSub: number | null;
  medal: Medal; crown: boolean; nextMedalSub: number | null; gapMm: number; aiGapMm: number; peakF: number; aiPeakF: number;
  badges: BadgeId[]; failReason: string | null; rank: number | null; aiBeaten: number | null /* players who beat the AI here (online) */;
  replay: string | null /* null above 6 KB */; strobe: Float32Array /* bx,by every 0.1 s */;
  standing?: Standing | null /* level success: the world rank row under the time (GAME_DESIGN.md §9.4); core replaces it as answers come */;
  ballFill?: string /* the equipped ball's colour for the share card (§7.14); absent: the default red, and on egg levels */;
  skins?: string[] /* skin ids this run unlocked (§7.14): listed on the card, which a small phone's toast may miss */;
}
export interface DailyView {
  dayIndex: number; n: number; level: LevelDef; balls: ('ok' | 'gold' | 'crown' | 'fail' | null)[];
  bestSub: number | null; parSub: number; top: BoardRow[] | null; rank: number | null; pct: number | null; streak: number; shareText: string;
}
export type UiAction = 'retry' | 'next' | 'demo' | 'board' | 'share' | 'resume' | 'practice' | 'select' | 'openLevel' | 'openDaily' | 'settingsChanged' | 'skip' | 'rerollName' | 'assistAccept'
  | 'ghostCycle' | 'aiLine' | 'notes' | 'mute' | 'reverseHint'
  | 'pause'    // O7 addition (non-breaking): the HUD ⏸ button (§9.3). Without a listener the UI falls back to a synthetic Escape key.
  | 'rewind'   // O7 addition (non-breaking): practice mode "5 s rewind" button (§3.5).
  | 'back'     // Escape on the level select: back to the title (the same as Esc / gamepad B from outside the layer).
  | 'replay'   // {id}: watch a ranking row's replay (UiContext.loadReplay answered ok) in the demo viewer (§7.5 item 6).
  | 'raceGhost'; // {id}: 「このゴーストと勝負」 in the replay viewer: the next attempt races that run's ghost.
export interface UiElements { canvas: HTMLCanvasElement; sceneEl: HTMLElement; deckEl: HTMLElement | null }
export interface UI {
  mount(root: HTMLElement): Layout;              // UI creates the canvas and, when tall, the deck element
  elements(): UiElements;                        // re-read on every onLayout (deckEl changes with the layout)
  onLayout(cb: (l: Layout) => void): void;
  show(s: Screen): void;
  hud(h: HudState): void;                        // once per frame (diffed into the DOM)
  fx(e: GameEvent, screenPos?: { x: number; y: number }): void;
  toast(text: string, kind?: 'info' | 'badge' | 'warn' | 'notice'): void;
  on(a: UiAction, cb: (payload?: unknown) => void): void;
  /**
   * Esc / gamepad B from outside the UI layer (core): closes the settings / about / notes / board sub-screen on
   * top, exactly as Escape inside the layer does. Returns true when it closed one (the core state stays).
   */
  back?(): boolean;
}

/** What a screen renderer may return. */
export interface ScreenHandle {
  onKey?(e: KeyboardEvent): boolean;          // true when handled
  onHud?(h: HudState): void;
  onEscape?(): void;
  dispose?(): void;
}

/** tall: HUD panels lower than this (px) get the compact scoreboard (the full one is 56 px with a split delta). */
const COMPACT_PANEL_H = 60;
/** The floor's front edge (z = 0.32 m, seen from 6° above) lines up with this y (m) in the ball plane (render/scene.ts). */
const FLOOR_FRONT_Y = -0.08;

type SubId = 'settings' | 'about' | 'notes' | 'board' | 'skins';
const SUB_SCREENS: ReadonlySet<Screen['id']> = new Set<SubId>(['settings', 'about', 'notes', 'board', 'skins']);
const PAGE_SCREENS: ReadonlySet<Screen['id']> = new Set(['select', 'daily', 'settings', 'about', 'notes', 'board']);
const HUD_SCREENS: ReadonlySet<Screen['id']> = new Set(['hud', 'pause', 'results', 'briefing']);

export const BUNDLED_LEVELS: readonly LevelDef[] = (levelsFile as unknown as { levels: LevelDef[] }).levels;
export const BUNDLED_SUMMARY: Readonly<Record<string, SummaryEntry>> = (summaryFile as unknown as { levels: Record<string, SummaryEntry> }).levels;

export function defaultSettings(): SaveV1['settings'] {
  return {
    lang: defaultLang(), langPicked: false, volume: 80, muted: false, haptics: true, motion: 'auto',
    keyboard: 'speed', ghostSet: 0, steady: true, aiLine: null, textScale: 100, quality: 'auto',
  };
}

const INK_FILTER = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
<filter id="yp-ink" x="-10%" y="-10%" width="120%" height="120%">
<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="1.8" xChannelSelector="R" yChannelSelector="G" result="d"/>
<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.5 1.65" result="m"/>
<feComposite in="d" in2="m" operator="in"/>
</filter></svg>`;

export function createUI(ctx: UiContext = {}): UI {
  const handlers = new Map<UiAction, ((payload?: unknown) => void)[]>();
  const layoutCbs: ((l: Layout) => void)[] = [];
  let rootEl: HTMLElement | null = null;
  let yp!: HTMLElement;
  let sceneEl!: HTMLElement;
  let canvas!: HTMLCanvasElement;
  let layer!: HTMLElement;
  let hud!: Hud;
  let deck: Deck | null = null;
  let pops!: Popups;
  let toasts!: Toasts;
  let wideOnboard!: HTMLElement;
  let layout: Layout = computeLayout(1280, 720, 1);
  let current: Screen = { id: 'hud' };
  let stack: Screen[] = [];
  let handle: ScreenHandle | null = null;
  let level: LevelDef | null = null;
  let lastHud: HudState | null = null;
  let crashesHere = 0;
  let lastTimeout: { reason: 'swing' | 'speed' | 'zone' | 'none'; value: number } | null = null;
  let localSettings: SaveV1['settings'] = defaultSettings();
  let onboard: 'hand' | 'keys' | null = null;
  let mounted = false;
  let lastSafe = 0;
  let lastInsets = { r: 0, b: 0 };
  // How the last finished run was played (for the results card: practice / assist runs keep no PB or medal).
  let lastRun = { practice: false, assist: false, pb: null as boolean | null, firstCrown: false };

  // ------------------------------------------------------------ data access

  const save = (): SaveV1 | null => {
    try {
      return ctx.store ? ctx.store.data() : null;
    } catch {
      return null;
    }
  };
  const settings = (): SaveV1['settings'] => save()?.settings ?? localSettings;
  const levels = (): readonly LevelDef[] => ctx.levels ?? BUNDLED_LEVELS;
  const summary = (id: string): SummaryEntry | null => (ctx.summary ?? BUNDLED_SUMMARY)[id] ?? null;
  const reducedMotion = (): boolean => {
    const m = settings().motion;
    return m === 'off' || (m === 'auto' && prefersReducedMotion());
  };

  function emit(a: UiAction, payload?: unknown): void {
    if (a === 'pause' && !handlers.get('pause')?.length) {
      // Contract fallback: the input manager maps Escape to its 'pause' command.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      return;
    }
    for (const cb of handlers.get(a) ?? []) {
      try {
        cb(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function pauseInfo(): PauseInfo {
    const st = settings();
    const p = save()?.levels[level?.id ?? ''];
    const base: PauseInfo = {
      practiceAvailable: crashesHere > 0 || (p?.fails ?? 0) > 0,
      practice: lastHud?.mode === 'practice',
      skipAvailable: !!p && p.attempts >= 10 && !p.cleared && !p.skipped && (level?.world ?? 0) > 0,
      assistOffered: false,
      assist: false,
      reverseHint: level?.id === '2-3',
      ghostSet: st.ghostSet,
      aiLine: st.aiLine ?? ((level?.world ?? 1) <= 2 && (level?.world ?? 1) > 0),
      muted: st.muted,
    };
    try {
      return { ...base, ...(ctx.pause?.() ?? {}) };
    } catch {
      return base;
    }
  }

  /** 人類 vs AI: crowns over the campaign levels (§7.2). */
  function crownCount(): { crowns: number; total: number } {
    const prog = save()?.levels ?? {};
    const campaign = levels().filter((l) => l.world > 0);
    return { crowns: campaign.filter((l) => prog[l.id]?.crown).length, total: campaign.length };
  }

  function applyPrefs(): void {
    const st = settings();
    setLang(st.lang);
    document.documentElement.lang = st.lang;
    document.documentElement.classList.toggle('yp-ts125', st.textScale === 125);
    if (mounted) {
      yp.classList.toggle('yp--reduce', reducedMotion());
      yp.setAttribute('lang', st.lang);
    }
  }

  function applySettings(next: SaveV1['settings']): void {
    const prevLang = settings().lang;
    const prevScale = settings().textScale;
    localSettings = { ...next };
    try {
      ctx.store?.update((d) => {
        d.settings = { ...next };
      });
    } catch {
      /* the store reports its own failures */
    }
    applyPrefs();
    emit('settingsChanged', { ...next });
    if (next.lang !== prevLang || next.textScale !== prevScale) {
      // The screen is rebuilt in the new language / size: keep keyboard focus on the same setting.
      const seg = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-seg]')?.dataset.seg;
      rebuildChrome();
      if (seg) layer.querySelector<HTMLElement>(`[data-seg="${seg}"] [aria-checked="true"]`)?.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------ chrome (HUD, deck, popups)

  function buildHud(): void {
    hud = createHud(yp, {
      emit: (a, p) => emit(a, p),
      chips: () => {
        const pi = pauseInfo();
        return {
          // ⓘ strategy card on every level but the text-free 1-1 tutorial (§8.4 item 5; the automatic showing on
          // first entry is core's and starts at W2).
          info: !!level && level.id !== '1-1' && !!ctx.briefing && safeBriefing(level) !== null,
          reverse: pi.reverseHint,
          skip: pi.skipAvailable,
        };
      },
      practiceSlow: () => pauseInfo().practice,
      targets: () => targetsOf(level),
      openInfo: () => {
        if (!level) return;
        const ai = safeBriefing(level);
        if (ai) show({ id: 'briefing', level, ai });
      },
    });
    hud.setLayout(layout);
    hud.setLevel(level);
    // Keep the HUD under the popups / screen layer in DOM order too.
    const popEl = yp.querySelector('.yp-pop');
    if (popEl) yp.insertBefore(hud.el, popEl);
  }

  function setLevel(l: LevelDef): void {
    if (l === level) return;
    level = l;
    if (mounted) hud.setLevel(l);
  }

  /** AI par and personal best (substeps) for the tall scoreboard. */
  function targetsOf(l: LevelDef | null): { ai: number | null; pb: number | null } {
    if (!l) return { ai: null, pb: null };
    const sv = save();
    if (l.world === 0) {
      const par = (l as Partial<DailyDef>).parSub;
      let pb: number | null = null;
      try {
        const dv = ctx.daily?.();
        if (dv && dv.level.id === l.id) pb = dv.bestSub;
      } catch {
        pb = null;
      }
      return { ai: typeof par === 'number' && par > 0 ? par : null, pb };
    }
    const par = summary(l.id)?.parSub;
    const pb = sv?.levels[l.id]?.bestSub ?? null;
    return { ai: typeof par === 'number' && par > 0 ? par : null, pb: typeof pb === 'number' && pb > 0 ? pb : null };
  }

  function safeBriefing(l: LevelDef): GhostSummary | null {
    try {
      return ctx.briefing?.(l) ?? null;
    } catch {
      return null;
    }
  }

  function buildDeck(): void {
    deck?.dispose();
    deck = null;
    if (layout.kind === 'tall' && layout.deck) {
      deck = createDeck(yp);
      yp.insertBefore(deck.el, hud?.el ?? null);
      placeDeck();
    }
    // A new deck (rotation, language / text size change) starts without the onboarding hand: redraw it.
    onboard = null;
    if (mounted && wideOnboard) updateOnboarding();
  }

  function placeDeck(): void {
    if (!deck || !layout.deck) return;
    const r = layout.deck;
    Object.assign(deck.el.style, { top: `${r.y}px`, height: `${r.h}px` });
  }

  function rebuildChrome(): void {
    if (!mounted) return;
    hud.dispose();
    buildHud();
    const hadDeck = !!deck;
    buildDeck();
    if (hadDeck || deck) for (const cb of layoutCbs) cb(layout);
    if (lastHud) hudUpdate(lastHud);
    render();
  }

  function placeScene(): void {
    const r = layout.scene;
    Object.assign(sceneEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  }

  function safeTop(): number {
    try {
      const probe = h('div', { style: 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);padding-bottom:env(safe-area-inset-bottom,0px)' });
      yp.appendChild(probe);
      const cs = getComputedStyle(probe);
      const v = parseFloat(cs.paddingTop) || 0;
      lastInsets = { r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0 };
      probe.remove();
      return v;
    } catch {
      return 0;
    }
  }

  function relayout(force = false): void {
    if (!rootEl) return;
    const w = rootEl.clientWidth || window.innerWidth;
    const hgt = rootEl.clientHeight || window.innerHeight;
    lastSafe = safeTop();
    const next = computeLayout(w, hgt, window.devicePixelRatio || 1, lastSafe);
    if (!force && sameLayout(next, layout)) return;
    const kindChanged = next.kind !== layout.kind;
    layout = next;
    yp.dataset.layout = layout.kind;
    yp.style.setProperty('--hud-top', `${layout.hudTop}px`);
    yp.style.setProperty('--scene-h', `${layout.scene.h}px`);
    yp.style.setProperty('--deck-h', `${layout.deck ? layout.deck.h : 0}px`);
    yp.style.setProperty('--bench-h', `${layout.bench ?? 0}px`);
    // Landscape phones (wide but short): denser menus and cards so every button is reachable without scrolling.
    yp.dataset.short = layout.kind === 'wide' && layout.h < 520 ? '1' : '0';
    // tall, short phones: the HUD panel under a status row is too low for the two-line scoreboard (clock over the
    // split delta, labels over the times): it goes compact (styles.css) so it never runs over the play area.
    yp.dataset.panel = layout.kind === 'tall' && tallPanelH(layout, lastSafe) < COMPACT_PANEL_H ? 'compact' : 'full';
    placeScene();
    if (kindChanged || force) buildDeck();
    else placeDeck();
    hud.setLayout(layout);
    for (const cb of layoutCbs) cb(layout);
    if (kindChanged && current.id !== 'hud') render();
    pops.placeBanners();
    toasts.refresh();
  }

  // ------------------------------------------------------------ screens

  const env: ScreenEnv = {
    ctx,
    emit,
    open: (sc) => show(sc),
    back: () => goBack(),
    canGoBack: () => stack.length > 0,
    host: () => (stack.find((x) => !SUB_SCREENS.has(x.id)) ?? current).id,
    save,
    levels,
    summary,
    settings,
    applySettings,
    reducedMotion,
    pauseInfo: () => pauseInfo(),
    lastRun: () => ({ ...lastRun }),
    layoutKind: () => layout.kind,
    safeTop: () => lastSafe,
    playBottom: () => layout.scene.y + layout.scene.h - (layout.bench ?? 0),
    toast: (text, kind) => toasts.show(text, kind),
    refresh: () => render(),
  };

  /**
   * The button that opened a sub-screen from the keyboard, focused again when the sub-screen closes (the screen under it
   * is rebuilt: the button is found again by its icon and its place among the buttons with that icon). A button pressed
   * with the mouse or a finger is not followed: back on the title, Enter starts the game as its hint says.
   */
  const openers = new WeakMap<Screen, { sig: string; nth: number }>();
  const openerSig = (el: Element): string => `${el.tagName}|${el.querySelector('svg')?.innerHTML ?? el.textContent ?? ''}`;
  const openerCands = (sig: string): HTMLElement[] =>
    [...layer.querySelectorAll<HTMLElement>('button, a[href], [tabindex]')].filter((x) => openerSig(x) === sig);

  function noteOpener(under: Screen): void {
    openers.delete(under);
    const a = mounted ? (document.activeElement as HTMLElement | null) : null;
    if (!a || a === layer || !layer.contains(a)) return;
    let keyboard = false;
    try {
      keyboard = a.matches(':focus-visible');
    } catch {
      keyboard = false;
    }
    if (!keyboard) return;
    const sig = openerSig(a);
    openers.set(under, { sig, nth: openerCands(sig).indexOf(a) });
  }

  function refocusOpener(o: { sig: string; nth: number }): void {
    const c = openerCands(o.sig);
    const el = c[o.nth] ?? (c.length === 1 ? c[0] : undefined);
    if (!el || !focusables(layer).includes(el)) return;
    // Only where it can be seen (a note card on another world's page stays behind the default focus).
    const r = el.getBoundingClientRect();
    const v = layer.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.bottom <= v.top || r.top >= v.bottom || r.right <= v.left || r.left >= v.right)) return;
    el.focus({ preventScroll: true });
  }

  function goBack(): void {
    const prev = stack.pop();
    if (prev) {
      const opener = openers.get(prev);
      current = prev;
      render();
      if (prev.id === 'select') emit('select', { from: 'back' });
      // After core's answer (the level select comes back as a new screen of the same kind).
      if (opener && current.id === prev.id) refocusOpener(opener);
    } else {
      current = { id: 'select', world: level?.world || 1 };
      render();
      emit('select', { from: 'back' });
    }
  }

  function show(sc: Screen): void {
    if (SUB_SCREENS.has(sc.id)) {
      if (current.id !== sc.id) {
        noteOpener(current);
        stack.push(current);
      }
    } else {
      stack = [];
    }
    current = sc;
    if (sc.id === 'briefing' || sc.id === 'demo') setLevel(sc.level);
    if (sc.id === 'results') setLevel(sc.data.level);
    if (!mounted) return;
    render();
  }

  function render(): void {
    if (!mounted) return;
    handle?.dispose?.();
    handle = null;
    const sc = current;
    yp.dataset.screen = sc.id;
    hud.setMenu(sc.id === 'results');
    layer.replaceChildren();
    layer.dataset.kind = PAGE_SCREENS.has(sc.id) ? 'page' : sc.id === 'pause' || sc.id === 'briefing' ? 'scrim' : 'none';
    hud.el.hidden = !HUD_SCREENS.has(sc.id);
    wideOnboard.style.display = 'none';
    let r: ScreenHandle | void = undefined;
    try {
      switch (sc.id) {
        case 'hud':
          break;
        case 'title':
          r = renderTitleScreen(layer, sc, env);
          break;
        case 'select':
          r = renderSelectScreen(layer, sc, env);
          break;
        case 'briefing':
          r = renderBriefingScreen(layer, sc, env);
          break;
        case 'pause':
          r = renderPauseScreen(layer, sc, env, pauseInfo(), level);
          break;
        case 'results':
          r = renderResults(layer, sc.data, env, { failText: failText(sc.data), pause: pauseInfo() });
          break;
        case 'demo':
          r = renderDemoScreen(layer, sc, env);
          break;
        case 'board':
          r = renderBoardScreen(layer, sc, env);
          break;
        case 'daily':
          r = renderDailyScreen(layer, sc, env);
          break;
        case 'settings':
          r = renderSettingsScreen(layer, sc, env);
          break;
        case 'about':
          r = renderAboutScreen(layer, sc, env);
          break;
        case 'notes':
          r = renderNotesScreen(layer, sc, env);
          break;
        case 'skins':
          r = renderSkinsScreen(layer, sc, env);
          break;
      }
    } catch (e) {
      console.error('[ui] screen render failed', sc.id, e);
    }
    handle = r || null;
    if (lastHud) handle?.onHud?.(lastHud);
    // A crown / PB banner that started during the success beat moves next to the card that just opened; it belongs
    // to the run and the results, so it does not follow the player to the level select, the ranking, the AI demo.
    if (sc.id === 'hud' || sc.id === 'results') pops.placeBanners();
    else pops.clearBanners();
    // Trick / badge toasts are about the run (the results card lists them): they do not pile up on the level select.
    if (PAGE_SCREENS.has(sc.id) || sc.id === 'title') toasts.drop('badge');
    // Toasts never cover the card that just opened (results buttons, pause menu): they move or wait (see toastArea).
    toasts.refresh();
    // Focus: into the layer for menus, back to the page for play.
    if (sc.id === 'hud') {
      const a = document.activeElement as HTMLElement | null;
      if (a && yp.contains(a)) a.blur();
      updateOnboarding();
    } else {
      const target = layer.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(layer)[0] ?? layer;
      try {
        target.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
  }

  function failText(d: ResultsData): string | null {
    if (d.ok) return null;
    if (d.failReason) return d.failReason;
    if (lastTimeout) return failReasonText(lastTimeout.reason, lastTimeout.value, d.level.physics.restDeg);
    return t('fail.none');
  }

  function onLayerKey(e: KeyboardEvent): void {
    const tgt = e.target as HTMLElement;
    const isControl = !!tgt.closest('button, a, input, select, textarea, [role="tab"], [role="radio"]');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      escape();
      return;
    }
    if (handle?.onKey?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && isControl) {
      // Native activation of the focused control; keep the game keys (Enter/Space = retry) from firing too.
      e.stopPropagation();
      return;
    }
    if (e.key === 'Tab') {
      const f = focusables(layer);
      if (f.length) {
        // i: the index in the Tab order; focus outside it (a roving card, a list) sits between two of them (x.5), so
        // that Tab from the last card of the skins sheet also wraps instead of leaving the page.
        const a = document.activeElement as HTMLElement;
        const at = f.indexOf(a);
        const i = at >= 0 ? at : f.filter((x) => a.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING).length - 0.5;
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1]!.focus();
        } else if (!e.shiftKey && i >= f.length - 1) {
          e.preventDefault();
          f[0]!.focus();
        }
      }
      e.stopPropagation();
    }
    if (e.key.startsWith('Arrow') && isControl) e.stopPropagation();
  }

  function escape(): void {
    if (handle?.onEscape) {
      handle.onEscape();
      return;
    }
    switch (current.id) {
      case 'pause':
        emit('resume');
        break;
      case 'settings':
      case 'about':
      case 'notes':
      case 'board':
      case 'skins':
        goBack();
        break;
      case 'daily':
        goBack();
        break;
      case 'select':
        emit('back');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ per frame

  function updateOnboarding(): void {
    let want: 'hand' | 'keys' | null = null;
    const hs = lastHud;
    if (current.id === 'hud' && level?.id === '1-1' && hs && !hs.running && hs.timeSub === 0 && hs.mode === 'campaign') {
      // §9.4 "1-1 の初回はゴーストの手の手本": until the first run of 1-1 starts (core sets seen.onboarding then).
      // Without a store (dev pages) fall back to "1-1 not cleared yet".
      const sv = save();
      const first = sv ? !sv.seen?.onboarding && !sv.levels['1-1']?.cleared : true;
      if (first) want = coarse() ? 'hand' : 'keys';
    }
    const wideShow = layout.kind === 'wide' && !!want;
    wideOnboard.style.display = wideShow ? '' : 'none';
    if (want === onboard) return;
    onboard = want;
    deck?.onboarding(layout.kind === 'tall' ? want : null);
    if (wideShow) {
      wideOnboard.replaceChildren(
        want === 'keys'
          ? h('div', { class: 'keycaps', style: 'position:relative;left:auto;bottom:auto;transform:none' }, h('span', { class: 'keycap' }, '←'), h('span', { class: 'keycap' }, '→'))
          : h('div', { class: 'deck-hand', style: 'position:relative;width:260px;height:80px;margin:0' }, h('span', { class: 'deck-hand-track' }), h('span', { class: 'deck-hand-finger' }, icon('hand'))),
      );
    }
  }

  function coarse(): boolean {
    try {
      return matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  function hudUpdate(hs: HudState): void {
    const prev = lastHud;
    lastHud = hs;
    hud.update(hs);
    if (deck) {
      deck.force(hs.F, hs.Fmax, hs.aiF, hs.saturated);
      // tall: "move to start" is written on the drag surface itself (not squeezed into the HUD).
      deck.ready(!hs.running && hs.timeSub === 0 && hs.mode !== 'demo' && current.id === 'hud');
    }
    handle?.onHud?.(hs);
    if (!prev || prev.running !== hs.running || (prev.timeSub === 0) !== (hs.timeSub === 0) || prev.mode !== hs.mode) updateOnboarding();
  }

  // ------------------------------------------------------------ popups & toasts: where they may go

  /** Layout box of an element relative to the UI root (offsets: entering animations do not move it). */
  function boxOf(el: HTMLElement): Box | null {
    if (!el.isConnected || el.offsetWidth === 0) return null;
    let x = 0;
    let y = 0;
    let e: HTMLElement | null = el;
    while (e && e !== yp) {
      x += e.offsetLeft;
      y += e.offsetTop;
      e = e.offsetParent as HTMLElement | null;
    }
    if (e !== yp) {
      const r = el.getBoundingClientRect();
      const o = yp.getBoundingClientRect();
      return { x0: r.left - o.left, y0: r.top - o.top, x1: r.right - o.left, y1: r.bottom - o.top };
    }
    return { x0: x, y0: y, x1: x + el.offsetWidth, y1: y + el.offsetHeight };
  }

  /** Popups stay in the 3D view under the HUD (tall: above the bench band; wide: above the force bar). */
  function popBounds(): Box {
    const r = layout.scene;
    const below = layout.kind === 'wide' ? 40 : (layout.bench ?? 0) + 4;
    return { x0: r.x + 4, y0: layout.hudTop + 4, x1: r.x + r.w - 4, y1: r.y + r.h - below };
  }

  /**
   * Toast area for the current screen. HUD: tall one at a time on the bench band at the bottom of the 3D view, right
   * under the floor's front edge (never on the ball, the goal zone or its floor pad), landscape phones one at a time in
   * the bottom-right corner, wide otherwise the stylesheet's place under the clock. AI demo in wide: one at a time
   * under the skip button (the F(t) strip is under the floor, the ball swings above it). Screens with a card (results,
   * pause, briefing, share sheet, the tall demo's graph panel): the largest free side of the card, so that toasts never
   * cover its buttons (nor a crown / PB banner there); when nothing fits they wait until the card closes.
   */
  function toastArea(): ToastArea | null {
    if (!mounted) return null;
    const W = layout.w;
    const H = layout.h;
    if (current.id === 'hud') {
      if (layout.kind === 'tall' && layout.deck) {
        // From the floor's front edge down: a one-line toast fits the bench band at any text size. A longer one (two
        // or three lines at 125 % on a narrow phone) runs on over the force bar and the top of the drag surface (the
        // toasts let touches through) rather than up over the floor, and always has room, so it never waits.
        const playBottom = layout.scene.y + layout.scene.h - (layout.bench ?? 0);
        const a = lastHud?.anchors;
        const front = a?.pxPerM ? a.pivot.y + (RAIL_Y - FLOOR_FRONT_Y) * a.pxPerM : NaN;
        const top = Math.max(playBottom, Number.isFinite(front) ? front : playBottom + 8) + 4;
        return { x0: 10, x1: W - 10, top, limit: H - 8 - lastInsets.b, max: 1 };
      }
      if (yp.dataset.short === '1') {
        // Landscape phones: the stylesheet's place under the clock is the gantry and the wall tops, where the ball
        // clears the walls. One toast at a time in the bottom-right corner instead, in the finger band under the
        // floor, beside the force bar (like tall, which keeps toasts off the play area).
        const o = yp.getBoundingClientRect();
        const bar = hud.el.querySelector<HTMLElement>('.hud-force')?.getBoundingClientRect();
        const x1 = W - 10 - lastInsets.r;
        const x0 = Math.max(bar && bar.width > 0 ? bar.right - o.left + 10 : W * 0.62, x1 - 280);
        return { x0, x1, bottom: H - 6 - lastInsets.b, limit: layout.hudTop + 8, max: 1 };
      }
      return null;
    }
    // Full pages (level select, daily hub, settings, ...) scroll under the toasts: the stylesheet's bottom centre.
    if (PAGE_SCREENS.has(current.id) || current.id === 'title') return null;
    if (current.id === 'demo' && layout.kind === 'wide') {
      // The low F(t) strip is under the floor and the ball swings in the whole view above it: top right, under the
      // skip button (and its focus ring), over the gantry's end, well above the ball and the goal zone.
      const bar = layer.querySelector<HTMLElement>('.demo-top');
      const b = bar ? boxOf(bar) : null;
      const x1 = W - 10 - lastInsets.r;
      return { x0: Math.max(10, x1 - 300), x1, top: (b ? b.y1 : layout.hudTop) + 10, limit: H * 0.6, max: 1 };
    }
    const cards = [...layer.querySelectorAll<HTMLElement>('.sheet, .demo-panel')].map(boxOf).filter((b): b is Box => !!b);
    if (!cards.length) return null;
    const c = cards.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    const top = (layout.kind === 'tall' ? lastSafe + HUD_BAND : layout.hudTop) + 6;
    const bottom = H - 10;
    const gap = 10;
    const leftW = c.x0 - gap - 10;
    const rightW = W - 10 - (c.x1 + gap);
    const aboveH = c.y0 - gap - top;
    const belowH = bottom - (c.y1 + gap);
    const side = Math.max(leftW, rightW);
    // A crown / PB banner in the free area: toasts stay under it (or wait until it is gone, onBannerChange).
    const ban = pops.bannerBox();
    const under = (x0: number, x1: number, y: number): number => (ban && ban.x0 < x1 && x0 < ban.x1 ? Math.max(y, ban.y1 + 8) : y);
    if (side >= 240 && side >= Math.min(W * 0.28, 420)) {
      const x0 = leftW >= rightW ? 10 : c.x1 + gap;
      const x1 = leftW >= rightW ? c.x0 - gap : W - 10;
      const mid = (x0 + x1) / 2;
      const hw = Math.min(210, (x1 - x0) / 2);
      // From the bottom of the free side: the stamp and the PB / crown banners live in its upper part.
      return { x0: mid - hw, x1: mid + hw, bottom: bottom - 6, limit: under(mid - hw, mid + hw, layout.hudTop + 16) };
    }
    const x0 = Math.max(10, W / 2 - 210);
    const x1 = Math.min(W - 10, W / 2 + 210);
    if (aboveH >= belowH) return { x0, x1, top: under(x0, x1, top), limit: c.y0 - gap };
    return { x0, x1, bottom, limit: c.y1 + gap };
  }

  /**
   * Crown / PB banners (§9.5): the results card opens 0.75 s after the success (SUCCESS_BEAT) and the banners stay on
   * top of it, in the free area next to it. tall: the band between the HUD band and the card's top edge (20 %).
   * wide: over the middle of the side the card leaves free (results.ts resultsSide), a quarter of the way down.
   * The card may not be open yet (the banner starts during the beat): then its place is predicted from the layout.
   */
  function bannerPlace(): BannerPlace | null {
    if (!mounted) return null;
    const W = layout.w;
    const H = layout.h;
    const card = current.id === 'results' ? layer.querySelector<HTMLElement>('.res') : null;
    const c = card ? boxOf(card) : null;
    if (layout.kind === 'tall') {
      const bandBottom = lastSafe + HUD_BAND;
      const cardTop = c ? c.y0 : lastSafe + 0.2 * H;
      return { x: W / 2, y: (bandBottom + Math.max(bandBottom, cardTop)) / 2, maxW: W - 20, minTop: bandBottom + 2 };
    }
    let x0: number;
    let x1: number;
    if (c) {
      [x0, x1] = c.x0 >= W - c.x1 ? [0, c.x0] : [c.x1, W];
    } else {
      const cardW = cssWidth('var(--res-w)') + 16;
      [x0, x1] = (level ? resultsSide(level) : 'right') === 'right' ? [0, W - cardW] : [cardW, W];
    }
    return { x: (x0 + x1) / 2, y: Math.max(H * 0.26, layout.hudTop + 40), maxW: Math.max(120, x1 - x0 - 24), minTop: layout.hudTop + 4 };
  }

  /** Resolved width of a CSS length (custom properties of the UI root included), 0 when it cannot be read. */
  function cssWidth(len: string): number {
    try {
      const probe = h('div', { style: `position:absolute;visibility:hidden;height:0;width:${len}` });
      yp.appendChild(probe);
      const v = probe.offsetWidth;
      probe.remove();
      return v || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Near-miss label beside the wall's top corner on the side the ball came from (§9.3): never on the gantry beam or
   * the ghost tags above it, never over the ball (which is already past the wall).
   */
  function nearPlace(e: Extract<GameEvent, { t: 'cross' }>, p: { x: number; y: number }): NearPlace | null {
    const w = level?.physics.walls[e.wall];
    const k = lastHud?.anchors?.pxPerM;
    if (!w || !k || !(k > 0) || !Number.isFinite(e.px + e.py + p.x + p.y)) return null;
    const side: -1 | 1 = e.dir > 0 ? -1 : 1;
    const face = side < 0 ? w.x0 : w.x1;
    const x = p.x + (face - e.px) * k + side * 8;
    const topY = p.y - (w.h - e.py) * k;
    const beamY = p.y - (BEAM_Y - e.py) * k;
    return { x, y: topY + 14, side, minTop: beamY + 10 };
  }

  // ------------------------------------------------------------ events

  function anchorPos(p?: { x: number; y: number }): { x: number; y: number } {
    if (p) return p;
    const a = lastHud?.anchors;
    if (a) return a.ball;
    return { x: layout.scene.x + layout.scene.w / 2, y: layout.scene.y + layout.scene.h * 0.45 };
  }

  const CRASH_KEYS = { 1: 'crash.ball', 2: 'crash.string', 3: 'crash.beam', 4: 'crash.floor', 5: 'crash.egg' } as const;

  function fx(e: GameEvent, screenPos?: { x: number; y: number }): void {
    if (!mounted) return;
    const center = { x: layout.scene.x + layout.scene.w / 2, y: layout.scene.y + Math.max(layout.hudTop + 60, layout.scene.h * 0.3) };
    switch (e.t) {
      case 'levelLoaded':
        level = e.level;
        crashesHere = 0;
        lastTimeout = null;
        lastRun = { practice: false, assist: false, pb: null, firstCrown: false };
        hud.setLevel(level);
        // The 1-1 onboarding hand belongs to 1-1: another level loaded before a run started there (a challenge link,
        // a replay) takes it off the deck and brings the grip back right away.
        updateOnboarding();
        break;
      case 'ready':
        hud.refreshChips();
        break;
      case 'retry':
        pops.clear();
        break;
      case 'runStart':
        updateOnboarding();
        break;
      case 'cross': {
        const p = anchorPos(screenPos);
        const near = e.gapMm < 40 && nearTier(e.gapMm) !== null;
        if (near) pops.near(e.gapMm, p.x, p.y - 44, nearPlace(e, p) ?? undefined);
        // The whoosh trails the ball; with a near-miss label beside the wall it would sit on top of it.
        if (e.speed >= 3 && !near) pops.show(t('pop.whoosh'), p.x - 64 * e.dir, p.y + 8, 'whoosh');
        break;
      }
      case 'snap':
        if (e.J >= 0.5) {
          const p = anchorPos(screenPos);
          pops.show(t('pop.snap'), p.x + 40, p.y - 36, 'snap');
        }
        break;
      case 'stop':
        if (e.speed >= 1) {
          const p = screenPos ?? lastHud?.anchors?.pivot ?? center;
          pops.show(t('pop.bang'), p.x, p.y + 30, 'bang');
        }
        break;
      case 'split':
        // tall: the scoreboard under the band shows it (D10); wide: big in the middle of the view.
        if (!hud.split(e.deltaSub, e.vs, e.index)) pops.split(e.deltaSub, center.x, center.y);
        break;
      case 'holdReset':
        if (e.frac >= 0.3) {
          const p = anchorPos(screenPos);
          pops.banner('almost', t('pop.almost'), p.x - layout.w / 2, p.y - layout.h * 0.26 - 50);
        }
        break;
      case 'success': {
        lastRun = { practice: lastHud?.mode === 'practice', assist: pauseInfo().assist, pb: e.pb, firstCrown: e.firstCrown };
        const p = screenPos ?? lastHud?.anchors?.ball ?? center;
        // Stamped just above the ball so the ball stays visible under the rim.
        pops.stamp(t('pop.stamp'), p.x, p.y - 78);
        // §9.5: "人類の勝利" band, the crown lands on the 人類 vs AI x/18 counter (shown inside the band here); or the
        // PB ribbon. Right after the stamp, so that the counter ticks during the 0.75 s beat; the results card then
        // opens under the banner (it lives above the screen layer, next to the card: bannerPlace).
        if (e.firstCrown) {
          const { crowns, total } = crownCount();
          window.setTimeout(() => pops.banner('crown', t('pop.crown'), undefined, undefined, total > 0 ? { from: Math.max(0, crowns - 1), to: crowns, total } : undefined), BANNER_DELAY_MS);
        } else if (e.pb) window.setTimeout(() => pops.banner('pb', t('pop.pb')), BANNER_DELAY_MS);
        break;
      }
      case 'crash': {
        crashesHere++;
        const p = anchorPos(screenPos);
        pops.show(t('pop.crash'), p.x, p.y - 30, 'crash');
        // string (2) and egg (5) crashes have no depth: "−0mm" would say nothing, the cause says it all
        pops.crashInfo(e.kind === 2 || e.kind === 5 ? null : Math.max(0, e.overlapMm), t(CRASH_KEYS[e.kind as 1] ?? 'crash.ball'), p.x, p.y + 56);
        hud.refreshChips();
        break;
      }
      case 'timeout':
        // No banner: core opens the results card in the same frame, and its title already says タイムアップ (§9.5).
        lastTimeout = { reason: e.reason, value: e.value };
        lastRun = { practice: lastHud?.mode === 'practice', assist: pauseInfo().assist, pb: null, firstCrown: false };
        break;
      default:
        break;
    }
    hud.fx(e);
  }

  // ------------------------------------------------------------ public API

  return {
    mount(root: HTMLElement): Layout {
      rootEl = root;
      if (!save()) localSettings = { ...localSettings, lang: defaultLang() };
      setLang(settings().lang); // before any label is built
      yp = h('div', { class: 'yp', 'data-layout': 'wide', 'data-screen': current.id });
      yp.insertAdjacentHTML('afterbegin', INK_FILTER);
      canvas = h('canvas', { class: 'yp-canvas', 'aria-label': t('app.title') });
      sceneEl = h('div', { class: 'yp-scene' }, canvas);
      yp.appendChild(sceneEl);
      pops = createPopups(yp);
      pops.setBounds(popBounds);
      pops.setBannerPlace(bannerPlace);
      buildHud();
      wideOnboard = h('div', { class: 'wide-onboard', style: 'position:absolute;left:50%;bottom:90px;transform:translateX(-50%);pointer-events:none;z-index:11;display:none' });
      yp.appendChild(wideOnboard);
      layer = h('div', { class: 'yp-layer', tabindex: '-1' });
      layer.addEventListener('keydown', onLayerKey);
      layer.addEventListener('keyup', (e) => {
        const tgt = e.target as HTMLElement;
        if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') && tgt.closest('.yp-layer')) e.stopPropagation();
      });
      yp.appendChild(layer);
      toasts = createToasts(yp, toastArea);
      // A crown / PB banner takes room from the toasts next to the results card while it is up.
      pops.onBannerChange(() => toasts.refresh());
      // A card opened on top of the screen (share sheet, notes) moves the toasts too.
      try {
        let queued = false;
        new MutationObserver(() => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            toasts.refresh();
          });
        }).observe(layer, { childList: true });
      } catch {
        /* no MutationObserver: screen changes still refresh */
      }
      root.appendChild(yp);
      mounted = true;
      yp.dataset.pointer = coarse() ? 'coarse' : 'fine';
      applyPrefs();
      // Long-press / right-click menus stay off except in text fields and links (§3.3).
      root.addEventListener('contextmenu', (e) => {
        if (!(e.target as HTMLElement).closest('textarea, input, a')) e.preventDefault();
      });
      relayout(true);
      const onResize = (): void => relayout();
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      window.visualViewport?.addEventListener('resize', onResize);
      try {
        new ResizeObserver(onResize).observe(root);
      } catch {
        /* older browsers: window resize is enough */
      }
      try {
        matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => applyPrefs());
      } catch {
        /* ignore */
      }
      render();
      return layout;
    },
    elements(): UiElements {
      return { canvas, sceneEl, deckEl: deck?.el ?? null };
    },
    onLayout(cb) {
      layoutCbs.push(cb);
    },
    show,
    hud(hs: HudState) {
      if (mounted) hudUpdate(hs);
    },
    fx,
    toast(text, kind = 'info') {
      if (mounted) toasts.show(text, kind);
    },
    on(a, cb) {
      const list = handlers.get(a) ?? [];
      list.push(cb);
      handlers.set(a, list);
    },
    back() {
      if (!mounted || !SUB_SCREENS.has(current.id)) return false;
      goBack();
      return true;
    },
  };
}

/** Current UI language (for callers that format text outside the UI, e.g. core's toasts). */
export function uiLang(): 'ja' | 'en' {
  return getLang();
}
