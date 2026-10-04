// True redaction + text erasing by rewriting content streams.
// Glyphs whose centres fall inside a region are REMOVED from the Tj/TJ
// operators (replaced by spacing so the rest of the line keeps its place);
// image pixels under the region are painted out and the image re-encoded;
// links/comments over the region go. Nothing hidden "under a black box".
import { concat, enc, get, isStream, name, stream } from './types.js'
import { deref } from './parse.js'
import { deflate } from './env.js'
import { collectDrawOps, matPt, tokenizeContent, streamData } from './content.js'
import { decodeImage } from './image.js'
import { pageLeaves } from './ops.js'

const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
const rectsHit = (b, r) => b[0] < r.x + r.w && b[2] > r.x && b[1] < r.y + r.h && b[3] > r.y

/** Serialize a PDF string operand (literal, escaped). */
function strOperand(bytes) {
  let s = '('
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b)
    else if (b < 0x20 || b > 0x7e) s += '\\' + b.toString(8).padStart(3, '0')
    else s += String.fromCharCode(b)
  }
  return s + ')'
}
const fnum = (v) => (Number.isFinite(v) ? String(+v.toFixed(4)) : '0')

/**
 * Rebuild one text-showing operator with some glyphs removed.
 * tok: tokenizer op; parts: Map<partIndex, {fs, th, glyphs, removed:Set<glyphIdx>}>.
 * Returns replacement source text.
 */
function rewriteTextOp(tok, parts) {
  const out = [] // TJ items: strings (bytes) and numbers
  const pushStr = (bytes) => { if (bytes.length) out.push({ s: bytes }) }
  const pushNum = (n) => { if (n) out.push({ n }) }
  const doString = (bytes, part) => {
    const p = parts.get(part)
    if (!p) { pushStr(bytes); return }
    let keep = []
    let gap = 0
    p.glyphs.forEach((g, gi) => {
      if (p.removed.has(gi)) {
        if (keep.length) { pushStr(Uint8Array.from(keep)); keep = [] }
        gap += g.a
      } else {
        if (gap) { pushNum(-(gap * 1000) / (p.fs * p.th || 1)); gap = 0 }
        for (let k = g.b0; k < g.b1; k++) keep.push(bytes[k])
      }
    })
    if (keep.length) pushStr(Uint8Array.from(keep))
    if (gap) pushNum(-(gap * 1000) / (p.fs * p.th || 1))
  }
  let prefix = ''
  if (tok.op === 'TJ') {
    const arr = tok.operands.find((o) => o?.t === 'arr')
    arr?.items.forEach((it, k) => {
      if (it?.t === 'str') doString(it.bytes, k)
      else if (typeof it === 'number') pushNum(it)
    })
  } else {
    const nums = tok.operands.filter((o) => typeof o === 'number')
    if (tok.op === '"' && nums.length >= 2) prefix = `${fnum(nums[0])} Tw ${fnum(nums[1])} Tc `
    if (tok.op === "'" || tok.op === '"') prefix += 'T* '
    const s = [...tok.operands].reverse().find((o) => o?.t === 'str')
    if (s) doString(s.bytes, 0)
  }
  // merge adjacent numbers
  const merged = []
  for (const it of out) {
    const last = merged[merged.length - 1]
    if (it.n !== undefined && last?.n !== undefined) last.n += it.n
    else merged.push({ ...it })
  }
  const body = merged.map((it) => (it.n !== undefined ? fnum(it.n) : strOperand(it.s))).join(' ')
  return `${prefix}[${body}] TJ`
}

/** Paint display-space regions out of an RGBA image drawn with matrix m. */
function blankPixels(im, m, regions, fill) {
  // display → unit square (image space, y up) inverse
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det) return false
  const inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
  let touched = false
  const [fr, fg, fb] = fill
  for (const r of regions) {
    const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(([x, y]) => matPt(inv, x, y))
    const ux0 = Math.min(...corners.map((c) => c[0])), ux1 = Math.max(...corners.map((c) => c[0]))
    const uy0 = Math.min(...corners.map((c) => c[1])), uy1 = Math.max(...corners.map((c) => c[1]))
    const px0 = Math.max(0, Math.floor(ux0 * im.w)), px1 = Math.min(im.w, Math.ceil(ux1 * im.w))
    // image row 0 is the TOP (unit y = 1)
    const py0 = Math.max(0, Math.floor((1 - uy1) * im.h)), py1 = Math.min(im.h, Math.ceil((1 - uy0) * im.h))
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        // exact test for rotated images: pixel centre back to display space
        const [dx, dy] = matPt(m, (x + 0.5) / im.w, 1 - (y + 0.5) / im.h)
        if (!inRect(dx, dy, { x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 })) continue
        const o = (y * im.w + x) * 4
        im.rgba[o] = fr; im.rgba[o + 1] = fg; im.rgba[o + 2] = fb; im.rgba[o + 3] = 255
        touched = true
      }
    }
  }
  return touched
}

async function rgbaImageStream(im) {
  const rgb = new Uint8Array(im.w * im.h * 3)
  for (let i = 0, j = 0; i < im.w * im.h; i++, j += 4) { rgb[i * 3] = im.rgba[j]; rgb[i * 3 + 1] = im.rgba[j + 1]; rgb[i * 3 + 2] = im.rgba[j + 2] }
  return stream(new Map([
    ['Type', name('XObject')], ['Subtype', name('Image')], ['Width', im.w], ['Height', im.h],
    ['ColorSpace', name('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', name('FlateDecode')],
  ]), await deflate(rgb))
}

/**
 * Apply removals to a parsed doc IN PLACE (call before stamping/serialising).
 * regionsByPage[p] = [{x, y, w, h}] in display space.
 * opts.mode: 'redact' (text + images + annotations, then paint fill) | 'erase' (text only, no box)
 * opts.fill: '#000000' default for redact, null → no box.
 * opts.decodeJpeg(bytes) → Promise<{w,h,rgba}> (browser) for JPEG images under redactions;
 *   without it a JPEG touched by a redaction is removed entirely (safe default).
 * Returns {glyphs, images, annots} counts of what was removed.
 */
export async function applyRemovals(doc, regionsByPage, { mode = 'redact', fill = '#000000', decodeJpeg = null } = {}) {
  const leaves = pageLeaves(doc)
  const stats = { glyphs: 0, images: 0, annots: 0 }
  const fillRgb = hexRgb(fill) ?? [0, 0, 0]
  for (let pi = 0; pi < leaves.length; pi++) {
    const regions = (regionsByPage?.[pi] ?? []).filter((r) => r && r.w > 0 && r.h > 0)
    if (!regions.length) continue
    const leaf = leaves[pi]
    const { ops, data, tokens, disp } = await collectDrawOps(doc, leaf, { glyphs: true, annots: false })
    // ---- collect glyph removals per (xpath, op, part) ----
    const perStream = new Map() // xpathKey → Map<opIdx, Map<part, info>>
    for (const o of ops) {
      if (o.t !== 'text' || !o.glyphs?.length) continue
      let rec = null
      o.glyphs.forEach((g, gi) => {
        const [cx, cy] = matPt(o.m, g.x + g.w / 2, o.fs * 0.32)
        if (!regions.some((r) => inRect(cx, cy, r))) return
        if (!rec) {
          const key = o.src.xpath.join('/')
          if (!perStream.has(key)) perStream.set(key, { xpath: o.src.xpath, ops: new Map() })
          const byOp = perStream.get(key).ops
          if (!byOp.has(o.src.op)) byOp.set(o.src.op, new Map())
          rec = { fs: o.fs, th: o.th, glyphs: o.glyphs, removed: new Set() }
          byOp.get(o.src.op).set(o.src.part, rec)
        }
        rec.removed.add(gi)
        stats.glyphs++
      })
    }
    // ---- images (redact mode) ----
    const imageEdits = [] // {xpath, op, newName, stream} | {xpath, op, inline: replacement text}
    if (mode === 'redact') {
      let n = 0
      for (const o of ops) {
        if (o.t !== 'img' || !o.src) continue
        if (!regions.some((r) => rectsHit(o.bbox, r))) continue
        const srcStream = o.ref ?? { dict: o.inline.dict, data: o.inline.data }
        let im = await decodeImage(doc, srcStream, { fill: o.fill, res: o.res, inline: !!o.inline }).catch(() => null)
        if (im?.kind === 'jpeg' && decodeJpeg) {
          const dj = await decodeJpeg(im.data).catch(() => null)
          im = dj ? { kind: 'rgba', ...dj } : null
        }
        const key = o.src.xpath.join('/')
        if (!im || im.kind !== 'rgba') { // can't edit pixels → drop the image entirely
          imageEdits.push({ key, xpath: o.src.xpath, op: o.src.op, drop: true })
          stats.images++
          continue
        }
        if (!blankPixels(im, o.m, regions, fillRgb)) continue
        stats.images++
        const st = await rgbaImageStream(im)
        if (o.inline) imageEdits.push({ key, xpath: o.src.xpath, op: o.src.op, inline: st })
        else imageEdits.push({ key, xpath: o.src.xpath, op: o.src.op, newName: `RDim${pi}_${++n}`, stream: st })
      }
      for (const e of imageEdits) if (!perStream.has(e.key)) perStream.set(e.key, { xpath: e.xpath, ops: new Map() })
    }
    // ---- rewrite every affected stream (page content + nested forms, copy-on-write) ----
    const pageRes = cloneRes(deref(doc, get(leaf.dict, 'Resources') ?? leaf.inh.Resources))
    const rewriteSrc = (src, toks, edits, images) => {
      const reps = []
      for (const [opIdx, parts] of edits) {
        const tok = toks[opIdx]
        if (!tok || !['Tj', 'TJ', "'", '"'].includes(tok.op)) continue
        reps.push([tok.start, tok.end, rewriteTextOp(tok, parts)])
      }
      for (const e of images) {
        const tok = toks[e.op]
        if (!tok) continue
        if (e.drop) reps.push([tok.start, tok.end, ''])
        else if (e.newName) reps.push([tok.start, tok.end, `/${e.newName} Do`])
        else if (e.inline) reps.push([tok.start, tok.end, `/${e.inlineName} Do`])
      }
      reps.sort((a, b) => b[0] - a[0])
      let out = src
      for (const [s0, e0, txt] of reps) out = concat([out.subarray(0, s0), enc(` ${txt} `), out.subarray(e0)])
      return out
    }
    // group by stream key; page content first
    const keys = [...perStream.keys()].sort((a, b) => a.split('/').length - b.split('/').length)
    let newPageContent = data
    for (const key of keys) {
      const { xpath, ops: edits } = perStream.get(key)
      const images = imageEdits.filter((e) => e.key === key)
      // new image XObjects go into the resources of the stream that draws them
      if (!xpath.length) {
        for (const e of images) {
          if (e.newName) addXObject(pageRes, e.newName, e.stream)
          if (e.inline) { e.inlineName = `RDin${pi}_${e.op}`; addXObject(pageRes, e.inlineName, e.inline) }
        }
        newPageContent = rewriteSrc(data, tokens, edits, images)
        continue
      }
      // nested form: walk the resource chain, cloning each form on the way (copy-on-write)
      let res = pageRes
      let form = null
      for (const nm of xpath) {
        const xo = deref(doc, res.get('XObject'))
        const fv = xo instanceof Map ? deref(doc, xo.get(nm)) : null
        if (!isStream(fv)) { form = null; break }
        const copy = { k: 't', dict: new Map(fv.dict), data: fv.data }
        const subRes = cloneRes(deref(doc, get(fv.dict, 'Resources')) ?? res)
        copy.dict.set('Resources', subRes)
        const xoCopy = new Map(xo)
        xoCopy.set(nm, copy)
        res.set('XObject', xoCopy)
        res = subRes
        form = copy
      }
      if (!form) continue
      const fdata = await streamData(form)
      if (!fdata) continue
      for (const e of images) {
        if (e.newName) addXObject(res, e.newName, e.stream)
        if (e.inline) { e.inlineName = `RDin${pi}_${e.op}`; addXObject(res, e.inlineName, e.inline) }
      }
      const ftoks = tokenizeContent(fdata)
      form.data = rewriteSrc(fdata, ftoks, edits, images)
      form.dict.delete('Filter')
      form.dict.delete('DecodeParms')
      form.dict.set('Length', form.data.length)
    }
    // ---- redaction boxes, painted in display space on top of everything ----
    let tail = ''
    if (mode === 'redact' && fill) {
      const [r, g, b] = fillRgb.map((v) => +(v / 255).toFixed(3))
      const boxes = regions.map((rg) => `${fnum(rg.x)} ${fnum(rg.y)} ${fnum(rg.w)} ${fnum(rg.h)} re`).join(' ')
      // boxes are in display space; disp maps user→display, so cm with disp⁻¹
      const det = disp[0] * disp[3] - disp[1] * disp[2]
      const inv = [disp[3] / det, -disp[1] / det, -disp[2] / det, disp[0] / det, (disp[2] * disp[5] - disp[3] * disp[4]) / det, (disp[1] * disp[4] - disp[0] * disp[5]) / det]
      tail = `\nq ${inv.map(fnum).join(' ')} cm ${r} ${g} ${b} rg ${boxes} f Q\n`
    }
    // the rewritten content replaces ALL of the page's streams (they were concatenated)
    const body = concat([enc('q\n'), newPageContent ?? new Uint8Array(0), enc('\nQ'), enc(tail)])
    leaf.dict.set('Contents', stream(new Map(), body))
    leaf.dict.set('Resources', pageRes)
    // ---- annotations under the regions ----
    if (mode === 'redact') {
      const an = deref(doc, get(leaf.dict, 'Annots'))
      if (Array.isArray(an)) {
        const keep = an.filter((r) => {
          const a = deref(doc, r)
          const rect = a instanceof Map ? deref(doc, get(a, 'Rect')) : null
          if (!Array.isArray(rect)) return true
          const [x0, y0, x1, y1] = rect.map(Number)
          const p1 = matPt(disp, x0, y0), p2 = matPt(disp, x1, y1)
          const bb = [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])]
          const hit = regions.some((rg) => rectsHit(bb, rg))
          if (hit && get(a, 'Subtype')?.v !== 'Widget') { stats.annots++; return false }
          return true
        })
        leaf.dict.set('Annots', keep)
      }
    }
  }
  return stats
}

function cloneRes(res) {
  const m = res instanceof Map ? new Map(res) : new Map()
  return m
}
function addXObject(res, nm, st) {
  const xo = res.get('XObject')
  const m = xo instanceof Map ? new Map(xo) : new Map()
  m.set(nm, st)
  res.set('XObject', m)
}
function hexRgb(h) {
  const m = typeof h === 'string' ? h.match(/^#([0-9a-f]{6})$/i) : null
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * Text under display-space point / rect, for the editor's "edit text" tool:
 * returns runs [{str, x, y, w, h, size, rot, font, color, glyphRect}] grouped
 * into visual lines (adjacent runs on one baseline merge).
 */
export async function textRuns(doc, leaf) {
  const { ops } = await collectDrawOps(doc, leaf, { glyphs: true, annots: false })
  const runs = []
  for (const o of ops) {
    if (o.t !== 'text' || !o.str || o.inv || !o.glyphs?.length) continue
    if (Math.abs(o.rot) > 0.01) continue // rotated text: not editable in place
    // split one operator's glyphs into pieces at 2+ spaces or wide gaps —
    // generators often emit "FROM:   Company ABC" as a single string
    let piece = null
    let spaces = 0
    const flush = () => {
      if (!piece) return
      const s = piece.str.replace(/\s+$/, '')
      if (s.trim()) runs.push({ ...piece, str: s.replace(/^\s+/, '') })
      piece = null
    }
    for (const g of o.glyphs) {
      const isSpace = !g.s.trim()
      const gx0 = matPt(o.m, g.x, 0)[0], gx1 = matPt(o.m, g.x + g.w, 0)[0]
      const left = Math.min(gx0, gx1), right = Math.max(gx0, gx1)
      if (isSpace) { spaces++; if (piece) piece.str += g.s; continue }
      if (piece && (spaces >= 2 || left - (piece.x + piece.w) > o.h * 0.6)) flush()
      spaces = 0
      if (!piece) piece = { str: '', x: left, y: o.y - o.h * 0.78, w: 0, h: o.h, base: o.y, size: o.h, font: o.font, color: o.fc }
      piece.str += g.s
      piece.w = right - piece.x
    }
    flush()
  }
  // merge runs on one baseline whose gap is word-sized (kerned fragments → one phrase)
  runs.sort((a, b) => a.base - b.base || a.x - b.x)
  const merged = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    const gap = last ? r.x - (last.x + last.w) : 0
    if (last && Math.abs(last.base - r.base) < r.size * 0.25 && Math.abs(last.size - r.size) < r.size * 0.2 &&
        gap < r.size * 0.45 && r.x >= last.x - 0.5) {
      last.str += (gap > r.size * 0.15 && !last.str.endsWith(' ') ? ' ' : '') + r.str
      last.w = Math.max(last.x + last.w, r.x + r.w) - last.x
    } else merged.push({ ...r })
  }
  return merged
}

/**
 * Find every occurrence of `query` on a page → [{x, y, w, h, text}] boxes in
 * display space, glyph-accurate (for search-and-redact). Case-insensitive;
 * whitespace in the query matches any run of spaces/line joins.
 * opts.regex: treat query as a RegExp source (e.g. emails, phone numbers).
 */
export async function findText(doc, leaf, query, { regex = false } = {}) {
  if (!query) return []
  const { ops } = await collectDrawOps(doc, leaf, { glyphs: true, annots: false })
  // flatten glyphs into reading-order lines
  const glyphs = []
  for (const o of ops) {
    if (o.t !== 'text' || !o.glyphs?.length || o.inv) continue
    for (const g of o.glyphs) {
      const [x0, yb] = matPt(o.m, g.x, 0)
      const [x1] = matPt(o.m, g.x + g.w, 0)
      glyphs.push({ s: g.s, x: Math.min(x0, x1), w: Math.abs(x1 - x0), base: yb, size: o.h, rot: o.rot })
    }
  }
  const flat = glyphs.filter((g) => Math.abs(g.rot) < 0.01).sort((a, b) => (Math.abs(a.base - b.base) < a.size * 0.4 ? a.x - b.x : a.base - b.base))
  let text = ''
  const map = [] // char index → glyph index
  flat.forEach((g, i) => {
    const prev = flat[i - 1]
    if (prev) {
      const newLine = Math.abs(prev.base - g.base) >= prev.size * 0.4
      const gap = g.x - (prev.x + prev.w)
      if (newLine || gap > g.size * 0.18) { text += ' '; map.push(-1) }
    }
    for (const ch of g.s) { text += ch; map.push(i) }
  })
  let re
  try {
    re = regex ? new RegExp(query, 'gi') : new RegExp(query.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi')
  } catch { return [] }
  const out = []
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue
    const idx = map.slice(m.index, m.index + m[0].length).filter((k) => k >= 0)
    if (!idx.length) continue
    // one box per line the match spans
    const lines = new Map()
    for (const k of new Set(idx)) {
      const g = flat[k]
      const key = Math.round(g.base * 2)
      const b = lines.get(key) ?? { x0: Infinity, x1: -Infinity, base: g.base, size: g.size }
      b.x0 = Math.min(b.x0, g.x); b.x1 = Math.max(b.x1, g.x + g.w); b.size = Math.max(b.size, g.size)
      lines.set(key, b)
    }
    for (const b of lines.values()) out.push({ x: b.x0 - 0.5, y: b.base - b.size * 0.8, w: b.x1 - b.x0 + 1, h: b.size * 1.02, text: m[0] })
  }
  return out
}
