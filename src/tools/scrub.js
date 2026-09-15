import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, MetaTable } from '../ui/widgets.js'
import { readMetadata, scrubPdf } from '../pdf/ops.js'

export function Scrub() {
  let file = null
  let bytes = null
  let meta = null // {fields, xmp, id}
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    meta = null
    busy = true
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const found = await readMetadata(b)
      if (my !== loadGen) return
      bytes = b
      meta = found
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that file'
      file = null
      bytes = null
    } finally {
      if (my === loadGen) busy = false
      render()
    }
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const out = await scrubPdf(bytes)
      saveBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-clean.pdf`)
    } catch (e) {
      error = e.message || 'failed'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    const leaking = meta && (meta.fields.length || meta.xmp || meta.id)
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      busy ? h('p', { class: 'meta dim' }, 'Reading metadata…') : null,
      file && meta
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name)),
            leaking
              ? h('p', { class: 'meta dim' }, 'This file is carrying the following — all of it gets wiped:')
              : null,
            MetaTable(meta),
          )
        : null,
      ErrorText(error),
      file && meta
        ? Btn(busy ? 'Scrubbing…' : leaking ? 'Scrub it all' : 'Rebuild anyway', { onclick: run, disabled: busy })
        : null,
    )
  }
  render()
  return root
}
