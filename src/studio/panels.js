// Design & Edit — side panels (properties of the active layer, layers list,
// history) and the start screen (sizes, templates, open).
import { h, icon, setKids } from '../ui/dom.js'
import { Button, Seg, Select, Range, Switch, TextInput, Field, Swatches, Dropzone, sortable, menu, toast } from '../ui/kit.js'
import { BLEND_MODES, STUDIO_FONTS, SIZE_PRESETS, TEMPLATES, SHAPE_NAMES, documentFromTemplate, flatten, makeCanvas, drawLayerContent, pixelsOf, fitText } from './doc.js'
import { FILTERS } from './raster.js'
import { PRESETS, processImage, guessBackground } from '../editor/imagefx.js'

const LAYER_ICONS = { raster: 'image', text: 'type', shape: 'shapes' }
const PRESET_LABELS = { none: 'Original', bw: 'B&W', noir: 'Noir', sepia: 'Sepia', vintage: 'Vintage', vivid: 'Vivid', warm: 'Warm', cool: 'Cool', fade: 'Fade', dramatic: 'Drama', invert: 'Invert', pop: 'Pop' }
const FX_ADJUST = [
  ['brightness', 'Brightness', -100, 100], ['contrast', 'Contrast', -100, 100], ['exposure', 'Exposure', -100, 100], ['saturation', 'Saturation', -100, 100],
  ['warmth', 'Warmth', -100, 100], ['tint', 'Tint', -100, 100], ['hue', 'Hue', -180, 180],
]
const FX_EFFECTS = [['blur', 'Blur'], ['sharpen', 'Sharpen'], ['vignette', 'Vignette'], ['grain', 'Grain'], ['sepia', 'Sepia'], ['grayscale', 'Black & white']]

/** Range that reports while dragging (done=false) and once on release (done=true). */
function slide(value, opts, onChange) {
  const r = Range(value, opts, (v) => onChange(+v, false))
  r.querySelector('input').addEventListener('change', (e) => onChange(+e.target.value, true))
  return r
}
const row = (label, control) => h('div', { class: 'st-row' }, h('label', {}, label), control)
const num = (value, onCommit, { step = 1, min = -1e6, max = 1e6 } = {}) => {
  const inp = h('input', { class: 'input st-num', type: 'number', step: String(step), value: String(Math.round(value * 10) / 10) })
  inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) onCommit(Math.max(min, Math.min(max, v))) })
  inp.addEventListener('keydown', (e) => e.stopPropagation())
  return inp
}
const color = (value, onInput, onCommit) => {
  const inp = h('input', { type: 'color', class: 'st-color', value: value || '#000000' })
  inp.addEventListener('input', () => onInput(inp.value))
  inp.addEventListener('change', () => onCommit?.(inp.value))
  return inp
}

export function studioPanels(S, el) {
  const scrollTop = el.querySelector('.st-props')?.scrollTop ?? 0
  const L = S.active()
  const tab = S.panelTab ?? 'layers'
  const props = h('div', { class: 'st-props' }, L ? layerProps(S, L) : h('div', { class: 'tip' }, 'Select a layer to edit it.'))
  const bottom = h('div', { class: 'st-lower' },
    h('div', { class: 'st-tabs' }, Seg([['layers', 'Layers', 'layers'], ['history', 'History', 'history']], tab, (v) => { S.panelTab = v; S.refresh() }, { block: true })),
    tab === 'history' ? historyList(S) : layersList(S))
  setKids(el, h('div', { class: 'sheet-handle', onclick: () => el.classList.toggle('open') }, h('span', { class: 'grab' }), L ? L.name : 'Layers', icon('chevDown', 'icon-sm')), props, bottom)
  props.scrollTop = scrollTop
}

// ---------- properties ----------
function layerProps(S, L) {
  const live = () => S.redraw()
  const set = (k, v, label) => S.setProp(L, k, v, label)
  const name = h('input', { class: 'input st-lname', value: L.name, 'aria-label': 'Layer name' })
  name.addEventListener('change', () => { if (name.value.trim()) set('name', name.value.trim(), 'Rename layer') })
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur() })
  const common = h('details', { class: 'st-sec', open: true }, h('summary', {}, 'Layer'),
    row('Opacity', slide(Math.round(L.opacity * 100), { min: 0, max: 100, fmt: (v) => `${v}%` }, (v, done) => { L.opacity = v / 100; live(); if (done) S.commit('Opacity') })),
    row('Blend', Select(BLEND_MODES, L.blend ?? 'normal', (v) => set('blend', v, 'Blend mode'))),
    h('div', { class: 'st-grid4' },
      h('label', {}, 'X', num(L.x, (v) => set('x', v, 'Move'))), h('label', {}, 'Y', num(L.y, (v) => set('y', v, 'Move'))),
      h('label', {}, 'W', num(L.w, (v) => { const k = v / L.w; L.w = v; if (L.type === 'text') { L.size *= k; fitText(L, 'center') } S.commit('Resize') }, { min: 1 })),
      h('label', {}, 'H', num(L.h, (v) => { L.h = v; S.commit('Resize') }, { min: 1 })),
      h('label', {}, '°', num(L.rot, (v) => set('rot', ((v % 360) + 360) % 360, 'Rotate')))),
    h('div', { class: 'btnrow' },
      Button({ label: 'Flip ↔', size: 'sm', onClick: () => set('flipH', !L.flipH, 'Flip layer') }),
      Button({ label: 'Flip ↕', size: 'sm', onClick: () => set('flipV', !L.flipV, 'Flip layer') }),
      Button({ icon: 'copy', size: 'sm', tip: 'Duplicate layer (Ctrl+J)', onClick: () => S.duplicateLayer(L) }),
      L.type !== 'raster' ? Button({ label: 'Rasterize', size: 'sm', tip: 'Turn into pixels to paint on it', onClick: () => S.rasterize(L) }) : null,
      h('span', { style: { flex: 1 } }),
      Button({ icon: 'trash', size: 'sm', variant: 'danger', tip: 'Delete layer', onClick: () => S.removeLayer(L) })))
  const specific = L.type === 'text' ? textProps(S, L) : L.type === 'shape' ? shapeProps(S, L) : rasterProps(S, L)
  return [name, specific, common]
}

function textProps(S, L) {
  const set = (k, v, label) => S.setProp(L, k, v, label)
  const ta = h('textarea', { class: 'textarea st-textarea', rows: '3' })
  ta.value = L.text
  ta.addEventListener('input', () => { L.text = ta.value; fitText(L, 'tl'); S.redraw() })
  ta.addEventListener('change', () => S.commit('Edit text'))
  ta.addEventListener('keydown', (e) => e.stopPropagation())
  const sub = (k, patch, label) => set(k, { ...(L[k] ?? {}), ...patch }, label)
  return h('div', { class: 'st-secs' },
    h('details', { class: 'st-sec', open: true }, h('summary', {}, 'Text'),
      ta,
      row('Font', Select(STUDIO_FONTS, L.font, (v) => set('font', v, 'Font'))),
      row('Size', num(L.size, (v) => set('size', v, 'Font size'), { min: 2, max: 2000 })),
      row('Weight', Seg([['400', 'Regular'], ['600', 'Semi'], ['800', 'Bold'], ['900', 'Black']], String(L.weight), (v) => set('weight', +v, 'Font weight'), { block: true })),
      h('div', { class: 'btnrow' },
        Button({ label: 'Italic', size: 'sm', variant: L.italic ? 'primary' : undefined, onClick: () => { set('italic', !L.italic, 'Italic'); S.refresh() } }),
        Seg([['left', '', 'alignL', 'Left'], ['center', '', 'alignC', 'Centre'], ['right', '', 'alignR', 'Right']], L.align, (v) => set('align', v, 'Align'))),
      row('Colour', color(L.color, (v) => { L.color = v; S.redraw() }, () => S.commit('Text colour'))),
      row('Spacing', slide(L.spacing ?? 0, { min: -10, max: 80 }, (v, done) => { L.spacing = v; fitText(L, 'center'); S.redraw(); if (done) S.commit('Letter spacing') })),
      row('Line height', slide(L.lineHeight ?? 1.2, { min: 0.7, max: 3, step: 0.05, fmt: (v) => (+v).toFixed(2) }, (v, done) => { L.lineHeight = v; fitText(L, 'center'); S.redraw(); if (done) S.commit('Line height') })),
      Button({ label: 'Edit on canvas', icon: 'pencil', size: 'sm', onClick: () => S.editText(L) })),
    h('details', { class: 'st-sec', open: !!(L.outline || L.shadow || L.bg) }, h('summary', {}, 'Effects'),
      Switch('Outline', !!L.outline, (v) => { set('outline', v ? { width: 4, color: '#ffffff' } : null, 'Outline'); S.refresh() }),
      L.outline ? h('div', { class: 'st-subgrp' },
        row('Width', slide(L.outline.width, { min: 0.5, max: 40, step: 0.5 }, (v, done) => { L.outline = { ...L.outline, width: v }; S.redraw(); if (done) S.commit('Outline') })),
        row('Colour', color(L.outline.color, (v) => { L.outline = { ...L.outline, color: v }; S.redraw() }, () => S.commit('Outline')))) : null,
      Switch('Shadow', !!L.shadow, (v) => { set('shadow', v ? { opacity: 55, blur: 14, dx: 6, dy: 8, color: '#000000' } : null, 'Shadow'); S.refresh() }),
      L.shadow ? h('div', { class: 'st-subgrp' },
        row('Strength', slide(L.shadow.opacity, { min: 5, max: 100 }, (v, done) => { L.shadow = { ...L.shadow, opacity: v }; S.redraw(); if (done) S.commit('Shadow') })),
        row('Blur', slide(L.shadow.blur, { min: 0, max: 80 }, (v, done) => { L.shadow = { ...L.shadow, blur: v }; S.redraw(); if (done) S.commit('Shadow') })),
        row('Distance', slide(L.shadow.dy, { min: -60, max: 60 }, (v, done) => { L.shadow = { ...L.shadow, dx: Math.round(v * 0.75), dy: v }; S.redraw(); if (done) S.commit('Shadow') })),
        row('Colour', color(L.shadow.color, (v) => { L.shadow = { ...L.shadow, color: v }; S.redraw() }, () => S.commit('Shadow')))) : null,
      row('Background', Swatches(L.bg ?? null, (v) => { set('bg', v, 'Text background'); S.refresh() }, { allowNone: true, colors: ['#ffffff', '#111111', '#facc15', '#ef4444', '#3b82f6'] }))))
}

function shapeProps(S, L) {
  const set = (k, v, label) => S.setProp(L, k, v, label)
  const line = L.kind === 'line'
  return h('details', { class: 'st-sec', open: true }, h('summary', {}, SHAPE_NAMES[L.kind] ?? 'Shape'),
    row('Shape', Select(Object.entries(SHAPE_NAMES), L.kind, (v) => { set('kind', v, 'Change shape'); if (v === 'line') { L.stroke ??= L.fill ?? '#111111'; L.strokeW ||= 6 } S.refresh() })),
    line ? null : row('Fill', h('div', { class: 'row', style: { gap: '6px' } },
      color(L.fill ?? '#3b82f6', (v) => { L.fill = v; S.redraw() }, () => S.commit('Fill colour')),
      Button({ label: L.fill ? 'No fill' : 'Add fill', size: 'sm', onClick: () => { set('fill', L.fill ? null : '#3b82f6', 'Fill'); S.refresh() } }))),
    line || !L.fill ? null : Switch('Gradient fill', !!L.fill2, (v) => { set('fill2', v ? '#9333ea' : null, 'Gradient'); S.refresh() }),
    L.fill2 && !line ? h('div', { class: 'st-subgrp' },
      row('End colour', color(L.fill2, (v) => { L.fill2 = v; S.redraw() }, () => S.commit('Gradient'))),
      row('Angle', slide(L.gradAngle ?? 90, { min: 0, max: 360, fmt: (v) => `${v}°` }, (v, done) => { L.gradAngle = v; S.redraw(); if (done) S.commit('Gradient') }))) : null,
    row(line ? 'Colour' : 'Outline', h('div', { class: 'row', style: { gap: '6px' } },
      color(L.stroke ?? '#111111', (v) => { L.stroke = v; if (!L.strokeW) L.strokeW = 4; S.redraw() }, () => S.commit('Outline colour')),
      line ? null : Button({ label: L.stroke ? 'None' : 'Add', size: 'sm', onClick: () => { if (L.stroke) { L.stroke = null; L.strokeW = 0 } else { L.stroke = '#111111'; L.strokeW = 4 } S.commit('Outline'); S.refresh() } }))),
    L.stroke || line ? row('Thickness', slide(L.strokeW || 4, { min: 1, max: 80 }, (v, done) => { L.strokeW = v; S.redraw(); if (done) S.commit('Outline width') })) : null,
    L.kind === 'rect' ? row('Corners', slide(L.radius ?? 0, { min: 0, max: 100, fmt: (v) => `${v}%` }, (v, done) => { L.radius = v; S.redraw(); if (done) S.commit('Corner radius') })) : null,
    L.kind === 'star' || L.kind === 'polygon' ? row(L.kind === 'star' ? 'Points' : 'Sides', slide(L.sides, { min: 3, max: 24 }, (v, done) => { L.sides = v; S.redraw(); if (done) S.commit('Sides') })) : null,
    L.kind === 'star' ? row('Depth', slide(Math.round((1 - L.inner) * 100), { min: 5, max: 95, fmt: (v) => `${v}%` }, (v, done) => { L.inner = 1 - v / 100; S.redraw(); if (done) S.commit('Star depth') })) : null)
}

const stThumbCache = new WeakMap()
function stPresetThumbs(L) {
  const hit = stThumbCache.get(L.canvas)
  if (hit) return hit
  const k = 64 / Math.max(L.canvas.width, L.canvas.height)
  const c = makeCanvas(Math.max(1, L.canvas.width * k), Math.max(1, L.canvas.height * k))
  c.getContext('2d').drawImage(L.canvas, 0, 0, c.width, c.height)
  const small = { rgba: pixelsOf(c), w: c.width, h: c.height }
  const out = {}
  for (const [id, fx] of Object.entries(PRESETS)) {
    const r = processImage(small, {}, fx)
    const t = makeCanvas(r.w, r.h)
    t.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0)
    out[id] = t.toDataURL()
  }
  stThumbCache.set(L.canvas, out)
  return out
}

function rasterProps(S, L) {
  const fx = L.fx ?? {}
  const setFx = (patch, done, label = 'Adjust') => {
    const next = { ...(L.fx ?? {}), ...patch }
    for (const k of Object.keys(next)) if (next[k] === 0 || next[k] === null || next[k] === undefined) delete next[k]
    L.fx = Object.keys(next).length ? next : null
    S.redraw()
    if (done) S.commit(label)
  }
  const slider = (k, label, min = 0, max = 100) => row(label, slide(fx[k] ?? 0, { min, max, fmt: (v) => (min < 0 && v > 0 ? `+${v}` : String(v)) }, (v, done) => setFx({ [k]: v }, done)))
  const thumbs = Math.max(L.canvas.width, L.canvas.height) ? stPresetThumbs(L) : null
  const bg = fx.removeBg
  return h('div', { class: 'st-secs' },
    h('details', { class: 'st-sec', open: true }, h('summary', {}, 'Filters'),
      h('div', { class: 'st-presets' }, Object.keys(PRESETS).map((id) => h('button', {
        type: 'button', class: 'st-preset' + ((L.preset ?? 'none') === id ? ' on' : ''),
        onclick: () => {
          const keep = { removeBg: fx.removeBg, radius: fx.radius, border: fx.border, shadow: fx.shadow }
          L.fx = null
          L.preset = id === 'none' ? undefined : id
          setFx({ ...PRESETS[id], ...keep }, true, 'Filter')
        },
      }, thumbs ? h('img', { src: thumbs[id], alt: '' }) : null, h('span', {}, PRESET_LABELS[id]))))),
    h('details', { class: 'st-sec', open: FX_ADJUST.some(([k]) => fx[k]) }, h('summary', {}, 'Adjust'),
      FX_ADJUST.map(([k, l, a, b]) => slider(k, l, a, b)),
      FX_EFFECTS.map(([k, l]) => slider(k, l))),
    h('details', { class: 'st-sec', open: !!(bg || fx.radius || fx.border || fx.shadow) }, h('summary', {}, 'Cut-out & frame'),
      Switch('Remove background', !!bg, (v) => {
        setFx({ removeBg: v ? { color: guessBackground(pixelsOf(L.canvas), L.canvas.width, L.canvas.height), tolerance: 25, feather: 20, contiguous: true } : null }, true, 'Remove background')
        S.refresh()
      }, { hint: 'Best on plain backgrounds' }),
      bg ? h('div', { class: 'st-subgrp' },
        row('Strength', slide(bg.tolerance, { min: 1, max: 100 }, (v, done) => setFx({ removeBg: { ...bg, tolerance: v } }, done, 'Remove background'))),
        row('Soft edge', slide(bg.feather, { min: 0, max: 100 }, (v, done) => setFx({ removeBg: { ...bg, feather: v } }, done, 'Remove background'))),
        Switch('Only the outer background', bg.contiguous !== false, (v) => setFx({ removeBg: { ...bg, contiguous: v } }, true, 'Remove background'))) : null,
      slider('radius', 'Corners'),
      row('Border', slide(fx.border?.width ?? 0, { min: 0, max: 100 }, (v, done) => setFx({ border: v ? { color: '#ffffff', ...(fx.border ?? {}), width: v } : null }, done, 'Border'))),
      fx.border ? row('Border colour', color(fx.border.color ?? '#ffffff', (c) => setFx({ border: { ...fx.border, color: c } }, false), () => S.commit('Border'))) : null,
      Switch('Drop shadow', !!fx.shadow, (v) => { setFx({ shadow: v ? { blur: 30, dx: 20, dy: 25, opacity: 45, color: '#000000' } : null }, true, 'Shadow'); S.refresh() })),
    L.fx ? h('div', { class: 'btnrow' },
      Button({ label: 'Reset', icon: 'undo', size: 'sm', onClick: () => { L.fx = null; delete L.preset; S.commit('Reset adjustments') } }),
      Button({ label: 'Apply to pixels', size: 'sm', tip: 'Bake the adjustments in (needed before painting with them)', onClick: () => S.applyFx(L) })) : null,
    h('details', { class: 'st-sec' }, h('summary', {}, 'Effects (permanent)'),
      h('div', { class: 'st-filters' }, Object.entries(FILTERS).map(([id, [label]]) => Button({ label, size: 'sm', onClick: () => S.applyFilter(id) }))),
      h('div', { class: 'tip' }, 'Applied to the selection if there is one, otherwise the whole layer. Undo with Ctrl+Z.')))
}

// ---------- layers ----------
function layerThumb(S, L) {
  const c = makeCanvas(44, 44)
  const x = c.getContext('2d')
  const k = Math.min(44 / S.doc.w, 44 / S.doc.h)
  x.translate((44 - S.doc.w * k) / 2, (44 - S.doc.h * k) / 2)
  x.scale(k, k)
  try { drawLayerContent(x, L, { fast: true }) } catch { /* thumbnail only */ }
  return c
}
function layersList(S) {
  const list = S.doc.layers
  const n = list.length
  const rows = list.slice().reverse().map((L) => {
    const nm = h('span', { class: 'st-lnm', title: 'Double-click to rename' }, L.name)
    nm.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      const inp = h('input', { class: 'input', value: L.name })
      inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = L.name; inp.blur() } })
      inp.addEventListener('blur', () => { if (inp.value.trim() && inp.value !== L.name) S.setProp(L, 'name', inp.value.trim(), 'Rename layer'); else S.refresh() })
      nm.replaceWith(inp)
      inp.focus()
      inp.select()
    })
    const tog = (key, on, off, tip) => h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm' + (L[key] ? ' on' : ''), 'aria-label': tip, 'data-tip': tip,
      onclick: (e) => { e.stopPropagation(); S.setProp(L, key, !L[key], key === 'hidden' ? 'Visibility' : 'Lock'); S.refresh() },
    }, icon(L[key] ? on : off, 'icon-sm'))
    return h('div', {
      class: 'st-layer' + (L.id === S.activeId ? ' on' : '') + (L.hidden ? ' off' : ''), role: 'button', tabindex: '0', 'data-id': L.id,
      onclick: () => S.setActive(L.id),
    },
    tog('hidden', 'eyeOff', 'eye', L.hidden ? 'Show' : 'Hide'),
    h('span', { class: 'st-thumb' }, layerThumb(S, L)),
    h('span', { class: 'st-linfo' }, nm, h('small', {}, icon(LAYER_ICONS[L.type], 'icon-xs'), `${Math.round(L.opacity * 100)}%${L.blend && L.blend !== 'normal' ? ` · ${L.blend}` : ''}${L.fx ? ' · fx' : ''}`)),
    tog('locked', 'lock', 'unlock', L.locked ? 'Unlock' : 'Lock'))
  })
  const box = h('div', { class: 'st-layers' }, rows)
  sortable(box, '.st-layer', (from, to) => S.moveLayer(list[n - 1 - from], n - 1 - to), { horizontal: false })
  return [
    box,
    h('div', { class: 'st-lfoot' },
      Button({ icon: 'plus', size: 'sm', tip: 'New layer', onClick: () => S.addRaster() }),
      Button({ icon: 'type', size: 'sm', tip: 'Add text', onClick: () => S.setTool('text') }),
      Button({ icon: 'shapes', size: 'sm', tip: 'Add shape', onClick: () => S.setTool('shape') }),
      Button({ icon: 'image', size: 'sm', tip: 'Place image', onClick: () => S.placeImage() }),
      Button({ icon: 'copy', size: 'sm', tip: 'Duplicate', onClick: () => S.duplicateLayer() }),
      Button({ icon: 'down', size: 'sm', tip: 'Merge down (Ctrl+E)', onClick: () => S.mergeDown() }),
      Button({ icon: 'more', size: 'sm', tip: 'More', onClick: (e) => menu(e.currentTarget, [
        { label: 'Copy selection to new layer', onClick: () => S.layerFromSel(false) },
        { label: 'Cut selection to new layer', onClick: () => S.layerFromSel(true) },
        { label: 'Select layer pixels', onClick: () => S.selectLayerPixels() },
        { label: 'Rasterize layer', onClick: () => S.rasterize() },
        { label: 'Flatten image', onClick: () => S.flattenAll() },
      ], { align: 'right' }) }),
      h('span', { style: { flex: 1 } }),
      Button({ icon: 'trash', size: 'sm', variant: 'danger', tip: 'Delete layer', onClick: () => S.removeLayer() })),
  ]
}

function historyList(S) {
  return h('div', { class: 'st-history' }, S.states.map((s, i) => h('button', {
    type: 'button', class: 'st-hist' + (i === S.idx ? ' on' : '') + (i > S.idx ? ' future' : ''), onclick: () => S.jump(i),
  }, icon(i === 0 ? 'file' : 'history', 'icon-sm'), s.label)).reverse())
}

// ---------- start screen ----------
export function studioHome(S) {
  let cw = 1080, ch = 1080, bg = '#ffffff'
  const tplGrid = h('div', { class: 'st-tpls' })
  TEMPLATES.forEach(([name, w, hh], i) => {
    const btn = h('button', { type: 'button', class: 'st-tpl', onclick: () => S.fromTemplate(i) }, h('span', { class: 'st-tplimg', style: { aspectRatio: `${w} / ${hh}` } }), h('b', {}, name), h('small', {}, `${w} × ${hh}`))
    tplGrid.append(btn)
    setTimeout(() => { // draw previews after first paint
      try {
        const d = documentFromTemplate(i)
        const c = flatten(d, { scale: 220 / Math.max(w, hh) })
        btn.firstChild.replaceChildren(c)
      } catch (e) { console.warn('template preview failed', e) }
    }, 30 + i * 20)
  })
  const custom = h('div', { class: 'st-custom' },
    h('div', { class: 'field-row' },
      Field('Width (px)', TextInput(String(cw), (v) => { cw = Math.round(+v) }, { type: 'number' })),
      Field('Height (px)', TextInput(String(ch), (v) => { ch = Math.round(+v) }, { type: 'number' }))),
    Field('Background', Seg([['#ffffff', 'White'], ['', 'Transparent'], ['#111111', 'Black']], bg, (v) => { bg = v }, { block: true })),
    Button({ label: 'Create', icon: 'plus', variant: 'primary', block: true, onClick: () => {
      if (!(cw >= 1 && ch >= 1) || cw * ch > 60e6) { toast('Choose a size between 1 and about 7,700 × 7,700 px', { type: 'error' }); return }
      S.newDoc(cw, ch, bg || null)
    } }))
  return h('div', { class: 'st-home' },
    h('div', { class: 'st-hero' },
      h('h1', {}, 'Design & Edit'),
      h('p', {}, 'Layers, brushes, selections, retouching, filters, text and shapes — like a photo editor, right in your browser. Open a photo or a PDF page, or start a new design. Nothing is uploaded.')),
    h('div', { class: 'st-open' },
      Dropzone({ accept: 'image/*,application/pdf,.pdsd,application/json', onFiles: ([f]) => S.openFile(f), title: 'Open a photo, a PDF page or a saved project', tc: 'var(--c-edit)', icon: 'image' })),
    h('h2', {}, 'Templates'),
    tplGrid,
    h('h2', {}, 'Blank canvas'),
    h('div', { class: 'st-sizes' },
      SIZE_PRESETS.map(([name, w, hh]) => h('button', { type: 'button', class: 'st-size', onclick: () => S.newDoc(w, hh, '#ffffff') },
        h('span', { class: 'st-sizebox' }, h('i', { style: { aspectRatio: `${w} / ${hh}`, [w >= hh ? 'width' : 'height']: '100%' } })),
        h('b', {}, name), h('small', {}, `${w} × ${hh}`))),
      h('div', { class: 'st-size custom' }, h('b', {}, 'Custom size'), custom)))
}
