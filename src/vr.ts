/* The pure parts of the headset controls, kept out of the engine so they can
 * be tested without a headset: snap turning, telling a drag from a click,
 * which label a controller points at, and fitting a label's text on a card. */

export interface Vec3 { x: number; y: number; z: number }

const deg = (r: number) => (r * 180) / Math.PI;

/** One snap turn, in degrees: big enough to get round in a few flicks,
 *  small enough not to lose your place. */
export const SNAP_DEG = 30;
/** A trigger press that turned the view further than this was a drag, not a click. */
export const DRAG_DEG = 3;
/** A button held while the controller sweeps at least this far sideways is a swipe. */
export const SWIPE_DEG = 20;

/**
 * What a held button meant once released: swept left (the ray's yaw fell)
 * fast enough, the next photo; swept right, the previous; a short press that
 * barely moved, a click; a long hold going nowhere, nothing.
 */
export function pressOutcome(deltaYaw: number, swungDeg: number, heldMs: number): "next" | "previous" | "click" | "none" {
  if (swungDeg >= SWIPE_DEG) return heldMs > 1500 || Math.abs(deltaYaw) < SWIPE_DEG / 2 ? "none" : deltaYaw < 0 ? "next" : "previous";
  return swungDeg < DRAG_DEG && heldMs <= 600 ? "click" : "none";
}

/**
 * Snap turning from a thumbstick's x axis: one turn per flick, then nothing
 * until the stick comes back near the middle. Smooth turning makes many
 * people queasy in a headset; snapping does not.
 */
export function snapTurn(x: number, armed: boolean): { turn: -1 | 0 | 1; armed: boolean } {
  if (!armed) return { turn: 0, armed: Math.abs(x) < 0.3 };
  if (x > 0.6) return { turn: 1, armed: false };
  if (x < -0.6) return { turn: -1, armed: false };
  return { turn: 0, armed: true };
}

/** The yaw of a direction in degrees, as the engine measures it: 0 straight
 *  ahead (-z), positive to the right. */
export function yawOf(d: Vec3): number {
  return deg(Math.atan2(d.x, -d.z));
}

/** Degrees between two directions (any lengths). */
export function angleDeg(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
  if (!la || !lb) return 180;
  const c = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return deg(Math.acos(Math.max(-1, Math.min(1, c))));
}

/** The label a controller's ray points at: the nearest within `within`
 *  degrees, else -1. Labels with no direction (on a flat photo) are null. */
export function pointedLabel(ray: Vec3, labels: (Vec3 | null)[], within = 4): number {
  let best = -1, bestDeg = within;
  labels.forEach((d, i) => {
    if (!d) return;
    const a = angleDeg(ray, d);
    if (a <= bestDeg) { best = i; bestDeg = a; }
  });
  return best;
}

/**
 * A label's text in lines no wider than `maxWidth` (as `measure` reports),
 * at most `maxLines`; the last ends in an ellipsis if the text runs on. A
 * word too long for a line is cut, so nothing is ever drawn off the card.
 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 5): string[] {
  const fit = (s: string) => {
    let t = s;
    while (t.length > 1 && measure(t) > maxWidth) t = t.slice(0, -1);
    return t;
  };
  const lines: string[] = [];
  let line = "", truncated = false;
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const w = fit(word);
    const next = line ? `${line} ${w}` : w;
    if (measure(next) <= maxWidth) { line = next; continue; }
    if (lines.length === maxLines - 1) { truncated = true; break; }
    lines.push(line);
    line = w;
  }
  if (line) lines.push(line);
  if (truncated) {
    let l = lines[lines.length - 1];
    while (l.length > 1 && measure(`${l}…`) > maxWidth) l = l.slice(0, -1);
    lines[lines.length - 1] = `${l.replace(/[\s.,;:]+$/, "")}…`;
  }
  return lines;
}
