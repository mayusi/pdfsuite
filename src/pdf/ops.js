import { dec, get, isHex, isName, isRef, isStream, isStr, name, ref, set, stream, typeIs } from './types.js'
import { deref, parsePdf } from './parse.js'
import { newDoc, writeDoc } from './write.js'
import { inflate } from './env.js'
import { pngEncode } from '../png.js'

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

/** Walk the page tree → ordered leaves with resolved inherited attributes. */
export function pageLeaves(doc) {
  const root = deref(doc, get(doc.trailer, 'Root'))
  const catalog = isStream(root) ? root.dict : root
  const pagesRef = get(catalog, 'Pages')
  if (!isRef(pagesRef)) throw new Error('no /Pages in catalog')
  const leaves = []
  const seen = new Set()

  const walk = (nodeRef, inh) => {
    const key = nodeRef.n + ' ' + nodeRef.g
    if (seen.has(key)) return
    seen.add(key)
    const node = deref(doc, nodeRef)
    const dict = isStream(node) ? node.dict : node
    if (!(dict instanceof Map)) return
    const cur = { ...inh }
    for (const k of INHERITED) {
      const v = get(dict, k)
      if (v !== undefined) cur[k] = v
    }
    if (typeIs(dict, 'Page')) leaves.push({ ref: nodeRef, dict, inh: cur })
    else {
      const kidsArr = deref(doc, get(dict, 'Kids'))
      if (Array.isArray(kidsArr)) for (const kid of kidsArr) if (isRef(kid)) walk(kid, cur)
    }
  }
  walk(pagesRef, {})
  if (!leaves.length) throw new Error('PDF has no pages')
  return leaves
}

export async function pageCount(bytes) {
  return pageLeaves(await parsePdf(bytes)).length
}

/** Per-page geometry for UI pickers: [{w, h, rotate}] — MediaBox + inherited Rotate. */
export function pageDims(doc) {
  return pageLeaves(doc).map((leaf) => {
    let mb = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox
    if (isRef(mb)) mb = deref(doc, mb)
    if (!Array.isArray(mb)) mb = [0, 0, 612, 792]
    const rot = get(leaf.dict, 'Rotate') ?? leaf.inh.Rotate ?? 0
    return { w: Math.round(mb[2] - mb[0]), h: Math.round(mb[3] - mb[1]), rotate: typeof rot === 'number' ? rot : 0 }
  })
}

const textVal = (v) => {
  if (isStr(v) || isHex(v)) {
    const b = v.bytes
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
    return dec(b).replace(/\x00+$/, '')
  }
  if (isName(v)) return '/' + v.v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/**
 * What the file says about you: /Info fields, XMP presence, doc ID presence.
 * Drives the Scrub tool's "here's what's leaking" preview.
 */
export async function readMetadata(bytes) {
  const doc = await parsePdf(bytes)
  const out = { fields: [], xmp: false, id: false }
  const infoRaw = get(doc.trailer, 'Info')
  const info = isRef(infoRaw) ? deref(doc, infoRaw) : infoRaw
  if (info instanceof Map) {
    for (const [k, v] of info) {
      const s = textVal(isRef(v) ? deref(doc, v) : v)
      if (s) out.fields.push({ key: k, value: s })
    }
  }
  const root = deref(doc, get(doc.trailer, 'Root'))
  const catalog = isStream(root) ? root.dict : root
  if (get(catalog, 'Metadata') !== undefined) out.xmp = true
  if (get(doc.trailer, 'ID') !== undefined) out.id = true
  return out
}

/** Deep-copy a value across docs, remapping refs. */
function copyValue(v, src, dst, refMap) {
  if (isRef(v)) {
    const key = `${v.n} ${v.g}`
    if (refMap.has(key)) return refMap.get(key)
    const newNum = dst.alloc()
    const out = ref(newNum, 0)
    refMap.set(key, out)
    const srcVal = src.objects.get(key)?.v
    if (srcVal === undefined) return null // dangling ref → drop it
    dst.set(newNum, copyValue(srcVal, src, dst, refMap))
    return out
  }
  if (v instanceof Map) {
    const m = new Map()
    for (const [k, val] of v) m.set(k, copyValue(val, src, dst, refMap))
    return m
  }
  if (Array.isArray(v)) return v.map((x) => copyValue(x, src, dst, refMap))
  if (isStream(v)) return stream(copyValue(v.dict, src, dst, refMap), v.data.slice())
  return v
}

/**
 * Append selected pages of `srcDoc` into `dst` under `pagesRef`.
 * `picks` = [{leaf, rotateDelta}] — leaves already walked (source order preserved by caller).
 * `strip` names extra page-dict keys to drop (privacy scrubbing).
 */
function appendPages(srcDoc, picks, dst, pagesRef, kids, strip = []) {
  const refMap = new Map()
  for (const { leaf, rotateDelta } of picks) {
    const num = dst.alloc()
    kids.push(ref(num, 0))
    const pageDict = new Map()
    for (const k of INHERITED) {
      const v = get(leaf.dict, k) ?? leaf.inh[k]
      if (v !== undefined) pageDict.set(k, copyValue(v, srcDoc, dst, refMap))
    }
    for (const [k, val] of leaf.dict) {
      if (k === 'Parent' || k === 'Metadata' || INHERITED.includes(k) || strip.includes(k)) continue
      pageDict.set(k, copyValue(val, srcDoc, dst, refMap))
    }
    pageDict.set('Type', name('Page'))
    pageDict.set('Parent', ref(pagesRef, 0))
    if (rotateDelta) {
      const cur = get(pageDict, 'Rotate')
      const base = typeof cur === 'number' ? cur : 0
      pageDict.set('Rotate', ((base + rotateDelta) % 360 + 360) % 360)
    }
    dst.set(num, pageDict)
  }
}

function finishDoc(dst, pagesRef, kids) {
  dst.set(pagesRef, new Map([
    ['Type', name('Pages')],
    ['Kids', kids],
    ['Count', kids.length],
  ]))
  const catNum = dst.alloc()
  dst.set(catNum, new Map([
    ['Type', name('Catalog')],
    ['Pages', ref(pagesRef, 0)],
  ]))
  return writeDoc(dst, catNum)
}

/** Merge several PDFs (Uint8Array[]) into one, in order. */
export async function mergePdfs(inputs) {
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  for (const bytes of inputs) {
    const doc = await parsePdf(bytes)
    appendPages(doc, pageLeaves(doc).map((leaf) => ({ leaf, rotateDelta: 0 })), dst, pagesRef, kids)
  }
  return finishDoc(dst, pagesRef, kids)
}

/**
 * Rebuild a PDF from an ordered op list (1-based source pages):
 * reorder by list order, delete by omission, rotate via `rotation` delta.
 */
export async function organizePages(bytes, ops) {
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  const picks = ops.map((o) => {
    if (o.page < 1 || o.page > leaves.length) throw new Error(`page ${o.page} out of range`)
    return { leaf: leaves[o.page - 1], rotateDelta: o.rotation || 0 }
  })
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  appendPages(src, picks, dst, pagesRef, kids)
  return finishDoc(dst, pagesRef, kids)
}

/** Extract page ranges (1-based inclusive {from,to}) into a single PDF. */
export async function extractPages(bytes, ranges) {
  const ops = ranges.flatMap(({ from, to }) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ page: from + i, rotation: 0 })),
  )
  return organizePages(bytes, ops)
}

/** One output PDF per range. */
export async function splitPdf(bytes, ranges) {
  return Promise.all(ranges.map((r) => extractPages(bytes, [r])))
}

/** Parse "1-3, 5, 8-10" into {from,to}[] with bounds checking. */
export function parseRanges(spec, maxPage) {
  const ranges = []
  for (const part of spec.split(',')) {
    const t = part.trim()
    if (!t) continue
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t)
    if (!m) throw new Error(`bad range "${t}"`)
    const from = parseInt(m[1], 10)
    const to = m[2] ? parseInt(m[2], 10) : from
    if (from < 1 || to > maxPage || from > to) throw new Error(`range "${t}" out of bounds`)
    ranges.push({ from, to })
  }
  if (!ranges.length) throw new Error('no ranges given')
  return ranges
}

// ---------- images → pdf ----------

/** Read dimensions/colorspace from a JPEG's SOF marker. */
export function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG')
  let i = 2
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if (marker === 0xda) break // SOS — image data
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = (buf[i + 5] << 8) | buf[i + 6]
      const width = (buf[i + 7] << 8) | buf[i + 8]
      const comps = buf[i + 9]
      const cs = comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB'
      return { width, height, colorSpace: cs }
    }
    i += 2 + len
  }
  throw new Error('JPEG SOF marker not found')
}

/** Pack JPEG images into a PDF — one image per page at native size. */
export function imagesToPdf(images) {
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  for (const img of images) {
    const { width, height, colorSpace } = jpegInfo(img.data)
    const imgNum = dst.alloc()
    dst.set(imgNum, stream(new Map([
      ['Type', name('XObject')],
      ['Subtype', name('Image')],
      ['Width', width],
      ['Height', height],
      ['ColorSpace', name(colorSpace)],
      ['BitsPerComponent', 8],
      ['Filter', name('DCTDecode')],
      ['Length', img.data.length],
    ]), img.data))
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), new TextEncoder().encode(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`)))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')],
      ['Parent', ref(pagesRef, 0)],
      ['MediaBox', [0, 0, width, height]],
      ['Resources', new Map([['XObject', new Map([['Im0', ref(imgNum, 0)]])]])],
      ['Contents', ref(csNum, 0)],
    ]))
    kids.push(ref(pageNum, 0))
  }
  return finishDoc(dst, pagesRef, kids)
}

// ---------- page numbers ----------

/** Escape a JS string into PDF literal-string bytes (ASCII only). */
const pdfStr = (s) => '(' + s.replace(/[\\()]/g, (c) => '\\' + c) + ')'

/**
 * Stamp a label on every page.
 * opts: pos 'tl'|'tc'|'tr'|'bl'|'bc'|'br' (default 'bc'),
 *       fmt 'n'|'n-of-total'|'page-n' (default 'n-of-total'),
 *       start (number shown on first stamped page, default 1),
 *       skipFirst (don't stamp page 1), size (pt, default 10), margin (pt, default 18).
 * Appends a content stream ON TOP of existing content and injects a
 * Helvetica base-14 font under an unlikely-colliding resource name.
 */
export async function addPageNumbers(bytes, opts = {}) {
  const { pos = 'bc', fmt = 'n-of-total', start = 1, skipFirst = false, size = 10, margin = 18 } = opts
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  const total = leaves.length
  const fontResName = 'PDFFnt1'

  const labelFor = (i) => {
    const n = i + start
    if (fmt === 'n') return String(n)
    if (fmt === 'page-n') return `Page ${n}`
    return `${n} / ${total}`
  }

  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const refMap = new Map()

  for (let i = 0; i < leaves.length; i++) {
    const { leaf } = { leaf: leaves[i] }
    const num = dst.alloc()
    kids.push(ref(num, 0))
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

    if (i === 0 && skipFirst) {
      dst.set(num, pageDict)
      continue
    }

    // label position is chosen in DISPLAY space (what the user sees), then
    // mapped back into the page's user space honouring /Rotate.
    const mbSrc = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox
    const mbResolved = isRef(mbSrc) ? deref(src, mbSrc) : mbSrc
    const mb = Array.isArray(mbResolved) ? mbResolved : [0, 0, 612, 792]
    const rotSrc = get(leaf.dict, 'Rotate') ?? leaf.inh.Rotate ?? 0
    const rot = typeof rotSrc === 'number' ? ((rotSrc % 360) + 360) % 360 : 0
    const w = mb[2] - mb[0]
    const hh = mb[3] - mb[1]
    const dw = rot % 180 === 0 ? w : hh
    const dh = rot % 180 === 0 ? hh : w
    const label = labelFor(i)
    const charW = size * 0.5 // ~half-em advance for Helvetica digits
    const xd = pos.endsWith('l') ? margin
      : pos.endsWith('r') ? dw - margin - label.length * charW
      : dw / 2 - (label.length * charW) / 2
    const yd = pos.startsWith('t') ? dh - margin - size * 0.72 : margin
    // display (xd,yd) → user (xu,yu) for each quarter-turn, then counter-rotate
    // the text matrix so the label reads upright on the displayed page.
    const [xu, yu, m] =
      rot === 90 ? [w - yd, xd, [0, 1, -1, 0]]
      : rot === 180 ? [w - xd, hh - yd, [-1, 0, 0, -1]]
      : rot === 270 ? [yd, hh - xd, [0, -1, 1, 0]]
      : [xd, yd, [1, 0, 0, 1]]
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), new TextEncoder().encode(
      `q ${m[0]} ${m[1]} ${m[2]} ${m[3]} ${(mb[0] + xu).toFixed(1)} ${(mb[1] + yu).toFixed(1)} cm ` +
      `BT /${fontResName} ${size} Tf 0 g 0 0 Td ${pdfStr(label)} Tj ET Q`,
    )))

    // contents = existing contents + ours last (draws on top)
    const contents = pageDict.get('Contents')
    const arr = Array.isArray(contents) ? contents.slice() : contents !== undefined ? [contents] : []
    arr.push(ref(csNum, 0))
    pageDict.set('Contents', arr.length === 1 ? arr[0] : arr)

    // resources: pageDict already holds dst-space copies/refs — resolve any
    // indirect /Resources or /Font against dst.objects, never against src.
    let res = pageDict.get('Resources')
    if (isRef(res)) res = dst.objects.get(res.n)
    if (!(res instanceof Map)) res = new Map()
    let fonts = res.get('Font')
    if (isRef(fonts)) fonts = dst.objects.get(fonts.n)
    if (!(fonts instanceof Map)) fonts = new Map()
    if (!fonts.has(fontResName)) {
      fonts.set(fontResName, new Map([
        ['Type', name('Font')],
        ['Subtype', name('Type1')],
        ['BaseFont', name('Helvetica')],
      ]))
      res.set('Font', fonts)
    }
    pageDict.set('Resources', res)
    dst.set(num, pageDict)
  }
  return finishDoc(dst, pagesRef, kids)
}

/**
 * Rebuild dropping /Info, XMP /Metadata, doc IDs, per-page annotations (author
 * names, comments, popup threads) and /PieceInfo — tracker scrub.
 */
export async function scrubPdf(bytes) {
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  appendPages(src, leaves.map((leaf) => ({ leaf, rotateDelta: 0 })), dst, pagesRef, kids, [
    'Annots',
    'PieceInfo',
  ])
  return finishDoc(dst, pagesRef, kids)
}

// ---------- extract images ----------

/** Undo PNG/TIFF predictors on inflated image data (DecodeParms). */
export function unPredict(data, { predictor = 1, columns = 1, colors = 1, bpc = 8 }) {
  if (predictor === 1) return data
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowBytes = Math.ceil((columns * colors * bpc) / 8)
  if (predictor === 2) {
    const out = new Uint8Array(data.length)
    for (let y = 0; y * rowBytes < data.length; y++) {
      const row = y * rowBytes
      for (let x = 0; x < rowBytes; x++) {
        const left = x >= bpp ? out[row + x - bpp] : 0
        out[row + x] = (data[row + x] + left) & 0xff
      }
    }
    return out
  }
  if (predictor < 10 || predictor > 15) throw new Error(`unsupported predictor ${predictor}`)
  const hasFilterByte = predictor >= 10
  const rowStride = rowBytes + (hasFilterByte ? 1 : 0)
  const rows = Math.floor(data.length / rowStride)
  const out = new Uint8Array(rows * rowBytes)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < rows; y++) {
    const src = y * rowStride + (hasFilterByte ? 1 : 0)
    const f = hasFilterByte ? data[y * rowStride] : 1 // Optimum → sub? spec: treated as per-row
    const prev = y > 0 ? (y - 1) * rowBytes : -1
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[y * rowBytes + x - bpp] : 0
      const b = prev >= 0 ? out[prev + x] : 0
      const c = x >= bpp && prev >= 0 ? out[prev + x - bpp] : 0
      let v = data[src + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) v += paeth(a, b, c)
      out[y * rowBytes + x] = v & 0xff
    }
  }
  return out
}

/**
 * Pull embedded images out of a PDF.
 * Returns { images: [{name, data, w, h}], skipped } — DCTDecode→.jpg,
 * JPXDecode→.jp2, FlateDecode raw RGB/gray 8-bit→.png, else counted in skipped.
 */
export async function extractImages(bytes) {
  const doc = await parsePdf(bytes)
  const images = []
  let skipped = 0
  let i = 0
  for (const { v } of doc.objects.values()) {
    if (!isStream(v) || get(v.dict, 'Subtype')?.v !== 'Image') continue
    i++
    const w = get(v.dict, 'Width') ?? 0
    const h = get(v.dict, 'Height') ?? 0
    const filterVal = get(v.dict, 'Filter')
    const chain = (Array.isArray(filterVal) ? filterVal : filterVal === undefined ? [] : [filterVal]).map(
      (fl) => (isName(fl) ? fl.v : null),
    )
    const stem = `image-${i}-${w}x${h}`
    const codec = { DCTDecode: ['.jpg', 'image/jpeg'], DCT: ['.jpg', 'image/jpeg'], JPXDecode: ['.jp2', 'image/jp2'], JPX: ['.jp2', 'image/jp2'] }
    try {
      const last = chain.length ? chain[chain.length - 1] : null
      const out = last ? codec[last] : undefined
      // Every filter except a trailing image codec is a compression layer to
      // unwrap in listed order (e.g. [/FlateDecode /DCTDecode] = flate(jpeg)).
      const decodeChain = out ? chain.slice(0, -1) : chain
      let data = v.data
      for (const fl of decodeChain) {
        if (fl === 'FlateDecode' || fl === 'Fl') data = await inflate(data)
        else throw new Error(`unsupported filter ${fl}`)
      }
      if (out) {
        images.push({ name: `${stem}${out[0]}`, data, w, h, mime: out[1] })
      } else if (decodeChain.every((fl) => fl === 'FlateDecode' || fl === 'Fl' || fl === null)) {
        const bpc = get(v.dict, 'BitsPerComponent') ?? 8
        let cs = get(v.dict, 'ColorSpace')
        if (isRef(cs)) cs = deref(doc, cs)
        const csName = isName(cs) ? cs.v : Array.isArray(cs) && isName(cs[0]) ? cs[0].v : null
        if (bpc !== 8 || (csName !== 'DeviceRGB' && csName !== 'DeviceGray')) { skipped++; continue }
        const colors = csName === 'DeviceRGB' ? 3 : 1
        let dp = get(v.dict, 'DecodeParms') ?? get(v.dict, 'DP')
        if (Array.isArray(dp)) dp = [...dp].reverse().find((x) => x instanceof Map)
        const parms = dp instanceof Map ? {
          predictor: get(dp, 'Predictor') ?? 1,
          columns: get(dp, 'Columns') ?? w,
          colors: get(dp, 'Colors') ?? colors,
          bpc: get(dp, 'BitsPerComponent') ?? 8,
        } : { predictor: 1, columns: w, colors, bpc: 8 }
        const raw = unPredict(data, parms)
        if (raw.length !== w * h * colors) { skipped++; continue }
        images.push({ name: `${stem}.png`, data: pngEncode(w, h, raw, colors === 1), w, h, mime: 'image/png' })
      } else {
        skipped++
      }
    } catch { skipped++ }
  }
  return { images, skipped }
}
