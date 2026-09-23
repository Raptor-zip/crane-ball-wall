// Skin thumbnails for the skins screen (GAME_DESIGN.md §7.14): small inline SVG drawings in the notes-figure style
// (flat colours, ink outlines), one per part, drawn from the same look data the renderer uses. Owner: O7.
// A thumbnail shows its own part; the other parts (the ball on a crane card, the paper behind a ball) follow what is
// equipped, so a 'ball' ribbon or an 'auto' confetti palette looks the way it will in the game.
import type { BallLook, CraneLook, SkinLook, SkinPart, StageLook, TrailLook } from '../render/skinLooks';
import { svgFrom } from './dom';

const INK = '#1E2A44';
const RAIL = '#6B7280';
const GOAL = '#22B573';
const STAMP = '#D8342B';

/** The equipped looks a thumbnail borrows its surroundings from. */
export type ThumbContext = Pick<SkinLook, 'ball' | 'crane' | 'trail' | 'stage'>;

let uid = 0;

/** Deterministic 0..1 sequence (thumbnails never flicker between renders). */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const f = (n: number): string => (Math.round(n * 10) / 10).toString();

/** Paper with the equipped board's grid: the background of the ball, crane and trail cards. */
function paper(st: StageLook, lines = true): string {
  const [r, g, b] = st.paperTex.grid.rgb;
  const [a1, a2] = st.paperTex.grid.alpha;
  let out = `<rect width="64" height="64" fill="${st.paper1}"/>`;
  if (lines) {
    for (let k = 8; k < 64; k += 8) {
      const a = k % 32 === 0 ? a1 : a2 * 0.8;
      if (a <= 0) continue;
      out += `<path d="M${k} 0V64M0 ${k}H64" stroke="rgb(${r},${g},${b})" stroke-opacity="${f(a * 0.9)}" stroke-width="${k % 32 === 0 ? 0.9 : 0.6}"/>`;
    }
  }
  return out;
}

function ballSvg(ball: BallLook, cx: number, cy: number, R: number, id: string): string {
  let out = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${ball.body}"/>`;
  if (ball.pattern) {
    out += `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath><g clip-path="url(#${id})">`;
    ball.pattern.forEach((l, i) => {
      if (l.kind === 'speckle') {
        const rnd = rng(l.seed + i * 97);
        const n = Math.max(3, Math.round(l.cover * R * R * 0.42));
        for (let k = 0; k < n; k++) {
          const a = rnd() * Math.PI * 2;
          const d = Math.sqrt(rnd()) * R * 0.95;
          out += `<circle cx="${f(cx + Math.cos(a) * d)}" cy="${f(cy + Math.sin(a) * d)}" r="${f(R * (0.06 + rnd() * 0.05))}" fill="${l.color}" fill-opacity="${f(0.55 + 0.45 * rnd())}"/>`;
        }
      } else {
        for (const ax of l.axes) {
          const hw = Math.max(0.9, l.width * R);
          if (ax === 'y') out += `<rect x="${cx - R}" y="${f(cy - hw)}" width="${R * 2}" height="${f(hw * 2)}" fill="${l.color}"/>`;
          else if (ax === 'x') out += `<ellipse cx="${cx}" cy="${cy}" rx="${f(R * 0.32)}" ry="${R}" fill="none" stroke="${l.color}" stroke-width="${f(hw * 1.6)}"/>`;
          else out += `<ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="${f(R * 0.32)}" fill="none" stroke="${l.color}" stroke-width="${f(hw * 1.6)}"/>`;
        }
      }
    });
    out += '</g>';
  }
  // Outline (the ball's dark rim) and the white highlight arc of the 2D figures.
  out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${ball.outline}" stroke-width="${f(Math.max(1.4, R * 0.11))}"/>`;
  out += `<path d="M${f(cx - R * 0.58)} ${f(cy - R * 0.2)}a${f(R * 0.62)} ${f(R * 0.62)} 0 0 1 ${f(R * 0.46)} ${f(-R * 0.42)}" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="${f(Math.max(1.4, R * 0.15))}" stroke-linecap="round"/>`;
  return out;
}

function drawBall(ball: BallLook, c: ThumbContext): string {
  const id = `skt${++uid}`;
  return `${paper(c.stage)}<path d="M32 0V17" stroke="${c.trail.stringEdge}" stroke-width="2.4"/><path d="M32 0V17" stroke="${c.trail.string}" stroke-width="1.6"/>${ballSvg(ball, 32, 36, 18, id)}`;
}

/** Hazard stripes of an end stop inside (x, y, w, h). */
function hazard(x: number, y: number, w: number, h: number, a: string, b: string, id: string): string {
  let s = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${a}"/><g clip-path="url(#${id})">`;
  for (let k = -h; k < w + h; k += 5) s += `<path d="M${x + k} ${y + h}l${h} ${-h}h2.5l${-h} ${h}z" fill="${b}"/>`;
  return `${s}</g><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${INK}" stroke-width="1"/>`;
}

function drawCrane(cr: CraneLook, c: ThumbContext): string {
  const id = `skt${++uid}`;
  const legs = cr.legs ?? cr.beam;
  const cap = cr.legCap ?? cr.beamDark;
  const brace = cr.brace ?? cr.beamDark;
  const accent = cr.accent === 'ball' ? c.ball.body : cr.accent;
  let out = paper(c.stage);
  // Leg (behind the beam), with the primer's red / white bands, the cap and the brace.
  out += `<rect x="6" y="22" width="6" height="36" fill="${legs}" stroke="${INK}" stroke-width="1"/>`;
  if (cr.legBands) {
    for (let y = 22, k = 0; y < 58; y += 5, k++) out += `<rect x="6.5" y="${y}" width="5" height="${Math.min(5, 58 - y)}" fill="${k % 2 ? cr.legBands.b : cr.legBands.a}"/>`;
    out += `<rect x="6" y="22" width="6" height="36" fill="none" stroke="${INK}" stroke-width="1"/>`;
  }
  out += `<path d="M11.5 36 22 22" stroke="${INK}" stroke-width="3.4" stroke-linecap="round"/><path d="M11.5 36 22 22" stroke="${brace}" stroke-width="2" stroke-linecap="round"/>`;
  out += `<rect x="3.5" y="57" width="11" height="3.5" rx="1" fill="${cr.foot}" stroke="${INK}" stroke-width="1"/>`;
  // Beam: top flange and web in the beam colour, dark ribs and caps, the grey lower flange (never skinned).
  out += `<rect x="2" y="10" width="60" height="10" fill="${cr.beam}"/>`;
  for (let x = 12; x < 56; x += 11) out += `<path d="M${x} 12.5V19" stroke="${cr.beamDark}" stroke-width="1.6"/>`;
  out += `<rect x="2" y="10" width="60" height="2.5" fill="${cr.beam}"/><rect x="2" y="10" width="2.5" height="10" fill="${cr.beamDark}"/>`;
  out += `<rect x="2" y="19.5" width="60" height="3" fill="${RAIL}"/>`;
  out += `<rect x="2" y="10" width="60" height="12.5" fill="none" stroke="${INK}" stroke-width="1.2"/>`;
  out += `<rect x="3" y="22.5" width="9" height="2.5" fill="${cap}" stroke="${INK}" stroke-width="0.8"/>`;
  out += hazard(55, 12, 7, 8, cr.hazard[0], cr.hazard[1], id);
  // Trolley under the beam: wheels, body, top, the accent stripe; the hook, the string and the equipped ball.
  out += `<circle cx="29" cy="24" r="2.6" fill="${cr.tyre}"/><circle cx="41" cy="24" r="2.6" fill="${cr.tyre}"/><circle cx="29" cy="24" r="1" fill="${cr.hub}"/><circle cx="41" cy="24" r="1" fill="${cr.hub}"/>`;
  out += `<rect x="25" y="25" width="20" height="8" rx="1.5" fill="${cr.body}" stroke="${INK}" stroke-width="1"/><rect x="25.5" y="25.5" width="19" height="2.4" fill="${cr.bodyTop}"/>`;
  out += `<rect x="25.5" y="29.4" width="19" height="1.6" fill="${accent}"/><rect x="31" y="33" width="8" height="1.8" fill="${cr.plate}"/>`;
  out += `<path d="M35 34.8V50" stroke="${c.trail.string}" stroke-width="1.5"/>`;
  out += ballSvg(c.ball, 35, 54, 5.5, `${id}b`);
  return out;
}

function sparkPath(x: number, y: number, s: number): string {
  return `M${f(x)} ${f(y - s)}L${f(x + s * 0.28)} ${f(y - s * 0.28)}L${f(x + s)} ${f(y)}L${f(x + s * 0.28)} ${f(y + s * 0.28)}L${f(x)} ${f(y + s)}L${f(x - s * 0.28)} ${f(y + s * 0.28)}L${f(x - s)} ${f(y)}L${f(x - s * 0.28)} ${f(y - s * 0.28)}Z`;
}

function drawTrail(tr: TrailLook, c: ThumbContext): string {
  const ballCol = c.ball.trail ?? c.ball.body;
  const ribbon = tr.ribbon.color === 'ball' ? ballCol : tr.ribbon.color;
  const strobe = tr.strobe.color === 'ball' ? ballCol : tr.strobe.color;
  const pal = tr.confetti.palette === 'auto'
    ? [c.stage.brick1, c.stage.brick2, c.stage.mortar, c.crane.beam, GOAL, STAMP, c.stage.brick2]
    : tr.confetti.palette;
  let out = paper(c.stage);
  // The swing: the ribbon at the game's alpha (.34), strobe copies every "0.1 s" along it.
  out += `<path d="M5 30Q30 74 56 30" fill="none" stroke="${ribbon}" stroke-opacity=".34" stroke-width="${f(8 * tr.ribbon.width)}" stroke-linecap="round"/>`;
  for (const [x, y] of [[10, 38.5], [19.5, 46.5], [30.5, 50.5], [42, 46]] as const) {
    out += tr.strobe.shape === 'ring'
      ? `<circle cx="${x}" cy="${y}" r="4" fill="none" stroke="${strobe}" stroke-opacity=".8" stroke-width="1.4"/>`
      : `<circle cx="${x}" cy="${y}" r="4" fill="${strobe}" fill-opacity=".5"/>`;
  }
  // Confetti over the goal side: rects, eraser-crumb discs or ember stars in the palette.
  const bits: [number, number, number][] = [[8, 9, 20], [18, 16, -30], [27, 6, 45], [36, 14, 10], [13, 24, -60], [24, 25, 70], [43, 6, -15]];
  bits.forEach(([x, y, rot], i) => {
    const col = pal[i % pal.length]!;
    if (tr.confetti.shape === 'disc') out += `<circle cx="${x}" cy="${y}" r="2.1" fill="${col}" stroke="${INK}" stroke-opacity=".25" stroke-width=".5"/>`;
    else if (tr.confetti.shape === 'spark') out += `<path d="${sparkPath(x, y, 3.8)}" fill="${col}"/>`;
    else out += `<rect x="${x - 2.4}" y="${y - 1.3}" width="4.8" height="2.6" fill="${col}" transform="rotate(${rot} ${x} ${y})"/>`;
  });
  // The string (with its darker edge) from the trolley to the ball.
  out += `<rect x="46" y="0" width="14" height="4" rx="1" fill="${c.crane.body}"/>`;
  out += `<path d="M53 4 56 25" stroke="${tr.stringEdge}" stroke-width="2.8" stroke-linecap="round"/><path d="M53 4 56 25" stroke="${tr.string}" stroke-width="1.6" stroke-linecap="round"/>`;
  out += ballSvg(c.ball, 56, 30, 5.5, `skt${++uid}`);
  return out;
}

/** One wall of bricks in (x0..x1) from y0 down to the floor at y1, in the stage's row height and texture style. */
function wall(st: StageLook, x0: number, x1: number, y0: number, y1: number, seed: number): string {
  const rh = st.rowH >= 0.09 ? 6.4 : 3.9;
  const rnd = rng(seed);
  const w = x1 - x0;
  let out = `<rect x="${x0}" y="${y0}" width="${w}" height="${y1 - y0}" fill="${st.mortar}"/>`;
  let row = 0;
  for (let y = y1; y > y0 + 0.1; y -= rh, row++) {
    const top = Math.max(y0 + 0.9, y - rh + 0.7);
    const bw = st.brickTex === 'clay' || st.brickTex === 'print' ? w / 2 : w / 1.5;
    for (let x = x0 - (row % 2 ? bw / 2 : 0); x < x1; x += bw) {
      const a = Math.max(x0, x + 0.4);
      const b = Math.min(x1, x + bw - 0.4);
      if (b - a < 0.8) continue;
      const col = rnd() < 0.5 ? st.brick1 : st.brick2;
      const rx = st.brickTex === 'stone' ? 1.6 : st.brickTex === 'block' ? 0.3 : 0.5;
      const ink = st.brickTex === 'print' ? ` stroke="rgba(38,42,52,0.9)" stroke-width="0.6"` : '';
      out += `<rect x="${f(a)}" y="${f(top)}" width="${f(b - a)}" height="${f(y - 0.35 - top)}" rx="${rx}" fill="${col}"${ink}/>`;
      if (st.brickTex === 'stone') out += `<path d="M${f(a + 1)} ${f(top + 1)}h${f(Math.max(0, b - a - 2))}" stroke="#fff" stroke-opacity=".3" stroke-width=".8"/>`;
      else if (st.brickTex === 'block') out += `<path d="M${f(a)} ${f(top + 0.4)}h${f(b - a)}" stroke="#fff" stroke-opacity=".28" stroke-width=".6"/>`;
    }
  }
  // The wall's top face (mortar) and its outline.
  return `${out}<rect x="${x0}" y="${y0 - 1}" width="${w}" height="1.6" fill="${st.mortar}"/><rect x="${x0}" y="${y0 - 1}" width="${w}" height="${y1 - y0 + 1}" fill="none" stroke="${INK}" stroke-opacity=".55" stroke-width=".8"/>`;
}

function drawStage(st: StageLook, c: ThumbContext): string {
  const gid = `skt${++uid}`;
  let out = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${st.paper1}"/><stop offset="1" stop-color="${st.paper2}"/></linearGradient>`;
  out += `<rect width="64" height="64" fill="url(#${gid})"/>`;
  const [r, g, b] = st.paperTex.grid.rgb;
  const [a1, a2, a3] = st.paperTex.grid.alpha;
  for (let k = 4; k < 50; k += 4) {
    const a = k % 16 === 0 ? a1 : k % 8 === 0 ? a2 : a3;
    if (a > 0) out += `<path d="M${k} 0V49M0 ${k}H64" stroke="rgb(${r},${g},${b})" stroke-opacity="${f(Math.min(1, a * 1.1))}" stroke-width="${k % 16 === 0 ? 0.9 : 0.55}"/>`;
  }
  // Floor with its front edge and grid lines.
  out += `<rect x="0" y="49" width="64" height="15" fill="${st.floor}"/><path d="M0 49.5H64" stroke="${st.floorTex.edge}" stroke-width="1.2"/>`;
  for (let x = 6; x < 64; x += st.floorTex.minor ? 10 : 20) out += `<path d="M${x} 50 ${x - 3} 64" stroke="${st.floorTex.grid}" stroke-width=".8"/>`;
  out += wall(st, 13, 24, 31, 49.5, 11) + wall(st, 40, 51, 19, 49.5, 23);
  // A soft blob shadow under a hanging ball (the stage's blob colour) and the goal pad between the walls.
  out += `<ellipse cx="32" cy="53" rx="5" ry="1.4" fill="${st.blob}" fill-opacity=".25"/><rect x="26" y="48.2" width="12" height="1.6" rx=".8" fill="${GOAL}" fill-opacity=".55"/>`;
  out += `<path d="M32 0V36" stroke="${c.trail.string}" stroke-width="1.3"/>`;
  out += ballSvg(c.ball, 32, 40, 4.6, `${gid}b`);
  return out;
}

/** The thumbnail of one catalog entry: `look` is its own part's look, `c` the equipped looks around it. */
export function skinThumb(part: SkinPart, look: SkinLook[SkinPart], c: ThumbContext): SVGElement {
  let body: string;
  switch (part) {
    case 'ball':
      body = drawBall(look as BallLook, c);
      break;
    case 'crane':
      body = drawCrane(look as CraneLook, c);
      break;
    case 'trail':
      body = drawTrail(look as TrailLook, c);
      break;
    default:
      body = drawStage(look as StageLook, c);
  }
  return svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" class="skin-svg" aria-hidden="true" focusable="false">${body}</svg>`);
}
