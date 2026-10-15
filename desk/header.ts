/* A JPEG's pixel size and whether it says it is an equirect, from its first
 * few hundred kilobytes, without decoding it. */

export interface JpegHeader {
  width: number;
  height: number;
  /** GPano ProjectionType=equirectangular in its XMP. */
  equirect: boolean;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PROJECTION = /ProjectionType(?:="|>)\s*equirectangular/;

/** Null when the bytes run out before the frame header (read more and try again). */
export function readJpegHeader(b: Uint8Array): JpegHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error("Not a JPEG file");
  let equirect = false;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error(`Bad JPEG marker at byte ${i}`);
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (SOF.has(marker)) {
      if (i + 9 > b.length) return null;
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], equirect };
    }
    if (marker === 0xda) throw new Error("JPEG has no frame header");
    if (marker === 0xe1 && i + 2 + len <= b.length) {
      const body = new TextDecoder("latin1").decode(b.subarray(i + 4, i + 2 + len));
      if (body.startsWith("http://ns.adobe.com/") && PROJECTION.test(body)) equirect = true;
    }
    i += 2 + len;
  }
  return null;
}

/** 2:1 within 5%, as pano-kit core's resolveKind, and/or tagged equirect. */
export const isPano = (h: JpegHeader) => h.equirect || (h.height > 0 && Math.abs(h.width / h.height / 2 - 1) < 0.05);
