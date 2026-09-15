import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, FileList } from '../ui/widgets.js'
import { mergePdfs, pageCount } from '../pdf/ops.js'

export function Merge() {
  let files = [] // {file, bytes, pages, err}
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

  const add = async (incoming) => {
    for (const f of incoming) {
      const entry = { name: f.name, size: f.size, file: f, bytes: null, pages: null, meta: 'reading…', err: null }
      files.push(entry)
      render()
      try {
        const bytes = await readBytes(f)
        entry.bytes = bytes
        entry.pages = await pageCount(bytes)
        entry.meta = `${entry.pages} page${entry.pages === 1 ? '' : 's'}`
      } catch {
        entry.err = 'not a readable PDF'
      }
      render()
    }
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
      saveBlob(new Blob([out], { type: 'application/pdf' }), 'merged.pdf')
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
              `Drag to reorder · ${good.length} valid · ${total} pages total`),
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
