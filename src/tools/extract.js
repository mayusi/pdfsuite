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
  let hideDupes = false
  let selected = new Set() // image objects
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    results = null
    hideDupes = false
    selected = new Set()
    busy = true
    render()
    try {
      const bytes = await readBytes(f)
      if (my !== loadGen) return
      const found = await extractImages(bytes)
      if (my !== loadGen) return
      // count duplicates by content hash → first occurrence carries the badge
      const counts = new Map()
      for (const im of found.images) counts.set(im.hash, (counts.get(im.hash) ?? 0) + 1)
      const seen = new Set()
      for (const im of found.images) {
        im.dupCount = seen.has(im.hash) ? 0 : counts.get(im.hash)
        im.dup = seen.has(im.hash)
        seen.add(im.hash)
      }
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

  const saveZip = (list, suffix) => {
    const stem = file.name.replace(/\.pdf$/i, '')
    saveBlob(
      new Blob([zipStore(list.map((im) => ({ name: im.name, data: im.data })))], { type: 'application/zip' }),
      `${stem}-${suffix}.zip`,
    )
  }

  function render() {
    const imgs = results?.images ?? []
    const visible = hideDupes ? imgs.filter((im) => !im.dup) : imgs
    const unique = new Set(imgs.map((im) => im.hash)).size
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load, label: 'Drop a PDF here or ' }),
      busy ? h('p', { class: 'meta dim' }, 'Scanning for embedded images…') : null,
      file && results
        ? Card(
            h('p', { class: 'meta' },
              h('b', {}, file.name),
              ` — ${imgs.length} image${imgs.length === 1 ? '' : 's'} · ${unique} unique${results.skipped ? ` · ${results.skipped} skipped (unsupported)` : ''}`),
            imgs.length
              ? h('div', { class: 'toolbar' },
                  h('button', { type: 'button', class: 'tbtn', onclick: () => { selected = new Set(visible); render() } }, 'Select shown'),
                  h('button', { type: 'button', class: 'tbtn', onclick: () => { selected = new Set(); render() }, disabled: !selected.size || undefined }, 'Clear'),
                  h('label', { class: 'lbl', style: { margin: 0, alignSelf: 'center' } },
                    h('input', { type: 'checkbox', checked: hideDupes || undefined, onchange: (e) => { hideDupes = e.target.checked; render() } }),
                    ' hide duplicates'),
                  selected.size
                    ? h('span', { class: 'meta dim', style: { alignSelf: 'center' } }, `${selected.size} selected`)
                    : null,
                )
              : null,
          )
        : null,
      visible.length ? ImgGrid({ images: visible, onSave: saveOne, selected, onToggle: (im) => { selected.has(im) ? selected.delete(im) : selected.add(im); render() } }) : null,
      ErrorText(error),
      imgs.length
        ? h('div', { class: 'btnrow' },
            Btn(`Download all ${imgs.length} (.zip)`, { onclick: () => saveZip(imgs, 'images') }),
            selected.size
              ? Btn(`Download ${selected.size} selected (.zip)`, { onclick: () => saveZip([...selected], 'selected') })
              : null,
          )
        : null,
    )
  }
  render()
  return root
}
