# pano-kit

The reusable half of a 360° photo gallery: a three.js viewer engine, blur
baking, derivative making, and S3-compatible upload signing. No framework, no
database, no API of its own. An app supplies those; this supplies everything
that is the same from one app to the next.

First used by neaves.au `/360`. Ported from `pano-test-rig.html` and its brief.

## Modules

| Import | Runs in | What it does | Needs |
|---|---|---|---|
| `core` | anywhere | Dated folders (`parseFolder`: `DD_MM_YYYY_place` into a date and label), views and `#view=` links, panorama-or-flat, location parsing (typed coordinates and every shape of Google Maps link), outbound map links, the derivative ladder, texture limits, blur-cap geometry, gallery ordering and day grouping, slugs, storage keys | nothing |
| `bake` | browser | Blur regions painted into a copy of a photo: exact spherical caps on equirects, circles on flat photos | DOM canvas |
| `engine` | browser | `PanoEngine`: drag, pinch, wheel, keys; phone sensors with a watchdog; WebXR VR (trigger next, grip previous); partial spheres from GPano; flat photos as a virtual print; openings (fly in; a true stereographic little planet that unfolds into the view; a 330° spin; none); crossfade between photos; auto-rotate at any speed; label pins; minimap; nadir disk; progressive textures; `renderStartThumb` | three.js r186, loaded by URL |
| `derive` | browser | `fingerprint` (SHA-256), `readPhotoMeta` (EXIF date and camera, GPS, GPano), `makeRungs` (each size, blurs baked), `mapStrip`, `putSigned` (PUT with progress) | `exifreader` |
| `s3` | server | `presign` (short-lived PUT/GET), `deleteObject`, `objectUrl`, `publicUrl`, `regionFromEndpoint` | `aws4fetch` |

## Using it

Not published to npm. Vendor `src/` into the app (neaves.au keeps it at
`shared/pano-kit/`), byte-identical, and never edit it there: change it here,
run the tests, copy it back, and `diff -r` to confirm.

```sh
npm install --legacy-peer-deps   # plain install trips an npm peer-resolver bug
npm run check                    # tsc, strict
npm test                         # vitest
```

### three.js

The engine never imports three; it is handed the module. Serve r186 however
suits the app and pass its URL:

```ts
import { loadThree, PanoEngine } from "./pano-kit/engine";
const THREE = await loadThree("/vendor/three/0.186.1/three.module.min.js");
const engine = new PanoEngine(THREE, canvas, { pins, minimap, mmBase, mmBox }, {
  onTap: at => { /* {yaw, pitch} or, on a flat photo, {u, v} */ },
  onStep: d => { /* VR trigger +1, grip -1 */ },
}, { accent: "#e879f9", badge: { title: "neaves.au", subtitle: "360" } });
await engine.open({ sources, srcW, srcH, resolvedKind, gpano, start, hotspots }, { reveal: true });
```

`pins` is an empty element over the canvas (label buttons are added to it,
class `pano-pin`, with `data-state` of `shown`, `far` or `hidden`); `minimap`
holds the two 560×280 canvases `mmBase` and `mmBox`.

Types come from `@types/three@0.186.0` as type-only imports.

### Uploading straight to a bucket

The server signs, the browser uploads, the server never holds the bytes:

```ts
// server
const url = await presign(cfg, "PUT", key);          // 15 minutes, this key, this method
// browser
await putSigned(url, blob, "image/jpeg", n => setProgress(n / blob.size));
```

The bucket must allow the app's origin in its CORS rules, for `PUT` (uploads),
`GET` (WebGL refuses cross-origin textures without CORS headers) and `HEAD`.

**Backblaze B2.** Region comes from the S3 endpoint (`regionFromEndpoint`); a
wrong region fails every request with an unhelpful signature error. B2's CORS
rules name operations rather than methods; a working shape:

```json
[{
  "corsRuleName": "site",
  "allowedOrigins": ["https://neaves.au"],
  "allowedOperations": ["s3_put", "s3_get", "s3_head", "b2_download_file_by_name"],
  "allowedHeaders": ["content-type"],
  "exposeHeaders": ["etag"],
  "maxAgeSeconds": 3600
}]
```

`b2_download_file_by_name` is the one that covers public reads through the
`https://f00N.backblazeb2.com/file/<bucket>/…` URLs.

**Cloudflare R2.** Region `auto`; CORS with `AllowedMethods: PUT, GET, HEAD`.

**A far-away bucket and Node 20+.** Node tries each of a host's addresses for
only 250 ms. A server in Australia takes ~350 ms to connect to a European
bucket, so Node drops the address that works and `fetch` fails with
`ETIMEDOUT` (`err.cause`), while `curl` from the same box succeeds. Give the
app longer at startup:

```ts
import net from "net";
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
```

## Decisions, so they are not re-argued

- three.js directly, not Photo Sphere Viewer (no WebXR), A-Frame (global scene,
  poor React unmount) or Pannellum/Marzipano (no WebXR, unmaintained).
- The start view is the curator's choice, never an algorithm's, and thumbnails
  are rendered from it, so a card shows exactly the frame a visitor lands on.
- Blurs are baked into published files, never applied at view time.
- 8192 is the texture ceiling (some Adreno GPUs report 16384 and fail), 4096 on
  `deviceMemory <= 4`.
- Panorama means 2:1 within 5%, as the brief says (the rig's code allowed 2.5%).
- Map links go by coordinates, never by name.

## Not verified on hardware

The engine was ported from the rig, where sensors and VR were tested with
synthetic events only. Confirm on a real phone: the Generic Sensor quaternion
convention, the no-jump handoff into sensor mode, and the direction of the
drag-to-nudge-heading. On a Quest 3: 8192 against 4096 textures for judder in VR.
