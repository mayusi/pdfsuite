// Canvas renderer for collectDrawOps output — browser-side only.
// Paints text glyph-by-glyph at the PDF's own positions (substitute system
// fonts, matched by family/weight/style), images through their full matrix,
// vector paths, gradients, clips, alpha and blend modes.
import { decodeImage } from './image.js'
import { collectDrawOps } from './content.js'

const FAMILY = {
  serif: '"Times New Roman", Times, "Liberation Serif", Georgia, serif',
  sans: 'Arial, Helvetica, "Liberation Sans", "Segoe UI", sans-serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
}
export const fontCss = (f, px) => {
  const fam = f?.mono ? FAMILY.mono : f?.serif ? FAMILY.serif : FAMILY.sans
  return `${f?.italic ? 'italic ' : ''}${f?.bold ? '700 ' : ''}${px}px ${fam}`
}

/** Decode an image op once per doc → CanvasImageSource | null (cached). */
export async function imageSource(doc, op, cache) {
  const key = op.ref ?? op.inline
  if (key && cache.has(key)) return cache.get(key)
  const p = (async () => {
    const src = op.ref ?? { dict: op.inline.dict, data: op.inline.data }
    const im = await decodeImage(doc, src, { fill: op.fill ?? [0, 0, 0], res: op.res, inline: !!op.inline }).catch(() => null)
    if (!im) return null
    if (im.kind === 'rgba') return rgbaCanvas(im.w, im.h, im.rgba)
    if (im.kind === 'jpeg') {
      const bmp = await createImageBitmap(new Blob([im.data], { type: 'image/jpeg' })).catch(() => null)
      if (!bmp) return null
      if (!im.smask && !im.invert) return bmp
      const cv = document.createElement('canvas')
      cv.width = bmp.width
      cv.height = bmp.height
      const c = cv.getContext('2d')
      c.drawImage(bmp, 0, 0)
      const id = c.getImageData(0, 0, cv.width, cv.height)
      if (im.invert) for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 255 - id.data[i]; id.data[i + 1] = 255 - id.data[i + 1]; id.data[i + 2] = 255 - id.data[i + 2] }
      if (im.smask) {
        const { w: mw, h: mh, a } = im.smask
        for (let y = 0; y < cv.height; y++) {
          const my = Math.min(mh - 1, Math.floor((y * mh) / cv.height))
          for (let x = 0; x < cv.width; x++) {
            const mx = Math.min(mw - 1, Math.floor((x * mw) / cv.width))
            id.data[(y * cv.width + x) * 4 + 3] = a[my * mw + mx]
          }
        }
      }
      c.putImageData(id, 0, 0)
      return cv
    }
    return null // JPX: no browser decoder
  })()
  if (key) cache.set(key, p)
  return p
}

function rgbaCanvas(w, h, rgba) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  cv.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0)
  return cv
}

const CAP = ['butt', 'round', 'square']
const JOIN = ['miter', 'round', 'bevel']
const rgb = (c, fallback = '#000') => (c ? `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})` : fallback)

/**
 * Paint draw ops onto ctx. scale = device px per pt. Returns nothing.
 * opts.skipText: leave text out (the editor's text-edit mode paints its own).
 */
export async function paintOps(ctx, doc, ops, scale, cache = new Map(), { hide = null, hideGlyph = null } = {}) {
  let saves = 0
  const base = () => ctx.setTransform(scale, 0, 0, scale, 0, 0)
  const trace = (segs) => {
    ctx.beginPath()
    for (const seg of segs) {
      if (seg[0] === 'M') ctx.moveTo(seg[1], seg[2])
      else if (seg[0] === 'L') ctx.lineTo(seg[1], seg[2])
      else if (seg[0] === 'C') ctx.bezierCurveTo(seg[1], seg[2], seg[3], seg[4], seg[5], seg[6])
      else if (seg[0] === 'Z') ctx.closePath()
    }
  }
  const minLw = 1 / scale // hairlines: one device pixel
  base()
  for (const op of ops) {
    if (hide && hide(op)) continue
    ctx.globalCompositeOperation = op.blend ?? 'source-over'
    if (op.t === 'clip') {
      ctx.save(); saves++
      base()
      trace(op.segs)
      ctx.clip(op.eo ? 'evenodd' : 'nonzero')
    } else if (op.t === 'unclip') {
      if (saves > 0) { ctx.restore(); saves-- }
    } else if (op.t === 'rect' || op.t === 'path') {
      base()
      if (op.t === 'rect') { ctx.beginPath(); ctx.rect(op.x, op.y, op.w, op.h) } else trace(op.segs)
      if (op.fill) {
        ctx.globalAlpha = op.a ?? 1
        ctx.fillStyle = rgb(op.fc)
        ctx.fill(op.eo ? 'evenodd' : 'nonzero')
      }
      if (op.stroke) {
        ctx.globalAlpha = op.sa ?? 1
        ctx.strokeStyle = rgb(op.sc)
        ctx.lineWidth = Math.max(minLw, op.lw ?? 1)
        ctx.lineCap = CAP[op.cap] ?? 'butt'
        ctx.lineJoin = JOIN[op.join] ?? 'miter'
        ctx.setLineDash(op.dash ?? [])
        ctx.lineDashOffset = op.doff ?? 0
        ctx.stroke()
        ctx.setLineDash([])
      }
    } else if (op.t === 'shade') {
      base()
      ctx.globalAlpha = op.a ?? 1
      if (op.kind === 'flat') ctx.fillStyle = rgb(op.color)
      else {
        const g = op.kind === 'axial'
          ? ctx.createLinearGradient(...op.coords)
          : ctx.createRadialGradient(...op.coords)
        for (const [t, c] of op.stops) g.addColorStop(Math.min(1, Math.max(0, t)), rgb(c))
        ctx.fillStyle = g
      }
      ctx.fillRect(-1e4, -1e4, 2e4, 2e4) // the active clip bounds it
    } else if (op.t === 'img') {
      const src = await imageSource(doc, op, cache)
      if (!src) continue
      const m = op.m
      // unit square (y up) → display; flip so bitmap row 0 lands at the top
      ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4], scale * m[5])
      ctx.transform(1, 0, 0, -1, 0, 1)
      ctx.globalAlpha = op.a ?? 1
      // upscaled small images look terrible blurred; tiny-source stencils stay crisp
      const sw = src.width ?? 1
      ctx.imageSmoothingEnabled = !(sw < 64 && op.w * scale > sw * 4)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, 0, 0, 1, 1)
      base()
    } else if (op.t === 'text') {
      if (op.inv || !op.h) continue
      const px = op.h * scale
      const m = op.m
      if (!op.str || px < 3.2 || !op.gx) {
        // too small to read (thumbnails) or undecodable: draw an ink bar
        if (op.w * scale < 0.5) continue
        if (hideGlyph) { // a run being edited mustn't reappear as a grey bar at low zoom
          const cx = m[0] * (op.fs * 0.3) + m[2] * op.fs * 0.32 + m[4], cy = m[1] * (op.fs * 0.3) + m[3] * op.fs * 0.32 + m[5]
          if (hideGlyph(cx, cy)) continue
        }
        ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4], scale * m[5])
        ctx.globalAlpha = (op.a ?? 1) * 0.55
        ctx.fillStyle = rgb(op.fc)
        const adv = op.gx?.length ? op.gx[op.gx.length - 2] + op.fs * 0.5 : op.fs * op.str.length * 0.5
        ctx.fillRect(0, 0, Math.max(adv, op.fs * 0.3), op.fs * 0.62)
        base()
        continue
      }
      // text space (y-up, font size fs) → work in device-sized units so the
      // browser rasterises glyphs at their real pixel size (no 1px-font blur)
      const q = px / op.fs
      const th = op.th || 1
      ctx.setTransform(scale * m[0], scale * m[1], scale * m[2], scale * m[3], scale * m[4], scale * m[5])
      ctx.scale(th / q, -1 / q)
      ctx.font = fontCss(op.font, px)
      ctx.textBaseline = 'alphabetic'
      const mode = (op.mode ?? 0) % 4
      const fill = mode === 0 || mode === 2
      const stroke = mode === 1 || mode === 2
      ctx.fillStyle = rgb(op.fc)
      ctx.strokeStyle = rgb(op.sc)
      ctx.lineWidth = Math.max(0.03 * px, 1)
      const gx = op.gx
      for (let i = 0; i < gx.length; i += 2) {
        const ch = gx[i + 1]
        if (!ch || ch === ' ') continue
        if (hideGlyph) { // editor: glyphs under an "edit text" region aren't painted
          const adv = i + 2 < gx.length ? gx[i + 2] - gx[i] : op.fs * 0.5
          const cx = m[0] * (gx[i] + adv / 2) + m[2] * op.fs * 0.32 + m[4]
          const cy = m[1] * (gx[i] + adv / 2) + m[3] * op.fs * 0.32 + m[5]
          if (hideGlyph(cx, cy)) continue
        }
        const x = (gx[i] / th) * q
        if (fill) { ctx.globalAlpha = op.a ?? 1; ctx.fillText(ch, x, 0) }
        if (stroke) { ctx.globalAlpha = op.sa ?? 1; ctx.strokeText(ch, x, 0) }
      }
      base()
    }
  }
  while (saves-- > 0) ctx.restore()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

/**
 * Render a page to a new canvas `width` px wide (white background).
 * cache: Map shared across pages of one doc (decoded images).
 * Returns null for pages whose content can't be read at all.
 */
export async function renderPage(doc, leaf, { width = 160, cache = new Map(), annots = true, widgets = true } = {}) {
  const { ops, box } = await collectDrawOps(doc, leaf, { annots, widgets })
  const scale = width / box.w
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(box.w * scale))
  canvas.height = Math.max(2, Math.round(box.h * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (!ops.length) return canvas // a genuinely blank page is still a page
  await paintOps(ctx, doc, ops, scale, cache)
  return canvas
}
