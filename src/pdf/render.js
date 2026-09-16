import { collectDrawOps, decodeImageStream } from './ops.js'

/**
 * Canvas painter for collectDrawOps output — browser-side only.
 * renderPage() walks a page's content stream and paints a miniature:
 * images at their painted rects, real text where decodable & large enough,
 * skeleton bars elsewhere, table/box fills as light rects.
 */

/** Decode an image XObject once per doc → ImageBitmap (cached by stream object). */
async function cachedBitmap(doc, ref, cache) {
  if (!cache.has(ref)) {
    cache.set(ref, (async () => {
      const dec = await decodeImageStream(doc, ref).catch(() => null)
      if (!dec) return null
      return createImageBitmap(new Blob([dec.data], { type: dec.mime })).catch(() => null)
    })())
  }
  return cache.get(ref)
}

/**
 * Render a page to a canvas element.
 * width: target pixel width. cache: Map shared across pages of one doc
 * (letterhead/logo images decode once). Returns null for empty pages.
 */
export async function renderPage(doc, leaf, { width = 160, cache = new Map() } = {}) {
  const { ops, box } = await collectDrawOps(doc, leaf)
  if (!ops.length) return null
  const scale = width / box.w
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(2, Math.round(box.w * scale))
  canvas.height = Math.max(2, Math.round(box.h * scale))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const s = (v) => v * scale
  const rgba = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`
  const trace = (segs) => {
    ctx.beginPath()
    for (const seg of segs) {
      if (seg[0] === 'M') ctx.moveTo(s(seg[1]), s(seg[2]))
      else if (seg[0] === 'L') ctx.lineTo(s(seg[1]), s(seg[2]))
      else if (seg[0] === 'C') ctx.bezierCurveTo(s(seg[1]), s(seg[2]), s(seg[3]), s(seg[4]), s(seg[5]), s(seg[6]))
      else if (seg[0] === 'Z') ctx.closePath()
    }
  }
  const paintShape = (op, run) => {
    if (op.fill) {
      ctx.fillStyle = rgba(op.fc ?? [0.8, 0.85, 0.92], (op.a ?? 1) * 0.9)
      run.fill(op.eo ? 'evenodd' : 'nonzero')
    }
    if (op.stroke) {
      ctx.strokeStyle = rgba(op.sc ?? [0.45, 0.5, 0.6], op.a ?? 1)
      ctx.lineWidth = Math.max(0.5, s(op.lw ?? 1))
      if (op.dash) {
        ctx.setLineDash(op.dash.map((d) => d * scale))
        ctx.lineDashOffset = s(op.doff ?? 0)
      }
      run.stroke()
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
    }
  }
  for (const op of ops) {
    if (op.t === 'clip') {
      ctx.save()
      trace(op.segs)
      ctx.clip(op.eo ? 'evenodd' : 'nonzero')
    } else if (op.t === 'unclip') {
      ctx.restore()
    } else if (op.t === 'rect') {
      ctx.beginPath()
      ctx.rect(s(op.x), s(op.y), s(op.w), s(op.h))
      paintShape(op, {
        fill: (r) => ctx.fill(r),
        stroke: () => ctx.stroke(),
      })
    } else if (op.t === 'path') {
      trace(op.segs)
      paintShape(op, {
        fill: (r) => ctx.fill(r),
        stroke: () => ctx.stroke(),
      })
    } else if (op.t === 'img') {
      const bmp = await cachedBitmap(doc, op.ref, cache)
      if (!bmp) continue
      ctx.save()
      ctx.globalAlpha = (op.a ?? 1) * 0.92
      ctx.translate(s(op.x), s(op.y))
      if (op.rot) ctx.rotate(op.rot)
      if (op.mirror) ctx.scale(1, -1)
      ctx.drawImage(bmp, 0, 0, s(op.w), s(op.h))
      ctx.restore()
    } else if (op.t === 'text') {
      if (op.inv) continue // invisible OCR layer — extractable but not painted
      const px = op.h * scale
      ctx.save()
      ctx.translate(s(op.x), s(op.y))
      if (op.rot) ctx.rotate(op.rot)
      if (op.str && op.size * scale >= 4) {
        ctx.fillStyle = rgba(op.fc ?? [0.15, 0.2, 0.3], (op.a ?? 1) * 0.9)
        ctx.font = `${px}px sans-serif`
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(op.str, 0, 0)
      } else {
        // skeleton bar — text run too small/undecodable: ink density block
        ctx.fillStyle = 'rgba(71,85,105,0.55)'
        const bh = Math.max(0.8, op.h * scale * 0.72)
        ctx.fillRect(0, -bh, Math.max(1, s(op.w)), bh)
      }
      ctx.restore()
    }
  }
  return canvas
}
