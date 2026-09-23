// Skins in the running game (GAME_DESIGN.md §7.14, skins spec §6): unlocks, toasts, the applied look, the try-on
// preview, the share card's ball colour and the skins screen's data. Owner: O3.
//
// app.ts keeps only the wiring: apply() before renderer.init (the pending look is painted once) and after a settings
// change, check() whenever a calm screen is shown (never while RUNNING), view() / preview() for the UI context.
// Skins are cosmetic only: no skin id reaches replays, boards, links, the outbox or ghosts.
import type { LevelDef } from '../sim/level';
import type { Layout, Renderer, RendererExtras } from '../render/renderer';
import type { SaveV1, Store } from '../store/save';
import { addOwnedSkins, ensureSkinRecord } from '../store/cosmetic';
import type { SkinItem, SkinsView } from '../ui/context';
import type { ResultsData } from '../ui/ui';
import { dayIndexAt, jstDayNumber } from '../shared/daily';
import { currentStreak } from './dailyMode';
import {
  DEFAULT_SKIN_IDS, SKINS, SKIN_PARTS, newlyUnlocked, resolveSelection, ruleProgress, skinFacts, skinLook, type SkinPart,
} from './skins';
import { partLook } from '../render/skinLooks';
import { ct } from './text';

/** After a run: up to this many new skins get a toast each; more get one summary toast. */
export const SKIN_TOAST_EACH = 2;

export type SkinIds = Record<SkinPart, string>;

/** tall: px of paper kept between the floor's front edge and the skins sheet framed above it (skinsSheetLayout). */
export const SKINS_SHEET_GAP = 6;

/**
 * The layout the renderer frames the scene in while the skins sheet is open. tall, the sheet's top edge (root px) higher
 * than the floor's front edge (a small phone, 125 % text): that edge becomes the bottom of the play area (the layout's
 * bench band, at most 60 % of the scene), so the whole attract (floor to beam) shows above it as the try-on preview.
 * Otherwise (wide, no sheet, a sheet below the floor) the layout itself.
 */
export function skinsSheetLayout(l: Layout, sheetTop: number | null): Layout {
  if (sheetTop === null || l.kind !== 'tall' || !Number.isFinite(sheetTop)) return l;
  const cover = l.scene.y + l.scene.h - sheetTop + SKINS_SHEET_GAP;
  return cover > (l.bench ?? 0) + SKINS_SHEET_GAP ? { ...l, bench: Math.min(cover, l.scene.h * 0.6) } : l;
}

/**
 * The skins screen's data from a save (also used by dev/ui-demo). A locked streak skin shows the streak as it stands
 * today (「いま{have}日」: 0 once a day was missed, as on the daily hub), not the best one its unlock rule counts.
 */
export function buildSkinsView(save: SaveV1, levels: readonly LevelDef[], equipped?: SkinIds, nowMs: number = Date.now()): SkinsView {
  const rec = save.skins;
  const owned = new Set(rec?.owned ?? []);
  const seen = new Set(rec?.seen ?? []);
  const facts = skinFacts(save, levels, { bestStreak: rec?.bestStreak ?? 0 });
  const defaults = new Set<string>(Object.values(DEFAULT_SKIN_IDS));
  let streakNow = 0;
  try {
    streakNow = save.daily ? Math.max(0, Math.floor(currentStreak(save.daily, dayIndexAt(nowMs), jstDayNumber(nowMs)) || 0)) : 0;
  } catch {
    streakNow = 0;
  }
  const items: SkinItem[] = SKINS.map((s) => {
    const p = ruleProgress(s.rule, facts);
    const isOwned = defaults.has(s.id) || owned.has(s.id);
    const have = s.rule.k === 'streak' && !isOwned ? streakNow : p.have;
    return {
      id: s.id, part: s.part, set: s.set, rule: s.rule, look: partLook(s.part, s.id),
      owned: isOwned, isNew: isOwned && !defaults.has(s.id) && !seen.has(s.id),
      have: Math.min(have, p.need), need: p.need,
    };
  });
  return {
    items,
    equipped: equipped ?? resolveSelection(save.settings.skin, owned),
    unseen: items.filter((i) => i.isNew).length,
  };
}

export interface SkinStateDeps {
  store: Store;
  levels: readonly LevelDef[];
  renderer: Renderer;
  toast(text: string, kind: 'info'): void;
  /** False while a run is on (RUNNING and its beats): the look is then applied at the next calm moment. */
  canApply(): boolean;
  /** Wall clock in ms (the streak shown on the screen is today's). Default Date.now. */
  now?: () => number;
}

export interface SkinState {
  /** Resolves settings.skin (plus a try-on preview) and hands the look to the renderer when the ids changed. */
  apply(): void;
  /**
   * Unlock detection over the save: new skins go into skins.owned with a toast (one summary toast for many). With the
   * results card about to open, they are also listed on it (ResultsData.skins): a toast can find no room next to the
   * card on a small phone and is dropped when stale, the card's line stays.
   */
  check(results?: ResultsData | null): void;
  /** Try-on of any skins (locked ones too) on top of the equipped ones; null ends it. */
  preview(ids: Partial<SkinIds> | null): void;
  /** The ids the renderer has (the pending look before init). */
  applied(): SkinIds | null;
  /** The share card's ball colour of a run on `level`: the equipped ball's body, undefined for the default or an egg. */
  ballFill(level: LevelDef): string | undefined;
  view(): SkinsView;
}

const same = (a: SkinIds | null, b: SkinIds): boolean => !!a && SKIN_PARTS.every((p) => a[p] === b[p]);

export function createSkinState(d: SkinStateDeps): SkinState {
  let applied: SkinIds | null = null;
  let tryOn: Partial<SkinIds> | null = null;
  let firstCheck = true;

  const save = (): SaveV1 => d.store.data();
  const owned = (): Set<string> => new Set(save().skins?.owned ?? []);
  const equipped = (): SkinIds => resolveSelection(save().settings.skin, owned());

  function wanted(): SkinIds {
    const ids = { ...equipped() };
    if (tryOn) for (const p of SKIN_PARTS) if (typeof tryOn[p] === 'string' && SKINS.some((s) => s.id === tryOn![p] && s.part === p)) ids[p] = tryOn[p]!;
    return ids;
  }

  function apply(): void {
    if (!d.canApply()) return;
    const ids = wanted();
    if (same(applied, ids)) return;
    applied = ids;
    try {
      (d.renderer as Partial<RendererExtras>).setSkin?.(skinLook(ids));
    } catch (e) {
      console.error('[yurapita] renderer.setSkin:', e);
    }
  }

  function check(results?: ResultsData | null): void {
    const sv = save();
    const best = Math.max(sv.skins?.bestStreak ?? 0, sv.daily?.streak ?? 0);
    const fresh = newlyUnlocked(skinFacts(sv, d.levels, { bestStreak: best }), sv.skins?.owned ?? []);
    const bestUp = best > (sv.skins?.bestStreak ?? 0);
    const boot = firstCheck;
    firstCheck = false;
    if (!fresh.length && !bestUp) {
      apply();
      return;
    }
    let added: string[] = [];
    d.store.update((s) => {
      if (bestUp) ensureSkinRecord(s).bestStreak = best;
      added = addOwnedSkins(s, fresh);
    });
    // At boot (an existing player's first visit with skins: everything they already earned) one toast says it all;
    // after a run, one or two new skins are named.
    if (added.length > (boot ? 1 : SKIN_TOAST_EACH)) d.toast(ct('skin.toastMany', { n: added.length }), 'info');
    else for (const id of added) d.toast(ct('skin.toast', { name: ct(`skin.${id}.name`) }), 'info');
    if (results && added.length) results.skins = [...(results.skins ?? []), ...added];
    apply();
  }

  return {
    apply,
    check,
    preview(ids) {
      tryOn = ids && Object.keys(ids).length ? { ...ids } : null;
      apply();
    },
    applied: () => (applied ? { ...applied } : null),
    ballFill(level) {
      if (level.cargo === 'egg') return undefined;
      const id = equipped().ball;
      return id === DEFAULT_SKIN_IDS.ball ? undefined : partLook('ball', id).body;
    },
    view: () => buildSkinsView(save(), d.levels, equipped(), (d.now ?? Date.now)()),
  };
}
