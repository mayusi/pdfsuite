import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { dec, enc, get, isStream, name, ref, stream } from '../src/pdf/types.js'
import {
  collectDrawOps, contentBytes, pageLeaves, streamData,
  tokenizeContent,
} from '../src/pdf/ops.js'
import { annotatePdf } from '../src/pdf/stamp.js'

// ---------- fixtures ----------

/** Hand-written classic-xref PDF; every page gets a Contents stream + F1 font. */
function classicPdf(widths, { rotate = [] } = {}) {
  const head = '%PDF-1.7\n'
  let body = ''
  const offs = new Map()
  const add = (n, c) => { offs.set(n, head.length + body.length); body += `${n} 0 obj\n${c}\nendobj\n` }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = widths.map((_, i) => `${3 + i} 0 R`).join(' ')
  add(2, `<< /Type /Pages /Kids [${kids}] /Count ${widths.length} >>`)
  const content = 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET'
  widths.forEach((w, i) => {
    const rot = rotate[i] ? ` /Rotate ${rotate[i]}` : ''
    add(3 + i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} 400]${rot} ` +
      '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ' +
      `/Contents ${3 + widths.length + i} 0 R >>`)
    add(3 + widths.length + i, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  })
  const total = 3 + widths.length * 2
  const xrefAt = head.length + body.length
  let xref = `xref\n0 ${total}\n0000000000 65535 f \r\n`
  for (let n = 1; n < total; n++) xref += String(offs.get(n)).padStart(10, '0') + ' 00000 n \r\n'
  return enc(head + body + xref +
    `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
}

/** All pages share ONE /Resources ref — the inherited-resources shape. */
function sharedResPdf(widths) {
  const head = '%PDF-1.7\n'
  let body = ''
  const offs = new Map()
  const add = (n, c) => { offs.set(n, head.length + body.length); body += `${n} 0 obj\n${c}\nendobj\n` }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = widths.map((_, i) => `${3 + i} 0 R`).join(' ')
  add(2, `<< /Type /Pages /Kids [${kids}] /Count ${widths.length} >>`)
  const content = 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET'
  const resN = 3 + widths.length * 2
  widths.forEach((w, i) => {
    add(3 + i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} 400] ` +
      `/Resources ${resN} 0 R /Contents ${3 + widths.length + i} 0 R >>`)
    add(3 + widths.length + i, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  })
  add(resN, '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>')
  const total = resN + 1
  const xrefAt = head.length + body.length
  let xref = `xref\n0 ${total}\n0000000000 65535 f \r\n`
  for (let n = 1; n < total; n++) xref += String(offs.get(n)).padStart(10, '0') + ' 00000 n \r\n'
  return enc(head + body + xref +
    `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
}

/** qpdf-style indirection: /Contents is a ref TO an array of stream refs. */
function indirectContentsPdf(w) {
  const head = '%PDF-1.7\n'
  let body = ''
  const offs = new Map()
  const add = (n, c) => { offs.set(n, head.length + body.length); body += `${n} 0 obj\n${c}\nendobj\n` }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const content = 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET'
  add(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} 400] ` +
    '/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> ' +
    '/Contents 4 0 R >>')
  add(4, '[5 0 R 6 0 R]')
  add(5, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  add(6, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  const xrefAt = head.length + body.length
  const xref = 'xref\n0 7\n0000000000 65535 f \r\n' +
    [1, 2, 3, 4, 5, 6].map((n) => String(offs.get(n)).padStart(10, '0') + ' 00000 n \r\n').join('')
  return enc(head + body + xref +
    `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
}

/** Minimal JPEG shell: SOI + SOF0 (jpegInfo only needs markers for dims). */
const fakeJpeg = (w, h) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
  (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
  0x03, 0x11, 0x01, 0xff, 0xd9,
])

/** Contents refs of a leaf → [{stream, data}] after deref. */
const contentStreams = (doc, leaf) => {
  let c = get(leaf.dict, 'Contents')
  const refs = Array.isArray(c) ? c : c !== undefined ? [c] : []
  return refs.map((r) => (isStream(r) ? r : deref(doc, r))).filter(isStream)
}

const ORIG_CONTENT = 'BT /F1 12 Tf 10 10 Td (Hi) Tj ET'

// ---------- tests ----------

describe('annotatePdf', () => {
  it('keeps page count; unannotated pages stay byte-identical', async () => {
    const src = classicPdf([200, 300, 400])
    const out = await annotatePdf(src, [
      undefined,
      [{ t: 'stroke', pts: [[10, 10], [50, 60]], color: '#ff0000', width: 2 }],
      null,
    ])
    const doc = await parsePdf(out)
    const leaves = pageLeaves(doc)
    assert.equal(leaves.length, 3)
    for (const i of [0, 2]) {
      const c = get(leaves[i].dict, 'Contents')
      assert.ok(!Array.isArray(c), `page ${i + 1} Contents should stay a single ref`)
      const s = deref(doc, c)
      assert.equal(dec(s.data), ORIG_CONTENT)
    }
    // annotated page: [q, original, Q, stamp] — the original is isolated in its own
    // q…Q so leftover graphics state can never move the stamp
    const streams = contentStreams(doc, leaves[1])
    assert.equal(streams.length, 4)
    assert.equal(dec(streams[0].data).trim(), 'q')
    assert.equal(dec(streams[1].data), ORIG_CONTENT)
    assert.equal(dec(streams[2].data).trim(), 'Q')
    const text = dec(streams[3].data)
    assert.match(text, /10 10 m 50 60 l S/)
    assert.match(text, /1 0 0 RG 2 w 1 J 1 j/)
  })

  it('appends one stream per annotated page and merges resources', async () => {
    const out = await annotatePdf(classicPdf([200]), [[
      { t: 'rect', x: 5, y: 6, w: 30, h: 20, stroke: '#0000ff', fill: '#00ff00', lw: 2, alpha: 0.5 },
      { t: 'text', x: 20, y: 30, text: 'Hi', size: 12, color: '#111111', font: 'helvb' },
      { t: 'image', x: 40, y: 50, w: 24, h: 16, jpeg: fakeJpeg(24, 16) },
    ]])
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const res = deref(doc, get(leaf.dict, 'Resources'))
    // original F1 survives alongside ANN_* additions
    assert.equal(get(get(res, 'Font'), 'F1') instanceof Map || get(get(res, 'Font'), 'F1')?.k, true)
    const fonts = get(res, 'Font')
    assert.equal(get(fonts, 'ANN_HelveticaBold') instanceof Map, true)
    assert.equal(get(get(fonts, 'ANN_HelveticaBold'), 'BaseFont').v, 'Helvetica-Bold')
    assert.equal(get(get(fonts, 'ANN_HelveticaBold'), 'Encoding').v, 'WinAnsiEncoding')
    const gsMap = get(res, 'ExtGState')
    assert.ok(gsMap instanceof Map && gsMap.size >= 1, 'ExtGState merged')
    const gs0 = [...gsMap.values()][0]
    assert.equal(get(gs0, 'ca'), 0.5)
    assert.equal(get(gs0, 'CA'), 0.5)
    const xo = get(res, 'XObject')
    const im = deref(doc, get(xo, 'ANN_Im1'))
    assert.equal(get(im.dict, 'Filter').v, 'DCTDecode')
    assert.equal(get(im.dict, 'Width'), 24)
    assert.equal(get(im.dict, 'Height'), 16)
    const text = dec((await contentBytes(doc, leaf)))
    assert.match(text, /5 6 30 20 re B/)
    assert.match(text, /\/ANN_GS1 gs/)
    assert.match(text, /BT \/ANN_HelveticaBold 12 Tf 1 0 0 -1 20 39\.6 Tm \(Hi\) Tj ET/)
    assert.match(text, /24 0 0 -16 40 66 cm \/ANN_Im1 Do/)
  })

  it('emits every annotation shape inside its own q…Q', async () => {
    const out = await annotatePdf(classicPdf([300]), [[
      { t: 'stroke', pts: [[1, 2], [3, 4], [5, 6]], color: '#123456', width: 3, alpha: 0.8 },
      { t: 'vstroke', pts: [[10, 10, 200], [20, 10, 0.1], [30, 10, 8]], color: '#000000' },
      { t: 'highlight', pts: [[0, 50], [100, 50]], color: '#ffff00', width: 14 },
      { t: 'line', x1: 0, y1: 0, x2: 60, y2: 0, color: '#ff0000', width: 2, arrow: true },
      { t: 'ellipse', x: 10, y: 10, w: 40, h: 20, stroke: '#00ff00', lw: 1.5 },
    ]])
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const data = await contentBytes(doc, leaf)
    const text = dec(data)
    // variable width: per-segment mean of its two end widths, clamped 0.3–60
    assert.match(text, /60 w 10 10 m 20 10 l S/)
    assert.match(text, /4\.05 w 20 10 m 30 10 l S/)
    // highlight → Multiply ExtGState + default alpha .35
    const res = deref(doc, get(leaf.dict, 'Resources'))
    const bm = [...get(res, 'ExtGState').values()].find((d) => get(d, 'BM')?.v === 'Multiply')
    assert.ok(bm, 'highlight ExtGState carries /BM /Multiply')
    assert.match(text, /0 J 1 j 0 50 m 100 50 l S/) // flat caps: highlighter look
    // arrow → filled triangle at tip
    assert.match(text, /60 0 m .* l .* l h f/)
    // ellipse → cubic segs
    assert.match(text, / c .* c .* c .* c h/)
    const ops = tokenizeContent(data)
    const qs = ops.filter((o) => o.op === 'q').length
    const Qs = ops.filter((o) => o.op === 'Q').length
    assert.equal(qs, Qs)
    assert.equal(qs, 6, `each annotation wrapped + original isolated: ${qs} q-ops`)
  })

  it('writes WinAnsi text: octal escapes, never raw UTF-8', async () => {
    const out = await annotatePdf(classicPdf([200]), [[
      { t: 'text', x: 10, y: 20, text: 'café — “x”\nline2 ✓', size: 10, color: '#000000', font: 'times' },
    ]])
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const streams = contentStreams(doc, leaf)
    const data = streams[streams.length - 1].data
    // é→\351, —→\227, “→\223 ”→\224, ✓ unmappable→?
    const text = dec(data)
    assert.match(text, /caf\\351 \\227 \\223x\\224/)
    assert.match(text, /line2 \?/)
    assert.ok(![...data].some((b) => b >= 0x80), 'no raw high bytes in content')
    // two \n-separated lines → two independent BT…Tj blocks, ANN_F3 (Times)
    assert.equal((text.match(/BT \/ANN_TimesRoman 10 Tf/g) ?? []).length, 2)
    assert.equal((text.match(/Tj ET/g) ?? []).length, 2)
    const res = deref(doc, get(leaf.dict, 'Resources'))
    assert.equal(get(get(res, 'Font'), 'ANN_TimesRoman') instanceof Map, true)
    assert.equal(get(get(get(res, 'Font'), 'ANN_TimesRoman'), 'BaseFont').v, 'Times-Roman')
  })

  it('counter-rotates annotations on /Rotate 90 pages', async () => {
    const out = await annotatePdf(classicPdf([100], { rotate: [90] }), [[
      { t: 'stroke', pts: [[10, 10], [20, 30]], color: '#ff0000', width: 2 },
      { t: 'text', x: 30, y: 40, text: 'R', size: 10, color: '#000000' },
    ]])
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const streams = contentStreams(doc, leaf)
    const text = dec(streams[streams.length - 1].data)
    // display-space wrap for rot 90: dispLin [0 1 1 0] + origin at mb origin
    assert.match(text, /q 0 1 1 0 0 0 cm/)
    assert.match(text, /10 10 m 20 30 l S/)
    // text is set inside the display-space wrap with a y-flipped text matrix
    assert.match(text, /1 0 0 -1 30 48 Tm \(R\) Tj/)
    // and the round-trip: collectDrawOps lands the stroke at display (10,10)
    const { ops, box } = await collectDrawOps(doc, leaf)
    assert.deepEqual(box, { w: 400, h: 100 })
    const path = ops.find((o) => o.t === 'path')
    assert.ok(path, 'stroke walked back')
    assert.ok(Math.abs(path.segs[0][1] - 10) < 0.5 && Math.abs(path.segs[0][2] - 10) < 0.5,
      `display coords ${JSON.stringify(path.segs[0])}`)
    const t = ops.find((o) => o.t === 'text' && o.str === 'R')
    assert.ok(t, 'annotated text renders in display space')
    assert.ok(Math.abs(t.x - 30) < 0.5 && Math.abs(t.y - 48) < 0.5, `text pos ${JSON.stringify(t)}`)
  })

  it('skips invalid annotations silently', async () => {
    const out = await annotatePdf(classicPdf([200, 300]), [[
      { t: 'stroke', pts: [[0, 0]], color: '#fff' },            // too few pts + bad color
      { t: 'rect', x: 0, y: 0, w: 10, h: 10 },                // neither fill nor stroke
      { t: 'image', x: 0, y: 0, w: 5, h: 5, jpeg: enc('nope') }, // not a JPEG
      { t: 'bogus' },
      { t: 'text', x: 1, y: 1, text: '', size: 9, color: '#000000' },
      { t: 'stroke', pts: [[7, 7], [8, 8]], color: '#00ff00', width: 1 },
    ], []])
    const doc = await parsePdf(out)
    const leaves = pageLeaves(doc)
    const streams = contentStreams(doc, leaves[0])
    assert.equal(streams.length, 4, 'one valid annotation → q/orig/Q + one appended stream')
    const text = dec(streams[3].data)
    assert.equal((text.match(/ q /g) ?? []).length + (text.startsWith('\nq ') ? 1 : 0), 1, 'exactly one annotation emitted')
    assert.match(text, /7 7 m 8 8 l S/)
    // page 2: empty array → untouched
    const c2 = get(leaves[1].dict, 'Contents')
    assert.ok(!Array.isArray(c2))
    assert.equal(dec(deref(doc, c2).data), ORIG_CONTENT)
  })

  it('lands rect/text/image at exact display coords on unrotated pages', async () => {
    const out = await annotatePdf(classicPdf([300]), [[
      { t: 'rect', x: 50, y: 60, w: 30, h: 20, fill: '#ff0000' },
      { t: 'text', x: 100, y: 120, text: 'Box', size: 12, color: '#000000' },
      { t: 'image', x: 40, y: 50, w: 24, h: 16, jpeg: fakeJpeg(24, 16) },
    ]])
    const doc = await parsePdf(out)
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const r = ops.find((o) => o.t === 'rect')
    assert.ok(r)
    assert.ok(Math.abs(r.x - 50) < 0.5 && Math.abs(r.y - 60) < 0.5 &&
      Math.abs(r.w - 30) < 0.5 && Math.abs(r.h - 20) < 0.5, `rect ${JSON.stringify(r)}`)
    const t = ops.find((o) => o.t === 'text' && o.str === 'Box')
    assert.ok(t)
    assert.ok(Math.abs(t.x - 100) < 0.5 && Math.abs(t.y - 129.6) < 0.5, `text baseline = top + 0.8em ${JSON.stringify(t)}`)
    const im = ops.find((o) => o.t === 'img')
    assert.ok(im)
    assert.ok(Math.abs(im.x - 40) < 0.5 && Math.abs(im.y - 50) < 0.5 &&
      Math.abs(im.w - 24) < 0.5 && Math.abs(im.h - 16) < 0.5, `img ${JSON.stringify(im)}`)
  })

  it('isolates per-page resources when pages share a Resources dict', async () => {
    const out = await annotatePdf(sharedResPdf([200, 300]), [
      [{ t: 'image', x: 0, y: 0, w: 24, h: 16, jpeg: fakeJpeg(24, 16) }],
      [{ t: 'image', x: 0, y: 0, w: 8, h: 8, jpeg: fakeJpeg(8, 8) }],
    ])
    const doc = await parsePdf(out)
    const leaves = pageLeaves(doc)
    const annIm = (leaf) =>
      deref(doc, get(get(deref(doc, get(leaf.dict, 'Resources')), 'XObject'), 'ANN_Im1'))
    assert.equal(get(annIm(leaves[0]).dict, 'Width'), 24)
    assert.equal(get(annIm(leaves[1]).dict, 'Width'), 8)
  })

  it('preserves original content when Contents is an indirect array', async () => {
    const out = await annotatePdf(indirectContentsPdf(300), [[
      { t: 'stroke', pts: [[5, 5], [40, 40]], color: '#ff0000', width: 2 },
    ]])
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const data = dec(await contentBytes(doc, leaf))
    assert.match(data, /\(Hi\) Tj/) // original content survived the array deref
    assert.match(data, /5 5 m 40 40 l S/)
  })
})
