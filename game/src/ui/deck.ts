// Portrait control deck: force bar and control surface (GAME_DESIGN.md §3.3). Owner: O7.
// The whole deck element is the touch surface for O4's relative clutch drag. There are no buttons in it.
// Layout from the top: force bar (8 px), control surface (the rest). The fine band is the bottom third of
// `.deck-surface` (O4 reads its rect: deckEl.querySelector('.deck-surface')). No 2D overview of the rail: the 3D view
// above is the only picture of the play.
import { h } from './dom';
import { icon } from './icons';
import { createForceBar } from './hud';
import { t } from './i18n/format';
import { DECK_FORCE_H } from './layout';

export interface Deck {
  readonly el: HTMLElement;
  /** The control surface (O4's fine band is its bottom third). */
  readonly surface: HTMLElement;
  force(F: number, Fmax: number, aiF: number | null, saturated: boolean): void;
  onboarding(kind: 'hand' | 'keys' | null): void;
  /** READY: "move to start" written on the control surface under the grip (tall has no READY pill in the HUD). */
  ready(on: boolean): void;
  dispose(): void;
}

export function createDeck(parent: HTMLElement): Deck {
  const fbar = createForceBar();
  const forceEl = h('div', { class: 'deck-force' }, fbar.el);

  const fine = h('div', { class: 'deck-fine' }, h('span', { class: 'deck-fine-label' }, t('hud.fine')));
  const grip = h('div', { class: 'deck-grip', 'aria-hidden': 'true' }, icon('arrowL'), h('span', { class: 'deck-grip-bar' }), icon('arrowR'));
  const hand = h('div', { class: 'deck-hand', 'aria-hidden': 'true' }, h('span', { class: 'deck-hand-track' }), h('span', { class: 'deck-hand-finger' }, icon('hand')));
  const keys = h('div', { class: 'keycaps', 'aria-hidden': 'true' }, h('span', { class: 'keycap' }, '←'), h('span', { class: 'keycap' }, '→'));
  hand.style.display = 'none';
  keys.style.display = 'none';
  // The same "READY" marker the wide HUD shows in its band, where the thumb goes.
  const readyEl = h('div', { class: 'deck-ready', role: 'status' }, t('hud.ready'));
  readyEl.style.display = 'none';
  const surface = h('div', { class: 'deck-surface' }, fine, grip, hand, keys, readyEl);

  const el = h('div', { class: 'yp-deck', 'data-force-h': DECK_FORCE_H }, forceEl, surface);
  parent.appendChild(el);

  let readyOn = false;

  return {
    el,
    surface,
    force: (F, Fmax, aiF, sat) => fbar.update(F, Fmax, aiF, sat),
    onboarding(kind) {
      hand.style.display = kind === 'hand' ? '' : 'none';
      keys.style.display = kind === 'keys' ? '' : 'none';
      grip.style.display = kind ? 'none' : '';
      el.toggleAttribute('data-onboarding', !!kind);
    },
    ready(on) {
      if (on === readyOn) return;
      readyOn = on;
      readyEl.style.display = on ? '' : 'none';
    },
    dispose() {
      el.remove();
    },
  };
}
