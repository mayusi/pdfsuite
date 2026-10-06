import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { processImage, adjustRGBA, removeBgRGBA, guessBackground, cropRGBA, flipRGBA, roundRGBA, fxIsIdentity, PRESETS, blurRGBA } from '../src/editor/imagefx.js'

/** w×h image filled by fn(x,y) → [r,g,b,a]. */
const img = (w, h, fn) => {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(fn(x, y), (y * w + x) * 4)
  return { rgba, w, h }
}
const px = (im, x, y) => [...im.rgba.slice((y * im.w + x) * 4, (y * im.w + x) * 4 + 4)]

describe('image fx pipeline', () => {
  it('identity detection', () => {
    assert.ok(fxIsIdentity({}, {}))
    assert.ok(!fxIsIdentity({ brightness: 5 }, {}))
    assert.ok(!fxIsIdentity({}, { flipH: true }))
    assert.ok(!fxIsIdentity({ removeBg: { color: [255, 255, 255] } }, {}))
  })
  it('crop + flip keep the right pixels', () => {
    const src = img(4, 3, (x, y) => [x * 10, y * 10, 0, 255])
    const c = cropRGBA(src, { x: 1, y: 1, w: 2, h: 2 })
    assert.deepEqual([c.w, c.h, px(c, 0, 0)], [2, 2, [10, 10, 0, 255]])
    const f = flipRGBA(src, true, true)
    assert.deepEqual(px(f, 0, 0), [30, 20, 0, 255])
  })
  it('adjustments: brightness, contrast, grayscale, invert, sepia', () => {
    const one = (fx, c = [100, 150, 200, 255]) => { const d = Uint8ClampedArray.from(c); adjustRGBA(d, 1, 1, fx); return [...d] }
    assert.ok(one({ brightness: 50 })[0] > 100)
    assert.ok(one({ contrast: 50 })[0] < 100 && one({ contrast: 50 })[2] > 200)
    const g = one({ grayscale: 100 })
    assert.ok(g[0] === g[1] && g[1] === g[2])
    assert.deepEqual(one({ invert: 100 }).slice(0, 3), [155, 105, 55])
    const s = one({ sepia: 100 })
    assert.ok(s[0] > s[1] && s[1] > s[2], 'sepia is warm')
    assert.deepEqual(one({}).slice(0, 3), [100, 150, 200], 'zero fx is a no-op')
  })
  it('hue rotation by 120° maps red → green', () => {
    const d = Uint8ClampedArray.from([255, 0, 0, 255])
    adjustRGBA(d, 1, 1, { hue: 120 })
    assert.ok(d[1] > 200 && d[0] < 30, [...d].join())
  })
  it('background removal keys out the surround but keeps same colour inside the subject', () => {
    // white frame, black ring, white centre (should survive: not connected to the edge)
    const im = img(9, 9, (x, y) => {
      const ring = Math.max(Math.abs(x - 4), Math.abs(y - 4))
      return ring === 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]
    })
    assert.deepEqual(guessBackground(im.rgba, 9, 9), [255, 255, 255])
    removeBgRGBA(im.rgba, 9, 9, { color: [255, 255, 255], tolerance: 10, feather: 0 })
    assert.equal(px(im, 0, 0)[3], 0, 'outside removed')
    assert.equal(px(im, 4, 4)[3], 255, 'enclosed white kept')
    assert.equal(px(im, 2, 2)[3], 255, 'subject kept')
  })
  it('rounded corners clear the corner pixel and keep the centre', () => {
    const im = img(20, 20, () => [10, 10, 10, 255])
    roundRGBA(im.rgba, 20, 20, 8)
    assert.equal(px(im, 0, 0)[3], 0)
    assert.equal(px(im, 10, 10)[3], 255)
  })
  it('blur spreads a single bright pixel', () => {
    const im = img(9, 9, (x, y) => (x === 4 && y === 4 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    blurRGBA(im.rgba, 9, 9, 1)
    assert.ok(px(im, 4, 4)[0] < 255 && px(im, 5, 4)[0] > 0)
  })
  it('shadow pads the buffer and reports where the image sits', () => {
    const r = processImage(img(10, 10, () => [200, 0, 0, 255]), {}, { shadow: { blur: 20, dx: 30, dy: 30, opacity: 60, color: '#000000' } })
    assert.ok(r.w > 10 && r.ox > 0 && r.innerW === 10)
    assert.deepEqual(px(r, r.ox + 5, r.oy + 5).slice(0, 3), [200, 0, 0])
  })
  it('every preset runs and changes the image', () => {
    const src = img(8, 8, (x, y) => [x * 30, y * 30, 120, 255])
    for (const [name, fx] of Object.entries(PRESETS)) {
      if (name === 'none') continue
      const r = processImage(src, {}, fx)
      assert.notDeepEqual([...r.rgba.slice(0, 64)], [...src.rgba.slice(0, 64)], name)
    }
  })
  it('crop is stored in full-res px and scales for downsized previews', () => {
    const full = img(100, 50, (x) => [x, 0, 0, 255])
    const prev = img(50, 25, (x) => [x * 2, 0, 0, 255])
    const geo = { crop: { x: 50, y: 0, w: 50, h: 50 }, srcW: 100 }
    const a = processImage(full, geo), b = processImage(prev, geo)
    assert.deepEqual([a.w, a.h, b.w, b.h], [50, 50, 25, 25])
    assert.equal(px(a, 0, 0)[0], 50)
    assert.equal(px(b, 0, 0)[0], 50)
  })
})
