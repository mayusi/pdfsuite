// Editor → PDF. Pipeline (each step works in the FINAL page display space):
//   1. page structure (order / rotation / deletes / blank inserts)
//   2. text removal under "edit text" regions, true redaction, and removal of
//      embedded images the user deleted or replaced with an edited copy
//   3. form field values (optionally flattened)
//   4. everything else baked in as real PDF content / annotations (images run
//      through the same fx pipeline as the on-screen preview, at full size)
import { parsePdf } from '../pdf/parse.js'
import { organizePages, pageLeaves } from '../pdf/ops.js'
import { applyRemovals } from '../pdf/redact.js'
import { fillForm } from '../pdf/forms.js'
import { annotatePdf } from '../pdf/stamp.js'
import { toWinAnsi } from '../pdf/encodings.js'
import { textBox, fontCssOf, markSegs, polyPoints, LINE_H } from './annots.js'
import { processImage, fxIsIdentity } from './imagefx.js'

/** Browser JPEG decoder for the redaction engine. */
async function decodeJpeg(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const x = c.getContext('2d')
  x.drawImage(bmp, 0, 0)
  bmp.close?.()
  const d = x.getImageData(0, 0, c.width, c.height)
  return { w: c.width, h: c.height, rgba: d.data }
}

/** Render text the standard fonts can't encode (CJK, Arabic, emoji…) to a transparent image. */
function rasterText(a, b) {
  const k = 4 // px per pt — crisp when printed
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil((b.w + 4) * k))
  c.height = Math.max(1, Math.ceil((b.h + 2) * k))
  const x = c.getContext('2d')
  if (a.bg) { x.fillStyle = a.bg; x.fillRect(0, 0, c.width, c.height) }
  x.fillStyle = a.color
  x.font = fontCssOf(a, a.size * k)
  x.textBaseline = 'alphabetic'
  x.direction = 'inherit'
  b.lines.forEach((ln, i) => {
    const lw = x.measureText(ln).width
    const lx = a.align === 'center' ? (c.width - lw) / 2 : a.align === 'right' ? c.width - lw - 2 * k : 2 * k
    // (b.w comes from lineWidth(), i.e. the same browser measurement — nothing clips)
    x.fillText(ln, lx, (1 + a.size * 0.8 + i * a.size * (a.lineHeight ?? LINE_H)) * k)
  })
  const d = x.getImageData(0, 0, c.width, c.height)
  return { t: 'image', x: b.x - 2, y: b.y - 1, w: b.w + 4, h: b.h + 2, rgba: d.data, iw: c.width, ih: c.height, alpha: a.alpha ?? 1, rot: a.rot ? (a.rot * Math.PI) / 180 : 0 }
}

/**
 * Bake an image object's crop / flip / adjustments into pixels.
 * Returns a plain {rgba, iw, ih, x, y, w, h} (the box grows when a shadow pads it),
 * or null when nothing needs processing (the original bytes are kept).
 */
export async function bakeImage(a, decode = decodeJpeg) {
  const geo = { crop: a.crop, srcW: a.iw, flipH: a.flipH, flipV: a.flipV }
  if (fxIsIdentity(a.fx ?? {}, geo)) return null
  const src = a.rgba ? { rgba: a.rgba, w: a.iw, h: a.ih } : await decode(a.jpeg)
  const r = processImage(src, geo, a.fx ?? {})
  const sx = a.w / (r.innerW || 1), sy = a.h / (r.innerH || 1)
  return { rgba: r.rgba, iw: r.w, ih: r.h, x: a.x - r.ox * sx, y: a.y - r.oy * sy, w: r.w * sx, h: r.h * sy }
}

/** One editor object → engine annotations (array). */
export function toEngine(a) {
  const rot = a.rot ? (a.rot * Math.PI) / 180 : 0
  if (a.hidden || a.t === 'imgremove') return []
  const out = toEngine1(a, rot)
  if (a.blend && a.blend !== 'normal') for (const o of out) o.blend = a.blend
  return out
}

/** Shapes with a separately-transparent fill become fill + outline objects. */
function splitFill(o, fillAlpha) {
  if (!o.fill || !(fillAlpha < 1)) return [o]
  const alpha = o.alpha ?? 1
  return [{ ...o, stroke: null, alpha: alpha * fillAlpha }, ...(o.stroke && o.lw > 0 ? [{ ...o, fill: null, alpha }] : [])]
}

function toEngine1(a, rot) {
  switch (a.t) {
    case 'stroke': return [{ t: 'vstroke', pts: a.pts.map((p) => [p[0], p[1], p[2] ?? a.width]), color: a.color, alpha: a.alpha }]
    case 'highlight': return [{ t: 'highlight', pts: a.pts, color: a.color, width: a.width, alpha: a.alpha ?? 0.4 }]
    case 'hlrects': return a.rects.map((r) => ({ t: 'highlight', pts: [[r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2]], width: r.h, color: a.color, alpha: a.alpha ?? 0.4 }))
    case 'line': return [{ ...a }]
    case 'rect': case 'ellipse': return splitFill({ t: a.t, x: a.x, y: a.y, w: a.w, h: a.h, stroke: a.stroke, fill: a.fill, lw: a.lw, alpha: a.alpha, dash: a.dash, radius: a.radius, rot }, a.fillAlpha)
    case 'poly': {
      const pts = polyPoints(a)
      const segs = [...pts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]), ['Z']]
      return splitFill({ t: 'path', segs, stroke: a.stroke, fill: a.fill, lw: a.stroke ? a.lw : 0, alpha: a.alpha, dash: a.dash, x: a.x, y: a.y, w: a.w, h: a.h, rot }, a.fillAlpha)
    }
    case 'whiteout': return [{ t: 'rect', x: a.x, y: a.y, w: a.w, h: a.h, fill: a.fill ?? '#ffffff', stroke: null, lw: 0, alpha: 1, rot }]
    case 'text': case 'textedit': {
      if (!a.text.trim()) return []
      const b = textBox(a)
      const text = b.lines.join('\n')
      if (toWinAnsi(text.replace(/\n/g, '')) === null) return [rasterText(a, b)]
      return [{
        t: 'text', x: b.x, y: b.y, w: b.w, h: b.h, text, size: a.size, font: a.font, bold: a.bold, italic: a.italic, underline: a.underline, strike: a.strike,
        color: a.color, align: a.align, bg: a.bg, alpha: a.alpha, lineHeight: a.lineHeight ?? LINE_H, spacing: a.spacing || 0, outline: a.outline, shadow: a.shadow, rot,
      }]
    }
    case 'image': {
      const b = a.baked // set by exportEdited when fx/crop/flip apply
      if (b) return [{ t: 'image', x: b.x, y: b.y, w: b.w, h: b.h, rgba: b.rgba, iw: b.iw, ih: b.ih, alpha: a.alpha, rot }]
      return [{ t: 'image', x: a.x, y: a.y, w: a.w, h: a.h, jpeg: a.jpeg, rgba: a.rgba, iw: a.iw, ih: a.ih, alpha: a.alpha, rot }]
    }
    case 'mark':
      if (a.kind === 'dot') return [{ t: 'ellipse', x: a.x + a.w * 0.12, y: a.y + a.h * 0.12, w: a.w * 0.76, h: a.h * 0.76, fill: a.color, alpha: a.alpha, rot }]
      return [{ t: 'path', segs: markSegs(a), stroke: a.color, lw: Math.max(1, Math.min(a.w, a.h) * 0.12), alpha: a.alpha, x: a.x, y: a.y, w: a.w, h: a.h, rot }]
    case 'stamp': {
      const size = a.h * 0.5
      return [
        { t: 'rect', x: a.x, y: a.y, w: a.w, h: a.h, stroke: a.color, lw: Math.max(1, a.h * 0.06), radius: a.h * 0.18, alpha: a.alpha, rot },
        // h = 0.9·size puts the text box centre on the stamp centre, so both rotate about the same point
        { t: 'text', x: a.x, y: a.y + a.h / 2 - size * 0.45, w: a.w, h: size * 0.9, align: 'center', text: a.label, size, font: 'helv', bold: true, color: a.color, alpha: a.alpha, rot },
      ]
    }
    case 'note': return [{ t: 'note', x: a.x, y: a.y, text: a.text, color: a.color }]
    case 'link': return [{ t: 'link', x: a.x, y: a.y, w: a.w, h: a.h, url: a.url }]
    default: return []
  }
}

/**
 * Build the edited PDF.
 * info: opened source; pages: [{src|null, rot, w, h, annots}];
 * forms: {values: {name: value}, flatten} | null. Returns Uint8Array.
 */
export async function exportEdited(info, pages, { forms = null, onStep = () => {}, decode = decodeJpeg } = {}) {
  // 1. structure
  const identity = pages.length === info.leaves.length && pages.every((p, i) => p.src === i && !p.rot)
  let bytes = info.bytes
  if (!identity) {
    onStep('Arranging pages')
    bytes = await organizePages(info.bytes, pages.map((p) => (p.src === null ? { blank: [p.w, p.h] } : { page: p.src + 1, rotation: p.rot })))
  }
  let doc = await parsePdf(bytes)
  if (pageLeaves(doc).length !== pages.length) throw new Error('page structure mismatch')
  // 2. removals
  const erase = pages.map((p) => p.annots.filter((a) => a.t === 'textedit').map((a) => a.region))
  const redact = pages.map((p) => p.annots.filter((a) => a.t === 'redact').map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h, fill: a.fill })))
  if (erase.some((r) => r.length)) { onStep('Editing text'); await applyRemovals(doc, erase, { mode: 'erase' }) }
  if (redact.some((r) => r.length)) {
    onStep('Redacting')
    const fill = pages.flatMap((p) => p.annots).find((a) => a.t === 'redact')?.fill ?? '#000000'
    await applyRemovals(doc, redact, { mode: 'redact', fill, decodeJpeg })
  }
  const dropped = pages.map((p) => p.annots.filter((a) => a.t === 'imgremove').map((a) => a.region))
  if (dropped.some((r) => r.length)) { onStep('Replacing images'); await applyRemovals(doc, dropped, { mode: 'dropimg' }) }
  // 3. forms
  let src = doc
  if (forms && (Object.keys(forms.values).length || forms.flatten)) {
    onStep('Filling form')
    src = await fillForm(doc, forms.values, { flatten: forms.flatten })
  }
  // 4. annotations
  const edited = pages.flatMap((p) => p.annots).filter((a) => a.t === 'image' && !a.hidden)
  const baked = new Map()
  for (const a of edited) {
    const b = await bakeImage(a, decode)
    if (b) { if (!baked.size) onStep('Processing images'); baked.set(a, b) }
  }
  onStep('Saving')
  const engineAnnots = pages.map((p) => p.annots.filter((a) => a.t !== 'redact').flatMap((a) => toEngine(baked.has(a) ? { ...a, baked: baked.get(a) } : a)))
  return annotatePdf(src, engineAnnots)
}

