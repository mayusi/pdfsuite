# PDFSuite

**Every PDF tool you'd pay Smallpdf $12/month for — free, open source, zero dependencies, and 100% on your own device.**

👉 **Live app:** https://mayusi.github.io/pdfsuite/ · works offline once visited, installable as an app, or [download the whole thing as one HTML file](https://mayusi.github.io/pdfsuite/pdfsuite.html)

## Why

Smallpdf charges **$12/month** ($144/yr), iLovePDF **$9/month**. For that money they let you *upload your private documents to their servers* so they can merge, split and sign them — work your own browser can do locally.

| | Smallpdf / iLovePDF | PDFSuite |
|---|---|---|
| Price | $108–144 per year | **$0, forever** |
| Your files | Uploaded to their servers | **Never leave your device** |
| Account | Required past the free tier | **Never** |
| Limits | 2 tasks/day on free plans | **Unlimited** |
| Works offline | No | **Yes** (PWA, or a single HTML file) |
| Dependencies | Who knows | **Zero — read the whole source** |

Open devtools → Network: nothing carrying your document ever leaves the page. There is no server.

## Tools

**Edit & sign**
- **Edit PDF** — a full-screen editor: **change existing text** (click it and retype; the original is removed, the font matched), add text with fonts/sizes/styles/alignment, letter spacing, line height, outline and shadow; freehand drawing with pen pressure and an **eraser** that cuts strokes; text highlighting that snaps to lines; rectangles, ellipses, triangles, stars, polygons, lines and arrows with separate fill opacity; whiteout, signatures, check/cross/date marks, stamps, sticky-note comments and links.
  - **Image editing, built in** — for pictures you add *and* pictures already inside the PDF (click one to edit, save or delete it): crop with aspect presets, flip, free rotation, 11 one-tap filters, brightness/contrast/exposure/saturation/warmth/tint/hue, blur, sharpen, vignette, grain, **background removal**, rounded corners, borders, drop shadows, opacity and blend modes. The preview and the saved file run the same pixel pipeline, so what you see is what you get.
  - **Objects** — rotate anything with its handle (Shift = 15° steps), snapping guides to page edges, centres and other objects, multi-select (Shift-click or drag a box) with align and distribute, a **Layers** panel to reorder, hide, lock and rename, bring forward / send backward.
  - **Download as you like** — PDF (all pages, this page or a range; flattened forms optional) or **PNG / JPG images** at screen-to-print resolution, several pages zipped.
  - Continuous page scroll, page thumbnails with reorder/rotate/insert/delete, undo/redo, copy/paste, keyboard shortcuts. **Phones and tablets**: bottom tool bar and sheet on phones, a slide-over panel on iPad, pinch-zoom with two-finger pan, long-press menus, big touch handles, and Apple Pencil palm rejection (once the pencil draws, fingers scroll).
- **Sign PDF** — draw, type or upload a signature (paper background removed automatically), saved on your device for next time; click a signature field to sign into it.
- **Fill forms** — real inputs over the PDF's text fields, checkboxes, radio buttons and dropdowns; values get proper appearance streams so every viewer shows them; optional flattening.
- **Redact** — *true* redaction: glyphs under the boxes are removed from the content stream (the rest of the line keeps its position), image pixels underneath are painted out and re-encoded, links and comments go. **Search & redact** finds words, emails, phone numbers or long numbers on every page.
- **Watermark** — text or logo, font/size/colour/opacity/angle, centred or tiled, over or under the content, chosen pages; exact live preview.
- **Page numbers** — six positions, formats like “Page 1 of 9” or custom `{n}`/`{t}`, start value, skip cover, mirrored margins for printing; exact live preview.

**Organize**
- **Merge** — any number of PDFs, drag to order, optional page ranges per file, one bookmark per file (its own bookmarks nested inside), form fields kept and de-duplicated.
- **Split** — pick pages visually, custom ranges, every N pages, or one file per page (ZIP).
- **Organize pages** — drag to reorder, rotate, duplicate, delete, insert blank pages or pages from another PDF, multi-select with bulk actions, undo/redo.
- **Rotate** — click pages or rotate all/odd/even.
- **Crop** — drag a crop box over the page or auto-detect the content margins; apply to all, one, odd or even pages (rotated pages handled).

**Convert**
- **Images → PDF** — JPG/PNG/WebP/GIF/BMP; JPEGs embedded losslessly with their EXIF orientation honoured, PNG transparency kept; page size, orientation, margins, fit.
- **PDF → images** — PNG or JPG at 72–600 DPI.
- **PDF → text** — reading-order text with ligatures and smart quotes decoded; optional paragraph re-flow.
- **Extract images** — embedded photos exactly as stored, duplicates collapsed.

**Optimize & protect**
- **Compress** — lossless repack or photo re-encoding with downscaling; identical fonts/images across merged files are stored once; shows before/after.
- **Protect** — AES-256 (or AES-128 / RC4 for very old readers), owner password, print/copy/edit/comment/form permissions.
- **Unlock** — RC4, AES-128 and AES-256 (R2–R6) with the open or owner password. Every other tool also asks for the password when you give it a protected file.
- **Metadata & privacy** — see what's hidden (author, software, dates, XMP, document ID, comments), edit the properties, or wipe it all while keeping pages, links, bookmarks and form fields.

Results can be handed straight to the next tool (“Continue with Compress →”) without re-uploading anything.

## What's inside

All hand-written, no libraries:

- `src/pdf/parse.js` / `write.js` — scan-based parser (damaged and linearized files parse the same) and serializer.
- `src/pdf/filters.js` — Flate, LZW, ASCII85, ASCIIHex, RunLength, PNG/TIFF predictors.
- `src/pdf/crypto.js` / `security.js` — MD5, RC4, AES-128/256, SHA-256/384/512 and the Standard security handler (R2–R6).
- `src/pdf/content.js` — content-stream interpreter: graphics + text state, colour spaces (ICC, Indexed, Lab, Separation/DeviceN, patterns), shadings, inline images, form XObjects, annotation appearances, per-glyph positions.
- `src/pdf/render.js` — canvas renderer: glyph-exact placement with matched system fonts, images through their full matrix, soft masks, gradients, blend modes.
- `src/pdf/image.js` / `functions.js` — image decoding for every colour space and bit depth; PDF function types 0/2/3/4.
- `src/pdf/redact.js` — content rewriting for redaction and in-place text editing; glyph-accurate text search.
- `src/pdf/stamp.js` — page numbers, watermarks and the editor's export (standard-14 font metrics in `metrics.js`).
- `src/pdf/forms.js`, `outline.js`, `ops.js` — forms, bookmarks, page assembly, compression, images.
- `src/ui/`, `src/editor/`, `src/tools/` — the interface: a small design system, the editor, one module per tool.

Known limits, honestly: embedded fonts are drawn with matching system fonts in previews (the PDF itself is untouched); JBIG2/CCITT and JPEG 2000 images don't preview; editing text matches the original font with Helvetica/Times/Courier (text the standard fonts can't encode, like CJK or emoji, is added as a crisp image); scanned PDFs have no text to edit or search (no OCR).

## Develop

```bash
npm run dev     # zero-dependency static server → http://localhost:5199/
npm test        # node --test — 124 tests, nothing to install
npm run build   # dist/ + pdfsuite.html (single file) + sw.js / manifest / icons
```

Requires only Node ≥ 18. There is no `npm install` — there are no dependencies.

## License

MIT. Use it, fork it, sell it if you can — the point is nobody should have to.
