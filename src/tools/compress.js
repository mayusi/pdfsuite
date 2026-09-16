import { h, readBytes, saveBlob, setKids, fmtBytes } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { compressPdf } from '../pdf/ops.js'

export function Compress() {
  let file = null
  let bytes = null
  let result = null // {bytes, before, after}
  let reimageImgs = true
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    bytes = null
    result = null
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      bytes = b
    } catch (e) {
      if (my !== loadGen) return
      error = 'could not read that file'
      file = null
    }
    render()
  }

  const reimage = async (dec) => {
    const bmp = await createImageBitmap(new Blob([dec.data], { type: dec.mime })).catch(() => null)
    if (!bmp) return null
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext('2d').drawImage(bmp, 0, 0)
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.72))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null
  }

  const run = async () => {
    busy = true
    error = ''
    result = null
    render()
    try {
      result = await compressPdf(bytes, { reimage: reimageImgs ? reimage : undefined })
      if (result.after >= result.before) {
        result.note = 'already tight — rebuilt but not smaller'
      }
    } catch (e) {
      error = e.message || 'compress failed'
    } finally {
      busy = false
      render()
    }
  }

  const download = () =>
    saveBlob(new Blob([result.bytes], { type: 'application/pdf' }),
      `${file.name.replace(/\.pdf$/i, '')}-small.pdf`)

  function render() {
    const saved = result ? result.before - result.after : 0
    const pct = result ? Math.round((saved / result.before) * 100) : 0
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name), ` — ${fmtBytes(bytes?.length ?? 0)}`),
            h('label', { class: 'lbl chk' },
              h('input', {
                type: 'checkbox', checked: reimageImgs || undefined,
                onchange: (e) => { reimageImgs = e.target.checked },
              }),
              ' Re-encode embedded images at lower quality (biggest wins, slight quality loss)'),
            h('div', { class: 'btnrow' },
              Btn(busy ? 'Compressing…' : 'Compress', { onclick: run, disabled: busy })),
            result
              ? h('p', { class: 'meta' },
                  h('b', {}, `${fmtBytes(result.before)} → ${fmtBytes(result.after)}`),
                  saved > 0 ? ` — saved ${fmtBytes(saved)} (${pct}%)` : ` — ${result.note}`)
              : null,
            result ? Btn('Download compressed PDF', { onclick: download }) : null,
          )
        : null,
      ErrorText(error),
    )
  }
  render()
  return root
}
