/* pano-kit derive: turning a photo file into what a gallery publishes.
 *
 * Fingerprint it, read its metadata, make each size, a minimap strip and (via
 * the engine) a start-view thumbnail, and upload to signed URLs. In the
 * browser, because the browser already holds the decoded image and a server
 * should not have to decode a 200 MP file. What to upload where is the app's
 * business; nothing here knows about any particular API.
 */
import type { Blur } from "./core";
import { bakeTo, canvasToJpeg } from "./bake";
import type { GalleryDetails } from "./jpeg";

/** SHA-256 of the bytes, hex: the same photo is the same photo whatever it is called. */
export async function fingerprint(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Pixel size after EXIF orientation, which is what gets drawn, unlike the header's numbers. */
export async function measure(file: Blob): Promise<{ w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const out = { w: bmp.width, h: bmp.height };
  bmp.close();
  return out;
}

export interface Gpano {
  fullW: number;
  fullH: number;
  cropW: number;
  cropH: number;
  cropL: number;
  cropT: number;
  heading: number | null;
}

export interface PhotoMeta {
  takenAt: string | null;
  lat: number | null;
  lng: number | null;
  camera: string | null;
  gpano: Gpano | null;
  /** What someone wrote about it before upload (pano-kit jpeg's PhotoDetails, or any XMP editor): null or empty when absent. */
  title: string | null;
  description: string | null;
  tags: string[];
  rating: number | null;
  place: string | null;
  gallery: GalleryDetails | null;
}

const isView = (v: any) => v && [v.yaw, v.pitch, v.fov].every(Number.isFinite);
const isSpot = (h: any) => h && typeof h.text === "string" && ([h.yaw, h.pitch].every(Number.isFinite) || [h.u, h.v].every(Number.isFinite));

/** pano-kit's own XMP field, read defensively: a hand-edited or foreign file gets only what is well formed. */
export function readGallery(json: string | undefined): GalleryDetails | null {
  if (!json) return null;
  let g: any;
  try { g = JSON.parse(json); } catch { return null; }
  if (!g || typeof g !== "object") return null;
  const out: GalleryDetails = {};
  if (isView(g.start)) out.start = { yaw: g.start.yaw, pitch: g.start.pitch, fov: g.start.fov };
  if (Array.isArray(g.hotspots)) out.hotspots = g.hotspots.filter(isSpot);
  if (typeof g.linkUrl === "string") out.linkUrl = g.linkUrl;
  if (typeof g.linkLabel === "string") out.linkLabel = g.linkLabel;
  return Object.keys(out).length ? out : null;
}

/**
 * EXIF "2026:09:20 14:03:11" with OffsetTimeOriginal when the camera wrote one.
 * Without an offset the time is the camera's local clock; it is kept as
 * written (stored as if UTC) so the date part stays the day it was taken,
 * which is what grouping by day needs.
 */
export function exifDate(dt?: string, offset?: string): string | null {
  const m = dt?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const tz = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : "Z";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}

const num = (tag: any): number | undefined => {
  if (!tag) return undefined;
  const v = Array.isArray(tag.value) ? tag.value[0] : tag.value;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (tag: any): string | undefined => {
  if (!tag) return undefined;
  return tag.description ?? (Array.isArray(tag.value) ? tag.value.join(", ") : String(tag.value));
};

/** EXIF date and camera, GPS, and GPano crop. Missing metadata is normal (re-encoded
 *  copies have none) and comes back as nulls, never as an error. Needs `exifreader`. */
export async function readPhotoMeta(file: Blob): Promise<PhotoMeta> {
  const meta: PhotoMeta = {
    takenAt: null, lat: null, lng: null, camera: null, gpano: null,
    title: null, description: null, tags: [], rating: null, place: null, gallery: null,
  };
  try {
    const ExifReader = (await import("exifreader")).default;
    const tags: any = ExifReader.load(await file.slice(0, 4 * 1024 * 1024).arrayBuffer(), { expanded: true });
    if (tags.gps && Number.isFinite(tags.gps.Latitude) && Number.isFinite(tags.gps.Longitude)) {
      meta.lat = tags.gps.Latitude;
      meta.lng = tags.gps.Longitude;
    }
    meta.takenAt = exifDate(str(tags.exif?.DateTimeOriginal), str(tags.exif?.OffsetTimeOriginal));
    meta.camera = [str(tags.exif?.Make), str(tags.exif?.Model)].filter(Boolean).join(" ") || null;
    const x = tags.xmp ?? {};
    const text = (t: any) => (typeof t?.description === "string" && t.description.trim() ? t.description.trim() : null);
    meta.title = text(x.title);
    meta.description = text(x.description);
    meta.tags = Array.isArray(x.subject?.value) ? x.subject.value.map((v: any) => String(v.description ?? v.value ?? "").trim()).filter(Boolean) : [];
    const rating = num(x.Rating);
    meta.rating = rating != null && rating >= 0 && rating <= 5 ? Math.round(rating) : null;
    meta.place = text(x.Location);
    meta.gallery = readGallery(x.Gallery?.description);
    const fullW = num(x.FullPanoWidthPixels), fullH = num(x.FullPanoHeightPixels);
    const cropW = num(x.CroppedAreaImageWidthPixels), cropH = num(x.CroppedAreaImageHeightPixels);
    if (fullW && fullH && cropW && cropH) {
      meta.gpano = {
        fullW, fullH, cropW, cropH,
        cropL: num(x.CroppedAreaLeftPixels) ?? 0,
        cropT: num(x.CroppedAreaTopPixels) ?? 0,
        heading: num(x.PoseHeadingDegrees) ?? null,
      };
    }
  } catch {
    /* No readable metadata: locations and dates get set by hand. */
  }
  return meta;
}

export interface Rung {
  width: number;
  canvas: HTMLCanvasElement;
  blob: Blob;
}

export interface Qualities {
  /** The first width given: the photo at its own resolution, the one people look at. */
  full: number;
  /** Every smaller width. */
  rung: number;
}

/** Each width, decoded straight to that size (a 200 MP original is never held at full
 *  resolution more than once), with blurs baked in, as JPEG. */
export async function makeRungs(
  source: Blob, srcW: number, srcH: number, widths: number[], blurs: Blur[],
  q: Qualities = { full: 0.92, rung: 0.85 },
): Promise<Rung[]> {
  const out: Rung[] = [];
  for (const w of widths) {
    const h = Math.round((srcH * w) / srcW);
    const bmp = await createImageBitmap(source, w === srcW ? undefined : { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    const canvas = bakeTo(bmp, w, h, blurs);
    bmp.close();
    out.push({ width: w, canvas, blob: await canvasToJpeg(canvas, w === widths[0] ? q.full : q.rung) });
  }
  return out;
}

/** The 2:1 strip a minimap draws. */
export function mapStrip(from: HTMLCanvasElement, w = 560, h = 280, quality = 0.8): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(from, 0, 0, w, h);
  return canvasToJpeg(c, quality);
}

/** PUT to a signed bucket URL, with upload progress (fetch has none). */
export function putSigned(url: string, body: Blob, contentType: string, onProgress?: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = e => onProgress?.(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`The bucket refused the upload (HTTP ${xhr.status})`)));
    // A CORS refusal arrives here with no detail; the usual cause is the bucket's CORS rules.
    xhr.onerror = () => reject(new Error("The upload could not reach the bucket. Check its CORS rules allow PUT from this site."));
    xhr.send(body);
  });
}
