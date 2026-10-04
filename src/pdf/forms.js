// Interactive forms (AcroForm): read fields + widget geometry, fill values
// with generated appearance streams (so every viewer shows them), and
// optionally flatten (bake into page content, remove interactivity).
import { enc, get, isRef, isStream, name, ref, stream } from './types.js'
import { deref, parsePdf } from './parse.js'
import { copyValue, pageLeaves } from './ops.js'
import { displayTransform, matPt, pageBox, pageRotation } from './content.js'
import { pdfString, textString } from './outline.js'
import { stampPages, stdFont, textWidth, winStr } from './stamp.js'

const FF_READONLY = 1, FF_REQUIRED = 2, FF_MULTILINE = 1 << 12, FF_PASSWORD = 1 << 13
const FF_RADIO = 1 << 15, FF_PUSH = 1 << 16, FF_COMBO = 1 << 17, FF_EDIT = 1 << 18, FF_MULTISELECT = 1 << 21, FF_COMB = 1 << 24

/** Inherited field attribute lookup up the /Parent chain. */
function inh(doc, node, key) {
  for (let n = node, d = 0; n instanceof Map && d < 32; n = deref(doc, get(n, 'Parent')), d++) {
    const v = get(n, key)
    if (v !== undefined) return deref(doc, v)
  }
  return undefined
}

/** Parse a DA string "/Helv 12 Tf 0 0 1 rg" → {size, color:[r,g,b]}. */
function parseDA(da) {
  const s = da?.bytes ? new TextDecoder('latin1').decode(da.bytes) : ''
  const sz = s.match(/([\d.]+)\s+Tf/)
  let color = [0, 0, 0]
  const rg = s.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/)
  const g = s.match(/([\d.]+)\s+g(?![a-z])/)
  if (rg) color = [+rg[1], +rg[2], +rg[3]]
  else if (g) color = [+g[1], +g[1], +g[1]]
  return { size: sz ? +sz[1] : 0, color }
}

/**
 * Read all terminal fields → [{name, type, value, options, flags, readOnly, required, multiline,
 *   maxLen, comb, align, da, widgets:[{page, rect:{x,y,w,h} (display), onState, ref}]}].
 * type: 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature'
 */
export function readFields(doc) {
  const root = deref(doc, get(doc.trailer, 'Root'))
  const form = deref(doc, get(root, 'AcroForm'))
  if (!(form instanceof Map)) return []
  const leaves = pageLeaves(doc)
  // widget ref → page index (from page /Annots: more reliable than /P)
  const pageOf = new Map()
  leaves.forEach((leaf, i) => {
    const an = deref(doc, get(leaf.dict, 'Annots'))
    if (Array.isArray(an)) for (const r of an) if (isRef(r)) pageOf.set(`${r.n} ${r.g}`, i)
  })
  const geo = leaves.map((leaf) => {
    const box = pageBox(doc, leaf)
    return displayTransform(box, pageRotation(doc, leaf))
  })
  const fields = []
  const seen = new Set()
  const walk = (fref, prefix, depth) => {
    if (depth > 32) return
    const key = isRef(fref) ? `${fref.n} ${fref.g}` : null
    if (key && seen.has(key)) return
    if (key) seen.add(key)
    const f = deref(doc, fref)
    if (!(f instanceof Map)) return
    const t = get(f, 'T')
    const full = t ? (prefix ? `${prefix}.${pdfString(deref(doc, t))}` : pdfString(deref(doc, t))) : prefix
    const kids = deref(doc, get(f, 'Kids'))
    // kids that are fields (have /T) → recurse; kids without /T are this field's widgets
    const fieldKids = Array.isArray(kids) ? kids.filter((k) => { const kd = deref(doc, k); return kd instanceof Map && get(kd, 'T') !== undefined }) : []
    if (fieldKids.length) { for (const k of fieldKids) walk(k, full, depth + 1); return }
    const widgetRefs = Array.isArray(kids) && kids.length ? kids : [fref]
    const ft = inh(doc, f, 'FT')?.v
    const ff = inh(doc, f, 'Ff') ?? 0
    let type = ft === 'Tx' ? 'text' : ft === 'Ch' ? (ff & FF_COMBO ? 'combo' : 'list') : ft === 'Sig' ? 'signature'
      : ft === 'Btn' ? (ff & FF_PUSH ? 'button' : ff & FF_RADIO ? 'radio' : 'checkbox') : null
    if (!type) return
    const widgets = []
    for (const wr of widgetRefs) {
      const w = deref(doc, wr)
      if (!(w instanceof Map)) continue
      const rect = deref(doc, get(w, 'Rect'))
      const wkey = isRef(wr) ? `${wr.n} ${wr.g}` : null
      let page = wkey && pageOf.has(wkey) ? pageOf.get(wkey) : -1
      if (page < 0) {
        const p = get(w, 'P')
        if (isRef(p)) page = leaves.findIndex((l) => isRef(l.ref) && l.ref.n === p.n)
      }
      if (!Array.isArray(rect) || page < 0) continue
      const [x0, y0, x1, y1] = rect.map((v) => Number(deref(doc, v)))
      const a = matPt(geo[page], x0, y0), b = matPt(geo[page], x1, y1)
      // checkbox / radio on-state = the non-Off key of /AP /N
      let onState = null
      const apn = deref(doc, get(deref(doc, get(w, 'AP')), 'N'))
      if (apn instanceof Map && !isStream(apn)) onState = [...apn.keys()].find((k) => k !== 'Off') ?? null
      widgets.push({
        page, ref: wr, onState,
        rect: { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) },
        hidden: !!((deref(doc, get(w, 'F')) ?? 0) & 2),
      })
    }
    const v = inh(doc, f, 'V')
    let value
    if (type === 'checkbox') value = v?.k === 'n' && v.v !== 'Off'
    else if (type === 'radio') value = v?.k === 'n' && v.v !== 'Off' ? v.v : null
    else if (type === 'list' && Array.isArray(v)) value = v.map((x) => pdfString(deref(doc, x)))
    else value = v?.bytes ? pdfString(v) : v?.k === 'n' ? v.v : ''
    const opt = deref(doc, inh(doc, f, 'Opt'))
    const options = Array.isArray(opt) ? opt.map((o) => {
      o = deref(doc, o)
      if (Array.isArray(o)) return { value: pdfString(deref(doc, o[0])), label: pdfString(deref(doc, o[1])) }
      const s = pdfString(o)
      return { value: s, label: s }
    }) : []
    const da = parseDA(inh(doc, f, 'DA') ?? get(form, 'DA'))
    fields.push({
      name: full, type, value, options, flags: ff, ref: fref,
      readOnly: !!(ff & FF_READONLY), required: !!(ff & FF_REQUIRED), multiline: !!(ff & FF_MULTILINE),
      password: !!(ff & FF_PASSWORD), comb: !!(ff & FF_COMB), editable: !!(ff & FF_EDIT), multiSelect: !!(ff & FF_MULTISELECT),
      maxLen: inh(doc, f, 'MaxLen') ?? null, align: inh(doc, f, 'Q') ?? 0, da, widgets,
    })
  }
  const top = deref(doc, get(form, 'Fields'))
  if (Array.isArray(top)) for (const f of top) walk(f, '', 0)
  return fields
}

const n2 = (v) => +(+v).toFixed(3)

/** Appearance stream for a text-ish widget showing `text`. */
function textAppearance(text, w, h, { size, color, align, multiline, comb, maxLen }) {
  const base = stdFont('helv')
  const pad = 2
  let fs = size || 0
  const lines = multiline ? wrapLines(text, base, fs || 12, w - 2 * pad) : [text]
  if (!fs) { // auto size: fit height (and width for single-line)
    fs = multiline ? 10 : Math.max(4, Math.min(12, (h - 2 * pad) * 0.75))
    if (!multiline) while (fs > 4 && textWidth(base, text, fs) > w - 2 * pad) fs -= 0.5
  }
  const [r, g, b] = color
  let body = ''
  if (comb && maxLen > 0) {
    const cell = w / maxLen
    ;[...text].slice(0, maxLen).forEach((ch, i) => {
      const cw = textWidth(base, ch, fs)
      body += `BT /Helv ${n2(fs)} Tf ${n2(i * cell + (cell - cw) / 2)} ${n2((h - fs * 0.72) / 2)} Td ${winStr(ch)} Tj ET\n`
    })
  } else {
    const ls = multiline ? wrapLines(text, base, fs, w - 2 * pad) : lines
    const lead = fs * 1.15
    ls.forEach((ln, i) => {
      const tw = textWidth(base, ln, fs)
      const x = align === 1 ? (w - tw) / 2 : align === 2 ? w - pad - tw : pad
      const y = multiline ? h - pad - fs * 0.9 - i * lead : (h - fs * 0.72) / 2
      body += `BT /Helv ${n2(fs)} Tf ${n2(x)} ${n2(y)} Td ${winStr(ln)} Tj ET\n`
    })
  }
  return `/Tx BMC q 1 1 ${n2(w - 2)} ${n2(h - 2)} re W n ${n2(r)} ${n2(g)} ${n2(b)} rg\n${body}Q EMC`
}

function wrapLines(text, base, fs, maxW) {
  const out = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const t = line + word
      if (line && textWidth(base, t.trimEnd(), fs) > maxW) { out.push(line.trimEnd()); line = word.trimStart() }
      else line = t
    }
    out.push(line)
  }
  return out
}

const checkAppearance = (w, h, color = [0, 0, 0]) => {
  // ZapfDingbats-free check mark drawn as a path (no font dependency)
  const s = Math.min(w, h) * 0.8, ox = (w - s) / 2, oy = (h - s) / 2
  const [r, g, b] = color
  return `q ${n2(r)} ${n2(g)} ${n2(b)} RG ${n2(Math.max(1, s * 0.12))} w 1 J 1 j ${n2(ox + s * 0.15)} ${n2(oy + s * 0.5)} m ${n2(ox + s * 0.4)} ${n2(oy + s * 0.22)} l ${n2(ox + s * 0.88)} ${n2(oy + s * 0.82)} l S Q`
}
const dotAppearance = (w, h, color = [0, 0, 0]) => {
  const r = Math.min(w, h) * 0.28, cx = w / 2, cy = h / 2, k = 0.5523 * r
  const [cr, cg, cb] = color
  return `q ${n2(cr)} ${n2(cg)} ${n2(cb)} rg ${n2(cx + r)} ${n2(cy)} m ${n2(cx + r)} ${n2(cy + k)} ${n2(cx + k)} ${n2(cy + r)} ${n2(cx)} ${n2(cy + r)} c ${n2(cx - k)} ${n2(cy + r)} ${n2(cx - r)} ${n2(cy + k)} ${n2(cx - r)} ${n2(cy)} c ${n2(cx - r)} ${n2(cy - k)} ${n2(cx - k)} ${n2(cy - r)} ${n2(cx)} ${n2(cy - r)} c ${n2(cx + k)} ${n2(cy - r)} ${n2(cx + r)} ${n2(cy - k)} ${n2(cx + r)} ${n2(cy)} c f Q`
}

/**
 * Fill fields: values = {fieldName: string | boolean | string[]}.
 * opts.flatten: bake appearances into page content and drop the form.
 * Returns new PDF bytes.
 */
export async function fillForm(bytes, values, { flatten = false } = {}) {
  const doc = bytes instanceof Uint8Array ? await parsePdf(bytes) : bytes
  const fields = readFields(doc)
  const helv = new Map([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')], ['Encoding', name('WinAnsiEncoding')]])
  const mkAP = (content, w, h, withFont) => {
    const res = new Map()
    if (withFont) res.set('Font', new Map([['Helv', helv]]))
    return stream(new Map([['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, n2(w), n2(h)]], ['Resources', res]]), enc(content))
  }
  const setOn = (node, k, v) => { if (node instanceof Map) node.set(k, v) }
  for (const f of fields) {
    if (!(f.name in values) || f.readOnly) continue
    const v = values[f.name]
    const fd = deref(doc, f.ref)
    if (f.type === 'text' || f.type === 'combo' || f.type === 'list') {
      const sv = Array.isArray(v) ? v : String(v ?? '')
      const shown = Array.isArray(sv) ? sv.join(', ') : f.maxLen ? sv.slice(0, f.maxLen) : sv
      setOn(fd, 'V', Array.isArray(sv) ? sv.map(textString) : textString(shown))
      for (const wd of f.widgets) {
        const w = deref(doc, wd.ref)
        const rect = deref(doc, get(w, 'Rect')).map(Number)
        const ww = Math.abs(rect[2] - rect[0]), hh = Math.abs(rect[3] - rect[1])
        const display = f.type === 'list' || f.type === 'combo' ? (f.options.find((o) => o.value === shown)?.label ?? shown) : f.password ? '•'.repeat(shown.length) : shown
        const ap = mkAP(textAppearance(display, ww, hh, { size: f.da.size, color: f.da.color, align: f.align, multiline: f.multiline, comb: f.comb, maxLen: f.maxLen }), ww, hh, true)
        w.set('AP', new Map([['N', ap]]))
      }
    } else if (f.type === 'checkbox') {
      const on = v === true || v === 'true' || v === 'on' || v === 'Yes'
      for (const wd of f.widgets) {
        const w = deref(doc, wd.ref)
        const st = wd.onState ?? 'Yes'
        w.set('AS', name(on ? st : 'Off'))
        if (!wd.onState) { // no appearance for "on" yet → build both states
          const rect = deref(doc, get(w, 'Rect')).map(Number)
          const ww = Math.abs(rect[2] - rect[0]), hh = Math.abs(rect[3] - rect[1])
          w.set('AP', new Map([['N', new Map([['Yes', mkAP(checkAppearance(ww, hh, f.da.color), ww, hh)], ['Off', mkAP('', ww, hh)]])]]))
        }
      }
      setOn(fd, 'V', name(on ? (f.widgets[0]?.onState ?? 'Yes') : 'Off'))
    } else if (f.type === 'radio') {
      const pick = v == null || v === false ? 'Off' : String(v)
      for (const wd of f.widgets) {
        const w = deref(doc, wd.ref)
        const st = wd.onState
        w.set('AS', name(st && st === pick ? st : 'Off'))
        if (!st) {
          const rect = deref(doc, get(w, 'Rect')).map(Number)
          const ww = Math.abs(rect[2] - rect[0]), hh = Math.abs(rect[3] - rect[1])
          w.set('AP', new Map([['N', new Map([[pick, mkAP(dotAppearance(ww, hh, f.da.color), ww, hh)], ['Off', mkAP('', ww, hh)]])]]))
        }
      }
      setOn(fd, 'V', name(pick))
    }
  }
  const root = deref(doc, get(doc.trailer, 'Root'))
  const form = deref(doc, get(root, 'AcroForm'))
  if (form instanceof Map) form.set('NeedAppearances', false)
  if (!flatten) return stampPages(doc, () => null)
  // flatten: strip widgets from the pages up front (pages are copied before
  // stampFor runs), remember their appearances, then draw them as content
  const bake = pageLeaves(doc).map((leaf) => {
    const an = deref(doc, get(leaf.dict, 'Annots'))
    if (!Array.isArray(an)) return []
    const keep = [], todo = []
    for (const r of an) {
      const a = deref(doc, r)
      if (!(a instanceof Map) || get(a, 'Subtype')?.v !== 'Widget') { keep.push(r); continue }
      if ((deref(doc, get(a, 'F')) ?? 0) & 2) continue
      let ap = get(deref(doc, get(a, 'AP')), 'N')
      let apv = deref(doc, ap)
      if (apv instanceof Map && !isStream(apv)) { const as = get(a, 'AS'); ap = as?.k === 'n' ? apv.get(as.v) : null; apv = deref(doc, ap) }
      if (!isStream(apv)) continue
      todo.push({ ap, apv, rect: deref(doc, get(a, 'Rect')).map(Number) })
    }
    if (keep.length) leaf.dict.set('Annots', keep)
    else leaf.dict.delete('Annots')
    return todo
  })
  if (form instanceof Map) root.delete('AcroForm')
  return stampPages(doc, ({ i, dst }) => {
    const todo = bake[i]
    if (!todo?.length) return null
    const xo = {}
    let content = ''
    todo.forEach(({ ap, apv, rect }, k) => {
      const bb = (deref(doc, get(apv.dict, 'BBox')) ?? [0, 0, rect[2] - rect[0], rect[3] - rect[1]]).map(Number)
      const sx = (Math.abs(rect[2] - rect[0]) || 1) / ((bb[2] - bb[0]) || 1)
      const sy = (Math.abs(rect[3] - rect[1]) || 1) / ((bb[3] - bb[1]) || 1)
      const nm = `FLT${k + 1}`
      if (!get(apv.dict, 'Subtype')) { apv.dict.set('Type', name('XObject')); apv.dict.set('Subtype', name('Form')) }
      xo[nm] = copyValue(isRef(ap) ? ap : apv, doc, dst, new Map())
      content += `q ${n2(sx)} 0 0 ${n2(sy)} ${n2(Math.min(rect[0], rect[2]) - bb[0] * sx)} ${n2(Math.min(rect[1], rect[3]) - bb[1] * sy)} cm /${nm} Do Q\n`
    })
    return { content: '\n' + content, res: { XObject: xo } }
  })
}
