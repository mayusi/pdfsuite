// PDF Standard Security Handler — unlock RC4-40/128, AES-128 (R4) and
// AES-256 (R5/R6); protect with AES-256 (default), AES-128 or RC4-128,
// including owner password + permission flags.
import { concat, enc, get, isName, isRef, isStream, name, ref, stream, typeIs, dec } from './types.js'
import { deref, parsePdf, parseValue } from './parse.js'
import { newDoc, writeDoc } from './write.js'
import { aesCbcDecrypt, aesCbcEncrypt, md5, rc4, sha256, sha384, sha512 } from './crypto.js'
import { streamData } from './content.js'

const PAD32 = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

/** R2–R4 passwords are Latin-1 byte strings, padded/truncated to 32 bytes. */
const pwdPad = (s) => {
  for (const c of s) {
    if (c.codePointAt(0) > 0xff) throw new Error('this encryption mode needs a Latin-1 password — use AES-256 for other characters')
  }
  const b = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)
  const out = new Uint8Array(32)
  out.set(b.subarray(0, 32))
  if (b.length < 32) out.set(PAD32.subarray(0, 32 - b.length), b.length)
  return out
}
/** R5/R6 passwords are UTF-8, max 127 bytes. */
const pwdUtf8 = (s) => enc(s.normalize('NFKC')).slice(0, 127)

const xorKey = (key, i) => Uint8Array.from(key, (b) => b ^ i)
const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b }
const bytesEq = (a, b, n = a.length) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true }

function randomBytes(n) {
  const out = new Uint8Array(n)
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(out)
  let seed = md5(enc(`${Date.now()}:${Math.random()}:${performance.now?.()}`))
  for (let i = 0; i < n; i++) { if (i % 16 === 0 && i) seed = md5(seed); out[i] = seed[i % 16] ^ ((Math.random() * 256) | 0) }
  return out
}

// ---------- R2–R4 (MD5/RC4 key derivation) ----------

function computeO(ownerPad, userPad, keyLen, R) {
  let d = md5(ownerPad)
  if (R >= 3) for (let i = 0; i < 50; i++) d = md5(d.subarray(0, keyLen))
  const ok = d.subarray(0, keyLen)
  if (R === 2) return rc4(ok, userPad)
  let data = userPad
  for (let i = 0; i < 20; i++) data = rc4(xorKey(ok, i), data)
  return data
}

function computeFileKey(userPad, O, P, id0, keyLen, R, encryptMeta = true) {
  const parts = [userPad, O.subarray(0, 32), le32(P), id0]
  if (R >= 4 && !encryptMeta) parts.push(new Uint8Array([255, 255, 255, 255]))
  let d = md5(concat(parts))
  if (R >= 3) for (let i = 0; i < 50; i++) d = md5(d.subarray(0, keyLen))
  return d.slice(0, keyLen)
}

function computeU(fileKey, id0, R) {
  if (R === 2) return rc4(fileKey, PAD32)
  let data = md5(concat([PAD32, id0]))
  for (let i = 0; i < 20; i++) data = rc4(xorKey(fileKey, i), data)
  const out = new Uint8Array(32)
  out.set(data)
  out.set(md5(fileKey), 16) // arbitrary padding (spec) — deterministic here
  return out
}

// ---------- R5/R6 (SHA-2 / AES-256) ----------

/** Algorithm 2.B (R6) — or plain SHA-256 for R5. */
function hash2B(pwd, salt, udata, R) {
  let K = sha256(concat([pwd, salt, udata]))
  if (R === 5) return K
  for (let round = 0; ; round++) {
    const unit = concat([pwd, K, udata])
    const K1 = new Uint8Array(unit.length * 64)
    for (let i = 0; i < 64; i++) K1.set(unit, i * unit.length)
    const E = aesCbcEncrypt(K.subarray(0, 16), K.subarray(16, 32), K1, false)
    let sum = 0
    for (let i = 0; i < 16; i++) sum += E[i]
    const m = sum % 3
    K = m === 0 ? sha256(E) : m === 1 ? sha384(E) : sha512(E)
    if (round >= 63 && E[E.length - 1] <= round - 32) break
  }
  return K.slice(0, 32)
}

const ZERO_IV = new Uint8Array(16)

// ---------- encrypt-dict analysis ----------

/**
 * Authenticate a password against a Standard-handler encrypt dict.
 * Returns {fileKey, stm, str, R, V, P, encryptMeta, owner} where stm/str are
 * 'RC4' | 'AESV2' | 'AESV3' | 'None'. Throws 'wrong password' / 'unsupported …'.
 */
export function authenticate(doc, encDict, pwd) {
  const dd = (v) => (isRef(v) ? deref(doc, v) : v)
  const filt = dd(get(encDict, 'Filter'))
  if (!isName(filt) || filt.v !== 'Standard') throw new Error('unsupported security handler (certificate-encrypted PDFs need the original certificate)')
  const V = dd(get(encDict, 'V')) ?? 0
  const R = dd(get(encDict, 'R')) ?? 2
  const P = dd(get(encDict, 'P')) ?? -4
  const encryptMeta = dd(get(encDict, 'EncryptMetadata')) !== false
  const O = dd(get(encDict, 'O'))?.bytes
  const U = dd(get(encDict, 'U'))?.bytes
  if (!O || !U) throw new Error('unsupported encryption (missing O/U)')

  // crypt filter selection
  let stm = 'RC4', str = 'RC4'
  if (V >= 4) {
    const cf = dd(get(encDict, 'CF'))
    const method = (sel) => {
      const sn = dd(get(encDict, sel))
      const nm = isName(sn) ? sn.v : 'Identity'
      if (nm === 'Identity') return 'None'
      const f = cf instanceof Map ? dd(cf.get(nm)) : null
      const cfm = f instanceof Map ? dd(get(f, 'CFM')) : null
      const m = isName(cfm) ? cfm.v : 'None'
      if (m === 'V2') return 'RC4'
      if (m === 'AESV2' || m === 'AESV3' || m === 'None') return m
      throw new Error(`unsupported crypt filter ${m}`)
    }
    stm = method('StmF')
    str = method('StrF')
  } else if (V !== 1 && V !== 2) {
    throw new Error(`unsupported encryption version V=${V}`)
  }

  if (R >= 5) {
    const OE = dd(get(encDict, 'OE'))?.bytes
    const UE = dd(get(encDict, 'UE'))?.bytes
    if (!OE || !UE) throw new Error('unsupported encryption (missing OE/UE)')
    const pw = pwdUtf8(pwd)
    const U48 = U.subarray(0, 48)
    if (bytesEq(hash2B(pw, U.subarray(32, 40), new Uint8Array(0), R), U, 32)) {
      const ik = hash2B(pw, U.subarray(40, 48), new Uint8Array(0), R)
      return { fileKey: aesCbcDecrypt(ik, ZERO_IV, UE, false), stm, str, R, V, P, encryptMeta, owner: false }
    }
    if (bytesEq(hash2B(pw, O.subarray(32, 40), U48, R), O, 32)) {
      const ik = hash2B(pw, O.subarray(40, 48), U48, R)
      return { fileKey: aesCbcDecrypt(ik, ZERO_IV, OE, false), stm, str, R, V, P, encryptMeta, owner: true }
    }
    throw new Error('wrong password')
  }

  const id0 = doc.trailer && get(doc.trailer, 'ID')?.[0]?.bytes
  if (!id0) throw new Error('unsupported encryption (missing document ID)')
  const keyLen = V === 1 ? 5 : Math.min(16, ((dd(get(encDict, 'Length')) ?? 40) / 8) | 0) || 5
  const uOk = (key) => {
    const u = computeU(key, id0, R)
    return bytesEq(u, U, R === 2 ? 32 : 16)
  }
  let fileKey = computeFileKey(pwdPad(pwd), O, P, id0, keyLen, R, encryptMeta)
  if (uOk(fileKey)) return { fileKey, stm, str, R, V, P, encryptMeta, owner: false }
  // owner password → recover the user pad from O
  let d = md5(pwdPad(pwd))
  if (R >= 3) for (let i = 0; i < 50; i++) d = md5(d.subarray(0, keyLen))
  const ok = d.subarray(0, keyLen)
  let userPad = O.subarray(0, 32)
  if (R === 2) userPad = rc4(ok, userPad)
  else for (let i = 19; i >= 0; i--) userPad = rc4(xorKey(ok, i), userPad)
  fileKey = computeFileKey(userPad, O, P, id0, keyLen, R, encryptMeta)
  if (uOk(fileKey)) return { fileKey, stm, str, R, V, P, encryptMeta, owner: true }
  throw new Error('wrong password')
}

/** Per-object key for RC4 / AESV2; AESV3 uses the file key directly. */
function objectKey(fileKey, n, g, method) {
  if (method === 'AESV3') return fileKey
  const parts = [fileKey, new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff])]
  if (method === 'AESV2') parts.push(new Uint8Array([0x73, 0x41, 0x6c, 0x54])) // "sAlT"
  return md5(concat(parts)).subarray(0, Math.min(fileKey.length + 5, 16))
}

function cryptBytes(method, key, bytes, encrypt) {
  if (method === 'None') return bytes
  if (method === 'RC4') return rc4(key, bytes)
  if (encrypt) {
    const iv = randomBytes(16)
    return concat([iv, aesCbcEncrypt(key, iv, bytes, true)])
  }
  if (bytes.length < 16) return new Uint8Array(0)
  return aesCbcDecrypt(key, bytes.subarray(0, 16), bytes.subarray(16), true)
}

/** Apply the cipher to every string and stream inside one object value. */
function cryptObject(v, n, g, sec, encrypt) {
  const sk = objectKey(sec.fileKey, n, g, sec.str)
  const tk = objectKey(sec.fileKey, n, g, sec.stm)
  const walk = (x) => {
    if (x instanceof Map) { for (const y of x.values()) walk(y) }
    else if (Array.isArray(x)) { for (const y of x) walk(y) }
    else if (x?.k === 's' || x?.k === 'x') x.bytes = cryptBytes(sec.str, sk, x.bytes, encrypt)
  }
  if (isStream(v)) {
    walk(v.dict)
    const isMeta = typeIs(v.dict, 'Metadata')
    if (!(isMeta && !sec.encryptMeta)) {
      v.data = cryptBytes(sec.stm, tk, v.data, encrypt)
      if (!encrypt) v.dict.set('Length', v.data.length)
    }
  } else walk(v)
}

/** Deep-clone one value, remapping refs through refMap. */
export function cloneVal(v, refMap) {
  if (isRef(v)) return refMap.get(`${v.n} ${v.g}`) ?? null
  if (v instanceof Map) {
    const m = new Map()
    for (const [k, x] of v) m.set(k, cloneVal(x, refMap))
    return m
  }
  if (Array.isArray(v)) return v.map((x) => cloneVal(x, refMap))
  if (isStream(v)) return stream(cloneVal(v.dict, refMap), v.data.slice())
  if (v?.k === 's' || v?.k === 'x') return { ...v, bytes: v.bytes.slice() }
  return v
}

/** Copy every object (minus skip keys and xref streams) into dst; returns maps + root number. */
export function cloneDoc(src, dst, skip = new Set()) {
  const numOf = new Map()
  const refMap = new Map()
  for (const [key, ent] of src.objects) {
    if (skip.has(key)) continue
    const dict = isStream(ent.v) ? ent.v.dict : ent.v
    if (typeIs(dict, 'XRef')) { skip.add(key); continue } // writer emits its own xref
    numOf.set(key, dst.alloc())
  }
  for (const [k, num] of numOf) refMap.set(k, ref(num, 0))
  for (const [key, ent] of src.objects) {
    if (skip.has(key)) continue
    dst.set(numOf.get(key), cloneVal(ent.v, refMap))
  }
  const rootRef = get(src.trailer, 'Root')
  return { numOf, refMap, rootNum: numOf.get(`${rootRef.n} ${rootRef.g}`) }
}

const mapInfo = (src, numOf, refMap, trailer) => {
  const infoRef = get(src.trailer, 'Info')
  if (isRef(infoRef)) {
    const mapped = numOf.get(`${infoRef.n} ${infoRef.g}`)
    if (mapped) trailer.set('Info', ref(mapped, 0))
  } else if (infoRef instanceof Map) trailer.set('Info', cloneVal(infoRef, refMap))
}

/** Is this file encrypted? (cheap check for the UI) */
export async function isEncrypted(bytes) {
  const doc = await parsePdf(bytes, [], true)
  return !!get(doc.trailer, 'Encrypt')
}

/**
 * Unlock a protected PDF with the user OR owner password → unprotected bytes.
 * Throws 'wrong password' when neither authenticates.
 */
export async function decryptPdf(bytes, pwd) {
  const src = await parsePdf(bytes, [], true)
  const encRef = get(src.trailer, 'Encrypt')
  if (!encRef) return bytes
  const encDict = isRef(encRef) ? deref(src, encRef) : encRef
  const sec = authenticate(src, encDict, pwd)
  // encrypted object streams: parsePdf unpacked nothing useful from ciphertext,
  // so decrypt each container with its own key and unpack its objects now
  const objStmKeys = new Set()
  const unpacked = new Set() // inner objects are plaintext already
  for (const [key, ent] of src.objects) {
    const v = ent.v
    if (!isStream(v) || !typeIs(v.dict, 'ObjStm')) continue
    const N = get(v.dict, 'N'), first = get(v.dict, 'First')
    if (typeof N !== 'number' || typeof first !== 'number') continue
    const [n, g] = key.split(' ').map(Number)
    const plain = cryptBytes(sec.stm, objectKey(sec.fileKey, n, g, sec.stm), v.data, false)
    const data = await streamData({ dict: v.dict, data: plain })
    if (!data) continue
    objStmKeys.add(key)
    const header = dec(data.slice(0, first)).trim().split(/\s+/).map(Number)
    for (let i = 0; i < N; i++) {
      const num = header[i * 2], off = header[i * 2 + 1]
      try {
        const [v2] = parseValue(data, first + off)
        const k2 = `${num} 0`
        if (!src.objects.has(k2)) { // a directly-scanned object is the newer revision
          src.objects.set(k2, { n: num, g: 0, v: v2 })
          unpacked.add(k2)
        }
      } catch { /* skip malformed inner object */ }
    }
  }
  const encKey = isRef(encRef) ? `${encRef.n} ${encRef.g}` : null
  const skip = new Set([...objStmKeys, ...(encKey ? [encKey] : [])])
  const dst = newDoc()
  const { numOf, refMap, rootNum } = cloneDoc(src, dst, skip)
  // keys bind to SOURCE object ids — never to the renumbered clones
  for (const [key] of src.objects) {
    if (skip.has(key) || unpacked.has(key)) continue
    const [n, g] = key.split(' ').map(Number)
    cryptObject(dst.objects.get(numOf.get(key)), n, g, sec, false)
  }
  const id0 = get(src.trailer, 'ID')?.[0]?.bytes ?? md5(bytes.subarray(0, 4096))
  const trailer = new Map([['ID', [{ k: 'x', bytes: id0 }, { k: 'x', bytes: md5(concat([id0, enc('unlocked')])) }]]])
  mapInfo(src, numOf, refMap, trailer)
  return writeDoc(dst, rootNum, trailer)
}

/**
 * Permission flags → /P. perms: {print, printHigh, copy, modify, annotate, fill, assemble, accessibility}
 * (all default true — the password gates opening, flags restrict what readers allow after).
 */
export function permBits(perms = {}) {
  const on = (k) => perms[k] !== false
  let p = 0xfffff0c0 | 0 // reserved bits set, 1-2 clear
  if (on('print')) p |= 1 << 2
  if (on('modify')) p |= 1 << 3
  if (on('copy')) p |= 1 << 4
  if (on('annotate')) p |= 1 << 5
  if (on('fill')) p |= 1 << 8
  if (on('accessibility')) p |= 1 << 9
  if (on('assemble')) p |= 1 << 10
  if (on('print') && perms.printHigh !== false) p |= 1 << 11
  return p | 0
}

/**
 * Password-protect a PDF.
 * opts.method: 'aes256' (default, R6) | 'aes128' (R4) | 'rc4' (R3, legacy)
 * opts.ownerPwd: defaults to userPwd. opts.perms: see permBits.
 * An empty user password + owner password = opens freely, restrictions apply.
 */
export async function protectPdf(bytes, userPwd, { ownerPwd, method = 'aes256', perms } = {}) {
  let src = await parsePdf(bytes, [], true)
  if (get(src.trailer, 'Encrypt')) throw new Error('this PDF is already protected — unlock it first')
  const dst = newDoc()
  const { numOf, refMap, rootNum } = cloneDoc(src, dst)
  const P = permBits(perms)
  const owner = ownerPwd || userPwd
  const srcId = get(src.trailer, 'ID')
  const id0 = Array.isArray(srcId) && srcId[0]?.bytes?.length ? srcId[0].bytes.slice(0, 16) : randomBytes(16)
  const id1 = randomBytes(16)
  let sec, encDict
  if (method === 'aes256') {
    const fileKey = randomBytes(32)
    const upw = pwdUtf8(userPwd), opw = pwdUtf8(owner)
    const uvs = randomBytes(8), uks = randomBytes(8), ovs = randomBytes(8), oks = randomBytes(8)
    const none = new Uint8Array(0)
    const U = concat([hash2B(upw, uvs, none, 6), uvs, uks])
    const UE = aesCbcEncrypt(hash2B(upw, uks, none, 6), ZERO_IV, fileKey, false)
    const O = concat([hash2B(opw, ovs, U, 6), ovs, oks])
    const OE = aesCbcEncrypt(hash2B(opw, oks, U, 6), ZERO_IV, fileKey, false)
    const permsBlock = concat([le32(P), new Uint8Array([255, 255, 255, 255]), enc('Tadb'), randomBytes(4)])
    const Perms = aesCbcEncrypt(fileKey, ZERO_IV, permsBlock, false)
    sec = { fileKey, stm: 'AESV3', str: 'AESV3', encryptMeta: true }
    encDict = new Map([
      ['Filter', name('Standard')], ['V', 5], ['R', 6], ['Length', 256], ['P', P],
      ['CF', new Map([['StdCF', new Map([['AuthEvent', name('DocOpen')], ['CFM', name('AESV3')], ['Length', 32]])]])],
      ['StmF', name('StdCF')], ['StrF', name('StdCF')],
      ['O', { k: 'x', bytes: O }], ['U', { k: 'x', bytes: U }],
      ['OE', { k: 'x', bytes: OE }], ['UE', { k: 'x', bytes: UE }], ['Perms', { k: 'x', bytes: Perms }],
    ])
  } else {
    const R = method === 'aes128' ? 4 : 3
    const uPad = pwdPad(userPwd)
    const O = computeO(pwdPad(owner), uPad, 16, R)
    const fileKey = computeFileKey(uPad, O, P, id0, 16, R, true)
    const U = computeU(fileKey, id0, R)
    const m = method === 'aes128' ? 'AESV2' : 'RC4'
    sec = { fileKey, stm: m, str: m, encryptMeta: true }
    encDict = new Map([['Filter', name('Standard')], ['V', R === 4 ? 4 : 2], ['R', R], ['Length', 128], ['P', P],
      ['O', { k: 'x', bytes: O }], ['U', { k: 'x', bytes: U }]])
    if (R === 4) {
      encDict.set('CF', new Map([['StdCF', new Map([['AuthEvent', name('DocOpen')], ['CFM', name('AESV2')], ['Length', 16]])]]))
      encDict.set('StmF', name('StdCF'))
      encDict.set('StrF', name('StdCF'))
    }
  }
  for (const [num, v] of dst.objects) cryptObject(v, num, 0, sec, true)
  const encNum = dst.alloc()
  dst.set(encNum, encDict)
  const trailer = new Map([['Encrypt', ref(encNum, 0)], ['ID', [{ k: 'x', bytes: id0 }, { k: 'x', bytes: id1 }]]])
  mapInfo(src, numOf, refMap, trailer)
  src = null
  return writeDoc(dst, rootNum, trailer)
}
