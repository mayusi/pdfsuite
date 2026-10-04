import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { ascii85, asciiHex, lzw, runLength, decodeChain } from '../src/pdf/filters.js'
import { aesCbcDecrypt, aesCbcEncrypt, sha256, sha384, sha512 } from '../src/pdf/crypto.js'
import { glyphToUnicode, simpleEncodingTable, toWinAnsi } from '../src/pdf/encodings.js'
import { decodeImage } from '../src/pdf/image.js'
import { compileFunction } from '../src/pdf/functions.js'
import { parsePdf } from '../src/pdf/parse.js'
import { enc, name } from '../src/pdf/types.js'
import { extractText, pageLeaves } from '../src/pdf/ops.js'
import { textFromOps } from '../src/pdf/content.js'
import { decryptPdf, permBits, protectPdf } from '../src/pdf/security.js'

const u8 = (s) => new Uint8Array(Buffer.from(s, 'latin1'))
const str = (b) => Buffer.from(b).toString('latin1')

/** Hand-written one-page PDF whose content stream is wrapped in `filters`. */
function pdfWithContent(content, filterNames, encodeFn) {
  const data = encodeFn(Buffer.from(content, 'latin1'))
  const filt = filterNames.length === 1 ? `/${filterNames[0]}` : `[${filterNames.map((f) => '/' + f).join(' ')}]`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  let out = Buffer.from('%PDF-1.7\n', 'latin1')
  const offs = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    const body = o ?? null
    if (body) out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')])
    else out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n<< /Length ${data.length} /Filter ${filt} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')])
  })
  const x = out.length
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offs) xref += `${String(o).padStart(10, '0')} 00000 n \n`
  out = Buffer.concat([out, Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, 'latin1')])
  return new Uint8Array(out)
}

// minimal encoders for round-trip tests
const a85enc = (b) => {
  let s = ''
  for (let i = 0; i < b.length; i += 4) {
    const chunk = [...b.subarray(i, i + 4)]
    const n = chunk.length
    while (chunk.length < 4) chunk.push(0)
    let v = ((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]) >>> 0
    if (v === 0 && n === 4) { s += 'z'; continue }
    const c = []
    for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85) }
    s += c.slice(0, n + 1).join('')
  }
  return Buffer.from(s + '~>', 'latin1')
}
const lzwEnc = (b) => { // classic 9-12 bit encoder, EarlyChange 1
  const out = []
  let acc = 0, nacc = 0, bits = 9
  const put = (code) => { acc = (acc << bits) | code; nacc += bits; while (nacc >= 8) { out.push((acc >>> (nacc - 8)) & 255); nacc -= 8 } acc &= (1 << nacc) - 1 }
  let dict = new Map(), next = 258
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i)
  put(256)
  let w = ''
  for (const byte of b) {
    const c = String.fromCharCode(byte)
    if (dict.has(w + c)) { w += c; continue }
    put(dict.get(w))
    dict.set(w + c, next++)
    if (next + 1 > (1 << bits) && bits < 12) bits++
    if (next >= 4094) { put(256); dict = new Map(); for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i); next = 258; bits = 9 }
    w = c
  }
  if (w) put(dict.get(w))
  put(257)
  if (nacc) out.push((acc << (8 - nacc)) & 255)
  return Buffer.from(out)
}

describe('stream filters', () => {
  it('ASCII85 decodes groups, z, partial tail', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'hello world!', '\0\0\0\0xyz']) {
      assert.equal(str(ascii85(a85enc(Buffer.from(s, 'latin1')))), s)
    }
    assert.equal(str(ascii85(u8('87cURD]i,"Ebo80~>'))), 'Hello World!')
  })
  it('ASCIIHex ignores whitespace and pads odd tails', () => {
    assert.equal(str(asciiHex(u8('48 65 6c6C 6f>'))), 'Hello')
    assert.deepEqual([...asciiHex(u8('4>'))], [0x40])
  })
  it('RunLength literal + repeat runs', () => {
    assert.equal(str(runLength(new Uint8Array([2, 65, 66, 67, 254, 68, 128]))), 'ABCDDD')
  })
  it('LZW round-trips long repetitive data across code-width changes', () => {
    const src = Buffer.from(Array.from({ length: 30000 }, (_, i) => 'the quick brown fox '[i % 20] + (i % 7)).join(''), 'latin1')
    assert.equal(str(lzw(lzwEnc(src))), str(src))
  })
  it('decodeChain applies multi-filter chains with predictors', async () => {
    const raw = Buffer.from('BT /F1 12 Tf 10 10 Td (Chained) Tj ET', 'latin1')
    const dict = new Map([['Filter', [name('ASCII85Decode'), name('FlateDecode')]]])
    const { data } = await decodeChain(dict, new Uint8Array(a85enc(deflateSync(raw))))
    assert.equal(str(data), str(raw))
  })
  it('pages wrapped in A85+Flate / LZW / AHx render text (reportlab-style files)', async () => {
    const content = 'BT /F1 12 Tf 20 100 Td (Caf\xe9 \x93quoted\x94 text) Tj ET'
    const cases = [
      [['ASCII85Decode', 'FlateDecode'], (b) => a85enc(deflateSync(b))],
      [['LZWDecode'], lzwEnc],
      [['ASCIIHexDecode'], (b) => Buffer.from(b.toString('hex') + '>', 'latin1')],
    ]
    for (const [f, e] of cases) {
      const doc = await parsePdf(pdfWithContent(content, f, e))
      const [txt] = await extractText(doc)
      assert.equal(txt, 'Café “quoted” text', f.join('+'))
    }
  })
  it('streams with an indirect /Length (LibreOffice-style) still parse', async () => {
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>\nendobj\n' +
      '4 0 obj\n<< /Length 5 0 R >>\nstream\nBT /F1 10 Tf 5 5 Td (indirect) Tj ET\nendstream\nendobj\n' +
      '5 0 obj\n37\nendobj\n6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
    const doc = await parsePdf(enc(pdf))
    assert.ok(doc.objects.has('4 0'), 'content object present')
    assert.equal((await extractText(doc))[0], 'indirect')
  })
})

describe('text extraction', () => {
  it('joins kerned fragments by geometry, spaces only at real gaps', () => {
    const t = (x, w, s) => ({ t: 'text', x, y: 100, w, h: 10, size: 10, str: s, rot: 0 })
    assert.equal(textFromOps([t(0, 20, 'Quar'), t(20.2, 5, 't'), t(25.1, 20, 'erly'), t(50, 30, 'Report')]), 'Quarterly Report')
  })
  it('glyph names and encodings decode to Unicode', () => {
    assert.equal(glyphToUnicode('fi'), 'ﬁ')
    assert.equal(glyphToUnicode('eacute'), 'é')
    assert.equal(glyphToUnicode('uni20AC'), '€')
    assert.equal(glyphToUnicode('f_f_i'), 'ffi')
    const tbl = simpleEncodingTable(new Map([['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [2, name('fi'), name('fl')]]]))
    assert.equal(tbl[2] + tbl[3] + tbl[0x93] + tbl[0x80], 'ﬁﬂ“€')
    assert.deepEqual([...toWinAnsi('é“€')], [0xe9, 0x93, 0x80])
    assert.equal(toWinAnsi('✓'), null)
  })
})

describe('crypto primitives', () => {
  it('SHA-256/384/512 match node:crypto', () => {
    for (const len of [0, 55, 56, 64, 111, 112, 128, 999]) {
      const d = randomBytes(len)
      assert.equal(Buffer.from(sha256(d)).toString('hex'), createHash('sha256').update(d).digest('hex'))
      assert.equal(Buffer.from(sha384(d)).toString('hex'), createHash('sha384').update(d).digest('hex'))
      assert.equal(Buffer.from(sha512(d)).toString('hex'), createHash('sha512').update(d).digest('hex'))
    }
  })
  it('AES-128/256-CBC match node:crypto both ways', () => {
    for (const kl of [16, 32]) for (const len of [0, 1, 16, 100]) {
      const key = randomBytes(kl), iv = randomBytes(16), d = randomBytes(len)
      const c = createCipheriv(`aes-${kl * 8}-cbc`, key, iv)
      const ref = Buffer.concat([c.update(d), c.final()])
      assert.deepEqual(Buffer.from(aesCbcEncrypt(key, iv, d)), ref)
      assert.deepEqual(Buffer.from(aesCbcDecrypt(key, iv, new Uint8Array(ref))), d)
    }
  })
})

describe('security handler', () => {
  const base = pdfWithContent('BT /F1 12 Tf 20 100 Td (Top secret) Tj ET', ['FlateDecode'], deflateSync)
  for (const method of ['aes256', 'aes128', 'rc4']) {
    it(`${method}: protect → unlock with user and owner password, wrong password rejected`, async () => {
      const locked = await protectPdf(base, 'user pw', { ownerPwd: 'owner pw', method })
      assert.ok(!str(locked).includes('Top secret'), 'content is encrypted')
      await assert.rejects(() => parsePdf(locked), /password-protected/)
      for (const pw of ['user pw', 'owner pw']) {
        const doc = await parsePdf(await decryptPdf(locked, pw))
        assert.equal((await extractText(doc))[0], 'Top secret')
      }
      await assert.rejects(() => decryptPdf(locked, 'nope'), /wrong password/)
    })
  }
  it('AES-256 accepts non-Latin passwords; legacy modes refuse them clearly', async () => {
    const locked = await protectPdf(base, 'пароль🔒')
    assert.equal(pageLeaves(await parsePdf(await decryptPdf(locked, 'пароль🔒'))).length, 1)
    await assert.rejects(() => protectPdf(base, 'пароль', { method: 'rc4' }), /Latin-1/)
  })
  it('permission bits follow the spec layout', () => {
    assert.equal(permBits() & 0xf3c, 0xf3c)
    assert.equal(permBits({ print: false }) & (1 << 2), 0)
    assert.equal(permBits({ copy: false }) & (1 << 4), 0)
    assert.ok(permBits() < 0, 'high bits set → negative 32-bit int')
  })
})

describe('images + functions', () => {
  const doc = { objects: new Map(), trailer: new Map() }
  const img = (dict, data) => ({ k: 't', dict: new Map(Object.entries(dict)), data: new Uint8Array(data) })
  it('Indexed 1-bit image decodes through its palette', async () => {
    const v = img({ Width: 8, Height: 1, BitsPerComponent: 1, ColorSpace: [name('Indexed'), name('DeviceRGB'), 1, { k: 'x', bytes: new Uint8Array([255, 0, 0, 0, 0, 255]) }] }, [0b10100000])
    const r = await decodeImage(doc, v)
    assert.deepEqual([...r.rgba.slice(0, 8)], [0, 0, 255, 255, 255, 0, 0, 255])
  })
  it('CMYK, ICCBased(N=1) and Decode-inverted gray decode', async () => {
    const cmyk = await decodeImage(doc, img({ Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: name('DeviceCMYK') }, [0, 255, 255, 0]))
    assert.deepEqual([...cmyk.rgba], [255, 0, 0, 255])
    const icc = { k: 't', dict: new Map([['N', 1]]), data: new Uint8Array(0) }
    const g = await decodeImage(doc, img({ Width: 2, Height: 1, BitsPerComponent: 8, ColorSpace: [name('ICCBased'), icc], Decode: [1, 0] }, [0, 255]))
    assert.deepEqual([...g.rgba], [255, 255, 255, 255, 0, 0, 0, 255])
  })
  it('stencil masks paint the fill colour where samples are 0', async () => {
    const r = await decodeImage(doc, img({ Width: 2, Height: 1, ImageMask: true }, [0b01000000]), { fill: [0, 1, 0] })
    assert.deepEqual([...r.rgba], [0, 255, 0, 255, 0, 0, 0, 0])
  })
  it('type 2 / type 4 functions evaluate', async () => {
    const f2 = await compileFunction(doc, new Map([['FunctionType', 2], ['Domain', [0, 1]], ['C0', [0]], ['C1', [10]], ['N', 1]]))
    assert.deepEqual(f2([0.5]), [5])
    const f4 = await compileFunction(doc, { k: 't', dict: new Map([['FunctionType', 4], ['Domain', [0, 1]], ['Range', [0, 1, 0, 1]]]), data: enc('{ dup 0.5 gt { 1 exch sub } if dup }') })
    assert.deepEqual(f4([0.75]).map((x) => +x.toFixed(2)), [0.25, 0.25])
  })
})
