import { describe, it, expect } from "vitest";
import { exifDate } from "../src/derive";

describe("exifDate", () => {
  it("uses the camera's offset when it wrote one", () => {
    expect(exifDate("2026:09:20 14:03:11", "+02:00")).toBe("2026-09-20T12:03:11.000Z");
  });
  /* Without an offset the time is the camera's own clock. Kept as written, so
     a photo taken at 23:30 in Munich is still grouped under that day. */
  it("keeps the camera's clock as written when there is no offset", () => {
    expect(exifDate("2026:09:20 23:30:00")).toBe("2026-09-20T23:30:00.000Z");
  });
  it("returns nothing for missing or malformed dates", () => {
    expect(exifDate(undefined)).toBeNull();
    expect(exifDate("0000:00:00 00:00:00")).toBeNull();
    expect(exifDate("yesterday")).toBeNull();
  });
});
