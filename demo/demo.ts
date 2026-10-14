/* pano-kit demo: the engine on a generated test sphere, no server, no files.
 *
 * A labelled equirect grid (compass points on the horizon, latitude lines)
 * makes orientation mistakes obvious: yaw 0 must face "N · yaw 0", and text
 * must read the right way round. Build with:
 *   esbuild demo/demo.ts --bundle --format=esm --outfile=demo/demo.js
 * and serve the demo folder over http. */
import { PanoEngine, loadThree, renderStartThumb } from "../src/engine";
import { DEFAULT_VIEWER_SETTINGS, type Hotspot } from "../src/core";

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function testSphere(w = 4096, h = 2048): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#1e3a8a");
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
  engine.setSettings({ ...DEFAULT_VIEWER_SETTINGS, nadir: "disk" });
  const url = testSphere();
  const input = {
    sources: [{ width: 4096, url }],
    srcW: 4096, srcH: 2048, resolvedKind: "pano" as const, gpano: null,
    start: { yaw: 0, pitch: 0, fov: 75 }, hotspots,
  };
  await engine.open(input, { reveal: true });

  $("start").onclick = () => engine.toStart();
  $("planet").onclick = () => { engine.setSettings({ ...DEFAULT_VIEWER_SETTINGS, opening: "planet", nadir: "disk" }); engine.reveal(); };
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
