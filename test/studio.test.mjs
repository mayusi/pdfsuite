import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  maskRect, maskEllipse, maskPolygon, maskCombine, maskInvert, maskBounds, maskFeather, maskGrow, maskOutline, maskEmpty,
  floodMask, blendMasked, clearMasked, fillMasked, pixelate, posterize, threshold, edgeDetect, addNoise, denoise, autoLevels, FILTERS,
} from '../src/studio/raster.js'

const img = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(fn(x, y), (y * w + x) * 4); return d }
const count = (m) => m.reduce((s, v) => s + (v ? 1 : 0), 0)

describe('studio selections', () => {
  it('rect / ellipse / polygon masks cover the expected area', () => {
    assert.equal(count(maskRect(10, 10, 2, 3, 4, 5)), 20)
    assert.equal(count(maskRect(10, 10, 6, 8, -4, -5)), 20, 'negative drag direction')
    const e = maskEllipse(100, 100, 0, 0, 100, 100)
    assert.ok(Math.abs(count(e) - Math.PI * 2500) < 120)
    const tri = maskPolygon(100, 100, [[0, 0], [100, 0], [0, 100]])
    assert.ok(Math.abs(count(tri) - 5000) < 150)
  })
  it('combine modes, invert, bounds, empty', () => {
    const a = maskRect(10, 10, 0, 0, 6, 10), b = maskRect(10, 10, 4, 0, 6, 10)
    assert.equal(count(maskCombine(a, b, 'add')), 100)
    assert.equal(count(maskCombine(a, b, 'subtract')), 40)
    assert.equal(count(maskCombine(a, b, 'intersect')), 20)
    assert.equal(count(maskInvert(a)), 40)
    assert.deepEqual(maskBounds(b, 10, 10), { x: 4, y: 0, w: 6, h: 10 })
    assert.equal(maskBounds(new Uint8Array(100), 10, 10), null)
    assert.ok(maskEmpty(new Uint8Array(4)) && !maskEmpty(a))
  })
  it('feather softens the edge; grow and shrink move it', () => {
    const m = maskRect(40, 40, 10, 10, 20, 20)
    const f = maskFeather(m, 40, 40, 3)
    assert.equal(f[20 * 40 + 20], 255)
    assert.ok(f[20 * 40 + 10] > 0 && f[20 * 40 + 10] < 255)
    assert.equal(count(maskGrow(m, 40, 40, 2)), 24 * 24)
    assert.equal(count(maskGrow(m, 40, 40, -2)), 16 * 16)
  })
  it('outline traces the border of a square', () => {
    const segs = maskOutline(maskRect(10, 10, 2, 2, 3, 3), 10, 10)
    assert.equal(segs.length / 4, 4) // four merged sides
  })
})

describe('studio flood fill / magic wand', () => {
  // left half red, right half blue, a red dot on the blue side
  const w = 20, h = 10
  const d = img(w, h, (x, y) => (x < 10 || (x === 15 && y === 5) ? [255, 0, 0, 255] : [0, 0, 255, 255]))
  it('contiguous fill stops at colour edges', () => {
    assert.equal(count(floodMask(d, w, h, 2, 2)), 100)
  })
  it('global mode finds the colour everywhere', () => {
    assert.equal(count(floodMask(d, w, h, 2, 2, { contiguous: false })), 101)
  })
  it('tolerance includes close colours', () => {
    const g = img(10, 1, (x) => [x * 10, 0, 0, 255])
    assert.equal(count(floodMask(g, 10, 1, 0, 0, { tolerance: 25 })), 3)
  })
  it('transparent pixels match regardless of colour', () => {
    const t = img(4, 1, (x) => (x < 3 ? [x * 80, 0, 0, 0] : [0, 0, 0, 255]))
    assert.equal(count(floodMask(t, 4, 1, 0, 0, { tolerance: 0 })), 3)
  })
})

describe('studio masked pixel ops', () => {
  it('fill / clear / blend respect the mask', () => {
    const d = img(4, 1, () => [0, 0, 0, 255])
    const m = Uint8Array.from([255, 128, 0, 0])
    fillMasked(d, m, [255, 255, 255])
    assert.equal(d[0], 255)
    assert.ok(d[4] > 100 && d[4] < 160)
    assert.equal(d[8], 0)
    clearMasked(d, Uint8Array.from([0, 0, 255, 0]))
    assert.equal(d[11], 0)
    const src = img(4, 1, () => [9, 9, 9, 255])
    blendMasked(d, src, Uint8Array.from([0, 0, 0, 255]))
    assert.equal(d[12], 9)
  })
})

describe('studio filters', () => {
  const g = img(8, 8, (x, y) => [x * 32, y * 32, 100, 255])
  it('pixelate makes uniform blocks', () => {
    const p = pixelate(g, 8, 8, 4)
    assert.deepEqual([...p.slice(0, 4)], [...p.slice(12, 16)])
  })
  it('posterize limits levels; threshold is black/white', () => {
    const p = posterize(g, 8, 8, 2)
    assert.ok([...p].every((v, i) => i % 4 === 3 || v === 0 || v === 255))
    const t = threshold(g, 8, 8, 128)
    assert.ok([...t].every((v, i) => i % 4 === 3 || v === 0 || v === 255))
  })
  it('edge detect is flat on a flat image and strong on an edge', () => {
    const flat = edgeDetect(img(5, 5, () => [80, 80, 80, 255]), 5, 5)
    assert.equal(flat[12 * 4], 0)
    const step = edgeDetect(img(6, 3, (x) => (x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255])), 6, 3)
    assert.ok(step[(1 * 6 + 3) * 4] > 200)
  })
  it('noise is deterministic; denoise removes a speck', () => {
    assert.deepEqual([...addNoise(g, 8, 8, 30, 3)], [...addNoise(g, 8, 8, 30, 3)])
    const s = img(5, 5, (x, y) => (x === 2 && y === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    assert.equal(denoise(s, 5, 5)[12 * 4], 0)
  })
  it('auto levels stretches a dull image', () => {
    const dull = img(10, 10, (x) => [100 + x * 5, 100 + x * 5, 100 + x * 5, 255])
    const a = autoLevels(dull, 10, 10)
    assert.ok(a[0] < 10 && a[9 * 4] > 245)
  })
  it('every registered filter runs', () => {
    for (const [id, [, fn]] of Object.entries(FILTERS)) assert.equal(fn(g, 8, 8).length, g.length, id)
  })
})
