import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { dec, enc, get } from '../src/pdf/types.js'
import { extractText, pageLeaves } from '../src/pdf/ops.js'
import { collectDrawOps } from '../src/pdf/content.js'
import { decodeImage } from '../src/pdf/image.js'
import { applyRemovals, textRuns } from '../src/pdf/redact.js'
import { annotatePdf } from '../src/pdf/stamp.js'

/** One-page PDF with arbitrary content + optional extra objects (n → body). */
function pdf(content, { extra = {}, res = '/Font << /F1 5 0 R >>' } = {}) {
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << ${res} >> /Contents 4 0 R >>`,
    4: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...extra,
  }
  const nums = Object.keys(objs).map(Number).sort((a, b) => a - b)
  let out = '%PDF-1.7\n'
  const offs = {}
  for (const n of nums) { offs[n] = out.length; out += `${n} 0 obj\n${objs[n]}\nendobj\n` }
  const x = out.length
  const max = nums[nums.length - 1]
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`
  for (let n = 1; n <= max; n++) out += `${String(offs[n] ?? 0).padStart(10, '0')} ${offs[n] ? '00000 n' : '65535 f'} \n`
  out += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return enc(out)
}

const redact = async (bytes, regions, opts) => {
  const doc = await parsePdf(bytes)
  const stats = await applyRemovals(doc, [regions], opts)
  return { out: await annotatePdf(doc, []), stats }
}
const textOps = async (bytes) => {
  const d = await parsePdf(bytes)
  return (await collectDrawOps(d, pageLeaves(d)[0], { annots: false })).ops.filter((o) => o.t === 'text' && o.str)
}

describe('redaction', () => {
  it('removes only glyphs under the box and keeps the rest of the line in place', async () => {
    const src = pdf('BT /F1 20 Tf 50 200 Td (Secret: 1234 visible) Tj ET')
    const before = await textOps(src)
    const runs = await textRuns(await parsePdf(src), pageLeaves(await parsePdf(src))[0])
    assert.equal(runs[0].str, 'Secret: 1234 visible')
    // box over "1234": width("Secret: ") = 68.92pt at 20pt → digits span x 118.9–163.4
    const { out, stats } = await redact(src, [{ x: 118, y: 80, w: 45, h: 30 }])
    assert.equal(stats.glyphs, 4)
    const txt = (await extractText(await parsePdf(out)))[0]
    assert.ok(!txt.includes('1234'), txt)
    assert.match(txt, /Secret:/)
    assert.match(txt, /visible/)
    assert.ok(!dec(out).includes('1234'), 'no trace of the digits anywhere in the file')
    // "visible" keeps its exact x position
    const vis0 = before[0].x + before[0].gx[2 * 13]
    const after = await textOps(out)
    const visRun = after.find((o) => o.str.includes('visible'))
    assert.ok(Math.abs(visRun.x + (visRun.gx[2 * visRun.str.indexOf('v')]) - vis0) < 0.01, 'unchanged position')
  })
  it('handles kerned TJ arrays and the \' / " operators', async () => {
    const src = pdf("BT /F1 12 Tf 14 TL 40 250 Td [(Ke) -200 (rned) 50 ( word)] TJ (Next line) ' 2 1 (Third) \" ET")
    const { out } = await redact(src, [{ x: 30, y: 30, w: 80, h: 30 }, { x: 30, y: 58, w: 60, h: 14 }])
    const txt = (await extractText(await parsePdf(out)))[0]
    assert.ok(!/Kerned|Next/.test(txt), txt)
    assert.match(txt, /Third/)
    const lines = (await textOps(out)).map((o) => [o.str, Math.round(o.y)])
    assert.ok(lines.some(([s, y]) => s === 'Third' && y === 300 - 250 + 28), JSON.stringify(lines))
  })
  it('reaches text inside form XObjects without touching other pages\' copies', async () => {
    const form = 'BT /F1 16 Tf 10 10 Td (In a form) Tj ET'
    const src = pdf('q 1 0 0 1 100 100 cm /Fm1 Do Q', {
      res: '/XObject << /Fm1 6 0 R >>',
      extra: { 6: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 5 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream` },
    })
    const { out, stats } = await redact(src, [{ x: 100, y: 160, w: 200, h: 40 }])
    assert.equal(stats.glyphs, 9)
    assert.equal((await extractText(await parsePdf(out)))[0], '')
  })
  it('paints image pixels out (raw image) and re-encodes', async () => {
    const px = 'ff0000'.repeat(16) // 4×4 red, uncompressed hex
    const src = pdf('q 100 0 0 100 50 50 cm /Im1 Do Q', {
      res: '/XObject << /Im1 6 0 R >>',
      extra: { 6: `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${px.length + 1} >>\nstream\n${px}>\nendstream` },
    })
    // image occupies display x 50-150, y 150-250; redact its left half
    const { out, stats } = await redact(src, [{ x: 40, y: 140, w: 60, h: 120 }])
    assert.equal(stats.images, 1)
    const d = await parsePdf(out)
    const img = (await collectDrawOps(d, pageLeaves(d)[0], { annots: false })).ops.find((o) => o.t === 'img')
    const im = await decodeImage(d, img.ref)
    const at = (x, y) => [...im.rgba.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)]
    assert.deepEqual(at(0, 0), [0, 0, 0], 'left half blacked out')
    assert.deepEqual(at(3, 3), [255, 0, 0], 'right half untouched')
  })
  it('inline images under a redaction are rewritten too', async () => {
    const src = pdf('q 40 0 0 40 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID AAAA EI Q')
    const { out, stats } = await redact(src, [{ x: 0, y: 240, w: 100, h: 60 }])
    assert.equal(stats.images, 1)
    assert.ok(!/BI\s/.test(dec(out)), 'inline image replaced by an XObject')
  })
  it('erase mode removes text but draws no box', async () => {
    const src = pdf('BT /F1 20 Tf 50 200 Td (Edit me) Tj ET')
    const { out } = await redact(src, [{ x: 40, y: 75, w: 200, h: 40 }], { mode: 'erase' })
    assert.equal((await extractText(await parsePdf(out)))[0], '')
    const d = await parsePdf(out)
    const rects = (await collectDrawOps(d, pageLeaves(d)[0])).ops.filter((o) => o.t === 'rect')
    assert.equal(rects.length, 0)
  })
})
