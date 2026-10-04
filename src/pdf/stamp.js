// Everything that draws ON pages: page numbers, watermarks and the editor's
// annotation export. One rebuild pass (stampPages) appends generated content
// streams, merges resources and can add real PDF annotations (notes, links).
import { get, isRef, name, ref, stream, enc } from './types.js'
import { deref, parsePdf } from './parse.js'
import { newDoc } from './write.js'
import { deflate } from './env.js'
import { toWinAnsi } from './encodings.js'
import { stdWidth } from './metrics.js'
import { textString } from './outline.js'
import { pageBox, pageRotation } from './content.js'
import { copyValue, pageLeaves, finishDoc, jpegInfo, INHERITED } from './ops.js'

/** Display→user position + counter-rotation matrix for /Rotate'd pages. */
export function stampPos(rot, xd, yd, w, hh) {
  return rot === 90 ? [w - yd, xd, [0, 1, -1, 0]]
    : rot === 180 ? [w - xd, hh - yd, [-1, 0, 0, -1]]
    : rot === 270 ? [yd, hh - xd, [0, -1, 1, 0]]
    : [xd, yd, [1, 0, 0, 1]]
}

const fmt = (v) => (Number.isFinite(v) ? +v.toFixed(3) : 0)

/** Standard font face → base font name. family: helv|times|courier. */
export function stdFont(family = 'helv', bold = false, italic = false) {
  if (family === 'helvb') { family = 'helv'; bold = true }
  if (family === 'times') return bold ? (italic ? 'Times-BoldItalic' : 'Times-Bold') : (italic ? 'Times-Italic' : 'Times-Roman')
  if (family === 'courier') return bold ? (italic ? 'Courier-BoldOblique' : 'Courier-Bold') : (italic ? 'Courier-Oblique' : 'Courier')
  return bold ? (italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (italic ? 'Helvetica-Oblique' : 'Helvetica')
}
const fontDict = (base) => new Map([
  ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name(base)], ['Encoding', name('WinAnsiEncoding')],
])

/** WinAnsi literal string operand; unmappable chars become '?'. */
export function winStr(s) {
  let out = '('
  for (const ch of s) {
    const b = toWinAnsi(ch)?.[0] ?? 0x3f
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b)
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += '\\' + b.toString(8).padStart(3, '0')
  }
  return out + ')'
}
/** Text width in pt for a standard font (unmappable chars measured as '?'). */
export function textWidth(base, s, size) {
  const bytes = []
  for (const ch of s) bytes.push(toWinAnsi(ch)?.[0] ?? 0x3f)
  return stdWidth(base, bytes, size)
}

/** '#rrggbb' or [r,g,b] (0-1) → 'r g b' or null. */
export function rgbOp(c) {
  if (Array.isArray(c) && c.length >= 3) return c.slice(0, 3).map((v) => fmt(Math.min(1, Math.max(0, v)))).join(' ')
  const m = typeof c === 'string' ? c.match(/^#([0-9a-f]{6})$/i) : null
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => fmt(v)).join(' ')
}

/**
 * Build an image XObject in dst from {jpeg} or {rgba, w, h} (alpha → /SMask).
 * Returns the ref.
 */
export async function imageXObject(dst, img) {
  if (img.jpeg instanceof Uint8Array) {
    const info = jpegInfo(img.jpeg)
    const d = new Map([
      ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', info.width], ['Height', info.height],
      ['ColorSpace', name(info.colorSpace)], ['BitsPerComponent', 8], ['Filter', name('DCTDecode')],
    ])
    if (info.colorSpace === 'DeviceCMYK' && info.adobe) d.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0])
    const num = dst.alloc()
    dst.set(num, stream(d, img.jpeg))
    return ref(num, 0)
  }
  const { rgba, w, h } = img
  const rgb = new Uint8Array(w * h * 3)
  const alpha = new Uint8Array(w * h)
  let hasAlpha = false
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    rgb[i * 3] = rgba[j]; rgb[i * 3 + 1] = rgba[j + 1]; rgb[i * 3 + 2] = rgba[j + 2]
    alpha[i] = rgba[j + 3]
    if (rgba[j + 3] !== 255) hasAlpha = true
  }
  const d = new Map([
    ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', w], ['Height', h],
    ['ColorSpace', name('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', name('FlateDecode')],
  ])
  if (hasAlpha) {
    const sm = dst.alloc()
    dst.set(sm, stream(new Map([
      ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', w], ['Height', h],
      ['ColorSpace', name('DeviceGray')], ['BitsPerComponent', 8], ['Filter', name('FlateDecode')],
    ]), await deflate(alpha)))
    d.set('SMask', ref(sm, 0))
  }
  const num = dst.alloc()
  dst.set(num, stream(d, await deflate(rgb)))
  return ref(num, 0)
}

/**
 * Rebuild `bytes` stamping generated content on each page.
 * stampFor(ctx) → {content, res?: {Font?, ExtGState?, XObject?}, under?, annots?: Map[]} | null
 * (may be async). ctx = {leaf, i, total, mb, rot, w, hh, dw, dh, dst}.
 * The original content is wrapped in q…Q so its leftover graphics state
 * (an unbalanced cm, a clip) can never shift or hide the stamp.
 */
export async function stampPages(bytes, stampFor, { pages = null } = {}) {
  const src = bytes instanceof Uint8Array ? await parsePdf(bytes) : bytes // a parsed (possibly pre-edited) doc is fine too
  const leaves = pageLeaves(src)
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const refMap = new Map()
  const nums = leaves.map((leaf) => {
    const num = dst.alloc()
    kids.push(ref(num, 0))
    if (isRef(leaf.ref)) refMap.set(`${leaf.ref.n} ${leaf.ref.g}`, ref(num, 0))
    return num
  })
  let qNum = 0, QNum = 0
  const qq = () => {
    if (!qNum) {
      qNum = dst.alloc(); dst.set(qNum, stream(new Map(), enc('q\n')))
      QNum = dst.alloc(); dst.set(QNum, stream(new Map(), enc('\nQ\n')))
    }
  }
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]
    const pageDict = new Map()
    for (const k of INHERITED) {
      const v = get(leaf.dict, k) ?? leaf.inh[k]
      if (v !== undefined) pageDict.set(k, copyValue(v, src, dst, refMap))
    }
    for (const [k, val] of leaf.dict) {
      if (k === 'Parent' || k === 'Metadata' || INHERITED.includes(k)) continue
      pageDict.set(k, copyValue(val, src, dst, refMap))
    }
    pageDict.set('Type', name('Page'))
    pageDict.set('Parent', ref(pagesRef, 0))
    // the VISIBLE box (CropBox ∩ MediaBox) — what viewers and our editor show
    const mb = pageBox(src, leaf)
    const rot = pageRotation(src, leaf)
    const w = mb[2] - mb[0], hh = mb[3] - mb[1]
    const dw = rot % 180 === 0 ? w : hh
    const dh = rot % 180 === 0 ? hh : w
    const stamp = pages && !pages.includes(i) ? null
      : await stampFor({ leaf, i, total: leaves.length, mb, rot, w, hh, dw, dh, dst })
    if (stamp && (stamp.content || stamp.annots?.length)) {
      if (stamp.content) {
        const csNum = dst.alloc()
        dst.set(csNum, stream(new Map(), enc(stamp.content)))
        let contents = pageDict.get('Contents')
        if (isRef(contents)) { // qpdf-style: Contents → ref TO an array
          const c = dst.objects.get(contents.n)
          if (Array.isArray(c)) contents = c
        }
        const orig = Array.isArray(contents) ? contents.slice() : contents !== undefined && contents !== null ? [contents] : []
        let arr
        if (stamp.under) arr = [ref(csNum, 0), ...orig]
        else if (orig.length) { qq(); arr = [ref(qNum, 0), ...orig, ref(QNum, 0), ref(csNum, 0)] }
        else arr = [ref(csNum, 0)]
        pageDict.set('Contents', arr.length === 1 ? arr[0] : arr)
        let res = pageDict.get('Resources')
        if (isRef(res)) res = dst.objects.get(res.n)
        // clone before mutating: shared Resources dicts must not leak across pages
        res = res instanceof Map ? new Map(res) : new Map()
        for (const [section, entries] of Object.entries(stamp.res ?? {})) {
          let sec = res.get(section)
          if (isRef(sec)) sec = dst.objects.get(sec.n)
          sec = sec instanceof Map ? new Map(sec) : new Map()
          for (const [nm, val] of Object.entries(entries)) sec.set(nm, val)
          res.set(section, sec)
        }
        pageDict.set('Resources', res)
      }
      if (stamp.annots?.length) {
        let an = pageDict.get('Annots')
        if (isRef(an)) an = dst.objects.get(an.n)
        const list = Array.isArray(an) ? an.slice() : []
        for (const a of stamp.annots) {
          const n = dst.alloc()
          a.set('P', ref(nums[i], 0))
          dst.set(n, a)
          list.push(ref(n, 0))
        }
        pageDict.set('Annots', list)
      }
    }
    dst.set(nums[i], pageDict)
  }
  return finishDoc(dst, pagesRef, kids, src, refMap)
}

/** Which 0-based page indices a page selector covers. sel: 'all'|'odd'|'even'|number[] (1-based). */
export function selectPages(sel, total) {
  if (Array.isArray(sel)) return sel.map((p) => p - 1).filter((i) => i >= 0 && i < total)
  const all = Array.from({ length: total }, (_, i) => i)
  if (sel === 'odd') return all.filter((i) => i % 2 === 0)
  if (sel === 'even') return all.filter((i) => i % 2 === 1)
  return all
}

/**
 * Stamp page numbers.
 * opts: pos (tl|tc|tr|bl|bc|br), fmt ('n-of-total'|'n'|'page-n'|'page-n-of-total'|'custom'),
 * fmtStr ({n},{t}), start, skipFirst, size, margin, font, bold, color, mirror (swap l/r on even pages),
 * pages ('all'|'odd'|'even'|number[]).
 */
export async function addPageNumbers(bytes, opts = {}) {
  const {
    pos = 'bc', fmt: style = 'n-of-total', fmtStr = '{n}', start = 1, skipFirst = false, size = 10,
    margin = 18, font = 'helv', bold = false, color = '#000000', mirror = false, pages: sel = 'all',
  } = opts
  const base = stdFont(font, bold)
  const label = (i, total) => {
    const n = i + start - (skipFirst ? 1 : 0)
    const t = total - (skipFirst ? 1 : 0) + start - 1
    if (style === 'custom') return (fmtStr || '{n}').replaceAll('{n}', String(n)).replaceAll('{t}', String(t))
    if (style === 'n') return String(n)
    if (style === 'page-n') return `Page ${n}`
    if (style === 'page-n-of-total') return `Page ${n} of ${t}`
    return `${n} / ${t}`
  }
  const col = rgbOp(color) ?? '0 0 0'
  let wanted = null
  return stampPages(bytes, ({ i, total, mb, rot, w, hh, dw, dh }) => {
    wanted ??= new Set(selectPages(sel, total))
    if ((i === 0 && skipFirst) || !wanted.has(i)) return null
    const s = label(i, total)
    const tw = textWidth(base, s, size)
    let side = pos[1]
    if (mirror && i % 2 === 1 && side !== 'c') side = side === 'l' ? 'r' : 'l'
    const xd = side === 'l' ? margin : side === 'r' ? dw - margin - tw : dw / 2 - tw / 2
    const yd = pos[0] === 't' ? dh - margin - size * 0.72 : margin
    const [xu, yu, m] = stampPos(rot, xd, yd, w, hh)
    return {
      content: `\nq ${m.join(' ')} ${fmt(mb[0] + xu)} ${fmt(mb[1] + yu)} cm ${col} rg BT /PSNum ${fmt(size)} Tf 0 0 Td ${winStr(s)} Tj ET Q\n`,
      res: { Font: { PSNum: fontDict(base) } },
    }
  })
}

/**
 * Watermark every (selected) page with text or an image.
 * opts: text, size, font, bold, opacity, color, angle (deg, display space; negative ↗),
 * layout ('center'|'tile'), under (behind content), image ({jpeg}|{rgba,w,h}), imageScale (fraction of page width),
 * pages selector.
 */
export async function watermarkPdf(bytes, opts = {}) {
  const {
    text = 'CONFIDENTIAL', size = 48, font = 'helv', bold = true, opacity = 0.25, color = [0.62, 0.1, 0.1],
    angle = -45, layout = 'center', under = false, image = null, imageScale = 0.5, pages: sel = 'all',
  } = opts
  const base = stdFont(font, bold)
  const col = rgbOp(color) ?? '0.62 0.1 0.1'
  const th = (angle * Math.PI) / 180
  const R = [Math.cos(th), Math.sin(th), -Math.sin(th), Math.cos(th)]
  const tw = textWidth(base, text, size)
  let imRef = null, imDims = null, wanted = null
  return stampPages(bytes, async ({ i, total, mb, rot, w, hh, dw, dh, dst }) => {
    wanted ??= new Set(selectPages(sel, total))
    if (!wanted.has(i)) return null
    if (image && !imRef) {
      imRef = await imageXObject(dst, image)
      imDims = image.jpeg ? jpegInfo(image.jpeg) : { width: image.w, height: image.h }
    }
    const dispLin = rot === 90 ? [0, 1, 1, 0] : rot === 180 ? [-1, 0, 0, 1] : rot === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1]
    // after `wrap`, coordinates are display space (top-left origin, y down)
    const [xu0, yu0] = stampPos(rot, 0, dh, w, hh)
    const wrap = `${dispLin.join(' ')} ${fmt(mb[0] + xu0)} ${fmt(mb[1] + yu0)} cm`
    const centers = []
    if (layout === 'tile') {
      const stepX = Math.max(tw, size * 4) * 1.4, stepY = Math.max(size * 5, tw * 0.6)
      for (let y = stepY / 2; y < dh + stepY; y += stepY)
        for (let x = ((Math.round(y / stepY) % 2) * stepX) / 2; x < dw + stepX; x += stepX) centers.push([x, y])
    } else centers.push([dw / 2, dh / 2])
    const parts = []
    for (const [cx, cy] of centers) {
      // display space is y-down, so a negative angle tilts the baseline up-right (↗)
      const m = R
      if (imRef) {
        const iw = dw * imageScale, ih = (iw * imDims.height) / imDims.width
        parts.push(`q ${m.map(fmt).join(' ')} ${fmt(cx)} ${fmt(cy)} cm ${fmt(iw)} 0 0 ${fmt(-ih)} ${fmt(-iw / 2)} ${fmt(ih / 2)} cm /PSWmIm Do Q`)
      } else {
        // text needs y-up glyphs: flip back inside the rotated frame
        parts.push(`q ${m.map(fmt).join(' ')} ${fmt(cx)} ${fmt(cy)} cm 1 0 0 -1 0 0 cm BT /PSWm ${fmt(size)} Tf ${fmt(-tw / 2)} ${fmt(-size * 0.35)} Td ${winStr(text)} Tj ET Q`)
      }
    }
    const res = { ExtGState: { PSWmGS: new Map([['ca', opacity], ['CA', opacity]]) } }
    if (imRef) res.XObject = { PSWmIm: imRef }
    else res.Font = { PSWm: fontDict(base) }
    return {
      content: `\nq ${wrap} /PSWmGS gs ${col} rg ${parts.join(' ')} Q\n`,
      res,
      under,
    }
  })
}

const KAPPA = 0.5523

/** SVG-ish path segs (display space) → PDF path operators. */
function pathOps(segs) {
  return segs.map((s) => {
    if (s[0] === 'M') return `${fmt(s[1])} ${fmt(s[2])} m`
    if (s[0] === 'L') return `${fmt(s[1])} ${fmt(s[2])} l`
    if (s[0] === 'C') return `${fmt(s[1])} ${fmt(s[2])} ${fmt(s[3])} ${fmt(s[4])} ${fmt(s[5])} ${fmt(s[6])} c`
    if (s[0] === 'Z') return 'h'
    return ''
  }).join(' ')
}

/**
 * Bake editor annotations into pages as real PDF operators / annotations.
 * pagesAnnots[p] (0-based) = [{t, ...}] in DISPLAY-space pt (top-left origin, y down).
 *  stroke {pts,color,width} · vstroke {pts:[x,y,w]} · highlight {pts,color,width}
 *  line {x1,y1,x2,y2,color,width,arrow?,arrowStart?,dash?}
 *  rect/ellipse {x,y,w,h,stroke,fill,lw,dash?,radius?}
 *  path {segs:[['M',x,y],['L',x,y],['C',…],['Z']], stroke?, fill?, lw?}
 *  text {x,y,text,size,font,bold?,italic?,color,align?,w?,underline?,strike?,bg?,lineHeight?}
 *    x,y = top-left of the first line; baseline = y + size·0.8 (ascent); leading = size·lineHeight
 *  image {x,y,w,h, jpeg | rgba+iw+ih}
 *  note {x,y,text,color} → real /Text (sticky note) annotation
 *  link {x,y,w,h,url} → real /Link annotation
 * Every shape may carry alpha (0-1) and rot (radians, about its box centre).
 */
export async function annotatePdf(bytes, pagesAnnots) {
  return stampPages(bytes, async ({ i, mb, rot, w, hh, dh, dst }) => {
    const anns = pagesAnnots?.[i]
    if (!Array.isArray(anns) || !anns.length) return null
    const dispLin = rot === 90 ? [0, 1, 1, 0] : rot === 180 ? [-1, 0, 0, 1] : rot === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1]
    const [xu0, yu0] = stampPos(rot, 0, dh, w, hh)
    const wrap = `${dispLin.join(' ')} ${fmt(mb[0] + xu0)} ${fmt(mb[1] + yu0)} cm`
    // display (y-down) point → default user space, for annotation /Rect
    const toUser = (x, y) => {
      const [ux, uy] = stampPos(rot, x, dh - y, w, hh)
      return [mb[0] + ux, mb[1] + uy]
    }
    const res = {}
    const ops = []
    const annots = []
    let gsN = 0, imN = 0
    const gsFor = (alpha, multiply) => {
      const d = new Map([['ca', alpha], ['CA', alpha]])
      if (multiply) d.set('BM', name('Multiply'))
      const nm = `ANN_GS${++gsN}`
      ;(res.ExtGState ??= {})[nm] = d
      return `/${nm} gs`
    }
    const pt2 = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    const num = (v) => (Number.isFinite(v) ? fmt(v) : '0')
    for (const a of anns) {
      if (!a || typeof a !== 'object') continue
      const alpha = typeof a.alpha === 'number' ? Math.min(1, Math.max(0, a.alpha)) : null
      const color = rgbOp(a.color)
      const parts = []
      // optional rotation about the shape's centre
      let pre = ''
      if (a.rot && Number.isFinite(a.rot) && [a.x, a.y, a.w, a.h].every(Number.isFinite)) {
        const cx = a.x + a.w / 2, cy = a.y + a.h / 2
        const c = Math.cos(a.rot), s = Math.sin(a.rot)
        pre = `1 0 0 1 ${num(cx)} ${num(cy)} cm ${num(c)} ${num(s)} ${num(-s)} ${num(c)} 0 0 cm 1 0 0 1 ${num(-cx)} ${num(-cy)} cm`
      }
      const dashOp = Array.isArray(a.dash) && a.dash.length ? `[${a.dash.map(num).join(' ')}] 0 d` : ''
      switch (a.t) {
        case 'stroke':
        case 'highlight': {
          if (!color || !Array.isArray(a.pts) || a.pts.length < 1 || !a.pts.every(pt2)) break
          const w0 = a.t === 'highlight' ? (a.width ?? 12) : (a.width ?? 2)
          const path = a.pts.length === 1
            ? `${num(a.pts[0][0])} ${num(a.pts[0][1])} m ${num(a.pts[0][0] + 0.01)} ${num(a.pts[0][1])} l`
            : a.pts.map((p, k) => `${num(p[0])} ${num(p[1])} ${k ? 'l' : 'm'}`).join(' ')
          parts.push(`${color} RG ${num(w0)} w ${a.t === 'highlight' ? '0 J' : '1 J'} 1 j ${path} S`)
          break
        }
        case 'vstroke': {
          if (!color || !Array.isArray(a.pts) || a.pts.length < 1) break
          const segs = []
          for (let k = 0; k + 1 < a.pts.length; k++) {
            const [p, q] = [a.pts[k], a.pts[k + 1]]
            if (!pt2(p) || !pt2(q)) continue
            const sw = Math.min(60, Math.max(0.3, typeof p[2] === 'number' ? (p[2] + (q[2] ?? p[2])) / 2 : 1))
            segs.push(`${num(sw)} w ${num(p[0])} ${num(p[1])} m ${num(q[0])} ${num(q[1])} l S`)
          }
          if (!segs.length && a.pts.length === 1 && pt2(a.pts[0])) {
            const p = a.pts[0]
            const sw = Math.min(60, Math.max(0.3, typeof p[2] === 'number' ? p[2] : 1))
            segs.push(`${num(sw)} w ${num(p[0])} ${num(p[1])} m ${num(p[0] + 0.01)} ${num(p[1])} l S`)
          }
          if (!segs.length) break
          parts.push(`${color} RG 1 J 1 j ${segs.join(' ')}`)
          break
        }
        case 'line': {
          if (!color || ![a.x1, a.y1, a.x2, a.y2].every(Number.isFinite)) break
          const lw = typeof a.width === 'number' && a.width > 0 ? a.width : 2
          const head = (x1, y1, x2, y2) => {
            const ang = Math.atan2(y2 - y1, x2 - x1)
            const L = Math.min(60, Math.max(6, 3 * lw))
            const [bx, by] = [x2 - L * Math.cos(ang), y2 - L * Math.sin(ang)]
            const [px, py] = [-Math.sin(ang) * L * 0.45, Math.cos(ang) * L * 0.45]
            return `${color} rg ${num(x2)} ${num(y2)} m ${num(bx + px)} ${num(by + py)} l ${num(bx - px)} ${num(by - py)} l h f`
          }
          // shorten the shaft under arrowheads so the round cap doesn't poke through
          const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1)
          const L = Math.min(60, Math.max(6, 3 * lw)) * 0.6
          const ex = a.arrow ? a.x2 - L * Math.cos(ang) : a.x2, ey = a.arrow ? a.y2 - L * Math.sin(ang) : a.y2
          const sx = a.arrowStart ? a.x1 + L * Math.cos(ang) : a.x1, sy = a.arrowStart ? a.y1 + L * Math.sin(ang) : a.y1
          parts.push(`${color} RG ${num(lw)} w 1 J ${dashOp} ${num(sx)} ${num(sy)} m ${num(ex)} ${num(ey)} l S`)
          if (a.arrow) parts.push(head(a.x1, a.y1, a.x2, a.y2))
          if (a.arrowStart) parts.push(head(a.x2, a.y2, a.x1, a.y1))
          break
        }
        case 'rect':
        case 'ellipse': {
          if (![a.x, a.y, a.w, a.h].every(Number.isFinite)) break
          const fill = rgbOp(a.fill), strokeC = rgbOp(a.stroke)
          if (!fill && !strokeC) break
          const lw = typeof a.lw === 'number' && a.lw > 0 ? a.lw : 1
          let path
          if (a.t === 'rect' && a.radius > 0) {
            const r = Math.min(a.radius, a.w / 2, a.h / 2), k = r * (1 - KAPPA)
            const [x0, y0, x1, y1] = [a.x, a.y, a.x + a.w, a.y + a.h]
            path = `${num(x0 + r)} ${num(y0)} m ${num(x1 - r)} ${num(y0)} l ${num(x1 - k)} ${num(y0)} ${num(x1)} ${num(y0 + k)} ${num(x1)} ${num(y0 + r)} c ` +
              `${num(x1)} ${num(y1 - r)} l ${num(x1)} ${num(y1 - k)} ${num(x1 - k)} ${num(y1)} ${num(x1 - r)} ${num(y1)} c ` +
              `${num(x0 + r)} ${num(y1)} l ${num(x0 + k)} ${num(y1)} ${num(x0)} ${num(y1 - k)} ${num(x0)} ${num(y1 - r)} c ` +
              `${num(x0)} ${num(y0 + r)} l ${num(x0)} ${num(y0 + k)} ${num(x0 + k)} ${num(y0)} ${num(x0 + r)} ${num(y0)} c h`
          } else if (a.t === 'rect') {
            path = `${num(a.x)} ${num(a.y)} ${num(a.w)} ${num(a.h)} re`
          } else {
            const [cx, cy, rx, ry, k] = [a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, KAPPA]
            path =
              `${num(cx + rx)} ${num(cy)} m ` +
              `${num(cx + rx)} ${num(cy - k * ry)} ${num(cx + k * rx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c ` +
              `${num(cx - k * rx)} ${num(cy - ry)} ${num(cx - rx)} ${num(cy - k * ry)} ${num(cx - rx)} ${num(cy)} c ` +
              `${num(cx - rx)} ${num(cy + k * ry)} ${num(cx - k * rx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c ` +
              `${num(cx + k * rx)} ${num(cy + ry)} ${num(cx + rx)} ${num(cy + k * ry)} ${num(cx + rx)} ${num(cy)} c h`
          }
          const paint = fill && strokeC ? 'B' : fill ? 'f' : 'S'
          parts.push(`${fill ? `${fill} rg ` : ''}${strokeC ? `${strokeC} RG ` : ''}${num(lw)} w ${dashOp} ${path} ${paint}`)
          break
        }
        case 'path': {
          if (!Array.isArray(a.segs) || !a.segs.length) break
          const fill = rgbOp(a.fill), strokeC = rgbOp(a.stroke ?? a.color)
          if (!fill && !strokeC) break
          const lw = typeof a.lw === 'number' && a.lw > 0 ? a.lw : 1.5
          const paint = fill && strokeC ? 'B' : fill ? 'f' : 'S'
          parts.push(`${fill ? `${fill} rg ` : ''}${strokeC ? `${strokeC} RG ` : ''}${num(lw)} w 1 J 1 j ${pathOps(a.segs)} ${paint}`)
          break
        }
        case 'text': {
          const size = typeof a.size === 'number' && a.size > 0 ? a.size : null
          if (!color || !size || typeof a.text !== 'string' || !a.text.length || ![a.x, a.y].every(Number.isFinite)) break
          const base = stdFont(a.font, !!a.bold, !!a.italic)
          const fname = `ANN_${base.replace(/[^A-Za-z]/g, '')}`
          ;(res.Font ??= {})[fname] = fontDict(base)
          const lead = size * (a.lineHeight ?? 1.2)
          const lines = a.text.split('\n')
          const widths = lines.map((l) => textWidth(base, l, size))
          const boxW = Number.isFinite(a.w) && a.w > 0 ? a.w : Math.max(...widths)
          if (a.bg) {
            const bg = rgbOp(a.bg)
            if (bg) parts.push(`${bg} rg ${num(a.x - 2)} ${num(a.y - 1)} ${num(boxW + 4)} ${num(lines.length * lead + 2)} re f`)
          }
          lines.forEach((line, li) => {
            const lx = a.align === 'center' ? a.x + (boxW - widths[li]) / 2 : a.align === 'right' ? a.x + boxW - widths[li] : a.x
            const by = a.y + size * 0.8 + li * lead // baseline (ascent ≈ 0.8em for the standard fonts)
            // glyphs need y-up: local flip at the baseline
            if (line.length) parts.push(`${color} rg BT /${fname} ${num(size)} Tf 1 0 0 -1 ${num(lx)} ${num(by)} Tm ${winStr(line)} Tj ET`)
            const deco = []
            if (a.underline) deco.push(by + size * 0.12)
            if (a.strike) deco.push(by - size * 0.28)
            for (const yy of deco) parts.push(`${color} RG ${num(Math.max(0.5, size / 16))} w ${num(lx)} ${num(yy)} m ${num(lx + widths[li])} ${num(yy)} l S`)
          })
          break
        }
        case 'image': {
          if (![a.x, a.y, a.w, a.h].every(Number.isFinite)) break
          let r
          try {
            if (a.jpeg instanceof Uint8Array) r = await imageXObject(dst, { jpeg: a.jpeg })
            else if (a.rgba && a.iw && a.ih) r = await imageXObject(dst, { rgba: a.rgba, w: a.iw, h: a.ih })
            else break
          } catch { break }
          const nm = `ANN_Im${++imN}`
          ;(res.XObject ??= {})[nm] = r
          parts.push(`${num(a.w)} 0 0 ${num(-a.h)} ${num(a.x)} ${num(a.y + a.h)} cm /${nm} Do`)
          break
        }
        case 'note': {
          if (![a.x, a.y].every(Number.isFinite)) break
          const [ux, uy] = toUser(a.x, a.y)
          const c = rgbOp(a.color ?? '#ffd43b')?.split(' ').map(Number) ?? [1, 0.83, 0.23]
          annots.push(new Map([
            ['Type', name('Annot')], ['Subtype', name('Text')], ['Rect', [fmt(ux), fmt(uy - 20), fmt(ux + 20), fmt(uy)]],
            ['Contents', textString(String(a.text ?? ''))], ['Name', name('Comment')], ['C', c], ['F', 4],
            ['T', textString(a.author || 'PDFSuite')], ['Open', false],
          ]))
          break
        }
        case 'link': {
          if (![a.x, a.y, a.w, a.h].every(Number.isFinite) || typeof a.url !== 'string' || !a.url) break
          const [x1, y1] = toUser(a.x, a.y), [x2, y2] = toUser(a.x + a.w, a.y + a.h)
          const url = /^[a-z][a-z0-9+.-]*:/i.test(a.url) ? a.url : `https://${a.url}`
          annots.push(new Map([
            ['Type', name('Annot')], ['Subtype', name('Link')],
            ['Rect', [fmt(Math.min(x1, x2)), fmt(Math.min(y1, y2)), fmt(Math.max(x1, x2)), fmt(Math.max(y1, y2))]],
            ['Border', [0, 0, 0]], ['F', 4],
            ['A', new Map([['S', name('URI')], ['URI', { k: 's', bytes: enc(url) }]])],
          ]))
          break
        }
      }
      if (parts.length) {
        const needsGs = a.t === 'highlight' || (alpha !== null && alpha < 1)
        const gs = needsGs ? gsFor(alpha ?? 0.35, a.t === 'highlight') : ''
        ops.push(`q ${wrap} ${[pre, gs, ...parts].filter(Boolean).join(' ')} Q`)
      }
    }
    // leading \n keeps our first op from fusing with the previous stream's last token
    return ops.length || annots.length ? { content: ops.length ? '\n' + ops.join('\n') + '\n' : '', res, annots } : null
  })
}
