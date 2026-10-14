/* Locations for photos from a Google Maps Timeline export: for cameras that
 * record no GPS of their own, where the phone was when each photo was taken.
 *
 * Reads every export shape seen in the wild, all as plain JSON:
 * - the phone export (Google Maps > Settings > Personal content > Export
 *   Timeline data, Timeline.json): semanticSegments (visits, activities,
 *   timelinePath points) and rawSignals, coordinates written "50.05°, 14.34°",
 *   times with their own UTC offset;
 * - the same segments as a bare array with "geo:50.05,14.34" coordinates and
 *   path points timed in minutes from the segment's start;
 * - Takeout's Records.json (locations[], latitudeE7) and its monthly Semantic
 *   Location History files (timelineObjects[], placeVisit, activitySegment).
 *
 * Times are kept as the local clock read where they were recorded whenever
 * the export says its offset, because cameras that write no timezone (most
 * 360 cameras) stamp photos with the local clock too: matching clock to clock
 * needs no idea of where the photo was. A time with no offset (Takeout's "Z")
 * is UTC, and says so (`local: false`), for the caller to shift.
 *
 * Pure: give it the parsed JSON. The file never needs to leave the browser. */

export type FixKind = "visit" | "path" | "activity" | "raw";

/** Where the phone was at time `t` (ms), or from `t` to `until` for a visit. */
export interface Fix {
  t: number;
  until?: number;
  lat: number;
  lng: number;
  kind: FixKind;
  /** `t` is the local clock where it was recorded (else UTC). */
  local: boolean;
}

/* --------------------------------------------------------------- pieces */

/** Coordinates in any of the export's spellings, or null. */
export function readLatLng(v: unknown): { lat: number; lng: number } | null {
  let lat: number | undefined, lng: number | undefined;
  if (typeof v === "string") {
    const m = v.replace(/^geo:/i, "").match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?\s*$/);
    if (m) { lat = parseFloat(m[1]); lng = parseFloat(m[2]); }
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const e7 = (a: unknown) => (typeof a === "number" ? a / 1e7 : undefined);
    const n = (a: unknown) => (typeof a === "number" ? a : typeof a === "string" ? parseFloat(a) : undefined);
    lat = e7(o.latitudeE7) ?? e7(o.latE7) ?? n(o.latitude) ?? n(o.lat);
    lng = e7(o.longitudeE7) ?? e7(o.lngE7) ?? n(o.longitude) ?? n(o.lng);
    if (lat === undefined && (o.latLng !== undefined || o.LatLng !== undefined || o.point !== undefined)) return readLatLng(o.latLng ?? o.LatLng ?? o.point);
  }
  if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** A timestamp as ms on the local clock where it was recorded when it carries
 *  an offset, else as UTC ms. Also takes Takeout's millisecond strings. */
export function readTime(v: unknown): { t: number; local: boolean } | null {
  if (typeof v === "number" && Number.isFinite(v)) return { t: v, local: false };
  if (typeof v !== "string" || !v) return null;
  if (/^\d{10,}$/.test(v)) return { t: Number(v), local: false };
  const utc = Date.parse(v);
  if (!Number.isFinite(utc)) return null;
  const m = v.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return { t: utc, local: false };
  const off = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return { t: utc + off * 60_000, local: true };
}

/* -------------------------------------------------------------- parsing */

const timeOf = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const r = readTime(o[k]);
    if (r) return r;
  }
  return null;
};

/** One semantic segment, as the phone export writes it (in either spelling). */
function fromSegment(seg: Record<string, unknown>, out: Fix[]) {
  const start = timeOf(seg, "startTime", "startTimestamp");
  const end = timeOf(seg, "endTime", "endTimestamp");
  const visit = seg.visit as Record<string, any> | undefined;
  if (visit && start) {
    const where = readLatLng(visit.topCandidate?.placeLocation?.latLng ?? visit.topCandidate?.placeLocation);
    if (where) out.push({ ...where, t: start.t, until: end?.t ?? start.t, kind: "visit", local: start.local });
  }
  const activity = seg.activity as Record<string, any> | undefined;
  if (activity) {
    const a = readLatLng(activity.start?.latLng ?? activity.start);
    const b = readLatLng(activity.end?.latLng ?? activity.end);
    if (a && start) out.push({ ...a, t: start.t, kind: "activity", local: start.local });
    if (b && end) out.push({ ...b, t: end.t, kind: "activity", local: end.local });
  }
  const path = seg.timelinePath;
  if (Array.isArray(path)) {
    for (const p of path) {
      if (!p || typeof p !== "object") continue;
      const where = readLatLng((p as any).point);
      if (!where) continue;
      let when = readTime((p as any).time);
      const mins = Number((p as any).durationMinutesOffsetFromStartTime);
      if (!when && start && Number.isFinite(mins)) when = { t: start.t + mins * 60_000, local: start.local };
      if (when) out.push({ ...where, t: when.t, kind: "path", local: when.local });
    }
  }
}

/** Takeout's monthly Semantic Location History entries. */
function fromTimelineObject(o: Record<string, any>, out: Fix[]) {
  const v = o.placeVisit;
  if (v) {
    const where = readLatLng(v.location);
    const s = timeOf(v.duration ?? {}, "startTimestamp", "startTimestampMs");
    const e = timeOf(v.duration ?? {}, "endTimestamp", "endTimestampMs");
    if (where && s) out.push({ ...where, t: s.t, until: e?.t ?? s.t, kind: "visit", local: s.local });
  }
  const a = o.activitySegment;
  if (a) {
    const s = timeOf(a.duration ?? {}, "startTimestamp", "startTimestampMs");
    const e = timeOf(a.duration ?? {}, "endTimestamp", "endTimestampMs");
    const from = readLatLng(a.startLocation), to = readLatLng(a.endLocation);
    if (from && s) out.push({ ...from, t: s.t, kind: "activity", local: s.local });
    if (to && e) out.push({ ...to, t: e.t, kind: "activity", local: e.local });
    for (const p of a.simplifiedRawPath?.points ?? []) {
      const where = readLatLng(p), when = timeOf(p ?? {}, "timestamp", "timestampMs");
      if (where && when) out.push({ ...where, t: when.t, kind: "path", local: when.local });
    }
  }
}

/** Every fix in an export, oldest first. Unknown shapes give none, never an error. */
export function parseTimeline(json: unknown): Fix[] {
  const out: Fix[] = [];
  const root = json as any;
  const segments = Array.isArray(root) ? root : root?.semanticSegments;
  if (Array.isArray(segments)) for (const s of segments) if (s && typeof s === "object") fromSegment(s, out);
  for (const r of root?.rawSignals ?? []) {
    const p = r?.position;
    const where = p && readLatLng(p.LatLng ?? p.latLng ?? p), when = p && readTime(p.timestamp);
    if (where && when) out.push({ ...where, t: when.t, kind: "raw", local: when.local });
  }
  for (const l of root?.locations ?? []) {
    const where = readLatLng(l), when = l && (readTime(l.timestamp) ?? readTime(l.timestampMs));
    if (where && when) out.push({ ...where, t: when.t, kind: "raw", local: when.local });
  }
  for (const o of root?.timelineObjects ?? []) if (o && typeof o === "object") fromTimelineObject(o, out);
  return out.sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------- matching */

export interface TimelineMatch {
  lat: number;
  lng: number;
  /** Minutes between the photo and the nearest fix used (0 inside a visit). */
  gapMin: number;
  kind: FixKind | "between";
}

/**
 * Where the phone was at `photoT` (ms; on the same clock as the fixes: local
 * for an export with offsets). Inside a visit: the visit's place. Otherwise
 * between the fixes either side, by time along the straight line when both
 * are within `maxGapMin`, else the nearer one if it is. Null when nothing is
 * that close. `fixes` must be sorted (parseTimeline sorts them).
 */
export function locateAt(fixes: Fix[], photoT: number, maxGapMin = 30): TimelineMatch | null {
  let best: Fix | null = null;
  for (const f of fixes) {
    if (f.kind === "visit" && f.t <= photoT && photoT <= (f.until ?? f.t) && (!best || (f.until! - f.t) < (best.until! - best.t))) best = f;
  }
  if (best) return { lat: best.lat, lng: best.lng, gapMin: 0, kind: "visit" };

  // Visits also count as fixes at their start and end.
  let lo = 0, hi = fixes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].t <= photoT) lo = mid + 1;
    else hi = mid;
  }
  const max = maxGapMin * 60_000;
  // A visit holding photoT was taken above, so whatever came before has ended by then.
  let before: { f: Fix; t: number } | null = lo > 0 ? { f: fixes[lo - 1], t: fixes[lo - 1].until ?? fixes[lo - 1].t } : null;
  const after: { f: Fix; t: number } | null = lo < fixes.length ? { f: fixes[lo], t: fixes[lo].t } : null;
  // A visit that started earlier may end later than the nearest point before the photo.
  for (const f of fixes) if (f.kind === "visit" && f.until! <= photoT && (!before || f.until! > before.t)) before = { f, t: f.until! };

  const gapB = before ? photoT - before.t : Infinity, gapA = after ? after.t - photoT : Infinity;
  if (gapB <= max && gapA <= max && before && after && after.t > before.t) {
    const k = (photoT - before.t) / (after.t - before.t);
    return {
      lat: before.f.lat + (after.f.lat - before.f.lat) * k,
      lng: before.f.lng + (after.f.lng - before.f.lng) * k,
      gapMin: Math.min(gapB, gapA) / 60_000,
      kind: "between",
    };
  }
  const near = gapB <= gapA ? before : after;
  const gap = Math.min(gapB, gapA);
  if (!near || gap > max) return null;
  return { lat: near.f.lat, lng: near.f.lng, gapMin: gap / 60_000, kind: near.f.kind };
}
