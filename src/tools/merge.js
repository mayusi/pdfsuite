import { h, setKids, readBytes, saveBlob, fmtBytes } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, FileList } from '../ui/widgets.js'
import { parsePdf } from '../pdf/parse.js'
import { mergePdfs, pageLeaves } from '../pdf/ops.js'
import { renderPage } from '../pdf/render.js'

export function Merge() {
  let files = [] // {file, bytes, pages, doc, leaves, thumbNode, expanded, detail}
  let busy = false
  let error = ''
  let outName = 'merged'
  const root = h('div', { class: 'tool' })

  const add = async (incoming) => {
    for (const f of incoming) {
      const entry = {
        name: f.name, size: f.size, file: f,
        bytes: null, pages: null, doc: null, leaves: null, cache: new Map(),
        thumbNode: null, expanded: false, detail: null,
        meta: 'reading…', err: null,
      }
      entry.onExpand = () => expand(entry)
      files.push(entry)
      render()
      try {
        const bytes = await readBytes(f)
        entry.bytes = bytes
        const doc = await parsePdf(bytes)
        entry.doc = doc
        entry.leaves = pageLeaves(doc)
        entry.pages = entry.leaves.length
        entry.meta = `${entry.pages} page${entry.pages === 1 ? '' : 's'}`
        try {
          const canvas = await renderPage(doc, entry.leaves[0], { width: 72, cache: entry.cache })
          if (canvas) { canvas.className = 'thumb pcanvas-sm'; entry.thumbNode = canvas }
        } catch { /* no thumbnail — row keeps index */ }
      } catch {
        entry.err = 'not a readable PDF'
        entry.meta = ''
      }
      render()
    }
  }

  const expand = async (entry) => {
    entry.expanded = !entry.expanded
    if (!entry.expanded || !entry.leaves) { entry.detail = null; render(); return }
    const strip = h('div', { class: 'pstrip' }, h('span', { class: 'meta dim' }, 'rendering…'))
    entry.detail = strip
    render()
    for (let i = 0; i < entry.leaves.length; i++) {
      if (!entry.expanded) return // collapsed while rendering
      try {
        const c = await renderPage(entry.doc, entry.leaves[i], { width: 64, cache: entry.cache })
        if (c) {
          c.className = 'pcanvas-sm'
          c.title = `page ${i + 1}`
          strip.append(h('div', { class: 'pstrip-cell' }, c, h('span', { class: 'pstrip-n' }, `${i + 1}`)))
          if (i === 0) strip.firstChild.remove() // drop "rendering…"
        }
      } catch { /* skip page */ }
    }
    if (!strip.querySelectorAll('canvas').length) setKids(strip, h('span', { class: 'meta dim' }, 'no renderable pages'))
  }

  const move = (from, to) => {
    const c = [...files]
    const [x] = c.splice(from, 1)
    c.splice(to, 0, x)
    files = c
    render()
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const bad = files.find((f) => !f.bytes)
      if (bad) throw new Error(`"${bad.file.name}" isn't a readable PDF — remove it`)
      const out = await mergePdfs(files.map((f) => f.bytes))
      const name = (outName.trim() || 'merged').replace(/\.pdf$/i, '')
      saveBlob(new Blob([out], { type: 'application/pdf' }), `${name}.pdf`)
    } catch (e) {
      error = e.message || 'merge failed'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    const good = files.filter((f) => f.bytes)
    const total = good.reduce((n, f) => n + (f.pages || 0), 0)
    const estSize = good.reduce((n, f) => n + f.size, 0)
    setKids(root,
      DropZone({
        accept: 'application/pdf',
        multiple: true,
        onFiles: add,
        label: files.length ? 'Drop more PDFs to add them or ' : undefined,
      }),
      files.length
        ? Card(
            FileList({ files, onMove: move, onRemove: (i) => { files = files.filter((_, j) => j !== i); render() } }),
            h('p', { class: 'meta dim', style: { marginTop: '10px' } },
              `Drag to reorder · ${good.length} valid · ${total} pages total · ~${fmtBytes(estSize)} output`),
          )
        : null,
      files.length
        ? Card(
            h('label', { class: 'lbl' }, 'Output filename'),
            h('input', {
              class: 'textin', value: outName, placeholder: 'merged',
              oninput: (e) => (outName = e.target.value),
            }),
          )
        : null,
      ErrorText(error),
      Btn(busy ? 'Merging…' : `Merge ${good.length} PDFs · ${total} pages`, {
        onclick: run,
        disabled: busy || good.length < 2 || good.length !== files.length,
      }),
    )
  }
  render()
  return root
}
