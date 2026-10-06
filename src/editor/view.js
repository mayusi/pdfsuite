// One editor page: base raster (lazy, zoom-aware, memory-released when far
// away), overlay canvas for objects + selection + guides, DOM layers for inline
// text editing and form fields, and every tool's pointer gesture (mouse, pen,
// touch: pinch/two-finger pan, long-press menus, Apple Pencil palm rejection).
import { h } from '../ui/dom.js'
import { collectDrawOps } from '../pdf/content.js'
import { paintOps } from '../pdf/render.js'
import { textRuns, sameBox } from '../pdf/redact.js'
import {
  annBox, annBounds, annHit, annClone, annMove, annResize, annDraw, drawSelection, handleAt, keepsAspect, cursorFor,
  smooth, textBox, fontCssOf, LINE_H, eraseFrom,
} from './annots.js'

const MAX_PX = 4096 * 4096 * 0.9
const DRAW_TOOLS = new Set(['draw', 'highlight', 'erase', 'shape', 'whiteout', 'redact', 'link'])

/** Map a point from the page's ORIGINAL display space into its rotated space. */
export function rotPt(x, y, rot, W0, H0) {
  if (rot === 90) return [H0 - y, x]
  if (rot === 180) return [W0 - x, H0 - y]
  if (rot === 270) return [y, W0 - x]
  return [x, y]
}

export function createPageView(ed, page) {
  const el = h('div', { class: 'ed-page', 'data-id': String(page.id) })
  const base = h('canvas', { class: 'ed-base' })
  const over = h('canvas', { class: 'ed-over' })
  const label = h('div', { class: 'ed-plabel' })
  const fieldLayer = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } })
  el.append(base, over, fieldLayer, label)
  const octx = over.getContext('2d')
  const v = { el, page, base, over, rendered: 0, renderGen: 0, near: false, runs: null }

  // ---------- geometry ----------
  v.size = () => ({ w: page.w * ed.zoom, h: page.h * ed.zoom })
  v.layout = () => {
    const { w, h: hh } = v.size()
    el.style.width = `${w}px`
    el.style.height = `${hh}px`
    label.textContent = `${ed.pages.indexOf(page) + 1}`
    layoutFields()
  }
  const toPt = (cx, cy) => {
    const r = over.getBoundingClientRect()
    return [((cx - r.left) / r.width) * page.w, ((cy - r.top) / r.height) * page.h]
  }
  const S = () => over.width / page.w // canvas px per pt
  const cssPerPt = () => over.getBoundingClientRect().width / page.w || ed.zoom
  const origDims = () => ({ W0: page.rot % 180 ? page.h : page.w, H0: page.rot % 180 ? page.w : page.h })
  const removedImgs = () => page.annots.filter((a) => a.t === 'imgremove').map((a) => a.region)

  // ---------- base raster ----------
  v.render = async () => {
    const my = ++v.renderGen
    const dpr = Math.min(2.5, self.devicePixelRatio || 1)
    let scale = ed.zoom * dpr
    if (page.w * page.h * scale * scale > MAX_PX) scale = Math.sqrt(MAX_PX / (page.w * page.h))
    const bw = Math.max(2, Math.round(page.w * scale)), bh = Math.max(2, Math.round(page.h * scale))
    const off = document.createElement('canvas')
    off.width = bw
    off.height = bh
    const c = off.getContext('2d')
    c.fillStyle = '#fff'
    c.fillRect(0, 0, bw, bh)
    if (page.src !== null) {
      try {
        page.ops ??= (await collectDrawOps(ed.doc, ed.info.leaves[page.src], { widgets: !ed.fields.length })).ops
        if (my !== v.renderGen) return
        const { W0, H0 } = origDims()
        if (page.rot === 90) c.setTransform(0, 1, -1, 0, bw, 0)
        else if (page.rot === 180) c.setTransform(-1, 0, 0, -1, bw, bh)
        else if (page.rot === 270) c.setTransform(0, -1, 1, 0, 0, bh)
        const sx = (page.rot % 180 ? bh : bw) / W0
        const holes = page.annots.filter((a) => a.t === 'textedit').map((a) => a.region)
        const hideGlyph = holes.length ? (x, y) => {
          const [rx, ry] = rotPt(x, y, page.rot, W0, H0)
          return holes.some((r) => rx >= r.x && rx <= r.x + r.w && ry >= r.y && ry <= r.y + r.h)
        } : null
        const gone = removedImgs()
        const rb = (bb) => { // op bbox (original space) → rotated display space, where regions live
          if (!page.rot) return bb
          const [x1, y1] = rotPt(bb[0], bb[1], page.rot, W0, H0), [x2, y2] = rotPt(bb[2], bb[3], page.rot, W0, H0)
          return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
        }
        const hide = gone.length ? (op) => op.t === 'img' && gone.some((r) => sameBox(rb(op.bbox), r)) : null
        if (page.rot) { // paintOps sets its own transform: bake rotation via an intermediate canvas
          const tmp = document.createElement('canvas')
          tmp.width = Math.round(W0 * sx)
          tmp.height = Math.round(H0 * sx)
          const tc = tmp.getContext('2d')
          tc.fillStyle = '#fff'
          tc.fillRect(0, 0, tmp.width, tmp.height)
          await paintOps(tc, ed.doc, page.ops, sx, ed.imgCache, { hideGlyph, hide })
          c.drawImage(tmp, 0, 0)
        } else await paintOps(c, ed.doc, page.ops, sx, ed.imgCache, { hideGlyph, hide })
      } catch (e) { console.warn('page render failed', e) }
    }
    if (my !== v.renderGen) return
    base.width = bw
    base.height = bh
    base.getContext('2d').drawImage(off, 0, 0)
    if (over.width !== bw || over.height !== bh) { over.width = bw; over.height = bh }
    v.rendered = ed.zoom
    v.redraw()
  }
  v.release = () => {
    v.renderGen++
    base.width = 1; base.height = 1
    over.width = 1; over.height = 1
    v.rendered = 0
  }

  // ---------- overlay ----------
  let guides = []
  v.redraw = () => {
    if (over.width < 4) return
    const s = S()
    const u = s / cssPerPt()
    octx.setTransform(1, 0, 0, 1, 0, 0)
    octx.clearRect(0, 0, over.width, over.height)
    const bmp = (a) => ed.bitmap(a)
    const cropA = ed.cropping?.page === page ? ed.cropping.a : null
    for (const a of page.annots) if (a !== cropA) annDraw(octx, a, s, { bmp, editingId: ed.editing?.a.id })
    if (draft) annDraw(octx, draft, s, { bmp })
    if (cropA) drawCrop(cropA, s, u)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#10b981'
    if (hoverRun && (ed.tool === 'edittext' || ed.tool === 'redact')) outlineBox(hoverRun, ed.tool === 'redact' ? '#e03131' : '#2563eb', s)
    if (hoverImg && ed.tool === 'select' && !drag) outlineBox(hoverImg, '#2563eb', s)
    if (ed.pdfImg?.page === page) outlineBox(ed.pdfImg.box, '#2563eb', s, false, true)
    if (marquee) {
      octx.save()
      octx.fillStyle = 'rgba(16,185,129,.08)'
      octx.strokeStyle = accent
      octx.setLineDash([4 * u, 3 * u])
      octx.lineWidth = u
      octx.fillRect(marquee.x * s, marquee.y * s, marquee.w * s, marquee.h * s)
      octx.strokeRect(marquee.x * s, marquee.y * s, marquee.w * s, marquee.h * s)
      octx.restore()
    }
    if (eraserAt) {
      octx.save()
      octx.strokeStyle = '#868e96'
      octx.lineWidth = u
      octx.setLineDash([3 * u, 3 * u])
      octx.beginPath(); octx.arc(eraserAt[0] * s, eraserAt[1] * s, ed.style.eraserSize * s, 0, 7); octx.stroke()
      octx.restore()
    }
    if (ed.sel?.page === page && !cropA) {
      const many = ed.selSet.size > 1
      for (const a of ed.selSet) {
        if (!page.annots.includes(a) || ed.editing?.a === a) continue
        drawSelection(octx, a, s, u, accent, { hs: ed.touchUI ? 9 : 5, primary: !many && a === ed.sel.a })
      }
      if (many) {
        const b = groupBoundsOf([...ed.selSet])
        const p = 4 / cssPerPt()
        octx.save()
        octx.strokeStyle = accent
        octx.lineWidth = u
        octx.setLineDash([2 * u, 3 * u])
        octx.strokeRect((b.x - p) * s, (b.y - p) * s, (b.w + 2 * p) * s, (b.h + 2 * p) * s)
        octx.restore()
      }
    }
    if (guides.length) {
      octx.save()
      octx.strokeStyle = '#f03e3e'
      octx.lineWidth = u
      for (const g of guides) {
        octx.beginPath()
        if (g.x !== undefined) { octx.moveTo(g.x * s, 0); octx.lineTo(g.x * s, over.height) } else { octx.moveTo(0, g.y * s); octx.lineTo(over.width, g.y * s) }
        octx.stroke()
      }
      octx.restore()
    }
  }
  function outlineBox(r, color, s, dashed = true, strong = false) {
    octx.save()
    octx.strokeStyle = color
    octx.fillStyle = strong ? 'rgba(37,99,235,.10)' : 'rgba(37,99,235,.05)'
    octx.lineWidth = Math.max(1, s * (strong ? 1 : 0.6))
    if (dashed) octx.setLineDash([4, 3])
    octx.fillRect((r.x - 1) * s, (r.y - 1) * s, (r.w + 2) * s, (r.h + 2) * s)
    octx.strokeRect((r.x - 1) * s, (r.y - 1) * s, (r.w + 2) * s, (r.h + 2) * s)
    octx.restore()
  }
  const groupBoundsOf = (list) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const a of list) { const b = annBounds(a); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h) }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  // ---------- image crop mode ----------
  // the full (uncropped) image stays put; the crop window is edited in source px
  const fullBox = (a) => {
    const c = a.crop ?? { x: 0, y: 0, w: a.iw, h: a.ih }
    const kx = a.w / c.w, ky = a.h / c.h
    return { x: a.x - c.x * kx, y: a.y - c.y * ky, w: a.iw * kx, h: a.ih * ky, kx, ky }
  }
  function drawCrop(a, s, u) {
    const fb = fullBox(a)
    const full = ed.bitmap(a, { full: true })
    octx.save()
    octx.globalAlpha = 0.35
    if (full?.src) octx.drawImage(full.src, fb.x * s, fb.y * s, fb.w * s, fb.h * s)
    octx.globalAlpha = 1
    octx.beginPath(); octx.rect(a.x * s, a.y * s, a.w * s, a.h * s); octx.clip()
    if (full?.src) octx.drawImage(full.src, fb.x * s, fb.y * s, fb.w * s, fb.h * s)
    octx.restore()
    octx.save()
    octx.strokeStyle = '#fff'
    octx.lineWidth = 2 * u
    octx.strokeRect(a.x * s, a.y * s, a.w * s, a.h * s)
    octx.strokeStyle = 'rgba(255,255,255,.6)'
    octx.lineWidth = u
    for (const k of [1, 2]) { // rule of thirds
      octx.beginPath(); octx.moveTo((a.x + (a.w * k) / 3) * s, a.y * s); octx.lineTo((a.x + (a.w * k) / 3) * s, (a.y + a.h) * s); octx.stroke()
      octx.beginPath(); octx.moveTo(a.x * s, (a.y + (a.h * k) / 3) * s); octx.lineTo((a.x + a.w) * s, (a.y + (a.h * k) / 3) * s); octx.stroke()
    }
    const L = (ed.touchUI ? 18 : 12) * u
    octx.lineWidth = 4 * u
    octx.strokeStyle = '#fff'
    for (const [cx, cy, dx, dy] of [[a.x, a.y, 1, 1], [a.x + a.w, a.y, -1, 1], [a.x, a.y + a.h, 1, -1], [a.x + a.w, a.y + a.h, -1, -1]]) {
      octx.beginPath(); octx.moveTo(cx * s + dx * L, cy * s); octx.lineTo(cx * s, cy * s); octx.lineTo(cx * s, cy * s + dy * L); octx.stroke()
    }
    octx.restore()
  }
  function cropHandleAt(a, x, y) {
    const t = (ed.touchUI ? 18 : 10) / cssPerPt()
    const hx = Math.abs(x - a.x) < t ? 'w' : Math.abs(x - (a.x + a.w)) < t ? 'e' : ''
    const hy = Math.abs(y - a.y) < t ? 'n' : Math.abs(y - (a.y + a.h)) < t ? 's' : ''
    const inX = x > a.x - t && x < a.x + a.w + t, inY = y > a.y - t && y < a.y + a.h + t
    if (hx && hy) return hy + hx
    if (hx && inY) return hx
    if (hy && inX) return hy
    if (x > a.x && x < a.x + a.w && y > a.y && y < a.y + a.h) return 'move'
    return null
  }
  function applyCropDrag(a, o, handle, x, y, sx, sy) {
    const fb = fullBox(o)
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h
    if (handle === 'move') {
      const dx = Math.max(fb.x - o.x, Math.min(fb.x + fb.w - x1, x - sx))
      const dy = Math.max(fb.y - o.y, Math.min(fb.y + fb.h - y1, y - sy))
      x0 += dx; x1 += dx; y0 += dy; y1 += dy
    } else {
      const min = 8
      if (handle.includes('w')) x0 = Math.max(fb.x, Math.min(x, x1 - min))
      if (handle.includes('e')) x1 = Math.min(fb.x + fb.w, Math.max(x, x0 + min))
      if (handle.includes('n')) y0 = Math.max(fb.y, Math.min(y, y1 - min))
      if (handle.includes('s')) y1 = Math.min(fb.y + fb.h, Math.max(y, y0 + min))
      if (ed.cropAspect) { // locked ratio (w/h)
        const r = ed.cropAspect
        let w = x1 - x0, hh = y1 - y0
        if (w / hh > r) w = hh * r; else hh = w / r
        if (handle.includes('w')) x0 = x1 - w; else x1 = x0 + w
        if (handle.includes('n')) y0 = y1 - hh; else y1 = y0 + hh
      }
    }
    a.x = x0; a.y = y0; a.w = x1 - x0; a.h = y1 - y0
    a.crop = { x: (x0 - fb.x) / fb.kx, y: (y0 - fb.y) / fb.ky, w: (x1 - x0) / fb.kx, h: (y1 - y0) / fb.ky }
  }

  // ---------- text runs (edit text / snap redaction / text highlight) ----------
  v.getRuns = async () => {
    if (page.src === null) return []
    if (!v.runs) {
      const raw = await textRuns(ed.doc, ed.info.leaves[page.src]).catch(() => [])
      const { W0, H0 } = origDims()
      v.runs = raw.map((r) => {
        if (!page.rot) return r
        const [x1, y1] = rotPt(r.x, r.y, page.rot, W0, H0), [x2, y2] = rotPt(r.x + r.w, r.y + r.h, page.rot, W0, H0)
        return { ...r, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), rotated: true }
      })
    }
    return v.runs
  }
  v.invalidateRuns = () => { v.runs = null }
  const runAt = (x, y) => v.runs?.find((r) => x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 1 && y <= r.y + r.h + 1) ?? null

  /** Embedded image under a point (unrotated pages only), topmost first. */
  const pdfImageAt = (x, y) => {
    if (page.src === null || page.rot || !page.ops) return null
    const gone = removedImgs()
    for (let i = page.ops.length - 1; i >= 0; i--) {
      const o = page.ops[i]
      if (o.t !== 'img' || !o.bbox) continue
      const [x0, y0, x1, y1] = o.bbox
      if (x1 - x0 < 6 || y1 - y0 < 6) continue
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && !gone.some((r) => sameBox(o.bbox, r))) return o
    }
    return null
  }
  const boxOf = (o) => ({ x: o.bbox[0], y: o.bbox[1], w: o.bbox[2] - o.bbox[0], h: o.bbox[3] - o.bbox[1] })

  // ---------- form fields ----------
  function layoutFields() {
    fieldLayer.replaceChildren()
    if (page.src === null || page.rot || !ed.fields.length) return
    const z = ed.zoom
    for (const f of ed.fields) {
      for (const w of f.widgets) {
        if (w.page !== page.src || w.hidden) continue
        const r = w.rect
        const st = { left: `${r.x * z}px`, top: `${r.y * z}px`, width: `${r.w * z}px`, height: `${r.h * z}px`, pointerEvents: 'auto' }
        const fs = `${Math.max(8, Math.min((f.da.size || Math.min(12, r.h * 0.7)) * z, r.h * z * 0.8))}px`
        let input
        const val = ed.values[f.name] ?? f.value
        if (f.type === 'checkbox') input = h('input', { type: 'checkbox', class: 'ed-field', checked: !!val, onchange: (e) => ed.setField(f.name, e.target.checked) })
        else if (f.type === 'radio') input = h('input', { type: 'radio', class: 'ed-field', name: `rf-${f.name}`, checked: val === w.onState, onchange: () => ed.setField(f.name, w.onState) })
        else if (f.type === 'combo' || f.type === 'list') {
          input = h('select', { class: 'ed-field', onchange: (e) => ed.setField(f.name, e.target.value) },
            h('option', { value: '' }, ''), f.options.map((o) => h('option', { value: o.value, selected: o.value === val }, o.label)))
        } else if (f.type === 'signature') input = h('div', { class: 'ed-field sig', onclick: () => ed.signField(page, r) }, 'Tap to sign')
        else if (f.type === 'text') {
          input = f.multiline
            ? h('textarea', { class: 'ed-field', value: val ?? '', oninput: (e) => ed.setField(f.name, e.target.value) })
            : h('input', { class: 'ed-field', type: f.password ? 'password' : 'text', value: val ?? '', maxlength: f.maxLen ?? undefined, oninput: (e) => ed.setField(f.name, e.target.value) })
        } else continue
        if (f.readOnly) input.disabled = true
        Object.assign(input.style, st, { fontSize: fs })
        input.title = f.name
        input.addEventListener('keydown', (e) => e.stopPropagation())
        input.addEventListener('pointerdown', (e) => e.stopPropagation())
        fieldLayer.append(input)
      }
    }
  }
  v.layoutFields = layoutFields

  // ---------- inline text editing ----------
  v.editText = (a, { selectAll = false } = {}) => {
    ed.closeEditor(true)
    const z = ed.zoom
    const b = textBox(a)
    const ta = h('textarea', {
      class: 'ed-txt', spellcheck: 'true', rows: '1', autocapitalize: 'sentences',
      style: {
        left: `${b.x * z}px`, top: `${b.y * z}px`, font: fontCssOf(a, a.size * z), color: a.color, lineHeight: String(a.lineHeight ?? LINE_H),
        letterSpacing: `${(a.spacing ?? 0) * z}px`,
        textAlign: a.align ?? 'left', textDecoration: [a.underline ? 'underline' : '', a.strike ? 'line-through' : ''].join(' ').trim() || 'none',
        whiteSpace: a.w ? 'pre-wrap' : 'pre', width: a.w ? `${a.w * z + 2}px` : 'auto', background: a.bg ?? 'rgba(255,255,255,.6)',
        transform: a.rot ? `rotate(${a.rot}deg)` : '', transformOrigin: 'center',
      },
    })
    ta.value = a.text
    const fit = () => {
      ta.style.height = '0'
      ta.style.height = `${ta.scrollHeight}px`
      if (!a.w) { ta.style.width = '0'; ta.style.width = `${Math.max(30, ta.scrollWidth + 4)}px` }
    }
    ta.addEventListener('input', () => { a.text = ta.value; fit() })
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); ed.closeEditor(true) } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ed.closeEditor(true) }
    })
    ta.addEventListener('blur', () => setTimeout(() => { if (ed.editing?.el === ta) ed.closeEditor(true) }, 120))
    el.append(ta)
    ed.editing = { a, el: ta, page, before: a.text }
    v.redraw()
    requestAnimationFrame(() => {
      fit()
      ta.focus()
      if (selectAll) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  // ---------- gestures ----------
  let draft = null
  let drag = null
  let hoverRun = null
  let hoverImg = null
  let marquee = null
  let eraserAt = null
  let longPress = 0
  const pointers = new Map()
  let pinch = null

  const tolPt = () => (ed.touchUI ? 16 : 8) / cssPerPt()
  const capture = (id) => { try { over.setPointerCapture(id) } catch { /* pointer already gone */ } }
  const hitTop = (x, y) => {
    for (let i = page.annots.length - 1; i >= 0; i--) if (annHit(page.annots[i], x, y, (ed.touchUI ? 8 : 4) / cssPerPt() + 1)) return page.annots[i]
    return null
  }

  /** Snap a moving selection to page edges/centre and other objects. Returns adjusted [dx, dy]. */
  function snapMove(dx, dy, bounds, noSnap) {
    guides = []
    if (noSnap || ed.style.snap === false) return [dx, dy]
    const t = 6 / cssPerPt()
    const xs = [0, page.w / 2, page.w], ys = [0, page.h / 2, page.h]
    for (const a of page.annots) {
      if (ed.selSet.has(a) || a.hidden || a.t === 'imgremove') continue
      const b = annBounds(a)
      xs.push(b.x, b.x + b.w / 2, b.x + b.w)
      ys.push(b.y, b.y + b.h / 2, b.y + b.h)
    }
    const best = (cands, vals) => {
      let bd = t, out = null
      for (const c of cands) for (const v0 of vals) { const d = c - v0; if (Math.abs(d) < bd) { bd = Math.abs(d); out = [d, c] } }
      return out
    }
    const bx = bounds.x + dx, by = bounds.y + dy
    const sx = best(xs, [bx, bx + bounds.w / 2, bx + bounds.w])
    const sy = best(ys, [by, by + bounds.h / 2, by + bounds.h])
    if (sx) { dx += sx[0]; guides.push({ x: sx[1] }) }
    if (sy) { dy += sy[0]; guides.push({ y: sy[1] }) }
    return [dx, dy]
  }

  function eraseAt(x, y) {
    eraserAt = [x, y]
    const r = ed.style.eraserSize
    let changed = false
    const next = []
    for (const a of page.annots) {
      if (a.locked || a.hidden) { next.push(a); continue }
      if (a.t === 'hlrects') {
        const keep = a.rects.filter((rc) => !(x + r > rc.x && x - r < rc.x + rc.w && y + r > rc.y && y - r < rc.y + rc.h))
        if (keep.length !== a.rects.length) { changed = true; if (keep.length) next.push({ ...a, rects: keep }) } else next.push(a)
        continue
      }
      const pieces = eraseFrom(a, x, y, r)
      if (pieces === null) { next.push(a); continue }
      changed = true
      for (const p of pieces) { p.id = ed.newId(); next.push(p) }
    }
    if (changed) {
      page.annots = next
      if (drag) drag.changed = true
      if (ed.sel?.page === page) {
        const alive = [...ed.selSet].filter((a) => page.annots.includes(a))
        if (!alive.includes(ed.sel.a) || !alive.length) ed.select(null)
        else if (alive.length !== ed.selSet.size) ed.selectMany(page, alive)
      }
    }
    v.redraw()
  }

  const isPenOnlyDrawing = (e) => ed.penSeen && e.pointerType === 'touch' && DRAW_TOOLS.has(ed.tool)

  over.addEventListener('pointerdown', async (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.pointerType === 'pen') ed.penSeen = true
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) { // pinch-zoom + two-finger pan
      cancel()
      const [p, q] = [...pointers.values()]
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), z: ed.zoom, mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 }
      return
    }
    if (pointers.size > 2) return
    // Apple Pencil palm rejection: once a pen has drawn, fingers pan instead of drawing
    if (isPenOnlyDrawing(e)) { drag = { kind: 'pan', lx: e.clientX, ly: e.clientY, pid: e.pointerId }; capture(e.pointerId); return }
    ed.setCurrentPage(page)
    const [x, y] = toPt(e.clientX, e.clientY)
    const tool = ed.tool
    const st = ed.style

    const cropA = ed.cropping?.page === page ? ed.cropping.a : null
    if (cropA) {
      const hnd = cropHandleAt(cropA, x, y)
      if (hnd) { drag = { kind: 'crop', handle: hnd, o: annClone(cropA), a: cropA, sx: x, sy: y, pid: e.pointerId }; capture(e.pointerId); e.preventDefault() } else ed.finishCrop(true)
      return
    }

    if (tool === 'select') {
      const sel = ed.sel?.page === page && ed.selSet.size === 1 ? ed.sel.a : null
      const hnd = sel ? handleAt(sel, x, y, tolPt(), cssPerPt()) : null
      if (hnd) {
        const b = annBox(sel)
        drag = {
          kind: hnd === 'p1' || hnd === 'p2' ? hnd : hnd === 'rot' ? 'rotate' : 'resize', handle: hnd, o: annClone(sel), a: sel, sx: x, sy: y, moved: false, pid: e.pointerId,
          cx: b.x + b.w / 2, cy: b.y + b.h / 2, a0: Math.atan2(y - (b.y + b.h / 2), x - (b.x + b.w / 2)),
        }
        capture(e.pointerId)
        e.preventDefault()
        return
      }
      const hit = hitTop(x, y)
      if (hit) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { ed.toggleSelect(page, hit); return }
        if (!ed.selSet.has(hit) || ed.sel?.page !== page) ed.select(page, hit)
        else ed.sel = { page, a: hit }
        const group = [...ed.selSet].filter((a) => !a.locked)
        drag = { kind: 'move', items: group.map((a) => [a, annClone(a)]), bounds: groupBoundsOf(group), sx: x, sy: y, moved: false, pid: e.pointerId, hit }
        capture(e.pointerId)
        e.preventDefault()
        if (e.pointerType === 'touch') {
          const cx = e.clientX, cy = e.clientY
          longPress = setTimeout(() => { if (drag && !drag.moved) { drag = null; ed.contextMenu({ clientX: cx, clientY: cy }, page, hit) } }, 520)
        }
        return
      }
      drag = { kind: 'deselect', sx: x, sy: y, pid: e.pointerId, img: pdfImageAt(x, y), touch: e.pointerType === 'touch' }
      if (!drag.touch) capture(e.pointerId)
      return
    }
    if (tool === 'erase') {
      capture(e.pointerId)
      drag = { kind: 'erase', pid: e.pointerId, changed: false }
      eraseAt(x, y)
      e.preventDefault()
      return
    }
    if (tool === 'draw' || (tool === 'highlight' && ed.sub.hl === 'free')) {
      capture(e.pointerId)
      const w = tool === 'draw' ? st.penWidth * (e.pointerType === 'pen' ? 0.4 + 1.2 * (e.pressure || 0.5) : 1) : st.hlWidth
      draft = tool === 'draw'
        ? { t: 'stroke', pts: [[x, y, w]], color: st.penColor, width: st.penWidth, alpha: st.penAlpha }
        : { t: 'highlight', pts: [[x, y]], color: st.hlColor, width: st.hlWidth, alpha: 0.4 }
      drag = { kind: 'free', pid: e.pointerId }
      e.preventDefault()
      v.redraw()
      return
    }
    if (tool === 'highlight') {
      if (!v.runs) await v.getRuns()
      capture(e.pointerId)
      drag = { kind: 'hl', sx: x, sy: y, pid: e.pointerId }
      draft = { t: 'hlrects', rects: [], color: st.hlColor, alpha: 0.4 }
      e.preventDefault()
      return
    }
    if (tool === 'edittext') {
      if (page.rot) { ed.hint('Rotate this page back to edit its text'); return }
      if (!v.runs) await v.getRuns()
      const existing = page.annots.find((a) => a.t === 'textedit' && annHit(a, x, y))
      if (existing) { ed.select(page, existing); v.editText(existing); return }
      const r = runAt(x, y)
      if (!r) { ed.hint('Tap on existing text to change it'); return }
      const a = ed.add(page, {
        t: 'textedit', region: { x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 }, origText: r.str,
        x: r.x, y: r.base - r.size * 0.8, w: 0, text: r.str, size: Math.round(r.size * 10) / 10,
        font: r.font?.mono ? 'courier' : r.font?.serif ? 'times' : 'helv', bold: !!r.font?.bold, italic: !!r.font?.italic,
        color: rgbHex(r.color), align: 'left',
      }, { select: true })
      hoverRun = null
      v.render()
      v.editText(a)
      return
    }
    if (tool === 'text') {
      capture(e.pointerId)
      drag = { kind: 'textbox', sx: x, sy: y, pid: e.pointerId }
      return
    }
    if (tool === 'stamp') {
      const k = ed.sub.stamp
      const size = st.stampSize
      let a
      if (k === 'check' || k === 'cross' || k === 'dot') a = { t: 'mark', kind: k, x: x - size / 2, y: y - size / 2, w: size, h: size, color: st.markColor }
      else if (k === 'date') a = { t: 'text', x, y: y - st.textSize * 0.6, text: new Date().toLocaleDateString(), size: st.textSize, font: st.font, color: st.textColor, w: 0 }
      else {
        const hh = size * 1.3, ww = Math.max(hh * 2.4, hh * 0.62 * k.length)
        a = { t: 'stamp', label: k, x: x - ww / 2, y: y - hh / 2, w: ww, h: hh, color: st.stampColor }
      }
      ed.add(page, a, { select: true })
      return
    }
    if (tool === 'note') {
      const a = ed.add(page, { t: 'note', x: x - 11, y: y - 11, text: '', color: st.noteColor }, { select: true })
      ed.editNote(page, a, true)
      return
    }
    if (tool === 'redact' && !v.runs) await v.getRuns()
    capture(e.pointerId)
    drag = { kind: 'shape', sx: x, sy: y, pid: e.pointerId, moved: false }
    draft = null
    e.preventDefault()
  })

  over.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId)
    if (p) { p.x = e.clientX; p.y = e.clientY }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      ed.panBy(pinch.mx - mx, pinch.my - my)
      pinch.mx = mx
      pinch.my = my
      if (pinch.d > 0 && Math.abs(d / pinch.d - ed.zoom / pinch.z) > 0.01) ed.setZoom(pinch.z * (d / pinch.d), { cx: mx, cy: my, live: true })
      return
    }
    const [x, y] = toPt(e.clientX, e.clientY)
    if (!drag) {
      if ((ed.tool === 'edittext' || ed.tool === 'redact') && v.runs) {
        const r = runAt(x, y)
        if (r !== hoverRun) { hoverRun = r; v.redraw() }
        over.style.cursor = r ? (ed.tool === 'edittext' ? 'text' : 'pointer') : ed.tool === 'redact' ? 'crosshair' : 'default'
      } else if (ed.tool === 'edittext' || ed.tool === 'redact') v.getRuns().then(() => v.redraw())
      if (ed.tool === 'erase' && e.pointerType !== 'touch') { eraserAt = [x, y]; v.redraw() }
      const cropA = ed.cropping?.page === page ? ed.cropping.a : null
      if (cropA) {
        const hc = cropHandleAt(cropA, x, y)
        over.style.cursor = !hc ? 'default' : hc === 'move' ? 'move' : cursorFor({ rot: 0 }, hc)
        return
      }
      if (ed.tool === 'select' && e.pointerType !== 'touch') {
        const sel = ed.sel?.page === page && ed.selSet.size === 1 ? ed.sel.a : null
        const hnd = sel ? handleAt(sel, x, y, tolPt(), cssPerPt()) : null
        const hit = hnd ? null : hitTop(x, y)
        const img = hnd || hit ? null : pdfImageAt(x, y)
        const ib = img ? boxOf(img) : null
        if ((ib?.x ?? -1) !== (hoverImg?.x ?? -1) || (ib?.y ?? -1) !== (hoverImg?.y ?? -1)) { hoverImg = ib; v.redraw() }
        over.style.cursor = hnd ? cursorFor(sel, hnd) : hit ? 'move' : img ? 'pointer' : 'default'
      }
      return
    }
    if (drag.pid !== undefined && e.pointerId !== drag.pid) return
    const shift = e.shiftKey
    switch (drag.kind) {
      case 'pan':
        ed.panBy(drag.lx - e.clientX, drag.ly - e.clientY)
        drag.lx = e.clientX
        drag.ly = e.clientY
        break
      case 'move': {
        let dx = x - drag.sx, dy = y - drag.sy
        if (!drag.moved && Math.hypot(dx, dy) * cssPerPt() < (e.pointerType === 'touch' ? 8 : 3)) return
        clearTimeout(longPress)
        drag.moved = true
        ;[dx, dy] = snapMove(dx, dy, drag.bounds, e.altKey)
        for (const [a, o] of drag.items) annMove(a, o, dx, dy)
        v.redraw()
        ed.refreshProps?.(true)
        break
      }
      case 'resize':
        drag.moved = true
        annResize(drag.a, drag.o, drag.handle, x, y, { aspect: keepsAspect(drag.a) !== shift })
        v.redraw()
        break
      case 'rotate': {
        drag.moved = true
        let deg = (drag.o.rot ?? 0) + ((Math.atan2(y - drag.cy, x - drag.cx) - drag.a0) * 180) / Math.PI
        deg = ((deg % 360) + 360) % 360
        if (shift) deg = Math.round(deg / 15) * 15
        else for (const sn of [0, 90, 180, 270, 360]) if (Math.abs(deg - sn) < 3) deg = sn
        drag.a.rot = Math.round((deg % 360) * 10) / 10
        v.redraw()
        ed.refreshProps?.(true)
        break
      }
      case 'p1': case 'p2': {
        drag.moved = true
        let [nx, ny] = [x, y]
        if (shift) [nx, ny] = snap45(drag.kind === 'p1' ? drag.o.x2 : drag.o.x1, drag.kind === 'p1' ? drag.o.y2 : drag.o.y1, x, y)
        if (drag.kind === 'p1') { drag.a.x1 = nx; drag.a.y1 = ny } else { drag.a.x2 = nx; drag.a.y2 = ny }
        v.redraw()
        break
      }
      case 'crop':
        applyCropDrag(drag.a, drag.o, drag.handle, x, y, drag.sx, drag.sy)
        v.redraw()
        break
      case 'erase':
        for (const ev of coalesced(e)) { const [ex, ey] = toPt(ev.clientX, ev.clientY); eraseAt(ex, ey) }
        break
      case 'free': {
        for (const ev of coalesced(e)) {
          const [ex, ey] = toPt(ev.clientX, ev.clientY)
          const last = draft.pts[draft.pts.length - 1]
          if (Math.hypot(ex - last[0], ey - last[1]) * cssPerPt() < 1.2) continue
          if (draft.t === 'stroke') {
            const target = ed.style.penWidth * (ev.pointerType === 'pen' ? 0.4 + 1.2 * (ev.pressure || 0.5) : 1)
            draft.pts.push([ex, ey, last[2] * 0.5 + target * 0.5])
          } else draft.pts.push([ex, ey])
        }
        if (draft.t === 'highlight' && shift && draft.pts.length > 1) draft.pts = [draft.pts[0], [x, draft.pts[0][1]]]
        v.redraw()
        break
      }
      case 'hl':
        draft.rects = selectionRects(v.runs ?? [], drag.sx, drag.sy, x, y)
        v.redraw()
        break
      case 'shape': {
        const dx = x - drag.sx, dy = y - drag.sy
        if (!drag.moved && Math.hypot(dx, dy) * cssPerPt() < 3) return
        drag.moved = true
        draft = shapeFor(ed, drag.sx, drag.sy, x, y, shift)
        v.redraw()
        break
      }
      case 'textbox': {
        const dx = x - drag.sx
        if (Math.abs(dx) * cssPerPt() > 8) { marquee = { x: Math.min(drag.sx, x), y: drag.sy, w: Math.abs(dx), h: ed.style.textSize * LINE_H }; v.redraw() }
        break
      }
      case 'deselect':
        if (!drag.touch && Math.hypot(x - drag.sx, y - drag.sy) * cssPerPt() > 4) {
          marquee = { x: Math.min(drag.sx, x), y: Math.min(drag.sy, y), w: Math.abs(x - drag.sx), h: Math.abs(y - drag.sy) }
          v.redraw()
        }
        break
    }
  })

  const finish = (e) => {
    pointers.delete(e.pointerId)
    clearTimeout(longPress)
    if (pinch) { if (pointers.size < 2) { pinch = null; ed.setZoom(ed.zoom, { commit: true }) } return }
    if (!drag) return
    const d = drag
    drag = null
    guides = []
    const [x, y] = toPt(e.clientX, e.clientY)
    switch (d.kind) {
      case 'move': case 'resize': case 'p1': case 'p2': case 'rotate':
        if (d.moved) ed.commit('Move')
        else if (d.kind === 'move' && e.detail >= 2) ed.dblClick(page, d.hit)
        ed.refreshProps?.()
        break
      case 'crop':
        ed.refreshProps?.()
        break
      case 'erase':
        if (e.pointerType === 'touch') eraserAt = null
        if (d.changed) ed.commit('Erase')
        break
      case 'deselect': {
        const tap = Math.hypot(x - d.sx, y - d.sy) * cssPerPt() < 8
        if (marquee) {
          const m = marquee
          marquee = null
          const inside = page.annots.filter((a) => {
            if (a.hidden || a.locked || a.t === 'imgremove') return false
            const b = annBounds(a)
            return b.x >= m.x && b.y >= m.y && b.x + b.w <= m.x + m.w && b.y + b.h <= m.y + m.h
          })
          if (inside.length) ed.selectMany(page, inside); else ed.select(null)
        } else if (tap && d.img) ed.selectPdfImage(page, d.img, boxOf(d.img))
        else if (tap) ed.select(null)
        break
      }
      case 'free': {
        const a = draft
        draft = null
        if (a.t === 'stroke' && a.pts.length > 2) a.pts = smooth(a.pts)
        ed.add(page, a, { select: false })
        break
      }
      case 'hl': {
        const a = draft
        draft = null
        if (a.rects.length) ed.add(page, a, { select: false })
        else { ed.hint('Drag across text to highlight it — or switch to freehand'); v.redraw() }
        break
      }
      case 'shape': {
        let a = draft
        draft = null
        if (!d.moved) {
          const r = (ed.tool === 'redact' || ed.tool === 'whiteout') ? runAt(x, y) : null
          if (r) a = ed.tool === 'redact' ? { t: 'redact', x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2, fill: ed.style.redactColor } : { t: 'whiteout', x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2, fill: '#ffffff' }
          else if (ed.tool === 'shape') { // a tap drops a default-size shape
            const sz = 80
            const line = ed.sub.shape === 'line' || ed.sub.shape === 'arrow'
            a = shapeFor(ed, x - sz / 2, y + (line ? 0 : -sz / 2), x + sz / 2, y + (line ? 0 : sz / 2), false)
          } else { v.redraw(); break }
        }
        if (!a) break
        if (a.t === 'link') { ed.add(page, a, { select: true }); ed.editLink(page, a, true); break }
        ed.add(page, a, { select: ed.tool !== 'redact' && ed.tool !== 'whiteout' })
        break
      }
      case 'textbox': {
        const w = marquee ? marquee.w : 0
        marquee = null
        const st = ed.style
        const a = ed.add(page, { t: 'text', x: w ? Math.min(d.sx, x) : d.sx, y: d.sy - st.textSize * 0.6, w, text: '', size: st.textSize, font: st.font, bold: st.bold, italic: st.italic, underline: st.underline, color: st.textColor, align: st.align }, { select: true, silent: true })
        v.editText(a)
        break
      }
    }
    v.redraw()
  }
  const cancel = () => {
    clearTimeout(longPress)
    if (drag?.kind === 'move' && drag.moved) for (const [a, o] of drag.items) Object.assign(a, o)
    if (drag && (drag.kind === 'resize' || drag.kind === 'rotate') && drag.moved) Object.assign(drag.a, drag.o)
    drag = null
    draft = null
    marquee = null
    guides = []
    v.redraw()
  }
  over.addEventListener('pointerup', finish)
  over.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; cancel() })
  over.addEventListener('pointerleave', () => {
    if (!drag && (hoverRun || hoverImg || eraserAt)) { hoverRun = null; hoverImg = null; eraserAt = null; v.redraw() }
  })
  over.addEventListener('dblclick', (e) => {
    if (ed.tool !== 'select') return
    const [x, y] = toPt(e.clientX, e.clientY)
    const hit = hitTop(x, y)
    if (hit) ed.dblClick(page, hit)
  })
  over.addEventListener('contextmenu', (e) => {
    const [x, y] = toPt(e.clientX, e.clientY)
    const hit = hitTop(x, y)
    if (!hit) return
    e.preventDefault()
    if (!ed.selSet.has(hit)) ed.select(page, hit)
    ed.contextMenu(e, page, hit)
  })
  // touch: one finger on empty space scrolls natively in Select; anything else is ours
  over.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { e.preventDefault(); return }
    if (ed.cropping?.page === page) { e.preventDefault(); return }
    if (ed.tool !== 'select') { e.preventDefault(); return }
    const t = e.touches[0]
    const [x, y] = toPt(t.clientX, t.clientY)
    const sel = ed.sel?.page === page && ed.selSet.size === 1 ? ed.sel.a : null
    if ((sel && handleAt(sel, x, y, tolPt(), cssPerPt())) || hitTop(x, y)) e.preventDefault()
  }, { passive: false })

  v.cancel = cancel
  v.layout()
  return v
}

// ---------- helpers ----------

const coalesced = (e) => { const l = e.getCoalescedEvents?.(); return l && l.length ? l : [e] }
const rgbHex = (c) => '#' + (c ?? [0, 0, 0]).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')

function snap45(ox, oy, x, y) {
  const ang = Math.round(Math.atan2(y - oy, x - ox) / (Math.PI / 4)) * (Math.PI / 4)
  const len = Math.hypot(x - ox, y - oy)
  return [ox + len * Math.cos(ang), oy + len * Math.sin(ang)]
}

/** Draft object for rectangle-ish tools. */
function shapeFor(ed, x0, y0, x1, y1, shift) {
  const st = ed.style
  const sub = ed.sub.shape
  if (ed.tool === 'shape' && (sub === 'line' || sub === 'arrow')) {
    const [x2, y2] = shift ? snap45(x0, y0, x1, y1) : [x1, y1]
    return { t: 'line', x1: x0, y1: y0, x2, y2, color: st.shapeStroke ?? '#e03131', width: st.shapeWidth, arrow: sub === 'arrow', alpha: st.shapeAlpha, dash: st.shapeDash ? [st.shapeWidth * 3, st.shapeWidth * 2] : null }
  }
  let w = x1 - x0, hh = y1 - y0
  if (shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m }
  const box = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + hh), w: Math.abs(w), h: Math.abs(hh) }
  if (ed.tool === 'whiteout') return { t: 'whiteout', ...box, fill: '#ffffff' }
  if (ed.tool === 'redact') return { t: 'redact', ...box, fill: st.redactColor }
  if (ed.tool === 'link') return { t: 'link', ...box, url: '' }
  const common = { ...box, stroke: st.shapeStroke, fill: st.shapeFill, fillAlpha: st.shapeFillAlpha ?? 1, lw: st.shapeWidth, alpha: st.shapeAlpha, dash: st.shapeDash ? [st.shapeWidth * 3, st.shapeWidth * 2] : null }
  if (sub === 'triangle' || sub === 'star' || sub === 'polygon') return { t: 'poly', kind: sub, sides: sub === 'star' ? (st.starPoints ?? 5) : sub === 'polygon' ? (st.polySides ?? 6) : 3, ...common }
  return { t: sub === 'ellipse' ? 'ellipse' : 'rect', ...common, radius: sub === 'rrect' ? Math.min(box.w, box.h) * 0.15 : 0 }
}

/**
 * Text-selection style highlight rects between two points: runs in reading
 * order from the run under the start to the run under the end, clipped at the
 * start/end x on the first/last line.
 */
export function selectionRects(runs, x0, y0, x1, y1) {
  if (!runs.length) return []
  const ordered = [...runs].filter((r) => !r.rotated).sort((a, b) => (Math.abs(a.base - b.base) < a.size * 0.4 ? a.x - b.x : a.base - b.base))
  const idxAt = (x, y) => {
    let best = -1, bd = Infinity
    ordered.forEach((r, i) => {
      const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0
      const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0
      const d = dy * 4 + dx
      if (d < bd) { bd = d; best = i }
    })
    return bd < 30 ? best : -1
  }
  let a = idxAt(x0, y0), b = idxAt(x1, y1)
  if (a < 0 || b < 0) return []
  let sx = x0, ex = x1
  if (a > b) { [a, b] = [b, a]; [sx, ex] = [x1, x0] }
  const rects = []
  for (let i = a; i <= b; i++) {
    const r = ordered[i]
    let left = r.x, right = r.x + r.w
    if (i === a) left = Math.max(left, Math.min(sx, right))
    if (i === b) right = Math.min(right, Math.max(ex, left))
    if (a === b && left > right) [left, right] = [right, left]
    if (right - left > 0.5) rects.push({ x: left, y: r.y + r.h * 0.04, w: right - left, h: r.h * 0.92 })
  }
  return rects
}
