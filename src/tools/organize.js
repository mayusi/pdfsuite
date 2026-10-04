import { h, plural, stem, saveBlob } from '../ui/dom.js'
import { Button, IconButton, Dropzone, FileChip, pickFiles, sortable, toast, menu } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { PageCard, pageThumbs, zoomPage } from '../ui/pages.js'
import { organizePages } from '../pdf/ops.js'

export function Organize() {
  const { root, render } = mount()
  let info = null
  let extras = [] // extra opened PDFs: {info, thumbs}
  let thumbs = null
  let items = [] // {id, doc, page (0-based), rotation, blank?:[w,h]}
  let sel = new Set() // item ids
  let lastClick = null
  let history = []
  let future = []
  let busy = false
  let result = null
  let uid = 0

  const snapshot = () => items.map((x) => ({ ...x }))
  const mutate = (fn) => { history.push(snapshot()); if (history.length > 100) history.shift(); future = []; fn(); paint() }
  const undo = () => { if (!history.length) return; future.push(snapshot()); items = history.pop(); sel = new Set([...sel].filter((id) => items.some((x) => x.id === id))); paint() }
  const redo = () => { if (!future.length) return; history.push(snapshot()); items = future.pop(); paint() }

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      thumbs?.disconnect()
      thumbs = pageThumbs(info)
      extras = []
      items = info.leaves.map((_, p) => ({ id: ++uid, doc: 0, page: p, rotation: 0 }))
      sel = new Set(); history = []; future = []; result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const docInfo = (d) => (d === 0 ? info : extras[d - 1].info)
  const docThumbs = (d) => (d === 0 ? thumbs : extras[d - 1].thumbs)
  const dimsOf = (it) => (it.blank ? { w: it.blank[0], h: it.blank[1], rotate: 0 } : docInfo(it.doc).dims[it.page])

  const insertPdf = async () => {
    const [f] = await pickFiles()
    if (!f) return
    try {
      const xi = await openPdf(f)
      if (!xi) return
      extras.push({ info: xi, thumbs: pageThumbs(xi) })
      const d = extras.length
      const at = sel.size ? Math.max(...items.map((x, k) => (sel.has(x.id) ? k : -1))) + 1 : items.length
      mutate(() => items.splice(at, 0, ...xi.leaves.map((_, p) => ({ id: ++uid, doc: d, page: p, rotation: 0 }))))
      toast(`Inserted ${plural(xi.leaves.length, 'page')} from ${f.name}`)
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const selIdx = () => items.map((x, k) => (sel.has(x.id) ? k : -1)).filter((k) => k >= 0)
  const rot = (ids, d) => mutate(() => { for (const x of items) if (ids.has(x.id)) x.rotation = (x.rotation + d + 360) % 360 })
  const del = (ids) => {
    if (ids.size >= items.length) { toast('A PDF needs at least one page', { type: 'error' }); return }
    mutate(() => { items = items.filter((x) => !ids.has(x.id)); sel = new Set([...sel].filter((id) => !ids.has(id))) })
  }
  const dup = (ids) => mutate(() => {
    const out = []
    for (const x of items) { out.push(x); if (ids.has(x.id)) out.push({ ...x, id: ++uid }) }
    items = out
  })
  const blankAfter = (k) => {
    const d = dimsOf(items[k] ?? items[items.length - 1])
    const w = d.rotate % 180 === 0 ? d.w : d.h, hh = d.rotate % 180 === 0 ? d.h : d.w
    mutate(() => items.splice(k + 1, 0, { id: ++uid, blank: [w, hh], rotation: 0 }))
  }
  const moveSel = (where) => mutate(() => {
    const picked = items.filter((x) => sel.has(x.id))
    const rest = items.filter((x) => !sel.has(x.id))
    items = where === 'start' ? [...picked, ...rest] : [...rest, ...picked]
  })

  const click = (it, k, e) => {
    if (e.shiftKey && lastClick !== null) {
      const [a, b] = lastClick < k ? [lastClick, k] : [k, lastClick]
      for (let j = a; j <= b; j++) sel.add(items[j].id)
    } else if (sel.has(it.id)) sel.delete(it.id)
    else sel.add(it.id)
    lastClick = k
    paint()
  }

  const opsList = (keep) => keep.map((x) => (x.blank ? { blank: x.blank } : { doc: x.doc, page: x.page + 1, rotation: x.rotation }))
  const save = (only = null) => runTask((b) => { busy = b; paint() }, async () => {
    const keep = only ?? items
    const out = await organizePages(info.bytes, opsList(keep), { extra: extras.map((e) => e.info.bytes) })
    const name = `${stem(info.name)}${only ? '-selected' : '-organized'}.pdf`
    const blob = new Blob([out], { type: 'application/pdf' })
    if (only) { saveBlob(blob, name); toast(`Saved ${plural(keep.length, 'page')} as ${name}`); return }
    result = { blob, name, n: keep.length }
  })

  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return }
    if (!info || result || /input|textarea|select/i.test(e.target.tagName)) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
    else if (mod && k === 'a') { e.preventDefault(); sel = new Set(items.map((x) => x.id)); paint() }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); del(new Set(sel)) }
    else if (e.key === 'Escape' && sel.size) { sel = new Set(); paint() }
  }
  document.addEventListener('keydown', onKey)

  function paint() {
    if (!info) { render(ToolHead('organize'), Dropzone({ onFiles: load, title: 'Drop a PDF to rearrange its pages', tc: 'var(--c-organize)', icon: 'grid' })); return }
    if (result) {
      render(ToolHead('organize'), ResultCard({
        title: 'Pages organized', blob: result.blob, filename: result.name, toolId: 'organize', sub: `${result.name} · ${plural(result.n, 'page')}`,
        onAgain: () => { result = null; paint() },
      }))
      return
    }
    const grid = h('div', { class: 'pgrid' }, items.map((it, k) => PageCard({
      thumbs: it.blank ? null : docThumbs(it.doc), src: it.page, blank: !!it.blank, dims: dimsOf(it), rotation: it.rotation,
      label: `${k + 1}`, sub: it.blank ? 'blank' : it.doc ? `from ${extras[it.doc - 1].info.name.slice(0, 14)}` : it.page !== k ? `was ${it.page + 1}` : '',
      selected: sel.has(it.id), draggable: true,
      onClick: (e) => click(it, k, e),
      ops: [
        !it.blank ? { icon: 'zoomIn', tip: 'Preview', onClick: () => zoomPage(docInfo(it.doc), it.page, it.rotation) } : null,
        { icon: 'rotl', tip: 'Rotate left', onClick: () => rot(new Set([it.id]), -90) },
        { icon: 'rotate', tip: 'Rotate right', onClick: () => rot(new Set([it.id]), 90) },
        { icon: 'more', tip: 'More', onClick: () => {
          const btn = grid.children[k]?.querySelector('.pops button:last-child')
          menu(btn ?? grid, [
            { label: 'Duplicate', icon: 'copy', onClick: () => dup(new Set([it.id])) },
            { label: 'Insert blank page after', icon: 'pageAdd', onClick: () => blankAfter(k) },
            { label: 'Move to start', icon: 'up', onClick: () => mutate(() => { items.splice(k, 1); items.unshift(it) }) },
            { label: 'Move to end', icon: 'down', onClick: () => mutate(() => { items.splice(k, 1); items.push(it) }) },
            'sep',
            { label: 'Delete page', icon: 'trash', danger: true, onClick: () => del(new Set([it.id])) },
          ], { align: 'right' })
        } },
      ].filter(Boolean),
    })))
    sortable(grid, '.pcard', (from, to) => mutate(() => { const [x] = items.splice(from, 1); items.splice(to, 0, x) }))
    const n = sel.size
    const ids = new Set(sel)
    const removed = info.leaves.length + extras.reduce((a, e) => a + e.info.leaves.length, 0) - items.filter((x) => !x.blank).length
    render(
      ToolHead('organize'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'row between' },
            h('div', { class: 'row', style: { gap: '6px' } },
              IconButton('undo', 'Undo (Ctrl+Z)', undo, { disabled: !history.length }),
              IconButton('redo', 'Redo (Ctrl+Shift+Z)', redo, { disabled: !future.length }),
              h('span', { class: 'muted small' }, n ? `${plural(n, 'page')} selected` : 'Drag pages to reorder · click to select · Shift-click for a range')),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: n === items.length ? 'Clear' : 'Select all', size: 'sm', onClick: () => { sel = n === items.length ? new Set() : new Set(items.map((x) => x.id)); paint() } }))),
          n ? h('div', { class: 'card', style: { padding: '8px', position: 'sticky', top: '66px', zIndex: 5 } }, h('div', { class: 'row', style: { gap: '6px' } },
            Button({ label: 'Rotate left', icon: 'rotl', size: 'sm', onClick: () => rot(ids, -90) }),
            Button({ label: 'Rotate right', icon: 'rotate', size: 'sm', onClick: () => rot(ids, 90) }),
            Button({ label: 'Duplicate', icon: 'copy', size: 'sm', onClick: () => dup(ids) }),
            Button({ label: 'To start', icon: 'up', size: 'sm', onClick: () => moveSel('start') }),
            Button({ label: 'To end', icon: 'down', size: 'sm', onClick: () => moveSel('end') }),
            Button({ label: 'Save selected as PDF', icon: 'download', size: 'sm', onClick: () => save(items.filter((x) => ids.has(x.id))) }),
            Button({ label: 'Delete', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => del(ids) }))) : null,
          grid,
        ],
        [
          h('div', { class: 'card stack-sm' },
            h('div', { class: 'card-title' }, 'Add pages'),
            Button({ label: 'Blank page at end', icon: 'pageAdd', block: true, onClick: () => blankAfter(items.length - 1) }),
            Button({ label: 'Pages from another PDF', icon: 'files', block: true, onClick: insertPdf }),
            h('div', { class: 'divider' }),
            h('div', { class: 'card-title' }, 'Whole document'),
            Button({ label: 'Reverse page order', icon: 'refresh', block: true, onClick: () => mutate(() => items.reverse()) }),
            Button({ label: 'Reset all changes', icon: 'undo', block: true, disabled: !history.length && !extras.length, onClick: () => load([info.file]) })),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Saving…' : 'Save PDF', icon: 'download', variant: 'primary', size: 'lg', block: true, busy, onClick: () => save() }),
            h('div', { class: 'summary' }, `${plural(items.length, 'page')}${removed > 0 ? ` · ${removed} removed` : ''}`)),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
