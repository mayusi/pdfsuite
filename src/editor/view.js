// One editor page: base raster (lazy, zoom-aware, memory-released when far
// away), overlay canvas for annotations + selection, DOM layers for inline
// text editing and form fields, and every tool's pointer gesture.
import { h } from '../ui/dom.js'
import { collectDrawOps } from '../pdf/content.js'
import { paintOps } from '../pdf/render.js'
import { textRuns } from '../pdf/redact.js'
import {
  annBox, annHit, annClone, annMove, annResize, annDraw, drawSelection, handleAt, keepsAspect, CURSOR,
  smooth, textBox, fontCssOf, LINE_H,
} from './annots.js'

const MAX_PX = 4096 * 4096 * 0.9

/** Map a point from the page's ORIGINAL display space into its rotated space. */
export function rotPt(x, y, rot, W0, H0) {
  if (rot === 90) return [H0 - y, x]
  if (rot === 180) return [W0 - x, H0 - y]
  if (rot === 270) return [y, W0 - x]
  return [x, y]
}
/** Inverse: rotated space → original. */
export function unrotPt(x, y, rot, W0, H0) {
  if (rot === 90) return [y, H0 - x]
  if (rot === 180) return [W0 - x, H0 - y]
  if (rot === 270) return [W0 - y, x]
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
  const cssPerPt = () => over.getBoundingClientRect().width / page.w

  // ---------- base raster ----------
  const origDims = () => {
    if (page.src === null) return { W0: page.rot % 180 ? page.h : page.w, H0: page.rot % 180 ? page.w : page.h }
    return { W0: page.rot % 180 ? page.h : page.w, H0: page.rot % 180 ? page.w : page.h }
  }
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
        // rotate the canvas so original-space ops land in the rotated page
        if (page.rot === 90) c.setTransform(0, 1, -1, 0, bw, 0)
        else if (page.rot === 180) c.setTransform(-1, 0, 0, -1, bw, bh)
        else if (page.rot === 270) c.setTransform(0, -1, 1, 0, 0, bh)
        const sx = (page.rot % 180 ? bh : bw) / W0
        const holes = page.annots.filter((a) => a.t === 'textedit').map((a) => a.region)
        const hideGlyph = holes.length ? (x, y) => {
          const [rx, ry] = rotPt(x, y, page.rot, W0, H0)
          return holes.some((r) => rx >= r.x && rx <= r.x + r.w && ry >= r.y && ry <= r.y + r.h)
        } : null
        // paintOps resets the transform to its own scale; bake rotation into an intermediate canvas instead
        if (page.rot) {
          const tmp = document.createElement('canvas')
          tmp.width = Math.round(W0 * sx)
          tmp.height = Math.round(H0 * sx)
          const tc = tmp.getContext('2d')
          tc.fillStyle = '#fff'
          tc.fillRect(0, 0, tmp.width, tmp.height)
          await paintOps(tc, ed.doc, page.ops, sx, ed.imgCache, { hideGlyph })
          c.drawImage(tmp, 0, 0)
        } else {
          await paintOps(c, ed.doc, page.ops, sx, ed.imgCache, { hideGlyph })
        }
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
  v.release = () => { // far off-screen: free the bitmap memory
    v.renderGen++
    base.width = 1; base.height = 1
    over.width = 1; over.height = 1
    v.rendered = 0
  }

  // ---------- overlay ----------
  v.redraw = () => {
    if (over.width < 4) return
    const s = S()
    octx.setTransform(1, 0, 0, 1, 0, 0)
    octx.clearRect(0, 0, over.width, over.height)
    const bmp = (a) => ed.bitmap(a)
    for (const a of page.annots) annDraw(octx, a, s, { bmp, editingId: ed.editing?.a.id })
    if (draft) annDraw(octx, draft, s, { bmp })
    if (hoverRun && (ed.tool === 'edittext' || ed.tool === 'redact')) {
      octx.save()
      octx.strokeStyle = ed.tool === 'redact' ? '#e03131' : '#2563eb'
      octx.fillStyle = ed.tool === 'redact' ? 'rgba(224,49,49,.08)' : 'rgba(37,99,235,.08)'
      octx.lineWidth = Math.max(1, s * 0.6)
      octx.setLineDash([4, 3])
      const r = hoverRun
      octx.fillRect((r.x - 1) * s, (r.y - 1) * s, (r.w + 2) * s, (r.h + 2) * s)
      octx.strokeRect((r.x - 1) * s, (r.y - 1) * s, (r.w + 2) * s, (r.h + 2) * s)
      octx.restore()
    }
    if (marquee) {
      octx.save()
      octx.fillStyle = 'rgba(16,185,129,.08)'
      octx.strokeStyle = '#10b981'
      octx.setLineDash([4, 3])
      octx.fillRect(marquee.x * s, marquee.y * s, marquee.w * s, marquee.h * s)
      octx.strokeRect(marquee.x * s, marquee.y * s, marquee.w * s, marquee.h * s)
      octx.restore()
    }
    if (ed.sel?.page === page && page.annots.includes(ed.sel.a) && !(ed.editing?.a === ed.sel.a)) {
      drawSelection(octx, ed.sel.a, s, s / cssPerPt(), getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#10b981')
    }
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
        if (f.type === 'checkbox') {
          input = h('input', { type: 'checkbox', class: 'ed-field', checked: !!val, onchange: (e) => ed.setField(f.name, e.target.checked) })
        } else if (f.type === 'radio') {
          input = h('input', { type: 'radio', class: 'ed-field', name: `rf-${f.name}`, checked: val === w.onState, onchange: () => ed.setField(f.name, w.onState) })
        } else if (f.type === 'combo' || f.type === 'list') {
          input = h('select', { class: 'ed-field', onchange: (e) => ed.setField(f.name, e.target.value) },
            h('option', { value: '' }, ''), f.options.map((o) => h('option', { value: o.value, selected: o.value === val }, o.label)))
        } else if (f.type === 'signature') {
          input = h('div', { class: 'ed-field sig', onclick: () => ed.signField(page, r) }, 'Click to sign')
        } else if (f.type === 'text') {
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
      class: 'ed-txt', spellcheck: 'true', rows: '1',
      style: {
        left: `${b.x * z}px`, top: `${b.y * z}px`, font: fontCssOf(a, a.size * z), color: a.color, lineHeight: String(LINE_H),
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
    ta.addEventListener('input', () => { a.text = ta.value; fit(); ed.onLiveEdit?.() })
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); ed.closeEditor(true) }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ed.closeEditor(true) }
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
  let drag = null // {kind:'move'|'resize'|'shape'|'p1'|'p2'|'marquee'|'hl', ...}
  let hoverRun = null
  let marquee = null
  const pointers = new Map()
  let pinch = null

  const tolPt = () => 8 / cssPerPt()
  const capture = (id) => { try { over.setPointerCapture(id) } catch { /* pointer already gone */ } }
  const hitTop = (x, y) => {
    for (let i = page.annots.length - 1; i >= 0; i--) if (annHit(page.annots[i], x, y, 4 / cssPerPt() + 1)) return page.annots[i]
    return null
  }

  over.addEventListener('pointerdown', async (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) { // pinch-zoom
      cancel()
      const [p, q] = [...pointers.values()]
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), z: ed.zoom }
      return
    }
    if (pointers.size > 2) return
    ed.setCurrentPage(page)
    const [x, y] = toPt(e.clientX, e.clientY)
    const tool = ed.tool
    const st = ed.style
    if (tool === 'select') {
      const sel = ed.sel?.page === page ? ed.sel.a : null
      const hnd = sel ? handleAt(sel, x, y, tolPt(), cssPerPt()) : null
      if (hnd) {
        drag = { kind: hnd === 'p1' || hnd === 'p2' ? hnd : 'resize', handle: hnd, o: annClone(sel), a: sel, sx: x, sy: y, moved: false }
        capture(e.pointerId)
        e.preventDefault()
        return
      }
      const hit = hitTop(x, y)
      if (hit) {
        ed.select(page, hit)
        drag = { kind: 'move', o: annClone(hit), a: hit, sx: x, sy: y, moved: false, pid: e.pointerId }
        capture(e.pointerId)
        e.preventDefault()
      } else {
        drag = { kind: 'deselect', sx: x, sy: y, pid: e.pointerId }
      }
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
    if (tool === 'highlight') { // text highlight: drag across text like selecting it
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
      const r = runAt(x, y)
      const existing = page.annots.find((a) => a.t === 'textedit' && annHit(a, x, y))
      if (existing) { ed.select(page, existing); v.editText(existing); return }
      if (!r) { ed.hint('Click on existing text to change it'); return }
      const a = ed.add(page, {
        t: 'textedit', region: { x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 }, origText: r.str,
        x: r.x, y: r.base - r.size * 0.8, w: 0, text: r.str, size: Math.round(r.size * 10) / 10,
        font: r.font?.mono ? 'courier' : r.font?.serif ? 'times' : 'helv', bold: !!r.font?.bold, italic: !!r.font?.italic,
        color: rgbHex(r.color), align: 'left',
      }, { select: true })
      hoverRun = null
      v.render() // hide the original glyphs underneath
      v.editText(a, { selectAll: false })
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
    // rectangle tools: shape, whiteout, redact, link
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
      if (pinch.d > 0) ed.setZoom(pinch.z * (d / pinch.d), { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, live: true })
      return
    }
    const [x, y] = toPt(e.clientX, e.clientY)
    if (!drag) {
      // hover feedback
      if ((ed.tool === 'edittext' || ed.tool === 'redact') && v.runs) {
        const r = runAt(x, y)
        if (r !== hoverRun) { hoverRun = r; v.redraw() }
        over.style.cursor = r ? (ed.tool === 'edittext' ? 'text' : 'pointer') : ed.tool === 'redact' ? 'crosshair' : 'default'
      } else if (ed.tool === 'edittext' || ed.tool === 'redact') { v.getRuns().then(() => v.redraw()) }
      if (ed.tool === 'select') {
        const sel = ed.sel?.page === page ? ed.sel.a : null
        const hnd = sel ? handleAt(sel, x, y, tolPt(), cssPerPt()) : null
        over.style.cursor = hnd ? CURSOR[hnd] : hitTop(x, y) ? 'move' : 'default'
      }
      return
    }
    if (drag.pid !== undefined && e.pointerId !== drag.pid && drag.kind !== 'resize') return
    const shift = e.shiftKey
    switch (drag.kind) {
      case 'move': {
        const dx = x - drag.sx, dy = y - drag.sy
        if (!drag.moved && Math.hypot(dx, dy) * cssPerPt() < 3) return
        drag.moved = true
        annMove(drag.a, drag.o, dx, dy)
        v.redraw()
        ed.refreshProps?.(true)
        break
      }
      case 'resize':
        drag.moved = true
        annResize(drag.a, drag.o, drag.handle, x, y, { aspect: keepsAspect(drag.a) !== shift })
        v.redraw()
        break
      case 'p1': case 'p2': {
        drag.moved = true
        let [nx, ny] = [x, y]
        if (shift) [nx, ny] = snap45(drag.kind === 'p1' ? drag.o.x2 : drag.o.x1, drag.kind === 'p1' ? drag.o.y2 : drag.o.y1, x, y)
        if (drag.kind === 'p1') { drag.a.x1 = nx; drag.a.y1 = ny } else { drag.a.x2 = nx; drag.a.y2 = ny }
        v.redraw()
        break
      }
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
        if (e.pointerType !== 'touch' && Math.hypot(x - drag.sx, y - drag.sy) * cssPerPt() > 4) {
          marquee = { x: Math.min(drag.sx, x), y: Math.min(drag.sy, y), w: Math.abs(x - drag.sx), h: Math.abs(y - drag.sy) }
          v.redraw()
        }
        break
    }
  })

  const finish = (e) => {
    pointers.delete(e.pointerId)
    if (pinch) { if (pointers.size < 2) { pinch = null; ed.setZoom(ed.zoom, { commit: true }) } return }
    if (!drag) return
    const d = drag
    drag = null
    const [x, y] = toPt(e.clientX, e.clientY)
    switch (d.kind) {
      case 'move': case 'resize': case 'p1': case 'p2':
        if (d.moved) ed.commit('Move'); else if (d.kind === 'move' && e.detail >= 2) ed.dblClick(page, d.a)
        ed.refreshProps?.()
        break
      case 'deselect':
        if (marquee) {
          // select the topmost object inside the marquee
          const m = marquee
          marquee = null
          const inside = page.annots.filter((a) => { const b = annBox(a); return b.x >= m.x && b.y >= m.y && b.x + b.w <= m.x + m.w && b.y + b.h <= m.y + m.h })
          if (inside.length) ed.select(page, inside[inside.length - 1]); else ed.select(null)
          v.redraw()
        } else ed.select(null)
        break
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
        if (!d.moved) { // a click: snap redaction/whiteout to the text run under it
          const r = (ed.tool === 'redact' || ed.tool === 'whiteout') ? runAt(x, y) : null
          if (r) a = ed.tool === 'redact' ? { t: 'redact', x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2, fill: ed.style.redactColor } : { t: 'whiteout', x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2, fill: '#ffffff' }
          else { v.redraw(); break }
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
    if (drag && (drag.kind === 'move' || drag.kind === 'resize') && drag.moved) Object.assign(drag.a, drag.o)
    drag = null
    draft = null
    marquee = null
    v.redraw()
  }
  over.addEventListener('pointerup', finish)
  over.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; cancel() })
  over.addEventListener('pointerleave', () => { if (hoverRun && !drag) { hoverRun = null; v.redraw() } })
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
    ed.select(page, hit)
    ed.contextMenu(e, page, hit)
  })
  // touch: one finger on empty space scrolls; on an object (select tool) it drags
  over.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1) { e.preventDefault(); return }
    if (ed.tool !== 'select') { e.preventDefault(); return }
    const t = e.touches[0]
    const [x, y] = toPt(t.clientX, t.clientY)
    const sel = ed.sel?.page === page ? ed.sel.a : null
    if ((sel && handleAt(sel, x, y, tolPt(), cssPerPt())) || hitTop(x, y)) e.preventDefault()
  }, { passive: false })

  v.cancel = cancel
  v.layout()
  return v
}

// ---------- helpers ----------

/** Coalesced pointer samples, never empty (synthetic events report none). */
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
  if (ed.tool === 'shape' && (ed.sub.shape === 'line' || ed.sub.shape === 'arrow')) {
    const [x2, y2] = shift ? snap45(x0, y0, x1, y1) : [x1, y1]
    return { t: 'line', x1: x0, y1: y0, x2, y2, color: st.shapeStroke ?? '#e03131', width: st.shapeWidth, arrow: ed.sub.shape === 'arrow', alpha: st.shapeAlpha, dash: st.shapeDash ? [st.shapeWidth * 3, st.shapeWidth * 2] : null }
  }
  let w = x1 - x0, hh = y1 - y0
  if (shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m }
  const box = { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + hh), w: Math.abs(w), h: Math.abs(hh) }
  if (ed.tool === 'whiteout') return { t: 'whiteout', ...box, fill: '#ffffff' }
  if (ed.tool === 'redact') return { t: 'redact', ...box, fill: st.redactColor }
  if (ed.tool === 'link') return { t: 'link', ...box, url: '' }
  return { t: ed.sub.shape === 'ellipse' ? 'ellipse' : 'rect', ...box, stroke: st.shapeStroke, fill: st.shapeFill, lw: st.shapeWidth, alpha: st.shapeAlpha, dash: st.shapeDash ? [st.shapeWidth * 3, st.shapeWidth * 2] : null, radius: ed.sub.shape === 'rrect' ? Math.min(box.w, box.h) * 0.15 : 0 }
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
