// Editor annotation model — pure geometry + canvas drawing.
// Every annotation lives in the DISPLAY space of its page (pt, top-left origin,
// y down, after any rotation), exactly what the exporter consumes.
import { textWidth, stdFont } from '../pdf/stamp.js'
import { toWinAnsi } from '../pdf/encodings.js'

export const FAMILY_CSS = {
  helv: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  times: '"Times New Roman", Times, "Liberation Serif", serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
}
export const fontCssOf = (a, px) => `${a.italic ? 'italic ' : ''}${a.bold ? '700 ' : ''}${px}px ${FAMILY_CSS[a.font] ?? FAMILY_CSS.helv}`
export const LINE_H = 1.2

let measureCtx = null
/**
 * Width of one line in pt. Text the standard fonts can encode uses their real
 * metrics (exactly what the export writes); anything else (CJK, Arabic,
 * emoji — exported as an image) uses the browser's own font measurement.
 */
export function lineWidth(a, line) {
  if (toWinAnsi(line) !== null) return textWidth(stdFont(a.font, a.bold, a.italic), line, a.size)
  measureCtx ??= document.createElement('canvas').getContext('2d')
  measureCtx.font = fontCssOf(a, 100)
  return (measureCtx.measureText(line).width / 100) * a.size
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
  return { x: a.x, y: a.y, w, h: Math.max(a.size * LINE_H, lines.length * a.size * LINE_H), lines }
}

/** Axis-aligned bounding box (before any `rot`). */
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
    case 'textedit': { const b = textBox(a); return { x: Math.min(b.x, a.region.x), y: Math.min(b.y, a.region.y), w: Math.max(b.x + b.w, a.region.x + a.region.w) - Math.min(b.x, a.region.x), h: Math.max(b.y + b.h, a.region.y + a.region.h) - Math.min(b.y, a.region.y) } }
    case 'note': return { x: a.x, y: a.y, w: 22, h: 22 }
    default: return { x: a.x, y: a.y, w: a.w, h: a.h }
  }
}

/** Corners that can be dragged to resize, by type. */
export const resizable = (a) => ['image', 'rect', 'ellipse', 'whiteout', 'redact', 'text', 'mark', 'stamp', 'link', 'sig'].includes(a.t) || a.t === 'textedit'
export const keepsAspect = (a) => a.t === 'image' || a.t === 'mark' || a.t === 'stamp'

const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0
  return Math.hypot(x1 + t * dx - px, y1 + t * dy - py)
}

/** Point hit test (tol in pt). */
export function annHit(a, x, y, tol = 5) {
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
  if ((a.t === 'rect' || a.t === 'ellipse') && !a.fill) {
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
  return o
}

export function annMove(a, o, dx, dy) {
  if (o.pts) a.pts = o.pts.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)])
  if (o.rects) a.rects = o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }))
  if (o.x1 !== undefined) { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy }
  if (o.x !== undefined) { a.x = o.x + dx; a.y = o.y + dy }
  // a text edit's erase region stays put: only the replacement text moves
}

/** Resize from a corner/edge handle ('nw','n','ne','e','se','s','sw','w') to (x,y). */
export function annResize(a, o, handle, x, y, { aspect = false } = {}) {
  if (a.t === 'text' || a.t === 'textedit') {
    // side handles change the wrap width; corners scale the font
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

/** Rotate an annotation 90° clockwise with its page (page W×H before rotation). */
export function annRotate90(a, W, H) {
  const P = (x, y) => [H - y, x]
  const rectR = (r) => { const [x, y] = P(r.x, r.y + r.h); return { x, y, w: r.h, h: r.w } }
  if (a.pts) a.pts = a.pts.map((p) => [...P(p[0], p[1]), ...p.slice(2)])
  if (a.rects) a.rects = a.rects.map(rectR)
  if (a.x1 !== undefined) { [a.x1, a.y1] = P(a.x1, a.y1); [a.x2, a.y2] = P(a.x2, a.y2) }
  if (a.region) a.region = rectR(a.region)
  if (a.t === 'note') { [a.x, a.y] = P(a.x, a.y + 22); return }
  if (a.x !== undefined && a.pts === undefined && a.x1 === undefined) {
    const b = annBox(a)
    const nb = rectR(b)
    if (['text', 'textedit', 'image', 'stamp', 'mark'].includes(a.t)) {
      // content keeps its own shape, rotated about the box centre
      a.rot = ((a.rot ?? 0) + 90) % 360
      const cx = nb.x + nb.w / 2, cy = nb.y + nb.h / 2
      a.x = cx - b.w / 2
      a.y = cy - b.h / 2
    } else { a.x = nb.x; a.y = nb.y; a.w = nb.w; a.h = nb.h }
  }
}

// ---------- drawing ----------

const MARK_PATHS = {
  check: (x, y, w, h) => [['M', x + w * 0.12, y + h * 0.55], ['L', x + w * 0.4, y + h * 0.82], ['L', x + w * 0.9, y + h * 0.2]],
  cross: (x, y, w, h) => [['M', x + w * 0.18, y + h * 0.18], ['L', x + w * 0.82, y + h * 0.82], ['M', x + w * 0.82, y + h * 0.18], ['L', x + w * 0.18, y + h * 0.82]],
}
export const markSegs = (a) => (MARK_PATHS[a.kind] ?? MARK_PATHS.check)(a.x, a.y, a.w, a.h)

/**
 * Draw one annotation. S = canvas px per pt. opts.ghost = semi-transparent preview.
 * bmp(a) → decoded image for image annotations (or null while loading).
 */
export function annDraw(c, a, S, { bmp, editingId } = {}) {
  c.save()
  c.globalAlpha = a.alpha ?? 1
  c.lineJoin = 'round'
  c.lineCap = 'round'
  if (a.rot && a.t !== 'note') {
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
    case 'rect': case 'ellipse': case 'whiteout': {
      c.beginPath()
      if (a.t === 'ellipse') c.ellipse((a.x + a.w / 2) * S, (a.y + a.h / 2) * S, (a.w / 2) * S, (a.h / 2) * S, 0, 0, 7)
      else if (a.radius) c.roundRect?.(a.x * S, a.y * S, a.w * S, a.h * S, a.radius * S) ?? c.rect(a.x * S, a.y * S, a.w * S, a.h * S)
      else c.rect(a.x * S, a.y * S, a.w * S, a.h * S)
      const fill = a.t === 'whiteout' ? (a.fill ?? '#ffffff') : a.fill
      if (fill) { c.fillStyle = fill; c.fill() }
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
      // hatch so it reads as "pending redaction", not a plain shape
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
      c.fillStyle = a.color
      c.font = fontCssOf(a, a.size * S)
      c.textBaseline = 'alphabetic'
      b.lines.forEach((ln, i) => {
        const lw = lineWidth(a, ln)
        const lx = a.align === 'center' ? b.x + (b.w - lw) / 2 : a.align === 'right' ? b.x + b.w - lw : b.x
        const by = b.y + a.size * 0.8 + i * a.size * LINE_H
        // stretch the system font to the export font's advance widths (WYSIWYG line length)
        const measured = c.measureText(ln).width / S
        c.save()
        c.translate(lx * S, by * S)
        if (measured > 0 && lw > 0) c.scale(lw / measured, 1)
        c.fillText(ln, 0, 0)
        c.restore()
        if (a.underline || a.strike) {
          c.strokeStyle = a.color
          c.lineWidth = Math.max(0.5, (a.size / 16) * S)
          for (const off of [a.underline ? a.size * 0.12 : null, a.strike ? -a.size * 0.28 : null]) {
            if (off === null) continue
            c.beginPath(); c.moveTo(lx * S, (by + off) * S); c.lineTo((lx + lw) * S, (by + off) * S); c.stroke()
          }
        }
      })
      break
    }
    case 'image': {
      const im = bmp?.(a)
      if (im) c.drawImage(im, a.x * S, a.y * S, a.w * S, a.h * S)
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
      c.roundRect?.(a.x * S, a.y * S, a.w * S, a.h * S, a.h * 0.18 * S) ?? c.rect(a.x * S, a.y * S, a.w * S, a.h * S)
      c.stroke()
      const size = a.h * 0.5
      c.font = `700 ${size * S}px ${FAMILY_CSS.helv}`
      const tw = textWidth('Helvetica-Bold', a.label, size)
      const measured = c.measureText(a.label).width / S
      c.save()
      c.translate((a.x + (a.w - tw) / 2) * S, (a.y + a.h / 2 + size * 0.36) * S)
      if (measured) c.scale(tw / measured, 1)
      c.fillText(a.label, 0, 0)
      c.restore()
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

/** Selection chrome: dashed box + handles. u = canvas px per css px. */
export function drawSelection(c, a, S, u, accent = '#10b981') {
  const b = annBox(a)
  c.save()
  if (a.rot) {
    const cx = (b.x + b.w / 2) * S, cy = (b.y + b.h / 2) * S
    c.translate(cx, cy); c.rotate((a.rot * Math.PI) / 180); c.translate(-cx, -cy)
  }
  c.strokeStyle = accent
  c.lineWidth = 1.5 * u
  c.setLineDash([5 * u, 4 * u])
  const pad = 3 / (S / u) // 3 css px
  c.strokeRect((b.x - pad) * S, (b.y - pad) * S, (b.w + 2 * pad) * S, (b.h + 2 * pad) * S)
  c.setLineDash([])
  if (resizable(a)) {
    for (const [, hx, hy] of handlesOf(a, S / u)) {
      c.fillStyle = '#fff'
      c.strokeStyle = accent
      c.lineWidth = 1.5 * u
      c.beginPath()
      c.arc(hx * S, hy * S, 5 * u, 0, 7)
      c.fill()
      c.stroke()
    }
  }
  if (a.t === 'line') {
    for (const [px, py] of [[a.x1, a.y1], [a.x2, a.y2]]) {
      c.fillStyle = '#fff'; c.strokeStyle = accent; c.lineWidth = 1.5 * u
      c.beginPath(); c.arc(px * S, py * S, 5 * u, 0, 7); c.fill(); c.stroke()
    }
  }
  c.restore()
}

/** Handle positions [id, x, y] in pt; cssPerPt converts the 3px padding. */
export function handlesOf(a, cssPerPt = 1) {
  const b = annBox(a)
  const pad = 3 / cssPerPt
  const x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad, mx = (x0 + x1) / 2, my = (y0 + y1) / 2
  if (a.t === 'text' || a.t === 'textedit') return [['nw', x0, y0], ['ne', x1, y0], ['sw', x0, y1], ['se', x1, y1], ['w', x0, my], ['e', x1, my]]
  if (keepsAspect(a)) return [['nw', x0, y0], ['ne', x1, y0], ['sw', x0, y1], ['se', x1, y1]]
  return [['nw', x0, y0], ['n', mx, y0], ['ne', x1, y0], ['e', x1, my], ['se', x1, y1], ['s', mx, y1], ['sw', x0, y1], ['w', x0, my]]
}

/** Which handle (if any) is under (x,y) pt. tolPt = hit radius in pt. */
export function handleAt(a, x, y, tolPt, cssPerPt) {
  if (a.t === 'line') {
    if (Math.hypot(x - a.x1, y - a.y1) <= tolPt) return 'p1'
    if (Math.hypot(x - a.x2, y - a.y2) <= tolPt) return 'p2'
    return null
  }
  if (!resizable(a) || a.rot) return null
  for (const [id, hx, hy] of handlesOf(a, cssPerPt)) if (Math.hypot(x - hx, y - hy) <= tolPt) return id
  return null
}

export const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'move', p2: 'move' }

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
