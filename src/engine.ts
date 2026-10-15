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
 * print; three openings; auto-rotate; label pins; a minimap; a nadir cover;
 * progressive loading up to what the GPU can take; start-view thumbnails.
 *
 * three.js is not imported: pass its module URL to loadThree(), so each app
 * serves it however suits it (bundled, vendored, or a CDN).
 */
import type * as T from "three";
import {
  DEFAULT_VIEW, DEFAULT_VIEWER_SETTINGS, FOV_MAX, FOV_MIN, NADIR_DEG_MAX, capPolygon, clamp, firstPaintWidth, fitBadge, pickWidth, textureCap, wrap180,
  type Blur, type Hotspot, type ResolvedKind, type View, type ViewerSettings,
} from "./core";
import { bakeTo } from "./bake";
import { isIdentityGrade, type Grade } from "./grade";
import { DRAG_DEG, SNAP_DEG, pointedLabel, pressOutcome, snapTurn, wrapLines, yawOf, type Vec3 } from "./vr";

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
  /** What tapping a label does. fly (the default): turn the view to it, as a
   *  tour's link would. note: open or close it as a comment box where it is,
   *  without moving the view; it starts closed, a small mark until hovered or
   *  tapped. Labels are .pano-pin buttons with data-kind and data-open for the
   *  page to style, the text in .pano-pin-text. */
  labels?: "fly" | "note";
  /** The most device pixels per CSS pixel to draw at. Default 1.5: on a 2x
   *  screen a photo looks the same and the GPU fills 44% fewer pixels. */
  maxPixelRatio?: number;
}

const RADIUS = 500;
const FLAT_D = 300;    // a flat photo hangs 300 units ahead...
const FLAT_VFOV = 60;  // ...and spans 60° of height: a big print, in VR too

/* The little planet, done properly: every pixel is a ray from a point d behind
 * the sphere's centre. d = 1 is a stereographic projection (the "tiny planet"
 * with the whole scene wrapped into a ball), d = 0 is an ordinary rectilinear
 * view, and easing d from 1 to 0 unfolds one into the other. A full-screen
 * quad; the sphere mesh takes over once d reaches 0, where the two agree. */
const PLANET_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const PLANET_FRAG = `
precision highp float; // mediump shows artefacts on Quest 3
uniform sampler2D map;
uniform vec4 crop;     // the photo's place in the full sphere: left, top, width, height (0..1)
uniform float d;       // projection centre behind the sphere centre: 0 rectilinear, 1 stereographic
uniform mat3 rot;      // camera to world
uniform float tanHalf; // tan(vertical fov / 2)
uniform float aspect;
uniform vec3 bg;
uniform sampler2D disk; // the nadir cover, so it does not pop in when the planet hands over to the mesh
uniform float diskOn;
uniform float diskTheta; // the cover reaches this far from straight down (radians), laid on stereographically as the mesh is...
uniform float diskRot;   // ...turned so its top points at this yaw (radians)
uniform sampler2D figure; // and the figure under it, the same way
uniform float figureOn;
uniform float figureTheta;
uniform mat3 figureFrame; // world to the figure's own frame: undoes its turn, and its move off straight down
varying vec2 vUv;
const float PI = 3.14159265358979;
// A nadir layer at world direction w: transparent outside its cap.
vec4 cover(sampler2D tex, vec3 w, float theta, float turn) {
  float phi = acos(clamp(-w.y, -1.0, 1.0)); // angle from straight down
  if (phi >= theta) return vec4(0.0);
  vec2 h = vec2(w.x, w.z);
  float hl = length(h);
  h = hl > 1e-6 ? h / hl : vec2(0.0);
  // Into the layer's own frame: x across it, y towards its top (yaw turn), 1 at its edge.
  float cr = cos(turn), sr = sin(turn);
  vec2 l = tan(phi * 0.5) / tan(theta * 0.5) * vec2(h.x * cr + h.y * sr, h.x * sr - h.y * cr);
  return texture(tex, l * 0.5 + 0.5);
}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(aspect, 1.0) * tanHalf;
  vec3 dir = normalize(vec3(p, -1.0));
  vec3 o = vec3(0.0, 0.0, d);
  float b = dot(o, dir);
  float t = -b + sqrt(max(b * b - (d * d - 1.0), 0.0));
  vec3 w = rot * normalize(o + t * dir);
  float u = 0.5 + atan(w.x, -w.z) / (2.0 * PI);
  float v = 0.5 + asin(clamp(w.y, -1.0, 1.0)) / PI;
  vec2 img = vec2((u - crop.x) / crop.z, ((1.0 - v) - crop.y) / crop.w);
  vec2 uv = vec2(img.x, 1.0 - img.y);
  // Behind the viewer u jumps from 1 to 0; a derivative across that jump picks
  // the smallest mipmap and draws a line. Use the smaller of two gradients.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 uw = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dx2 = dFdx(uw), dy2 = dFdy(uw);
  if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
  bool inside = img.x >= 0.0 && img.x <= 1.0 && img.y >= 0.0 && img.y <= 1.0;
  vec4 col = inside ? textureGrad(map, uv, dx, dy) : vec4(bg, 1.0);
  if (figureOn > 0.5) {
    vec4 fc = cover(figure, figureFrame * w, figureTheta, 0.0);
    col = vec4(mix(col.rgb, fc.rgb, fc.a), 1.0);
  }
  if (diskOn > 0.5) {
    vec4 dc = cover(disk, w, diskTheta, diskRot);
    col = vec4(mix(col.rgb, dc.rgb, dc.a), 1.0);
  }
  gl_FragColor = col;
  #include <colorspace_fragment>
}
`;
/** How wide the little planet starts: 150° vertical, about 60° above the horizon at the edges. */
const PLANET_FOV = 150;
const CROSSFADE_MS = 700;

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
    // Decoded before it is handed over: texImage2D of an undecoded image decodes
    // it right there on the main thread (30 to 100 ms for a 4096 JPEG on a phone).
    img.onload = () => (typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(img));
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

/**
 * The nadir cover: a cap of a sphere just inside the photo's, reaching `theta`
 * out from straight down, with its picture laid on by stereographic projection
 * from the nadir (picture radius 1 at the cap's edge, top towards yaw 0). That
 * is conformal: a figure drawn as the camera would have seen it keeps its
 * shape however it is looked at. A flat disc squashed anything far out from
 * the centre to a sliver when seen at a slant.
 */
/** A picture handed over for the nadir; serial tells a new one from the same one. */
type Picture = { src: CanvasImageSource & { width: number; height: number }; serial: number };
/** A nadir layer: its mesh, its texture, what it was drawn from, the angle its cap was built for. */
interface Cover { mesh: T.Mesh; tex: T.Texture; key: string; theta: number; layer: number }

function makeCap(THREE: Three, theta: number, radius = RADIUS * 0.98) {
  const geo = new THREE.SphereGeometry(radius, 128, 48, 0, Math.PI * 2, Math.PI - theta, theta);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const k = 1 / Math.tan(theta / 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const phi = Math.acos(clamp(-y / Math.hypot(x, y, z), -1, 1));
    const h = Math.hypot(x, z);
    const rho = Math.tan(phi / 2) * k;
    uv.setXY(i, 0.5 + (h > 1e-9 ? (0.5 * rho * x) / h : 0), 0.5 - (h > 1e-9 ? (0.5 * rho * z) / h : 0));
  }
  uv.needsUpdate = true;
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
  /** The nadir cover (layer 1), and the figure drawn under it (layer 0). */
  private disk: Cover | null = null;
  private figure: Cover | null = null;
  private nadirImage: Picture | null = null;
  private figureImage: Picture | null = null;
  private input: PanoInput | null = null;
  /** What is on screen: the best image loaded so far. */
  private shown: HTMLImageElement | HTMLCanvasElement | null = null;
  /** What blur previews are baked from: the untouched original, when the curator loads it. */
  private bakeSource: HTMLImageElement | null = null;
  private blurs: Blur[] | null = null;
  private grade: Grade | null = null;
  private loadToken = 0;
  private isFlat = false;
  private resizeObs: ResizeObserver;
  private maxAniso: number;
  readonly cap: number;

  view: View = { ...DEFAULT_VIEW };
  private start: View = { ...DEFAULT_VIEW };
  /** 1: a true little planet; 0: an ordinary view; between: the unfold. */
  private planetD = 0;
  private planet: { scene: T.Scene; mesh: T.Mesh; mat: T.ShaderMaterial } | null = null;
  /** The previous photo, fading out under the new one. */
  private outgoing: { mesh: T.Mesh; texture: T.Texture | null; t0: number } | null = null;
  private anim: { active: boolean; t0: number; dur: number; from: View; to: View; planet?: { from: number; to: number }; ease?: (t: number) => number } =
    { active: false, t0: 0, dur: 0, from: DEFAULT_VIEW, to: DEFAULT_VIEW };
  private autoRotate = false;
  private rotateSpeed = 1.5;   // degrees a second
  private rotateIdleMs = 3000; // how long untouched before it starts
  private lastInteraction = performance.now();
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  private downAt: { x: number; y: number } | null = null;
  private moved = 0;
  private hotspots: Hotspot[] = [];
  private labelsShown = true;
  private captionLines: string[] | null = null;
  private hintLines: string[] | null = null;
  private pins: HTMLButtonElement[] = [];
  private mmDrag = false;
  private settings: ViewerSettings = { ...DEFAULT_VIEWER_SETTINGS };
  private readonly accent: string;
  private badge: EngineOptions["badge"];
  private readonly labelMode: "fly" | "note";
  private readonly background: number;
  private xrSession: XRSession | null = null;
  /** The headset view: its turn (thumbstick snaps, trigger drags), the trigger
   *  press being dragged, and the labels drawn into the scene, since a page's
   *  own elements never show inside a headset. */
  private vr = {
    base: null as XRReferenceSpace | null,
    yaw: 0,
    /** The yaw the reference space was last offset by. */
    applied: NaN,
    /** Set when a photo opens: the next frame turns the world so the start view is where the head points. */
    faceStart: false,
    /** The caption card, and when it goes. */
    caption: null as T.Sprite | null,
    captionUntil: 0,
    /** The controls hint shown on entering, and when it goes. */
    hint: null as T.Sprite | null,
    hintUntil: 0,
    armed: new Map<XRInputSource, boolean>(),
    /** A/X held: where the ray pointed when it went down, and how far it has swept since. */
    hold: new Map<XRInputSource, { t0: number; startRay: number; delta: number; swung: number }>(),
    bDown: new Map<XRInputSource, boolean>(),
    drag: null as null | { source: XRInputSource; startRay: number; startYaw: number; swung: number },
    labels: null as T.Group | null,
    dots: [] as (T.Sprite | null)[],
    cards: [] as (T.Sprite | null)[],
    dirs: [] as (Vec3 | null)[],
    dotSize: 1,
    open: new Set<number>(),
    dotTex: null as T.Texture | null,
  };
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
    this.labelMode = options.labels ?? "fly";
    this.background = options.background ?? 0x05030a;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.maxPixelRatio ?? 1.5));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local");
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.background);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1100);
    this.scene.add(this.camera);
    this.raycaster = new THREE.Raycaster();
    this.gyro.q = new THREE.Quaternion();
    const handheld = matchMedia("(pointer: coarse)").matches;
    this.maxAniso = Math.min(this.renderer.capabilities.getMaxAnisotropy(), handheld ? 4 : 16);
    this.cap = textureCap(this.renderer.capabilities.maxTextureSize, (navigator as any).deviceMemory, handheld);
    // three rebuilds its own state after a lost context (a backgrounded iOS tab,
    // memory pressure); a renderer that only draws on change must then be told to.
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

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
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    navigator.xr?.removeEventListener?.("sessiongranted", this.onSessionGranted);
    this.clearMesh();
    this.dropVrLabels();
    this.dropVrCaption();
    this.dropVrHint();
    this.vr.dotTex?.dispose();
    this.texture?.dispose();
    this.finishCrossfade();
    if (this.planet) {
      this.planet.mesh.geometry.dispose();
      this.planet.mat.dispose();
      this.planet = null;
    }
    this.disk = this.dropCover(this.disk);
    this.figure = this.dropCover(this.figure);
    this.layers.pins.replaceChildren();
    this.renderer.dispose();
  }

  private resize() {
    if (this.renderer.xr.isPresenting) return;
    this.invalidate();
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setSettings(s: ViewerSettings) {
    this.settings = s;
    this.updateCovers();
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

  /** Keep the current photo on screen to fade out under the next one. */
  private retireCurrent() {
    this.finishCrossfade();
    if (!this.mesh || this.reducedMotion) {
      this.clearMesh();
      this.texture?.dispose();
      this.texture = null;
      return;
    }
    this.mesh.renderOrder = 0;
    this.outgoing = { mesh: this.mesh, texture: this.texture, t0: performance.now() };
    this.mesh = null;
    this.texture = null;
  }

  /** End a crossfade: drop the old photo and make the new one opaque again. */
  private finishCrossfade() {
    const o = this.outgoing;
    if (!o) return;
    this.invalidate();
    this.outgoing = null;
    this.scene.remove(o.mesh);
    o.mesh.geometry.dispose();
    (o.mesh.material as T.Material).dispose();
    o.texture?.dispose();
    const m = this.mesh?.material as T.MeshBasicMaterial | undefined;
    if (m) {
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.needsUpdate = true;
    }
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
    const fading = !!this.outgoing;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.texture, transparent: fading, opacity: fading ? 0 : 1, depthWrite: !fading }));
    this.mesh.renderOrder = 1;
    if (this.isFlat) this.mesh.position.set(0, 0, -FLAT_D);
    else this.mesh.rotation.y = -Math.PI / 2;
    this.scene.add(this.mesh);
    for (const c of [this.disk, this.figure]) if (c) c.mesh.visible = !this.isFlat;
  }

  private setTexture(src: HTMLImageElement | HTMLCanvasElement) {
    this.invalidate();
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
    this.grade = null;
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
    this.retireCurrent();
    this.build(input);
    this.shown = img;
    this.setTexture(img);
    this.setHotspots(input.hotspots);
    if (this.renderer.xr.isPresenting) this.faceStartInVR();
    this.layers.minimap.hidden = !(this.settings.minimap && !this.isFlat);
    if (this.gyro.on) {
      // Sensors stay on from photo to photo: the new photo's start view is
      // wherever the phone points now, and no opening plays over the phone's own view.
      this.aimSensorsAt(this.start.yaw);
      this.view.fov = this.start.fov;
      this.anim.active = false;
      this.planetD = 0;
    } else if (opts.initialView) {
      Object.assign(this.view, opts.initialView);
      this.anim.active = false;
      this.planetD = 0;
    } else if (opts.reveal && !this.renderer.xr.isPresenting) this.reveal();
    else {
      Object.assign(this.view, this.start);
      this.planetD = 0;
    }
    this.cb.onLoaded?.({ width: first!, final: best === first });

    const bestUrl = urlFor(best);
    if (best && best !== first && bestUrl) {
      try {
        const big = await loadImage(bestUrl);
        if (token !== this.loadToken || this.disposed) return;
        this.shown = big;
        if (this.blurs || this.grade) this.applyBlurPreview();
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
    if (this.blurs || this.grade) this.applyBlurPreview();
  }

  setBlurPreview(blurs: Blur[] | null) {
    this.blurs = blurs;
    this.refreshPreview();
  }

  /** Preview a grade (pano-kit grade), baked the same way as blurs and together with them. Null: none. */
  setGradePreview(grade: Grade | null) {
    this.grade = grade && !isIdentityGrade(grade) ? grade : null;
    this.refreshPreview();
  }

  private refreshPreview() {
    if (!this.blurs && !this.grade) {
      if (this.bakeTimer) clearTimeout(this.bakeTimer);
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
      if (!src || (!this.blurs && !this.grade)) return;
      const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
      const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
      // Preview at up to 4096 wide: plenty to judge a blur, quick to redraw.
      const k = Math.min(1, 4096 / sw);
      this.setTexture(bakeTo(src, Math.round(sw * k), Math.round(sh * k), this.blurs ?? [], this.grade));
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
      this.planetD = 0;
    }
    this.camera.position.set(0, 0, 0);
    const dir = lookDir(this.THREE, this.view.yaw, clamp(this.view.pitch, -89, 89)).add(this.camera.position);
    this.camera.lookAt(dir);
    if (this.camera.fov !== this.view.fov) {
      this.camera.fov = this.view.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  flyTo(to: View, dur = 1400) {
    if (this.gyro.on) {
      // The phone holds the view, so turn its heading instead of dropping the
      // sensors: what was asked for is now straight ahead (the pitch stays the
      // phone's). Start view and a label from the list used to switch them off.
      this.aimSensorsAt(to.yaw);
      this.view.fov = to.fov;
      return;
    }
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

  /** The opening (settings.opening), always ending on the start view. A flat
   *  photo only flies or zooms: there is no sphere to turn round. */
  reveal() {
    const s = this.start;
    this.planetD = 0;
    const o = this.settings.opening;
    if (this.reducedMotion || o === "none") {
      Object.assign(this.view, s);
      this.anim.active = false;
      return;
    }
    const run = (from: View, dur: number, planet = false, to: View = s) => {
      Object.assign(this.view, from);
      this.planetD = planet ? 1 : 0;
      this.anim = {
        active: true, t0: performance.now(), dur, from: { ...from }, to: { ...to },
        planet: planet ? { from: 1, to: 0 } : undefined, ease: easeInOut,
      };
    };
    if (!this.isFlat) {
      // The whole scene as a small round world seen from above, unfolding into the start view.
      if (o === "planet") return run({ yaw: s.yaw + 60, pitch: -89.9, fov: PLANET_FOV }, 3000, true, { ...s, yaw: s.yaw + 60 + wrap180(-60) });
      // The same world turning half round as it opens out.
      if (o === "swirl") return run({ yaw: s.yaw - 200, pitch: -89.9, fov: PLANET_FOV }, 5200, true);
      // One slow turn round the whole scene, settling on the start view.
      if (o === "spin") return run({ yaw: s.yaw - 330, pitch: s.pitch - 4, fov: Math.min(FOV_MAX, s.fov + 20) }, 7500);
      // From the ground at your feet, tilting up to the view.
      if (o === "rise") return run({ yaw: s.yaw - 25, pitch: -89, fov: FOV_MAX }, 4200);
      // From the sky, tilting down to the view.
      if (o === "sky") return run({ yaw: s.yaw + 25, pitch: 89, fov: FOV_MAX }, 4200);
    }
    // From close in on the view, pulling back to it.
    if (o === "zoom") return run({ yaw: s.yaw + 4, pitch: s.pitch + 2, fov: FOV_MIN }, 3400);
    // fly, and anything a flat photo cannot do: a long glide in from off to one side.
    run(this.isFlat
      ? { yaw: s.yaw - 12, pitch: s.pitch + 4, fov: Math.max(FOV_MIN, s.fov * 0.75) }
      : { yaw: s.yaw - 45, pitch: s.pitch + 12, fov: Math.max(FOV_MIN, s.fov * 0.6) }, 3200);
  }

  setFov(f: number) {
    this.view.fov = clamp(f, FOV_MIN, FOV_MAX);
  }

  zoom(delta: number) {
    this.touched();
    this.setFov(this.view.fov + delta);
  }

  /** Slow turning when left alone. Defaults: 1.5°/s after 3 s idle; a tour wants faster and sooner. */
  setAutoRotate(on: boolean, opts: { speed?: number; idleMs?: number } = {}) {
    this.autoRotate = on;
    this.rotateSpeed = opts.speed ?? 1.5;
    this.rotateIdleMs = opts.idleMs ?? 3000;
    if (on && this.gyro.on) this.stopSensors(true);
  }

  private touched() {
    this.lastInteraction = performance.now();
    if (this.anim.active) {
      this.anim.active = false;
      this.anim.planet = undefined;
      // Interrupted mid-unfold: snap to an ordinary view rather than freeze half a planet.
      if (this.planetD > 0) {
        this.planetD = 0;
        this.view.fov = clamp(this.view.fov, FOV_MIN, FOV_MAX);
        this.view.pitch = clamp(this.view.pitch, -89, 89);
      }
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
    if (a.planet) this.planetD = a.planet.from + (a.planet.to - a.planet.from) * k;
    if (t >= 1) {
      a.active = false;
      a.planet = undefined;
      a.ease = undefined;
      this.view.yaw = wrap180(this.view.yaw);
      this.planetD = 0;
    }
  }

  /** Something changed that the camera does not show: a new image, a cover, labels. */
  private dirty = true;
  /** The camera and canvas the last frame was drawn for. */
  private lastSig = "";
  private invalidate() {
    this.dirty = true;
  }

  private lastT = performance.now();
  private frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.renderer.xr.isPresenting) {
      this.tick(now);
      if (this.autoRotate && !this.isFlat && !this.gyro.on && !this.anim.active && !this.mmDrag && !this.pointers.size
        && now - this.lastInteraction > this.rotateIdleMs && !this.reducedMotion) {
        this.view.yaw = wrap180(this.view.yaw + this.rotateSpeed * dt);
      }
      if (this.gyro.on && this.gyro.have) {
        this.camera.position.set(0, 0, 0);
        this.applyGyro();
      } else this.applyView();
    }
    if (this.renderer.xr.isPresenting) this.vrTick();
    const fading = !!this.outgoing;
    if (this.outgoing) {
      const k = Math.min(1, (now - this.outgoing.t0) / CROSSFADE_MS);
      const m = this.mesh?.material as T.MeshBasicMaterial | undefined;
      if (m) m.opacity = k;
      if (k >= 1) this.finishCrossfade();
    }
    // Draw only when something on screen would change. A still photo used to be
    // redrawn sixty times a second at full size, which is most of what a GPU
    // does here; skipping it frees the machine for the page around it.
    const xr = this.renderer.xr.isPresenting;
    const q = this.camera.quaternion;
    const sig = `${q.x.toFixed(5)},${q.y.toFixed(5)},${q.z.toFixed(5)},${q.w.toFixed(5)},${this.camera.fov.toFixed(3)},${this.planetD.toFixed(4)},${this.canvas.width}x${this.canvas.height}`;
    if (!xr && !fading && !this.dirty && sig === this.lastSig) return;
    this.dirty = false;
    this.lastSig = sig;
    if (!xr) {
      this.drawMinimapBox();
      this.placePins();
    }
    if (this.planetD > 0.0005 && !this.renderer.xr.isPresenting && !this.isFlat && this.texture && this.input) this.renderPlanet();
    else this.renderer.render(this.scene, this.camera);
  };

  private renderPlanet() {
    const THREE = this.THREE;
    if (!this.planet) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: null },
          crop: { value: new THREE.Vector4(0, 0, 1, 1) },
          d: { value: 1 },
          rot: { value: new THREE.Matrix3() },
          tanHalf: { value: 1 },
          aspect: { value: 1 },
          bg: { value: new THREE.Color(this.background) },
          disk: { value: null },
          diskOn: { value: 0 },
          diskTheta: { value: 0 },
          diskRot: { value: 0 },
          figure: { value: null },
          figureOn: { value: 0 },
          figureTheta: { value: 0 },
          figureFrame: { value: new THREE.Matrix3() },
        },
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.planet = { scene, mesh, mat };
    }
    const g = sphereParams(this.input!);
    const u = this.planet.mat.uniforms;
    u.map.value = this.texture;
    u.crop.value.set(g.cropL / g.fullW, g.cropT / g.fullH, g.cropW / g.fullW, g.cropH / g.fullH);
    u.d.value = this.planetD;
    this.camera.updateMatrixWorld();
    u.rot.value.setFromMatrix4(this.camera.matrixWorld);
    u.tanHalf.value = Math.tan(rad(this.view.fov) / 2);
    u.aspect.value = this.camera.aspect;
    u.diskOn.value = this.disk ? 1 : 0;
    u.disk.value = this.disk?.tex ?? null;
    u.diskTheta.value = this.disk?.theta ?? 0;
    u.diskRot.value = rad(this.settings.nadirRot ?? 0);
    u.figureOn.value = this.figure ? 1 : 0;
    u.figure.value = this.figure?.tex ?? null;
    u.figureTheta.value = this.figure?.theta ?? 0;
    // The same turn as the mesh's, inverted: the planet and the mesh cannot disagree.
    if (this.figure) u.figureFrame.value.setFromMatrix4(new this.THREE.Matrix4().makeRotationFromQuaternion(this.figure.mesh.quaternion.clone().invert()));
    this.renderer.render(this.planet.scene, this.camera);
  }

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
    this.invalidate();
    this.hotspots = list;
    this.layers.pins.replaceChildren();
    this.pins = list.map((h, i) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "pano-pin";
      pin.dataset.kind = this.labelMode;
      const text = document.createElement("span");
      text.className = "pano-pin-text";
      text.textContent = h.text || `Label ${i + 1}`;
      pin.append(text);
      if (this.labelMode === "note") {
        pin.dataset.open = "0";
        pin.setAttribute("aria-expanded", "false");
        pin.setAttribute("aria-label", h.text || `Label ${i + 1}`);
        pin.onclick = e => {
          // A comment, not a link: open or close it where it is, and leave the view alone.
          e.stopPropagation();
          const open = pin.dataset.open !== "1";
          pin.dataset.open = open ? "1" : "0";
          pin.setAttribute("aria-expanded", String(open));
        };
      } else {
        pin.onclick = () => {
          this.touched();
          this.flyTo(this.viewFor(h, Math.min(this.view.fov, 60)), 800);
        };
      }
      this.layers.pins.append(pin);
      return pin;
    });
    this.vr.open.clear();
    if (this.renderer.xr.isPresenting) this.buildVrLabels();
  }

  /** Turn to a label and open it: for a list of a photo's points of interest. */
  showLabel(i: number) {
    const h = this.hotspots[i], pin = this.pins[i];
    if (!h) return;
    this.touched();
    this.flyTo(this.viewFor(h, Math.min(this.view.fov, 60)), 900);
    if (pin?.dataset.kind === "note") {
      pin.dataset.open = "1";
      pin.setAttribute("aria-expanded", "true");
    }
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
    if (this.planetD > 0.01) {
      for (const pin of this.pins) pin.dataset.state = "hidden";
      return;
    }
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

  /* --------------------------------------------------- nadir cover */

  /** A picture for the nadir cover itself when settings.nadir is "image": a
   *  logo, anything with transparency. Square works best; it is drawn centred
   *  and contained. Its centre sits straight down and its top points at nadirRot. */
  setNadirImage(src: (CanvasImageSource & { width: number; height: number }) | null) {
    this.nadirImage = src ? { src, serial: (this.nadirImage?.serial ?? 0) + 1 } : null;
    this.updateCovers();
  }

  /** A picture drawn under the nadir cover, sized and turned on its own
   *  (settings.figure): a figure standing in for whoever held the camera,
   *  coming out from under the badge. Same rules as setNadirImage. */
  /** The words on the badge disk, e.g. each photo's own title and credit. Fitted to the disk however long. */
  setBadge(badge: { title: string; subtitle?: string } | null) {
    this.badge = badge;
    this.updateCovers();
  }

  /** A line or two about the photo (its title; then date and place), shown in
   *  the headset for a few seconds after it opens, below the start view: a
   *  page's own text never shows in VR. */
  setCaption(lines: string[] | null) {
    const kept = lines?.map(l => l.trim()).filter(Boolean) ?? [];
    this.captionLines = kept.length ? kept : null;
    if (this.renderer.xr.isPresenting) this.showVrCaption();
  }

  /** Labels shown or put away, in the headset too. On a page the pins layer is
   *  the page's own element to hide. */
  setLabelsShown(on: boolean) {
    this.labelsShown = on;
    if (this.vr.labels) this.vr.labels.visible = on;
  }

  /** How the controls work, as a card shown for fifteen seconds on entering the
   *  headset, below the caption: the first line as a title, the rest as lines. */
  setVrHint(lines: string[] | null) {
    const kept = lines?.map(l => l.trim()).filter(Boolean) ?? [];
    this.hintLines = kept.length ? kept : null;
  }

  setFigureImage(src: (CanvasImageSource & { width: number; height: number }) | null) {
    this.figureImage = src ? { src, serial: (this.figureImage?.serial ?? 0) + 1 } : null;
    this.updateCovers();
  }

  private nadirDeg() {
    return clamp(this.settings.nadirDeg, 5, NADIR_DEG_MAX);
  }

  private dropCover(c: Cover | null): null {
    if (c) {
      this.scene.remove(c.mesh);
      c.mesh.geometry.dispose();
      (c.mesh.material as T.Material).dispose();
      c.tex.dispose();
    }
    return null;
  }

  private drawBadge(): HTMLCanvasElement {
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
      // Fitted inside the inner ring whatever the words: shrunk, then wrapped, then cut short.
      x.textAlign = "center"; x.textBaseline = "middle";
      const font = (size: number, sub: boolean) => `${sub ? 500 : 700} ${size}px system-ui, sans-serif`;
      const measure = (t: string, size: number) => { x.font = font(size, false); return x.measureText(t).width; };
      for (const l of fitBadge(this.badge.title, this.badge.subtitle, 138, measure)) {
        x.font = font(l.size, l.sub);
        x.fillStyle = l.sub ? this.accent : "#f5f3ff";
        x.fillText(l.text, 0, l.y);
      }
    }
    return c;
  }

  private drawPicture(src: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
    // Seen from close by, and at a slant out towards its edge: as sharp as the device can sensibly hold.
    const size = this.cap >= 8192 ? 2048 : 1024;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const k = Math.min(size / src.width, size / src.height);
    c.getContext("2d")!.drawImage(src, (size - src.width * k) / 2, (size - src.height * k) / 2, src.width * k, src.height * k);
    return c;
  }

  /** One layer: built when what is on it changes, rebuilt in shape when its
   *  size does, and otherwise only turned, so a slider is cheap. A viewer-time
   *  mesh, not baked, so changing it needs no re-encode. */
  private placeCover(
    cur: Cover | null, key: string | null, draw: () => HTMLCanvasElement, deg: number, rot: number, layer: number,
    at?: { yaw: number; pitch: number } | null, centre?: { x: number; y: number },
  ): Cover | null {
    if (!key) return this.dropCover(cur);
    const THREE = this.THREE;
    const theta = rad(clamp(deg, 5, NADIR_DEG_MAX));
    let c = cur;
    if (!c || c.key !== key) {
      this.dropCover(c);
      const tex = new THREE.Texture(draw());
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.maxAniso;
      tex.needsUpdate = true;
      // The higher layer sits a little nearer and draws later, over the one below.
      const mesh = new THREE.Mesh(
        makeCap(THREE, theta, RADIUS * (0.985 - 0.005 * layer)),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      mesh.renderOrder = 2 + layer;
      this.scene.add(mesh);
      c = { mesh, tex, key, theta, layer };
    } else if (c.theta !== theta) {
      c.mesh.geometry.dispose();
      c.mesh.geometry = makeCap(THREE, theta, RADIUS * (0.985 - 0.005 * layer));
      c.theta = theta;
    }
    // Turned about the vertical, so its top points at yaw rot. Placed somewhere,
    // its `centre` point is first rolled to straight down (so turns spin about
    // it), then everything is tilted along the great circle from straight down
    // to `at`, which carries its top along without twisting it.
    const down = new THREE.Vector3(0, -1, 0);
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -rad(rot));
    if (at) {
      const r = centre ? Math.hypot(centre.x, centre.y) : 0;
      if (r > 1e-6) {
        // Picture x is world x and picture y (down) is world z, as makeCap lays it on.
        const phi = 2 * Math.atan(r * Math.tan(c.theta / 2));
        const p = new THREE.Vector3((Math.sin(phi) * centre!.x) / r, -Math.cos(phi), (Math.sin(phi) * centre!.y) / r);
        turn.multiply(new THREE.Quaternion().setFromUnitVectors(p, down));
      }
      if (at.pitch > -89.95) turn.premultiply(new THREE.Quaternion().setFromUnitVectors(down, lookDir(THREE, at.yaw, at.pitch)));
    }
    c.mesh.quaternion.copy(turn);
    c.mesh.visible = !this.isFlat;
    return c;
  }

  private updateCovers() {
    this.invalidate();
    const s = this.settings;
    const usable = (p: Picture | null) => (p && p.src.width > 0 && p.src.height > 0 ? p : null);
    const img = usable(this.nadirImage);
    const mode = s.nadir === "none" ? null : s.nadir === "image" && img ? "image" : "disk";
    const badgeKey = this.badge ? `disk:${this.badge.title}|${this.badge.subtitle ?? ""}` : "disk";
    this.disk = this.placeCover(this.disk, mode && (mode === "image" ? `image:${img!.serial}` : badgeKey),
      () => (mode === "image" ? this.drawPicture(img!.src) : this.drawBadge()), this.nadirDeg(), s.nadirRot ?? 0, 1);
    const fig = s.figure ? usable(this.figureImage) : null;
    this.figure = this.placeCover(this.figure, fig && `figure:${fig.serial}`, () => this.drawPicture(fig!.src),
      s.figure?.deg ?? 0, s.figure?.rot ?? 0, 0, s.figure?.at, s.figure?.centre);
  }

  /* ------------------------------------------------------ sensors */

  /** A quick first check only: desktop browsers define the motion APIs, and a
   *  touchscreen PC passes the touch test, yet neither has sensors. Decide
   *  whether to offer Sensors with detectSensors. */
  static sensorsAvailable(): boolean {
    const touchy = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
    return touchy && (typeof DeviceOrientationEvent !== "undefined" || "RelativeOrientationSensor" in window);
  }

  private static sensing: Promise<boolean> | null = null;
  /** Whether this device really reports how it is held, found by listening
   *  rather than guessing: only real angles count (desktop Chrome sends one
   *  event with every angle null). Silence is a no, except on a handheld whose
   *  browser asks first (requestPermission): iOS sends nothing until asked
   *  from a tap, and a Chromium that has requestPermission may hold events
   *  back the same way. requestPermission alone proves nothing (Chrome 152 on
   *  a touchscreen PC has it), so the device must also be held: an iPhone or
   *  iPad, or a coarse primary pointer. Only a yes is kept: a page that loaded
   *  hidden may not have been sent anything yet. */
  static detectSensors(timeoutMs = 1500): Promise<boolean> {
    if (PanoEngine.sensing) return PanoEngine.sensing;
    const probe = new Promise<boolean>(resolve => {
      const DOE = (window as any).DeviceOrientationEvent;
      if (!DOE || !PanoEngine.sensorsAvailable()) return resolve(false);
      const handheld = matchMedia("(pointer: coarse)").matches;
      const asks = typeof DOE.requestPermission === "function";
      const done = (ok: boolean) => {
        clearTimeout(timer);
        window.removeEventListener("deviceorientation", heard);
        resolve(ok);
      };
      const heard = (e: DeviceOrientationEvent) => { if (e.beta != null || e.alpha != null) done(true); };
      // Silence: a yes on an iPhone, and on a handheld whose browser has still to
      // ask (requestPermission, or a sensor permission at "prompt"), since
      // either sends nothing until a tap asks it to.
      const timer = setTimeout(() => {
        if (PanoEngine.isApple() && asks) return done(true);
        if (!handheld) return done(false);
        if (asks) return done(true);
        void PanoEngine.sensorPermission().then(state => done(state === "prompt"));
      }, timeoutMs);
      window.addEventListener("deviceorientation", heard);
    });
    PanoEngine.sensing = probe;
    void probe.then(ok => { if (!ok) PanoEngine.sensing = null; });
    return probe;
  }

  static isApple(): boolean {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  /** The browser's sensor permission for this site, where it can be asked:
   *  "prompt" means a tap can make it ask. "unknown" where the Permissions API
   *  has no such name (Safari, Firefox): those never ask. */
  static async sensorPermission(): Promise<"granted" | "prompt" | "denied" | "unknown"> {
    try {
      const st = await navigator.permissions.query({ name: "accelerometer" as PermissionName });
      return st.state;
    } catch {
      return "unknown";
    }
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

  /** Turn the sensors' heading so the phone, pointing where it points now, looks at `yaw`. */
  private aimSensorsAt(yaw: number) {
    if (this.gyro.have) {
      this.gyro.headingOffset += rad(wrap180(this.currentView().yaw - yaw));
      this.applyGyro(); // the camera now, so a second aim this frame measures from here
    } else this.gyro.wantYaw = yaw; // the first reading lines up on it (firstSample)
    this.invalidate();
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
      s.addEventListener("error", (e: any) => {
        if (this.gyro.have) return;
        if (e?.error?.name === "NotAllowedError") {
          // The visitor said no, or the setting does: not a device without sensors.
          console.warn("pano-kit: motion access refused (NotAllowedError)");
          this.stopSensors(true);
          this.cb.onToast?.("Motion access was refused. Allow motion sensors for this site in the browser's settings, reload, and tap Sensors again.", "err");
          return;
        }
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

  /** Look around by moving the phone. Only ever from a tap: that is what lets
   *  a browser ask. On iOS the asking is DeviceOrientationEvent.requestPermission,
   *  and the only way in. On a Chromium it is starting the Generic Sensor API,
   *  which asks a browser still to decide (its requestPermission only answers
   *  from the stored setting, so its answer is noted, never acted on). While
   *  the browser is asking, the watchdog waits for the visitor; otherwise no
   *  data within 2 s means a device without sensors, and drag it is. */
  async startSensors(): Promise<boolean> {
    const DOE = (window as any).DeviceOrientationEvent;
    const asks = !!DOE && typeof DOE.requestPermission === "function";
    const refused = (why: string) => {
      console.warn(`pano-kit: motion access refused (${why})`);
      this.cb.onToast?.("Motion access was refused. Allow motion sensors for this site in the browser's settings, reload, and tap Sensors again.", "err");
    };
    if (asks && PanoEngine.isApple()) {
      try {
        const answer = await DOE.requestPermission();
        if (answer !== "granted") {
          refused(String(answer));
          return false;
        }
      } catch (e: any) {
        refused(e?.name || "no answer");
        return false;
      }
    }
    this.anim.active = false;
    this.autoRotate = false;
    Object.assign(this.gyro, { wantYaw: this.currentView().yaw, headingOffset: 0, on: true, have: false, count: 0 });
    // Still inside the tap: a Chromium that has not decided asks here.
    if (!this.startGenericSensor()) {
      this.gyro.path = "deviceorientation";
      window.addEventListener("deviceorientation", this.onOrientation);
    }
    if (asks && !PanoEngine.isApple()) DOE.requestPermission().then((a: unknown) => console.info(`pano-kit: requestPermission says ${a}`), () => {});
    this.emitSensors();
    const pending = (await PanoEngine.sensorPermission()) === "prompt" && !this.gyro.have;
    if (pending && this.gyro.on) this.cb.onToast?.("Allow motion sensors when the browser asks.", "ok");
    clearTimeout(this.gyro.watchdog);
    this.gyro.watchdog = setTimeout(() => {
      if (this.gyro.have || !this.gyro.on) return;
      console.warn(`pano-kit: no motion data arrived (${this.gyro.path})`);
      this.stopSensors(true);
      this.cb.onToast?.(pending ? "No answer from the browser about motion sensors; drag to look around." : "This device isn't sending motion data, so drag to look around.", "warn");
    }, pending ? 60000 : 2000);
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

  private onContextRestored = () => {
    this.lastSig = "";
    this.invalidate();
  };

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
        this.vr.base = null;
        this.vr.drag = null;
        this.vr.applied = NaN;
        this.vr.faceStart = false;
        this.vr.armed.clear();
        this.vr.hold.clear();
        this.vr.bDown.clear();
        // The next session starts from its own reference space, not this one's turn.
        this.renderer.xr.setReferenceSpace(null as unknown as XRReferenceSpace);
        this.dropVrLabels();
        this.dropVrCaption();
        this.dropVrHint();
        Object.assign(this.view, this.start);
        this.resize();
        this.cb.onVR?.(false);
      });
      // The trigger is for looking: held and swept it drags the view round like a
      // mouse, and a press that hardly moved is a click that opens or closes the
      // label pointed at. Stepping through the photos is the A/X and B/Y buttons
      // (vrTick), so neither can set the other off. Grip does nothing: hands
      // squeeze it just holding the controller.
      s.addEventListener("selectstart", e => {
        const ray = this.vr.base && this.rayOf(e.frame, e.inputSource, this.vr.base);
        if (ray) this.vr.drag = { source: e.inputSource, startRay: yawOf(ray), startYaw: this.vr.yaw, swung: 0 };
      });
      s.addEventListener("select", e => {
        const d = this.vr.drag;
        if (d && d.source === e.inputSource && d.swung > DRAG_DEG) return;
        const space = this.renderer.xr.getReferenceSpace();
        const ray = space && this.rayOf(e.frame, e.inputSource, space);
        const i = ray ? pointedLabel(ray, this.vr.dirs) : -1;
        if (i >= 0 && !this.vr.open.delete(i)) this.vr.open.add(i);
      });
      s.addEventListener("selectend", e => { if (this.vr.drag?.source === e.inputSource) this.vr.drag = null; });
      await this.renderer.xr.setSession(s);
      this.vr.base = this.renderer.xr.getReferenceSpace();
      this.faceStartInVR();
      this.buildVrLabels();
      this.showVrHint();
      this.cb.onVR?.(true);
    } catch (e: any) {
      this.cb.onToast?.(`Could not start VR: ${e?.message ?? e}`, "err");
    }
  }

  get presentingVR() {
    return this.renderer.xr.isPresenting;
  }

  /* ------------------------------------------------- in the headset */

  /** Turn the headset view to vr.yaw (degrees, positive right) by offsetting the
   *  session's own reference space, so head tracking is exactly as it was. A
   *  pose in an offset space is the base pose with the offset undone, so
   *  turning the view right by a takes a rotation of +a about y. */
  private applyVrYaw() {
    const base = this.vr.base;
    if (!base) return;
    if (Math.abs(wrap180(this.vr.yaw - this.vr.applied)) < 0.02) return;
    this.vr.applied = this.vr.yaw;
    const h = rad(this.vr.yaw) / 2;
    this.renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(new XRRigidTransform(undefined, { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) })));
  }

  /** Each photo opens facing its start view: where the head points right now, not
   *  where it pointed when the session began. The head's yaw needs a frame
   *  (vrTick); until then the world is turned as if the head were at rest. */
  private faceStartInVR() {
    this.vr.yaw = wrap180(this.start.yaw);
    this.vr.drag = null;
    this.vr.faceStart = true;
    this.applyVrYaw();
  }

  /** The -z of an orientation: where a controller or the head points. */
  private forwardOf(o: { x: number; y: number; z: number; w: number }): Vec3 {
    const { x, y, z, w } = o;
    return { x: -2 * (x * z + w * y), y: -2 * (y * z - w * x), z: -(1 - 2 * (x * x + y * y)) };
  }

  /** Where a controller points, in `space`. */
  private rayOf(frame: XRFrame, source: XRInputSource, space: XRReferenceSpace): Vec3 | null {
    const pose = frame.getPose(source.targetRaySpace, space);
    return pose ? this.forwardOf(pose.transform.orientation) : null;
  }

  private vrTick() {
    const frame = this.renderer.xr.getFrame() as XRFrame | null;
    const s = this.xrSession, base = this.vr.base;
    if (!frame || !s || !base) return;
    if (this.vr.caption && performance.now() > this.vr.captionUntil) this.dropVrCaption();
    if (this.vr.hint && performance.now() > this.vr.hintUntil) this.dropVrHint();
    let turned = false;
    if (this.vr.faceStart) {
      // What is seen = head yaw in the base space + the world's turn: set the turn
      // so the start view is straight ahead of wherever the head is now.
      const head = frame.getViewerPose(base);
      if (head) {
        this.vr.faceStart = false;
        this.vr.yaw = wrap180(this.start.yaw - yawOf(this.forwardOf(head.transform.orientation)));
        turned = true;
      }
    }
    const now = performance.now();
    for (const src of s.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const ax = gp.axes;
      if (ax.length >= 2) {
        // xr-standard puts the thumbstick at axes 2 and 3 (0 and 1 are a touchpad); a
        // controller with only two axes has its stick there. Left and right turn; up
        // and down are deliberately nothing.
        const st = snapTurn(ax.length >= 4 ? ax[2] : ax[0], this.vr.armed.get(src) ?? true);
        this.vr.armed.set(src, st.armed);
        if (st.turn) {
          this.vr.yaw = wrap180(this.vr.yaw + st.turn * SNAP_DEG);
          turned = true;
        }
      }
      // xr-standard buttons: 4 is A or X, 5 is B or Y. A/X clicked is the next photo;
      // held and swept sideways, a swipe: left next, right previous. B/Y is previous.
      const a = gp.buttons[4]?.pressed ?? false, b = gp.buttons[5]?.pressed ?? false;
      const held = this.vr.hold.get(src);
      if (a && !held) {
        const ray = this.rayOf(frame, src, base);
        if (ray) this.vr.hold.set(src, { t0: now, startRay: yawOf(ray), delta: 0, swung: 0 });
      } else if (a && held) {
        const ray = this.rayOf(frame, src, base);
        if (ray) {
          held.delta = wrap180(yawOf(ray) - held.startRay);
          held.swung = Math.max(held.swung, Math.abs(held.delta));
        }
      } else if (!a && held) {
        this.vr.hold.delete(src);
        const out = pressOutcome(held.delta, held.swung, now - held.t0);
        if (out === "next" || out === "click") this.cb.onStep?.(1);
        else if (out === "previous") this.cb.onStep?.(-1);
      }
      if (b && !(this.vr.bDown.get(src) ?? false)) this.cb.onStep?.(-1);
      this.vr.bDown.set(src, b);
    }
    const d = this.vr.drag;
    if (d) {
      // Measured in the base space, which the turn does not move, so the drag cannot feed on itself.
      const ray = this.rayOf(frame, d.source, base);
      if (ray) {
        const delta = wrap180(yawOf(ray) - d.startRay);
        d.swung = Math.max(d.swung, Math.abs(delta));
        // The photo follows the hand, as it does under a mouse.
        this.vr.yaw = wrap180(d.startYaw - delta);
        turned = true;
      }
    }
    if (turned) this.applyVrYaw();
    if (!this.vr.labels) return;
    // A label's card shows while a controller points at its dot, or once clicked open.
    const space = this.renderer.xr.getReferenceSpace();
    const hovered = new Set<number>();
    if (space) {
      for (const src of s.inputSources) {
        if (src.targetRayMode !== "tracked-pointer") continue;
        const ray = this.rayOf(frame, src, space);
        const i = ray ? pointedLabel(ray, this.vr.dirs) : -1;
        if (i >= 0) hovered.add(i);
      }
    }
    this.vr.cards.forEach((c, i) => { if (c) c.visible = hovered.has(i) || this.vr.open.has(i); });
    this.vr.dots.forEach((dot, i) => { dot?.scale.setScalar(this.vr.dotSize * (hovered.has(i) ? 1.6 : 1)); });
  }

  /** The labels as sprites in the scene, for the headset: a dot each, and a card
   *  of text above it that shows when pointed at. Labels on a flat photo have
   *  no direction and are left out. */
  private buildVrLabels() {
    this.dropVrLabels();
    if (!this.renderer.xr.isPresenting) return;
    const THREE = this.THREE;
    const at = RADIUS * 0.9;
    const span = (degrees: number) => 2 * at * Math.tan(rad(degrees) / 2);
    this.vr.dotTex ??= this.vrDotTexture();
    this.vr.dotSize = span(1.6);
    const g = new THREE.Group();
    this.vr.dirs = this.hotspots.map(h => ("u" in h ? null : lookDir(THREE, h.yaw, h.pitch)));
    this.vr.dots = [];
    this.vr.cards = [];
    this.hotspots.forEach((h, i) => {
      const dir = this.vr.dirs[i];
      if (!dir) {
        this.vr.dots.push(null);
        this.vr.cards.push(null);
        return;
      }
      const pos = new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(at);
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.vr.dotTex, depthTest: false, transparent: true }));
      dot.scale.setScalar(this.vr.dotSize);
      dot.position.copy(pos);
      dot.renderOrder = 10;
      const card = this.vrCard(h.text || `Label ${i + 1}`);
      card.sprite.scale.set(span(24), span(24) * card.aspect, 1);
      card.sprite.center.set(0.5, -0.12); // just above its dot
      card.sprite.position.copy(pos);
      card.sprite.visible = false;
      card.sprite.renderOrder = 11;
      g.add(dot, card.sprite);
      this.vr.dots.push(dot);
      this.vr.cards.push(card.sprite);
    });
    g.visible = this.labelsShown;
    this.vr.labels = g;
    this.scene.add(g);
    this.showVrCaption();
  }

  /** The caption below the start view, for eight seconds. In the offset space
   *  the start view is straight ahead of the head, so the card is too. */
  private showVrCaption() {
    this.dropVrCaption();
    if (!this.renderer.xr.isPresenting || !this.captionLines) return;
    const THREE = this.THREE;
    const at = RADIUS * 0.9;
    const [title, ...rest] = this.captionLines;
    const card = this.vrCard(title, rest.join(" · ") || undefined);
    const w = 2 * at * Math.tan(rad(34) / 2);
    card.sprite.scale.set(w, w * card.aspect, 1);
    card.sprite.position.copy(lookDir(THREE, this.start.yaw, -24).multiplyScalar(at));
    card.sprite.renderOrder = 12;
    this.scene.add(card.sprite);
    this.vr.caption = card.sprite;
    this.vr.captionUntil = performance.now() + 8000;
  }

  /** The controls, below the caption, for fifteen seconds after entering. */
  private showVrHint() {
    this.dropVrHint();
    if (!this.renderer.xr.isPresenting || !this.hintLines) return;
    const THREE = this.THREE;
    const at = RADIUS * 0.9;
    const [title, ...rest] = this.hintLines;
    const card = this.vrCard(title, rest.join("\n") || undefined);
    const w = 2 * at * Math.tan(rad(40) / 2);
    card.sprite.scale.set(w, w * card.aspect, 1);
    card.sprite.position.copy(lookDir(THREE, this.start.yaw, -44).multiplyScalar(at));
    card.sprite.renderOrder = 12;
    this.scene.add(card.sprite);
    this.vr.hint = card.sprite;
    this.vr.hintUntil = performance.now() + 15000;
  }

  private dropVrHint() {
    const c = this.vr.hint;
    if (!c) return;
    this.scene.remove(c);
    const m = c.material as T.SpriteMaterial;
    m.map?.dispose();
    m.dispose();
    this.vr.hint = null;
  }

  private dropVrCaption() {
    const c = this.vr.caption;
    if (!c) return;
    this.scene.remove(c);
    const m = c.material as T.SpriteMaterial;
    m.map?.dispose();
    m.dispose();
    this.vr.caption = null;
  }

  private dropVrLabels() {
    const g = this.vr.labels;
    if (!g) return;
    this.scene.remove(g);
    g.traverse(o => {
      const m = (o as T.Sprite).material as T.SpriteMaterial | undefined;
      if (!m) return;
      if (m.map && m.map !== this.vr.dotTex) m.map.dispose();
      m.dispose();
    });
    this.vr.labels = null;
    this.vr.dots = [];
    this.vr.cards = [];
    this.vr.dirs = [];
  }

  private vrDotTexture(): T.Texture {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(64, 64, 40, 0, Math.PI * 2);
    ctx.fillStyle = this.accent;
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    const t = new this.THREE.CanvasTexture(c);
    t.colorSpace = this.THREE.SRGBColorSpace;
    return t;
  }

  /** Text on a dark card, as a sprite, and its height over its width: a label,
   *  or a caption with a smaller second line. */
  private vrCard(text: string, sub?: string): { sprite: T.Sprite; aspect: number } {
    const W = 1024, pad = 40, size = 46, lineH = 60, subSize = 34, subH = 46;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    const family = `system-ui, -apple-system, "Segoe UI", sans-serif`;
    const font = `600 ${size}px ${family}`, subFont = `400 ${subSize}px ${family}`;
    ctx.font = font;
    const lines = wrapLines(text, W - pad * 2, s => ctx.measureText(s).width, 5);
    ctx.font = subFont;
    const subLines = sub ? sub.split("\n").flatMap(l => wrapLines(l, W - pad * 2, s => ctx.measureText(s).width, 2)).slice(0, 10) : [];
    c.width = W;
    c.height = pad * 2 + Math.max(1, lines.length) * lineH + (subLines.length ? 8 + subLines.length * subH : 0);
    ctx.fillStyle = "rgba(10,8,18,.92)"; // a resize clears the context's state, so the fonts are set again below
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.roundRect(3, 3, W - 6, c.height - 6, 28);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.font = font;
    ctx.fillStyle = "#ffffff";
    lines.forEach((l, i) => ctx.fillText(l, pad, pad + lineH * i + lineH / 2));
    ctx.font = subFont;
    ctx.fillStyle = "rgba(255,255,255,.78)";
    const subTop = pad + Math.max(1, lines.length) * lineH + 8;
    subLines.forEach((l, i) => ctx.fillText(l, pad, subTop + subH * i + subH / 2));
    const t = new this.THREE.CanvasTexture(c);
    t.colorSpace = this.THREE.SRGBColorSpace;
    t.anisotropy = this.maxAniso;
    return { sprite: new this.THREE.Sprite(new this.THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true })), aspect: c.height / W };
  }
}
