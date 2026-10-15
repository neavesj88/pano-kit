/* pano-kit grade: tone and colour for a 360, one pixel at a time.
 *
 * Every adjustment here maps a pixel's colour to a new colour without looking
 * at its neighbours. That is the point: an equirect's left and right edges are
 * the same place in the world, and local tone tools (Camera Raw's Shadows,
 * Highlights, Clarity, Dehaze) adapt to what surrounds each pixel, so they
 * treat the two edges differently and draw a line where the picture wraps.
 * Shadows and highlights are done here with a tone curve instead.
 *
 * Pure, no DOM: the live preview and the saved file run the same numbers.
 */

export interface Grade {
  /** Stops of light, applied in linear light. */
  exposure: number;
  /** Warmer (+) or cooler (-). */
  temperature: number;
  /** Magenta (+) or green (-). */
  tint: number;
  contrast: number;
  /** Tone-curve regions, light to dark: each lifts (+) or lowers (-) its quarter of the range. */
  highlights: number;
  lights: number;
  darks: number;
  shadows: number;
  /** Where the white end sits: + pushes more of the top to white, - greys it down. */
  whites: number;
  /** Where the black end sits: + lifts black towards grey, - crushes more to black. */
  blacks: number;
  /** Saturation that favours the duller colours, leaving already-strong ones mostly alone. */
  vibrance: number;
  saturation: number;
}

export type GradeKey = keyof Grade;

export const GRADE_RANGES: Record<GradeKey, readonly [number, number]> = {
  exposure: [-3, 3],
  temperature: [-100, 100],
  tint: [-100, 100],
  contrast: [-100, 100],
  highlights: [-100, 100],
  lights: [-100, 100],
  darks: [-100, 100],
  shadows: [-100, 100],
  whites: [-100, 100],
  blacks: [-100, 100],
  vibrance: [-100, 100],
  saturation: [-100, 100],
};

export const GRADE_KEYS = Object.keys(GRADE_RANGES) as GradeKey[];

export const DEFAULT_GRADE: Grade = {
  exposure: 0, temperature: 0, tint: 0, contrast: 0,
  highlights: 0, lights: 0, darks: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0,
};

/** Any partial or stored grade made whole and in range; nonsense reads as 0. */
export function normaliseGrade(g: Partial<Record<GradeKey, unknown>> | null | undefined): Grade {
  const out = { ...DEFAULT_GRADE };
  for (const k of GRADE_KEYS) {
    const v = Number(g?.[k]);
    const [lo, hi] = GRADE_RANGES[k];
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  }
  return out;
}

export const isIdentityGrade = (g: Grade | null | undefined) => !g || GRADE_KEYS.every(k => g[k] === 0);

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear-light gains for white balance, scaled so white keeps its brightness. */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100, m = tint / 100;
  const r = 1 + 0.2 * t, g = 1 - 0.15 * m, b = 1 - 0.2 * t;
  const k = 1 / (0.2126 * r + 0.7152 * g + 0.0722 * b);
  return [r * k, g * k, b * k];
}

/** Contrast about mid-grey with the ends held: towards smoothstep for +, towards its inverse for -. */
function contrastCurve(v: number, c: number): number {
  if (c === 0) return v;
  const target = c > 0 ? v * v * (3 - 2 * v) : 0.5 - Math.sin(Math.asin(1 - 2 * v) / 3);
  return v + (target - v) * Math.abs(c);
}

/** The tone curve's control points (x and y in 0..1), before smoothing. */
export function curvePoints(g: Pick<Grade, "shadows" | "darks" | "lights" | "highlights" | "whites" | "blacks">): [number, number][] {
  // END stays under 0.125 so the moved ends never pass the region points.
  const REGION = 0.1, END = 0.12;
  const pts: [number, number][] = [];
  const bl = g.blacks / 100, wh = g.whites / 100;
  if (bl >= 0) pts.push([0, END * bl]);
  else pts.push([0, 0], [END * -bl, 0]);
  pts.push(
    [0.125, 0.125 + REGION * (g.shadows / 100)],
    [0.375, 0.375 + REGION * (g.darks / 100)],
    [0.625, 0.625 + REGION * (g.lights / 100)],
    [0.875, 0.875 + REGION * (g.highlights / 100)],
  );
  if (wh >= 0) pts.push([1 - END * wh, 1], [1, 1]);
  else pts.push([1, 1 + END * wh]);
  // Never darker for a brighter input: the curve may flatten but not fold back.
  let floor = 0;
  for (const p of pts) {
    p[1] = clamp01(Math.max(floor, p[1]));
    floor = p[1];
  }
  return pts.filter((p, i) => i === 0 || p[0] > pts[i - 1][0]);
}

/** A smooth curve through the points that never overshoots them (Fritsch–Carlson). */
export function monotoneCurve(pts: [number, number][]): (x: number) => number {
  const n = pts.length;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** One 256-entry table per channel: white balance and exposure in linear light, then contrast and the tone curve. */
export function gradeLuts(g: Grade): [Uint8Array, Uint8Array, Uint8Array] {
  const gains = whiteBalanceGains(g.temperature, g.tint);
  const ev = Math.pow(2, g.exposure);
  const curve = monotoneCurve(curvePoints(g));
  const c = g.contrast / 100;
  return gains.map(gain => {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i / 255;
      if (gain !== 1 || ev !== 1) v = toSrgb(clamp01(toLinear(v) * gain * ev));
      v = curve(contrastCurve(v, c));
      lut[i] = Math.round(clamp01(v) * 255);
    }
    return lut;
  }) as [Uint8Array, Uint8Array, Uint8Array];
}

/** Grades RGBA pixels (canvas ImageData) in place. Alpha is untouched. */
export function applyGrade(px: Uint8ClampedArray | Uint8Array, g: Grade): void {
  if (isIdentityGrade(g)) return;
  const [lr, lg, lb] = gradeLuts(g);
  const sat = 1 + g.saturation / 100, vib = g.vibrance / 100;
  const colour = sat !== 1 || vib !== 0;
  for (let i = 0; i < px.length; i += 4) {
    let r = lr[px[i]], gg = lg[px[i + 1]], b = lb[px[i + 2]];
    if (colour) {
      const mx = r > gg ? (r > b ? r : b) : gg > b ? gg : b;
      const mn = r < gg ? (r < b ? r : b) : gg < b ? gg : b;
      const f = sat * (1 + vib * (1 - (mx - mn) / 255));
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      r = l + (r - l) * f;
      gg = l + (gg - l) * f;
      b = l + (b - l) * f;
      r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      gg = gg < 0 ? 0 : gg > 255 ? 255 : Math.round(gg);
      b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
    }
    px[i] = r;
    px[i + 1] = gg;
    px[i + 2] = b;
  }
}
