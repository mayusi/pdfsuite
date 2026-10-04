import { h, stem, saveBlob, plural } from '../ui/dom.js'
import { Button, Dropzone, Switch, FileChip, Progress, pickFiles, toast, Callout } from '../ui/kit.js'
import { ToolHead, Workspace, openPdf, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { pageText } from '../pdf/content.js'

/** Undo hard line-wrapping: join lines inside paragraphs, fix hyphenation. */
function reflow(text) {
  return text.split(/\n{2,}/).map((para) => para
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/([^\n.!?:;])\n(?=[a-zà-ÿ0-9(“"'])/g, '$1 ')
  ).join('\n\n')
}

export function PdfToText() {
  const { root, render } = mount()
  let info = null
  let pages = []
  let markers = true
  let paragraphs = false
  let loading = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      pages = []
      loading = Progress(0)
      paint()
      for (let k = 0; k < info.leaves.length; k++) {
        pages.push(await pageText(info.doc, info.leaves[k]).catch(() => ''))
        loading.set((k + 1) / info.leaves.length)
        if (k % 5 === 4) await new Promise((r) => setTimeout(r))
      }
      loading = null
      paint()
    } catch (e) { loading = null; toast(e.message, { type: 'error' }); paint() }
  }

  const fullText = () => pages.map((t, k) => {
    const body = paragraphs ? reflow(t) : t
    return markers ? `——— Page ${k + 1} ———\n${body}` : body
  }).join(markers ? '\n\n' : '\n\n')

  function paint() {
    if (!info) { render(ToolHead('pdftext'), Dropzone({ onFiles: load, title: 'Drop a PDF to pull its text out', tc: 'var(--c-convert)', icon: 'filetext' })); return }
    const text = loading ? '' : fullText()
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    const empty = !loading && pages.every((p) => !p.trim())
    const area = h('textarea', { class: 'textout', readonly: true, spellcheck: 'false' })
    area.value = text
    render(
      ToolHead('pdftext'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          loading ? h('div', { class: 'card card-pad stack-sm' }, h('span', { class: 'muted small' }, 'Reading pages…'), loading) : null,
          empty ? Callout('No text found. This PDF is probably scanned images — the pages are pictures of text, not text. (OCR would be needed.)', { type: 'warn' }) : null,
          loading ? null : area,
        ],
        [
          h('div', { class: 'card stack' },
            Switch('Page markers', markers, (v) => { markers = v; paint() }, { hint: 'A line between pages' }),
            Switch('Join lines into paragraphs', paragraphs, (v) => { paragraphs = v; paint() }, { hint: 'Undo hard line breaks and hyphenation' }),
            h('p', { class: 'muted small', style: { margin: 0 } }, `${plural(words, 'word')} · ${plural(pages.length, 'page')}`)),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: 'Copy text', icon: 'copy', variant: 'primary', size: 'lg', block: true, disabled: !!loading || !words, onClick: async () => {
              try { await navigator.clipboard.writeText(fullText()); toast('Copied to clipboard') } catch { area.select(); document.execCommand('copy'); toast('Copied') }
            } }),
            Button({ label: 'Download .txt', icon: 'download', block: true, disabled: !!loading || !words, onClick: () => saveBlob(new Blob([fullText()], { type: 'text/plain;charset=utf-8' }), `${stem(info.name)}.txt`) })),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
