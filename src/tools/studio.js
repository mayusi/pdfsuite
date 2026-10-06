// Design & Edit — a layered image & design editor (think Pixlr) that also
// opens PDF pages and exports PDFs. Raster layers you paint on, text and
// shape layers you can restyle forever, selections, retouch tools, filters,
// templates, history. Everything runs locally on <canvas>.
import { h, icon, setKids, saveBlob, stem } from '../ui/dom.js'
import { Button, Seg, Range, Switch, TextInput, Field, toast, modal, menu, confirmDialog, pickFiles } from '../ui/kit.js'
import { openPdf, takeHandoff, friendly } from '../ui/tool.js'
import { renderPage } from '../pdf/render.js'
import { imagesToPdf } from '../pdf/ops.js'
import {
  newDocument, rasterLayer, textLayer, shapeLayer, makeCanvas, dupCanvas, pixelsOf, canvasFromRGBA, composite, flatten, layerToCanvas,
  layerCorners, hitLayer, isCanvasAligned, snapshotDoc, restoreDoc, historyBytes, saveProject, loadProject, fitText, textFont, newLayerId,
  documentFromTemplate, rasterSource,
} from '../studio/doc.js'
import { beginStroke, strokeTo, bucketFill, gradientFill, maskCanvas } from '../studio/paint.js'
import {
  maskRect, maskEllipse, maskPolygon, maskCombine, maskInvert, maskBounds, maskFeather, maskGrow, maskOutline, maskEmpty, floodMask,
  blendMasked, clearMasked, FILTERS,
} from '../studio/raster.js'
import { studioPanels, studioHome } from '../studio/panels.js'

export const STUDIO_TOOLS = [
  ['move', 'move', 'V', 'Move & transform'], ['marquee', 'marquee', 'M', 'Select area'], ['lasso', 'lasso', 'L', 'Lasso'], ['wand', 'wand', 'W', 'Magic wand'], ['crop', 'crop', 'C', 'Crop'], '|',
  ['brush', 'brush', 'B', 'Brush'], ['eraser', 'eraser', 'E', 'Eraser'], ['bucket', 'bucket', 'K', 'Fill'], ['gradient', 'gradient', 'G', 'Gradient'],
  ['clone', 'stamp2', 'S', 'Clone stamp'], ['retouch', 'retouch', 'R', 'Retouch: blur, sharpen, smudge, dodge, burn'], '|',
  ['text', 'type', 'T', 'Text'], ['shape', 'shapes', 'U', 'Shapes'], ['eyedropper', 'pipette', 'I', 'Colour picker'], ['hand', 'hand', 'H', 'Pan'],
]
const PAINT_TOOLS = new Set(['brush', 'eraser', 'clone', 'retouch', 'bucket', 'gradient'])
const HISTORY_MAX = 60
const HISTORY_BYTES = 900 * 1024 * 1024

export function Studio() {
  const root = h('div', { class: 'st-root' })
  const S = {
    doc: null, activeId: null, tool: 'move', fg: '#111111', bg: '#ffffff', zoom: 1, panX: 0, panY: 0, name: 'design',
    states: [], idx: -1, dirty: false, editingText: null,
    opts: {
      brush: { size: 24, hardness: 0.75, opacity: 1, pressure: true },
      eraser: { size: 40, hardness: 0.8, opacity: 1, pressure: true },
      clone: { size: 40, hardness: 0.6, opacity: 1, pressure: false, from: null, setting: false },
      retouch: { mode: 'blur', size: 50, hardness: 0.4, strength: 0.5, pressure: false },
      bucket: { tolerance: 32, contiguous: true, sampleAll: false, opacity: 1 },
      gradient: { type: 'linear', transparent: false, opacity: 1 },
      select: { mode: 'replace', feather: 0 },
      marquee: { shape: 'rect' },
      lasso: { kind: 'free' },
      wand: { tolerance: 32, contiguous: true, sampleAll: false },
      move: { auto: true },
      shape: { kind: 'rect', fill: '#3b82f6', stroke: null, strokeW: 0 },
      text: { font: 'Inter, system-ui, sans-serif', size: 96, weight: 800, color: null },
      crop: { ratio: null },
    },
  }
  let els = {}
  let raf = 0
  let antsT = 0
  let antsPhase = 0
  let gesture = null // current pointer interaction
  const pointers = new Map()
  let pinch = null
  let spaceDown = false
  let cropRect = null
  let lassoPts = null
  let hover = null // doc point under the pointer (brush cursor)
  let guide = null // gradient line / shape preview in progress

  // ---------- state helpers ----------
  S.active = () => S.doc?.layers.find((L) => L.id === S.activeId) ?? null
  S.setActive = (id) => { S.activeId = id; S.refresh(); S.redraw() }
  S.redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw() }) }
  S.refresh = () => { if (els.panel) studioPanels(S, els.panel); updateChrome() }
  S.commit = (label) => {
    S.states = S.states.slice(0, S.idx + 1)
    S.states.push({ label, snap: snapshotDoc(S.doc), active: S.activeId })
    while (S.states.length > HISTORY_MAX || (S.states.length > 2 && historyBytes(S.states.map((s) => s.snap)) > HISTORY_BYTES)) S.states.shift()
    S.idx = S.states.length - 1
    S.dirty = true
    S.refresh()
    S.redraw()
  }
  S.jump = (i) => {
    if (i < 0 || i >= S.states.length || i === S.idx) return
    closeTextEditor(false)
    S.idx = i
    restoreDoc(S.doc, S.states[i].snap)
    S.activeId = S.states[i].active && S.doc.layers.some((L) => L.id === S.states[i].active) ? S.states[i].active : S.doc.layers.at(-1)?.id
    cropRect = null
    lassoPts = null
    fitStage()
    S.refresh()
    S.redraw()
  }
  S.undo = () => S.jump(S.idx - 1)
  S.redo = () => S.jump(S.idx + 1)

  S.setDoc = (doc, name = S.name) => {
    S.doc = doc
    S.name = name
    S.activeId = doc.layers.at(-1)?.id
    S.states = [{ label: 'Open', snap: snapshotDoc(doc), active: S.activeId }]
    S.idx = 0
    S.dirty = false
    cropRect = null
    build()
    requestAnimationFrame(() => { S.fit(); S.redraw() })
  }

  // ---------- layers ----------
  const indexOf = (L) => S.doc.layers.indexOf(L)
  S.insertLayer = (L, { above = S.active(), label = 'New layer' } = {}) => {
    const i = above ? indexOf(above) + 1 : S.doc.layers.length
    S.doc.layers.splice(i, 0, L)
    S.activeId = L.id
    if (label) S.commit(label)
    return L
  }
  S.addRaster = () => S.insertLayer(rasterLayer(`Layer ${S.doc.layers.length + 1}`, makeCanvas(S.doc.w, S.doc.h)))
  S.duplicateLayer = (L = S.active()) => {
    if (!L) return
    const c = { ...L, id: newLayerId(), name: `${L.name} copy`, outline: L.outline && { ...L.outline }, shadow: L.shadow && { ...L.shadow }, fx: L.fx && JSON.parse(JSON.stringify(L.fx)) }
    S.insertLayer(c, { above: L, label: 'Duplicate layer' })
  }
  S.removeLayer = (L = S.active()) => {
    if (!L) return
    if (S.doc.layers.length === 1) { toast('A design needs at least one layer', { type: 'info' }); return }
    const i = indexOf(L)
    S.doc.layers.splice(i, 1)
    S.activeId = (S.doc.layers[i - 1] ?? S.doc.layers[0]).id
    S.commit('Delete layer')
  }
  S.moveLayer = (L, toIndex) => {
    const list = S.doc.layers.filter((x) => x !== L)
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, L)
    S.doc.layers = list
    S.commit('Reorder layers')
  }
  S.setProp = (L, key, value, label = null) => {
    L[key] = value
    if (L.type === 'text' && ['text', 'font', 'size', 'weight', 'italic', 'spacing', 'lineHeight', 'bg', 'bgPad'].includes(key)) fitText(L, 'center')
    S.redraw()
    if (label) S.commit(label)
  }
  /** Turn a text/shape layer (or a moved/rotated image) into canvas-sized pixels. */
  S.rasterize = (L = S.active(), { label = 'Rasterize layer', withFx = true } = {}) => {
    if (!L) return null
    const c = layerToCanvas(S.doc, L, { withFx })
    const R = rasterLayer(L.name, c)
    Object.assign(R, { id: L.id, opacity: L.opacity, blend: L.blend, hidden: L.hidden, locked: L.locked, fx: withFx ? null : (L.fx ?? null) })
    S.doc.layers[indexOf(L)] = R
    if (label) S.commit(label)
    return R
  }
  S.mergeDown = (L = S.active()) => {
    const i = indexOf(L)
    if (i < 1) { toast('There’s no layer below to merge into', { type: 'info' }); return }
    const below = S.doc.layers[i - 1]
    const c = makeCanvas(S.doc.w, S.doc.h)
    composite(c.getContext('2d'), { w: S.doc.w, h: S.doc.h, layers: [{ ...below, hidden: false }, L] })
    const R = rasterLayer(below.name, c)
    R.id = below.id
    S.doc.layers.splice(i - 1, 2, R)
    S.activeId = R.id
    S.commit('Merge down')
  }
  S.flattenAll = () => {
    const c = flatten(S.doc)
    S.doc.layers = [rasterLayer('Background', c)]
    S.activeId = S.doc.layers[0].id
    S.commit('Flatten image')
  }
  /** Make sure the active layer can be painted: raster, unlocked, visible and on the canvas grid. */
  S.paintTarget = (verb = 'paint on') => {
    let L = S.active()
    if (!L) { toast('Add a layer first', { type: 'info' }); return null }
    if (L.locked) { toast(`“${L.name}” is locked — unlock it in Layers to ${verb} it`, { type: 'info' }); return null }
    if (L.hidden) { toast(`“${L.name}” is hidden — show it to ${verb} it`, { type: 'info' }); return null }
    if (L.type !== 'raster') { L = S.rasterize(L, { label: null }); toast(`${L.name} was turned into pixels so you can ${verb} it`, { type: 'info', timeout: 2500 }) } else if (!isCanvasAligned(S.doc, L)) L = S.rasterize(L, { label: null, withFx: false })
    return L
  }
  S.mergedPixels = () => pixelsOf(flatten(S.doc))

  // ---------- selection ----------
  S.setSel = (m, label = 'Select') => { S.doc.sel = !m || maskEmpty(m) ? null : m; S.commit(S.doc.sel ? label : 'Deselect') }
  S.selectAll = () => S.setSel(maskRect(S.doc.w, S.doc.h, 0, 0, S.doc.w, S.doc.h), 'Select all')
  S.deselect = () => { if (S.doc.sel) S.setSel(null) }
  S.invertSel = () => S.setSel(S.doc.sel ? maskInvert(S.doc.sel) : maskRect(S.doc.w, S.doc.h, 0, 0, S.doc.w, S.doc.h), 'Invert selection')
  S.featherSel = (r) => { if (S.doc.sel) S.setSel(maskFeather(S.doc.sel, S.doc.w, S.doc.h, r), 'Feather') }
  S.growSel = (r) => { if (S.doc.sel) S.setSel(maskGrow(S.doc.sel, S.doc.w, S.doc.h, r), r > 0 ? 'Expand selection' : 'Contract selection') }
  S.selectLayerPixels = (L = S.active()) => {
    if (!L) return
    const px = pixelsOf(layerToCanvas(S.doc, L))
    const m = new Uint8Array(S.doc.w * S.doc.h)
    for (let p = 0; p < m.length; p++) m[p] = px[p * 4 + 3]
    S.setSel(m, 'Select layer pixels')
  }
  const needSel = () => { if (!S.doc.sel) { toast('Select an area first (marquee, lasso or magic wand)', { type: 'info' }); return false } return true }
  S.clearSel = () => {
    if (!needSel()) return
    const L = S.paintTarget('erase')
    if (!L) return
    const d = new Uint8ClampedArray(pixelsOf(L.canvas))
    clearMasked(d, S.doc.sel)
    L.canvas = canvasFromRGBA(d, S.doc.w, S.doc.h)
    S.commit('Delete pixels')
  }
  S.fillSel = (color = S.fg) => {
    if (!needSel()) return
    const L = S.paintTarget('fill')
    if (!L) return
    const t = makeCanvas(S.doc.w, S.doc.h)
    const x = t.getContext('2d')
    x.fillStyle = color
    x.fillRect(0, 0, t.width, t.height)
    x.globalCompositeOperation = 'destination-in'
    x.drawImage(maskCanvas(S.doc.sel, S.doc.w, S.doc.h), 0, 0)
    const work = dupCanvas(L.canvas)
    work.getContext('2d').drawImage(t, 0, 0)
    L.canvas = work
    S.commit('Fill selection')
  }
  S.strokeSel = (width = 6, color = S.fg) => {
    if (!needSel()) return
    const L = S.paintTarget('outline')
    if (!L) return
    const segs = maskOutline(S.doc.sel, S.doc.w, S.doc.h)
    const work = dupCanvas(L.canvas)
    const x = work.getContext('2d')
    x.strokeStyle = color
    x.lineWidth = width
    x.lineCap = 'square'
    x.beginPath()
    for (let i = 0; i < segs.length; i += 4) { x.moveTo(segs[i], segs[i + 1]); x.lineTo(segs[i + 2], segs[i + 3]) }
    x.stroke()
    L.canvas = work
    S.commit('Outline selection')
  }
  /** Copy (or cut) the selected pixels of the active layer into a new layer. */
  S.layerFromSel = (cut = false) => {
    if (!needSel()) return
    const L = S.paintTarget(cut ? 'cut from' : 'copy from')
    if (!L) return
    const c = dupCanvas(L.canvas)
    const x = c.getContext('2d')
    x.globalCompositeOperation = 'destination-in'
    x.drawImage(maskCanvas(S.doc.sel, S.doc.w, S.doc.h), 0, 0)
    if (cut) {
      const d = new Uint8ClampedArray(pixelsOf(L.canvas))
      clearMasked(d, S.doc.sel)
      L.canvas = canvasFromRGBA(d, S.doc.w, S.doc.h)
    }
    const R = rasterLayer(`${L.name} ${cut ? 'cut' : 'copy'}`, c)
    S.doc.sel = null
    S.insertLayer(R, { above: L, label: cut ? 'Cut to new layer' : 'Copy to new layer' })
  }

  // ---------- adjustments / filters ----------
  S.applyFilter = (id, amount) => {
    const L = S.paintTarget('filter')
    if (!L) return
    const src = pixelsOf(L.canvas)
    let out = FILTERS[id][1](src, S.doc.w, S.doc.h, amount)
    if (S.doc.sel) out = blendMasked(new Uint8ClampedArray(src), out, S.doc.sel)
    L.canvas = canvasFromRGBA(out, S.doc.w, S.doc.h)
    S.commit(FILTERS[id][0])
  }
  /** Bake a raster layer's live adjustments into its pixels. */
  S.applyFx = (L = S.active()) => {
    if (!L?.fx) return
    S.rasterize(L, { label: 'Apply adjustments', withFx: true })
  }

  // ---------- canvas-wide operations ----------
  /** Transform every layer by a document-space function (canvas resize / rotate / flip / scale). */
  function transformDoc(nw, nh, mapRaster, mapBox, label) {
    const ow = S.doc.w, oh = S.doc.h
    S.doc.layers = S.doc.layers.map((L) => {
      if (L.type === 'raster' && isCanvasAligned(S.doc, L)) {
        const c = makeCanvas(nw, nh)
        const x = c.getContext('2d')
        x.imageSmoothingQuality = 'high'
        mapRaster(x, L.canvas, ow, oh)
        return { ...L, canvas: c, w: nw, h: nh, x: 0, y: 0 }
      }
      return mapBox({ ...L }, ow, oh)
    })
    S.doc.w = nw
    S.doc.h = nh
    S.doc.sel = null
    cropRect = null
    S.commit(label)
    S.fit()
  }
  S.cropTo = (r) => {
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y))
    const w = Math.min(S.doc.w - x0, Math.round(r.w)), hh = Math.min(S.doc.h - y0, Math.round(r.h))
    if (w < 2 || hh < 2) return
    transformDoc(w, hh, (x, src) => x.drawImage(src, -x0, -y0), (L) => ({ ...L, x: L.x - x0, y: L.y - y0 }), 'Crop')
  }
  S.cropToSel = () => { if (needSel()) { const b = maskBounds(S.doc.sel, S.doc.w, S.doc.h); if (b) S.cropTo(b) } }
  S.canvasSize = (nw, nh, anchor = 'c') => {
    const dx = anchor.includes('l') ? 0 : anchor.includes('r') ? nw - S.doc.w : (nw - S.doc.w) / 2
    const dy = anchor.includes('t') ? 0 : anchor.includes('b') ? nh - S.doc.h : (nh - S.doc.h) / 2
    transformDoc(nw, nh, (x, src) => x.drawImage(src, dx, dy), (L) => ({ ...L, x: L.x + dx, y: L.y + dy }), 'Canvas size')
  }
  S.imageSize = (nw, nh) => {
    const kx = nw / S.doc.w, ky = nh / S.doc.h
    transformDoc(nw, nh, (x, src) => x.drawImage(src, 0, 0, nw, nh), (L) => {
      const o = { ...L, x: L.x * kx, y: L.y * ky, w: L.w * kx, h: L.h * ky }
      if (o.type === 'text') o.size = L.size * Math.min(kx, ky)
      return o
    }, 'Image size')
  }
  S.rotateCanvas = (cw) => {
    const ow = S.doc.w, oh = S.doc.h
    transformDoc(oh, ow, (x, src) => {
      if (cw) { x.translate(oh, 0); x.rotate(Math.PI / 2) } else { x.translate(0, ow); x.rotate(-Math.PI / 2) }
      x.drawImage(src, 0, 0)
    }, (L) => {
      const cx = L.x + L.w / 2, cy = L.y + L.h / 2
      const [nx, ny] = cw ? [oh - cy, cx] : [cy, ow - cx]
      return { ...L, x: nx - L.w / 2, y: ny - L.h / 2, rot: ((L.rot + (cw ? 90 : -90)) % 360 + 360) % 360 }
    }, cw ? 'Rotate canvas right' : 'Rotate canvas left')
  }
  S.flipCanvas = (horiz) => {
    const W = S.doc.w, H = S.doc.h
    transformDoc(W, H, (x, src) => {
      if (horiz) { x.translate(W, 0); x.scale(-1, 1) } else { x.translate(0, H); x.scale(1, -1) }
      x.drawImage(src, 0, 0)
    }, (L) => (horiz
      ? { ...L, x: W - L.x - L.w, flipH: !L.flipH, rot: (360 - L.rot) % 360 }
      : { ...L, y: H - L.y - L.h, flipV: !L.flipV, rot: (360 - L.rot) % 360 }), horiz ? 'Flip canvas horizontally' : 'Flip canvas vertically')
  }
  S.trimTransparent = () => {
    const px = S.mergedPixels()
    const m = new Uint8Array(S.doc.w * S.doc.h)
    for (let p = 0; p < m.length; p++) m[p] = px[p * 4 + 3] > 8 ? 255 : 0
    const b = maskBounds(m, S.doc.w, S.doc.h)
    if (!b) { toast('Nothing to trim — the canvas is empty', { type: 'info' }); return }
    S.cropTo(b)
  }

  // ---------- opening / placing ----------
  async function fileToCanvas(f, max = 4096) {
    const bmp = await createImageBitmap(f)
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const c = makeCanvas(bmp.width * k, bmp.height * k)
    const x = c.getContext('2d')
    x.imageSmoothingQuality = 'high'
    x.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close?.()
    return c
  }
  S.placeCanvas = (c, name = 'Image') => {
    const k = Math.min(1, (S.doc.w * 0.8) / c.width, (S.doc.h * 0.8) / c.height)
    const w = c.width * k, hh = c.height * k
    S.insertLayer(rasterLayer(name, c, (S.doc.w - w) / 2, (S.doc.h - hh) / 2, w, hh), { label: 'Place image' })
    S.setTool('move')
  }
  S.placeImage = async (f) => {
    if (!f) [f] = await pickFiles({ accept: 'image/*' })
    if (!f) return
    try { S.placeCanvas(await fileToCanvas(f), stem(f.name)) } catch { toast('Couldn’t read that image', { type: 'error' }) }
  }
  async function pickPdfPage(info) {
    const n = info.leaves.length
    if (n === 1) return { page: 0, dpi: 150 }
    return new Promise((resolve) => {
      let dpi = 150
      const grid = h('div', { class: 'st-pagepick' })
      const cache = new Map()
      const m = modal({
        title: 'Choose a page', wide: true,
        body: [h('div', { class: 'tip' }, 'Pick the page to open as an editable design.'), Field('Resolution', Seg([['96', 'Screen'], ['150', 'Standard'], ['300', 'Print']], '150', (v) => { dpi = +v }, { block: true })), grid],
        onClose: () => resolve(null),
        actions: [{ label: 'Cancel' }],
      })
      info.leaves.slice(0, 200).forEach((leaf, i) => {
        const b = h('button', { type: 'button', class: 'st-pp', onclick: () => { resolve({ page: i, dpi }); m.close() } }, h('span', { class: 'ph' }), `${i + 1}`)
        grid.append(b)
        renderPage(info.doc, leaf, { width: 150, cache }).then((cv) => { b.firstChild.replaceWith(cv) }).catch(() => {})
      })
    })
  }
  S.openPdfFile = async (f, pageIndex = null, dpi = 150) => {
    try {
      const info = await openPdf(f)
      if (!info) return
      let pick = pageIndex === null ? await pickPdfPage(info) : { page: pageIndex, dpi }
      if (!pick) return
      const d = info.dims[pick.page]
      const pw = d.rotate % 180 ? d.h : d.w
      const width = Math.min(Math.round((pw * pick.dpi) / 72), 5000)
      const cv = await renderPage(info.doc, info.leaves[pick.page], { width })
      const doc = newDocument(cv.width, cv.height, null)
      doc.layers[0] = rasterLayer(`Page ${pick.page + 1}`, cv)
      S.setDoc(doc, `${stem(info.name)}-p${pick.page + 1}`)
      S.pdfDpi = pick.dpi
    } catch (e) { toast(friendly(e, f.name), { type: 'error' }) }
  }
  S.openFile = async (f) => {
    if (!f) [f] = await pickFiles({ accept: 'image/*,application/pdf,.pdsd,application/json' })
    if (!f) return
    if (S.doc && S.dirty && !(await confirmLeave())) return
    try {
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) return S.openPdfFile(f)
      if (/\.pdsd$|json$/i.test(f.name) || /json/.test(f.type)) { S.setDoc(await loadProject(await f.text()), stem(f.name)); return }
      const c = await fileToCanvas(f, 6000)
      const doc = newDocument(c.width, c.height, null)
      doc.layers[0] = rasterLayer(stem(f.name), c)
      S.setDoc(doc, stem(f.name))
    } catch (e) { toast(friendly(e, f.name), { type: 'error' }) }
  }
  S.newDoc = (w, hh, bg = '#ffffff') => S.setDoc(newDocument(w, hh, bg), 'design')
  S.fromTemplate = (i) => S.setDoc(documentFromTemplate(i), 'design')

  // ---------- export ----------
  S.saveProjectFile = async () => {
    const json = await saveProject(S.doc)
    saveBlob(new Blob([json], { type: 'application/json' }), `${S.name}.pdsd`)
    S.dirty = false
    toast('Project saved — open the .pdsd file here to keep editing')
  }
  S.exportDialog = () => {
    closeTextEditor(true)
    const o = { format: 'png', scale: 1, quality: 0.92, transparent: true, dpi: S.pdfDpi ?? 150, name: S.name }
    const body = h('div', { class: 'xport' })
    const paint = () => {
      const px = `${Math.round(S.doc.w * o.scale)} × ${Math.round(S.doc.h * o.scale)} px`
      setKids(body,
        Field('Format', Seg([['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP'], ['pdf', 'PDF']], o.format, (v) => { o.format = v; paint() }, { block: true })),
        o.format === 'pdf'
          ? Field('Page size', Seg([['72', '72 dpi'], ['96', '96 dpi'], ['150', '150 dpi'], ['300', '300 dpi']], String(o.dpi), (v) => { o.dpi = +v; paint() }, { block: true }),
            { hint: `${(S.doc.w / o.dpi * 25.4).toFixed(0)} × ${(S.doc.h / o.dpi * 25.4).toFixed(0)} mm` })
          : Field('Size', Seg([['0.5', '½×'], ['1', '1×'], ['2', '2×'], ['3', '3×']], String(o.scale), (v) => { o.scale = +v; paint() }, { block: true }), { hint: px }),
        o.format === 'jpg' || o.format === 'webp' || o.format === 'pdf' ? Field('Quality', Range(Math.round(o.quality * 100), { min: 40, max: 100, fmt: (v) => `${v}%` }, (v) => { o.quality = v / 100 })) : null,
        o.format === 'png' || o.format === 'webp' ? Switch('Transparent background', o.transparent, (v) => { o.transparent = v }, { hint: 'Off fills empty areas with white' }) : null,
        Field('File name', TextInput(o.name, (v) => { o.name = v })))
    }
    paint()
    modal({ title: 'Export', body: [body], actions: [{ label: 'Cancel' }, { label: 'Export', variant: 'primary', onClick: () => { doExport(o) } }] })
  }
  async function doExport(o) {
    try {
      const name = (o.name || S.name).trim().replace(/\.(png|jpe?g|webp|pdf)$/i, '') || 'design'
      if (o.format === 'pdf') {
        const c = flatten(S.doc, { bg: '#ffffff' })
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', o.quality))
        const out = await imagesToPdf([{ jpeg: new Uint8Array(await blob.arrayBuffer()) }], { size: 'fit', dpi: o.dpi })
        saveBlob(new Blob([out], { type: 'application/pdf' }), `${name}.pdf`)
        toast(`Saved ${name}.pdf`)
      } else {
        const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[o.format]
        const c = flatten(S.doc, { scale: o.scale, bg: o.format === 'jpg' || !o.transparent ? '#ffffff' : null })
        const blob = await new Promise((r) => c.toBlob(r, mime, o.quality))
        if (!blob) throw new Error('The image is too large to encode — try a smaller size')
        saveBlob(blob, `${name}.${o.format}`)
        toast(`Saved ${name}.${o.format}`)
      }
      S.dirty = false
      S.lastExport = o.format
    } catch (e) { console.error(e); toast(`Couldn’t export: ${friendly(e)}`, { type: 'error' }) }
  }

  // ---------- view ----------
  S.fit = () => {
    const st = els.stage
    if (!st || !S.doc) return
    const cw = st.clientWidth, ch = st.clientHeight
    if (!cw || !ch) return
    S.zoom = Math.min(4, Math.max(0.02, Math.min((cw - 48) / S.doc.w, (ch - 48) / S.doc.h)))
    S.panX = (cw - S.doc.w * S.zoom) / 2
    S.panY = (ch - S.doc.h * S.zoom) / 2
    updateChrome()
    S.redraw()
  }
  S.setZoom = (z, cx, cy) => {
    const st = els.stage
    if (!st) return
    const r = st.getBoundingClientRect()
    const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top
    const nz = Math.min(32, Math.max(0.02, z))
    S.panX = px - ((px - S.panX) / S.zoom) * nz
    S.panY = py - ((py - S.panY) / S.zoom) * nz
    S.zoom = nz
    updateChrome()
    positionTextEditor()
    S.redraw()
  }
  function fitStage() {
    const st = els.stage
    if (!st) return
    const dpr = Math.min(2, self.devicePixelRatio || 1)
    const w = Math.round(st.clientWidth * dpr), hh = Math.round(st.clientHeight * dpr)
    for (const c of [els.view, els.over]) if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh }
  }
  const toDoc = (cx, cy) => {
    const r = els.stage.getBoundingClientRect()
    return [(cx - r.left - S.panX) / S.zoom, (cy - r.top - S.panY) / S.zoom]
  }
  const toScreen = (x, y) => [x * S.zoom + S.panX, y * S.zoom + S.panY]
  let checker = null
  function draw() {
    if (!S.doc || !els.view) return
    fitStage()
    const dpr = els.view.width / Math.max(1, els.stage.clientWidth)
    const v = els.view.getContext('2d')
    v.setTransform(1, 0, 0, 1, 0, 0)
    v.clearRect(0, 0, els.view.width, els.view.height)
    v.setTransform(dpr, 0, 0, dpr, 0, 0)
    // checkerboard behind the canvas (screen-sized squares)
    if (!checker) {
      const t = makeCanvas(16, 16)
      const tx = t.getContext('2d')
      tx.fillStyle = '#ffffff'; tx.fillRect(0, 0, 16, 16)
      tx.fillStyle = '#e3e5ea'; tx.fillRect(0, 0, 8, 8); tx.fillRect(8, 8, 8, 8)
      checker = v.createPattern(t, 'repeat')
    }
    const [sx, sy] = toScreen(0, 0)
    v.save()
    v.shadowColor = 'rgba(0,0,0,.25)'
    v.shadowBlur = 18
    v.fillStyle = checker
    v.fillRect(sx, sy, S.doc.w * S.zoom, S.doc.h * S.zoom)
    v.restore()
    v.save()
    v.beginPath()
    v.rect(sx, sy, S.doc.w * S.zoom, S.doc.h * S.zoom)
    v.clip()
    v.translate(S.panX, S.panY)
    v.scale(S.zoom, S.zoom)
    v.imageSmoothingEnabled = S.zoom < 3
    v.imageSmoothingQuality = 'high'
    composite(v, S.doc, { fast: !!gesture })
    v.restore()
    drawOverlay(dpr)
  }
  const outlineCache = new WeakMap()
  function drawOverlay(dpr) {
    const o = els.over.getContext('2d')
    o.setTransform(1, 0, 0, 1, 0, 0)
    o.clearRect(0, 0, els.over.width, els.over.height)
    o.setTransform(dpr, 0, 0, dpr, 0, 0)
    const Z = S.zoom
    // selection marching ants
    const sel = S.doc.sel
    if (sel) {
      let segs = outlineCache.get(sel)
      if (!segs) outlineCache.set(sel, (segs = maskOutline(sel, S.doc.w, S.doc.h)))
      o.save()
      o.translate(S.panX, S.panY)
      o.beginPath()
      for (let i = 0; i < segs.length; i += 4) { o.moveTo(segs[i] * Z, segs[i + 1] * Z); o.lineTo(segs[i + 2] * Z, segs[i + 3] * Z) }
      o.lineWidth = 1
      o.strokeStyle = '#000'
      o.setLineDash([4, 4])
      o.lineDashOffset = antsPhase
      o.stroke()
      o.strokeStyle = '#fff'
      o.lineDashOffset = antsPhase + 4
      o.stroke()
      o.restore()
    }
    // active layer frame + handles
    const L = S.active()
    if (L && S.tool === 'move' && !L.hidden && !S.editingText) {
      const cs = layerCorners(L).map(([x, y]) => toScreen(x, y))
      o.save()
      o.strokeStyle = '#3b82f6'
      o.lineWidth = 1.5
      o.beginPath()
      cs.forEach(([x, y], i) => (i ? o.lineTo(x, y) : o.moveTo(x, y)))
      o.closePath()
      o.stroke()
      if (!L.locked) {
        const hs = handlePoints(L)
        for (const [id, x, y] of hs) {
          o.beginPath()
          if (id === 'rot') { o.arc(x, y, 6, 0, Math.PI * 2) } else o.rect(x - 5, y - 5, 10, 10)
          o.fillStyle = '#fff'
          o.fill()
          o.stroke()
        }
      }
      o.restore()
    }
    // crop box
    if (S.tool === 'crop' && cropRect) {
      const [x0, y0] = toScreen(cropRect.x, cropRect.y), [x1, y1] = toScreen(cropRect.x + cropRect.w, cropRect.y + cropRect.h)
      o.save()
      o.fillStyle = 'rgba(10,12,18,.55)'
      o.beginPath()
      o.rect(0, 0, els.stage.clientWidth, els.stage.clientHeight)
      o.rect(x0, y1, x1 - x0, y0 - y1)
      o.fill('evenodd')
      o.strokeStyle = '#fff'
      o.lineWidth = 1.5
      o.strokeRect(x0, y0, x1 - x0, y1 - y0)
      o.lineWidth = 1
      o.strokeStyle = 'rgba(255,255,255,.5)'
      for (const k of [1, 2]) {
        o.beginPath(); o.moveTo(x0 + ((x1 - x0) * k) / 3, y0); o.lineTo(x0 + ((x1 - x0) * k) / 3, y1); o.stroke()
        o.beginPath(); o.moveTo(x0, y0 + ((y1 - y0) * k) / 3); o.lineTo(x1, y0 + ((y1 - y0) * k) / 3); o.stroke()
      }
      o.fillStyle = '#fff'
      for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]]) o.fillRect(x - 5, y - 5, 10, 10)
      o.restore()
    }
    // lasso in progress
    if (lassoPts?.length) {
      o.save()
      o.strokeStyle = '#111'
      o.setLineDash([4, 3])
      o.beginPath()
      lassoPts.forEach(([x, y], i) => { const [a, b] = toScreen(x, y); i ? o.lineTo(a, b) : o.moveTo(a, b) })
      if (hover && S.opts.lasso.kind === 'poly') { const [a, b] = toScreen(...hover); o.lineTo(a, b) }
      o.stroke()
      o.restore()
    }
    // marquee / gradient line preview
    if (guide) {
      o.save()
      o.strokeStyle = '#111'
      o.setLineDash([4, 3])
      const [x0, y0] = toScreen(guide.x0, guide.y0), [x1, y1] = toScreen(guide.x1, guide.y1)
      if (guide.kind === 'line') { o.beginPath(); o.moveTo(x0, y0); o.lineTo(x1, y1); o.stroke(); o.setLineDash([]); o.fillStyle = '#fff'; o.beginPath(); o.arc(x0, y0, 4, 0, 7); o.fill(); o.stroke() } else if (guide.kind === 'ellipse') { o.beginPath(); o.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, 7); o.stroke() } else o.strokeRect(x0, y0, x1 - x0, y1 - y0)
      o.restore()
    }
    // brush cursor + clone source
    const T = S.tool
    if (hover && ['brush', 'eraser', 'clone', 'retouch'].includes(T)) {
      const [x, y] = toScreen(...hover)
      const r = Math.max(1, (S.opts[T].size / 2) * Z)
      o.save()
      o.strokeStyle = 'rgba(0,0,0,.7)'
      o.beginPath(); o.arc(x, y, r, 0, 7); o.stroke()
      o.strokeStyle = 'rgba(255,255,255,.8)'
      o.beginPath(); o.arc(x, y, r + 1, 0, 7); o.stroke()
      o.restore()
    }
    if (T === 'clone' && S.opts.clone.from) {
      let [x, y] = S.opts.clone.from
      if (gesture?.stroke?.cloneOff && hover) { x = hover[0] + gesture.stroke.cloneOff[0]; y = hover[1] + gesture.stroke.cloneOff[1] }
      const [a, b] = toScreen(x, y)
      o.save()
      o.strokeStyle = '#e03131'
      o.lineWidth = 1.5
      o.beginPath(); o.moveTo(a - 8, b); o.lineTo(a + 8, b); o.moveTo(a, b - 8); o.lineTo(a, b + 8); o.stroke()
      o.restore()
    }
  }
  function handlePoints(L) {
    const cs = layerCorners(L).map(([x, y]) => toScreen(x, y))
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const hs = [['nw', ...cs[0]], ['ne', ...cs[1]], ['se', ...cs[2]], ['sw', ...cs[3]]]
    if (L.type === 'shape') hs.push(['n', ...mid(cs[0], cs[1])], ['e', ...mid(cs[1], cs[2])], ['s', ...mid(cs[2], cs[3])], ['w', ...mid(cs[3], cs[0])])
    const top = mid(cs[0], cs[1]), c = mid(cs[0], cs[2])
    const len = Math.hypot(top[0] - c[0], top[1] - c[1]) || 1
    hs.push(['rot', top[0] + ((top[0] - c[0]) / len) * 26, top[1] + ((top[1] - c[1]) / len) * 26])
    return hs
  }
  function handleAtScreen(L, sx, sy) {
    const tol = matchMedia('(pointer: coarse)').matches ? 18 : 9
    for (const [id, x, y] of handlePoints(L)) if (Math.hypot(sx - x, sy - y) <= tol) return id
    return null
  }

  // ---------- transform math ----------
  function resizeLayer(L, o, handle, px, py, keep) {
    const a = (o.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2
    const dx = px - cx, dy = py - cy
    const lx = dx * c + dy * s, ly = -dx * s + dy * c // pointer in the unrotated frame
    const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
    const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
    const ax = -hx * o.w / 2, ay = -hy * o.h / 2 // fixed anchor (opposite side)
    let nw = hx ? Math.max(4, (lx - ax) * hx) : o.w
    let nh = hy ? Math.max(4, (ly - ay) * hy) : o.h
    if (keep && hx && hy) { const k = Math.max(nw / o.w, nh / o.h); nw = o.w * k; nh = o.h * k }
    const ncx = ax + (hx ? (hx * nw) / 2 : 0), ncy = ay + (hy ? (hy * nh) / 2 : 0) // new centre in the local frame
    const wx = cx + ncx * c - ncy * s, wy = cy + ncx * s + ncy * c
    L.w = nw
    L.h = nh
    L.x = wx - nw / 2
    L.y = wy - nh / 2
  }

  // ---------- tools ----------
  S.setTool = (t) => {
    closeTextEditor(true)
    if (S.tool === 'crop' && t !== 'crop') cropRect = null
    if (t === 'crop' && S.doc) cropRect = { x: 0, y: 0, w: S.doc.w, h: S.doc.h }
    lassoPts = null
    S.tool = t
    els.rail?.querySelectorAll('.st-tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t))
    if (els.stage) els.stage.style.cursor = t === 'hand' ? 'grab' : t === 'move' ? 'default' : t === 'text' ? 'text' : ['brush', 'eraser', 'clone', 'retouch'].includes(t) ? 'none' : 'crosshair'
    renderOptions()
    S.refresh()
    S.redraw()
  }
  S.setColor = (which, v) => { S[which] = v; renderColors(); renderOptions() }

  function pickLayerAt(x, y) {
    for (let i = S.doc.layers.length - 1; i >= 0; i--) if (hitLayer(S.doc.layers[i], x, y)) return S.doc.layers[i]
    return null
  }
  const combineMode = (e) => (e.shiftKey ? 'add' : e.altKey ? 'subtract' : S.opts.select.mode)
  const finishSel = (m, mode, label) => {
    let next = maskCombine(S.doc.sel, m, mode)
    if (S.opts.select.feather > 0) next = maskFeather(next, S.doc.w, S.doc.h, S.opts.select.feather)
    S.setSel(next, label)
  }
  function samplePixel(x, y) {
    const c = flatten(S.doc)
    const d = c.getContext('2d').getImageData(Math.max(0, Math.min(S.doc.w - 1, Math.floor(x))), Math.max(0, Math.min(S.doc.h - 1, Math.floor(y))), 1, 1).data
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  function onDown(e) {
    if (!S.doc) return
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 2) { // pinch-zoom + two-finger pan — cancels the one-finger action
      cancelGesture()
      const [p, q] = [...pointers.values()]
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), z: S.zoom, mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 }
      return
    }
    if (pointers.size > 2) return
    try { els.stage.setPointerCapture(e.pointerId) } catch { /* gone */ }
    e.preventDefault()
    closeTextEditor(true)
    const [x, y] = toDoc(e.clientX, e.clientY)
    const T = spaceDown || e.button === 1 ? 'hand' : S.tool
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5
    switch (T) {
      case 'hand':
        gesture = { kind: 'pan', lx: e.clientX, ly: e.clientY }
        els.stage.style.cursor = 'grabbing'
        break
      case 'move': {
        const L = S.active()
        const r = els.stage.getBoundingClientRect()
        const hnd = L && !L.locked ? handleAtScreen(L, e.clientX - r.left, e.clientY - r.top) : null
        if (hnd) {
          const cx = L.x + L.w / 2, cy = L.y + L.h / 2
          gesture = { kind: hnd === 'rot' ? 'rotate' : 'resize', handle: hnd, L, o: { ...L }, cx, cy, a0: Math.atan2(y - cy, x - cx), moved: false }
          break
        }
        let target = L && hitLayer(L, x, y) ? L : null
        if (!target && S.opts.move.auto) target = pickLayerAt(x, y)
        if (!target) target = L
        if (!target || target.locked) { if (target?.locked) toast('That layer is locked', { type: 'info' }); break }
        if (target.id !== S.activeId) { S.activeId = target.id; S.refresh() }
        gesture = { kind: 'move', L: target, ox: target.x, oy: target.y, sx: x, sy: y, moved: false }
        break
      }
      case 'marquee':
        gesture = { kind: 'marquee', x0: x, y0: y, mode: combineMode(e) }
        guide = { kind: S.opts.marquee.shape === 'ellipse' ? 'ellipse' : 'rect', x0: x, y0: y, x1: x, y1: y }
        break
      case 'lasso':
        if (S.opts.lasso.kind === 'poly') {
          if (lassoPts?.length > 2 && Math.hypot((x - lassoPts[0][0]) * S.zoom, (y - lassoPts[0][1]) * S.zoom) < 12) { closeLasso(combineMode(e)); break }
          lassoPts = [...(lassoPts ?? []), [x, y]]
          if (e.detail >= 2 && lassoPts.length > 2) closeLasso(combineMode(e))
        } else {
          lassoPts = [[x, y]]
          gesture = { kind: 'lasso', mode: combineMode(e) }
        }
        break
      case 'wand': {
        const L = S.active()
        const o = S.opts.wand
        const pix = o.sampleAll || !L || !isCanvasAligned(S.doc, L) ? S.mergedPixels() : pixelsOf(L.canvas)
        finishSel(floodMask(pix, S.doc.w, S.doc.h, x, y, { tolerance: o.tolerance, contiguous: o.contiguous }), combineMode(e), 'Magic wand')
        break
      }
      case 'crop': {
        if (!cropRect) cropRect = { x: 0, y: 0, w: S.doc.w, h: S.doc.h }
        let hnd = cropHandle(x, y)
        const whole = cropRect.x <= 0 && cropRect.y <= 0 && cropRect.w >= S.doc.w && cropRect.h >= S.doc.h
        if (hnd === 'move' && whole) hnd = null // nothing to move yet: draw a new crop box
        gesture = { kind: 'crop', handle: hnd ?? 'new', o: { ...cropRect }, sx: x, sy: y }
        if (!hnd) cropRect = { x, y, w: 0, h: 0 }
        break
      }
      case 'brush': case 'eraser': case 'clone': case 'retouch': {
        const o = S.opts[T]
        if (T === 'clone' && (e.altKey || o.setting || !o.from)) {
          if (!e.altKey && !o.setting && !o.from) { toast('Alt-click (or tap “Set source”) where you want to copy from first', { type: 'info' }); break }
          o.from = [x, y]
          o.setting = false
          renderOptions()
          S.redraw()
          break
        }
        const L = S.paintTarget(T === 'eraser' ? 'erase' : 'paint on')
        if (!L) break
        const tool = T === 'retouch' ? S.opts.retouch.mode : T
        const stroke = beginStroke(S.doc, L, tool, { ...o, color: S.fg, sel: S.doc.sel, cloneFrom: S.opts.clone.from })
        strokeTo(stroke, x, y, pressure)
        gesture = { kind: 'stroke', stroke, L, label: { brush: 'Brush', eraser: 'Eraser', clone: 'Clone stamp' }[T] ?? tool[0].toUpperCase() + tool.slice(1) }
        break
      }
      case 'bucket': {
        const L = S.paintTarget('fill')
        if (!L) break
        const o = S.opts.bucket
        bucketFill(S.doc, L, x, y, { color: S.fg, tolerance: o.tolerance, contiguous: o.contiguous, opacity: o.opacity, sel: S.doc.sel, sample: o.sampleAll ? S.mergedPixels() : null })
        S.commit('Fill')
        break
      }
      case 'gradient':
        gesture = { kind: 'gradient', x0: x, y0: y }
        guide = { kind: 'line', x0: x, y0: y, x1: x, y1: y }
        break
      case 'eyedropper':
        S.setColor(e.altKey ? 'bg' : 'fg', samplePixel(x, y))
        gesture = { kind: 'pick', alt: e.altKey }
        break
      case 'text': {
        const hit = pickLayerAt(x, y)
        if (hit?.type === 'text') { S.activeId = hit.id; S.refresh(); openTextEditor(hit); break }
        const t = S.opts.text
        const L = textLayer('Your text', x, y, { font: t.font, size: t.size, weight: t.weight, color: t.color ?? S.fg })
        L.y = y - L.h / 2
        S.insertLayer(L, { label: null })
        openTextEditor(L, true)
        break
      }
      case 'shape': {
        const o = S.opts.shape
        const L = shapeLayer(o.kind, x, y, 1, 1, { fill: o.kind === 'line' ? null : o.fill, stroke: o.kind === 'line' ? (o.stroke ?? o.fill ?? S.fg) : o.stroke, strokeW: o.kind === 'line' ? Math.max(4, o.strokeW) : o.strokeW })
        S.insertLayer(L, { label: null })
        gesture = { kind: 'shape', L, x0: x, y0: y, moved: false }
        break
      }
    }
    S.redraw()
  }

  function onMove(e) {
    const p = pointers.get(e.pointerId)
    if (p) { p.x = e.clientX; p.y = e.clientY }
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      S.panX += mx - pinch.mx
      S.panY += my - pinch.my
      pinch.mx = mx
      pinch.my = my
      if (pinch.d > 0) S.setZoom(pinch.z * (d / pinch.d), mx, my)
      return
    }
    if (!S.doc) return
    const [x, y] = toDoc(e.clientX, e.clientY)
    hover = [x, y]
    const g = gesture
    if (!g) {
      if (S.tool === 'move' && S.active() && e.pointerType !== 'touch') {
        const r = els.stage.getBoundingClientRect()
        const hnd = handleAtScreen(S.active(), e.clientX - r.left, e.clientY - r.top)
        els.stage.style.cursor = hnd === 'rot' ? 'grab' : hnd ? 'nwse-resize' : 'default'
      }
      if (['brush', 'eraser', 'clone', 'retouch', 'lasso'].includes(S.tool)) S.redraw()
      return
    }
    const shift = e.shiftKey
    switch (g.kind) {
      case 'pan':
        S.panX += e.clientX - g.lx
        S.panY += e.clientY - g.ly
        g.lx = e.clientX
        g.ly = e.clientY
        positionTextEditor()
        break
      case 'move': {
        let dx = x - g.sx, dy = y - g.sy
        if (!g.moved && Math.hypot(dx, dy) * S.zoom < 3) return
        g.moved = true
        if (shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0 }
        let nx = g.ox + dx, ny = g.oy + dy
        // snap the layer's centre / edges to the canvas centre and edges
        const t = 8 / S.zoom
        for (const [v, set] of [[nx + g.L.w / 2, (s) => (nx = s - g.L.w / 2)], [nx, (s) => (nx = s)], [nx + g.L.w, (s) => (nx = s - g.L.w)]]) {
          for (const s of [0, S.doc.w / 2, S.doc.w]) if (Math.abs(v - s) < t) { set(s); break }
        }
        for (const [v, set] of [[ny + g.L.h / 2, (s) => (ny = s - g.L.h / 2)], [ny, (s) => (ny = s)], [ny + g.L.h, (s) => (ny = s - g.L.h)]]) {
          for (const s of [0, S.doc.h / 2, S.doc.h]) if (Math.abs(v - s) < t) { set(s); break }
        }
        g.L.x = nx
        g.L.y = ny
        break
      }
      case 'resize': {
        g.moved = true
        const keepDefault = g.L.type !== 'shape'
        resizeLayer(g.L, g.o, g.handle, x, y, keepDefault !== shift)
        break
      }
      case 'rotate': {
        g.moved = true
        let deg = g.o.rot + ((Math.atan2(y - g.cy, x - g.cx) - g.a0) * 180) / Math.PI
        deg = ((deg % 360) + 360) % 360
        if (shift) deg = Math.round(deg / 15) * 15 % 360
        else for (const sn of [0, 90, 180, 270, 360]) if (Math.abs(deg - sn) < 3) deg = sn % 360
        g.L.rot = Math.round(deg * 10) / 10
        break
      }
      case 'marquee': {
        let x1 = x, y1 = y
        if (shift && Math.abs(x - g.x0) > 2) { const m = Math.max(Math.abs(x - g.x0), Math.abs(y - g.y0)); x1 = g.x0 + Math.sign(x - g.x0) * m; y1 = g.y0 + Math.sign(y - g.y0) * m }
        guide.x1 = x1
        guide.y1 = y1
        break
      }
      case 'lasso': {
        const last = lassoPts.at(-1)
        if (Math.hypot((x - last[0]) * S.zoom, (y - last[1]) * S.zoom) > 2) lassoPts.push([x, y])
        break
      }
      case 'crop': applyCropDrag(g, x, y, shift); break
      case 'stroke': {
        const evs = e.getCoalescedEvents?.() ?? []
        for (const ev of evs.length ? evs : [e]) {
          const [ex, ey] = toDoc(ev.clientX, ev.clientY)
          strokeTo(g.stroke, ex, ey, ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5)
        }
        break
      }
      case 'gradient':
        guide.x1 = x
        guide.y1 = y
        if (shift) { const a = Math.round(Math.atan2(y - g.y0, x - g.x0) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(x - g.x0, y - g.y0); guide.x1 = g.x0 + Math.cos(a) * l; guide.y1 = g.y0 + Math.sin(a) * l }
        break
      case 'pick': S.setColor(g.alt ? 'bg' : 'fg', samplePixel(x, y)); break
      case 'shape': {
        g.moved = true
        let w = x - g.x0, hh = y - g.y0
        if (g.L.kind === 'line' || g.L.kind === 'arrow') {
          const len = Math.hypot(w, hh)
          let ang = (Math.atan2(hh, w) * 180) / Math.PI
          if (shift) ang = Math.round(ang / 15) * 15
          const th = g.L.kind === 'line' ? Math.max(4, g.L.strokeW || 4) : Math.max(24, len * 0.28)
          g.L.w = Math.max(1, len)
          g.L.h = th
          g.L.rot = ang
          g.L.x = (g.x0 + x) / 2 - g.L.w / 2
          g.L.y = (g.y0 + y) / 2 - g.L.h / 2
          if (shift) { const r = (ang * Math.PI) / 180; g.L.x = g.x0 + (Math.cos(r) * len) / 2 - g.L.w / 2; g.L.y = g.y0 + (Math.sin(r) * len) / 2 - g.L.h / 2 }
          break
        }
        if (shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m }
        g.L.x = Math.min(g.x0, g.x0 + w)
        g.L.y = Math.min(g.y0, g.y0 + hh)
        g.L.w = Math.max(1, Math.abs(w))
        g.L.h = Math.max(1, Math.abs(hh))
        break
      }
    }
    S.redraw()
  }

  function onUp(e) {
    pointers.delete(e.pointerId)
    if (pinch) { if (pointers.size < 2) pinch = null; return }
    const g = gesture
    gesture = null
    if (!g || !S.doc) { S.redraw(); return }
    const [x, y] = toDoc(e.clientX, e.clientY)
    switch (g.kind) {
      case 'pan': els.stage.style.cursor = S.tool === 'hand' ? 'grab' : ''; break
      case 'move': if (g.moved) S.commit('Move'); break
      case 'resize':
        if (!g.moved) break
        if (g.L.type === 'text') { // bake the scale into the font size so the text stays crisp and editable
          const k = g.L.w / g.o.w
          g.L.size = Math.max(4, Math.round(g.o.size * k * 10) / 10)
          if (g.L.outline) g.L.outline = { ...g.L.outline, width: g.L.outline.width * k }
          fitText(g.L, 'center')
        }
        S.commit('Transform')
        break
      case 'rotate': if (g.moved) S.commit('Rotate'); break
      case 'marquee': {
        const gd = guide
        guide = null
        const w = gd.x1 - gd.x0, hh = gd.y1 - gd.y0
        if (Math.abs(w) * S.zoom < 3 || Math.abs(hh) * S.zoom < 3) { if (g.mode === 'replace') S.deselect(); break }
        const m = gd.kind === 'ellipse' ? maskEllipse(S.doc.w, S.doc.h, gd.x0, gd.y0, w, hh) : maskRect(S.doc.w, S.doc.h, gd.x0, gd.y0, w, hh)
        finishSel(m, g.mode, 'Select')
        break
      }
      case 'lasso': closeLasso(g.mode); break
      case 'crop':
        if (cropRect && (cropRect.w < 0 || cropRect.h < 0)) cropRect = normRect(cropRect)
        if (cropRect && (cropRect.w < 3 || cropRect.h < 3)) cropRect = { x: 0, y: 0, w: S.doc.w, h: S.doc.h }
        renderOptions()
        break
      case 'stroke': S.commit(g.label); break
      case 'gradient': {
        const gd = guide
        guide = null
        if (Math.hypot(gd.x1 - gd.x0, gd.y1 - gd.y0) * S.zoom < 3) break
        const L = S.paintTarget('paint on')
        if (!L) break
        const o = S.opts.gradient
        gradientFill(S.doc, L, gd.x0, gd.y0, gd.x1, gd.y1, { type: o.type, c1: S.fg, c2: o.transparent ? null : S.bg, opacity: o.opacity, sel: S.doc.sel })
        S.commit('Gradient')
        break
      }
      case 'shape':
        if (!g.moved || (g.L.w < 4 && g.L.h < 4)) { // a tap drops a default-size shape
          const sz = Math.round(Math.min(S.doc.w, S.doc.h) * 0.25)
          const line = g.L.kind === 'line' || g.L.kind === 'arrow'
          Object.assign(g.L, { w: sz, h: line ? (g.L.kind === 'line' ? Math.max(4, g.L.strokeW) : sz * 0.35) : sz, x: x - sz / 2, y: y - (line ? sz * 0.175 : sz / 2) })
        }
        S.commit(`Add ${g.L.name.toLowerCase()}`)
        S.setTool('move')
        break
    }
    S.redraw()
  }

  function cancelGesture() {
    const g = gesture
    gesture = null
    guide = null
    if (!g) return
    if (g.kind === 'stroke') g.L.canvas = g.stroke.before
    if (g.kind === 'move') { g.L.x = g.ox; g.L.y = g.oy }
    if ((g.kind === 'resize' || g.kind === 'rotate') && g.moved) Object.assign(g.L, g.o)
    if (g.kind === 'shape') { S.doc.layers = S.doc.layers.filter((L) => L !== g.L); S.activeId = S.doc.layers.at(-1)?.id }
    if (g.kind === 'lasso') lassoPts = null
    S.redraw()
  }

  function closeLasso(mode) {
    const pts = lassoPts
    lassoPts = null
    if (!pts || pts.length < 3) { if (mode === 'replace') S.deselect(); S.redraw(); return }
    finishSel(maskPolygon(S.doc.w, S.doc.h, pts), mode, 'Lasso')
  }
  const normRect = (r) => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) })
  function cropHandle(x, y) {
    if (!cropRect) return null
    const t = (matchMedia('(pointer: coarse)').matches ? 20 : 10) / S.zoom
    const r = cropRect
    const hx = Math.abs(x - r.x) < t ? 'w' : Math.abs(x - (r.x + r.w)) < t ? 'e' : ''
    const hy = Math.abs(y - r.y) < t ? 'n' : Math.abs(y - (r.y + r.h)) < t ? 's' : ''
    if (hx || hy) return hy + hx
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return 'move'
    return null
  }
  function applyCropDrag(g, x, y, shift) {
    const W = S.doc.w, H = S.doc.h, o = g.o
    const ratio = S.opts.crop.ratio
    if (g.handle === 'new') {
      let w = x - g.sx, hh = y - g.sy
      if (ratio) hh = Math.sign(hh || 1) * Math.abs(w) / ratio
      else if (shift) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m }
      cropRect = normRect({ x: g.sx, y: g.sy, w, h: hh })
    } else if (g.handle === 'move') {
      cropRect = { ...o, x: Math.max(0, Math.min(W - o.w, o.x + x - g.sx)), y: Math.max(0, Math.min(H - o.h, o.y + y - g.sy)) }
    } else {
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h
      if (g.handle.includes('w')) x0 = Math.min(x, x1 - 4)
      if (g.handle.includes('e')) x1 = Math.max(x, x0 + 4)
      if (g.handle.includes('n')) y0 = Math.min(y, y1 - 4)
      if (g.handle.includes('s')) y1 = Math.max(y, y0 + 4)
      if (ratio) { const w = x1 - x0; if (g.handle.includes('n')) y0 = y1 - w / ratio; else y1 = y0 + w / ratio }
      cropRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
    cropRect.x = Math.max(0, cropRect.x)
    cropRect.y = Math.max(0, cropRect.y)
    cropRect.w = Math.min(W - cropRect.x, cropRect.w)
    cropRect.h = Math.min(H - cropRect.y, cropRect.h)
    if (ratio) { // clamping must not break the chosen proportions
      const w = Math.min(cropRect.w, cropRect.h * ratio)
      cropRect.w = w
      cropRect.h = w / ratio
    }
  }
  S.applyCrop = () => { if (cropRect) { const r = cropRect; S.cropTo(r); S.setTool('move') } }
  S.cropRect = () => cropRect

  // ---------- inline text editing ----------
  function openTextEditor(L, isNew = false) {
    closeTextEditor(true)
    S.setTool('text')
    const ta = h('textarea', { class: 'st-txt', spellcheck: 'false' })
    ta.value = L.text
    S.editingText = { L, ta, isNew, before: L.text }
    ta.addEventListener('input', () => { L.text = ta.value; fitText(L, 'tl'); positionTextEditor(); S.redraw() })
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); closeTextEditor(true) }
    })
    ta.addEventListener('pointerdown', (e) => e.stopPropagation())
    els.stage.append(ta)
    positionTextEditor()
    requestAnimationFrame(() => { ta.focus(); if (isNew) ta.select() })
    S.refresh()
  }
  function positionTextEditor() {
    const ed = S.editingText
    if (!ed) return
    const L = ed.L
    const [x, y] = toScreen(L.x, L.y)
    Object.assign(ed.ta.style, {
      left: `${x}px`, top: `${y}px`, width: `${L.w * S.zoom + 4}px`, height: `${L.h * S.zoom + 4}px`,
      font: textFont(L, L.size * S.zoom), lineHeight: String(L.lineHeight || 1.2), textAlign: L.align,
      letterSpacing: `${(L.spacing || 0) * S.zoom}px`, transform: L.rot ? `rotate(${L.rot}deg)` : '', padding: L.bg ? `${L.size * (L.bgPad ?? 0.25) * S.zoom}px` : '0',
    })
  }
  function closeTextEditor(commit) {
    const ed = S.editingText
    if (!ed) return
    S.editingText = null
    ed.ta.remove()
    const L = ed.L
    if (!L.text.trim()) {
      S.doc.layers = S.doc.layers.filter((x) => x !== L)
      S.activeId = S.doc.layers.at(-1)?.id
      if (!ed.isNew) S.commit('Delete text')
    } else if (commit && (ed.isNew || L.text !== ed.before)) S.commit(ed.isNew ? 'Add text' : 'Edit text')
    S.refresh()
    S.redraw()
  }
  S.editText = (L = S.active()) => { if (L?.type === 'text') openTextEditor(L) }

  // ---------- chrome ----------
  function updateChrome() {
    if (els.zoom) els.zoom.textContent = `${Math.round(S.zoom * 100)}%`
    if (els.undo) els.undo.disabled = S.idx <= 0
    if (els.redo) els.redo.disabled = S.idx >= S.states.length - 1
    if (els.size && S.doc) els.size.textContent = `${S.doc.w} × ${S.doc.h}`
  }
  function renderColors() {
    if (!els.colors) return
    const sw = (which) => {
      const inp = h('input', { type: 'color', value: S[which], 'aria-label': which === 'fg' ? 'Foreground colour' : 'Background colour', oninput: (e) => { S[which] = e.target.value; renderOptionsSoon() } })
      return h('label', { class: `st-sw ${which}`, style: { background: S[which] }, 'data-tip': which === 'fg' ? 'Foreground colour' : 'Background colour' }, inp)
    }
    setKids(els.colors,
      sw('bg'), sw('fg'),
      h('button', { type: 'button', class: 'st-swap', 'data-tip': 'Swap colours (X)', 'aria-label': 'Swap colours', onclick: () => { [S.fg, S.bg] = [S.bg, S.fg]; renderColors() } }, '⇄'))
  }
  let optT = 0
  const renderOptionsSoon = () => { clearTimeout(optT); optT = setTimeout(() => renderColors(), 60) }

  function renderOptions() {
    if (!els.opts) return
    const T = S.tool
    const o = S.opts[T]
    const rng = (label, v, opts, set) => h('label', { class: 'st-opt' }, h('span', {}, label), Range(v, opts, set))
    const sizeHard = (oo) => [
      rng('Size', oo.size, { min: 1, max: 400, fmt: (v) => `${v}px` }, (v) => { oo.size = +v; S.redraw() }),
      rng('Hardness', Math.round(oo.hardness * 100), { min: 0, max: 100, fmt: (v) => `${v}%` }, (v) => { oo.hardness = v / 100 }),
    ]
    let kids = []
    switch (T) {
      case 'move':
        kids = [Switch('Auto-select layer', o.auto, (v) => { o.auto = v }), h('span', { class: 'st-hint' }, 'Drag to move · corners scale (Shift frees the ratio) · round handle rotates (Shift = 15°)')]
        break
      case 'marquee': case 'lasso': case 'wand':
        kids = [
          T === 'marquee' ? Seg([['rect', 'Rectangle', 'square'], ['ellipse', 'Ellipse', 'circle']], S.opts.marquee.shape, (v) => { S.opts.marquee.shape = v }) : null,
          T === 'lasso' ? Seg([['free', 'Freehand'], ['poly', 'Polygon']], S.opts.lasso.kind, (v) => { S.opts.lasso.kind = v; lassoPts = null; S.redraw() }) : null,
          T === 'wand' ? rng('Tolerance', o.tolerance, { min: 0, max: 255 }, (v) => { o.tolerance = +v }) : null,
          T === 'wand' ? Switch('Contiguous', o.contiguous, (v) => { o.contiguous = v }) : null,
          T === 'wand' ? Switch('All layers', o.sampleAll, (v) => { o.sampleAll = v }) : null,
          Seg([['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']], S.opts.select.mode, (v) => { S.opts.select.mode = v }),
          rng('Feather', S.opts.select.feather, { min: 0, max: 100, fmt: (v) => `${v}px` }, (v) => { S.opts.select.feather = +v }),
          Button({ label: 'Deselect', size: 'sm', disabled: !S.doc?.sel, onClick: () => S.deselect() }),
        ]
        break
      case 'crop':
        kids = [
          Seg([['', 'Free'], ['1', '1:1'], ['1.3333', '4:3'], ['1.7778', '16:9'], ['0.8', '4:5'], ['0.5625', '9:16']], o.ratio ? String(+o.ratio.toFixed(4)) : '', (v) => {
            o.ratio = v ? +v : null
            if (o.ratio && cropRect) { cropRect.h = Math.min(S.doc.h - cropRect.y, cropRect.w / o.ratio); cropRect.w = cropRect.h * o.ratio; S.redraw() }
          }),
          cropRect ? h('span', { class: 'st-hint' }, `${Math.round(cropRect.w)} × ${Math.round(cropRect.h)}`) : null,
          Button({ label: 'Apply crop', icon: 'check', variant: 'primary', size: 'sm', onClick: () => S.applyCrop() }),
          Button({ label: 'Cancel', size: 'sm', onClick: () => S.setTool('move') }),
        ]
        break
      case 'brush': case 'eraser':
        kids = [...sizeHard(o), rng('Opacity', Math.round(o.opacity * 100), { min: 1, max: 100, fmt: (v) => `${v}%` }, (v) => { o.opacity = v / 100 }), Switch('Pen pressure', o.pressure, (v) => { o.pressure = v })]
        break
      case 'clone':
        kids = [...sizeHard(o), rng('Opacity', Math.round(o.opacity * 100), { min: 1, max: 100, fmt: (v) => `${v}%` }, (v) => { o.opacity = v / 100 }),
          Button({ label: o.setting ? 'Tap the source…' : o.from ? 'Change source' : 'Set source', size: 'sm', variant: o.setting ? 'primary' : undefined, onClick: () => { o.setting = !o.setting; renderOptions() } }),
          h('span', { class: 'st-hint' }, 'Alt-click picks where to copy from')]
        break
      case 'retouch':
        kids = [Seg([['blur', 'Blur'], ['sharpen', 'Sharpen'], ['smudge', 'Smudge'], ['dodge', 'Dodge'], ['burn', 'Burn']], o.mode, (v) => { o.mode = v }),
          ...sizeHard(o), rng('Strength', Math.round(o.strength * 100), { min: 1, max: 100, fmt: (v) => `${v}%` }, (v) => { o.strength = v / 100 })]
        break
      case 'bucket':
        kids = [rng('Tolerance', o.tolerance, { min: 0, max: 255 }, (v) => { o.tolerance = +v }), Switch('Contiguous', o.contiguous, (v) => { o.contiguous = v }), Switch('All layers', o.sampleAll, (v) => { o.sampleAll = v }),
          rng('Opacity', Math.round(o.opacity * 100), { min: 1, max: 100, fmt: (v) => `${v}%` }, (v) => { o.opacity = v / 100 })]
        break
      case 'gradient':
        kids = [Seg([['linear', 'Linear'], ['radial', 'Radial']], o.type, (v) => { o.type = v }), Switch('Fade to transparent', o.transparent, (v) => { o.transparent = v }),
          rng('Opacity', Math.round(o.opacity * 100), { min: 1, max: 100, fmt: (v) => `${v}%` }, (v) => { o.opacity = v / 100 }), h('span', { class: 'st-hint' }, 'Drag across the canvas · foreground → background colour')]
        break
      case 'text':
        kids = [h('span', { class: 'st-hint' }, 'Click to add text, or click existing text to edit it. Style it on the right.')]
        break
      case 'shape':
        kids = [h('div', { class: 'st-shapes' }, [['rect', '▭'], ['ellipse', '◯'], ['triangle', '△'], ['star', '☆'], ['polygon', '⬡'], ['heart', '♡'], ['line', '╱'], ['arrow', '➜']].map(([k, g]) =>
          h('button', { type: 'button', class: o.kind === k ? 'on' : '', 'aria-label': k, 'data-tip': k[0].toUpperCase() + k.slice(1), onclick: () => { o.kind = k; renderOptions() } }, g))),
        h('label', { class: 'st-opt' }, h('span', {}, 'Fill'), h('input', { type: 'color', value: o.fill ?? '#3b82f6', oninput: (e) => { o.fill = e.target.value } })),
        rng('Outline', o.strokeW, { min: 0, max: 40, fmt: (v) => `${v}px` }, (v) => { o.strokeW = +v; if (+v && !o.stroke) o.stroke = '#111111' })]
        break
      case 'eyedropper':
        kids = [h('span', { class: 'st-hint' }, 'Click to pick the foreground colour · Alt-click for the background colour')]
        break
      case 'hand':
        kids = [Button({ label: 'Fit', size: 'sm', onClick: () => S.fit() }), Button({ label: '100%', size: 'sm', onClick: () => S.setZoom(1) }), h('span', { class: 'st-hint' }, 'Tip: hold Space with any tool to pan')]
        break
    }
    setKids(els.opts, h('span', { class: 'st-optname' }, STUDIO_TOOLS.find((t) => t[0] === T)?.[3] ?? ''), kids)
  }

  // ---------- menus ----------
  const menus = {
    File: () => [
      { label: 'New design…', icon: 'plus', onClick: async () => { if (await confirmLeave()) { S.doc = null; empty() } } },
      { label: 'Open image, PDF or project…', icon: 'files', kbd: 'Ctrl+O', onClick: () => S.openFile() },
      { label: 'Place image as layer…', icon: 'image', onClick: () => S.placeImage() },
      'sep',
      { label: 'Save project (.pdsd)', icon: 'save', kbd: 'Ctrl+S', onClick: () => S.saveProjectFile() },
      { label: 'Export PNG / JPG / WebP / PDF…', icon: 'download', kbd: 'Ctrl+Shift+E', onClick: () => S.exportDialog() },
    ],
    Edit: () => [
      { label: 'Undo', icon: 'undo', kbd: 'Ctrl+Z', disabled: S.idx <= 0, onClick: () => S.undo() },
      { label: 'Redo', icon: 'redo', kbd: 'Ctrl+Shift+Z', disabled: S.idx >= S.states.length - 1, onClick: () => S.redo() },
      'sep',
      { label: 'Select all', kbd: 'Ctrl+A', onClick: () => S.selectAll() },
      { label: 'Deselect', kbd: 'Ctrl+D', onClick: () => S.deselect() },
      { label: 'Invert selection', kbd: 'Ctrl+Shift+I', onClick: () => S.invertSel() },
      { label: 'Select layer pixels', onClick: () => S.selectLayerPixels() },
      { label: 'Feather selection…', onClick: () => askNumber('Feather selection', 'Softness (px)', 10, (v) => S.featherSel(v)) },
      { label: 'Expand selection…', onClick: () => askNumber('Expand selection', 'Pixels', 5, (v) => S.growSel(v)) },
      { label: 'Contract selection…', onClick: () => askNumber('Contract selection', 'Pixels', 5, (v) => S.growSel(-v)) },
      'sep',
      { label: 'Fill selection with colour', icon: 'bucket', kbd: 'Alt+Del', onClick: () => S.fillSel() },
      { label: 'Outline selection…', onClick: () => askNumber('Outline selection', 'Line width (px)', 6, (v) => S.strokeSel(v)) },
      { label: 'Delete selected pixels', icon: 'trash', kbd: 'Del', onClick: () => S.clearSel() },
    ],
    Image: () => [
      { label: 'Crop to selection', icon: 'crop', onClick: () => S.cropToSel() },
      { label: 'Trim empty edges', onClick: () => S.trimTransparent() },
      { label: 'Canvas size…', onClick: () => sizeDialog('canvas') },
      { label: 'Image size…', onClick: () => sizeDialog('image') },
      'sep',
      { label: 'Rotate 90° right', icon: 'rotate', onClick: () => S.rotateCanvas(true) },
      { label: 'Rotate 90° left', icon: 'rotl', onClick: () => S.rotateCanvas(false) },
      { label: 'Flip horizontally', onClick: () => S.flipCanvas(true) },
      { label: 'Flip vertically', onClick: () => S.flipCanvas(false) },
      'sep',
      { label: 'Flatten image', onClick: () => S.flattenAll() },
    ],
    Layer: () => [
      { label: 'New layer', icon: 'plus', kbd: 'Ctrl+Shift+N', onClick: () => S.addRaster() },
      { label: 'Duplicate layer', icon: 'copy', kbd: 'Ctrl+J', onClick: () => S.duplicateLayer() },
      { label: 'Copy selection to new layer', onClick: () => S.layerFromSel(false) },
      { label: 'Cut selection to new layer', onClick: () => S.layerFromSel(true) },
      { label: 'Merge down', kbd: 'Ctrl+E', onClick: () => S.mergeDown() },
      { label: 'Rasterize layer', onClick: () => S.rasterize() },
      { label: 'Flip layer horizontally', onClick: () => { const L = S.active(); if (L) S.setProp(L, 'flipH', !L.flipH, 'Flip layer') } },
      { label: 'Flip layer vertically', onClick: () => { const L = S.active(); if (L) S.setProp(L, 'flipV', !L.flipV, 'Flip layer') } },
      'sep',
      { label: 'Delete layer', icon: 'trash', danger: true, onClick: () => S.removeLayer() },
    ],
    Filter: () => Object.entries(FILTERS).map(([id, [label]]) => ({
      label: ['pixelate', 'posterize', 'threshold', 'noise'].includes(id) ? `${label}…` : label,
      onClick: () => {
        const amt = { pixelate: ['Block size (px)', 12], posterize: ['Colour levels', 5], threshold: ['Level (0-255)', 128], noise: ['Amount', 20] }[id]
        if (amt) askNumber(label, amt[0], amt[1], (v) => S.applyFilter(id, v)); else S.applyFilter(id)
      },
    })),
  }
  function askNumber(title, label, value, done) {
    let v = value
    modal({ title, body: [Field(label, TextInput(String(value), (x) => { v = parseFloat(x) }, { type: 'number' }))], actions: [{ label: 'Cancel' }, { label: 'OK', variant: 'primary', onClick: () => { if (Number.isFinite(v)) done(v) } }] })
  }
  function sizeDialog(kind) {
    let w = S.doc.w, hh = S.doc.h, keep = kind === 'image', anchor = 'c'
    const ratio = S.doc.w / S.doc.h
    const body = h('div', { class: 'xport' })
    const paint = () => setKids(body,
      h('div', { class: 'field-row' },
        Field('Width (px)', TextInput(String(w), (x) => { w = Math.max(1, Math.round(+x || 1)); if (keep) { hh = Math.max(1, Math.round(w / ratio)); paint() } }, { type: 'number' })),
        Field('Height (px)', TextInput(String(hh), (x) => { hh = Math.max(1, Math.round(+x || 1)); if (keep) { w = Math.max(1, Math.round(hh * ratio)); paint() } }, { type: 'number' }))),
      Switch('Keep proportions', keep, (v) => { keep = v }),
      kind === 'canvas' ? Field('Anchor', Seg([['tl', '↖'], ['t', '↑'], ['tr', '↗'], ['l', '←'], ['c', '•'], ['r', '→'], ['bl', '↙'], ['b', '↓'], ['br', '↘']], anchor, (v) => { anchor = v }, { block: true })) : null,
      h('div', { class: 'tip' }, kind === 'canvas' ? 'Adds or trims space around the design — nothing is stretched.' : 'Scales the whole design, every layer included.'))
    paint()
    modal({
      title: kind === 'canvas' ? 'Canvas size' : 'Image size', body: [body],
      actions: [{ label: 'Cancel' }, { label: 'Apply', variant: 'primary', onClick: () => {
        if (w * hh > 60e6) { toast('That’s too big — keep it under 60 megapixels', { type: 'error' }); return false }
        if (kind === 'canvas') S.canvasSize(w, hh, anchor); else S.imageSize(w, hh)
      } }],
    })
  }

  // ---------- shell ----------
  const confirmLeave = async () => !S.dirty || confirmDialog('Discard this design?', 'You haven’t exported or saved it. Save the project (.pdsd) to keep editing later.', { ok: 'Discard', danger: true, cancel: 'Keep editing' })

  function empty() {
    els = {}
    setKids(root,
      h('div', { class: 'st-top' },
        h('a', { class: 'btn btn-ghost btn-icon btn-sm', href: '#/', 'aria-label': 'All tools', 'data-tip': 'All tools' }, icon('left')),
        h('span', { class: 'st-brand' }, 'Design & Edit')),
      studioHome(S))
  }

  function build() {
    els = {}
    els.undo = Button({ icon: 'undo', size: 'sm', variant: 'ghost', tip: 'Undo (Ctrl+Z)', onClick: () => S.undo() })
    els.redo = Button({ icon: 'redo', size: 'sm', variant: 'ghost', tip: 'Redo (Ctrl+Shift+Z)', onClick: () => S.redo() })
    els.zoom = h('button', { type: 'button', class: 'st-zoomlbl', 'data-tip': 'Zoom', onclick: (e) => menu(e.currentTarget, [
      { label: 'Fit on screen', kbd: 'Ctrl+0', onClick: () => S.fit() }, 'sep',
      ...[25, 50, 100, 200, 400].map((z) => ({ label: `${z}%`, onClick: () => S.setZoom(z / 100) })),
    ]) }, '100%')
    els.size = h('span', { class: 'st-size' })
    const menuBar = h('nav', { class: 'st-menus' }, Object.keys(menus).map((k) => h('button', { type: 'button', onclick: (e) => menu(e.currentTarget, menus[k]()) }, k)))
    const top = h('div', { class: 'st-top' },
      h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'All tools', 'data-tip': 'All tools', onclick: async () => { if (await confirmLeave()) { S.dirty = false; location.hash = '#/' } } }, icon('left')),
      h('span', { class: 'st-brand st-hide-m' }, 'Design & Edit'),
      menuBar,
      h('div', { class: 'st-mid' }, els.undo, els.redo,
        h('div', { class: 'st-zoom' },
          h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => S.setZoom(S.zoom / 1.25) }, icon('minus', 'icon-sm')), els.zoom,
          h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => S.setZoom(S.zoom * 1.25) }, icon('plus', 'icon-sm'))),
        els.size),
      h('button', { class: 'btn btn-ghost btn-icon btn-sm st-panelbtn', 'aria-label': 'Layers and properties', 'data-tip': 'Layers & properties', onclick: () => els.panel.classList.toggle('open') }, icon('layers')),
      Button({ label: 'Export', icon: 'download', variant: 'primary', size: 'sm', onClick: () => S.exportDialog() }))
    els.colors = h('div', { class: 'st-colors' })
    els.rail = h('nav', { class: 'st-rail', 'aria-label': 'Tools' },
      STUDIO_TOOLS.map((t) => (t === '|' ? h('span', { class: 'sep' }) : h('button', {
        type: 'button', class: 'st-tool', 'data-tool': t[0], 'data-tip': `${t[3]} (${t[2]})`, 'data-tip-side': 'right', 'aria-label': t[3], onclick: () => S.setTool(t[0]),
      }, icon(t[1])))), els.colors)
    els.opts = h('div', { class: 'st-opts' })
    els.view = h('canvas', { class: 'st-view' })
    els.over = h('canvas', { class: 'st-over' })
    els.stage = h('div', { class: 'st-stage', tabindex: '0' }, els.view, els.over)
    els.panel = h('aside', { class: 'st-panel', 'aria-label': 'Layers and properties' })
    const body = h('div', { class: 'st-body' }, els.rail, h('div', { class: 'st-center' }, els.opts, els.stage), els.panel)
    setKids(root, top, body)
    els.stage.addEventListener('pointerdown', onDown)
    els.stage.addEventListener('pointermove', onMove)
    els.stage.addEventListener('pointerup', onUp)
    els.stage.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; cancelGesture() })
    els.stage.addEventListener('pointerleave', () => { hover = null; S.redraw() })
    els.stage.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) S.setZoom(S.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.0025), e.clientX, e.clientY)
      else { S.panX -= e.shiftKey ? e.deltaY : e.deltaX; S.panY -= e.shiftKey ? 0 : e.deltaY; positionTextEditor(); S.redraw() }
    }, { passive: false })
    els.stage.addEventListener('dblclick', (e) => {
      if (S.tool !== 'move') return
      const [x, y] = toDoc(e.clientX, e.clientY)
      const L = pickLayerAt(x, y)
      if (L?.type === 'text') { S.activeId = L.id; openTextEditor(L) }
    })
    els.stage.addEventListener('dragover', (e) => e.preventDefault())
    els.stage.addEventListener('drop', (e) => {
      e.preventDefault()
      const f = e.dataTransfer?.files?.[0]
      if (!f) return
      if (/^image\//.test(f.type)) S.placeImage(f); else S.openFile(f)
    })
    new ResizeObserver(() => { if (S.doc) { if (!S.userView) S.fit(); S.redraw() } }).observe(els.stage)
    renderColors()
    S.setTool(S.tool)
    S.refresh()
    clearInterval(antsT)
    antsT = setInterval(() => { if (!root.isConnected) { cleanup(); return } if (S.doc?.sel) { antsPhase = (antsPhase + 1) % 8; S.redraw() } }, 120)
  }

  // ---------- keyboard / clipboard ----------
  const KEYS = Object.fromEntries(STUDIO_TOOLS.filter((t) => t !== '|').map((t) => [t[2].toLowerCase(), t[0]]))
  const onKey = (e) => {
    if (!root.isConnected) { cleanup(); return }
    if (!S.doc || document.querySelector('.modal-back, .menu')) return
    if (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (e.key === ' ' && !spaceDown) { spaceDown = true; els.stage.style.cursor = 'grab'; e.preventDefault(); return }
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); S.undo() }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); S.redo() }
    else if (mod && k === 's') { e.preventDefault(); S.saveProjectFile() }
    else if (mod && k === 'o') { e.preventDefault(); S.openFile() }
    else if (mod && e.shiftKey && k === 'e') { e.preventDefault(); S.exportDialog() }
    else if (mod && k === 'e') { e.preventDefault(); S.mergeDown() }
    else if (mod && k === 'a') { e.preventDefault(); S.selectAll() }
    else if (mod && k === 'd') { e.preventDefault(); S.deselect() }
    else if (mod && e.shiftKey && k === 'i') { e.preventDefault(); S.invertSel() }
    else if (mod && e.shiftKey && k === 'n') { e.preventDefault(); S.addRaster() }
    else if (mod && k === 'j') { e.preventDefault(); if (S.doc.sel) S.layerFromSel(false); else S.duplicateLayer() }
    else if (mod && k === '0') { e.preventDefault(); S.userView = false; S.fit() }
    else if (mod && k === '1') { e.preventDefault(); S.setZoom(1) }
    else if (mod && (k === '=' || k === '+')) { e.preventDefault(); S.setZoom(S.zoom * 1.25) }
    else if (mod && k === '-') { e.preventDefault(); S.setZoom(S.zoom / 1.25) }
    else if (e.key === 'Enter' && S.tool === 'crop') { e.preventDefault(); S.applyCrop() }
    else if (e.key === 'Enter' && S.tool === 'lasso' && lassoPts?.length > 2) { e.preventDefault(); closeLasso(S.opts.select.mode) }
    else if (e.key === 'Escape') { if (gesture) cancelGesture(); else if (lassoPts) { lassoPts = null; S.redraw() } else if (S.tool === 'crop') S.setTool('move'); else S.deselect() }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && e.altKey) { e.preventDefault(); S.fillSel() }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (S.doc.sel) S.clearSel()
      else if (S.active() && S.active().type !== 'raster') S.removeLayer()
    } else if (e.key === '[' || e.key === ']') {
      const o = S.opts[S.tool]
      if (o?.size) { o.size = Math.max(1, Math.min(400, Math.round(o.size * (e.key === ']' ? 1.2 : 1 / 1.2)))); renderOptions(); S.redraw() }
    } else if (e.key.startsWith('Arrow') && S.tool === 'move' && S.active() && !S.active().locked) {
      e.preventDefault()
      const d = e.shiftKey ? 10 : 1
      const L = S.active()
      L.x += e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0
      L.y += e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0
      S.redraw()
      clearTimeout(S._nudge)
      S._nudge = setTimeout(() => S.commit('Nudge'), 400)
    } else if (!mod && !e.altKey && k === 'x') { [S.fg, S.bg] = [S.bg, S.fg]; renderColors() }
    else if (!mod && !e.altKey && KEYS[k]) { e.preventDefault(); S.setTool(KEYS[k]) }
  }
  const onKeyUp = (e) => { if (e.key === ' ') { spaceDown = false; if (els.stage) S.setTool(S.tool) } }
  const onPaste = async (e) => {
    if (!S.doc || !root.isConnected) return
    if (/input|textarea/i.test(document.activeElement?.tagName ?? '')) return
    const f = [...(e.clipboardData?.files ?? [])].find((x) => /^image\//.test(x.type))
    if (f) { e.preventDefault(); S.placeImage(f) }
  }
  const onBeforeUnload = (e) => { if (S.dirty && root.isConnected) { e.preventDefault(); e.returnValue = '' } }
  document.addEventListener('keydown', onKey)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('paste', onPaste)
  addEventListener('beforeunload', onBeforeUnload)
  function cleanup() {
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('paste', onPaste)
    removeEventListener('beforeunload', onBeforeUnload)
    clearInterval(antsT)
  }
  const mo = new MutationObserver(() => { if (!root.isConnected) { cleanup(); mo.disconnect() } })
  requestAnimationFrame(() => mo.observe(document.getElementById('app') ?? document.body, { childList: true }))

  // user-driven zoom/pan stops auto-fit on resize
  const markView = () => { S.userView = true }
  root.addEventListener('wheel', markView, { passive: true })
  S._rasterSource = rasterSource // tests
  window.__studio = S // devtools / automated tests

  const ho = takeHandoff()
  if (ho?.studioPdf) S.openPdfFile(ho.studioPdf, ho.page ?? 0, ho.dpi ?? 150).then(() => { if (!S.doc) empty() })
  else if (ho) { empty(); S.openFile(Array.isArray(ho) ? ho[0] : ho) } else empty()
  return root
}
