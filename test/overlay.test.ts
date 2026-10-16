import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERLAY, direction, edgeMask, footprint, normaliseOverlay, overlayCamera, photoDirection, photoPoint, placePoint, yawPitchOf,
  type Overlay,
} from "../src/overlay";

const o = (patch: Partial<Overlay>): Overlay => ({ ...DEFAULT_OVERLAY, feather: 0, ...patch });
const W = 1200, H = 800; // a 3:2 photo

describe("overlay", () => {
  it("puts the photo's centre where it points, and its edges hfov/2 either side", () => {
    const ov = o({ yaw: -46, pitch: 42, hfov: 55 });
    const cam = overlayCamera(ov, W, H);
    const c = photoPoint(cam, direction(-46, 42))!;
    expect(c[0]).toBeCloseTo(W / 2, 6);
    expect(c[1]).toBeCloseTo(H / 2, 6);
    const level = overlayCamera(o({ yaw: 10, pitch: 0, hfov: 60 }), W, H);
    expect(photoPoint(level, direction(10 + 29.999, 0))![0]).toBeCloseTo(W, 0);
    expect(photoPoint(level, direction(10 + 31, 0))).toBeNull();
    expect(photoPoint(level, direction(10 + 180, 0))).toBeNull();
  });

  it("turns clockwise for a positive roll", () => {
    const cam = overlayCamera(o({ roll: 90, hfov: 60 }), W, H);
    // Turned a quarter clockwise, the photo's right-hand edge hangs below its centre.
    expect(yawPitchOf(photoDirection(cam, W, H / 2)).pitch).toBeLessThan(-20);
  });

  it("photoDirection undoes photoPoint", () => {
    const cam = overlayCamera(o({ yaw: 170, pitch: -30, hfov: 80, roll: 25 }), W, H);
    for (const [x, y] of [[0, 0], [W, H], [300, 650], [W / 2, 10]]) {
      const back = photoPoint(cam, photoDirection(cam, x, y))!;
      expect(back[0]).toBeCloseTo(x, 6);
      expect(back[1]).toBeCloseTo(y, 6);
    }
  });

  it("finds every pixel it can touch, across the seam and over a pole", () => {
    const PW = 720, PH = 360;
    for (const ov of [o({ yaw: 175, pitch: 5, hfov: 40 }), o({ yaw: -100, pitch: 80, hfov: 70, roll: 30 }), o({ yaw: 30, pitch: -60, hfov: 120 }), o({ yaw: 0, pitch: 0, hfov: 20 })]) {
      const cam = overlayCamera(ov, W, H);
      const fp = footprint(ov, W, H, PW, PH);
      for (let j = 0; j < PH; j++) for (let i = 0; i < PW; i++) {
        const d = direction(((i + 0.5) / PW) * 360 - 180, 90 - ((j + 0.5) / PH) * 180);
        if (!photoPoint(cam, d)) continue;
        expect(j >= fp.y0 && j < fp.y1).toBe(true);
        const inCols = (i >= fp.x0 && i < fp.x1) || (i + PW >= fp.x0 && i + PW < fp.x1);
        expect(inCols).toBe(true);
      }
    }
    const seam = footprint(o({ yaw: 175, hfov: 40 }), W, H, PW, PH);
    expect(seam.x1).toBeGreaterThan(PW);
    const pole = footprint(o({ pitch: 80, hfov: 60 }), W, H, PW, PH);
    expect([pole.x0, pole.x1, pole.y0]).toEqual([0, PW, 0]);
  });

  it("drags by the grabbed point: it ends up under the pointer", () => {
    for (const roll of [0, 35, -120]) {
      const start = o({ yaw: 20, pitch: 10, hfov: 50, roll });
      const moved = placePoint(start, W, H, 900, 200, -70, 35);
      const at = yawPitchOf(photoDirection(overlayCamera(moved, W, H), 900, 200));
      expect(at.yaw).toBeCloseTo(-70, 1);
      expect(at.pitch).toBeCloseTo(35, 1);
      expect(moved.hfov).toBe(50);
      expect(moved.roll).toBe(roll);
    }
  });

  it("fades its edge and keeps its opacity inside", () => {
    const ov = o({ feather: 0.1, opacity: 0.6 });
    expect(edgeMask(ov, W, H, W / 2, H / 2)).toBeCloseTo(0.6, 9);
    expect(edgeMask(ov, W, H, 0, H / 2)).toBe(0);
    expect(edgeMask(ov, W, H, 40, H / 2)).toBeGreaterThan(0);
    expect(edgeMask(ov, W, H, 40, H / 2)).toBeLessThan(0.6);
    expect(edgeMask(o({ feather: 0, opacity: 1 }), W, H, 0, 0)).toBe(1);
  });

  it("reads stored overlays safely", () => {
    expect(normaliseOverlay({ yaw: 190, pitch: 120, hfov: 900, opacity: -1, feather: "x" } as any))
      .toEqual({ yaw: -170, pitch: 89, hfov: 150, roll: 0, opacity: 0, feather: DEFAULT_OVERLAY.feather });
  });
});
