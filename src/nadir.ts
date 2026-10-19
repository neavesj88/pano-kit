/* pano-kit nadir: the badge disk over the camera holder's hand, as a picture, and baked into an
 * equirect, so a saved file carries the same disk the viewer draws (its title and credit go
 * wherever the file goes). The viewer and the bake both draw it with badgeCanvas, and the bake
 * lays it on with the projection the viewer's cap uses (nadirPoint), so they match. */
import { fitBadge } from "./core";

export interface Badge { title: string; subtitle?: string | null }

type Picture = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/** A picture to lay over the nadir: `deg` out from straight down, its top towards yaw `rot`. */
export interface NadirSource { picture: Picture; deg: number; rot: number }

/** The disk: dark, fading out at its rim, two accent rings and a scale of ticks, the title and
 *  credit fitted inside the inner ring. Drawn in a 512 frame and scaled to `size` pixels. */
export function badgeCanvas(badge: Badge | null, accent: string, size = 512): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d")!;
  x.scale(size / 512, size / 512);
  x.translate(256, 256);
  const ring = x.createRadialGradient(0, 0, 150, 0, 0, 256);
  ring.addColorStop(0, "rgba(10,6,18,1)");
  ring.addColorStop(0.86, "rgba(10,6,18,1)");
  ring.addColorStop(1, "rgba(10,6,18,0)");
  x.fillStyle = ring;
  x.beginPath(); x.arc(0, 0, 256, 0, Math.PI * 2); x.fill();
  x.strokeStyle = accent; x.lineWidth = 6;
  x.beginPath(); x.arc(0, 0, 178, 0, Math.PI * 2); x.stroke();
  x.lineWidth = 2; x.strokeStyle = accent; x.globalAlpha = 0.5;
  x.beginPath(); x.arc(0, 0, 150, 0, Math.PI * 2); x.stroke();
  for (let i = 0; i < 36; i++) {
    const a = (i * Math.PI) / 18, r1 = i % 9 === 0 ? 120 : 138;
    x.beginPath(); x.moveTo(Math.sin(a) * r1, -Math.cos(a) * r1); x.lineTo(Math.sin(a) * 150, -Math.cos(a) * 150); x.stroke();
  }
  x.globalAlpha = 1;
  if (badge) {
    // Fitted inside the inner ring whatever the words: shrunk, then wrapped, then cut short.
    x.textAlign = "center"; x.textBaseline = "middle";
    const font = (px: number, sub: boolean) => `${sub ? 500 : 700} ${px}px system-ui, sans-serif`;
    const measure = (t: string, px: number) => { x.font = font(px, false); return x.measureText(t).width; };
    for (const l of fitBadge(badge.title, badge.subtitle, 138, measure)) {
      x.font = font(l.size, l.sub);
      x.fillStyle = l.sub ? accent : "#f5f3ff";
      x.fillText(l.text, 0, l.y);
    }
  }
  return c;
}

/** Where the direction yaw/pitch (degrees) lands on a nadir picture, as fractions of its width
 *  and height from its top left, or null when it is outside the cap. The viewer's cap: the
 *  picture laid on by stereographic projection from straight down, radius 1 at `deg` from
 *  straight down, then turned about the vertical so its top points at yaw `rot`. */
export function nadirPoint(yaw: number, pitch: number, deg: number, rot: number): { x: number; y: number } | null {
  const toRad = Math.PI / 180;
  const theta = deg * toRad;
  const y = yaw * toRad, p = pitch * toRad, r = rot * toRad;
  const dx = Math.cos(p) * Math.sin(y), dy = Math.sin(p), dz = -Math.cos(p) * Math.cos(y);
  // Undo the cap's turn (the viewer turns it by -rot about the vertical).
  const lx = dx * Math.cos(r) + dz * Math.sin(r), lz = -dx * Math.sin(r) + dz * Math.cos(r);
  const phi = Math.acos(Math.max(-1, Math.min(1, -dy)));
  if (phi > theta) return null;
  const h = Math.hypot(lx, lz);
  const rho = Math.tan(phi / 2) / Math.tan(theta / 2);
  // The cap's texture coordinates (v up), then the picture's rows, which run down.
  const u = 0.5 + (h > 1e-12 ? (0.5 * rho * lx) / h : 0);
  const v = 0.5 - (h > 1e-12 ? (0.5 * rho * lz) / h : 0);
  return { x: u, y: 1 - v };
}

/** Lays a nadir picture into the equirect on ctx (W×H) by inverse mapping: every pixel of the
 *  bottom band asks where it lands on the picture and mixes that colour in by its transparency
 *  (bilinear, weighted by alpha so a soft rim does not bleed its hidden colour). */
export function paintNadir(ctx: CanvasRenderingContext2D, W: number, H: number, { picture, deg, rot }: NadirSource) {
  const pw0 = "naturalWidth" in picture ? picture.naturalWidth : picture.width;
  const ph0 = "naturalHeight" in picture ? picture.naturalHeight : picture.height;
  if (!pw0 || !ph0 || deg <= 0) return;
  const pc = document.createElement("canvas");
  pc.width = pw0;
  pc.height = ph0;
  const pctx = pc.getContext("2d", { willReadFrequently: true });
  if (!pctx) throw new Error("This browser could not make a 2D canvas");
  pctx.drawImage(picture, 0, 0);
  const pix = pctx.getImageData(0, 0, pw0, ph0).data;
  const y0 = Math.max(0, Math.floor(((180 - deg) / 180) * H) - 1);
  const block = ctx.getImageData(0, y0, W, H - y0);
  const px = block.data;
  for (let j = y0; j < H; j++) {
    const pitch = 90 - ((j + 0.5) / H) * 180;
    for (let i = 0; i < W; i++) {
      const at = nadirPoint(((i + 0.5) / W) * 360 - 180, pitch, deg, rot);
      if (!at) continue;
      const sx = Math.min(pw0 - 1, Math.max(0, at.x * pw0 - 0.5)), sy = Math.min(ph0 - 1, Math.max(0, at.y * ph0 - 0.5));
      const x0 = Math.floor(sx), yy0 = Math.floor(sy), x1 = Math.min(pw0 - 1, x0 + 1), y1 = Math.min(ph0 - 1, yy0 + 1);
      const tx = sx - x0, ty = sy - yy0;
      const p00 = (yy0 * pw0 + x0) * 4, p10 = (yy0 * pw0 + x1) * 4, p01 = (y1 * pw0 + x0) * 4, p11 = (y1 * pw0 + x1) * 4;
      const w00 = (1 - tx) * (1 - ty) * pix[p00 + 3], w10 = tx * (1 - ty) * pix[p10 + 3];
      const w01 = (1 - tx) * ty * pix[p01 + 3], w11 = tx * ty * pix[p11 + 3];
      const aw = w00 + w10 + w01 + w11;
      if (aw <= 0) continue;
      const m = aw / 255;
      const q = ((j - y0) * W + i) * 4;
      for (let c = 0; c < 3; c++) {
        const col = (pix[p00 + c] * w00 + pix[p10 + c] * w10 + pix[p01 + c] * w01 + pix[p11 + c] * w11) / aw;
        px[q + c] = px[q + c] * (1 - m) + col * m;
      }
    }
  }
  ctx.putImageData(block, 0, y0);
}
