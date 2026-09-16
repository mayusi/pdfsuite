import { dec, get, isName, isStream, name, ref, stream, str, hex, typeIs } from './types.js'
import { inflate } from './env.js'

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])
const isWs = (b) => WS.has(b)
const isDelim = (b) => isWs(b) || DELIM.has(b)
const isDigit = (b) => b >= 0x30 && b <= 0x39

function skipWs(buf, i) {
  while (i < buf.length) {
    if (isWs(buf[i])) i++
    else if (buf[i] === 0x25) {
      while (i < buf.length && buf[i] !== 0x0a && buf[i] !== 0x0d) i++ // % comment → EOL
    } else break
  }
  return i
}

function matchKeyword(buf, i, kw) {
  for (let j = 0; j < kw.length; j++) if (buf[i + j] !== kw.charCodeAt(j)) return false
  return true
}

/** Parse one PDF value at buf[i]. Returns [value, nextIndex]. */
export function parseValue(buf, i, allowStream = false) {
  i = skipWs(buf, i)
  const b = buf[i]

  if (b === 0x3c) {
    // << dict >> or <hex>
    if (buf[i + 1] === 0x3c) {
      const dict = new Map()
      i += 2
      while (true) {
        i = skipWs(buf, i)
        if (buf[i] === 0x3e && buf[i + 1] === 0x3e) {
          i += 2
          break
        }
        if (buf[i] !== 0x2f) throw new Error(`dict: expected /key @${i}`)
        let keyEnd = i + 1
        while (keyEnd < buf.length && !isDelim(buf[keyEnd])) keyEnd++
        const key = decodeName(buf, i + 1, keyEnd)
        const [val, next] = parseValue(buf, keyEnd)
        dict.set(key, val)
        i = next
      }
      // top-level only: stream data may follow a dict
      if (allowStream) {
        const j = skipWs(buf, i)
        if (matchKeyword(buf, j, 'stream') && isDelim(buf[j + 6])) {
          let d = j + 6
          if (buf[d] === 0x0d && buf[d + 1] === 0x0a) d += 2
          else if (buf[d] === 0x0d || buf[d] === 0x0a) d += 1
          const len = get(dict, 'Length')
          let data
          if (typeof len === 'number' && len >= 0 && d + len <= buf.length) {
            data = buf.slice(d, d + len)
            i = d + len
            const e = skipWs(buf, i)
            if (matchKeyword(buf, e, 'endstream')) i = e + 9
          } else {
            const end = findMarker(buf, d, 'endstream')
            data = buf.slice(d, end)
            i = end + 9
          }
          return [stream(dict, data), i]
        }
      }
      return [dict, i]
    }
    // hex string
    let j = i + 1
    const nib = []
    while (j < buf.length && buf[j] !== 0x3e) {
      const c = buf[j]
      if (!isWs(c)) nib.push(c)
      j++
    }
    if (nib.length % 2) nib.push(0x30)
    const out = new Uint8Array(nib.length / 2)
    for (let k = 0; k < out.length; k++)
      out[k] = parseInt(String.fromCharCode(nib[2 * k], nib[2 * k + 1]), 16)
    return [hex(out), j + 1]
  }

  if (b === 0x5b) {
    const arr = []
    i++
    while (true) {
      i = skipWs(buf, i)
      if (buf[i] === 0x5d) return [arr, i + 1]
      const [v, next] = parseValue(buf, i)
      arr.push(v)
      i = next
    }
  }

  if (b === 0x2f) {
    let j = i + 1
    while (j < buf.length && !isDelim(buf[j])) j++
    return [name(decodeName(buf, i + 1, j)), j]
  }

  if (b === 0x28) {
    // literal string — escapes + balanced parens
    const out = []
    let j = i + 1
    let depth = 1
    while (j < buf.length && depth > 0) {
      const c = buf[j]
      if (c === 0x5c) {
        const e = buf[j + 1]
        j += 2
        switch (e) {
          case 0x6e: out.push(0x0a); break
          case 0x72: out.push(0x0d); break
          case 0x74: out.push(0x09); break
          case 0x62: out.push(0x08); break
          case 0x66: out.push(0x0c); break
          case 0x28: case 0x29: case 0x5c: out.push(e); break
          case 0x0d: if (buf[j] === 0x0a) j++; break
          case 0x0a: break
          default:
            if (isDigit(e)) {
              let oct = e - 0x30, cnt = 1
              while (cnt < 3 && isDigit(buf[j])) { oct = oct * 8 + (buf[j] - 0x30); j++; cnt++ }
              out.push(oct & 0xff)
            } else if (e !== undefined) out.push(e)
        }
      } else if (c === 0x28) { depth++; out.push(c); j++ }
      else if (c === 0x29) { if (--depth > 0) out.push(c); j++ }
      else { out.push(c); j++ }
    }
    return [str(new Uint8Array(out)), j]
  }

  // number / ref / keyword
  const start = i
  let j = i
  if (buf[j] === 0x2b || buf[j] === 0x2d) j++
  let sawDot = false
  while (j < buf.length && (isDigit(buf[j]) || (buf[j] === 0x2e && !sawDot))) {
    if (buf[j] === 0x2e) sawDot = true
    j++
  }
  if (j > start && (isDigit(buf[j - 1]) || isDigit(buf[start]))) {
    const numStr = dec(buf.slice(start, j))
    const num = parseFloat(numStr)
    if (Number.isInteger(num) && !numStr.includes('.')) {
      // maybe "n g R"
      let k = skipWs(buf, j)
      const s2 = k
      while (k < buf.length && isDigit(buf[k])) k++
      if (k > s2) {
        const g = parseInt(dec(buf.slice(s2, k)), 10)
        const k2 = skipWs(buf, k)
        if (buf[k2] === 0x52 && isDelim(buf[k2 + 1])) return [ref(num, g), k2 + 1]
      }
    }
    return [num, j]
  }

  // keyword
  let k = i
  while (k < buf.length && !isDelim(buf[k])) k++
  const word = dec(buf.slice(i, k))
  if (word === 'true') return [true, k]
  if (word === 'false') return [false, k]
  if (word === 'null') return [null, k]
  throw new Error(`unexpected token "${word}" @${i}`)
}

function decodeName(buf, i, j) {
  let s = ''
  while (i < j) {
    if (buf[i] === 0x23 && i + 2 < j) {
      // #XX
      const hv = parseInt(dec(buf.slice(i + 1, i + 3)), 16)
      if (!Number.isNaN(hv)) { s += String.fromCharCode(hv); i += 3; continue }
    }
    s += String.fromCharCode(buf[i++])
  }
  return s
}

function findMarker(buf, from, marker) {
  const m = marker
  outer: for (let i = from; i <= buf.length - m.length; i++) {
    for (let j = 0; j < m.length; j++) if (buf[i + j] !== m.charCodeAt(j)) continue outer
    // strip the EOL that precedes the marker (not part of stream data)
    let end = i
    if (buf[end - 1] === 0x0a) end--
    if (buf[end - 1] === 0x0d) end--
    return end
  }
  return buf.length
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g

/**
 * Parse a PDF by scanning for indirect objects — ignores xref tables entirely,
 * so linearized / damaged / xref-stream files all parse the same.
 */
export async function parsePdf(bytes, warnings = [], allowEncrypted = false) {
  const text = dec(bytes)
  const objects = new Map()

  for (const m of text.matchAll(OBJ_RE)) {
    const n = +m[1]
    const g = +m[2]
    const start = m.index + m[0].length
    try {
      const [v, next] = parseValue(bytes, start, true)
      const e = skipWs(bytes, next)
      if (!matchKeyword(bytes, e, 'endobj')) continue // not a real object boundary
      objects.set(`${n} ${g}`, { n, g, v })
    } catch {
      // false-positive match inside stream data — skip
    }
  }

  // objects hidden inside /ObjStm compressed streams
  for (const { v } of objects.values()) {
    if (!isStream(v) || !typeIs(v.dict, 'ObjStm')) continue
    const N = get(v.dict, 'N')
    const first = get(v.dict, 'First')
    if (typeof N !== 'number' || typeof first !== 'number') continue
    try {
      const data = await inflate(v.data)
      const headerEnd = first
      const header = dec(data.slice(0, headerEnd)).trim().split(/\s+/).map(Number)
      for (let i = 0; i < N; i++) {
        const num = header[i * 2]
        const off = header[i * 2 + 1]
        try {
          const [v2] = parseValue(data, first + off)
          if (!objects.has(`${num} 0`)) objects.set(`${num} 0`, { n: num, g: 0, v: v2 })
        } catch { warnings.push(`ObjStm: bad object ${num}`) }
      }
    } catch { warnings.push('ObjStm: inflate failed — document may be incomplete') }
  }

  // trailer: classic `trailer` dict, or an /XRef stream dict
  let trailer = null
  const tIdx = text.lastIndexOf('trailer')
  if (tIdx !== -1) {
    try { const [t] = parseValue(bytes, skipWs(bytes, tIdx + 7)); trailer = t } catch { /* fall through */ }
  }
  if (!(trailer instanceof Map)) {
    for (const { v } of objects.values()) {
      const dict = isStream(v) ? v.dict : v
      if (typeIs(dict, 'XRef')) { trailer = dict; break }
    }
  }
  if (!(trailer instanceof Map)) {
    // last resort: synthesize a trailer pointing at the catalog
    for (const { n, g, v } of objects.values()) {
      const dict = isStream(v) ? v.dict : v
      if (typeIs(dict, 'Catalog')) {
        trailer = new Map([['Root', ref(n, g)]])
        break
      }
    }
  }
  if (!trailer) throw new Error('not a PDF (no trailer/catalog found)')
  if (get(trailer, 'Encrypt') && !allowEncrypted)
    throw new Error('this PDF is password-protected — unlock it in the Protect tool first')

  return { objects, trailer, warnings, encrypted: !!get(trailer, 'Encrypt') }
}

/** Resolve a value: refs are dereferenced, everything else returned as-is. */
export function deref(doc, v) {
  if (v?.k === 'r') return doc.objects.get(`${v.n} ${v.g}`)?.v
  return v
}
