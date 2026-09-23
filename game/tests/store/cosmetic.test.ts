// Cosmetic save fields (GAME_DESIGN.md §7.14, §10.4 "保存"): settings.skin and SaveV1.skins are validated and defaulted
// like the other settings, never break an old or hand-edited save, and stay out of everything that is sent. Owner: O8.
import { describe, expect, it } from 'vitest';
import { defaultSave, parseSave } from '../../src/store/save';
import {
  addOwnedSkins, emptySkinRecord, markSkinsSeen, noteBestStreak, parseSkinRecord, parseSkinSelection,
} from '../../src/store/cosmetic';

describe('settings.skin', () => {
  it('keeps strings (at most 32 characters) under the four part keys, drops the rest', () => {
    expect(parseSkinSelection({ ball: 'ball.steel', crane: 'crane.wood', trail: 'trail.wire', stage: 'stage.site' }))
      .toEqual({ ball: 'ball.steel', crane: 'crane.wood', trail: 'trail.wire', stage: 'stage.site' });
    // Unknown ids are kept (resolveSelection falls back at apply time and the save is never rewritten for it).
    expect(parseSkinSelection({ ball: 'ball.future', hat: 'hat.top', crane: 7, trail: '', stage: 'x'.repeat(33) })).toEqual({ ball: 'ball.future' });
    for (const bad of [null, undefined, 'ball.steel', ['ball.steel'], 3, {}, { ball: null }]) expect(parseSkinSelection(bad)).toBeUndefined();
  });

  it('parseSave: absent stays absent, garbage is dropped, a valid one survives a round trip', () => {
    expect(parseSave({ settings: { lang: 'ja' } }).settings.skin).toBeUndefined();
    expect(parseSave({ settings: { skin: 'nope' } }).settings.skin).toBeUndefined();
    const d = defaultSave('ja');
    d.settings.skin = { ball: 'ball.lapis', stage: 'stage.castle' };
    expect(parseSave(JSON.parse(JSON.stringify(d))).settings.skin).toEqual({ ball: 'ball.lapis', stage: 'stage.castle' });
    expect(defaultSave('ja').settings.skin).toBeUndefined();
  });
});

describe('SaveV1.skins', () => {
  it('owned / seen: catalog ids only, never a default, no duplicates, stored order', () => {
    const r = parseSkinRecord({
      owned: ['trail.pencil', 'ball.red', 'ball.steel', 'ball.steel', 'ball.gold', 42, 'crane.wood'],
      seen: ['stage.note', 'trail.pencil', '__proto__'], bestStreak: 4,
    });
    expect(r).toEqual({ owned: ['trail.pencil', 'ball.steel', 'crane.wood'], seen: ['trail.pencil'], bestStreak: 4 });
  });

  it('bestStreak: an int in [0, 2^31-1], never below the daily streak', () => {
    expect(parseSkinRecord({ bestStreak: -3 })!.bestStreak).toBe(0);
    expect(parseSkinRecord({ bestStreak: 2.5 })!.bestStreak).toBe(0);
    expect(parseSkinRecord({ bestStreak: 2 ** 31 })!.bestStreak).toBe(0);
    expect(parseSkinRecord({ bestStreak: 3 }, 9)!.bestStreak).toBe(9);
    expect(parseSkinRecord({ bestStreak: 12 }, 1)!.bestStreak).toBe(12);
    expect(parseSkinRecord({}, Number.NaN)).toEqual(emptySkinRecord());
  });

  it('parseSave: absent until the first unlock, garbage record -> absent, the daily streak lifts bestStreak', () => {
    expect(parseSave({}).skins).toBeUndefined();
    expect(parseSave({ skins: 'x' }).skins).toBeUndefined();
    expect(parseSave({ skins: [] }).skins).toBeUndefined();
    const s = parseSave({ skins: { owned: ['ball.moss'], seen: [], bestStreak: 2 }, daily: { dayIndex: 3, streak: 5, lastPlayedDay: 3 } });
    expect(s.skins).toEqual({ owned: ['ball.moss'], seen: [], bestStreak: 5 });
  });

  it('noteBestStreak keeps the best daily streak after markPlayed resets it', () => {
    const d = defaultSave('ja');
    noteBestStreak(d);
    expect(d.skins).toBeUndefined();   // nothing to keep yet: no record is created
    d.daily.streak = 7;
    noteBestStreak(d);
    expect(d.skins!.bestStreak).toBe(7);
    d.daily.streak = 1;   // a gap: markPlayed starts over
    noteBestStreak(d);
    expect(d.skins!.bestStreak).toBe(7);
  });

  it('addOwnedSkins / markSkinsSeen: only catalog non-default ids, once each', () => {
    const d = defaultSave('ja');
    expect(addOwnedSkins(d, ['ball.red', 'ball.steel', 'nope'])).toEqual(['ball.steel']);
    expect(addOwnedSkins(d, ['ball.steel', 'trail.wire'])).toEqual(['trail.wire']);
    expect(addOwnedSkins(d, ['ball.steel'])).toEqual([]);
    expect(d.skins!.owned).toEqual(['ball.steel', 'trail.wire']);
    markSkinsSeen(d, ['ball.steel', 'ball.steel', 'stage.note']);
    markSkinsSeen(d, ['ball.steel']);
    expect(d.skins!.seen).toEqual(['ball.steel']);
  });
});
