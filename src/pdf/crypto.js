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

// ---------- AES (FIPS-197) — 128/256-bit keys, CBC mode ----------

const SBOX = new Uint8Array(256)
const INV_SBOX = new Uint8Array(256)
const xt = (b) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff
const gmul = (a, b) => {
  let r = 0
  while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1 }
  return r
}
{
  // S-box = affine transform of the GF(2^8) multiplicative inverse
  for (let i = 0; i < 256; i++) {
    let inv = 0
    if (i) for (let j = 1; j < 256; j++) if (gmul(i, j) === 1) { inv = j; break }
    let x = inv
    let s = inv
    for (let k = 0; k < 4; k++) { x = ((x << 1) | (x >> 7)) & 0xff; s ^= x }
    SBOX[i] = s ^ 0x63
  }
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i
}

/** Expand a 16/32-byte key → round keys (Uint8Array of 16*(rounds+1)). */
function aesExpand(key) {
  const nk = key.length / 4
  const rounds = nk + 6
  const w = new Uint8Array(16 * (rounds + 1))
  w.set(key)
  let rcon = 1
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t = w.slice(4 * (i - 1), 4 * i)
    if (i % nk === 0) {
      t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]])
      rcon = xt(rcon)
    } else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b])
    for (let k = 0; k < 4; k++) w[4 * i + k] = w[4 * (i - nk) + k] ^ t[k]
  }
  return { w, rounds }
}

function aesEncBlock({ w, rounds }, inp, out) {
  const s = inp.slice(0, 16)
  for (let i = 0; i < 16; i++) s[i] ^= w[i]
  for (let r = 1; r <= rounds; r++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]
    // shift rows (column-major state)
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t
    if (r !== rounds) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3]
        s[c] = xt(a0) ^ xt(a1) ^ a1 ^ a2 ^ a3
        s[c + 1] = a0 ^ xt(a1) ^ xt(a2) ^ a2 ^ a3
        s[c + 2] = a0 ^ a1 ^ xt(a2) ^ xt(a3) ^ a3
        s[c + 3] = xt(a0) ^ a0 ^ a1 ^ a2 ^ xt(a3)
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= w[16 * r + i]
  }
  out.set(s)
}

function aesDecBlock({ w, rounds }, inp, out) {
  const s = inp.slice(0, 16)
  for (let i = 0; i < 16; i++) s[i] ^= w[16 * rounds + i]
  for (let r = rounds - 1; r >= 0; r--) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]
    for (let i = 0; i < 16; i++) s[i] ^= w[16 * r + i]
    if (r !== 0) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3]
        s[c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)
        s[c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)
        s[c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)
        s[c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)
      }
    }
  }
  out.set(s)
}

/** AES-CBC encrypt. pad=true adds PKCS#5 padding; otherwise data must be ×16. */
export function aesCbcEncrypt(key, iv, data, pad = true) {
  const ks = aesExpand(key)
  const n = pad ? 16 - (data.length % 16) : 0
  const buf = new Uint8Array(data.length + n)
  buf.set(data)
  buf.fill(n, data.length)
  if (buf.length % 16) throw new Error('aes: data not block-aligned')
  const out = new Uint8Array(buf.length)
  let prev = iv
  const blk = new Uint8Array(16)
  for (let o = 0; o < buf.length; o += 16) {
    for (let i = 0; i < 16; i++) blk[i] = buf[o + i] ^ prev[i]
    aesEncBlock(ks, blk, out.subarray(o, o + 16))
    prev = out.subarray(o, o + 16)
  }
  return out
}

/** AES-CBC decrypt. unpad strips PKCS#5 padding when valid (lenient when not). */
export function aesCbcDecrypt(key, iv, data, unpad = true) {
  const ks = aesExpand(key)
  const len = data.length - (data.length % 16)
  const out = new Uint8Array(len)
  let prev = iv
  const blk = new Uint8Array(16)
  for (let o = 0; o < len; o += 16) {
    aesDecBlock(ks, data.subarray(o, o + 16), blk)
    for (let i = 0; i < 16; i++) out[o + i] = blk[i] ^ prev[i]
    prev = data.subarray(o, o + 16)
  }
  if (!unpad || !len) return out
  const p = out[len - 1]
  if (p >= 1 && p <= 16 && out.subarray(len - p).every((b) => b === p)) return out.slice(0, len - p)
  return out
}

// ---------- SHA-2 (FIPS 180-4) — 256 / 384 / 512 ----------

const K256 = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const shaPad = (data, blockLen) => {
  const lenBytes = blockLen === 64 ? 8 : 16
  const total = Math.ceil((data.length + 1 + lenBytes) / blockLen) * blockLen
  const buf = new Uint8Array(total)
  buf.set(data)
  buf[data.length] = 0x80
  const bits = data.length * 8
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 4, bits >>> 0)
  dv.setUint32(total - 8, Math.floor(bits / 2 ** 32))
  return { buf, dv }
}

export function sha256(data) {
  const { buf, dv } = shaPad(data, 64)
  const H = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  const rr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let o = 0; o < buf.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + 4 * i)
    for (let i = 16; i < 64; i++) {
      const s0 = rr(W[i - 15], 7) ^ rr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rr(W[i - 2], 17) ^ rr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) >>> 0
      const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  H.forEach((v, i) => ov.setUint32(4 * i, v))
  return out
}

// SHA-512 on (hi, lo) 32-bit pairs
const hexPair = (x) => [parseInt(x.slice(0, 8), 16) >>> 0, parseInt(x.slice(8), 16) >>> 0]
const K512 = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019',
  '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
  '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3',
  '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725',
  '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
  '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001',
  'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb',
  '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
  '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207',
  'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a',
  '5fcb6fab3ad6faec', '6c44198c4a475817',
].map(hexPair)
const IV512 = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map(hexPair)
const IV384 = ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'].map(hexPair)

function sha512core(data, iv, outLen) {
  const { buf, dv } = shaPad(data, 128)
  const H = iv.map((x) => [...x])
  const Wh = new Uint32Array(80), Wl = new Uint32Array(80)
  const rotr = (h, l, n) => (n < 32
    ? [((h >>> n) | (l << (32 - n))) >>> 0, ((l >>> n) | (h << (32 - n))) >>> 0]
    : [((l >>> (n - 32)) | (h << (64 - n))) >>> 0, ((h >>> (n - 32)) | (l << (64 - n))) >>> 0])
  const shr = (h, l, n) => [h >>> n, ((l >>> n) | (h << (32 - n))) >>> 0]
  const add = (...ps) => {
    let lo = 0, hi = 0
    for (const [ph, pl] of ps) { lo += pl; hi += ph }
    hi += Math.floor(lo / 4294967296)
    return [hi >>> 0, lo >>> 0]
  }
  const x3 = (a, b, c) => [(a[0] ^ b[0] ^ c[0]) >>> 0, (a[1] ^ b[1] ^ c[1]) >>> 0]
  for (let o = 0; o < buf.length; o += 128) {
    for (let i = 0; i < 16; i++) { Wh[i] = dv.getUint32(o + 8 * i); Wl[i] = dv.getUint32(o + 8 * i + 4) }
    for (let i = 16; i < 80; i++) {
      const s0 = x3(rotr(Wh[i - 15], Wl[i - 15], 1), rotr(Wh[i - 15], Wl[i - 15], 8), shr(Wh[i - 15], Wl[i - 15], 7))
      const s1 = x3(rotr(Wh[i - 2], Wl[i - 2], 19), rotr(Wh[i - 2], Wl[i - 2], 61), shr(Wh[i - 2], Wl[i - 2], 6))
      const r = add([Wh[i - 16], Wl[i - 16]], s0, [Wh[i - 7], Wl[i - 7]], s1)
      Wh[i] = r[0]; Wl[i] = r[1]
    }
    let [a, b, c, d, e, f, g, h] = H.map((x) => [...x])
    for (let i = 0; i < 80; i++) {
      const S1 = x3(rotr(e[0], e[1], 14), rotr(e[0], e[1], 18), rotr(e[0], e[1], 41))
      const ch = [((e[0] & f[0]) ^ (~e[0] & g[0])) >>> 0, ((e[1] & f[1]) ^ (~e[1] & g[1])) >>> 0]
      const t1 = add(h, S1, ch, K512[i], [Wh[i], Wl[i]])
      const S0 = x3(rotr(a[0], a[1], 28), rotr(a[0], a[1], 34), rotr(a[0], a[1], 39))
      const maj = [((a[0] & b[0]) ^ (a[0] & c[0]) ^ (b[0] & c[0])) >>> 0, ((a[1] & b[1]) ^ (a[1] & c[1]) ^ (b[1] & c[1])) >>> 0]
      const t2 = add(S0, maj)
      h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2)
    }
    ;[a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = add(H[i], v) })
  }
  const out = new Uint8Array(64)
  const ov = new DataView(out.buffer)
  H.forEach(([hh, ll], i) => { ov.setUint32(8 * i, hh); ov.setUint32(8 * i + 4, ll) })
  return out.slice(0, outLen)
}
export const sha512 = (data) => sha512core(data, IV512, 64)
export const sha384 = (data) => sha512core(data, IV384, 48)
