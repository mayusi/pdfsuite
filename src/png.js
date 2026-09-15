// Minimal PNG encoder — truecolor/gray 8-bit, zlib stream with STORED deflate
// blocks (no compression, but valid). Enough to export decoded PDF rasters.
import { crc32 } from './zip.js'

function adler32(data) {
  let a = 1, b = 0
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** Wrap raw bytes in a zlib stream using uncompressed deflate blocks. */
export function zlibStore(data) {
  const nBlocks = Math.max(1, Math.ceil(data.length / 65535))
  const out = new Uint8Array(2 + data.length + nBlocks * 5 + 4)
  let o = 0
  out[o++] = 0x78
  out[o++] = 0x01
  for (let i = 0; i < nBlocks; i++) {
    const chunk = data.subarray(i * 65535, (i + 1) * 65535)
    const last = i === nBlocks - 1
    out[o++] = last ? 1 : 0
    out[o++] = chunk.length & 0xff
    out[o++] = (chunk.length >> 8) & 0xff
    out[o++] = ~chunk.length & 0xff
    out[o++] = (~chunk.length >> 8) & 0xff
    out.set(chunk, o)
    o += chunk.length
  }
  const adler = adler32(data)
  out[o++] = (adler >>> 24) & 0xff
  out[o++] = (adler >>> 16) & 0xff
  out[o++] = (adler >>> 8) & 0xff
  out[o++] = adler & 0xff
  return out.subarray(0, o)
}

/** pixels: Uint8Array of RGB or grayscale samples. gray=true → 1 byte/px, else 3. */
export function pngEncode(width, height, pixels, gray = false) {
  const bpp = gray ? 1 : 3
  const stride = width * bpp
  if (pixels.length !== stride * height) throw new Error('pixel buffer size mismatch')

  const scan = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    scan[y * (stride + 1)] = 0 // filter: none
    scan.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const chunk = (type, data) => {
    const t = new TextEncoder().encode(type)
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, data.length)
    const body = new Uint8Array(t.length + data.length)
    body.set(t)
    body.set(data, t.length)
    const crc = new Uint8Array(4)
    new DataView(crc.buffer).setUint32(0, crc32(body))
    const out = new Uint8Array(4 + body.length + 4)
    out.set(len, 0)
    out.set(body, 4)
    out.set(crc, 4 + body.length)
    return out
  }

  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = gray ? 0 : 2 // color type
  // compression/filter/interlace = 0

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibStore(scan)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
