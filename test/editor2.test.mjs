import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toEngine, bakeImage } from '../src/editor/export.js'
import { annHit, annBounds, eraseFrom, polyPoints, annClone } from '../src/editor/annots.js'
import { contentMargins } from '../src/tools/crop.js'

const solid = (w, h, c) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) d.set(c, i); return d }

describe('editor objects → engine', () => {
  it('hidden objects and removal markers export nothing', () => {
    assert.deepEqual(toEngine({ t: 'rect', x: 0, y: 0, w: 5, h: 5, fill: '#000000', hidden: true }), [])
    assert.deepEqual(toEngine({ t: 'imgremove', region: { x: 0, y: 0, w: 5, h: 5 } }), [])
  })
  it('polygons/stars become closed paths with the right point count', () => {
    const [p] = toEngine({ t: 'poly', kind: 'star', sides: 5, x: 0, y: 0, w: 100, h: 100, stroke: '#000000', lw: 2 })
    assert.equal(p.t, 'path')
    assert.equal(p.segs.length, 11) // 10 points + close
    assert.deepEqual(p.segs.at(-1), ['Z'])
    assert.equal(polyPoints({ kind: 'polygon', sides: 6, x: 0, y: 0, w: 10, h: 10 }).length, 6)
  })
  it('a semi-transparent fill is split from an opaque outline; blend passes through', () => {
    const out = toEngine({ t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#ff0000', fillAlpha: 0.25, stroke: '#000000', lw: 1, alpha: 1, blend: 'multiply' })
    assert.equal(out.length, 2)
    assert.equal(out[0].alpha, 0.25)
    assert.equal(out[0].stroke, null)
    assert.equal(out[1].fill, null)
    assert.ok(out.every((o) => o.blend === 'multiply'))
  })
  it('text effects reach the engine', () => {
    const [t] = toEngine({ t: 'text', x: 10, y: 10, text: 'Hi', size: 12, font: 'helv', color: '#000000', spacing: 2, lineHeight: 1.6, outline: { width: 1, color: '#fff' }, shadow: { opacity: 40 } })
    assert.equal(t.spacing, 2)
    assert.equal(t.lineHeight, 1.6)
    assert.ok(t.outline && t.shadow)
  })
  it('whiteout keeps its rotation', () => {
    const [w] = toEngine({ t: 'whiteout', x: 0, y: 0, w: 10, h: 10, rot: 90 })
    assert.ok(Math.abs(w.rot - Math.PI / 2) < 1e-9)
  })
})

describe('image baking', () => {
  it('untouched images keep their original bytes', async () => {
    assert.equal(await bakeImage({ t: 'image', x: 0, y: 0, w: 10, h: 10, rgba: solid(2, 2, [1, 2, 3, 255]), iw: 2, ih: 2 }), null)
  })
  it('crop + filter produce new pixels; a shadow grows the box around the same centre', async () => {
    const a = { t: 'image', x: 100, y: 100, w: 50, h: 50, rgba: solid(20, 20, [200, 50, 50, 255]), iw: 20, ih: 20, fx: { grayscale: 100 }, crop: { x: 0, y: 0, w: 10, h: 10 } }
    const b = await bakeImage(a)
    assert.deepEqual([b.iw, b.ih], [10, 10])
    assert.equal(b.rgba[0], b.rgba[1])
    const s = await bakeImage({ ...a, crop: undefined, fx: { shadow: { blur: 20, dx: 0, dy: 0, opacity: 50 } } })
    assert.ok(s.w > 50 && s.x < 100)
    assert.ok(Math.abs(s.x + s.w / 2 - 125) < 1e-6, 'centre preserved')
    const [e] = toEngine({ ...a, baked: s })
    assert.equal(e.iw, s.iw)
    assert.equal(e.jpeg, undefined)
  })
  it('JPEG sources go through the supplied decoder', async () => {
    let called = 0
    const decode = async () => { called++; return { rgba: solid(4, 4, [10, 10, 10, 255]), w: 4, h: 4 } }
    const b = await bakeImage({ t: 'image', x: 0, y: 0, w: 4, h: 4, jpeg: new Uint8Array([1]), iw: 4, ih: 4, flipH: true }, decode)
    assert.equal(called, 1)
    assert.equal(b.iw, 4)
  })
})

describe('object helpers', () => {
  it('hidden / locked / removal markers are never hit', () => {
    const r = { t: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#000' }
    assert.ok(annHit(r, 5, 5))
    assert.ok(!annHit({ ...r, hidden: true }, 5, 5))
    assert.ok(!annHit({ ...r, locked: true }, 5, 5))
  })
  it('rotated bounds grow to the rotated corners', () => {
    const b = annBounds({ t: 'rect', x: 0, y: 0, w: 100, h: 10, rot: 90 })
    assert.ok(Math.abs(b.w - 10) < 1e-6 && Math.abs(b.h - 100) < 1e-6)
  })
  it('erasing the middle of a stroke splits it in two', () => {
    const pts = Array.from({ length: 21 }, (_, i) => [i * 10, 50, 2])
    const parts = eraseFrom({ t: 'stroke', pts, color: '#000', width: 2 }, 100, 50, 8)
    assert.equal(parts.length, 2)
    assert.equal(eraseFrom({ t: 'stroke', pts, color: '#000', width: 2 }, 100, 300, 8), null, 'untouched')
  })
  it('clones carry image edits but share the pixel data', () => {
    const a = { t: 'image', rgba: new Uint8ClampedArray(4), fx: { blur: 3 }, crop: { x: 1, y: 1, w: 2, h: 2 } }
    const c = annClone(a)
    c.fx.blur = 9
    c.crop.x = 0
    assert.equal(a.fx.blur, 3)
    assert.equal(a.crop.x, 1)
    assert.equal(c.rgba, a.rgba)
  })
})

describe('crop: content margin detection', () => {
  it('finds the inked area and pads it a little', () => {
    const w = 100, h = 100
    const d = solid(w, h, [255, 255, 255, 255])
    for (let y = 20; y < 60; y++) for (let x = 30; x < 80; x++) d.set([0, 0, 0, 255], (y * w + x) * 4)
    const m = contentMargins(d, w, h, { pad: 0 })
    assert.deepEqual([m.l, m.t, m.r, m.b].map((v) => +v.toFixed(2)), [0.3, 0.2, 0.2, 0.4])
    assert.deepEqual(contentMargins(solid(10, 10, [255, 255, 255, 255]), 10, 10), { l: 0, t: 0, r: 0, b: 0 }, 'blank page untouched')
  })
})
