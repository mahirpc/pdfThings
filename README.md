# pdfThings

A private, static PDF workbench. Everything — viewing, editing, signing,
form filling, page management, OCR, and password protection — runs
entirely in the browser tab. No server, no upload, no account. It's built
to be pushed straight to **GitHub Pages** (or any static host).

## Deploy it

1. Create a new GitHub repository (or use an existing one).
2. Copy every file in this folder into the repo, preserving the structure:
   ```
   index.html
   manifest.webmanifest
   sw.js
   offline.html
   .nojekyll
   css/styles.css
   js/*.js
   icons/*.png
   ```
3. Commit and push.
4. In the repo's **Settings → Pages**, set the source to the branch/folder
   you pushed to (e.g. `main` / `/root`), save, and wait a minute or two.
5. Open the URL GitHub gives you. That's it — no build step, no `npm
   install`, nothing to compile.

`.nojekyll` is included so GitHub Pages serves the files as-is (Jekyll
otherwise ignores folders starting with an underscore and can interfere
with some file types).

### Using your own domain / a sub-path

Every asset reference in this project is a **relative path**, so it works
whether it's deployed at `https://you.github.io/` (root) or
`https://you.github.io/pdfThings/` (project sub-path). No configuration
needed either way.

### Installing it as an app

Once it's live, open it in Chrome/Edge/Android and use "Install app" (or
the install button in the Settings panel inside pdfThings itself). On
iOS/iPadOS Safari, use Share → "Add to Home Screen". After the first
visit, it keeps working offline — the service worker precaches the app
and its core libraries.

## What's actually implemented

- **Viewing** — zoom, fit-width, page thumbnails with drag-to-reorder,
  in-document text search, dark canvas mode, installable/offline PWA.
- **Editing & annotation** — free text boxes, highlight/underline/
  strikethrough (via real text selection), freehand drawing, shapes
  (rectangle/ellipse/line/arrow), image insertion, sticky notes, and
  preset stamps (Approved/Draft/Confidential/etc.), all movable, resizable,
  and rotatable, with click-to-delete and full undo/redo.
- **Signatures** — draw, type (three script styles), or upload; saved
  locally in IndexedDB for reuse across sessions; place, resize, rotate.
- **Forms** — detects a PDF's existing AcroForm fields (text, checkbox,
  radio, dropdown), renders a matching input for each, fills and
  optionally flattens them.
- **Pages** — rotate, delete, duplicate, extract, and reorder (all via a
  single index-mapped `copyPages` call, never a per-page loop, so shared
  fonts/images aren't duplicated); merge multiple PDFs (strictly
  sequential, never `Promise.all`, to bound memory); split into ranges or
  one-file-per-page; insert blank pages or pages from another PDF;
  watermarks; page numbers / running headers.
- **Scan** — build a PDF from photos of pages (upload from your library or
  capture with the camera). Each photo gets its own freeform crop (drag
  the corner handles), rotate, and brightness/contrast/grayscale
  adjustment before the pages are assembled, in order, into a new PDF —
  which can open straight in the editor or download directly. Source
  photos are downscaled on import to keep a multi-page scanning session
  light on memory.
- **OCR** — fully offline via Tesseract.js (WebAssembly), loaded only when
  you open the OCR panel. Can also bake an invisible, position-matched
  text layer onto a scanned page so it becomes selectable/searchable
  without changing how it looks.
- **Text tools** — instant, on-device word-frequency heuristics: extractive
  summarizing, keyword extraction, title suggestions, basic whitespace/
  punctuation cleanup. See "About the Text tools panel" below.
- **Security & metadata** — edit title/author/subject/keywords; password-
  protect with AES encryption and permission flags (printing, copying,
  editing, annotating); remove a password; flatten annotations
  permanently.
- **Compress on save** — every Save prompts for a compression level (No
  compression / Low / Medium / High, or a 0–100% slider). Anything above
  "No compression" re-renders each page as a JPEG at a level-derived
  resolution/quality and rebuilds the PDF from those images, which works
  on any PDF regardless of what's inside it — but means the saved copy's
  text is no longer selectable or searchable (your working copy in the
  editor is unaffected). The save toast reports the before/after size.
- **Everything stays local** — signatures, recent-files list, and settings
  live in this browser's IndexedDB. Nothing is ever sent anywhere.

## Architecture, briefly

| File | Responsibility |
|---|---|
| `js/app.js` | Document state, virtualized page rendering, panel routing, undo/redo, save/export, PWA install |
| `js/pdf-tools.js` | All pdf-lib structural operations (merge/split/rotate/encrypt/etc.) |
| `js/annotate.js` | The annotation overlay engine + signature pad + the bake-into-PDF routine |
| `js/scan.js` | Scan panel — photo crop/rotate/adjust and PDF assembly from images |
| `js/forms.js` | AcroForm field detection and filling |
| `js/ocr.js` | Tesseract.js integration |
| `js/ai.js` | The on-device text heuristics |
| `js/thumbnails.js` | Virtualized, drag-sortable page thumbnail rail |
| `js/db.js` | Tiny IndexedDB wrapper |
| `sw.js` | Offline caching |

**Memory discipline**, since everything runs client-side: page and
thumbnail canvases are cleared (`clearRect` + zeroed dimensions) the
moment they scroll out of view and re-rendered on demand; large
`Uint8Array`s are cloned rather than shared across pdf.js/pdf-lib so
neither library can detach a buffer the other still needs; merges process
files one at a time in a strict loop; undo history is capped at 15 steps
with dropped snapshots explicitly released.

## Third-party libraries (all via CDN, no build step)

- **pdf.js** 3.11.174 — rendering, text layer, search
- **pdf-lib-plus-encrypt** 1.1.0 — a maintained fork of pdf-lib. It's used
  instead of mainline pdf-lib because **mainline pdf-lib doesn't implement
  PDF password encryption at all** — this fork adds the `.encrypt()`
  method. Everything else in the app uses the same pdf-lib API either way.
  If you'd rather not depend on a smaller fork, swap the `<script>` tag in
  `index.html` for `https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js`
  — every feature keeps working except "Protect with password", which
  will show a clear "unavailable" message instead of failing silently.
- **Sortable** 1.15.7 — thumbnail drag-to-reorder
- **Tesseract.js** 5.1.1 — OCR, loaded lazily only when the OCR panel is used

## Known limitations, stated plainly

- **Annotations on structurally-rotated pages.** Annotation placement is
  computed exactly for pages at their original orientation. If you rotate
  a page 90°/180°/270° with the Pages tool and then add annotations, the
  rotation is compensated for automatically and works correctly in
  testing — but it's the one geometry path that isn't as battle-tested as
  the rest. If anything looks off, flattening annotations before rotating
  sidesteps it entirely.
- **Removing a password** works best on PDFs pdfThings itself encrypted.
  Support for arbitrary third-party encrypted PDFs depends on what the
  underlying library can decrypt; viewing such a file (rather than
  editing it) generally works fine since pdf.js handles decryption for
  display natively.
- **The Text tools panel is heuristic, not a language model.** Summaries
  and keywords are word-frequency based and run instantly with no
  download. Translation, fluent grammar rewriting, and open-ended
  "explain this" genuinely need a real model, which isn't bundled — a
  static page shipping a few hundred MB of weights by default didn't seem
  like the right tradeoff. The panel says this directly rather than
  faking output.
- **What a static site fundamentally can't do:** real-time collaboration,
  multi-user editing, accounts, cloud sync/backup, emailing a file
  directly from the app, audit logs, or enterprise digital-signature
  services (the kind backed by a trusted timestamp authority). All of
  these need a server this project intentionally doesn't have.
- Compression on re-save is whatever pdf-lib's own object-stream output
  gives you — it's not a substitute for a dedicated image-recompression
  pipeline, so gains vary a lot by file.

## Browser support notes

- Signature/recent-file persistence needs IndexedDB (all modern browsers).
- "Save" uses the File System Access API (`showSaveFilePicker`) in
  Chrome/Edge for a real save-to-disk dialog; Firefox/Safari fall back to
  a normal download automatically.
- Reopening a "Recent" file relies on the same API keeping a permitted
  file handle; browsers without it will simply prompt you to re-select
  the file rather than silently failing.
