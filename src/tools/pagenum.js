import { h, stem } from '../ui/dom.js'
import { Button, Dropzone, Field, Seg, Select, Stepper, Switch, Swatches, TextInput, FileChip, pickFiles, toast } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { livePreview } from '../ui/preview.js'
import { addPageNumbers } from '../pdf/stamp.js'

const POSITIONS = [['tl', 'Top left'], ['tc', 'Top centre'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['br', 'Bottom right']]
const FORMATS = [['n', '1'], ['n-of-total', '1 / 9'], ['page-n', 'Page 1'], ['page-n-of-total', 'Page 1 of 9'], ['custom', 'Custom']]

export function PageNums() {
  const { root, render } = mount()
  let info = null
  const o = { pos: 'bc', fmt: 'n', fmtStr: '- {n} -', start: 1, size: 11, margin: 24, font: 'helv', bold: false, color: '#000000', skipFirst: false, mirror: false, pages: 'all' }
  let busy = false
  let result = null
  let pv = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }
  const opts = (extra = {}) => ({ ...o, ...extra })
  const set = (k, v, repaint = false) => { o[k] = v; if (repaint) paint(); else pv?.update() }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const out = await addPageNumbers(info.bytes, opts())
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}-numbered.pdf` }
  })

  function posPicker() {
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', padding: '8px', background: 'var(--surface-3)', borderRadius: '10px', aspectRatio: '1.3' } })
    for (const [v, label] of POSITIONS) {
      const row = v[0] === 't' ? 1 : 3
      const col = { l: 1, c: 2, r: 3 }[v[1]]
      grid.append(h('button', {
        type: 'button', 'aria-label': label, 'data-tip': label,
        style: { gridRow: String(row), gridColumn: String(col), border: '0', borderRadius: '7px', cursor: 'pointer', background: o.pos === v ? 'var(--accent)' : 'var(--surface)', color: o.pos === v ? 'var(--on-accent)' : 'var(--text-3)', fontSize: '12px', fontWeight: '700', boxShadow: 'var(--shadow-sm)' },
        onclick: () => set('pos', v, true),
      }, '1'))
    }
    grid.append(h('div', { style: { gridRow: '2', gridColumn: '1 / 4' } }))
    return grid
  }

  function paint() {
    if (!info) { render(ToolHead('pagenum'), Dropzone({ onFiles: load, title: 'Drop a PDF to number its pages', tc: 'var(--c-edit)', icon: 'hash' })); return }
    if (result) { render(ToolHead('pagenum'), ResultCard({ title: 'Page numbers added', blob: result.blob, filename: result.name, toolId: 'pagenum', onAgain: () => { result = null; paint() } })); return }
    const n = info.leaves.length
    const previewPages = n > 1 ? [o.skipFirst && n > 2 ? 1 : 0, o.skipFirst && n > 2 ? 2 : 1] : [0]
    pv = livePreview(info, previewPages, (bytes) => addPageNumbers(bytes, opts({ total: n, offset: previewPages[0] })))
    render(
      ToolHead('pagenum'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'card card-pad' }, h('div', { class: 'card-title' }, 'Live preview'), pv.el),
        ],
        [
          h('div', { class: 'card stack' },
            Field('Position', posPicker()),
            Field('Format', Seg(FORMATS, o.fmt, (v) => set('fmt', v, true), { block: true })),
            o.fmt === 'custom' ? Field('Custom text', TextInput(o.fmtStr, (v) => set('fmtStr', v), { placeholder: 'e.g. Page {n} of {t}' }), { hint: '{n} number · {t} total' }) : null,
            h('div', { class: 'field-row' },
              Field('Start at', Stepper(o.start, { min: 0, max: 99999 }, (v) => set('start', v))),
              Field('Size', Stepper(o.size, { min: 5, max: 72 }, (v) => set('size', v)), { hint: 'pt' })),
            h('div', { class: 'field-row' },
              Field('Font', Select([['helv', 'Helvetica'], ['times', 'Times'], ['courier', 'Courier']], o.font, (v) => set('font', v))),
              Field('Margin', Stepper(o.margin, { min: 0, max: 200, step: 2 }, (v) => set('margin', v)), { hint: 'pt' })),
            Field('Colour', Swatches(o.color, (v) => set('color', v), { colors: ['#000000', '#555555', '#1971c2', '#e03131', '#2f9e44'] })),
            Field('Pages', Seg([['all', 'All'], ['odd', 'Odd'], ['even', 'Even']], o.pages, (v) => set('pages', v), { block: true })),
            Switch('Bold', o.bold, (v) => set('bold', v)),
            Switch('Skip the first page', o.skipFirst, (v) => set('skipFirst', v, true), { hint: 'Cover pages stay clean; numbering starts on page 2' }),
            Switch('Mirror for printing', o.mirror, (v) => set('mirror', v), { hint: 'Left/right positions swap on even pages (book style)' })),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Numbering…' : 'Add page numbers', icon: 'hash', variant: 'primary', size: 'lg', block: true, busy, onClick: run })),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
