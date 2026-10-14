/* pano-kit demo: the engine on a generated test sphere, no server, no files.
 *
 * A labelled equirect grid (compass points on the horizon, latitude lines)
 * makes orientation mistakes obvious: yaw 0 must face "N · yaw 0", and text
 * must read the right way round. Build with:
 *   esbuild demo/demo.ts --bundle --format=esm --outfile=demo/demo.js
 * and serve the demo folder over http. */
import { PanoEngine, loadThree, renderStartThumb } from "../src/engine";
import { DEFAULT_VIEWER_SETTINGS, NADIR_DEG_MAX, type Hotspot, type ViewerSettings } from "../src/core";

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function testSphere(w = 4096, h = 2048, tint = "#1e3a8a"): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, tint);
  g.addColorStop(0.5, "#0f172a");
  g.addColorStop(1, "#3f2a14");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.strokeStyle = "rgba(255,255,255,.35)";
  x.lineWidth = 2;
  for (let yaw = -180; yaw <= 180; yaw += 30) {
    const px = ((yaw + 180) / 360) * w;
    x.beginPath(); x.moveTo(px, 0); x.lineTo(px, h); x.stroke();
  }
  for (let p = -60; p <= 60; p += 30) {
    const py = ((90 - p) / 180) * h;
    x.beginPath(); x.moveTo(0, py); x.lineTo(w, py); x.stroke();
  }
  x.fillStyle = "#fff";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = "700 90px system-ui, sans-serif";
  for (const [label, yaw] of [["N · yaw 0", 0], ["E · yaw 90", 90], ["S · yaw 180", 180], ["W · yaw -90", -90]] as const) {
    x.fillText(label, ((yaw + 180) / 360) * w, h / 2);
  }
  x.font = "500 48px system-ui, sans-serif";
  x.fillText("pitch +60", w / 2, ((90 - 60) / 180) * h);
  x.fillText("pitch -60", w / 2, ((90 + 60) / 180) * h);
  return c.toDataURL("image/jpeg", 0.9);
}

/** A stand-in nadir picture: transparent, with an arrow to its top and a body
 *  below the centre, the way a figure covering the camera holder would sit. */
function coverImage(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const x = c.getContext("2d")!;
  x.translate(256, 256);
  x.fillStyle = "rgba(56,189,248,.85)";
  x.beginPath(); x.ellipse(0, 130, 90, 110, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = "#facc15";
  x.beginPath(); x.moveTo(0, -240); x.lineTo(40, -170); x.lineTo(14, -170); x.lineTo(14, 0); x.lineTo(-14, 0); x.lineTo(-14, -170); x.lineTo(-40, -170); x.closePath(); x.fill();
  x.fillStyle = "#fff"; x.font = "700 44px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("TOP", 0, -120); x.fillText("body", 0, 130);
  return c;
}

const hotspots: Hotspot[] = [
  { yaw: 90, pitch: 10, text: "East label" },
  { yaw: -45, pitch: -20, text: "South-west, low" },
];

async function main() {
  const THREE = await loadThree(THREE_URL);
  const status = $("status");
  const engine = new PanoEngine(
    THREE,
    $<HTMLCanvasElement>("c"),
    { pins: $("pins"), minimap: $("mm"), mmBase: $<HTMLCanvasElement>("mmBase"), mmBox: $<HTMLCanvasElement>("mmBox") },
    {
      onLoaded: i => { status.textContent = `loaded ${i.width}px${i.final ? " (final)" : ""}`; },
      onTap: at => { status.textContent = `tap ${JSON.stringify(at)}`; },
      onError: m => { status.textContent = `error: ${m}`; },
      onToast: m => { status.textContent = m; },
    },
    { badge: { title: "pano-kit", subtitle: "demo" } },
  );
  let settings: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS, nadir: "disk" };
  const apply = (patch: Partial<ViewerSettings>) => { settings = { ...settings, ...patch }; engine.setSettings(settings); };
  apply({});
  engine.setNadirImage(coverImage());
  const url = testSphere();
  const input = {
    sources: [{ width: 4096, url }],
    srcW: 4096, srcH: 2048, resolvedKind: "pano" as const, gpano: null,
    start: { yaw: 0, pitch: 0, fov: 75 }, hotspots,
  };
  await engine.open(input, { reveal: true });

  $("start").onclick = () => engine.toStart();
  $("planet").onclick = () => { apply({ opening: "planet" }); engine.reveal(); };
  $("spin").onclick = () => { apply({ opening: "spin" }); engine.reveal(); };
  // The nadir cover: which, how big, which way its top points.
  const cover = $<HTMLSelectElement>("cover"), rot = $<HTMLInputElement>("rot"), size = $<HTMLInputElement>("size");
  size.max = String(NADIR_DEG_MAX);
  const coverChanged = () => {
    apply({ nadir: cover.value as ViewerSettings["nadir"], nadirRot: Number(rot.value), nadirDeg: Number(size.value) });
    status.textContent = `cover ${cover.value}, top at yaw ${rot.value}°, ${size.value}° out`;
  };
  cover.onchange = rot.oninput = size.oninput = coverChanged;
  $("down").onclick = () => engine.flyTo({ yaw: engine.currentView().yaw, pitch: -89, fov: 100 }, 700);
  // A second sphere in another colour, to watch the crossfade between photos.
  const other = { ...input, sources: [{ width: 4096, url: testSphere(4096, 2048, "#7c2d12") }], hotspots: [] };
  let flip = false;
  $("next").onclick = () => { flip = !flip; void engine.open(flip ? other : input, { reveal: true }); };
  $("thumb").onclick = async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const blob = await renderStartThumb(THREE, img, input, engine.currentView(), 600, 375);
    $<HTMLImageElement>("thumbOut").src = URL.createObjectURL(blob);
    status.textContent = `thumbnail ${blob.size} bytes`;
  };
  (window as any).engine = engine;
}

main().catch(e => { $("status").textContent = `failed: ${e?.message ?? e}`; });
