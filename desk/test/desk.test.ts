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


import {
  CLIP_ALLOW, DARK_LIFT, LIFT_MAX, LIFT_MAX_DIM, LIFT_TARGET, LIFT_TARGET_DIM, addGrades, brightShare, bulkGrade, clippedShare, daylight, horizonMedian, inDatedFolder,
  liftMax, liftTarget,
} from "../bulk.ts";
import { DEFAULT_GRADE, applyGrade } from "../../src/grade.ts";
import { blurAt, dragTo } from "../blurs.ts";

/** w by h RGBA, grey `sky` in the top quarter and grey `mid` below it: with a bright sky a
 *  third of the frame above the ground is bright, which reads as daylight. */
const pano = (w: number, h: number, sky: number, mid: number) => {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = y < h / 4 ? sky : mid; px.set([v, v, v, 255], (y * w + x) * 4); }
  return px;
};

describe("bulk", () => {
  const look = { ...DEFAULT_GRADE, vibrance: 30, highlights: -20, whites: -5, contrast: 5 };

  it("aims dark shots at a normal level, easing in under the threshold", () => {
    expect(liftTarget(0.4)).toBeNull();
    expect(liftTarget(0.2)).toBeNull();
    expect(liftTarget(0.1)).toBe(LIFT_TARGET);
    const near = liftTarget(0.19)!;
    expect(near).toBeGreaterThan(0.19);
    expect(near).toBeLessThan(liftTarget(0.17)!);
    expect(liftTarget(0.25, 0.3)).toBeGreaterThan(0.25);
    expect(liftTarget(0.1, 0.2, 0)).toBe(LIFT_TARGET_DIM);
  });

  it("lifts night and dim rooms less, so night stays night", () => {
    expect(daylight(0.02)).toBe(0);
    expect(daylight(0.4)).toBe(1);
    expect(daylight(0.15)).toBeCloseTo(0.5, 5);
    expect(liftMax(0)).toBe(LIFT_MAX_DIM);
    expect(liftMax(1)).toBe(LIFT_MAX);
  });

  it("finds the lift that brings a dark day shot to the target", () => {
    const px = pano(64, 32, 200, 30);
    const b = bulkGrade(look, px, 64, 32);
    expect(b.median).toBeCloseTo(30 / 255, 5);
    expect(b.lift).toBeGreaterThan(0);
    expect(b.lift).toBeLessThanOrEqual(LIFT_MAX);
    expect(b.after!).toBeGreaterThanOrEqual(LIFT_TARGET - 0.01);
    expect(b.grade.vibrance).toBe(30);
    expect(b.grade.exposure).toBeGreaterThan(0);
    // The input is only read.
    expect(px[(20 * 64 + 5) * 4]).toBe(30);
  });

  it("aims a night shot lower, and lifts a very dark one no more than its cap", () => {
    const night = bulkGrade(look, pano(64, 32, 5, 30), 64, 32);
    expect(night.bright).toBe(0);
    expect(night.lift).toBeGreaterThan(0);
    expect(night.lift).toBeLessThan(LIFT_MAX_DIM);
    expect(night.after!).toBeGreaterThanOrEqual(LIFT_TARGET_DIM - 0.01);
    expect(night.after!).toBeLessThan(LIFT_TARGET);
    const black = bulkGrade(look, pano(64, 32, 2, 4), 64, 32);
    expect(black.lift).toBe(LIFT_MAX_DIM);
    expect(black.grade).toEqual(addGrades(look, DARK_LIFT, LIFT_MAX_DIM));
  });

  it("holds a lift back rather than blow out a bright sky", () => {
    // Sky just under clipping over dark ground: daylight, dark, and the lift would clip the sky.
    const px = pano(64, 32, 238, 30);
    const b = bulkGrade(look, px, 64, 32);
    expect(b.held).toBe(true);
    expect(b.after!).toBeLessThan(LIFT_TARGET);
    const out = px.slice();
    applyGrade(out, b.grade);
    const plain = px.slice();
    applyGrade(plain, look);
    expect(clippedShare(out, 64, 32) - clippedShare(plain, 64, 32)).toBeLessThanOrEqual(CLIP_ALLOW);
    // The same ground under a sky with room to spare reaches the target.
    expect(bulkGrade(look, pano(64, 32, 200, 30), 64, 32).held).toBe(false);
  });

  it("leaves normal shots, and runs without pixels, on the look alone", () => {
    expect(bulkGrade(look, pano(64, 32, 200, 120), 64, 32)).toMatchObject({ grade: look, lift: 0 });
    expect(bulkGrade(look, null).grade).toEqual(look);
    expect(bulkGrade(null, null).grade).toEqual(DEFAULT_GRADE);
    expect(addGrades({ ...DEFAULT_GRADE, shadows: 90 }, { ...DEFAULT_GRADE, shadows: 60 }).shadows).toBe(100);
  });

  it("measures the middle band, and the bright share above the ground", () => {
    // 4 rows of 2 pixels: bright sky, two dark middle rows, bright ground.
    const px = new Uint8Array(4 * 2 * 4);
    const row = (y: number, v: number) => { for (let x = 0; x < 2; x++) px.set([v, v, v, 255], (y * 2 + x) * 4); };
    row(0, 250); row(1, 20); row(2, 20); row(3, 250);
    expect(horizonMedian(px, 2, 4)).toBeCloseTo(20 / 255, 5);
    // The bright ground row is left out: one bright row of the top three.
    expect(brightShare(px, 2, 4)).toBeCloseTo(1 / 3, 5);
  });

  it("picks the blur under the pointer, topmost first, across the seam", () => {
    const blurs = [{ yaw: 10, pitch: 0, r: 3 }, { yaw: 11, pitch: 0, r: 3 }, { yaw: 179, pitch: 5, r: 3 }, { u: 0.5, v: 0.5, r: 3 }];
    expect(blurAt(blurs, 11, 0)).toBe(1);
    expect(blurAt(blurs, 7.5, 0)).toBe(0);
    expect(blurAt(blurs, -179, 5)).toBe(2);
    expect(blurAt(blurs, 40, 0)).toBe(-1);
    expect(blurAt([], 0, 0)).toBe(-1);
  });

  it("moves a dragged blur with the grab point under the pointer", () => {
    expect(dragTo({ yaw: 2, pitch: -1 }, 30, 10)).toEqual({ yaw: 32, pitch: 9 });
    expect(dragTo({ yaw: 5, pitch: 0 }, 178, 0)).toEqual({ yaw: -177, pitch: 0 });
    expect(dragTo({ yaw: 0, pitch: 5 }, 0, 88)).toEqual({ yaw: 0, pitch: 90 });
  });

  it("keeps to trip folders named by date, not the sorting folders beside them", () => {
    expect(inDatedFolder("E:\\04_10_2026_paris_town\\pano\\IMG_1.jpg", "E:\\")).toBe(true);
    expect(inDatedFolder("E:\\_sorting_work\\04_10_2026_paris\\IMG_1.jpg", "E:\\")).toBe(false);
    expect(inDatedFolder("E:\\OTHER\\IMG_1.jpg", "E:\\")).toBe(false);
    expect(inDatedFolder("E:\\IMG_1.jpg", "E:\\")).toBe(false);
    expect(inDatedFolder("E:\\04_10_2026_paris\\pano\\IMG_1.jpg", "E:\\04_10_2026_paris")).toBe(true);
    expect(inDatedFolder("/photos/2026-10-04 paris/IMG_1.jpg", "/photos/")).toBe(true);
  });
});
