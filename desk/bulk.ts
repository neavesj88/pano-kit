/* Bulk work on a trip's 360s: a look preset on every photo, dark ones brought up to a
 * normal level, then edited copies saved. Pure; the page runs it photo by photo. */
import { DEFAULT_GRADE, GRADE_KEYS, applyGrade, normaliseGrade, type Grade } from "../src/grade.ts";
import { parseFolder } from "../src/core.ts";

/** Inside a folder named by date (04_10_2026_paris), as neaves.au groups them: the scanned
 *  folder itself, or the first folder below it. Sorting and not-trip folders beside the trip
 *  folders are left out, whatever is inside them. Either slash. */
export function inDatedFolder(file: string, root: string): boolean {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (parseFolder(trimmed.split(/[\\/]/).pop() ?? "").date) return true;
  const rel = file.slice(trimmed.length).replace(/^[\\/]+/, "").split(/[\\/]/);
  return rel.length > 1 && !!parseFolder(rel[0]).date;
}

/** One unit of brightening, first tuned on a dark 360 (Colosseum interior, 8 Oct 2026):
 *  exposure and a lifted lower curve, highlights held. Colour comes from the look. Dark shots
 *  get as many units as they need, up to LIFT_MAX. */
export const DARK_LIFT: Grade = { ...DEFAULT_GRADE, exposure: 0.4, contrast: -10, blacks: 15, shadows: 60, darks: 45, highlights: -20 };
export const DEFAULT_DARK_THRESHOLD = 0.2;
/** Where a dark shot is brought to: the middle band's median, the low end of a normal shot
 *  (most of the trip sits at 0.3 and up) in daylight, less at night or in a dim room, where a
 *  bigger lift greys the black sky and the shadows. Just under the threshold the aim eases down
 *  to the photo's own level, so a 0.19 shot is not jumped past a 0.21 one. */
export const LIFT_TARGET = 0.28;
export const LIFT_TARGET_DIM = 0.12;
const LIFT_EASE = 0.05;
/** Most units of DARK_LIFT a photo gets: three in daylight (beyond that the sky flattens),
 *  half a unit at night or in a dim room. At one and a half, the pre-dawn Menin Gate and a car
 *  interior came out washed out: night is meant to look dark (Jared, 17 Oct 2026). */
export const LIFT_MAX = 3;
export const LIFT_MAX_DIM = 0.5;
/** Share of the frame above mid-grey (sky and walls, not the ground) at or below which a shot
 *  is night or a dim room, and at or above which it is daylight. Measured on the trip's 86
 *  darkest shots: night ones 0.02 to 0.10, daylight ones mostly 0.2 and up. */
export const DIM_SHARE = 0.1;
export const DAY_SHARE = 0.2;
/** The most of the frame a lift may newly clip (any channel at 252 or more), over what the look
 *  alone clips. A backlit shot (Hill 60's crater, sun in frame) blew 8% of its sky at one unit;
 *  it is held back to keep the sky instead. Pulling highlights down harder to make room was tried
 *  and turned blue skies lavender. */
export const CLIP_ALLOW = 0.01;

/** a plus k times b, slider by slider, kept in range. */
export function addGrades(a: Grade, b: Grade, k = 1): Grade {
  const out = { ...a };
  for (const key of GRADE_KEYS) out[key] = Math.round((a[key] + k * b[key]) * 100) / 100;
  return normaliseGrade(out);
}

/** Median brightness (0 to 1) of rows y0 to y1 of an equirect's RGBA pixels. */
export function bandMedian(px: Uint8ClampedArray | Uint8Array, w: number, y0: number, y1: number): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      hist[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++;
      n++;
    }
  }
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen * 2 >= n) return v / 255;
  }
  return 1;
}

/** The middle half of the rows: the sky above and the ground (tripod, hand) below should not
 *  decide whether a shot is dark. */
export const horizonMedian = (px: Uint8ClampedArray | Uint8Array, w: number, h: number) =>
  bandMedian(px, w, Math.floor(h / 4), Math.floor((3 * h) / 4));
/** Share (0 to 1) of the top three quarters of the rows above mid-grey. */
export function brightShare(px: Uint8ClampedArray | Uint8Array, w: number, h: number): number {
  const rows = Math.floor((3 * h) / 4);
  let n = 0;
  for (let i = 0; i < rows * w * 4; i += 4) if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] > 127.5) n++;
  return rows ? n / (rows * w) : 0;
}

/** Share (0 to 1) of the top three quarters of the rows with a channel clipped. */
export function clippedShare(px: Uint8ClampedArray | Uint8Array, w: number, h: number): number {
  const rows = Math.floor((3 * h) / 4);
  let n = 0;
  for (let i = 0; i < rows * w * 4; i += 4) if (px[i] >= 252 || px[i + 1] >= 252 || px[i + 2] >= 252) n++;
  return rows ? n / (rows * w) : 0;
}

/** How much of a daylight shot this is, 0 (night, dim room) to 1, from its bright share. */
export function daylight(share: number): number {
  return Math.min(1, Math.max(0, (share - DIM_SHARE) / (DAY_SHARE - DIM_SHARE)));
}

/** The brightness a shot measured at `median` is lifted to, or null when it is not dark. */
export function liftTarget(median: number, threshold = DEFAULT_DARK_THRESHOLD, day = 1): number | null {
  if (!Number.isFinite(median) || median >= threshold) return null;
  const aim = LIFT_TARGET_DIM + day * (LIFT_TARGET - LIFT_TARGET_DIM);
  const ease = Math.min(1, (threshold - median) / LIFT_EASE);
  return median + ease * (Math.max(aim, median) - median);
}

/** Most units of lift for a shot `day` (0 to 1) daylight. */
export const liftMax = (day: number) => LIFT_MAX_DIM + day * (LIFT_MAX - LIFT_MAX_DIM);

export interface BulkGrade {
  grade: Grade; lift: number; median: number | null; after: number | null; bright: number | null;
  /** True when the lift stopped short of the target so as not to clip the sky. */
  held: boolean;
}

/** The grade bulk gives a photo: the look (or nothing), plus as many units of DARK_LIFT as
 *  bring its middle band to the target without clipping more than CLIP_ALLOW of the frame,
 *  found on a small copy (px, RGBA, w by h) with the same grading code the copy is saved with.
 *  No pixels: the look alone. */
export function bulkGrade(look: Grade | null, px: Uint8ClampedArray | Uint8Array | null, w = 0, h = 0, threshold = DEFAULT_DARK_THRESHOLD): BulkGrade {
  const base = normaliseGrade(look ?? DEFAULT_GRADE);
  if (!px) return { grade: base, lift: 0, median: null, after: null, bright: null, held: false };
  const median = horizonMedian(px, w, h), bright = brightShare(px, w, h), day = daylight(bright);
  const graded = (k: number) => {
    const g = addGrades(base, DARK_LIFT, k);
    const copy = px.slice();
    applyGrade(copy, g);
    return { k, g, m: horizonMedian(copy, w, h), c: clippedShare(copy, w, h) };
  };
  const plain = graded(0);
  const done = (r: ReturnType<typeof graded>, held = false): BulkGrade =>
    ({ grade: r.g, lift: Math.round(r.k * 100) / 100, median, after: r.m, bright, held });
  const target = liftTarget(median, threshold, day);
  if (target == null) return done(plain);
  // Brightness and clipping both rise with the lift, so each limit is found by halving the
  // gap until it is within a 64th of a unit: first the most the sky allows, then the target.
  const fits = (r: ReturnType<typeof graded>) => r.c - plain.c <= CLIP_ALLOW;
  let top = graded(liftMax(day)), held = false;
  if (!fits(top)) {
    let lo = plain, hi = top.k;
    while (hi - lo.k > 1 / 64) {
      const r = graded((lo.k + hi) / 2);
      if (fits(r)) lo = r;
      else hi = r.k;
    }
    top = lo;
    held = top.m < target;
  }
  if (top.m <= target) return done(top, held);
  let lo = 0;
  while (top.k - lo > 1 / 64) {
    const r = graded((lo + top.k) / 2);
    if (r.m < target) lo = r.k;
    else top = r;
  }
  return done(top);
}
