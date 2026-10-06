// Crop PDF — drag a crop box over a page preview (or auto-detect the content
// margins) and apply it to every page, the current page, or odd / even pages.
// Cropping sets the visible page box; nothing outside it is shown or printed.
import { h, plural, stem, yieldUI } from '../ui/dom.js'
import { Button, Dropzone, FileChip, Field, Seg, Stepper, pickFiles, toast } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { renderPage } from '../pdf/render.js'
import { cropPages } from '../pdf/stamp.js'

const NONE = { l: 0, t: 0, r: 0, b: 0 } // margins as fractions of the page

/** Content bounds of a rendered page → margins (fractions), with a little breathing room. */
export function contentMargins(rgba, w, h, { pad = 0.015, threshold = 245 } = {}) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (rgba[i] < threshold || rgba[i + 1] < threshold || rgba[i + 2] < threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return { ...NONE } // blank page: leave it alone
  const c = (v) => Math.max(0, Math.min(0.45, v))
  return { l: c(x0 / w - pad), t: c(y0 / h - pad), r: c(1 - (x1 + 1) / w - pad), b: c(1 - (y1 + 1) / h - pad) }
}

export function Crop() {
  const { root, render } = mount()
  let info = null
  let cur = 0
  let scope = 'all'
  let margins = [] // per page
  let busy = false
  let result = null
  let preview = null // {i, canvas}
  const cache = new Map()

  const dispDims = (i) => {
    const d = info.dims[i]
    return d.rotate % 180 === 0 ? { w: d.w, h: d.h } : { w: d.h, h: d.w }
  }
  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      cur = 0
      margins = info.leaves.map(() => ({ ...NONE }))
      result = null
      preview = null
      cache.clear()
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }
  const inScope = (i) => scope === 'all' || (scope === 'current' ? i === cur : scope === 'odd' ? i % 2 === 0 : i % 2 === 1)
  const setMargins = (m) => { margins = margins.map((old, i) => (inScope(i) ? { ...m } : old)) }
  const cropped = () => margins.filter((m) => m.l || m.t || m.r || m.b).length

  const autoDetect = () => runTask((b) => { busy = b; paint() }, async () => {
    for (let i = 0; i < info.leaves.length; i++) {
      if (!inScope(i)) continue
      const cv = await renderPage(info.doc, info.leaves[i], { width: 300, cache })
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height)
      margins[i] = contentMargins(d.data, cv.width, cv.height)
      await yieldUI()
    }
    toast('Margins detected — adjust the box if needed', { type: 'info' })
  })

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const rects = margins.map((m, i) => {
      if (!(m.l || m.t || m.r || m.b)) return null
      const { w, h: hh } = dispDims(i)
      return { x: m.l * w, y: m.t * hh, w: (1 - m.l - m.r) * w, h: (1 - m.t - m.b) * hh }
    })
    const out = await cropPages(info.bytes, rects)
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}-cropped.pdf` }
  })

  /** Page preview with a draggable crop box. */
  function Stage() {
    const m = margins[cur]
    const wrap = h('div', { class: 'crop-stage' })
    const box = h('div', { class: 'crop-box' }, ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => h('span', { class: `crop-h ${k}`, 'data-h': k })))
    const place = () => Object.assign(box.style, { left: `${m.l * 100}%`, top: `${m.t * 100}%`, right: `${m.r * 100}%`, bottom: `${m.b * 100}%` })
    place()
    const draw = (cv) => { cv.classList.add('crop-cv'); wrap.prepend(cv) }
    if (preview?.i === cur) draw(preview.canvas)
    else {
      const { w, h: hh } = dispDims(cur)
      wrap.style.aspectRatio = `${w} / ${hh}`
      renderPage(info.doc, info.leaves[cur], { width: 900, cache }).then((cv) => {
        preview = { i: cur, canvas: cv }
        if (wrap.isConnected) { wrap.style.aspectRatio = ''; draw(cv) }
      }).catch(() => {})
    }
    let drag = null
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try { box.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
      drag = { h: e.target.dataset.h ?? 'move', x: e.clientX, y: e.clientY, m: { ...m }, r: wrap.getBoundingClientRect() }
    })
    box.addEventListener('pointermove', (e) => {
      if (!drag) return
      const dx = (e.clientX - drag.x) / drag.r.width, dy = (e.clientY - drag.y) / drag.r.height
      const o = drag.m, min = 0.05
      const k = drag.h
      if (k === 'move') {
        const mx = Math.max(-o.l, Math.min(o.r, dx)), my = Math.max(-o.t, Math.min(o.b, dy))
        Object.assign(m, { l: o.l + mx, r: o.r - mx, t: o.t + my, b: o.b - my })
      } else {
        if (k.includes('w')) m.l = Math.max(0, Math.min(1 - o.r - min, o.l + dx))
        if (k.includes('e')) m.r = Math.max(0, Math.min(1 - o.l - min, o.r - dx))
        if (k.includes('n')) m.t = Math.max(0, Math.min(1 - o.b - min, o.t + dy))
        if (k.includes('s')) m.b = Math.max(0, Math.min(1 - o.t - min, o.b - dy))
      }
      place()
    })
    const end = () => { if (!drag) return; drag = null; setMargins(m); paint() }
    box.addEventListener('pointerup', end)
    box.addEventListener('pointercancel', end)
    wrap.append(box)
    return wrap
  }

  function marginInputs() {
    const m = margins[cur]
    const { w, h: hh } = dispDims(cur)
    const mm = (frac, size) => Math.round(((frac * size) / 72) * 25.4)
    const set = (k, size) => (v) => {
      const f = Math.max(0, (v / 25.4) * 72) / size
      const opp = { l: 'r', r: 'l', t: 'b', b: 't' }[k]
      m[k] = Math.min(f, 0.95 - m[opp])
      setMargins(m)
      paint()
    }
    return h('div', { class: 'crop-mm' },
      Field('Top (mm)', Stepper(mm(m.t, hh), { min: 0, max: 999 }, set('t', hh))),
      Field('Bottom (mm)', Stepper(mm(m.b, hh), { min: 0, max: 999 }, set('b', hh))),
      Field('Left (mm)', Stepper(mm(m.l, w), { min: 0, max: 999 }, set('l', w))),
      Field('Right (mm)', Stepper(mm(m.r, w), { min: 0, max: 999 }, set('r', w))))
  }

  function paint() {
    if (!info) { render(ToolHead('crop'), Dropzone({ onFiles: load, title: 'Drop a PDF to crop', tc: 'var(--c-organize)', icon: 'crop' })); return }
    if (result) { render(ToolHead('crop'), ResultCard({ title: 'PDF cropped', blob: result.blob, filename: result.name, toolId: 'crop', onAgain: () => { result = null; paint() } })); return }
    const n = info.leaves.length
    const done = cropped()
    const go = (i) => { cur = Math.max(0, Math.min(n - 1, i)); paint() }
    render(
      ToolHead('crop'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('p', { class: 'muted small', style: { margin: 0 } }, 'Drag the edges or corners of the box. Everything outside it is cut off.'),
          h('div', { class: 'crop-nav' },
            Button({ icon: 'chevLeft', size: 'sm', tip: 'Previous page', disabled: cur === 0, onClick: () => go(cur - 1) }),
            h('span', {}, `Page ${cur + 1} of ${n}`),
            Button({ icon: 'chevRight', size: 'sm', tip: 'Next page', disabled: cur === n - 1, onClick: () => go(cur + 1) })),
          Stage(),
        ],
        [
          h('div', { class: 'card stack' },
            Field('Apply to', Seg([['all', 'All pages'], ['current', 'This page'], ['odd', 'Odd'], ['even', 'Even']], scope, (v) => { scope = v; paint() }, { block: true })),
            marginInputs(),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: 'Auto-detect margins', icon: 'wand', disabled: busy, onClick: autoDetect }),
              Button({ label: 'Reset', icon: 'undo', size: 'sm', disabled: !done, onClick: () => { margins = margins.map(() => ({ ...NONE })); paint() } }))),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Working…' : 'Save cropped PDF', icon: 'download', variant: 'primary', size: 'lg', block: true, busy, disabled: !done, onClick: run }),
            h('div', { class: 'summary' }, done ? `${plural(done, 'page')} will be cropped` : 'Nothing cropped yet')),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
