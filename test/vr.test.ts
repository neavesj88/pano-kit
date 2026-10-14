import { describe, it, expect } from "vitest";
import { DRAG_DEG, SNAP_DEG, angleDeg, pointedLabel, snapTurn, wrapLines, yawOf } from "../src/vr";

describe("snap turning from a thumbstick", () => {
  it("turns once per flick, either way, and waits for the stick to come back", () => {
    let s = snapTurn(0.9, true);
    expect(s).toEqual({ turn: 1, armed: false });
    s = snapTurn(0.9, s.armed);
    expect(s.turn).toBe(0);
    s = snapTurn(0.5, s.armed);
    expect(s).toEqual({ turn: 0, armed: false });
    s = snapTurn(0.1, s.armed);
    expect(s).toEqual({ turn: 0, armed: true });
    expect(snapTurn(-0.8, true)).toEqual({ turn: -1, armed: false });
  });

  it("ignores a stick resting a little off centre", () => {
    expect(snapTurn(0.4, true)).toEqual({ turn: 0, armed: true });
    expect(SNAP_DEG).toBe(30);
  });
});

describe("where a controller points", () => {
  it("measures yaw the engine's way: ahead is 0, right is positive", () => {
    expect(yawOf({ x: 0, y: 0, z: -1 })).toBeCloseTo(0);
    expect(yawOf({ x: 1, y: 0, z: 0 })).toBeCloseTo(90);
    expect(yawOf({ x: -1, y: 0, z: 0 })).toBeCloseTo(-90);
  });

  it("finds the nearest label within a few degrees, and none further off", () => {
    const ahead = { x: 0, y: 0, z: -1 };
    const labels = [{ x: 0.2, y: 0, z: -1 }, { x: 0.03, y: 0, z: -1 }, null];
    expect(angleDeg(ahead, labels[1]!)).toBeCloseTo(1.72, 1);
    expect(pointedLabel(ahead, labels)).toBe(1);
    expect(pointedLabel({ x: 1, y: 0, z: 0 }, labels)).toBe(-1);
    expect(pointedLabel(ahead, [null])).toBe(-1);
  });

  it("calls a press that turned the view a little a click, and more a drag", () => {
    expect(DRAG_DEG).toBeGreaterThan(1);
    expect(DRAG_DEG).toBeLessThan(10);
  });
});

describe("a label's text on its card", () => {
  const measure = (s: string) => s.length * 10; // ten units a character

  it("wraps on words within the width", () => {
    expect(wrapLines("Martin power turret, twin .50 cals", 120, measure)).toEqual(["Martin power", "turret, twin", ".50 cals"]);
  });

  it("stops at the line limit with an ellipsis that fits", () => {
    const lines = wrapLines("one two three four five six seven eight nine ten", 90, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines.every(l => measure(l) <= 90)).toBe(true);
  });

  it("cuts a word too long for any line rather than drawing off the card", () => {
    const lines = wrapLines("Supercalifragilistic", 80, measure);
    expect(lines.every(l => measure(l) <= 80)).toBe(true);
  });

  it("gives nothing for no text", () => {
    expect(wrapLines("   ", 100, measure)).toEqual([]);
  });
});
