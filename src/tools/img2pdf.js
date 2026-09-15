import { h, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, FileList } from '../ui/widgets.js'
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
  let files = []
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

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
      const images = await Promise.all(files.map(async (f) => ({ data: await toJpeg(f) })))
      const out = imagesToPdf(images)
      saveBlob(new Blob([out], { type: 'application/pdf' }), 'images.pdf')
    } catch (e) {
      error = e.message || 'failed — use JPEG or PNG images'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    root.replaceChildren(
      DropZone({
        accept: 'image/jpeg,image/png,image/webp,image/gif,image/bmp',
        multiple: true,
        onFiles: (f) => { files = files.concat(f); render() },
        label: 'Drop images here or ',
      }),
      files.length ? Card(FileList({ files, onMove: move, onRemove: (i) => { files = files.filter((_, j) => j !== i); render() } })) : null,
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
