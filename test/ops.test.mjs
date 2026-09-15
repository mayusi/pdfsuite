import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { enc, get, isStream, name, ref, set, stream, typeIs } from '../src/pdf/types.js'
import { newDoc, writeDoc } from '../src/pdf/write.js'
import {
  addPageNumbers, extractImages, extractPages, imagesToPdf, jpegInfo, mergePdfs,
  organizePages, pageCount, pageDims, pageLeaves, pagePreview, parseRanges,
  readMetadata, scrubPdf, splitPdf, tokenizeContent, unPredict,
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
    await assert.rejects(parsePdf(bytes), /encrypted/i)
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
      '/Root ' + catNum + ' 0 R >>',
      `/Root ${catNum} 0 R /Info << /Author (sneaky) /Producer (acme) >> /ID [<aa><bb>] >>`,
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
      '/Root ' + catNum + ' 0 R >>',
      `/Root ${catNum} 0 R /Info << /Title <FEFF00480069> >> >>`,
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
    const out = await addPageNumbers(classicPdf([100], { rotate: [90] }), { pos: 'bc' })
    const doc = await parsePdf(out)
    const leaf = pageLeaves(doc)[0]
    const contents = get(leaf.dict, 'Contents')
    const lastRef = Array.isArray(contents) ? contents[contents.length - 1] : contents
    const text = new TextDecoder('latin1').decode(deref(doc, lastRef).data)
    assert.match(text, /q 0 1 -1 0 [\d.]+ [\d.]+ cm/)
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
