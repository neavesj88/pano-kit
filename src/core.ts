/* pano-kit core: the rules of a 360° photo gallery.
 *
 * Pure: no DOM, no three.js, no database, no framework, so every decision
 * here is testable and a server and a browser using it cannot disagree.
 * Views and their links, panorama-or-flat, location parsing, the derivative
 * ladder, texture limits, blur-cap geometry, gallery ordering, slugs and
 * storage keys. Ported from the pano test rig and its brief.
 */

export type PanoKind = "auto" | "pano" | "flat";
export type ResolvedKind = "pano" | "flat";

export interface View {
  yaw: number;   // degrees, image centre = 0, right = positive, wrapped to (-180, 180]
  pitch: number; // degrees, up = positive, clamped to ±89
  fov: number;   // vertical field of view, degrees
}

export const DEFAULT_VIEW: View = { yaw: 0, pitch: 0, fov: 75 };
export const FOV_MIN = 30;
export const FOV_MAX = 100;

/** A spherical cap to blur ({yaw, pitch, r} in degrees), or for a flat photo a
 *  circle in image space ({u, v} 0..1, r as a percent of the width). */
export type Blur = { yaw: number; pitch: number; r: number } | { u: number; v: number; r: number };
/** A label pinned inside the photo. */
export type Hotspot = { yaw: number; pitch: number; text: string } | { u: number; v: number; text: string };

/** How the viewer opens a photo and dresses it; one set for a whole gallery. */
export interface ViewerSettings {
  /** fly: ease in to the start view. planet: a little planet unfolding into it.
   *  spin: one sweeping turn round the scene. none: straight there. */
  opening: "fly" | "planet" | "spin" | "none";
  /** disk: cover the nadir (the tripod, or the hand on the stick) with a badge.
   *  image: with a picture the page hands over (PanoEngine.setNadirImage), drawn
   *  with its transparency, so a figure can cover whoever held the camera; the
   *  disk until one arrives. */
  nadir: "none" | "disk" | "image";
  /** Angular radius of the cover, degrees out from straight down (5 to NADIR_DEG_MAX). */
  nadirDeg: number;
  /** Which way the cover's top points, as a yaw in degrees. 0 is the image centre. */
  nadirRot?: number;
  /** A picture under the nadir cover (PanoEngine.setFigureImage), sized and turned
   *  on its own: a figure standing in for whoever held the camera, coming out from
   *  under the badge. deg and rot as for the cover. Null, or no picture: none. */
  figure?: { deg: number; rot: number } | null;
  minimap: boolean;
}

export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = { opening: "fly", nadir: "none", nadirDeg: 25, nadirRot: 0, minimap: true };

/** Past about 75° the cover's plane is nearly level with the eye and smears to the horizon. */
export const NADIR_DEG_MAX = 75;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Yaw into [-180, 180). A value already in range comes back untouched, so a
 *  view read from a link is not turned into 12.299999999999955. */
export const wrap180 = (a: number) => (a >= -180 && a < 180 ? a : ((((a + 540) % 360) + 360) % 360) - 180);

/* ------------------------------------------------------------------ kind */

/** 2:1 within 5% is a full panorama; anything else is a flat photo, unless
 *  the curator overrode it. The brief says 5%; the rig's code allowed 0.05 of
 *  ratio, which is 2.5%. The camera writes exactly 2:1, so it rarely matters. */
export function resolveKind(override: PanoKind | null | undefined, w: number, h: number): ResolvedKind {
  if (override === "pano" || override === "flat") return override;
  if (!w || !h) return "pano";
  return Math.abs(w / h / 2 - 1) < 0.05 ? "pano" : "flat";
}

/* ------------------------------------------------------------- location */

export type ParsedLocation = { lat: number; lng: number } | { short: true } | null;

/** Coordinates out of anything someone might paste: "lat, lng", or a Google
 *  Maps link in any of its shapes. A short maps.app.goo.gl link cannot be read
 *  in the browser (it needs the redirect followed), so it is reported as such. */
export function parseLocation(text: string): ParsedLocation {
  const t = text.trim();
  const m =
    t.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/) ||
    t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
    t.match(/[?&]query=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i) ||
    t.match(/[?&]q=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i) ||
    t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
    t.match(/[?&]ll=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  if (m) {
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(t)) return { short: true };
  return null;
}

/** Hosts the server will follow a short link through. Anything else is refused,
 *  so the expander cannot be pointed at arbitrary URLs. */
export function isMapsShortLinkHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // Anchored on a real Google domain: google.com, google.de, google.com.au,
  // google.co.uk. A looser pattern let "google.com.evil.example" through.
  return h === "maps.app.goo.gl" || h === "goo.gl" || /(^|\.)google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(h);
}

/* Linked by coordinates, never by name: coordinates never resolve to the
   wrong café. */
export const mapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
export const directionsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
export const geoUri = (lat: number, lng: number, name?: string | null) =>
  `geo:${lat},${lng}?q=${lat},${lng}${name ? `(${encodeURIComponent(name)})` : ""}`;

/* --------------------------------------------------------------- views */

export function normaliseView(v: Partial<View> | null | undefined): View {
  const yaw = Number(v?.yaw);
  const pitch = Number(v?.pitch);
  const fov = Number(v?.fov);
  return {
    yaw: Number.isFinite(yaw) ? wrap180(yaw) : DEFAULT_VIEW.yaw,
    pitch: Number.isFinite(pitch) ? clamp(pitch, -89, 89) : DEFAULT_VIEW.pitch,
    fov: Number.isFinite(fov) ? clamp(fov, FOV_MIN, FOV_MAX) : DEFAULT_VIEW.fov,
  };
}

/** `#view=yaw,pitch,fov` → a view, or null. A shared link lands exactly there. */
export function parseViewHash(hash: string): View | null {
  const m = hash.match(/view=(-?[\d.]+),(-?[\d.]+),([\d.]+)/);
  if (!m) return null;
  return normaliseView({ yaw: +m[1], pitch: +m[2], fov: +m[3] });
}

export function formatViewHash(v: View): string {
  return `view=${v.yaw.toFixed(1)},${v.pitch.toFixed(1)},${Math.round(v.fov)}`;
}

/* --------------------------------------------------------- derivatives */

/** Never ask a GPU for more than this: some Adreno parts report 16384 and then
 *  fall over. */
export const TEXTURE_CEILING = 8192;
export const FIRST_PAINT_WIDTH = 2048;

/**
 * The widths to make from a source: the full image (capped at the ceiling),
 * plus each smaller rung it is wide enough to need. A 4000-wide photo becomes
 * [4000, 2048]; a 20224-wide scenic one [8192, 4096, 2048]. The full rung is the
 * photo at its own resolution, so nothing is ever upscaled.
 */
export function derivativeWidths(srcW: number, kind: ResolvedKind): number[] {
  const full = Math.min(srcW, kind === "flat" ? 4096 : TEXTURE_CEILING);
  const rungs = [full];
  for (const w of kind === "flat" ? [2048] : [4096, 2048]) if (w < full) rungs.push(w);
  return rungs;
}

/** What the device can take: the ceiling, the GPU's own limit, and 4096 on a
 *  low-memory phone. */
export function textureCap(maxTextureSize: number, deviceMemory?: number): number {
  const cap = Math.min(TEXTURE_CEILING, maxTextureSize || TEXTURE_CEILING);
  return deviceMemory && deviceMemory <= 4 ? Math.min(cap, 4096) : cap;
}

/** The largest available width that fits the cap, else the smallest. */
export function pickWidth(sizes: number[], cap: number): number | null {
  if (!sizes.length) return null;
  const fit = sizes.filter(w => w <= cap).sort((a, b) => b - a);
  return fit[0] ?? Math.min(...sizes);
}

/** First paint: the 2048 rung if there is one, else the smallest. */
export function firstPaintWidth(sizes: number[]): number | null {
  if (!sizes.length) return null;
  return sizes.includes(FIRST_PAINT_WIDTH) ? FIRST_PAINT_WIDTH : Math.min(...sizes);
}

/* ------------------------------------------------------- blur geometry */

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * The outline of a spherical cap on an equirectangular image, as a polygon in
 * pixels. Not a circle: near the poles a face becomes a wide smear, so each
 * row is solved exactly from
 *   cos(dist) = sin p sin p0 + cos p cos p0 cos(dyaw)
 *   dyaw(p)   = acos((cos r − sin p sin p0) / (cos p cos p0)).
 * x may run past either edge; callers draw it three times (offset ±W) so a cap
 * across the seam is covered.
 */
export function capPolygon(yaw0: number, pitch0: number, r: number, W: number, H: number): [number, number][] {
  const rows = 40;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const pTop = Math.min(90, pitch0 + r);
  const pBot = Math.max(-90, pitch0 - r);
  for (let i = 0; i <= rows; i++) {
    const p = pTop - ((pTop - pBot) * i) / rows;
    const cp = Math.cos(rad(p)) * Math.cos(rad(pitch0));
    let d: number;
    if (Math.abs(cp) < 1e-6) d = 180;
    else {
      const c = (Math.cos(rad(r)) - Math.sin(rad(p)) * Math.sin(rad(pitch0))) / cp;
      d = c <= -1 ? 180 : c >= 1 ? 0 : deg(Math.acos(c));
    }
    const y = ((90 - p) / 180) * H;
    left.push([((yaw0 - d + 180) / 360) * W, y]);
    right.push([((yaw0 + d + 180) / 360) * W, y]);
  }
  return left.concat(right.reverse());
}

/* ------------------------------------------------------- gallery order */

export interface Orderable {
  id: number;
  rating: number;
  takenAt: string | null;
  sortOrder?: number | null;
}

/** Trip order: when it was taken, then the curator's order, then upload order. */
export function tripCompare(a: Orderable, b: Orderable): number {
  const ta = a.takenAt ? Date.parse(a.takenAt) : NaN;
  const tb = b.takenAt ? Date.parse(b.takenAt) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1; // dated first
  const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return a.id - b.id;
}

export type SortMode = "best" | "trip";

/** Best first: rating high to low, ties in trip order, unrated last. */
export function sortPanos<T extends Orderable>(list: T[], mode: SortMode): T[] {
  const out = [...list];
  if (mode === "trip") return out.sort(tripCompare);
  return out.sort((a, b) => (b.rating || 0) - (a.rating || 0) || tripCompare(a, b));
}

/** Trip order grouped by day, headed by where it was. */
export function groupByDay<T extends Orderable & { locality?: string | null; country?: string | null }>(
  list: T[],
): { day: string | null; heading: string; items: T[] }[] {
  const groups: { day: string | null; heading: string; items: T[] }[] = [];
  for (const p of sortPanos(list, "trip")) {
    const day = p.takenAt ? p.takenAt.slice(0, 10) : null;
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.items.push(p);
      continue;
    }
    groups.push({ day, heading: p.locality || p.country || "", items: [p] });
  }
  return groups;
}

/* ---------------------------------------------------------------- slugs */

/** A readable URL slug. The server adds a number if it is taken. */
export function slugify(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "photo";
}

/* -------------------------------------------------------- storage keys */

/** Every object a panorama owns, under one folder. Derivatives carry a version
 *  in their path because they are served immutable: re-baking a blur writes a
 *  new version rather than overwriting what browsers have cached. The original
 *  has a random token in its name and is never put in an API response, so the
 *  unblurred photo cannot be found from the public site. */
export const panoKeys = {
  derivative: (prefix: string, version: number, width: number) => `${prefix}/v${version}/${width}.jpg`,
  map: (prefix: string, version: number) => `${prefix}/v${version}/map.jpg`,
  thumb: (prefix: string, thumbVersion: number) => `${prefix}/thumb-${thumbVersion}.jpg`,
};

/** Only these may be asked for by name when signing an upload. */
export function isAllowedAssetName(name: string): boolean {
  return name === "map" || name === "thumb" || name === "original" || /^\d{3,5}$/.test(name);
}

/* --------------------------------------------------------- dated folders */

export interface DatedFolder {
  /** The folder name as stored: safe characters only. */
  key: string;
  /** YYYY-MM-DD when the name starts with a date, else null. */
  date: string | null;
  /** The rest of the name, e.g. "rome_colosseum_forum". */
  place: string;
  /** For people: "Rome Colosseum Forum". */
  label: string;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A folder name made safe to store and show: letters, digits, _ - and spaces, at most 80. */
export function folderKey(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim()
    .replace(/[^A-Za-z0-9_\- ]+/g, "_").replace(/\s*_[\s_]*/g, "_").replace(/\s+/g, " ")
    .replace(/^[_ -]+|[_ -]+$/g, "").slice(0, 80);
}

/**
 * Folders named for a day and a place, the way a trip's photos get sorted:
 * DD_MM_YYYY_place (04_10_2026_paris) or YYYY-MM-DD_place. Anything else is a
 * plain folder with no date. The date matters most when a photo carries no
 * camera metadata: it is then the only thing that puts the photo on its day.
 */
export function parseFolder(name: string): DatedFolder {
  const key = folderKey(name);
  const valid = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };
  let date: string | null = null;
  let rest = key;
  const dmy = key.match(/^(\d{2})[_-](\d{2})[_-](\d{4})(?:[_ -]+(.*))?$/);
  const ymd = key.match(/^(\d{4})-(\d{2})-(\d{2})(?:[_ -]+(.*))?$/);
  if (dmy && valid(+dmy[3], +dmy[2], +dmy[1])) {
    date = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    rest = dmy[4] ?? "";
  } else if (ymd && valid(+ymd[1], +ymd[2], +ymd[3])) {
    date = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
    rest = ymd[4] ?? "";
  }
  const words = rest.split(/[_ -]+/).filter(Boolean);
  // A dated folder's place is a lowercase slug, so it is title-cased; a folder
  // named by hand is shown as it was typed.
  const label = date
    ? words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    : key.replace(/_/g, " ");
  return { key, date, place: words.join("_"), label };
}

/** "4 Oct 2026", from YYYY-MM-DD. */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** Dated folders in date order, then undated ones by name. */
export function compareFolders(a: string, b: string): number {
  const fa = parseFolder(a), fb = parseFolder(b);
  if (fa.date && fb.date && fa.date !== fb.date) return fa.date < fb.date ? -1 : 1;
  if (!!fa.date !== !!fb.date) return fa.date ? -1 : 1;
  return fa.key.localeCompare(fb.key);
}
