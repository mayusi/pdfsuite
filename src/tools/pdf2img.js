import { h, plural, stem, fmtBytes } from '../ui/dom.js'
import { Button, Dropzone, Field, Seg, Range, FileChip, Progress, pickFiles, toast } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { PageCard, pageThumbs, zoomPage } from '../ui/pages.js'
import { renderPage } from '../pdf/render.js'
import { zipStore } from '../zip.js'

export function PdfToImg() {
  const { root, render } = mount()
  let info = null
  let thumbs = null
  let fmt = 'png'
  let quality = 0.9
  let dpi = 150
  let sel = new Set()
  let busy = false
  let progress = null
  let result = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      thumbs?.disconnect()
      thumbs = pageThumbs(info)
      sel = new Set(info.leaves.map((_, k) => k))
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const pxSize = () => { // rough output size for the first selected page
    const d = info.dims[[...sel][0] ?? 0]
    const w = d.rotate % 180 === 0 ? d.w : d.h, hh = d.rotate % 180 === 0 ? d.h : d.w
    return [Math.round((w * dpi) / 72), Math.round((hh * dpi) / 72)]
  }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const picks = [...sel].sort((a, b) => a - b)
    const cache = new Map()
    const files = []
    const base = stem(info.name)
    const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png'
    progress = Progress(0)
    paint()
    for (let k = 0; k < picks.length; k++) {
      const i = picks[k]
      const d = info.dims[i]
      const w = d.rotate % 180 === 0 ? d.w : d.h
      // cap at ~40 MP so 600 DPI on a poster can't crash the tab
      const width = Math.min(Math.round((w * dpi) / 72), 9000)
      const cv = await renderPage(info.doc, info.leaves[i], { width, cache })
      const blob = await new Promise((r) => cv.toBlob(r, mime, fmt === 'jpg' ? quality : undefined))
      if (!blob) throw new Error(`Couldn’t encode page ${i + 1} (too large?)`)
      files.push({ name: `${base}-page-${String(i + 1).padStart(String(info.leaves.length).length, '0')}.${fmt}`, data: new Uint8Array(await blob.arrayBuffer()) })
      progress.set((k + 1) / picks.length)
      await new Promise((r) => setTimeout(r)) // let the UI breathe between pages
    }
    progress = null
    if (files.length === 1) result = { blob: new Blob([files[0].data], { type: mime }), name: files[0].name, n: 1 }
    else result = { blob: new Blob([zipStore(files)], { type: 'application/zip' }), name: `${base}-${fmt}.zip`, n: files.length }
  })

  function paint() {
    if (!info) { render(ToolHead('pdf2img'), Dropzone({ onFiles: load, title: 'Drop a PDF to turn into images', tc: 'var(--c-convert)', icon: 'image' })); return }
    if (result) {
      render(ToolHead('pdf2img'), ResultCard({
        title: result.n > 1 ? `${plural(result.n, 'image')} ready` : 'Image ready', blob: result.blob, filename: result.name, toolId: 'pdf2img',
        sub: `${result.name} · ${fmtBytes(result.blob.size)}`, onAgain: () => { result = null; paint() },
      }))
      return
    }
    const [pw, ph] = pxSize()
    render(
      ToolHead('pdf2img'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'row between' },
            h('span', { class: 'muted small' }, `${sel.size} of ${info.leaves.length} pages selected`),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: 'All', size: 'sm', onClick: () => { sel = new Set(info.leaves.map((_, k) => k)); paint() } }),
              Button({ label: 'None', size: 'sm', onClick: () => { sel = new Set(); paint() } }))),
          h('div', { class: 'pgrid' }, info.leaves.map((_, i) => PageCard({
            thumbs, src: i, dims: info.dims[i], label: `${i + 1}`, selected: sel.has(i),
            onClick: () => { sel.has(i) ? sel.delete(i) : sel.add(i); paint() },
            ops: [{ icon: 'zoomIn', tip: 'Preview', onClick: () => zoomPage(info, i) }],
          }))),
        ],
        [
          h('div', { class: 'card stack' },
            Field('Format', Seg([['png', 'PNG'], ['jpg', 'JPG']], fmt, (v) => { fmt = v; paint() }, { block: true }), { hint: fmt === 'png' ? 'sharp, larger' : 'smaller files' }),
            fmt === 'jpg' ? Field('Quality', Range(Math.round(quality * 100), { min: 40, max: 100, fmt: (v) => `${v}%` }, (v) => (quality = v / 100))) : null,
            Field('Resolution', Seg([[72, '72'], [150, '150'], [300, '300'], [600, '600']], dpi, (v) => { dpi = v; paint() }, { block: true }), { hint: 'DPI' }),
            h('p', { class: 'muted small', style: { margin: 0 } }, `About ${pw} × ${ph} px per page.`)),
          h('div', { class: 'action-bar sticky-m' },
            progress,
            Button({ label: busy ? 'Rendering…' : `Convert ${plural(sel.size, 'page')}`, icon: 'download', variant: 'primary', size: 'lg', block: true, busy, disabled: !sel.size, onClick: run }),
            h('div', { class: 'summary' }, sel.size > 1 ? 'Downloaded as a ZIP' : '')),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
