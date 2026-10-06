// Design & Edit — painting on raster layers. A stroke accumulates soft dabs
// into a coverage mask; the layer is rebuilt from its pre-stroke pixels plus
// the tool's "source" (colour, cloned pixels, blurred pixels…) shown through
// that mask, clipped by the selection, at the stroke opacity. So overlapping
// dabs never exceed the chosen opacity, and the pre-stroke canvas is kept
// untouched for undo (copy-on-write).
import { makeCanvas, dupCanvas, pixelsOf, canvasFromRGBA } from './doc.js'
import { floodMask } from './raster.js'
import { blurRGBA, sharpenRGBA, adjustRGBA } from '../editor/imagefx.js'

const selCanvasCache = new WeakMap()
/** Selection mask → canvas whose alpha is the mask (cached per mask). */
export function maskCanvas(mask, w, h) {
  let c = selCanvasCache.get(mask)
  if (c && c.width === w && c.height === h) return c
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let p = 0; p < mask.length; p++) rgba[p * 4 + 3] = mask[p]
  c = canvasFromRGBA(rgba, w, h)
  selCanvasCache.set(mask, c)
  return c
}

export function hexRGB(hex) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  const n = m ? parseInt(m[1], 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function processedCopy(src, fn) {
  const w = src.width, h = src.height
  const d = new Uint8ClampedArray(pixelsOf(src))
  fn(d, w, h)
  return canvasFromRGBA(d, w, h)
}

/**
 * Start a stroke on a canvas-aligned raster layer.
 * tool: brush | eraser | clone | blur | sharpen | dodge | burn | smudge
 * o: {size, hardness 0-1, opacity 0-1, color, strength 0-1, cloneFrom:[x,y], sel: mask|null}
 */
export function beginStroke(doc, L, tool, o) {
  const before = L.canvas
  const work = dupCanvas(before)
  L.canvas = work
  const W = doc.w, H = doc.h
  const wctx = work.getContext('2d')
  const st = { tool, o, before, work, last: null, bbox: null, cloneOff: null }
  if (tool === 'smudge') {
    st.dab = makeCanvas(1, 1)
    return st
  }
  st.mask = makeCanvas(W, H)
  st.mctx = st.mask.getContext('2d')
  st.tmp = makeCanvas(W, H)
  st.tctx = st.tmp.getContext('2d')
  st.sel = o.sel ? maskCanvas(o.sel, W, H) : null
  const k = o.strength ?? 0.5
  if (tool === 'blur') st.source = processedCopy(before, (d, w, h) => blurRGBA(d, w, h, Math.max(1, o.size * 0.12 * (0.5 + k))))
  else if (tool === 'sharpen') st.source = processedCopy(before, (d, w, h) => sharpenRGBA(d, w, h, 40 + k * 120))
  else if (tool === 'dodge') st.source = processedCopy(before, (d, w, h) => adjustRGBA(d, w, h, { exposure: 8 + k * 36 }))
  else if (tool === 'burn') st.source = processedCopy(before, (d, w, h) => adjustRGBA(d, w, h, { exposure: -(8 + k * 36) }))
  st.wctx = wctx
  return st
}

function grow(st, x, y, r) {
  const b = { x: Math.floor(x - r - 2), y: Math.floor(y - r - 2), w: Math.ceil(2 * r + 4), h: Math.ceil(2 * r + 4) }
  if (!st.bbox) st.bbox = b
  else {
    const x0 = Math.min(st.bbox.x, b.x), y0 = Math.min(st.bbox.y, b.y)
    st.bbox = { x: x0, y: y0, w: Math.max(st.bbox.x + st.bbox.w, b.x + b.w) - x0, h: Math.max(st.bbox.y + st.bbox.h, b.y + b.h) - y0 }
  }
  return b
}

function stamp(st, x, y, r) {
  const c = st.mctx
  const hard = Math.min(0.99, Math.max(0, st.o.hardness ?? 0.7))
  const g = c.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, 'rgba(0,0,0,1)')
  g.addColorStop(hard, 'rgba(0,0,0,1)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.fillStyle = g
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
  grow(st, x, y, r)
}

function smudgeStep(st, fx, fy, x, y, r) {
  const d = Math.ceil(r * 2)
  if (st.dab.width !== d) { st.dab.width = d; st.dab.height = d }
  const dc = st.dab.getContext('2d')
  dc.globalCompositeOperation = 'copy'
  dc.drawImage(st.work, fx - r, fy - r, d, d, 0, 0, d, d)
  dc.globalCompositeOperation = 'destination-in'
  const g = dc.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, `rgba(0,0,0,${st.o.strength ?? 0.5})`)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  dc.fillStyle = g
  dc.fillRect(0, 0, d, d)
  const w = st.work.getContext('2d')
  w.save()
  if (st.o.sel) { // smudge only inside the selection
    const sc = maskCanvas(st.o.sel, st.work.width, st.work.height)
    dc.globalCompositeOperation = 'destination-in'
    dc.drawImage(sc, x - r, y - r, d, d, 0, 0, d, d)
  }
  w.drawImage(st.dab, x - r, y - r)
  w.restore()
  grow(st, x, y, r)
}

/** Add stroke points (doc px). pressure 0-1 (pens), 0.5 for mice. */
export function strokeTo(st, x, y, pressure = 0.5) {
  const pr = st.o.pressure === false ? 1 : 0.35 + pressure * 1.3
  const r = Math.max(0.5, (st.o.size / 2) * Math.min(1.6, pr))
  if (st.tool === 'clone' && !st.cloneOff) {
    const [sx, sy] = st.o.cloneFrom
    st.cloneOff = [sx - x, sy - y]
  }
  const step = Math.max(0.7, r * (st.tool === 'smudge' ? 0.15 : 0.22))
  const from = st.last ?? [x, y]
  const dist = Math.hypot(x - from[0], y - from[1])
  const n = st.last ? Math.max(1, Math.floor(dist / step)) : 1
  let px = from[0], py = from[1]
  for (let i = 1; i <= n; i++) {
    const t = st.last ? i / n : 1
    const nx = from[0] + (x - from[0]) * t, ny = from[1] + (y - from[1]) * t
    if (st.tool === 'smudge') smudgeStep(st, px, py, nx, ny, r)
    else stamp(st, nx, ny, r)
    px = nx; py = ny
  }
  st.last = [x, y]
  if (st.tool !== 'smudge') renderStroke(st)
}

function renderStroke(st) {
  const W = st.work.width, H = st.work.height
  const b = st.bbox
  const x = Math.max(0, b.x), y = Math.max(0, b.y), w = Math.min(W, b.x + b.w) - x, h = Math.min(H, b.y + b.h) - y
  if (w <= 0 || h <= 0) return
  // 'copy' / 'destination-in' affect the whole canvas outside what's drawn: clip to the dirty rect
  const t = st.tctx
  t.save()
  t.beginPath()
  t.rect(x, y, w, h)
  t.clip()
  t.globalCompositeOperation = 'copy'
  if (st.tool === 'eraser') t.drawImage(st.mask, x, y, w, h, x, y, w, h)
  else {
    if (st.tool === 'brush') { t.fillStyle = st.o.color ?? '#000000'; t.fillRect(x, y, w, h) } else if (st.tool === 'clone') {
      t.clearRect(x, y, w, h)
      t.globalCompositeOperation = 'source-over'
      const [ox, oy] = st.cloneOff
      t.drawImage(st.before, x + ox, y + oy, w, h, x, y, w, h)
    } else t.drawImage(st.source, x, y, w, h, x, y, w, h)
    t.globalCompositeOperation = 'destination-in'
    t.drawImage(st.mask, x, y, w, h, x, y, w, h)
  }
  if (st.sel) { t.globalCompositeOperation = 'destination-in'; t.drawImage(st.sel, x, y, w, h, x, y, w, h) }
  t.restore()
  const c = st.wctx
  c.save()
  c.beginPath()
  c.rect(x, y, w, h)
  c.clip()
  c.globalCompositeOperation = 'copy'
  c.drawImage(st.before, x, y, w, h, x, y, w, h)
  c.globalCompositeOperation = st.tool === 'eraser' ? 'destination-out' : 'source-over'
  c.globalAlpha = st.o.opacity ?? 1
  c.drawImage(st.tmp, x, y, w, h, x, y, w, h)
  c.restore()
}

/** Paint bucket: fill similar pixels around (x,y) with a colour. sample = rgba to judge similarity on (layer or merged). */
export function bucketFill(doc, L, x, y, { color, tolerance = 32, contiguous = true, opacity = 1, sel = null, sample = null }) {
  const W = doc.w, H = doc.h
  const pix = sample ?? pixelsOf(L.canvas)
  let m = floodMask(pix, W, H, x, y, { tolerance, contiguous })
  if (sel) { const n = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) n[i] = Math.min(m[i], sel[i]); m = n }
  const work = dupCanvas(L.canvas)
  const mc = maskCanvas(m, W, H)
  const t = makeCanvas(W, H)
  const tc = t.getContext('2d')
  tc.fillStyle = color
  tc.fillRect(0, 0, W, H)
  tc.globalCompositeOperation = 'destination-in'
  tc.drawImage(mc, 0, 0)
  const c = work.getContext('2d')
  c.globalAlpha = opacity
  c.drawImage(t, 0, 0)
  L.canvas = work
  return m
}

/** Gradient drawn along (x0,y0)→(x1,y1). type: linear | radial. c2 null = fade to transparent. */
export function gradientFill(doc, L, x0, y0, x1, y1, { type = 'linear', c1 = '#000000', c2 = '#ffffff', opacity = 1, sel = null }) {
  const W = doc.w, H = doc.h
  const t = makeCanvas(W, H)
  const tc = t.getContext('2d')
  const g = type === 'radial' ? tc.createRadialGradient(x0, y0, 0, x0, y0, Math.max(1, Math.hypot(x1 - x0, y1 - y0))) : tc.createLinearGradient(x0, y0, x1, y1)
  g.addColorStop(0, c1)
  const [r, gg, b] = hexRGB(c1)
  g.addColorStop(1, c2 ?? `rgba(${r},${gg},${b},0)`)
  tc.fillStyle = g
  tc.fillRect(0, 0, W, H)
  if (sel) { tc.globalCompositeOperation = 'destination-in'; tc.drawImage(maskCanvas(sel, W, H), 0, 0) }
  const work = dupCanvas(L.canvas)
  const c = work.getContext('2d')
  c.globalAlpha = opacity
  c.drawImage(t, 0, 0)
  L.canvas = work
}
