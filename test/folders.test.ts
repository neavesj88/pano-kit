import { describe, it, expect } from "vitest";
import { compareFolders, folderKey, parseFolder, shortDate } from "../src/core";

/* The real folder names from the Europe 2026 itinerary. */
const trip = [
  "18_09_2026_perth_departure", "19_09_2026_dubai_transit", "19_09_2026_munich_oktoberfest",
  "25_09_2026_berchtesgaden_eagles_nest", "28_09_2026_munster_panzermuseum", "29_09_2026_muenster_westf",
  "02_10_2026_ypres", "04_10_2026_paris", "08_10_2026_rome_colosseum_forum", "10_10_2026_perth_arrival",
];

describe("parseFolder", () => {
  it("reads the itinerary's DD_MM_YYYY_place names", () => {
    expect(parseFolder("04_10_2026_paris")).toEqual({ key: "04_10_2026_paris", date: "2026-10-04", place: "paris", label: "Paris" });
    expect(parseFolder("08_10_2026_rome_colosseum_forum").label).toBe("Rome Colosseum Forum");
    expect(parseFolder("25_09_2026_berchtesgaden_eagles_nest").date).toBe("2026-09-25");
    for (const f of trip) expect(parseFolder(f).date, f).toMatch(/^2026-(09|10)-\d{2}$/);
  });

  it("also reads YYYY-MM-DD_place", () => {
    expect(parseFolder("2026-10-04_paris")).toMatchObject({ date: "2026-10-04", label: "Paris" });
  });

  it("refuses impossible dates and treats the name as a plain folder", () => {
    expect(parseFolder("31_02_2026_nowhere").date).toBeNull();
    expect(parseFolder("Holiday snaps")).toMatchObject({ date: null, label: "Holiday snaps" });
  });

  it("makes names safe to store", () => {
    expect(folderKey("  Eagle's Nest / Berchtesgaden ")).toBe("Eagle_s Nest_Berchtesgaden");
    expect(folderKey("Köln")).toBe("Koln");
    expect(folderKey("x".repeat(200)).length).toBe(80);
  });
});

describe("folder order and dates", () => {
  it("runs the trip in date order, undated folders last", () => {
    const shuffled = ["Misc", ...trip].reverse();
    expect([...shuffled].sort(compareFolders)).toEqual([...trip, "Misc"]);
  });
  it("keeps a day's two places together, by name", () => {
    expect(["19_09_2026_munich_oktoberfest", "19_09_2026_dubai_transit"].sort(compareFolders))
      .toEqual(["19_09_2026_dubai_transit", "19_09_2026_munich_oktoberfest"]);
  });
  it("writes a short date", () => {
    expect(shortDate("2026-10-04")).toBe("4 Oct 2026");
  });
});
