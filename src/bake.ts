/* Blur regions, and optionally a grade and overlaid photos, painted into a copy of a photo.
 *
 * Use it for both the live preview and the published files, so what the
 * curator sees is exactly what visitors get. Blurs are baked, never applied at
 * view time: the published image simply does not contain the face. Ported
 * from the test rig's paintBake.
 */
import { capPolygon, clamp, type Blur } from "./core";
import { applyGrade, isIdentityGrade, type Grade } from "./grade";
import { edgeMask, footprint, overlayCamera, type Overlay } from "./overlay";
import { paintNadir, type NadirSource } from "./nadir";

type Source = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/** A flat photo to set into the 360 (pano-kit overlay), with its picture. */
export interface OverlaySource {
  image: Source;
  overlay: Overlay;
}

const sizeOf = (src: Source) => ({
  w: "naturalWidth" in src ? src.naturalWidth : src.width,
  h: "naturalHeight" in src ? src.naturalHeight : src.height,
});

function traceCap(ctx: CanvasRenderingContext2D, poly: [number, number][], offset: number) {
  ctx.moveTo(poly[0][0] + offset, poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] + offset, poly[i][1]);
  ctx.closePath();
}

/** Draws `src` into `ctx` at W×H with every blur region applied, then the grade if one is given,
 *  then any overlaid photos (which keep their own colours: the grade is the 360's), then the
 *  nadir disk over everything, as the viewer layers them. */
export function paintBake(
  ctx: CanvasRenderingContext2D, W: number, H: number, src: Source, blurs: Blur[], grade?: Grade | null, overlays?: OverlaySource[] | null,
  nadir?: NadirSource | null,
) {
  const { w: sw0, h: sh0 } = sizeOf(src);
  // The source may be a different size from the target (a derivative, a thumbnail):
  // map source rectangles proportionally.
  const kx = sw0 / W;
  const ky = sh0 / H;
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(src, 0, 0, W, H);

  for (const b of blurs) {
    if ("u" in b) {
      // Flat photo: a circle in image space, r as a percent of the width.
      const cx = b.u * W, cy = b.v * H, rad = (b.r / 100) * W, px = clamp(rad * 0.35, 8, 80);
      const m = Math.ceil(px * 3);
      const sx = Math.max(0, cx - rad - m), sy = Math.max(0, cy - rad - m);
      const sw = Math.min(W, cx + rad + m) - sx, sh = Math.min(H, cy + rad + m) - sy;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = `blur(${px}px)`;
      ctx.drawImage(src, sx * kx, sy * ky, sw * kx, sh * ky, sx, sy, sw, sh);
      ctx.restore();
      continue;
    }
    const poly = capPolygon(b.yaw, b.pitch, b.r, W, H);
    const ys = poly.map(p => p[1]);
    const xs = poly.map(p => p[0]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
    const px = clamp((y1 - y0) * 0.12, 8, 80);
    const m = Math.ceil(px * 3);
    const sy = Math.max(0, y0 - m), sh = Math.min(H, y1 + m) - sy;
    let sx = Math.max(0, Math.floor(Math.min(...xs)) - m);
    let sw = Math.min(W, Math.ceil(Math.max(...xs)) + m) - sx;
    // Across the seam, or very wide near a pole: take the whole row band.
    if (Math.max(...xs) > W || Math.min(...xs) < 0 || sw > W * 0.7) {
      sx = 0;
      sw = W;
    }
    ctx.save();
    ctx.beginPath();
    for (const off of [-W, 0, W]) traceCap(ctx, poly, off);
    ctx.clip();
    ctx.filter = `blur(${px}px)`;
    ctx.drawImage(src, sx * kx, sy * ky, sw * kx, sh * ky, sx, sy, sw, sh);
    ctx.restore();
  }
  ctx.filter = "none";
  if (grade && !isIdentityGrade(grade)) {
    const data = ctx.getImageData(0, 0, W, H);
    applyGrade(data.data, grade);
    ctx.putImageData(data, 0, 0);
  }
  if (overlays?.length) paintOverlays(ctx, W, H, overlays);
  if (nadir) paintNadir(ctx, W, H, nadir);
}

/**
 * Each overlaid photo into an equirect W×H, by inverse mapping: every pixel it
 * can touch asks where its direction lands on the photo, takes that colour
 * (bilinear, with the photo's own transparency) and mixes it in by the soft
 * edge and the opacity. The photo is first scaled to about the size it covers,
 * because sampling a big photo sparsely shimmers.
 */
export function paintOverlays(ctx: CanvasRenderingContext2D, W: number, H: number, overlays: OverlaySource[]) {
  for (const { image, overlay } of overlays) {
    const { w: iw, h: ih } = sizeOf(image);
    if (!iw || !ih || overlay.opacity <= 0) continue;
    const k = Math.min(1, Math.ceil((overlay.hfov / 360) * W * 1.5) / iw);
    const pw = Math.max(2, Math.round(iw * k)), ph = Math.max(2, Math.round(ih * k));
    const pc = document.createElement("canvas");
    pc.width = pw;
    pc.height = ph;
    const pctx = pc.getContext("2d", { willReadFrequently: true });
    if (!pctx) throw new Error("This browser could not make a 2D canvas");
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(image, 0, 0, pw, ph);
    const photo = pctx.getImageData(0, 0, pw, ph).data;
    const { fwd, right, up, f } = overlayCamera(overlay, pw, ph);
    const fp = footprint(overlay, pw, ph, W, H);
    const runs = fp.x1 > W ? [[fp.x0, W], [0, fp.x1 - W]] : [[fp.x0, fp.x1]];
    for (const [a, b] of runs) {
      if (b <= a || fp.y1 <= fp.y0) continue;
      const block = ctx.getImageData(a, fp.y0, b - a, fp.y1 - fp.y0);
      const px = block.data, bw = b - a;
      const sinY = new Float64Array(bw), cosY = new Float64Array(bw);
      for (let i = 0; i < bw; i++) {
        const yaw = (((a + i + 0.5) / W) * 360 - 180) * (Math.PI / 180);
        sinY[i] = Math.sin(yaw);
        cosY[i] = Math.cos(yaw);
      }
      for (let j = fp.y0; j < fp.y1; j++) {
        const pitch = (90 - ((j + 0.5) / H) * 180) * (Math.PI / 180);
        const cp = Math.cos(pitch), sp = Math.sin(pitch);
        for (let i = 0; i < bw; i++) {
          // direction(yaw, pitch) as overlay.ts defines it, inlined: this loop runs for every pixel the photo covers.
          const dx = cp * sinY[i], dy = sp, dz = -cp * cosY[i];
          const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
          if (z <= 1e-9) continue;
          const x = pw / 2 + (f * (dx * right[0] + dy * right[1] + dz * right[2])) / z;
          const y = ph / 2 - (f * (dx * up[0] + dy * up[1] + dz * up[2])) / z;
          if (x < 0 || x > pw || y < 0 || y > ph) continue;
          // Bilinear, between pixel centres, held at the borders.
          const sx = Math.min(pw - 1, Math.max(0, x - 0.5)), sy = Math.min(ph - 1, Math.max(0, y - 0.5));
          const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(pw - 1, x0 + 1), y1 = Math.min(ph - 1, y0 + 1);
          const tx = sx - x0, ty = sy - y0;
          const p00 = (y0 * pw + x0) * 4, p10 = (y0 * pw + x1) * 4, p01 = (y1 * pw + x0) * 4, p11 = (y1 * pw + x1) * 4;
          const w00 = (1 - tx) * (1 - ty) * photo[p00 + 3], w10 = tx * (1 - ty) * photo[p10 + 3];
          const w01 = (1 - tx) * ty * photo[p01 + 3], w11 = tx * ty * photo[p11 + 3];
          const aw = w00 + w10 + w01 + w11;
          const m = edgeMask(overlay, pw, ph, x, y) * (aw / 255);
          if (m <= 0) continue;
          const q = ((j - fp.y0) * bw + i) * 4;
          // Weighted by each corner's alpha, so a cut-out's transparent edge does not bleed its hidden colour.
          for (let c = 0; c < 3; c++) {
            const col = (photo[p00 + c] * w00 + photo[p10 + c] * w10 + photo[p01 + c] * w01 + photo[p11 + c] * w11) / aw;
            px[q + c] = px[q + c] * (1 - m) + col * m;
          }
        }
      }
      ctx.putImageData(block, a, fp.y0);
    }
  }
}

/** A new canvas of the photo at W×H, blurs, any grade, any overlaid photos and any nadir disk applied. */
export function bakeTo(
  src: Source, W: number, H: number, blurs: Blur[], grade?: Grade | null, overlays?: OverlaySource[] | null, nadir?: NadirSource | null,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  // Read back once per bake when grading or overlaying: tell the browser so it keeps the pixels CPU-side.
  const ctx = c.getContext("2d", (grade && !isIdentityGrade(grade)) || overlays?.length || nadir ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error("This browser could not make a 2D canvas");
  paintBake(ctx, W, H, src, blurs, grade, overlays, nadir);
  return c;
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/jpeg", quality),
  );
}
