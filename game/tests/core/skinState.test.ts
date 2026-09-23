// Skins in the running game (GAME_DESIGN.md §7.14): unlock detection over the save and its toasts, the look handed to
// the renderer (only when the ids change, never during a run), try-on, the share card's ball fill, the screen's data.
// Owner: O3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LevelDef, LevelsFile } from '../../src/sim/level';
import type { SaveV1, Store } from '../../src/store/save';
import { defaultLevelProgress, defaultSave } from '../../src/store/save';
import type { Renderer } from '../../src/render/renderer';
import type { SkinLook } from '../../src/render/skinLooks';
import { SKINS } from '../../src/core/skins';
import { SKIN_TOAST_EACH, buildSkinsView, createSkinState } from '../../src/core/skinState';
import { t } from '../../src/ui/i18n/format';

const levels = (JSON.parse(readFileSync(new URL('../../src/data/levels.json', import.meta.url), 'utf8')) as LevelsFile).levels;
const L = (id: string): LevelDef => levels.find((l) => l.id === id)!;

function memStore(d: SaveV1): Store & { updates: number } {
  const s = { persistent: true, updates: 0, data: () => d, update: (fn: (x: SaveV1) => void) => { s.updates++; fn(d); }, flush: () => undefined };
  return s;
}

function rig(save = defaultSave('ja'), opts: { canApply?: () => boolean } = {}) {
  const looks: SkinLook[] = [];
  const toasts: string[] = [];
  const renderer = { setSkin: (l: SkinLook) => looks.push(l) } as unknown as Renderer;
  const store = memStore(save);
  const st = createSkinState({ store, levels, renderer, toast: (text) => toasts.push(text), canApply: opts.canApply ?? (() => true) });
  return { st, save, store, looks, toasts };
}

const clear = (s: SaveV1, id: string, e: Partial<SaveV1['levels'][string]> = {}): void => {
  s.levels[id] = { ...defaultLevelProgress('h'), cleared: true, attempts: 1, ...e };
};
const ids = (l: SkinLook): string[] => [l.ball.id, l.crane.id, l.trail.id, l.stage.id];

describe('apply(): the look reaches the renderer once per change', () => {
  it('a fresh save paints the defaults once; the same ids again do nothing', () => {
    const r = rig();
    r.st.apply();
    r.st.apply();
    expect(r.looks.map(ids)).toEqual([['ball.red', 'crane.yellow', 'trail.ink', 'stage.note']]);
  });

  it('settings.skin resolves against owned: a locked or foreign id falls back to the default', () => {
    const s = defaultSave('ja');
    s.skins = { owned: ['ball.steel'], seen: [], bestStreak: 0 };
    s.settings.skin = { ball: 'ball.steel', crane: 'crane.tancho', trail: 'stage.site' };
    const r = rig(s);
    r.st.apply();
    expect(ids(r.looks[0]!)).toEqual(['ball.steel', 'crane.yellow', 'trail.ink', 'stage.note']);
  });

  it('never during a run: the change waits for the next calm call', () => {
    let calm = false;
    const s = defaultSave('ja');
    s.skins = { owned: ['stage.diazo'], seen: [], bestStreak: 0 };
    const r = rig(s, { canApply: () => calm });
    s.settings.skin = { stage: 'stage.diazo' };
    r.st.apply();
    expect(r.looks).toEqual([]);
    calm = true;
    r.st.apply();
    expect(r.looks.map((l) => l.stage.id)).toEqual(['stage.diazo']);
  });

  it('try-on shows any skin (locked too) over the equipped ones; null goes back', () => {
    const r = rig();
    r.st.apply();
    r.st.preview({ ball: 'ball.lapis', stage: 'stage.castle' });
    expect(ids(r.looks.at(-1)!)).toEqual(['ball.lapis', 'crane.yellow', 'trail.ink', 'stage.castle']);
    r.st.preview({ ball: 'crane.wood' });   // an id of another part is ignored
    expect(ids(r.looks.at(-1)!)).toEqual(['ball.red', 'crane.yellow', 'trail.ink', 'stage.note']);
    r.st.preview({ ball: 'ball.point' });
    r.st.preview(null);
    expect(r.looks.at(-1)!.ball.id).toBe('ball.red');
    expect(r.st.applied()).toEqual({ ball: 'ball.red', crane: 'crane.yellow', trail: 'trail.ink', stage: 'stage.note' });
  });
});

describe('check(): unlocks and toasts', () => {
  it('an existing player at boot: everything earned is owned at once, with ONE summary toast', () => {
    const s = defaultSave('ja');
    for (const id of ['1-1', '1-2', '1-3', '1-4', '2-1', '2-2']) clear(s, id, { medal: 3, fails: 10 });
    s.levels['1-1']!.crown = true;
    s.seen.tricks = ['brakeFling', 'snap', 'windUp'];
    const r = rig(s);
    r.st.check();
    expect(s.skins!.owned).toEqual(['ball.steel', 'ball.wrecker', 'ball.kinobi', 'crane.wood', 'trail.pencil', 'trail.kumihimo', 'stage.diazo']);
    expect(r.toasts).toEqual([t('skin.toastMany', { n: 7 })]);
    // Idempotent: nothing new, no toast, no write.
    const writes = r.store.updates;
    r.st.check();
    expect(r.toasts).toHaveLength(1);
    expect(r.store.updates).toBe(writes);
  });

  it('one new skin at boot is named', () => {
    const s = defaultSave('ja');
    clear(s, '1-1');
    const r = rig(s);
    r.st.check();
    expect(r.toasts).toEqual([t('skin.toast', { name: t('skin.trail.pencil.name') })]);
  });

  it(`after a run: up to ${SKIN_TOAST_EACH} new skins are named one by one, more get one summary`, () => {
    const s = defaultSave('ja');
    const r = rig(s);
    r.st.check();   // boot: nothing yet
    expect(r.toasts).toEqual([]);
    clear(s, '1-1', { crown: true, medal: 3 });   // first clear + first crown: pencil and the braided cord
    r.st.check();
    expect(r.toasts).toEqual([
      t('skin.toast', { name: t('skin.trail.pencil.name') }),
      t('skin.toast', { name: t('skin.trail.kumihimo.name') }),
    ]);
    for (const id of ['1-2', '1-3', '1-4', '2-1', '2-2']) clear(s, id, { medal: 3 });   // W1, 2-2, 5 golds
    r.st.check();
    expect(r.toasts.at(-1)).toBe(t('skin.toastMany', { n: 3 }));
    expect(s.skins!.owned).toEqual(['trail.pencil', 'trail.kumihimo', 'ball.steel', 'ball.kinobi', 'stage.diazo']);
  });

  it('the best daily streak is kept: a streak skin stays owned after markPlayed resets the streak', () => {
    const s = defaultSave('ja');
    s.daily.streak = 7;
    const r = rig(s);
    r.st.check();
    expect(s.skins).toEqual({ owned: ['ball.moss', 'crane.primer'], seen: [], bestStreak: 7 });
    s.daily.streak = 1;
    r.st.check();
    expect(s.skins!.owned).toEqual(['ball.moss', 'crane.primer']);
    expect(buildSkinsView(s, levels).items.find((i) => i.id === 'ball.moss')!.have).toBe(7);
  });

  it('an unlock re-resolves the selection (an id stored before it was owned now applies)', () => {
    const s = defaultSave('ja');
    s.settings.skin = { trail: 'trail.pencil' };
    const r = rig(s);
    r.st.apply();
    expect(r.looks.at(-1)!.trail.id).toBe('trail.ink');
    clear(s, '1-1');
    r.st.check();
    expect(r.looks.at(-1)!.trail.id).toBe('trail.pencil');
  });
});

describe('the share card and the screen data', () => {
  it('ballFill: the equipped ball body; undefined for the default red and on the egg level', () => {
    const s = defaultSave('ja');
    const r = rig(s);
    expect(r.st.ballFill(L('2-2'))).toBeUndefined();
    s.skins = { owned: ['ball.lapis'], seen: [], bestStreak: 0 };
    s.settings.skin = { ball: 'ball.lapis' };
    expect(r.st.ballFill(L('2-2'))).toBe('#23408A');
    expect(r.st.ballFill(L('4-3'))).toBeUndefined();
    r.st.preview({ ball: 'ball.steel' });   // a try-on is never a run's ball
    expect(r.st.ballFill(L('2-2'))).toBe('#23408A');
  });

  it('view(): catalog order, looks, owned / NEW, progress capped at need, the equipped ids', () => {
    const s = defaultSave('ja');
    s.skins = { owned: ['ball.steel', 'trail.pencil'], seen: ['trail.pencil'], bestStreak: 0 };
    s.settings.skin = { ball: 'ball.steel' };
    for (let k = 0; k < 4; k++) clear(s, `1-${k + 1}`, { fails: 30 });
    const v = rig(s).st.view();
    expect(v.items.map((i) => i.id)).toEqual(SKINS.map((d) => d.id));
    expect(v.equipped).toEqual({ ball: 'ball.steel', crane: 'crane.yellow', trail: 'trail.ink', stage: 'stage.note' });
    expect(v.unseen).toBe(1);
    const by = (id: string) => v.items.find((i) => i.id === id)!;
    expect(by('ball.steel')).toMatchObject({ owned: true, isNew: true, part: 'ball', set: 'lab' });
    expect(by('ball.steel').look).toMatchObject({ id: 'ball.steel', body: '#384354' });
    expect(by('ball.red')).toMatchObject({ owned: true, isNew: false });
    // Not owned yet although the rule is met (core adds it on the next check): the card still says what it needs.
    expect(by('ball.wrecker')).toMatchObject({ owned: false, have: 50, need: 50 });
    expect(by('stage.site')).toMatchObject({ owned: false, have: 4, need: 300 });
  });
});
