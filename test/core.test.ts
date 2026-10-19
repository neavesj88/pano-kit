import { describe, it, expect } from "vitest";
import {
  resolveKind, parseLocation, isMapsShortLinkHost, mapsUrl, geoUri, normaliseView, parseViewHash, formatViewHash,
  derivativeWidths, textureCap, pickWidth, firstPaintWidth, capPolygon, sortPanos, groupByDay, slugify, panoKeys,
  isAllowedAssetName, wrap180, uploadStrips,
} from "../src/core";
import { fitBadge, type BadgeLine } from "../src/core";

describe("resolveKind", () => {
  it("treats 2:1 as a panorama and the camera's 4:3 frame as flat", () => {
    expect(resolveKind("auto", 4000, 2000)).toBe("pano");
    expect(resolveKind("auto", 20224, 10112)).toBe("pano");
    expect(resolveKind("auto", 3520, 2644)).toBe("flat"); // the one flat photo in the received set
  });
  it("allows 5% either side of 2:1 and lets the curator override", () => {
    expect(resolveKind("auto", 4000, 2090)).toBe("pano");
    expect(resolveKind("auto", 4000, 1700)).toBe("flat");
    expect(resolveKind("flat", 4000, 2000)).toBe("flat");
    expect(resolveKind("pano", 3000, 2000)).toBe("pano");
  });
});

describe("parseLocation", () => {
  it("reads typed coordinates", () => {
    expect(parseLocation("48.137154, 11.576124")).toEqual({ lat: 48.137154, lng: 11.576124 });
    expect(parseLocation("-31.95,115.86")).toEqual({ lat: -31.95, lng: 115.86 });
  });
  it("reads every shape of Google Maps link the brief lists", () => {
    expect(parseLocation("https://www.google.com/maps/place/Marienplatz/@48.1373932,11.5732545,17z")).toEqual({ lat: 48.1373932, lng: 11.5732545 });
    expect(parseLocation("https://www.google.com/maps/search/?api=1&query=48.1,11.5")).toEqual({ lat: 48.1, lng: 11.5 });
    expect(parseLocation("https://maps.google.com/?q=48.1,11.5")).toEqual({ lat: 48.1, lng: 11.5 });
    expect(parseLocation("https://maps.google.com/?ll=48.1%2C11.5")).toEqual({ lat: 48.1, lng: 11.5 });
    expect(parseLocation("https://www.google.com/maps/place/X/data=!3m1!4b1!4m6!3m5!3d48.1373932!4d11.5754432")).toEqual({ lat: 48.1373932, lng: 11.5754432 });
  });
  it("recognises a short link it cannot read itself", () => {
    expect(parseLocation("https://maps.app.goo.gl/AbCdEf123")).toEqual({ short: true });
  });
  it("refuses nonsense and impossible coordinates", () => {
    expect(parseLocation("somewhere nice")).toBeNull();
    expect(parseLocation("95, 10")).toBeNull();
  });
});

describe("short link hosts", () => {
  /* The server follows these redirects, so anything else must be refused or it
     becomes a way to make the server fetch arbitrary URLs. */
  it("allows only Google's map hosts", () => {
    expect(isMapsShortLinkHost("maps.app.goo.gl")).toBe(true);
    expect(isMapsShortLinkHost("www.google.com")).toBe(true);
    expect(isMapsShortLinkHost("www.google.com.au")).toBe(true);
    expect(isMapsShortLinkHost("evil.example")).toBe(false);
    expect(isMapsShortLinkHost("google.com.evil.example")).toBe(false);
    expect(isMapsShortLinkHost("127.0.0.1")).toBe(false);
  });
});

describe("outbound links", () => {
  it("links by coordinates, and names the place in the Android geo: link", () => {
    expect(mapsUrl(48.1, 11.5)).toBe("https://www.google.com/maps/search/?api=1&query=48.1,11.5");
    expect(geoUri(48.1, 11.5, "Marienplatz")).toBe("geo:48.1,11.5?q=48.1,11.5(Marienplatz)");
  });
});

describe("views", () => {
  it("wraps yaw, clamps pitch and fov, fills gaps", () => {
    expect(normaliseView({ yaw: 190, pitch: 120, fov: 10 })).toEqual({ yaw: -170, pitch: 89, fov: 30 });
    expect(normaliseView(null)).toEqual({ yaw: 0, pitch: 0, fov: 75 });
    expect(wrap180(180)).toBe(-180);
  });
  it("round-trips a shared view link", () => {
    const v = { yaw: -42.5, pitch: 10.2, fov: 60 };
    expect(parseViewHash("#" + formatViewHash(v))).toEqual(v);
    expect(parseViewHash("#p=foo&view=12.3,-4.5,70")).toEqual({ yaw: 12.3, pitch: -4.5, fov: 70 });
    expect(parseViewHash("#nothing")).toBeNull();
  });
});

describe("derivatives", () => {
  it("never upscales, and only makes the rungs a photo is wide enough for", () => {
    expect(derivativeWidths(4000, "pano")).toEqual([4000, 2048]);
    expect(derivativeWidths(20224, "pano")).toEqual([8192, 4096, 2048]);
    expect(derivativeWidths(1800, "pano")).toEqual([1800]);
    expect(derivativeWidths(3520, "flat")).toEqual([3520, 2048]);
    expect(derivativeWidths(6000, "flat")).toEqual([4096, 2048]);
  });
  it("respects the GPU and low-memory phones", () => {
    expect(textureCap(16384)).toBe(8192);
    expect(textureCap(4096)).toBe(4096);
    expect(textureCap(16384, 4)).toBe(4096);
    expect(textureCap(16384, 8)).toBe(8192);
    // An iPhone: a GPU that claims 16384, no deviceMemory, a finger for a pointer.
    expect(textureCap(16384, undefined, true)).toBe(4096);
    // A Mac in Safari: no deviceMemory either, but a mouse.
    expect(textureCap(16384, undefined, false)).toBe(8192);
    // A big Android tablet in Chrome says how much memory it has, and that wins.
    expect(textureCap(16384, 8, true)).toBe(8192);
  });
  it("picks the biggest that fits, and the 2048 for first paint", () => {
    expect(pickWidth([8192, 4096, 2048], 4096)).toBe(4096);
    expect(pickWidth([4000, 2048], 8192)).toBe(4000);
    expect(pickWidth([8192], 4096)).toBe(8192); // nothing fits: smallest available
    expect(pickWidth([], 4096)).toBeNull();
    expect(firstPaintWidth([4000, 2048])).toBe(2048);
    expect(firstPaintWidth([1800])).toBe(1800);
  });
  it("splits a big texture into strips that cover every row once", () => {
    const covers = (strips: [number, number][], h: number) =>
      strips.every(([a, b], i) => a < b && a === (i ? strips[i - 1][1] : 0)) && strips.at(-1)![1] === h;
    const s8000 = uploadStrips(8000, 4000);
    expect(s8000).toHaveLength(16); // 250 rows of 8000 a frame
    expect(s8000[0]).toEqual([0, 250]);
    expect(covers(s8000, 4000)).toBe(true);
    const s4096 = uploadStrips(4096, 2048);
    expect(s4096).toHaveLength(5); // 488 rows a frame, the last one short
    expect(s4096.at(-1)).toEqual([1952, 2048]);
    expect(covers(s4096, 2048)).toBe(true);
    // Wider than the budget still moves a row a frame.
    expect(uploadStrips(3_000_000, 2, 2_000_000)).toEqual([[0, 1], [1, 2]]);
    expect(uploadStrips(100, 50, 1e9)).toEqual([[0, 50]]);
  });
});

describe("capPolygon", () => {
  /* At the equator a cap of radius r spans 2r degrees of yaw; near a pole it
     spans far more, which is why it is not drawn as a circle. */
  it("is 2r wide at the equator and much wider near the nadir", () => {
    const W = 3600, H = 1800;
    const width = (poly: [number, number][]) => Math.max(...poly.map(p => p[0])) - Math.min(...poly.map(p => p[0]));
    expect(width(capPolygon(0, 0, 10, W, H))).toBeCloseTo((20 / 360) * W, 0);
    expect(width(capPolygon(0, -80, 8, W, H))).toBeGreaterThan(width(capPolygon(0, 0, 8, W, H)) * 3);
  });
  it("sits where the yaw and pitch say", () => {
    const poly = capPolygon(90, 0, 5, 3600, 1800);
    const cx = (Math.max(...poly.map(p => p[0])) + Math.min(...poly.map(p => p[0]))) / 2;
    const cy = (Math.max(...poly.map(p => p[1])) + Math.min(...poly.map(p => p[1]))) / 2;
    expect(cx).toBeCloseTo(2700, 0); // yaw 90 is three quarters across
    expect(cy).toBeCloseTo(900, 0);  // pitch 0 is the middle row
  });
});

describe("gallery order", () => {
  const p = (id: number, rating: number, takenAt: string | null) => ({ id, rating, takenAt });
  const list = [p(1, 0, "2026-09-20T10:00:00Z"), p(2, 5, "2026-09-25T10:00:00Z"), p(3, 3, null), p(4, 5, "2026-09-18T10:00:00Z")];

  it("puts the best first, ties in trip order, unrated last", () => {
    expect(sortPanos(list, "best").map(x => x.id)).toEqual([4, 2, 3, 1]);
  });
  it("runs the trip in time order with undated photos at the end", () => {
    expect(sortPanos(list, "trip").map(x => x.id)).toEqual([4, 1, 2, 3]);
  });
  it("groups the trip by day under the place", () => {
    const g = groupByDay([
      { id: 1, rating: 0, takenAt: "2026-09-20T09:00:00Z", locality: "Munich" },
      { id: 2, rating: 0, takenAt: "2026-09-20T15:00:00Z", locality: "Munich" },
      { id: 3, rating: 0, takenAt: "2026-09-21T09:00:00Z", locality: "Salzburg" },
    ]);
    expect(g.map(x => [x.day, x.heading, x.items.length])).toEqual([["2026-09-20", "Munich", 2], ["2026-09-21", "Salzburg", 1]]);
  });
});

describe("slugs and keys", () => {
  it("makes readable slugs", () => {
    expect(slugify("Marienplatz, München!")).toBe("marienplatz-munchen");
    expect(slugify("IMG_2445.webp")).toBe("img-2445");
    expect(slugify("???")).toBe("photo");
  });
  it("versions derivatives so cached copies are never overwritten", () => {
    expect(panoKeys.derivative("pano/ab12", 3, 2048)).toBe("pano/ab12/v3/2048.jpg");
    expect(panoKeys.thumb("pano/ab12", 7)).toBe("pano/ab12/thumb-7.jpg");
  });
  it("only signs uploads for known asset names", () => {
    for (const ok of ["map", "thumb", "original", "2048", "8192"]) expect(isAllowedAssetName(ok)).toBe(true);
    for (const bad of ["../x", "2048.jpg", "index.html", "", "1"]) expect(isAllowedAssetName(bad)).toBe(false);
  });
});

/* Whatever goes in a title must stay inside the badge and legible. */
describe("fitting the nadir badge's text", () => {
  // A stand-in for measureText: every character 0.55 of the font size wide.
  const measure = (t: string, size: number) => t.length * size * 0.55;
  const R = 150;
  const inside = (lines: BadgeLine[]) => lines.every(l => {
    const half = l.size * 0.56;
    const y = Math.abs(l.y) + half * 0.8;
    return measure(l.text, l.size) <= 2 * Math.sqrt(Math.max(0, R * R - y * y));
  });

  it("puts a short title on one big line with the credit small under it", () => {
    const lines = fitBadge("neaves.au", "© Jared Neaves 2026", R, measure);
    expect(lines.map(l => [l.text, l.sub])).toEqual([["neaves.au", false], ["© Jared Neaves 2026", true]]);
    expect(lines[0].size).toBeGreaterThan(lines[1].size * 2.5);
    expect(lines[1].y).toBeGreaterThan(lines[0].y);
    expect(inside(lines)).toBe(true);
  });

  it("wraps a longer title over balanced lines rather than shrinking it to nothing", () => {
    const lines = fitBadge("Mirabell Gardens and the Pegasus Fountain", "© Jared Neaves 2026", R, measure).filter(l => !l.sub);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map(l => l.text).join(" ")).toBe("Mirabell Gardens and the Pegasus Fountain");
    const widths = lines.map(l => measure(l.text, l.size));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(Math.max(...widths) * 0.6);
    expect(inside(fitBadge("Mirabell Gardens and the Pegasus Fountain", "© Jared Neaves 2026", R, measure))).toBe(true);
  });

  it("cuts a title too long for three lines with an ellipsis, still inside", () => {
    const long = "The Commonwealth War Graves Commission cemetery at Tyne Cot near Passchendaele in Flanders at sunrise on a cold morning";
    const lines = fitBadge(long, "© Jared Neaves 2026", R, measure);
    expect(lines.filter(l => !l.sub).length).toBeLessThanOrEqual(3);
    expect(lines.filter(l => !l.sub).at(-1)!.text.endsWith("…")).toBe(true);
    expect(inside(lines)).toBe(true);
    // Cut late, not early: the box is filled before anything is dropped.
    const shown = lines.filter(l => !l.sub).map(l => l.text).join(" ");
    expect(shown.startsWith("The Commonwealth War Graves")).toBe(true);
    expect(shown.split(" ").length).toBeGreaterThanOrEqual(8);
  });

  it("copes with one enormous word, and with no title at all", () => {
    expect(inside(fitBadge("Supercalifragilisticexpialidociousnessinglyish", null, R, measure))).toBe(true);
    expect(fitBadge("   ", "© Jared Neaves 2026", R, measure).map(l => l.text)).toEqual(["© Jared Neaves 2026"]);
  });
});
