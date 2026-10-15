import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPano, readJpegHeader } from "../header.ts";
import { editedPath, isEditedName, isHiddenDir, isInside, sidecarPath, workCopyPath, workRelative } from "../paths.ts";

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

  it("names its copies beside the original, never as the original", () => {
    const o = p("04_10_2026_paris", "IMG_1.jpg");
    expect(editedPath(o)).toBe(p("04_10_2026_paris", "IMG_1_edited.jpg"));
    expect(sidecarPath(o)).toBe(p("04_10_2026_paris", "IMG_1.pano.json"));
    expect(editedPath(p("a", "IMG.JPEG"))).toBe(p("a", "IMG_edited.jpg"));
    expect(isEditedName("IMG_1_edited.jpg")).toBe(true);
    expect(isEditedName("IMG_1_Edited.JPG")).toBe(true);
    expect(isEditedName("IMG_1.jpg")).toBe(false);
  });

  it("puts PhotoCraft's copy in the working folder under the trip folder's name", () => {
    const work = win ? "D:\\Work" : "/work";
    const copy = workCopyPath(p("08_10_2026_rome", "IMG_7.jpg"), work);
    expect(copy).toBe(path.join(work, "08_10_2026_rome", "IMG_7.jpg"));
    expect(workRelative(editedPath(copy), work)).toBe("08_10_2026_rome/IMG_7_edited.jpg");
  });

  it("skips folders nobody browses", () => {
    expect(isHiddenDir("$RECYCLE.BIN")).toBe(true);
    expect(isHiddenDir("System Volume Information")).toBe(true);
    expect(isHiddenDir(".git")).toBe(true);
    expect(isHiddenDir("04_10_2026_paris")).toBe(false);
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
