/* pano-kit engine: a three.js 360° photo viewer, ported from the test rig.
 *
 * Framework-free on purpose. The page owns its buttons and panels; this owns
 * the canvas, the camera and everything that runs per frame. Label pins and
 * the minimap are drawn straight into elements the page hands over, because
 * pushing that through a UI framework sixty times a second is the slow part.
 *
 * Drag, pinch, wheel and keys; phone motion sensors (Generic Sensor API, then
 * deviceorientation, with a watchdog that says why when nothing arrives);
 * WebXR immersive VR; partial spheres from GPano; flat photos as a virtual
 * print; three openings; auto-rotate; label pins; a minimap; a nadir disk;
 * progressive loading up to what the GPU can take; start-view thumbnails.
 *
 * three.js is not imported: pass its module URL to loadThree(), so each app
 * serves it however suits it (bundled, vendored, or a CDN).
 */
import type * as T from "three";
import {
  DEFAULT_VIEW, DEFAULT_VIEWER_SETTINGS, FOV_MAX, FOV_MIN, capPolygon, clamp, firstPaintWidth, pickWidth, textureCap, wrap180,
  type Blur, type Hotspot, type ResolvedKind, type View, type ViewerSettings,
} from "./core";
import { bakeTo } from "./bake";

export type Three = typeof T;
const threeLoads = new Map<string, Promise<Three>>();
/** three.js's ES module, imported once per URL. Built against r186. */
export function loadThree(url: string): Promise<Three> {
  let p = threeLoads.get(url);
  if (!p) {
    p = import(/* @vite-ignore */ url) as Promise<Three>;
    threeLoads.set(url, p);
  }
  return p;
}

export interface PanoInput {
  sources: { width: number; url: string | null }[];
  srcW: number | null;
  srcH: number | null;
  resolvedKind: ResolvedKind;
  gpano: { fullW: number; fullH: number; cropW: number; cropH: number; cropL: number; cropT: number } | null;
  start: View;
  hotspots: Hotspot[];
}

export interface SensorState {
  on: boolean;
  live: boolean;
  path: string;
}

export interface EngineCallbacks {
  onToast?: (message: string, kind?: "ok" | "warn" | "err") => void;
  /** Any direct interaction with the photo: the page uses it to wake its chrome. */
  onInteract?: () => void;
  /** A tap (not a drag) on the photo, as a direction or, on a flat photo, a point. */
  onTap?: (at: { yaw: number; pitch: number } | { u: number; v: number }) => void;
  onSensors?: (state: SensorState) => void;
  onVR?: (presenting: boolean) => void;
  /** VR controller: trigger is +1 (next photo), grip is -1 (previous). */
  onStep?: (delta: 1 | -1) => void;
  onLoaded?: (info: { width: number; final: boolean }) => void;
  onError?: (message: string) => void;
}

export interface EngineOptions {
  /** Minimap frame, start-view dot and nadir-disk ring. */
  accent?: string;
  /** Behind the photo while it loads, and around a flat photo. */
  background?: number;
  /** Words on the nadir disk; null for a plain disk. */
  badge?: { title: string; subtitle?: string } | null;
}

const RADIUS = 500;
const FLAT_D = 300;    // a flat photo hangs 300 units ahead...
const FLAT_VFOV = 60;  // ...and spans 60° of height: a big print, in VR too

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // The bucket sends CORS headers; without this WebGL refuses the texture.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image could not be loaded"));
    img.src = url;
  });
}

/** Geometry parameters for a photo: where it sits on the sphere. */
function sphereParams(p: Pick<PanoInput, "gpano" | "srcW" | "srcH">) {
  if (p.gpano) return p.gpano;
  const w = p.srcW || 2, h = p.srcH || 1;
  return { fullW: w, fullH: h, cropL: 0, cropT: 0, cropW: w, cropH: h };
}

function makeSphere(THREE: Three, g: ReturnType<typeof sphereParams>, detail = 1) {
  const phiStart = (2 * Math.PI * g.cropL) / g.fullW, phiLength = (2 * Math.PI * g.cropW) / g.fullW;
  const thetaStart = (Math.PI * g.cropT) / g.fullH, thetaLength = (Math.PI * g.cropH) / g.fullH;
  const segW = Math.max(8, Math.round(96 * detail * g.cropW / g.fullW));
  const segH = Math.max(8, Math.round(64 * detail * g.cropH / g.fullH));
  const geo = new THREE.SphereGeometry(RADIUS, segW, segH, phiStart, phiLength, thetaStart, thetaLength);
  // Inside-out, and turned so the image centre is yaw 0 straight ahead with text
  // reading the right way round (verified in the rig with a labelled grid).
  geo.scale(-1, 1, 1);
  return geo;
}

function lookDir(THREE: Three, yaw: number, pitch: number) {
  const y = rad(yaw), p = rad(pitch);
  return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}

/**
 * The start view as a 1200×750 picture: the gallery card, the map popup and
 * the link preview all show exactly the frame a visitor lands on. Uses its own
 * small renderer, so it works without a viewer on screen (the uploader).
 */
export function renderStartThumb(
  THREE: Three,
  src: HTMLImageElement | HTMLCanvasElement,
  input: Pick<PanoInput, "gpano" | "srcW" | "srcH" | "resolvedKind">,
  start: View,
  w = 1200,
  h = 750,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  if (input.resolvedKind === "flat") {
    // A centre crop: a flat photo has no "view" to render.
    const ctx = canvas.getContext("2d")!;
    const sw0 = "naturalWidth" in src ? src.naturalWidth : src.width;
    const sh0 = "naturalHeight" in src ? src.naturalHeight : src.height;
    const sc = Math.max(w / sw0, h / sh0), sw = w / sc, sh = h / sc;
    ctx.drawImage(src, (sw0 - sw) / 2, (sh0 - sh) / 2, sw, sh, 0, 0, w, h);
  } else {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    const scene = new THREE.Scene();
    const tex = new THREE.Texture(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(makeSphere(THREE, sphereParams(input), 2), new THREE.MeshBasicMaterial({ map: tex }));
    mesh.rotation.y = -Math.PI / 2;
    scene.add(mesh);
    const cam = new THREE.PerspectiveCamera(start.fov, w / h, 0.1, 1100);
    cam.lookAt(lookDir(THREE, start.yaw, start.pitch));
    renderer.render(scene, cam);
    // The canvas keeps its pixels (preserveDrawingBuffer); free the GPU side now.
    mesh.geometry.dispose();
    (mesh.material as T.Material).dispose();
    tex.dispose();
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d")!.drawImage(canvas, 0, 0);
    renderer.dispose();
    renderer.forceContextLoss();
    return new Promise((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error("thumbnail"))), "image/jpeg", 0.86));
  }
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("thumbnail"))), "image/jpeg", 0.86));
}

export class PanoEngine {
  readonly THREE: Three;
  private renderer: T.WebGLRenderer;
  private scene: T.Scene;
  private camera: T.PerspectiveCamera;
  private raycaster: T.Raycaster;
  private mesh: T.Mesh | null = null;
  private texture: T.Texture | null = null;
  private disk: T.Mesh | null = null;
  private diskTex: T.Texture | null = null;
  private input: PanoInput | null = null;
  /** What is on screen: the best image loaded so far. */
  private shown: HTMLImageElement | HTMLCanvasElement | null = null;
  /** What blur previews are baked from: the untouched original, when the curator loads it. */
  private bakeSource: HTMLImageElement | null = null;
  private blurs: Blur[] | null = null;
  private loadToken = 0;
  private isFlat = false;
  private resizeObs: ResizeObserver;
  private maxAniso: number;
  readonly cap: number;

  view: View = { ...DEFAULT_VIEW };
  private start: View = { ...DEFAULT_VIEW };
  private lift = 0; // 0: camera at the centre; 1: near the zenith looking down (little planet)
  private anim: { active: boolean; t0: number; dur: number; from: View; to: View; lift?: { from: number; to: number }; ease?: (t: number) => number } =
    { active: false, t0: 0, dur: 0, from: DEFAULT_VIEW, to: DEFAULT_VIEW };
  private autoRotate = false;
  private lastInteraction = performance.now();
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  private downAt: { x: number; y: number } | null = null;
  private moved = 0;
  private hotspots: Hotspot[] = [];
  private pins: HTMLButtonElement[] = [];
  private mmDrag = false;
  private settings: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS };
  private readonly accent: string;
  private readonly badge: EngineOptions["badge"];
  private xrSession: XRSession | null = null;
  private disposed = false;
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  private gyro = {
    on: false, have: false, path: "off", count: 0, headingOffset: 0, wantYaw: 0,
    watchdog: 0 as unknown as ReturnType<typeof setTimeout>, sensor: null as any, q: null as unknown as T.Quaternion,
  };
  private wakeLock: any = null;

  constructor(
    THREE: Three,
    private canvas: HTMLCanvasElement,
    private layers: { pins: HTMLElement; minimap: HTMLElement; mmBase: HTMLCanvasElement; mmBox: HTMLCanvasElement },
    private cb: EngineCallbacks = {},
    options: EngineOptions = {},
  ) {
    this.THREE = THREE;
    this.accent = options.accent ?? "#e879f9";
    this.badge = options.badge === undefined ? null : options.badge;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local");
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(options.background ?? 0x05030a);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1100);
    this.scene.add(this.camera);
    this.raycaster = new THREE.Raycaster();
    this.gyro.q = new THREE.Quaternion();
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.cap = textureCap(this.renderer.capabilities.maxTextureSize, (navigator as any).deviceMemory);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();
    this.bindPointer();
    this.bindMinimap();
    window.addEventListener("keydown", this.onKey);
    navigator.xr?.addEventListener?.("sessiongranted", this.onSessionGranted);
    this.renderer.setAnimationLoop(this.frame);
  }

  /* --------------------------------------------------------- lifecycle */

  dispose() {
    this.disposed = true;
    this.loadToken++;
    this.stopSensors(true);
    this.xrSession?.end().catch(() => {});
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    window.removeEventListener("keydown", this.onKey);
    navigator.xr?.removeEventListener?.("sessiongranted", this.onSessionGranted);
    this.clearMesh();
    this.texture?.dispose();
    this.disk?.geometry.dispose();
    (this.disk?.material as T.Material | undefined)?.dispose();
    this.diskTex?.dispose();
    this.layers.pins.replaceChildren();
    this.renderer.dispose();
  }

  private resize() {
    if (this.renderer.xr.isPresenting) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setSettings(s: ViewerSettings) {
    this.settings = s;
    this.updateDisk();
    this.layers.minimap.hidden = !(s.minimap && !this.isFlat && !!this.shown);
  }

  /* ------------------------------------------------------- photos */

  private clearMesh() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as T.Material).dispose();
    this.mesh = null;
  }

  private build(input: PanoInput) {
    const THREE = this.THREE;
    this.clearMesh();
    this.isFlat = input.resolvedKind === "flat";
    let geo: T.BufferGeometry;
    if (this.isFlat) {
      const w = input.srcW || 4, h = input.srcH || 3;
      const ph = 2 * FLAT_D * Math.tan(rad(FLAT_VFOV) / 2);
      geo = new THREE.PlaneGeometry((ph * w) / h, ph);
    } else {
      geo = makeSphere(THREE, sphereParams(input));
    }
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.texture }));
    if (this.isFlat) this.mesh.position.set(0, 0, -FLAT_D);
    else this.mesh.rotation.y = -Math.PI / 2;
    this.scene.add(this.mesh);
    if (this.disk) this.disk.visible = !this.isFlat;
  }

  private setTexture(src: HTMLImageElement | HTMLCanvasElement) {
    const THREE = this.THREE;
    const old = this.texture;
    const tex = new THREE.Texture(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.needsUpdate = true;
    this.texture = tex;
    if (this.mesh) {
      (this.mesh.material as T.MeshBasicMaterial).map = tex;
      (this.mesh.material as T.MeshBasicMaterial).needsUpdate = true;
    }
    old?.dispose();
    this.drawMinimapBase(src);
  }

  /** Show a photo: the 2048 first so something is on screen fast, then the
   *  biggest the device can take, swapped in place. */
  async open(input: PanoInput, opts: { reveal?: boolean; initialView?: View | null } = {}) {
    const token = ++this.loadToken;
    this.input = input;
    this.bakeSource = null;
    this.blurs = null;
    this.stopSensors(true);
    this.start = { ...input.start };
    const sizes = input.sources.filter(s => s.url).map(s => s.width);
    const first = firstPaintWidth(sizes);
    const best = pickWidth(sizes, this.cap);
    const urlFor = (w: number | null) => input.sources.find(s => s.width === w)?.url ?? null;
    const firstUrl = urlFor(first);
    if (!firstUrl) {
      this.cb.onError?.("This photo has no image files yet.");
      return;
    }
    let img: HTMLImageElement;
    try {
      img = await loadImage(firstUrl);
    } catch (e: any) {
      if (token === this.loadToken) this.cb.onError?.(e.message);
      return;
    }
    if (token !== this.loadToken || this.disposed) return;
    this.texture?.dispose();
    this.texture = null;
    this.build(input);
    this.shown = img;
    this.setTexture(img);
    this.setHotspots(input.hotspots);
    this.layers.minimap.hidden = !(this.settings.minimap && !this.isFlat);
    if (opts.initialView) {
      Object.assign(this.view, opts.initialView);
      this.anim.active = false;
      this.lift = 0;
    } else if (opts.reveal && !this.renderer.xr.isPresenting) this.reveal();
    else {
      Object.assign(this.view, this.start);
      this.lift = 0;
    }
    this.cb.onLoaded?.({ width: first!, final: best === first });

    const bestUrl = urlFor(best);
    if (best && best !== first && bestUrl) {
      try {
        const big = await loadImage(bestUrl);
        await big.decode().catch(() => {});
        if (token !== this.loadToken || this.disposed) return;
        this.shown = big;
        if (this.blurs) this.applyBlurPreview();
        else this.setTexture(big);
        this.cb.onLoaded?.({ width: best, final: true });
      } catch {
        /* The 2048 stays up; better than nothing on a slow link. */
      }
    }
  }

  /* -------------------------------------------- curation: blur preview */

  /** Load the untouched original so blur edits preview truthfully (the public
   *  files already have the saved blurs baked in). */
  async useOriginal(url: string) {
    const img = await loadImage(url);
    if (this.disposed) return;
    this.bakeSource = img;
    if (this.blurs) this.applyBlurPreview();
  }

  setBlurPreview(blurs: Blur[] | null) {
    this.blurs = blurs;
    if (!blurs) {
      if (this.shown) this.setTexture(this.shown);
      return;
    }
    this.applyBlurPreview();
  }

  private bakeTimer: ReturnType<typeof setTimeout> | null = null;
  private applyBlurPreview() {
    if (this.bakeTimer) clearTimeout(this.bakeTimer);
    this.bakeTimer = setTimeout(() => {
      const src = this.bakeSource ?? this.shown;
      if (!src || !this.blurs) return;
      const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
      const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
      // Preview at up to 4096 wide: plenty to judge a blur, quick to redraw.
      const k = Math.min(1, 4096 / sw);
      this.setTexture(bakeTo(src, Math.round(sw * k), Math.round(sh * k), this.blurs));
    }, 90);
  }

  /** The image currently shown (with any blur preview), for rendering a thumbnail. */
  thumbSource(): HTMLImageElement | HTMLCanvasElement | null {
    return (this.texture?.image as HTMLImageElement | HTMLCanvasElement | undefined) ?? this.shown;
  }

  /* --------------------------------------------------------- view */

  currentView(): View {
    const fwd = new this.THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    return {
      yaw: wrap180(deg(Math.atan2(fwd.x, -fwd.z))),
      pitch: deg(Math.asin(clamp(fwd.y, -1, 1))),
      fov: this.camera.fov,
    };
  }

  setStart(v: View) {
    this.start = { ...v };
  }

  private applyView() {
    if (this.isFlat) {
      this.view.yaw = clamp(this.view.yaw, -70, 70);
      this.view.pitch = clamp(this.view.pitch, -50, 50);
      this.lift = 0;
    }
    this.camera.position.set(0, RADIUS * 0.94 * this.lift, 0);
    const dir = lookDir(this.THREE, this.view.yaw, clamp(this.view.pitch, -89, 89)).add(this.camera.position);
    this.camera.lookAt(dir);
    if (this.camera.fov !== this.view.fov) {
      this.camera.fov = this.view.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  flyTo(to: View, dur = 1400) {
    if (this.gyro.on) this.stopSensors(true);
    if (this.reducedMotion || dur === 0) {
      Object.assign(this.view, to);
      this.anim.active = false;
      return;
    }
    const from = { ...this.view };
    this.anim = { active: true, t0: performance.now(), dur, from, to: { ...to, yaw: from.yaw + wrap180(to.yaw - from.yaw) } };
  }

  toStart(dur = 900) {
    this.touched();
    this.flyTo({ ...this.start }, dur);
  }

  /** The opening: fly in, little planet, or straight there. */
  reveal() {
    const s = this.start;
    if (this.reducedMotion || this.settings.opening === "none") {
      Object.assign(this.view, s);
      this.anim.active = false;
      this.lift = 0;
      return;
    }
    if (this.settings.opening === "planet" && !this.isFlat) {
      // Lifted towards the zenith looking straight down with a wide view, then it settles into the sphere.
      Object.assign(this.view, { yaw: s.yaw + 40, pitch: -89, fov: 100 });
      this.lift = 1;
      this.flyTo({ ...s }, 2600);
      this.anim.lift = { from: 1, to: 0 };
      this.anim.ease = easeInOut;
      return;
    }
    Object.assign(this.view, { yaw: s.yaw - 10, pitch: s.pitch + 3, fov: Math.max(35, s.fov * 0.8) });
    this.lift = 0;
    this.flyTo({ ...s }, 1600);
  }

  setFov(f: number) {
    this.view.fov = clamp(f, FOV_MIN, FOV_MAX);
  }

  zoom(delta: number) {
    this.touched();
    this.setFov(this.view.fov + delta);
  }

  setAutoRotate(on: boolean) {
    this.autoRotate = on;
    if (on && this.gyro.on) this.stopSensors(true);
  }

  private touched() {
    this.lastInteraction = performance.now();
    if (this.anim.active) {
      this.anim.active = false;
      this.anim.lift = undefined;
      this.lift = 0;
    }
    this.cb.onInteract?.();
  }

  private tick(now: number) {
    if (!this.anim.active) return;
    const a = this.anim;
    const t = Math.min(1, (now - a.t0) / a.dur);
    const k = (a.ease ?? easeOutCubic)(t);
    this.view.yaw = a.from.yaw + (a.to.yaw - a.from.yaw) * k;
    this.view.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * k;
    this.view.fov = a.from.fov + (a.to.fov - a.from.fov) * k;
    if (a.lift) this.lift = a.lift.from + (a.lift.to - a.lift.from) * k;
    if (t >= 1) {
      a.active = false;
      a.lift = undefined;
      a.ease = undefined;
      this.view.yaw = wrap180(this.view.yaw);
      this.lift = 0;
    }
  }

  private lastT = performance.now();
  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.renderer.xr.isPresenting) {
      this.tick(now);
      if (this.autoRotate && !this.isFlat && !this.gyro.on && !this.anim.active && !this.mmDrag && !this.pointers.size
        && now - this.lastInteraction > 3000 && !this.reducedMotion) {
        this.view.yaw = wrap180(this.view.yaw + 1.5 * dt);
      }
      if (this.gyro.on && this.gyro.have) {
        this.camera.position.set(0, 0, 0);
        this.applyGyro();
      } else this.applyView();
      this.drawMinimapBox();
      this.placePins();
    }
    this.renderer.render(this.scene, this.camera);
  };

  /* ---------------------------------------------- pointer and keys */

  private bindPointer() {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", e => {
      this.touched();
      try { c.setPointerCapture(e.pointerId); } catch { /* not all pointers */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.style.cursor = "grabbing";
      if (this.pointers.size === 1) {
        this.downAt = { x: e.clientX, y: e.clientY };
        this.moved = 0;
      }
    });
    c.addEventListener("pointermove", e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.touched();
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 1) {
        const k = 0.12 * (this.view.fov / 75);
        // While sensors steer, a sideways drag nudges the heading instead.
        if (this.gyro.on) this.gyro.headingOffset += rad(dx * k);
        else {
          this.view.yaw = wrap180(this.view.yaw - dx * k);
          this.view.pitch = clamp(this.view.pitch + dy * k, -89, 89);
        }
      } else {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.lastPinch && d > 0) this.setFov(this.view.fov * (this.lastPinch / d));
        this.lastPinch = d;
      }
    });
    const end = (e: PointerEvent) => {
      const tap = this.pointers.size === 1 && this.downAt && this.moved < 8 && e.type === "pointerup";
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.lastPinch = 0;
      if (!this.pointers.size) c.style.cursor = "grab";
      if (tap && this.cb.onTap) {
        const at = this.isFlat ? this.uvAt(e.clientX, e.clientY) : this.dirAt(e.clientX, e.clientY);
        if (at) this.cb.onTap(at);
      }
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("wheel", e => {
      e.preventDefault();
      this.touched();
      this.setFov(this.view.fov + e.deltaY * 0.03);
    }, { passive: false });
    c.style.cursor = "grab";
  }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
    const step = e.shiftKey ? 15 : 5;
    switch (e.key) {
      case "ArrowLeft": this.view.yaw = wrap180(this.view.yaw - step); break;
      case "ArrowRight": this.view.yaw = wrap180(this.view.yaw + step); break;
      case "ArrowUp": this.view.pitch = clamp(this.view.pitch + step, -89, 89); break;
      case "ArrowDown": this.view.pitch = clamp(this.view.pitch - step, -89, 89); break;
      case "+": case "=": this.setFov(this.view.fov - 5); break;
      case "-": this.setFov(this.view.fov + 5); break;
      default: return;
    }
    e.preventDefault();
    this.touched();
    if (this.gyro.on) this.stopSensors(true);
  };

  private ndc(cx: number, cy: number) {
    const r = this.canvas.getBoundingClientRect();
    return new this.THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }

  dirAt(cx: number, cy: number) {
    this.raycaster.setFromCamera(this.ndc(cx, cy), this.camera);
    const d = this.raycaster.ray.direction;
    return { yaw: wrap180(deg(Math.atan2(d.x, -d.z))), pitch: deg(Math.asin(clamp(d.y, -1, 1))) };
  }

  uvAt(cx: number, cy: number) {
    if (!this.mesh) return null;
    this.raycaster.setFromCamera(this.ndc(cx, cy), this.camera);
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    return hit?.uv ? { u: hit.uv.x, v: 1 - hit.uv.y } : null;
  }

  /* ---------------------------------------------------- label pins */

  setHotspots(list: Hotspot[]) {
    this.hotspots = list;
    this.layers.pins.replaceChildren();
    this.pins = list.map((h, i) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "pano-pin";
      pin.textContent = h.text || `Label ${i + 1}`;
      pin.onclick = () => {
        this.touched();
        this.flyTo(this.viewFor(h, Math.min(this.view.fov, 60)), 800);
      };
      this.layers.pins.append(pin);
      return pin;
    });
  }

  /** Where to look so a label or blur is centred. */
  viewFor(h: Hotspot | Blur, fov = 60): View {
    if (!("u" in h)) return { yaw: h.yaw, pitch: h.pitch, fov };
    const pp = (this.mesh?.geometry as T.PlaneGeometry | undefined)?.parameters;
    if (!pp) return { ...this.view };
    const x = (h.u - 0.5) * pp.width, y = (0.5 - h.v) * pp.height;
    return { yaw: deg(Math.atan2(x, FLAT_D)), pitch: deg(Math.atan2(y, Math.hypot(x, FLAT_D))), fov };
  }

  private placePins() {
    if (!this.pins.length) return;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const v = new this.THREE.Vector3();
    this.hotspots.forEach((h, i) => {
      const pin = this.pins[i];
      if (!pin) return;
      if ("u" in h) {
        const pp = (this.mesh?.geometry as T.PlaneGeometry | undefined)?.parameters;
        if (!this.isFlat || !pp || !this.mesh) { pin.dataset.state = "hidden"; return; }
        v.set((h.u - 0.5) * pp.width, (0.5 - h.v) * pp.height, 0);
        this.mesh.localToWorld(v);
        v.project(this.camera);
      } else {
        v.copy(lookDir(this.THREE, h.yaw, h.pitch)).multiplyScalar(100).add(this.camera.position).project(this.camera);
      }
      if (v.z > 1 || v.z < -1 || this.renderer.xr.isPresenting) { pin.dataset.state = "hidden"; return; }
      const sx = ((v.x + 1) / 2) * W, sy = ((1 - v.y) / 2) * H;
      pin.style.left = `${sx}px`;
      pin.style.top = `${sy}px`;
      pin.dataset.state = sx < 0 || sx > W || sy < 0 || sy > H ? "far" : "shown";
    });
  }

  /* ------------------------------------------------------ minimap */

  private drawMinimapBase(src: HTMLImageElement | HTMLCanvasElement) {
    const c = this.layers.mmBase, ctx = c.getContext("2d");
    if (!ctx || !this.input) return;
    const W = c.width, H = c.height, g = sphereParams(this.input);
    ctx.fillStyle = "#0a0710";
    ctx.fillRect(0, 0, W, H);
    try {
      ctx.drawImage(src, (g.cropL / g.fullW) * W, (g.cropT / g.fullH) * H, (g.cropW / g.fullW) * W, (g.cropH / g.fullH) * H);
    } catch { /* tainted or not ready */ }
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.stroke();
  }

  private drawMinimapBox() {
    const c = this.layers.mmBox, ctx = c.getContext("2d");
    if (!ctx) return;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (this.renderer.xr.isPresenting || !this.settings.minimap || this.isFlat) return;
    const v = this.currentView(), vf = this.camera.fov;
    const hf = deg(2 * Math.atan(Math.tan(rad(vf) / 2) * this.camera.aspect));
    const bw = Math.min(W, (hf / 360) * W), bh = Math.min(H, (vf / 180) * H);
    const cx = ((v.yaw + 180) / 360) * W, cy = ((90 - v.pitch) / 180) * H;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,0,0,.6)";
    ctx.shadowBlur = 4;
    for (const off of [-W, 0, W]) ctx.strokeRect(cx - bw / 2 + off, cy - bh / 2, bw, bh);
    ctx.shadowBlur = 0;
    const sx = ((this.start.yaw + 180) / 360) * W, sy = ((90 - this.start.pitch) / 180) * H;
    ctx.fillStyle = this.accent;
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.fill();
    if (this.blurs?.length) {
      ctx.strokeStyle = "rgba(255,124,124,.9)";
      ctx.lineWidth = 1.5;
      for (const b of this.blurs) {
        if ("u" in b) continue;
        const poly = capPolygon(b.yaw, b.pitch, b.r, W, H);
        ctx.beginPath();
        for (const off of [-W, 0, W]) {
          ctx.moveTo(poly[0][0] + off, poly[0][1]);
          for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] + off, poly[i][1]);
          ctx.closePath();
        }
        ctx.stroke();
      }
    }
  }

  private bindMinimap() {
    const mm = this.layers.minimap;
    const look = (e: PointerEvent) => {
      const r = mm.getBoundingClientRect();
      const u = clamp((e.clientX - r.left) / r.width, 0, 1), v = clamp((e.clientY - r.top) / r.height, 0, 1);
      if (this.gyro.on) this.stopSensors(true);
      this.anim.active = false;
      this.view.yaw = wrap180(u * 360 - 180);
      this.view.pitch = clamp(90 - v * 180, -89, 89);
      this.touched();
    };
    mm.addEventListener("pointerdown", e => {
      this.mmDrag = true;
      try { mm.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      look(e);
    });
    mm.addEventListener("pointermove", e => { if (this.mmDrag) look(e); });
    mm.addEventListener("pointerup", () => { this.mmDrag = false; });
    mm.addEventListener("pointercancel", () => { this.mmDrag = false; });
  }

  /* ---------------------------------------------------- nadir disk */

  private updateDisk() {
    const THREE = this.THREE;
    if (this.disk) {
      this.scene.remove(this.disk);
      this.disk.geometry.dispose();
      (this.disk.material as T.Material).dispose();
      this.disk = null;
    }
    if (this.settings.nadir !== "disk") return;
    // A viewer-time mesh, not baked, so changing it needs no re-encode.
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const x = c.getContext("2d")!;
    x.translate(256, 256);
    const ring = x.createRadialGradient(0, 0, 150, 0, 0, 256);
    ring.addColorStop(0, "rgba(10,6,18,1)");
    ring.addColorStop(0.86, "rgba(10,6,18,1)");
    ring.addColorStop(1, "rgba(10,6,18,0)");
    x.fillStyle = ring;
    x.beginPath(); x.arc(0, 0, 256, 0, Math.PI * 2); x.fill();
    x.strokeStyle = this.accent; x.lineWidth = 6;
    x.beginPath(); x.arc(0, 0, 178, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 2; x.strokeStyle = this.accent; x.globalAlpha = 0.5;
    x.beginPath(); x.arc(0, 0, 150, 0, Math.PI * 2); x.stroke();
    for (let i = 0; i < 36; i++) {
      const a = (i * Math.PI) / 18, r1 = i % 9 === 0 ? 120 : 138;
      x.beginPath(); x.moveTo(Math.sin(a) * r1, -Math.cos(a) * r1); x.lineTo(Math.sin(a) * 150, -Math.cos(a) * 150); x.stroke();
    }
    x.globalAlpha = 1;
    if (this.badge) {
      x.fillStyle = "#f5f3ff"; x.textAlign = "center"; x.textBaseline = "middle";
      x.font = "700 54px system-ui, sans-serif"; x.fillText(this.badge.title, 0, this.badge.subtitle ? -14 : 0);
      if (this.badge.subtitle) { x.font = "500 30px system-ui, sans-serif"; x.fillStyle = this.accent; x.fillText(this.badge.subtitle, 0, 34); }
    }
    this.diskTex?.dispose();
    this.diskTex = new THREE.Texture(c);
    this.diskTex.colorSpace = THREE.SRGBColorSpace;
    this.diskTex.needsUpdate = true;
    const th = rad(this.settings.nadirDeg);
    this.disk = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS * Math.sin(th) * 1.02, 64),
      new THREE.MeshBasicMaterial({ map: this.diskTex, transparent: true }),
    );
    this.disk.rotation.x = -Math.PI / 2;
    this.disk.position.y = -RADIUS * Math.cos(th);
    this.disk.visible = !this.isFlat;
    this.scene.add(this.disk);
  }

  /* ------------------------------------------------------ sensors */

  static sensorsAvailable(): boolean {
    const touchy = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
    return touchy && (typeof DeviceOrientationEvent !== "undefined" || "RelativeOrientationSensor" in window);
  }

  private emitSensors() {
    this.cb.onSensors?.({ on: this.gyro.on, live: this.gyro.have, path: this.gyro.path });
  }

  private applyGyro() {
    const THREE = this.THREE;
    this.camera.quaternion.copy(this.gyro.q);
    this.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.gyro.headingOffset));
    if (this.camera.fov !== this.view.fov) {
      this.camera.fov = this.view.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private firstSample() {
    this.gyro.have = true;
    clearTimeout(this.gyro.watchdog);
    // No jump on switch-on: align the phone's heading with where the view was.
    this.gyro.headingOffset = 0;
    this.applyGyro();
    this.gyro.headingOffset = rad(wrap180(this.currentView().yaw - this.gyro.wantYaw));
    this.emitSensors();
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const THREE = this.THREE;
    this.gyro.count++;
    // three r133's DeviceOrientationControls maths, vendored (removed from three in r134).
    const euler = new THREE.Euler(rad(e.beta), rad(e.alpha), -rad(e.gamma), "YXZ");
    const W = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    const screenAngle = rad((screen.orientation?.angle ?? (window as any).orientation ?? 0) as number);
    this.gyro.q.setFromEuler(euler).multiply(W).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenAngle));
    if (!this.gyro.have) this.firstSample();
  };

  private startGenericSensor(): boolean {
    const Ctor = (window as any).RelativeOrientationSensor;
    if (!Ctor) return false;
    try {
      const W = new this.THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // sensor Z-up to three Y-up
      const s = new Ctor({ frequency: 60, referenceFrame: "screen" });
      s.addEventListener("reading", () => {
        const q = s.quaternion as number[] | null;
        if (!q) return;
        this.gyro.count++;
        this.gyro.q.set(q[0], q[1], q[2], q[3]).premultiply(W);
        if (!this.gyro.have) this.firstSample();
      });
      s.addEventListener("error", () => {
        if (this.gyro.have) return;
        this.gyro.path = "deviceorientation";
        window.addEventListener("deviceorientation", this.onOrientation);
      });
      s.start();
      this.gyro.sensor = s;
      this.gyro.path = "RelativeOrientationSensor";
      return true;
    } catch {
      return false;
    }
  }

  /** Look around by moving the phone. Only ever from a button. If no data
   *  arrives within 2 s it falls back to drag and says why. */
  async startSensors(): Promise<boolean> {
    const DOE = (window as any).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        if ((await DOE.requestPermission()) !== "granted") {
          this.cb.onToast?.("Motion permission was refused.", "err");
          return false;
        }
      } catch {
        this.cb.onToast?.("Motion permission was refused.", "err");
        return false;
      }
    }
    this.anim.active = false;
    this.autoRotate = false;
    Object.assign(this.gyro, { wantYaw: this.currentView().yaw, headingOffset: 0, on: true, have: false, count: 0 });
    if (!this.startGenericSensor()) {
      this.gyro.path = "deviceorientation";
      window.addEventListener("deviceorientation", this.onOrientation);
    }
    this.emitSensors();
    this.gyro.watchdog = setTimeout(() => {
      if (this.gyro.have) return;
      const path = this.gyro.path;
      this.stopSensors(true);
      this.cb.onToast?.(
        `No motion data arrived (${path}). On GrapheneOS, check the browser's Sensors permission and its per-site Motion sensors setting. Drag still works.`,
        "warn",
      );
    }, 2000);
    try { this.wakeLock = await (navigator as any).wakeLock?.request("screen"); } catch { /* optional */ }
    return true;
  }

  stopSensors(quiet = false) {
    if (this.gyro.on && this.gyro.have) Object.assign(this.view, this.currentView());
    const was = this.gyro.on;
    this.gyro.on = false;
    this.gyro.have = false;
    window.removeEventListener("deviceorientation", this.onOrientation);
    clearTimeout(this.gyro.watchdog);
    if (this.gyro.sensor) {
      try { this.gyro.sensor.stop(); } catch { /* already stopped */ }
      this.gyro.sensor = null;
    }
    this.wakeLock?.release?.();
    this.wakeLock = null;
    if (was || !quiet) this.emitSensors();
  }

  /* ---------------------------------------------------------- VR */

  static async vrSupported(): Promise<boolean> {
    try {
      return !!(await navigator.xr?.isSessionSupported("immersive-vr"));
    } catch {
      return false;
    }
  }

  private onSessionGranted = () => {
    // VR-to-VR navigation: a headset browser arriving from another immersive page.
    if (!this.xrSession) this.enterVR();
  };

  async enterVR() {
    if (this.xrSession) {
      await this.xrSession.end();
      return;
    }
    try {
      const s = await navigator.xr!.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
      this.xrSession = s;
      if (this.gyro.on) this.stopSensors(true);
      s.addEventListener("end", () => {
        this.xrSession = null;
        Object.assign(this.view, this.start);
        this.resize();
        this.cb.onVR?.(false);
      });
      s.addEventListener("select", () => this.cb.onStep?.(1));
      s.addEventListener("squeeze", () => this.cb.onStep?.(-1));
      await this.renderer.xr.setSession(s);
      this.cb.onVR?.(true);
    } catch (e: any) {
      this.cb.onToast?.(`Could not start VR: ${e?.message ?? e}`, "err");
    }
  }

  get presentingVR() {
    return this.renderer.xr.isPresenting;
  }
}
