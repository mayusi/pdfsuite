import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, ThumbList } from '../ui/widgets.js'
import { imagesToPdf } from '../pdf/ops.js'

/** Any raster → JPEG bytes via the browser's own decoder (canvas). */
async function toJpeg(file) {
  if (file.type === 'image/jpeg') return readBytes(file)
  const bmp = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff' // flatten alpha
  ctx.drawImage(bmp, 0, 0)
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92))
  return new Uint8Array(await blob.arrayBuffer())
}

export function ImgToPdf() {
  let files = [] // {file, url, dims}
  let busy = false
  let error = ''
  let opts = { size: 'native', orient: 'auto', margin: 0, fit: 'contain' }
  const root = h('div', { class: 'tool' })

  const add = async (incoming) => {
    for (const f of incoming) {
      const entry = { file: f, url: URL.createObjectURL(f), dims: null }
      files.push(entry)
      render()
      try {
        const bmp = await createImageBitmap(f)
        entry.dims = `${bmp.width}×${bmp.height}`
        bmp.close()
      } catch { /* non-decodable → toJpeg will surface it on build */ }
      render()
    }
  }

  const remove = (i) => {
    URL.revokeObjectURL(files[i].url)
    files = files.filter((_, j) => j !== i)
    render()
  }

  const move = (from, to) => {
    const c = [...files]
    const [x] = c.splice(from, 1)
    c.splice(to, 0, x)
    files = c
    render()
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const images = await Promise.all(files.map(async (f) => ({ data: await toJpeg(f.file) })))
      const out = imagesToPdf(images, opts)
      saveBlob(new Blob([out], { type: 'application/pdf' }), 'images.pdf')
    } catch (e) {
      error = e.message || 'failed — use JPEG or PNG images'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    setKids(root,
      DropZone({
        accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp',
        multiple: true,
        onFiles: add,
        label: 'Drop images here or ',
      }),
      files.length
        ? Card(
            ThumbList({ files, onMove: move, onRemove: remove }),
            h('p', { class: 'meta dim', style: { marginTop: '10px' } }, 'Drag to reorder — each image becomes one page'),
          )
        : null,
      files.length
        ? Card(
            h('div', { class: 'optrow' },
              h('label', { class: 'lbl' }, 'Page size'),
              h('select', { class: 'textin sel', onchange: (e) => { opts = { ...opts, size: e.target.value } } },
                h('option', { value: 'native', selected: true }, 'Match image'),
                h('option', { value: 'a4' }, 'A4'),
                h('option', { value: 'letter' }, 'Letter')),
              h('label', { class: 'lbl' }, 'Orientation'),
              h('select', { class: 'textin sel', onchange: (e) => { opts = { ...opts, orient: e.target.value } } },
                h('option', { value: 'auto', selected: true }, 'Auto'),
                h('option', { value: 'portrait' }, 'Portrait'),
                h('option', { value: 'landscape' }, 'Landscape')),
            ),
            h('div', { class: 'optrow' },
              h('label', { class: 'lbl' }, `Margin ${opts.margin}pt`),
              h('input', {
                type: 'range', min: 0, max: 72, step: 1, value: opts.margin, class: 'slider',
                oninput: (e) => { opts = { ...opts, margin: +e.target.value }; e.target.previousElementSibling.textContent = `Margin ${opts.margin}pt` },
              }),
              h('label', { class: 'lbl' }, 'Fit'),
              h('select', { class: 'textin sel', onchange: (e) => { opts = { ...opts, fit: e.target.value } } },
                h('option', { value: 'contain', selected: true }, 'Fit (keep ratio)'),
                h('option', { value: 'stretch' }, 'Stretch to page')),
            ),
          )
        : null,
      ErrorText(error),
      Btn(busy ? 'Building…' : `Build PDF from ${files.length} image${files.length === 1 ? '' : 's'}`, {
        onclick: run,
        disabled: busy || !files.length,
      }),
    )
  }
  render()
  return root
}
