import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, ImgGrid } from '../ui/widgets.js'
import { extractImages } from '../pdf/ops.js'
import { zipStore } from '../zip.js'

export function ExtractImgs() {
  let file = null
  let results = null // {images, skipped}
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    results = null
    busy = true
    render()
    try {
      const bytes = await readBytes(f)
      if (my !== loadGen) return
      const found = await extractImages(bytes)
      if (my !== loadGen) return
      results = found
      if (!results.images.length) {
        error = results.skipped
          ? `found ${results.skipped} image${results.skipped === 1 ? '' : 's'} but in formats we can't decode yet (CCITT/JBIG2/masked)`
          : 'no embedded images found in this PDF'
      }
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that PDF'
      file = null
      results = null
    } finally {
      if (my === loadGen) busy = false
      render()
    }
  }

  const saveOne = (im) => saveBlob(new Blob([im.data], { type: im.mime }), im.name)

  const saveAll = () => {
    const stem = file.name.replace(/\.pdf$/i, '')
    saveBlob(
      new Blob([zipStore(results.images.map((im) => ({ name: im.name, data: im.data })))], { type: 'application/zip' }),
      `${stem}-images.zip`,
    )
  }

  function render() {
    const imgs = results?.images ?? []
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load, label: 'Drop a PDF here or ' }),
      busy ? h('p', { class: 'meta dim' }, 'Scanning for embedded images…') : null,
      file && results ? Card(h('p', { class: 'meta' }, h('b', {}, file.name), ` — ${imgs.length} image${imgs.length === 1 ? '' : 's'} extracted${results.skipped ? `, ${results.skipped} skipped (unsupported)` : ''}`)) : null,
      imgs.length ? ImgGrid({ images: imgs, onSave: saveOne }) : null,
      ErrorText(error),
      imgs.length ? Btn(`Download all ${imgs.length} (.zip)`, { onclick: saveAll }) : null,
    )
  }
  render()
  return root
}
