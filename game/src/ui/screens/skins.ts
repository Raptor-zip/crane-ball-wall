// Skins (スキン, GAME_DESIGN.md §7.14): a sheet over the live title attract (tall: a bottom sheet, wide: a side panel
// away from the attract's goal) with one tab per part. Tapping an unlocked card equips it (settings.skin, applied by core outside a run);
// tapping a locked card tries it on the attract behind the sheet until another tap or close. Locked cards keep their
// true colours and show the unlock condition and progress. Opening a tab marks its new skins as seen. Owner: O7.
import type { Screen, ScreenHandle } from '../ui';
import type { ScreenEnv, SkinItem, SkinsView } from '../context';
import type { SkinLook, SkinPart } from '../../render/skinLooks';
import type { UnlockRule } from '../../core/skins';
import type { BadgeId } from '../../core/bus';
import type { I18nKey } from '../i18n/format';
import { markSkinsSeen } from '../../store/cosmetic';
import { h } from '../dom';
import { icon } from '../icons';
import { getLang, levelName, t } from '../i18n/format';
import { skinThumb } from '../skinthumb';
import { resultsSide } from '../results';

const PARTS: readonly SkinPart[] = ['ball', 'crane', 'trail', 'stage'];
/**
 * Repaints (a board repaint is 20-60 ms on a phone) wait for the input to settle: every try-on, and an equip picked
 * with the arrow keys (holding ↓ runs through the cards; only the card it stops on is painted and stored).
 */
export const TRY_ON_DEBOUNCE_MS = 150;
/** The level of the title attract behind the sheet (core/app.ts TITLE_LEVEL). */
const ATTRACT_LEVEL = '2-2';
/** Enter / Space on these activate them; anywhere else on the sheet (or the scene around it) they do nothing. */
const CONTROLS = 'button, a, input, select, textarea, [role="tab"], [role="radio"]';
/** px kept between a card picked with the keys and the list's edge: its focus ring (3 px out, 2.5 px wide) and shadow. */
const REVEAL_PAD = 8;
/**
 * tall: px under the top safe inset kept for the try-on tag (styles.css .skins-try: 10 px down, 56-58 px tall with its
 * × button and two or three lines) and the ghost tags that the attract draws just above its beam: the attract framed
 * over a high sheet starts under it.
 */
export const TRY_BAND = 80;
/**
 * What the sheet keeps when it is rebuilt in place (a rotation re-renders the screen): the try-on and the list's scroll;
 * the tab is the screen's own `part`. Opening the sheet again starts afresh (a new screen object).
 */
const kept = new WeakMap<object, { trying: string | null; scroll: number }>();

const nameOf = (id: string): string => t(`skin.${id}.name` as I18nKey);
/** A level id that never breaks at its hyphen (「2-」 / 「2」 on two lines): word joiners around it. */
const levelId = (id: string): string => id.replace(/-/g, '\u2060-\u2060');

/** The unlock condition of a locked card (§7.14 table), with {have}/{need} filled in. */
export function conditionText(rule: UnlockRule, have: number, need: number, env: Pick<ScreenEnv, 'levels'>): string {
  const v = { have, need };
  switch (rule.k) {
    case 'always': return t('skin.rule.always');
    case 'clears': return rule.n === 'all' ? t('skin.rule.clearsAll', v) : need === 1 ? t('skin.rule.clears1') : t('skin.rule.clears', v);
    case 'level': {
      const lv = env.levels().find((l) => l.id === rule.id);
      return t('skin.rule.level', { id: levelId(rule.id), name: lv ? levelName(lv) : rule.id });
    }
    case 'world': return t('skin.rule.world', { ...v, w: rule.w });
    case 'notes': return t('skin.rule.notes', v);
    case 'tricks': return t(rule.n === 'all' ? 'skin.rule.tricksAll' : 'skin.rule.tricks', v);
    case 'badge': {
      const name = t(`badge.${rule.id as BadgeId}`);
      // やさしさ exists only on the levels with a gentle limit (2-2, 3-2): the condition names them.
      const gentle = rule.id === 'yasashisa' ? env.levels().filter((l) => l.world >= 1 && typeof l.badges?.gentleN === 'number') : [];
      if (gentle.length) {
        const n = Math.min(...gentle.map((l) => l.badges!.gentleN!));
        const levels = gentle.map((l) => levelId(l.id)).join(t('skin.rule.or'));
        return t('skin.rule.gentle', { name, levels, n: String(n) });
      }
      return t('skin.rule.badge', { name, desc: t(`badge.${rule.id as BadgeId}.desc`) });
    }
    case 'fails': return t('skin.rule.fails', v);
    case 'attempts': return t('skin.rule.attempts', v);
    case 'golds': return t('skin.rule.golds', v);
    case 'crowns': return rule.n === 'all' ? t('skin.rule.crownsAll', v) : need === 1 ? t('skin.rule.crowns1') : t('skin.rule.crowns', v);
    case 'streak': return t('skin.rule.streak', v);
    default: return '';
  }
}

function readView(env: ScreenEnv): SkinsView | null {
  try {
    return env.ctx.skins?.() ?? null;
  } catch {
    return null;
  }
}

export function renderSkinsScreen(root: HTMLElement, screen: Extract<Screen, { id: 'skins' }>, env: ScreenEnv): ScreenHandle {
  let view = readView(env);
  const close = h('button', { class: 'btn btn--icon skins-close', type: 'button', 'aria-label': t('common.close'), title: t('common.close') }, icon('close'));
  close.addEventListener('click', () => env.back());
  const head = h('header', { class: 'skins-head' },
    h('div', { class: 'skins-titles' }, h('h1', { class: 'sheet-title', id: 'skins-title' }, icon('brush'), t('skins.title'))),
    close,
    h('p', { class: 'skins-note' }, t('skins.note')));
  const tabs = h('div', { class: 'skins-tabs', role: 'tablist', 'aria-labelledby': 'skins-title' });
  const panel = h('div', { class: 'skins-panel', role: 'tabpanel', id: 'skins-panel', tabindex: '-1' });
  const sheet = h('section', { class: 'sheet skins-sheet screen-enter', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'skins-title' }, head, tabs, panel);
  const tryText = h('div', { class: 'skins-try-text' });
  const tryStop = h('button', { class: 'btn btn--icon skins-try-stop', type: 'button', 'aria-label': t('skins.tryEnd'), title: t('skins.tryEnd') }, icon('close'));
  const tryBanner = h('div', { class: 'skins-try', role: 'status', hidden: true }, icon('brush'), tryText, tryStop);
  // wide: the panel takes the side away from the attract's goal (as the results card does), so the walls, the goal and
  // the ball's last swing stay in view beside it.
  const attract = env.levels().find((l) => l.id === ATTRACT_LEVEL);
  const el = h('div', { class: 'skins', 'data-side': attract ? resultsSide(attract) : 'left' }, tryBanner, sheet);
  root.appendChild(el);

  if (!view) {
    panel.append(h('p', { class: 'skins-empty' }, '—'));
    return {};
  }

  // NEW labels belong to this visit: the ids are marked seen when their tab opens, the labels stay until close.
  const fresh = new Set(view.items.filter((i) => i.isNew).map((i) => i.id));
  const visited = new Set<SkinPart>();
  let part: SkinPart = screen.part ?? view.items.find((i) => fresh.has(i.id))?.part ?? 'ball';
  let trying: SkinItem | null = null;
  /** An equip picked with the arrow keys, stored when the keys settle (or on close). */
  let pending: SkinItem | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** A try-on reached core (closing must end it even when its "end" was still waiting for the debounce). */
  let previewed = false;

  // tall: core frames the attract above the sheet (the sheet can be taller than the control deck on a small phone or at
  // 125 % text); its top edge goes along now and whenever the sheet changes size. A sheet that rises above the floor also
  // gets the empty HUD band for the attract, down from under the try-on tag's band (TRY_BAND).
  const sheetTop = (): number | undefined => {
    if (env.layoutKind() !== 'tall') return undefined;
    const yp = el.closest('.yp');
    if (!yp || !el.isConnected) return undefined;
    const top = el.getBoundingClientRect().top - yp.getBoundingClientRect().top + sheet.offsetTop;
    return sheet.offsetHeight > 0 && Number.isFinite(top) ? top : undefined;
  };
  const shown = (): void => {
    try {
      const top = sheetTop();
      env.ctx.skinsShown?.(true, top, top === undefined ? undefined : env.safeTop() + TRY_BAND);
    } catch {
      /* core's business */
    }
  };
  shown();
  let resize: ResizeObserver | null = null;
  try {
    resize = new ResizeObserver(() => {
      if (!disposed) shown();
    });
    resize.observe(sheet);
  } catch {
    resize = null;   // no ResizeObserver: the top edge of the first layout stays
  }

  const partItems = (p: SkinPart): SkinItem[] => view!.items.filter((i) => i.part === p);
  /** The equipped id of a part, an arrow-key pick waiting for the keys to settle included. */
  const equippedId = (p: SkinPart): string => (pending?.part === p ? pending.id : view!.equipped[p]);
  const lookOf = <P extends SkinPart>(p: P): SkinLook[P] => {
    const id = trying?.part === p ? trying.id : equippedId(p);
    return (view!.items.find((i) => i.id === id) ?? partItems(p)[0]!).look as SkinLook[P];
  };
  const setDone = (set: SkinItem['set']): boolean => set !== 'original' && view!.items.filter((i) => i.set === set).every((i) => i.owned);

  function markSeen(p: SkinPart): void {
    const ids = partItems(p).filter((i) => i.owned && fresh.has(i.id)).map((i) => i.id);
    if (!ids.length) return;
    try {
      env.ctx.store?.update((d) => markSkinsSeen(d, ids));
    } catch {
      /* the store reports its own failures */
    }
  }

  // ---- tabs
  const tabBtns = PARTS.map((p) => {
    const b = h('button', { class: 'wtab skins-tab', type: 'button', role: 'tab', id: `skins-tab-${p}`, 'aria-controls': 'skins-panel', 'data-part': p });
    b.addEventListener('click', () => selectTab(p, false));
    return b;
  });
  tabs.append(...tabBtns);

  function paintTabs(): void {
    tabBtns.forEach((b, k) => {
      const p = PARTS[k]!;
      const items = partItems(p);
      const on = p === part;
      const dot = !visited.has(p) && items.some((i) => fresh.has(i.id));
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on) b.setAttribute('data-autofocus', '');
      else b.removeAttribute('data-autofocus');
      b.replaceChildren(
        // A break opportunity after 「・」 / "&" (the label wraps there at 125 % text instead of being cut).
        h('span', { class: 'skins-tab-label' }, t(`skins.tab.${p}` as I18nKey).replace(/([・&])\s?/g, (m) => `${m}\u200b`)),
        h('b', { class: 'num' }, `${items.filter((i) => i.owned).length}/${items.length}`));
      if (dot) b.append(h('span', { class: 'skin-dot', 'aria-label': t('skins.new') }));
    });
  }

  function selectTab(p: SkinPart, focus: boolean): void {
    part = p;
    screen.part = p;   // a rebuild (rotation) opens the same tab
    visited.add(p);
    markSeen(p);
    panel.setAttribute('aria-labelledby', `skins-tab-${p}`);
    paintTabs();
    paintPanel();
    panel.scrollTop = 0;
    if (focus) tabBtns[PARTS.indexOf(p)]!.focus({ preventScroll: true });
  }

  // ---- cards
  function card(it: SkinItem): HTMLButtonElement {
    const on = equippedId(it.part) === it.id;
    const tryingThis = trying?.id === it.id;
    const ctxLooks = { ball: lookOf('ball'), crane: lookOf('crane'), trail: lookOf('trail'), stage: lookOf('stage') };
    const cls = `skin-card${on ? ' is-on' : ''}${it.owned ? '' : ' is-locked'}${tryingThis ? ' is-trying' : ''}`;
    const b = h('button', { class: cls, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: '-1', 'data-skin': it.id });
    const cond = it.owned ? '' : conditionText(it.rule, it.have, it.need, env);
    const badge = on
      ? h('span', { class: 'skin-badge skin-badge--on', 'aria-hidden': 'true' }, icon('check'))
      : !it.owned ? h('span', { class: 'skin-badge skin-badge--lock', 'aria-hidden': 'true' }, icon('lock')) : null;
    const main = h('span', { class: 'skin-main' },
      h('span', { class: 'skin-set' }, t(`skin.set.${it.set}` as I18nKey), setDone(it.set) ? h('span', { class: 'skin-stamp' }, t('skins.setDone')) : null),
      h('span', { class: 'skin-name' }, h('span', null, nameOf(it.id)),
        fresh.has(it.id) ? h('span', { class: 'newdot' }, t('skins.new')) : null,
        on ? h('span', { class: 'skin-on' }, t('skins.equipped')) : null,
        tryingThis ? h('span', { class: 'skin-on skin-on--try' }, t('skins.trying')) : null));
    if (it.owned) main.append(h('span', { class: 'skin-blurb' }, t(`skin.${it.id}.blurb` as I18nKey)));
    else {
      main.append(h('span', { class: 'skin-cond' }, cond));
      if (it.need > 1) {
        const pct = Math.max(0, Math.min(100, (it.have / it.need) * 100));
        main.append(h('span', { class: 'skin-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(it.need), 'aria-valuenow': String(it.have), 'aria-label': cond },
          h('i', { style: `width:${pct.toFixed(1)}%` })));
      }
    }
    b.append(h('span', { class: 'skin-thumb' }, skinThumb(it.part, it.look, ctxLooks), badge), main);
    // Read as: name, NEW, equipped, then the blurb (unlocked) or "locked: condition" (the badges are pictures only).
    const parts = [nameOf(it.id), fresh.has(it.id) ? t('skins.new') : '', on ? t('skins.equipped') : '', it.owned ? t(`skin.${it.id}.blurb` as I18nKey) : `${t('skins.locked')}: ${cond}`];
    b.setAttribute('aria-label', parts.filter(Boolean).join(getLang() === 'ja' ? '、' : ', '));
    b.addEventListener('click', () => pick(it));
    return b;
  }

  function paintPanel(): void {
    const items = partItems(part);
    const group = h('div', { class: 'skins-list', role: 'radiogroup', 'aria-label': t(`skins.tab.${part}` as I18nKey) }, ...items.map(card));
    const cards = [...group.querySelectorAll<HTMLButtonElement>('.skin-card')];
    const focusable = cards.find((c) => c.getAttribute('aria-checked') === 'true') ?? cards[0];
    if (focusable) focusable.tabIndex = 0;
    // The cards first (on a small phone the sheet has room for one or two); the notes under them.
    const kids: HTMLElement[] = [group];
    if (items.some((i) => !i.owned)) kids.push(h('p', { class: 'skins-hint' }, t('skins.tryHint')));
    if (part === 'ball' || part === 'trail') kids.push(h('p', { class: 'skins-egg' }, icon('info'), t('skins.egg')));
    panel.replaceChildren(...kids);
  }

  function paintTry(): void {
    tryBanner.hidden = !trying;
    if (!trying) return;
    tryText.replaceChildren(
      // Landscape phones: the short heading (「試着中」) and the name only (the card's lock and condition say the rest),
      // see styles.css.
      h('b', null, h('span', { class: 'skins-try-long' }, t('skins.try')), h('span', { class: 'skins-try-short' }, t('skins.trying'))),
      h('span', null, nameOf(trying.id), h('span', { class: 'skins-try-cond' }, ` — ${conditionText(trying.rule, trying.have, trying.need, env)}`)));
  }

  /** Stores a waiting equip (settings.skin; core applies it) and hands the try-on state to core. */
  function settle(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending) {
      const it = pending;
      pending = null;
      const st = env.settings();
      env.applySettings({ ...st, skin: { ...(st.skin ?? {}), [it.part]: it.id } });
      view = readView(env) ?? view;
    }
    const ids = trying ? { [trying.part]: trying.id } : null;
    if (!ids && !previewed) return;
    previewed = ids !== null;
    try {
      env.ctx.skinPreview?.(ids);
    } catch {
      /* core's business */
    }
  }

  /** Settle now (a tap on an unlocked card equips at once) or after TRY_ON_DEBOUNCE_MS (try-ons, arrow keys). */
  function schedule(now: boolean): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (now) settle();
    else timer = setTimeout(() => {
      timer = null;
      if (!disposed) settle();
    }, TRY_ON_DEBOUNCE_MS);
  }

  /** Scrolls the list (only the list, never the sheet or the page) so that a card is in view, focus ring included. */
  function reveal(c: HTMLElement): void {
    const p = panel.getBoundingClientRect();
    const r = c.getBoundingClientRect();
    if (!p.height || !r.height) return;   // not laid out
    if (r.top < p.top + REVEAL_PAD) panel.scrollTop -= p.top + REVEAL_PAD - r.top;
    else if (r.bottom > p.bottom - REVEAL_PAD) panel.scrollTop += r.bottom - p.bottom + REVEAL_PAD;
  }

  /** Focus back on a card after a repaint; `show`: the keys picked it, so it is scrolled into view (a tap leaves the list). */
  function refocus(id: string, show = false): void {
    const c = panel.querySelector<HTMLElement>(`[data-skin="${id}"]`);
    c?.focus({ preventScroll: true });
    if (c && show) reveal(c);
  }

  function pick(it: SkinItem, byKey = false): void {
    const hadFocus = el.contains(document.activeElement);
    if (it.owned) {
      // Equip: settings.skin, applied by core; a try-on ends in the same step.
      if (pending && pending.part !== it.part) settle();   // another part's arrow-key pick is stored first
      trying = null;
      pending = it;
      schedule(!byKey);
    } else {
      trying = trying?.id === it.id ? null : it;
      schedule(false);
    }
    paintTry();
    paintPanel();
    if (hadFocus) refocus(it.id, byKey);
  }

  tryStop.addEventListener('click', () => {
    if (!trying) return;
    const id = trying.id;
    trying = null;
    schedule(false);
    paintTry();
    paintPanel();
    refocus(id);
  });

  // Rebuilt in place (a rotation): the try-on comes back (core got its end from the old sheet), and the list where it was.
  const keep = kept.get(screen);
  const again = keep?.trying ? view.items.find((i) => i.id === keep.trying && !i.owned) ?? null : null;
  trying = again;
  selectTab(part, false);
  if (keep) {
    panel.scrollTop = keep.scroll;
    if (again) {
      paintTry();
      schedule(true);
      const c = panel.querySelector<HTMLElement>(`[data-skin="${again.id}"]`);
      if (c) reveal(c);
    }
  }

  return {
    onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || /^F\d+$/.test(e.key)) return false;
      const tgt = e.target as HTMLElement;
      const nav = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End';
      if (nav && tgt.closest('[role="tab"]')) {
        // Tabs: ← → (and Home / End) move and select (automatic activation).
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return true;
        const i = PARTS.indexOf(part);
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? PARTS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + PARTS.length) % PARTS.length;
        selectTab(PARTS[n]!, true);
        return true;
      }
      if (nav && tgt.closest('.skin-card')) {
        // A radio group: the arrows move to the next card and pick it (equip, or try a locked one on). The pick is
        // painted at once and reaches the scene when the keys settle (holding ↓ runs through the cards).
        const cards = [...panel.querySelectorAll<HTMLButtonElement>('.skin-card')];
        const i = cards.indexOf(tgt.closest('.skin-card') as HTMLButtonElement);
        const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
        const n = e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : (i + (back ? -1 : 1) + cards.length) % cards.length;
        const it = partItems(part).find((x) => x.id === cards[n]?.dataset.skin);
        // The arrows check the next card; they never uncheck the one that is on (a locked card on trial stays on trial).
        if (it && !(trying?.id === it.id)) pick(it, true);
        else if (it) refocus(it.id, true);
        return true;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        // A control (card, tab, button) activates itself (ui.ts keeps the key from the game). Anywhere else (the list's
        // background, the notes, the scene around the sheet) nothing happens: the title behind it must not start.
        // Space still scrolls the list it is pressed in.
        if (tgt.closest(CONTROLS)) return false;
        if (e.key === ' ' && tgt.closest('.skins-panel')) {
          e.stopPropagation();
          return false;
        }
        return true;
      }
      if (e.key === 'Tab' || e.key === 'Escape') return false;
      // Everything else stays on the sheet: a stray key must not start the game on the title behind it.
      return e.key.length === 1 || nav || e.key === 'Backspace';
    },
    onEscape() {
      env.back();
    },
    dispose() {
      disposed = true;
      resize?.disconnect();
      kept.set(screen, { trying: trying?.id ?? null, scroll: panel.scrollTop });
      // An arrow-key pick still waiting is stored; a try-on ends (closing goes back to the equipped look).
      trying = null;
      try {
        settle();
      } catch {
        /* the store reports its own failures */
      }
      try {
        if (previewed) env.ctx.skinPreview?.(null);
        env.ctx.skinsShown?.(false);
      } catch {
        /* core's business */
      }
    },
  };
}
