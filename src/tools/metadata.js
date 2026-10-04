import { h, stem } from '../ui/dom.js'
import { Button, Dropzone, Field, Switch, TextInput, FileChip, pickFiles, toast, Callout } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { readMetadata, scrubPdf } from '../pdf/ops.js'
import { setMetadata } from '../pdf/stamp.js'
import { deref } from '../pdf/parse.js'
import { get } from '../pdf/types.js'

const EDITABLE = [['Title', 'Title'], ['Author', 'Author'], ['Subject', 'Subject'], ['Keywords', 'Keywords']]
const LABELS = { Creator: 'Created with', Producer: 'PDF made by', CreationDate: 'Created', ModDate: 'Modified', Trapped: 'Trapped' }
const PDF_DATE = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/

/** "D:20240102153000+01'00'" → readable date. */
function pdfDate(s) {
  const m = String(s).match(PDF_DATE)
  if (!m) return s
  const d = new Date(Date.UTC(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0))
  return Number.isNaN(+d) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function Metadata() {
  const { root, render } = mount()
  let info = null
  let meta = null
  let edits = {}
  let comments = 0
  let removeComments = true
  let busy = false
  let result = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      meta = await readMetadata(info.bytes)
      edits = Object.fromEntries(EDITABLE.map(([k]) => [k, meta.fields.find((x) => x.key === k)?.value ?? '']))
      comments = 0
      for (const leaf of info.leaves) {
        const an = deref(info.doc, get(leaf.dict, 'Annots'))
        if (!Array.isArray(an)) continue
        for (const r of an) {
          const a = deref(info.doc, r)
          const st = a instanceof Map ? get(a, 'Subtype')?.v : null
          if (st && st !== 'Link' && st !== 'Widget') comments++
        }
      }
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const save = () => runTask((b) => { busy = b; paint() }, async () => {
    const out = await setMetadata(info.bytes, edits)
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}.pdf`, title: 'Metadata updated' }
  })
  const wipe = () => runTask((b) => { busy = b; paint() }, async () => {
    const out = await scrubPdf(info.bytes, { removeComments })
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}-clean.pdf`, title: 'All hidden data removed' }
  })

  function paint() {
    if (!info) { render(ToolHead('metadata'), Dropzone({ onFiles: load, title: 'Drop a PDF to inspect its hidden data', tc: 'var(--c-secure)', icon: 'eraser' })); return }
    if (result) {
      render(ToolHead('metadata'), ResultCard({ title: result.title, blob: result.blob, filename: result.name, toolId: 'metadata', onAgain: () => load([new File([result.blob], result.name, { type: 'application/pdf' })]) }))
      return
    }
    const other = meta.fields.filter((f) => !EDITABLE.some(([k]) => k === f.key))
    const rows = [
      ...other.map((f) => [LABELS[f.key] ?? f.key, /Date$/.test(f.key) ? pdfDate(f.value) : f.value]),
      meta.xmp ? ['XMP packet', 'Embedded metadata (often holds the same info, plus edit history)'] : null,
      meta.id ? ['Document ID', 'A unique fingerprint that can link copies of this file'] : null,
      comments ? ['Comments', `${comments} annotation${comments === 1 ? '' : 's'} — may include author names`] : null,
    ].filter(Boolean)
    render(
      ToolHead('metadata'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'card card-pad stack' },
            h('div', { class: 'card-title' }, 'Document properties'),
            EDITABLE.map(([k, label]) => Field(label, TextInput(edits[k], (v) => (edits[k] = v), { placeholder: `No ${label.toLowerCase()}` }))),
            Button({ label: busy ? 'Saving…' : 'Save properties', icon: 'save', busy, onClick: save })),
          h('div', { class: 'card card-pad stack-sm' },
            h('div', { class: 'card-title' }, 'Hidden data in this file'),
            rows.length
              ? h('table', { class: 'mtable' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', { class: 'mkey' }, k), h('td', { class: 'mval leak' }, v)))))
              : Callout('Nothing hidden here — this file is already clean.', { type: 'ok' })),
        ],
        [
          h('div', { class: 'card stack' },
            h('div', { class: 'card-title' }, 'Remove everything'),
            h('p', { class: 'muted small', style: { margin: 0 } }, 'Strips properties, XMP, the document ID and app data. Pages, links, bookmarks and form fields are kept.'),
            Switch('Also remove comments', removeComments, (v) => (removeComments = v), { hint: 'Sticky notes, highlights and other markup' })),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Cleaning…' : 'Remove all hidden data', icon: 'eraser', variant: 'primary', size: 'lg', block: true, busy, onClick: wipe })),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
