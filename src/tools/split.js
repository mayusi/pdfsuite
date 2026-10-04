import { h, plural, stem } from '../ui/dom.js'
import { Button, Dropzone, Field, Seg, Stepper, TextInput, FileChip, pickFiles, toast } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { PageCard, pageThumbs, zoomPage } from '../ui/pages.js'
import { extractPages, parseRanges, splitPdf } from '../pdf/ops.js'
import { zipStore } from '../zip.js'

/** Sorted set → "1-3, 5" */
export const selToSpec = (sel) => {
  const pgs = [...sel].sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < pgs.length; i++) {
    let j = i
    while (j + 1 < pgs.length && pgs[j + 1] === pgs[j] + 1) j++
    parts.push(pgs[i] === pgs[j] ? `${pgs[i]}` : `${pgs[i]}-${pgs[j]}`)
    i = j
  }
  return parts.join(', ')
}

export function Split() {
  const { root, render } = mount()
  let info = null
  let thumbs = null
  let mode = 'select' // select | ranges | every | each
  let sel = new Set()
  let last = null
  let spec = ''
  let rangesSpec = ''
  let everyN = 2
  let busy = false
  let result = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      thumbs?.disconnect()
      thumbs = pageThumbs(info)
      const n = info.leaves.length
      sel = new Set()
      spec = ''
      rangesSpec = n > 1 ? `1-${Math.ceil(n / 2)}, ${Math.ceil(n / 2) + 1}-${n}` : '1'
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const N = () => info?.leaves.length ?? 0
  const groups = () => { // [{from,to}] for the current mode, or null if invalid
    const n = N()
    try {
      if (mode === 'select') return sel.size ? parseRanges(selToSpec(sel), n) : []
      if (mode === 'ranges') return parseRanges(rangesSpec, n)
      if (mode === 'every') return Array.from({ length: Math.ceil(n / everyN) }, (_, k) => ({ from: k * everyN + 1, to: Math.min(n, (k + 1) * everyN) }))
      return Array.from({ length: n }, (_, k) => ({ from: k + 1, to: k + 1 }))
    } catch { return null }
  }

  const toggle = (p, shift) => {
    if (shift && last !== null) {
      const [a, b] = last < p ? [last, p] : [p, last]
      for (let x = a; x <= b; x++) sel.add(x)
    } else sel.has(p) ? sel.delete(p) : sel.add(p)
    last = p
    spec = selToSpec(sel)
    paint()
  }
  const preset = (kind) => {
    const all = Array.from({ length: N() }, (_, i) => i + 1)
    sel = new Set(kind === 'all' ? all : kind === 'none' ? [] : kind === 'invert' ? all.filter((p) => !sel.has(p)) : all.filter((p) => (kind === 'odd') === (p % 2 === 1)))
    last = null
    spec = selToSpec(sel)
    paint()
  }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const g = groups()
    if (!g?.length) throw new Error('Nothing to extract')
    const base = stem(info.name)
    if (mode === 'select') {
      const out = await extractPages(info.bytes, g)
      result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${base}-pages-${selToSpec(sel).replace(/\s/g, '')}.pdf`, n: 1 }
    } else {
      const outs = await splitPdf(info.bytes, g)
      if (outs.length === 1) {
        result = { blob: new Blob([outs[0]], { type: 'application/pdf' }), name: `${base}-${g[0].from}-${g[0].to}.pdf`, n: 1 }
      } else {
        const zip = zipStore(outs.map((o, k) => ({ name: `${base}-${g[k].from === g[k].to ? `p${g[k].from}` : `${g[k].from}-${g[k].to}`}.pdf`, data: o })))
        result = { blob: new Blob([zip], { type: 'application/zip' }), name: `${base}-split.zip`, n: outs.length }
      }
    }
  })

  function paint() {
    if (!info) { render(ToolHead('split'), Dropzone({ onFiles: load, title: 'Drop the PDF you want to split', tc: 'var(--c-organize)', icon: 'scissors' })); return }
    if (result) {
      render(ToolHead('split'), ResultCard({
        title: result.n > 1 ? `Split into ${result.n} files` : 'Pages extracted', blob: result.blob, filename: result.name, toolId: 'split',
        onAgain: () => { result = null; paint() },
      }))
      return
    }
    const g = groups()
    // which output file each page lands in (for the badges)
    const fileOf = new Map()
    g?.forEach((r, k) => { for (let p = r.from; p <= r.to; p++) if (!fileOf.has(p)) fileOf.set(p, k + 1) })
    let grid = h('div', { class: 'pgrid' }, info.leaves.map((_, i) => {
      const p = i + 1
      const inOut = fileOf.has(p)
      return PageCard({
        thumbs, src: i, dims: info.dims[i], label: `${p}`,
        sub: mode !== 'select' && inOut && g.length > 1 ? `→ file ${fileOf.get(p)}` : '',
        selected: mode === 'select' ? sel.has(p) : undefined,
        off: mode !== 'select' && !inOut,
        onClick: mode === 'select' ? (e) => toggle(p, e.shiftKey) : null,
        ops: [{ icon: 'zoomIn', tip: 'Preview', onClick: () => zoomPage(info, i) }],
      })
    }))
    const specInput = TextInput(spec, (v) => {
      spec = v
      try {
        sel = new Set(v.trim() ? parseRanges(v, N()).flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, k) => from + k)) : [])
        specInput.classList.remove('bad')
        paintGridOnly()
      } catch { specInput.classList.add('bad') }
    }, { placeholder: 'e.g. 1-3, 7, 10-12' })
    const rangesInput = TextInput(rangesSpec, (v) => {
      rangesSpec = v
      const ok = groups() !== null
      rangesInput.classList.toggle('bad', !ok)
      if (ok) paintGridOnly()
    }, { placeholder: 'e.g. 1-3, 4-8, 9-12' })
    const outCount = g?.length ?? 0
    const pagesOut = g ? g.reduce((n, r) => n + r.to - r.from + 1, 0) : 0
    const label = mode === 'select' ? (sel.size ? `Extract ${plural(sel.size, 'page')}` : 'Select pages to extract')
      : g === null ? 'Fix the ranges' : `Split into ${plural(outCount, 'file')}`
    render(
      ToolHead('split'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          mode === 'select' ? h('div', { class: 'row between' },
            h('span', { class: 'muted small' }, 'Click pages to pick them · Shift-click selects a range'),
            h('div', { class: 'row', style: { gap: '6px' } },
              ['all', 'none', 'odd', 'even', 'invert'].map((k) => Button({ label: k[0].toUpperCase() + k.slice(1), size: 'sm', onClick: () => preset(k) })))) : null,
          grid,
        ],
        [
          h('div', { class: 'card stack' },
            Field('How to split', Seg([['select', 'Pick pages'], ['ranges', 'Ranges'], ['every', 'Every N'], ['each', 'Each page']], mode, (v) => { mode = v; paint() }, { block: true })),
            mode === 'select' ? Field('Pages', specInput, { hint: 'synced with your picks' })
              : mode === 'ranges' ? Field('Ranges — one file per range', rangesInput)
              : mode === 'every' ? Field('Pages per file', Stepper(everyN, { min: 1, max: Math.max(1, N()) }, (v) => { everyN = v; paint() }))
              : h('p', { class: 'muted small', style: { margin: 0 } }, `Every page becomes its own PDF — ${plural(N(), 'file')} in a ZIP.`),
            h('p', { class: 'muted small', style: { margin: 0 } }, mode === 'select'
              ? 'Selected pages are saved together as one new PDF.'
              : `${plural(pagesOut, 'page')} → ${plural(outCount, 'PDF')}${outCount > 1 ? ', downloaded as a ZIP' : ''}.`)),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Working…' : label, icon: 'scissors', variant: 'primary', size: 'lg', block: true, busy, disabled: !outCount, onClick: run })),
        ]),
    )
    function paintGridOnly() { // keep text inputs focused while typing
      const fresh = h('div', { class: 'pgrid' }, info.leaves.map((_, i) => {
        const p = i + 1
        const gg = groups() ?? []
        const inOut = gg.some((r) => p >= r.from && p <= r.to)
        return PageCard({
          thumbs, src: i, dims: info.dims[i], label: `${p}`,
          selected: mode === 'select' ? sel.has(p) : undefined, off: mode !== 'select' && !inOut,
          onClick: mode === 'select' ? (e) => toggle(p, e.shiftKey) : null,
          ops: [{ icon: 'zoomIn', tip: 'Preview', onClick: () => zoomPage(info, i) }],
        })
      }))
      grid.replaceWith(fresh)
      grid = fresh
      const btn = root.querySelector('.action-bar .btn')
      const gg = groups()
      if (btn) {
        btn.disabled = !(gg?.length)
        btn.lastChild.textContent = mode === 'select' ? (sel.size ? `Extract ${plural(sel.size, 'page')}` : 'Select pages to extract') : gg === null ? 'Fix the ranges' : `Split into ${plural(gg.length, 'file')}`
      }
    }
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
