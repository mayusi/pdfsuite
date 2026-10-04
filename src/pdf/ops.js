import { concat, dec, enc, get, isHex, isName, isRef, isStream, isStr, name, ref, set, stream, typeIs } from './types.js'
import { deref, parsePdf, parseValue } from './parse.js'
import { newDoc, writeDoc } from './write.js'
import { deflate } from './env.js'
import { pngEncode } from '../png.js'
import { crc32 } from '../zip.js'
import { decodeImage } from './image.js'
import { readOutline, remapOutline, writeOutline } from './outline.js'
import { collectDrawOps, pageBox, pageRotation, pageText, streamData, textFromOps } from './content.js'

export const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

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
  // the VISIBLE box (CropBox ∩ MediaBox), exactly what rendering, the editor and stamping use
  return pageLeaves(doc).map((leaf) => {
    const b = pageBox(doc, leaf)
    return { w: +(b[2] - b[0]).toFixed(2), h: +(b[3] - b[1]).toFixed(2), rotate: pageRotation(doc, leaf) }
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
export function copyValue(v, src, dst, refMap) {
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
function buildCatalog(dst, pagesRef, kids, srcDoc, refMap, { skip = [], noInfo = false } = {}) {
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
      if (skip.includes(k)) continue
      const v = get(srcCat, k)
      if (v !== undefined) catDict.set(k, copyValue(v, srcDoc, dst, refMap))
    }
    const info = noInfo ? null : get(srcDoc.trailer, 'Info')
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

export function finishDoc(dst, pagesRef, kids, srcDoc, refMap) {
  const { catNum, trailer } = buildCatalog(dst, pagesRef, kids, srcDoc, refMap)
  return writeDoc(dst, catNum, trailer)
}

/**
 * Assemble a new PDF from pages of one or more parsed docs.
 * ops: [{doc, page (1-based), rotation?} | {blank: [w, h]}] in output order.
 * opts.names: per-doc titles → merge bookmarks ("file.pdf" › its own outline).
 * Bookmarks and form fields survive for pages that make it into the output;
 * references to dropped pages become null instead of dragging the whole
 * page (and its content) into the file as an orphan.
 */
async function assemble(docs, ops, { names = null, extrasFrom = null } = {}) {
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const leavesOf = docs.map((d) => pageLeaves(d))
  const refMaps = docs.map(() => new Map())
  const firstNew = docs.map(() => new Map()) // per doc: src leaf key → first output ref
  const nums = ops.map(() => dst.alloc())
  ops.forEach((o, i) => {
    kids.push(ref(nums[i], 0))
    if (o.blank) return
    const leaves = leavesOf[o.doc]
    if (!leaves || o.page < 1 || o.page > leaves.length) throw new Error(`page ${o.page} out of range`)
    const leaf = leaves[o.page - 1]
    if (isRef(leaf.ref)) {
      const key = `${leaf.ref.n} ${leaf.ref.g}`
      if (!firstNew[o.doc].has(key)) {
        firstNew[o.doc].set(key, ref(nums[i], 0))
        refMaps[o.doc].set(key, ref(nums[i], 0))
      }
    }
  })
  // dropped pages: references resolve to null, never to an orphan copy
  docs.forEach((d, di) => {
    for (const leaf of leavesOf[di]) {
      if (!isRef(leaf.ref)) continue
      const key = `${leaf.ref.n} ${leaf.ref.g}`
      if (!refMaps[di].has(key)) refMaps[di].set(key, null)
    }
  })
  ops.forEach((o, i) => {
    if (o.blank) {
      dst.set(nums[i], new Map([
        ['Type', name('Page')], ['Parent', ref(pagesRef, 0)],
        ['MediaBox', [0, 0, o.blank[0] ?? 612, o.blank[1] ?? 792]],
        ['Resources', new Map()],
      ]))
      return
    }
    writePage(docs[o.doc], leavesOf[o.doc][o.page - 1], nums[i], o.rotation || 0, dst, pagesRef, refMaps[o.doc])
  })

  // bookmarks
  const tree = []
  docs.forEach((d, di) => {
    const mapped = remapOutline(readOutline(d), (key) => firstNew[di].get(key) ?? null)
    if (names) {
      const firstOp = ops.findIndex((o) => !o.blank && o.doc === di)
      if (firstOp >= 0) tree.push({ title: names[di] ?? `Document ${di + 1}`, target: ref(nums[firstOp], 0), view: [name('Fit')], open: false, children: mapped })
    } else tree.push(...mapped)
  })

  // interactive form fields whose widgets landed on output pages
  const fields = []
  const usedNames = new Set()
  let formDA = null, formDR = null, needApp = false
  docs.forEach((d, di) => {
    const root = deref(d, get(d.trailer, 'Root'))
    const form = deref(d, get(root, 'AcroForm'))
    if (!(form instanceof Map)) return
    const top = deref(d, get(form, 'Fields'))
    if (!Array.isArray(top)) return
    const included = new Set([...firstNew[di].keys()])
    const onPage = (fref, depth = 0) => {
      const f = deref(d, fref)
      if (!(f instanceof Map) || depth > 20) return false
      const p = get(f, 'P')
      if (isRef(p) && included.has(`${p.n} ${p.g}`)) return true
      const ks = deref(d, get(f, 'Kids'))
      return Array.isArray(ks) && ks.some((k) => onPage(k, depth + 1))
    }
    for (const fref of top) {
      if (!onPage(fref)) continue
      const copied = copyValue(fref, d, dst, refMaps[di])
      if (!copied) continue
      const fd = dst.objects.get(copied.n)
      const t = fd instanceof Map ? get(fd, 'T') : null
      const tn = t?.bytes ? dec(t.bytes) : null
      if (tn !== null) {
        let nm = tn
        let k = 2
        while (usedNames.has(nm)) nm = `${tn}_${k++}`
        usedNames.add(nm)
        if (nm !== tn) fd.set('T', { k: 's', bytes: enc(nm) })
      }
      fields.push(copied)
    }
    formDA ??= get(form, 'DA') ?? null
    if (!formDR && get(form, 'DR') !== undefined) formDR = copyValue(get(form, 'DR'), d, dst, refMaps[di])
    if (get(form, 'NeedAppearances') === true) needApp = true
  })

  dst.set(pagesRef, new Map([['Type', name('Pages')], ['Kids', kids], ['Count', kids.length]]))
  const catNum = dst.alloc()
  const cat = new Map([['Type', name('Catalog')], ['Pages', ref(pagesRef, 0)]])
  const ol = writeOutline(dst, tree)
  if (ol) { cat.set('Outlines', ol); cat.set('PageMode', name('UseOutlines')) }
  if (fields.length) {
    const af = new Map([['Fields', fields]])
    if (formDA) af.set('DA', formDA)
    if (formDR) af.set('DR', formDR)
    if (needApp) af.set('NeedAppearances', true)
    cat.set('AcroForm', af)
  }
  const trailer = new Map()
  if (extrasFrom !== null) { // single-source rebuild: keep doc-level niceties
    const d = docs[extrasFrom]
    const srcRoot = deref(d, get(d.trailer, 'Root'))
    for (const k of ['Lang', 'ViewerPreferences', 'MarkInfo', 'PageLabels']) {
      const v = get(srcRoot, k)
      if (v !== undefined && k !== 'PageLabels') cat.set(k, copyValue(v, d, dst, refMaps[extrasFrom]))
    }
    const info = get(d.trailer, 'Info')
    if (info) { const iv = copyValue(info, d, dst, refMaps[extrasFrom]); if (iv) trailer.set('Info', iv) }
  }
  dst.set(catNum, cat)
  return writeDoc(dst, catNum, trailer)
}

/** Write one source page into dst as object `num` (inherited attrs flattened). */
function writePage(srcDoc, leaf, num, rotateDelta, dst, pagesRef, refMap, strip = []) {
  const pageDict = new Map()
  for (const k of INHERITED) {
    const v = get(leaf.dict, k) ?? leaf.inh[k]
    if (v !== undefined) pageDict.set(k, copyValue(v, srcDoc, dst, refMap))
  }
  for (const [k, val] of leaf.dict) {
    if (k === 'Parent' || k === 'Metadata' || k === 'StructParents' || INHERITED.includes(k) || strip.includes(k)) continue
    pageDict.set(k, copyValue(val, srcDoc, dst, refMap))
  }
  // a copied Annots array may hold nulls where an entry pointed at a dropped page
  const an = pageDict.get('Annots')
  if (Array.isArray(an)) pageDict.set('Annots', an.filter((x) => x !== null && x !== undefined))
  pageDict.set('Type', name('Page'))
  pageDict.set('Parent', ref(pagesRef, 0))
  if (rotateDelta) {
    const cur = get(pageDict, 'Rotate')
    const base = typeof cur === 'number' ? cur : 0
    pageDict.set('Rotate', ((base + rotateDelta) % 360 + 360) % 360)
  }
  dst.set(num, pageDict)
}

/**
 * Merge several PDFs (Uint8Array[]) into one, in order.
 * opts.names → one bookmark per file holding that file's own bookmarks.
 * opts.pages → per-input array of 1-based pages to take (default: all).
 */
export async function mergePdfs(inputs, { names = null, pages = null } = {}) {
  const docs = []
  for (const b of inputs) docs.push(await parsePdf(b))
  const ops = []
  docs.forEach((d, di) => {
    const n = pageLeaves(d).length
    const sel = pages?.[di] ?? Array.from({ length: n }, (_, i) => i + 1)
    for (const p of sel) ops.push(typeof p === 'object' ? { doc: di, ...p } : { doc: di, page: p })
  })
  return assemble(docs, ops, { names })
}

/**
 * Rebuild a PDF from an ordered op list (1-based source pages):
 * reorder by list order, delete by omission, rotate via `rotation` delta,
 * insert blank pages with {blank: [w, h]}, pull pages of extra PDFs with
 * {doc: k, page} where k indexes [main, ...opts.extra].
 */
export async function organizePages(bytes, ops, { extra = [] } = {}) {
  const docs = [await parsePdf(bytes)]
  for (const b of extra) docs.push(await parsePdf(b))
  return assemble(docs, ops.map((o) => (o.blank ? o : { doc: o.doc ?? 0, page: o.page, rotation: o.rotation })), { extrasFrom: 0 })
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
  let orientation = 1
  let adobe = false
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if (marker === 0xda) break // SOS — image data
    if (marker === 0xe1 && buf[i + 4] === 0x45 && buf[i + 5] === 0x78 && buf[i + 6] === 0x69 && buf[i + 7] === 0x66) {
      orientation = exifOrientation(buf, i + 10, i + 2 + len) || 1
    }
    if (marker === 0xee && buf[i + 4] === 0x41 && buf[i + 5] === 0x64 && buf[i + 6] === 0x6f && buf[i + 7] === 0x62 && buf[i + 8] === 0x65) adobe = true
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = (buf[i + 5] << 8) | buf[i + 6]
      const width = (buf[i + 7] << 8) | buf[i + 8]
      const comps = buf[i + 9]
      const cs = comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB'
      return { width, height, colorSpace: cs, orientation, adobe }
    }
    i += 2 + len
  }
  throw new Error('JPEG SOF marker not found')
}

/** EXIF IFD0 orientation tag (0x0112) from a TIFF block at [t, end). */
function exifOrientation(buf, t, end) {
  const le = buf[t] === 0x49
  const u16 = (o) => (le ? buf[o] | (buf[o + 1] << 8) : (buf[o] << 8) | buf[o + 1])
  const u32 = (o) => (le ? (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0 : ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0)
  const ifd = t + u32(t + 4)
  if (ifd + 2 > end) return 1
  const n = u16(ifd)
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > end) break
    if (u16(e) === 0x0112) return u16(e + 8)
  }
  return 1
}

/** EXIF orientation → clockwise rotation in degrees (mirrored variants approximated). */
export const exifRotation = (o) => ({ 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 })[o] ?? 0

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a3: [841.89, 1190.55], a5: [419.53, 595.28] }

/**
 * Images → PDF, one image per page.
 * images: [{data|jpeg: Uint8Array (JPEG)} | {rgba, width, height}] + optional rotate (deg, clockwise).
 *   JPEGs are embedded losslessly; their EXIF orientation is honoured.
 *   RGBA images keep transparency (soft mask).
 * opts: size 'fit' (page = image at `dpi`) | 'a4' | 'letter' | 'legal' | 'a3' | 'a5'
 *       ('native' = legacy 1px→1pt), orient 'auto'|'portrait'|'landscape', margin (pt),
 *       fit 'contain'|'cover'|'stretch', dpi (default 96).
 */
export async function imagesToPdf(images, opts = {}) {
  const { size = 'fit', orient = 'auto', margin = 0, fit = 'contain', dpi = 96 } = opts
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  for (const img of images) {
    let width, height, imgDict, imgData, rot = ((img.rotate ?? 0) % 360 + 360) % 360
    const jpeg = img.jpeg ?? img.data
    if (jpeg) {
      const info = jpegInfo(jpeg)
      width = info.width
      height = info.height
      rot = (rot + exifRotation(info.orientation)) % 360
      imgDict = new Map([
        ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', width], ['Height', height],
        ['ColorSpace', name(info.colorSpace)], ['BitsPerComponent', 8], ['Filter', name('DCTDecode')],
      ])
      if (info.colorSpace === 'DeviceCMYK' && info.adobe) imgDict.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0])
      imgData = jpeg
    } else {
      width = img.width
      height = img.height
      const n = width * height
      const rgb = new Uint8Array(n * 3)
      const alpha = new Uint8Array(n)
      let hasAlpha = false
      for (let k = 0, j = 0; k < n; k++, j += 4) {
        rgb[k * 3] = img.rgba[j]; rgb[k * 3 + 1] = img.rgba[j + 1]; rgb[k * 3 + 2] = img.rgba[j + 2]
        alpha[k] = img.rgba[j + 3]
        if (img.rgba[j + 3] !== 255) hasAlpha = true
      }
      imgDict = new Map([
        ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', width], ['Height', height],
        ['ColorSpace', name('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', name('FlateDecode')],
      ])
      if (hasAlpha) {
        const sm = dst.alloc()
        dst.set(sm, stream(new Map([
          ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', width], ['Height', height],
          ['ColorSpace', name('DeviceGray')], ['BitsPerComponent', 8], ['Filter', name('FlateDecode')],
        ]), await deflate(alpha)))
        imgDict.set('SMask', ref(sm, 0))
      }
      imgData = await deflate(rgb)
    }
    const imgNum = dst.alloc()
    dst.set(imgNum, stream(imgDict, imgData))
    // displayed (post-rotation) image size
    const swap = rot % 180 !== 0
    const vw = swap ? height : width, vh = swap ? width : height
    let pw, ph
    if (size === 'native' || size === 'fit') {
      const k = size === 'native' ? 1 : 72 / (dpi || 96)
      pw = vw * k + margin * 2
      ph = vh * k + margin * 2
    } else {
      const [bw, bh] = PAGE_SIZES[size] ?? PAGE_SIZES.a4
      const landscape = orient === 'landscape' || (orient === 'auto' && vw > vh)
      ;[pw, ph] = landscape ? [Math.max(bw, bh), Math.min(bw, bh)] : [Math.min(bw, bh), Math.max(bw, bh)]
    }
    const cw = Math.max(1, pw - margin * 2), ch = Math.max(1, ph - margin * 2)
    let dw, dh
    if (fit === 'stretch') { dw = cw; dh = ch }
    else { const sc = fit === 'cover' ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh); dw = vw * sc; dh = vh * sc }
    const x = (pw - dw) / 2, y = (ph - dh) / 2
    // unit square → displayed box, rotated clockwise by `rot`
    const f = (v) => +v.toFixed(3)
    const m = rot === 90 ? [0, -dh, dw, 0, x, y + dh]
      : rot === 180 ? [-dw, 0, 0, -dh, x + dw, y + dh]
      : rot === 270 ? [0, dh, -dw, 0, x + dw, y]
      : [dw, 0, 0, dh, x, y]
    const clip = fit === 'cover' ? `${f(margin)} ${f(margin)} ${f(cw)} ${f(ch)} re W n ` : ''
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), new TextEncoder().encode(`q ${clip}${m.map(f).join(' ')} cm /Im0 Do Q`)))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesRef, 0)], ['MediaBox', [0, 0, f(pw), f(ph)]],
      ['Resources', new Map([['XObject', new Map([['Im0', ref(imgNum, 0)]])]])],
      ['Contents', ref(csNum, 0)],
    ]))
    kids.push(ref(pageNum, 0))
  }
  return finishDoc(dst, pagesRef, kids)
}

const KEEP_ANNOTS = new Set(['Link', 'Widget'])
const PERSONAL_ANNOT_KEYS = ['T', 'M', 'NM', 'CreationDate', 'RC', 'Subj']

/**
 * Privacy scrub: drops /Info, XMP /Metadata (catalog + pages), doc IDs and
 * /PieceInfo app data; anonymises what's left of annotations. Bookmarks,
 * links and form fields survive — they're content, not tracking data.
 * opts.removeComments (default true): also drop comment/markup annotations
 * (sticky notes, highlights, ink, stamps…) which carry author names + text.
 */
export async function scrubPdf(bytes, { removeComments = true } = {}) {
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  // filter + anonymise annotations IN THE SOURCE before copying: anything
  // copied and dropped afterwards would still be written as an orphan object
  // (and its comment text would survive in the file)
  for (const leaf of leaves) {
    const an = deref(src, get(leaf.dict, 'Annots'))
    if (!Array.isArray(an)) continue
    const keep = []
    for (const r of an) {
      const ad = deref(src, r)
      if (!(ad instanceof Map)) continue
      const sub = get(ad, 'Subtype')?.v
      if (removeComments && !KEEP_ANNOTS.has(sub)) continue
      // on widgets /T is the FIELD NAME, not an author — keep it
      for (const k of PERSONAL_ANNOT_KEYS) if (!(sub === 'Widget' && (k === 'T' || k === 'RC'))) ad.delete(k)
      ad.delete('Popup')
      keep.push(r)
    }
    if (keep.length) leaf.dict.set('Annots', keep)
    else leaf.dict.delete('Annots')
  }
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const refMap = new Map()
  appendPages(src, leaves.map((leaf) => ({ leaf, rotateDelta: 0 })), dst, pagesRef, kids, ['PieceInfo', 'LastModified'], refMap)
  const { catNum, trailer } = buildCatalog(dst, pagesRef, kids, src, refMap, { skip: ['Metadata'], noInfo: true })
  trailer.delete('ID')
  return writeDoc(dst, catNum, trailer)
}

// ---------- text extraction ----------

/** All pages → ['page 1 text', ...]. */
export async function extractText(doc) {
  const leaves = pageLeaves(doc)
  const out = []
  for (const leaf of leaves) out.push(await pageText(doc, leaf))
  return out
}

// ---------- compress ----------

/**
 * Rebuild keeping only reachable objects, re-deflate every stream that gets
 * smaller, merge byte-identical streams (fonts/images repeated across merged
 * files), optionally strip metadata + page thumbnails, and — through the
 * browser hook — re-encode/downscale photos.
 * opts.reimage(decoded, {w, h}) → Promise<Uint8Array JPEG | null>
 * opts.stripMeta: drop /Info + XMP; opts.stripThumbs (default true): drop page /Thumb images.
 * Returns { bytes, before, after, images: {total, recoded} }.
 */
export async function compressPdf(bytes, { reimage, stripMeta = false, stripThumbs = true } = {}) {
  const src = await parsePdf(bytes)
  const leaves = pageLeaves(src)
  if (stripThumbs) for (const leaf of leaves) { leaf.dict.delete('Thumb'); leaf.dict.delete('PieceInfo') }
  const dst = newDoc()
  const pagesRef = dst.alloc()
  const kids = []
  const refMap = new Map()
  appendPages(src, leaves.map((leaf) => ({ leaf, rotateDelta: 0 })), dst, pagesRef, kids, [], refMap)
  const { catNum, trailer } = buildCatalog(dst, pagesRef, kids, src, refMap, stripMeta ? { skip: ['Metadata'], noInfo: true } : {})
  const dstDoc = { objects: new Map(), trailer: new Map() }
  for (const [num, v] of dst.objects) dstDoc.objects.set(`${num} 0`, { v })
  // soft masks are alpha channels — never JPEG them (halos), and skip stencils
  const smaskNums = new Set()
  for (const v of dst.objects.values()) {
    if (isStream(v)) { const sm = get(v.dict, 'SMask'); if (isRef(sm)) smaskNums.add(sm.n) }
  }
  const stats = { total: 0, recoded: 0 }
  for (const [num, v] of dst.objects) {
    if (!isStream(v)) continue
    const isImage = get(v.dict, 'Subtype')?.v === 'Image'
    if (isImage && !smaskNums.has(num) && get(v.dict, 'ImageMask') !== true) {
      stats.total++
      const bpc = get(v.dict, 'BitsPerComponent') ?? 8
      if (reimage && bpc >= 8) {
        const dec = await decodeImageStream(dstDoc, v).catch(() => null)
        const repl = dec ? await reimage(dec, { w: get(v.dict, 'Width'), h: get(v.dict, 'Height') }).catch(() => null) : null
        if (repl && repl.length < v.data.length * 0.95) {
          const info = jpegInfo(repl)
          v.data = repl
          v.dict.set('Filter', name('DCTDecode'))
          v.dict.set('ColorSpace', name(info.colorSpace))
          v.dict.set('BitsPerComponent', 8)
          v.dict.set('Width', info.width) // the hook may have downscaled (any SMask still maps 1:1 onto the unit square)
          v.dict.set('Height', info.height)
          for (const k of ['DecodeParms', 'DP', 'Decode', 'Mask']) v.dict.delete(k)
          stats.recoded++
          continue
        }
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
  dedupeStreams(dst)
  const out = writeDoc(dst, catNum, trailer)
  return { bytes: out, before: bytes.length, after: out.length, images: stats }
}

/** Merge byte-identical stream objects and repoint every reference to the survivor. */
function dedupeStreams(dst) {
  const seen = new Map() // key → num
  const remap = new Map() // dup num → keeper num
  for (const [num, v] of dst.objects) {
    if (!isStream(v) || v.data.length < 64) continue
    const dictKey = [...v.dict].filter(([k]) => k !== 'Length').map(([k, x]) => `${k}=${JSON.stringify(x, (_, y) => (y instanceof Uint8Array ? [...y] : y instanceof Map ? [...y] : y))}`).sort().join('|')
    const key = `${crc32(v.data)}:${v.data.length}:${dictKey}`
    const prev = seen.get(key)
    if (prev !== undefined && bytesEqual(dst.objects.get(prev).data, v.data)) remap.set(num, prev)
    else seen.set(key, num)
  }
  if (!remap.size) return
  const fix = (x) => {
    if (isRef(x)) return remap.has(x.n) ? ref(remap.get(x.n), 0) : x
    if (x instanceof Map) { for (const [k, y] of x) x.set(k, fix(y)); return x }
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) x[i] = fix(x[i]); return x }
    if (isStream(x)) { fix(x.dict); return x }
    return x
  }
  for (const v of dst.objects.values()) fix(v)
  for (const n of remap.keys()) dst.objects.delete(n)
}
const bytesEqual = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }

/**
 * Best-effort visual for a page when rendering fails: {img: {data, mime} | null, text}.
 * img = the largest painted image XObject; text = the page's first characters.
 */
export async function pagePreview(doc, leaf, maxLen = 200) {
  const { ops } = await collectDrawOps(doc, leaf, { annots: false }).catch(() => ({ ops: [] }))
  const text = textFromOps(ops).replace(/\s+/g, ' ').trim().slice(0, maxLen)
  let best = null
  for (const o of ops) if (o.t === 'img' && o.ref && (!best || o.w * o.h > best.w * best.h)) best = o
  return { img: best ? await decodeImageStream(doc, best.ref).catch(() => null) : null, text }
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
