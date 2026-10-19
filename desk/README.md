# pano-desk

A local 360 viewer and editor on pano-kit, for the step before a gallery:
going through a trip's photos, fixing them, and deciding how each one opens.

- **Browse** trip folders (`DD_MM_YYYY_place`, sorted by date), with a strip of
  the 360 shots in each. Flat photos are left out. Badges show which have a saved
  edit, a PhotoCraft export, or saved settings.
- **Adjust**: exposure, contrast, a tone curve (highlights, lights, darks, shadows),
  whites and blacks, temperature and tint, vibrance and saturation. Every
  slider is pano-kit `grade`, one pixel at a time, so the seam where the 360
  wraps cannot show. Copy and paste a grade between photos, or keep up to three
  named presets (pick one in the dropdown, then Load or Save); they are stored in
  `presets.json` in the app's data folder (`%LOCALAPPDATA%\pano-desk`), not the browser.
- **Blur**: click what to hide (a face, a plate, the hand on the stick). The blur
  is baked into the saved file with pano-kit `bake`, the same code a gallery
  publishes with.
- **View**: the start view, labels, and a preview of the gallery's bottom cover.
- **Info**: name, place, map location (coordinates or a Google Maps link), description,
  tags, rating and a read-more link: what a gallery shows beside the photo.
- **Overlay** (then and now): set an old flat photo into the 360 where it was taken. With the
  tab open, drag the photo to move it (it stays in true perspective: it is drawn as
  the camera that took it would have seen it), scroll on it to size it, Shift+scroll
  to turn it; sliders for size, turn, opacity, soft edge and position. PNG cut-outs
  keep their transparency. It is baked into the saved file with pano-kit `overlay`
  and `bake`, the same pinhole mapping as a hand-run `pano_blend.py`.
- **PhotoCraft**: open the photo in PhotoCraft, and with Live on, see PhotoCraft's
  picture in 360 a moment after each pause in editing.
- **Before**: hold the button, or hold `\`, to see it without your sliders and blurs.
  `[` and `]` step through the folder.

## Files it writes

Beside the original, which is only ever read:

| File | What |
|---|---|
| `edited\Edited_<name>.jpg` | In an `edited` folder beside the originals (made when first needed, and hidden from the folder list). Your edit baked in at full size, JPEG quality 95, with the original's EXIF and GPano metadata copied on (pano-kit `jpeg`), so other 360 viewers still see a 360, and the Info tab's details written in (XMP title, description, keywords, rating, place; EXIF GPS; start view, labels and link in `panokit:Gallery`), which neaves.au's uploader reads. With no sliders or blurs it is the original's own pixels, not re-encoded. Save settings rewrites the details into an existing copy without touching its pixels. Replacing one asks first. Copies named the old way (`<name>_edited.jpg`, before 16 Oct 2026) are still recognised as copies and never listed as originals, but are not moved. |
| `<name>.pano.json` | The recipe: base picture, grade, blurs, start view, labels, cover, and the Info tab's `place`, `location` (`{lat, lng, approx, source}`; `approx` stays true until the spot is set by hand or marked right), `title`, `description`, `tags`, `rating`, `linkUrl` and `linkLabel`, and `overlays` (each `{file, yaw, pitch, hfov, roll, opacity, feather}`). Opening the photo again restores it. |
| `<name>.overlays\` | The photos set into it, copied here when added so the recipe can name them. |

In the working folder (PhotoCraft's automation root): `<folders below the root>\<name>.jpg`,
a copy of the original for PhotoCraft to open, and `edited\Edited_<name>.jpg` beside it, what Live
exports from PhotoCraft. Thumbnails are cached under `%LOCALAPPDATA%\pano-desk`.

## Running it

```sh
npm install --legacy-peer-deps
copy desk\config.example.json desk\config.local.json   # then set your folders
npm run desk:build      # the page; again after changing desk/src
npm run desk            # opens an app window; the server stops 15 s after it closes
```

`config.local.json` is git-ignored: it holds your own paths.

| Key | |
|---|---|
| `roots` | Folders to browse. Nothing outside these (and `work`) can be read; originals must be under a root. |
| `work` | PhotoCraft's automation read/write root (`--automation-read-root`/`--automation-write-root`). |
| `port` | Default 5196. The server listens on 127.0.0.1 only. |
| `photocraft` | `cli` (photocraft-cli.exe), `port` and `tokenFile`, as PhotoCraft's own `--control` launch uses. Leave it out to hide the PhotoCraft tab. |
| `stickers` | A folder of cut-out pictures (transparent PNGs). The Overlay tab shows them; a click sets one into the 360 where you are looking, small, to drag, size and turn like a then-and-now photo. Leave it out to hide them. |
| `badge` | The nadir disk baked into every saved copy (View tab: on or off, size, turn): `owner` for its "© owner year" line, `untitled` for photos with no title yet, `accent` for its rings, `deg` for its default size (12). |
| `browser` | The app window's browser (default Edge). |
| `cache` | Where thumbnails go. |

`node desk/server.ts` runs without opening a window. `--config FILE` and
`--port N` override the defaults. Node 22.18 or later runs the server from source,
so only the page needs building.

## How the PhotoCraft round trip works

PhotoCraft's automation can only reach its own root, so **Open in PhotoCraft**
copies the original there under its trip folder's name and opens that copy
through PhotoCraft's MCP bridge. If the copy is already open, it says which tab
rather than opening a second one (PhotoCraft would).

**Live** asks PhotoCraft every 1.2 s what its front document is and how many
edits it has had. When that is this photo (matched by its path, or by its file
name if you opened the original by hand) and the edit count has stood still
for 0.7 s, it exports the document, flattened, to `edited\Edited_<name>.jpg` in the
working folder. Your layers stay in PhotoCraft. pano-desk watches the folder
and shows the new file, keeping your view. PhotoCraft has to be running from
its "(Claude)" shortcut, which starts the control port with its token.

Bridge exports use PhotoCraft's own JPEG settings; the `quality` option is
headless-only in PhotoCraft 0.7.

## Decisions

- The page does the image work and the server never decodes a photo. The
  browser already holds the decoded image, and the preview and the saved file
  must come from the same code to match.
- The preview bakes at 4096 wide, 90 ms after the last slider change. That is
  plenty to judge a grade and quick to redraw; the save is full size.
- Only this machine's own page may call the server. It checks the Host name
  (against DNS rebinding), requires an `X-Pano-Desk` header on anything that
  writes (no other site can send one without a preflight it would fail), and
  resolves every path through links before checking it is under a root.
- Labels and blurs use neaves.au's limits (blur radius 0.3° to 40°, label text
  120 characters), so a recipe can be imported there as it is.
