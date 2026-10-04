// Stream filter decoders — everything a PDF can wrap a stream in, except the
// image codecs (DCT/JPX/JBIG2/CCITT), which callers handle or skip.
import { inflate } from './env.js'

/** ASCII85Decode — 4 bytes per 5 chars, 'z' = four zero bytes, '~>' ends. */
export function ascii85(data) {
  const out = []
  let tuple = 0
  let n = 0
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    if (c === 0x7e) break // '~>' EOD
    if (c <= 0x20) continue // whitespace
    if (c === 0x7a && n === 0) { out.push(0, 0, 0, 0); continue } // 'z'
    if (c < 0x21 || c > 0x75) throw new Error('bad ASCII85 data')
    tuple = tuple * 85 + (c - 0x21)
    if (++n === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255)
      tuple = 0
      n = 0
    }
  }
  if (n > 1) { // partial group: pad with 'u', keep n-1 bytes
    for (let k = n; k < 5; k++) tuple = tuple * 85 + 84
    const b = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255]
    out.push(...b.slice(0, n - 1))
  }
  return new Uint8Array(out)
}

/** ASCIIHexDecode — hex pairs, whitespace ignored, '>' ends, odd tail pads 0. */
export function asciiHex(data) {
  const out = []
  let hi = -1
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    if (c === 0x3e) break
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1
    if (v < 0) continue
    if (hi < 0) hi = v
    else { out.push(hi * 16 + v); hi = -1 }
  }
  if (hi >= 0) out.push(hi * 16)
  return new Uint8Array(out)
}

/** RunLengthDecode — len byte 0-127 copies len+1 literals, 129-255 repeats next byte 257-len times. */
export function runLength(data) {
  const out = []
  for (let i = 0; i < data.length;) {
    const len = data[i++]
    if (len === 128) break
    if (len < 128) { for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]) }
    else { const b = data[i++]; for (let k = 0; k < 257 - len; k++) out.push(b) }
  }
  return new Uint8Array(out)
}

/** LZWDecode — 9..12-bit codes, 256 clear, 257 EOD; earlyChange per spec default 1. */
export function lzw(data, earlyChange = 1) {
  const out = []
  let dict = []
  const reset = () => {
    dict = []
    for (let i = 0; i < 256; i++) dict.push([i])
    dict.push(null, null) // 256 clear, 257 eod
  }
  reset()
  let bits = 9
  let buf = 0
  let nbuf = 0
  let prev = null
  for (let i = 0; i < data.length; i++) {
    buf = (buf << 8) | data[i]
    nbuf += 8
    while (nbuf >= bits) {
      const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1)
      nbuf -= bits
      buf &= (1 << nbuf) - 1
      if (code === 256) { reset(); bits = 9; prev = null; continue }
      if (code === 257) return new Uint8Array(out)
      let entry
      if (code < dict.length && dict[code]) entry = dict[code]
      else if (prev && code === dict.length) entry = [...prev, prev[0]]
      else throw new Error('bad LZW code')
      for (const b of entry) out.push(b)
      if (prev) dict.push([...prev, entry[0]])
      prev = entry
      if (dict.length + earlyChange >= 1 << bits && bits < 12) bits++
    }
  }
  return new Uint8Array(out)
}

/** Undo PNG/TIFF predictors (DecodeParms /Predictor). */
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
  const rowStride = rowBytes + 1
  const rows = Math.floor(data.length / rowStride)
  const out = new Uint8Array(rows * rowBytes)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < rows; y++) {
    const src = y * rowStride + 1
    const f = data[y * rowStride]
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

const FILTER_ALIAS = { AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' }
export const IMAGE_CODECS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode'])

/** Normalised [{name, parms: Map|null}] chain for a stream dict. */
export function filterChain(dict) {
  const g = (k) => (dict instanceof Map ? dict.get(k) : undefined)
  const f = g('Filter') ?? g('F')
  const p = g('DecodeParms') ?? g('DP')
  const names = Array.isArray(f) ? f : f ? [f] : []
  const parms = Array.isArray(p) ? p : [p]
  return names.map((n, i) => {
    const nm = n?.k === 'n' ? n.v : null
    return { name: FILTER_ALIAS[nm] ?? nm, parms: parms[i] instanceof Map ? parms[i] : null }
  })
}

const predictParms = (parms) => {
  if (!parms) return null
  const pr = parms.get('Predictor') ?? 1
  if (pr === 1) return null
  return {
    predictor: pr,
    columns: parms.get('Columns') ?? 1,
    colors: parms.get('Colors') ?? 1,
    bpc: parms.get('BitsPerComponent') ?? 8,
  }
}

/** Apply one non-image filter. */
export async function applyFilter(name, parms, d) {
  if (name === 'FlateDecode') {
    d = await inflate(d)
  } else if (name === 'LZWDecode') {
    d = lzw(d, parms?.get('EarlyChange') ?? 1)
  } else if (name === 'ASCII85Decode') return ascii85(d)
  else if (name === 'ASCIIHexDecode') return asciiHex(d)
  else if (name === 'RunLengthDecode') return runLength(d)
  else if (name === 'Crypt') return d // Identity crypt filter
  else throw new Error(`unsupported filter ${name}`)
  const pp = predictParms(parms)
  return pp ? unPredict(d, pp) : d
}

/**
 * Decode a stream's data through its filter chain.
 * stopAtImage: stop (without error) at a trailing image codec and report it.
 * Returns {data, codec, parms} — codec null when fully decoded.
 */
export async function decodeChain(dict, data, { stopAtImage = false } = {}) {
  const chain = filterChain(dict)
  let d = data
  for (let i = 0; i < chain.length; i++) {
    const { name, parms } = chain[i]
    if (IMAGE_CODECS.has(name)) {
      if (stopAtImage) return { data: d, codec: name, parms }
      throw new Error(`image codec ${name}`)
    }
    d = await applyFilter(name, parms, d)
  }
  return { data: d, codec: null, parms: null }
}
