/* pano-kit overlay: a flat photo set into a 360, the way a camera would have
 * seen it from where the 360 was taken. For then-and-now: the 1945 photo on
 * the Reichstag roof, lined up with the building it shows.
 *
 * The photo is a pinhole camera's picture: it covers `hfov` degrees across,
 * looks towards (yaw, pitch), and is turned `roll` degrees about that line.
 * Every pixel of the 360 is a direction; the photo pixel that direction lands
 * on is where the camera's ray through it meets the picture plane. Working in
 * directions means the 360's wrap seam and its poles need no special cases.
 *
 * Pure: the engine draws the same camera as a plane in its scene for the live
 * view, and bake.ts runs this inverse mapping for the saved file.
 */

export interface Overlay {
  /** Where the photo's centre points, degrees (yaw: 360 centre = 0, right positive; pitch: up positive). */
  yaw: number;
  pitch: number;
  /** Degrees the photo spans from its left edge to its right. */
  hfov: number;
  /** Turned about its own centre, degrees, clockwise as you look at it. */
  roll: number;
  /** 0 (invisible) to 1. */
  opacity: number;
  /** Soft edge, as a share of the photo's shorter side (0 to 0.5). */
  feather: number;
}

export const DEFAULT_OVERLAY: Overlay = { yaw: 0, pitch: 0, hfov: 50, roll: 0, opacity: 1, feather: 0.03 };
export const HFOV_MIN = 2;
export const HFOV_MAX = 150;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type Vec3 = [number, number, number];

/** The direction of (yaw, pitch) in pano-kit's world: y up, yaw 0 looking down -z (as the engine's dirAt reads it). */
export function direction(yaw: number, pitch: number): Vec3 {
  const y = rad(yaw), p = rad(pitch);
  return [Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)];
}

export function yawPitchOf(d: Vec3): { yaw: number; pitch: number } {
  return { yaw: deg(Math.atan2(d[0], -d[2])), pitch: deg(Math.asin(clamp(d[1], -1, 1))) };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface OverlayCamera {
  fwd: Vec3;
  right: Vec3;
  up: Vec3;
  /** Focal length in photo pixels. */
  f: number;
  w: number;
  h: number;
}

/** The camera the photo was taken with, for a photo w × h pixels. */
export function overlayCamera(o: Overlay, w: number, h: number): OverlayCamera {
  const fwd = direction(o.yaw, o.pitch);
  const r0 = direction(o.yaw + 90, 0);
  // up = right × fwd: level with the horizon before the roll.
  const u0: Vec3 = [r0[1] * fwd[2] - r0[2] * fwd[1], r0[2] * fwd[0] - r0[0] * fwd[2], r0[0] * fwd[1] - r0[1] * fwd[0]];
  const c = Math.cos(rad(o.roll)), s = Math.sin(rad(o.roll));
  const right: Vec3 = [r0[0] * c - u0[0] * s, r0[1] * c - u0[1] * s, r0[2] * c - u0[2] * s];
  const up: Vec3 = [u0[0] * c + r0[0] * s, u0[1] * c + r0[1] * s, u0[2] * c + r0[2] * s];
  const f = w / 2 / Math.tan(rad(clamp(o.hfov, HFOV_MIN, HFOV_MAX)) / 2);
  return { fwd, right, up, f, w, h };
}

/** Where a direction lands on the photo, in its pixels (0,0 top-left), or null when it misses. */
export function photoPoint(cam: OverlayCamera, d: Vec3): [number, number] | null {
  const z = dot(d, cam.fwd);
  if (z <= 1e-9) return null;
  const x = cam.w / 2 + (cam.f * dot(d, cam.right)) / z;
  const y = cam.h / 2 - (cam.f * dot(d, cam.up)) / z;
  return x >= 0 && x <= cam.w && y >= 0 && y <= cam.h ? [x, y] : null;
}

/** The direction through a photo pixel: the inverse of photoPoint. */
export function photoDirection(cam: OverlayCamera, x: number, y: number): Vec3 {
  const a = (x - cam.w / 2) / cam.f, b = -(y - cam.h / 2) / cam.f;
  const d: Vec3 = [cam.fwd[0] + a * cam.right[0] + b * cam.up[0], cam.fwd[1] + a * cam.right[1] + b * cam.up[1], cam.fwd[2] + a * cam.right[2] + b * cam.up[2]];
  const n = Math.hypot(...d);
  return [d[0] / n, d[1] / n, d[2] / n];
}

/** How opaque the photo is at one of its pixels: the soft edge, then the opacity. */
export function edgeMask(o: Overlay, w: number, h: number, x: number, y: number): number {
  const band = o.feather * Math.min(w, h);
  let m = 1;
  if (band > 0) {
    const t = clamp(Math.min(x, w - x, y, h - y) / band, 0, 1);
    m = t * t * (3 - 2 * t);
  }
  return m * clamp(o.opacity, 0, 1);
}

/**
 * The rows and columns of a W × H equirect the photo can touch, so a bake
 * only visits those. Columns may run past the right edge (wrap them with % W).
 * A photo over a pole takes the whole width of its rows.
 */
export function footprint(o: Overlay, w: number, h: number, W: number, H: number): { x0: number; x1: number; y0: number; y1: number } {
  const cam = overlayCamera(o, w, h);
  const N = 48;
  let pMin = 90, pMax = -90, dMin = 360, dMax = -360;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    for (const [x, y] of [[t * w, 0], [t * w, h], [0, t * h], [w, t * h]]) {
      const { yaw, pitch } = yawPitchOf(photoDirection(cam, x, y));
      const dy = ((((yaw - o.yaw + 540) % 360) + 360) % 360) - 180;
      pMin = Math.min(pMin, pitch); pMax = Math.max(pMax, pitch);
      dMin = Math.min(dMin, dy); dMax = Math.max(dMax, dy);
    }
  }
  const row = (p: number) => ((90 - p) / 180) * H;
  const overNorth = !!photoPoint(cam, [0, 1, 0]), overSouth = !!photoPoint(cam, [0, -1, 0]);
  if (overNorth) pMax = 90;
  if (overSouth) pMin = -90;
  const y0 = Math.max(0, Math.floor(row(pMax)) - 2), y1 = Math.min(H, Math.ceil(row(pMin)) + 2);
  if (overNorth || overSouth || dMax - dMin >= 359) return { x0: 0, x1: W, y0, y1 };
  const col = (yaw: number) => ((yaw + 180) / 360) * W;
  let x0 = Math.floor(col(o.yaw + dMin)) - 2, x1 = Math.ceil(col(o.yaw + dMax)) + 2;
  if (x0 < 0) { x0 += W; x1 += W; }
  return { x0, x1: Math.min(x1, x0 + W), y0, y1 };
}

/** Moves the photo so its pixel (px, py) sits on the direction (yaw, pitch): dragging it by that point. */
export function placePoint(o: Overlay, w: number, h: number, px: number, py: number, yaw: number, pitch: number): Overlay {
  const f = w / 2 / Math.tan(rad(clamp(o.hfov, HFOV_MIN, HFOV_MAX)) / 2);
  // The point's offset from the photo's centre, turned back by the roll, as angles.
  const dx = px - w / 2, dy = py - h / 2;
  const c = Math.cos(rad(o.roll)), s = Math.sin(rad(o.roll));
  const rx = dx * c - dy * s, ry = dx * s + dy * c;
  const next = { ...o, yaw: yaw - deg(Math.atan2(rx, f)), pitch: clamp(pitch + deg(Math.atan2(ry, f)), -89, 89) };
  // That was the small-angle answer, off by up to a degree when tilted; a few
  // correction steps put the point under the pointer to well under a pixel.
  for (let i = 0; i < 8; i++) {
    const at = yawPitchOf(photoDirection(overlayCamera(next, w, h), px, py));
    const dYaw = (((yaw - at.yaw + 540) % 360) + 360) % 360 - 180, dPitch = pitch - at.pitch;
    if (Math.abs(dYaw) < 1e-4 && Math.abs(dPitch) < 1e-4) break;
    next.yaw = (((next.yaw + dYaw + 540) % 360) + 360) % 360 - 180;
    next.pitch = clamp(next.pitch + dPitch, -89, 89);
  }
  return next;
}

export function normaliseOverlay(o: Partial<Record<keyof Overlay, unknown>> | null | undefined): Overlay {
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    yaw: (((n(o?.yaw, 0) + 540) % 360) + 360) % 360 - 180,
    pitch: clamp(n(o?.pitch, 0), -89, 89),
    hfov: clamp(n(o?.hfov, DEFAULT_OVERLAY.hfov), HFOV_MIN, HFOV_MAX),
    roll: clamp(n(o?.roll, 0), -180, 180),
    opacity: clamp(n(o?.opacity, 1), 0, 1),
    feather: clamp(n(o?.feather, DEFAULT_OVERLAY.feather), 0, 0.5),
  };
}
