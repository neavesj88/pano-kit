/* pano-desk: a local 360 viewer and editor on pano-kit.
 *
 *   node desk/server.ts          serve on 127.0.0.1 (see config.local.json)
 *   node desk/server.ts --app    ...and open it as an app window; quits when the window closes
 *   --config FILE  another config (default desk/config.local.json); --port N  another port
 *
 * Node runs this file as it is (type stripping, Node 22.18+): no build for the
 * server, only for the page (npm run desk:build). The page does the image
 * work, because the browser already decodes and draws the photo; this only
 * lists folders, hands files over, stores what the page saves beside the
 * original, and relays PhotoCraft.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withMetadata } from "../src/jpeg.ts";
import { isPano, readJpegHeader, type JpegHeader } from "./header.ts";
import {
  EDITED_DIR, editedPath, isEditedName, isHiddenDir, isInsideAny, isJpegName, isSidecarName, overlayDir, overlayFileName, sidecarPath, workCopyPath, workRelative,
} from "./paths.ts";
import { PhotoCraft, type PhotoCraftConfig } from "./photocraft.ts";
import { detailsFromRecipe } from "./details.ts";
import { readPresets } from "./presets.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");

interface Config {
  roots: string[];
  work: string | null;
  port: number;
  browser: string | null;
  photocraft: PhotoCraftConfig | null;
  /** A folder of cut-out pictures (transparent PNGs) to place into a 360 like a then-and-now photo. */
  stickers: string | null;
  /** The nadir disk baked into saved copies: whose © it carries, the title when a photo has none,
   *  its ring colour and its size in degrees from straight down. */
  badge: { owner: string | null; untitled: string; accent: string | null; deg: number };
  cache: string;
}

function loadConfig(argv: string[]): Config {
  const configArg = argv.indexOf("--config");
  const file = configArg >= 0 ? path.resolve(argv[configArg + 1]) : path.join(HERE, "config.local.json");
  let raw: any = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  else console.warn(`No ${file}: copy config.example.json to it and set your folders.`);
  const portArg = argv.indexOf("--port");
  const cfg: Config = {
    roots: (Array.isArray(raw.roots) ? raw.roots : []).map((r: string) => path.resolve(r)),
    work: raw.work ? path.resolve(raw.work) : null,
    port: portArg >= 0 ? Number(argv[portArg + 1]) : Number(raw.port) || 5196,
    browser: raw.browser ?? null,
    photocraft: raw.photocraft?.cli ? { cli: raw.photocraft.cli, port: Number(raw.photocraft.port) || 7878, tokenFile: raw.photocraft.tokenFile } : null,
    stickers: raw.stickers ? path.resolve(raw.stickers) : null,
    badge: {
      owner: typeof raw.badge?.owner === "string" && raw.badge.owner.trim() ? raw.badge.owner.trim() : null,
      untitled: typeof raw.badge?.untitled === "string" ? raw.badge.untitled : "",
      accent: typeof raw.badge?.accent === "string" ? raw.badge.accent : null,
      deg: Number(raw.badge?.deg) >= 5 && Number(raw.badge?.deg) <= 75 ? Number(raw.badge.deg) : 12,
    },
    cache: raw.cache ? path.resolve(raw.cache) : path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "pano-desk"),
  };
  for (const r of cfg.roots) if (!fs.existsSync(r)) console.warn(`Root not found (yet): ${r}`);
  return cfg;
}

const argv = process.argv.slice(2);
const cfg = loadConfig(argv);
const appMode = argv.includes("--app");
const readable = () => [...cfg.roots, ...(cfg.work ? [cfg.work] : [])];
const pc = cfg.photocraft ? new PhotoCraft(cfg.photocraft) : null;

/* ------------------------------------------------------------ helpers */

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new HttpError(413, "Too big");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A path from the page, resolved through any links, and only if it is somewhere the app may read. */
async function allowed(p: string | null, roots: string[] = readable()): Promise<string> {
  if (!p) throw new HttpError(400, "No path given");
  const full = path.resolve(p);
  let real = full;
  try { real = await fsp.realpath(full); } catch { /* not there yet: checked as written */ }
  if (!isInsideAny(roots, full) || !isInsideAny(roots, real)) throw new HttpError(403, "That folder is outside the ones pano-desk is set up for");
  return full;
}

/** An original photo: under a root, a JPEG, not one of our own copies. */
async function originalPath(p: string | null): Promise<string> {
  const full = await allowed(p, cfg.roots);
  if (!isJpegName(full) || isEditedName(full)) throw new HttpError(400, "Not an original JPEG");
  return full;
}

async function writeAtomic(target: string, data: Uint8Array | string) {
  const tmp = `${target}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, target);
}

const headers = new Map<string, { size: number; mtime: number; h: JpegHeader }>();
async function header(file: string, st: fs.Stats): Promise<JpegHeader> {
  const c = headers.get(file);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.h;
  let h: JpegHeader | null = null;
  const fd = await fsp.open(file, "r");
  try {
    for (const n of [256 * 1024, 4 * 1024 * 1024]) {
      const buf = Buffer.alloc(Math.min(n, st.size));
      await fd.read(buf, 0, buf.length, 0);
      h = readJpegHeader(buf);
      if (h || buf.length >= st.size) break;
    }
  } catch {
    h = null;
  } finally {
    await fd.close();
  }
  h ??= { width: 0, height: 0, equirect: false };
  headers.set(file, { size: st.size, mtime: st.mtimeMs, h });
  return h;
}

async function statOrNull(p: string) {
  try { return await fsp.stat(p); } catch { return null; }
}

/** The details saved for an original (its .pano.json), as they go into its copy. */
async function savedDetails(original: string) {
  try { return detailsFromRecipe(JSON.parse(await fsp.readFile(sidecarPath(original), "utf8"))); } catch { return {}; }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, cache: string) {
  const st = await statOrNull(file);
  if (!st?.isFile()) throw new HttpError(404, "Not found");
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Length": st.size, ETag: etag, "Cache-Control": cache });
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------ events */

const clients = new Set<http.ServerResponse>();
let quitTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(type: string, data: unknown) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

function events(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(`event: hello\ndata: {}\n\n`);
  clients.add(res);
  if (quitTimer) clearTimeout(quitTimer);
  quitTimer = null;
  broadcast("photocraft", live.state);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    // Launched as an app: the window is the app, so closing the last one stops the server too.
    if (appMode && clients.size === 0) quitTimer = setTimeout(() => process.exit(0), 15000);
  });
}

if (cfg.work && fs.existsSync(cfg.work)) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  fs.watch(cfg.work, { recursive: true }, (_ev, name) => {
    if (!name || !isJpegName(String(name))) return;
    const full = path.join(cfg.work!, String(name));
    // An export arrives as several writes: report it once it has settled.
    clearTimeout(timers.get(full));
    timers.set(full, setTimeout(async () => {
      timers.delete(full);
      const st = await statOrNull(full);
      if (st) broadcast("work", { path: full, mtime: st.mtimeMs });
    }, 500));
  });
}

/* ----------------------------------------------------- PhotoCraft live */

const live = {
  original: null as string | null,
  state: { on: false, connected: false, doc: null as string | null, matched: false, exporting: false, message: "" } as Record<string, unknown>,
  seenRev: -1,
  changedAt: 0,
  exportedRev: -1,
  busy: false,
};

function setLive(patch: Record<string, unknown>) {
  const next = { ...live.state, ...patch };
  if (JSON.stringify(next) !== JSON.stringify(live.state)) {
    live.state = next;
    broadcast("photocraft", next);
  }
}

const samePath = (a: string | null, b: string | null) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** PhotoCraft names a file it opened through its automation relative to that root (the working folder). */
const docFile = (p: string | null) => (!p ? null : path.isAbsolute(p) ? p : cfg.work ? path.join(cfg.work, p) : null);

async function livePoll() {
  if (!pc || !cfg.work || !live.original || live.busy) return;
  live.busy = true;
  try {
    const doc = await pc.activeDoc();
    const copy = workCopyPath(live.original, cfg.work, cfg.roots);
    const file = docFile(doc?.path ?? null);
    const matched = !!doc && (samePath(file, copy) || samePath(file, live.original) || doc.name.toLowerCase() === path.basename(live.original).toLowerCase());
    setLive({ connected: true, doc: doc?.name ?? null, matched, message: matched ? "" : doc ? `PhotoCraft's front image is ${doc.name}` : "No image open in PhotoCraft" });
    if (!doc || !matched) return;
    const now = Date.now();
    if (doc.revision !== live.seenRev) {
      live.seenRev = doc.revision;
      live.changedAt = now;
    }
    // Wait until the edits stop for a moment: a slider drag is dozens of revisions.
    if (doc.revision !== live.exportedRev && now - live.changedAt >= 700) {
      setLive({ exporting: true });
      // PhotoCraft writes the file but may not make its folder.
      await fsp.mkdir(path.dirname(editedPath(copy)), { recursive: true });
      await pc.exportActive(workRelative(editedPath(copy), cfg.work));
      live.exportedRev = doc.revision;
      setLive({ exporting: false, message: "" });
    }
  } catch (e: any) {
    setLive({ connected: false, exporting: false, matched: false, message: e.message });
  } finally {
    live.busy = false;
  }
}
setInterval(livePoll, 1200);

/* ------------------------------------------------------------ routes */

/** Every 360 original in a folder and all the folders below it (not the edited, overlay or
 *  hidden ones), for bulk work: the same photo objects as list(), each with its folder. */
async function scan(dir: string) {
  const photos: unknown[] = [];
  const walk = async (d: string) => {
    const listing = await list(d);
    photos.push(...listing.photos);
    for (const sub of listing.dirs.sort((a, b) => a.name.localeCompare(b.name))) await walk(sub.path);
  };
  await walk(dir);
  return { path: dir, photos };
}

async function list(dir: string | null) {
  if (!dir) return { path: null, parent: null, dirs: cfg.roots.map(r => ({ name: r, path: r })), photos: [], hidden: 0 };
  const full = await allowed(dir);
  const entries = await fsp.readdir(full, { withFileTypes: true });
  const names = new Set(entries.map(e => e.name.toLowerCase()));
  // Saved copies live in the edited folder beside the originals: read it once, not once per photo.
  const editedNames = new Set((await fsp.readdir(path.join(full, EDITED_DIR)).catch(() => [] as string[])).map(n => n.toLowerCase()));
  const dirs = entries.filter(e => e.isDirectory() && !isHiddenDir(e.name)).map(e => ({ name: e.name, path: path.join(full, e.name) }));
  const photos = [];
  let hidden = 0;
  for (const e of entries) {
    if (!e.isFile() || !isJpegName(e.name) || isEditedName(e.name)) continue;
    const file = path.join(full, e.name);
    const st = await fsp.stat(file);
    const h = await header(file, st);
    if (!isPano(h)) {
      hidden++;
      continue;
    }
    const edited = editedNames.has(path.basename(editedPath(file)).toLowerCase()) ? await statOrNull(editedPath(file)) : null;
    const work = cfg.work && !isInsideAny([cfg.work], file) ? await statOrNull(editedPath(workCopyPath(file, cfg.work, cfg.roots))) : null;
    const sidecar = names.has(path.basename(sidecarPath(file)).toLowerCase());
    let skip = false;
    if (sidecar) try { skip = JSON.parse(await fsp.readFile(sidecarPath(file), "utf8"))?.skip === true; } catch { /* unreadable settings: not marked */ }
    photos.push({
      name: e.name, path: file, size: st.size, mtime: st.mtimeMs, width: h.width, height: h.height,
      edited: edited ? { path: editedPath(file), mtime: edited.mtimeMs } : null,
      work: work && cfg.work ? { path: editedPath(workCopyPath(file, cfg.work, cfg.roots)), mtime: work.mtimeMs } : null,
      sidecar, skip,
    });
  }
  const parent = cfg.roots.some(r => samePath(r, full)) ? null : path.dirname(full);
  return { path: full, parent, dirs, photos, hidden };
}

const thumbFile = (file: string, st: fs.Stats) =>
  path.join(cfg.cache, "thumbs", crypto.createHash("sha1").update(`${file.toLowerCase()}|${st.size}|${st.mtimeMs}`).digest("hex") + ".jpg");

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  // Only this machine's own page: refuse other Host names (DNS rebinding) and,
  // for anything that writes, other origins and plain cross-site form posts.
  const host = req.headers.host ?? "";
  if (host !== `127.0.0.1:${cfg.port}` && host !== `localhost:${cfg.port}`) throw new HttpError(403, "Wrong host");
  const url = new URL(req.url ?? "/", `http://${host}`);
  const q = (k: string) => url.searchParams.get(k);
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (req.headers["x-pano-desk"] !== "1" || (origin && origin !== `http://${host}`)) throw new HttpError(403, "Refused");
  }
  const p = url.pathname;

  if (p === "/api/ping") return send(res, 200, { app: "pano-desk" });
  if (p === "/api/config") return send(res, 200, { roots: cfg.roots, work: cfg.work, photocraft: !!pc, badge: cfg.badge });
  if (p === "/api/events") return events(req, res);
  if (p === "/api/list") return send(res, 200, await list(q("path")));
  if (p === "/api/scan") return send(res, 200, await scan(await allowed(q("path"), cfg.roots)));
  if (p === "/api/file") return sendFile(req, res, await allowed(q("path")), "no-cache");

  // The stickers folder: its pictures by name, and one picture. Only names overlayFileName
  // leaves as they are, so nothing outside the folder can be asked for.
  if (p === "/api/stickers") {
    if (!cfg.stickers) return send(res, 200, { names: [] });
    const names = (await fsp.readdir(cfg.stickers).catch(() => [] as string[])).filter(n => overlayFileName(n) === n);
    return send(res, 200, { names: names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) });
  }
  if (p === "/api/sticker") {
    const name = q("name") ?? "";
    if (!cfg.stickers || overlayFileName(name) !== name) throw new HttpError(404, "No such sticker");
    return sendFile(req, res, path.join(cfg.stickers, name), "no-cache");
  }

  if (p === "/api/thumb") {
    const file = await allowed(q("path"));
    const st = await statOrNull(file);
    if (!st) throw new HttpError(404, "Not found");
    const t = thumbFile(file, st);
    if (req.method === "PUT") {
      await fsp.mkdir(path.dirname(t), { recursive: true });
      await writeAtomic(t, await readBody(req, 4 * 1024 * 1024));
      return send(res, 200, { ok: true });
    }
    return sendFile(req, res, t, "no-cache");
  }

  // The three grade presets, in the app's own data folder (beside the thumbnail cache).
  if (p === "/api/presets") {
    const file = path.join(cfg.cache, "presets.json");
    if (req.method === "PUT") {
      const slots = readPresets(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")));
      await fsp.mkdir(cfg.cache, { recursive: true });
      await writeAtomic(file, JSON.stringify({ slots }, null, 2) + "\n");
      return send(res, 200, { slots });
    }
    let raw: unknown = null;
    try { raw = JSON.parse(await fsp.readFile(file, "utf8")); } catch { /* none saved yet */ }
    return send(res, 200, { slots: readPresets(raw) });
  }

  if (p === "/api/sidecar") {
    const original = await originalPath(q("path"));
    const side = sidecarPath(original);
    if (req.method === "PUT") {
      const data = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Settings must be an object");
      await writeAtomic(side, JSON.stringify(data, null, 2) + "\n");
      broadcast("saved", { path: side });
      return send(res, 200, { path: side });
    }
    const st = await statOrNull(side);
    if (!st) return send(res, 200, null);
    return send(res, 200, JSON.parse(await fsp.readFile(side, "utf8")));
  }

  // "Don't upload": a mark in the .pano.json that the upload staging leaves out. Set on its own,
  // so marking a photo never saves the page's other unsaved changes. Nothing is deleted.
  if (p === "/api/skip" && req.method === "POST") {
    const original = await originalPath(q("path"));
    const side = sidecarPath(original);
    const data = (await statOrNull(side)) ? JSON.parse(await fsp.readFile(side, "utf8")) : { version: 1 };
    if (q("on") === "1") data.skip = true;
    else delete data.skip;
    await writeAtomic(side, JSON.stringify(data, null, 2) + "\n");
    broadcast("saved", { path: side });
    return send(res, 200, { skip: data.skip === true });
  }

  // The page's baked JPEG (or, with lossless=1, the original's own pixels) with the
  // original's metadata and the details from its .pano.json written in.
  if (p === "/api/save" && req.method === "POST") {
    const original = await originalPath(q("path"));
    const target = editedPath(original);
    if (samePath(target, original)) throw new HttpError(400, "Refusing to write over the original");
    if ((await statOrNull(target)) && q("overwrite") !== "1") return send(res, 409, { exists: true, path: target });
    const body = await readBody(req, 400 * 1024 * 1024);
    const before = await fsp.stat(original);
    const orig = await fsp.readFile(original);
    const out = withMetadata(q("lossless") === "1" ? orig : body, orig, await savedDetails(original));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, out);
    const after = await fsp.stat(original);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new HttpError(500, "The original changed while saving; check it");
    broadcast("saved", { path: target });
    return send(res, 200, { path: target, bytes: out.length });
  }

  // A flat photo for then-and-now, kept in <name>.overlays\ beside the original so the
  // recipe can name it. The same name with different bytes gets a -2, -3... suffix.
  if (p === "/api/overlay" && req.method === "PUT") {
    const original = await originalPath(q("path"));
    const name = overlayFileName(q("name") ?? "");
    if (!name) throw new HttpError(400, "Only JPEG, PNG or WebP photos can be overlaid");
    const body = await readBody(req, 80 * 1024 * 1024);
    const dir = overlayDir(original);
    await fsp.mkdir(dir, { recursive: true });
    const ext = path.extname(name), base = name.slice(0, -ext.length);
    for (let n = 1; n < 1000; n++) {
      const file = path.join(dir, n === 1 ? name : `${base}-${n}${ext}`);
      const st = await statOrNull(file);
      if (st && (st.size !== body.length || !body.equals(await fsp.readFile(file)))) continue;
      if (!st) await writeAtomic(file, body);
      return send(res, 200, { file: path.basename(file), path: file });
    }
    throw new HttpError(409, "Too many photos with that name");
  }

  // New details into an existing saved copy, its pixels untouched.
  if (p === "/api/details" && req.method === "POST") {
    const original = await originalPath(q("path"));
    const target = editedPath(original);
    const edited = await statOrNull(target);
    if (!edited) return send(res, 200, { written: false });
    const out = withMetadata(await fsp.readFile(target), await fsp.readFile(original), await savedDetails(original));
    await writeAtomic(target, out);
    broadcast("saved", { path: target });
    return send(res, 200, { written: true, path: target });
  }

  if (p === "/api/photocraft/open" && req.method === "POST") {
    if (!pc || !cfg.work) throw new HttpError(400, "PhotoCraft is not set up in config.local.json");
    const original = await originalPath(q("path"));
    const copy = workCopyPath(original, cfg.work, cfg.roots);
    if (!(await statOrNull(copy))) {
      await fsp.mkdir(path.dirname(copy), { recursive: true });
      await fsp.copyFile(original, copy, fs.constants.COPYFILE_EXCL);
    }
    // Opening a file PhotoCraft already has open makes a second tab of it, so say where it is instead.
    const { docs } = await pc.documents();
    const open = docs.find(d => samePath(docFile(d.path), copy));
    if (open) return send(res, 200, { copy, already: true, tab: open.index + 1 });
    await pc.open(workRelative(copy, cfg.work));
    return send(res, 200, { copy, already: false });
  }

  if (p === "/api/photocraft/live" && req.method === "POST") {
    if (!pc || !cfg.work) throw new HttpError(400, "PhotoCraft is not set up in config.local.json");
    const on = q("on") === "1";
    live.original = on ? await originalPath(q("path")) : null;
    live.seenRev = live.exportedRev = -1;
    live.changedAt = 0;
    setLive({ on, connected: false, doc: null, matched: false, exporting: false, message: on ? "Connecting to PhotoCraft…" : "" });
    if (on) void livePoll();
    return send(res, 200, { on });
  }

  if (p.startsWith("/api/")) throw new HttpError(404, "No such call");

  // The page.
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("pano-desk's page is not built yet: run  npm run desk:build  in the pano-kit folder.");
  }
  const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
  const file = path.resolve(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) throw new HttpError(403, "Refused");
  return sendFile(req, res, file, rel.startsWith("vendor/") || rel.startsWith("assets/") ? "max-age=31536000, immutable" : "no-cache");
}

/* ------------------------------------------------------------ start */

function openWindow() {
  const browser = cfg.browser ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  spawn(browser, [`--app=http://127.0.0.1:${cfg.port}/`, "--window-size=1680,1000"], { detached: true, stdio: "ignore" }).unref();
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e: any) => {
    if (res.headersSent) return res.end();
    send(res, e instanceof HttpError ? e.status : 500, { error: e?.message ?? String(e) });
  });
});

server.on("error", async (e: any) => {
  if (e.code !== "EADDRINUSE") throw e;
  // Already running (another shortcut click): just open another window onto it.
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/ping`);
    if ((await r.json()).app === "pano-desk") {
      if (appMode) openWindow();
      console.log(`pano-desk is already running on ${cfg.port}`);
      process.exit(0);
    }
  } catch { /* something else has the port */ }
  console.error(`Port ${cfg.port} is taken by something else; set "port" in config.local.json`);
  process.exit(1);
});

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`pano-desk on http://127.0.0.1:${cfg.port}/  roots: ${cfg.roots.join(", ") || "(none)"}  work: ${cfg.work ?? "(none)"}`);
  if (appMode) openWindow();
});

process.on("exit", () => pc?.stop());
