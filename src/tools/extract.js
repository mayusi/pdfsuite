import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { extractImages } from '../pdf/ops.js'
import { zipStore } from '../zip.js'

export function ExtractImgs() {
  let file = null
  let bytes = null
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    error = ''
    try {
      file = f
      bytes = await readBytes(f)
    } catch (e) {
      error = 'could not read that file'
      file = null
      bytes = null
    }
    render()
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const { images, skipped } = await extractImages(bytes)
      if (!images.length) {
        error = skipped
          ? `found ${skipped} image${skipped === 1 ? '' : 's'} but in formats we can't decode yet (CCITT/JBIG2/masked)`
          : 'no embedded images found in this PDF'
        return
      }
      const stem = file.name.replace(/\.pdf$/i, '')
      if (images.length === 1) {
        saveBlob(new Blob([images[0].data]), images[0].name)
      } else {
        saveBlob(new Blob([zipStore(images.map((im) => ({ name: im.name, data: im.data })))], { type: 'application/zip' }), `${stem}-images.zip`)
      }
      if (skipped) error = `saved ${images.length} — skipped ${skipped} unsupported`
    } catch (e) {
      error = e.message || 'extraction failed'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    setKids(root, 
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file ? Card(h('p', { class: 'meta' }, h('b', {}, file.name), ' — JPEG / JPEG2000 / raw rasters → PNG')) : null,
      ErrorText(error),
      Btn(busy ? 'Extracting…' : 'Extract images', { onclick: run, disabled: busy || !bytes }),
    )
  }
  render()
  return root
}
