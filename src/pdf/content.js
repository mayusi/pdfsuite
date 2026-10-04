// Page content interpreter: tokenizer (with byte offsets + inline images),
// fonts / text decoding, and the walker that turns a page's operators into
// positioned display-space draw ops for the renderer, text extraction,
// redaction and text editing.
import { concat, dec, get, isName, isRef, isStream } from './types.js'
import { deref } from './parse.js'
import { decodeChain } from './filters.js'
import { simpleEncodingTable } from './encodings.js'
import { resolveColorSpace } from './image.js'
import { compileFunction } from './functions.js'

// ---------- content bytes + tokenizer ----------

/** Decode a stream through its whole filter chain → bytes (null for image codecs / unsupported). */
export async function streamData(s) {
  try {
    const { data, codec } = await decodeChain(s.dict, s.data, { stopAtImage: true })
    return codec ? null : data
  } catch {
    return null
  }
}

/**
 * A page's decoded Contents, concatenated with a newline between streams
 * (streams may split mid-object but tokens must never fuse: "ET"+"BT").
 * Returns null when nothing decodes.
 */
export async function contentBytes(doc, leaf) {
  let c = get(leaf.dict, 'Contents')
  if (isRef(c)) c = deref(doc, c)
  const streams = isStream(c) ? [c]
    : Array.isArray(c) ? c.map((x) => deref(doc, x)).filter(isStream)
    : []
  const parts = []
  for (const s of streams) {
    const d = await streamData(s)
    if (d === null) continue // one broken stream shouldn't blank the whole page
    if (parts.length) parts.push(NL)
    parts.push(d)
  }
  return parts.length ? concat(parts) : null
}
const NL = new Uint8Array([10])

/**
 * Content-stream tokenizer → [{op, operands, start, end}] where start/end are
 * byte offsets covering the operands + operator (for in-place rewriting).
 * Operands: numbers, booleans, null, {t:'name',v}, {t:'str',bytes,hex?},
 * {t:'arr',items}, {t:'dict',v:Map} (inline dicts e.g. BDC properties).
 * Inline images arrive as one op: {op:'BI', dict: Map, data: Uint8Array}.
 */
export function tokenizeContent(data) {
  const ops = []
  let operands = []
  let opStart = -1
  let i = 0
  const n = data.length
  const isWS = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32
  const isDelim = (c) => isWS(c) || c === 0x5b || c === 0x5d || c === 0x3c || c === 0x3e || c === 0x28 || c === 0x29 || c === 0x2f || c === 0x25 || c === 0x7b || c === 0x7d
  const stack = [] // open arrays / dicts: {kind, at: operands length}
  const mark = () => { if (opStart < 0) opStart = i }
  const readName = () => {
    let j = i + 1
    while (j < n && !isDelim(data[j])) j++
    let nm = ''
    for (let k = i + 1; k < j; k++) {
      if (data[k] === 0x23 && k + 2 < j) {
        const hv = parseInt(String.fromCharCode(data[k + 1], data[k + 2]), 16)
        if (!Number.isNaN(hv)) { nm += String.fromCharCode(hv); k += 2; continue }
      }
      nm += String.fromCharCode(data[k])
    }
    i = j
    return { t: 'name', v: nm }
  }
  while (i < n) {
    const c = data[i]
    if (isWS(c)) { i++; continue }
    if (c === 0x25) { while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++; continue }
    mark()
    if (c === 0x2f) { operands.push(readName()); continue }
    if (c === 0x28) {
      let j = i + 1, depth = 1
      const bytes = []
      while (j < n && depth) {
        const b = data[j]
        if (b === 0x5c) {
          const e = data[j + 1]
          if (e === 0x0a) { j += 2; continue }
          if (e === 0x0d) { j += data[j + 2] === 0x0a ? 3 : 2; continue }
          const esc = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c }[e]
          if (esc !== undefined) { bytes.push(esc); j += 2; continue }
          if (e >= 0x30 && e <= 0x37) {
            let oct = 0, k = 0
            while (k < 3 && data[j + 1 + k] >= 0x30 && data[j + 1 + k] <= 0x37) { oct = oct * 8 + (data[j + 1 + k] - 0x30); k++ }
            bytes.push(oct & 0xff); j += 1 + k; continue
          }
          bytes.push(e); j += 2; continue
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
      if (data[i + 1] === 0x3c) { stack.push({ kind: 'dict', at: operands.length }); i += 2; continue }
      let j = i + 1, hexs = ''
      while (j < n && data[j] !== 0x3e) { if (!isWS(data[j])) hexs += String.fromCharCode(data[j]); j++ }
      const bytes = new Uint8Array(Math.ceil(hexs.length / 2))
      for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hexs.slice(k * 2, k * 2 + 2).padEnd(2, '0'), 16)
      operands.push({ t: 'str', bytes, hex: true })
      i = j + 1
      continue
    }
    if (c === 0x3e && data[i + 1] === 0x3e) {
      const top = stack.pop()
      i += 2
      if (top?.kind === 'dict') {
        const items = operands.splice(top.at)
        const m = new Map()
        for (let k = 0; k + 1 < items.length; k += 2) if (items[k]?.t === 'name') m.set(items[k].v, items[k + 1])
        operands.push({ t: 'dict', v: m })
      }
      continue
    }
    if (c === 0x5b) { stack.push({ kind: 'arr', at: operands.length }); i++; continue }
    if (c === 0x5d) {
      const top = stack.pop()
      i++
      if (top?.kind === 'arr') operands.push({ t: 'arr', items: operands.splice(top.at) })
      continue
    }
    if (c === 0x7b || c === 0x7d) { i++; continue } // PostScript braces (type-4 leakage) — ignore
    let j = i
    while (j < n && !isDelim(data[j])) j++
    const tok = dec(data.subarray(i, j))
    i = j
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { operands.push(parseFloat(tok)); continue }
    if (/^[+-]?\d*\.\d*\.\d*$|^--?\d/.test(tok)) { operands.push(parseFloat(tok.replace(/^--/, '-')) || 0); continue } // malformed numbers seen in the wild
    if (tok === 'true' || tok === 'false' || tok === 'null') { operands.push(tok === 'true' ? true : tok === 'false' ? false : null); continue }
    if (stack.length) { // an operator inside an unclosed array/dict: treat as junk name
      operands.push({ t: 'name', v: tok })
      continue
    }
    if (tok === 'BI') {
      // inline image: key/value pairs until ID, one whitespace byte, raw data until EI
      const start = opStart
      const pairs = []
      while (i < n) {
        while (i < n && isWS(data[i])) i++
        if (data[i] === 0x2f) { pairs.push(readName()); continue }
        let k = i
        while (k < n && !isDelim(data[k])) k++
        const word = dec(data.subarray(i, k))
        if (word === 'ID') { i = k; break }
        // a value: reuse the value tokenizer on a tiny slice
        if (data[i] === 0x5b) {
          let depth = 0, e = i
          do { if (data[e] === 0x5b) depth++; else if (data[e] === 0x5d) depth--; e++ } while (e < n && depth)
          const sub = tokenizeContent(concat([data.subarray(i, e), new Uint8Array([32, 0x6e])]))
          pairs.push(sub[0]?.operands[0] ?? null)
          i = e
        } else if (data[i] === 0x3c || data[i] === 0x28) {
          const sub = tokenizeContent(concat([data.subarray(i, Math.min(n, i + 4096)), new Uint8Array([32, 0x6e])]))
          pairs.push(sub[0]?.operands[0] ?? null)
          // advance past the string/hex
          if (data[i] === 0x3c) { while (i < n && data[i] !== 0x3e) i++; i++ } else {
            let depth = 0
            do { if (data[i] === 0x5c) i++; else if (data[i] === 0x28) depth++; else if (data[i] === 0x29) depth--; i++ } while (i < n && depth)
          }
        } else {
          pairs.push(/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) ? parseFloat(word) : word === 'true' ? true : word === 'false' ? false : { t: 'name', v: word })
          i = k
        }
      }
      if (i < n && isWS(data[i])) i++
      const dict = new Map()
      for (let k = 0; k + 1 < pairs.length; k += 2) if (pairs[k]?.t === 'name') dict.set(pairs[k].v, contentToPdfVal(pairs[k + 1]))
      // EI must be preceded by whitespace and followed by a delimiter; for
      // uncompressed images the byte count is known and checked first
      const ds = i
      let de = -1
      const w = dict.get('W') ?? dict.get('Width'), h = dict.get('H') ?? dict.get('Height')
      const filt = dict.get('F') ?? dict.get('Filter')
      if (!filt && typeof w === 'number' && typeof h === 'number') {
        const im = dict.get('IM') ?? dict.get('ImageMask')
        const bpc = im === true ? 1 : dict.get('BPC') ?? dict.get('BitsPerComponent') ?? 8
        const cs = dict.get('CS') ?? dict.get('ColorSpace')
        const csn = cs?.k === 'n' ? cs.v : ''
        const comps = im === true ? 1 : /RGB/.test(csn) ? 3 : /CMYK/.test(csn) ? 4 : 1
        const len = Math.ceil((w * comps * bpc) / 8) * h
        let e = ds + len
        while (e < n && isWS(data[e])) e++
        if (data[e] === 0x45 && data[e + 1] === 0x49) { de = ds + len; i = e + 2 }
      }
      if (de < 0) {
        while (i < n) {
          if (isWS(data[i]) && data[i + 1] === 0x45 && data[i + 2] === 0x49 && (i + 3 >= n || isDelim(data[i + 3]))) { de = i; i += 3; break }
          i++
        }
        if (de < 0) { de = n; i = n }
      }
      ops.push({ op: 'BI', operands: [], dict, data: data.slice(ds, de), start, end: i })
      operands = []
      opStart = -1
      continue
    }
    ops.push({ op: tok, operands, start: opStart, end: i })
    operands = []
    opStart = -1
  }
  return ops
}

/** Content-tokenizer operand → parser-style PDF value (for inline image dicts). */
function contentToPdfVal(v) {
  if (v?.t === 'name') return { k: 'n', v: v.v }
  if (v?.t === 'str') return { k: v.hex ? 'x' : 's', bytes: v.bytes }
  if (v?.t === 'arr') return v.items.map(contentToPdfVal)
  if (v?.t === 'dict') { const m = new Map(); for (const [k, x] of v.v) m.set(k, contentToPdfVal(x)); return m }
  return v
}

// ---------- fonts ----------

/** Parse a /ToUnicode CMap stream → {map: Map<code,string>, codeLen}. */
export function parseToUnicode(data) {
  const src = dec(data)
  const hex = (s) => parseInt(s, 16)
  const uni = (s) => {
    let out = ''
    for (let i = 0; i + 4 <= s.length; i += 4) out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16))
    if (s.length === 2) out = String.fromCharCode(parseInt(s, 16))
    return out
  }
  const map = new Map()
  let codeLen = 1
  const cs = src.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/)
  if (cs) codeLen = Math.max(1, cs[1].length / 2)
  for (const b of src.matchAll(/beginbf(char|range)([\s\S]*?)endbf\1/g)) {
    const [, kind, body] = b
    if (kind === 'char') {
      for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
        codeLen = Math.max(codeLen, m[1].length / 2)
        map.set(hex(m[1]), uni(m[2]))
      }
    } else {
      for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<([0-9A-Fa-f]+)>)/g)) {
        codeLen = Math.max(codeLen, m[1].length / 2)
        const lo = hex(m[1]), hi = Math.min(hex(m[2]), lo + 65535)
        if (m[4] !== undefined) {
          // increment the LAST code unit of the destination
          const base = m[4]
          const head = base.slice(0, -4), tail = hex(base.slice(-4) || '0')
          for (let c = lo; c <= hi; c++) map.set(c, uni(head + (tail + c - lo).toString(16).padStart(4, '0')))
        } else for (const [k, dm] of [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].entries()) map.set(lo + k, uni(dm[1]))
      }
    }
  }
  return { map, codeLen }
}

const FONT_CACHE = new WeakMap() // font dict → parsed info (fonts repeat on every page)

/** Resolve a page's /Resources /Font → Map<name, fontInfo>. */
export async function fontMap(doc, leaf) {
  const res = deref(doc, get(leaf.dict, 'Resources') ?? leaf.inh.Resources)
  return fontMapFromRes(doc, res)
}

/** Font name → info {widths, firstChar, wRanges, dw, codeLen, tounicode, enc, base, bold, italic, serif, mono, fm}. */
export async function fontMapFromRes(doc, res) {
  let fonts = res instanceof Map ? get(res, 'Font') : null
  fonts = deref(doc, fonts)
  const out = new Map()
  if (!(fonts instanceof Map)) return out
  for (const [fname, fref] of fonts) {
    let fd = deref(doc, fref)
    if (isStream(fd)) fd = fd.dict
    if (!(fd instanceof Map)) continue
    const hit = FONT_CACHE.get(fd)
    if (hit) { out.set(fname, hit); continue }
    const info = await parseFont(doc, fd)
    FONT_CACHE.set(fd, info)
    out.set(fname, info)
  }
  return out
}

async function parseFont(doc, fd) {
  const info = { widths: null, firstChar: 0, wRanges: null, tounicode: null, codeLen: null, dw: null, fm: 0.001 }
  const sub = get(fd, 'Subtype')?.v
  const isCid = sub === 'Type0' || get(fd, 'DescendantFonts') !== undefined
  if (isCid) info.codeLen = 2
  let cidFd = fd
  const desc = deref(doc, get(fd, 'DescendantFonts'))
  if (Array.isArray(desc) && desc.length) {
    let d0 = deref(doc, desc[0])
    if (isStream(d0)) d0 = d0.dict
    if (d0 instanceof Map) cidFd = d0
  }
  info.dw = deref(doc, get(cidFd, 'DW')) ?? null
  const w = deref(doc, get(fd, 'Widths'))
  if (Array.isArray(w)) info.widths = w.map((x) => deref(doc, x))
  info.firstChar = deref(doc, get(fd, 'FirstChar')) ?? 0
  if (sub === 'Type3') { // glyph space → text space via FontMatrix
    const fmx = deref(doc, get(fd, 'FontMatrix'))
    if (Array.isArray(fmx)) info.fm = Number(fmx[0]) || 0.001
  }
  const wArr = deref(doc, get(cidFd, 'W') ?? get(fd, 'W'))
  if (Array.isArray(wArr)) {
    info.wRanges = new Map()
    for (let i = 0; i < wArr.length;) {
      const a = deref(doc, wArr[i]), b = deref(doc, wArr[i + 1])
      if (typeof a === 'number' && Array.isArray(b)) {
        b.forEach((ww, k) => info.wRanges.set(a + k, deref(doc, ww)))
        i += 2
      } else if (typeof a === 'number' && typeof b === 'number' && typeof deref(doc, wArr[i + 2]) === 'number') {
        const ww = deref(doc, wArr[i + 2])
        for (let c = a; c <= b && c - a < 65536; c++) info.wRanges.set(c, ww)
        i += 3
      } else i++
    }
  }
  // style hints for the renderer
  let base = get(fd, 'BaseFont')
  base = isName(base) ? base.v.replace(/^[A-Z]{6}\+/, '') : ''
  let fdesc = deref(doc, get(cidFd, 'FontDescriptor') ?? get(fd, 'FontDescriptor'))
  const flags = fdesc instanceof Map ? deref(doc, get(fdesc, 'Flags')) ?? 0 : 0
  const lname = base.toLowerCase()
  info.base = base
  info.bold = /bold|black|heavy|semibold|demi|,b\b|-b\b|cmbx|ssbx/.test(lname) || (fdesc instanceof Map && (deref(doc, get(fdesc, 'FontWeight')) ?? 400) >= 600) || !!(flags & 262144)
  info.italic = /italic|oblique|ital\b|-it\b|,i\b|cmti|cmsl|cmmi|ssi\d|-obl/.test(lname) || !!(flags & 64)
  info.mono = /courier|mono|consol|menlo|cmtt|typewriter|code/.test(lname) || !!(flags & 1)
  const SANS = /sans|arial|helvetica|cmss|verdana|tahoma|calibri|segoe|frutiger|futura|gill|myriad|roboto|open ?sans|lato|inter|ubuntu|gothic|nimbussan|liberationsans|dejavusans|notosans|source ?sans|franklin|avenir|trebuchet|lucida ?grande|yahei|meiryo/
  const SERIF = /times|serif|roman|roma\b|georgia|garamond|cmr\d|cmti|cmbx|cmsl|cmmi|cmsy|eur[a-z]*\d|lmroman|minion|palatino|palladio|pazo|book|cambria|constantia|nimbusrom|schoolbook|century|libertine|charter|utopia|baskerville|caslon|sabon|bembo|didot|bodoni|pagella|termes|bonum|schola|merriweather|lora|mincho|songti|simsun/
  info.serif = !info.mono && !SANS.test(lname) && (SERIF.test(lname) || !!(flags & 2))
  info.symbol = /symbol|dingbat|wingding/.test(lname)
  info.type3 = sub === 'Type3'
  if (!isCid) {
    const encv = deref(doc, get(fd, 'Encoding'))
    info.enc = simpleEncodingTable(encv, { symbolic: !!(flags & 4) && !encv })
  }
  const tu = deref(doc, get(fd, 'ToUnicode'))
  if (isStream(tu)) {
    const d = await streamData(tu).catch(() => null)
    if (d) {
      info.tounicode = parseToUnicode(d)
      if (isCid) info.tounicode.codeLen = 2 // Identity-H/V codes are always 2 bytes
    }
  }
  return info
}

/** Decode a PDF string operand using a font entry. */
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
    if ((c < 0x20 && ch !== ' ' && ch !== '\t') || (c >= 0x7f && c <= 0x9f) || (c >= 0xe000 && c <= 0xf8ff)) bad++
  }
  return bad / s.length
}

// ---------- geometry ----------

export const matMul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]
export const matPt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** user→display transform (top-left origin, /Rotate applied clockwise). */
export function displayTransform(mb, rot) {
  const [x0, y0, x1, y1] = mb
  if (rot === 90) return [0, 1, 1, 0, -y0, -x0]
  if (rot === 180) return [-1, 0, 0, 1, x1, -y0]
  if (rot === 270) return [0, -1, -1, 0, y1, x1]
  return [1, 0, 0, -1, -x0, y1]
}

/** Effective page box: CropBox ∩ MediaBox (what viewers show). */
export function pageBox(doc, leaf) {
  const num = (a) => (Array.isArray(a) && a.length === 4 ? a.map((v) => Number(deref(doc, v))) : null)
  const mb = num(deref(doc, get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox)) ?? [0, 0, 612, 792]
  const norm = (b) => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]
  let box = norm(mb)
  const cb = num(deref(doc, get(leaf.dict, 'CropBox') ?? leaf.inh.CropBox))
  if (cb) {
    const c = norm(cb)
    const ix = [Math.max(box[0], c[0]), Math.max(box[1], c[1]), Math.min(box[2], c[2]), Math.min(box[3], c[3])]
    if (ix[2] - ix[0] > 1 && ix[3] - ix[1] > 1) box = ix
  }
  return box
}

export function pageRotation(doc, leaf) {
  const r = deref(doc, get(leaf.dict, 'Rotate') ?? leaf.inh.Rotate ?? 0)
  return typeof r === 'number' ? ((Math.round(r / 90) * 90) % 360 + 360) % 360 : 0
}

// ---------- the walker ----------

/**
 * Interpret a page into display-space draw ops.
 * Returns {ops, box:{w,h}, rot, mb, disp}. ops:
 *   text  {x,y,w,h,rot,str,size,fc,sc,a,sa,mode,inv,font,m,glyphs?,src?}
 *         m = display matrix of the run origin (text space → display, size baked in)
 *         glyphs = [{x (text-space advance from origin, in em*size units), w, s}]
 *   img   {x,y,w,h,rot,mirror,m,ref|inline,a,fill,key}
 *   rect/path {segs|x,y,w,h, fill,stroke,fc,sc,a,sa,lw,dash,doff,eo,cap,join,blend}
 *   shade {kind:'axial'|'radial', coords (display), stops:[[t,[r,g,b]]], extend, a} (fills current clip)
 *   clip / unclip
 * opts.glyphs: per-glyph geometry + source op references (redaction / editing).
 * opts.annots: also paint annotation appearance streams (default true).
 */
export async function collectDrawOps(doc, leaf, { glyphs = false, annots = true, widgets = true } = {}) {
  const box4 = pageBox(doc, leaf)
  const rot = pageRotation(doc, leaf)
  const w = box4[2] - box4[0], hgt = box4[3] - box4[1]
  const box = { w: rot % 180 === 0 ? w : hgt, h: rot % 180 === 0 ? hgt : w }
  const res = deref(doc, get(leaf.dict, 'Resources') ?? leaf.inh.Resources)
  const disp = displayTransform(box4, rot)
  const st = newState(disp)
  st.glyphs = glyphs
  st.ops = []
  st.csCache = new Map()
  const data = await contentBytes(doc, leaf)
  if (data) {
    st.srcTokens = glyphs ? tokenizeContent(data) : null
    await walk(doc, st, data, res, await fontMapFromRes(doc, res), st.srcTokens, [])
  }
  if (annots) await paintAnnotations(doc, leaf, st, res, widgets)
  return { ops: st.ops, box, rot, mb: box4, disp, data, tokens: st.srcTokens }
}

function newState(disp) {
  return {
    ops: [], disp,
    ctm: [1, 0, 0, 1, 0, 0], gstack: [],
    tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0],
    leading: 0, fontSize: 0, curFont: null, tc: 0, tw: 0, tz: 1, tr: 0, rise: 0,
    path: [], cur: null,
    fillC: [0, 0, 0], strokeC: [0, 0, 0], fillA: 1, strokeA: 1, blend: null,
    fillCS: null, strokeCS: null, fillPat: null, strokePat: null,
    lw: 1, cap: 0, join: 0, dash: null, dashPhase: 0, clipLevels: [], depth: 0,
  }
}

const GSTATE_KEYS = ['ctm', 'tm', 'tlm', 'fillC', 'strokeC', 'fillA', 'strokeA', 'blend', 'fillCS', 'strokeCS', 'fillPat', 'strokePat',
  'lw', 'cap', 'join', 'dash', 'dashPhase', 'curFont', 'fontSize', 'tc', 'tw', 'tz', 'tr', 'leading', 'rise']
const snap = (st) => Object.fromEntries(GSTATE_KEYS.map((k) => [k, st[k]]))

const BLEND = { Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten', ColorDodge: 'color-dodge', ColorBurn: 'color-burn', HardLight: 'hard-light', SoftLight: 'soft-light', Difference: 'difference', Exclusion: 'exclusion', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity' }

async function walk(doc, st, data, res, fonts, tokens, xpath) {
  const { ops } = st
  const disp = st.disp
  const dm = () => matMul(disp, st.ctm) // user → display
  const xf = (x, y) => matPt(disp, ...matPt(st.ctm, x, y))
  const avgScale = () => { const m = dm(); return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1 }
  const resSec = (k) => { const v = res instanceof Map ? deref(doc, get(res, k)) : null; return v instanceof Map ? v : null }
  const fontOf = () => (st.curFont && fonts.get(st.curFont)) || null
  const toks = tokens ?? tokenizeContent(data)

  const csFor = async (nm) => {
    const key = `${xpath.join('/')}|${nm}`
    if (st.csCache.has(key)) return st.csCache.get(key)
    const cs = await resolveColorSpace(doc, { k: 'n', v: nm }, res).catch(() => null)
    st.csCache.set(key, cs)
    return cs
  }
  const colorOf = (cs, comps) => {
    if (!cs) return comps.length === 1 ? [comps[0], comps[0], comps[0]] : comps.length === 4 ? cmyk(comps) : comps.length >= 3 ? comps.slice(0, 3) : null
    try { return cs.toRGB(comps).map((v) => Math.min(1, Math.max(0, v))) } catch { return null }
  }

  const glyphWidth = (font, code) => {
    if (!font) return 0.5
    const wv = font.wRanges?.get(code) ?? font.widths?.[code - font.firstChar]
    if (typeof wv === 'number') return wv * (font.fm ?? 0.001)
    return (font.dw ?? (font.codeLen ? 1000 : 500)) * 0.001
  }

  /** Show one string; part = index within a TJ array (for source mapping). */
  const showText = (bytes, opIdx, part) => {
    const font = fontOf()
    const cl = font?.tounicode?.codeLen ?? font?.codeLen ?? 1
    const fs = st.fontSize, th = st.tz
    const trm = matMul(dm(), matMul(st.tm, [1, 0, 0, 1, 0, st.rise])) // text space → display
    const gl = []
    const gx = [] // per-glyph advance offsets — exact placement with substitute fonts
    let adv = 0
    let str = ''
    for (let i = 0; i + cl <= bytes.length; i += cl) {
      let code = 0
      for (let k = 0; k < cl; k++) code = code * 256 + bytes[i + k]
      const ch = decodeString(bytes.subarray(i, i + cl), font)
      const w0 = glyphWidth(font, code)
      const isSpace = cl === 1 && code === 32
      const a = (w0 * fs + st.tc + (isSpace ? st.tw : 0)) * th
      if (st.glyphs) gl.push({ x: adv, w: w0 * fs * th, a, s: ch, b0: i, b1: i + cl })
      gx.push(adv, ch)
      str += ch
      adv += a
    }
    const [dx, dy] = matPt(trm, 0, 0)
    const [dx2, dy2] = matPt(trm, adv, 0)
    const [ux, uy] = matPt(trm, 0, fs)
    const hh = Math.hypot(ux - dx, uy - dy)
    const ang = Math.atan2(dy2 - dy, dx2 - dx)
    const mode = st.tr
    const op = {
      t: 'text', x: dx, y: dy, w: Math.hypot(dx2 - dx, dy2 - dy), h: hh, rot: ang,
      str: garbageRatio(str) >= 0.4 ? '' : str,
      size: hh, fs, th,
      fc: st.fillC, sc: st.strokeC, a: st.fillA, sa: st.strokeA, mode, inv: mode === 3 || mode === 7,
      font: font ? { base: font.base, bold: font.bold, italic: font.italic, serif: font.serif, mono: font.mono, symbol: font.symbol } : null,
      m: trm, blend: st.blend, gx, // gx = [adv0, ch0, adv1, ch1, …] in text space
    }
    if (st.glyphs) { op.glyphs = gl; op.src = { op: opIdx, part, xpath } }
    ops.push(op)
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

  const strokeParams = () => ({
    lw: st.lw * avgScale(), dash: st.dash ? st.dash.map((d) => d * avgScale()) : null,
    doff: st.dash ? st.dashPhase * avgScale() : 0, cap: st.cap, join: st.join,
  })

  const paintPath = async (op) => {
    const fill = 'fFbB'.includes(op[0]) || op === 'f*' || op === 'b*' || op === 'B*'
    const stroke = op[0] === 'S' || op[0] === 's' || 'bB'.includes(op[0])
    const closing = 'sb'.includes(op[0])
    const eo = op.endsWith('*')
    // pattern fills: shading patterns → gradient clipped to the path
    const usePat = fill && !!st.fillPat
    if (usePat) {
      const shade = await patternShade(st.fillPat)
      if (shade) {
        ops.push({ t: 'clip', segs: xformSegs(st.path, true), eo })
        ops.push(shade)
        ops.push({ t: 'unclip' })
      }
    }
    const doFill = fill && !usePat
    if (!doFill && !stroke) { st.path.length = 0; st.cur = null; return }
    const common = {
      fill: doFill, stroke, eo, fc: st.fillC, sc: st.strokeC,
      a: st.fillA, sa: st.strokeA, blend: st.blend, ...strokeParams(),
    }
    const nonRect = []
    for (const sub of st.path) {
      if (sub.rect && Math.abs(dm()[1]) < 1e-6 && Math.abs(dm()[2]) < 1e-6) {
        const [rx, ry, rw, rh] = sub.rect
        const cs = [[rx, ry], [rx + rw, ry + rh]].map(([x, y]) => xf(x, y))
        ops.push({
          t: 'rect', x: Math.min(cs[0][0], cs[1][0]), y: Math.min(cs[0][1], cs[1][1]),
          w: Math.abs(cs[1][0] - cs[0][0]), h: Math.abs(cs[1][1] - cs[0][1]), ...common,
        })
      } else nonRect.push(sub)
    }
    if (nonRect.length) ops.push({ t: 'path', segs: xformSegs(nonRect, closing), ...common })
    st.path.length = 0
    st.cur = null
  }

  /** Shading dict → display-space gradient op (axial/radial), else a flat average fill. */
  const shadeOp = async (sh, extraMatrix = null) => {
    sh = deref(doc, sh)
    const sd = isStream(sh) ? sh.dict : sh
    if (!(sd instanceof Map)) return null
    const type = deref(doc, get(sd, 'ShadingType'))
    const cs = await resolveColorSpace(doc, get(sd, 'ColorSpace'), res).catch(() => null)
    const fn = await compileFunction(doc, get(sd, 'Function')).catch(() => null)
    const domain = deref(doc, get(sd, 'Domain')) ?? [0, 1]
    const coords = deref(doc, get(sd, 'Coords'))
    const ext = deref(doc, get(sd, 'Extend')) ?? [false, false]
    const m = extraMatrix ? matMul(disp, extraMatrix) : dm()
    if ((type === 2 || type === 3) && Array.isArray(coords) && fn && cs) {
      const stops = []
      for (let k = 0; k <= 16; k++) {
        const t = k / 16
        const v = domain[0] + t * (domain[1] - domain[0])
        const c = colorOf(cs, fn([v]))
        if (c) stops.push([t, c])
      }
      if (type === 2) {
        const [x0, y0] = matPt(m, coords[0], coords[1]), [x1, y1] = matPt(m, coords[2], coords[3])
        return { t: 'shade', kind: 'axial', coords: [x0, y0, x1, y1], stops, extend: ext, a: st.fillA, blend: st.blend }
      }
      const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
      const [x0, y0] = matPt(m, coords[0], coords[1]), [x1, y1] = matPt(m, coords[3], coords[4])
      return { t: 'shade', kind: 'radial', coords: [x0, y0, coords[2] * sc, x1, y1, coords[5] * sc], stops, extend: ext, a: st.fillA, blend: st.blend }
    }
    // other shading types: flat colour from the middle of the function / background
    let c = null
    if (fn && cs) c = colorOf(cs, fn([(domain[0] + domain[1]) / 2]))
    const bg = deref(doc, get(sd, 'Background'))
    if (!c && Array.isArray(bg) && cs) c = colorOf(cs, bg)
    return c ? { t: 'shade', kind: 'flat', color: c, a: st.fillA, blend: st.blend } : null
  }

  const patternShade = async (pat) => {
    const pd = isStream(pat) ? pat.dict : pat
    if (!(pd instanceof Map)) return null
    const ptype = deref(doc, get(pd, 'PatternType'))
    const pm = deref(doc, get(pd, 'Matrix'))
    const mat = Array.isArray(pm) && pm.length === 6 ? pm.map(Number) : [1, 0, 0, 1, 0, 0]
    if (ptype === 2) return shadeOp(get(pd, 'Shading'), mat) // pattern space = default user space × Matrix
    // tiling pattern: approximate by a neutral tint of its paint colour
    return { t: 'shade', kind: 'flat', color: st.fillC ?? [0.75, 0.75, 0.75], a: st.fillA * 0.5, blend: st.blend }
  }

  const emitImage = async (ref, inlineIm, opIdx) => {
    const m = dm()
    const cs = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => matPt(m, x, y))
    const e1 = [cs[2][0] - cs[3][0], cs[2][1] - cs[3][1]]
    const e2 = [cs[0][0] - cs[3][0], cs[0][1] - cs[3][1]]
    const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1])
    ops.push({
      t: 'img', x: cs[3][0], y: cs[3][1], w: Math.hypot(...e1), h: Math.hypot(...e2),
      rot: Math.atan2(e1[1], e1[0]), mirror: e1[0] * e2[1] - e1[1] * e2[0] < 0,
      m, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      ref, inline: inlineIm, res, a: st.fillA, fill: st.fillC, blend: st.blend,
      src: st.glyphs ? { op: opIdx, xpath } : undefined,
    })
  }

  const nums = (operands) => operands.filter((o) => typeof o === 'number')

  for (let oi = 0; oi < toks.length; oi++) {
    const { op, operands } = toks[oi]
    switch (op) {
      case 'q': st.gstack.push(snap(st)); break
      case 'Q': {
        const s = st.gstack.pop()
        if (s) Object.assign(st, s)
        while (st.clipLevels.length && st.clipLevels[st.clipLevels.length - 1] > st.gstack.length) {
          st.clipLevels.pop()
          ops.push({ t: 'unclip' })
        }
        break
      }
      case 'cm': if (operands.length >= 6) st.ctm = matMul(st.ctm, nums(operands).slice(0, 6)); break
      case 'BT': st.tm = [1, 0, 0, 1, 0, 0]; st.tlm = [...st.tm]; break
      case 'ET': break
      case 'Tf': {
        const nm = operands.find((o) => o?.t === 'name')
        const sz = operands.find((o) => typeof o === 'number')
        if (nm) st.curFont = nm.v
        if (sz !== undefined) st.fontSize = sz
        break
      }
      case 'Td': case 'TD': {
        const [tx, ty] = nums(operands)
        if (op === 'TD') st.leading = -(ty || 0)
        st.tlm = matMul(st.tlm, [1, 0, 0, 1, tx || 0, ty || 0])
        st.tm = [...st.tlm]
        break
      }
      case 'T*': st.tlm = matMul(st.tlm, [1, 0, 0, 1, 0, -st.leading]); st.tm = [...st.tlm]; break
      case 'TL': st.leading = nums(operands)[0] || 0; break
      case 'Tm': { const n6 = nums(operands); if (n6.length >= 6) { st.tm = n6.slice(0, 6); st.tlm = [...st.tm] } break }
      case 'Tc': st.tc = nums(operands)[0] || 0; break
      case 'Tw': st.tw = nums(operands)[0] || 0; break
      case 'Tz': st.tz = (nums(operands)[0] ?? 100) / 100; break
      case 'Tr': st.tr = nums(operands)[0] || 0; break
      case 'Ts': st.rise = nums(operands)[0] || 0; break
      case 'Tj': case "'": case '"': {
        if (op === '"') { const ns = nums(operands); if (ns.length >= 2) { st.tw = ns[0]; st.tc = ns[1] } }
        if (op === "'" || op === '"') { st.tlm = matMul(st.tlm, [1, 0, 0, 1, 0, -st.leading]); st.tm = [...st.tlm] }
        const s = [...operands].reverse().find((o) => o?.t === 'str')
        if (s) showText(s.bytes, oi, 0)
        break
      }
      case 'TJ': {
        const arr = operands.find((o) => o?.t === 'arr')
        if (!arr) break
        arr.items.forEach((it, k) => {
          if (it?.t === 'str') showText(it.bytes, oi, k)
          else if (typeof it === 'number') st.tm = matMul(st.tm, [1, 0, 0, 1, (-it / 1000) * st.fontSize * st.tz, 0])
        })
        break
      }
      // ---- paths ----
      case 'm': { const [x, y] = nums(operands); st.path.push({ segs: [['M', x || 0, y || 0]] }); st.cur = [x || 0, y || 0]; break }
      case 'l': {
        if (!st.path.length) break
        const [x, y] = nums(operands)
        st.path[st.path.length - 1].segs.push(['L', x || 0, y || 0]); st.cur = [x || 0, y || 0]
        break
      }
      case 'c': {
        const n6 = nums(operands)
        if (!st.path.length || n6.length < 6) break
        st.path[st.path.length - 1].segs.push(['C', ...n6.slice(0, 6)]); st.cur = [n6[4], n6[5]]
        break
      }
      case 'v': {
        const n4 = nums(operands)
        if (!st.path.length || !st.cur || n4.length < 4) break
        st.path[st.path.length - 1].segs.push(['C', st.cur[0], st.cur[1], ...n4.slice(0, 4)]); st.cur = [n4[2], n4[3]]
        break
      }
      case 'y': {
        const n4 = nums(operands)
        if (!st.path.length || n4.length < 4) break
        st.path[st.path.length - 1].segs.push(['C', n4[0], n4[1], n4[2], n4[3], n4[2], n4[3]]); st.cur = [n4[2], n4[3]]
        break
      }
      case 'h': if (st.path.length) st.path[st.path.length - 1].segs.push(['Z']); break
      case 're': {
        const n4 = nums(operands)
        if (n4.length < 4) break
        const [rx, ry, rw, rh] = n4
        st.path.push({ rect: [rx, ry, rw, rh], segs: [['M', rx, ry], ['L', rx + rw, ry], ['L', rx + rw, ry + rh], ['L', rx, ry + rh], ['Z']] })
        st.cur = [rx, ry]
        break
      }
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'b': case 'B*': case 'b*':
        if (st.pendingClip) {
          ops.push(st.pendingClip); st.clipLevels.push(st.gstack.length); st.pendingClip = null
        }
        await paintPath(op)
        break
      case 'W': case 'W*':
        if (st.path.length) st.pendingClip = { t: 'clip', segs: xformSegs(st.path, true), eo: op === 'W*' }
        break
      case 'n':
        if (st.pendingClip) { ops.push(st.pendingClip); st.clipLevels.push(st.gstack.length); st.pendingClip = null }
        st.path.length = 0; st.cur = null
        break
      // ---- colour ----
      case 'g': { const v = nums(operands)[0] ?? 0; st.fillC = [v, v, v]; st.fillCS = null; st.fillPat = null; break }
      case 'G': { const v = nums(operands)[0] ?? 0; st.strokeC = [v, v, v]; st.strokeCS = null; st.strokePat = null; break }
      case 'rg': { const n3 = nums(operands); if (n3.length >= 3) st.fillC = n3.slice(0, 3); st.fillCS = null; st.fillPat = null; break }
      case 'RG': { const n3 = nums(operands); if (n3.length >= 3) st.strokeC = n3.slice(0, 3); st.strokeCS = null; st.strokePat = null; break }
      case 'k': { const n4 = nums(operands); if (n4.length >= 4) st.fillC = cmyk(n4); st.fillCS = null; st.fillPat = null; break }
      case 'K': { const n4 = nums(operands); if (n4.length >= 4) st.strokeC = cmyk(n4); st.strokeCS = null; st.strokePat = null; break }
      case 'cs': case 'CS': {
        const nm = operands.find((o) => o?.t === 'name')?.v
        const cs = nm ? await csFor(nm) : null
        // spec: selecting a colour space resets the colour to its initial value (all-zero components)
        const init = cs && cs.n > 0 ? colorOf(cs, new Array(cs.n).fill(cs.name === 'Separation' || cs.name === 'DeviceN' ? 1 : 0)) : null
        if (op === 'cs') { st.fillCS = cs; st.fillPat = null; st.fillC = init ?? [0, 0, 0] }
        else { st.strokeCS = cs; st.strokePat = null; st.strokeC = init ?? [0, 0, 0] }
        break
      }
      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const fillSide = op === 'sc' || op === 'scn'
        const cs = fillSide ? st.fillCS : st.strokeCS
        const pnm = operands.find((o) => o?.t === 'name')
        if (pnm && (cs?.pattern || !cs)) {
          const pats = resSec('Pattern')
          const pat = pats ? deref(doc, pats.get(pnm.v)) : null
          if (fillSide) st.fillPat = pat ?? null
          else st.strokePat = pat ?? null
          break
        }
        const c = colorOf(cs, nums(operands))
        if (c) { if (fillSide) { st.fillC = c; st.fillPat = null } else { st.strokeC = c; st.strokePat = null } }
        break
      }
      case 'sh': {
        const nm = operands.find((o) => o?.t === 'name')
        const shd = resSec('Shading')
        if (nm && shd) {
          const op2 = await shadeOp(shd.get(nm.v))
          if (op2) ops.push(op2)
        }
        break
      }
      // ---- graphics state ----
      case 'w': { const v = nums(operands)[0]; if (Number.isFinite(v)) st.lw = v; break }
      case 'J': st.cap = nums(operands)[0] || 0; break
      case 'j': st.join = nums(operands)[0] || 0; break
      case 'd': {
        const arr = operands.find((o) => o?.t === 'arr')
        st.dash = arr ? arr.items.filter((x) => typeof x === 'number' && x >= 0) : null
        if (st.dash && !st.dash.some((x) => x > 0)) st.dash = null
        st.dashPhase = nums(operands)[0] ?? 0
        break
      }
      case 'gs': {
        const nm = operands.find((o) => o?.t === 'name')
        const gd = resSec('ExtGState')
        const e = gd && nm ? deref(doc, gd.get(nm.v)) : null
        if (e instanceof Map) {
          const ca = deref(doc, get(e, 'ca')), CA = deref(doc, get(e, 'CA'))
          if (typeof ca === 'number') st.fillA = ca
          if (typeof CA === 'number') st.strokeA = CA
          const lw = deref(doc, get(e, 'LW')); if (typeof lw === 'number') st.lw = lw
          const lc = deref(doc, get(e, 'LC')); if (typeof lc === 'number') st.cap = lc
          const lj = deref(doc, get(e, 'LJ')); if (typeof lj === 'number') st.join = lj
          let bm = deref(doc, get(e, 'BM'))
          if (Array.isArray(bm)) bm = bm[0]
          if (bm?.k === 'n') st.blend = BLEND[bm.v] ?? null
          const font = deref(doc, get(e, 'Font'))
          if (Array.isArray(font) && typeof font[1] === 'number') st.fontSize = font[1]
        }
        break
      }
      case 'BI': {
        const fillC = st.fillC
        await emitImage(null, { dict: toks[oi].dict, data: toks[oi].data, fill: fillC }, oi)
        break
      }
      case 'Do': {
        const nm = [...operands].reverse().find((o) => o?.t === 'name')
        if (!nm) break
        const xo = resSec('XObject')
        const xv = xo ? deref(doc, xo.get(nm.v)) : null
        if (!isStream(xv)) break
        const sub = get(xv.dict, 'Subtype')?.v
        if (sub === 'Image') {
          await emitImage(xv, null, oi)
          const last = ops[ops.length - 1]
          const r = xo.get(nm.v)
          last.key = isRef(r) ? `${r.n} ${r.g}` : `inline:${nm.v}`
          last.name = nm.v
        } else if (sub === 'Form' && st.depth < 8) {
          await runForm(doc, st, xv, res, fonts, [...xpath, nm.v])
        }
        break
      }
    }
  }
}

/** Run a form XObject (shared by Do and annotation appearances). */
async function runForm(doc, st, xv, parentRes, parentFonts, xpath, extraMatrix = null) {
  const fm = deref(doc, get(xv.dict, 'Matrix'))
  const fmat = Array.isArray(fm) && fm.length === 6 ? fm.map(Number) : [1, 0, 0, 1, 0, 0]
  const saved = { ...snap(st), path: st.path, cur: st.cur, gstack: st.gstack, clipLen: st.clipLevels.length, pendingClip: st.pendingClip }
  if (extraMatrix) st.ctm = matMul(st.ctm, extraMatrix)
  st.ctm = matMul(st.ctm, fmat)
  st.path = []
  st.cur = null
  st.gstack = []
  st.pendingClip = null
  const bb = deref(doc, get(xv.dict, 'BBox'))
  let clipped = false
  if (Array.isArray(bb) && bb.length === 4) {
    const [bx0, by0, bx1, by1] = bb.map((v) => Number(deref(doc, v)))
    const m = matMul(st.disp, st.ctm)
    const cs = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]].map(([x, y]) => matPt(m, x, y))
    st.ops.push({ t: 'clip', segs: [['M', ...cs[0]], ['L', ...cs[1]], ['L', ...cs[2]], ['L', ...cs[3]], ['Z']] })
    clipped = true
  }
  // transparency group: constant alpha applies to the group as a whole —
  // approximated by letting the current alpha flow into the form
  st.depth++
  try {
    const subRes = deref(doc, get(xv.dict, 'Resources'))
    const merged = subRes instanceof Map ? subRes : parentRes
    const subFonts = merged === parentRes ? parentFonts : await fontMapFromRes(doc, merged)
    const fdata = await streamData(xv)
    if (fdata) await walk(doc, st, fdata, merged, subFonts, null, xpath)
  } finally {
    st.depth--
    while (st.clipLevels.length > saved.clipLen) { st.clipLevels.pop(); st.ops.push({ t: 'unclip' }) }
    Object.assign(st, saved)
    if (clipped) st.ops.push({ t: 'unclip' })
  }
}

/** Paint annotation normal appearances (stamps, filled fields, ink, signatures…). */
async function paintAnnotations(doc, leaf, st, pageRes, widgets) {
  const an = deref(doc, get(leaf.dict, 'Annots'))
  if (!Array.isArray(an)) return
  for (const r of an) {
    const a = deref(doc, r)
    if (!(a instanceof Map)) continue
    const sub = get(a, 'Subtype')?.v
    if (sub === 'Popup' || sub === 'Link' || (!widgets && sub === 'Widget')) continue
    const flags = deref(doc, get(a, 'F')) ?? 0
    if (flags & 2 || flags & 32) continue // hidden / NoView
    let ap = deref(doc, get(deref(doc, get(a, 'AP')), 'N'))
    if (ap instanceof Map && !isStream(ap)) { // appearance states (checkboxes, radios)
      const as = get(a, 'AS')
      ap = deref(doc, as?.k === 'n' ? ap.get(as.v) : ap.get('On') ?? ap.get('Yes') ?? null)
    }
    if (!isStream(ap)) continue
    const rect = deref(doc, get(a, 'Rect'))
    if (!Array.isArray(rect) || rect.length !== 4) continue
    const [x0, y0, x1, y1] = rect.map((v) => Number(deref(doc, v)))
    const bb = deref(doc, get(ap.dict, 'BBox')) ?? [0, 0, x1 - x0, y1 - y0]
    const fm = deref(doc, get(ap.dict, 'Matrix'))
    const M = Array.isArray(fm) && fm.length === 6 ? fm.map(Number) : [1, 0, 0, 1, 0, 0]
    // spec 12.5.5: transform BBox by Matrix, map that box onto Rect
    const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => matPt(M, x, y))
    const bx0 = Math.min(...pts.map((p) => p[0])), by0 = Math.min(...pts.map((p) => p[1]))
    const bw = Math.max(...pts.map((p) => p[0])) - bx0 || 1, bh = Math.max(...pts.map((p) => p[1])) - by0 || 1
    const A = [(Math.min(x0, x1) === x0 ? x1 - x0 : x0 - x1) / bw, 0, 0, Math.abs(y1 - y0) / bh, 0, 0]
    A[4] = Math.min(x0, x1) - bx0 * A[0]
    A[5] = Math.min(y0, y1) - by0 * A[3]
    const saved = snap(st)
    st.ctm = [1, 0, 0, 1, 0, 0]
    st.fillA = 1; st.strokeA = 1; st.blend = null
    await runForm(doc, st, ap, pageRes, new Map(), ['@annot'], A).catch(() => {})
    Object.assign(st, saved)
  }
}

const cmyk = (n) => [(1 - n[0]) * (1 - n[3]), (1 - n[1]) * (1 - n[3]), (1 - n[2]) * (1 - n[3])]

// ---------- text extraction ----------

/** Page text, lines reassembled by position (top→bottom, left→right). */
export async function pageText(doc, leaf) {
  const { ops } = await collectDrawOps(doc, leaf, { annots: false })
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

