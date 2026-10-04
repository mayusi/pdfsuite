import { h, icon, plural, stem } from '../ui/dom.js'
import { Button, IconButton, Dropzone, Field, Switch, TextInput, sortable } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, friendly } from '../ui/tool.js'
import { mergePdfs, parseRanges } from '../pdf/ops.js'
import { renderPage } from '../pdf/render.js'

export function Merge() {
  const { root, render } = mount()
  let files = [] // {id, file, info|null, err, thumb, range, rangeOk}
  let outName = 'merged'
  let bookmarks = true
  let busy = false
  let result = null
  let uid = 0

  const add = async (incoming) => {
    result = null
    for (const f of incoming) {
      const entry = { id: ++uid, file: f, info: null, err: null, thumb: null, range: '', rangeOk: true, loading: true }
      files.push(entry)
      paint()
      try {
        entry.info = await openPdf(f)
        if (!entry.info) { files = files.filter((x) => x !== entry); paint(); continue }
        const cv = await renderPage(entry.info.doc, entry.info.leaves[0], { width: 96 }).catch(() => null)
        entry.thumb = cv
      } catch (e) {
        entry.err = friendly(e, f.name)
      }
      entry.loading = false
      paint()
    }
  }

  const pagesOf = (e) => {
    if (!e.info) return []
    const n = e.info.leaves.length
    if (!e.range.trim()) return Array.from({ length: n }, (_, i) => i + 1)
    try { return parseRanges(e.range, n).flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, i) => from + i)) } catch { return null }
  }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const good = files.filter((f) => f.info)
    const pages = good.map(pagesOf)
    if (pages.some((p) => !p)) throw new Error('Fix the highlighted page ranges first')
    const out = await mergePdfs(good.map((f) => f.info.bytes), { names: bookmarks ? good.map((f) => stem(f.file.name)) : null, pages })
    const name = `${(outName.trim() || 'merged').replace(/\.pdf$/i, '')}.pdf`
    result = { blob: new Blob([out], { type: 'application/pdf' }), name, pages: pages.reduce((n, p) => n + p.length, 0) }
  })

  const move = (from, to) => { const [x] = files.splice(from, 1); files.splice(to, 0, x); paint() }

  function fileRow(e, i) {
    const n = e.info?.leaves.length
    const range = TextInput(e.range, (v) => {
      e.range = v
      e.rangeOk = pagesOf(e) !== null
      range.classList.toggle('bad', !e.rangeOk)
      meta.textContent = metaText()
      updateAction()
    }, { placeholder: `All ${n ?? ''} pages — or e.g. 1-3, 5` })
    range.style.height = '32px'
    range.style.maxWidth = '220px'
    if (!e.rangeOk) range.classList.add('bad')
    const metaText = () => {
      const p = pagesOf(e)
      return e.err ? '' : e.loading ? 'Reading…' : `${plural(n, 'page')}${p && p.length !== n ? ` · using ${p.length}` : ''}${e.info?.wasEncrypted ? ' · unlocked' : ''}`
    }
    const meta = h('span', { class: 'fmeta' }, metaText())
    return h('div', { class: 'fitem' },
      h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip', 'icon-sm')),
      h('div', { class: 'fthumb' }, e.thumb ?? h('div', { class: 'fc-icon', style: { width: '34px', height: '42px' } }, 'PDF')),
      h('div', { class: 'fmain' },
        h('span', { class: 'fname', title: e.file.name }, e.file.name),
        e.err ? h('span', { class: 'ferr' }, e.err) : h('div', { class: 'row', style: { gap: '8px' } }, meta, e.info ? range : null)),
      h('div', { class: 'facts' },
        IconButton('up', 'Move up', () => move(i, i - 1), { disabled: i === 0 }),
        IconButton('down', 'Move down', () => move(i, i + 1), { disabled: i === files.length - 1 }),
        IconButton('x', 'Remove', () => { files = files.filter((x) => x !== e); result = null; paint() })))
  }

  let actionBtn = null
  let summary = null
  const totals = () => {
    const good = files.filter((f) => f.info)
    const pages = good.map(pagesOf)
    return { good, pages: pages.every(Boolean) ? pages.reduce((n, p) => n + p.length, 0) : null }
  }
  const updateAction = () => {
    if (!actionBtn) return
    const { good, pages } = totals()
    const ok = good.length >= 2 && pages !== null && !files.some((f) => f.loading)
    actionBtn.disabled = !ok || busy
    summary.textContent = good.length < 2 ? 'Add at least two PDFs' : pages === null ? 'Check your page ranges' : `${plural(good.length, 'file')} · ${plural(pages, 'page')}`
  }

  function paint() {
    if (!files.length) {
      render(ToolHead('merge'), Dropzone({ multiple: true, onFiles: add, title: 'Drop the PDFs you want to combine', tc: 'var(--c-organize)', icon: 'merge' }))
      return
    }
    if (result) {
      render(ToolHead('merge'), ResultCard({
        title: 'Your PDFs are merged', blob: result.blob, filename: result.name, toolId: 'merge',
        sub: `${result.name} · ${plural(result.pages, 'page')}`,
        onAgain: () => { files = []; result = null; paint() },
      }))
      return
    }
    const list = h('div', { class: 'flist' }, files.map(fileRow))
    sortable(list, '.fitem', move, { horizontal: false, handle: '.grip' })
    actionBtn = Button({ label: busy ? 'Merging…' : 'Merge PDFs', icon: 'merge', variant: 'primary', size: 'lg', block: true, busy, onClick: run })
    summary = h('div', { class: 'summary' })
    render(
      ToolHead('merge'),
      Workspace(
        [
          h('div', { class: 'row between' },
            h('div', { class: 'muted small' }, 'Drag ', icon('grip', 'icon-sm'), ' to reorder. Leave the page box empty to use every page.'),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: 'A → Z', size: 'sm', onClick: () => { files.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true })); paint() } }),
              Button({ label: 'Reverse', size: 'sm', onClick: () => { files.reverse(); paint() } }))),
          list,
          Dropzone({ multiple: true, onFiles: add, compact: true, title: 'Add more PDFs' }),
        ],
        [
          h('div', { class: 'card stack' },
            Field('File name', TextInput(outName, (v) => (outName = v), { placeholder: 'merged' }), { hint: '.pdf' }),
            Switch('Bookmark each file', bookmarks, (v) => (bookmarks = v), { hint: 'Adds a bookmark per file; each file’s own bookmarks go inside it' })),
          h('div', { class: 'action-bar sticky-m' }, actionBtn, summary),
        ]),
    )
    updateAction()
  }

  const ho = takeHandoff()
  if (ho) add(Array.isArray(ho) ? ho : [ho])
  else paint()
  return root
}
