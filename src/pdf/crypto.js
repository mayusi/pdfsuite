// Zero-dep crypto primitives for the PDF Standard Security Handler.
// md5: RFC 1321. rc4: RC4 stream cipher. Both on Uint8Array.

const S8 = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
const K32 = []
for (let i = 0; i < 64; i++) K32.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296))

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0

/** MD5 digest of bytes → 16-byte Uint8Array. */
export function md5(data) {
  const bitLen = data.length * 8
  const padZeros = (56 - ((data.length + 1) % 64) + 64) % 64
  const padLen = data.length + 1 + padZeros + 8
  const buf = new Uint8Array(padLen)
  buf.set(data)
  buf[data.length] = 0x80
  const dv = new DataView(buf.buffer)
  // 64-bit length little-endian at the tail
  for (let i = 0; i < 8; i++) dv.setUint8(padLen - 8 + i, (bitLen / 2 ** (8 * i)) & 0xff)

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < padLen; off += 64) {
    const M = []
    for (let i = 0; i < 16; i++) M.push(dv.getUint32(off + i * 4, true))
    let [A, B, C, D] = [a0, b0, c0, d0]
    for (let i = 0; i < 64; i++) {
      let F, g
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      F = (F + A + K32[i] + M[g]) >>> 0
      A = D; D = C; C = B
      B = (B + rotl(F, S8[i])) >>> 0
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
  }
  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true)
  ov.setUint32(8, c0, true); ov.setUint32(12, d0, true)
  return out
}

/** RC4 keystream applied to data (in-place-safe copy returned). */
export function rc4(key, data) {
  const S = new Uint8Array(256)
  for (let i = 0; i < 256; i++) S[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff
    ;[S[i], S[j]] = [S[j], S[i]]
  }
  const out = new Uint8Array(data.length)
  let i = 0
  j = 0
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + S[i]) & 0xff
    ;[S[i], S[j]] = [S[j], S[i]]
    out[n] = data[n] ^ S[(S[i] + S[j]) & 0xff]
  }
  return out
}
