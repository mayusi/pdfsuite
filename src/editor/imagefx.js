// Pixel pipeline for the editor's image editing — pure JS on RGBA buffers, so
// the live preview and the exported PDF are byte-for-byte the same process
// (and it all runs in node tests). Order: crop → flip → adjustments → effects
// → background removal → rounded corners → border → shadow.

export const FX_DEFAULTS = {
  brightness: 0, contrast: 0, saturation: 0, hue: 0, exposure: 0, warmth: 0, tint: 0,
  blur: 0, sharpen: 0, vignette: 0, grain: 0, sepia: 0, grayscale: 0, invert: 0,
  removeBg: null, // {color:[r,g,b], tolerance 0-100, feather 0-100}
  radius: 0, // % of the short side
  border: null, // {width (% short side), color}
  shadow: null, // {blur (% short side), dx, dy (%), color, opacity}
}

/** Preset looks (merged over the defaults). */
export const PRESETS = {
  none: {},
  bw: { grayscale: 100, contrast: 12 },
  noir: { grayscale: 100, contrast: 45, brightness: -8, vignette: 45 },
  sepia: { sepia: 85, contrast: 5, brightness: 4 },
  vintage: { sepia: 35, saturation: -25, contrast: -10, warmth: 25, vignette: 35, grain: 18 },
  vivid: { saturation: 45, contrast: 15, sharpen: 25 },
  warm: { warmth: 40, saturation: 10 },
  cool: { warmth: -40, tint: -5 },
  fade: { contrast: -30, brightness: 12, saturation: -20 },
  dramatic: { contrast: 55, saturation: -15, vignette: 55, sharpen: 20 },
  invert: { invert: 100 },
  pop: { saturation: 70, contrast: 25, exposure: 10 },
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v)

/** Is this fx object a no-op? (skip work + keep JPEGs untouched) */
export function fxIsIdentity(fx = {}, geo = {}) {
  for (const [k, d] of Object.entries(FX_DEFAULTS)) {
    const v = fx[k] ?? d
    if (d === null ? v !== null && v !== undefined : v !== d) return false
  }
  return !geo.crop && !geo.flipH && !geo.flipV
}

/** Crop (source px) → new buffer. */
export function cropRGBA({ rgba, w, h }, c) {
  const x0 = Math.max(0, Math.round(c.x)), y0 = Math.max(0, Math.round(c.y))
  const cw = Math.max(1, Math.min(w - x0, Math.round(c.w))), ch = Math.max(1, Math.min(h - y0, Math.round(c.h)))
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4)
  return { rgba: out, w: cw, h: ch }
}

export function flipRGBA({ rgba, w, h }, flipH, flipV) {
  if (!flipH && !flipV) return { rgba, w, h }
  const out = new Uint8ClampedArray(rgba.length)
  for (let y = 0; y < h; y++) {
    const sy = flipV ? h - 1 - y : y
    for (let x = 0; x < w; x++) {
      const sx = flipH ? w - 1 - x : x
      const s = (sy * w + sx) * 4, d = (y * w + x) * 4
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3]
    }
  }
  return { rgba: out, w, h }
}

/** Separable box blur (3 passes ≈ gaussian) on all four channels, in place. */
export function blurRGBA(rgba, w, h, radius) {
  const r = Math.max(0, Math.round(radius))
  if (!r) return rgba
  const tmp = new Float32Array(rgba.length)
  const src = Float32Array.from(rgba)
  const pass = (from, to, horiz) => {
    const len = horiz ? w : h, lines = horiz ? h : w
    const win = 2 * r + 1
    for (let l = 0; l < lines; l++) {
      const idx = (i) => (horiz ? (l * w + i) * 4 : (i * w + l) * 4)
      for (let c = 0; c < 4; c++) {
        let acc = 0
        for (let i = -r; i <= r; i++) acc += from[idx(Math.min(len - 1, Math.max(0, i))) + c]
        for (let i = 0; i < len; i++) {
          to[idx(i) + c] = acc / win
          acc += from[idx(Math.min(len - 1, i + r + 1)) + c] - from[idx(Math.max(0, i - r)) + c]
        }
      }
    }
  }
  for (let k = 0; k < 3; k++) { pass(src, tmp, true); pass(tmp, src, false) }
  for (let i = 0; i < rgba.length; i++) rgba[i] = src[i]
  return rgba
}

function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  let hh = 0, s = 0
  const l = (mx + mn) / 2
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    hh /= 6
  }
  return [hh, s, l]
}
function hslToRgb(hh, s, l) {
  if (!s) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)]
}

/** Per-pixel colour adjustments, in place. Values are -100..100 (hue -180..180). */
export function adjustRGBA(rgba, w, h, fx) {
  const br = (fx.brightness ?? 0) * 1.6
  const ct = (fx.contrast ?? 0) / 100
  const cf = ct >= 0 ? 1 + ct * 2 : 1 + ct
  const sat = (fx.saturation ?? 0) / 100
  const hue = (fx.hue ?? 0) / 360
  const ex = 2 ** ((fx.exposure ?? 0) / 50)
  const warm = (fx.warmth ?? 0) * 0.5, tint = (fx.tint ?? 0) * 0.4
  const sep = (fx.sepia ?? 0) / 100, gray = (fx.grayscale ?? 0) / 100, inv = (fx.invert ?? 0) / 100
  const vig = (fx.vignette ?? 0) / 100, grain = (fx.grain ?? 0) / 100
  const cx = w / 2, cy = h / 2, maxd = Math.hypot(cx, cy) || 1
  let seed = 1234567
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      if (ex !== 1) { r *= ex; g *= ex; b *= ex }
      if (br) { r += br; g += br; b += br }
      if (cf !== 1) { r = (r - 128) * cf + 128; g = (g - 128) * cf + 128; b = (b - 128) * cf + 128 }
      if (warm || tint) { r += warm; b -= warm; g += tint }
      r = clamp8(r); g = clamp8(g); b = clamp8(b)
      if (sat || hue) {
        let [hh, s, l] = rgbToHsl(r / 255, g / 255, b / 255)
        if (hue) hh = (hh + hue + 1) % 1
        if (sat) s = Math.min(1, Math.max(0, sat > 0 ? s + (1 - s) * sat * s * 1.5 + s * sat * 0.3 : s * (1 + sat)))
        ;[r, g, b] = hslToRgb(hh, s, l).map((v) => v * 255)
      }
      if (gray) { const yv = 0.299 * r + 0.587 * g + 0.114 * b; r += (yv - r) * gray; g += (yv - g) * gray; b += (yv - b) * gray }
      if (sep) {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b
        r += (sr - r) * sep; g += (sg - g) * sep; b += (sb - b) * sep
      }
      if (inv) { r += (255 - 2 * r) * inv; g += (255 - 2 * g) * inv; b += (255 - 2 * b) * inv }
      if (vig) { const d = Math.hypot(x - cx, y - cy) / maxd; const k = 1 - vig * Math.max(0, d - 0.35) * 1.4; r *= k; g *= k; b *= k }
      if (grain) { const n = rnd() * 60 * grain; r += n; g += n; b += n }
      rgba[i] = clamp8(r); rgba[i + 1] = clamp8(g); rgba[i + 2] = clamp8(b)
    }
  }
  return rgba
}

/** Unsharp mask: original + amount·(original − blurred), in place. */
export function sharpenRGBA(rgba, w, h, amount) {
  const a = amount / 100
  if (!a) return rgba
  const bl = blurRGBA(Uint8ClampedArray.from(rgba), w, h, Math.max(1, Math.round(Math.min(w, h) / 400)))
  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) rgba[i + c] = clamp8(rgba[i + c] + (rgba[i + c] - bl[i + c]) * a * 1.5)
  }
  return rgba
}

/**
 * Background removal by colour key: pixels close to `color` become
 * transparent; feather softens the edge. Flood-fills from the borders when
 * contiguous=true so the same colour inside the subject survives.
 */
export function removeBgRGBA(rgba, w, h, { color, tolerance = 25, feather = 20, contiguous = true }) {
  const tol = (tolerance / 100) * 442 // max RGB distance
  const fth = Math.max(1, (feather / 100) * 120)
  const dist = (i) => Math.hypot(rgba[i] - color[0], rgba[i + 1] - color[1], rgba[i + 2] - color[2])
  const alphaFor = (d) => (d <= tol ? 0 : d >= tol + fth ? 1 : (d - tol) / fth)
  if (!contiguous) {
    for (let i = 0; i < rgba.length; i += 4) rgba[i + 3] = rgba[i + 3] * alphaFor(dist(i))
    return rgba
  }
  const seen = new Uint8Array(w * h)
  const stack = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)
  while (stack.length) {
    const p = stack.pop()
    if (seen[p]) continue
    seen[p] = 1
    const d = dist(p * 4)
    if (d > tol + fth) continue
    rgba[p * 4 + 3] = rgba[p * 4 + 3] * alphaFor(d)
    if (d > tol) continue // feather band: soften but don't spread through it
    const x = p % w, y = (p / w) | 0
    if (x > 0) stack.push(p - 1)
    if (x < w - 1) stack.push(p + 1)
    if (y > 0) stack.push(p - w)
    if (y < h - 1) stack.push(p + w)
  }
  return rgba
}

/** Most common corner colour — a good guess for "the background". */
export function guessBackground(rgba, w, h) {
  const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w >> 1, 0], [0, h >> 1], [w - 1, h >> 1], [w >> 1, h - 1]]
  const cols = pts.map(([x, y]) => { const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]] })
  let best = cols[0], bestN = -1
  for (const c of cols) {
    const n = cols.filter((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) < 40).length
    if (n > bestN) { bestN = n; best = c }
  }
  return best
}

/** Rounded-corner alpha mask (radius px), in place. */
export function roundRGBA(rgba, w, h, rad) {
  const r = Math.min(rad, w / 2, h / 2)
  if (r < 1) return rgba
  for (let y = 0; y < h; y++) {
    const dy = y < r ? r - y - 0.5 : y >= h - r ? y - (h - r) + 0.5 : 0
    if (!dy) continue
    for (let x = 0; x < w; x++) {
      const dx = x < r ? r - x - 0.5 : x >= w - r ? x - (w - r) + 0.5 : 0
      if (!dx) continue
      const d = Math.hypot(dx, dy) - r
      if (d > -1) rgba[(y * w + x) * 4 + 3] *= Math.max(0, Math.min(1, -d))
    }
  }
  return rgba
}

/** Paint a border inside the edges following the alpha shape (rounded corners respected). */
export function borderRGBA(rgba, w, h, bw, color, rad) {
  const b = Math.max(0, Math.round(bw))
  if (!b) return rgba
  const r = Math.min(rad, w / 2, h / 2)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // distance to the (rounded) outer edge
      let d = Math.min(x, y, w - 1 - x, h - 1 - y)
      if (r >= 1) {
        const dx = x < r ? r - x : x >= w - r ? x - (w - r) + 1 : 0
        const dy = y < r ? r - y : y >= h - r ? y - (h - r) + 1 : 0
        if (dx && dy) d = r - Math.hypot(dx, dy)
      }
      if (d < b) {
        const i = (y * w + x) * 4
        const k = Math.min(1, b - d) // anti-aliased inner edge
        rgba[i] += (color[0] - rgba[i]) * k
        rgba[i + 1] += (color[1] - rgba[i + 1]) * k
        rgba[i + 2] += (color[2] - rgba[i + 2]) * k
      }
    }
  }
  return rgba
}

/**
 * Drop shadow: returns a bigger buffer with the shadow behind the image.
 * pad/offsets in px. Returns {rgba, w, h, ox, oy} where (ox,oy) is where the
 * original image's top-left now sits inside the padded buffer.
 */
export function shadowRGBA({ rgba, w, h }, { blur, dx, dy, color = [0, 0, 0], opacity = 50 }) {
  const pad = Math.ceil(blur * 2 + Math.max(Math.abs(dx), Math.abs(dy)))
  const W = w + 2 * pad, H = h + 2 * pad
  const sh = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tx = x + pad + Math.round(dx), ty = y + pad + Math.round(dy)
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue
      const o = (ty * W + tx) * 4
      sh[o] = color[0]; sh[o + 1] = color[1]; sh[o + 2] = color[2]
      sh[o + 3] = rgba[(y * w + x) * 4 + 3] * (opacity / 100)
    }
  }
  blurRGBA(sh, W, H, blur)
  // composite the image over the shadow (source-over)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = ((y + pad) * W + x + pad) * 4
      const sa = rgba[s + 3] / 255, da = sh[d + 3] / 255
      const oa = sa + da * (1 - sa)
      if (oa <= 0) continue
      for (let c = 0; c < 3; c++) sh[d + c] = (rgba[s + c] * sa + sh[d + c] * da * (1 - sa)) / oa
      sh[d + 3] = oa * 255
    }
  }
  return { rgba: sh, w: W, h: H, ox: pad, oy: pad }
}

/**
 * Run the whole pipeline. src = {rgba, w, h}; geo = {crop:{x,y,w,h} (source px), flipH, flipV};
 * fx = adjustments. Returns {rgba, w, h, ox, oy} (ox/oy > 0 when a shadow padded it).
 * `scale` lets the preview run on a downscaled source with identical look
 * (pixel-size effects — blur, border, radius, shadow — are relative to the short side).
 */
export function processImage(src, geo = {}, fx = {}) {
  let img = { rgba: Uint8ClampedArray.from(src.rgba), w: src.w, h: src.h }
  if (geo.crop) {
    const k = src.w / (geo.srcW ?? src.w) // crop is stored in full-res px; preview sources are smaller
    img = cropRGBA(img, { x: geo.crop.x * k, y: geo.crop.y * k, w: geo.crop.w * k, h: geo.crop.h * k })
  }
  img = flipRGBA(img, geo.flipH, geo.flipV)
  const short = Math.min(img.w, img.h)
  const f = { ...FX_DEFAULTS, ...fx }
  adjustRGBA(img.rgba, img.w, img.h, f)
  if (f.blur) blurRGBA(img.rgba, img.w, img.h, (f.blur / 100) * short * 0.04)
  if (f.sharpen) sharpenRGBA(img.rgba, img.w, img.h, f.sharpen)
  if (f.removeBg) removeBgRGBA(img.rgba, img.w, img.h, f.removeBg)
  const rad = (f.radius / 100) * short * 0.5
  if (rad) roundRGBA(img.rgba, img.w, img.h, rad)
  if (f.border?.width) borderRGBA(img.rgba, img.w, img.h, (f.border.width / 100) * short * 0.1, hexRgb8(f.border.color ?? '#ffffff'), rad)
  let ox = 0, oy = 0
  if (f.shadow?.opacity) {
    const s = shadowRGBA(img, {
      blur: (f.shadow.blur / 100) * short * 0.08, dx: (f.shadow.dx / 100) * short * 0.1, dy: (f.shadow.dy / 100) * short * 0.1,
      color: hexRgb8(f.shadow.color ?? '#000000'), opacity: f.shadow.opacity,
    })
    img = { rgba: s.rgba, w: s.w, h: s.h }
    ox = s.ox; oy = s.oy
  }
  return { ...img, ox, oy, innerW: img.w - 2 * ox, innerH: img.h - 2 * oy }
}

export function hexRgb8(hx) {
  const m = String(hx).match(/^#?([0-9a-f]{6})$/i)
  const n = m ? parseInt(m[1], 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
