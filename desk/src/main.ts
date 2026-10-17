/* pano-desk's page: browse trip folders, look at a 360, grade it, blur what
 * should not be seen, set how the gallery opens it, follow PhotoCraft live,
 * and save edited\Edited_<name>.jpg plus a <name>.pano.json recipe beside the original.
 *
 * Everything that changes pixels is pano-kit's (grade, bake), the same code for
 * the preview and the saved file, so the preview is what gets saved. */
import { PanoEngine, loadThree } from "../../src/engine";
import {
  DEFAULT_VIEW, DEFAULT_VIEWER_SETTINGS, NADIR_DEG_MAX, compareFolders, mapsUrl, normaliseView, parseFolder, parseLocation, shortDate,
  type Blur, type Hotspot, type View,
} from "../../src/core";
import { DEFAULT_GRADE, GRADE_RANGES, isIdentityGrade, normaliseGrade, type Grade, type GradeKey } from "../../src/grade";
import { bakeTo, canvasToJpeg } from "../../src/bake";
import { LIMITS, cleanTags, isLinkUrl } from "../details";
import { PRESET_NAME_MAX, PRESET_SLOTS, readPresets, type Preset } from "../presets";
import {
  DEFAULT_OVERLAY, HFOV_MAX, HFOV_MIN, direction, normaliseOverlay, overlayCamera, photoPoint, placePoint, type Overlay,
} from "../../src/overlay";

const THREE_URL = "/vendor/three/0.186.1/three.module.min.js";
/** As neaves.au's curate panel allows: a face across a square is well under a degree. */
const BLUR_MIN = 0.3, BLUR_MAX = 40;
const JPEG_QUALITY = 0.95;

interface Photo {
  name: string; path: string; size: number; mtime: number; width: number; height: number;
  edited: { path: string; mtime: number } | null;
  work: { path: string; mtime: number } | null;
  sidecar: boolean;
}
interface Listing { path: string | null; parent: string | null; dirs: { name: string; path: string }[]; photos: Photo[]; hidden: number }
type Base = "original" | "photocraft";
type Source = Base | "edited";
interface Nadir { cover: "none" | "disk"; deg: number; rot: number }
/** What is saved beside the original as <name>.pano.json. */
/** Where a photo was taken. `approx` marks a guess (a site's centre, the phone's
 *  coarse fix) still to be checked; setting the spot by hand clears it. */
interface Spot { lat: number; lng: number; approx: boolean; source?: string }
interface Recipe {
  version: 1; base: Base; grade: Grade; blurs: Blur[]; start: View; hotspots: Hotspot[]; nadir: Nadir;
  title: string; place: string; location: Spot | null; description: string; tags: string[];
  /** 0 for none, else 1 to 5 stars. */
  rating: number; linkUrl: string; linkLabel: string;
  /** Flat photos set into the 360, bottom first; `file` is in <name>.overlays beside the original. */
  overlays: PlacedPhoto[];
  savedAt?: string;
}
interface PlacedPhoto extends Overlay { file: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const store = {
  get: (k: string) => { try { return localStorage.getItem(`pano-desk:${k}`); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(`pano-desk:${k}`, v); } catch { /* private mode */ } },
};

async function api<T = any>(url: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const method = init.method ?? "GET";
  const r = await fetch(url, { ...init, headers: { ...(method === "GET" ? {} : { "X-Pano-Desk": "1" }), ...(init.headers ?? {}) } });
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok && r.status !== 409) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return { status: r.status, data };
}
const fileUrl = (p: string, v: number) => `/api/file?path=${encodeURIComponent(p)}&v=${Math.round(v)}`;

/* ------------------------------------------------------------- state */

let engine: PanoEngine;
let listing: Listing = { path: null, parent: null, dirs: [], photos: [], hidden: 0 };
let current: Photo | null = null;
let recipe: Recipe = freshRecipe();
let savedJson = JSON.stringify(recipe);
let source: Source = "original";
let mode: "look" | "blur" | "label" = "look";
let selBlur = -1;
let blurSize = 3; // replaced from storage once the page has loaded
let beforeHeld = false;
let copied: Grade | null = null;
let presets: (Preset | null)[] = Array.from({ length: PRESET_SLOTS }, () => null);
let pcState: Record<string, any> = { on: false };
let config: { roots: string[]; work: string | null; photocraft: boolean } = { roots: [], work: null, photocraft: false };
/** The overlaid photos' pictures, by file path: loaded once, handed to the engine and the bake. */
const overlayImages = new Map<string, HTMLImageElement>();
let selOverlay = -1;
let overlayDrag: { i: number; px: number; py: number } | null = null;

function freshRecipe(): Recipe {
  return {
    version: 1, base: "original", grade: { ...DEFAULT_GRADE }, blurs: [], start: { ...DEFAULT_VIEW }, hotspots: [], nadir: { cover: "none", deg: 25, rot: 0 },
    title: "", place: "", location: null, description: "", tags: [], rating: 0, linkUrl: "", linkLabel: "", overlays: [],
  };
}

function readRecipe(raw: any): Recipe {
  const r = freshRecipe();
  if (!raw || typeof raw !== "object") return r;
  r.base = raw.base === "photocraft" ? "photocraft" : "original";
  r.grade = normaliseGrade(raw.grade);
  r.blurs = Array.isArray(raw.blurs) ? raw.blurs.filter((b: any) => Number.isFinite(b?.yaw) && Number.isFinite(b?.pitch) && Number.isFinite(b?.r)) : [];
  r.start = normaliseView(raw.start);
  r.hotspots = Array.isArray(raw.hotspots) ? raw.hotspots.filter((h: any) => Number.isFinite(h?.yaw) && typeof h?.text === "string") : [];
  const n = raw.nadir ?? {};
  r.nadir = { cover: n.cover === "disk" ? "disk" : "none", deg: Number(n.deg) || 25, rot: Number(n.rot) || 0 };
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  r.title = str(raw.title, LIMITS.title);
  r.place = str(raw.place, LIMITS.place);
  r.location = readSpot(raw.location);
  r.description = str(raw.description, LIMITS.description);
  r.tags = Array.isArray(raw.tags) ? cleanTags(raw.tags) : [];
  r.rating = Number.isInteger(raw.rating) && raw.rating >= 0 && raw.rating <= 5 ? raw.rating : 0;
  r.linkUrl = str(raw.linkUrl, LIMITS.linkUrl);
  r.linkLabel = str(raw.linkLabel, LIMITS.linkLabel);
  r.overlays = Array.isArray(raw.overlays)
    ? raw.overlays.filter((o: any) => typeof o?.file === "string" && o.file).map((o: any) => ({ ...normaliseOverlay(o), file: o.file }))
    : [];
  r.savedAt = typeof raw.savedAt === "string" ? raw.savedAt : undefined;
  return r;
}

function readSpot(l: any): Spot | null {
  const lat = Number(l?.lat), lng = Number(l?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const s: Spot = { lat, lng, approx: l.approx === true };
  if (typeof l.source === "string" && l.source) s.source = l.source.slice(0, 200);
  return s;
}

const dirty = () => JSON.stringify({ ...recipe, savedAt: undefined }) !== savedJson;
function markSaved() { savedJson = JSON.stringify({ ...recipe, savedAt: undefined }); updateDirty(); }
function updateDirty() {
  const d = !!current && dirty();
  $("dirty").textContent = d ? "Unsaved" : "";
  $("dirty").title = d ? "Unsaved changes: Save settings or Save edited copy keeps them" : "";
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string, kind: "" | "ok" | "err" = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === "err" ? 7000 : 3500);
}

/* ------------------------------------------------------------ browser */

async function browse(dir: string | null) {
  const { data } = await api<Listing>(`/api/list${dir ? `?path=${encodeURIComponent(dir)}` : ""}`);
  listing = data;
  if (!dir && data.dirs.length === 1) return browse(data.dirs[0].path);
  if (dir) store.set("folder", dir);
  drawBrowser();
}

function drawBrowser() {
  $("crumb").textContent = listing.path ?? "Roots";
  $<HTMLButtonElement>("up").disabled = !listing.path;
  const dirs = [...listing.dirs].sort((a, b) => compareFolders(a.name, b.name));
  $("dirs").innerHTML = dirs.map(d => {
    const f = parseFolder(d.name);
    return `<button data-path="${esc(d.path)}"><span class="date">${f.date ? shortDate(f.date) : ""}</span><span>${esc(f.date ? f.label || d.name : d.name)}</span></button>`;
  }).join("");
  $("grid").innerHTML = listing.photos.map((p, i) => `
    <button class="tile${current?.path === p.path ? " on" : ""}" data-i="${i}" title="${esc(p.name)}">
      <img alt="" data-thumb="${esc(p.path)}" data-v="${Math.round(p.mtime)}">
      <span class="name">${esc(p.name.replace(/^IMG_\d{8}_/, ""))}</span>
      <span class="badges">${p.edited ? "<span>edited</span>" : ""}${p.work ? "<span>PC</span>" : ""}${p.sidecar ? "<span>⚙</span>" : ""}</span>
    </button>`).join("");
  $("sidefoot").textContent = listing.path
    ? `${listing.photos.length} 360 photo${listing.photos.length === 1 ? "" : "s"}${listing.hidden ? ` · ${listing.hidden} flat hidden` : ""}`
    : "";
  loadThumbs();
}

/* Thumbnails: the server keeps them; the page makes any that are missing, two at a time. */
const thumbQueue: HTMLImageElement[] = [];
let thumbsRunning = 0;
function loadThumbs() {
  for (const img of $("grid").querySelectorAll<HTMLImageElement>("img[data-thumb]")) {
    const p = img.dataset.thumb!;
    img.onerror = () => { img.onerror = null; thumbQueue.push(img); pumpThumbs(); };
    img.src = `/api/thumb?path=${encodeURIComponent(p)}&v=${img.dataset.v}`;
  }
}
async function pumpThumbs() {
  while (thumbsRunning < 2 && thumbQueue.length) {
    const img = thumbQueue.shift()!;
    thumbsRunning++;
    makeThumb(img).catch(() => { /* leave it blank */ }).finally(() => { thumbsRunning--; pumpThumbs(); });
  }
}
async function makeThumb(img: HTMLImageElement) {
  const p = img.dataset.thumb!;
  const blob = await (await fetch(fileUrl(p, Number(img.dataset.v)))).blob();
  const bmp = await createImageBitmap(blob, { resizeWidth: 480, resizeHeight: 240, resizeQuality: "medium" });
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 240;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const jpg = await canvasToJpeg(c, 0.8);
  img.src = URL.createObjectURL(jpg);
  await api(`/api/thumb?path=${encodeURIComponent(p)}`, { method: "PUT", body: jpg });
}

/* ------------------------------------------------------------ viewer */

async function openPhoto(p: Photo) {
  if (current && dirty() && !confirm(`${current.name} has unsaved changes. Leave them?`)) return;
  current = p;
  store.set("photo", p.path);
  const { data } = await api(`/api/sidecar?path=${encodeURIComponent(p.path)}`);
  recipe = readRecipe(data);
  markSaved();
  source = recipe.base === "photocraft" && p.work ? "photocraft" : "original";
  selBlur = -1;
  selOverlay = -1;
  setMode("look");
  $("empty").hidden = true;
  $("title").textContent = p.name;
  for (const t of $("grid").querySelectorAll(".tile")) t.classList.toggle("on", listing.photos[Number((t as HTMLElement).dataset.i)]?.path === p.path);
  // The panels need only the recipe, so they are ready while a big photo is still decoding.
  drawPanels();
  drawSources();
  if (pcState.on) await setLive(true);
  await show(false);
}

function sourceUrl(): string | null {
  if (!current) return null;
  if (source === "photocraft") return current.work ? fileUrl(current.work.path, current.work.mtime) : null;
  if (source === "edited") return current.edited ? fileUrl(current.edited.path, current.edited.mtime) : null;
  return fileUrl(current.path, current.mtime);
}

async function show(keepView: boolean) {
  const url = sourceUrl();
  if (!current || !url) return;
  applyNadir();
  await engine.open(
    { sources: [{ width: current.width, url }], srcW: current.width, srcH: current.height, resolvedKind: "pano", gpano: null, start: recipe.start, hotspots: recipe.hotspots },
    keepView ? { initialView: engine.currentView() } : { reveal: true },
  );
  applyPreview();
  drawSources();
}

/** The sliders, blurs and overlaid photos, live, unless looking at the saved file or holding Before. */
function applyPreview() {
  const off = source === "edited" || beforeHeld;
  engine.setGradePreview(off ? null : recipe.grade);
  engine.setBlurPreview(off || !recipe.blurs.length ? null : recipe.blurs);
  void showOverlays();
}

/* -------------------------------------------------- overlaid photos */

/** Where an overlaid photo's file is: <name>.overlays\<file> beside the original. */
function overlayPath(file: string): string {
  const p = current!.path, sep = p.includes("\\") ? "\\" : "/";
  return p.replace(/\.[^.\\/]+$/, "") + ".overlays" + sep + file;
}

function overlayImage(file: string): Promise<HTMLImageElement> {
  const key = overlayPath(file);
  const have = overlayImages.get(key);
  if (have?.complete && have.naturalWidth) return Promise.resolve(have);
  const img = have ?? new Image();
  overlayImages.set(key, img);
  // The load event, not decode(): a window that is not being drawn can hold decode() back indefinitely.
  const ready = new Promise<HTMLImageElement>((resolve, reject) => {
    img.addEventListener("load", () => resolve(img), { once: true });
    img.addEventListener("error", () => { overlayImages.delete(key); reject(new Error(`Could not load ${file}`)); }, { once: true });
  });
  if (!have) img.src = fileUrl(key, 0);
  return ready;
}

/** The overlaid photos as the engine and the bake take them, pictures loaded. */
async function overlaySources() {
  const out = [];
  for (const o of recipe.overlays) {
    try { out.push({ image: await overlayImage(o.file), overlay: o as Overlay }); }
    catch { toast(`Could not load ${o.file}`, "err"); }
  }
  return out;
}

async function showOverlays() {
  const off = source === "edited" || beforeHeld || !current;
  engine.setOverlays(off ? null : await overlaySources());
}

/** The topmost overlaid photo under a screen point, with the photo pixel it is grabbed by. */
function overlayAt(clientX: number, clientY: number): { i: number; px: number; py: number } | null {
  const { yaw, pitch } = engine.dirAt(clientX, clientY);
  for (let i = recipe.overlays.length - 1; i >= 0; i--) {
    const img = current && overlayImages.get(overlayPath(recipe.overlays[i].file));
    if (!img?.naturalWidth) continue;
    const at = photoPoint(overlayCamera(recipe.overlays[i], img.naturalWidth, img.naturalHeight), direction(yaw, pitch));
    if (at) return { i, px: at[0], py: at[1] };
  }
  return null;
}

/** Then & now tab open, and not looking at a saved file: dragging an overlaid photo moves it rather than the view. */
const overlayMode = () => !$("tab-overlay").hidden && source !== "edited" && !!current;

function bindOverlayDrag() {
  const stage = $("stage");
  // Capture on the stage runs before the engine's own handlers on the canvas, so a grab
  // on a photo never turns the view, and a press anywhere else still does.
  stage.addEventListener("pointerdown", e => {
    if (!overlayMode() || e.button !== 0 || (e.target as HTMLElement).closest("#top, #mm, .pano-pin")) return;
    const hit = overlayAt(e.clientX, e.clientY);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    overlayDrag = hit;
    if (selOverlay !== hit.i) { selOverlay = hit.i; drawOverlayTab(); }
    stage.setPointerCapture(e.pointerId);
  }, true);
  stage.addEventListener("pointermove", e => {
    if (!overlayDrag) {
      if (overlayMode()) $("c").style.cursor = overlayAt(e.clientX, e.clientY) ? "move" : "grab";
      return;
    }
    e.stopPropagation();
    const o = recipe.overlays[overlayDrag.i];
    const img = overlayImages.get(overlayPath(o.file))!;
    const at = engine.dirAt(e.clientX, e.clientY);
    Object.assign(o, placePoint(o, img.naturalWidth, img.naturalHeight, overlayDrag.px, overlayDrag.py, at.yaw, at.pitch));
    void showOverlays();
    syncOverlaySliders();
  }, true);
  const end = (e: PointerEvent) => {
    if (!overlayDrag) return;
    e.stopPropagation();
    overlayDrag = null;
    updateDirty();
    drawOverlayTab();
  };
  stage.addEventListener("pointerup", end, true);
  stage.addEventListener("pointercancel", end, true);
  // Wheel over a photo sizes it (Shift: turns it); anywhere else the view zooms as usual.
  stage.addEventListener("wheel", e => {
    if (!overlayMode()) return;
    const hit = overlayAt(e.clientX, e.clientY);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    const o = recipe.overlays[hit.i];
    if (e.shiftKey) o.roll = Math.max(-180, Math.min(180, o.roll + Math.sign(e.deltaY || e.deltaX) * 0.5));
    else o.hfov = Math.max(HFOV_MIN, Math.min(HFOV_MAX, o.hfov * (1 + e.deltaY * 0.0008)));
    selOverlay = hit.i;
    void showOverlays();
    syncOverlaySliders();
    updateDirty();
  }, { capture: true, passive: false });
}

async function addOverlay(file: File) {
  if (!current) return;
  try {
    const { data } = await api(`/api/overlay?path=${encodeURIComponent(current.path)}&name=${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
    const v = engine.currentView();
    // Where you are looking, about half the width of the view, so it is in front of you to drag into place.
    recipe.overlays.push({ ...DEFAULT_OVERLAY, yaw: round(v.yaw, 2), pitch: round(v.pitch, 2), hfov: round(Math.min(90, v.fov * 0.6), 1), file: data.file });
    selOverlay = recipe.overlays.length - 1;
    await showOverlays();
    updateDirty();
    drawOverlayTab();
  } catch (e: any) { toast(`Not added: ${e.message}`, "err"); }
}

const OVERLAY_SLIDERS: [keyof Overlay, string, number, number, number][] = [
  ["hfov", "Size", HFOV_MIN, HFOV_MAX, 0.1],
  ["roll", "Turn", -180, 180, 0.1],
  ["opacity", "Opacity", 0, 1, 0.01],
  ["feather", "Soft edge", 0, 0.3, 0.005],
  ["yaw", "Across", -180, 180, 0.05],
  ["pitch", "Up", -89, 89, 0.05],
];

function drawOverlayTab() {
  const off = !current || source === "edited";
  const sel = recipe.overlays[selOverlay];
  $("tab-overlay").innerHTML = `
    <h3>Then &amp; now</h3>
    <p class="note">Set an old photo into this 360 where it was taken. With this tab open, drag a photo to move it, scroll on it to size it, Shift+scroll to turn it. Line up something both share (a corner, a statue, a roofline), then fade it with Opacity.</p>
    <div class="buttons"><label class="filebtn ${off ? "disabled" : ""}">Add photo…<input type="file" id="oAdd" accept="image/jpeg,image/png,image/webp" hidden ${off ? "disabled" : ""}></label></div>
    <div class="list">${recipe.overlays.map((o, i) => `<div class="item${i === selOverlay ? " on" : ""}" data-i="${i}">
      <span>${esc(o.file)} · ${round(o.hfov)}° wide${o.opacity < 1 ? ` · ${Math.round(o.opacity * 100)}%` : ""}</span><button data-go="${i}" title="Look at it">◎</button><button data-del="${i}" title="Remove from this photo">×</button></div>`).join("") || `<p class="note">No photos set in yet.</p>`}</div>
    ${sel ? OVERLAY_SLIDERS.map(([k, label, lo, hi, st]) => slider(`o-${k}`, label, round(sel[k] as number, 3), lo, hi, st)).join("") : ""}
    ${sel ? `<p class="note">PNG cut-outs keep their transparency. The photo keeps its own colours: the Adjust sliders change only the 360.</p>` : ""}`;
  const add = document.getElementById("oAdd") as HTMLInputElement | null;
  if (add) add.onchange = () => { const f = add.files?.[0]; add.value = ""; if (f) void addOverlay(f); };
  bindList("tab-overlay", i => { selOverlay = selOverlay === i ? -1 : i; drawOverlayTab(); },
    i => { const o = recipe.overlays[i]; engine.flyTo({ yaw: o.yaw, pitch: o.pitch, fov: Math.min(100, Math.max(30, o.hfov * 1.4)) }, 700); },
    i => { recipe.overlays.splice(i, 1); selOverlay = -1; void showOverlays(); updateDirty(); drawOverlayTab(); });
  if (!sel) return;
  for (const [k] of OVERLAY_SLIDERS) {
    const r = $<HTMLInputElement>(`o-${k}`), n = $<HTMLInputElement>(`o-${k}-n`);
    const set = (v: number) => {
      Object.assign(sel, normaliseOverlay({ ...sel, [k]: v }));
      syncOverlaySliders();
      void showOverlays();
      updateDirty();
    };
    r.oninput = () => set(Number(r.value));
    n.onchange = () => set(Number(n.value));
    r.disabled = n.disabled = off;
  }
}

/** Slider positions after a drag or a scroll, without redrawing the tab under the pointer. */
function syncOverlaySliders() {
  const sel = recipe.overlays[selOverlay];
  if (!sel) return;
  for (const [k] of OVERLAY_SLIDERS) {
    const r = document.getElementById(`o-${k}`) as HTMLInputElement | null, n = document.getElementById(`o-${k}-n`) as HTMLInputElement | null;
    if (r && n) r.value = n.value = String(round(sel[k] as number, 3));
  }
}

function applyNadir() {
  engine.setSettings({ ...DEFAULT_VIEWER_SETTINGS, opening: "none", minimap: true, nadir: recipe.nadir.cover, nadirDeg: recipe.nadir.deg, nadirRot: recipe.nadir.rot });
}

function drawSources() {
  for (const b of $("sources").querySelectorAll<HTMLButtonElement>("button")) {
    const s = b.dataset.src as Source;
    b.classList.toggle("on", s === source);
    b.disabled = !current || (s === "photocraft" && !current.work) || (s === "edited" && !current.edited);
  }
}

async function setSource(s: Source) {
  if (!current || s === source) return;
  source = s;
  if (s !== "edited") recipe.base = s;
  updateDirty();
  await show(true);
  drawPanels();
}

function step(delta: number) {
  if (!current) return;
  const i = listing.photos.findIndex(p => p.path === current!.path);
  const next = listing.photos[i + delta];
  if (next) void openPhoto(next);
}

function setMode(m: typeof mode) {
  mode = mode === m ? "look" : m;
  const hint = $("modehint");
  hint.hidden = mode === "look";
  hint.textContent = mode === "blur" ? "Blur: click what to hide · Esc to stop" : mode === "label" ? "Label: click where it goes · Esc to stop" : "";
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
}

function onTap(at: { yaw: number; pitch: number } | { u: number; v: number }) {
  if (!current || source === "edited" || !("yaw" in at) || !Number.isFinite(at.yaw) || !Number.isFinite(at.pitch)) return;
  if (mode === "blur") {
    recipe.blurs.push({ yaw: round(at.yaw, 2), pitch: round(at.pitch, 2), r: blurSize });
    selBlur = recipe.blurs.length - 1;
    edited();
    drawPanels();
  } else if (mode === "label") {
    const text = $<HTMLInputElement>("labelText")?.value.trim();
    if (!text) return toast("Type the label's text first", "err");
    recipe.hotspots.push({ yaw: round(at.yaw, 2), pitch: round(at.pitch, 2), text: text.slice(0, LIMITS.hotspotText) });
    engine.setHotspots(recipe.hotspots);
    edited();
    drawPanels();
  }
}

/** Something in the recipe changed: show it and flag it unsaved. */
function edited() {
  applyPreview();
  updateDirty();
}

/* ------------------------------------------------------------ panels */

const GROUPS: [string, GradeKey[]][] = [
  ["Light", ["exposure", "contrast"]],
  ["Tone curve (360-safe shadows and highlights)", ["highlights", "lights", "darks", "shadows"]],
  ["Ends", ["whites", "blacks"]],
  ["Colour", ["temperature", "tint", "vibrance", "saturation"]],
];
const LABELS: Record<GradeKey, string> = {
  exposure: "Exposure", contrast: "Contrast", highlights: "Highlights", lights: "Lights", darks: "Darks", shadows: "Shadows",
  whites: "Whites", blacks: "Blacks", temperature: "Temperature", tint: "Tint", vibrance: "Vibrance", saturation: "Saturation",
};

function slider(id: string, label: string, value: number, min: number, max: number, stepBy: number) {
  return `<div class="row"><label for="${id}" title="Double-click to reset">${label}</label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${stepBy}" value="${value}">
    <input type="number" id="${id}-n" min="${min}" max="${max}" step="${stepBy}" value="${value}"></div>`;
}

/** The preset slot last picked in the dropdown (0 to PRESET_SLOTS - 1). */
function presetSlot(): number {
  const n = Number(store.get("presetSlot"));
  return Number.isInteger(n) && n >= 0 && n < PRESET_SLOTS ? n : 0;
}

async function savePreset(i: number) {
  const name = prompt(`Name preset ${i + 1}`, presets[i]?.name ?? `Preset ${i + 1}`);
  if (name === null) return;
  const next = presets.slice();
  next[i] = { name: name.trim().slice(0, PRESET_NAME_MAX) || `Preset ${i + 1}`, grade: { ...recipe.grade } };
  try {
    const { data } = await api("/api/presets", { method: "PUT", body: JSON.stringify(next), headers: { "Content-Type": "application/json" } });
    presets = readPresets(data);
    store.set("presetSlot", String(i));
    drawPanels();
    toast(`Saved preset "${presets[i]?.name}"`, "ok");
  } catch (e: any) { toast(`Preset not saved: ${e.message}`, "err"); }
}

function drawPanels() {
  const off = !current || source === "edited";
  const g = recipe.grade;
  const slot = presetSlot();
  $("tab-adjust").innerHTML = `
    ${off && current ? `<p class="note">Showing the saved edited copy as it is. Pick Original or PhotoCraft above to edit.</p>` : ""}
    <h3>Presets</h3>
    <div class="preset">
      <select id="gPreset" aria-label="Preset">${presets.map((p, i) => `<option value="${i}" ${i === slot ? "selected" : ""}>${i + 1} · ${p ? esc(p.name) : "empty"}</option>`).join("")}</select>
      <button id="gLoad" ${off || !presets[slot] ? "disabled" : ""} title="Set every slider to this preset">Load</button>
      <button id="gSave" ${off ? "disabled" : ""} title="Keep the sliders as they are now in this slot">Save</button>
    </div>
    ${GROUPS.map(([title, keys]) => `<h3>${title}</h3>${keys.map(k => slider(`g-${k}`, LABELS[k], g[k], GRADE_RANGES[k][0], GRADE_RANGES[k][1], k === "exposure" ? 0.05 : 1)).join("")}`).join("")}
    <div class="buttons"><button id="gReset">Reset all</button><button id="gCopy">Copy</button><button id="gPaste" ${copied ? "" : "disabled"}>Paste</button></div>
    <p class="note">Each slider changes every pixel on its own, so nothing here can draw a line where the 360 wraps. Double-click a name to reset it.</p>`;
  for (const [, keys] of GROUPS) for (const k of keys) {
    const r = $<HTMLInputElement>(`g-${k}`), n = $<HTMLInputElement>(`g-${k}-n`);
    const set = (v: number) => {
      recipe.grade = normaliseGrade({ ...recipe.grade, [k]: v });
      r.value = n.value = String(recipe.grade[k]);
      edited();
    };
    r.oninput = () => set(Number(r.value));
    n.onchange = () => set(Number(n.value));
    r.previousElementSibling!.addEventListener("dblclick", () => set(0));
    r.disabled = n.disabled = off;
  }
  $("gReset").onclick = () => { recipe.grade = { ...DEFAULT_GRADE }; edited(); drawPanels(); };
  $("gCopy").onclick = () => { copied = { ...recipe.grade }; toast("Grade copied: open another photo and Paste"); drawPanels(); };
  $("gPaste").onclick = () => { if (copied) { recipe.grade = { ...copied }; edited(); drawPanels(); } };
  $<HTMLSelectElement>("gPreset").onchange = e => { store.set("presetSlot", (e.target as HTMLSelectElement).value); drawPanels(); };
  $("gLoad").onclick = () => {
    const p = presets[presetSlot()];
    if (!p) return;
    recipe.grade = { ...p.grade };
    edited();
    drawPanels();
    toast(`Loaded preset "${p.name}"`, "ok");
  };
  $("gSave").onclick = () => void savePreset(presetSlot());

  $("tab-blur").innerHTML = `
    <div class="buttons"><button data-mode="blur" class="${mode === "blur" ? "on" : ""}" ${off ? "disabled" : ""}>Click to blur</button>
      <button id="bClear" ${recipe.blurs.length ? "" : "disabled"}>Remove all</button></div>
    ${slider("bSize", selBlur >= 0 ? `Size #${selBlur + 1}` : "Next size", selBlur >= 0 ? recipe.blurs[selBlur]?.r ?? blurSize : blurSize, BLUR_MIN, BLUR_MAX, 0.1)}
    <p class="note">Size is the blur's radius in degrees. A face a few metres away is 2 to 4.</p>
    <div class="list">${recipe.blurs.map((b, i) => "yaw" in b ? `<div class="item${i === selBlur ? " on" : ""}" data-i="${i}">
      <span>#${i + 1} · ${round(b.yaw)}°, ${round(b.pitch)}° · r ${round(b.r)}°</span><button data-go="${i}" title="Look at it">◎</button><button data-del="${i}" title="Remove">×</button></div>` : "").join("") || `<p class="note">No blurs yet.</p>`}</div>
    <p class="note">Blurs are baked into the saved file, so the face is simply not in it.</p>`;
  const bs = $<HTMLInputElement>("bSize"), bn = $<HTMLInputElement>("bSize-n");
  const setSize = (v: number) => {
    const r = Math.min(BLUR_MAX, Math.max(BLUR_MIN, v));
    bs.value = bn.value = String(r);
    // The last size set is the next blur's size too, and is remembered between photos and runs.
    blurSize = r;
    store.set("blurSize", String(r));
    if (selBlur >= 0 && recipe.blurs[selBlur]) { recipe.blurs[selBlur].r = r; edited(); drawBlurList(); }
  };
  bs.oninput = () => setSize(Number(bs.value));
  bn.onchange = () => setSize(Number(bn.value));
  $("bClear").onclick = () => { recipe.blurs = []; selBlur = -1; edited(); drawPanels(); };
  bindList("tab-blur", i => { selBlur = selBlur === i ? -1 : i; drawPanels(); }, i => engine.flyTo(engine.viewFor(recipe.blurs[i], 50), 700),
    i => { recipe.blurs.splice(i, 1); selBlur = -1; edited(); drawPanels(); });

  const v = recipe.start, n = recipe.nadir;
  $("tab-view").innerHTML = `
    <h3>Start view</h3>
    <p class="note">Where the gallery opens it: ${round(v.yaw)}° across, ${round(v.pitch)}° up, ${round(v.fov)}° wide.</p>
    <div class="buttons"><button id="vSet" ${current ? "" : "disabled"}>Use what I'm looking at</button><button id="vGo" ${current ? "" : "disabled"}>Look at it</button></div>
    <h3>Labels</h3>
    <div class="row" style="grid-template-columns:1fr auto"><input type="text" id="labelText" maxlength="120" placeholder="Label text, then click Place"><button data-mode="label" class="${mode === "label" ? "on" : ""}" ${off ? "disabled" : ""}>Place</button></div>
    <div class="list">${recipe.hotspots.map((h, i) => `<div class="item" data-i="${i}"><span>${esc(h.text)}</span><button data-go="${i}" title="Look at it">◎</button><button data-del="${i}" title="Remove">×</button></div>`).join("") || `<p class="note">No labels.</p>`}</div>
    <h3>Bottom cover (preview)</h3>
    <div class="row"><label>Cover</label><select id="nCover"><option value="none">None</option><option value="disk" ${n.cover === "disk" ? "selected" : ""}>Disk</option></select><span></span></div>
    ${slider("nDeg", "Size", n.deg, 5, NADIR_DEG_MAX, 1)}${slider("nRot", "Turn", n.rot, -180, 180, 1)}
    <p class="note">The gallery draws its own badge and figure on the disk; this shows where it sits and how big.</p>`;
  $("vSet").onclick = () => { recipe.start = normaliseView(engine.currentView()); engine.setStart(recipe.start); updateDirty(); drawPanels(); };
  $("vGo").onclick = () => engine.flyTo(recipe.start, 800);
  bindList("tab-view", () => {}, i => engine.flyTo(engine.viewFor(recipe.hotspots[i], 60), 700),
    i => { recipe.hotspots.splice(i, 1); engine.setHotspots(recipe.hotspots); updateDirty(); drawPanels(); });
  const nadirChanged = () => {
    recipe.nadir = { cover: $<HTMLSelectElement>("nCover").value as Nadir["cover"], deg: Number($<HTMLInputElement>("nDeg").value), rot: Number($<HTMLInputElement>("nRot").value) };
    $<HTMLInputElement>("nDeg-n").value = String(recipe.nadir.deg);
    $<HTMLInputElement>("nRot-n").value = String(recipe.nadir.rot);
    applyNadir();
    updateDirty();
  };
  $("nCover").onchange = $("nDeg").oninput = $("nRot").oninput = nadirChanged;
  $("nDeg-n").onchange = () => { $<HTMLInputElement>("nDeg").value = $<HTMLInputElement>("nDeg-n").value; nadirChanged(); };
  $("nRot-n").onchange = () => { $<HTMLInputElement>("nRot").value = $<HTMLInputElement>("nRot-n").value; nadirChanged(); };

  drawInfo();
  drawOverlayTab();
  drawPhotoCraft();
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.onclick = () => setMode(b.dataset.mode as typeof mode);
  $<HTMLButtonElement>("saveJpeg").disabled = !current || source === "edited";
  $<HTMLButtonElement>("saveSettings").disabled = !current;
  updateDirty();
}

function drawBlurList() {
  const items = $("tab-blur").querySelectorAll<HTMLElement>(".item");
  items.forEach(el => {
    const b = recipe.blurs[Number(el.dataset.i)];
    if (b && "yaw" in b) el.querySelector("span")!.textContent = `#${Number(el.dataset.i) + 1} · ${round(b.yaw)}°, ${round(b.pitch)}° · r ${round(b.r)}°`;
  });
}

function bindList(tab: string, select: (i: number) => void, go: (i: number) => void, del: (i: number) => void) {
  $(tab).querySelector(".list")!.addEventListener("click", e => {
    const t = e.target as HTMLElement;
    if (t.dataset.go) return go(Number(t.dataset.go));
    if (t.dataset.del) return del(Number(t.dataset.del));
    const item = t.closest<HTMLElement>(".item");
    if (item) select(Number(item.dataset.i));
  });
}

function drawPhotoCraft() {
  const s = pcState;
  const status = !config.photocraft ? `<div class="status warn">PhotoCraft is not set up in config.local.json.</div>`
    : !s.on ? `<div class="status">Live is off.</div>`
    : s.exporting ? `<div class="status ok">Exporting from PhotoCraft…</div>`
    : s.matched ? `<div class="status ok">Live: following ${esc(s.doc ?? "")}. Stop editing for a moment and it appears here.</div>`
    : `<div class="status warn">${esc(s.message || "Waiting for PhotoCraft…")}</div>`;
  $("tab-pc").innerHTML = `
    <h3>Round trip</h3>
    <p class="note">1. <b>Open in PhotoCraft</b> copies the original into the working folder${config.work ? ` (${esc(config.work)})` : ""} and opens it there. The original is never opened for writing.</p>
    <p class="note">2. Turn on <b>Live</b>: whenever you pause editing in PhotoCraft, its picture is exported (flattened; your layers stay in PhotoCraft) and shown here in 360.</p>
    <p class="note">3. Sliders and blurs here go on top of it. <b>Save edited copy</b> writes the result to the edited folder beside the original.</p>
    <div class="buttons"><button id="pcOpen" ${current && config.photocraft ? "" : "disabled"}>Open in PhotoCraft</button>
      <button id="pcLive" class="${s.on ? "on" : ""}" ${current && config.photocraft ? "" : "disabled"}>Live ${s.on ? "on" : "off"}</button></div>
    ${status}
    <p class="note">PhotoCraft must have been started from its "PhotoCraft (Claude)" shortcut: that is what opens its control port.</p>`;
  $("pcOpen").onclick = async () => {
    try {
      const { data } = await api(`/api/photocraft/open?path=${encodeURIComponent(current!.path)}`, { method: "POST" });
      toast(data.already ? `Already open in PhotoCraft (tab ${data.tab}): ${data.copy}` : `Opened in PhotoCraft: ${data.copy}`, "ok");
    } catch (e: any) { toast(e.message, "err"); }
  };
  $("pcLive").onclick = () => setLive(!pcState.on);
}

async function setLive(on: boolean) {
  if (!current) return;
  try {
    await api(`/api/photocraft/live?on=${on ? 1 : 0}&path=${encodeURIComponent(current.path)}`, { method: "POST" });
  } catch (e: any) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------ saving */

/** Place, location, description and tags: what the gallery shows beside the photo. */
function drawInfo() {
  const off = !current, l = recipe.location;
  $("tab-info").innerHTML = `
    <h3>Name</h3>
    <input type="text" id="iTitle" class="wide" maxlength="${LIMITS.title}" placeholder="What the gallery calls it" value="${esc(recipe.title)}" ${off ? "disabled" : ""}>
    <h3>Place</h3>
    <input type="text" id="iPlace" class="wide" maxlength="${LIMITS.place}" placeholder="e.g. Tyne Cot Cemetery, Zonnebeke" value="${esc(recipe.place)}" ${off ? "disabled" : ""}>
    <h3>Location</h3>
    <div class="row" style="grid-template-columns:1fr auto"><input type="text" id="iLoc" placeholder="lat, lng or a Google Maps link" value="${l ? `${l.lat}, ${l.lng}` : ""}" ${off ? "disabled" : ""}>
      <button id="iMap" ${l ? "" : "disabled"} title="Open in Google Maps">Map</button></div>
    ${l?.approx ? `<p class="note warn">Approximate${l.source ? `: ${esc(l.source)}` : ""}. Paste the true spot, or <button id="iExact" class="link">it's right</button>.</p>` : l?.source ? `<p class="note">${esc(l.source)}</p>` : ""}
    <h3>Description</h3>
    <textarea id="iDesc" rows="10" maxlength="${LIMITS.description}" placeholder="What is in the photo" ${off ? "disabled" : ""}>${esc(recipe.description)}</textarea>
    <h3>Tags</h3>
    <input type="text" id="iTags" class="wide" placeholder="comma separated, up to ${LIMITS.tags}" value="${esc(recipe.tags.join(", "))}" ${off ? "disabled" : ""}>
    <h3>Rating</h3>
    <div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button data-star="${n}" class="${n <= recipe.rating ? "on" : ""}" title="${n} star${n > 1 ? "s" : ""}" ${off ? "disabled" : ""}>★</button>`).join("")}
      <button data-star="0" class="ghost" title="No rating" ${off ? "disabled" : ""}>clear</button></div>
    <h3>Read more link</h3>
    <input type="text" id="iLinkUrl" class="wide" maxlength="${LIMITS.linkUrl}" placeholder="https://… (a museum's page, say)" value="${esc(recipe.linkUrl)}" ${off ? "disabled" : ""}>
    <input type="text" id="iLinkLabel" class="wide" maxlength="${LIMITS.linkLabel}" placeholder="Link text (optional)" value="${esc(recipe.linkLabel)}" ${off ? "disabled" : ""} style="margin-top:6px">
    <p class="note">Save settings writes these to the .pano.json and, once there is one, into the edited copy itself (title, description, keywords, rating, place, GPS, and the start view, labels and link), which is what neaves.au reads on upload.</p>`;
  if (off) return;
  $<HTMLInputElement>("iTitle").oninput = e => { recipe.title = (e.target as HTMLInputElement).value.trim(); updateDirty(); };
  for (const b of $("tab-info").querySelectorAll<HTMLButtonElement>("[data-star]")) b.onclick = () => { recipe.rating = Number(b.dataset.star); updateDirty(); drawInfo(); };
  $<HTMLInputElement>("iLinkUrl").onchange = e => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v && !isLinkUrl(v)) return toast("A link must start with http:// or https://", "err");
    recipe.linkUrl = v;
    updateDirty();
  };
  $<HTMLInputElement>("iLinkLabel").oninput = e => { recipe.linkLabel = (e.target as HTMLInputElement).value.trim(); updateDirty(); };
  $<HTMLInputElement>("iPlace").oninput = e => { recipe.place = (e.target as HTMLInputElement).value.trim(); updateDirty(); };
  $<HTMLTextAreaElement>("iDesc").oninput = e => { recipe.description = (e.target as HTMLTextAreaElement).value.trim(); updateDirty(); };
  $<HTMLInputElement>("iTags").onchange = e => { recipe.tags = cleanTags((e.target as HTMLInputElement).value.split(",")); updateDirty(); drawInfo(); };
  $<HTMLInputElement>("iLoc").onchange = e => {
    const text = (e.target as HTMLInputElement).value;
    if (!text.trim()) { recipe.location = null; updateDirty(); return drawInfo(); }
    const at = parseLocation(text);
    if (!at) return toast("Not a location: paste \"lat, lng\" or a Google Maps link", "err");
    if ("short" in at) return toast("A short maps.app.goo.gl link cannot be read here: open it, then copy the long link or the coordinates", "err");
    recipe.location = { lat: round(at.lat, 6), lng: round(at.lng, 6), approx: false, source: "set by hand" };
    updateDirty();
    drawInfo();
  };
  const ex = document.getElementById("iExact");
  if (ex && l) ex.onclick = () => { recipe.location = { ...l, approx: false }; updateDirty(); drawInfo(); };
  $("iMap").onclick = () => { if (recipe.location) window.open(mapsUrl(recipe.location.lat, recipe.location.lng), "_blank", "noopener"); };
}

async function saveSettings(quiet = false) {
  if (!current) return;
  const body = JSON.stringify({ ...recipe, savedAt: new Date().toISOString() });
  await api(`/api/sidecar?path=${encodeURIComponent(current.path)}`, { method: "PUT", body, headers: { "Content-Type": "application/json" } });
  markSaved();
  if (quiet) return;
  // An edited copy already made carries the details too, so an upload picks up the latest.
  const { data } = await api(`/api/details?path=${encodeURIComponent(current.path)}`, { method: "POST" });
  toast(data?.written ? "Settings saved, and written into the edited copy" : "Settings saved beside the original", "ok");
}

async function saveJpeg() {
  if (!current || source === "edited") return;
  const p = current;
  const baseFile = source === "photocraft" ? p.work?.path : p.path;
  if (!baseFile) return;
  // No pixel edits: the copy is the original's own pixels with the details written in, nothing re-encoded.
  const lossless = source === "original" && isIdentityGrade(recipe.grade) && !recipe.blurs.length && !recipe.overlays.length;
  const btn = $<HTMLButtonElement>("saveJpeg");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    // The server writes the details from the .pano.json, so that goes first.
    await saveSettings(true);
    let jpeg: Blob = new Blob([]);
    if (!lossless) {
      const blob = await (await fetch(fileUrl(baseFile, source === "photocraft" ? p.work!.mtime : p.mtime))).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = bakeTo(bmp, bmp.width, bmp.height, recipe.blurs, recipe.grade, await overlaySources());
      bmp.close();
      jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
      canvas.width = canvas.height = 0;
    }
    const url = `/api/save?path=${encodeURIComponent(p.path)}${lossless ? "&lossless=1" : ""}`;
    let r = await api(url, { method: "POST", body: jpeg });
    if (r.status === 409) {
      if (!confirm(`${r.data.path} already exists. Replace it?`)) return;
      r = await api(url + "&overwrite=1", { method: "POST", body: jpeg });
    }
    toast(`Saved ${r.data.path}${lossless ? " (original pixels, details added)" : ""}`, "ok");
  } catch (e: any) {
    toast(`Not saved: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save edited copy";
  }
}

/* ------------------------------------------------------------ live updates */

let relistTimer: ReturnType<typeof setTimeout> | null = null;
/** Re-read the open folder after a save or an export, keeping the current photo's object fresh. */
function relist(then?: () => void) {
  if (relistTimer) clearTimeout(relistTimer);
  relistTimer = setTimeout(async () => {
    if (!listing.path) return;
    const { data } = await api<Listing>(`/api/list?path=${encodeURIComponent(listing.path)}`);
    listing = data;
    if (current) current = listing.photos.find(p => p.path === current!.path) ?? current;
    drawBrowser();
    drawSources();
    then?.();
  }, 250);
}

function listen() {
  const es = new EventSource("/api/events");
  es.addEventListener("work", e => {
    const { path } = JSON.parse((e as MessageEvent).data);
    relist(async () => {
      if (!current || !current.work || current.work.path.toLowerCase() !== String(path).toLowerCase()) return;
      if (source === "photocraft") await show(true);
      // Live is on to watch PhotoCraft, so switch to its picture rather than just saying it changed.
      else if (pcState.on) await setSource("photocraft");
      else toast("PhotoCraft's export updated. Pick PhotoCraft above to see it.");
    });
  });
  es.addEventListener("saved", () => relist());
  es.addEventListener("photocraft", e => {
    pcState = JSON.parse((e as MessageEvent).data);
    drawPhotoCraft();
  });
  es.onerror = () => { /* EventSource reconnects by itself */ };
}

/* ------------------------------------------------------------ start */

async function main() {
  const THREE = await loadThree(THREE_URL);
  engine = new PanoEngine(
    THREE, $<HTMLCanvasElement>("c"),
    { pins: $("pins"), minimap: $("mm"), mmBase: $<HTMLCanvasElement>("mmBase"), mmBox: $<HTMLCanvasElement>("mmBox") },
    { onTap, onToast: (m, k) => toast(m, k === "err" ? "err" : ""), onError: m => toast(m, "err") },
    { badge: null, maxPixelRatio: 1.5 },
  );
  // For poking at from the console.
  (window as any).engine = engine;
  (window as any).desk = { get recipe() { return recipe; }, get source() { return source; }, get current() { return current; }, openPhoto, setSource, saveJpeg, saveSettings, edited, drawPanels, addOverlay, showOverlays };
  config = (await api("/api/config")).data;
  try { presets = readPresets((await api("/api/presets")).data); } catch { /* empty slots until one is saved */ }
  const savedSize = Number(store.get("blurSize"));
  if (savedSize >= BLUR_MIN && savedSize <= BLUR_MAX) blurSize = savedSize;
  $("up").onclick = () => browse(listing.parent);
  $("dirs").onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-path]"); if (b) void browse(b.dataset.path!); };
  $("grid").onclick = e => { const t = (e.target as HTMLElement).closest<HTMLElement>(".tile"); if (t) void openPhoto(listing.photos[Number(t.dataset.i)]); };
  $("sources").onclick = e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-src]"); if (b && !b.disabled) void setSource(b.dataset.src as Source); };
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);
  const hold = (on: boolean) => { if (beforeHeld === on) return; beforeHeld = on; $("before").classList.toggle("held", on); applyPreview(); };
  const before = $("before");
  before.onpointerdown = () => hold(true);
  before.onpointerup = before.onpointerleave = () => hold(false);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) b.onclick = () => {
    for (const o of document.querySelectorAll<HTMLButtonElement>(".tabs button")) o.classList.toggle("on", o === b);
    for (const t of document.querySelectorAll<HTMLElement>(".tab")) t.hidden = t.id !== `tab-${b.dataset.tab}`;
  };
  $("saveJpeg").onclick = () => void saveJpeg();
  $("saveSettings").onclick = () => void saveSettings();
  window.addEventListener("keydown", e => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    if (e.key === "[") step(-1);
    else if (e.key === "]") step(1);
    else if (e.key === "\\" && !e.repeat) hold(true);
    else if (e.key === "Escape") setMode("look");
  });
  window.addEventListener("keyup", e => { if (e.key === "\\") hold(false); });
  window.addEventListener("beforeunload", e => { if (current && dirty()) e.preventDefault(); });
  listen();
  bindOverlayDrag();
  drawPanels();
  drawSources();
  const last = store.get("folder");
  try { await browse(last); } catch { await browse(null); }
  const lastPhoto = store.get("photo");
  const p = listing.photos.find(x => x.path === lastPhoto);
  if (p) await openPhoto(p);
}

main().catch(e => toast(`pano-desk failed to start: ${e?.message ?? e}`, "err"));
