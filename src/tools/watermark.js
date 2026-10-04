import { h, stem, readBytes } from '../ui/dom.js'
import { Button, Dropzone, Field, Seg, Select, Range, Switch, Swatches, TextInput, FileChip, pickFiles, toast } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { livePreview } from '../ui/preview.js'
import { watermarkPdf } from '../pdf/stamp.js'

const hexToRgb = (hx) => { const n = parseInt(hx.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255] }

/** An image file → watermark image ({jpeg} or {rgba,w,h} — transparency kept). */
async function loadImage(file) {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * k))
  c.height = Math.max(1, Math.round(bmp.height * k))
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close?.()
  if (/jpe?g/i.test(file.type) && k === 1) return { jpeg: await readBytes(file), name: file.name, url: c.toDataURL() }
  return { rgba: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height, name: file.name, url: c.toDataURL() }
}

export function Watermark() {
  const { root, render } = mount()
  let info = null
  let kind = 'text'
  let image = null
  const o = { text: 'CONFIDENTIAL', size: 60, font: 'helv', bold: true, color: '#e03131', opacity: 0.2, angle: -45, layout: 'center', under: false, imageScale: 0.5, pages: 'all' }
  let busy = false
  let result = null
  let pv = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }
  const engineOpts = () => ({ ...o, color: hexToRgb(o.color), image: kind === 'image' ? image : null })
  const set = (k, v, repaint = false) => { o[k] = v; if (repaint) paint(); else pv?.update() }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    if (kind === 'text' && !o.text.trim()) throw new Error('Type some watermark text first')
    if (kind === 'image' && !image) throw new Error('Choose an image first')
    const out = await watermarkPdf(info.bytes, engineOpts())
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}-watermarked.pdf` }
  })

  function paint() {
    if (!info) { render(ToolHead('watermark'), Dropzone({ onFiles: load, title: 'Drop a PDF to watermark', tc: 'var(--c-edit)', icon: 'droplet' })); return }
    if (result) { render(ToolHead('watermark'), ResultCard({ title: 'Watermark added', blob: result.blob, filename: result.name, toolId: 'watermark', onAgain: () => { result = null; paint() } })); return }
    pv = livePreview(info, info.leaves.length > 1 ? [0, 1] : [0], (bytes) => (kind === 'image' && !image) ? Promise.resolve(bytes) : watermarkPdf(bytes, { ...engineOpts(), pages: 'all' }))
    render(
      ToolHead('watermark'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'card card-pad' }, h('div', { class: 'card-title' }, 'Live preview'), pv.el),
        ],
        [
          h('div', { class: 'card stack' },
            Seg([['text', 'Text', 'type'], ['image', 'Image', 'image']], kind, (v) => { kind = v; paint() }, { block: true }),
            kind === 'text'
              ? [
                  Field('Text', TextInput(o.text, (v) => set('text', v), { placeholder: 'e.g. DRAFT' })),
                  h('div', { class: 'field-row' },
                    Field('Font', Select([['helv', 'Helvetica'], ['times', 'Times'], ['courier', 'Courier']], o.font, (v) => set('font', v))),
                    Field('Style', Seg([[true, 'Bold'], [false, 'Regular']], o.bold, (v) => set('bold', v), { block: true }))),
                  Field('Size', Range(o.size, { min: 12, max: 200, fmt: (v) => `${v}pt` }, (v) => set('size', v))),
                  Field('Colour', Swatches(o.color, (v) => set('color', v), { colors: ['#e03131', '#111111', '#868e96', '#1971c2', '#2f9e44', '#f08c00'] })),
                ]
              : [
                  image
                    ? h('div', { class: 'row' }, h('img', { src: image.url, alt: '', style: { width: '64px', height: '64px', objectFit: 'contain', background: 'var(--surface-3)', borderRadius: '8px' } }),
                        h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'small', style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, image.name)),
                        Button({ label: 'Change', size: 'sm', onClick: pickImg }))
                    : Button({ label: 'Choose logo / image', icon: 'image', block: true, onClick: pickImg }),
                  Field('Size', Range(Math.round(o.imageScale * 100), { min: 5, max: 100, fmt: (v) => `${v}% of width` }, (v) => set('imageScale', v / 100))),
                ],
            Field('Opacity', Range(Math.round(o.opacity * 100), { min: 5, max: 100, fmt: (v) => `${v}%` }, (v) => set('opacity', v / 100))),
            Field('Angle', Range(o.angle, { min: -90, max: 90, fmt: (v) => `${v}°` }, (v) => set('angle', v))),
            Field('Layout', Seg([['center', 'Centred'], ['tile', 'Tiled']], o.layout, (v) => set('layout', v), { block: true })),
            Field('Pages', Seg([['all', 'All'], ['odd', 'Odd'], ['even', 'Even']], o.pages, (v) => set('pages', v), { block: true }), { hint: 'preview shows every page' }),
            Switch('Behind the content', o.under, (v) => set('under', v), { hint: 'Text and images stay on top of the watermark' })),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Applying…' : 'Add watermark', icon: 'droplet', variant: 'primary', size: 'lg', block: true, busy, onClick: run })),
        ]),
    )
  }

  async function pickImg() {
    const [f] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif' })
    if (!f) return
    try { image = await loadImage(f); paint() } catch { toast('Couldn’t read that image', { type: 'error' }) }
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
