/* pano-desk's page: browse trip folders, look at a 360, grade it, blur what
 * should not be seen, set how the gallery opens it, follow PhotoCraft live,
 * and save <name>_edited.jpg plus a <name>.pano.json recipe beside the original.
 *
 * Everything that changes pixels is pano-kit's (grade, bake), the same code for
 * the preview and the saved file, so the preview is what gets saved. */
import { PanoEngine, loadThree } from "../../src/engine";
import {
  DEFAULT_VIEW, DEFAULT_VIEWER_SETTINGS, NADIR_DEG_MAX, compareFolders, normaliseView, parseFolder, shortDate,
  type Blur, type Hotspot, type View,
} from "../../src/core";
import { DEFAULT_GRADE, GRADE_RANGES, isIdentityGrade, normaliseGrade, type Grade, type GradeKey } from "../../src/grade";
import { bakeTo, canvasToJpeg } from "../../src/bake";

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
interface Recipe { version: 1; base: Base; grade: Grade; blurs: Blur[]; start: View; hotspots: Hotspot[]; nadir: Nadir; savedAt?: string }

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
let pcState: Record<string, any> = { on: false };
let config: { roots: string[]; work: string | null; photocraft: boolean } = { roots: [], work: null, photocraft: false };

function freshRecipe(): Recipe {
  return { version: 1, base: "original", grade: { ...DEFAULT_GRADE }, blurs: [], start: { ...DEFAULT_VIEW }, hotspots: [], nadir: { cover: "none", deg: 25, rot: 0 } };
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
  r.savedAt = typeof raw.savedAt === "string" ? raw.savedAt : undefined;
  return r;
}

const dirty = () => JSON.stringify({ ...recipe, savedAt: undefined }) !== savedJson;
function markSaved() { savedJson = JSON.stringify({ ...recipe, savedAt: undefined }); updateDirty(); }
function updateDirty() { $("dirty").textContent = current && dirty() ? "Unsaved changes" : ""; }

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

/** The sliders and blurs, live, unless looking at the saved file or holding Before. */
function applyPreview() {
  const off = source === "edited" || beforeHeld;
  engine.setGradePreview(off ? null : recipe.grade);
  engine.setBlurPreview(off || !recipe.blurs.length ? null : recipe.blurs);
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
    recipe.hotspots.push({ yaw: round(at.yaw, 2), pitch: round(at.pitch, 2), text: text.slice(0, 120) });
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

function drawPanels() {
  const off = !current || source === "edited";
  const g = recipe.grade;
  $("tab-adjust").innerHTML = `
    ${off && current ? `<p class="note">Showing the saved _edited.jpg as it is. Pick Original or PhotoCraft above to edit.</p>` : ""}
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
    <p class="note">3. Sliders and blurs here go on top of it. <b>Save _edited.jpg</b> writes the result beside the original.</p>
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

async function saveSettings(quiet = false) {
  if (!current) return;
  const body = JSON.stringify({ ...recipe, savedAt: new Date().toISOString() });
  await api(`/api/sidecar?path=${encodeURIComponent(current.path)}`, { method: "PUT", body, headers: { "Content-Type": "application/json" } });
  markSaved();
  if (!quiet) toast("Settings saved beside the original", "ok");
}

async function saveJpeg() {
  if (!current || source === "edited") return;
  const p = current;
  const baseFile = source === "photocraft" ? p.work?.path : p.path;
  if (!baseFile) return;
  if (source === "original" && isIdentityGrade(recipe.grade) && !recipe.blurs.length && !confirm("No sliders or blurs are set, so this would save the original again. Save anyway?")) return;
  const btn = $<HTMLButtonElement>("saveJpeg");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const blob = await (await fetch(fileUrl(baseFile, source === "photocraft" ? p.work!.mtime : p.mtime))).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = bakeTo(bmp, bmp.width, bmp.height, recipe.blurs, recipe.grade);
    bmp.close();
    const jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
    canvas.width = canvas.height = 0;
    const url = `/api/save?path=${encodeURIComponent(p.path)}`;
    let r = await api(url, { method: "POST", body: jpeg });
    if (r.status === 409) {
      if (!confirm(`${r.data.path} already exists. Replace it?`)) return;
      r = await api(url + "&overwrite=1", { method: "POST", body: jpeg });
    }
    await saveSettings(true);
    toast(`Saved ${r.data.path}`, "ok");
  } catch (e: any) {
    toast(`Not saved: ${e.message}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save _edited.jpg";
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
  (window as any).desk = { get recipe() { return recipe; }, get source() { return source; }, get current() { return current; }, openPhoto, setSource, saveJpeg, saveSettings, edited, drawPanels };
  config = (await api("/api/config")).data;
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
  drawPanels();
  drawSources();
  const last = store.get("folder");
  try { await browse(last); } catch { await browse(null); }
  const lastPhoto = store.get("photo");
  const p = listing.photos.find(x => x.path === lastPhoto);
  if (p) await openPhoto(p);
}

main().catch(e => toast(`pano-desk failed to start: ${e?.message ?? e}`, "err"));
