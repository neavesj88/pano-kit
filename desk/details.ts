/* A photo's recipe (<name>.pano.json) as the details pano-kit jpeg writes into
 * its _edited.jpg: name, description, tags, rating, place, map location, and
 * the gallery's start view, labels and read-more link. Shared by the page
 * (limits for its inputs) and the server (which writes the file). */
import type { PhotoDetails } from "../src/jpeg.ts";

/** neaves.au's own limits, so an upload is never refused over one field. */
export const LIMITS = { title: 200, description: 5000, place: 200, tags: 20, tag: 40, hotspots: 50, hotspotText: 120, linkUrl: 500, linkLabel: 80 } as const;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const finite = (...v: unknown[]) => v.every(x => typeof x === "number" && Number.isFinite(x));

/** Tags as a gallery keeps them: trimmed, no repeats ignoring case, within the limits. */
export function cleanTags(list: unknown[]): string[] {
  const out: string[] = [];
  for (const t of list) {
    const v = text(t, LIMITS.tag);
    if (v && !out.some(o => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out.slice(0, LIMITS.tags);
}

/** A web address only: nothing that runs when opened (as neaves.au checks it). */
export const isLinkUrl = (s: string) => s.length <= LIMITS.linkUrl && /^https?:\/\/\S+$/i.test(s);

export function detailsFromRecipe(r: any): PhotoDetails {
  if (!r || typeof r !== "object") return {};
  const d: PhotoDetails = {};
  const title = text(r.title, LIMITS.title), description = text(r.description, LIMITS.description), place = text(r.place, LIMITS.place);
  if (title) d.title = title;
  if (description) d.description = description;
  if (place) d.place = place;
  const tags = Array.isArray(r.tags) ? cleanTags(r.tags) : [];
  if (tags.length) d.tags = tags;
  if (Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5) d.rating = r.rating;
  const l = r.location;
  if (l && finite(l.lat, l.lng) && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180) d.location = { lat: l.lat, lng: l.lng };
  const gallery: NonNullable<PhotoDetails["gallery"]> = {};
  const s = r.start;
  if (s && finite(s.yaw, s.pitch, s.fov) && !(s.yaw === 0 && s.pitch === 0 && s.fov === 75)) gallery.start = { yaw: s.yaw, pitch: s.pitch, fov: s.fov };
  const spots = Array.isArray(r.hotspots)
    ? r.hotspots.filter((h: any) => h && finite(h.yaw, h.pitch) && typeof h.text === "string" && h.text.trim())
      .slice(0, LIMITS.hotspots).map((h: any) => ({ yaw: h.yaw, pitch: h.pitch, text: h.text.trim().slice(0, LIMITS.hotspotText) }))
    : [];
  if (spots.length) gallery.hotspots = spots;
  const url = text(r.linkUrl, LIMITS.linkUrl);
  if (url && isLinkUrl(url)) {
    gallery.linkUrl = url;
    const label = text(r.linkLabel, LIMITS.linkLabel);
    if (label) gallery.linkLabel = label;
  }
  if (Object.keys(gallery).length) d.gallery = gallery;
  return d;
}
