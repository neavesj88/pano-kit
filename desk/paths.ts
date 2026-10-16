/* Which files pano-desk may touch, and what its copies are called.
 *
 * The server only reads under the configured roots and the PhotoCraft working
 * folder, and only ever writes these beside an original: edited\Edited_<name>.jpg,
 * <name>.pano.json, the <name>.overlays folder and, in the working folder, a copy
 * of the original for PhotoCraft to open. The original itself is never written.
 */
import path from "node:path";

const win = process.platform === "win32";
const norm = (p: string) => {
  const r = path.resolve(p);
  return win ? r.toLowerCase() : r;
};

/** p is root itself or somewhere beneath it. */
export function isInside(root: string, p: string): boolean {
  const r = norm(root), q = norm(p);
  if (q === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return q.startsWith(withSep);
}

export const isInsideAny = (roots: string[], p: string) => roots.some(r => isInside(r, p));

/** Where saved copies go, beside the originals, and how they are named. */
export const EDITED_DIR = "edited";
export const EDITED_PREFIX = "Edited_";
// Edited_<name>.jpg now; <name>_edited.jpg as copies were named before 16 Oct 2026, so those are never taken for originals.
const EDITED = /^Edited_.+\.jpe?g$|_edited\.jpe?g$/i;
export const isEditedName = (name: string) => EDITED.test(path.basename(name));
export const isJpegName = (name: string) => /\.jpe?g$/i.test(name);
export const isSidecarName = (name: string) => /\.pano\.json$/i.test(name);

const stem = (file: string) => file.slice(0, file.length - path.extname(file).length);
/** pano\IMG_1.jpg -> pano\edited\Edited_IMG_1.jpg. */
export const editedPath = (original: string) =>
  path.join(path.dirname(original), EDITED_DIR, EDITED_PREFIX + path.basename(stem(original)) + ".jpg");
/** IMG_1.jpg -> IMG_1.pano.json, beside it. */
export const sidecarPath = (original: string) => stem(original) + ".pano.json";
/** IMG_1.jpg -> IMG_1.overlays\, beside it: the flat photos set into it (then-and-now). */
export const overlayDir = (original: string) => stem(original) + ".overlays";

/** A name for a dropped-in photo that is safe on any disk: letters, digits, space, . _ - only, and an image extension. */
export function overlayFileName(name: string): string | null {
  // Either separator, whatever this machine uses: the name comes from a browser.
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const ext = path.extname(leaf).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return null;
  const base = leaf.slice(0, leaf.length - ext.length).replace(/[^A-Za-z0-9 ._-]+/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 80) || "photo";
  return base + ext;
}

/** Where the original goes for PhotoCraft (its automation can only reach the working
 *  folder), keeping its folders below the root it is in: E:\04_10_2026_paris\pano\IMG.jpg
 *  -> <work>\04_10_2026_paris\pano\IMG.jpg, so two trips' "pano" folders never meet.
 *  PhotoCraft's export lands beside it as IMG_edited.jpg. */
export function workCopyPath(original: string, work: string, roots: string[] = []): string {
  const root = roots.filter(r => isInside(r, original)).sort((a, b) => b.length - a.length)[0];
  const rel = root ? path.relative(root, original) : path.join(path.basename(path.dirname(original)), path.basename(original));
  return path.join(work, rel);
}

/** The same, relative to the working folder with forward slashes: how PhotoCraft's automation names files. */
export const workRelative = (p: string, work: string) => path.relative(work, p).split(path.sep).join("/");

/** Folders a person never wants to browse into. */
export const isHiddenDir = (name: string) =>
  /^[.$]/.test(name) || /^System Volume Information$/i.test(name) || /\.overlays$/i.test(name) || name.toLowerCase() === EDITED_DIR;
