import { h, readBytes, saveBlob, setKids } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { parsePdf } from '../pdf/parse.js'
import { extractText } from '../pdf/ops.js'

export function PdfToText() {
  let file = null
  let texts = null // string[]
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    texts = null
    busy = true
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const doc = await parsePdf(b)
      const t = await extractText(doc)
      if (my !== loadGen) return
      texts = t
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that file'
      file = null
    } finally {
      if (my === loadGen) busy = false
      render()
    }
  }

  const download = () => {
    const body = texts
      .map((t, i) => `--- page ${i + 1} ---\n\n${t || '(no extractable text)'}`)
      .join('\n\n')
    saveBlob(
      new Blob([body], { type: 'text/plain;charset=utf-8' }),
      `${file.name.replace(/\.pdf$/i, '')}.txt`,
    )
  }

  function render() {
    const totalChars = texts ? texts.reduce((s, t) => s + t.length, 0) : 0
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      busy ? h('p', { class: 'meta dim' }, 'Reading text…') : null,
      file && texts
        ? Card(
            h('p', { class: 'meta' },
              h('b', {}, file.name),
              ` — ${texts.length} pages · ${totalChars.toLocaleString()} chars extracted`),
            totalChars
              ? h('pre', { class: 'textpreview' },
                  texts.slice(0, 3).map((t, i) => `--- page ${i + 1} ---\n${t || '(no extractable text)'}`).join('\n\n').slice(0, 1200))
              : h('p', { class: 'meta dim' }, 'No extractable text — this looks like a scanned/image-only PDF.'),
            Btn('Download .txt', { onclick: download, disabled: !totalChars }),
          )
        : null,
      ErrorText(error),
    )
  }
  render()
  return root
}
