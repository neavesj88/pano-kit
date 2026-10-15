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

/** The re-encoded image with the original's metadata in place of its own header segments. */
export function withMetadata(encoded: Uint8Array, original: Uint8Array): Uint8Array {
  const enc = jpegSegments(encoded);
  const orig = jpegSegments(original);
  const carried = orig.segments.filter(s => isMetadata(original, s)).map(s => {
    const copy = original.slice(s.start, s.end);
    if (s.marker === 0xe1 && startsWith(original, s.start + 4, "Exif\0\0")) freshenExif(copy);
    return copy;
  });
  // The encoder's own APPn (a JFIF header) goes: JFIF and EXIF both claim to be first.
  const kept = enc.segments.filter(s => !isApp(s.marker)).map(s => encoded.subarray(s.start, s.end));
  const scan = encoded.subarray(enc.scanStart);
  const parts = [new Uint8Array([0xff, SOI]), ...carried, ...kept, scan];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
