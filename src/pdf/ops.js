import { concat, dec, enc, get, isHex, isName, isRef, isStream, isStr, name, ref, set, stream, typeIs } from './types.js'
import { deref, parsePdf, parseValue } from './parse.js'
import { newDoc, writeDoc } from './write.js'
import { deflate } from './env.js'
import { pngEncode } from '../png.js'
import { crc32 } from '../zip.js'
import { decodeChain } from './filters.js'
import { decodeImage } from './image.js'
import { simpleEncodingTable } from './encodings.js'

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
    if (srcVal === undefined) {
      refMap.delete(key) // don't leave a pointer to an object that never gets written
      return null
    }
    dst.set(newNum, isStream(srcVal)
      ? stream(copyValue(srcVal.dict, src, dst, refMap), srcVal.data.slice())
      : copyValue(srcVal, src, dst, refMap))
    return out
  }
  if (v instanceof Map) {
    const m = new Map()
    for (const [k, val] of v) m.set(k, copyValue(val, src, dst, refMap))
    return m
  }
  if (Array.isArray(v)) return v.map((x) => copyValue(x, src, dst, refMap))
  if (isStream(v)) {
    // streams are only valid as indirect objects — re-home direct ones
    const num = dst.alloc()
    dst.set(num, stream(copyValue(v.dict, src, dst, refMap), v.data.slice()))
    return ref(num, 0)
  }
  return v
}

/**
 * Append selected pages of `srcDoc` into `dst` under `pagesRef`.
 * `picks` = [{leaf, rotateDelta}] — leaves already walked (source order preserved by caller).
 * `strip` names extra page-dict keys to drop (privacy scrubbing).
 */
function appendPages(srcDoc, picks, dst, pagesRef, kids, strip = [], refMap = new Map()) {
  // pre-register every leaf ref first: a page dict referencing a LATER page
  // (annotation /P, named dests inside dicts) must remap onto the real copy —
  // a refMap miss would deep-copy an orphan page object outside the tree
  const nums = picks.map(({ leaf }) => {
    const num = dst.alloc()
    kids.push(ref(num, 0))
    if (isRef(leaf.ref)) refMap.set(`${leaf.ref.n} ${leaf.ref.g}`, ref(num, 0))
    return num
  })
  for (const [pi, { leaf, rotateDelta }] of picks.entries()) {
    const num = nums[pi]
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

// catalog keys that survive whole-document rebuilds (remapped via refMap)
const CATALOG_EXTRAS = [
  'Outlines', 'Names', 'AcroForm', 'PageLabels', 'PageMode', 'OpenAction',
  'ViewerPreferences', 'MarkInfo', 'Lang', 'Metadata', 'StructTreeRoot', 'URI',
]

/**
 * Build the Pages node + catalog (with extras preserved when srcDoc/refMap
 * are given) → {catNum, trailer}. Kept separate from writeDoc so callers can
 * mutate copied objects (recompression) after extras are pulled in.
 */
function buildCatalog(dst, pagesRef, kids, srcDoc, refMap) {
  dst.set(pagesRef, new Map([
    ['Type', name('Pages')],
    ['Kids', kids],
    ['Count', kids.length],
  ]))
  const catNum = dst.alloc()
  const catDict = new Map([
    ['Type', name('Catalog')],
    ['Pages', ref(pagesRef, 0)],
  ])
  const trailer = new Map()
  if (srcDoc && refMap) {
    const srcRoot = deref(srcDoc, get(srcDoc.trailer, 'Root'))
    const srcCat = isStream(srcRoot) ? srcRoot.dict : srcRoot
    for (const k of CATALOG_EXTRAS) {
      const v = get(srcCat, k)
      if (v !== undefined) catDict.set(k, copyValue(v, srcDoc, dst, refMap))
    }
    const info = get(srcDoc.trailer, 'Info')
    if (info) {
      const iv = copyValue(info, srcDoc, dst, refMap)
      if (iv !== null && iv !== undefined) trailer.set('Info', iv)
    }
    const srcId = get(srcDoc.trailer, 'ID')
    if (Array.isArray(srcId)) {
      trailer.set('ID', srcId.map((x) =>
        x?.bytes ? { k: 'x', bytes: x.bytes.slice() } : copyValue(x, srcDoc, dst, refMap)))
    }
  }
  dst.set(catNum, catDict)
  return { catNum, trailer }
}

function finishDoc(dst, pagesRef, kids, srcDoc, refMap) {
  const { catNum, trailer } = buildCatalog(dst, pagesRef, kids, srcDoc, refMap)
  return writeDoc(dst, catNum, trailer)
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
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] }

/**
 * Wrap jpeg images into a one-page-each PDF.
 * opts: size 'native'|'a4'|'letter', orient 'auto'|'portrait'|'landscape',
 *       margin (pt), fit 'contain'|'stretch'.
 */
export function imagesToPdf(images, opts = {}) {
  const { size = 'native', orient = 'auto', margin = 0, fit = 'contain' } = opts
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

    let pw, ph
    if (size === 'native') {
      pw = width + margin * 2
      ph = height + margin * 2
    } else {
      let [bw, bh] = PAGE_SIZES[size] ?? PAGE_SIZES.a4
      const landscape = orient === 'landscape' || (orient === 'auto' && width > height)
      ;[pw, ph] = landscape ? [Math.max(bw, bh), Math.min(bw, bh)] : [Math.min(bw, bh), Math.max(bw, bh)]
    }
    const cw = Math.max(1, pw - margin * 2)
    const ch = Math.max(1, ph - margin * 2)
    let dw, dh
    if (fit === 'stretch') { dw = cw; dh = ch }
    else { const s = Math.min(cw / width, ch / height); dw = width * s; dh = height * s }
    const x = (pw - dw) / 2
    const y = (ph - dh) / 2

    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), new TextEncoder().encode(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`)))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')],
      ['Parent', ref(pagesRef, 0)],
      ['MediaBox', [0, 0, pw, ph]],
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
 *       skipFirst (don't stamp page 1), size (pt, default 10), margin (pt, default 18),
 *       fmt 'custom' uses fmtStr with {n} = page number, {t} = total.
 * Appends a content stream ON TOP of existing content and injects a
 * Helvetica base-14 font under an unlikely-colliding resource name.
 */
/** Display→user position map + counter-rotation matrix for /Rotate'd pages. */
function stampPos(rot, xd, yd, w, hh) {
  return rot === 90 ? [w - yd, xd, [0, 1, -1, 0]]
    : rot === 180 ? [w - xd, hh - yd, [-1, 0, 0, -1]]
    : rot === 270 ? [yd, hh - xd, [0, -1, 1, 0]]
    : [xd, yd, [1, 0, 0, 1]]
}

const HELVETICA = new Map([
  ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')],
])

/**
 * Rebuild `bytes` stamping a generated content stream on each page.
 * stampFor(ctx) → {content: string, res?: {Font?, ExtGState?}} | null.
 * ctx = {leaf, i, total, mb, rot, w, hh, dw, dh} — dw/dh are display-space dims.
 */
async function stampPages(bytes, stampFor) {
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const refMap = new Map()

  // pre-register every leaf ref so forward page refs remap to real copies
  const nums = leaves.map((leaf) => {
    const num = dst.alloc()
    kids.push(ref(num, 0))
    if (isRef(leaf.ref)) refMap.set(`${leaf.ref.n} ${leaf.ref.g}`, ref(num, 0))
    return num
  })

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]
    const num = nums[i]
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

    const mbSrc = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox
    const mbResolved = isRef(mbSrc) ? deref(src, mbSrc) : mbSrc
    const mb = Array.isArray(mbResolved) ? mbResolved : [0, 0, 612, 792]
    const rotSrc = get(leaf.dict, 'Rotate') ?? leaf.inh.Rotate ?? 0
    const rot = typeof rotSrc === 'number' ? ((rotSrc % 360) + 360) % 360 : 0
    const w = mb[2] - mb[0]
    const hh = mb[3] - mb[1]
    const dw = rot % 180 === 0 ? w : hh
    const dh = rot % 180 === 0 ? hh : w

    const stamp = stampFor({ leaf, i, total: leaves.length, mb, rot, w, hh, dw, dh, dst })
    if (stamp) {
      const csNum = dst.alloc()
      dst.set(csNum, stream(new Map(), new TextEncoder().encode(stamp.content)))
      let contents = pageDict.get('Contents')
      if (isRef(contents)) { // qpdf-style: Contents is a ref TO an array of stream refs
        const c = dst.objects.get(contents.n)
        if (Array.isArray(c)) contents = c
      }
      const arr = Array.isArray(contents) ? contents.slice() : contents !== undefined ? [contents] : []
      arr.push(ref(csNum, 0))
      pageDict.set('Contents', arr.length === 1 ? arr[0] : arr)

      let res = pageDict.get('Resources')
      if (isRef(res)) res = dst.objects.get(res.n)
      // clone before mutating: an inherited/shared Resources dict is one copied
      // Map reachable from every page — in-place adds would leak across pages
      res = res instanceof Map ? new Map(res) : new Map()
      for (const [section, entries] of Object.entries(stamp.res ?? {})) {
        let sec = res.get(section)
        if (isRef(sec)) sec = dst.objects.get(sec.n)
        sec = sec instanceof Map ? new Map(sec) : new Map()
        for (const [nm, val] of Object.entries(entries)) if (!sec.has(nm)) sec.set(nm, val)
        res.set(section, sec)
      }
      pageDict.set('Resources', res)
    }
    dst.set(num, pageDict)
  }
  return finishDoc(dst, pagesRef, kids, src, refMap)
}

export async function addPageNumbers(bytes, opts = {}) {
  const { pos = 'bc', fmt = 'n-of-total', fmtStr = '{n}', start = 1, skipFirst = false, size = 10, margin = 18 } = opts
  const labelFor = (i, total) => {
    const n = i + start
    if (fmt === 'custom') return (fmtStr || '{n}').replaceAll('{n}', String(n)).replaceAll('{t}', String(total))
    if (fmt === 'n') return String(n)
    if (fmt === 'page-n') return `Page ${n}`
    return `${n} / ${total}`
  }
  return stampPages(bytes, ({ i, total, mb, rot, dw, dh }) => {
    if (i === 0 && skipFirst) return null
    const label = labelFor(i, total)
    const charW = size * 0.5
    const xd = pos.endsWith('l') ? margin
      : pos.endsWith('r') ? dw - margin - label.length * charW
      : dw / 2 - (label.length * charW) / 2
    const yd = pos.startsWith('t') ? dh - margin - size * 0.72 : margin
    const w = mb[2] - mb[0], hh = mb[3] - mb[1]
    const [xu, yu, m] = stampPos(rot, xd, yd, w, hh)
    return {
      content:
        `q ${m[0]} ${m[1]} ${m[2]} ${m[3]} ${(mb[0] + xu).toFixed(1)} ${(mb[1] + yu).toFixed(1)} cm ` +
        `BT /PDFFnt1 ${size} Tf 0 g 0 0 Td ${pdfStr(label)} Tj ET Q`,
      res: { Font: { PDFFnt1: HELVETICA } },
    }
  })
}

/**
 * Stamp rotated, translucent, colored text across every page.
 * angle: degrees in DISPLAY space (negative → ↗ bottom-left→top-right).
 */
export async function watermarkPdf(
  bytes,
  { text = 'CONFIDENTIAL', size = 48, opacity = 0.25, color = [0.62, 0.1, 0.1], angle = -45 } = {},
) {
  const th = (angle * Math.PI) / 180
  const R = [Math.cos(th), Math.sin(th), -Math.sin(th), Math.cos(th)]
  return stampPages(bytes, ({ mb, rot, dw, dh }) => {
    const dispLin = rot === 90 ? [0, 1, 1, 0]
      : rot === 180 ? [-1, 0, 0, 1]
      : rot === 270 ? [0, -1, -1, 0]
      : [1, 0, 0, -1]
    const m = matMul(dispLin, R)
    const w = mb[2] - mb[0], hh = mb[3] - mb[1]
    const [xu, yu] = stampPos(rot, dw / 2, dh / 2, w, hh)
    const half = (text.length * size * 0.5) / 2
    return {
      content:
        `q /GSwm gs ${color.map((c) => c.toFixed(3)).join(' ')} rg ` +
        `${m.map((v) => +v.toFixed(4)).join(' ')} ${(mb[0] + xu).toFixed(1)} ${(mb[1] + yu).toFixed(1)} cm ` +
        `BT /PDFFnt1 ${size} Tf ${(-half).toFixed(1)} ${(-size * 0.36).toFixed(1)} Td ${pdfStr(text)} Tj ET Q`,
      res: {
        Font: { PDFFnt1: HELVETICA },
        ExtGState: { GSwm: new Map([['ca', opacity], ['CA', opacity]]) },
      },
    }
  })
}

// ---------- edit annotations ----------

/** Unicode → CP1252 byte for the 0x80–0x9F range (differs from latin1). */
const ANN_CP1252 = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
])

/** WinAnsi literal string: CP1252 bytes, high/control bytes as \ooo, else '?'. */
const annStr = (s) => {
  let out = '('
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    const b = cp < 0x80 ? cp : cp >= 0xa0 && cp < 0x100 ? cp : ANN_CP1252.get(cp) ?? 0x3f
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b)
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b)
    else out += '\\' + b.toString(8).padStart(3, '0')
  }
  return out + ')'
}

const annNum = (v) => +v.toFixed(2)

/** '#rrggbb' → 'r g b' (0–1 floats, 3 decimals) or null. */
const annColor = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(typeof hex === 'string' ? hex : '')
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    .map((c) => c.toFixed(3)).join(' ')
}

const ANN_FONTS = {
  helv: ['ANN_F1', 'Helvetica'],
  helvb: ['ANN_F2', 'Helvetica-Bold'],
  times: ['ANN_F3', 'Times-Roman'],
  courier: ['ANN_F4', 'Courier'],
}
const ANN_KAPPA = 0.5523

const annFontDict = (base) => new Map([
  ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name(base)],
])

/**
 * Bake UI annotations into pages as real PDF operators.
 * pagesAnnots[p] (0-based) = [{t, ...}] in DISPLAY-space pt (top-left origin,
 * y down, dims dw×dh); falsy/empty entries leave the page untouched.
 * Shapes: stroke {pts,color,width}, vstroke {pts:[x,y,w]}, highlight {pts,
 * color,width}, line {x1,y1,x2,y2,arrow?}, rect/ellipse {x,y,w,h,stroke,fill,
 * lw}, text {x,y,text,size,font} (x,y = TOP of first line; baseline = y+size,
 * leading 1.2×size),
 * image {x,y,w,h,jpeg}. Appends one content stream per touched page and merges
 * ANN_* resources (fonts, ExtGState, XObjects) into page Resources.
 */
export async function annotatePdf(bytes, pagesAnnots) {
  return stampPages(bytes, ({ i, mb, rot, w, hh, dh, dst }) => {
    const anns = pagesAnnots?.[i]
    if (!Array.isArray(anns) || !anns.length) return null
    // display→user wrap: after this cm all coords are display space (y down)
    const dispLin = rot === 90 ? [0, 1, 1, 0]
      : rot === 180 ? [-1, 0, 0, 1]
      : rot === 270 ? [0, -1, -1, 0]
      : [1, 0, 0, -1]
    const [xu0, yu0] = stampPos(rot, 0, dh, w, hh)
    const wrap = `${dispLin.join(' ')} ${annNum(mb[0] + xu0)} ${annNum(mb[1] + yu0)} cm`
    const res = {}
    const ops = []
    let gsN = 0, imN = 0
    const gsFor = (alpha, multiply) => {
      const d = new Map([['ca', alpha], ['CA', alpha]])
      if (multiply) d.set('BM', name('Multiply'))
      const nm = `ANN_GS${++gsN}`
      ;(res.ExtGState ??= {})[nm] = d
      return `/${nm} gs`
    }
    const pt2 = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    const num = (v) => Number.isFinite(v) ? annNum(v) : '0'
    for (const a of anns) {
      if (!a || typeof a !== 'object') continue
      const alpha = typeof a.alpha === 'number' ? Math.min(1, Math.max(0, a.alpha)) : null
      const needsGs = a.t === 'highlight' || (alpha !== null && alpha < 1)
      const gs = needsGs ? gsFor(alpha ?? 0.35, a.t === 'highlight') : ''
      const color = annColor(a.color)
      const parts = []
      switch (a.t) {
        case 'stroke':
        case 'highlight': {
          if (!color || !Array.isArray(a.pts) || a.pts.length < 1 || !a.pts.every(pt2)) break
          const w0 = a.t === 'highlight' ? (a.width ?? 12) : (a.width ?? 2)
          const path = a.pts.length === 1
            ? `${num(a.pts[0][0])} ${num(a.pts[0][1])} m ${num(a.pts[0][0] + 0.01)} ${num(a.pts[0][1])} l` // tap-dot
            : a.pts.map((p, k) => `${num(p[0])} ${num(p[1])} ${k ? 'l' : 'm'}`).join(' ')
          parts.push(`${color} RG ${num(w0)} w 1 J 1 j ${path} S`)
          break
        }
        case 'vstroke': {
          if (!color || !Array.isArray(a.pts) || a.pts.length < 1) break
          const segs = []
          for (let k = 0; k + 1 < a.pts.length; k++) {
            const [p, q] = [a.pts[k], a.pts[k + 1]]
            if (!pt2(p) || !pt2(q)) continue
            const sw = Math.min(60, Math.max(0.3, typeof p[2] === 'number' ? p[2] : 1))
            segs.push(`${num(sw)} w ${num(p[0])} ${num(p[1])} m ${num(q[0])} ${num(q[1])} l S`)
          }
          if (!segs.length && a.pts.length === 1 && pt2(a.pts[0])) { // tap-dot
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
          parts.push(`${color} RG ${num(lw)} w ${num(a.x1)} ${num(a.y1)} m ${num(a.x2)} ${num(a.y2)} l S`)
          if (a.arrow) {
            const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1)
            const L = Math.min(60, 3 * lw)
            const [bx, by] = [a.x2 - L * Math.cos(ang), a.y2 - L * Math.sin(ang)]
            const [px, py] = [-Math.sin(ang) * L * 0.45, Math.cos(ang) * L * 0.45]
            parts.push(
              `${color} rg ${num(a.x2)} ${num(a.y2)} m ${num(bx + px)} ${num(by + py)} l ` +
              `${num(bx - px)} ${num(by - py)} l h f`,
            )
          }
          break
        }
        case 'rect':
        case 'ellipse': {
          if (![a.x, a.y, a.w, a.h].every(Number.isFinite)) break
          const fill = annColor(a.fill), strokeC = annColor(a.stroke)
          if (!fill && !strokeC) break
          const lw = typeof a.lw === 'number' && a.lw > 0 ? a.lw : 1
          let path
          if (a.t === 'rect') {
            path = `${num(a.x)} ${num(a.y)} ${num(a.w)} ${num(a.h)} re`
          } else {
            const [cx, cy, rx, ry, k] = [a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, ANN_KAPPA]
            path =
              `${num(cx + rx)} ${num(cy)} m ` +
              `${num(cx + rx)} ${num(cy - k * ry)} ${num(cx + k * rx)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c ` +
              `${num(cx - k * rx)} ${num(cy - ry)} ${num(cx - rx)} ${num(cy - k * ry)} ${num(cx - rx)} ${num(cy)} c ` +
              `${num(cx - rx)} ${num(cy + k * ry)} ${num(cx - k * rx)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c ` +
              `${num(cx + k * rx)} ${num(cy + ry)} ${num(cx + rx)} ${num(cy + k * ry)} ${num(cx + rx)} ${num(cy)} c h`
          }
          const paint = fill && strokeC ? 'B' : fill ? 'f' : 'S'
          parts.push(
            `${fill ? `${fill} rg ` : ''}${strokeC ? `${strokeC} RG ` : ''}${num(lw)} w ${path} ${paint}`,
          )
          break
        }
        case 'text': {
          const size = typeof a.size === 'number' && a.size > 0 ? a.size : null
          const [fname, base] = ANN_FONTS[a.font] ?? ANN_FONTS.helv
          if (!color || !size || typeof a.text !== 'string' || !a.text.length ||
              ![a.x, a.y].every(Number.isFinite)) break
          ;(res.Font ??= {})[fname] = annFontDict(base)
          const lines = a.text.split('\n')
          lines.forEach((line, li) => {
            const yTd = a.y + size + li * size * 1.2 // baseline = top + one em
            const [xu, yu, m] = stampPos(rot, a.x, dh - yTd, w, hh)
            ops.push(
              `q ${gs} ${m.join(' ')} ${annNum(mb[0] + xu)} ${annNum(mb[1] + yu)} cm ` +
              `${color} rg BT /${fname} ${num(size)} Tf 0 0 Td ${annStr(line)} Tj ET Q`,
            )
          })
          break
        }
        case 'image': {
          if (!(a.jpeg instanceof Uint8Array) || ![a.x, a.y, a.w, a.h].every(Number.isFinite)) break
          let info
          try { info = jpegInfo(a.jpeg) } catch { break } // non-JPEG → skip
          const imNum = dst.alloc()
          dst.set(imNum, stream(new Map([
            ['Type', name('XObject')], ['Subtype', name('Image')],
            ['Width', info.width], ['Height', info.height],
            ['ColorSpace', name(info.colorSpace)], ['BitsPerComponent', 8],
            ['Filter', name('DCTDecode')],
          ]), a.jpeg))
          const nm = `ANN_Im${++imN}`
          ;(res.XObject ??= {})[nm] = ref(imNum, 0)
          parts.push(`${num(a.w)} 0 0 ${num(-a.h)} ${num(a.x)} ${num(a.y + a.h)} cm /${nm} Do`)
          break
        }
      }
      if (parts.length) ops.push(`q ${wrap} ${[gs, ...parts].filter(Boolean).join(' ')} Q`)
    }
    // leading \n keeps our first op from merging with the previous stream's
    // last token (Contents arrays concatenate without a separator)
    return ops.length ? { content: '\n' + ops.join('\n'), res } : null
  })
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

// ---------- text extraction ----------

/** Page text, lines reassembled by position (top→bottom, left→right). */
export async function pageText(doc, leaf) {
  const { ops } = await collectDrawOps(doc, leaf)
  return textFromOps(ops)
}

/**
 * Text ops → reading-order text. Runs are grouped into lines by baseline, then
 * joined by GEOMETRY: a space only where the gap between runs is wider than a
 * fraction of the font size. (Kerned TJ arrays and per-glyph positioning emit
 * one op per fragment — joining those with blanks gives "Quar t erly".)
 */
export function textFromOps(ops) {
  const texts = ops.filter((o) => o.t === 'text' && o.str && Math.abs(o.rot ?? 0) < 0.3)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []
  let cur = []
  let lineY = 0
  for (const t of texts) {
    if (cur.length && Math.abs(t.y - lineY) > Math.max(2, Math.min(t.h, cur[0].h) * 0.5)) { lines.push(cur); cur = [] }
    if (!cur.length) lineY = t.y
    cur.push(t)
  }
  if (cur.length) lines.push(cur)
  // vertical / rotated runs: their own lines, kept in stream order
  const rotated = ops.filter((o) => o.t === 'text' && o.str && Math.abs(o.rot ?? 0) >= 0.3).map((o) => o.str.trim()).filter(Boolean)
  const out = lines.map((l) => {
    l.sort((a, b) => a.x - b.x)
    let s = ''
    let end = -Infinity
    for (const t of l) {
      const size = t.size || t.h || 10
      const gap = t.x - end
      if (s && gap > size * 0.18 && !s.endsWith(' ') && !t.str.startsWith(' ')) s += ' '
      s += t.str
      end = Math.max(end, t.x + t.w)
    }
    return s.replace(/[ﬀ-ﬆ]/g, (c) => c.normalize('NFKC')).replace(/\s+/g, ' ').trim()
  }).filter(Boolean)
  return [...out, ...rotated].join('\n')
}

/** All pages → ['page 1 text', ...]. */
export async function extractText(doc) {
  const leaves = pageLeaves(doc)
  const out = []
  for (const leaf of leaves) out.push(await pageText(doc, leaf))
  return out
}

// ---------- compress ----------

/**
 * Rebuild keeping only reachable objects; re-deflate every decodable stream
 * when it wins. opts.reimage: async (stream, decodedBytes) → Uint8Array|null —
 * browser hook to re-encode DCT images at lower quality (canvas path).
 * Returns { bytes, before, after }.
 */
export async function compressPdf(bytes, { reimage } = {}) {
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const refMap = new Map()
  appendPages(src, leaves.map((leaf) => ({ leaf, rotateDelta: 0 })), dst, pagesRef, kids, [], refMap)
  // pull catalog extras in now so recompression covers them too
  const { catNum, trailer } = buildCatalog(dst, pagesRef, kids, src, refMap)
  const dstDoc = { objects: new Map() }
  for (const [num, v] of dst.objects) dstDoc.objects.set(`${num} 0`, { v })
  for (const v of dst.objects.values()) {
    if (!isStream(v)) continue
    if (reimage && get(v.dict, 'Subtype')?.v === 'Image' && get(v.dict, 'SMask') === undefined) {
      const dec = await decodeImageStream(dstDoc, v).catch(() => null)
      const repl = dec ? await reimage(dec).catch(() => null) : null
      if (repl && repl.length < v.data.length) {
        v.data = repl
        v.dict.set('Filter', name('DCTDecode'))
        v.dict.set('ColorSpace', name('DeviceRGB'))
        v.dict.set('BitsPerComponent', 8)
        for (const k of ['DecodeParms', 'DP', 'Decode']) v.dict.delete(k)
        continue
      }
    }
    // streamData undoes the whole chain incl. predictors, so the re-deflated
    // bytes are raw — DecodeParms no longer applies and must go with the old filters.
    const raw = await streamData(v)
    if (raw === null) continue
    const packed = await deflate(raw)
    if (packed.length < v.data.length) {
      v.data = packed
      v.dict.set('Filter', name('FlateDecode'))
      v.dict.delete('DecodeParms')
      v.dict.delete('DP')
    }
  }
  const out = writeDoc(dst, catNum, trailer)
  return { bytes: out, before: bytes.length, after: out.length }
}

/** Decode a stream through its whole filter chain → bytes (null for image codecs / unsupported). */
export async function streamData(s) {
  try {
    const { data, codec } = await decodeChain(s.dict, s.data, { stopAtImage: true })
    return codec ? null : data
  } catch {
    return null
  }
}

/** Concatenated, decoded Contents bytes for a page (null if undecodable). */
export async function contentBytes(doc, leaf) {
  let c = get(leaf.dict, 'Contents')
  if (isRef(c)) c = deref(doc, c)
  const streams = isStream(c) ? [c]
    : Array.isArray(c) ? c.map((x) => (isRef(x) ? deref(doc, x) : x)).filter(isStream)
    : []
  const parts = []
  for (const s of streams) {
    const d = await streamData(s)
    if (d === null) return null
    parts.push(d)
  }
  return parts.length ? concat(parts) : null
}

/**
 * Minimal content-stream tokenizer → [{op, operands}].
 * Handles names, numbers, literal+hex strings, arrays, dict marks.
 * Operands keep source order; arrays arrive as {t:'arr', items}.
 */
export function tokenizeContent(data) {
  const ops = []
  let operands = []
  let i = 0
  const n = data.length
  const isWS = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32
  const isDelim = (c) => isWS(c) || c === 0x5b || c === 0x5d || c === 0x3c || c === 0x3e || c === 0x28 || c === 0x29 || c === 0x2f || c === 0x25
  while (i < n) {
    const c = data[i]
    if (isWS(c)) { i++; continue }
    if (c === 0x25) { while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++; continue }
    if (c === 0x2f) {
      let j = i + 1
      while (j < n && !isDelim(data[j])) j++
      // #xx unescape like parse.js decodeName — /F#31-style font names
      let nm = ''
      for (let k = i + 1; k < j; k++) {
        if (data[k] === 0x23 && k + 2 < j) {
          const hv = parseInt(dec(data.subarray(k + 1, k + 3)), 16)
          if (!Number.isNaN(hv)) { nm += String.fromCharCode(hv); k += 2; continue }
        }
        nm += String.fromCharCode(data[k])
      }
      operands.push({ t: 'name', v: nm })
      i = j
      continue
    }
    if (c === 0x28) {
      let j = i + 1, depth = 1
      const bytes = []
      while (j < n && depth) {
        const b = data[j]
        if (b === 0x5c) {
          const e = data[j + 1]
          if (e === 0x0a) { j += 2; continue }                              // \LF
          if (e === 0x0d) { j += data[j + 2] === 0x0a ? 3 : 2; continue }   // \CR(LF)
          const esc = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c }[e]
          if (esc !== undefined) { bytes.push(esc); j += 2; continue }
          if (e >= 0x30 && e <= 0x37) {                                     // \ooo octal
            let oct = 0, k = 0
            while (k < 3 && data[j + 1 + k] >= 0x30 && data[j + 1 + k] <= 0x37) {
              oct = oct * 8 + (data[j + 1 + k] - 0x30); k++
            }
            bytes.push(oct & 0xff); j += 1 + k; continue
          }
          bytes.push(e); j += 2; continue                                   // \( \) \\ other
        }
        if (b === 0x28) depth++
        else if (b === 0x29) { depth--; if (!depth) { j++; break } }
        bytes.push(b)
        j++
      }
      operands.push({ t: 'str', bytes: Uint8Array.from(bytes) })
      i = j
      continue
    }
    if (c === 0x3c) {
      if (data[i + 1] === 0x3c) { operands.push({ t: 'dict' }); i += 2; continue }
      let j = i + 1, hexs = ''
      while (j < n && data[j] !== 0x3e) { if (!isWS(data[j])) hexs += String.fromCharCode(data[j]); j++ }
      const bytes = new Uint8Array(Math.ceil(hexs.length / 2))
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hexs.slice(k * 2, k * 2 + 2).padEnd(2, '0'), 16)
      operands.push({ t: 'str', bytes })
      i = j + 1
      continue
    }
    if (c === 0x3e && data[i + 1] === 0x3e) { operands.push({ t: 'dict' }); i += 2; continue }
    if (c === 0x5b) { operands.push({ t: '[' }); i++; continue }
    if (c === 0x5d) {
      let k = operands.length - 1
      while (k >= 0 && operands[k].t !== '[') k--
      const items = operands.splice(k + 1)
      operands.length = k
      operands.push({ t: 'arr', items })
      i++
      continue
    }
    let j = i
    while (j < n && !isDelim(data[j])) j++
    const tok = dec(data.subarray(i, j))
    i = j
    if (tok === 'ID') {
      // inline image payload: one ws byte, raw data until whitespace+'EI'
      ops.push({ op: 'ID', operands })
      operands = []
      if (i < n && isWS(data[i])) i++
      while (i < n) {
        if (isWS(data[i]) && data[i + 1] === 0x45 && data[i + 2] === 0x49 && (i + 3 >= n || isDelim(data[i + 3]))) {
          i += 3
          ops.push({ op: 'EI', operands: [] })
          break
        }
        i++
      }
      continue
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) operands.push(parseFloat(tok))
    else if (tok === 'true' || tok === 'false' || tok === 'null') operands.push(tok === 'true' ? true : tok === 'false' ? false : null)
    else { ops.push({ op: tok, operands }); operands = [] }
  }
  return ops
}

/**
 * Best-effort visual for a page: {img: {data, mime} | null, text: string}.
 * img = the largest painted image XObject (dominant cm area); text = the
 * page's own first characters of drawn text (Tj/TJ operands, latin1-decoded).
 */
export async function pagePreview(doc, leaf, maxLen = 200) {
  const data = await contentBytes(doc, leaf)
  if (!data) return { img: null, text: '' }
  const ops = tokenizeContent(data)
  const fonts = await fontMap(doc, leaf)
  let curFont = null
  const parts = []
  for (const { op, operands } of ops) {
    if (op === 'Tf') {
      const nm = operands.find((o) => o.t === 'name')
      if (nm) curFont = fonts.get(nm.v) ?? null
      continue
    }
    if (op === 'Tj' || op === "'" || op === '"') {
      for (let k = operands.length - 1; k >= 0; k--) {
        if (operands[k].t === 'str') { parts.push(decodeString(operands[k].bytes, curFont)); break }
      }
    } else if (op === 'TJ') {
      const arr = operands.find((o) => o.t === 'arr')
      if (arr) for (const it of arr.items) if (it.t === 'str') parts.push(decodeString(it.bytes, curFont))
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen)
  return { img: await dominantImage(doc, leaf, ops), text }
}

/** Largest-painted-area image XObject invoked by the page's Do operators. */
async function dominantImage(doc, leaf, ops) {
  const resSrc = get(leaf.dict, 'Resources') ?? leaf.inh.Resources
  const res = isRef(resSrc) ? deref(doc, resSrc) : resSrc
  const xoSrc = get(res, 'XObject')
  const xo = isRef(xoSrc) ? deref(doc, xoSrc) : xoSrc
  if (!(xo instanceof Map)) return null
  let cm = [1, 0, 0, 1, 0, 0]
  let best = null
  for (const { op, operands } of ops) {
    if (op === 'cm' && operands.length === 6) cm = operands.map(Number)
    else if (op === 'Do') {
      const nm = [...operands].reverse().find((o) => o.t === 'name')
      if (!nm) continue
      let xv = xo.get(nm.v)
      if (isRef(xv)) xv = deref(doc, xv)
      if (!isStream(xv) || get(xv.dict, 'Subtype')?.v !== 'Image') continue
      const area = Math.abs(cm[0] * cm[3] - cm[1] * cm[2])
      if (!best || area > best.area) best = { area, xv }
    }
  }
  return best ? decodeImageStream(doc, best.xv) : null
}

// ---------- page rendering ----------

/** Parse a /ToUnicode CMap stream → {map: Map<code,string>, codeLen}. */
export function parseToUnicode(data) {
  const src = dec(data)
  const hex = (s) => parseInt(s, 16)
  const uni = (s) => {
    let out = ''
    for (let i = 0; i + 4 <= s.length; i += 4) out += String.fromCodePoint(parseInt(s.slice(i, i + 4), 16))
    return out
  }
  const map = new Map()
  let codeLen = 1
  const blocks = src.matchAll(/beginbf(char|range)([\s\S]*?)endbf\1/g)
  for (const b of blocks) {
    const [, kind, body] = b
    if (kind === 'char') {
      for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        codeLen = Math.max(codeLen, m[1].length / 2)
        map.set(hex(m[1]), uni(m[2]))
      }
    } else {
      for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<([0-9A-Fa-f]+)>)/g)) {
        codeLen = Math.max(codeLen, m[1].length / 2)
        const lo = hex(m[1]), hi = hex(m[2])
        if (m[4]) for (let c = lo; c <= hi; c++) map.set(c, uni((hex(m[4]) + c - lo).toString(16).padStart(m[4].length, '0')))
        else for (const [k, dm] of [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].entries()) map.set(lo + k, uni(dm[1]))
      }
    }
  }
  return { map, codeLen }
}

/**
 * Resolve a page's font resources → Map<name, {widths, firstChar, tounicode}>.
 * widths = /Widths array (deref'd) + /FirstChar; CID /W ranges folded in.
 */
export async function fontMap(doc, leaf) {
  const resSrc = get(leaf.dict, 'Resources') ?? leaf.inh.Resources
  const res = isRef(resSrc) ? deref(doc, resSrc) : resSrc
  return fontMapFromRes(doc, res)
}

/** Font name → {widths, firstChar, wRanges, tounicode} from a Resources dict. */
export async function fontMapFromRes(doc, res) {
  let fonts = res instanceof Map ? get(res, 'Font') : null
  if (isRef(fonts)) fonts = deref(doc, fonts)
  const out = new Map()
  if (!(fonts instanceof Map)) return out
  for (const [fname, fref] of fonts) {
    let fd = isRef(fref) ? deref(doc, fref) : fref
    if (isStream(fd)) fd = fd.dict
    if (!(fd instanceof Map)) continue
    const hit = FONT_CACHE.get(fd)
    if (hit) { out.set(fname, hit); continue }
    const info = { widths: null, firstChar: 0, wRanges: null, tounicode: null, codeLen: null, dw: 1000 }
    // Type0 fonts wrap a descendant CIDFont that carries /W + /DW; codes are
    // multi-byte (2 for Identity encodings) even without a ToUnicode map
    const isCid = get(fd, 'Subtype')?.v === 'Type0' || get(fd, 'DescendantFonts') !== undefined
    if (isCid) info.codeLen = 2
    let cidFd = fd
    const desc = get(fd, 'DescendantFonts')
    if (Array.isArray(desc) && desc.length) {
      let d0 = isRef(desc[0]) ? deref(doc, desc[0]) : desc[0]
      if (isStream(d0)) d0 = d0.dict
      if (d0 instanceof Map) cidFd = d0
    }
    info.dw = get(cidFd, 'DW') ?? null
    let w = get(fd, 'Widths')
    if (isRef(w)) w = deref(doc, w)
    if (Array.isArray(w)) info.widths = w
    info.firstChar = get(fd, 'FirstChar') ?? 0
    let wArr = get(cidFd, 'W') ?? get(fd, 'W')
    if (isRef(wArr)) wArr = deref(doc, wArr)
    if (Array.isArray(wArr)) {
      info.wRanges = new Map()
      for (let i = 0; i < wArr.length;) {
        if (typeof wArr[i] === 'number' && Array.isArray(wArr[i + 1])) {
          // [cid [w0 w1 …]] — explicit widths for consecutive codes
          wArr[i + 1].forEach((ww, k) => info.wRanges.set(wArr[i] + k, ww))
          i += 2
        } else if (typeof wArr[i] === 'number' && typeof wArr[i + 1] === 'number' && typeof wArr[i + 2] === 'number') {
          // [lo hi w] — one width for the whole range
          for (let c = wArr[i]; c <= wArr[i + 1]; c++) info.wRanges.set(c, wArr[i + 2])
          i += 3
        } else i++
      }
    }
    // style hints for the renderer + simple-font encoding table for text
    let base = get(fd, 'BaseFont')
    base = isName(base) ? base.v.replace(/^[A-Z]{6}\+/, '') : ''
    let fdesc = get(cidFd, 'FontDescriptor') ?? get(fd, 'FontDescriptor')
    if (isRef(fdesc)) fdesc = deref(doc, fdesc)
    const flags = fdesc instanceof Map ? get(fdesc, 'Flags') ?? 0 : 0
    const lname = base.toLowerCase()
    info.base = base
    info.bold = /bold|black|heavy|semibold|demi|,b/.test(lname) || (fdesc instanceof Map && (get(fdesc, 'FontWeight') ?? 400) >= 600)
    info.italic = /italic|oblique|,i/.test(lname) || !!(flags & 64)
    info.mono = /courier|mono|consol|menlo/.test(lname) || !!(flags & 1)
    info.serif = !info.mono && (/times|serif|roman|georgia|garamond|cmr|cmti|cmbx|minion|palatino|book|cambria/.test(lname) || (!!(flags & 2) && !/sans|arial|helvetica|cmss/.test(lname)))
    info.symbol = /symbol|dingbat/.test(lname)
    if (!isCid) {
      let encv = get(fd, 'Encoding')
      if (isRef(encv)) encv = deref(doc, encv)
      info.enc = simpleEncodingTable(encv, { symbolic: !!(flags & 4) && !encv })
    }
    let tu = get(fd, 'ToUnicode')
    if (isRef(tu)) tu = deref(doc, tu)
    if (isStream(tu)) {
      const d = await streamData(tu).catch(() => null)
      if (d) info.tounicode = parseToUnicode(d)
    }
    FONT_CACHE.set(fd, info)
    out.set(fname, info)
  }
  return out
}
const FONT_CACHE = new WeakMap() // font dict → parsed info (fonts repeat on every page)

/** Decode a PDF string operand using a font entry (ToUnicode → latin1). */
export function decodeString(bytes, font) {
  if (font?.tounicode) {
    const { map, codeLen } = font.tounicode
    let out = ''
    for (let i = 0; i + codeLen <= bytes.length; i += codeLen) {
      let code = 0
      for (let k = 0; k < codeLen; k++) code = code * 256 + bytes[i + k]
      out += map.get(code) ?? (codeLen === 1 && font.enc ? font.enc[code] : '')
    }
    return out
  }
  if (font?.enc) {
    let out = ''
    for (let i = 0; i < bytes.length; i++) out += font.enc[bytes[i]]
    return out
  }
  // multi-byte codes without a map decode as the raw CID values
  const cl = font?.codeLen ?? 1
  if (cl > 1) {
    let out = ''
    for (let i = 0; i + cl <= bytes.length; i += cl) {
      let code = 0
      for (let k = 0; k < cl; k++) code = code * 256 + bytes[i + k]
      out += code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return out
  }
  return dec(bytes)
}

/** Fraction of decoded chars that are non-printable — flags garbage text. */
const garbageRatio = (s) => {
  if (!s.length) return 1
  let bad = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if ((c < 0x20 && ch !== ' ' && ch !== '\t') || (c >= 0x7f && c <= 0x9f)) bad++
  }
  return bad / s.length
}

const matMul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]
const matPt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** user→display transform (top-left origin, /Rotate applied clockwise). */
export function displayTransform(mb, rot) {
  const [x0, y0, x1, y1] = mb
  if (rot === 90) return [0, 1, 1, 0, -y0, -x0]
  if (rot === 180) return [-1, 0, 0, 1, x1, -y0]
  if (rot === 270) return [0, -1, -1, 0, y1, x1]
  return [1, 0, 0, -1, -x0, y1]
}

/**
 * Interpret a page content stream into positioned display-space draw ops.
 * Returns { ops, box } — box = {w,h} of the displayed page in points.
 * ops: {t:'text'|'img'|'rect'|'path'|'clip'|'unclip', x?,y?,w?,h?, rot?, str?,
 *       key?, stroke?, fill?, fc?, sc?, a?, lw?, dash?, eo?, segs?}
 * Path segs are [cmd, ...displayPts] with cmd 'M'|'L'|'C'|'Z'.
 */
export async function collectDrawOps(doc, leaf) {
  const mbSrc = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox
  const mbRes = isRef(mbSrc) ? deref(doc, mbSrc) : mbSrc
  const mb = Array.isArray(mbRes) ? mbRes : [0, 0, 612, 792]
  const rotSrc = get(leaf.dict, 'Rotate') ?? leaf.inh.Rotate ?? 0
  const rot = typeof rotSrc === 'number' ? ((rotSrc % 360) + 360) % 360 : 0
  const w = mb[2] - mb[0]
  const hgt = mb[3] - mb[1]
  const box = { w: rot % 180 === 0 ? w : hgt, h: rot % 180 === 0 ? hgt : w }
  const resSrc = get(leaf.dict, 'Resources') ?? leaf.inh.Resources
  const res = isRef(resSrc) ? deref(doc, resSrc) : resSrc
  const st = {
    ops: [], disp: displayTransform(mb, rot),
    ctm: [1, 0, 0, 1, 0, 0], gstack: [],
    tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0],
    leading: 0, fontSize: 0, curFont: null, tc: 0, tw: 0, tz: 1, tr: 0,
    path: [], cur: null,
    fillC: [0, 0, 0], strokeC: [0, 0, 0], fillA: 1, strokeA: 1,
    lw: 1, dash: null, dashPhase: 0, clipLevels: [], depth: 0,
  }
  const data = await contentBytes(doc, leaf)
  if (data) await walkContent(doc, st, data, res, await fontMap(doc, leaf))
  return { ops: st.ops, box }
}

const cmyk2rgb = (c, m, y, k) => [
  1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k),
]

/** Decode numeric color operands by component count (gray/rgb/cmyk). */
function colorFrom(nums) {
  if (nums.length === 1) return [nums[0], nums[0], nums[0]]
  if (nums.length === 3) return nums.slice(0, 3)
  if (nums.length >= 4) return cmyk2rgb(nums[0], nums[1], nums[2], nums[3])
  return null
}

async function walkContent(doc, st, data, res, fonts) {
  const { ops, disp } = st
  const xf = (x, y) => matPt(disp, ...matPt(st.ctm, x, y))
  const avgScale = () => (Math.hypot(st.ctm[0], st.ctm[1]) + Math.hypot(st.ctm[2], st.ctm[3])) / 2
  const lwScaled = () => st.lw * avgScale()
  const dashScaled = () => (st.dash ? st.dash.map((d) => d * avgScale()) : null)
  const doffScaled = () => (st.dash ? st.dashPhase * avgScale() : 0)

  const xoDict = () => {
    let x = res instanceof Map ? get(res, 'XObject') : null
    if (isRef(x)) x = deref(doc, x)
    return x instanceof Map ? x : null
  }
  const xoResolve = (nm) => {
    let xv = xoDict()?.get(nm)
    if (isRef(xv)) xv = deref(doc, xv)
    return xv
  }
  const xoKey = (nm) => {
    const v = xoDict()?.get(nm)
    return isRef(v) ? `${v.n} ${v.g}` : `inline:${nm}`
  }
  const fontOf = () => (st.curFont && fonts.get(st.curFont)) || null

  const advance = (bytes, font) => {
    if (!font) return bytes.length * 0.5 * st.fontSize * st.tz
    let sum = 0
    const cl = font.tounicode?.codeLen ?? font.codeLen ?? 1
    for (let i = 0; i + cl <= bytes.length; i += cl) {
      let code = 0
      for (let k = 0; k < cl; k++) code = code * 256 + bytes[i + k]
      const wv = font.wRanges?.get(code) ?? font.widths?.[code - font.firstChar]
      // DW is a CIDFont concept (spec default 1000); simple fonts fall back ~500
      sum += (typeof wv === 'number' ? wv : font.dw ?? (font.codeLen ? 1000 : 500)) / 1000
    }
    return sum * st.fontSize * st.tz
  }

  const emitText = (bytes) => {
    const font = fontOf()
    const str = decodeString(bytes, font)
    const cl = font?.tounicode?.codeLen ?? font?.codeLen ?? 1
    const ncodes = Math.floor(bytes.length / cl)
    const adv = advance(bytes, font) + st.tw * (str.split(' ').length - 1) + st.tc * ncodes
    const m = matMul(st.ctm, st.tm)
    const [ux, uy] = matPt(m, 0, 0)
    const [dx, dy] = matPt(disp, ux, uy)
    const [ux2, uy2] = matPt(m, adv, 0)
    const [dx2, dy2] = matPt(disp, ux2, uy2)
    const dspW = Math.hypot(dx2 - dx, dy2 - dy)
    const ang = Math.atan2(dy2 - dy, dx2 - dx)
    const hh = Math.hypot(m[2], m[3]) * st.fontSize
    ops.push({
      t: 'text', x: dx, y: dy, w: dspW, h: hh, rot: ang,
      str: garbageRatio(str) >= 0.4 ? '' : str,
      size: st.fontSize * Math.hypot(m[0], m[1]),
      fc: st.fillC, a: st.fillA, inv: st.tr === 3,
    })
    st.tm = matMul(st.tm, [1, 0, 0, 1, adv, 0])
  }

  const xformSegs = (subs, closing) =>
    subs.flatMap((sub) => {
      const segs = sub.segs.map((seg) => {
        if (seg[0] === 'Z') return ['Z']
        const out = [seg[0]]
        for (let i = 1; i + 1 < seg.length; i += 2) out.push(...xf(seg[i], seg[i + 1]))
        return out
      })
      if (closing && segs.length && segs[segs.length - 1][0] !== 'Z') segs.push(['Z'])
      return segs
    })

  const paintPath = (op) => {
    const fill = 'fFbB'.includes(op[0]) || op === 'f*' || op === 'b*' || op === 'B*'
    const stroke = op[0] === 'S' || op[0] === 's' || 'bB'.includes(op[0])
    const closing = 'sb'.includes(op[0])
    const eo = op.endsWith('*')
    const lw = lwScaled(), dash = dashScaled(), doff = doffScaled()
    const nonRect = []
    for (const sub of st.path) {
      if (sub.rect) {
        const [rx, ry, rw, rh] = sub.rect
        const cs = [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]].map(([x, y]) => xf(x, y))
        const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1])
        ops.push({
          t: 'rect', x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
          fill, stroke, fc: st.fillC, sc: st.strokeC,
          a: stroke && !fill ? st.strokeA : st.fillA, lw, dash, doff,
        })
      } else nonRect.push(sub)
    }
    if (nonRect.length) {
      ops.push({
        t: 'path', segs: xformSegs(nonRect, closing), fill, stroke, eo,
        fc: st.fillC, sc: st.strokeC,
        a: stroke && !fill ? st.strokeA : st.fillA, lw, dash, doff,
      })
    }
    st.path.length = 0
    st.cur = null
  }

  const nums = (operands) => operands.filter((o) => typeof o === 'number').map(Number)

  for (const { op, operands } of tokenizeContent(data)) {
    switch (op) {
      case 'q':
        st.gstack.push({
          ctm: st.ctm, tm: st.tm, tlm: st.tlm,
          fillC: st.fillC, strokeC: st.strokeC, fillA: st.fillA, strokeA: st.strokeA,
          lw: st.lw, dash: st.dash, dashPhase: st.dashPhase,
        })
        break
      case 'Q': {
        const s = st.gstack.pop()
        if (s) ({
          ctm: st.ctm, tm: st.tm, tlm: st.tlm,
          fillC: st.fillC, strokeC: st.strokeC, fillA: st.fillA, strokeA: st.strokeA,
          lw: st.lw, dash: st.dash, dashPhase: st.dashPhase,
        } = s)
        while (st.clipLevels.length && st.clipLevels[st.clipLevels.length - 1] > st.gstack.length) {
          st.clipLevels.pop()
          ops.push({ t: 'unclip' })
        }
        break
      }
      case 'cm': if (operands.length === 6) st.ctm = matMul(st.ctm, operands.map(Number)); break
      case 'BT': st.tm = [1, 0, 0, 1, 0, 0]; st.tlm = [...st.tm]; break
      case 'ET': break
      case 'Tf': {
        const nm = operands.find((o) => o.t === 'name')
        const sz = operands.find((o) => typeof o === 'number')
        if (nm) st.curFont = nm.v
        if (sz !== undefined) st.fontSize = sz
        break
      }
      case 'Td': case 'TD': {
        const [tx, ty] = [Number(operands[0]) || 0, Number(operands[1]) || 0]
        if (op === 'TD') st.leading = -ty
        st.tlm = matMul(st.tlm, [1, 0, 0, 1, tx, ty])
        st.tm = [...st.tlm]
        break
      }
      case 'T*': st.tlm = matMul(st.tlm, [1, 0, 0, 1, 0, -st.leading]); st.tm = [...st.tlm]; break
      case 'TL': st.leading = Number(operands[0]) || 0; break
      case 'Tm': if (operands.length === 6) { st.tm = operands.map(Number); st.tlm = [...st.tm] } break
      case 'Tc': st.tc = Number(operands[0]) || 0; break
      case 'Tw': st.tw = Number(operands[0]) || 0; break
      case 'Tz': st.tz = (Number(operands[0]) || 100) / 100; break
      case 'Tr': st.tr = Number(operands[0]) || 0; break
      case 'Tj': case "'": case '"': {
        if (op === '"') {
          // " aw ac string — sets Tw and Tc, then behaves like '
          const ns = nums(operands)
          if (ns.length >= 2) { st.tw = ns[0]; st.tc = ns[1] }
        }
        if (op === "'" || op === '"') {
          st.tlm = matMul(st.tlm, [1, 0, 0, 1, 0, -st.leading]); st.tm = [...st.tlm]
        }
        const s = [...operands].reverse().find((o) => o.t === 'str')
        if (s) emitText(s.bytes)
        break
      }
      case 'TJ': {
        const arr = operands.find((o) => o.t === 'arr')
        if (!arr) break
        for (const it of arr.items) {
          if (it.t === 'str') emitText(it.bytes)
          else if (typeof it === 'number')
            st.tm = matMul(st.tm, [1, 0, 0, 1, (-it / 1000) * st.fontSize * st.tz, 0])
        }
        break
      }
      // ---- path construction ----
      case 'm': {
        const [x, y] = [Number(operands[0]) || 0, Number(operands[1]) || 0]
        st.path.push({ segs: [['M', x, y]] })
        st.cur = [x, y]
        break
      }
      case 'l': {
        if (!st.path.length) break
        const [x, y] = [Number(operands[0]) || 0, Number(operands[1]) || 0]
        st.path[st.path.length - 1].segs.push(['L', x, y])
        st.cur = [x, y]
        break
      }
      case 'c': {
        if (!st.path.length) break
        const n6 = nums(operands)
        if (n6.length < 6) break
        st.path[st.path.length - 1].segs.push(['C', ...n6.slice(0, 6)])
        st.cur = [n6[4], n6[5]]
        break
      }
      case 'v': {
        if (!st.path.length || !st.cur) break
        const n4 = nums(operands)
        if (n4.length < 4) break
        st.path[st.path.length - 1].segs.push(['C', st.cur[0], st.cur[1], ...n4.slice(0, 4)])
        st.cur = [n4[2], n4[3]]
        break
      }
      case 'y': {
        if (!st.path.length) break
        const n4 = nums(operands)
        if (n4.length < 4) break
        st.path[st.path.length - 1].segs.push(['C', n4[0], n4[1], n4[2], n4[3], n4[2], n4[3]])
        st.cur = [n4[2], n4[3]]
        break
      }
      case 'h': {
        if (st.path.length) st.path[st.path.length - 1].segs.push(['Z'])
        break
      }
      case 're': {
        const n4 = nums(operands)
        if (n4.length < 4) break
        const [rx, ry, rw, rh] = n4
        st.path.push({
          rect: [rx, ry, rw, rh],
          segs: [['M', rx, ry], ['L', rx + rw, ry], ['L', rx + rw, ry + rh], ['L', rx, ry + rh], ['Z']],
        })
        break
      }
      // ---- path painting / clipping ----
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'b': case 'B*': case 'b*':
        paintPath(op)
        break
      case 'W': case 'W*': {
        if (st.path.length) {
          ops.push({ t: 'clip', segs: xformSegs(st.path, true), eo: op === 'W*' })
          st.clipLevels.push(st.gstack.length)
        }
        break
      }
      case 'n': st.path.length = 0; st.cur = null; break
      // ---- color + graphics state ----
      case 'g': { const v = Number(operands[0]) || 0; st.fillC = [v, v, v]; break }
      case 'G': { const v = Number(operands[0]) || 0; st.strokeC = [v, v, v]; break }
      case 'rg': { const c = colorFrom(nums(operands).slice(0, 3)); if (c) st.fillC = c; break }
      case 'RG': { const c = colorFrom(nums(operands).slice(0, 3)); if (c) st.strokeC = c; break }
      case 'k': case 'K': {
        const c = colorFrom(nums(operands))
        if (c) op === 'k' ? (st.fillC = c) : (st.strokeC = c)
        break
      }
      case 'sc': case 'scn': { const c = colorFrom(nums(operands)); if (c) st.fillC = c; break }
      case 'SC': case 'SCN': { const c = colorFrom(nums(operands)); if (c) st.strokeC = c; break }
      case 'cs': case 'CS': break
      case 'w': {
        const w = Number(operands[0])
        if (Number.isFinite(w)) st.lw = w // 0 w is a real hairline, not 1
        break
      }
      case 'd': {
        const arr = operands.find((o) => o.t === 'arr')
        const phase = Number(operands.filter((o) => typeof o === 'number').pop() ?? 0)
        st.dash = arr
          ? arr.items.map(Number).filter((x) => Number.isFinite(x) && x >= 0)
          : null
        st.dashPhase = Number.isFinite(phase) ? phase : 0
        break
      }
      case 'gs': {
        const nm = operands.find((o) => o.t === 'name')
        let gd = res instanceof Map ? get(res, 'ExtGState') : null
        if (isRef(gd)) gd = deref(doc, gd)
        let e = gd instanceof Map && nm ? gd.get(nm.v) : null
        if (isRef(e)) e = deref(doc, e)
        if (e instanceof Map) {
          const ca = get(e, 'ca'), CA = get(e, 'CA')
          if (typeof ca === 'number') st.fillA = ca
          if (typeof CA === 'number') st.strokeA = CA
        }
        break
      }
      case 'Do': {
        const nm = [...operands].reverse().find((o) => o.t === 'name')
        if (!nm) break
        const xv = xoResolve(nm.v)
        if (!isStream(xv)) break
        const sub = get(xv.dict, 'Subtype')?.v
        if (sub === 'Image') {
          // cs[0..3] = unit quad corners (0,0)(1,0)(1,1)(0,1) in display space.
          // Anchor at cs[3] (image top-left); basis e1 = top edge, e2 = left
          // edge (down the bitmap) — captures rotation/mirror, not just bbox.
          const cs = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => xf(x, y))
          const e1 = [cs[2][0] - cs[3][0], cs[2][1] - cs[3][1]]
          const e2 = [cs[0][0] - cs[3][0], cs[0][1] - cs[3][1]]
          ops.push({
            t: 'img', x: cs[3][0], y: cs[3][1],
            w: Math.hypot(...e1), h: Math.hypot(...e2),
            rot: Math.atan2(e1[1], e1[0]),
            mirror: e1[0] * e2[1] - e1[1] * e2[0] < 0,
            key: xoKey(nm.v), ref: xv, a: st.fillA,
          })
        } else if (sub === 'Form' && st.depth < 4) {
          const fm = get(xv.dict, 'Matrix')
          const fmat = Array.isArray(fm) && fm.length === 6 ? fm.map(Number) : [1, 0, 0, 1, 0, 0]
          // form content runs under an implied q/Q: snapshot the whole graphics
          // state — colors/alpha/dash, text state (a form's Tf/Tr/Tw would
          // otherwise leak into outer text), the in-progress path, and the
          // gstack itself (unbalanced q/Q inside a form must not corrupt ours)
          const saved = {
            ctm: st.ctm, tm: st.tm, tlm: st.tlm, curFont: st.curFont,
            leading: st.leading, fontSize: st.fontSize, tc: st.tc, tw: st.tw,
            tz: st.tz, tr: st.tr,
            fillC: st.fillC, strokeC: st.strokeC, fillA: st.fillA, strokeA: st.strokeA,
            lw: st.lw, dash: st.dash, dashPhase: st.dashPhase,
            path: st.path, cur: st.cur, gstack: st.gstack,
            clipLen: st.clipLevels.length,
          }
          st.ctm = matMul(st.ctm, fmat)
          // fresh path + gstack so the form can't touch the outer ones
          st.path = []
          st.cur = null
          st.gstack = []
          const bb = get(xv.dict, 'BBox')
          let clipped = false
          if (Array.isArray(bb) && bb.length === 4) {
            const [bx0, by0, bx1, by1] = bb.map(Number)
            const cs = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]].map(([x, y]) => xf(x, y))
            ops.push({
              t: 'clip',
              segs: [['M', ...cs[0]], ['L', ...cs[1]], ['L', ...cs[2]], ['L', ...cs[3]], ['Z']],
            })
            clipped = true
          }
          st.depth++
          try {
            let subRes = get(xv.dict, 'Resources')
            if (isRef(subRes)) subRes = deref(doc, subRes)
            const merged = subRes instanceof Map
              ? new Map([...(res instanceof Map ? res : []), ...subRes])
              : res
            const subFonts = merged === res ? fonts : await fontMapFromRes(doc, merged)
            st.curFont = null
            const fdata = await streamData(xv).catch(() => null)
            if (fdata) await walkContent(doc, st, fdata, merged, subFonts)
          } finally {
            st.depth--
            // clips opened inside the form die with it
            while (st.clipLevels.length > saved.clipLen) {
              st.clipLevels.pop()
              ops.push({ t: 'unclip' })
            }
            ;({
              ctm: st.ctm, tm: st.tm, tlm: st.tlm, curFont: st.curFont,
              leading: st.leading, fontSize: st.fontSize, tc: st.tc, tw: st.tw,
              tz: st.tz, tr: st.tr,
              fillC: st.fillC, strokeC: st.strokeC, fillA: st.fillA, strokeA: st.strokeA,
              lw: st.lw, dash: st.dash, dashPhase: st.dashPhase,
            } = saved)
            st.path = saved.path
            st.cur = saved.cur
            st.gstack = saved.gstack
            if (clipped) ops.push({ t: 'unclip' })
          }
        }
        break
      }
    }
  }
}

// ---------- extract images ----------

/**
 * Decode one image XObject stream → {data, mime, ext} or null when unsupported.
 * JPEG/JPEG2000 payloads are passed through untouched (lossless extraction);
 * everything else is decoded through its colour space to PNG (alpha kept).
 */
export async function decodeImageStream(doc, v) {
  const im = await decodeImage(doc, v)
  if (!im) return null
  if (im.kind === 'jpeg') return { data: im.data, mime: 'image/jpeg', ext: '.jpg', smask: im.smask, cmyk: im.cmyk, invert: im.invert }
  if (im.kind === 'jpx') return { data: im.data, mime: 'image/jp2', ext: '.jp2' }
  return { data: rgbaToPng(im.w, im.h, im.rgba), mime: 'image/png', ext: '.png', rgba: im.rgba, w: im.w, h: im.h }
}

/** RGBA → smallest faithful PNG (drops alpha / colour when unused). */
export function rgbaToPng(w, h, rgba) {
  let opaque = true, gray = true
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) opaque = false
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) gray = false
    if (!opaque && !gray) break
  }
  const ch = (gray ? 1 : 3) + (opaque ? 0 : 1)
  const px = new Uint8Array(w * h * ch)
  for (let i = 0, o = 0; i < rgba.length; i += 4) {
    px[o++] = rgba[i]
    if (!gray) { px[o++] = rgba[i + 1]; px[o++] = rgba[i + 2] }
    if (!opaque) px[o++] = rgba[i + 3]
  }
  return pngEncode(w, h, px, ch)
}

/**
 * Pull embedded images out of a PDF.
 * Returns { images: [{name, data, w, h, mime}], skipped }.
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
    const dec = await decodeImageStream(doc, v).catch(() => null)
    if (dec) images.push({ name: `image-${i}-${w}x${h}${dec.ext}`, data: dec.data, w, h, mime: dec.mime, hash: crc32(dec.data) >>> 0 })
    else skipped++
  }
  return { images, skipped }
}
