import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { dec, enc, get, isStream, name, ref, set, stream, typeIs } from '../src/pdf/types.js'
import { newDoc, writeDoc } from '../src/pdf/write.js'
import {
  addPageNumbers, collectDrawOps, decodeString, displayTransform, extractImages,
  extractPages, fontMap, imagesToPdf, jpegInfo, mergePdfs,
  organizePages, pageCount, pageDims, pageLeaves, pagePreview, parseRanges,
  parseToUnicode, readMetadata, scrubPdf, splitPdf, tokenizeContent, unPredict,
} from '../src/pdf/ops.js'
import { crc32, zipStore } from '../src/zip.js'
import { pngEncode, zlibStore } from '../src/png.js'

// ---------- fixtures ----------

/** A hand-written, classic-xref PDF — ground truth independent of our writer. */
function classicPdf(widths, { rotate = [] } = {}) {
  const head = '%PDF-1.7\n'
  let body = ''
  const offs = new Map()
  const add = (n, content) => {
    offs.set(n, head.length + body.length)
    body += `${n} 0 obj\n${content}\nendobj\n`
  }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  const kids = widths.map((_, i) => `${3 + i} 0 R`).join(' ')
  add(2, `<< /Type /Pages /Kids [${kids}] /Count ${widths.length} >>`)
  widths.forEach((w, i) => {
    const rot = rotate[i] ? ` /Rotate ${rotate[i]}` : ''
    add(3 + i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} 400]${rot} >>`)
  })
  const xrefAt = head.length + body.length
  let xref = `xref\n0 ${3 + widths.length}\n0000000000 65535 f \r\n`
  for (let n = 1; n < 3 + widths.length; n++)
    xref += String(offs.get(n)).padStart(10, '0') + ' 00000 n \r\n'
  return enc(head + body + xref +
    `trailer\n<< /Size ${3 + widths.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
}

/** Same fixture but MediaBox lives on the /Pages node (inherited). */
function inheritedPdf() {
  const head = '%PDF-1.7\n'
  const body =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 612 792] >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n' +
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 700] >>\nendobj\n'
  const at = head.length + body.length
  return enc(head + body +
    `xref\n0 5\n0000000000 65535 f \r\n0000000000 00000 n \r\n` +
    `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`)
}

/** PDF containing an /ObjStm — objects 4,5 hidden in a compressed stream. */
function objStmPdf() {
  const head = '%PDF-1.7\n'
  const inner = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 111 111] >>'
  const inner2 = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 222 222] >>'
  const header = `4 0 5 ${inner.length}`
  const payload = deflateSync(enc(header + inner + inner2))
  const body =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>\nendobj\n' +
    `3 0 obj\n<< /Type /ObjStm /N 2 /First ${header.length} /Length ${payload.length} /Filter /FlateDecode >>\nstream\n`
  const bodyBytes = enc(head + body)
  const tail = enc(`\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \r\n` +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`)
  const out = new Uint8Array(bodyBytes.length + payload.length + tail.length)
  out.set(bodyBytes, 0); out.set(payload, bodyBytes.length); out.set(tail, bodyBytes.length + payload.length)
  return out
}

const widthsOf = async (bytes) => {
  const doc = await parsePdf(bytes)
  return pageLeaves(doc).map((l) => get(l.dict, 'MediaBox')[2])
}

const rotationsOf = async (bytes) => {
  const doc = await parsePdf(bytes)
  return pageLeaves(doc).map((l) => get(l.dict, 'Rotate') ?? l.inh.Rotate ?? 0)
}

// ---------- tests ----------

describe('parser', () => {
  it('reads a classic-xref pdf', async () => {
    const doc = await parsePdf(classicPdf([100, 200, 300]))
    assert.equal(pageLeaves(doc).length, 3)
  })

  it('resolves inherited page attributes', async () => {
    const doc = await parsePdf(inheritedPdf())
    const leaves = pageLeaves(doc)
    assert.equal(leaves[0].inh.MediaBox[2], 612)
    assert.equal(get(leaves[1].dict, 'MediaBox')[2], 700)
  })

  it('unpacks /ObjStm objects', async () => {
    const doc = await parsePdf(objStmPdf())
    const w = pageLeaves(doc).map((l) => get(l.dict, 'MediaBox')[2])
    assert.deepEqual(w, [111, 222])
  })

  it('skips fake obj markers inside stream data', async () => {
    const dst = newDoc()
    const streamNum = dst.alloc()
    dst.set(streamNum, stream(new Map(), enc('junk 9 9 obj \xff\xfe binary junk')))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(999, 0)]]))
    const bytes = writeDoc(dst, catNum)
    const doc = await parsePdf(bytes)
    assert.equal(doc.objects.has('9 9'), false)
  })

  it('skips parseable-but-unterminated fake objects', async () => {
    const dst = newDoc()
    const streamNum = dst.alloc()
    dst.set(streamNum, stream(new Map(), enc('junk 9 9 obj << /Fake 1 >> noendobj')))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(999, 0)]]))
    const bytes = writeDoc(dst, catNum)
    const doc = await parsePdf(bytes)
    assert.equal(doc.objects.has('9 9'), false)
  })

  it('rejects encrypted pdfs', async () => {
    const head = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'
    const bytes = enc(head + 'trailer\n<< /Size 2 /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n')
    await assert.rejects(parsePdf(bytes), /password-protected/i)
  })
})

describe('ops', () => {
  it('merges in order', async () => {
    const out = await mergePdfs([classicPdf([100, 200]), classicPdf([300, 400, 500])])
    assert.deepEqual(await widthsOf(out), [100, 200, 300, 400, 500])
  })

  it('extracts ranges', async () => {
    const out = await extractPages(classicPdf([100, 200, 300, 400, 500]), [
      { from: 2, to: 3 }, { from: 5, to: 5 },
    ])
    assert.deepEqual(await widthsOf(out), [200, 300, 500])
  })

  it('splits into one pdf per range', async () => {
    const outs = await splitPdf(classicPdf([100, 200, 300, 400]), [
      { from: 1, to: 2 }, { from: 3, to: 4 },
    ])
    assert.equal(outs.length, 2)
    assert.deepEqual(await widthsOf(outs[0]), [100, 200])
    assert.deepEqual(await widthsOf(outs[1]), [300, 400])
  })

  it('reorders and deletes pages', async () => {
    const out = await organizePages(classicPdf([100, 200, 300]), [
      { page: 3, rotation: 0 }, { page: 1, rotation: 0 },
    ])
    assert.deepEqual(await widthsOf(out), [300, 100])
  })

  it('applies rotation, adding to existing', async () => {
    const out = await organizePages(classicPdf([100], { rotate: [270] }), [{ page: 1, rotation: 90 }])
    assert.deepEqual(await rotationsOf(out), [0])
  })

  it('rejects out-of-range pages', async () => {
    await assert.rejects(
      organizePages(classicPdf([100, 200]), [{ page: 9, rotation: 0 }]),
      /out of range/,
    )
  })

  it('preserves page content streams through merge', async () => {
    const dst = newDoc()
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('0 0 m 10 10 l S')))
    const pageNum = dst.alloc()
    const pagesNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 100, 100]], ['Contents', ref(csNum)],
      ['Resources', new Map()],
    ]))
    dst.set(pagesNum, new Map([
      ['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1],
    ]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const src = writeDoc(dst, catNum)

    const merged = await mergePdfs([src, src])
    const doc = await parsePdf(merged)
    const leaves = pageLeaves(doc)
    assert.equal(leaves.length, 2)
    for (const leaf of leaves) {
      const cs = deref(doc, get(leaf.dict, 'Contents'))
      assert.equal(new TextDecoder().decode(cs.data).trim(), '0 0 m 10 10 l S')
    }
  })
})

describe('imagesToPdf', () => {
  const fakeJpeg = (w, h) => {
    const b = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03, 0xff, 0xda]
    return new Uint8Array(b)
  }

  it('reads jpeg dimensions', () => {
    assert.deepEqual(jpegInfo(fakeJpeg(640, 480)), { width: 640, height: 480, colorSpace: 'DeviceRGB' })
  })

  it('wraps jpegs into one-page-each pdfs', async () => {
    const out = imagesToPdf([{ data: fakeJpeg(640, 480) }, { data: fakeJpeg(320, 240) }])
    const doc = await parsePdf(out)
    const leaves = pageLeaves(doc)
    assert.equal(leaves.length, 2)
    assert.equal(get(leaves[0].dict, 'MediaBox')[2], 640)
    const res = deref(doc, get(leaves[0].dict, 'Resources'))
    const xobj = deref(doc, get(get(res, 'XObject'), 'Im0'))
    assert.equal(xobj.data.length, 14)
  })
})

describe('parseRanges', () => {
  it('parses mixed specs', () => {
    assert.deepEqual(parseRanges('1-3, 5, 8-10', 20), [
      { from: 1, to: 3 }, { from: 5, to: 5 }, { from: 8, to: 10 },
    ])
  })
  it('rejects bad input', () => {
    assert.throws(() => parseRanges('abc', 10), /bad range/)
    assert.throws(() => parseRanges('5-2', 10), /out of bounds/)
    assert.throws(() => parseRanges('0', 10), /out of bounds/)
    assert.throws(() => parseRanges('11', 10), /out of bounds/)
    assert.throws(() => parseRanges('  ', 10), /no ranges/)
  })
})

describe('new tools', () => {
  /** PDF with a DCTDecode image + a FlateDecode raw-RGB image embedded. */
  function pdfWithImages() {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const jpgNum = dst.alloc()
    dst.set(jpgNum, stream(new Map([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', 4], ['Height', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerComponent', 8], ['Filter', name('DCTDecode')], ['Length', 10],
    ]), new Uint8Array(10).fill(0xab)))
    const raw = new Uint8Array(2 * 2 * 3).fill(0x7f)
    const flated = deflateSync(raw)
    const rawNum = dst.alloc()
    dst.set(rawNum, stream(new Map([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', 2], ['Height', 2], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerComponent', 8], ['Filter', name('FlateDecode')], ['Length', flated.length],
    ]), flated))
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('q 10 0 0 10 0 0 cm /Im0 Do Q')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 100, 100]], ['Contents', ref(csNum)],
      ['Resources', new Map([['XObject', new Map([['Im0', ref(jpgNum)], ['Im1', ref(rawNum)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    return writeDoc(dst, catNum)
  }

  it('extractImages pulls jpeg + converts raw raster to png', async () => {
    const { images, skipped } = await extractImages(pdfWithImages())
    assert.equal(skipped, 0)
    assert.equal(images.length, 2)
    const jpg = images.find((i) => i.name.endsWith('.jpg'))
    const png = images.find((i) => i.name.endsWith('.png'))
    assert.ok(jpg && png, 'expected one jpg and one png')
    assert.equal(jpg.data.length, 10)
    assert.deepEqual([...png.data.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]) // PNG sig
  })

  it('addPageNumbers stamps a trailing content stream per page', async () => {
    const out = await addPageNumbers(classicPdf([100, 200, 300]))
    const doc = await parsePdf(out)
    const leaves = pageLeaves(doc)
    assert.equal(leaves.length, 3)
    const first = leaves[0]
    const contents = get(first.dict, 'Contents')
    const lastRef = Array.isArray(contents) ? contents[contents.length - 1] : contents
    const last = deref(doc, lastRef)
    const text = new TextDecoder('latin1').decode(last.data)
    assert.match(text, /BT \/PDFFnt1 10 Tf/)
    assert.match(text, /\(1 \/ 3\) Tj/)
    const font = get(get(get(first.dict, 'Resources'), 'Font'), 'PDFFnt1')
    assert.equal(get(font, 'BaseFont').v, 'Helvetica')
  })

  it('scrubPdf drops trailer Info and catalog Metadata', async () => {
    // build a doc, then append a trailer with /Info + /ID by hand
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 50, 50]]]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const metaNum = dst.alloc()
    dst.set(metaNum, stream(new Map([['Type', name('Metadata')], ['Subtype', name('XML')]]), enc('<x:xmpmeta>tracking</x:xmpmeta>')))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([
      ['Type', name('Catalog')], ['Pages', ref(pagesNum)],
      ['Metadata', ref(metaNum)],
    ]))
    let bytes = writeDoc(dst, catNum)
    const dirty = enc(new TextDecoder('latin1').decode(bytes).replace(
      '/Root ' + catNum + ' 0 R >>',
      `/Root ${catNum} 0 R /Info << /Author (nsa) /Producer (adobe) >> /ID [<aa><bb>] >>`,
    ))
    const clean = await scrubPdf(dirty)
    const str = new TextDecoder('latin1').decode(clean)
    assert.ok(!str.includes('nsa'), 'author should be gone')
    assert.ok(!str.includes('xmpmeta'), 'xmp should be gone')
    assert.ok(!str.includes('/Info'), 'info should be gone')
    assert.equal((await pageCount(clean)), 1)
  })

  it('unPredict reverses PNG sub+up filters', () => {
    // 2 rows, 3 cols, 1 color: row0 filter 1 (sub), row1 filter 2 (up)
    const row0 = [1, 10, 5, 5] // filter1: bytes are deltas → 10,15,20
    const row1 = [2, 2, 2, 2] // filter2: +above → 12,17,22
    const out = unPredict(new Uint8Array([...row0, ...row1]), { predictor: 15, columns: 3, colors: 1, bpc: 8 })
    assert.deepEqual([...out], [10, 15, 20, 12, 17, 22])
  })

  it('unPredict tiff predictor adds left neighbour', () => {
    const out = unPredict(new Uint8Array([5, 5, 5]), { predictor: 2, columns: 3, colors: 1, bpc: 8 })
    assert.deepEqual([...out], [5, 10, 15])
  })

  it('pngEncode emits valid PNG structure', () => {
    const png = pngEncode(2, 2, new Uint8Array(12).fill(128))
    assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const s = new TextDecoder('latin1').decode(png)
    assert.ok(s.includes('IHDR') && s.includes('IDAT') && s.includes('IEND'))
  })

  it('zlibStore round-trips through inflate', async () => {
    const { inflateSync } = await import('node:zlib')
    const data = enc('hello png world '.repeat(5000)) // >64KB → multi-block
    const round = inflateSync(Buffer.from(zlibStore(data)))
    assert.deepEqual(new Uint8Array(round), data)
  })
})

describe('qol engine', () => {
  it('pageDims returns per-page geometry incl inherited + rotation', async () => {
    const doc = await parsePdf(inheritedPdf())
    assert.deepEqual(pageDims(doc), [
      { w: 612, h: 792, rotate: 0 },
      { w: 700, h: 700, rotate: 0 },
    ])
    const rot = await parsePdf(classicPdf([100], { rotate: [90] }))
    assert.equal(pageDims(rot)[0].rotate, 90)
  })

  it('readMetadata surfaces Info fields, XMP and doc ID', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 50, 50]]]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const metaNum = dst.alloc()
    dst.set(metaNum, stream(new Map([['Type', name('Metadata')], ['Subtype', name('XML')]]), enc('<x:xmpmeta>x</x:xmpmeta>')))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)], ['Metadata', ref(metaNum)]]))
    const bytes = writeDoc(dst, catNum)
    const dirty = enc(new TextDecoder('latin1').decode(bytes).replace(
      '/Root ' + catNum + ' 0 R',
      `/Root ${catNum} 0 R /Info << /Author (sneaky) /Producer (acme) >> /ID [<aa><bb>] `,
    ))
    const meta = await readMetadata(dirty)
    assert.equal(meta.xmp, true)
    assert.equal(meta.id, true)
    const kv = Object.fromEntries(meta.fields.map((f) => [f.key, f.value]))
    assert.equal(kv.Author, 'sneaky')
    assert.equal(kv.Producer, 'acme')
  })

  it('readMetadata decodes UTF-16BE strings', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 50, 50]]]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const bytes = writeDoc(dst, catNum)
    // /Title <FEFF00480069> = UTF-16BE "Hi"
    const dirty = enc(new TextDecoder('latin1').decode(bytes).replace(
      '/Root ' + catNum + ' 0 R',
      `/Root ${catNum} 0 R /Info << /Title <FEFF00480069> >> `,
    ))
    const meta = await readMetadata(dirty)
    assert.equal(meta.fields.find((f) => f.key === 'Title').value, 'Hi')
  })

  it('addPageNumbers honors position, format, start, skipFirst, size', async () => {
    const out = await addPageNumbers(classicPdf([100, 200, 300]), {
      pos: 'tr', fmt: 'page-n', start: 5, skipFirst: true, size: 14, margin: 30,
    })
    const doc = await parsePdf(out)
    const leaves = pageLeaves(doc)
    // page 1 skipped: no trailing label stream
    const c0 = get(leaves[0].dict, 'Contents')
    assert.equal(c0, undefined)
    // page 2 stamped "Page 6" top-right at 14pt
    const c1 = get(leaves[1].dict, 'Contents')
    const lastRef = Array.isArray(c1) ? c1[c1.length - 1] : c1
    const text = new TextDecoder('latin1').decode(deref(doc, lastRef).data)
    assert.match(text, /BT \/PDFFnt1 14 Tf/)
    assert.match(text, /\(Page 6\) Tj/)
    // top-right: baseline y = 400-30-0.72*14 = 359.9, x = 200-30-42 = 128 (cm translation)
    assert.match(text, /q 1 0 0 1 128\.0 359\.9 cm/)
  })

  it('addPageNumbers preserves indirect page Resources', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const resNum = dst.alloc()
    dst.set(resNum, new Map([['ProcSet', [name('PDF'), name('Text')]]]))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 100, 100]], ['Resources', ref(resNum)],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const out = await addPageNumbers(writeDoc(dst, catNum))
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const res = deref(doc, get(leaf.dict, 'Resources'))
    assert.ok(res instanceof Map, 'indirect /Resources must survive stamping')
    assert.deepEqual(res.get('ProcSet').map((n) => n.v), ['PDF', 'Text'])
    assert.equal(get(get(res, 'Font'), 'PDFFnt1') instanceof Map, true)
  })

  it('addPageNumbers counter-rotates the stamp on rotated pages', async () => {
    // 100×400 page shown rotated 90° → "bc" lands on the user's right edge,
    // mid-height, text advancing along +y (upright in display space).
    const out = await addPageNumbers(classicPdf([100], { rotate: [90] }), { pos: 'bc' })
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const contents = get(leaf.dict, 'Contents')
    const lastRef = Array.isArray(contents) ? contents[contents.length - 1] : contents
    const text = new TextDecoder('latin1').decode(deref(doc, lastRef).data)
    assert.match(text, /q 0 1 -1 0 82\.0 187\.5 cm/)
    // 270° → user's left edge, text advancing −y.
    const out2 = await addPageNumbers(classicPdf([100], { rotate: [270] }), { pos: 'bc' })
    const doc2 = await parsePdf(out2)
    const c2 = get(pageLeaves(doc2)[0].dict, 'Contents')
    const last2 = Array.isArray(c2) ? c2[c2.length - 1] : c2
    const text2 = new TextDecoder('latin1').decode(deref(doc2, last2).data)
    assert.match(text2, /q 0 -1 1 0 18\.0 212\.5 cm/)
  })

  it('scrubPdf drops page annotations carrying author data', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const annotNum = dst.alloc()
    dst.set(annotNum, new Map([['Type', name('Annot')], ['Subtype', name('Text')]]))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 50, 50]], ['Annots', [ref(annotNum)]],
      ['PieceInfo', new Map([['Illustrator', new Map()]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const dirty = writeDoc(dst, catNum)
    const clean = new TextDecoder('latin1').decode(await scrubPdf(dirty))
    assert.ok(!clean.includes('/Annots'), 'annotations should be gone')
    assert.ok(!clean.includes('/PieceInfo'), 'piece info should be gone')
    // merge keeps annotations — stripping is a scrub-only choice
    const merged = new TextDecoder('latin1').decode(await mergePdfs([dirty]))
    assert.ok(merged.includes('/Annots'), 'merge should preserve annotations')
  })

  it('extractImages unwraps flate-wrapped jpeg filter chains', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const imgNum = dst.alloc()
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const wrapped = deflateSync(jpeg)
    dst.set(imgNum, stream(new Map([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', 4], ['Height', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerComponent', 8], ['Filter', [name('FlateDecode'), name('DCTDecode')]],
      ['Length', wrapped.length],
    ]), wrapped))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 100, 100]],
      ['Resources', new Map([['XObject', new Map([['Im0', ref(imgNum)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const { images, skipped } = await extractImages(writeDoc(dst, catNum))
    assert.equal(skipped, 0)
    assert.equal(images.length, 1)
    assert.deepEqual([...images[0].data], [...jpeg])
    assert.equal(images[0].mime, 'image/jpeg')
  })

  it('tokenizeContent parses strings, arrays and ops', () => {
    const ops = tokenizeContent(enc('BT /F1 12 Tf 10 20 Td (Hello\\) done) TJ [<4869> -20 (x)] TJ ET'))
    const tj = ops.filter((o) => o.op === 'TJ')
    const td = ops.find((o) => o.op === 'Td')
    assert.equal(td.operands[0], 10)
    assert.equal(td.operands[1], 20)
    assert.equal(tj.length, 2)
    const arr = tj[1].operands.find((o) => o.t === 'arr')
    assert.equal(new TextDecoder('latin1').decode(arr.items[0].bytes), 'Hi')
    assert.equal(arr.items[1], -20)
  })

  it('pagePreview extracts the page\'s own text', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map([['Filter', name('FlateDecode')]]), deflateSync(enc('BT /F1 12 Tf 10 700 Td (Chapter 2: Methods) Tj ET'))))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(csNum)],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const prev = await pagePreview(doc, pageLeaves(doc)[0])
    assert.equal(prev.text, 'Chapter 2: Methods')
    assert.equal(prev.img, null)
  })

  it('pagePreview picks the dominant painted image', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const mkImg = (bytes) => {
      const n = dst.alloc()
      dst.set(n, stream(new Map([
        ['Type', name('XObject')], ['Subtype', name('Image')],
        ['Width', 4], ['Height', 4], ['ColorSpace', name('DeviceRGB')],
        ['BitsPerComponent', 8], ['Filter', name('DCTDecode')], ['Length', bytes.length],
      ]), bytes))
      return n
    }
    const big = mkImg(new Uint8Array([1, 1, 1]))
    const small = mkImg(new Uint8Array([2, 2]))
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('q 10 0 0 10 0 0 cm /Im0 Do Q q 500 0 0 500 0 0 cm /Im1 Do Q')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 612, 792]],
      ['Contents', ref(csNum)],
      ['Resources', new Map([['XObject', new Map([['Im0', ref(small)], ['Im1', ref(big)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const prev = await pagePreview(doc, pageLeaves(doc)[0])
    assert.equal(prev.img.mime, 'image/jpeg')
    assert.deepEqual([...prev.img.data], [1, 1, 1]) // the 500x500-painted one, not the 10x10
  })

  it('extractImages tags output mime types', async () => {
    const { images } = await extractImages(pdfWithImagesMime())
    assert.equal(images.find((i) => i.name.endsWith('.jpg')).mime, 'image/jpeg')
    assert.equal(images.find((i) => i.name.endsWith('.png')).mime, 'image/png')
  })
})

/** Minimal image-bearing pdf for the mime test. */
function pdfWithImagesMime() {
  const dst = newDoc()
  const pagesNum = dst.alloc()
  const jpgNum = dst.alloc()
  dst.set(jpgNum, stream(new Map([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 4], ['Height', 4], ['ColorSpace', name('DeviceRGB')],
    ['BitsPerComponent', 8], ['Filter', name('DCTDecode')], ['Length', 10],
  ]), new Uint8Array(10).fill(0xab)))
  const raw = deflateSync(new Uint8Array(12).fill(0x7f))
  const rawNum = dst.alloc()
  dst.set(rawNum, stream(new Map([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 2], ['Height', 2], ['ColorSpace', name('DeviceRGB')],
    ['BitsPerComponent', 8], ['Filter', name('FlateDecode')], ['Length', raw.length],
  ]), raw))
  const pageNum = dst.alloc()
  dst.set(pageNum, new Map([
    ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 100, 100]],
    ['Resources', new Map([['XObject', new Map([['Im0', ref(jpgNum)], ['Im1', ref(rawNum)]])]])],
  ]))
  dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
  const catNum = dst.alloc()
  dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
  return writeDoc(dst, catNum)
}

describe('zipStore', () => {
  it('produces a valid zip structure', () => {
    const out = zipStore([{ name: 'a.txt', data: enc('hello') }, { name: 'b.txt', data: enc('world!') }])
    assert.deepEqual([...out.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
    const eocd = out.length - 22
    assert.deepEqual([...out.slice(eocd, eocd + 4)], [0x50, 0x4b, 0x05, 0x06])
    assert.equal(out[eocd + 10], 2) // entry count
  })

  it('crc32 matches known vector', () => {
    assert.equal(crc32(enc('hello')), 0x3610a686)
  })
})

// ---------- page renderer engine ----------

/** PDF with a CID/ToUnicode font, a painted image, a filled rect, and (opt) rotation. */
function richPdf({ rotate = 0, cid = false } = {}) {
  const dst = newDoc()
  const pagesNum = dst.alloc()
  const jpgNum = dst.alloc()
  dst.set(jpgNum, stream(new Map([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 4], ['Height', 4], ['ColorSpace', name('DeviceRGB')],
    ['BitsPerComponent', 8], ['Filter', name('DCTDecode')], ['Length', 5],
  ]), new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 7])))
  const fontDict = new Map([
    ['Type', name('Font')], ['Subtype', name(cid ? 'Type0' : 'Type1')],
    ['BaseFont', name('Helvetica')],
  ])
  if (cid) {
    const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <0627>
<0002> <0644>
endbfchar
1 beginbfrange
<0003> <0004> <0645>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`
    const cmapNum = dst.alloc()
    dst.set(cmapNum, stream(new Map([['Filter', name('FlateDecode')]]), deflateSync(enc(cmap))))
    fontDict.set('ToUnicode', ref(cmapNum))
  }
  const fontNum = dst.alloc()
  dst.set(fontNum, fontDict)
  const show = cid ? '<0001> Tj <0002> Tj <00030004> Tj' : '(Hi) Tj'
  const csNum = dst.alloc()
  dst.set(csNum, stream(new Map(), enc(
    `q 200 0 0 100 50 60 cm /Im0 Do Q 50 50 100 20 re f BT /F1 12 Tf 60 700 Td ${show} ET`,
  )))
  const pageNum = dst.alloc()
  const pd = new Map([
    ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 612, 792]],
    ['Contents', ref(csNum)],
    ['Resources', new Map([
      ['Font', new Map([['F1', ref(fontNum)]])],
      ['XObject', new Map([['Im0', ref(jpgNum)]])],
    ])],
  ])
  if (rotate) pd.set('Rotate', rotate)
  dst.set(pageNum, pd)
  dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
  const catNum = dst.alloc()
  dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
  return writeDoc(dst, catNum)
}

describe('renderer engine', () => {
  it('parseToUnicode maps bfchar and bfrange codes', () => {
    const { map, codeLen } = parseToUnicode(enc(
      'x 1 begincodespacerange <0000> <FFFF> endcodespacerange ' +
      '1 beginbfchar <0009> <0041> endbfchar ' +
      '1 beginbfrange <0010> <0012> <0061> endbfrange ' +
      '1 beginbfrange <0020> <0021> [<0078> <0079>] endbfrange x',
    ))
    assert.equal(codeLen, 2)
    assert.equal(map.get(9), 'A')
    assert.equal(map.get(0x10), 'a')
    assert.equal(map.get(0x12), 'c')
    assert.equal(map.get(0x20), 'x')
    assert.equal(map.get(0x21), 'y')
  })

  it('collectDrawOps positions image, text and rect in display space', async () => {
    const doc = await parsePdf(richPdf())
    const { ops, box } = await collectDrawOps(doc, pageLeaves(doc)[0])
    assert.deepEqual(box, { w: 612, h: 792 })
    const img = ops.find((o) => o.t === 'img')
    assert.ok(img)
    assert.ok(Math.abs(img.x - 50) < 0.5 && Math.abs(img.w - 200) < 0.5, `img rect ${JSON.stringify(img)}`)
    assert.ok(Math.abs(img.y - (792 - 160)) < 0.5 && Math.abs(img.h - 100) < 0.5)
    const txt = ops.find((o) => o.t === 'text')
    assert.ok(txt)
    assert.equal(txt.str, 'Hi')
    assert.ok(Math.abs(txt.x - 60) < 0.5 && Math.abs(txt.y - 92) < 0.5, `text pos ${JSON.stringify(txt)}`)
    assert.ok(Math.abs(txt.w - 12) < 6) // ~0.5em advance fallback
    const rect = ops.find((o) => o.t === 'rect')
    assert.ok(rect)
    assert.ok(Math.abs(rect.x - 50) < 0.5 && Math.abs(rect.y - (792 - 70)) < 0.5)
    assert.ok(Math.abs(rect.w - 100) < 0.5 && Math.abs(rect.h - 20) < 0.5)
  })

  it('collectDrawOps respects /Rotate', async () => {
    const doc = await parsePdf(richPdf({ rotate: 90 }))
    const { ops, box } = await collectDrawOps(doc, pageLeaves(doc)[0])
    assert.deepEqual(box, { w: 792, h: 612 })
    const txt = ops.find((o) => o.t === 'text')
    // user (60,700) → display (700,60) under 90° clockwise
    assert.ok(Math.abs(txt.x - 700) < 0.5 && Math.abs(txt.y - 60) < 0.5, `rot90 ${JSON.stringify(txt)}`)
  })

  it('decodeString resolves CID codes through ToUnicode', async () => {
    const doc = await parsePdf(richPdf({ cid: true }))
    const fonts = await fontMap(doc, pageLeaves(doc)[0])
    const f1 = fonts.get('F1')
    assert.equal(decodeString(new Uint8Array([0, 1]), f1), 'ا') // alef
    assert.equal(decodeString(new Uint8Array([0, 3, 0, 4]), f1), 'من') // meem+noon via bfrange
    const prev = await pagePreview(doc, pageLeaves(doc)[0])
    assert.ok(prev.text.includes('ا'), `preview text: ${prev.text}`)
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const strs = ops.filter((o) => o.t === 'text').map((o) => o.str).join('')
    assert.ok(strs.includes('ال'), `collected text: ${strs}`)
  })

  it('tokenizer skips BI/ID/EI inline image payload', () => {
    const data = enc('BI /W 2 /H 2 /CS /DeviceGray /BPC 8 ID ')
    const imgBytes = new Uint8Array([0x00, 0x02, 0xff, 0x10])
    const tail = enc(' EI BT /F1 12 Tf 10 20 Td (A) Tj ET')
    const buf = new Uint8Array(data.length + imgBytes.length + tail.length)
    buf.set(data, 0); buf.set(imgBytes, data.length); buf.set(tail, data.length + imgBytes.length)
    const ops = tokenizeContent(buf)
    const opNames = ops.map((o) => o.op)
    assert.ok(opNames.includes('ID'), `ops: ${opNames}`)
    assert.ok(opNames.includes('EI'))
    const tj = ops.find((o) => o.op === 'Tj')
    assert.ok(tj, 'Tj after inline image must survive')
  })

  it('displayTransform maps corners per rotation', () => {
    const mb = [0, 0, 612, 792]
    const pt = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    assert.deepEqual(pt(displayTransform(mb, 0), 0, 0), [0, 792])
    assert.deepEqual(pt(displayTransform(mb, 90), 0, 0), [0, 0]) // BL → TL (clockwise)
    assert.deepEqual(pt(displayTransform(mb, 180), 0, 0), [612, 0])
    assert.deepEqual(pt(displayTransform(mb, 270), 0, 0), [792, 612])
  })
})

describe('powerup engine', () => {
  it('organizePages duplicates a page when picked twice', async () => {
    const out = await organizePages(classicPdf([100, 200, 300]), [{ page: 2 }, { page: 2 }, { page: 1 }])
    const doc = await parsePdf(out)
    assert.equal(pageLeaves(doc).length, 3)
    const dims = pageDims(doc)
    assert.deepEqual(dims.map((d) => d.w), [200, 200, 100])
  })

  it('imagesToPdf honours a4/landscape/margin options', async () => {
    const fake = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0xff, 0xda])
    const out = imagesToPdf([{ data: fake }], { size: 'a4', orient: 'auto', margin: 18 })
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const mb = get(leaf.dict, 'MediaBox')
    // 800×600 image → landscape A4
    assert.ok(Math.abs(mb[2] - 841.89) < 0.5, `pw ${mb[2]}`)
    assert.ok(Math.abs(mb[3] - 595.28) < 0.5, `ph ${mb[3]}`)
  })

  it('extractImages tags identical content with the same hash', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const mk = () => { const n = dst.alloc(); dst.set(n, stream(new Map([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', 4], ['Height', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerComponent', 8], ['Filter', name('DCTDecode')], ['Length', jpg.length],
    ]), jpg)); return n }
    mk(); mk()
    const pg = dst.alloc()
    dst.set(pg, new Map([['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 10, 10]]]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pg)]], ['Count', 1]]))
    const cat = dst.alloc()
    dst.set(cat, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const { images } = await extractImages(writeDoc(dst, cat))
    assert.equal(images.length, 2)
    assert.equal(images[0].hash, images[1].hash)
  })
})

// ---------- vector/path/form walker ----------

/** Page exercising rg/RG colors, m/l/c path stroke, gs alpha, W-clip, Form XObject. */
function vectorPdf() {
  const content =
    'q\n1 0 0 rg\n10 10 50 30 re f\n' +
    '0.2 0.4 0.9 RG\n2 w\n[3 2] 0 d\n' +
    '60 60 m 80 60 l 90 90 95 95 100 100 c S\n' +
    '/GS0 gs\n0 1 0 rg\n20 120 40 20 re f\n' +
    '10 10 80 80 re W n\n' +
    'BT /F1 14 Tf 30 30 Td (HELLO) Tj ET\n/Fm0 Do\nQ\n'
  const form = 'BT /F2 9 Tf 5 5 Td (INNER) Tj ET\n'
  const head = '%PDF-1.7\n'
  let body = ''
  const offs = new Map()
  const add = (n, c) => { offs.set(n, head.length + body.length); body += `${n} 0 obj\n${c}\nendobj\n` }
  add(1, '<< /Type /Catalog /Pages 2 0 R >>')
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
    '/Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 7 0 R >> /ExtGState << /GS0 9 0 R >> >> ' +
    '/Contents 4 0 R >>')
  add(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
  add(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add(7, `<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 50 50] ` +
    `/Resources << /Font << /F2 8 0 R >> >> /Length ${form.length} >>\nstream\n${form}endstream`)
  add(8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add(9, '<< /ca 0.5 /CA 0.25 >>')
  const xrefAt = head.length + body.length
  let xref = 'xref\n0 10\n0000000000 65535 f \r\n'
  for (let n = 1; n < 10; n++)
    xref += (offs.has(n) ? String(offs.get(n)).padStart(10, '0') + ' 00000 n' : '0000000000 65535 f') + ' \r\n'
  return enc(head + body + xref +
    `trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
}

describe('vector walker', () => {
  it('emits path ops with stroke color/width and cubic segs', async () => {
    const doc = await parsePdf(vectorPdf())
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const path = ops.find((o) => o.t === 'path')
    assert.ok(path, 'm/l/c + S produced a path op')
    assert.ok(path.segs.some((seg) => seg[0] === 'C'), 'cubic seg captured')
    assert.ok(path.stroke && !path.fill)
    assert.ok(Math.abs(path.sc[2] - 0.9) < 1e-6, 'RG stroke color')
    assert.ok(Math.abs(path.lw - 2) < 1e-6, 'line width')
    assert.deepEqual(path.dash, [3, 2], 'dash pattern')
  })
  it('tracks fill color, gs alpha, clip/unclip, text color', async () => {
    const doc = await parsePdf(vectorPdf())
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const red = ops.find((o) => o.t === 'rect' && Math.abs(o.fc[0] - 1) < 1e-6)
    assert.ok(red?.fill && red.a === 1, 'red rect filled at full alpha')
    const green = ops.find((o) => o.t === 'rect' && o.fc[1] === 1)
    assert.equal(green.a, 0.5, 'ExtGState ca applied to fill')
    const hello = ops.find((o) => o.t === 'text' && o.str === 'HELLO')
    assert.ok(hello, 'text op emitted')
    assert.equal(Math.round(hello.fc[1] * 10) / 10, 1, 'text inherits fill color')
    assert.ok(ops.filter((o) => o.t === 'clip').length >= 2, 'W clip + form BBox clip')
    assert.ok(ops.filter((o) => o.t === 'unclip').length >= 2, 'clip ends on Q / form exit')
  })
  it('walks Form XObjects recursively with Matrix applied', async () => {
    const doc = await parsePdf(vectorPdf())
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const inner = ops.find((o) => o.t === 'text' && o.str === 'INNER')
    assert.ok(inner, 'form content walked')
    assert.ok(Math.abs(inner.x - 55) < 2, `form Matrix +50 tx applied (x=${inner.x})`)
  })
})

// ---------- v3 tools: text/compress/protect ----------

describe('crypto primitives', () => {
  it('md5 matches RFC 1321 vectors', async () => {
    const { md5 } = await import('../src/pdf/crypto.js')
    const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    assert.equal(hex(md5(enc(''))), 'd41d8cd98f00b204e9800998ecf8427e')
    assert.equal(hex(md5(enc('abc'))), '900150983cd24fb0d6963f7d28e17f72')
    assert.equal(
      hex(md5(enc('The quick brown fox jumps over the lazy dog'))),
      '9e107d9d372bb6826bd81d3542a419d6')
  })
  it('rc4 matches RFC 6229 vector', async () => {
    const { rc4 } = await import('../src/pdf/crypto.js')
    const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    assert.equal(hex(rc4(enc('Key'), enc('Plaintext'))), 'bbf316e8d940af0ad3')
    assert.equal(hex(rc4(enc('Wiki'), enc('pedia'))), '1021bf0420')
  })
})

describe('pageText', () => {
  it('reassembles lines by position', async () => {
    const content = 'BT /F1 12 Tf 50 700 Td (First line) Tj 0 -20 Td (Second line) Tj ET\n'
    const head = '%PDF-1.7\n'
    let body = ''
    const offs = new Map()
    const add = (n, c) => { offs.set(n, head.length + body.length); body += `${n} 0 obj\n${c}\nendobj\n` }
    add(1, '<< /Type /Catalog /Pages 2 0 R >>')
    add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 800] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>')
    add(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`)
    add(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const xrefAt = head.length + body.length
    let xref = 'xref\n0 6\n0000000000 65535 f \r\n'
    for (let n = 1; n < 6; n++) xref += String(offs.get(n)).padStart(10, '0') + ' 00000 n \r\n'
    const doc = await parsePdf(enc(head + body + xref +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`))
    const { pageText } = await import('../src/pdf/ops.js')
    const text = await pageText(doc, pageLeaves(doc)[0])
    assert.equal(text, 'First line\nSecond line')
  })
})

describe('compressPdf', () => {
  it('deflates uncompressed streams and reports sizes', async () => {
    const pad = 'BT /F1 9 Tf 10 10 Td (' + 'x'.repeat(3000) + ') Tj ET\n'
    const head = '%PDF-1.7\n'
    let body = ''
    const offs = new Map()
    const add = (n, c) => { offs.set(n, head.length + body.length); body += `${n} 0 obj\n${c}\nendobj\n` }
    add(1, '<< /Type /Catalog /Pages 2 0 R >>')
    add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    add(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>')
    add(4, `<< /Length ${pad.length} >>\nstream\n${pad}endstream`)
    add(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const xrefAt = head.length + body.length
    let xref = 'xref\n0 6\n0000000000 65535 f \r\n'
    for (let n = 1; n < 6; n++) xref += String(offs.get(n)).padStart(10, '0') + ' 00000 n \r\n'
    const src = enc(head + body + xref +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`)
    const { compressPdf, pageText } = await import('../src/pdf/ops.js')
    const { bytes, before, after } = await compressPdf(src)
    assert.ok(after < before, `compressed ${before} → ${after}`)
    const re = await parsePdf(bytes)
    assert.equal(pageLeaves(re).length, 1)
    const txt = await pageText(re, pageLeaves(re)[0])
    assert.ok(txt.startsWith('xxx'), 'content still decodes after recompression')
  })
})

describe('protectPdf/decryptPdf', () => {
  it('encrypts strings+streams, trailer carries /Encrypt, roundtrip unlocks', async () => {
    const { protectPdf, decryptPdf } = await import('../src/pdf/ops.js')
    const src = classicPdf([300, 400])
    const locked = await protectPdf(src, 'hunter2')
    await assert.rejects(() => parsePdf(locked), /password-protected/, 'plain parse refuses encrypted docs')
    const doc = await parsePdf(locked, [], true)
    assert.ok(get(doc.trailer, 'Encrypt'), '/Encrypt in trailer')
    assert.ok(get(doc.trailer, 'ID'), '/ID in trailer')
    const unlocked = await decryptPdf(locked, 'hunter2')
    const doc2 = await parsePdf(unlocked)
    assert.equal(pageLeaves(doc2).length, 2, 'roundtrip preserves pages')
    assert.equal(get(doc2.trailer, 'Encrypt'), undefined, 'unlock drops Encrypt')
    // owner-password path also unlocks
    const unlockedO = await decryptPdf(locked, 'hunter2')
    assert.equal(pageLeaves(await parsePdf(unlockedO)).length, 2)
    // wrong password throws
    await assert.rejects(() => decryptPdf(locked, 'nope'), /wrong password/)
  })
})

// ---------- adversarial review fixes ----------

describe('review fixes', () => {
  it('cm concatenates as ctm×operand (nested translate+scale)', async () => {
    // scale(2) then translate(10,20): pt(1,1) → (2*(1+10), 2*(1+20)) = (22,42)
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('2 0 0 2 0 0 cm 1 0 0 1 10 20 cm 1 1 4 4 re f')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 200, 200]], ['Contents', ref(csNum)],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const r = ops.find((o) => o.t === 'rect')
    // correct order: user (22,42) → display (22, 200−(42+8)) = (22,150), w=8
    // wrong order: user (12,22) → display (12,170)
    assert.ok(Math.abs(r.x - 22) < 0.5 && Math.abs(r.y - 150) < 0.5,
      `cm order ${JSON.stringify(r)}`)
  })

  it('Tr 3 invisible text emits flagged ops, still extractable', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('BT /F1 12 Tf 3 Tr 10 100 Td (HIDDEN OCR) Tj ET')))
    const fontNum = dst.alloc()
    dst.set(fontNum, new Map([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')]]))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 200, 200]],
      ['Contents', ref(csNum)],
      ['Resources', new Map([['Font', new Map([['F1', ref(fontNum)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const leaf = pageLeaves(doc)[0]
    const { ops } = await collectDrawOps(doc, leaf)
    const t = ops.find((o) => o.t === 'text')
    assert.equal(t.inv, true, 'invisible text flagged for painter skip')
    assert.equal(t.str, 'HIDDEN OCR')
    const { pageText } = await import('../src/pdf/ops.js')
    assert.equal(await pageText(doc, leaf), 'HIDDEN OCR', 'OCR layer still extracts')
  })

  it('literal strings decode escapes, octal, and line continuation', () => {
    // PDF source bytes: (a\nb) (\101\102) (x\<LF>y) — built raw to keep
    // the backslashes literal in this fixture
    const src = Uint8Array.from(
      [...'(a' + String.fromCharCode(0x5c) + 'nb) Tj (' +
      String.fromCharCode(0x5c) + '101' + String.fromCharCode(0x5c) + '102) Tj (x' +
      String.fromCharCode(0x5c) + '\ny) Tj'].map((c) => c.charCodeAt(0)))
    const ops = tokenizeContent(src)
    const strs = ops.filter((o) => o.op === 'Tj').map((o) => o.operands[0].bytes)
    assert.deepEqual([...strs[0]], [0x61, 0x0a, 0x62])
    assert.deepEqual([...strs[1]], [0x41, 0x42])
    assert.deepEqual([...strs[2]], [0x78, 0x79])
  })

  it('/W pairwise form [cid [w0 w1]] drives real advances', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const fontNum = dst.alloc()
    dst.set(fontNum, new Map([
      ['Type', name('Font')], ['Subtype', name('Type0')], ['BaseFont', name('X')],
      ['W', [10, [900, 100]]], // cid 10→900, cid 11→100
      ['DW', 500],
    ]))
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('BT /F1 12 Tf 0 100 Td <000A> Tj <000B> Tj ET')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 500, 500]],
      ['Contents', ref(csNum)],
      ['Resources', new Map([['Font', new Map([['F1', ref(fontNum)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const texts = ops.filter((o) => o.t === 'text')
    assert.equal(texts.length, 2)
    // cid10 at 900/1000 em × 12pt = 10.8 advance → second glyph at x≈10.8
    assert.ok(Math.abs(texts[1].x - 10.8) < 0.5, `advance ${JSON.stringify(texts.map((t) => t.x))}`)
  })

  it('" operator applies aw/ac spacing before moving to next line', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const fontNum = dst.alloc()
    dst.set(fontNum, new Map([
      ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')],
      ['Widths', [600, 600, 600]], ['FirstChar', 97],
    ]))
    const csNum = dst.alloc()
    // 100 Tw + 5 Tc via " operator — 'a a' advances more than bare Tj would
    dst.set(csNum, stream(new Map(), enc('BT /F1 10 Tf 14 TL 0 100 Td 100 5 (a a)" (b) Tj ET')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 300, 300]],
      ['Contents', ref(csNum)],
      ['Resources', new Map([['Font', new Map([['F1', ref(fontNum)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const texts = ops.filter((o) => o.t === 'text')
    assert.equal(texts.length, 2)
    assert.ok(texts[0].w > 36, `word+char spacing applied: w=${texts[0].w}`)
    // " moves to next line FIRST (display y = 200 + leading 14 = 214),
    // then shows the string — 'b' follows on the same line
    assert.ok(Math.abs(texts[0].y - 214) < 0.5, `line advanced by leading: y=${texts[0].y}`)
    assert.ok(Math.abs(texts[1].y - texts[0].y) < 0.5, 'Tj continues on same line')
  })

  it('TJ kerning translates in text space under rotated Tm', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const fontNum = dst.alloc()
    dst.set(fontNum, new Map([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')]]))
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('BT /F1 10 Tf 0 1 -1 0 100 100 Tm [(A) -1000 (B)] TJ ET')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)], ['MediaBox', [0, 0, 300, 300]],
      ['Contents', ref(csNum)],
      ['Resources', new Map([['Font', new Map([['F1', ref(fontNum)]])]])],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const texts = ops.filter((o) => o.t === 'text')
    assert.equal(texts.length, 2)
    // text-x points +y_user → display −? user-x advances along (0,1)_user =
    // display (0, +1)? verify: kern must shift B's y not x
    assert.ok(Math.abs(texts[1].x - texts[0].x) < 0.5, `rotated kern x drift ${JSON.stringify(texts)}`)
    assert.ok(Math.abs(texts[1].y - texts[0].y) > 5, `rotated kern y advance ${JSON.stringify(texts)}`)
  })

  it('0 w stays a hairline (lw 0), not forced to 1', async () => {
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const csNum = dst.alloc()
    dst.set(csNum, stream(new Map(), enc('0 w 1 1 m 50 1 l S')))
    const pageNum = dst.alloc()
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 100, 100]], ['Contents', ref(csNum)],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([['Type', name('Catalog')], ['Pages', ref(pagesNum)]]))
    const doc = await parsePdf(writeDoc(dst, catNum))
    const { ops } = await collectDrawOps(doc, pageLeaves(doc)[0])
    const p = ops.find((o) => o.t === 'path')
    assert.equal(p.lw, 0, 'hairline preserved')
  })

  it('decryptPdf rejects AES/non-RC4 encrypt dicts loudly', async () => {
    const { decryptPdf } = await import('../src/pdf/ops.js')
    const plain = classicPdf([100])
    const txt = dec(plain)
    const encDict = '<< /Filter /Standard /V 4 /R 4 /Length 128 /P -4 ' +
      '/CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF ' +
      '/O <0000000000000000000000000000000000000000000000000000000000000000> ' +
      '/U <0000000000000000000000000000000000000000000000000000000000000000> >>'
    const patched = txt.replace(/trailer\n<< \/Size (\d+) \/Root 1 0 R >>/,
      `9 0 obj\n${encDict}\nendobj\ntrailer\n<< /Size $1 /Root 1 0 R /Encrypt 9 0 R /ID [<aa> <bb>] >>`)
    assert.notEqual(patched, txt, 'fixture patched')
    await assert.rejects(() => decryptPdf(enc(patched), 'x'), /unsupported/i)
  })

  it('decryptPdf uses SOURCE object numbers (sparse-numbered fixture)', async () => {
    const { decryptPdf } = await import('../src/pdf/ops.js')
    const { md5, rc4 } = await import('../src/pdf/crypto.js')
    // replicate the Standard R3 algorithm independently — that is the point
    const PAD = new Uint8Array([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
      0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe,
      0x64, 0x53, 0x69, 0x7a])
    const pad = (s) => {
      const b = Uint8Array.from(s, (c) => c.charCodeAt(0))
      const o = new Uint8Array(32)
      o.set(b.subarray(0, 32))
      if (b.length < 32) o.set(PAD.subarray(0, 32 - b.length), b.length)
      return o
    }
    const cat2 = (ps) => {
      const n = ps.reduce((a, p) => a + p.length, 0)
      const o = new Uint8Array(n)
      let i = 0
      for (const p of ps) { o.set(p, i); i += p.length }
      return o
    }
    const xk = (k, i) => Uint8Array.from(k, (b) => b ^ i)
    const uPad = pad('sparse')
    let d = md5(uPad)
    for (let i = 0; i < 50; i++) d = md5(d.subarray(0, 16))
    const oKey = d.subarray(0, 16)
    let O = uPad
    for (let i = 0; i < 20; i++) O = rc4(xk(oKey, i), O)
    const id0 = new Uint8Array(16).fill(0x5a)
    const P = -4
    const le = new Uint8Array(4)
    new DataView(le.buffer).setInt32(0, P, true)
    let fd = md5(cat2([uPad, O, le, id0]))
    for (let i = 0; i < 50; i++) fd = md5(fd.subarray(0, 16))
    const fileKey = fd.subarray(0, 16)
    let ud = md5(cat2([PAD, id0]))
    for (let i = 0; i < 20; i++) ud = rc4(xk(fileKey, i), ud)
    const U = new Uint8Array(32)
    U.set(ud)
    const objKeyT = (n, g) => md5(cat2([fileKey,
      new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255])])).subarray(0, 16)
    const hexOf = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    const content = 'BT /F1 10 Tf 5 50 Td (SECRETS) Tj ET'
    const encContent = rc4(objKeyT(40, 0), enc(content))
    const pre =
      '%PDF-1.7\n' +
      '10 0 obj\n<< /Type /Catalog /Pages 20 0 R >>\nendobj\n' +
      '20 0 obj\n<< /Type /Pages /Kids [30 0 R] /Count 1 >>\nendobj\n' +
      '30 0 obj\n<< /Type /Page /Parent 20 0 R /MediaBox [0 0 100 100] /Contents 40 0 R >>\nendobj\n' +
      `40 0 obj\n<< /Length ${encContent.length} >>\nstream\n`
    const mid = `\nendstream\nendobj\n` +
      `50 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${hexOf(O)}> /U <${hexOf(U)}> >>\nendobj\n`
    const beforeXref = cat2([enc(pre), encContent, enc(mid)])
    const xrefAt = beforeXref.length
    const tail = 'xref\n0 51\n0000000000 65535 f \r\n' +
      `trailer\n<< /Size 51 /Root 10 0 R /Encrypt 50 0 R /ID [<${hexOf(id0)}> <${hexOf(id0)}>] >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`
    const locked = cat2([beforeXref, enc(tail)])
    // src objects are 10/20/30/40/50 — a dst-keyed walk would garble the stream
    const unlocked = await decryptPdf(locked, 'sparse')
    const doc = await parsePdf(unlocked)
    const leaf = pageLeaves(doc)[0]
    const { streamData } = await import('../src/pdf/ops.js')
    const cs = deref(doc, get(leaf.dict, 'Contents'))
    const plain = dec(await streamData(cs))
    assert.ok(plain.includes('SECRETS'), `decrypted content: ${JSON.stringify(plain.slice(0, 80))}`)
    assert.equal(get(doc.trailer, 'Encrypt'), undefined)
  })

  it('decryptPdf unpacks encrypted ObjStm containers', async () => {
    const { decryptPdf } = await import('../src/pdf/ops.js')
    const { md5, rc4 } = await import('../src/pdf/crypto.js')
    const PAD = new Uint8Array([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
      0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe,
      0x64, 0x53, 0x69, 0x7a])
    const pad = (s) => {
      const b = Uint8Array.from(s, (c) => c.charCodeAt(0))
      const o = new Uint8Array(32)
      o.set(b.subarray(0, 32))
      if (b.length < 32) o.set(PAD.subarray(0, 32 - b.length), b.length)
      return o
    }
    const cat2 = (ps) => {
      const n = ps.reduce((a, p) => a + p.length, 0)
      const o = new Uint8Array(n)
      let i = 0
      for (const p of ps) { o.set(p, i); i += p.length }
      return o
    }
    const xk = (k, i) => Uint8Array.from(k, (b) => b ^ i)
    const uPad = pad('os')
    let d = md5(uPad)
    for (let i = 0; i < 50; i++) d = md5(d.subarray(0, 16))
    const oKey = d.subarray(0, 16)
    let O = uPad
    for (let i = 0; i < 20; i++) O = rc4(xk(oKey, i), O)
    const id0 = new Uint8Array(16).fill(0x33)
    const P = -4
    const le = new Uint8Array(4)
    new DataView(le.buffer).setInt32(0, P, true)
    let fd = md5(cat2([uPad, O, le, id0]))
    for (let i = 0; i < 50; i++) fd = md5(fd.subarray(0, 16))
    const fileKey = fd.subarray(0, 16)
    let ud = md5(cat2([PAD, id0]))
    for (let i = 0; i < 20; i++) ud = rc4(xk(fileKey, i), ud)
    const U = new Uint8Array(32)
    U.set(ud)
    const objKeyT = (n, g) => md5(cat2([fileKey,
      new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255])])).subarray(0, 16)
    const hexOf = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    // object 60 (a page dict with a plaintext string) lives inside ObjStm 70;
    // the container stream is encrypted with key(70,0) — inner strings are
    // already plaintext once the container is decrypted (no per-object key)
    const inner = '60 0 << /Type /Page /Parent 20 0 R /MediaBox [0 0 200 200] /Foo (bar) >>'
    const packed = deflateSync(enc(inner))
    const encStm = rc4(objKeyT(70, 0), packed)
    const pre =
      '%PDF-1.7\n' +
      '10 0 obj\n<< /Type /Catalog /Pages 20 0 R >>\nendobj\n' +
      '20 0 obj\n<< /Type /Pages /Kids [30 0 R 60 0 R] /Count 2 >>\nendobj\n' +
      '30 0 obj\n<< /Type /Page /Parent 20 0 R /MediaBox [0 0 100 100] >>\nendobj\n' +
      `70 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${encStm.length} /Filter /FlateDecode >>\nstream\n`
    const mid = `\nendstream\nendobj\n` +
      `50 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${hexOf(O)}> /U <${hexOf(U)}> >>\nendobj\n`
    const beforeXref = cat2([enc(pre), encStm, enc(mid)])
    const xrefAt = beforeXref.length
    const tail = 'xref\n0 71\n0000000000 65535 f \r\n' +
      `trailer\n<< /Size 71 /Root 10 0 R /Encrypt 50 0 R /ID [<${hexOf(id0)}> <${hexOf(id0)}>] >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`
    const unlocked = await decryptPdf(cat2([beforeXref, enc(tail)]), 'os')
    const doc = await parsePdf(unlocked)
    const leaves = pageLeaves(doc)
    assert.equal(leaves.length, 2, 'ObjStm page recovered')
    const p2 = leaves[1]
    assert.equal(get(p2.dict, 'MediaBox')[2], 200)
    const foo = get(p2.dict, 'Foo')
    assert.equal(dec(foo.bytes), 'bar', 'inner string is plaintext — never re-encrypted')
  })

  it('compressPdf preserves /Info, /ID and catalog /Outlines with remapped page refs', async () => {
    const { compressPdf } = await import('../src/pdf/ops.js')
    const dst = newDoc()
    const pagesNum = dst.alloc()
    const pageNum = dst.alloc()
    const csNum = dst.alloc()
    const infoNum = dst.alloc()
    const outlNum = dst.alloc()
    dst.set(infoNum, new Map([['Title', { k: 's', bytes: enc('My Doc') }]]))
    dst.set(outlNum, new Map([
      ['Type', name('Outlines')], ['Count', 1],
      ['First', new Map([['Title', { k: 's', bytes: enc('Ch1') }], ['Dest', [ref(pageNum), name('Fit')]]])],
    ]))
    dst.set(csNum, stream(new Map(), enc('BT /F1 10 Tf 10 50 Td (hi) Tj ET')))
    dst.set(pageNum, new Map([
      ['Type', name('Page')], ['Parent', ref(pagesNum)],
      ['MediaBox', [0, 0, 100, 100]], ['Contents', ref(csNum)],
    ]))
    dst.set(pagesNum, new Map([['Type', name('Pages')], ['Kids', [ref(pageNum)]], ['Count', 1]]))
    const catNum = dst.alloc()
    dst.set(catNum, new Map([
      ['Type', name('Catalog')], ['Pages', ref(pagesNum)], ['Outlines', ref(outlNum)],
    ]))
    const src = writeDoc(dst, catNum, new Map([
      ['Info', ref(infoNum)],
      ['ID', [{ k: 'x', bytes: new Uint8Array(16).fill(7) }, { k: 'x', bytes: new Uint8Array(16).fill(9) }]],
    ]))
    const { bytes } = await compressPdf(src)
    const doc = await parsePdf(bytes)
    assert.ok(get(doc.trailer, 'Info'), 'Info survives compress')
    assert.ok(get(doc.trailer, 'ID'), 'ID survives compress')
    const cat = deref(doc, get(doc.trailer, 'Root'))
    const outl = deref(doc, get(cat, 'Outlines'))
    assert.ok(outl instanceof Map, 'Outlines survives')
    const first = get(outl, 'First')
    const destPage = deref(doc, get(first, 'Dest')[0])
    assert.ok(destPage instanceof Map && typeIs(destPage, 'Page'),
      'outline dest remaps to the kept page')
  })
})
