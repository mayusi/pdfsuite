import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { addPageNumbers, pageCount } from '../pdf/ops.js'

const POSITIONS = [
  ['bc', 'Bottom center'], ['bl', 'Bottom left'], ['br', 'Bottom right'],
  ['tc', 'Top center'], ['tl', 'Top left'], ['tr', 'Top right'],
]
const FORMATS = [
  ['n-of-total', '1 / 12'], ['n', '1'], ['page-n', 'Page 1'], ['custom', 'Custom…'],
]

export function PageNums() {
  let file = null
  let bytes = null
  let pages = 0
  let pos = 'bc'
  let fmt = 'n-of-total'
  let fmtStr = '{n} / {t}'
  let start = 1
  let size = 10
  let margin = 18
  let skipFirst = false
  let busy = false
  let error = ''
  let loadGen = 0
  let previewEl = null
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    pages = 0
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const count = await pageCount(b)
      if (my !== loadGen) return
      bytes = b
      pages = count
    } catch (e) {
      if (my !== loadGen) return
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
      const out = await addPageNumbers(bytes, { pos, fmt, fmtStr, start, size, margin, skipFirst })
      saveBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-numbered.pdf`)
    } catch (e) {
      error = e.message || 'failed'
    } finally {
      busy = false
      render()
    }
  }

  const select = (options, value, onpick) =>
    h('select', {
      class: 'textin sel',
      onchange: (e) => { onpick(e.target.value); render() },
    }, options.map(([v, label]) =>
      h('option', { value: v, selected: v === value || undefined }, label)))

  const numin = (value, min, max, onset) =>
    h('input', {
      class: 'textin num', type: 'number', value, min, max,
      onchange: (e) => { onset(Math.max(min, Math.min(max, parseInt(e.target.value, 10) || min))) },
    })

  const previewLabel = () => {
    const n = (skipFirst ? 1 : 0) + start
    const shown = fmt === 'n' ? `${n}`
      : fmt === 'page-n' ? `Page ${n}`
      : fmt === 'custom' ? (fmtStr || '{n}').replaceAll('{n}', String(n)).replaceAll('{t}', String(pages))
      : `${n} / ${pages}`
    const where = POSITIONS.find(([v]) => v === pos)[1].toLowerCase()
    return `Preview: "${shown}" · ${where} · ${size}pt · ${margin}pt margin${skipFirst ? ' · page 1 left blank' : ''}`
  }

  function render() {
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name), ` — ${pages} pages`),
            h('div', { class: 'optrow' },
              h('div', {}, h('label', { class: 'lbl' }, 'Position'), select(POSITIONS, pos, (v) => (pos = v))),
              h('div', {}, h('label', { class: 'lbl' }, 'Format'), select(FORMATS, fmt, (v) => (fmt = v))),
              h('div', {}, h('label', { class: 'lbl' }, 'Start at'), numin(start, 0, 9999, (v) => (start = v))),
              h('div', {}, h('label', { class: 'lbl' }, 'Size (pt)'), numin(size, 6, 48, (v) => (size = v))),
            ),
            fmt === 'custom'
              ? h('div', { class: 'optrow' },
                  h('div', { style: { flex: 1 } },
                    h('label', { class: 'lbl' }, 'Custom label — {n} = number, {t} = total'),
                    h('input', { class: 'textin', value: fmtStr, oninput: (e) => {
                      fmtStr = e.target.value
                      if (previewEl) previewEl.textContent = previewLabel()
                    } })),
                )
              : null,
            h('div', { class: 'optrow' },
              h('div', { style: { flex: 1 } },
                h('label', { class: 'lbl' }, `Margin — ${margin}pt`),
                h('input', {
                  type: 'range', min: 0, max: 72, step: 1, value: margin, class: 'slider',
                  oninput: (e) => {
                    margin = +e.target.value
                    e.target.previousElementSibling.textContent = `Margin — ${margin}pt`
                    if (previewEl) previewEl.textContent = previewLabel()
                  },
                })),
            ),
            h('label', { class: 'radio', style: { marginBottom: '10px' } },
              h('input', { type: 'checkbox', checked: skipFirst || undefined, onchange: (e) => { skipFirst = e.target.checked; render() } }),
              'Skip first page (covers/title pages stay clean)',
            ),
            (previewEl = h('p', { class: 'meta dim' }, previewLabel())),
          )
        : null,
      ErrorText(error),
      file ? Btn(busy ? 'Stamping…' : 'Add page numbers', { onclick: run, disabled: busy || !bytes }) : null,
    )
  }
  render()
  return root
}
