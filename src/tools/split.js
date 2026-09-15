import { h, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { extractPages, pageCount, parseRanges, splitPdf } from '../pdf/ops.js'
import { zipStore } from '../zip.js'

export function Split() {
  let file = null
  let bytes = null
  let pages = 0
  let spec = ''
  let mode = 'one'
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    error = ''
    try {
      file = f
      bytes = await readBytes(f)
      pages = await pageCount(bytes)
      spec = `1-${pages}`
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
      const ranges = parseRanges(spec, pages)
      const stem = file.name.replace(/\.pdf$/i, '')
      if (mode === 'one') {
        const out = await extractPages(bytes, ranges)
        saveBlob(new Blob([out], { type: 'application/pdf' }), `${stem}-pages.pdf`)
      } else {
        const outs = await splitPdf(bytes, ranges)
        saveBlob(
          new Blob([zipStore(outs.map((out, i) => ({
            name: `${stem}-${ranges[i].from}-${ranges[i].to}.pdf`,
            data: out,
          })))], { type: 'application/zip' }),
          `${stem}-split.zip`,
        )
      }
    } catch (e) {
      error = e.message || 'split failed'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    root.replaceChildren(
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name), ` — ${pages} pages`),
            h('label', { class: 'lbl' }, 'Pages / ranges (e.g. 1-3, 5, 8-10)'),
            h('input', {
              class: 'textin',
              value: spec,
              oninput: (e) => (spec = e.target.value),
            }),
            h(
              'div',
              { class: 'radio-row' },
              radio('one', 'One PDF with those pages'),
              radio('zip', 'Separate PDF per range (zip)'),
            ),
          )
        : null,
      ErrorText(error),
      Btn(busy ? 'Working…' : 'Split', { onclick: run, disabled: busy || !bytes }),
    )
  }

  const radio = (val, text) =>
    h(
      'label',
      { class: 'radio' },
      h('input', {
        type: 'radio',
        name: 'splitmode',
        checked: mode === val || undefined,
        onchange: () => { mode = val; render() },
      }),
      text,
    )

  render()
  return root
}
