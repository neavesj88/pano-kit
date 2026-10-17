import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPano, readJpegHeader } from "../header.ts";
import { cleanTags, detailsFromRecipe, isLinkUrl } from "../details.ts";
import { PRESET_SLOTS, readPresets } from "../presets.ts";
import { editedPath, isEditedName, isHiddenDir, isInside, overlayFileName, sidecarPath, workCopyPath, workRelative } from "../paths.ts";

const win = process.platform === "win32";
const root = win ? "E:\\" : "/photos";
const p = (...parts: string[]) => path.join(root, ...parts);

describe("paths", () => {
  it("keeps to its roots, whatever the path says", () => {
    expect(isInside(root, p("04_10_2026_paris", "IMG_1.jpg"))).toBe(true);
    expect(isInside(p("trip"), p("trip"))).toBe(true);
    expect(isInside(p("trip"), p("trip", "..", "other", "x.jpg"))).toBe(false);
    expect(isInside(p("trip"), p("trip-2", "x.jpg"))).toBe(false);
    if (win) expect(isInside("E:\\Trip", "e:\\trip\\IMG.JPG")).toBe(true);
  });

  it("saves copies as edited\\Edited_<name>.jpg beside the original, never as the original", () => {
    const o = p("04_10_2026_paris", "pano", "IMG_1.jpg");
    expect(editedPath(o)).toBe(p("04_10_2026_paris", "pano", "edited", "Edited_IMG_1.jpg"));
    expect(sidecarPath(o)).toBe(p("04_10_2026_paris", "pano", "IMG_1.pano.json"));
    expect(editedPath(p("a", "IMG.JPEG"))).toBe(p("a", "edited", "Edited_IMG.jpg"));
    expect(isEditedName("Edited_IMG_1.jpg")).toBe(true);
    expect(isEditedName(editedPath(o))).toBe(true);
    // Copies named the old way are still copies, never originals.
    expect(isEditedName("IMG_1_edited.jpg")).toBe(true);
    expect(isEditedName("IMG_1.jpg")).toBe(false);
    expect(isEditedName("Edited_.jpg")).toBe(false);
  });

  it("puts PhotoCraft's copy in the working folder under the trip folder's name", () => {
    const work = win ? "D:\\Work" : "/work";
    const copy = workCopyPath(p("08_10_2026_rome", "IMG_7.jpg"), work);
    expect(copy).toBe(path.join(work, "08_10_2026_rome", "IMG_7.jpg"));
    expect(workRelative(editedPath(copy), work)).toBe("08_10_2026_rome/edited/Edited_IMG_7.jpg");
  });

  it("keeps the folders below the root, so two trips' pano folders stay apart", () => {
    const work = win ? "D:\Work" : "/work";
    const a = workCopyPath(p("27_09_2026_berlin", "pano", "IMG_1.jpg"), work, [root]);
    const b = workCopyPath(p("08_10_2026_rome", "pano", "IMG_1.jpg"), work, [root]);
    expect(a).toBe(path.join(work, "27_09_2026_berlin", "pano", "IMG_1.jpg"));
    expect(a).not.toBe(b);
  });

  it("skips folders nobody browses", () => {
    expect(isHiddenDir("$RECYCLE.BIN")).toBe(true);
    expect(isHiddenDir("System Volume Information")).toBe(true);
    expect(isHiddenDir(".git")).toBe(true);
    expect(isHiddenDir("04_10_2026_paris")).toBe(false);
    expect(isHiddenDir("IMG_1.overlays")).toBe(true);
    expect(isHiddenDir("edited")).toBe(true);
    expect(isHiddenDir("edited photos")).toBe(false);
  });

  it("makes dropped-in photo names safe and keeps only image types", () => {
    expect(overlayFileName("Raising a flag (1945)?.JPG")).toBe("Raising a flag _1945_.jpg");
    expect(overlayFileName("..\\..\\evil.png")).toBe("evil.png");
    expect(overlayFileName("../../evil.png")).toBe("evil.png");
    expect(overlayFileName("notes.txt")).toBeNull();
  });
});

const seg = (marker: number, body: number[] | string) => {
  const b = typeof body === "string" ? [...body].map(c => c.charCodeAt(0)) : body;
  return [0xff, marker, (b.length + 2) >> 8, (b.length + 2) & 0xff, ...b];
};
const sof = (w: number, h: number) => seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const jpeg = (...s: number[][]) => new Uint8Array([0xff, 0xd8, ...s.flat(), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0xff, 0xd9]);

describe("header", () => {
  it("reads the size and the equirect tag without decoding", () => {
    const xmp = seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<rdf GPano:ProjectionType="equirectangular"/>');
    const h = readJpegHeader(jpeg(xmp, sof(8000, 4000)))!;
    expect(h).toEqual({ width: 8000, height: 4000, equirect: true });
    expect(isPano(h)).toBe(true);
  });

  it("calls a 4:3 photo flat and a 2:1 one a 360 even untagged", () => {
    expect(isPano(readJpegHeader(jpeg(sof(7040, 5288)))!)).toBe(false);
    expect(isPano(readJpegHeader(jpeg(sof(6000, 3000)))!)).toBe(true);
  });

  it("asks for more bytes when the frame header is beyond what was read", () => {
    const full = jpeg(seg(0xe1, "Exif\0\0" + "x".repeat(500)), sof(100, 50));
    expect(readJpegHeader(full.subarray(0, 200))).toBeNull();
    expect(() => readJpegHeader(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a JPEG/);
  });
});

describe("details", () => {
  it("turns a recipe into what goes in the file, dropping what neaves.au would refuse", () => {
    const d = detailsFromRecipe({
      title: "  Reichstag  ", description: "Roof", place: "Berlin", tags: ["a", "A", " b ", ""], rating: 4,
      location: { lat: 52.5, lng: 13.4, approx: true }, start: { yaw: 10, pitch: 5, fov: 80 },
      hotspots: [{ yaw: 1, pitch: 2, text: " Flag " }, { yaw: 1, pitch: 2, text: "  " }], linkUrl: "https://example.org", linkLabel: "More",
    });
    expect(d).toEqual({
      title: "Reichstag", description: "Roof", place: "Berlin", tags: ["a", "b"], rating: 4, location: { lat: 52.5, lng: 13.4 },
      gallery: { start: { yaw: 10, pitch: 5, fov: 80 }, hotspots: [{ yaw: 1, pitch: 2, text: "Flag" }], linkUrl: "https://example.org", linkLabel: "More" },
    });
  });

  it("leaves out defaults and anything malformed", () => {
    expect(detailsFromRecipe({ start: { yaw: 0, pitch: 0, fov: 75 }, rating: 0, location: { lat: 99, lng: 0 }, linkUrl: "javascript:alert(1)", linkLabel: "x" })).toEqual({});
    expect(detailsFromRecipe(null)).toEqual({});
    expect(isLinkUrl("https://a.b/c")).toBe(true);
    expect(isLinkUrl("ftp://a")).toBe(false);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => "t" + i))).toHaveLength(20);
  });
});

describe("presets", () => {
  it("always has three slots, empty ones null, grades made whole and in range", () => {
    expect(readPresets(null)).toEqual([null, null, null]);
    const got = readPresets({ slots: [{ name: "  Warm lift ", grade: { exposure: 9, vibrance: 20 } }, null, { grade: {} }, { name: "fourth", grade: {} }] });
    expect(got).toHaveLength(PRESET_SLOTS);
    expect(got[0]?.name).toBe("Warm lift");
    expect(got[0]?.grade.exposure).toBe(3);
    expect(got[0]?.grade.vibrance).toBe(20);
    expect(got[0]?.grade.contrast).toBe(0);
    expect(got[1]).toBeNull();
    expect(got[2]?.name).toBe("Preset 3");
  });

  it("ignores junk in a slot", () => {
    expect(readPresets([{ name: "x" }, "y", 3])).toEqual([null, null, null]);
  });
});

