// Inline SVG icons (no image files, §9.1). Bold round strokes to match the rounded type. Owner: O7.
import type { GhostKind } from '../render/renderer';
import type { Medal } from '../core/bus';
import { svgFrom } from './dom';

const A = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
const ST = 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
  retry: `<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4 3.5v4.8h4.8"/>`,
  pause: `<path d="M8.5 5.5v13M15.5 5.5v13"/>`,
  play: `<path d="M8 5.2v13.6L19 12z" fill="currentColor"/>`,
  back: `<path d="M14.5 5.5 8 12l6.5 6.5"/>`,
  next: `<path d="M9.5 5.5 16 12l-6.5 6.5"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  gear: `<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".6" fill="currentColor"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>`,
  crown: `<path d="M3.5 8.5 7.5 13l4.5-7 4.5 7 4-4.5-1.8 10H5.3z" fill="currentColor" stroke-width="1.6"/>`,
  share: `<path d="M12 3.5v11M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5v6.5h14v-6.5"/>`,
  download: `<path d="M12 3.5v11M7.5 10 12 14.5 16.5 10"/><path d="M5 19.5h14"/>`,
  copy: `<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>`,
  sound: `<path d="M4.5 9.5h3.5L13 5v14l-5-4.5H4.5z" fill="currentColor" stroke-width="1.8"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>`,
  mute: `<path d="M4.5 9.5h3.5L13 5v14l-5-4.5H4.5z" fill="currentColor" stroke-width="1.8"/><path d="m16.5 9.5 5 5M21.5 9.5l-5 5"/>`,
  ghost: `<path d="M6 20V11a6 6 0 0 1 12 0v9l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6z"/><circle cx="10" cy="11" r=".9" fill="currentColor"/><circle cx="14" cy="11" r=".9" fill="currentColor"/>`,
  line: `<path d="M3.5 18c3-9 6-12 8.5-12s5.5 3 8.5 12" stroke-dasharray="2.2 3"/>`,
  book: `<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5z"/><path d="M12 6.5v13"/>`,
  demo: `<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor" stroke-width="1.6"/>`,
  practice: `<path d="M12 7v5l3 2"/><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v4h4"/>`,
  skip: `<path d="M5 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor" stroke-width="1.6"/>`,
  reverse: `<path d="M19 6l-7 6 7 6zM12 6l-7 6 7 6z" fill="currentColor" stroke-width="1.6"/>`,
  list: `<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.8" cy="7" r=".8" fill="currentColor"/><circle cx="4.8" cy="12" r=".8" fill="currentColor"/><circle cx="4.8" cy="17" r=".8" fill="currentColor"/>`,
  assist: `<path d="M4 15c2.5-4 5.5-4 8 0s5.5 4 8 0"/><path d="M12 4v5"/>`,
  offline: `<path d="M3.5 9a13 13 0 0 1 17 0M6.5 12.5a8.5 8.5 0 0 1 11 0M9.5 16a4 4 0 0 1 5 0"/><path d="M4 4l16 16"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  wait: `<path d="M6.5 3.5h11M6.5 20.5h11"/><path d="M8 3.5v2c0 3 4 3.5 4 6.5s-4 3.5-4 6.5v2M16 3.5v2c0 3-4 3.5-4 6.5s4 3.5 4 6.5v2"/><path d="M9.8 18.8h4.4L12 16.6z" fill="currentColor" stroke-width="1.4"/>`,
  hand: `<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5V4a1.5 1.5 0 0 1 3 0v6m0-1a1.5 1.5 0 0 1 3 0v4.5c0 4-2.5 6.5-6 6.5-2.5 0-4-1-5.5-3L4 13.6a1.6 1.6 0 0 1 2.3-2.2L9 13.5"/>`,
  arrowL: `<path d="M19 12H5M10.5 6.5 5 12l5.5 5.5"/>`,
  arrowR: `<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>`,
  trophy: `<path d="M7.5 4.5h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6.5H4.5a3 3 0 0 0 3 4M16.5 6.5h3a3 3 0 0 1-3 4M12 14v3.5M8.5 20h7M9.5 17.5h5"/>`,
  star: `<path d="M12 3.8l2.5 5.2 5.6.7-4.1 3.9 1 5.6L12 16.5l-5 2.7 1-5.6-4.1-3.9 5.6-.7z" fill="currentColor" stroke-width="1.4"/>`,
  // Skins (§7.14): a paintbrush.
  brush: `<path d="M20.2 3.8 12.4 11.6"/><path d="M13.7 13 11 10.3"/><path d="M9.2 12.6c-2.3 0-3.9 1.8-3.9 4 0 1.5-.8 2.5-1.9 2.9 1 .7 2.4 1 3.8 1 2.9 0 4.9-2 4.9-4.6z" fill="currentColor" stroke-width="1.6"/>`,
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, cls = 'ico'): SVGElement {
  const el = svgFrom(`<svg ${A} class="${cls}" ${ST}>${PATHS[name]}</svg>`);
  return el;
}

const MEDAL_FILL: Record<number, [string, string]> = {
  1: ['#C98A52', '#8E5427'],
  2: ['#C9D1DA', '#7D8795'],
  3: ['#F5C83A', '#B7860B'],
};

/** Medal coin (1 bronze, 2 silver, 3 gold). 0 draws an empty dashed ring. */
export function coin(medal: Medal, cls = 'coin'): SVGElement {
  if (medal === 0) {
    return svgFrom(`<svg ${A.replace('0 0 24 24', '0 0 40 40')} class="${cls} coin--empty"><circle cx="20" cy="20" r="16.5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3.2 3.2"/></svg>`);
  }
  const [face, edge] = MEDAL_FILL[medal] ?? MEDAL_FILL[3]!;
  const label = medal === 3 ? '1' : medal === 2 ? '2' : '3';
  return svgFrom(`<svg ${A.replace('0 0 24 24', '0 0 40 40')} class="${cls} coin--${medal}">
    <circle cx="20" cy="21.5" r="17" fill="${edge}"/>
    <circle cx="20" cy="19.5" r="17" fill="${face}" stroke="#1E2A44" stroke-width="2"/>
    <circle cx="20" cy="19.5" r="12.2" fill="none" stroke="${edge}" stroke-width="1.6" stroke-dasharray="1.2 2.1"/>
    <path d="M11 11.5a12 12 0 0 1 9-4" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="2.4" stroke-linecap="round"/>
    <text x="20" y="25.2" text-anchor="middle" font-family="ui-monospace, monospace" font-weight="800" font-size="15" fill="${edge}">${label}</text>
  </svg>`);
}

/** Crown badge (AI beaten). */
export function crownBadge(cls = 'crown'): SVGElement {
  return svgFrom(`<svg ${A.replace('0 0 24 24', '0 0 40 40')} class="${cls}">
    <path d="M6 15l7.5 7L20 10l6.5 12L34 15l-3 15H9z" fill="#B7860B" transform="translate(0 2)"/>
    <path d="M6 15l7.5 7L20 10l6.5 12L34 15l-3 15H9z" fill="#F2B705" stroke="#1E2A44" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="20" cy="9" r="2.6" fill="#E0312B" stroke="#1E2A44" stroke-width="1.6"/>
    <circle cx="6" cy="14" r="2.2" fill="#F2B705" stroke="#1E2A44" stroke-width="1.6"/>
    <circle cx="34" cy="14" r="2.2" fill="#F2B705" stroke="#1E2A44" stroke-width="1.6"/>
    <path d="M10 26.5h20" stroke="#1E2A44" stroke-width="1.6" stroke-linecap="round" opacity=".45"/>
  </svg>`);
}

const GHOST_COLOR: Record<GhostKind, string> = {
  ai: '#19C3FF', calm: '#19C3FF', research_fast: '#19C3FF', research_pump: '#19C3FF', reverse_hint: '#19C3FF',
  pb: '#FFC23D', daily_pb: '#FFC23D', wr: '#FF3FA4', rival: '#FF8A3D', challenge: '#FFFFFF',
};

export function ghostColor(kind: GhostKind): string {
  return GHOST_COLOR[kind];
}

/** Ghost marker shape (§3.5): AI hexagon, PB circle, WR star, rival triangle, challenge flag. Inner SVG markup in a 20x20 box. */
export function ghostShapeMarkup(kind: GhostKind, size = 20): string {
  const c = GHOST_COLOR[kind];
  const k = size / 20;
  const st = `stroke="#1E2A44" stroke-width="${1.6 / k}" stroke-linejoin="round"`;
  let inner: string;
  switch (kind) {
    case 'pb':
    case 'daily_pb':
      inner = `<circle cx="10" cy="10" r="7" fill="${c}" ${st}/>`;
      break;
    case 'wr':
      inner = `<path d="M10 2.2l2.3 4.9 5.3.6-3.9 3.7 1 5.3L10 14.1l-4.7 2.6 1-5.3-3.9-3.7 5.3-.6z" fill="${c}" ${st}/>`;
      break;
    case 'rival':
      inner = `<path d="M10 3l7.5 13h-15z" fill="${c}" ${st}/>`;
      break;
    case 'challenge':
      inner = `<path d="M5 17.5V3M5 3.5h10l-2.5 3.5L15 10.5H5" fill="${c}" ${st}/>`;
      break;
    default:
      inner = `<path d="M6 3.5h8l4 6.5-4 6.5H6l-4-6.5z" fill="${c}" ${st}/>`;
  }
  return `<g transform="scale(${k})">${inner}</g>`;
}

export function ghostShape(kind: GhostKind, cls = 'gshape'): SVGElement {
  return svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true" class="${cls}">${ghostShapeMarkup(kind)}</svg>`);
}

/** Daily-rack ball: ok (yellow), gold (green), crown, fail (cracked red), null (unused). */
export function rackBall(b: 'ok' | 'gold' | 'crown' | 'fail' | null, cls = 'rball'): SVGElement {
  const body = (fill: string, extra = ''): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true" class="${cls} ${cls}--${b ?? 'empty'}">
      <circle cx="20" cy="21.5" r="15" fill="rgba(30,42,68,.18)"/>
      <circle cx="20" cy="20" r="15" fill="${fill}" stroke="#1E2A44" stroke-width="2"/>
      <path d="M11.5 14a10 10 0 0 1 6-4.5" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="2.6" stroke-linecap="round"/>${extra}</svg>`;
  switch (b) {
    case 'ok':
      return svgFrom(body('#F5C83A'));
    case 'gold':
      return svgFrom(body('#22B573'));
    case 'crown':
      return svgFrom(body('#F5C83A', `<path d="M11 24.5l1.6-9 4 4 3.4-6 3.4 6 4-4 1.6 9z" fill="#fff" stroke="#1E2A44" stroke-width="1.6" stroke-linejoin="round"/>`));
    case 'fail':
      return svgFrom(body('#E0312B', `<path d="M19 5.5l-2.5 7 5 3-3.5 6 2.5 5.5" fill="none" stroke="#1E2A44" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><path d="M21.5 15.5l6 1.5" stroke="#1E2A44" stroke-width="1.6" stroke-linecap="round"/>`));
    default:
      return svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true" class="${cls} ${cls}--empty"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3.4 3.4"/></svg>`);
  }
}
