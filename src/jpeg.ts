/* pano-kit jpeg: carrying a photo's metadata onto a re-encoded copy.
 *
 * A JPEG made by a canvas has no metadata at all: no EXIF date or camera, and
 * no GPano XMP, without which other 360 viewers show the copy as a flat
 * picture. This copies the original's metadata segments into the new file,
 * byte for byte, without decoding either image. No imports and no DOM, so a
 * server can use it as well as a browser.
 */

export interface Segment {
  marker: number;
  /** Offset of the segment's 0xFF, and the offset just past its last byte. */
  start: number;
  end: number;
}

const SOI = 0xd8, SOS = 0xda, EOI = 0xd9;
const isApp = (m: number) => m >= 0xe0 && m <= 0xef;

/** The segments from just after SOI up to and including SOS's header, and where the
 *  entropy-coded data begins. Throws on anything that is not a JPEG. */
export function jpegSegments(b: Uint8Array): { segments: Segment[]; scanStart: number } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) throw new Error("Not a JPEG file");
  const segments: Segment[] = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`Bad JPEG marker at byte ${i}`);
    let j = i;
    while (b[j] === 0xff) j++;
    const marker = b[j];
    if (marker === EOI) throw new Error("JPEG ends before its image data");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (j + 2 >= b.length) throw new Error("JPEG cut short");
    const len = (b[j + 1] << 8) | b[j + 2];
    const end = j + 1 + len;
    if (len < 2 || end > b.length) throw new Error("JPEG cut short");
    segments.push({ marker, start: i, end });
    if (marker === SOS) return { segments, scanStart: end };
    i = end;
  }
  throw new Error("JPEG has no image data");
}

const startsWith = (b: Uint8Array, at: number, text: string) => {
  for (let k = 0; k < text.length; k++) if (b[at + k] !== text.charCodeAt(k)) return false;
  return true;
};

/** Which segments are worth carrying: EXIF and XMP (APP1), ICC colour profile (APP2), IPTC (APP13). */
export function isMetadata(b: Uint8Array, s: Segment): boolean {
  const body = s.start + 4;
  if (s.marker === 0xe1) return startsWith(b, body, "Exif\0\0") || startsWith(b, body, "http://ns.adobe.com/");
  if (s.marker === 0xe2) return startsWith(b, body, "ICC_PROFILE\0");
  if (s.marker === 0xed) return startsWith(b, body, "Photoshop 3.0\0");
  return false;
}

/**
 * In an EXIF segment (a copy, changed in place): set Orientation to 1, because the
 * new pixels are already the right way up, and cut the link to the embedded
 * thumbnail (IFD1), which would still show the old picture. Returns what it changed.
 */
export function freshenExif(seg: Uint8Array): { orientation: boolean; thumbnail: boolean } {
  const done = { orientation: false, thumbnail: false };
  const t = 10; // 0xFF E1, length (2), "Exif\0\0" (6): the TIFF header starts here
  if (seg.length < t + 8) return done;
  const le = seg[t] === 0x49 && seg[t + 1] === 0x49;
  if (!le && !(seg[t] === 0x4d && seg[t + 1] === 0x4d)) return done;
  const u16 = (o: number) => (le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1]);
  const u32 = (o: number) => (le ? (seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16)) + seg[o + 3] * 2 ** 24 : seg[o] * 2 ** 24 + ((seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]));
  const ifd0 = t + u32(t + 4);
  if (ifd0 + 2 > seg.length) return done;
  const n = u16(ifd0);
  for (let k = 0; k < n; k++) {
    const e = ifd0 + 2 + k * 12;
    if (e + 12 > seg.length) return done;
    if (u16(e) === 0x0112 && u16(e + 8) !== 1) {
      seg[e + 8] = le ? 1 : 0;
      seg[e + 9] = le ? 0 : 1;
      done.orientation = true;
    }
  }
  const next = ifd0 + 2 + n * 12;
  if (next + 4 <= seg.length && u32(next) !== 0) {
    seg.fill(0, next, next + 4);
    done.thumbnail = true;
  }
  return done;
}

/* --------------------------------------------------------- details */

/** What a person says about a photo, written into its file so any gallery (or
 *  Lightroom, or Google Photos) reads it from the photo itself. Title,
 *  description, keywords, rating and place go in the standard XMP fields; the
 *  location goes in EXIF GPS, which is what everything reads; what only a 360
 *  gallery needs (start view, labels, a link) goes in pano-kit's own XMP field. */
export interface PhotoDetails {
  title?: string;
  description?: string;
  tags?: string[];
  /** 0 to 5 stars. */
  rating?: number;
  place?: string;
  location?: { lat: number; lng: number } | null;
  gallery?: GalleryDetails | null;
}

export interface GalleryDetails {
  start?: { yaw: number; pitch: number; fov: number };
  hotspots?: ({ yaw: number; pitch: number; text: string } | { u: number; v: number; text: string })[];
  linkUrl?: string | null;
  linkLabel?: string | null;
}

/** The namespace of pano-kit's own XMP field, `panokit:Gallery` (JSON). */
export const PANOKIT_NS = "https://github.com/neavesj88/pano-kit/ns/1.0/";
const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";

const xmlEscape = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The original's GPano properties, as written (still XML-escaped), so the copy stays a 360. */
export function gpanoProperties(xmp: string): [string, string][] {
  const out = new Map<string, string>();
  for (const m of xmp.matchAll(/GPano:(\w+)\s*=\s*"([^"]*)"/g)) out.set(m[1], m[2]);
  for (const m of xmp.matchAll(/<GPano:(\w+)>([^<]*)<\/GPano:\1>/g)) out.set(m[1], m[2]);
  return [...out];
}

/** A whole XMP packet: the original's GPano properties and the details. */
export function buildXmp(originalXmp: string | null, d: PhotoDetails): string {
  const attrs = gpanoProperties(originalXmp ?? "").map(([k, v]) => `\n   GPano:${k}="${v}"`);
  if (d.rating != null && Number.isFinite(d.rating)) attrs.push(`\n   xmp:Rating="${Math.max(0, Math.min(5, Math.round(d.rating)))}"`);
  const alt = (tag: string, text?: string) =>
    text ? `\n   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(text)}</rdf:li></rdf:Alt></${tag}>` : "";
  const tags = (d.tags ?? []).filter(Boolean);
  const gallery = d.gallery && Object.values(d.gallery).some(v => v != null && !(Array.isArray(v) && !v.length)) ? JSON.stringify(d.gallery) : null;
  const body = [
    alt("dc:title", d.title),
    alt("dc:description", d.description),
    tags.length ? `\n   <dc:subject><rdf:Bag>${tags.map(t => `<rdf:li>${xmlEscape(t)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>` : "",
    d.place ? `\n   <Iptc4xmpCore:Location>${xmlEscape(d.place)}</Iptc4xmpCore:Location>` : "",
    gallery ? `\n   <panokit:Gallery>${xmlEscape(gallery)}</panokit:Gallery>` : "",
  ].join("");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
   xmlns:panokit="${PANOKIT_NS}"${attrs.join("")}>${body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** A JPEG APP1 segment around a body, or an error if it cannot fit in one (64 KB). */
function app1(body: Uint8Array): Uint8Array {
  if (body.length + 2 > 0xffff) throw new Error("These details are too long to fit in the photo's metadata");
  const seg = new Uint8Array(body.length + 4);
  seg.set([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  seg.set(body, 4);
  return seg;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const TIFF_AT = 10; // 0xFF E1, length, "Exif\0\0": the TIFF block starts here

/**
 * An EXIF segment with GPS latitude and longitude, from the original's (or a
 * new one when it has none). IFD0 is copied to the end of the block with a
 * GPS pointer added and the header pointed at the copy; every other offset
 * stays valid because nothing before it moves.
 */
export function exifWithGps(exif: Uint8Array | null, lat: number, lng: number): Uint8Array {
  let tiff: Uint8Array;
  if (exif) tiff = exif.slice(TIFF_AT);
  else tiff = new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // II, IFD0 at 8: no entries, no next
  const le = tiff[0] === 0x49;
  const r16 = (o: number) => (le ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1]);
  const r32 = (o: number) => (le ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16)) + tiff[o + 3] * 2 ** 24 : tiff[o] * 2 ** 24 + ((tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]));
  const ifd0 = r32(4);
  const n = r16(ifd0);
  const entries: Uint8Array[] = [];
  for (let k = 0; k < n; k++) {
    const e = tiff.slice(ifd0 + 2 + k * 12, ifd0 + 14 + k * 12);
    if ((le ? e[0] | (e[1] << 8) : (e[0] << 8) | e[1]) !== 0x8825) entries.push(e);
  }
  const w16 = (v: number) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const w32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const entry = (tag: number, type: number, count: number, value: number[]) => new Uint8Array([...w16(tag), ...w16(type), ...w32(count), ...value]);
  const pad = tiff.length % 2;
  const newIfd0 = tiff.length + pad;
  const gpsIfd = newIfd0 + 2 + (entries.length + 1) * 12 + 4;
  const GPS_N = 5;
  const latAt = gpsIfd + 2 + GPS_N * 12 + 4, lngAt = latAt + 24;
  entries.push(entry(0x8825, 4, 1, w32(gpsIfd)));
  entries.sort((a, b) => (le ? (a[0] | (a[1] << 8)) - (b[0] | (b[1] << 8)) : ((a[0] << 8) | a[1]) - ((b[0] << 8) | b[1])));
  const dms = (v: number) => {
    const a = Math.abs(v);
    let d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 10000);
    // Rounding can make 60 seconds (or then 60 minutes): carry it rather than write an invalid value.
    if (s >= 600000) { s -= 600000; m++; }
    if (m >= 60) { m -= 60; d++; }
    return [...w32(d), ...w32(1), ...w32(m), ...w32(1), ...w32(s), ...w32(10000)];
  };
  const ascii = (c: string) => [c.charCodeAt(0), 0, 0, 0];
  const gps = [
    entry(0x0000, 1, 4, [2, 3, 0, 0]),
    entry(0x0001, 2, 2, ascii(lat < 0 ? "S" : "N")),
    entry(0x0002, 5, 3, w32(latAt)),
    entry(0x0003, 2, 2, ascii(lng < 0 ? "W" : "E")),
    entry(0x0004, 5, 3, w32(lngAt)),
  ];
  const head = tiff.slice();
  head.set(w32(newIfd0), 4);
  const out = concat(
    head, new Uint8Array(pad),
    new Uint8Array(w16(entries.length)), ...entries, new Uint8Array(4),
    new Uint8Array(w16(GPS_N)), ...gps, new Uint8Array(4),
    new Uint8Array(dms(lat)), new Uint8Array(dms(lng)),
  );
  return app1(concat(utf8("Exif\0\0"), out));
}

/** The re-encoded image with the original's metadata in place of its own header
 *  segments, and any details written in. Pass the original as `encoded` too for a
 *  copy with new details and untouched pixels. */
export function withMetadata(encoded: Uint8Array, original: Uint8Array, details?: PhotoDetails): Uint8Array {
  const enc = jpegSegments(encoded);
  const orig = jpegSegments(original);
  const isExif = (s: Segment) => s.marker === 0xe1 && startsWith(original, s.start + 4, "Exif\0\0");
  const isXmp = (s: Segment) => s.marker === 0xe1 && startsWith(original, s.start + 4, XMP_ID);
  const carried = orig.segments.filter(s => isMetadata(original, s)).map(s => {
    const copy = original.slice(s.start, s.end);
    if (isExif(s)) freshenExif(copy);
    return { s, copy };
  });
  if (details) {
    const loc = details.location;
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
      const exif = carried.find(c => isExif(c.s));
      const withGps = exifWithGps(exif?.copy ?? null, loc.lat, loc.lng);
      if (exif) exif.copy = withGps;
      else carried.unshift({ s: { marker: 0xe1, start: -1, end: -1 }, copy: withGps });
    }
    const xmp = carried.find(c => c.s.start >= 0 && isXmp(c.s));
    const text = xmp ? new TextDecoder().decode(xmp.copy.subarray(4 + XMP_ID.length)) : null;
    const seg = app1(concat(utf8(XMP_ID), utf8(buildXmp(text, details))));
    if (xmp) xmp.copy = seg;
    else carried.push({ s: { marker: 0xe1, start: -1, end: -1 }, copy: seg });
  }
  // The encoder's own APPn (a JFIF header) goes: JFIF and EXIF both claim to be first.
  const kept = enc.segments.filter(s => !isApp(s.marker)).map(s => encoded.subarray(s.start, s.end));
  const scan = encoded.subarray(enc.scanStart);
  return concat(new Uint8Array([0xff, SOI]), ...carried.map(c => c.copy), ...kept, scan);
}
