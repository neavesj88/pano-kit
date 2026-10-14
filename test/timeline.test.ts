import { describe, it, expect } from "vitest";
import { locateAt, parseTimeline, readLatLng, readTime } from "../src/timeline";

/* Shapes from documented exports (field names and spellings as published for
 * the phone export, Records.json and Semantic Location History); the values
 * are made up, on the Salzburg day of a trip. */

const PHONE = {
  semanticSegments: [
    {
      startTime: "2026-09-25T07:30:00.000+02:00",
      endTime: "2026-09-25T08:00:00.000+02:00",
      timelinePath: [
        { point: "47.8095°, 13.0550°", time: "2026-09-25T07:30:00.000+02:00" },
        { point: "47.8070°, 13.0480°", time: "2026-09-25T07:45:00.000+02:00" },
      ],
    },
    {
      startTime: "2026-09-25T08:00:00.000+02:00",
      endTime: "2026-09-25T09:10:00.000+02:00",
      startTimeTimezoneUtcOffsetMinutes: 120,
      visit: { hierarchyLevel: 0, probability: 0.85, topCandidate: { placeId: "x", semanticType: "UNKNOWN", probability: 0.45, placeLocation: { latLng: "47.8058°, 13.0418°" } } },
    },
    {
      startTime: "2026-09-25T09:10:00.000+02:00",
      endTime: "2026-09-25T09:40:00.000+02:00",
      activity: { start: { latLng: "47.8058°, 13.0418°" }, end: { latLng: "47.7980°, 13.0470°" }, topCandidate: { type: "WALKING" } },
    },
  ],
  rawSignals: [
    { position: { LatLng: "47.7990°, 13.0460°", accuracyMeters: 13, altitudeMeters: 430, source: "WIFI", timestamp: "2026-09-25T09:35:00.000+02:00", speedMetersPerSecond: 0.07 } },
    { wifiScan: { devicesRecords: [{ mac: 1, rawRssi: -60 }] } },
  ],
  userLocationProfile: { frequentPlaces: [{ placeId: "h", placeLocation: "-31.95°, 115.86°", label: "HOME" }] },
};

/** The camera's clock read, as the site stores a photo with no timezone. */
const clock = (s: string) => Date.parse(`${s}Z`);

describe("reading a Timeline export", () => {
  it("reads coordinates however the export spells them", () => {
    expect(readLatLng("47.8058°, 13.0418°")).toEqual({ lat: 47.8058, lng: 13.0418 });
    expect(readLatLng("geo:47.8058,13.0418")).toEqual({ lat: 47.8058, lng: 13.0418 });
    expect(readLatLng({ latitudeE7: 478058000, longitudeE7: 130418000 })).toEqual({ lat: 47.8058, lng: 13.0418 });
    expect(readLatLng({ latE7: -319500000, lngE7: 1158600000 })).toEqual({ lat: -31.95, lng: 115.86 });
    expect(readLatLng({ latLng: "47.8°, 13.0°" })).toEqual({ lat: 47.8, lng: 13 });
    expect(readLatLng("somewhere")).toBeNull();
    expect(readLatLng("0°, 0°")).toBeNull();
  });

  it("keeps times on the local clock when the export gives the offset, and says when it is UTC", () => {
    expect(readTime("2026-09-25T08:13:00.000+02:00")).toEqual({ t: clock("2026-09-25T08:13:00"), local: true });
    expect(readTime("2026-09-25T06:13:00.000Z")).toEqual({ t: clock("2026-09-25T06:13:00"), local: false });
    expect(readTime("1790000000000")).toEqual({ t: 1790000000000, local: false });
    expect(readTime("not a time")).toBeNull();
  });

  it("takes visits, activities, paths and raw signals from the phone export, oldest first", () => {
    const fixes = parseTimeline(PHONE);
    expect(fixes.map(f => f.kind)).toEqual(["path", "path", "visit", "activity", "raw", "activity"]);
    expect(fixes.every(f => f.local)).toBe(true);
    expect(fixes.find(f => f.kind === "visit")).toMatchObject({ lat: 47.8058, lng: 13.0418, t: clock("2026-09-25T08:00:00"), until: clock("2026-09-25T09:10:00") });
  });

  it("takes the bare-array spelling with geo: strings and path times in minutes from the start", () => {
    const fixes = parseTimeline([
      { startTime: "2026-09-25T08:00:00.000+02:00", endTime: "2026-09-25T09:00:00.000+02:00", visit: { topCandidate: { placeLocation: "geo:47.805800,13.041800" } } },
      { startTime: "2026-09-25T09:00:00.000+02:00", endTime: "2026-09-25T10:00:00.000+02:00", timelinePath: [{ point: "geo:47.79,13.05", durationMinutesOffsetFromStartTime: "20" }] },
    ]);
    expect(fixes).toEqual([
      { lat: 47.8058, lng: 13.0418, t: clock("2026-09-25T08:00:00"), until: clock("2026-09-25T09:00:00"), kind: "visit", local: true },
      { lat: 47.79, lng: 13.05, t: clock("2026-09-25T09:20:00"), kind: "path", local: true },
    ]);
  });

  it("takes Takeout's Records.json and Semantic Location History, in UTC", () => {
    const records = parseTimeline({ locations: [{ latitudeE7: 478058000, longitudeE7: 130418000, accuracy: 22, timestamp: "2026-09-25T06:13:00.000Z" }] });
    expect(records).toEqual([{ lat: 47.8058, lng: 13.0418, t: Date.parse("2026-09-25T06:13:00Z"), kind: "raw", local: false }]);
    const semantic = parseTimeline({ timelineObjects: [{ placeVisit: { location: { latitudeE7: 478058000, longitudeE7: 130418000 }, duration: { startTimestamp: "2026-09-25T06:00:00Z", endTimestamp: "2026-09-25T07:00:00Z" } } }] });
    expect(semantic[0]).toMatchObject({ kind: "visit", local: false, lat: 47.8058 });
  });

  it("gives nothing, not an error, for something that is not an export", () => {
    expect(parseTimeline(null)).toEqual([]);
    expect(parseTimeline({ hello: "world" })).toEqual([]);
    expect(parseTimeline("text")).toEqual([]);
  });
});

describe("placing a photo by the time it was taken", () => {
  const fixes = parseTimeline(PHONE);

  it("puts a photo taken during a visit at the visit's place", () => {
    expect(locateAt(fixes, clock("2026-09-25T08:13:35"))).toEqual({ lat: 47.8058, lng: 13.0418, gapMin: 0, kind: "visit" });
  });

  it("puts one taken on the move between the fixes either side, by time", () => {
    const m = locateAt(fixes, clock("2026-09-25T07:37:30"))!;
    expect(m.kind).toBe("between");
    expect(m.lat).toBeCloseTo(47.80825, 5);
    expect(m.lng).toBeCloseTo(13.0515, 5);
    expect(m.gapMin).toBeCloseTo(7.5, 5);
  });

  it("measures from where a visit ended, not from when it began", () => {
    const m = locateAt(fixes, clock("2026-09-25T09:15:00"))!;
    expect(m.gapMin).toBeCloseTo(5, 5);
  });

  it("uses the nearer fix alone when the other side is too far, and nothing when both are", () => {
    const early = locateAt(fixes, clock("2026-09-25T07:10:00"))!;
    expect(early).toMatchObject({ lat: 47.8095, lng: 13.055, kind: "path" });
    expect(early.gapMin).toBeCloseTo(20, 5);
    expect(locateAt(fixes, clock("2026-09-25T05:00:00"))).toBeNull();
    expect(locateAt(fixes, clock("2026-09-25T12:00:00"))).toBeNull();
    expect(locateAt(fixes, clock("2026-09-25T05:00:00"), 180)).not.toBeNull();
  });
});
