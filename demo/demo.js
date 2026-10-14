// src/core.ts
var DEFAULT_VIEW = { yaw: 0, pitch: 0, fov: 75 };
var FOV_MIN = 30;
var FOV_MAX = 100;
var DEFAULT_VIEWER_SETTINGS = { opening: "fly", nadir: "none", nadirDeg: 25, minimap: true };
var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
var wrap180 = (a) => a >= -180 && a < 180 ? a : ((a + 540) % 360 + 360) % 360 - 180;
var TEXTURE_CEILING = 8192;
var FIRST_PAINT_WIDTH = 2048;
function textureCap(maxTextureSize, deviceMemory) {
  const cap = Math.min(TEXTURE_CEILING, maxTextureSize || TEXTURE_CEILING);
  return deviceMemory && deviceMemory <= 4 ? Math.min(cap, 4096) : cap;
}
function pickWidth(sizes, cap) {
  if (!sizes.length) return null;
  const fit = sizes.filter((w) => w <= cap).sort((a, b) => b - a);
  return fit[0] ?? Math.min(...sizes);
}
function firstPaintWidth(sizes) {
  if (!sizes.length) return null;
  return sizes.includes(FIRST_PAINT_WIDTH) ? FIRST_PAINT_WIDTH : Math.min(...sizes);
}
var rad = (d) => d * Math.PI / 180;
var deg = (r) => r * 180 / Math.PI;
function capPolygon(yaw0, pitch0, r, W, H) {
  const rows = 40;
  const left = [];
  const right = [];
  const pTop = Math.min(90, pitch0 + r);
  const pBot = Math.max(-90, pitch0 - r);
  for (let i = 0; i <= rows; i++) {
    const p = pTop - (pTop - pBot) * i / rows;
    const cp = Math.cos(rad(p)) * Math.cos(rad(pitch0));
    let d;
    if (Math.abs(cp) < 1e-6) d = 180;
    else {
      const c = (Math.cos(rad(r)) - Math.sin(rad(p)) * Math.sin(rad(pitch0))) / cp;
      d = c <= -1 ? 180 : c >= 1 ? 0 : deg(Math.acos(c));
    }
    const y = (90 - p) / 180 * H;
    left.push([(yaw0 - d + 180) / 360 * W, y]);
    right.push([(yaw0 + d + 180) / 360 * W, y]);
  }
  return left.concat(right.reverse());
}

// src/bake.ts
var sizeOf = (src) => ({
  w: "naturalWidth" in src ? src.naturalWidth : src.width,
  h: "naturalHeight" in src ? src.naturalHeight : src.height
});
function traceCap(ctx, poly, offset) {
  ctx.moveTo(poly[0][0] + offset, poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0] + offset, poly[i][1]);
  ctx.closePath();
}
function paintBake(ctx, W, H, src, blurs) {
  const { w: sw0, h: sh0 } = sizeOf(src);
  const kx = sw0 / W;
  const ky = sh0 / H;
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(src, 0, 0, W, H);
  for (const b of blurs) {
    if ("u" in b) {
      const cx = b.u * W, cy = b.v * H, rad3 = b.r / 100 * W, px2 = clamp(rad3 * 0.35, 8, 80);
      const m2 = Math.ceil(px2 * 3);
      const sx2 = Math.max(0, cx - rad3 - m2), sy2 = Math.max(0, cy - rad3 - m2);
      const sw2 = Math.min(W, cx + rad3 + m2) - sx2, sh2 = Math.min(H, cy + rad3 + m2) - sy2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rad3, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = `blur(${px2}px)`;
      ctx.drawImage(src, sx2 * kx, sy2 * ky, sw2 * kx, sh2 * ky, sx2, sy2, sw2, sh2);
      ctx.restore();
      continue;
    }
    const poly = capPolygon(b.yaw, b.pitch, b.r, W, H);
    const ys = poly.map((p) => p[1]);
    const xs = poly.map((p) => p[0]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
    const px = clamp((y1 - y0) * 0.12, 8, 80);
    const m = Math.ceil(px * 3);
    const sy = Math.max(0, y0 - m), sh = Math.min(H, y1 + m) - sy;
    let sx = Math.max(0, Math.floor(Math.min(...xs)) - m);
    let sw = Math.min(W, Math.ceil(Math.max(...xs)) + m) - sx;
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
function bakeTo(src, W, H, blurs) {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("This browser could not make a 2D canvas");
  paintBake(ctx, W, H, src, blurs);
  return c;
}

// src/engine.ts
var threeLoads = /* @__PURE__ */ new Map();
function loadThree(url) {
  let p = threeLoads.get(url);
  if (!p) {
    p = import(
      /* @vite-ignore */
      url
    );
    threeLoads.set(url, p);
  }
  return p;
}
var RADIUS = 500;
var FLAT_D = 300;
var FLAT_VFOV = 60;
var PLANET_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
var PLANET_FRAG = `
precision highp float; // mediump shows artefacts on Quest 3
uniform sampler2D map;
uniform vec4 crop;     // the photo's place in the full sphere: left, top, width, height (0..1)
uniform float d;       // projection centre behind the sphere centre: 0 rectilinear, 1 stereographic
uniform mat3 rot;      // camera to world
uniform float tanHalf; // tan(vertical fov / 2)
uniform float aspect;
uniform vec3 bg;
uniform sampler2D disk; // the nadir disk, so it does not pop in when the planet hands over to the mesh
uniform float diskOn;
uniform float diskCos;  // the disk sits on the plane y = -cos(nadir angle)...
uniform float diskR;    // ...with this radius (unit sphere), as the mesh does
varying vec2 vUv;
const float PI = 3.14159265358979;
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
  if (diskOn > 0.5 && w.y < 0.0) {
    vec2 q = vec2(w.x, w.z) * (-diskCos / w.y); // where the ray meets the disk's plane
    if (length(q) < diskR) {
      vec4 dc = texture(disk, vec2(q.x / diskR, -q.y / diskR) * 0.5 + 0.5);
      col = vec4(mix(col.rgb, dc.rgb, dc.a), 1.0);
    }
  }
  gl_FragColor = col;
  #include <colorspace_fragment>
}
`;
var PLANET_FOV = 150;
var CROSSFADE_MS = 700;
var easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
var easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
var rad2 = (d) => d * Math.PI / 180;
var deg2 = (r) => r * 180 / Math.PI;
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image could not be loaded"));
    img.src = url;
  });
}
function sphereParams(p) {
  if (p.gpano) return p.gpano;
  const w = p.srcW || 2, h = p.srcH || 1;
  return { fullW: w, fullH: h, cropL: 0, cropT: 0, cropW: w, cropH: h };
}
function makeSphere(THREE, g, detail = 1) {
  const phiStart = 2 * Math.PI * g.cropL / g.fullW, phiLength = 2 * Math.PI * g.cropW / g.fullW;
  const thetaStart = Math.PI * g.cropT / g.fullH, thetaLength = Math.PI * g.cropH / g.fullH;
  const segW = Math.max(8, Math.round(96 * detail * g.cropW / g.fullW));
  const segH = Math.max(8, Math.round(64 * detail * g.cropH / g.fullH));
  const geo = new THREE.SphereGeometry(RADIUS, segW, segH, phiStart, phiLength, thetaStart, thetaLength);
  geo.scale(-1, 1, 1);
  return geo;
}
function lookDir(THREE, yaw, pitch) {
  const y = rad2(yaw), p = rad2(pitch);
  return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}
function renderStartThumb(THREE, src, input, start, w = 1200, h = 750) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  if (input.resolvedKind === "flat") {
    const ctx = canvas.getContext("2d");
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
    mesh.geometry.dispose();
    mesh.material.dispose();
    tex.dispose();
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    out.getContext("2d").drawImage(canvas, 0, 0);
    renderer.dispose();
    renderer.forceContextLoss();
    return new Promise((resolve, reject) => out.toBlob((b) => b ? resolve(b) : reject(new Error("thumbnail")), "image/jpeg", 0.86));
  }
  return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("thumbnail")), "image/jpeg", 0.86));
}
var PanoEngine = class {
  constructor(THREE, canvas, layers, cb = {}, options = {}) {
    this.canvas = canvas;
    this.layers = layers;
    this.cb = cb;
    this.THREE = THREE;
    this.accent = options.accent ?? "#e879f9";
    this.badge = options.badge === void 0 ? null : options.badge;
    this.background = options.background ?? 328458;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local");
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.background);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1100);
    this.scene.add(this.camera);
    this.raycaster = new THREE.Raycaster();
    this.gyro.q = new THREE.Quaternion();
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.cap = textureCap(this.renderer.capabilities.maxTextureSize, navigator.deviceMemory);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();
    this.bindPointer();
    this.bindMinimap();
    window.addEventListener("keydown", this.onKey);
    navigator.xr?.addEventListener?.("sessiongranted", this.onSessionGranted);
    this.renderer.setAnimationLoop(this.frame);
  }
  THREE;
  renderer;
  scene;
  camera;
  raycaster;
  mesh = null;
  texture = null;
  disk = null;
  diskTex = null;
  input = null;
  /** What is on screen: the best image loaded so far. */
  shown = null;
  /** What blur previews are baked from: the untouched original, when the curator loads it. */
  bakeSource = null;
  blurs = null;
  loadToken = 0;
  isFlat = false;
  resizeObs;
  maxAniso;
  cap;
  view = { ...DEFAULT_VIEW };
  start = { ...DEFAULT_VIEW };
  /** 1: a true little planet; 0: an ordinary view; between: the unfold. */
  planetD = 0;
  planet = null;
  /** The previous photo, fading out under the new one. */
  outgoing = null;
  anim = { active: false, t0: 0, dur: 0, from: DEFAULT_VIEW, to: DEFAULT_VIEW };
  autoRotate = false;
  rotateSpeed = 1.5;
  // degrees a second
  rotateIdleMs = 3e3;
  // how long untouched before it starts
  lastInteraction = performance.now();
  pointers = /* @__PURE__ */ new Map();
  lastPinch = 0;
  downAt = null;
  moved = 0;
  hotspots = [];
  pins = [];
  mmDrag = false;
  settings = { ...DEFAULT_VIEWER_SETTINGS };
  accent;
  badge;
  background;
  xrSession = null;
  disposed = false;
  reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  gyro = {
    on: false,
    have: false,
    path: "off",
    count: 0,
    headingOffset: 0,
    wantYaw: 0,
    watchdog: 0,
    sensor: null,
    q: null
  };
  wakeLock = null;
  /* --------------------------------------------------------- lifecycle */
  dispose() {
    this.disposed = true;
    this.loadToken++;
    this.stopSensors(true);
    this.xrSession?.end().catch(() => {
    });
    this.renderer.setAnimationLoop(null);
    this.resizeObs.disconnect();
    window.removeEventListener("keydown", this.onKey);
    navigator.xr?.removeEventListener?.("sessiongranted", this.onSessionGranted);
    this.clearMesh();
    this.texture?.dispose();
    this.finishCrossfade();
    if (this.planet) {
      this.planet.mesh.geometry.dispose();
      this.planet.mat.dispose();
      this.planet = null;
    }
    this.disk?.geometry.dispose();
    this.disk?.material?.dispose();
    this.diskTex?.dispose();
    this.layers.pins.replaceChildren();
    this.renderer.dispose();
  }
  resize() {
    if (this.renderer.xr.isPresenting) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }
  setSettings(s) {
    this.settings = s;
    this.updateDisk();
    this.layers.minimap.hidden = !(s.minimap && !this.isFlat && !!this.shown);
  }
  /* ------------------------------------------------------- photos */
  clearMesh() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
  }
  /** Keep the current photo on screen to fade out under the next one. */
  retireCurrent() {
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
  finishCrossfade() {
    const o = this.outgoing;
    if (!o) return;
    this.outgoing = null;
    this.scene.remove(o.mesh);
    o.mesh.geometry.dispose();
    o.mesh.material.dispose();
    o.texture?.dispose();
    const m = this.mesh?.material;
    if (m) {
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.needsUpdate = true;
    }
  }
  build(input) {
    const THREE = this.THREE;
    this.clearMesh();
    this.isFlat = input.resolvedKind === "flat";
    let geo;
    if (this.isFlat) {
      const w = input.srcW || 4, h = input.srcH || 3;
      const ph = 2 * FLAT_D * Math.tan(rad2(FLAT_VFOV) / 2);
      geo = new THREE.PlaneGeometry(ph * w / h, ph);
    } else {
      geo = makeSphere(THREE, sphereParams(input));
    }
    const fading = !!this.outgoing;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.texture, transparent: fading, opacity: fading ? 0 : 1, depthWrite: !fading }));
    this.mesh.renderOrder = 1;
    if (this.isFlat) this.mesh.position.set(0, 0, -FLAT_D);
    else this.mesh.rotation.y = -Math.PI / 2;
    this.scene.add(this.mesh);
    if (this.disk) this.disk.visible = !this.isFlat;
  }
  setTexture(src) {
    const THREE = this.THREE;
    const old = this.texture;
    const tex = new THREE.Texture(src);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    tex.needsUpdate = true;
    this.texture = tex;
    if (this.mesh) {
      this.mesh.material.map = tex;
      this.mesh.material.needsUpdate = true;
    }
    old?.dispose();
    this.drawMinimapBase(src);
  }
  /** Show a photo: the 2048 first so something is on screen fast, then the
   *  biggest the device can take, swapped in place. */
  async open(input, opts = {}) {
    const token = ++this.loadToken;
    this.input = input;
    this.bakeSource = null;
    this.blurs = null;
    this.stopSensors(true);
    this.start = { ...input.start };
    const sizes = input.sources.filter((s) => s.url).map((s) => s.width);
    const first = firstPaintWidth(sizes);
    const best = pickWidth(sizes, this.cap);
    const urlFor = (w) => input.sources.find((s) => s.width === w)?.url ?? null;
    const firstUrl = urlFor(first);
    if (!firstUrl) {
      this.cb.onError?.("This photo has no image files yet.");
      return;
    }
    let img;
    try {
      img = await loadImage(firstUrl);
    } catch (e) {
      if (token === this.loadToken) this.cb.onError?.(e.message);
      return;
    }
    if (token !== this.loadToken || this.disposed) return;
    this.retireCurrent();
    this.build(input);
    this.shown = img;
    this.setTexture(img);
    this.setHotspots(input.hotspots);
    this.layers.minimap.hidden = !(this.settings.minimap && !this.isFlat);
    if (opts.initialView) {
      Object.assign(this.view, opts.initialView);
      this.anim.active = false;
      this.planetD = 0;
    } else if (opts.reveal && !this.renderer.xr.isPresenting) this.reveal();
    else {
      Object.assign(this.view, this.start);
      this.planetD = 0;
    }
    this.cb.onLoaded?.({ width: first, final: best === first });
    const bestUrl = urlFor(best);
    if (best && best !== first && bestUrl) {
      try {
        const big = await loadImage(bestUrl);
        await big.decode().catch(() => {
        });
        if (token !== this.loadToken || this.disposed) return;
        this.shown = big;
        if (this.blurs) this.applyBlurPreview();
        else this.setTexture(big);
        this.cb.onLoaded?.({ width: best, final: true });
      } catch {
      }
    }
  }
  /* -------------------------------------------- curation: blur preview */
  /** Load the untouched original so blur edits preview truthfully (the public
   *  files already have the saved blurs baked in). */
  async useOriginal(url) {
    const img = await loadImage(url);
    if (this.disposed) return;
    this.bakeSource = img;
    if (this.blurs) this.applyBlurPreview();
  }
  setBlurPreview(blurs) {
    this.blurs = blurs;
    if (!blurs) {
      if (this.shown) this.setTexture(this.shown);
      return;
    }
    this.applyBlurPreview();
  }
  bakeTimer = null;
  applyBlurPreview() {
    if (this.bakeTimer) clearTimeout(this.bakeTimer);
    this.bakeTimer = setTimeout(() => {
      const src = this.bakeSource ?? this.shown;
      if (!src || !this.blurs) return;
      const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
      const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
      const k = Math.min(1, 4096 / sw);
      this.setTexture(bakeTo(src, Math.round(sw * k), Math.round(sh * k), this.blurs));
    }, 90);
  }
  /** The image currently shown (with any blur preview), for rendering a thumbnail. */
  thumbSource() {
    return this.texture?.image ?? this.shown;
  }
  /* --------------------------------------------------------- view */
  currentView() {
    const fwd = new this.THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    return {
      yaw: wrap180(deg2(Math.atan2(fwd.x, -fwd.z))),
      pitch: deg2(Math.asin(clamp(fwd.y, -1, 1))),
      fov: this.camera.fov
    };
  }
  setStart(v) {
    this.start = { ...v };
  }
  applyView() {
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
  flyTo(to, dur = 1400) {
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
  /** The opening: fly in, little planet, spin, or straight there. */
  reveal() {
    const s = this.start;
    this.planetD = 0;
    if (this.reducedMotion || this.settings.opening === "none") {
      Object.assign(this.view, s);
      this.anim.active = false;
      return;
    }
    if (this.settings.opening === "planet" && !this.isFlat) {
      const from = { yaw: s.yaw + 60, pitch: -89.9, fov: PLANET_FOV };
      Object.assign(this.view, from);
      this.planetD = 1;
      this.anim = {
        active: true,
        t0: performance.now(),
        dur: 3e3,
        from: { ...from },
        to: { ...s, yaw: from.yaw + wrap180(s.yaw - from.yaw) },
        planet: { from: 1, to: 0 },
        ease: easeInOut
      };
      return;
    }
    if (this.settings.opening === "spin" && !this.isFlat) {
      const from = { yaw: s.yaw - 330, pitch: s.pitch - 4, fov: Math.min(FOV_MAX, s.fov + 20) };
      Object.assign(this.view, from);
      this.anim = { active: true, t0: performance.now(), dur: 3600, from: { ...from }, to: { ...s }, ease: easeInOut };
      return;
    }
    Object.assign(this.view, { yaw: s.yaw - 10, pitch: s.pitch + 3, fov: Math.max(35, s.fov * 0.8) });
    this.flyTo({ ...s }, 1600);
  }
  setFov(f) {
    this.view.fov = clamp(f, FOV_MIN, FOV_MAX);
  }
  zoom(delta) {
    this.touched();
    this.setFov(this.view.fov + delta);
  }
  /** Slow turning when left alone. Defaults: 1.5°/s after 3 s idle; a tour wants faster and sooner. */
  setAutoRotate(on, opts = {}) {
    this.autoRotate = on;
    this.rotateSpeed = opts.speed ?? 1.5;
    this.rotateIdleMs = opts.idleMs ?? 3e3;
    if (on && this.gyro.on) this.stopSensors(true);
  }
  touched() {
    this.lastInteraction = performance.now();
    if (this.anim.active) {
      this.anim.active = false;
      this.anim.planet = void 0;
      if (this.planetD > 0) {
        this.planetD = 0;
        this.view.fov = clamp(this.view.fov, FOV_MIN, FOV_MAX);
        this.view.pitch = clamp(this.view.pitch, -89, 89);
      }
    }
    this.cb.onInteract?.();
  }
  tick(now) {
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
      a.planet = void 0;
      a.ease = void 0;
      this.view.yaw = wrap180(this.view.yaw);
      this.planetD = 0;
    }
  }
  lastT = performance.now();
  frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1e3);
    this.lastT = now;
    if (!this.renderer.xr.isPresenting) {
      this.tick(now);
      if (this.autoRotate && !this.isFlat && !this.gyro.on && !this.anim.active && !this.mmDrag && !this.pointers.size && now - this.lastInteraction > this.rotateIdleMs && !this.reducedMotion) {
        this.view.yaw = wrap180(this.view.yaw + this.rotateSpeed * dt);
      }
      if (this.gyro.on && this.gyro.have) {
        this.camera.position.set(0, 0, 0);
        this.applyGyro();
      } else this.applyView();
      this.drawMinimapBox();
      this.placePins();
    }
    if (this.outgoing) {
      const k = Math.min(1, (now - this.outgoing.t0) / CROSSFADE_MS);
      const m = this.mesh?.material;
      if (m) m.opacity = k;
      if (k >= 1) this.finishCrossfade();
    }
    if (this.planetD > 5e-4 && !this.renderer.xr.isPresenting && !this.isFlat && this.texture && this.input) this.renderPlanet();
    else this.renderer.render(this.scene, this.camera);
  };
  renderPlanet() {
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
          diskCos: { value: 1 },
          diskR: { value: 0 }
        },
        vertexShader: PLANET_VERT,
        fragmentShader: PLANET_FRAG,
        depthTest: false,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.planet = { scene, mesh, mat };
    }
    const g = sphereParams(this.input);
    const u = this.planet.mat.uniforms;
    u.map.value = this.texture;
    u.crop.value.set(g.cropL / g.fullW, g.cropT / g.fullH, g.cropW / g.fullW, g.cropH / g.fullH);
    u.d.value = this.planetD;
    this.camera.updateMatrixWorld();
    u.rot.value.setFromMatrix4(this.camera.matrixWorld);
    u.tanHalf.value = Math.tan(rad2(this.view.fov) / 2);
    u.aspect.value = this.camera.aspect;
    const th = rad2(this.settings.nadirDeg);
    u.diskOn.value = this.disk && this.diskTex ? 1 : 0;
    u.disk.value = this.diskTex;
    u.diskCos.value = Math.cos(th);
    u.diskR.value = Math.sin(th) * 1.02;
    this.renderer.render(this.planet.scene, this.camera);
  }
  /* ---------------------------------------------- pointer and keys */
  bindPointer() {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.addEventListener("pointerdown", (e) => {
      this.touched();
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      c.style.cursor = "grabbing";
      if (this.pointers.size === 1) {
        this.downAt = { x: e.clientX, y: e.clientY };
        this.moved = 0;
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.touched();
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 1) {
        const k = 0.12 * (this.view.fov / 75);
        if (this.gyro.on) this.gyro.headingOffset += rad2(dx * k);
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
    const end = (e) => {
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
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.touched();
      this.setFov(this.view.fov + e.deltaY * 0.03);
    }, { passive: false });
    c.style.cursor = "grab";
  }
  onKey = (e) => {
    const t = e.target;
    if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
    const step = e.shiftKey ? 15 : 5;
    switch (e.key) {
      case "ArrowLeft":
        this.view.yaw = wrap180(this.view.yaw - step);
        break;
      case "ArrowRight":
        this.view.yaw = wrap180(this.view.yaw + step);
        break;
      case "ArrowUp":
        this.view.pitch = clamp(this.view.pitch + step, -89, 89);
        break;
      case "ArrowDown":
        this.view.pitch = clamp(this.view.pitch - step, -89, 89);
        break;
      case "+":
      case "=":
        this.setFov(this.view.fov - 5);
        break;
      case "-":
        this.setFov(this.view.fov + 5);
        break;
      default:
        return;
    }
    e.preventDefault();
    this.touched();
    if (this.gyro.on) this.stopSensors(true);
  };
  ndc(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return new this.THREE.Vector2((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }
  dirAt(cx, cy) {
    this.raycaster.setFromCamera(this.ndc(cx, cy), this.camera);
    const d = this.raycaster.ray.direction;
    return { yaw: wrap180(deg2(Math.atan2(d.x, -d.z))), pitch: deg2(Math.asin(clamp(d.y, -1, 1))) };
  }
  uvAt(cx, cy) {
    if (!this.mesh) return null;
    this.raycaster.setFromCamera(this.ndc(cx, cy), this.camera);
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    return hit?.uv ? { u: hit.uv.x, v: 1 - hit.uv.y } : null;
  }
  /* ---------------------------------------------------- label pins */
  setHotspots(list) {
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
  viewFor(h, fov = 60) {
    if (!("u" in h)) return { yaw: h.yaw, pitch: h.pitch, fov };
    const pp = this.mesh?.geometry?.parameters;
    if (!pp) return { ...this.view };
    const x = (h.u - 0.5) * pp.width, y = (0.5 - h.v) * pp.height;
    return { yaw: deg2(Math.atan2(x, FLAT_D)), pitch: deg2(Math.atan2(y, Math.hypot(x, FLAT_D))), fov };
  }
  placePins() {
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
        const pp = this.mesh?.geometry?.parameters;
        if (!this.isFlat || !pp || !this.mesh) {
          pin.dataset.state = "hidden";
          return;
        }
        v.set((h.u - 0.5) * pp.width, (0.5 - h.v) * pp.height, 0);
        this.mesh.localToWorld(v);
        v.project(this.camera);
      } else {
        v.copy(lookDir(this.THREE, h.yaw, h.pitch)).multiplyScalar(100).add(this.camera.position).project(this.camera);
      }
      if (v.z > 1 || v.z < -1 || this.renderer.xr.isPresenting) {
        pin.dataset.state = "hidden";
        return;
      }
      const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      pin.style.left = `${sx}px`;
      pin.style.top = `${sy}px`;
      pin.dataset.state = sx < 0 || sx > W || sy < 0 || sy > H ? "far" : "shown";
    });
  }
  /* ------------------------------------------------------ minimap */
  drawMinimapBase(src) {
    const c = this.layers.mmBase, ctx = c.getContext("2d");
    if (!ctx || !this.input) return;
    const W = c.width, H = c.height, g = sphereParams(this.input);
    ctx.fillStyle = "#0a0710";
    ctx.fillRect(0, 0, W, H);
    try {
      ctx.drawImage(src, g.cropL / g.fullW * W, g.cropT / g.fullH * H, g.cropW / g.fullW * W, g.cropH / g.fullH * H);
    } catch {
    }
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
  }
  drawMinimapBox() {
    const c = this.layers.mmBox, ctx = c.getContext("2d");
    if (!ctx) return;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (this.renderer.xr.isPresenting || !this.settings.minimap || this.isFlat) return;
    const v = this.currentView(), vf = this.camera.fov;
    const hf = deg2(2 * Math.atan(Math.tan(rad2(vf) / 2) * this.camera.aspect));
    const bw = Math.min(W, hf / 360 * W), bh = Math.min(H, vf / 180 * H);
    const cx = (v.yaw + 180) / 360 * W, cy = (90 - v.pitch) / 180 * H;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,0,0,.6)";
    ctx.shadowBlur = 4;
    for (const off of [-W, 0, W]) ctx.strokeRect(cx - bw / 2 + off, cy - bh / 2, bw, bh);
    ctx.shadowBlur = 0;
    const sx = (this.start.yaw + 180) / 360 * W, sy = (90 - this.start.pitch) / 180 * H;
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
  bindMinimap() {
    const mm = this.layers.minimap;
    const look = (e) => {
      const r = mm.getBoundingClientRect();
      const u = clamp((e.clientX - r.left) / r.width, 0, 1), v = clamp((e.clientY - r.top) / r.height, 0, 1);
      if (this.gyro.on) this.stopSensors(true);
      this.anim.active = false;
      this.view.yaw = wrap180(u * 360 - 180);
      this.view.pitch = clamp(90 - v * 180, -89, 89);
      this.touched();
    };
    mm.addEventListener("pointerdown", (e) => {
      this.mmDrag = true;
      try {
        mm.setPointerCapture(e.pointerId);
      } catch {
      }
      look(e);
    });
    mm.addEventListener("pointermove", (e) => {
      if (this.mmDrag) look(e);
    });
    mm.addEventListener("pointerup", () => {
      this.mmDrag = false;
    });
    mm.addEventListener("pointercancel", () => {
      this.mmDrag = false;
    });
  }
  /* ---------------------------------------------------- nadir disk */
  updateDisk() {
    const THREE = this.THREE;
    if (this.disk) {
      this.scene.remove(this.disk);
      this.disk.geometry.dispose();
      this.disk.material.dispose();
      this.disk = null;
    }
    if (this.settings.nadir !== "disk") return;
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const x = c.getContext("2d");
    x.translate(256, 256);
    const ring = x.createRadialGradient(0, 0, 150, 0, 0, 256);
    ring.addColorStop(0, "rgba(10,6,18,1)");
    ring.addColorStop(0.86, "rgba(10,6,18,1)");
    ring.addColorStop(1, "rgba(10,6,18,0)");
    x.fillStyle = ring;
    x.beginPath();
    x.arc(0, 0, 256, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = this.accent;
    x.lineWidth = 6;
    x.beginPath();
    x.arc(0, 0, 178, 0, Math.PI * 2);
    x.stroke();
    x.lineWidth = 2;
    x.strokeStyle = this.accent;
    x.globalAlpha = 0.5;
    x.beginPath();
    x.arc(0, 0, 150, 0, Math.PI * 2);
    x.stroke();
    for (let i = 0; i < 36; i++) {
      const a = i * Math.PI / 18, r1 = i % 9 === 0 ? 120 : 138;
      x.beginPath();
      x.moveTo(Math.sin(a) * r1, -Math.cos(a) * r1);
      x.lineTo(Math.sin(a) * 150, -Math.cos(a) * 150);
      x.stroke();
    }
    x.globalAlpha = 1;
    if (this.badge) {
      x.fillStyle = "#f5f3ff";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.font = "700 54px system-ui, sans-serif";
      x.fillText(this.badge.title, 0, this.badge.subtitle ? -14 : 0);
      if (this.badge.subtitle) {
        x.font = "500 30px system-ui, sans-serif";
        x.fillStyle = this.accent;
        x.fillText(this.badge.subtitle, 0, 34);
      }
    }
    this.diskTex?.dispose();
    this.diskTex = new THREE.Texture(c);
    this.diskTex.colorSpace = THREE.SRGBColorSpace;
    this.diskTex.needsUpdate = true;
    const th = rad2(this.settings.nadirDeg);
    this.disk = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS * Math.sin(th) * 1.02, 64),
      new THREE.MeshBasicMaterial({ map: this.diskTex, transparent: true })
    );
    this.disk.rotation.x = -Math.PI / 2;
    this.disk.position.y = -RADIUS * Math.cos(th);
    this.disk.visible = !this.isFlat;
    this.scene.add(this.disk);
  }
  /* ------------------------------------------------------ sensors */
  static sensorsAvailable() {
    const touchy = navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches;
    return touchy && (typeof DeviceOrientationEvent !== "undefined" || "RelativeOrientationSensor" in window);
  }
  emitSensors() {
    this.cb.onSensors?.({ on: this.gyro.on, live: this.gyro.have, path: this.gyro.path });
  }
  applyGyro() {
    const THREE = this.THREE;
    this.camera.quaternion.copy(this.gyro.q);
    this.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.gyro.headingOffset));
    if (this.camera.fov !== this.view.fov) {
      this.camera.fov = this.view.fov;
      this.camera.updateProjectionMatrix();
    }
  }
  firstSample() {
    this.gyro.have = true;
    clearTimeout(this.gyro.watchdog);
    this.gyro.headingOffset = 0;
    this.applyGyro();
    this.gyro.headingOffset = rad2(wrap180(this.currentView().yaw - this.gyro.wantYaw));
    this.emitSensors();
  }
  onOrientation = (e) => {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const THREE = this.THREE;
    this.gyro.count++;
    const euler = new THREE.Euler(rad2(e.beta), rad2(e.alpha), -rad2(e.gamma), "YXZ");
    const W = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    const screenAngle = rad2(screen.orientation?.angle ?? window.orientation ?? 0);
    this.gyro.q.setFromEuler(euler).multiply(W).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenAngle));
    if (!this.gyro.have) this.firstSample();
  };
  startGenericSensor() {
    const Ctor = window.RelativeOrientationSensor;
    if (!Ctor) return false;
    try {
      const W = new this.THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      const s = new Ctor({ frequency: 60, referenceFrame: "screen" });
      s.addEventListener("reading", () => {
        const q = s.quaternion;
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
  async startSensors() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      try {
        if (await DOE.requestPermission() !== "granted") {
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
        "warn"
      );
    }, 2e3);
    try {
      this.wakeLock = await navigator.wakeLock?.request("screen");
    } catch {
    }
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
      try {
        this.gyro.sensor.stop();
      } catch {
      }
      this.gyro.sensor = null;
    }
    this.wakeLock?.release?.();
    this.wakeLock = null;
    if (was || !quiet) this.emitSensors();
  }
  /* ---------------------------------------------------------- VR */
  static async vrSupported() {
    try {
      return !!await navigator.xr?.isSessionSupported("immersive-vr");
    } catch {
      return false;
    }
  }
  onSessionGranted = () => {
    if (!this.xrSession) this.enterVR();
  };
  async enterVR() {
    if (this.xrSession) {
      await this.xrSession.end();
      return;
    }
    try {
      const s = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
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
    } catch (e) {
      this.cb.onToast?.(`Could not start VR: ${e?.message ?? e}`, "err");
    }
  }
  get presentingVR() {
    return this.renderer.xr.isPresenting;
  }
};

// demo/demo.ts
var THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js";
var $ = (id) => document.getElementById(id);
function testSphere(w = 4096, h = 2048, tint = "#1e3a8a") {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, tint);
  g.addColorStop(0.5, "#0f172a");
  g.addColorStop(1, "#3f2a14");
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  x.strokeStyle = "rgba(255,255,255,.35)";
  x.lineWidth = 2;
  for (let yaw = -180; yaw <= 180; yaw += 30) {
    const px = (yaw + 180) / 360 * w;
    x.beginPath();
    x.moveTo(px, 0);
    x.lineTo(px, h);
    x.stroke();
  }
  for (let p = -60; p <= 60; p += 30) {
    const py = (90 - p) / 180 * h;
    x.beginPath();
    x.moveTo(0, py);
    x.lineTo(w, py);
    x.stroke();
  }
  x.fillStyle = "#fff";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = "700 90px system-ui, sans-serif";
  for (const [label, yaw] of [["N \xB7 yaw 0", 0], ["E \xB7 yaw 90", 90], ["S \xB7 yaw 180", 180], ["W \xB7 yaw -90", -90]]) {
    x.fillText(label, (yaw + 180) / 360 * w, h / 2);
  }
  x.font = "500 48px system-ui, sans-serif";
  x.fillText("pitch +60", w / 2, (90 - 60) / 180 * h);
  x.fillText("pitch -60", w / 2, (90 + 60) / 180 * h);
  return c.toDataURL("image/jpeg", 0.9);
}
var hotspots = [
  { yaw: 90, pitch: 10, text: "East label" },
  { yaw: -45, pitch: -20, text: "South-west, low" }
];
async function main() {
  const THREE = await loadThree(THREE_URL);
  const status = $("status");
  const engine = new PanoEngine(
    THREE,
    $("c"),
    { pins: $("pins"), minimap: $("mm"), mmBase: $("mmBase"), mmBox: $("mmBox") },
    {
      onLoaded: (i) => {
        status.textContent = `loaded ${i.width}px${i.final ? " (final)" : ""}`;
      },
      onTap: (at) => {
        status.textContent = `tap ${JSON.stringify(at)}`;
      },
      onError: (m) => {
        status.textContent = `error: ${m}`;
      },
      onToast: (m) => {
        status.textContent = m;
      }
    },
    { badge: { title: "pano-kit", subtitle: "demo" } }
  );
  engine.setSettings({ ...DEFAULT_VIEWER_SETTINGS, nadir: "disk" });
  const url = testSphere();
  const input = {
    sources: [{ width: 4096, url }],
    srcW: 4096,
    srcH: 2048,
    resolvedKind: "pano",
    gpano: null,
    start: { yaw: 0, pitch: 0, fov: 75 },
    hotspots
  };
  await engine.open(input, { reveal: true });
  $("start").onclick = () => engine.toStart();
  $("planet").onclick = () => {
    engine.setSettings({ ...DEFAULT_VIEWER_SETTINGS, opening: "planet", nadir: "disk" });
    engine.reveal();
  };
  $("spin").onclick = () => {
    engine.setSettings({ ...DEFAULT_VIEWER_SETTINGS, opening: "spin", nadir: "disk" });
    engine.reveal();
  };
  const other = { ...input, sources: [{ width: 4096, url: testSphere(4096, 2048, "#7c2d12") }], hotspots: [] };
  let flip = false;
  $("next").onclick = () => {
    flip = !flip;
    void engine.open(flip ? other : input, { reveal: true });
  };
  $("thumb").onclick = async () => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const blob = await renderStartThumb(THREE, img, input, engine.currentView(), 600, 375);
    $("thumbOut").src = URL.createObjectURL(blob);
    status.textContent = `thumbnail ${blob.size} bytes`;
  };
  window.engine = engine;
}
main().catch((e) => {
  $("status").textContent = `failed: ${e?.message ?? e}`;
});
