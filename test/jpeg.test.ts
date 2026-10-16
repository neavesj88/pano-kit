import { describe, expect, it } from "vitest";
import { buildXmp, freshenExif, gpanoProperties, jpegSegments, withMetadata, type PhotoDetails } from "../src/jpeg";
import { readGallery, readPhotoMeta } from "../src/derive";

const bytes = (...parts: (number[] | Uint8Array | string)[]) =>
  new Uint8Array(parts.flatMap(p => (typeof p === "string" ? [...p].map(c => c.charCodeAt(0)) : [...p])));
/** A marker segment: FF, marker, big-endian length (counting itself), body. */
const seg = (marker: number, ...body: (number[] | string)[]) => {
  const b = bytes(...body);
  return bytes([0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff], b);
};

/** Little-endian EXIF: IFD0 with Orientation and Make, pointing on to an IFD1. */
function exifSegment(orientation: number, nextIfd: number) {
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD0 at 8
    0x02, 0x00, // two entries
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation SHORT
    0x0f, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x4c, 0x75, 0x6e, 0x00, // Make "Lun"
    nextIfd & 0xff, 0x00, 0x00, 0x00, // next IFD
  ];
  return seg(0xe1, "Exif\0\0", tiff);
}
const xmp = seg(0xe1, "http://ns.adobe.com/xap/1.0/\0", '<x:xmpmeta GPano:ProjectionType="equirectangular"/>');
const sos = seg(0xda, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
const scanData = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0xd9];

const original = bytes([0xff, 0xd8], exifSegment(6, 0x40), xmp, seg(0xdb, [0, 1, 2]), seg(0xc0, [8, 0, 4]), sos, scanData);
const encoded = bytes([0xff, 0xd8], seg(0xe0, "JFIF\0", [1, 1, 0]), seg(0xdb, [9, 9, 9]), seg(0xc0, [8, 0, 8]), sos, [0xaa, 0xbb, 0xff, 0xd9]);

describe("jpeg", () => {
  it("lists segments up to the scan", () => {
    const { segments, scanStart } = jpegSegments(original);
    expect(segments.map(s => s.marker)).toEqual([0xe1, 0xe1, 0xdb, 0xc0, 0xda]);
    expect([...original.subarray(scanStart)]).toEqual(scanData);
  });

  it("refuses what is not a JPEG", () => {
    expect(() => jpegSegments(bytes("PNG"))).toThrow(/Not a JPEG/);
    expect(() => jpegSegments(bytes([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40, 1, 2]))).toThrow(/cut short/);
  });

  it("puts the original's EXIF and XMP on the new pixels, and drops the encoder's JFIF", () => {
    const out = withMetadata(encoded, original);
    const { segments, scanStart } = jpegSegments(out);
    expect(segments.map(s => s.marker)).toEqual([0xe1, 0xe1, 0xdb, 0xc0, 0xda]);
    // The new image's own tables and pixels, untouched.
    expect([...out.subarray(segments[2].start, segments[2].end)]).toEqual([...seg(0xdb, [9, 9, 9])]);
    expect([...out.subarray(scanStart)]).toEqual([0xaa, 0xbb, 0xff, 0xd9]);
    expect(new TextDecoder().decode(out)).toContain('GPano:ProjectionType="equirectangular"');
  });

  it("sets orientation to 1 and unlinks the old thumbnail, on a copy only", () => {
    const out = withMetadata(encoded, original);
    const e = jpegSegments(out).segments[0];
    const orientationAt = e.start + 10 + 8 + 2 + 8;
    expect(out[orientationAt]).toBe(1);
    expect(out[e.start + 10 + 8 + 2 + 24]).toBe(0);
    // The original's bytes are not changed.
    expect(original[jpegSegments(original).segments[0].start + 10 + 8 + 2 + 8]).toBe(6);
  });

  it("leaves an upright EXIF with no thumbnail as it was", () => {
    const s = exifSegment(1, 0);
    expect(freshenExif(s)).toEqual({ orientation: false, thumbnail: false });
  });

  it("copes with an original that has no metadata", () => {
    const bare = bytes([0xff, 0xd8], seg(0xdb, [0]), sos, [1, 0xff, 0xd9]);
    const out = withMetadata(encoded, bare);
    expect(jpegSegments(out).segments.map(s => s.marker)).toEqual([0xdb, 0xc0, 0xda]);
  });

  const details: PhotoDetails = {
    title: "The Reichstag & me",
    description: "Roof terrace.\nWhere the 1945 photo was taken.",
    tags: ["berlin", "ww2", "then & now"],
    rating: 4,
    place: "Reichstag roof, Berlin",
    location: { lat: 52.518623, lng: -13.376198 },
    gallery: { start: { yaw: -46, pitch: 12, fov: 80 }, hotspots: [{ yaw: 10, pitch: 5, text: "Soviet flag, 2 May 1945" }], linkUrl: "https://example.org/a?b=1&c=2", linkLabel: "Read more" },
  };
  const read = (b: Uint8Array) => readPhotoMeta(new Blob([b]));

  it("writes details a gallery reads back, and keeps the camera's own metadata", async () => {
    const meta = await read(withMetadata(encoded, original, details));
    expect(meta.title).toBe("The Reichstag & me");
    expect(meta.description).toBe("Roof terrace.\nWhere the 1945 photo was taken.");
    expect(meta.tags).toEqual(["berlin", "ww2", "then & now"]);
    expect(meta.rating).toBe(4);
    expect(meta.place).toBe("Reichstag roof, Berlin");
    expect(meta.lat).toBeCloseTo(52.518623, 5);
    expect(meta.lng).toBeCloseTo(-13.376198, 5);
    expect(meta.gallery).toEqual(details.gallery);
    expect(meta.camera).toBe("Lun");
    const out = withMetadata(encoded, original, details);
    expect(gpanoProperties(new TextDecoder().decode(out))).toContainEqual(["ProjectionType", "equirectangular"]);
  });

  it("adds GPS to a file that had no EXIF at all", async () => {
    const bare = bytes([0xff, 0xd8], seg(0xdb, [0]), sos, [1, 0xff, 0xd9]);
    const meta = await read(withMetadata(bare, bare, { location: { lat: -31.95, lng: 115.86 } }));
    expect(meta.lat).toBeCloseTo(-31.95, 5);
    expect(meta.lng).toBeCloseTo(115.86, 5);
  });

  it("keeps pixels untouched when the original is passed as the image too", () => {
    const out = withMetadata(original, original, { title: "x" });
    const a = jpegSegments(original), b = jpegSegments(out);
    expect([...out.subarray(b.scanStart)]).toEqual([...original.subarray(a.scanStart)]);
  });

  it("reads nothing into a file with no details, and ignores a malformed gallery field", async () => {
    const meta = await read(withMetadata(encoded, original));
    expect([meta.title, meta.description, meta.rating, meta.place, meta.gallery]).toEqual([null, null, null, null, null]);
    expect(meta.tags).toEqual([]);
    expect(readGallery("{not json")).toBeNull();
    expect(readGallery(JSON.stringify({ start: { yaw: "x" }, hotspots: [{ text: 3 }, { yaw: 1, pitch: 2, text: "ok" }] }))).toEqual({ hotspots: [{ yaw: 1, pitch: 2, text: "ok" }] });
  });

  it("escapes what it writes, so a title cannot break the XML", () => {
    const xmp = buildXmp(null, { title: 'a "<b>" & c' });
    expect(xmp).toContain("a &quot;&lt;b&gt;&quot; &amp; c");
    expect(() => withMetadata(encoded, original, { description: "x".repeat(70000) })).toThrow(/too long/);
  });
});

