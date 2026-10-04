import { h, stem, fmtBytes } from '../ui/dom.js'
import { Button, Dropzone, Switch, FileChip, pickFiles, toast, Callout } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { compressPdf } from '../pdf/ops.js'

const LEVELS = {
  lossless: { label: 'Lossless', desc: 'Repacks everything without touching image quality.', q: null },
  balanced: { label: 'Balanced', desc: 'Re-encodes photos at good quality and caps them at 2000px. Best for most files.', q: 0.75, max: 2000 },
  smallest: { label: 'Smallest', desc: 'Stronger photo compression, capped at 1400px. Great for email; photos get softer.', q: 0.55, max: 1400 },
}

/** Browser-side photo re-encoder handed to the engine. */
const reimager = ({ q, max }) => async (dec) => {
  let src
  if (dec.rgba) {
    const c = document.createElement('canvas')
    c.width = dec.w
    c.height = dec.h
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(dec.rgba), dec.w, dec.h), 0, 0)
    src = c
  } else if (dec.mime === 'image/jpeg') {
    src = await createImageBitmap(new Blob([dec.data], { type: 'image/jpeg' })).catch(() => null)
  }
  if (!src) return null
  const k = Math.min(1, max / Math.max(src.width, src.height))
  if (src.width * src.height < 120 * 120) return null // icons: not worth it
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(src.width * k))
  c.height = Math.max(1, Math.round(src.height * k))
  const x = c.getContext('2d')
  x.fillStyle = '#fff' // JPEG has no alpha; any soft mask stays attached to the image
  x.fillRect(0, 0, c.width, c.height)
  x.drawImage(src, 0, 0, c.width, c.height)
  src.close?.()
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

export function Compress() {
  const { root, render } = mount()
  let info = null
  let level = 'balanced'
  let stripMeta = false
  let busy = false
  let result = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const L = LEVELS[level]
    const r = await compressPdf(info.bytes, { reimage: L.q ? reimager(L) : undefined, stripMeta })
    const smaller = r.after < info.size
    result = { ...r, smaller, blob: new Blob([smaller ? r.bytes : info.bytes], { type: 'application/pdf' }), name: `${stem(info.name)}-compressed.pdf` }
  })

  function paint() {
    if (!info) { render(ToolHead('compress'), Dropzone({ onFiles: load, title: 'Drop a PDF to make it smaller', tc: 'var(--c-secure)', icon: 'shrink' })); return }
    if (result) {
      const saved = info.size - result.after
      const pct = Math.round((saved / info.size) * 100)
      render(ToolHead('compress'), ResultCard({
        title: result.smaller ? `${pct}% smaller` : 'Already well optimized',
        sub: result.smaller ? `${fmtBytes(info.size)} → ${fmtBytes(result.after)}` : 'We couldn’t make this file smaller — you’re downloading the original.',
        blob: result.blob, filename: result.name, toolId: 'compress', autoDownload: result.smaller,
        extra: h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'sv' }, fmtBytes(info.size)), h('div', { class: 'sl' }, 'Before')),
          h('div', { class: 'stat good' }, h('div', { class: 'sv' }, fmtBytes(Math.min(info.size, result.after))), h('div', { class: 'sl' }, 'After')),
          h('div', { class: 'stat' }, h('div', { class: 'sv' }, `${result.images.recoded}/${result.images.total}`), h('div', { class: 'sl' }, 'Images re-compressed'))),
        onAgain: () => { result = null; paint() },
      }))
      if (!result.smaller) toast('This PDF is already as small as we can make it', { type: 'info' })
      return
    }
    render(
      ToolHead('compress'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'card card-pad stack-sm' },
            Object.entries(LEVELS).map(([k, L]) => h('label', {
              class: 'callout' + (k === level ? ' ok' : ''), style: { cursor: 'pointer', alignItems: 'center' },
              onclick: () => { level = k; paint() },
            }, h('input', { type: 'radio', name: 'lvl', checked: k === level, style: { accentColor: 'var(--accent)' } }),
            h('div', {}, h('b', {}, L.label), h('div', { class: 'small muted' }, L.desc))))),
        ],
        [
          h('div', { class: 'card stack' },
            Switch('Remove metadata', stripMeta, (v) => (stripMeta = v), { hint: 'Author, title, dates and XMP — a few KB, and more private' }),
            Callout('Text and vector graphics are always kept sharp — only photos are re-encoded, and only when it actually saves space.')),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Compressing…' : 'Compress PDF', icon: 'shrink', variant: 'primary', size: 'lg', block: true, busy, onClick: run })),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
