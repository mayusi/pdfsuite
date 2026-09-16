# PDFSuite

**Every PDF tool you'd pay Smallpdf $12/mo for — free, open source, zero dependencies, 100% client-side.**

👉 **Live app:** https://mayusi.github.io/pdfsuite/

## The pitch

Smallpdf charges **$12/month** ($144/yr). iLovePDF charges **$9/month**. For that money they let you *upload your private documents to their servers* so they can merge, split, and rotate pages — operations your own browser has been able to do locally for years.

PDFSuite does the same job for **$0**:

| | Smallpdf / iLovePDF | PDFSuite |
|---|---|---|
| Price | $108–144/yr | **$0, forever** |
| Your files | Uploaded to their servers | **Never leave your machine** |
| Account | Required past limits | None, ever |
| Daily task caps | 2/day free tier | **Unlimited** |
| Dependencies | Who knows | **Zero. Read the whole source.** |
| Works offline | No | **Yes** |

Open devtools → network tab. Zero requests carrying your documents — there is no server. Open the source: ~1,500 lines of hand-written JavaScript including the **entire PDF engine** (parser, object model, writer) — no libraries, no build, no `node_modules`, no supply chain.

## What's inside (all hand-rolled)

- `src/pdf/parse.js` — scan-based PDF parser: indirect objects, dicts/arrays/strings/streams, `/ObjStm` unpacking, inherited page-tree attributes. Ignores xref tables entirely, so linearized and damaged files still parse.
- `src/pdf/write.js` — PDF serializer + xref table writer.
- `src/pdf/ops.js` — merge, extract/split, organize (reorder/rotate/delete), images→PDF (JPEG embedded via `/DCTDecode`).
- `src/zip.js` — ZIP writer (STORE + CRC32) for multi-file downloads.
- `src/ui/` + `src/tools/` — vanilla DOM views. File pickers are `<label>`-activated: the dialog opens with **zero JS involved**.

## Tools

- **Merge PDF** — combine any number of PDFs, your order, with rendered page thumbnails
- **Split PDF** — visual page picker or ranges (`1-3, 5, 8-10`), one file or a zip of separate PDFs/pages
- **Organize pages** — rendered page previews, drag-reorder, move-to-position, duplicate, rotate, delete/restore, undo (Ctrl+Z), extract selected
- **Images to PDF** — JPG/PNG/WebP/GIF/BMP → PDF with page size / orientation / margin / fit controls
- **Extract images** — pull embedded images, deduped by content hash, zip or individual
- **Page numbers** — position, format (incl. custom `{n}`/`{t}`), start-at, skip-first, margin
- **Watermark** — diagonal translucent text on every page (size, color, opacity, angle)
- **PDF to PNG** — every page rendered to an image at 1×–3×, zipped
- **PDF to text** — position-sorted text extraction, CID/ToUnicode-aware (Arabic, CJK, …)
- **Compress PDF** — rebuild + re-deflate every stream, optional JPEG re-encode of embedded images
- **Protect / Unlock** — RC4-128 Standard-handler encryption, or decrypt with the password
- **Scrub metadata** — shows you the author/producer/XMP/doc-ID leak before wiping it

Page previews are drawn by a **hand-written content-stream renderer** (`collectDrawOps` walks the PDF operators — graphics state, text matrices, `/Rotate`, Form XObjects, vector paths, colors, clipping — and paints to canvas). Known limits (honest list): JBIG2/CCITT image streams aren't decoded; encryption is RC4-128 (the interoperable baseline — opens everywhere) and unlock supports Standard-handler RC4 (R2/R3) — **AES-encrypted files are rejected with a clear error rather than silently corrupted**; passwords are Latin-1 only (the byte-string format every PDF reader agrees on); page-subsetting tools (split/extract/organize/merge) rebuild the page set and don't carry over document-level extras like outlines, while whole-document tools (compress, watermark, page numbers, protect/unlock) preserve `/Outlines`, `/AcroForm`, `/Names`, `/Info`, `/ID` and friends. The parser is scan-based rather than a full-spec implementation, so exotic files may be partially understood.

## Develop

```bash
npm run dev     # node serve.mjs → http://localhost:5199/  (zero-dep static server)
npm test        # node --test — no install needed, there is nothing to install
npm run build   # copies the deployable site to dist/
```

Requires only Node ≥ 18. `npm install` does not exist here — there are no dependencies to install.

## License

MIT. Use it, fork it, sell it if you can — the point is nobody should have to.
