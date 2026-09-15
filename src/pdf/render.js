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
  for (const op of ops) {
    if (op.t === 'rect') {
      ctx.fillStyle = 'rgba(148,163,184,0.35)'
      if (op.stroke) {
        ctx.strokeStyle = 'rgba(100,116,139,0.6)'
        ctx.lineWidth = Math.max(0.5, scale * 0.5)
        ctx.strokeRect(s(op.x), s(op.y), s(op.w), s(op.h))
      } else ctx.fillRect(s(op.x), s(op.y), s(op.w), s(op.h))
    } else if (op.t === 'img') {
      const bmp = await cachedBitmap(doc, op.ref, cache)
      if (!bmp) continue
      ctx.save()
      ctx.globalAlpha = 0.92
      ctx.drawImage(bmp, s(op.x), s(op.y), s(op.w), s(op.h))
      ctx.restore()
    } else if (op.t === 'text') {
      const px = op.h * scale
      ctx.save()
      ctx.translate(s(op.x), s(op.y))
      if (op.rot) ctx.rotate(op.rot)
      if (op.str && op.size * scale >= 4) {
        ctx.fillStyle = 'rgba(30,41,59,0.85)'
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
