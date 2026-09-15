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

## Tools (v1)

- **Merge PDF** — combine any number of PDFs, your order
- **Split PDF** — extract ranges (`1-3, 5, 8-10`) into one file or a zip of separate PDFs
- **Organize pages** — drag-reorder, rotate, delete
- **Images to PDF** — JPG/PNG/WebP/GIF/BMP → PDF (decoded by the browser's own canvas)

Known limits (honest list): encrypted PDFs bail with a clear error, PDF→images needs a real renderer so it's out, page previews show metadata cards instead of thumbnails for the same reason.

## Develop

```bash
npm run dev     # node serve.mjs → http://localhost:5199/  (zero-dep static server)
npm test        # node --test — no install needed, there is nothing to install
npm run build   # copies the deployable site to dist/
```

Requires only Node ≥ 18. `npm install` does not exist here — there are no dependencies to install.

## License

MIT. Use it, fork it, sell it if you can — the point is nobody should have to.
