/* Blur regions painted into a copy of a photo.
 *
 * Use it for both the live preview and the published files, so what the
 * curator sees is exactly what visitors get. Blurs are baked, never applied at
 * view time: the published image simply does not contain the face. Ported
 * from the test rig's paintBake.
 */
import { capPolygon, clamp, type Blur } from "./core";

type Source = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

const sizeOf = (src: Source) => ({
  w: "naturalWidth" in src ? src.naturalWidth : src.width,
  h: "naturalHeight" in src ? src.naturalHeight : src.height,
});

function traceCap(ctx: CanvasRenderingContext2D, poly: [number, number][], offset: number) {
  ctx.moveTo(poly[0][0] + offset, poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] + offset, poly[i][1]);
  ctx.closePath();
}

/** Draws `src` into `ctx` at W×H with every blur region applied. */
export function paintBake(ctx: CanvasRenderingContext2D, W: number, H: number, src: Source, blurs: Blur[]) {
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
}

/** A new canvas of the photo at W×H, blurs applied. */
export function bakeTo(src: Source, W: number, H: number, blurs: Blur[]): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("This browser could not make a 2D canvas");
  paintBake(ctx, W, H, src, blurs);
  return c;
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/jpeg", quality),
  );
}
