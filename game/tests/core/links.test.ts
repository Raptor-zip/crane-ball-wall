// Challenge / level / daily links (GAME_DESIGN.md §7.5, §7.13): round trip, and garbage never throws. Owner: O3.
import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/sim/level';
import {
  challengeUrl, levelUrl, parseHash, resolveLink, shareLevelUrl, shareOrigin, type LinkDeps,
} from '../../src/core/links';
import { SIM_VERSION } from '../../src/sim/constants';

const ORIGIN = 'https://yurapita.example';
const REPLAY = 'WVABAQ3xYz_-09';

const fakeLevel = (id: string, hash: string): LevelDef => ({ id, physics: { hash } }) as unknown as LevelDef;
const deps: LinkDeps = {
  findLevel: (id) => (['1-1', '2-2', 'd:17'].includes(id) ? fakeLevel(id, id === '2-2' ? 'aaaa0000' : 'bbbb1111') : null),
  replayLevelHash: (b64) => {
    if (b64.startsWith('BROKEN')) throw new Error('decodeReplay: bad magic');
    return b64.startsWith('OLD') ? 'ffff0000' : 'aaaa0000';
  },
  levelHash: (phys) => (phys as unknown as { hash: string }).hash,
};

describe('parseHash', () => {
  it('round-trips a challenge link', () => {
    const url = challengeUrl(ORIGIN, '2-2', REPLAY);
    expect(url).toBe(`${ORIGIN}/#c=2-2.${REPLAY}`);
    expect(parseHash(new URL(url).hash)).toEqual({ kind: 'challenge', levelId: '2-2', replay: REPLAY });
  });

  it('round-trips daily challenge and level links', () => {
    expect(parseHash(new URL(challengeUrl(ORIGIN, 'd:17', REPLAY)).hash)).toEqual({ kind: 'challenge', levelId: 'd:17', replay: REPLAY });
    expect(parseHash(new URL(levelUrl(ORIGIN, '4-2')).hash)).toEqual({ kind: 'level', levelId: '4-2' });
    expect(parseHash('#d')).toEqual({ kind: 'daily' });
  });

  it('accepts percent-encoded colons (some share targets encode them)', () => {
    expect(parseHash(`#c=d%3A17.${REPLAY}`)).toEqual({ kind: 'challenge', levelId: 'd:17', replay: REPLAY });
  });

  it('never throws on garbage', () => {
    const garbage = [
      '', '#', '#x', '#c=', '#c=.', '#c=2-2', '#c=2-2.', '#c=.abc', '#c=9-9.abc', '#c=2-2.ab$cd', '#c=%E0%A4%A.x',
      '#l=', '#l=../../etc', '#l=2-2.x', '#c=2-2.' + 'A'.repeat(50000), '#%', '#dd', '#c=<script>.x',
      undefined as unknown as string, null as unknown as string, 42 as unknown as string,
    ];
    for (const g of garbage) {
      expect(() => parseHash(g)).not.toThrow();
      const r = parseHash(g);
      expect(['none', 'invalid', 'challenge']).toContain(r.kind);
    }
    expect(parseHash('#c=2-2').kind).toBe('invalid');
    expect(parseHash('#c=9-9.abc').kind).toBe('invalid');
    expect(parseHash('#l=../../etc').kind).toBe('invalid');
    expect(parseHash('#x').kind).toBe('none');
  });
});

describe('resolveLink', () => {
  it('opens a valid challenge with its ghost', () => {
    const r = resolveLink(parseHash(`#c=2-2.${REPLAY}`), deps);
    expect(r).toMatchObject({ kind: 'challenge', replay: REPLAY, stale: false });
  });

  it('opens a stale challenge without the ghost ("古いバージョン")', () => {
    const r = resolveLink(parseHash('#c=2-2.OLDreplay'), deps);
    expect(r).toMatchObject({ kind: 'challenge', replay: null, stale: true });
  });

  it('a replay of another simulation version is stale too (a SIM_VERSION bump since the link was shared)', () => {
    const withSim = (sim: number): LinkDeps => ({ ...deps, replaySim: () => sim });
    expect(resolveLink(parseHash(`#c=2-2.${REPLAY}`), withSim(SIM_VERSION))).toMatchObject({ kind: 'challenge', replay: REPLAY, stale: false });
    expect(resolveLink(parseHash(`#c=2-2.${REPLAY}`), withSim(SIM_VERSION + 1))).toMatchObject({ kind: 'challenge', replay: null, stale: true });
    const broken: LinkDeps = { ...deps, replaySim: () => { throw new Error('decodeReplay: bad magic'); } };
    expect(resolveLink(parseHash(`#c=2-2.${REPLAY}`), broken)).toEqual({ kind: 'error' });
  });

  it('sends broken challenges to level select (kind error), never throws', () => {
    expect(resolveLink(parseHash('#c=2-2.BROKENxx'), deps)).toEqual({ kind: 'error' });
    expect(resolveLink(parseHash('#c=5-3.abc'), deps)).toEqual({ kind: 'error' }); // unknown level
    expect(resolveLink(parseHash('#c=2-2'), deps)).toEqual({ kind: 'error' });
    expect(resolveLink(parseHash('#l=5-9'), deps)).toEqual({ kind: 'error' });
    const throwing: LinkDeps = { ...deps, findLevel: () => { throw new Error('boom'); } };
    expect(resolveLink(parseHash(`#c=2-2.${REPLAY}`), throwing)).toEqual({ kind: 'error' });
  });

  it('passes daily and none through; #l= opens the level', () => {
    expect(resolveLink({ kind: 'daily' }, deps)).toEqual({ kind: 'daily' });
    expect(resolveLink({ kind: 'none' }, deps)).toEqual({ kind: 'none' });
    expect(resolveLink(parseHash('#l=1-1'), deps)).toMatchObject({ kind: 'level', level: { id: '1-1' } });
  });
});

describe('share URL (§7.13)', () => {
  it('falls back to #l= without a replay or above 1,500 characters', () => {
    expect(shareLevelUrl(ORIGIN, '2-2', REPLAY)).toBe(`${ORIGIN}/#c=2-2.${REPLAY}`);
    expect(shareLevelUrl(ORIGIN, '2-2', null)).toBe(`${ORIGIN}/#l=2-2`);
    expect(shareLevelUrl(ORIGIN, '2-2', 'A'.repeat(1500))).toBe(`${ORIGIN}/#l=2-2`);
  });

  it('origin: VITE_PUBLIC_ORIGIN, else http(s) location, else none', () => {
    expect(shareOrigin('https://a.example/', { protocol: 'file:', origin: 'null' })).toBe('https://a.example');
    expect(shareOrigin(undefined, { protocol: 'https:', origin: 'https://b.example' })).toBe('https://b.example');
    expect(shareOrigin(undefined, { protocol: 'file:', origin: 'null' })).toBeNull();
    expect(shareOrigin('', null)).toBeNull();
  });
});
