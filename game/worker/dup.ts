// Duplicate-run detection for /api/submit (GAME_DESIGN.md §7.8 step 6, §7.11). Owner: O9.
//
// Replays of the top 100 are public (boot `wr`, /api/ghost, challenge links on X). Without a check, anyone can post a
// public replay again under any number of fresh secrets: every copy verifies, lands next to the original and pushes
// real players out of the top 100 (their replay is then set to NULL for good).
//
// Every top row therefore carries a fingerprint of the run's decoded inputs (the q sequence, not the replay bytes:
// the device byte and the repeat encoding allow many byte strings for one input). A new run is a duplicate of another
// player's row when both have the same length and
//   - the whole q sequence is the same (copies, re-encoded copies), or
//   - at least FP_MIN_MATCHES of the 16 equal tick ranges carry identical, non-constant inputs (copies with a few
//     edited ticks: many single-tick +-1 edits keep the exact time - a third of them on the reviewed 1-1 run - so a
//     whole-run hash alone is not enough; a blind copier needs edits in 5+ ranges that all keep the time).
// Ranges whose q is constant (idle, a held key, full force) are no evidence and never count as a match, so two
// players with the same simple key pattern do not collide just because both waited or pushed for a while.
// Heavily edited, re-simulated variants remain the tool-made-input limit of §7.11.
import type { TopRow } from './db';

export const FP_SEGMENTS = 16;
/** Identical non-constant ranges (of 16) that make a near-duplicate: at most 4 ranges may differ. */
export const FP_MIN_MATCHES = 12;
const WHOLE_HEX = 8;
const SEG_HEX = 3;
/** Fingerprint text: 8 hex digits (32-bit hash of the whole run) + 16 x 3 hex digits (12-bit range hashes, 000 = constant). */
export const FP_LENGTH = WHOLE_HEX + FP_SEGMENTS * SEG_HEX;
const FP_RE = new RegExp(`^[0-9a-f]{${FP_LENGTH}}$`);

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv(h: number, byte: number): number {
  return Math.imul(h ^ (byte & 255), FNV_PRIME) >>> 0;
}

/** Fingerprint of a verified run's inputs (see the header). */
export function runFingerprint(qs: Int8Array): string {
  const n = qs.length;
  let h = fnv(fnv(FNV_OFFSET, n), n >>> 8);
  for (let i = 0; i < n; i++) h = fnv(h, qs[i]!);
  let out = h.toString(16).padStart(WHOLE_HEX, '0');
  for (let k = 0; k < FP_SEGMENTS; k++) {
    const a = Math.floor((k * n) / FP_SEGMENTS);
    const b = Math.floor(((k + 1) * n) / FP_SEGMENTS);
    let constant = true;
    for (let i = a + 1; i < b; i++) {
      if (qs[i] !== qs[a]) {
        constant = false;
        break;
      }
    }
    let v = 0;
    if (!constant) {
      let s = FNV_OFFSET;
      for (let i = a; i < b; i++) s = fnv(s, qs[i]!);
      v = (s ^ (s >>> 12) ^ (s >>> 24)) & 0xfff;
      if (v === 0) v = 1;   // 000 is reserved for constant ranges
    }
    out += v.toString(16).padStart(SEG_HEX, '0');
  }
  return out;
}

export function isFingerprint(v: unknown): v is string {
  return typeof v === 'string' && FP_RE.test(v);
}

/** Replay length of a verified time (§4.6: success on the last tick). */
const ticksOf = (t120: number): number => Math.ceil((t120 + 59) / 2);

/** true when `fp` (a run of `t120`) duplicates the inputs of one of `rows` (other players' rows, see the header). */
export function isDuplicateRun(fp: string, t120: number, rows: readonly TopRow[]): boolean {
  const nTicks = ticksOf(t120);
  const whole = fp.slice(0, WHOLE_HEX);
  for (const r of rows) {
    const o = r[6];
    if (o === undefined || ticksOf(r[2]) !== nTicks) continue;
    if (o.startsWith(whole)) return true;
    let same = 0;
    for (let k = 0; k < FP_SEGMENTS; k++) {
      const p = WHOLE_HEX + k * SEG_HEX;
      const seg = fp.slice(p, p + SEG_HEX);
      if (seg !== '000' && o.startsWith(seg, p)) same++;
    }
    if (same >= FP_MIN_MATCHES) return true;
  }
  return false;
}
