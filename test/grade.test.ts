import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRADE, GRADE_KEYS, GRADE_RANGES, applyGrade, curvePoints, gradeLuts, isIdentityGrade, monotoneCurve,
  normaliseGrade, whiteBalanceGains, type Grade,
} from "../src/grade";

const g = (patch: Partial<Grade>): Grade => ({ ...DEFAULT_GRADE, ...patch });
const px = (...rgb: number[][]) => new Uint8ClampedArray(rgb.flatMap(c => [...c, 255]));

describe("grade", () => {
  it("does nothing at its defaults, bit for bit", () => {
    expect(isIdentityGrade(DEFAULT_GRADE)).toBe(true);
    for (const lut of gradeLuts(DEFAULT_GRADE)) for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i);
    const a = px([0, 0, 0], [12, 200, 77], [255, 255, 255]);
    const before = [...a];
    applyGrade(a, DEFAULT_GRADE);
    expect([...a]).toEqual(before);
  });

  it("keeps every table rising, whatever the sliders say", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 300; n++) {
      const grade = normaliseGrade(Object.fromEntries(GRADE_KEYS.map(k => {
        const [lo, hi] = GRADE_RANGES[k];
        return [k, lo + rnd() * (hi - lo)];
      })));
      for (const lut of gradeLuts(grade)) for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    }
  });

  it("an exposure stop doubles linear light", () => {
    const [lr] = gradeLuts(g({ exposure: 1 }));
    // sRGB 99 is linear 0.1248; doubled is 0.2496, which is sRGB 137.
    expect(lr[99]).toBe(137);
    expect(lr[255]).toBe(255);
  });

  it("the tone curve regions lift their own part of the range most", () => {
    const [lift] = gradeLuts(g({ shadows: 100 }));
    expect(lift[32] - 32).toBeGreaterThan(lift[160] - 160);
    expect(lift[0]).toBe(0);
    expect(lift[255]).toBe(255);
    const [hi] = gradeLuts(g({ highlights: -100 }));
    expect(223 - hi[223]).toBeGreaterThan(64 - hi[64]);
  });

  it("blacks and whites move the ends", () => {
    expect(gradeLuts(g({ blacks: 100 }))[0][0]).toBeGreaterThan(20);
    expect(gradeLuts(g({ blacks: -100 }))[0][20]).toBe(0);
    expect(gradeLuts(g({ whites: -100 }))[0][255]).toBeLessThan(235);
    expect(gradeLuts(g({ whites: 100 }))[0][235]).toBe(255);
  });

  it("contrast holds black, mid-grey and white", () => {
    for (const c of [-100, 100]) {
      const [l] = gradeLuts(g({ contrast: c }));
      expect([l[0], l[255]]).toEqual([0, 255]);
      expect(Math.abs(l[128] - 128)).toBeLessThanOrEqual(1);
    }
    expect(gradeLuts(g({ contrast: 100 }))[0][64]).toBeLessThan(64);
  });

  it("white balance warms a grey without changing how bright white is", () => {
    const [r, gg, b] = whiteBalanceGains(100, 0);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(0.2126 * r + 0.7152 * gg + 0.0722 * b).toBeCloseTo(1, 10);
    const a = px([128, 128, 128]);
    applyGrade(a, g({ temperature: 50 }));
    expect(a[0]).toBeGreaterThan(a[2]);
  });

  it("saturation -100 is grey and vibrance spares strong colours", () => {
    const a = px([200, 60, 40]);
    applyGrade(a, g({ saturation: -100 }));
    expect(new Set([a[0], a[1], a[2]]).size).toBe(1);
    // Spread between the strongest and weakest channel, before and after.
    const dull = px([140, 120, 110]), strong = px([200, 40, 30]);
    applyGrade(dull, g({ vibrance: 100 }));
    applyGrade(strong, g({ vibrance: 100 }));
    expect((dull[0] - dull[2]) / 30).toBeGreaterThan(1.8);
    expect((strong[0] - strong[2]) / 170).toBeLessThan(1.4);
  });

  it("a colour comes out the same wherever it sits, so the wrap seam stays a seam of one picture", () => {
    const grade = g({ exposure: 0.4, shadows: 60, darks: 45, highlights: -20, vibrance: 20, temperature: 10 });
    const row = px([10, 20, 30], [90, 80, 70], [200, 190, 180], [10, 20, 30]);
    applyGrade(row, grade);
    expect([...row.slice(0, 4)]).toEqual([...row.slice(12, 16)]);
  });

  it("reads stored grades safely", () => {
    expect(normaliseGrade({ exposure: 9, contrast: "x", tint: -500 } as any)).toEqual(g({ exposure: 3, tint: -100 }));
    expect(normaliseGrade(null)).toEqual(DEFAULT_GRADE);
  });

  it("the curve passes through its points and never overshoots them", () => {
    const pts = curvePoints(g({ shadows: 100, darks: -100, blacks: 50 }));
    const f = monotoneCurve(pts);
    for (const [x, y] of pts) expect(f(x)).toBeCloseTo(y, 9);
    for (let x = 0; x <= 1; x += 0.01) expect(f(x)).toBeGreaterThanOrEqual(-1e-12);
  });
});
