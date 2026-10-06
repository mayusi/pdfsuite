// Design & Edit — pure pixel operations on RGBA buffers and 8-bit masks
// (selections, flood fill / magic wand, destructive filters). No DOM, so it
// all runs in node tests. A mask is a Uint8Array(w*h), 0 = outside, 255 = in.

const clampB = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)

// ---------- masks ----------

export function maskRect(w, h, x, y, rw, rh) {
  const m = new Uint8Array(w * h)
  const x0 = Math.max(0, Math.round(Math.min(x, x + rw))), x1 = Math.min(w, Math.round(Math.max(x, x + rw)))
  const y0 = Math.max(0, Math.round(Math.min(y, y + rh))), y1 = Math.min(h, Math.round(Math.max(y, y + rh)))
  for (let yy = y0; yy < y1; yy++) m.fill(255, yy * w + x0, yy * w + x1)
  return m
}

export function maskEllipse(w, h, x, y, rw, rh) {
  const m = new Uint8Array(w * h)
  const cx = x + rw / 2, cy = y + rh / 2, rx = Math.abs(rw / 2), ry = Math.abs(rh / 2)
  if (rx < 0.5 || ry < 0.5) return m
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(h, Math.ceil(cy + ry))
  for (let yy = y0; yy < y1; yy++) {
    const dy = (yy + 0.5 - cy) / ry
    if (dy * dy > 1) continue
    const dx = rx * Math.sqrt(1 - dy * dy)
    const a = Math.max(0, Math.round(cx - dx)), b = Math.min(w, Math.round(cx + dx))
    if (b > a) m.fill(255, yy * w + a, yy * w + b)
  }
  return m
}

/** Even-odd scanline fill of a closed polygon [[x,y],…]. */
export function maskPolygon(w, h, pts) {
  const m = new Uint8Array(w * h)
  if (pts.length < 3) return m
  const ys = pts.map((p) => p[1])
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h, Math.ceil(Math.max(...ys)))
  const xs = []
  for (let yy = y0; yy < y1; yy++) {
    const sy = yy + 0.5
    xs.length = 0
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j]
      if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) / (yj - yi)) * (xj - xi))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.round(xs[k])), b = Math.min(w, Math.round(xs[k + 1]))
      if (b > a) m.fill(255, yy * w + a, yy * w + b)
    }
  }
  return m
}

/** Combine a new selection with the current one. mode: replace | add | subtract | intersect */
export function maskCombine(cur, next, mode = 'replace') {
  if (!cur || mode === 'replace') return next
  const out = new Uint8Array(cur.length)
  for (let i = 0; i < out.length; i++) {
    const a = cur[i], b = next[i]
    out[i] = mode === 'add' ? Math.max(a, b) : mode === 'subtract' ? Math.min(a, 255 - b) : Math.min(a, b)
  }
  return out
}

export function maskInvert(m) {
  const out = new Uint8Array(m.length)
  for (let i = 0; i < m.length; i++) out[i] = 255 - m[i]
  return out
}

export function maskEmpty(m) {
  if (!m) return true
  for (let i = 0; i < m.length; i++) if (m[i]) return false
  return true
}

/** Bounding box of the non-zero mask, or null. */
export function maskBounds(m, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (m[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** Soften a mask's edge (separable box blur, 2 passes). */
export function maskFeather(m, w, h, r) {
  r = Math.round(r)
  if (r < 1) return m
  let a = Float32Array.from(m), b = new Float32Array(m.length)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) { // horizontal
      let acc = 0
      const row = y * w
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / (2 * r + 1)
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]
      }
    }
    for (let x = 0; x < w; x++) { // vertical
      let acc = 0
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * r + 1)
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]
      }
    }
  }
  const out = new Uint8Array(m.length)
  for (let i = 0; i < out.length; i++) out[i] = clampB(Math.round(a[i]))
  return out
}

/** Grow (r>0) or shrink (r<0) a selection by r pixels (square structuring element). */
export function maskGrow(m, w, h, r) {
  r = Math.round(r)
  if (!r) return m
  const grow = r > 0
  const rr = Math.abs(r)
  const pick = grow ? Math.max : Math.min
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 255
    for (let k = -rr; k <= rr; k++) { const xx = x + k; v = pick(v, xx < 0 || xx >= w ? (grow ? 0 : 0) : m[y * w + xx]) }
    tmp[y * w + x] = v
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = grow ? 0 : 255
    for (let k = -rr; k <= rr; k++) { const yy = y + k; v = pick(v, yy < 0 || yy >= h ? 0 : tmp[yy * w + x]) }
    out[y * w + x] = v
  }
  return out
}

/**
 * Edge segments of a mask (threshold 128) for "marching ants":
 * flat array [x1, y1, x2, y2, …] with runs merged along rows / columns.
 */
export function maskOutline(m, w, h) {
  const segs = []
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] >= 128
  for (let y = 0; y <= h; y++) { // horizontal edges between row y-1 and y
    let start = -1
    for (let x = 0; x <= w; x++) {
      const edge = x < w && inside(x, y - 1) !== inside(x, y)
      if (edge && start < 0) start = x
      else if (!edge && start >= 0) { segs.push(start, y, x, y); start = -1 }
    }
  }
  for (let x = 0; x <= w; x++) { // vertical edges between column x-1 and x
    let start = -1
    for (let y = 0; y <= h; y++) {
      const edge = y < h && inside(x - 1, y) !== inside(x, y)
      if (edge && start < 0) start = y
      else if (!edge && start >= 0) { segs.push(x, start, x, y); start = -1 }
    }
  }
  return segs
}

// ---------- flood fill / magic wand ----------

/**
 * Pixels similar to the one at (x,y): max channel difference (RGBA) ≤ tolerance (0-255).
 * contiguous=false selects that colour everywhere.
 */
export function floodMask(rgba, w, h, x, y, { tolerance = 32, contiguous = true } = {}) {
  const m = new Uint8Array(w * h)
  x = Math.floor(x); y = Math.floor(y)
  if (x < 0 || y < 0 || x >= w || y >= h) return m
  const i0 = (y * w + x) * 4
  const r = rgba[i0], g = rgba[i0 + 1], b = rgba[i0 + 2], a = rgba[i0 + 3]
  const near = (p) => {
    const i = p * 4
    // fully transparent pixels match each other regardless of their (meaningless) colour
    if (a === 0 && rgba[i + 3] === 0) return true
    return Math.max(Math.abs(rgba[i] - r), Math.abs(rgba[i + 1] - g), Math.abs(rgba[i + 2] - b), Math.abs(rgba[i + 3] - a)) <= tolerance
  }
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (near(p)) m[p] = 255
    return m
  }
  const stack = [y * w + x]
  m[y * w + x] = 255
  while (stack.length) { // scanline flood
    const p = stack.pop()
    const py = (p / w) | 0
    let lx = p % w, rx = lx
    while (lx > 0 && !m[py * w + lx - 1] && near(py * w + lx - 1)) { lx--; m[py * w + lx] = 255 }
    while (rx < w - 1 && !m[py * w + rx + 1] && near(py * w + rx + 1)) { rx++; m[py * w + rx] = 255 }
    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= h) continue
      for (let xx = lx; xx <= rx; xx++) {
        const q = ny * w + xx
        if (!m[q] && near(q)) { m[q] = 255; stack.push(q) }
      }
    }
  }
  return m
}

// ---------- compositing helpers ----------

/** dst = src where mask (soft), else dst. All buffers same size. */
export function blendMasked(dst, src, mask) {
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const k = mask[p]
    if (!k) continue
    if (k === 255) { dst[i] = src[i]; dst[i + 1] = src[i + 1]; dst[i + 2] = src[i + 2]; dst[i + 3] = src[i + 3]; continue }
    const t = k / 255
    for (let c = 0; c < 4; c++) dst[i + c] = Math.round(dst[i + c] + (src[i + c] - dst[i + c]) * t)
  }
  return dst
}

/** Clear (make transparent) the masked pixels. */
export function clearMasked(rgba, mask) {
  for (let p = 0; p < mask.length; p++) if (mask[p]) rgba[p * 4 + 3] = Math.round(rgba[p * 4 + 3] * (1 - mask[p] / 255))
  return rgba
}

/** Fill the masked pixels with a colour [r,g,b,a]. */
export function fillMasked(rgba, mask, [r, g, b, a = 255]) {
  const src = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < src.length; i += 4) { src[i] = r; src[i + 1] = g; src[i + 2] = b; src[i + 3] = a }
  return blendMasked(rgba, src, mask)
}

// ---------- filters (destructive, return a new buffer) ----------

export function pixelate(rgba, w, h, size) {
  const out = new Uint8ClampedArray(rgba)
  size = Math.max(2, Math.round(size))
  for (let by = 0; by < h; by += size) for (let bx = 0; bx < w; bx += size) {
    const ex = Math.min(w, bx + size), ey = Math.min(h, by + size)
    const s = [0, 0, 0, 0]
    let n = 0
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 4; for (let c = 0; c < 4; c++) s[c] += rgba[i + c]; n++ }
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * w + x) * 4; for (let c = 0; c < 4; c++) out[i + c] = Math.round(s[c] / n) }
  }
  return out
}

export function posterize(rgba, w, h, levels = 4) {
  const out = new Uint8ClampedArray(rgba)
  const n = Math.max(2, Math.round(levels)) - 1
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = Math.round(Math.round((rgba[i + c] / 255) * n) * (255 / n))
  return out
}

export function threshold(rgba, w, h, level = 128) {
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const v = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] >= level ? 255 : 0
    out[i] = out[i + 1] = out[i + 2] = v
  }
  return out
}

/** 3×3 convolution (alpha kept). */
export function convolve(rgba, w, h, k, { bias = 0, divisor = 1 } = {}) {
  const out = new Uint8ClampedArray(rgba)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    for (let c = 0; c < 3; c++) {
      let s = 0
      for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
        const xx = Math.min(w - 1, Math.max(0, x + kx)), yy = Math.min(h - 1, Math.max(0, y + ky))
        s += rgba[(yy * w + xx) * 4 + c] * k[(ky + 1) * 3 + kx + 1]
      }
      out[o + c] = s / divisor + bias
    }
  }
  return out
}

export const emboss = (rgba, w, h) => convolve(rgba, w, h, [-2, -1, 0, -1, 1, 1, 0, 1, 2], { bias: 0 })

export function edgeDetect(rgba, w, h) {
  const g = grayscaleCopy(rgba)
  const L = (x, y) => g[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4]
  const out = new Uint8ClampedArray(rgba)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // Sobel magnitude, in floats
    const gx = L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1)
    const gy = L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1)
    const i = (y * w + x) * 4
    out[i] = out[i + 1] = out[i + 2] = Math.min(255, Math.hypot(gx, gy) / 4)
  }
  return out
}

/** Pencil-sketch look: inverted edges on white. */
export function sketch(rgba, w, h) {
  const e = edgeDetect(rgba, w, h)
  for (let i = 0; i < e.length; i += 4) e[i] = e[i + 1] = e[i + 2] = 255 - e[i]
  return e
}

function grayscaleCopy(rgba) {
  const g = new Uint8ClampedArray(rgba)
  for (let i = 0; i < g.length; i += 4) g[i] = g[i + 1] = g[i + 2] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
  return g
}

/** Deterministic noise (amount 0-100). */
export function addNoise(rgba, w, h, amount = 20, seed = 1) {
  const out = new Uint8ClampedArray(rgba)
  let s = seed >>> 0 || 1
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) - 0.5 }
  const k = amount * 2.55
  for (let i = 0; i < out.length; i += 4) { const n = rnd() * k; for (let c = 0; c < 3; c++) out[i + c] = rgba[i + c] + n }
  return out
}

/** 3×3 median — removes speckle noise. */
export function denoise(rgba, w, h) {
  const out = new Uint8ClampedArray(rgba)
  const win = new Array(9)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4
    for (let c = 0; c < 3; c++) {
      let n = 0
      for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
        const xx = Math.min(w - 1, Math.max(0, x + kx)), yy = Math.min(h - 1, Math.max(0, y + ky))
        win[n++] = rgba[(yy * w + xx) * 4 + c]
      }
      win.sort((a, b) => a - b)
      out[o + c] = win[4]
    }
  }
  return out
}

/** Stretch each channel so its darkest 0.5% → 0 and brightest → 255. */
export function autoLevels(rgba, w, h) {
  const out = new Uint8ClampedArray(rgba)
  const n = w * h
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256)
    for (let i = c; i < rgba.length; i += 4) hist[rgba[i]]++
    const cut = n * 0.005
    let lo = 0, hi = 255, acc = 0
    while (lo < 255 && (acc += hist[lo]) <= cut) lo++
    acc = 0
    while (hi > 0 && (acc += hist[hi]) <= cut) hi--
    if (hi <= lo) continue
    for (let i = c; i < rgba.length; i += 4) out[i] = ((rgba[i] - lo) * 255) / (hi - lo)
  }
  return out
}

/** Destructive filter registry: id → [label, fn(rgba,w,h,amount)] */
export const FILTERS = {
  pixelate: ['Pixelate', (d, w, h, a = 12) => pixelate(d, w, h, a)],
  posterize: ['Posterize', (d, w, h, a = 5) => posterize(d, w, h, a)],
  threshold: ['Threshold', (d, w, h, a = 128) => threshold(d, w, h, a)],
  emboss: ['Emboss', (d, w, h) => emboss(d, w, h)],
  edges: ['Edge detect', (d, w, h) => edgeDetect(d, w, h)],
  sketch: ['Sketch', (d, w, h) => sketch(d, w, h)],
  noise: ['Add noise', (d, w, h, a = 20) => addNoise(d, w, h, a, 7)],
  denoise: ['Reduce noise', (d, w, h) => denoise(d, w, h)],
  autolevels: ['Auto levels', (d, w, h) => autoLevels(d, w, h)],
}
