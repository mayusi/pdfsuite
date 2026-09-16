import { h, readBytes, saveBlob, setKids } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { watermarkPdf } from '../pdf/ops.js'

const ANGLES = [[-45, 'Diagonal ↗'], [45, 'Diagonal ↘'], [0, 'Horizontal']]
const COLORS = [
  ['0.62,0.10,0.10', 'Red'],
  ['0.10,0.10,0.10', 'Black'],
  ['0.30,0.30,0.30', 'Gray'],
  ['0.10,0.30,0.62', 'Blue'],
]

export function Watermark() {
  let file = null
  let bytes = null
  let text = 'CONFIDENTIAL'
  let size = 48
  let opacity = 0.25
  let colorKey = COLORS[0][0]
  let angle = -45
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    bytes = null
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

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const color = colorKey.split(',').map(Number)
      const out = await watermarkPdf(bytes, { text, size, opacity, color, angle })
      saveBlob(new Blob([out], { type: 'application/pdf' }),
        `${file.name.replace(/\.pdf$/i, '')}-watermarked.pdf`)
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
      h('option', { value: v, selected: String(v) === String(value) || undefined }, label)))

  function render() {
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name)),
            h('div', {},
              h('label', { class: 'lbl' }, 'Watermark text'),
              h('input', {
                class: 'textin', value: text, maxlength: 60,
                oninput: (e) => { text = e.target.value },
              })),
            h('div', { class: 'optrow' },
              h('div', {}, h('label', { class: 'lbl' }, 'Angle'), select(ANGLES, angle, (v) => (angle = Number(v)))),
              h('div', {}, h('label', { class: 'lbl' }, 'Color'), select(COLORS, colorKey, (v) => (colorKey = v))),
              h('div', {},
                h('label', { class: 'lbl' }, `Size — ${size}pt`),
                h('input', {
                  type: 'range', min: 12, max: 120, value: size, class: 'slider',
                  oninput: (e) => { size = Number(e.target.value); e.target.previousElementSibling.textContent = `Size — ${size}pt` },
                })),
              h('div', {},
                h('label', { class: 'lbl' }, `Opacity — ${Math.round(opacity * 100)}%`),
                h('input', {
                  type: 'range', min: 5, max: 80, value: Math.round(opacity * 100), class: 'slider',
                  oninput: (e) => { opacity = Number(e.target.value) / 100; e.target.previousElementSibling.textContent = `Opacity — ${Math.round(opacity * 100)}%` },
                }))),
            h('div', { class: 'btnrow' },
              Btn(busy ? 'Stamping…' : 'Stamp it', { onclick: run, disabled: busy || !text.trim() })),
          )
        : null,
      ErrorText(error),
    )
  }
  render()
  return root
}
