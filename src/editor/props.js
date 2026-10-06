// Contextual properties panel: edits the selected object, or sets the
// defaults for the active tool. Changes apply live; history commits once per
// gesture (sliders commit on release).
import { h, icon, setKids } from '../ui/dom.js'
import { Button, Seg, Select, Range, Stepper, Swatches, Switch, TextInput, toast, sortable } from '../ui/kit.js'
import { savedSignatures, forgetSignature } from './signature.js'
import { PRESETS, processImage, guessBackground } from './imagefx.js'

export const TOOL_INFO = {
  select: ['Select', 'Click an item to select it. Drag to move, drag handles to resize, double-click to edit. Right-click for more.'],
  edittext: ['Edit text', 'Click any text in the PDF to change it. The original text is removed when you download, and the font is matched as closely as possible.'],
  text: ['Add text', 'Click to type. Drag sideways first to make a box that wraps text.'],
  draw: ['Draw', 'Draw freehand. A pen tablet’s pressure is used for line width.'],
  highlight: ['Highlight', 'Drag across text to highlight it like a real marker.'],
  shape: ['Shapes', 'Drag to draw. Hold Shift for squares, circles and 45° lines.'],
  whiteout: ['Whiteout', 'Drag over anything to cover it with white. Click on text to cover just that line. (To truly remove content, use Redact.)'],
  redact: ['Redact', 'Mark areas or search for words. When you download, everything under the boxes — text and images — is permanently removed, not just hidden.'],
  image: ['Image', 'Pick a picture to place on the page.'],
  signature: ['Signature', 'Create a signature, then click it to place it on the page.'],
  stamp: ['Stamps', 'Pick a mark or stamp, then click on the page to place it. Great for checkboxes on forms.'],
  note: ['Comment', 'Click to add a sticky-note comment. It shows as a real PDF comment in any reader.'],
  link: ['Link', 'Drag a box over the area that should open a web address.'],
  erase: ['Eraser', 'Rub over drawings, highlights, lines and shapes to erase them. Drawings are cut where you erase.'],
}

const TEXT_COLORS = ['#111111', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff']
const HL_COLORS = ['#ffe066', '#8ce99a', '#99e9f2', '#fcc2d7', '#ffc078']
const STAMPS = ['APPROVED', 'DRAFT', 'PAID', 'CONFIDENTIAL', 'REJECTED', 'FINAL', 'COPY', 'VOID']
const TYPE_NAMES = { text: 'Text', textedit: 'Edited text', stroke: 'Drawing', highlight: 'Highlight', hlrects: 'Highlight', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', whiteout: 'Whiteout', redact: 'Redaction', image: 'Image', mark: 'Mark', stamp: 'Stamp', note: 'Comment', link: 'Link', poly: 'Shape', imgremove: 'Removed image' }
const TYPE_ICONS = { text: 'type', textedit: 'editText', stroke: 'pencil', highlight: 'highlight', hlrects: 'highlight', line: 'line', rect: 'square', ellipse: 'circle', poly: 'shapes', whiteout: 'whiteout', redact: 'redact', image: 'image', mark: 'check', stamp: 'stamp', note: 'note', link: 'link', imgremove: 'eyeOff' }
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']
const ROTATABLE = new Set(['text', 'textedit', 'image', 'stamp', 'mark', 'rect', 'ellipse', 'poly', 'whiteout'])

/** Render the panel into `el`. */
export function renderProps(ed, el) {
  const many = ed.sel && ed.selSet.size > 1
  const sel = many ? null : ed.sel?.a
  const page = ed.sel?.page ?? ed.currentPage()
  if (ed.propsTab === 'layers' && page) {
    setKids(el, panelHead(ed, el, 'Layers'), tabs(ed), layersPanel(ed, page))
    return
  }
  if (ed.pdfImg && !ed.sel) {
    setKids(el, panelHead(ed, el, 'Image in the PDF'), tabs(ed), pdfImagePanel(ed))
    return
  }
  if (many) {
    setKids(el, panelHead(ed, el, `${ed.selSet.size} items selected`), tabs(ed), multiPanel(ed))
    return
  }
  const head = sel ? (sel.name || TYPE_NAMES[sel.t] || 'Item') : TOOL_INFO[ed.tool]?.[0]
  const live = () => { ed.redrawCurrent(); ed.dirtyChrome() }
  const change = (k, v, commit = true) => { sel[k] = v; live(); if (commit) ed.commit('Style') }
  const S = ed.style

  const font = (obj, setter) => h('div', { class: 'grp' },
    h('label', {}, 'Font'),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } },
      Select([['helv', 'Helvetica'], ['times', 'Times'], ['courier', 'Courier']], obj.font, (v) => setter('font', v)),
      Stepper(obj.size ?? obj.textSize, { min: 4, max: 200, step: 1 }, (v) => setter('size', v))),
    h('div', { class: 'row', style: { gap: '6px' } },
      toggleBtn('bold', 'Bold (Ctrl+B)', !!obj.bold, (v) => setter('bold', v)),
      toggleBtn('italic', 'Italic (Ctrl+I)', !!obj.italic, (v) => setter('italic', v)),
      toggleBtn('underline', 'Underline (Ctrl+U)', !!obj.underline, (v) => setter('underline', v)),
      toggleBtn('strike', 'Strikethrough', !!obj.strike, (v) => setter('strike', v)),
      h('span', { style: { flex: 1 } }),
      Seg([['left', '', 'alignL', 'Align left'], ['center', '', 'alignC', 'Centre'], ['right', '', 'alignR', 'Align right']], obj.align ?? 'left', (v) => setter('align', v))))

  const turn = (d) => { sel.rot = (((sel.rot ?? 0) + d) % 360 + 360) % 360; live(); ed.commit('Rotate'); ed.refreshProps() }
  const actions = () => [
    ROTATABLE.has(sel.t) ? h('div', { class: 'grp' }, h('label', {}, 'Rotation'),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } },
        Stepper(Math.round(sel.rot ?? 0), { min: -360, max: 360, step: 1 }, (v) => { sel.rot = ((Math.round(v) % 360) + 360) % 360; live(); ed.commit('Rotate') }),
        Button({ icon: 'rotl', size: 'sm', tip: 'Rotate 90° left', onClick: () => turn(-90) }),
        Button({ icon: 'rotate', size: 'sm', tip: 'Rotate 90° right', onClick: () => turn(90) }))) : null,
    ['redact', 'note', 'link', 'textedit'].includes(sel.t) ? null : h('div', { class: 'grp' }, h('label', {}, 'Blend mode'),
      Select(BLENDS.map((b) => [b, b === 'normal' ? 'Normal' : b.replace('-', ' ').replace(/^./, (c) => c.toUpperCase())]), sel.blend ?? 'normal', (v) => change('blend', v === 'normal' ? undefined : v))),
    alignBlock(ed, 'Align to page'),
    h('div', { class: 'grp' },
      h('label', {}, 'Arrange'),
      h('div', { class: 'btnrow' },
        Button({ icon: 'copy', size: 'sm', tip: 'Duplicate (Ctrl+D)', onClick: () => ed.duplicate() }),
        Button({ icon: 'front', size: 'sm', tip: 'Bring to front (Ctrl+])', onClick: () => ed.reorder('front') }),
        Button({ icon: 'up', size: 'sm', tip: 'Bring forward (])', onClick: () => ed.reorder('forward') }),
        Button({ icon: 'down', size: 'sm', tip: 'Send backward ([)', onClick: () => ed.reorder('backward') }),
        Button({ icon: 'back', size: 'sm', tip: 'Send to back (Ctrl+[)', onClick: () => ed.reorder('back') }),
        Button({ icon: 'lock', size: 'sm', tip: 'Lock in place', onClick: () => ed.setFlag(ed.sel.page, sel, 'locked', true) }),
        h('span', { style: { flex: 1 } }),
        Button({ icon: 'trash', size: 'sm', variant: 'danger', tip: 'Delete (Del)', onClick: () => ed.deleteSel() }))),
  ]

  const opacity = (obj, key, set) => h('div', { class: 'grp' }, h('label', {}, 'Opacity'),
    rangeCommit(Math.round((obj[key] ?? 1) * 100), { min: 10, max: 100, fmt: (v) => `${v}%` }, (v, done) => set(key, v / 100, done)))

  let body = []
  if (sel) {
    const set = (k, v, done = true) => change(k, v, done)
    switch (sel.t) {
      case 'text': case 'textedit':
        body = [
          sel.t === 'textedit' ? h('div', { class: 'tip' }, 'Original: ', h('b', {}, `“${sel.origText}”`)) : null,
          font(sel, set),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color, (v) => set('color', v), { colors: TEXT_COLORS })),
          h('div', { class: 'grp' }, h('label', {}, 'Background'), Swatches(sel.bg ?? null, (v) => set('bg', v), { allowNone: true, colors: ['#ffffff', '#fff3bf', '#e7f5ff'] })),
          opacity(sel, 'alpha', set),
          textEffects(ed, sel, set),
          Button({ label: 'Edit text', icon: 'pencil', size: 'sm', onClick: () => ed.editSelected() }),
          sel.t === 'textedit' ? Button({ label: 'Restore original text', icon: 'undo', size: 'sm', onClick: () => ed.deleteSel() }) : null,
        ]
        break
      case 'stroke':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color, (v) => set('color', v))),
          h('div', { class: 'grp' }, h('label', {}, 'Thickness'), rangeCommit(sel.width, { min: 0.5, max: 30, step: 0.5, fmt: (v) => `${v}pt` }, (v, done) => {
            const k = v / (sel.width || 1)
            sel.pts = sel.pts.map((p) => [p[0], p[1], (p[2] ?? sel.width) * k])
            set('width', v, done)
          })),
          opacity(sel, 'alpha', set),
        ]
        break
      case 'highlight': case 'hlrects':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color, (v) => set('color', v), { colors: HL_COLORS })),
          sel.t === 'highlight' ? h('div', { class: 'grp' }, h('label', {}, 'Thickness'), rangeCommit(sel.width, { min: 4, max: 40, fmt: (v) => `${v}pt` }, (v, done) => set('width', v, done))) : null,
        ]
        break
      case 'line':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color, (v) => set('color', v))),
          h('div', { class: 'grp' }, h('label', {}, 'Thickness'), rangeCommit(sel.width, { min: 0.5, max: 20, step: 0.5, fmt: (v) => `${v}pt` }, (v, done) => set('width', v, done))),
          h('div', { class: 'grp' }, h('label', {}, 'Ends'), h('div', { class: 'row', style: { gap: '6px' } },
            Switch('Arrow at end', !!sel.arrow, (v) => set('arrow', v)),
            Switch('Arrow at start', !!sel.arrowStart, (v) => set('arrowStart', v)))),
          Switch('Dashed', !!sel.dash, (v) => set('dash', v ? [sel.width * 3, sel.width * 2] : null)),
          opacity(sel, 'alpha', set),
        ]
        break
      case 'rect': case 'ellipse': case 'poly':
        body = [
          sel.t === 'poly' && sel.kind !== 'triangle' ? h('div', { class: 'grp' }, h('label', {}, sel.kind === 'star' ? 'Points' : 'Sides'),
            rangeCommit(sel.sides ?? (sel.kind === 'star' ? 5 : 6), { min: sel.kind === 'star' ? 4 : 3, max: 16 }, (v, done) => set('sides', +v, done))) : null,
          sel.t === 'poly' && sel.kind === 'star' ? h('div', { class: 'grp' }, h('label', {}, 'Star depth'),
            rangeCommit(Math.round((1 - (sel.inner ?? 0.45)) * 100), { min: 10, max: 90, fmt: (v) => `${v}%` }, (v, done) => set('inner', 1 - v / 100, done))) : null,
          h('div', { class: 'grp' }, h('label', {}, 'Border'), Swatches(sel.stroke ?? null, (v) => set('stroke', v), { allowNone: true })),
          h('div', { class: 'grp' }, h('label', {}, 'Fill'), Swatches(sel.fill ?? null, (v) => { set('fill', v); ed.refreshProps() }, { allowNone: true })),
          sel.fill ? h('div', { class: 'grp' }, h('label', {}, 'Fill opacity'), rangeCommit(Math.round((sel.fillAlpha ?? 1) * 100), { min: 0, max: 100, fmt: (v) => `${v}%` }, (v, done) => set('fillAlpha', v / 100, done))) : null,
          h('div', { class: 'grp' }, h('label', {}, 'Border width'), rangeCommit(sel.lw ?? 2, { min: 0.5, max: 20, step: 0.5, fmt: (v) => `${v}pt` }, (v, done) => set('lw', v, done))),
          Switch('Dashed border', !!sel.dash, (v) => set('dash', v ? [(sel.lw ?? 2) * 3, (sel.lw ?? 2) * 2] : null)),
          sel.t === 'rect' ? Switch('Rounded corners', !!sel.radius, (v) => set('radius', v ? Math.min(sel.w, sel.h) * 0.15 : 0)) : null,
          opacity(sel, 'alpha', set),
        ]
        break
      case 'whiteout':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Cover colour'), Swatches(sel.fill ?? '#ffffff', (v) => set('fill', v), { colors: ['#ffffff', '#f8f9fa', '#000000'] })),
          h('div', { class: 'tip' }, 'Whiteout only covers what’s underneath — the text is still in the file. Use Redact to remove it for real.'),
        ]
        break
      case 'redact':
        body = [
          h('div', { class: 'tip' }, icon('shield', 'icon-sm'), ' Everything under this box is permanently removed when you download.'),
          h('div', { class: 'grp' }, h('label', {}, 'Box colour'), Swatches(sel.fill ?? '#000000', (v) => { for (const p of ed.pages) for (const a of p.annots) if (a.t === 'redact') a.fill = v; ed.style.redactColor = v; ed.redrawAll(); ed.commit('Style') }, { colors: ['#000000', '#ffffff', '#495057'] })),
        ]
        break
      case 'image':
        body = imagePanel(ed, sel, set, live)
        break
      case 'mark':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Mark'), Seg([['check', '✓'], ['cross', '✗'], ['dot', '●']], sel.kind, (v) => set('kind', v), { block: true })),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color, (v) => set('color', v))),
        ]
        break
      case 'stamp':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Text'), TextInput(sel.label, (v) => { sel.label = v.toUpperCase().slice(0, 30); live() }, { onEnter: () => ed.commit('Stamp') })),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color, (v) => set('color', v), { colors: ['#e03131', '#2f9e44', '#1971c2', '#111111'] })),
          opacity(sel, 'alpha', set),
        ]
        break
      case 'note':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Comment'), h('div', { class: 'tip', style: { whiteSpace: 'pre-wrap' } }, sel.text || '(empty)')),
          Button({ label: 'Edit comment', icon: 'note', size: 'sm', onClick: () => ed.editNote(ed.sel.page, sel) }),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(sel.color ?? '#ffd43b', (v) => set('color', v), { colors: ['#ffd43b', '#8ce99a', '#74c0fc', '#ffa8a8'] })),
        ]
        break
      case 'link':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Web address'), TextInput(sel.url, (v) => { sel.url = v }, { placeholder: 'https://…', onEnter: () => ed.commit('Link') })),
          h('div', { class: 'tip' }, 'Becomes a clickable link in any PDF reader. The blue box isn’t printed.'),
        ]
        break
    }
    body.push(actions())
  } else {
    const setS = (k, v) => { S[k] = v; ed.saveStyle() }
    switch (ed.tool) {
      case 'text':
        body = [
          font({ font: S.font, size: S.textSize, bold: S.bold, italic: S.italic, underline: S.underline, align: S.align }, (k, v) => setS(k === 'size' ? 'textSize' : k, v)),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(S.textColor, (v) => setS('textColor', v), { colors: TEXT_COLORS })),
        ]
        break
      case 'draw':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(S.penColor, (v) => setS('penColor', v))),
          h('div', { class: 'grp' }, h('label', {}, 'Thickness'), Range(S.penWidth, { min: 0.5, max: 24, step: 0.5, fmt: (v) => `${v}pt` }, (v) => setS('penWidth', v))),
          h('div', { class: 'grp' }, h('label', {}, 'Opacity'), Range(Math.round(S.penAlpha * 100), { min: 10, max: 100, fmt: (v) => `${v}%` }, (v) => setS('penAlpha', v / 100))),
        ]
        break
      case 'highlight':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Mode'), Seg([['text', 'Text', 'type'], ['free', 'Freehand', 'highlight']], ed.sub.hl, (v) => { ed.sub.hl = v; ed.refreshProps(); ed.hintTool() }, { block: true })),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(S.hlColor, (v) => setS('hlColor', v), { colors: HL_COLORS })),
          ed.sub.hl === 'free' ? h('div', { class: 'grp' }, h('label', {}, 'Thickness'), Range(S.hlWidth, { min: 4, max: 40, fmt: (v) => `${v}pt` }, (v) => setS('hlWidth', v))) : null,
        ]
        break
      case 'shape':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Shape'), h('div', { class: 'shape-grid' },
            [['rect', '▭', 'Rectangle'], ['rrect', '▢', 'Rounded rectangle'], ['ellipse', '◯', 'Ellipse'], ['triangle', '△', 'Triangle'], ['star', '☆', 'Star'], ['polygon', '⬡', 'Polygon'], ['line', '╱', 'Line'], ['arrow', '➚', 'Arrow']]
              .map(([k, g, tip]) => h('button', { type: 'button', class: ed.sub.shape === k ? 'on' : '', 'data-tip': tip, 'aria-label': tip, onclick: () => { ed.sub.shape = k; ed.refreshProps() } }, g)))),
          ed.sub.shape === 'polygon' ? h('div', { class: 'grp' }, h('label', {}, 'Sides'), Range(S.polySides ?? 6, { min: 3, max: 16 }, (v) => setS('polySides', +v))) : null,
          ed.sub.shape === 'star' ? h('div', { class: 'grp' }, h('label', {}, 'Points'), Range(S.starPoints ?? 5, { min: 4, max: 16 }, (v) => setS('starPoints', +v))) : null,
          h('div', { class: 'grp' }, h('label', {}, ed.sub.shape === 'line' || ed.sub.shape === 'arrow' ? 'Colour' : 'Border'), Swatches(S.shapeStroke, (v) => setS('shapeStroke', v), { allowNone: !(ed.sub.shape === 'line' || ed.sub.shape === 'arrow') })),
          ed.sub.shape === 'line' || ed.sub.shape === 'arrow' ? null : h('div', { class: 'grp' }, h('label', {}, 'Fill'), Swatches(S.shapeFill, (v) => setS('shapeFill', v), { allowNone: true })),
          h('div', { class: 'grp' }, h('label', {}, 'Thickness'), Range(S.shapeWidth, { min: 0.5, max: 20, step: 0.5, fmt: (v) => `${v}pt` }, (v) => setS('shapeWidth', v))),
          ed.sub.shape === 'line' || ed.sub.shape === 'arrow' || !S.shapeFill ? null : h('div', { class: 'grp' }, h('label', {}, 'Fill opacity'), Range(Math.round((S.shapeFillAlpha ?? 1) * 100), { min: 0, max: 100, fmt: (v) => `${v}%` }, (v) => setS('shapeFillAlpha', v / 100))),
          Switch('Dashed', S.shapeDash, (v) => setS('shapeDash', v)),
          h('div', { class: 'tip' }, 'Tap the page to drop a shape, or drag to size it. Shift keeps it even.'),
        ]
        break
      case 'erase':
        body = [h('div', { class: 'grp' }, h('label', {}, 'Eraser size'), Range(S.eraserSize ?? 10, { min: 2, max: 60, fmt: (v) => `${v}pt` }, (v) => setS('eraserSize', +v)))]
        break
      case 'redact':
        body = [redactSearch(ed), h('div', { class: 'grp' }, h('label', {}, 'Box colour'), Swatches(S.redactColor, (v) => setS('redactColor', v), { colors: ['#000000', '#ffffff', '#495057'] }))]
        break
      case 'image':
        body = [Button({ label: 'Choose image', icon: 'image', variant: 'primary', block: true, onClick: () => ed.insertImage() })]
        break
      case 'signature': {
        const sigs = savedSignatures()
        body = [
          Button({ label: 'New signature', icon: 'plus', variant: 'primary', block: true, onClick: () => ed.newSignature() }),
          sigs.length ? h('div', { class: 'grp' }, h('label', {}, 'Saved on this device'),
            h('div', { class: 'sigs' }, sigs.map((u) => h('button', { type: 'button', title: 'Place this signature', onclick: () => ed.placeSignature(u) },
              h('img', { src: u, alt: 'Saved signature' }),
              h('span', { class: 'x', title: 'Forget', onclick: (e) => { e.stopPropagation(); forgetSignature(u); ed.refreshProps(); toast('Signature removed from this device') } }, icon('x', 'icon-sm')))))) : null,
          h('div', { class: 'grp' }, h('label', {}, 'Initials or date'), h('div', { class: 'btnrow' },
            Button({ label: 'Today’s date', size: 'sm', onClick: () => { ed.sub.stamp = 'date'; ed.setTool('stamp') } }))),
        ]
        break
      }
      case 'stamp':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Marks'), h('div', { class: 'stamp-grid' },
            [['check', '✓'], ['cross', '✗'], ['dot', '●'], ['date', icon('calendar', 'icon-sm')]].map(([k, l]) => h('button', { type: 'button', class: ed.sub.stamp === k ? 'on' : '', title: k, onclick: () => { ed.sub.stamp = k; ed.refreshProps() } }, l)))),
          h('div', { class: 'grp' }, h('label', {}, 'Stamps'), h('div', { class: 'stamp-grid', style: { gridTemplateColumns: '1fr 1fr' } },
            STAMPS.map((k) => h('button', { type: 'button', class: ed.sub.stamp === k ? 'on' : '', style: { fontSize: '11px' }, onclick: () => { ed.sub.stamp = k; ed.refreshProps() } }, k)))),
          h('div', { class: 'grp' }, h('label', {}, 'Custom stamp'), TextInput(STAMPS.includes(ed.sub.stamp) || ['check', 'cross', 'dot', 'date'].includes(ed.sub.stamp) ? '' : ed.sub.stamp, (v) => { if (v.trim()) ed.sub.stamp = v.trim().toUpperCase().slice(0, 30) }, { placeholder: 'e.g. RECEIVED' })),
          h('div', { class: 'grp' }, h('label', {}, 'Size'), Range(S.stampSize, { min: 8, max: 60, fmt: (v) => `${v}pt` }, (v) => setS('stampSize', v))),
          h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(ed.sub.stamp.length > 5 || STAMPS.includes(ed.sub.stamp) ? S.stampColor : S.markColor, (v) => setS(STAMPS.includes(ed.sub.stamp) ? 'stampColor' : 'markColor', v), { colors: ['#111111', '#e03131', '#2f9e44', '#1971c2'] })),
        ]
        break
      case 'note':
        body = [h('div', { class: 'grp' }, h('label', {}, 'Colour'), Swatches(S.noteColor, (v) => setS('noteColor', v), { colors: ['#ffd43b', '#8ce99a', '#74c0fc', '#ffa8a8'] }))]
        break
      case 'select':
        body = [
          pageActions(ed),
          h('div', { class: 'grp' }, h('label', {}, 'Editing'),
            Switch('Snap to edges & objects', S.snap !== false, (v) => setS('snap', v), { hint: 'Hold Alt while dragging to skip' }),
            Button({ label: 'Select all on this page', icon: 'cursor', size: 'sm', onClick: () => ed.selectAll() })),
          h('div', { class: 'tip' }, 'Tip: click a picture that’s part of the PDF to edit, save or delete it.'),
          shortcutsBlock(ed),
        ]
        break
      default:
        body = []
    }
  }
  setKids(el,
    panelHead(ed, el, head, !!sel),
    tabs(ed),
    !sel && TOOL_INFO[ed.tool] ? h('div', { class: 'tip' }, TOOL_INFO[ed.tool][1]) : null,
    body)
}

function panelHead(ed, el, head, esc = false) {
  return [
    h('div', { class: 'sheet-handle', onclick: () => el.classList.toggle('open') }, h('span', { class: 'grab' }), head, icon('chevDown', 'icon-sm')),
    h('h3', {}, head, h('span', { class: 'row', style: { gap: '6px' } }, esc ? h('span', { class: 'kbd' }, 'Esc') : null,
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm ed-drawer-x', 'aria-label': 'Close panel', onclick: () => el.classList.remove('open') }, icon('x', 'icon-sm')))),
  ]
}

function tabs(ed) {
  return h('div', { class: 'ptabs' }, Seg([['props', 'Properties'], ['layers', 'Layers', 'layers']], ed.propsTab === 'layers' ? 'layers' : 'props',
    (v) => { ed.propsTab = v; ed.refreshProps() }, { block: true }))
}

// ---------- align / multi-select ----------
function alignBlock(ed, label) {
  const b = (ic, tip, how) => Button({ icon: ic, size: 'sm', tip, onClick: () => ed.align(how) })
  const glyph = (g, tip, how) => h('button', { type: 'button', class: 'btn btn-sm btn-icon', 'data-tip': tip, 'aria-label': tip, onclick: () => ed.align(how) }, g)
  return h('div', { class: 'grp' }, h('label', {}, label),
    h('div', { class: 'btnrow' },
      b('alignL', 'Align left', 'l'), b('alignC', 'Align centre', 'c'), b('alignR', 'Align right', 'r'),
      glyph('⤒', 'Align top', 't'), glyph('⇕', 'Align middle', 'm'), glyph('⤓', 'Align bottom', 'b')))
}

function multiPanel(ed) {
  const items = ed.selected()
  const avg = Math.round((items.reduce((s, a) => s + (a.alpha ?? 1), 0) / items.length) * 100)
  return [
    alignBlock(ed, 'Align to each other'),
    h('div', { class: 'grp' }, h('label', {}, 'Distribute evenly'),
      h('div', { class: 'btnrow' },
        Button({ label: 'Across', size: 'sm', onClick: () => ed.align('dh') }),
        Button({ label: 'Down', size: 'sm', onClick: () => ed.align('dv') }))),
    h('div', { class: 'grp' }, h('label', {}, 'Opacity'),
      rangeCommit(avg, { min: 10, max: 100, fmt: (v) => `${v}%` }, (v, done) => { for (const a of items) a.alpha = v / 100; ed.redrawCurrent(); if (done) ed.commit('Style') })),
    h('div', { class: 'grp' }, h('label', {}, 'Arrange'),
      h('div', { class: 'btnrow' },
        Button({ icon: 'copy', size: 'sm', tip: 'Duplicate all', onClick: () => ed.duplicate() }),
        Button({ icon: 'front', size: 'sm', tip: 'Bring to front', onClick: () => ed.reorder('front') }),
        Button({ icon: 'back', size: 'sm', tip: 'Send to back', onClick: () => ed.reorder('back') }),
        h('span', { style: { flex: 1 } }),
        Button({ icon: 'trash', size: 'sm', variant: 'danger', tip: 'Delete all (Del)', onClick: () => ed.deleteSel() }))),
    h('div', { class: 'tip' }, 'Shift-click to add or remove items. Drag across empty space to select an area.'),
  ]
}

// ---------- layers ----------
function layersPanel(ed, page) {
  const list = page.annots.filter((a) => a.id !== 'flash')
  if (!list.length) return [h('div', { class: 'tip' }, 'Nothing added to this page yet. Everything you add shows up here — the top of the list is in front.')]
  const n = list.length
  const rows = list.slice().reverse().map((a) => {
    const name = h('span', { class: 'lname', title: 'Double-click to rename' }, a.name || TYPE_NAMES[a.t] || a.t,
      (a.t === 'text' || a.t === 'textedit') && !a.name ? h('small', {}, ` ${(a.text || '').slice(0, 24)}`) : null)
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      if (a.t === 'imgremove') return
      const inp = h('input', { class: 'input', value: a.name || TYPE_NAMES[a.t] || '' })
      inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = a.name || TYPE_NAMES[a.t] || ''; inp.blur() } })
      inp.addEventListener('blur', () => {
        const v = inp.value.trim()
        const nv = v && v !== TYPE_NAMES[a.t] ? v : undefined
        if (nv !== a.name) { a.name = nv; ed.commit('Rename') }
        ed.refreshProps()
      })
      name.replaceWith(inp)
      inp.focus()
      inp.select()
    })
    const flag = (ic, icOn, key, tip) => h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm' + (a[key] ? ' on' : ''), 'data-tip': tip, 'aria-label': tip,
      onclick: (e) => { e.stopPropagation(); ed.setFlag(page, a, key, !a[key]) },
    }, icon(a[key] ? icOn : ic, 'icon-sm'))
    return h('div', {
      class: 'layer' + (ed.selSet.has(a) ? ' on' : '') + (a.hidden ? ' off' : ''), role: 'button', tabindex: '0',
      onclick: (e) => {
        if (a.t === 'imgremove' || a.hidden || a.locked) return
        if (ed.tool !== 'select') ed.setTool('select')
        if (e.shiftKey || e.ctrlKey || e.metaKey) ed.toggleSelect(page, a); else ed.select(page, a)
      },
    },
    h('span', { class: 'lgrip' }, icon('grip', 'icon-sm')),
    icon(TYPE_ICONS[a.t] ?? 'square', 'icon-sm'),
    name,
    a.t === 'imgremove'
      ? Button({ icon: 'undo', size: 'sm', variant: 'ghost', tip: 'Bring the image back', onClick: () => { page.annots = page.annots.filter((x) => x !== a); ed.viewOf(page)?.render(); ed.commit('Restore image'); ed.refreshProps() } })
      : [flag('eye', 'eyeOff', 'hidden', a.hidden ? 'Show' : 'Hide'), flag('unlock', 'lock', 'locked', a.locked ? 'Unlock' : 'Lock')])
  })
  const box = h('div', { class: 'layers' }, rows)
  sortable(box, '.layer', (from, to) => ed.moveLayer(page, list[n - 1 - from], n - 1 - to), { horizontal: false, handle: '.lgrip' })
  return [box, h('div', { class: 'tip' }, 'Drag the grip to reorder · double-click a name to rename · the top of the list is in front.')]
}

// ---------- text effects ----------
function textEffects(ed, a, set) {
  const sub = (k, patch, done = true) => set(k, { ...(a[k] ?? {}), ...patch }, done)
  return h('details', { class: 'fxsec', open: !!(a.spacing || a.outline || a.shadow || (a.lineHeight && a.lineHeight !== 1.2)) },
    h('summary', {}, 'Spacing & effects'),
    h('div', { class: 'grp' }, h('label', {}, 'Letter spacing'), rangeCommit(a.spacing ?? 0, { min: -2, max: 20, step: 0.5, fmt: (v) => `${v}pt` }, (v, done) => set('spacing', +v, done))),
    h('div', { class: 'grp' }, h('label', {}, 'Line height'), rangeCommit(a.lineHeight ?? 1.2, { min: 0.8, max: 3, step: 0.05, fmt: (v) => `${(+v).toFixed(2)}×` }, (v, done) => set('lineHeight', +v, done))),
    Switch('Outline', !!a.outline, (v) => { set('outline', v ? { width: 1, color: '#ffffff' } : undefined); ed.refreshProps() }),
    a.outline ? h('div', { class: 'grp sub' },
      rangeCommit(a.outline.width ?? 1, { min: 0.25, max: 6, step: 0.25, fmt: (v) => `${v}pt` }, (v, done) => sub('outline', { width: +v }, done)),
      Swatches(a.outline.color ?? '#ffffff', (v) => sub('outline', { color: v }))) : null,
    Switch('Shadow', !!a.shadow, (v) => { set('shadow', v ? { opacity: 45, dx: 20, dy: 20, color: '#000000' } : undefined); ed.refreshProps() }),
    a.shadow ? h('div', { class: 'grp sub' },
      rangeCommit(a.shadow.opacity ?? 45, { min: 5, max: 100, fmt: (v) => `${v}% strength` }, (v, done) => sub('shadow', { opacity: +v }, done)),
      rangeCommit(a.shadow.dx ?? 20, { min: -100, max: 100, fmt: (v) => `${v} across` }, (v, done) => sub('shadow', { dx: +v }, done)),
      rangeCommit(a.shadow.dy ?? 20, { min: -100, max: 100, fmt: (v) => `${v} down` }, (v, done) => sub('shadow', { dy: +v }, done)),
      Swatches(a.shadow.color ?? '#000000', (v) => sub('shadow', { color: v }))) : null)
}

// ---------- images ----------
const thumbCache = new WeakMap()
/** Small previews of every preset look, made once per image source. */
function presetThumbs(ed, a) {
  const key = a.srcKey
  if (!key) return null
  if (thumbCache.has(key)) return thumbCache.get(key)
  const src = ed.imageSrc(a)
  if (!src) return null
  const k = 72 / Math.max(src.w, src.h)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(src.w * k))
  c.height = Math.max(1, Math.round(src.h * k))
  const x = c.getContext('2d')
  x.drawImage(src.canvas, 0, 0, c.width, c.height)
  const small = { rgba: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }
  const out = {}
  for (const [name, fx] of Object.entries(PRESETS)) {
    const r = processImage(small, {}, fx)
    const t = document.createElement('canvas')
    t.width = r.w
    t.height = r.h
    t.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0)
    out[name] = t.toDataURL()
  }
  thumbCache.set(key, out)
  return out
}
const PRESET_NAMES = { none: 'Original', bw: 'B&W', noir: 'Noir', sepia: 'Sepia', vintage: 'Vintage', vivid: 'Vivid', warm: 'Warm', cool: 'Cool', fade: 'Fade', dramatic: 'Drama', invert: 'Invert', pop: 'Pop' }
const ADJUST = [
  ['brightness', 'Brightness', -100, 100], ['contrast', 'Contrast', -100, 100], ['exposure', 'Exposure', -100, 100],
  ['saturation', 'Saturation', -100, 100], ['warmth', 'Warmth', -100, 100], ['tint', 'Tint', -100, 100], ['hue', 'Hue', -180, 180],
]
const EFFECTS = [['blur', 'Blur'], ['sharpen', 'Sharpen'], ['vignette', 'Vignette'], ['grain', 'Grain'], ['sepia', 'Sepia'], ['grayscale', 'Black & white']]
const rgbToHex = (c) => '#' + (c ?? [255, 255, 255]).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const hexToRgbArr = (hx) => { const n = parseInt(String(hx).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }

function imagePanel(ed, a, set, live) {
  const fx = a.fx ?? {}
  const setFx = (patch, done = true, keepPreset = false) => {
    const next = { ...(a.fx ?? {}), ...patch }
    for (const k of Object.keys(next)) if (next[k] === 0 || next[k] === null || next[k] === undefined) delete next[k]
    a.fx = Object.keys(next).length ? next : undefined
    if (!keepPreset) delete a.preset
    live()
    if (done) { ed.commit('Image'); ed.refreshProps(true) }
  }
  const slider = (k, label, min = 0, max = 100) => h('div', { class: 'grp fxrow' }, h('label', {}, label),
    rangeCommit(fx[k] ?? 0, { min, max, fmt: (v) => (v > 0 && min < 0 ? `+${v}` : String(v)) }, (v, done) => setFx({ [k]: +v }, done)))
  if (ed.cropping?.a === a) {
    const orig = a.iw / a.ih
    const cur = ed.cropAspect === null ? 'free' : Math.abs(ed.cropAspect - orig) < 1e-6 ? 'orig' : String(+ed.cropAspect.toFixed(4))
    return [
      h('div', { class: 'tip' }, icon('crop', 'icon-sm'), ' Drag the edges or corners on the page. The faded part is cut away.'),
      h('div', { class: 'grp' }, h('label', {}, 'Shape'),
        Seg([['free', 'Free'], ['1', '1:1'], ['1.3333', '4:3'], ['1.7778', '16:9'], ['0.75', '3:4'], ['orig', 'Original']], cur,
          (v) => { ed.cropAspect = v === 'free' ? null : v === 'orig' ? orig : +v; ed.refreshProps() }, { block: true })),
      h('div', { class: 'btnrow' },
        Button({ label: 'Apply crop', icon: 'check', variant: 'primary', size: 'sm', onClick: () => ed.finishCrop(true) }),
        Button({ label: 'Cancel', size: 'sm', onClick: () => ed.finishCrop(false) }),
        ed.cropping.before.crop ? Button({ label: 'Remove crop', size: 'sm', onClick: () => { const before = ed.cropping.before; ed.finishCrop(false); uncrop(a, before); ed.commit('Crop'); ed.redrawCurrent(); ed.refreshProps() } }) : null),
    ]
  }
  const thumbs = presetThumbs(ed, a)
  const bg = fx.removeBg
  return [
    h('div', { class: 'btnrow imgtools' },
      Button({ icon: 'crop', label: 'Crop', size: 'sm', onClick: () => ed.startCrop(ed.sel.page, a) }),
      Button({ label: 'Flip ↔', size: 'sm', tip: 'Flip horizontally', onClick: () => { a.flipH = !a.flipH || undefined; live(); ed.commit('Flip') } }),
      Button({ label: 'Flip ↕', size: 'sm', tip: 'Flip vertically', onClick: () => { a.flipV = !a.flipV || undefined; live(); ed.commit('Flip') } }),
      Button({ icon: 'download', size: 'sm', tip: 'Save this image as PNG', onClick: () => ed.saveImage(a) })),
    h('details', { class: 'fxsec', open: true }, h('summary', {}, 'Filters'),
      h('div', { class: 'presets' }, Object.keys(PRESETS).map((name) => h('button', {
        type: 'button', class: 'preset' + ((a.preset ?? 'none') === name ? ' on' : ''), title: PRESET_NAMES[name],
        onclick: () => {
          const keep = { removeBg: fx.removeBg, radius: fx.radius, border: fx.border, shadow: fx.shadow }
          a.fx = undefined
          a.preset = name === 'none' ? undefined : name
          setFx({ ...PRESETS[name], ...keep }, true, true)
          ed.refreshProps()
        },
      }, thumbs ? h('img', { src: thumbs[name], alt: '' }) : h('span', { class: 'ph' }), h('span', {}, PRESET_NAMES[name]))))),
    h('details', { class: 'fxsec', open: ADJUST.some(([k]) => fx[k]) }, h('summary', {}, 'Adjust'),
      ADJUST.map(([k, l, mn, mx]) => slider(k, l, mn, mx)),
      Button({ label: 'Reset adjustments', icon: 'undo', size: 'sm', variant: 'ghost', onClick: () => { setFx(Object.fromEntries([...ADJUST, ...EFFECTS].map(([k]) => [k, 0]))); ed.refreshProps() } })),
    h('details', { class: 'fxsec', open: EFFECTS.some(([k]) => fx[k]) }, h('summary', {}, 'Effects'),
      EFFECTS.map(([k, l]) => slider(k, l))),
    h('details', { class: 'fxsec', open: !!bg }, h('summary', {}, 'Remove background'),
      Switch('Remove background', !!bg, (v) => {
        const src = ed.imageSrc(a)
        const color = src ? guessBackground(src.rgba, src.w, src.h) : [255, 255, 255]
        setFx({ removeBg: v ? { color, tolerance: 25, feather: 20, contiguous: true } : null })
        ed.refreshProps()
      }, { hint: 'Works best on plain or studio backgrounds' }),
      bg ? [
        h('div', { class: 'grp fxrow' }, h('label', {}, 'Strength'), rangeCommit(bg.tolerance ?? 25, { min: 1, max: 100 }, (v, done) => setFx({ removeBg: { ...bg, tolerance: +v } }, done))),
        h('div', { class: 'grp fxrow' }, h('label', {}, 'Soft edge'), rangeCommit(bg.feather ?? 20, { min: 0, max: 100 }, (v, done) => setFx({ removeBg: { ...bg, feather: +v } }, done))),
        h('div', { class: 'grp' }, h('label', {}, 'Background colour'),
          Swatches(rgbToHex(bg.color), (v) => setFx({ removeBg: { ...bg, color: hexToRgbArr(v) } }), { colors: [...new Set(['#ffffff', '#000000', '#00ff00', rgbToHex(bg.color)])] })),
        Switch('Only the outer background', bg.contiguous !== false, (v) => setFx({ removeBg: { ...bg, contiguous: v } }), { hint: 'Off = remove that colour everywhere' }),
      ] : null),
    h('details', { class: 'fxsec', open: !!(fx.radius || fx.border || fx.shadow) }, h('summary', {}, 'Frame & shadow'),
      slider('radius', 'Rounded corners'),
      h('div', { class: 'grp fxrow' }, h('label', {}, 'Border'), rangeCommit(fx.border?.width ?? 0, { min: 0, max: 100 }, (v, done) => { setFx({ border: +v ? { color: '#ffffff', ...(fx.border ?? {}), width: +v } : null }, done); if (done) ed.refreshProps() })),
      fx.border ? Swatches(fx.border.color ?? '#ffffff', (v) => setFx({ border: { ...fx.border, color: v } })) : null,
      Switch('Drop shadow', !!fx.shadow, (v) => { setFx({ shadow: v ? { blur: 30, dx: 20, dy: 25, opacity: 45, color: '#000000' } : null }); ed.refreshProps() }),
      fx.shadow ? [
        h('div', { class: 'grp fxrow' }, h('label', {}, 'Softness'), rangeCommit(fx.shadow.blur ?? 30, { min: 0, max: 100 }, (v, done) => setFx({ shadow: { ...fx.shadow, blur: +v } }, done))),
        h('div', { class: 'grp fxrow' }, h('label', {}, 'Distance'), rangeCommit(fx.shadow.dy ?? 25, { min: 0, max: 100 }, (v, done) => setFx({ shadow: { ...fx.shadow, dx: Math.round(+v * 0.8), dy: +v } }, done))),
        h('div', { class: 'grp fxrow' }, h('label', {}, 'Strength'), rangeCommit(fx.shadow.opacity ?? 45, { min: 5, max: 100 }, (v, done) => setFx({ shadow: { ...fx.shadow, opacity: +v } }, done))),
      ] : null),
    h('div', { class: 'grp' }, h('label', {}, 'Opacity'),
      rangeCommit(Math.round((a.alpha ?? 1) * 100), { min: 5, max: 100, fmt: (v) => `${v}%` }, (v, done) => set('alpha', v / 100, done))),
    h('div', { class: 'tip' }, 'Drag a corner to resize (Shift unlocks the proportions) · drag the round handle to rotate.'),
  ]
}
/** Undo a crop that was applied before the current crop session. */
function uncrop(a, before) {
  const c = before.crop
  if (!c) return
  const kx = a.w / c.w, ky = a.h / c.h
  a.x -= c.x * kx
  a.y -= c.y * ky
  a.w = a.iw * kx
  a.h = a.ih * ky
  delete a.crop
}

function pdfImagePanel(ed) {
  const pi = ed.pdfImg
  return [
    h('div', { class: 'tip' }, 'This picture is part of the original PDF. Make it editable to crop it, add filters, remove its background, or move and resize it.'),
    Button({ label: 'Edit this image', icon: 'wand', variant: 'primary', block: true, onClick: () => ed.editPdfImage() }),
    h('div', { class: 'btnrow' },
      Button({ label: 'Save as PNG', icon: 'download', size: 'sm', onClick: () => ed.savePdfImage() }),
      Button({ label: 'Delete', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => ed.deletePdfImage() })),
    h('div', { class: 'tip' }, `${Math.round(pi.box.w)} × ${Math.round(pi.box.h)} pt on the page.`),
  ]
}

function toggleBtn(ic, tip, on, set) {
  return h('button', { type: 'button', class: 'btn btn-sm btn-icon' + (on ? ' on' : ''), 'data-tip': tip, 'aria-pressed': String(on), onclick: (e) => { const nv = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', nv); set(nv) } }, icon(ic, 'icon-sm'))
}

/** Range that reports live (done=false) and once more on release (done=true). */
function rangeCommit(value, opts, onChange) {
  const r = Range(value, opts, (v) => onChange(v, false))
  r.querySelector('input').addEventListener('change', (e) => onChange(+e.target.value, true))
  return r
}

function pageActions(ed) {
  const p = ed.currentPage()
  if (!p) return null
  return h('div', { class: 'grp' },
    h('label', {}, `Page ${ed.pages.indexOf(p) + 1} of ${ed.pages.length}`),
    h('div', { class: 'btnrow' },
      Button({ label: 'Rotate', icon: 'rotate', size: 'sm', onClick: () => ed.rotatePage(p) }),
      Button({ label: 'Duplicate', icon: 'copy', size: 'sm', onClick: () => ed.duplicatePage(p) }),
      Button({ label: 'Blank after', icon: 'pageAdd', size: 'sm', onClick: () => ed.insertBlank(p) }),
      Button({ label: 'Design & Edit', icon: 'brush', size: 'sm', tip: 'Open this page in the photo & design editor', onClick: () => ed.openInStudio(p) }),
      Button({ label: 'Delete', icon: 'trash', size: 'sm', variant: 'danger', disabled: ed.pages.length < 2, onClick: () => ed.deletePage(p) })))
}

function shortcutsBlock(ed) {
  return h('div', { class: 'grp' },
    h('label', {}, 'Shortcuts'),
    h('div', { class: 'tip' }, 'V select · E edit text · T text · P draw · H highlight · R shapes · W whiteout · X redact · I image · S sign · K stamps · N comment'),
    Button({ label: 'All keyboard shortcuts', icon: 'keyboard', size: 'sm', onClick: () => ed.showShortcuts() }))
}

/** Search-and-redact block. */
function redactSearch(ed) {
  let q = ''
  let mode = 'text'
  const results = h('div', { class: 'ed-results' })
  const status = h('div', { class: 'tip' })
  let hits = []
  const presets = { email: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', phone: '\\+?\\d[\\d\\s().-]{7,}\\d', number: '\\b\\d{4,}\\b' }
  const run = async () => {
    const query = mode === 'text' ? q : presets[mode]
    if (!query) { results.replaceChildren(); status.textContent = ''; return }
    status.textContent = 'Searching…'
    hits = await ed.searchAll(query, { regex: mode !== 'text' })
    status.textContent = hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'}` : 'No matches'
    results.replaceChildren(...hits.slice(0, 200).map((m) => h('button', { type: 'button', onclick: () => ed.flashHit(m) }, h('b', {}, `p${ed.pages.indexOf(m.page) + 1}`), ' ', m.text)))
  }
  const input = TextInput('', (v) => { q = v }, { placeholder: 'Find text to redact', onEnter: () => { mode = 'text'; run() } })
  return h('div', { class: 'grp' },
    h('label', {}, 'Search & redact'),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, input, Button({ icon: 'search', size: 'sm', tip: 'Search', onClick: () => { mode = 'text'; run() } })),
    h('div', { class: 'btnrow' },
      Button({ label: 'Emails', size: 'sm', onClick: () => { mode = 'email'; run() } }),
      Button({ label: 'Phone numbers', size: 'sm', onClick: () => { mode = 'phone'; run() } }),
      Button({ label: 'Long numbers', size: 'sm', onClick: () => { mode = 'number'; run() } })),
    status, results,
    Button({ label: 'Redact all matches', icon: 'redact', variant: 'primary', block: true, onClick: () => { if (hits.length) { ed.redactHits(hits); hits = []; results.replaceChildren(); status.textContent = 'Marked for redaction' } else toast('Search for something first', { type: 'info' }) } }))
}

