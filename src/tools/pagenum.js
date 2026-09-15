import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { addPageNumbers, pageCount } from '../pdf/ops.js'

export function PageNums() {
  let file = null
  let bytes = null
  let pages = 0
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    error = ''
    try {
      file = f
      bytes = await readBytes(f)
      pages = await pageCount(bytes)
    } catch (e) {
      error = e.message || 'could not read that PDF'
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
      const out = await addPageNumbers(bytes)
      saveBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-numbered.pdf`)
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
      file ? Card(h('p', { class: 'meta' }, h('b', {}, file.name), ` — ${pages} pages`), h('p', { class: 'meta dim' }, 'Stamps "N / total" bottom-center in Helvetica 10pt')) : null,
      ErrorText(error),
      Btn(busy ? 'Stamping…' : 'Add page numbers', { onclick: run, disabled: busy || !bytes }),
    )
  }
  render()
  return root
}
