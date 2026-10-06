// Editor object model — pure geometry + canvas drawing.
// Every object lives in the DISPLAY space of its page (pt, top-left origin,
// y down, after any page rotation), exactly what the exporter consumes.
// Box objects may carry `rot` (degrees, clockwise, about the box centre).
import { textWidth, stdFont } from '../pdf/stamp.js'
import { stdWidth } from '../pdf/metrics.js'
import { toWinAnsi } from '../pdf/encodings.js'

export const FAMILY_CSS = {
  helv: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
}
export const fontCssOf = (a, px) => `${a.italic ? 'italic ' : ''}${a.bold ? '700 ' : ''}${px}px ${FAMILY_CSS[a.font] ?? FAMILY_CSS.helv}`
export const LINE_H = 1.2
const lineH = (a) => a.lineHeight ?? LINE_H

/** Types that are a box (x,y,w,h) and can rotate freely. */
const BOX_ROT = new Set(['text', 'image', 'rect', 'ellipse', 'whiteout', 'stamp', 'mark', 'poly'])
export const rotatable = (a) => BOX_ROT.has(a.t)

let measureCtx = null
/**
 * Width of one line in pt. Text the standard fonts can encode uses their real
 * metrics (exactly what the export writes); anything else (CJK, Arabic,
 * emoji — exported as an image) uses the browser's own measurement.
 */
export function lineWidth(a, line) {
  const sp = (a.spacing ?? 0) * Math.max(0, [...line].length - 1)
  if (toWinAnsi(line) !== null) return textWidth(stdFont(a.font, a.bold, a.italic), line, a.size) + sp
  measureCtx ??= document.createElement('canvas').getContext('2d')
  measureCtx.font = fontCssOf(a, 100)
  return (measureCtx.measureText(line).width / 100) * a.size + sp
}

/** Wrap text to a box width (pt) using the same metrics the export uses. */
export function layoutText(a) {
  const paras = String(a.text ?? '').split('\n')
  if (!a.w) return paras
  const out = []
  for (const para of paras) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      const t = line + word
      if (line && lineWidth(a, t.trimEnd()) > a.w) { out.push(line.trimEnd()); line = word.trimStart() } else line = t
    }
    out.push(line)
  }
  return out
}

export function textBox(a) {
  const lines = layoutText(a)
  const w = a.w || Math.max(4, ...lines.map((l) => lineWidth(a, l)))
  return { x: a.x, y: a.y, w, h: Math.max(a.size * lineH(a), lines.length * a.size * lineH(a)), lines }
}

/** Axis-aligned box BEFORE rotation. */
export function annBox(a) {
  switch (a.t) {
    case 'stroke': case 'highlight': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const p of a.pts) {
        const r = (p[2] ?? a.width ?? 2) / 2 + 1
        x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r)
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    case 'line': {
      const r = (a.width ?? 2) / 2 + 3
      return { x: Math.min(a.x1, a.x2) - r, y: Math.min(a.y1, a.y2) - r, w: Math.abs(a.x2 - a.x1) + 2 * r, h: Math.abs(a.y2 - a.y1) + 2 * r }
    }
    case 'hlrects': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const r of a.rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h) }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    case 'text': { const b = textBox(a); return { x: b.x, y: b.y, w: b.w, h: b.h } }
    case 'textedit': {
      const b = textBox(a)
      return { x: Math.min(b.x, a.region.x), y: Math.min(b.y, a.region.y), w: Math.max(b.x + b.w, a.region.x + a.region.w) - Math.min(b.x, a.region.x), h: Math.max(b.y + b.h, a.region.y + a.region.h) - Math.min(b.y, a.region.y) }
    }
    case 'imgremove': return { ...a.region }
    case 'note': return { x: a.x, y: a.y, w: 22, h: 22 }
    default: return { x: a.x, y: a.y, w: a.w, h: a.h }
  }
}

/** World-space axis-aligned bounds including rotation (for marquee, snapping, align). */
export function annBounds(a) {
  const b = annBox(a)
  if (!a.rot || !rotatable(a)) return b
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => rotAbout(x, y, cx, cy, a.rot))
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

export function rotAbout(x, y, cx, cy, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]
}
/** World point → the object's unrotated local frame. */
const toLocal = (a, x, y) => {
  if (!a.rot || !rotatable(a)) return [x, y]
  const b = annBox(a)
  return rotAbout(x, y, b.x + b.w / 2, b.y + b.h / 2, -a.rot)
}

/** Which objects can be resized with handles. */
export const resizable = (a) => ['image', 'rect', 'ellipse', 'whiteout', 'redact', 'text', 'mark', 'stamp', 'link', 'poly', 'textedit'].includes(a.t)
export const keepsAspect = (a) => a.t === 'image' || a.t === 'mark' || a.t === 'stamp'

const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0
  return Math.hypot(x1 + t * dx - px, y1 + t * dy - py)
}

/** Point hit test (tol in pt). Hidden/locked/removal markers are never hit. */
export function annHit(a, x0, y0, tol = 5) {
  if (a.hidden || a.locked || a.t === 'imgremove') return false
  const [x, y] = toLocal(a, x0, y0)
  if (a.t === 'stroke' || a.t === 'highlight') {
    const w = a.width ?? 2
    if (a.pts.length === 1) return Math.hypot(x - a.pts[0][0], y - a.pts[0][1]) < Math.max(tol, w / 2 + 2)
    for (let i = 1; i < a.pts.length; i++) {
      const ww = (a.pts[i][2] ?? w) / 2 + tol
      if (distSeg(x, y, a.pts[i - 1][0], a.pts[i - 1][1], a.pts[i][0], a.pts[i][1]) < ww) return true
    }
    return false
  }
  if (a.t === 'line') return distSeg(x, y, a.x1, a.y1, a.x2, a.y2) < Math.max(tol, (a.width ?? 2) / 2 + 3)
  if (a.t === 'hlrects') return a.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
  const b = annBox(a)
  if ((a.t === 'rect' || a.t === 'ellipse' || a.t === 'poly') && !a.fill) {
    const band = (a.lw ?? 2) / 2 + tol
    const outer = x >= b.x - band && x <= b.x + b.w + band && y >= b.y - band && y <= b.y + b.h + band
    const inner = x > b.x + band && x < b.x + b.w - band && y > b.y + band && y < b.y + b.h - band
    return outer && !inner
  }
  return x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2
}

/** Deep-ish copy (image bytes shared — never mutated). */
export function annClone(a) {
  const o = { ...a }
  if (a.pts) o.pts = a.pts.map((p) => [...p])
  if (a.rects) o.rects = a.rects.map((r) => ({ ...r }))
  if (a.region) o.region = { ...a.region }
  if (a.segs) o.segs = a.segs.map((s) => [...s])
  if (a.fx) o.fx = JSON.parse(JSON.stringify(a.fx))
  if (a.crop) o.crop = { ...a.crop }
  if (a.outline) o.outline = { ...a.outline }
  if (a.shadow) o.shadow = { ...a.shadow }
  return o
}

export function annMove(a, o, dx, dy) {
  if (o.pts) a.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)])
  if (o.rects) a.rects = o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }))
  if (o.x1 !== undefined) { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy }
  if (o.x !== undefined) { a.x = o.x + dx; a.y = o.y + dy }
  // a text edit's erase region stays put: only the replacement text moves
}

/**
 * Resize from a handle ('nw','n','ne','e','se','s','sw','w') to world (x,y).
 * Works in the object's local frame for rotated objects and keeps the opposite
 * corner fixed in world space.
 */
export function annResize(a, o, handle, xw, yw, { aspect = false } = {}) {
  const rot = rotatable(o) ? o.rot ?? 0 : 0
  const ob = annBox(o)
  const ocx = ob.x + ob.w / 2, ocy = ob.y + ob.h / 2
  const [x, y] = rot ? rotAbout(xw, yw, ocx, ocy, -rot) : [xw, yw]
  // anchor = opposite handle, local coords
  const ax = handle.includes('w') ? ob.x + ob.w : handle.includes('e') ? ob.x : ocx
  const ay = handle.includes('n') ? ob.y + ob.h : handle.includes('s') ? ob.y : ocy
  const anchorWorld = rot ? rotAbout(ax, ay, ocx, ocy, rot) : [ax, ay]
  resizeLocal(a, o, handle, x, y, aspect)
  if (rot) {
    const nb = annBox(a)
    const ncx = nb.x + nb.w / 2, ncy = nb.y + nb.h / 2
    const nax = handle.includes('w') ? nb.x + nb.w : handle.includes('e') ? nb.x : ncx
    const nay = handle.includes('n') ? nb.y + nb.h : handle.includes('s') ? nb.y : ncy
    const now = rotAbout(nax, nay, ncx, ncy, rot)
    const dx = anchorWorld[0] - now[0], dy = anchorWorld[1] - now[1]
    a.x += dx
    a.y += dy
    if (a.t === 'textedit') { /* region stays */ }
  }
}

function resizeLocal(a, o, handle, x, y, aspect) {
  if (a.t === 'text' || a.t === 'textedit') {
    const ob = textBox(o)
    if (handle === 'e' || handle === 'w') {
      if (handle === 'e') a.w = Math.max(o.size, x - o.x)
      else { const right = o.x + ob.w; a.x = Math.min(x, right - o.size); a.w = right - a.x }
      return
    }
    const ax = handle.includes('w') ? o.x + ob.w : o.x
    const ay = handle.includes('n') ? o.y + ob.h : o.y
    const f = Math.max(0.15, Math.min(12, Math.max(Math.abs(x - ax) / (ob.w || 1), Math.abs(y - ay) / (ob.h || 1))))
    a.size = Math.max(4, Math.round(o.size * f * 2) / 2)
    if (o.w) a.w = o.w * (a.size / o.size)
    const nb = textBox(a)
    a.x = handle.includes('w') ? ax - nb.w : ax
    a.y = handle.includes('n') ? ay - nb.h : ay
    return
  }
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h
  if (handle.includes('w')) x0 = Math.min(x, x1 - 4)
  if (handle.includes('e')) x1 = Math.max(x, x0 + 4)
  if (handle.includes('n')) y0 = Math.min(y, y1 - 4)
  if (handle.includes('s')) y1 = Math.max(y, y0 + 4)
  if (aspect && o.w && o.h) {
    const r = o.w / o.h
    let w = x1 - x0, h = y1 - y0
    if (handle.length === 2) { if (w / h > r) w = h * r; else h = w / r } else if (handle === 'e' || handle === 'w') h = w / r; else w = h * r
    if (handle.includes('w')) x0 = x1 - w; else x1 = x0 + w
    if (handle.includes('n')) y0 = y1 - h; else y1 = y0 + h
  }
  a.x = x0; a.y = y0; a.w = x1 - x0; a.h = y1 - y0
}

/** Rotate an object 90° clockwise with its page (page W×H before rotation). */
export function annRotate90(a, W, H) {
  const P = (x, y) => [H - y, x]
  const rectR = (r) => { const [x, y] = P(r.x, r.y + r.h); return { x, y, w: r.h, h: r.w } }
  if (a.pts) a.pts = a.pts.map((p) => [...P(p[0], p[1]), ...p.slice(2)])
  if (a.rects) a.rects = a.rects.map(rectR)
  if (a.x1 !== undefined) { [a.x1, a.y1] = P(a.x1, a.y1); [a.x2, a.y2] = P(a.x2, a.y2) }
  if (a.region) a.region = rectR(a.region)
  if (a.t === 'note') { [a.x, a.y] = P(a.x, a.y + 22); return }
  if (a.t === 'imgremove') return
  if (a.x !== undefined && a.pts === undefined && a.x1 === undefined) {
    const b = annBox(a)
    const nb = rectR(b)
    if (['text', 'textedit', 'image', 'stamp', 'mark', 'poly'].includes(a.t)) {
      a.rot = ((a.rot ?? 0) + 90) % 360
      const cx = nb.x + nb.w / 2, cy = nb.y + nb.h / 2
      a.x = cx - b.w / 2
      a.y = cy - b.h / 2
    } else { a.x = nb.x; a.y = nb.y; a.w = nb.w; a.h = nb.h }
  }
}

// ---------- shapes ----------

/** Polygon / star outline points for a 'poly' object (box space). */
export function polyPoints(a) {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2, rx = a.w / 2, ry = a.h / 2
  const n = Math.max(3, Math.min(24, a.sides ?? (a.kind === 'triangle' ? 3 : 5)))
  if (a.kind === 'triangle') return [[cx, a.y], [a.x + a.w, a.y + a.h], [a.x, a.y + a.h]]
  if (a.kind === 'star') {
    const inner = a.inner ?? 0.45
    const pts = []
    for (let i = 0; i < n * 2; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / n
      const k = i % 2 ? inner : 1
      pts.push([cx + Math.cos(ang) * rx * k, cy + Math.sin(ang) * ry * k])
    }
    return pts
  }
  return Array.from({ length: n }, (_, i) => { const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + Math.cos(ang) * rx, cy + Math.sin(ang) * ry] })
}

const MARK_PATHS = {
  check: (x, y, w, h) => [['M', x + w * 0.12, y + h * 0.55], ['L', x + w * 0.4, y + h * 0.82], ['L', x + w * 0.9, y + h * 0.2]],
  cross: (x, y, w, h) => [['M', x + w * 0.18, y + h * 0.18], ['L', x + w * 0.82, y + h * 0.82], ['M', x + w * 0.82, y + h * 0.18], ['L', x + w * 0.18, y + h * 0.82]],
}
export const markSegs = (a) => (MARK_PATHS[a.kind] ?? MARK_PATHS.check)(a.x, a.y, a.w, a.h)

// ---------- eraser ----------

/**
 * Erase the parts of a freehand stroke/highlight within radius r of (x, y).
 * Returns the surviving pieces (0, 1 or more new objects) — or null when the
 * object wasn't touched.
 */
export function eraseFrom(a, x, y, r) {
  if (a.t !== 'stroke' && a.t !== 'highlight') return null
  const reach = r + (a.width ?? 2) / 2
  let touched = false
  const pieces = []
  let cur = []
  const pts = a.pts
  // densify long segments so a small eraser can split them
  const dense = []
  for (let i = 0; i < pts.length; i++) {
    if (i) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]
      const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, r / 2))
      for (let k = 1; k < n; k++) dense.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, ...pts[i].slice(2)])
    }
    dense.push(pts[i])
  }
  for (const p of dense) {
    if (Math.hypot(p[0] - x, p[1] - y) <= reach) {
      touched = true
      if (cur.length) { pieces.push(cur); cur = [] }
    } else cur.push(p)
  }
  if (cur.length) pieces.push(cur)
  if (!touched) return null
  return pieces.filter((pc) => pc.length > 1).map((pc) => ({ ...a, pts: pc, id: undefined }))
}

// ---------- drawing ----------

/** Fill a line glyph-by-glyph with the export font's advance widths (WYSIWYG). */
function drawLine(c, a, ln, lx, by, S, method = 'fillText') {
  const sp = a.spacing ?? 0
  const bytes = toWinAnsi(ln)
  if (!bytes) { // non-WinAnsi text: natural layout (exported as an image)
    if ('letterSpacing' in c) c.letterSpacing = `${sp * S}px`
    c[method](ln, lx * S, by * S)
    if ('letterSpacing' in c) c.letterSpacing = '0px'
    return
  }
  const base = stdFont(a.font, a.bold, a.italic)
  let x = lx
  const chars = [...ln]
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ') c[method](chars[i], x * S, by * S)
    x += stdWidth(base, [bytes[i]], a.size) + sp
  }
}

/**
 * Draw one object. S = canvas px per pt.
 * opts.bmp(a) → processed image source {src, ox, oy, innerW, innerH} or a plain drawable.
 */
export function annDraw(c, a, S, { bmp, editingId } = {}) {
  if (a.hidden || a.t === 'imgremove') return
  c.save()
  c.globalAlpha = a.alpha ?? 1
  if (a.blend && a.blend !== 'normal') c.globalCompositeOperation = a.blend
  c.lineJoin = 'round'
  c.lineCap = 'round'
  if (a.rot && rotatable(a)) {
    const b = annBox(a)
    const cx = (b.x + b.w / 2) * S, cy = (b.y + b.h / 2) * S
    c.translate(cx, cy)
    c.rotate((a.rot * Math.PI) / 180)
    c.translate(-cx, -cy)
  }
  switch (a.t) {
    case 'stroke': {
      c.strokeStyle = a.color
      c.fillStyle = a.color
      const pts = a.pts
      if (pts.length === 1) { c.beginPath(); c.arc(pts[0][0] * S, pts[0][1] * S, Math.max(0.5, ((pts[0][2] ?? a.width) * S) / 2), 0, 7); c.fill(); break }
      for (let i = 1; i < pts.length; i++) {
        c.lineWidth = Math.max(0.6, (((pts[i - 1][2] ?? a.width) + (pts[i][2] ?? a.width)) / 2) * S)
        c.beginPath()
        c.moveTo(pts[i - 1][0] * S, pts[i - 1][1] * S)
        c.lineTo(pts[i][0] * S, pts[i][1] * S)
        c.stroke()
      }
      break
    }
    case 'highlight': {
      c.globalCompositeOperation = 'multiply'
      c.globalAlpha = Math.min(a.alpha ?? 0.4, 0.6)
      c.strokeStyle = a.color
      c.lineWidth = a.width * S
      c.lineCap = 'butt'
      c.beginPath()
      a.pts.forEach((p, i) => (i ? c.lineTo(p[0] * S, p[1] * S) : c.moveTo(p[0] * S, p[1] * S)))
      if (a.pts.length === 1) c.lineTo(a.pts[0][0] * S + 1, a.pts[0][1] * S)
      c.stroke()
      break
    }
    case 'hlrects': {
      c.globalCompositeOperation = 'multiply'
      c.globalAlpha = Math.min(a.alpha ?? 0.4, 0.6)
      c.fillStyle = a.color
      for (const r of a.rects) c.fillRect(r.x * S, r.y * S, r.w * S, r.h * S)
      break
    }
    case 'line': {
      c.strokeStyle = a.color
      c.fillStyle = a.color
      const lw = a.width ?? 2
      c.lineWidth = Math.max(0.6, lw * S)
      if (a.dash) c.setLineDash(a.dash.map((d) => d * S))
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1)
      const L = Math.min(60, Math.max(6, 3 * lw))
      const sx = a.arrowStart ? a.x1 + L * 0.6 * Math.cos(ang) : a.x1, sy = a.arrowStart ? a.y1 + L * 0.6 * Math.sin(ang) : a.y1
      const ex = a.arrow ? a.x2 - L * 0.6 * Math.cos(ang) : a.x2, ey = a.arrow ? a.y2 - L * 0.6 * Math.sin(ang) : a.y2
      c.beginPath(); c.moveTo(sx * S, sy * S); c.lineTo(ex * S, ey * S); c.stroke()
      c.setLineDash([])
      const head = (x1, y1, x2, y2) => {
        const an = Math.atan2(y2 - y1, x2 - x1)
        const bx = x2 - L * Math.cos(an), by = y2 - L * Math.sin(an)
        const px = -Math.sin(an) * L * 0.45, py = Math.cos(an) * L * 0.45
        c.beginPath(); c.moveTo(x2 * S, y2 * S); c.lineTo((bx + px) * S, (by + py) * S); c.lineTo((bx - px) * S, (by - py) * S); c.closePath(); c.fill()
      }
      if (a.arrow) head(a.x1, a.y1, a.x2, a.y2)
      if (a.arrowStart) head(a.x2, a.y2, a.x1, a.y1)
      break
    }
    case 'rect': case 'ellipse': case 'whiteout': case 'poly': {
      c.beginPath()
      if (a.t === 'ellipse') c.ellipse((a.x + a.w / 2) * S, (a.y + a.h / 2) * S, (a.w / 2) * S, (a.h / 2) * S, 0, 0, 7)
      else if (a.t === 'poly') polyPoints(a).forEach(([px, py], i) => (i ? c.lineTo(px * S, py * S) : c.moveTo(px * S, py * S)))
      else if (a.radius && c.roundRect) c.roundRect(a.x * S, a.y * S, a.w * S, a.h * S, a.radius * S)
      else c.rect(a.x * S, a.y * S, a.w * S, a.h * S)
      if (a.t === 'poly') c.closePath()
      const fill = a.t === 'whiteout' ? (a.fill ?? '#ffffff') : a.fill
      if (fill) { c.save(); c.globalAlpha = (a.alpha ?? 1) * (a.fillAlpha ?? 1); c.fillStyle = fill; c.fill(); c.restore() }
      if (a.t !== 'whiteout' && a.stroke) {
        c.strokeStyle = a.stroke
        c.lineWidth = Math.max(0.6, (a.lw ?? 2) * S)
        if (a.dash) c.setLineDash(a.dash.map((d) => d * S))
        c.stroke()
        c.setLineDash([])
      }
      break
    }
    case 'redact': {
      c.fillStyle = a.fill ?? '#000000'
      c.globalAlpha = 0.85
      c.fillRect(a.x * S, a.y * S, a.w * S, a.h * S)
      c.globalAlpha = 0.5
      c.strokeStyle = '#ff6b6b'
      c.lineWidth = Math.max(1, S * 0.8)
      c.save()
      c.beginPath(); c.rect(a.x * S, a.y * S, a.w * S, a.h * S); c.clip()
      for (let k = -a.h; k < a.w; k += 8) { c.beginPath(); c.moveTo((a.x + k) * S, (a.y + a.h) * S); c.lineTo((a.x + k + a.h) * S, a.y * S); c.stroke() }
      c.restore()
      break
    }
    case 'text': case 'textedit': {
      if (a.id === editingId) break
      if (a.t === 'textedit' && !a.text.trim()) break
      const b = textBox(a)
      if (a.bg) { c.fillStyle = a.bg; c.fillRect((b.x - 2) * S, (b.y - 1) * S, (b.w + 4) * S, (b.h + 2) * S) }
      c.font = fontCssOf(a, a.size * S)
      c.textBaseline = 'alphabetic'
      const place = b.lines.map((ln, i) => {
        const lw = lineWidth(a, ln)
        const lx = a.align === 'center' ? b.x + (b.w - lw) / 2 : a.align === 'right' ? b.x + b.w - lw : b.x
        return [ln, lx, b.y + a.size * 0.8 + i * a.size * lineH(a), lw]
      })
      if (a.shadow?.opacity > 0) {
        c.save()
        c.globalAlpha = (a.alpha ?? 1) * (a.shadow.opacity / 100)
        c.fillStyle = a.shadow.color ?? '#000000'
        const off = (v) => ((v ?? 30) / 100) * a.size * 0.5
        for (const [ln, lx, by] of place) drawLine(c, a, ln, lx + off(a.shadow.dx), by + off(a.shadow.dy), S)
        c.restore()
      }
      c.fillStyle = a.color
      for (const [ln, lx, by] of place) drawLine(c, a, ln, lx, by, S)
      if (a.outline?.width > 0) {
        c.strokeStyle = a.outline.color ?? '#000000'
        c.lineWidth = a.outline.width * S
        for (const [ln, lx, by] of place) drawLine(c, a, ln, lx, by, S, 'strokeText')
      }
      if (a.underline || a.strike) {
        c.strokeStyle = a.color
        c.lineWidth = Math.max(0.5, (a.size / 16) * S)
        for (const [, lx, by, lw] of place) {
          for (const off of [a.underline ? a.size * 0.12 : null, a.strike ? -a.size * 0.28 : null]) {
            if (off === null) continue
            c.beginPath(); c.moveTo(lx * S, (by + off) * S); c.lineTo((lx + lw) * S, (by + off) * S); c.stroke()
          }
        }
      }
      break
    }
    case 'image': {
      const im = bmp?.(a)
      if (im?.src) {
        const sx = a.w / (im.innerW || 1), sy = a.h / (im.innerH || 1)
        c.imageSmoothingQuality = 'high'
        c.drawImage(im.src, (a.x - im.ox * sx) * S, (a.y - im.oy * sy) * S, im.src.width * sx * S, im.src.height * sy * S)
      } else if (im) c.drawImage(im, a.x * S, a.y * S, a.w * S, a.h * S)
      else { c.strokeStyle = '#adb5bd'; c.setLineDash([4, 3]); c.strokeRect(a.x * S, a.y * S, a.w * S, a.h * S); c.setLineDash([]) }
      break
    }
    case 'mark': {
      c.strokeStyle = a.color
      c.fillStyle = a.color
      if (a.kind === 'dot') { c.beginPath(); c.ellipse((a.x + a.w / 2) * S, (a.y + a.h / 2) * S, (a.w / 2.6) * S, (a.h / 2.6) * S, 0, 0, 7); c.fill(); break }
      c.lineWidth = Math.max(1, Math.min(a.w, a.h) * 0.12 * S)
      c.beginPath()
      for (const sg of markSegs(a)) sg[0] === 'M' ? c.moveTo(sg[1] * S, sg[2] * S) : c.lineTo(sg[1] * S, sg[2] * S)
      c.stroke()
      break
    }
    case 'stamp': {
      c.strokeStyle = a.color
      c.fillStyle = a.color
      c.lineWidth = Math.max(1, a.h * 0.06 * S)
      c.beginPath()
      if (c.roundRect) c.roundRect(a.x * S, a.y * S, a.w * S, a.h * S, a.h * 0.18 * S); else c.rect(a.x * S, a.y * S, a.w * S, a.h * S)
      c.stroke()
      const size = a.h * 0.5
      const t = { font: 'helv', bold: true, size, spacing: 0 }
      c.font = fontCssOf(t, size * S)
      const tw = lineWidth(t, a.label)
      drawLine(c, t, a.label, a.x + (a.w - tw) / 2, a.y + a.h / 2 + size * 0.36, S)
      break
    }
    case 'note': {
      const x = a.x * S, y = a.y * S, s = 22 * S
      c.fillStyle = a.color ?? '#ffd43b'
      c.strokeStyle = 'rgba(0,0,0,.35)'
      c.lineWidth = Math.max(1, S * 0.6)
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + s, y); c.lineTo(x + s, y + s * 0.72); c.lineTo(x + s * 0.72, y + s); c.lineTo(x, y + s); c.closePath(); c.fill(); c.stroke()
      c.fillStyle = 'rgba(0,0,0,.45)'
      for (let k = 0; k < 3; k++) c.fillRect(x + s * 0.2, y + s * (0.28 + k * 0.18), s * (k === 2 ? 0.35 : 0.6), Math.max(1, s * 0.06))
      break
    }
    case 'link': {
      c.fillStyle = 'rgba(37, 99, 235, 0.12)'
      c.strokeStyle = '#2563eb'
      c.lineWidth = Math.max(1, S)
      c.setLineDash([4, 3])
      c.fillRect(a.x * S, a.y * S, a.w * S, a.h * S)
      c.strokeRect(a.x * S, a.y * S, a.w * S, a.h * S)
      c.setLineDash([])
      break
    }
  }
  c.restore()
}

/**
 * Selection chrome. u = canvas px per css px; hs = handle radius in css px
 * (bigger on touch screens). primary=false draws a lighter outline (multi-select).
 */
export function drawSelection(c, a, S, u, accent = '#10b981', { hs = 5, primary = true } = {}) {
  const b = annBox(a)
  c.save()
  if (a.rot && rotatable(a)) {
    const cx = (b.x + b.w / 2) * S, cy = (b.y + b.h / 2) * S
    c.translate(cx, cy); c.rotate((a.rot * Math.PI) / 180); c.translate(-cx, -cy)
  }
  c.strokeStyle = accent
  c.lineWidth = 1.5 * u
  c.setLineDash([5 * u, 4 * u])
  const pad = 3 / (S / u)
  c.strokeRect((b.x - pad) * S, (b.y - pad) * S, (b.w + 2 * pad) * S, (b.h + 2 * pad) * S)
  c.setLineDash([])
  if (primary) {
    const cssPerPt = S / u
    if (resizable(a)) {
      for (const [, hx, hy] of handlesOf(a, cssPerPt, true)) dot(c, hx * S, hy * S, hs * u, accent, u)
    }
    if (rotatable(a) && a.t !== 'textedit') {
      const [rx, ry] = rotHandleLocal(a, cssPerPt)
      c.strokeStyle = accent
      c.lineWidth = 1.5 * u
      c.beginPath(); c.moveTo(rx * S, (b.y - pad) * S); c.lineTo(rx * S, ry * S); c.stroke()
      dot(c, rx * S, ry * S, hs * u, accent, u, true)
    }
    if (a.t === 'line') for (const [px, py] of [[a.x1, a.y1], [a.x2, a.y2]]) dot(c, px * S, py * S, hs * u, accent, u)
  }
  c.restore()
}
function dot(c, x, y, r, accent, u, ring = false) {
  c.fillStyle = ring ? accent : '#fff'
  c.strokeStyle = ring ? '#fff' : accent
  c.lineWidth = 1.5 * u
  c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.stroke()
}

/** Rotation handle position in the object's LOCAL frame (above top-centre). */
function rotHandleLocal(a, cssPerPt) {
  const b = annBox(a)
  return [b.x + b.w / 2, b.y - 3 / cssPerPt - 26 / cssPerPt]
}

/** Handle positions [id, x, y] in LOCAL frame (local=true) or world. */
export function handlesOf(a, cssPerPt = 1, local = false) {
  const b = annBox(a)
  const pad = 3 / cssPerPt
  const x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad, mx = (x0 + x1) / 2, my = (y0 + y1) / 2
  let hs
  if (a.t === 'text' || a.t === 'textedit') hs = [['nw', x0, y0], ['ne', x1, y0], ['sw', x0, y1], ['se', x1, y1], ['w', x0, my], ['e', x1, my]]
  else if (keepsAspect(a)) hs = [['nw', x0, y0], ['ne', x1, y0], ['sw', x0, y1], ['se', x1, y1]]
  else hs = [['nw', x0, y0], ['n', mx, y0], ['ne', x1, y0], ['e', x1, my], ['se', x1, y1], ['s', mx, y1], ['sw', x0, y1], ['w', x0, my]]
  if (local || !a.rot || !rotatable(a)) return hs
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  return hs.map(([id, x, y]) => [id, ...rotAbout(x, y, cx, cy, a.rot)])
}

/** Which handle (if any) is under world (x,y). 'rot' = rotation handle. */
export function handleAt(a, x, y, tolPt, cssPerPt) {
  if (a.locked) return null
  if (a.t === 'line') {
    if (Math.hypot(x - a.x1, y - a.y1) <= tolPt) return 'p1'
    if (Math.hypot(x - a.x2, y - a.y2) <= tolPt) return 'p2'
    return null
  }
  if (rotatable(a) && a.t !== 'textedit') {
    const b = annBox(a)
    let [rx, ry] = rotHandleLocal(a, cssPerPt)
    if (a.rot) [rx, ry] = rotAbout(rx, ry, b.x + b.w / 2, b.y + b.h / 2, a.rot)
    if (Math.hypot(x - rx, y - ry) <= tolPt) return 'rot'
  }
  if (!resizable(a)) return null
  for (const [id, hx, hy] of handlesOf(a, cssPerPt)) if (Math.hypot(x - hx, y - hy) <= tolPt) return id
  return null
}

const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize']
const HANDLE_ANG = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }
/** Resize cursor for a handle, adjusted for the object's rotation. */
export function cursorFor(a, h) {
  if (h === 'rot') return 'grab'
  if (h === 'p1' || h === 'p2') return 'move'
  const ang = ((HANDLE_ANG[h] ?? 0) + (a.rot ?? 0) + 360) % 180
  return CURSORS[Math.round(ang / 45) % 4]
}

/** Light path smoothing for freehand strokes (Chaikin, keeps endpoints). */
export function smooth(pts, passes = 2) {
  let p = pts
  for (let k = 0; k < passes && p.length > 2; k++) {
    const out = [p[0]]
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1]
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, ...(a.length > 2 ? [a[2] * 0.75 + b[2] * 0.25] : [])])
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, ...(a.length > 2 ? [a[2] * 0.25 + b[2] * 0.75] : [])])
    }
    out.push(p[p.length - 1])
    p = out
  }
  return p
}
