import { h, setKids, readBytes, saveBlob, fmtBytes, icon } from '../ui/dom.js'
import { Btn, DropZone, ErrorText, Toolbar, iconBtn } from '../ui/widgets.js'
import { get } from '../pdf/types.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves, pageDims, annotatePdf } from '../pdf/ops.js'
import { renderPage } from '../pdf/render.js'

/**
 * Edit PDF — annotation layer over rendered pages: pen (pressure), highlighter,
 * text, line/arrow, rect/ellipse, whiteout, images, select/move/resize, eraser.
 * Annotations live in DISPLAY space (top-left origin, pt units, post-/Rotate
 * dims) — exactly the space annotatePdf() consumes on export.
 */
export function Edit() {
  // ---------- state ----------
  let file = null
  let bytes = null
  let doc = null
  let leaves = []
  let dims = []
  let annots = [] // annots[i] = annotation objects for page i
  let page = 0
  let zoom = 1
  let tool = 'select'
  let color = '#e03131'
  let penWidth = 4
  let alpha = 1
  let font = 'helv'
  let fontSize = 16
  let sel = null // selected annotation (object identity inside annots[page])
  let undoStack = []
  let redoStack = []
  let busy = false
  let error = ''
  let loadGen = 0
  let baseGen = 0
  const imgCache = new Map() // shared page-render decode cache
  const bmpCache = new WeakMap() // image annot → ImageBitmap | Promise
  const root = h('div', { class: 'tool' })

  // dom refs — built once per loaded doc, updated in place (canvas state is precious)
  let editorEl = null
  let stage, pageEl, base, over, octx, delChip
  let thumbsEl, thumbObs
  let metaEl, pageLbl, zoomLbl, prevBtn, nextBtn, dlBtn
  let toolBtns, fontWrap, widthSlider, widthLbl, alphaSlider, alphaLbl, colorPick
  let swatchEls = []
  let actionSlot
  let txtIn = null // {ta, x, y} floating text editor

  // gesture state
  const pointers = new Map() // pointerId → {x,y} client px — powers pinch zoom
  let pinch = null // {d} last finger-pair distance
  let draft = null // in-progress stroke/shape (not yet committed)
  let drag = null // {kind:'shape'|'move'|'resize', corner, sx, sy, o, pushed}
  let captureId = null // pointerId owning the active gesture
  let tap = null // {id,x,y} pending text/eraser tap
  let pendingDeselect = null // pointerId of an empty-space press awaiting its up

  const ED_TOOLS = [
    ['select', 'Select'], ['pen', 'Pen'], ['hilite', 'Highlight'], ['text', 'Text'],
    ['line', 'Line'], ['arrow', 'Arrow'], ['rect', 'Rect'], ['ellipse', 'Ellipse'],
    ['whiteout', 'Whiteout'], ['image', 'Image'], ['eraser', 'Eraser'],
  ]
  const ED_COLORS = ['#111111', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#862e9c', '#ffffff']
  const ED_FONTS = [['helv', 'Helvetica'], ['helvb', 'Helvetica Bold'], ['times', 'Times'], ['courier', 'Courier']]
  const ED_DRAW = new Set(['pen', 'hilite', 'line', 'arrow', 'rect', 'ellipse', 'whiteout'])
  const ED_FAM = {
    helv: 'Helvetica, Arial, sans-serif',
    helvb: 'Helvetica, Arial, sans-serif',
    times: '"Times New Roman", Times, serif',
    courier: '"Courier New", Courier, monospace',
  }

  // ---------- geometry ----------
  const pageW = () => (dims[page].rotate % 180 === 0 ? dims[page].w : dims[page].h)
  const pageH = () => (dims[page].rotate % 180 === 0 ? dims[page].h : dims[page].w)
  const toPt = (cx, cy) => {
    const r = over.getBoundingClientRect()
    return [(cx - r.left) / zoom, (cy - r.top) / zoom]
  }
  const distSeg = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1
    const l2 = dx * dx + dy * dy
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(x1 + t * dx - px, y1 + t * dy - py)
  }

  const edTextBox = (a) => {
    const lines = String(a.text).split('\n')
    return {
      x: a.x, y: a.y,
      w: Math.max(4, Math.max(...lines.map((l) => l.length)) * a.size * 0.5),
      h: lines.length * a.size * 1.2,
    }
  }

  const edBBox = (a) => {
    if (a.pts?.length) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
      for (const p of a.pts) {
        const r = (p[2] ?? a.width ?? 2) / 2 + 1
        x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r)
        x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r)
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    if (a.t === 'line') {
      const r = (a.width ?? 2) / 2 + 2
      const x0 = Math.min(a.x1, a.x2) - r, y0 = Math.min(a.y1, a.y2) - r
      return { x: x0, y: y0, w: Math.abs(a.x2 - a.x1) + 2 * r, h: Math.abs(a.y2 - a.y1) + 2 * r }
    }
    if (a.t === 'text') return edTextBox(a)
    if (a.w !== undefined) return { x: a.x, y: a.y, w: a.w, h: a.h }
    return null
  }

  const edResizable = (a) => a.t === 'image' || a.t === 'rect' || a.t === 'ellipse' || a.t === 'text'
  const edCorners = (b) => [
    ['nw', b.x, b.y], ['ne', b.x + b.w, b.y],
    ['sw', b.x, b.y + b.h], ['se', b.x + b.w, b.y + b.h],
  ]
  const handleAt = (a, x, y) => {
    const b = edBBox(a)
    const hs = 6 / zoom // 12 css px hit target
    for (const [id, cx, cy] of edCorners(b)) {
      if (Math.abs(x - cx) <= hs && Math.abs(y - cy) <= hs) return id
    }
    return null
  }

  const edHit = (a, x, y) => {
    if (a.pts) {
      const tol = Math.max(6, (a.width ?? 4) / 2 + 4)
      if (a.pts.length === 1) return Math.hypot(x - a.pts[0][0], y - a.pts[0][1]) < tol
      for (let i = 1; i < a.pts.length; i++) {
        const t2 = a.t === 'vstroke' ? Math.max(6, (a.pts[i][2] ?? 2) / 2 + 4) : tol
        if (distSeg(x, y, a.pts[i - 1][0], a.pts[i - 1][1], a.pts[i][0], a.pts[i][1]) < t2) return true
      }
      return false
    }
    if (a.t === 'line') return distSeg(x, y, a.x1, a.y1, a.x2, a.y2) < Math.max(6, (a.width ?? 2) / 2 + 4)
    const b = edBBox(a)
    if (!b) return false
    if (a.t === 'rect' || a.t === 'ellipse') {
      if (a.fill) return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
      const band = (a.lw ?? 2) / 2 + 4
      const outer = x >= b.x - band && x <= b.x + b.w + band && y >= b.y - band && y <= b.y + b.h + band
      const inner = x > b.x + band && x < b.x + b.w - band && y > b.y + band && y < b.y + b.h - band
      return outer && !inner
    }
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h // text, image
  }

  const pickAt = (x, y) => {
    if (sel && edResizable(sel) && annots[page].includes(sel)) {
      const c = handleAt(sel, x, y)
      if (c) return { a: sel, corner: c }
    }
    const arr = annots[page]
    for (let i = arr.length - 1; i >= 0; i--) if (edHit(arr[i], x, y)) return { a: arr[i] }
    return null
  }

  // coords-only copy (jpeg bytes shared — they are never mutated in place)
  const edSnap = (a) => {
    const o = { ...a }
    if (a.pts) o.pts = a.pts.map((p) => [...p])
    return o
  }
  const edRestore = (a, o) => {
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'w', 'h', 'size'])
      if (o[k] !== undefined) a[k] = o[k]
    if (o.pts) a.pts = o.pts.map((p) => [...p])
  }
  const edMove = (o, a, dx, dy) => {
    if (o.pts) a.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)])
    if (o.x !== undefined) a.x = o.x + dx
    if (o.y !== undefined) a.y = o.y + dy
    if (o.x1 !== undefined) { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy }
  }
  const edResize = (o, a, corner, x, y) => {
    if (a.t === 'text') { // scale font about the opposite corner
      const ob = edTextBox(o)
      const opp = { nw: [ob.x + ob.w, ob.y + ob.h], ne: [ob.x, ob.y + ob.h], sw: [ob.x + ob.w, ob.y], se: [ob.x, ob.y] }[corner]
      const oc = { nw: [ob.x, ob.y], ne: [ob.x + ob.w, ob.y], sw: [ob.x, ob.y + ob.h], se: [ob.x + ob.w, ob.y + ob.h] }[corner]
      const d0 = Math.hypot(oc[0] - opp[0], oc[1] - opp[1]) || 1
      const f = Math.max(0.1, Math.min(20, Math.hypot(x - opp[0], y - opp[1]) / d0))
      a.size = Math.max(4, o.size * f)
      a.x = corner[1] === 'w' ? opp[0] - ob.w * f : opp[0]
      a.y = corner[0] === 'n' ? opp[1] - ob.h * f : opp[1]
      return
    }
    const x1 = o.x + o.w, y1 = o.y + o.h
    if (corner[1] === 'w') { a.x = Math.min(x, x1 - 4); a.w = x1 - a.x }
    if (corner[1] === 'e') a.w = Math.max(4, x - o.x)
    if (corner[0] === 'n') { a.y = Math.min(y, y1 - 4); a.h = y1 - a.y }
    if (corner[0] === 's') a.h = Math.max(4, y - o.y)
  }

  // ---------- undo / redo ----------
  const edCloneAnnots = () => annots.map((arr) => arr.map(edSnap))
  const pushUndo = () => {
    undoStack.push(edCloneAnnots())
    if (undoStack.length > 50) undoStack.shift()
    redoStack = []
  }
  const undo = () => {
    if (!undoStack.length) return
    redoStack.push(edCloneAnnots())
    annots = undoStack.pop()
    if (sel && !annots[page].includes(sel)) sel = null
    afterMut()
  }
  const redo = () => {
    if (!redoStack.length) return
    undoStack.push(edCloneAnnots())
    annots = redoStack.pop()
    if (sel && !annots[page].includes(sel)) sel = null
    afterMut()
  }
  const afterMut = () => { redraw(); updateChrome() }

  // ---------- overlay painting ----------
  const bmpFor = (a) => {
    let b = bmpCache.get(a)
    if (b === undefined) {
      b = createImageBitmap(new Blob([a.jpeg], { type: 'image/jpeg' })).catch(() => null)
      bmpCache.set(a, b)
      b.then((r) => { bmpCache.set(a, r); if (root.isConnected) redraw() })
      return null
    }
    return b instanceof ImageBitmap ? b : null
  }

  const drawAnnot = (c, a, S) => {
    c.globalAlpha = a.alpha ?? 1
    if (a.t === 'stroke' || a.t === 'highlight' || a.t === 'vstroke') {
      c.strokeStyle = a.color
      if (a.t === 'vstroke') {
        for (let i = 1; i < a.pts.length; i++) {
          const [x0, y0, w0] = a.pts[i - 1]
          const [x1, y1, w1] = a.pts[i]
          c.lineWidth = Math.max(0.5, ((w0 + w1) / 2) * S)
          c.beginPath()
          c.moveTo(x0 * S, y0 * S)
          c.lineTo(x1 * S, y1 * S)
          c.stroke()
        }
        if (a.pts.length === 1) {
          const [x, y, w] = a.pts[0]
          c.fillStyle = a.color
          c.beginPath()
          c.arc(x * S, y * S, Math.max(0.5, (w * S) / 2), 0, 7)
          c.fill()
        }
      } else {
        c.lineWidth = Math.max(0.5, (a.width ?? 2) * S)
        c.beginPath()
        a.pts.forEach((p, i) => (i ? c.lineTo(p[0] * S, p[1] * S) : c.moveTo(p[0] * S, p[1] * S)))
        if (a.pts.length === 1) c.lineTo(a.pts[0][0] * S + 0.01, a.pts[0][1] * S)
        c.stroke()
      }
    } else if (a.t === 'line') {
      c.strokeStyle = a.color
      c.lineWidth = Math.max(0.5, (a.width ?? 2) * S)
      c.beginPath()
      c.moveTo(a.x1 * S, a.y1 * S)
      c.lineTo(a.x2 * S, a.y2 * S)
      if (a.arrow) {
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1)
        const hl = Math.max(8, (a.width ?? 2) * 3)
        for (const s of [1, -1]) {
          const th = ang + Math.PI + s * 0.45
          c.moveTo(a.x2 * S, a.y2 * S)
          c.lineTo((a.x2 + hl * Math.cos(th)) * S, (a.y2 + hl * Math.sin(th)) * S)
        }
      }
      c.stroke()
    } else if (a.t === 'rect' || a.t === 'ellipse') {
      c.beginPath()
      if (a.t === 'rect') c.rect(a.x * S, a.y * S, a.w * S, a.h * S)
      else c.ellipse((a.x + a.w / 2) * S, (a.y + a.h / 2) * S, (a.w / 2) * S, (a.h / 2) * S, 0, 0, 7)
      if (a.fill) { c.fillStyle = a.fill; c.fill() }
      if (a.stroke) { c.strokeStyle = a.stroke; c.lineWidth = Math.max(0.5, (a.lw ?? 2) * S); c.stroke() }
    } else if (a.t === 'text') {
      // y anchors the TOP of the first line — baseline ≈ y+size (matches export)
      c.fillStyle = a.color
      c.font = `${a.font === 'helvb' ? '700 ' : ''}${a.size * S}px ${ED_FAM[a.font] ?? ED_FAM.helv}`
      String(a.text).split('\n').forEach((ln, i) => c.fillText(ln, a.x * S, (a.y + a.size + i * a.size * 1.2) * S))
    } else if (a.t === 'image') {
      const b = bmpFor(a)
      if (b) c.drawImage(b, a.x * S, a.y * S, a.w * S, a.h * S)
      else { c.strokeStyle = '#71717b'; c.lineWidth = 1; c.strokeRect(a.x * S, a.y * S, a.w * S, a.h * S) }
    }
    c.globalAlpha = 1
  }

  const drawSel = (c, a, S) => {
    const b = edBBox(a)
    if (!b) return
    const u = S / zoom // canvas px per css px — chrome stays constant on screen
    c.save()
    c.strokeStyle = '#34d399'
    c.lineWidth = 1.5 * u
    c.setLineDash([5 * u, 4 * u])
    c.strokeRect((b.x - 4) * S, (b.y - 4) * S, (b.w + 8) * S, (b.h + 8) * S)
    c.setLineDash([])
    if (edResizable(a)) {
      const hs = 4 / zoom // 8 css px squares at bbox corners
      c.fillStyle = '#34d399'
      c.strokeStyle = '#09090b'
      for (const [, cx, cy] of edCorners(b)) {
        c.fillRect((cx - hs) * S, (cy - hs) * S, hs * 2 * S, hs * 2 * S)
        c.strokeRect((cx - hs) * S, (cy - hs) * S, hs * 2 * S, hs * 2 * S)
      }
    }
    c.restore()
  }

  const redraw = () => {
    if (!octx || !doc) return
    const S = over.width / pageW() // backing px per pt
    octx.clearRect(0, 0, over.width, over.height)
    octx.lineJoin = 'round'
    octx.lineCap = 'round'
    for (const a of annots[page]) drawAnnot(octx, a, S)
    if (draft) drawAnnot(octx, draft, S)
    if (sel && annots[page].includes(sel)) drawSel(octx, sel, S)
    positionChip()
  }

  const applyPageSize = () => {
    pageEl.style.width = `${pageW() * zoom}px`
    pageEl.style.height = `${pageH() * zoom}px`
  }

  // base raster: DOM size updates synchronously, bitmap follows async
  const renderBase = async () => {
    if (!doc) return
    closeTextIn(true)
    const my = ++baseGen
    const W = pageW(), H = pageH()
    const dpr = self.devicePixelRatio || 1
    const bw = Math.max(2, Math.min(4096, Math.round(W * zoom * dpr)))
    const bh = Math.max(2, Math.round((bw * H) / W))
    applyPageSize()
    base.width = over.width = bw
    base.height = over.height = bh
    const ctx = base.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, bw, bh)
    redraw()
    try {
      const cv = await renderPage(doc, leaves[page], { width: bw, cache: imgCache })
      if (my !== baseGen) return
      if (cv) ctx.drawImage(cv, 0, 0, bw, bh)
    } catch { /* blank page stays white */ }
  }

  // ---------- zoom / nav ----------
  const setZoom = (z) => {
    const nz = Math.max(0.25, Math.min(4, z))
    if (nz === zoom) return
    zoom = nz
    renderBase()
    updateChrome()
  }

  // zoom keeping the pt under (cx,cy) client coords stationary
  const zoomAround = (cx, cy, z) => {
    const nz = Math.max(0.25, Math.min(4, z))
    if (nz === zoom) return
    const r = pageEl.getBoundingClientRect()
    const ax = (cx - r.left) / zoom, ay = (cy - r.top) / zoom
    zoom = nz
    if (pinch) {
      // mid-pinch: leave backing canvases alone — CSS stretch keeps base +
      // overlay aligned for free; a real re-raster runs when the pinch ends
      applyPageSize()
      redraw()
    } else {
      renderBase()
    }
    const r2 = pageEl.getBoundingClientRect()
    stage.scrollLeft += r2.left + ax * zoom - cx
    stage.scrollTop += r2.top + ay * zoom - cy
    updateChrome()
  }

  const fitZoom = () => setZoom(Math.max(0.25, stage.clientWidth / pageW()))

  const gotoPage = (i) => {
    if (!doc || i < 0 || i >= leaves.length) return
    cancelGesture()
    page = i
    sel = null
    renderBase()
    thumbsEl?.querySelectorAll('.edthumb').forEach((el, j) => el.classList.toggle('cur', j === page))
    updateChrome()
  }

  // ---------- tools ----------
  const shapeDraft = (x0, y0, x1, y1) => {
    if (tool === 'line' || tool === 'arrow')
      return { t: 'line', x1: x0, y1: y0, x2: x1, y2: y1, color, width: penWidth, alpha, arrow: tool === 'arrow' }
    const x = Math.min(x0, x1), y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0), hgt = Math.abs(y1 - y0)
    if (tool === 'rect') return { t: 'rect', x, y, w, h: hgt, stroke: color, fill: null, lw: penWidth, alpha }
    if (tool === 'ellipse') return { t: 'ellipse', x, y, w, h: hgt, stroke: color, fill: null, lw: penWidth, alpha }
    return { t: 'rect', x, y, w, h: hgt, stroke: null, fill: '#ffffff', lw: 0, alpha: 1 } // whiteout
  }

  const setTool = (t) => {
    if (t === 'image') { pickImage(); return }
    tool = t
    closeTextIn(true)
    for (const [k, b] of toolBtns) b.classList.toggle('on', k === t)
    // draw modes own every gesture; select/text/eraser let the stage pan natively
    // (pan-x pan-y still blocks browser pinch-zoom so our JS pinch keeps working)
    over.style.touchAction = ED_DRAW.has(t) ? 'none' : 'pan-x pan-y'
    over.style.cursor = t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair'
    if (t === 'hilite' && penWidth < 10) { penWidth = 14; syncOpts() }
    updateChrome()
  }

  const pickImage = () => {
    const inp = h('input', { type: 'file', accept: 'image/*', class: 'hidden-input' })
    inp.addEventListener('cancel', () => inp.remove())
    inp.onchange = async () => {
      const f = inp.files?.[0]
      inp.remove()
      if (!f) return
      try {
        const bmp = await createImageBitmap(f)
        const cv = document.createElement('canvas')
        cv.width = bmp.width
        cv.height = bmp.height
        const cx = cv.getContext('2d')
        cx.fillStyle = '#ffffff' // flatten alpha onto white
        cx.fillRect(0, 0, cv.width, cv.height)
        cx.drawImage(bmp, 0, 0)
        const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.9))
        if (!blob) throw new Error('encode failed')
        const W = pageW(), H = pageH()
        let w = Math.min(200, W - 40)
        let hgt = (w * bmp.height) / bmp.width
        if (hgt > H - 40) { hgt = H - 40; w = (hgt * bmp.width) / bmp.height }
        const a = {
          t: 'image', x: (W - w) / 2, y: (H - hgt) / 2, w, h: hgt,
          jpeg: new Uint8Array(await blob.arrayBuffer()),
        }
        bmpCache.set(a, bmp)
        pushUndo()
        annots[page].push(a)
        sel = a
        setTool('select')
        afterMut()
      } catch {
        error = 'could not read that image'
        paint()
      }
    }
    editorEl.append(inp)
    inp.click()
  }

  const openTextIn = (x, y) => {
    closeTextIn(true)
    const ta = h('textarea', {
      class: 'edtxtin',
      rows: '1',
      style: {
        left: `${x * zoom}px`, top: `${y * zoom}px`,
        fontSize: `${fontSize * zoom}px`, color,
        fontFamily: ED_FAM[font], fontWeight: font === 'helvb' ? '700' : '400',
      },
      onkeydown: (e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeTextIn(true) }
        else if (e.key === 'Escape') { e.preventDefault(); closeTextIn(false) }
      },
      onblur: () => closeTextIn(true),
    })
    txtIn = { ta, x, y }
    pageEl.append(ta)
    ta.focus()
  }

  const closeTextIn = (commit) => {
    if (!txtIn) return
    const { ta, x, y } = txtIn
    txtIn = null // null first — removing the node re-fires blur
    const text = ta.value.replace(/\s+$/, '')
    ta.remove()
    if (!commit || !text.trim()) return
    pushUndo()
    const a = { t: 'text', x, y, text, size: fontSize, color, font, alpha }
    annots[page].push(a)
    sel = a
    afterMut()
  }

  const delSel = () => {
    if (!sel) return
    const arr = annots[page]
    const i = arr.indexOf(sel)
    if (i < 0) { sel = null; return }
    pushUndo()
    arr.splice(i, 1)
    sel = null
    afterMut()
  }

  const clearPage = () => {
    if (!annots[page]?.length) return
    pushUndo()
    annots[page] = []
    sel = null
    afterMut()
  }

  // ---------- gestures ----------
  const cancelGesture = () => {
    if (drag && sel && (drag.kind === 'move' || drag.kind === 'resize')) {
      if (drag.pushed) undoStack.pop()
      edRestore(sel, drag.o)
    }
    draft = null
    drag = null
    tap = null
    pendingDeselect = null
    captureId = null
    redraw()
    updateChrome()
  }

  const onDown = (e) => {
    if (!doc || (e.pointerType === 'mouse' && e.button !== 0)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) { // second finger → pinch, kill whatever was mid-flight
      cancelGesture()
      const [p, q] = [...pointers.values()]
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) }
      return
    }
    if (pointers.size > 2) return
    const [x, y] = toPt(e.clientX, e.clientY)
    if (tool === 'select') {
      const hit = pickAt(x, y)
      if (hit) {
        sel = hit.a
        captureId = e.pointerId
        over.setPointerCapture(e.pointerId)
        drag = { kind: hit.corner ? 'resize' : 'move', corner: hit.corner, sx: x, sy: y, o: edSnap(hit.a), pushed: false }
        e.preventDefault()
      } else {
        pendingDeselect = e.pointerId // confirmed on pointerup — pans must not deselect
        over.setPointerCapture(e.pointerId) // else an off-canvas release leaks the pointers entry → phantom pinch
      }
      redraw()
      updateChrome()
    } else if (tool === 'pen' || tool === 'hilite') {
      captureId = e.pointerId
      over.setPointerCapture(e.pointerId)
      const w = penWidth * (0.4 + 1.2 * (e.pressure || 0.5))
      draft = tool === 'pen'
        ? { t: 'vstroke', pts: [[x, y, w]], color, alpha }
        : { t: 'highlight', pts: [[x, y]], color, width: penWidth, alpha: Math.min(alpha, 0.35) }
      e.preventDefault()
      redraw()
    } else if (tool === 'text' || tool === 'eraser') {
      tap = { id: e.pointerId, x, y } // act on pointerup so pans don't fire it
      captureId = e.pointerId // capture so the up/cancel always reaches us
      over.setPointerCapture(e.pointerId)
    } else { // line, arrow, rect, ellipse, whiteout
      captureId = e.pointerId
      over.setPointerCapture(e.pointerId)
      drag = { kind: 'shape', sx: x, sy: y }
      draft = shapeDraft(x, y, x, y)
      e.preventDefault()
      redraw()
    }
  }

  const onMove = (e) => {
    const p = pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (pointers.size >= 2) {
      if (pinch) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (d > 0 && pinch.d > 0) zoomAround((a.x + b.x) / 2, (a.y + b.y) / 2, (zoom * d) / pinch.d)
        pinch.d = d
      }
      return
    }
    if (e.pointerId !== captureId) return
    const [x, y] = toPt(e.clientX, e.clientY)
    if (draft && (draft.t === 'vstroke' || draft.t === 'highlight')) {
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const [ex, ey] = toPt(ev.clientX, ev.clientY)
        const last = draft.pts[draft.pts.length - 1]
        if (Math.hypot(ex - last[0], ey - last[1]) < 0.6) continue
        if (draft.t === 'vstroke') draft.pts.push([ex, ey, penWidth * (0.4 + 1.2 * (ev.pressure || 0.5))])
        else draft.pts.push([ex, ey])
      }
      redraw()
    } else if (drag?.kind === 'shape') {
      draft = shapeDraft(drag.sx, drag.sy, x, y)
      redraw()
    } else if (drag?.kind === 'move' && sel) {
      const dx = x - drag.sx, dy = y - drag.sy
      if (dx || dy) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; updateChrome() }
        edMove(drag.o, sel, dx, dy)
        redraw()
      }
    } else if (drag?.kind === 'resize' && sel) {
      if (!drag.pushed) { pushUndo(); drag.pushed = true; updateChrome() }
      edResize(drag.o, sel, drag.corner, x, y)
      redraw()
    }
  }

  const onUp = (e) => {
    pointers.delete(e.pointerId)
    if (e.pointerType === 'mouse' && e.button !== 0) return // stray right-release mid-drag commits nothing
    if (pinch && pointers.size < 2) { pinch = null; renderBase() } // re-raster at final zoom
    if (tap && tap.id === e.pointerId) {
      const { x, y } = tap
      tap = null
      captureId = null
      const [ux, uy] = toPt(e.clientX, e.clientY)
      if (Math.hypot(ux - x, uy - y) > 8) return // dragged, not tapped
      if (tool === 'text') openTextIn(x, y)
      else { // eraser
        const hit = pickAt(x, y)
        if (hit) {
          pushUndo()
          const arr = annots[page]
          arr.splice(arr.indexOf(hit.a), 1)
          if (sel === hit.a) sel = null
          afterMut()
        }
      }
      return
    }
    if (pendingDeselect === e.pointerId) {
      pendingDeselect = null
      sel = null
      redraw()
      updateChrome()
      return
    }
    if (e.pointerId !== captureId) return
    captureId = null
    if (draft) {
      const d = draft
      draft = null
      const ok = d.pts ? d.pts.length >= 1
        : d.t === 'line' ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 2
        : d.w > 2 && d.h > 2
      if (ok) {
        pushUndo()
        annots[page].push(d)
        sel = d
      }
      afterMut()
    }
    drag = null
  }

  const onCancel = (e) => {
    pointers.delete(e.pointerId)
    if (pinch && pointers.size < 2) { pinch = null; renderBase() }
    cancelGesture()
  }

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    zoomAround(e.clientX, e.clientY, zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.0018))
  }

  const onTouchStart = (e) => {
    if (e.touches.length > 1) { e.preventDefault(); return } // our pinch, not the browser's
    if (tool !== 'select') return
    const t = e.touches[0]
    if (!t) return
    const [x, y] = toPt(t.clientX, t.clientY)
    if (pickAt(x, y)) e.preventDefault() // block native pan so pointer events drive the drag
  }

  // ---------- build ----------
  const buildThumbs = () => {
    thumbObs?.disconnect()
    thumbObs = null
    setKids(thumbsEl)
    const render1 = (cell, i) => {
      renderPage(doc, leaves[i], { width: 180, cache: imgCache })
        .then((cv) => { if (cv && cell.isConnected) { cv.className = 'edthumbc'; cell.prepend(cv) } })
        .catch(() => {})
    }
    const cells = dims.map((d, i) => {
      const W = d.rotate % 180 === 0 ? d.w : d.h
      const H = d.rotate % 180 === 0 ? d.h : d.w
      const cell = h('button', {
        type: 'button', class: 'edthumb' + (i === page ? ' cur' : ''), title: `Page ${i + 1}`,
        style: { aspectRatio: `${W} / ${H}` },
        onclick: () => gotoPage(i),
      }, h('span', { class: 'edthumbn' }, String(i + 1)))
      thumbsEl.append(cell)
      return cell
    })
    if ('IntersectionObserver' in window) {
      thumbObs = new IntersectionObserver((ents) => {
        for (const en of ents) {
          if (!en.isIntersecting) continue
          thumbObs.unobserve(en.target)
          render1(en.target, cells.indexOf(en.target))
        }
      }, { root: thumbsEl, rootMargin: '120px' })
      cells.forEach((c) => thumbObs.observe(c))
    } else {
      cells.forEach((c, i) => render1(c, i))
    }
  }

  const build = () => {
    toolBtns = new Map()
    metaEl = h('p', { class: 'meta dim' })

    const toolRow = h('div', { class: 'edtools' })
    for (const [t, label] of ED_TOOLS) {
      const b = h('button', { type: 'button', class: 'edt', onclick: () => setTool(t) }, label)
      toolBtns.set(t, b)
      toolRow.append(b)
    }

    swatchEls = []
    const swatches = h('div', { class: 'edsws' },
      ED_COLORS.map((c) => {
        const b = h('button', {
          type: 'button', class: 'edsw', title: c, style: { background: c },
          onclick: () => { color = c; syncOpts() },
        })
        swatchEls.push([c, b])
        return b
      }),
      colorPick = h('input', {
        type: 'color', class: 'edpick', value: color, title: 'Custom color',
        oninput: (e) => { color = e.target.value; syncOpts() },
      }))
    widthLbl = h('span', { class: 'edrangev' })
    widthSlider = h('input', {
      type: 'range', min: '1', max: '40', value: String(penWidth), class: 'slider edslider',
      oninput: (e) => { penWidth = +e.target.value; syncOpts() },
    })
    const widthWrap = h('label', { class: 'edopt' }, 'Stroke', widthSlider, widthLbl)
    alphaLbl = h('span', { class: 'edrangev' })
    alphaSlider = h('input', {
      type: 'range', min: '10', max: '100', value: '100', class: 'slider edslider',
      oninput: (e) => { alpha = +e.target.value / 100; syncOpts() },
    })
    const alphaWrap = h('label', { class: 'edopt' }, 'Opacity', alphaSlider, alphaLbl)
    fontWrap = h('span', { class: 'edtext' },
      h('select', { class: 'textin sel edfont', onchange: (e) => (font = e.target.value) },
        ED_FONTS.map(([v, l]) => h('option', { value: v, selected: v === font || undefined }, l))),
      h('input', {
        type: 'number', class: 'textin num ednum', min: '8', max: '72', value: String(fontSize), title: 'Font size (pt)',
        oninput: (e) => { fontSize = Math.max(8, Math.min(72, +e.target.value || 16)) },
      }))
    const optsRow = h('div', { class: 'edopts' }, swatches, widthWrap, alphaWrap, fontWrap)

    prevBtn = h('button', { type: 'button', class: 'edt', onclick: () => gotoPage(page - 1) }, '‹ Prev')
    pageLbl = h('span', { class: 'edpgl' })
    nextBtn = h('button', { type: 'button', class: 'edt', onclick: () => gotoPage(page + 1) }, 'Next ›')
    zoomLbl = h('span', { class: 'edpgl' })
    actionSlot = h('div', { class: 'edacts' })
    const navRow = h('div', { class: 'ednav' },
      prevBtn, pageLbl, nextBtn, h('span', { class: 'edsep' }),
      h('button', { type: 'button', class: 'edt', title: 'Zoom out', onclick: () => setZoom(zoom / 1.25) }, '−'),
      zoomLbl,
      h('button', { type: 'button', class: 'edt', title: 'Zoom in', onclick: () => setZoom(zoom * 1.25) }, '+'),
      h('button', { type: 'button', class: 'edt', title: 'Fit width', onclick: fitZoom }, 'Fit'),
      h('span', { class: 'edsep' }),
      actionSlot)

    base = h('canvas', { class: 'edbase' })
    over = h('canvas', { class: 'edover' })
    octx = over.getContext('2d')
    delChip = iconBtn('x', 'Delete annotation', (e) => { e.stopPropagation(); delSel() })
    delChip.classList.add('edsel')
    delChip.style.display = 'none'
    pageEl = h('div', { class: 'edpage' }, base, over, delChip)
    stage = h('div', { class: 'edwrap' }, pageEl)
    thumbsEl = h('div', { class: 'edthumbs' })
    dlBtn = Btn('Download edited PDF', { onclick: run })
    editorEl = h('div', { class: 'ed' }, metaEl, toolRow, optsRow, navRow, stage, thumbsEl, dlBtn)

    over.addEventListener('pointerdown', onDown)
    over.addEventListener('pointermove', onMove)
    over.addEventListener('pointerup', onUp)
    over.addEventListener('pointercancel', onCancel)
    over.addEventListener('touchstart', onTouchStart, { passive: false })
    over.addEventListener('contextmenu', (e) => e.preventDefault())
    stage.addEventListener('wheel', onWheel, { passive: false })

    setTool('select')
    syncOpts()
    buildThumbs()
  }

  const positionChip = () => {
    if (!delChip) return
    const b = sel && annots[page]?.includes(sel) ? edBBox(sel) : null
    if (!b) { delChip.style.display = 'none'; return }
    delChip.style.display = ''
    delChip.style.left = `${(b.x + b.w) * zoom + 4}px`
    delChip.style.top = `${b.y * zoom - 12}px`
  }

  const syncOpts = () => {
    for (const [c, b] of swatchEls) b.classList.toggle('on', c === color)
    if (colorPick) colorPick.value = color
    if (widthSlider) widthSlider.value = String(penWidth)
    if (widthLbl) widthLbl.textContent = `${penWidth}pt`
    if (alphaSlider) alphaSlider.value = String(Math.round(alpha * 100))
    if (alphaLbl) alphaLbl.textContent = `${Math.round(alpha * 100)}%`
  }

  const updateChrome = () => {
    if (!editorEl) return
    const total = annots.reduce((n, a) => n + a.length, 0)
    metaEl.textContent =
      `${file.name} · ${fmtBytes(file.size)} · ${leaves.length} page${leaves.length > 1 ? 's' : ''} · ` +
      `${total} annotation${total === 1 ? '' : 's'}`
    pageLbl.textContent = `p ${page + 1} / ${leaves.length}`
    zoomLbl.textContent = `${Math.round(zoom * 100)}%`
    prevBtn.disabled = page === 0
    nextBtn.disabled = page === leaves.length - 1
    for (const [t, b] of toolBtns) b.classList.toggle('on', t === tool)
    fontWrap.style.display = tool === 'text' ? '' : 'none'
    setKids(actionSlot, Toolbar([
      ['↶ Undo', undo, !undoStack.length],
      ['↷ Redo', redo, !redoStack.length],
      ['Clear page', clearPage, !annots[page]?.length],
    ]))
    setKids(dlBtn, h('span', { class: 'edbtnin' }, icon('download', 'icon-sm'), busy ? 'Working…' : 'Download edited PDF'))
    dlBtn.disabled = busy
    positionChip()
  }

  // ---------- load / export ----------
  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    bytes = null
    doc = null
    editorEl = null
    annots = []
    sel = null
    undoStack = []
    redoStack = []
    pointers.clear() // a load mid-gesture must not leak pointer/pinch/draft state
    pinch = null
    cancelGesture()
    imgCache.clear()
    thumbObs?.disconnect()
    thumbObs = null
    paint()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const d = await parsePdf(b)
      if (my !== loadGen) return
      bytes = b
      doc = d
      leaves = pageLeaves(d)
      dims = pageDims(d)
      annots = leaves.map(() => [])
      page = 0
      zoom = 1
      build()
      paint()
      gotoPage(0)
      if (pageW() * zoom > stage.clientWidth) fitZoom() // small screens open fit-width
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that PDF'
      file = null
      doc = null
      paint()
    }
  }

  const run = async () => {
    busy = true
    error = ''
    updateChrome()
    try {
      const out = await annotatePdf(bytes, annots)
      saveBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-edited.pdf`)
    } catch (e) {
      error = e.message || 'export failed'
      paint()
    } finally {
      busy = false
      updateChrome()
    }
  }

  function paint() {
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      editorEl,
      ErrorText(error))
  }

  // keyboard: Ctrl+Z/Y undo-redo, Del deletes selection, Esc cancels — self-removes when detached
  const onKey = (e) => {
    if (!root.isConnected) {
      thumbObs?.disconnect()
      return document.removeEventListener('keydown', onKey)
    }
    if (!doc || /input|textarea|select/i.test(e.target.tagName)) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo() }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); delSel() }
    else if (e.key === 'Escape') {
      if (draft || drag) cancelGesture()
      else if (sel) { sel = null; afterMut() }
    }
  }
  document.addEventListener('keydown', onKey)

  paint()
  return root
}
