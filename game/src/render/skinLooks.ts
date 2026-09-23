// Skin looks: the colour / material / texture-style data of every cosmetic skin (skins spec §2.3, §5.3). Owner: O5.
//
// Pure data with NO imports, so render, core and tests can all use it (§10.2). The renderer receives one resolved
// SkinLook and knows no unlock rules (those live in src/core/skins.ts).
//
// Hard rules (§1): purely cosmetic. Sizes, hitboxes, the camera, the lights, the ghosts, the goal, danger / amber / ink,
// the tiers, the tether, the lamp, the egg and every CSS token are never part of a look (no keys for them here; the key
// whitelist is tested). The lower flange (rail #6B7280) is fixed for every crane: it is the beam's crash edge.
// DEFAULT_LOOK repeats today's literals (tests/render/palette_sync.test.ts pins each one to its source).

export type Hex = string; // '#RRGGBB'
export type SkinPart = 'ball' | 'crane' | 'trail' | 'stage';
export const SKIN_PARTS: readonly SkinPart[] = ['ball', 'crane', 'trail', 'stage'];

export interface BallMat { roughness: number; metalness: number; clearcoat: number; clearcoatRoughness: number; envMapIntensity: number }
/**
 * Pattern layers, baked as vertex colours on a second sphere mesh (the default ball has none):
 *   speckle: a vertex whose position hash is < cover gets lerp(base, color, 0.55 + 0.45 * hash2);
 *   band:    a vertex with |axis . p| / R < width gets `color` (width is exactly the band's share of the area).
 * Layers are applied in order; local +Y points along the string (towards the hook).
 */
export type BallLayer =
  | { kind: 'speckle'; color: Hex; cover: number; seed: number }
  | { kind: 'band'; color: Hex; width: number; axes: readonly ('x' | 'y' | 'z')[] };
export interface BallLook {
  id: string; body: Hex; outline: Hex;
  /** Ribbon / strobe colour when the trail skin says 'ball' (default: body). */
  trail?: Hex;
  mat: BallMat;
  pattern: readonly BallLayer[] | null;
}
export interface MatScalars { roughness: number; metalness: number; envMapIntensity: number }
export interface CraneLook {
  id: string;
  /** Web, top flange, arms and (default) legs. */
  beam: Hex;
  /** Stiffener ribs and end caps (default leg caps and knee braces too). */
  beamDark: Hex;
  legs?: Hex; legCap?: Hex; brace?: Hex;
  /** Aviation-style bands replacing the plain leg box: a / b alternating, an odd number of bands of about `pitch` m. */
  legBands?: { a: Hex; b: Hex; pitch: number };
  foot: Hex;
  body: Hex; bodyTop: Hex; plate: Hex; tyre: Hex; hub: Hex; steel: Hex;
  /** Trolley front stripe: 'ball' = the equipped ball's body colour (today's look). */
  accent: 'ball' | Hex;
  /** Rail-end bumper stripes (canvas texture). */
  hazard: readonly [Hex, Hex];
  paint: MatScalars; trolleyMat: MatScalars;
}
export interface TrailLook {
  id: string; string: Hex; stringEdge: Hex;
  /** Live motion ribbon: colour and width (x today's 2 * BALL_R * 0.8). Alpha is fixed (.34 * t^2 * fade). */
  ribbon: { color: 'ball' | Hex; width: number };
  /** Success strobe copies. */
  strobe: { color: 'ball' | Hex; shape: 'ring' | 'disc' };
  /** Success confetti: 'auto' = [brick1, brick2, mortar, beam, goal, stamp, brick2] of the current board and crane. */
  confetti: { palette: 'auto' | readonly Hex[]; shape: 'rect' | 'disc' | 'spark' };
}
export interface PaperTex {
  fibre: 'short' | 'kozo' | 'grain' | 'none';
  /** CSS colours of the fibres (dark / light); unused when fibre = 'none'. */
  fibreDark: string; fibreLight: string;
  noiseDark: Hex; noiseLight: Hex;
  /** Graph grid: rgb and the alphas of the 1 m, 0.5 m and 0.1 m lines (0 = not drawn). */
  grid: { rgb: readonly [number, number, number]; alpha: readonly [number, number, number] };
}
export interface StageLook {
  id: string;
  /** Board paper: paper1 at the level centre (also the canvas base, clear colour and ink halo), paper2 at the edges. */
  paper1: Hex; paper2: Hex;
  paperTex: PaperTex;
  floor: Hex;
  floorTex: { noise: Hex; grid: Hex; edge: Hex; /** 10 cm lines (false: only the 1 m joints). */ minor: boolean };
  /** Floor vertex tint (r, g, b multipliers). */
  floorTint: readonly [number, number, number];
  brick1: Hex; brick2: Hex; mortar: Hex;
  brickTex: 'clay' | 'block' | 'stone' | 'print';
  /** Brick row height [m]: 0.06 bricks, 0.1 blocks and stones (the wall box itself never changes). */
  rowH: 0.06 | 0.1;
  /** Blob shadow colour (low quality). */
  blob: Hex;
  /** Crash dust (default mortar), crash sparks (default brick2), floor dust (default floor). */
  dust?: Hex; spark?: Hex; floorDust?: Hex;
}
export interface SkinLook { ball: BallLook; crane: CraneLook; trail: TrailLook; stage: StageLook }

// ---------------------------------------------------------------------------------------------- balls

const BALLS: readonly BallLook[] = [
  {
    id: 'ball.red', body: '#E0312B', outline: '#7A1712',
    mat: { roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.26, envMapIntensity: 0.7 }, pattern: null,
  },
  {
    id: 'ball.steel', body: '#384354', outline: '#141A24',
    mat: { roughness: 0.25, metalness: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 0.9 }, pattern: null,
  },
  {
    id: 'ball.wrecker', body: '#35312E', outline: '#110F0D',
    mat: { roughness: 0.7, metalness: 0.3, clearcoat: 0.05, clearcoatRoughness: 0.5, envMapIntensity: 0.5 },
    pattern: [
      { kind: 'speckle', color: '#7A4A32', cover: 0.14, seed: 21 },
      { kind: 'speckle', color: '#25221F', cover: 0.1, seed: 22 },
    ],
  },
  {
    id: 'ball.point', body: '#22242A', outline: '#0B0C0E',
    mat: { roughness: 0.9, metalness: 0, clearcoat: 0.02, clearcoatRoughness: 0.6, envMapIntensity: 0.25 }, pattern: null,
  },
  {
    id: 'ball.moss', body: '#556B2F', outline: '#1F2A10', trail: '#3A4A22',
    mat: { roughness: 0.95, metalness: 0, clearcoat: 0.02, clearcoatRoughness: 0.6, envMapIntensity: 0.2 },
    pattern: [
      // .26 (not .30): the body colour keeps >= 60 % of the surface (area-weighted on the real sphere, §5.3).
      { kind: 'speckle', color: '#3E5222', cover: 0.26, seed: 31 },
      { kind: 'speckle', color: '#6B5A3A', cover: 0.12, seed: 32 },
      { kind: 'band', color: '#8E7447', width: 0.02, axes: ['x', 'z'] },
    ],
  },
  {
    id: 'ball.kinobi', body: '#2A2B30', outline: '#0B0C0E',
    mat: { roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.8 },
    pattern: [{ kind: 'band', color: '#A8842A', width: 0.18, axes: ['y'] }],
  },
  {
    id: 'ball.lapis', body: '#23408A', outline: '#0C1A3D', trail: '#2A2D35',
    mat: { roughness: 0.18, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.9 },
    pattern: [
      { kind: 'speckle', color: '#C9A13A', cover: 0.05, seed: 41 },
      { kind: 'speckle', color: '#8C9BBF', cover: 0.04, seed: 42 },
    ],
  },
];

// ---------------------------------------------------------------------------------------------- cranes

const TROLLEY_TODAY = { roughness: 0.38, metalness: 0.25, envMapIntensity: 0.8 } as const;
const CRANES: readonly CraneLook[] = [
  {
    id: 'crane.yellow', beam: '#F2B705', beamDark: '#D99F00', foot: '#4B5563',
    body: '#33405C', bodyTop: '#46557A', plate: '#26314A', tyre: '#1B1F27', hub: '#B8C0CA', steel: '#9AA3AE', accent: 'ball',
    hazard: ['#F2B705', '#1E1E1E'],
    paint: { roughness: 0.42, metalness: 0.08, envMapIntensity: 0.55 }, trolleyMat: TROLLEY_TODAY,
  },
  {
    id: 'crane.wood', beam: '#B08A5A', beamDark: '#8E6B42', legs: '#9A7A52', legCap: '#8E6B42', brace: '#8E6B42', foot: '#3A3F46',
    body: '#2B303B', bodyTop: '#3A404D', plate: '#23272F', tyre: '#1B1F27', hub: '#B8C0CA', steel: '#9AA3AE', accent: 'ball',
    hazard: ['#F2B705', '#1E1E1E'],
    paint: { roughness: 0.8, metalness: 0, envMapIntensity: 0.3 }, trolleyMat: TROLLEY_TODAY,
  },
  {
    id: 'crane.primer', beam: '#8A3B2B', beamDark: '#6E2F24', legCap: '#D8342B', brace: '#6E2F24',
    legBands: { a: '#D8342B', b: '#F4F2EC', pitch: 0.25 }, foot: '#3A3F46',
    body: '#2B303B', bodyTop: '#3A404D', plate: '#23272F', tyre: '#1B1F27', hub: '#B8C0CA', steel: '#9AA3AE', accent: '#F2B705',
    hazard: ['#D8342B', '#FFFFFF'],
    paint: { roughness: 0.6, metalness: 0.05, envMapIntensity: 0.4 }, trolleyMat: TROLLEY_TODAY,
  },
  {
    id: 'crane.lineart', beam: '#767B84', beamDark: '#1E2A44', legs: '#767B84', legCap: '#1E2A44', brace: '#1E2A44', foot: '#3A3F46',
    body: '#1E232B', bodyTop: '#2C323C', plate: '#171B21', tyre: '#1B1F27', hub: '#E2E2DE', steel: '#9AA3AE', accent: '#F4F4F0',
    hazard: ['#F4F4F0', '#1E1E1E'],
    paint: { roughness: 0.9, metalness: 0, envMapIntensity: 0.2 }, trolleyMat: { roughness: 0.8, metalness: 0, envMapIntensity: 0.2 },
  },
  {
    id: 'crane.tancho', beam: '#5A2A22', beamDark: '#3A1C17', legs: '#1F1A19', legCap: '#D8342B', brace: '#F1F0EB', foot: '#3A3B40',
    body: '#1C1D21', bodyTop: '#2A2C31', plate: '#131417', tyre: '#1B1F27', hub: '#D9D9D4', steel: '#9AA3AE', accent: '#D8342B',
    hazard: ['#D8342B', '#FFFFFF'],
    paint: { roughness: 0.3, metalness: 0.05, envMapIntensity: 0.7 }, trolleyMat: { roughness: 0.35, metalness: 0.2, envMapIntensity: 0.8 },
  },
];

// ---------------------------------------------------------------------------------------------- string, trail, effects

const TRAILS: readonly TrailLook[] = [
  {
    id: 'trail.ink', string: '#2B2B2B', stringEdge: '#2B2B2B',
    ribbon: { color: 'ball', width: 1 }, strobe: { color: 'ball', shape: 'ring' }, confetti: { palette: 'auto', shape: 'rect' },
  },
  {
    id: 'trail.pencil', string: '#323438', stringEdge: '#323438',
    ribbon: { color: '#55585E', width: 0.55 }, strobe: { color: '#55585E', shape: 'disc' },
    confetti: { palette: ['#E2CFC6', '#D3BBB0', '#C8A27A', '#55585E', '#EBDDD6'], shape: 'disc' },
  },
  {
    id: 'trail.wire', string: '#2E3642', stringEdge: '#1E232B',
    ribbon: { color: 'ball', width: 1 }, strobe: { color: 'ball', shape: 'ring' },
    confetti: { palette: ['#FFF4C2', '#FFB347', '#FF8A1E', '#F2B705'], shape: 'spark' },
  },
  {
    id: 'trail.proof', string: '#1E2A44', stringEdge: '#1E2A44',
    ribbon: { color: '#1E2A44', width: 0.6 }, strobe: { color: '#1E2A44', shape: 'ring' },
    confetti: { palette: ['#1E2A44', '#1E2A44', '#1E2A44', '#D8342B'], shape: 'rect' },
  },
  {
    id: 'trail.kumihimo', string: '#58141F', stringEdge: '#3A0C14',
    ribbon: { color: 'ball', width: 1 }, strobe: { color: 'ball', shape: 'disc' },
    confetti: { palette: ['#D4AF37', '#E9C85B', '#F6E7B0', '#D8342B', '#FFFFFF'], shape: 'rect' },
  },
];

// ---------------------------------------------------------------------------------------------- board and walls

const STAGES: readonly StageLook[] = [
  {
    id: 'stage.note', paper1: '#F3EEE4', paper2: '#E6DCCB',
    paperTex: {
      fibre: 'short', fibreDark: 'rgba(150,130,100,0.10)', fibreLight: 'rgba(255,255,255,0.5)', noiseDark: '#A89878', noiseLight: '#FFFFFF',
      grid: { rgb: [150, 170, 200], alpha: [0.42, 0.3, 0.2] },
    },
    floor: '#D9D4CB', floorTex: { noise: '#8D8577', grid: '#C9C2B6', edge: '#B3AA9B', minor: true }, floorTint: [1, 0.975, 0.93],
    brick1: '#B5553A', brick2: '#C8643F', mortar: '#E8DCC8', brickTex: 'clay', rowH: 0.06, blob: '#3A2A20',
  },
  {
    id: 'stage.diazo', paper1: '#F1F1EC', paper2: '#E2E3DE',
    paperTex: {
      fibre: 'short', fibreDark: 'rgba(120,130,150,0.10)', fibreLight: 'rgba(255,255,255,0.5)', noiseDark: '#8E96A8', noiseLight: '#FFFFFF',
      grid: { rgb: [60, 90, 170], alpha: [0.2, 0.14, 0.09] },
    },
    floor: '#D5D7D4', floorTex: { noise: '#858A94', grid: '#C3C7CC', edge: '#A9AEB6', minor: true }, floorTint: [1, 0.99, 0.98],
    brick1: '#7A7FB0', brick2: '#878CBC', mortar: '#DCE0E4', brickTex: 'block', rowH: 0.1, blob: '#1E2433',
  },
  {
    id: 'stage.site', paper1: '#F3EBDD', paper2: '#E8DCC6',
    paperTex: {
      fibre: 'grain', fibreDark: 'rgba(150,110,60,0.08)', fibreLight: 'rgba(255,255,255,0.3)', noiseDark: '#A08B6B', noiseLight: '#FFFFFF',
      grid: { rgb: [138, 106, 58], alpha: [0.34, 0.24, 0] },
    },
    floor: '#CFCCC6', floorTex: { noise: '#8A8780', grid: '#BDB9B1', edge: '#A8A49C', minor: false }, floorTint: [1, 1, 0.98],
    brick1: '#7E7C78', brick2: '#8E8B86', mortar: '#D2CEC6', brickTex: 'block', rowH: 0.1, blob: '#2E2A26',
  },
  {
    id: 'stage.textbook', paper1: '#F8F7F3', paper2: '#ECEBE6',
    paperTex: {
      fibre: 'none', fibreDark: 'rgba(0,0,0,0)', fibreLight: 'rgba(0,0,0,0)', noiseDark: '#B0B0AC', noiseLight: '#FFFFFF',
      grid: { rgb: [154, 156, 163], alpha: [0.42, 0.3, 0.2] },
    },
    floor: '#D8D6D1', floorTex: { noise: '#8C8A86', grid: '#C6C4BF', edge: '#ABA9A4', minor: true }, floorTint: [1, 1, 1],
    brick1: '#83868C', brick2: '#91949A', mortar: '#3A3F4A', brickTex: 'print', rowH: 0.06, blob: '#2A2C30', dust: '#9A9CA3',
  },
  {
    id: 'stage.castle', paper1: '#F4EFE5', paper2: '#E7E0CF',
    paperTex: {
      // Long kozo fibres; their alpha stays at today's .10 (§2.3: paper details never exceed today's alphas).
      fibre: 'kozo', fibreDark: 'rgba(150,130,100,0.10)', fibreLight: 'rgba(255,255,255,0.5)', noiseDark: '#A89878', noiseLight: '#FFFFFF',
      grid: { rgb: [160, 140, 110], alpha: [0.33, 0.24, 0.16] },
    },
    floor: '#DAD5C9', floorTex: { noise: '#9A9384', grid: '#C8C2B5', edge: '#B2AB9C', minor: true }, floorTint: [1, 0.985, 0.95],
    brick1: '#7A7478', brick2: '#89838A', mortar: '#CFC9BE', brickTex: 'stone', rowH: 0.1, blob: '#2E2A26',
  },
];

const byId = <T extends { id: string }>(xs: readonly T[]): Readonly<Record<string, T>> => {
  const o: Record<string, T> = {};
  for (const x of xs) o[x.id] = x;
  return o;
};

/** Every part look by id. The first entry of each part is its default. */
export const LOOKS: {
  readonly ball: Readonly<Record<string, BallLook>>; readonly crane: Readonly<Record<string, CraneLook>>;
  readonly trail: Readonly<Record<string, TrailLook>>; readonly stage: Readonly<Record<string, StageLook>>;
} = { ball: byId(BALLS), crane: byId(CRANES), trail: byId(TRAILS), stage: byId(STAGES) };

/** Today's look (every part's default). */
export const DEFAULT_LOOK: SkinLook = { ball: BALLS[0]!, crane: CRANES[0]!, trail: TRAILS[0]!, stage: STAGES[0]! };

export type PartLook<P extends SkinPart> = SkinLook[P];

/** The look of a part by id; an unknown id gives that part's default. */
export function partLook<P extends SkinPart>(part: P, id: string | undefined): SkinLook[P] {
  const table = LOOKS[part] as Readonly<Record<string, SkinLook[P]>>;
  const hit = typeof id === 'string' && Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
  return hit ?? DEFAULT_LOOK[part];
}

// ---------------------------------------------------------------------------------------------- derived values

/** Resolved colour of a 'ball' reference: the ball's trail colour (else body); '#E0312B' on egg levels (§1.4). */
export function ballTrailColour(ball: BallLook, egg: boolean): Hex {
  return egg ? '#E0312B' : ball.trail ?? ball.body;
}

/** The trolley accent stripe of a crane look with a ball look. */
export function craneAccent(crane: CraneLook, ball: BallLook): Hex {
  return crane.accent === 'ball' ? ball.body : crane.accent;
}

/** Confetti palette of a look: 'auto' = [brick1, brick2, mortar, beam, goal, stamp, brick2] (today's order). */
export function confettiPalette(look: SkinLook): readonly Hex[] {
  const p = look.trail.confetti.palette;
  if (p !== 'auto') return p;
  const s = look.stage;
  return [s.brick1, s.brick2, s.mortar, look.crane.beam, '#22B573', '#D8342B', s.brick2];
}

// ---------------------------------------------------------------------------------------------- ball patterns

/** Integer hash of a rounded position and a seed -> [0, 1). */
function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Which pattern layer colours the vertex at (x, y, z) on a sphere of radius R (local +Y along the string), and how
 * much: returns [layer index or -1 for the body colour, lerp amount from the body towards the layer colour].
 * The position is rounded to 0.1 mm before hashing, so seam and pole duplicates get the same colour.
 */
export function patternAt(pattern: readonly BallLayer[], x: number, y: number, z: number, R: number): [number, number] {
  const ix = Math.round(x * 1e4), iy = Math.round(y * 1e4), iz = Math.round(z * 1e4);
  let layer = -1, t = 0;
  pattern.forEach((l, i) => {
    if (l.kind === 'speckle') {
      if (hash4(ix, iy, iz, l.seed) < l.cover) {
        layer = i;
        t = 0.55 + 0.45 * hash4(iz, ix, iy, l.seed * 7919 + 1);
      }
    } else {
      for (const ax of l.axes) {
        const v = ax === 'x' ? x : ax === 'y' ? y : z;
        if (Math.abs(v) / R < l.width) {
          layer = i;
          t = 1;
        }
      }
    }
  });
  return [layer, t];
}
