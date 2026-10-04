// Colour spaces + image XObject decoding to RGBA, pure JS (runs in node too).
// DCT/JPX payloads are handed back undecoded — the browser owns those codecs.
import { deref } from './parse.js'
import { decodeChain } from './filters.js'
import { compileFunction } from './functions.js'

const nameOf = (v) => (v?.k === 'n' ? v.v : null)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

const cmykToRgb = (c, m, y, k) => [
  (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k),
]
const labToRgb = (L, a, b) => { // D65, sRGB gamma
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200
  const f = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
  x = 0.95047 * f(x); y = f(y); z = 1.08883 * f(z)
  const g = (c) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c)
  return [g(x * 3.2406 + y * -1.5372 + z * -0.4986), g(x * -0.9689 + y * 1.8758 + z * 0.0415), g(x * 0.0557 + y * -0.204 + z * 1.057)].map(clamp01)
}

/**
 * Resolve a colour space → {n, name, toRGB(comps[0..1]) → [r,g,b] 0..1, indexed?, hival?}.
 * Unknown spaces fall back by component count so something sensible paints.
 */
export async function resolveColorSpace(doc, cs, res = null) {
  cs = deref(doc, cs)
  // named resource (/CS0) → look up in Resources /ColorSpace
  const nm = nameOf(cs)
  if (nm && !/^Device|^Pattern$/.test(nm) && res instanceof Map) {
    let csd = deref(doc, res.get('ColorSpace'))
    const inner = csd instanceof Map ? csd.get(nm) : undefined
    if (inner !== undefined) return resolveColorSpace(doc, inner, null)
  }
  const fam = nm ?? (Array.isArray(cs) ? nameOf(deref(doc, cs[0])) : null)
  const gray = { n: 1, name: 'DeviceGray', toRGB: (c) => [c[0], c[0], c[0]] }
  const rgb = { n: 3, name: 'DeviceRGB', toRGB: (c) => [c[0], c[1], c[2]] }
  const cmyk = { n: 4, name: 'DeviceCMYK', toRGB: (c) => cmykToRgb(c[0], c[1], c[2], c[3]) }
  switch (fam) {
    case 'DeviceGray': case 'G': case 'CalGray': return gray
    case 'DeviceRGB': case 'RGB': case 'CalRGB': return rgb
    case 'DeviceCMYK': case 'CMYK': return cmyk
    case 'Lab': {
      const d = deref(doc, cs[1])
      const r = (d instanceof Map && d.get('Range')) || [-100, 100, -100, 100]
      // components arrive normalised 0..1 over [0,100],[amin,amax],[bmin,bmax]
      return { n: 3, name: 'Lab', toRGB: (c) => labToRgb(c[0] * 100, r[0] + c[1] * (r[1] - r[0]), r[2] + c[2] * (r[3] - r[2])), lab: r }
    }
    case 'ICCBased': {
      const s = deref(doc, cs[1])
      const d = s?.dict
      const n = d?.get('N') ?? 3
      const alt = d?.get('Alternate')
      if (alt) {
        const a = await resolveColorSpace(doc, alt).catch(() => null)
        if (a && a.n === n) return { ...a, name: 'ICCBased' }
      }
      return { ...(n === 1 ? gray : n === 4 ? cmyk : rgb), name: 'ICCBased' }
    }
    case 'Indexed': case 'I': {
      const base = await resolveColorSpace(doc, cs[1])
      const hival = deref(doc, cs[2]) ?? 255
      let lk = deref(doc, cs[3])
      let bytes
      if (lk?.k === 't') bytes = (await decodeChain(lk.dict, lk.data)).data
      else if (lk?.bytes) bytes = lk.bytes
      else bytes = new Uint8Array(0)
      const palette = []
      for (let i = 0; i <= hival; i++) {
        const comps = []
        for (let k = 0; k < base.n; k++) comps.push((bytes[i * base.n + k] ?? 0) / 255)
        palette.push(base.toRGB(comps))
      }
      return { n: 1, name: 'Indexed', indexed: true, hival, toRGB: (c) => palette[Math.max(0, Math.min(hival, Math.round(c[0])))] ?? [0, 0, 0] }
    }
    case 'Separation': case 'DeviceN': {
      const nIn = fam === 'Separation' ? 1 : (deref(doc, cs[1])?.length ?? 1)
      const alt = await resolveColorSpace(doc, cs[2]).catch(() => gray)
      const fn = await compileFunction(doc, cs[3]).catch(() => null)
      const sepName = fam === 'Separation' ? nameOf(cs[1]) : null
      if (sepName === 'None') return { n: 1, name: fam, none: true, toRGB: () => [1, 1, 1] }
      return {
        n: nIn, name: fam,
        toRGB: fn ? (c) => alt.toRGB(fn(c)) : (c) => { const v = 1 - clamp01(c[0]); return [v, v, v] },
      }
    }
    case 'Pattern': return { n: 0, name: 'Pattern', pattern: true, toRGB: () => [0.5, 0.5, 0.5] }
    default:
      return rgb
  }
}

/** Read N samples of `bpc` bits from a row starting at byte `off`. */
function readSamples(data, off, count, bpc, out) {
  if (bpc === 8) { for (let i = 0; i < count; i++) out[i] = data[off + i] ?? 0; return }
  if (bpc === 16) { for (let i = 0; i < count; i++) out[i] = ((data[off + 2 * i] ?? 0) << 8) | (data[off + 2 * i + 1] ?? 0); return }
  const mask = (1 << bpc) - 1
  for (let i = 0; i < count; i++) {
    const bit = i * bpc
    const byte = data[off + (bit >> 3)] ?? 0
    out[i] = (byte >> (8 - bpc - (bit & 7))) & mask
  }
}

/**
 * Decode an image XObject (stream) → result:
 *   {kind:'rgba', w, h, rgba: Uint8ClampedArray}           raw samples, fully decoded
 *   {kind:'jpeg'|'jpx', w, h, data, smask?: rgba-alpha-plane|null, cmyk?: bool}
 *   null when unsupported (JBIG2/CCITT, broken data)
 * opts.fill = [r,g,b] 0..1 for stencil masks (ImageMask true).
 */
export async function decodeImage(doc, v, { fill = [0, 0, 0], res = null, inline = false } = {}) {
  const d = v.dict
  const g = (k, k2) => { const x = d.get(k) ?? (k2 ? d.get(k2) : undefined); return deref(doc, x) }
  const w = g('Width', 'W') ?? 0
  const h = g('Height', 'H') ?? 0
  if (!w || !h || w * h > 40e6) return null
  const isMask = g('ImageMask', 'IM') === true
  const bpc = isMask ? 1 : g('BitsPerComponent', 'BPC') ?? 8
  const decodeArr = g('Decode', 'D')
  const chain = await decodeChain(d, v.data, { stopAtImage: true })
  const smaskAlpha = !isMask && !inline ? await softMask(doc, d) : null

  if (chain.codec === 'DCTDecode' || chain.codec === 'JPXDecode') {
    let cmyk = false
    const csv = g('ColorSpace', 'CS')
    if (csv) { const cs = await resolveColorSpace(doc, csv, res).catch(() => null); cmyk = cs?.n === 4 }
    return { kind: chain.codec === 'DCTDecode' ? 'jpeg' : 'jpx', w, h, data: chain.data, smask: smaskAlpha, cmyk, invert: Array.isArray(decodeArr) && decodeArr[0] === 1 }
  }
  if (chain.codec) return null // JBIG2 / CCITT

  const data = chain.data
  const rgba = new Uint8ClampedArray(w * h * 4)
  if (isMask) {
    const paintOn = Array.isArray(decodeArr) && decodeArr[0] === 1 ? 1 : 0
    const rowBytes = Math.ceil(w / 8)
    const [r, gg, b] = fill.map((c) => Math.round(c * 255))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const o = (y * w + x) * 4
        if (bit === paintOn) { rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = b; rgba[o + 3] = 255 }
      }
    }
    return { kind: 'rgba', w, h, rgba, stencil: true }
  }

  const cs = await resolveColorSpace(doc, g('ColorSpace', 'CS') ?? { k: 'n', v: 'DeviceGray' }, res)
  const n = cs.n || 1
  const rowBytes = Math.ceil((w * n * bpc) / 8)
  const maxV = (1 << bpc) - 1
  const dec = Array.isArray(decodeArr) ? decodeArr : cs.lab ? [0, 100, ...cs.lab] : null
  const samples = new Array(w * n)
  const comps = new Array(n)
  // colour-key masking: /Mask [min0 max0 min1 max1 …] on raw sample values
  const maskV = g('Mask')
  const keyRanges = Array.isArray(maskV) ? maskV.map((x) => deref(doc, x)) : null
  // cache for 8-bit single-channel / indexed (cheap and very common)
  const lut = n === 1 && bpc <= 8 ? new Map() : null
  for (let y = 0; y < h; y++) {
    readSamples(data, y * rowBytes, w * n, bpc, samples)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      let rgb
      if (lut) {
        const s = samples[x]
        rgb = lut.get(s)
        if (!rgb) {
          let c = cs.indexed ? (dec ? dec[0] + (s * (dec[1] - dec[0])) / maxV : s) : dec ? dec[0] + (s * (dec[1] - dec[0])) / maxV : s / maxV
          rgb = cs.toRGB([c])
          lut.set(s, rgb)
        }
      } else {
        for (let k = 0; k < n; k++) {
          const s = samples[x * n + k]
          comps[k] = dec ? dec[2 * k] + (s * (dec[2 * k + 1] - dec[2 * k])) / maxV : s / maxV
        }
        if (cs.lab) { // Lab components decode over their own ranges already
          rgb = labToRgb(comps[0], comps[1], comps[2])
        } else rgb = cs.toRGB(comps)
      }
      rgba[o] = rgb[0] * 255
      rgba[o + 1] = rgb[1] * 255
      rgba[o + 2] = rgb[2] * 255
      let a = 255
      if (keyRanges) {
        let inside = true
        for (let k = 0; k < n; k++) {
          const s = samples[x * n + k]
          if (s < keyRanges[2 * k] || s > keyRanges[2 * k + 1]) { inside = false; break }
        }
        if (inside) a = 0
      }
      rgba[o + 3] = a
    }
  }
  if (smaskAlpha) applyAlpha(rgba, w, h, smaskAlpha)
  else if (maskV?.k === 't') { // stencil mask stream → alpha
    const m = await decodeImage(doc, { dict: new Map([...maskV.dict, ['ImageMask', true]]), data: maskV.data }, { fill: [0, 0, 0] }).catch(() => null)
    if (m) applyAlpha(rgba, w, h, { w: m.w, h: m.h, a: Uint8ClampedArray.from({ length: m.w * m.h }, (_, i) => m.rgba[i * 4 + 3]) })
  }
  return { kind: 'rgba', w, h, rgba }
}

/** /SMask → {w,h,a} alpha plane (gray decoded). */
async function softMask(doc, d) {
  const sm = deref(doc, d.get('SMask'))
  if (sm?.k !== 't') return null
  const m = await decodeImage(doc, { dict: new Map([...sm.dict, ['ColorSpace', { k: 'n', v: 'DeviceGray' }]]).set('SMask', undefined), data: sm.data }).catch(() => null)
  if (!m || m.kind !== 'rgba') return null
  const a = new Uint8ClampedArray(m.w * m.h)
  for (let i = 0; i < a.length; i++) a[i] = m.rgba[i * 4]
  return { w: m.w, h: m.h, a }
}

/** Multiply an alpha plane (any size — nearest resample) into rgba. */
export function applyAlpha(rgba, w, h, { w: mw, h: mh, a }) {
  for (let y = 0; y < h; y++) {
    const my = Math.min(mh - 1, Math.floor((y * mh) / h))
    for (let x = 0; x < w; x++) {
      const mx = Math.min(mw - 1, Math.floor((x * mw) / w))
      const o = (y * w + x) * 4 + 3
      rgba[o] = (rgba[o] * a[my * mw + mx]) / 255
    }
  }
}
