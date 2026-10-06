import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { dec, enc, get } from '../src/pdf/types.js'
import { pageLeaves, pageDims } from '../src/pdf/ops.js'
import { collectDrawOps, contentBytes } from '../src/pdf/content.js'
import { applyRemovals } from '../src/pdf/redact.js'
import { annotatePdf, cropPages } from '../src/pdf/stamp.js'
import { hash2B } from '../src/pdf/security.js'

describe('AES-256 (R6) password hash', () => {
  it('counts rounds from 1 like qpdf / Acrobat (value cross-checked with pypdf)', () => {
    // these inputs end exactly on the stop-condition boundary, where an off-by-one changes the key
    const U = Buffer.from('eaaa27dfaa55a001bfdb3e8d8ac0a437891a4429c6c2cca14b3c627dfac2335cca8396845629992710397c4e0c27d0c8', 'hex')
    const O = Buffer.from('ecdc93a8b5888a485d5ad2522fc0af9604cdbe62446b2d2805d46a7aa93f7f7e2e39f8e0b3685ea65c0053d7de6d51b3', 'hex')
    const k = hash2B(new TextEncoder().encode('pw'), new Uint8Array(O.subarray(40, 48)), new Uint8Array(U), 6)
    assert.equal(Buffer.from(k).toString('hex'), '19973eefcfe2da9303de20b00b68ddc09357375a300b8e4d7ec4ad54e9081d4f')
  })
})

function pdf(content, { extra = '', rotate = 0 } = {}) {
  const px = 'ff0000'.repeat(4)
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300]${rotate ? ` /Rotate ${rotate}` : ''} /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R ${extra}>>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${px.length + 1} >>\nstream\n${px}>\nendstream`,
  ]
  let out = '%PDF-1.7\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  return enc(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`)
}

describe('editor engine additions', () => {
  it('dropimg removes exactly the matching embedded image (and keeps the other)', async () => {
    const src = pdf('q 100 0 0 100 20 20 cm /Im1 Do Q q 50 0 0 50 300 200 cm /Im1 Do Q BT /F1 12 Tf 10 10 Td (keep) Tj ET')
    const doc = await parsePdf(src)
    // first image: user space 20..120 → display y 180..280
    const stats = await applyRemovals(doc, [[{ x: 20, y: 180, w: 100, h: 100 }]], { mode: 'dropimg' })
    assert.equal(stats.images, 1)
    const out = await parsePdf(await annotatePdf(doc, []))
    const { ops } = await collectDrawOps(out, pageLeaves(out)[0])
    const imgs = ops.filter((o) => o.t === 'img')
    assert.equal(imgs.length, 1)
    assert.ok(Math.abs(imgs[0].x - 300) < 0.5, 'the small image survives')
    assert.ok(ops.some((o) => o.t === 'text' && o.str === 'keep'), 'text untouched')
  })
  it('cropPages sets the visible box from display coords (also on rotated pages)', async () => {
    const out = await cropPages(pdf('BT ET'), [{ x: 50, y: 25, w: 200, h: 100 }])
    const d = await parsePdf(out)
    assert.deepEqual(pageDims(d)[0], { w: 200, h: 100, rotate: 0 })
    assert.deepEqual(get(pageLeaves(d)[0].dict, 'CropBox'), [50, 175, 250, 275])
    const rot = await cropPages(pdf('BT ET', { rotate: 90 }), [{ x: 10, y: 20, w: 100, h: 50 }])
    const d2 = await parsePdf(rot)
    assert.deepEqual(pageDims(d2)[0], { w: 50, h: 100, rotate: 90 }) // stored unrotated: 50×100, shown 100×50
  })
  it('blend modes, letter spacing, text outline and shadow are written', async () => {
    const out = await annotatePdf(pdf('BT ET'), [[
      { t: 'rect', x: 10, y: 10, w: 50, h: 50, fill: '#ff0000', blend: 'screen' },
      { t: 'text', x: 20, y: 100, text: 'Fx', size: 20, color: '#000000', spacing: 3, outline: { width: 1.5, color: '#ff0000' }, shadow: { opacity: 50, dx: 30, dy: 30, color: '#000000' } },
    ]])
    const d = await parsePdf(out)
    const leaf = pageLeaves(d)[0]
    const res = deref(d, get(leaf.dict, 'Resources'))
    const gss = [...deref(d, get(res, 'ExtGState')).values()].map((g) => deref(d, g))
    assert.ok(gss.some((g) => get(g, 'BM')?.v === 'Screen'))
    assert.ok(gss.some((g) => get(g, 'ca') === 0.5), 'shadow alpha')
    const text = dec(await contentBytes(d, leaf))
    assert.match(text, /3 Tc/)
    assert.match(text, /2 Tr/)
    assert.equal((text.match(/\(Fx\) Tj/g) ?? []).length, 2, 'shadow + main text')
  })
})
