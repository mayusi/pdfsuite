import { h, plural, stem } from '../ui/dom.js'
import { Button, Dropzone, FileChip, Field, Seg, pickFiles, toast } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { PageCard, pageThumbs } from '../ui/pages.js'
import { organizePages } from '../pdf/ops.js'

export function Rotate() {
  const { root, render } = mount()
  let info = null
  let thumbs = null
  let rots = []
  let scope = 'all'
  let busy = false
  let result = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      thumbs?.disconnect()
      thumbs = pageThumbs(info)
      rots = info.leaves.map(() => 0)
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }
  const inScope = (i) => scope === 'all' || (scope === 'odd' ? i % 2 === 0 : i % 2 === 1)
  const rotAll = (d) => { rots = rots.map((r, i) => (inScope(i) ? (r + d + 360) % 360 : r)); paint() }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const out = await organizePages(info.bytes, rots.map((r, i) => ({ page: i + 1, rotation: r })))
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}-rotated.pdf` }
  })

  function paint() {
    if (!info) { render(ToolHead('rotate'), Dropzone({ onFiles: load, title: 'Drop a PDF to rotate', tc: 'var(--c-organize)', icon: 'rotate' })); return }
    if (result) { render(ToolHead('rotate'), ResultCard({ title: 'Pages rotated', blob: result.blob, filename: result.name, toolId: 'rotate', onAgain: () => { result = null; paint() } })); return }
    const changed = rots.filter(Boolean).length
    render(
      ToolHead('rotate'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('p', { class: 'muted small', style: { margin: 0 } }, 'Click a page to turn it 90° clockwise, or use the buttons to rotate many at once.'),
          h('div', { class: 'pgrid' }, info.leaves.map((_, i) => PageCard({
            thumbs, src: i, dims: info.dims[i], rotation: rots[i], label: `${i + 1}`, sub: rots[i] ? `${rots[i]}°` : '',
            onClick: () => { rots[i] = (rots[i] + 90) % 360; paint() },
            ops: [
              { icon: 'rotl', tip: 'Rotate left', onClick: () => { rots[i] = (rots[i] + 270) % 360; paint() } },
              { icon: 'rotate', tip: 'Rotate right', onClick: () => { rots[i] = (rots[i] + 90) % 360; paint() } },
            ],
          }))),
        ],
        [
          h('div', { class: 'card stack' },
            Field('Apply to', Seg([['all', 'All pages'], ['odd', 'Odd'], ['even', 'Even']], scope, (v) => (scope = v), { block: true })),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: 'Left', icon: 'rotl', onClick: () => rotAll(-90) }),
              Button({ label: 'Right', icon: 'rotate', onClick: () => rotAll(90) }),
              Button({ label: '180°', onClick: () => rotAll(180) })),
            Button({ label: 'Reset', icon: 'undo', size: 'sm', disabled: !changed, onClick: () => { rots = rots.map(() => 0); paint() } })),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Saving…' : 'Save rotated PDF', icon: 'download', variant: 'primary', size: 'lg', block: true, busy, disabled: !changed, onClick: run }),
            h('div', { class: 'summary' }, changed ? `${plural(changed, 'page')} will be rotated` : 'Nothing rotated yet')),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
