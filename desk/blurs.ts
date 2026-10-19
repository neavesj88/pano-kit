/* Picking and moving a blur on the sphere, for dragging one into place on the Blur tab.
 * Pure, so the page's pointer handling stays thin. */
import { wrap180, type Blur } from "../src/core.ts";
import { direction } from "../src/overlay.ts";

/** The topmost blur (the last one drawn) whose circle holds the direction yaw/pitch, or -1.
 *  Measured along the sphere, so it holds across the ±180° seam and near the poles. */
export function blurAt(blurs: readonly Blur[], yaw: number, pitch: number): number {
  const p = direction(yaw, pitch);
  for (let i = blurs.length - 1; i >= 0; i--) {
    const b = blurs[i];
    if (!("yaw" in b)) continue;
    const q = direction(b.yaw, b.pitch);
    const cos = Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
    if ((Math.acos(cos) * 180) / Math.PI <= b.r) return i;
  }
  return -1;
}

/** Where a blur grabbed `off` from its centre (its yaw/pitch minus the grab point's) lands
 *  with the pointer at yaw/pitch: the grab point stays under the pointer. */
export function dragTo(off: { yaw: number; pitch: number }, yaw: number, pitch: number): { yaw: number; pitch: number } {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { yaw: r2(wrap180(yaw + off.yaw)), pitch: r2(Math.min(90, Math.max(-90, pitch + off.pitch))) };
}
