// Design & Edit — document model: layers (raster / text / shape), rendering
// and compositing on canvas, text layout, shape paths, project files.
// Coordinates are document pixels, origin top-left. Every layer has a box
// {x, y, w, h}, a rotation `rot` (degrees, clockwise, about the box centre),
// flips, opacity and a blend mode. Raster pixels are never mutated in place
// once a history step references them (copy-on-write), so undo is just a
// list of shallow layer snapshots.
import { processImage, fxIsIdentity } from '../editor/imagefx.js'

export const BLEND_MODES = [
  ['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['color-dodge', 'Colour dodge'], ['color-burn', 'Colour burn'], ['hard-light', 'Hard light'], ['soft-light', 'Soft light'],
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Colour'], ['luminosity', 'Luminosity'],
]
export const STUDIO_FONTS = [
  ['Inter, system-ui, sans-serif', 'Sans'], ['Georgia, "Times New Roman", serif', 'Serif'], ['"Courier New", monospace', 'Mono'],
  ['Impact, "Arial Black", sans-serif', 'Impact'], ['"Trebuchet MS", sans-serif', 'Trebuchet'], ['"Palatino Linotype", Palatino, serif', 'Palatino'],
  ['"Comic Sans MS", "Comic Neue", cursive', 'Comic'], ['"Brush Script MT", "Segoe Script", cursive', 'Script'], ['Verdana, sans-serif', 'Verdana'],
  ['"Arial Narrow", Arial, sans-serif', 'Narrow'],
]
export const SIZE_PRESETS = [
  ['Instagram post', 1080, 1080], ['Instagram story', 1080, 1920], ['Facebook post', 1200, 630], ['YouTube thumbnail', 1280, 720],
  ['X / Twitter post', 1600, 900], ['LinkedIn banner', 1584, 396], ['Presentation 16:9', 1920, 1080], ['Phone wallpaper', 1170, 2532],
  ['A4 (300 dpi)', 2480, 3508], ['US Letter (300 dpi)', 2550, 3300], ['A5 flyer (300 dpi)', 1748, 2480], ['Business card', 1050, 600],
  ['Poster 18×24 (150 dpi)', 2700, 3600], ['Icon / logo', 1024, 1024],
]

let idSeq = 0
export const newLayerId = () => `L${Date.now().toString(36)}${(idSeq++).toString(36)}`

export function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}
export function dupCanvas(src) {
  const c = makeCanvas(src.width, src.height)
  c.getContext('2d').drawImage(src, 0, 0)
  return c
}
export function canvasFromRGBA(rgba, w, h) {
  const c = makeCanvas(w, h)
  c.getContext('2d').putImageData(new ImageData(rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba), w, h), 0, 0)
  return c
}
export const pixelsOf = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data

const base = (type, name, x, y, w, h) => ({ id: newLayerId(), type, name, x, y, w, h, rot: 0, opacity: 1, blend: 'normal', hidden: false, locked: false, flipH: false, flipV: false })

export function rasterLayer(name, canvas, x = 0, y = 0, w = canvas.width, h = canvas.height) {
  return { ...base('raster', name, x, y, w, h), canvas, fx: null }
}
export function textLayer(text, x, y, opts = {}) {
  const L = {
    ...base('text', 'Text', x, y, 10, 10), text,
    font: STUDIO_FONTS[0][0], size: 72, weight: 700, italic: false, color: '#111111', align: 'left',
    spacing: 0, lineHeight: 1.2, outline: null, shadow: null, bg: null, bgPad: 0.25, ...opts,
  }
  fitText(L)
  return L
}
export function shapeLayer(kind, x, y, w, h, opts = {}) {
  return {
    ...base('shape', SHAPE_NAMES[kind] ?? 'Shape', x, y, w, h), kind,
    fill: '#3b82f6', fill2: null, gradAngle: 90, stroke: null, strokeW: 0, radius: 0, sides: kind === 'star' ? 5 : 6, inner: 0.45, ...opts,
  }
}
export const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', star: 'Star', polygon: 'Polygon', triangle: 'Triangle', heart: 'Heart' }

export function newDocument(w, h, bg = '#ffffff') {
  const c = makeCanvas(w, h)
  if (bg) { const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, w, h) }
  return { w: c.width, h: c.height, layers: [rasterLayer('Background', c)], sel: null }
}

// ---------- text ----------
let stMeasureCtx = null
const mctx = () => (stMeasureCtx ??= makeCanvas(4, 4).getContext('2d'))
export const textFont = (L, px = L.size) => `${L.italic ? 'italic ' : ''}${L.weight ?? 400} ${px}px ${L.font}`
function lineW(ctx, s, spacing) { return ctx.measureText(s).width + spacing * Math.max(0, [...s].length - 1) }
/** Lines + natural size of a text layer (at its own font size). */
export function layoutStudioText(L) {
  const ctx = mctx()
  ctx.font = textFont(L)
  const lines = String(L.text ?? '').split('\n')
  const widths = lines.map((s) => lineW(ctx, s, L.spacing || 0))
  const lh = L.size * (L.lineHeight || 1.2)
  return { lines, widths, lh, w: Math.max(1, ...widths), h: Math.max(lh, lines.length * lh) }
}
/** Text boxes size themselves from the text; keeps the box centre unless anchor = 'tl'. */
export function fitText(L, anchor = 'tl') {
  const t = layoutStudioText(L)
  const pad = L.bg ? L.size * (L.bgPad ?? 0.25) * 2 : 0
  const nw = t.w + pad, nh = t.h + pad
  if (anchor === 'center') { L.x += (L.w - nw) / 2; L.y += (L.h - nh) / 2 }
  L.w = nw
  L.h = nh
  return L
}

function drawText(ctx, L) {
  const t = layoutStudioText(L)
  const pad = L.bg ? L.size * (L.bgPad ?? 0.25) : 0
  const sx = L.w / (t.w + pad * 2), sy = L.h / (t.h + pad * 2) // text is scaled with its box
  ctx.scale(sx, sy)
  const W = t.w + pad * 2, H = t.h + pad * 2
  ctx.translate(-W / 2, -H / 2)
  if (L.bg) {
    ctx.fillStyle = L.bg
    const r = Math.min(W, H) * 0.12
    ctx.beginPath()
    ctx.roundRect ? ctx.roundRect(0, 0, W, H, r) : ctx.rect(0, 0, W, H)
    ctx.fill()
  }
  ctx.font = textFont(L)
  ctx.textBaseline = 'alphabetic'
  const sp = L.spacing || 0
  const each = (fn) => t.lines.forEach((s, i) => {
    const lx = pad + (L.align === 'center' ? (t.w - t.widths[i]) / 2 : L.align === 'right' ? t.w - t.widths[i] : 0)
    const by = pad + i * t.lh + (t.lh - L.size) / 2 + L.size * 0.82
    if (!sp) { fn(s, lx, by); return }
    let x = lx
    for (const ch of s) { fn(ch, x, by); x += ctx.measureText(ch).width + sp }
  })
  if (L.shadow?.opacity) {
    ctx.save()
    ctx.shadowColor = hexA(L.shadow.color ?? '#000000', L.shadow.opacity / 100)
    ctx.shadowBlur = (L.shadow.blur ?? 10) * (L.size / 72)
    ctx.shadowOffsetX = (L.shadow.dx ?? 6) * (L.size / 72) * sx
    ctx.shadowOffsetY = (L.shadow.dy ?? 6) * (L.size / 72) * sy
    ctx.fillStyle = L.color
    each((s, x, y) => ctx.fillText(s, x, y))
    ctx.restore()
  }
  if (L.outline?.width) {
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeStyle = L.outline.color ?? '#000000'
    ctx.lineWidth = L.outline.width * 2 * (L.size / 72)
    each((s, x, y) => ctx.strokeText(s, x, y))
  }
  ctx.fillStyle = L.color
  each((s, x, y) => ctx.fillText(s, x, y))
}

export function hexA(hex, a) {
  const m = String(hex).match(/^#?([0-9a-f]{6})$/i)
  const n = m ? parseInt(m[1], 16) : 0
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// ---------- shapes ----------
/** Path of a shape in its local box (-w/2..w/2, -h/2..h/2). */
export function shapePath(ctx, L) {
  const w = L.w, h = L.h, x0 = -w / 2, y0 = -h / 2
  ctx.beginPath()
  switch (L.kind) {
    case 'ellipse': ctx.ellipse(0, 0, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); break
    case 'line': ctx.moveTo(x0, 0); ctx.lineTo(x0 + w, 0); break
    case 'arrow': {
      const hl = Math.min(w * 0.35, h * 1.2 + 10), sh = h * 0.28
      ctx.moveTo(x0, -sh); ctx.lineTo(x0 + w - hl, -sh); ctx.lineTo(x0 + w - hl, y0); ctx.lineTo(x0 + w, 0)
      ctx.lineTo(x0 + w - hl, -y0); ctx.lineTo(x0 + w - hl, sh); ctx.lineTo(x0, sh); ctx.closePath()
      break
    }
    case 'triangle': ctx.moveTo(0, y0); ctx.lineTo(-x0, -y0); ctx.lineTo(x0, -y0); ctx.closePath(); break
    case 'star': case 'polygon': {
      const n = Math.max(3, Math.min(24, L.sides || 5))
      const steps = L.kind === 'star' ? n * 2 : n
      for (let i = 0; i < steps; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / steps
        const k = L.kind === 'star' && i % 2 ? (L.inner ?? 0.45) : 1
        const px = Math.cos(a) * (w / 2) * k, py = Math.sin(a) * (h / 2) * k
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)
      }
      ctx.closePath()
      break
    }
    case 'heart': {
      const s = (px, py) => [x0 + px * w, y0 + py * h]
      ctx.moveTo(...s(0.5, 0.28))
      ctx.bezierCurveTo(...s(0.5, 0.08), ...s(0.12, 0.02), ...s(0.08, 0.32))
      ctx.bezierCurveTo(...s(0.04, 0.6), ...s(0.36, 0.78), ...s(0.5, 0.96))
      ctx.bezierCurveTo(...s(0.64, 0.78), ...s(0.96, 0.6), ...s(0.92, 0.32))
      ctx.bezierCurveTo(...s(0.88, 0.02), ...s(0.5, 0.08), ...s(0.5, 0.28))
      ctx.closePath()
      break
    }
    default: {
      const r = Math.min(Math.abs(w), Math.abs(h)) / 2 * Math.min(1, (L.radius ?? 0) / 100)
      if (r > 0 && ctx.roundRect) ctx.roundRect(x0, y0, w, h, r); else ctx.rect(x0, y0, w, h)
    }
  }
}
function drawShape(ctx, L) {
  shapePath(ctx, L)
  if (L.kind !== 'line' && L.fill) {
    if (L.fill2) {
      const a = ((L.gradAngle ?? 90) * Math.PI) / 180
      const dx = (Math.cos(a) * L.w) / 2, dy = (Math.sin(a) * L.h) / 2
      const g = ctx.createLinearGradient(-dx, -dy, dx, dy)
      g.addColorStop(0, L.fill)
      g.addColorStop(1, L.fill2)
      ctx.fillStyle = g
    } else ctx.fillStyle = L.fill
    ctx.fill()
  }
  const sw = L.kind === 'line' ? Math.max(1, L.strokeW || 4) : L.strokeW
  if ((L.stroke || L.kind === 'line') && sw > 0) {
    ctx.lineWidth = sw
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = L.stroke ?? L.fill ?? '#000000'
    ctx.stroke()
  }
}

// ---------- raster fx (non-destructive adjustments, cached) ----------
const fxCache = new WeakMap() // canvas → Map(key → canvas)
const FAST_MAX = 1400
/** The pixels to show for a raster layer: its canvas, or the cached adjusted copy. */
export function rasterSource(L, { fast = false } = {}) {
  if (!L.fx || fxIsIdentity(L.fx, {})) return L.canvas
  let m = fxCache.get(L.canvas)
  if (!m) fxCache.set(L.canvas, (m = new Map()))
  const big = Math.max(L.canvas.width, L.canvas.height)
  const useFast = fast && big > FAST_MAX
  const key = (useFast ? 'f' : 'F') + JSON.stringify(L.fx)
  let out = m.get(key)
  if (out) return out
  let src = L.canvas
  if (useFast) { const k = FAST_MAX / big; src = makeCanvas(L.canvas.width * k, L.canvas.height * k); src.getContext('2d').drawImage(L.canvas, 0, 0, src.width, src.height) }
  const r = processImage({ rgba: pixelsOf(src), w: src.width, h: src.height }, {}, L.fx)
  out = canvasFromRGBA(r.rgba, r.w, r.h)
  out._pad = { ox: r.ox, oy: r.oy, innerW: r.innerW, innerH: r.innerH }
  if (m.size > 8) m.delete(m.keys().next().value)
  m.set(key, out)
  return out
}

// ---------- drawing ----------
export const layerMatrix = (L) => {
  const a = (L.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const fx = L.flipH ? -1 : 1, fy = L.flipV ? -1 : 1
  return [c * fx, s * fx, -s * fy, c * fy, L.x + L.w / 2, L.y + L.h / 2]
}
/** Draw one layer (no opacity / blend — the caller sets those). */
export function drawLayerContent(ctx, L, { fast = false } = {}) {
  ctx.save()
  ctx.transform(...layerMatrix(L))
  if (L.type === 'raster') {
    const src = rasterSource(L, { fast })
    const p = src._pad
    if (p) { const kx = L.w / p.innerW, ky = L.h / p.innerH; ctx.drawImage(src, -L.w / 2 - p.ox * kx, -L.h / 2 - p.oy * ky, src.width * kx, src.height * ky) } else ctx.drawImage(src, -L.w / 2, -L.h / 2, L.w, L.h)
  } else if (L.type === 'text') drawText(ctx, L)
  else if (L.type === 'shape') drawShape(ctx, L)
  ctx.restore()
}
/**
 * Composite the document into ctx (already scaled to document px by the caller).
 * hook(L, ctx) may draw extra content right after a layer (live stroke previews).
 */
export function composite(ctx, doc, { fast = false, hook = null, skip = null } = {}) {
  for (const L of doc.layers) {
    if (L.hidden || L === skip) continue
    ctx.save()
    ctx.globalAlpha = L.opacity ?? 1
    ctx.globalCompositeOperation = L.blend && L.blend !== 'normal' ? L.blend : 'source-over'
    if (hook?.(L, ctx) !== 'replace') drawLayerContent(ctx, L, { fast })
    ctx.restore()
  }
}
/** Flattened document as a canvas at `scale`. bg: colour behind transparent pixels, or null. */
export function flatten(doc, { scale = 1, bg = null } = {}) {
  const c = makeCanvas(doc.w * scale, doc.h * scale)
  const x = c.getContext('2d')
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height) }
  x.scale(c.width / doc.w, c.height / doc.h)
  x.imageSmoothingQuality = 'high'
  composite(x, doc)
  return c
}
/** One layer rendered into a document-sized canvas (for rasterize / merge / bake). */
export function layerToCanvas(doc, L, { withFx = true } = {}) {
  const c = makeCanvas(doc.w, doc.h)
  const x = c.getContext('2d')
  drawLayerContent(x, withFx ? L : { ...L, fx: null })
  return c
}

// ---------- geometry ----------
export function layerCorners(L) {
  const m = layerMatrix(L)
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const lx = (u * L.w) / 2, ly = (v * L.h) / 2
    return [m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5]]
  })
}
export function layerAABB(L) {
  const cs = layerCorners(L)
  const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
/** Document point → layer-local (-w/2..w/2) coordinates. */
export function layerLocal(L, px, py) {
  const a = (-L.rot * Math.PI) / 180
  const dx = px - (L.x + L.w / 2), dy = py - (L.y + L.h / 2)
  let lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a)
  if (L.flipH) lx = -lx
  if (L.flipV) ly = -ly
  return [lx, ly]
}
/** Is the point on visible content of this layer? */
export function hitLayer(L, px, py) {
  if (L.hidden || L.locked) return false
  const [lx, ly] = layerLocal(L, px, py)
  if (Math.abs(lx) > L.w / 2 + 2 || Math.abs(ly) > L.h / 2 + 2) return false
  if (L.type !== 'raster') return true
  const cx = Math.floor(((lx + L.w / 2) / L.w) * L.canvas.width), cy = Math.floor(((ly + L.h / 2) / L.h) * L.canvas.height)
  if (cx < 0 || cy < 0 || cx >= L.canvas.width || cy >= L.canvas.height) return false
  return L.canvas.getContext('2d', { willReadFrequently: true }).getImageData(cx, cy, 1, 1).data[3] > 16
}
/** Raster layer sitting exactly on the canvas grid (paintable without baking)? */
export const isCanvasAligned = (doc, L) => L.type === 'raster' && !L.rot && !L.flipH && !L.flipV && L.x === 0 && L.y === 0 &&
  L.canvas.width === doc.w && L.canvas.height === doc.h && L.w === doc.w && L.h === doc.h

// ---------- history ----------
export const snapshotDoc = (doc) => ({ w: doc.w, h: doc.h, sel: doc.sel, layers: doc.layers.map((L) => ({ ...L, outline: L.outline && { ...L.outline }, shadow: L.shadow && { ...L.shadow }, fx: L.fx && JSON.parse(JSON.stringify(L.fx)) })) })
export const restoreDoc = (doc, s) => { doc.w = s.w; doc.h = s.h; doc.sel = s.sel; doc.layers = s.layers.map((L) => ({ ...L })) }
/** Rough bytes held by a list of snapshots (unique canvases only). */
export function historyBytes(snaps) {
  const seen = new Set()
  let n = 0
  for (const s of snaps) for (const L of s.layers) if (L.canvas && !seen.has(L.canvas)) { seen.add(L.canvas); n += L.canvas.width * L.canvas.height * 4 }
  return n
}

// ---------- project files ----------
export async function saveProject(doc) {
  const layers = doc.layers.map((L) => {
    const { canvas, ...rest } = L
    return canvas ? { ...rest, png: canvas.toDataURL('image/png') } : rest
  })
  return JSON.stringify({ app: 'pdfsuite-design', v: 1, w: doc.w, h: doc.h, layers })
}
export async function loadProject(text) {
  const j = JSON.parse(text)
  if (j.app !== 'pdfsuite-design') throw new Error('This isn’t a Design & Edit project file')
  const layers = []
  for (const l of j.layers) {
    if (l.png) {
      const img = new Image()
      img.src = l.png
      await img.decode()
      const c = makeCanvas(img.naturalWidth, img.naturalHeight)
      c.getContext('2d').drawImage(img, 0, 0)
      const { png, ...rest } = l
      layers.push({ ...rest, canvas: c, id: newLayerId() })
    } else layers.push({ ...l, id: newLayerId() })
  }
  return { w: j.w, h: j.h, layers, sel: null }
}

// ---------- templates ----------
/** Ready-made designs built from editable layers. */
export const TEMPLATES = [
  ['Quote card', 1080, 1080, (d) => {
    bgFill(d, '#0f172a', '#334155')
    d.layers.push(shapeLayer('rect', 90, 90, 900, 900, { fill: null, stroke: '#f59e0b', strokeW: 6, name: 'Frame' }))
    d.layers.push(centerText(d, '“Make it simple,\nbut significant.”', 400, { size: 78, color: '#f8fafc', font: STUDIO_FONTS[1][0], weight: 700, align: 'center' }))
    d.layers.push(centerText(d, '— DON DRAPER', 720, { size: 34, color: '#f59e0b', spacing: 6, weight: 600 }))
  }],
  ['YouTube thumbnail', 1280, 720, (d) => {
    bgFill(d, '#ef4444', '#7c2d12')
    d.layers.push(shapeLayer('rect', 60, 430, 700, 210, { fill: '#facc15', radius: 20, rot: -3, name: 'Banner' }))
    d.layers.push(textLayer('HOW I DID IT', 90, 465, { size: 110, color: '#111111', font: STUDIO_FONTS[3][0], weight: 900, rot: -3 }))
    d.layers.push(textLayer('in 7 days', 100, 120, { size: 120, color: '#ffffff', weight: 900, outline: { width: 6, color: '#111111' }, shadow: { opacity: 60, blur: 18, dx: 8, dy: 8, color: '#000000' } }))
    d.layers.push(shapeLayer('arrow', 860, 300, 320, 140, { fill: '#ffffff', rot: 25 }))
  }],
  ['Sale poster', 1080, 1350, (d) => {
    bgFill(d, '#fdf2f8', '#fbcfe8')
    d.layers.push(shapeLayer('ellipse', 190, 200, 700, 700, { fill: '#db2777', fill2: '#9333ea', gradAngle: 45, name: 'Circle' }))
    d.layers.push(centerText(d, 'SUMMER', 420, { size: 110, color: '#ffffff', weight: 900, spacing: 8 }))
    d.layers.push(centerText(d, '50% OFF', 560, { size: 150, color: '#ffffff', weight: 900, font: STUDIO_FONTS[3][0] }))
    d.layers.push(centerText(d, 'This weekend only · shop.example.com', 1080, { size: 40, color: '#831843', weight: 600 }))
  }],
  ['Event flyer', 1748, 2480, (d) => {
    bgFill(d, '#111827', '#1e3a8a')
    d.layers.push(shapeLayer('star', 1150, 180, 420, 420, { fill: '#fde047', sides: 8, inner: 0.55, name: 'Burst' }))
    d.layers.push(textLayer('LIVE\nMUSIC', 150, 700, { size: 330, color: '#ffffff', weight: 900, lineHeight: 0.95, font: STUDIO_FONTS[3][0] }))
    d.layers.push(textLayer('Friday 8 PM · The Old Hall', 160, 1500, { size: 90, color: '#fde047', weight: 700 }))
    d.layers.push(shapeLayer('rect', 150, 1700, 1448, 8, { fill: '#fde047', name: 'Rule' }))
    d.layers.push(textLayer('Tickets at the door · free entry before 9', 160, 1780, { size: 60, color: '#e5e7eb', weight: 500 }))
  }],
  ['Business card', 1050, 600, (d) => {
    bgFill(d, '#ffffff', null)
    d.layers.push(shapeLayer('rect', 0, 0, 340, 600, { fill: '#0ea5e9', fill2: '#2563eb', gradAngle: 90, name: 'Side band' }))
    d.layers.push(textLayer('AB', 95, 230, { size: 120, color: '#ffffff', weight: 900 }))
    d.layers.push(textLayer('Alex Brown', 400, 170, { size: 64, color: '#0f172a', weight: 800 }))
    d.layers.push(textLayer('Product designer', 402, 255, { size: 34, color: '#0ea5e9', weight: 600 }))
    d.layers.push(textLayer('alex@example.com\n+1 555 0100\nexample.com', 402, 340, { size: 30, color: '#334155', weight: 500, lineHeight: 1.5 }))
  }],
  ['Instagram story', 1080, 1920, (d) => {
    bgFill(d, '#fef3c7', '#fca5a5')
    d.layers.push(shapeLayer('heart', 340, 420, 400, 360, { fill: '#e11d48', name: 'Heart' }))
    d.layers.push(centerText(d, 'NEW POST', 960, { size: 120, color: '#7f1d1d', weight: 900, spacing: 10 }))
    d.layers.push(centerText(d, 'tap the link in bio', 1120, { size: 54, color: '#9f1239', weight: 600, italic: true }))
    d.layers.push(shapeLayer('rect', 340, 1500, 400, 110, { fill: '#7f1d1d', radius: 100, name: 'Button' }))
    d.layers.push(centerText(d, 'READ MORE', 1525, { size: 48, color: '#ffffff', weight: 800 }))
  }],
]
function bgFill(d, c1, c2) {
  const c = d.layers[0].canvas.getContext('2d')
  if (c2) { const g = c.createLinearGradient(0, 0, d.w, d.h); g.addColorStop(0, c1); g.addColorStop(1, c2); c.fillStyle = g } else c.fillStyle = c1
  c.fillRect(0, 0, d.w, d.h)
}
function centerText(d, text, y, opts) {
  const L = textLayer(text, 0, y, opts)
  L.x = (d.w - L.w) / 2
  return L
}
export function documentFromTemplate(i) {
  const [, w, h, build] = TEMPLATES[i]
  const d = newDocument(w, h, '#ffffff')
  build(d)
  return d
}
