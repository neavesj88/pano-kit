import { describe, expect, it } from "vitest";
import { nadirPoint } from "../src/nadir";

describe("nadir", () => {
  it("puts straight down at the picture's centre, whatever the turn", () => {
    for (const rot of [0, 37, -120]) {
      const c = nadirPoint(0, -90, 12, rot)!;
      expect(c.x).toBeCloseTo(0.5, 6);
      expect(c.y).toBeCloseTo(0.5, 6);
    }
  });

  it("points the picture's top at yaw rot, and its right a quarter turn on, at the cap's edge", () => {
    // A hair inside the edge: exactly on it, rounding can put the point just outside.
    const edge = -90 + 12 - 1e-7;
    for (const rot of [0, 45, -170]) {
      const top = nadirPoint(rot, edge, 12, rot)!;
      expect(top.x).toBeCloseTo(0.5, 5);
      expect(top.y).toBeCloseTo(0, 5);
      const right = nadirPoint(rot + 90, edge, 12, rot)!;
      expect(right.x).toBeCloseTo(1, 5);
      expect(right.y).toBeCloseTo(0.5, 5);
      const bottom = nadirPoint(rot + 180, edge, 12, rot)!;
      expect(bottom.y).toBeCloseTo(1, 5);
    }
  });

  it("is stereographic from straight down, and empty outside the cap", () => {
    // Half way out in tan(phi/2), not in angle.
    const deg = 30, phi = 2 * Math.atan(0.5 * Math.tan((deg * Math.PI) / 360));
    const half = nadirPoint(0, -90 + (phi * 180) / Math.PI, deg, 0)!;
    expect(half.y).toBeCloseTo(0.25, 6);
    expect(nadirPoint(0, -90 + 12.5, 12, 0)).toBeNull();
    expect(nadirPoint(0, 0, 12, 0)).toBeNull();
  });
});
