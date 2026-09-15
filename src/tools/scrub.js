import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { scrubPdf } from '../pdf/ops.js'

export function Scrub() {
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
    setKids(root, 
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name)),
            h('p', { class: 'meta dim' }, 'Rebuilds the document and drops /Info, XMP metadata, document IDs, author/producer fields and dead objects. Pages and content are untouched.'),
          )
        : null,
      ErrorText(error),
      Btn(busy ? 'Scrubbing…' : 'Scrub metadata', { onclick: run, disabled: busy || !bytes }),
    )
  }
  render()
  return root
}
