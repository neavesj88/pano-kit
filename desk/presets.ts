/* Grade presets: three named slots of slider settings, kept by the server (not
 * the browser) so they survive a cleared browser, another port or another
 * window. Shared by the page and the server. */
import { normaliseGrade, type Grade } from "../src/grade.ts";

export const PRESET_SLOTS = 3;
export const PRESET_NAME_MAX = 40;

export interface Preset {
  name: string;
  grade: Grade;
}

/** Exactly PRESET_SLOTS entries, each a preset or null (empty), whatever was stored. */
export function readPresets(raw: unknown): (Preset | null)[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.slots) ? (raw as any).slots : [];
  const out: (Preset | null)[] = [];
  for (let i = 0; i < PRESET_SLOTS; i++) {
    const p = list[i];
    if (!p || typeof p !== "object" || !p.grade || typeof p.grade !== "object") { out.push(null); continue; }
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, PRESET_NAME_MAX) : `Preset ${i + 1}`;
    out.push({ name, grade: normaliseGrade(p.grade) });
  }
  return out;
}
