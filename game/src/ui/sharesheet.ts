// Share sheet: card preview and the §7.13 share paths. Owner: O7.
// The PNG is rendered when the sheet opens so that navigator.share runs directly inside the tap (user activation).
import type { DailyView, ResultsData } from './ui';
import type { ScreenEnv } from './context';
import { h, makeModal } from './dom';
import { icon } from './icons';
import { getLang, t } from './i18n/format';
import { copyText, dailyShareText, levelShareText, shareCaps, shareDownloadAndX, shareNative, shareOrigin, splitUrl } from './share';
import { shareCardPng } from './sharecard';

export type ShareTarget = { kind: 'level'; data: ResultsData } | { kind: 'daily'; view: DailyView; gapMm?: number | null };

export function openShareSheet(root: HTMLElement, env: ScreenEnv, target: ShareTarget): HTMLElement {
  const origin = shareOrigin(env.ctx.origin);
  const lang = getLang();
  const text = target.kind === 'level'
    ? levelShareText(target.data, target.data.parSub, origin, lang)
    : target.view.shareText || dailyShareText(target.view, origin, lang, { gapMm: target.gapMm });

  const prev = document.activeElement as HTMLElement | null;
  const scrim = h('div', { class: 'yp-layer', 'data-kind': 'scrim', style: 'z-index:40', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('share.title') });
  let unmodal = (): void => undefined;
  const close = (): void => {
    unmodal();
    scrim.remove();
    prev?.focus?.({ preventScroll: true });
  };
  const closeBtn = h('button', { class: 'btn btn--icon btn--flat', type: 'button', 'aria-label': t('common.close') }, icon('close'));
  closeBtn.addEventListener('click', close);
  const preview = h('div', { class: 'share-prev', 'aria-hidden': 'true' });
  const area = h('textarea', { class: 'share-text', readonly: true, rows: 5, 'aria-label': t('share.title') }) as HTMLTextAreaElement;
  area.value = text;
  const status = h('div', { class: 'note', role: 'status', 'aria-live': 'polite' });
  const buttons = h('div', { class: 'btnrow' });
  const body = h('div', { class: 'card-body' },
    h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('h2', { class: 'sheet-title', style: 'flex:1' }, t('share.title')), closeBtn),
    target.kind === 'level' ? preview : null,
    area, status);
  const card = h('div', { class: 'sheet card screen-enter' }, body, h('div', { class: 'card-foot' }, buttons));
  scrim.append(h('div', { class: 'center-wrap' }, card));
  scrim.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim || (e.target as HTMLElement).classList.contains('center-wrap')) close();
  });
  root.appendChild(scrim);
  unmodal = makeModal(root, scrim);

  let png: Blob | null = null;
  const fileName = target.kind === 'level' ? `yurapita-${target.data.level.id}.png` : 'yurapita-daily.png';

  const copy = async (): Promise<void> => {
    if (await copyText(text)) {
      status.textContent = t('share.copied');
      env.toast(t('share.copied'), 'info');
    } else {
      status.textContent = t('share.manual');
      area.focus();
      area.select();
    }
  };

  function build(): void {
    const caps = shareCaps(png);
    buttons.replaceChildren();
    if (caps.native) {
      const b = h('button', { class: 'btn btn--primary btn--lg', type: 'button', style: 'grid-column:1/-1', 'data-autofocus': '' }, icon('share'), t('share.native'));
      b.addEventListener('click', () => {
        const { text: tx, url } = splitUrl(text);
        void shareNative(tx, url, png).then((r) => {
          if (r === 'clipboard') void copy();
        });
      });
      buttons.append(b);
    } else if (caps.x) {
      const b = h('button', { class: 'btn btn--primary btn--lg', type: 'button', style: 'grid-column:1/-1', 'data-autofocus': '' }, icon('share'), t('share.x'));
      b.addEventListener('click', () => shareDownloadAndX(text, target.kind === 'level' ? png : null, fileName));
      buttons.append(b);
    }
    if (target.kind === 'level' && png && !caps.native) {
      const d = h('button', { class: 'btn', type: 'button' }, icon('download'), t('share.download'));
      d.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(png!);
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
      buttons.append(d);
    }
    const c = h('button', { class: 'btn', type: 'button' }, icon('copy'), t('share.copy'));
    c.addEventListener('click', () => void copy());
    buttons.append(c);
    // Two per row under the full-width primary: an odd one out (e.g. copy alone under 「Xに投稿」) takes the row.
    const halves = [...buttons.children].filter((el) => !(el as HTMLElement).style.gridColumn) as HTMLElement[];
    if (halves.length % 2 === 1) halves[halves.length - 1]!.style.gridColumn = '1/-1';
    if (!caps.clipboard && !caps.native && !caps.x) status.textContent = t('share.manual');
    const f = buttons.querySelector<HTMLElement>('[data-autofocus]') ?? buttons.querySelector<HTMLElement>('button');
    f?.focus({ preventScroll: true });
  }

  build();
  if (target.kind === 'level') {
    let aiPath: Float32Array | null = null;
    try {
      aiPath = env.ctx.aiPath?.(target.data.level.id) ?? null;
    } catch {
      aiPath = null;
    }
    void shareCardPng(target.data, aiPath).then(({ canvas, blob }) => {
      png = blob;
      canvas.setAttribute('aria-hidden', 'true');
      preview.replaceChildren(canvas);
      build();
    });
  }
  return scrim;
}
