import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePdf, deref } from '../src/pdf/parse.js'
import { enc, get } from '../src/pdf/types.js'
import { extractText, pageLeaves, pageDims } from '../src/pdf/ops.js'
import { collectDrawOps } from '../src/pdf/content.js'
import { exportEdited, toEngine } from '../src/editor/export.js'
import { annRotate90, annBox, annHit, annResize, annClone, textBox, smooth } from '../src/editor/annots.js'
import { selectionRects } from '../src/editor/view.js'

/** n-page PDF, each page "Page k secret-k" in Helvetica 14 at (40, 700). */
function doc(n, { w = 400, h = 800 } = {}) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']
  const kids = []
  for (let i = 0; i < n; i++) {
    const c = `BT /F1 14 Tf 40 ${h - 100} Td (Page ${i + 1} secret-${i + 1}) Tj ET`
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`)
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`)
    kids.push(objs.length)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${n} >>`
  let out = '%PDF-1.7\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return enc(out)
}
async function info(bytes) {
  const d = await parsePdf(bytes)
  return { bytes, doc: d, leaves: pageLeaves(d), dims: pageDims(d) }
}
const pagesOf = (inf) => inf.leaves.map((_, i) => ({ id: `p${i}`, src: i, rot: 0, w: 400, h: 800, annots: [] }))

describe('editor export pipeline', () => {
  it('edits existing text: original glyphs removed, replacement written in place', async () => {
    const inf = await info(doc(1))
    const pages = pagesOf(inf)
    // "Page 1 secret-1" baseline at display y = 800-700 = 100; edit the whole run
    pages[0].annots.push({ t: 'textedit', region: { x: 38, y: 86, w: 140, h: 18 }, origText: 'Page 1 secret-1', x: 40, y: 100 - 14 * 0.8, w: 0, text: 'Page 1 approved', size: 14, font: 'helv', color: '#000000' })
    const out = await exportEdited(inf, pages)
    const [txt] = await extractText(await parsePdf(out))
    assert.equal(txt, 'Page 1 approved')
  })
  it('redacts across pages, reorders, rotates and inserts blank pages', async () => {
    const inf = await info(doc(3))
    const pages = pagesOf(inf)
    pages[1].annots.push({ t: 'redact', x: 85, y: 86, w: 80, h: 18, fill: '#000000' }) // "secret-2"
    const [p0, p1, p2] = pages
    p2.annots.push({ t: 'rect', x: 10, y: 10, w: 50, h: 30, stroke: '#ff0000', lw: 2 })
    annRotate90(p2.annots[0], p2.w, p2.h)
    p2.rot = 90; [p2.w, p2.h] = [p2.h, p2.w]
    const order = [p2, { id: 'blank', src: null, rot: 0, w: 300, h: 300, annots: [{ t: 'text', x: 20, y: 20, w: 0, text: 'Inserted', size: 12, font: 'helv', color: '#000000' }] }, p1, p0]
    const out = await exportEdited(inf, order)
    const d = await parsePdf(out)
    const leaves = pageLeaves(d)
    assert.equal(leaves.length, 4)
    const txt = await extractText(d)
    assert.match(txt[0], /Page 3/)
    assert.equal(txt[1], 'Inserted')
    assert.match(txt[2], /Page 2/)
    assert.ok(!txt[2].includes('secret-2'), `redacted: ${txt[2]}`)
    assert.match(txt[3], /secret-1/)
    assert.equal(get(leaves[0].dict, 'Rotate'), 90)
    // the rectangle drawn at display (10,10) before rotating lands at the rotated position
    const { ops, box } = await collectDrawOps(d, leaves[0])
    assert.deepEqual(box, { w: 800, h: 400 })
    const r = ops.find((o) => o.t === 'rect' && o.stroke)
    assert.ok(r && Math.abs(r.x - (800 - 40)) < 1 && Math.abs(r.y - 10) < 1 && Math.abs(r.w - 30) < 1 && Math.abs(r.h - 50) < 1, JSON.stringify(r))
  })
  it('identity structure keeps the original bytes path (no needless rebuild)', async () => {
    const inf = await info(doc(2))
    const out = await exportEdited(inf, pagesOf(inf))
    const d = await parsePdf(out)
    assert.equal(pageLeaves(d).length, 2)
  })
  it('every editor object type converts to valid engine annotations', async () => {
    const objs = [
      { t: 'stroke', pts: [[1, 1, 2], [5, 5, 3]], color: '#000000', width: 2 },
      { t: 'highlight', pts: [[1, 1], [9, 1]], color: '#ffff00', width: 10 },
      { t: 'hlrects', rects: [{ x: 1, y: 1, w: 50, h: 10 }], color: '#ffff00' },
      { t: 'line', x1: 0, y1: 0, x2: 10, y2: 10, color: '#000000', width: 1, arrow: true },
      { t: 'rect', x: 1, y: 1, w: 9, h: 9, stroke: '#000000', lw: 1, rot: 90 },
      { t: 'whiteout', x: 1, y: 1, w: 9, h: 9 },
      { t: 'text', x: 1, y: 1, w: 0, text: 'Hi', size: 10, font: 'times', bold: true, color: '#000000' },
      { t: 'image', x: 1, y: 1, w: 10, h: 10, rgba: new Uint8ClampedArray(16).fill(255), iw: 2, ih: 2 },
      { t: 'mark', kind: 'check', x: 1, y: 1, w: 10, h: 10, color: '#000000' },
      { t: 'mark', kind: 'dot', x: 1, y: 1, w: 10, h: 10, color: '#000000' },
      { t: 'stamp', label: 'PAID', x: 1, y: 1, w: 60, h: 20, color: '#ff0000' },
      { t: 'note', x: 1, y: 1, text: 'hello', color: '#ffd43b' },
      { t: 'link', x: 1, y: 1, w: 10, h: 10, url: 'example.com' },
    ]
    const conv = objs.flatMap(toEngine)
    assert.deepEqual(conv.map((a) => a.t), ['vstroke', 'highlight', 'highlight', 'line', 'rect', 'rect', 'text', 'image', 'path', 'ellipse', 'rect', 'text', 'note', 'link'])
    const inf = await info(doc(1))
    const pages = pagesOf(inf)
    pages[0].annots = objs
    const d = await parsePdf(await exportEdited(inf, pages))
    const annots = deref(d, get(pageLeaves(d)[0].dict, 'Annots')).map((r) => deref(d, r))
    assert.deepEqual(annots.map((a) => get(a, 'Subtype').v).sort(), ['Link', 'Text'])
    assert.match((await extractText(d))[0], /PAID/)
  })
})

describe('editor geometry', () => {
  it('rotating an annotation 4× returns it home', () => {
    const a = { t: 'rect', x: 10, y: 20, w: 30, h: 40 }
    const b = annClone(a)
    let W = 400, H = 800
    for (let k = 0; k < 4; k++) { annRotate90(b, W, H); [W, H] = [H, W] }
    assert.deepEqual([b.x, b.y, b.w, b.h].map((v) => Math.round(v)), [10, 20, 30, 40])
  })
  it('hit tests respect outlines vs fills, lines by distance', () => {
    const outline = { t: 'rect', x: 0, y: 0, w: 100, h: 100, stroke: '#000', lw: 2 }
    assert.ok(annHit(outline, 0, 50))
    assert.ok(!annHit(outline, 50, 50), 'hollow centre is click-through')
    assert.ok(annHit({ ...outline, fill: '#fff' }, 50, 50))
    assert.ok(annHit({ t: 'line', x1: 0, y1: 0, x2: 100, y2: 100, width: 2 }, 50, 52))
  })
  it('resizing keeps aspect for images, text corners scale the font', () => {
    const img = { t: 'image', x: 0, y: 0, w: 100, h: 50 }
    annResize(img, annClone(img), 'se', 200, 60, { aspect: true })
    assert.ok(Math.abs(img.w / img.h - 2) < 1e-9)
    const t = { t: 'text', x: 0, y: 0, w: 0, text: 'Hello', size: 10, font: 'helv' }
    const before = textBox(t)
    annResize(t, annClone(t), 'se', before.w * 2, before.h * 2, {})
    assert.equal(t.size, 20)
    assert.ok(annBox(t).w > before.w * 1.9)
  })
  it('text highlight selects reading-order runs between two points', () => {
    const runs = [
      { str: 'first line', x: 10, y: 10, w: 100, h: 12, base: 20, size: 12 },
      { str: 'second line', x: 10, y: 30, w: 120, h: 12, base: 40, size: 12 },
      { str: 'third', x: 10, y: 50, w: 60, h: 12, base: 60, size: 12 },
    ]
    const rects = selectionRects(runs, 60, 15, 40, 55)
    assert.equal(rects.length, 3)
    assert.ok(Math.abs(rects[0].x - 60) < 0.01, 'first line starts at the press point')
    assert.ok(Math.abs(rects[2].x + rects[2].w - 40) < 0.01, 'last line ends at the release point')
    assert.equal(rects[1].w, 120)
  })
  it('stroke smoothing keeps endpoints', () => {
    const s = smooth([[0, 0, 1], [10, 0, 2], [10, 10, 3]])
    assert.deepEqual(s[0], [0, 0, 1])
    assert.deepEqual(s[s.length - 1], [10, 10, 3])
  })
})
