import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { dec, enc, get } from '../src/pdf/types.js'
import { extractText, mergePdfs, organizePages, pageLeaves, splitPdf, scrubPdf } from '../src/pdf/ops.js'
import { collectDrawOps, contentBytes } from '../src/pdf/content.js'
import { addPageNumbers, annotatePdf, textWidth, watermarkPdf } from '../src/pdf/stamp.js'
import { readOutline } from '../src/pdf/outline.js'

/** n-page PDF (Helvetica text "Page k" on each) with an optional outline + form field. */
function samplePdf(n, { outline = false, field = false, w = 300, h = 400 } = {}) {
  const objs = []
  const add = (body) => { objs.push(body); return objs.length }
  const cat = add(null)
  const pages = add(null)
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const pageNums = []
  for (let i = 0; i < n; i++) {
    const c = `BT /F1 12 Tf 20 ${h - 40} Td (Page ${i + 1}) Tj ET`
    const cs = add(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`)
    pageNums.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cs} 0 R ANNOTS >>`))
  }
  let catExtra = ''
  if (outline) {
    const root = add(null)
    const items = pageNums.map((p, i) => add(`<< /Title (Chapter ${i + 1}) /Parent ${root} 0 R /Dest [${p} 0 R /Fit] PREV NEXT >>`))
    items.forEach((it, i) => {
      objs[it - 1] = objs[it - 1].replace('PREV', i ? `/Prev ${items[i - 1]} 0 R` : '').replace('NEXT', i < items.length - 1 ? `/Next ${items[i + 1]} 0 R` : '')
    })
    objs[root - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`
    catExtra += ` /Outlines ${root} 0 R`
  }
  if (field) {
    const wid = add(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [20 20 200 40] /P ${pageNums[0]} 0 R /F 4 >>`)
    objs[pageNums[0] - 1] = objs[pageNums[0] - 1].replace('ANNOTS', `/Annots [${wid} 0 R]`)
    catExtra += ` /AcroForm << /Fields [${wid} 0 R] /DA (/Helv 0 Tf 0 g) >>`
  }
  objs.forEach((o, i) => { if (o) objs[i] = o.replace(' ANNOTS', '') })
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pages} 0 R${catExtra} >>`
  objs[pages - 1] = `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${n} >>`
  let out = '%PDF-1.7\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return enc(out)
}

describe('annotatePdf — new shapes', () => {
  it('notes and links become real annotations; text aligns with real widths', async () => {
    const out = await annotatePdf(samplePdf(1), [[
      { t: 'note', x: 50, y: 60, text: 'Check this — ok?' },
      { t: 'link', x: 10, y: 10, w: 100, h: 20, url: 'example.com/x' },
      { t: 'text', x: 0, y: 200, w: 300, align: 'center', text: 'Mid', size: 20, color: '#000000' },
      { t: 'text', x: 20, y: 250, text: 'Ünïcode “quotes”', size: 12, color: '#ff0000', underline: true, italic: true, font: 'times' },
    ]])
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const annots = deref(doc, get(leaf.dict, 'Annots')).map((r) => deref(doc, r))
    const note = annots.find((a) => get(a, 'Subtype').v === 'Text')
    const link = annots.find((a) => get(a, 'Subtype').v === 'Link')
    assert.ok(note && link)
    assert.equal(dec(get(get(link, 'A'), 'URI').bytes), 'https://example.com/x')
    const r = get(link, 'Rect')
    assert.deepEqual(r, [10, 370, 110, 390]) // display (10,10)-(110,30) on a 400pt page
    const { ops } = await collectDrawOps(doc, leaf)
    const mid = ops.find((o) => o.t === 'text' && o.str === 'Mid')
    assert.ok(Math.abs(mid.x - (150 - textWidth('Helvetica', 'Mid', 20) / 2)) < 0.5, `centred x ${mid.x}`)
    const [txt] = await extractText(doc)
    assert.match(txt, /Ünïcode “quotes”/)
    assert.match(dec(await contentBytes(doc, leaf)), /\/ANN_TimesItalic/)
  })
  it('RGBA images embed with an /SMask; opaque ones without', async () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 0, 9, 9, 9, 255])
    const opaque = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 1, 1, 1, 255])
    const out = await annotatePdf(samplePdf(1), [[
      { t: 'image', x: 10, y: 10, w: 40, h: 40, rgba, iw: 2, ih: 2 },
      { t: 'image', x: 60, y: 10, w: 40, h: 40, rgba: opaque, iw: 2, ih: 2 },
    ]])
    const doc = await parsePdf(out)
    const xo = deref(doc, get(deref(doc, get(pageLeaves(doc)[0].dict, 'Resources')), 'XObject'))
    const a = deref(doc, get(xo, 'ANN_Im1')), b = deref(doc, get(xo, 'ANN_Im2'))
    assert.ok(get(a.dict, 'SMask'), 'alpha image has a soft mask')
    assert.equal(get(b.dict, 'SMask'), undefined)
  })
  it('a page whose content leaves an unbalanced cm still gets the stamp in the right place', async () => {
    const src = dec(samplePdf(1)).replace(/BT \/F1 12 Tf 20 360 Td \(Page 1\) Tj ET/, '2 0 0 2 50 50 cm BT /F1 12 Tf 0 0 Td (X) Tj ET')
      .replace(/<< \/Length \d+ >>/, (m) => `<< /Length ${'2 0 0 2 50 50 cm BT /F1 12 Tf 0 0 Td (X) Tj ET'.length} >>`)
    const out = await annotatePdf(enc(src), [[{ t: 'rect', x: 10, y: 10, w: 20, h: 20, fill: '#ff0000' }]])
    const doc = await parsePdf(out)
    const r = (await collectDrawOps(doc, pageLeaves(doc)[0])).ops.find((o) => o.t === 'rect')
    assert.ok(Math.abs(r.x - 10) < 0.5 && Math.abs(r.y - 10) < 0.5 && Math.abs(r.w - 20) < 0.5, JSON.stringify(r))
  })
})

describe('watermark + page numbers', () => {
  it('tiled watermark stamps many copies; under=true goes beneath the content', async () => {
    const out = await watermarkPdf(samplePdf(2), { text: 'DRAFT', layout: 'tile', under: true, size: 24 })
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const cs = get(leaf.dict, 'Contents').map((r) => dec(deref(doc, r).data))
    assert.match(cs[0], /\(DRAFT\) Tj/, 'watermark stream first (under)')
    assert.ok((cs[0].match(/\(DRAFT\) Tj/g) ?? []).length > 4, 'tiled')
  })
  it('page selection: watermark only even pages', async () => {
    const out = await watermarkPdf(samplePdf(4), { pages: 'even' })
    const doc = await parsePdf(out)
    const stamped = pageLeaves(doc).map((l) => Array.isArray(get(l.dict, 'Contents')))
    assert.deepEqual(stamped, [false, true, false, true])
  })
  it('page numbers: custom format, colour, mirrored margins on even pages', async () => {
    const out = await addPageNumbers(samplePdf(2), { fmt: 'page-n-of-total', pos: 'br', mirror: true, color: '#ff0000' })
    const doc = await parsePdf(out)
    const [p1, p2] = (await Promise.all(pageLeaves(doc).map((l) => collectDrawOps(doc, l)))).map((r) => r.ops.find((o) => o.t === 'text' && /of/.test(o.str)))
    assert.equal(p1.str, 'Page 1 of 2')
    assert.ok(p1.x > 150 && p2.x < 50, `odd right, even left: ${p1.x} ${p2.x}`)
    assert.deepEqual(p1.fc.map((v) => +v.toFixed(2)), [1, 0, 0])
  })
})

describe('bookmarks + forms survive page operations', () => {
  it('split keeps bookmarks for kept pages; organize retargets them', async () => {
    const src = samplePdf(4, { outline: true })
    const [first] = await splitPdf(src, [{ from: 2, to: 3 }])
    const d1 = await parsePdf(first)
    assert.deepEqual(readOutline(d1).map((n) => n.title), ['Chapter 2', 'Chapter 3'])
    const re = await organizePages(src, [{ page: 4 }, { page: 1 }])
    const d2 = await parsePdf(re)
    const ol = readOutline(d2)
    const leaves = pageLeaves(d2)
    const idx = (n) => leaves.findIndex((l) => `${l.ref.n} ${l.ref.g}` === n.page)
    assert.deepEqual(ol.map((n) => [n.title, idx(n)]), [['Chapter 1', 1], ['Chapter 4', 0]])
  })
  it('merge nests each file under its name and keeps / dedupes form fields', async () => {
    const a = samplePdf(2, { outline: true, field: true }), b = samplePdf(1, { field: true })
    const out = await mergePdfs([a, b], { names: ['a.pdf', 'b.pdf'] })
    const doc = await parsePdf(out)
    const ol = readOutline(doc)
    assert.deepEqual(ol.map((n) => n.title), ['a.pdf', 'b.pdf'])
    assert.deepEqual(ol[0].children.map((n) => n.title), ['Chapter 1', 'Chapter 2'])
    const root = deref(doc, get(doc.trailer, 'Root'))
    const fields = deref(doc, get(deref(doc, get(root, 'AcroForm')), 'Fields')).map((r) => dec(get(deref(doc, r), 'T').bytes))
    assert.deepEqual(fields, ['name', 'name_2'])
  })
  it('a link to a dropped page does not drag that page into a split', async () => {
    const src = dec(samplePdf(3)).replace('/Contents 5 0 R', '/Contents 5 0 R /Annots [<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [8 0 R /Fit] >>]')
    const [one] = await splitPdf(enc(src), [{ from: 1, to: 1 }])
    assert.ok(!dec(one).includes('(Page 2)'), 'page 2 content must not be copied')
    assert.equal(pageLeaves(await parsePdf(one)).length, 1)
  })
  it('scrub keeps bookmarks + fields, drops comments', async () => {
    const src = samplePdf(2, { outline: true, field: true })
    const noted = await annotatePdf(src, [[{ t: 'note', x: 5, y: 5, text: 'secret comment' }]])
    const clean = await scrubPdf(noted)
    const doc = await parsePdf(clean)
    assert.equal(readOutline(doc).length, 2)
    assert.ok(!dec(clean).includes('secret comment'))
    assert.ok(dec(clean).includes('/T (name)'), 'form field name kept')
  })
})
