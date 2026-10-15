/* Which files pano-desk may touch, and what its copies are called.
 *
 * The server only reads under the configured roots and the PhotoCraft working
 * folder, and only ever writes three kinds of file beside an original:
 * <name>_edited.jpg, <name>.pano.json and, in the working folder, a copy of
 * the original for PhotoCraft to open. The original itself is never written.
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

const EDITED = /_edited\.jpe?g$/i;
export const isEditedName = (name: string) => EDITED.test(name);
export const isJpegName = (name: string) => /\.jpe?g$/i.test(name);
export const isSidecarName = (name: string) => /\.pano\.json$/i.test(name);

const stem = (file: string) => file.slice(0, file.length - path.extname(file).length);
/** IMG_1.jpg -> IMG_1_edited.jpg, beside it. */
export const editedPath = (original: string) => stem(original) + "_edited.jpg";
/** IMG_1.jpg -> IMG_1.pano.json, beside it. */
export const sidecarPath = (original: string) => stem(original) + ".pano.json";

/** Where the original goes for PhotoCraft (its automation can only reach the working
 *  folder), keeping the trip folder's name: E:\04_10_2026_paris\IMG.jpg ->
 *  <work>\04_10_2026_paris\IMG.jpg. PhotoCraft's export lands beside it as IMG_edited.jpg. */
export function workCopyPath(original: string, work: string): string {
  return path.join(work, path.basename(path.dirname(original)), path.basename(original));
}

/** The same, relative to the working folder with forward slashes: how PhotoCraft's automation names files. */
export const workRelative = (p: string, work: string) => path.relative(work, p).split(path.sep).join("/");

/** Folders a person never wants to browse into. */
export const isHiddenDir = (name: string) => /^[.$]/.test(name) || /^System Volume Information$/i.test(name);
