import { concat, dec, get, isHex, isName, isRef, isStream, isStr, name, ref, set, stream, typeIs } from './types.js'
import { deref, parsePdf } from './parse.js'
import { newDoc, writeDoc } from './write.js'
import { inflate } from './env.js'
import { pngEncode } from '../png.js'
import { crc32 } from '../zip.js'

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
export async function addPageNumbers(bytes, opts = {}) {
  const { pos = 'bc', fmt = 'n-of-total', fmtStr = '{n}', start = 1, skipFirst = false, size = 10, margin = 18 } = opts
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  const total = leaves.length
  const fontResName = 'PDFFnt1'

  const labelFor = (i) => {
    const n = i + start
    if (fmt === 'custom') return (fmtStr || '{n}').replaceAll('{n}', String(n)).replaceAll('{t}', String(total))
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

// ---------- page previews (text + dominant image, no renderer) ----------

/** Concatenated, decoded Contents bytes for a page (null if undecodable). */
export async function contentBytes(doc, leaf) {
  let c = get(leaf.dict, 'Contents')
  if (isRef(c)) c = deref(doc, c)
  const streams = isStream(c) ? [c]
    : Array.isArray(c) ? c.map((x) => (isRef(x) ? deref(doc, x) : x)).filter(isStream)
    : []
  const parts = []
  for (const s of streams) {
    let d = s.data
    const fl = get(s.dict, 'Filter')
    const chain = Array.isArray(fl) ? fl : fl ? [fl] : []
    for (const f of chain) {
      const fn = isName(f) ? f.v : null
      if (fn === 'FlateDecode' || fn === 'Fl') d = await inflate(d)
      else return null
    }
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
      operands.push({ t: 'name', v: dec(data.subarray(i + 1, j)) })
      i = j
      continue
    }
    if (c === 0x28) {
      let j = i + 1, depth = 1
      const bytes = []
      while (j < n && depth) {
        const b = data[j]
        if (b === 0x5c) { bytes.push(data[j + 1]); j += 2; continue }
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
  let fonts = res instanceof Map ? get(res, 'Font') : null
  if (isRef(fonts)) fonts = deref(doc, fonts)
  const out = new Map()
  if (!(fonts instanceof Map)) return out
  for (const [fname, fref] of fonts) {
    let fd = isRef(fref) ? deref(doc, fref) : fref
    if (isStream(fd)) fd = fd.dict
    if (!(fd instanceof Map)) continue
    const info = { widths: null, firstChar: 0, wRanges: null, tounicode: null }
    let w = get(fd, 'Widths')
    if (isRef(w)) w = deref(doc, w)
    if (Array.isArray(w)) info.widths = w
    info.firstChar = get(fd, 'FirstChar') ?? 0
    let wArr = get(fd, 'W')
    if (isRef(wArr)) wArr = deref(doc, wArr)
    if (Array.isArray(wArr)) {
      info.wRanges = new Map()
      for (let i = 0; i + 2 < wArr.length; i += 3) {
        const [lo, hi, ws] = [wArr[i], wArr[i + 1], wArr[i + 2]]
        if (typeof lo === 'number' && Array.isArray(ws)) ws.forEach((ww, k) => info.wRanges.set(lo + k, ww))
        else if (typeof lo === 'number' && typeof hi === 'number' && typeof ws === 'number')
          for (let c = lo; c <= hi; c++) info.wRanges.set(c, ws)
      }
    }
    let tu = get(fd, 'ToUnicode')
    if (isRef(tu)) tu = deref(doc, tu)
    if (isStream(tu)) {
      let d = tu.data
      const fl = get(tu.dict, 'Filter')
      const chain = Array.isArray(fl) ? fl : fl ? [fl] : []
      let ok = true
      for (const f of chain) {
        const fn = isName(f) ? f.v : null
        if (fn === 'FlateDecode' || fn === 'Fl') d = await inflate(d)
        else { ok = false; break }
      }
      if (ok) info.tounicode = parseToUnicode(d)
    }
    out.set(fname, info)
  }
  return out
}

/** Decode a PDF string operand using a font entry (ToUnicode → latin1). */
export function decodeString(bytes, font) {
  if (font?.tounicode) {
    const { map, codeLen } = font.tounicode
    let out = ''
    for (let i = 0; i + codeLen <= bytes.length; i += codeLen) {
      let code = 0
      for (let k = 0; k < codeLen; k++) code = code * 256 + bytes[i + k]
      out += map.get(code) ?? ''
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
 * ops: {t:'text'|'bar'|'img'|'rect', x,y,w,h, rot, str?, key?, stroke?}
 */
export async function collectDrawOps(doc, leaf) {
  const data = await contentBytes(doc, leaf)
  const mbSrc = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox
  const mbRes = isRef(mbSrc) ? deref(doc, mbSrc) : mbSrc
  const mb = Array.isArray(mbRes) ? mbRes : [0, 0, 612, 792]
  const rotSrc = get(leaf.dict, 'Rotate') ?? leaf.inh.Rotate ?? 0
  const rot = typeof rotSrc === 'number' ? ((rotSrc % 360) + 360) % 360 : 0
  const w = mb[2] - mb[0]
  const hgt = mb[3] - mb[1]
  const box = { w: rot % 180 === 0 ? w : hgt, h: rot % 180 === 0 ? hgt : w }
  const disp = displayTransform(mb, rot)
  const empty = { ops: [], box }
  if (!data) return empty

  const fonts = await fontMap(doc, leaf)
  const resSrc = get(leaf.dict, 'Resources') ?? leaf.inh.Resources
  const res = isRef(resSrc) ? deref(doc, resSrc) : resSrc
  const xoSrc = res instanceof Map ? get(res, 'XObject') : null
  const xo = isRef(xoSrc) ? deref(doc, xoSrc) : xoSrc

  const ops = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const gstack = []
  let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0]
  let leading = 0, fontSize = 0, curFont = null, tc = 0, tw = 0, tz = 1
  const pathRects = []

  const imgObj = (nm) => {
    if (!(xo instanceof Map)) return null
    let xv = xo.get(nm)
    if (isRef(xv)) xv = deref(doc, xv)
    return isStream(xv) && get(xv.dict, 'Subtype')?.v === 'Image' ? xv : null
  }
  const imgKey = (nm) => {
    const v = xo instanceof Map ? xo.get(nm) : null
    return isRef(v) ? `${v.n} ${v.g}` : `inline:${nm}`
  }
  const fontOf = () => (curFont && fonts.get(curFont)) || null

  const advance = (bytes, font) => {
    if (!font) return bytes.length * 0.5 * fontSize * tz
    let sum = 0
    const cl = font.tounicode?.codeLen ?? 1
    for (let i = 0; i + cl <= bytes.length; i += cl) {
      let code = 0
      for (let k = 0; k < cl; k++) code = code * 256 + bytes[i + k]
      const wv = font.wRanges?.get(code) ?? font.widths?.[code - font.firstChar]
      sum += (typeof wv === 'number' ? wv : 500) / 1000
    }
    return sum * fontSize * tz
  }

  const emitText = (bytes) => {
    const font = fontOf()
    const str = decodeString(bytes, font)
    const ncodes = font?.tounicode ? Math.floor(bytes.length / font.tounicode.codeLen) : bytes.length
    const adv = advance(bytes, font) + tw * (str.split(' ').length - 1) + tc * ncodes
    const m = matMul(ctm, tm)
    const [ux, uy] = matPt(m, 0, 0)
    const [dx, dy] = matPt(disp, ux, uy)
    // baseline direction + advance vector through the same transform
    const [ux2, uy2] = matPt(m, adv, 0)
    const [dx2, dy2] = matPt(disp, ux2, uy2)
    const dspW = Math.hypot(dx2 - dx, dy2 - dy)
    const ang = Math.atan2(dy2 - dy, dx2 - dx)
    const hh = Math.hypot(m[2], m[3]) * fontSize
    ops.push({
      t: 'text', x: dx, y: dy, w: dspW, h: hh, rot: ang,
      str: garbageRatio(str) < 0.4 ? str : '', size: fontSize * Math.hypot(m[0], m[1]),
    })
    // advance the text matrix in TEXT space: Tm' = Tm × T(adv,0)
    tm = matMul(tm, [1, 0, 0, 1, adv, 0])
  }

  for (const { op, operands } of tokenizeContent(data)) {
    switch (op) {
      case 'q': gstack.push({ ctm, tm, tlm }); break
      case 'Q': { const s = gstack.pop(); if (s) ({ ctm, tm, tlm } = s); break }
      case 'cm': if (operands.length === 6) ctm = matMul(operands.map(Number), ctm); break
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [...tm]; break
      case 'ET': break
      case 'Tf': {
        const nm = operands.find((o) => o.t === 'name')
        const sz = operands.find((o) => typeof o === 'number')
        if (nm) curFont = nm.v
        if (sz !== undefined) fontSize = sz
        break
      }
      case 'Td': case 'TD': {
        const [tx, ty] = [Number(operands[0]) || 0, Number(operands[1]) || 0]
        if (op === 'TD') leading = -ty
        // Tlm' = Tlm × T(tx,ty) — offset in text space, not user space
        tlm = matMul(tlm, [1, 0, 0, 1, tx, ty])
        tm = [...tlm]
        break
      }
      case 'T*': tlm = matMul(tlm, [1, 0, 0, 1, 0, -leading]); tm = [...tlm]; break
      case 'TL': leading = Number(operands[0]) || 0; break
      case 'Tm': if (operands.length === 6) { tm = operands.map(Number); tlm = [...tm] } break
      case 'Tc': tc = Number(operands[0]) || 0; break
      case 'Tw': tw = Number(operands[0]) || 0; break
      case 'Tz': tz = (Number(operands[0]) || 100) / 100; break
      case 'Tj': case "'": case '"': {
        if (op === "'" || op === '"') { tlm = matMul(tlm, [1, 0, 0, 1, 0, -leading]); tm = [...tlm] }
        const s = [...operands].reverse().find((o) => o.t === 'str')
        if (s) emitText(s.bytes)
        break
      }
      case 'TJ': {
        const arr = operands.find((o) => o.t === 'arr')
        if (!arr) break
        for (const it of arr.items) {
          if (it.t === 'str') emitText(it.bytes)
          else if (typeof it === 'number') {
            // kerning adjust: negative moves forward, in thousandths of em
            tm[4] += (-it / 1000) * fontSize * tz
          }
        }
        break
      }
      case 'Do': {
        const nm = [...operands].reverse().find((o) => o.t === 'name')
        if (!nm) break
        if (imgObj(nm.v)) {
          const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => matPt(disp, ...matPt(ctm, x, y)))
          const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
          ops.push({ t: 'img', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), rot: 0, key: imgKey(nm.v), ref: imgObj(nm.v) })
        }
        break
      }
      case 're': {
        const [rx, ry, rw, rh] = operands.map(Number)
        if ([rx, ry, rw, rh].every(Number.isFinite)) pathRects.push([rx, ry, rw, rh])
        break
      }
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'b': {
        for (const [rx, ry, rw, rh] of pathRects) {
          const corners = [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]].map(([x, y]) => matPt(disp, ...matPt(ctm, x, y)))
          const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
          ops.push({ t: 'rect', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), stroke: op === 'S' || op === 's' })
        }
        pathRects.length = 0
        break
      }
      case 'n': pathRects.length = 0; break
    }
  }
  return { ops, box }
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
/**
 * Decode one image XObject stream → {data, mime, ext} or null when unsupported.
 * Applies the full /Filter chain in order; a trailing image codec (DCT/JPX)
 * names the format, everything else is unwrapped as compression.
 */
export async function decodeImageStream(doc, v) {
  const w = get(v.dict, 'Width') ?? 0
  const h = get(v.dict, 'Height') ?? 0
  const filterVal = get(v.dict, 'Filter')
  const chain = (Array.isArray(filterVal) ? filterVal : filterVal === undefined ? [] : [filterVal]).map(
    (fl) => (isName(fl) ? fl.v : null),
  )
  const codec = { DCTDecode: ['.jpg', 'image/jpeg'], DCT: ['.jpg', 'image/jpeg'], JPXDecode: ['.jp2', 'image/jp2'], JPX: ['.jp2', 'image/jp2'] }
  const last = chain.length ? chain[chain.length - 1] : null
  const out = last ? codec[last] : undefined
  const decodeChain = out ? chain.slice(0, -1) : chain
  let data = v.data
  for (const fl of decodeChain) {
    if (fl === 'FlateDecode' || fl === 'Fl') data = await inflate(data)
    else return null
  }
  if (out) return { data, mime: out[1], ext: out[0] }
  if (!decodeChain.every((fl) => fl === 'FlateDecode' || fl === 'Fl' || fl === null)) return null
  const bpc = get(v.dict, 'BitsPerComponent') ?? 8
  let cs = get(v.dict, 'ColorSpace')
  if (isRef(cs)) cs = deref(doc, cs)
  const csName = isName(cs) ? cs.v : Array.isArray(cs) && isName(cs[0]) ? cs[0].v : null
  if (bpc !== 8 || (csName !== 'DeviceRGB' && csName !== 'DeviceGray')) return null
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
  if (raw.length !== w * h * colors) return null
  return { data: pngEncode(w, h, raw, colors === 1), mime: 'image/png', ext: '.png' }
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
