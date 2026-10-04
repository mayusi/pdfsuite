// Contextual properties panel: edits the selected object, or sets the
// defaults for the active tool. Changes apply live; history commits once per
// gesture (sliders commit on release).
import { h, icon, setKids } from '../ui/dom.js'
import { Button, Seg, Select, Range, Stepper, Swatches, Switch, TextInput, toast } from '../ui/kit.js'
import { savedSignatures, forgetSignature } from './signature.js'

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
}

const TEXT_COLORS = ['#111111', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff']
const HL_COLORS = ['#ffe066', '#8ce99a', '#99e9f2', '#fcc2d7', '#ffc078']
const STAMPS = ['APPROVED', 'DRAFT', 'PAID', 'CONFIDENTIAL', 'REJECTED', 'FINAL', 'COPY', 'VOID']
const TYPE_NAMES = { text: 'Text', textedit: 'Edited text', stroke: 'Drawing', highlight: 'Highlight', hlrects: 'Highlight', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', whiteout: 'Whiteout', redact: 'Redaction', image: 'Image', mark: 'Mark', stamp: 'Stamp', note: 'Comment', link: 'Link' }

/** Render the panel into `el`. */
export function renderProps(ed, el) {
  const sel = ed.sel?.a
  const head = sel ? TYPE_NAMES[sel.t] ?? 'Item' : TOOL_INFO[ed.tool]?.[0]
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

  const actions = () => h('div', { class: 'grp' },
    h('label', {}, 'Arrange'),
    h('div', { class: 'btnrow' },
      Button({ icon: 'copy', size: 'sm', tip: 'Duplicate (Ctrl+D)', onClick: () => ed.duplicate() }),
      Button({ icon: 'front', size: 'sm', tip: 'Bring to front', onClick: () => ed.reorder('front') }),
      Button({ icon: 'back', size: 'sm', tip: 'Send to back', onClick: () => ed.reorder('back') }),
      ['text', 'textedit', 'image', 'stamp', 'mark'].includes(sel.t) ? Button({ icon: 'rotate', size: 'sm', tip: 'Rotate 90°', onClick: () => { sel.rot = ((sel.rot ?? 0) + 90) % 360; live(); ed.commit('Rotate') } }) : null,
      h('span', { style: { flex: 1 } }),
      Button({ icon: 'trash', size: 'sm', variant: 'danger', tip: 'Delete (Del)', onClick: () => ed.deleteSel() })))

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
      case 'rect': case 'ellipse':
        body = [
          h('div', { class: 'grp' }, h('label', {}, 'Border'), Swatches(sel.stroke ?? null, (v) => set('stroke', v), { allowNone: true })),
          h('div', { class: 'grp' }, h('label', {}, 'Fill'), Swatches(sel.fill ?? null, (v) => set('fill', v), { allowNone: true })),
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
        body = [opacity(sel, 'alpha', set), h('div', { class: 'tip' }, 'Drag a corner to resize (Shift unlocks the proportions).')]
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
          h('div', { class: 'grp' }, h('label', {}, 'Shape'), Seg([['rect', '', 'square', 'Rectangle'], ['rrect', 'R', null, 'Rounded rectangle'], ['ellipse', '', 'circle', 'Ellipse'], ['line', '', 'line', 'Line'], ['arrow', '', 'arrow', 'Arrow']], ed.sub.shape, (v) => { ed.sub.shape = v; ed.refreshProps() }, { block: true })),
          h('div', { class: 'grp' }, h('label', {}, ed.sub.shape === 'line' || ed.sub.shape === 'arrow' ? 'Colour' : 'Border'), Swatches(S.shapeStroke, (v) => setS('shapeStroke', v), { allowNone: !(ed.sub.shape === 'line' || ed.sub.shape === 'arrow') })),
          ed.sub.shape === 'line' || ed.sub.shape === 'arrow' ? null : h('div', { class: 'grp' }, h('label', {}, 'Fill'), Swatches(S.shapeFill, (v) => setS('shapeFill', v), { allowNone: true })),
          h('div', { class: 'grp' }, h('label', {}, 'Thickness'), Range(S.shapeWidth, { min: 0.5, max: 20, step: 0.5, fmt: (v) => `${v}pt` }, (v) => setS('shapeWidth', v))),
          Switch('Dashed', S.shapeDash, (v) => setS('shapeDash', v)),
        ]
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
        body = [pageActions(ed), shortcutsBlock(ed)]
        break
      default:
        body = []
    }
  }
  setKids(el,
    h('div', { class: 'sheet-handle', onclick: () => el.classList.toggle('open') }, head, icon('chevDown', 'icon-sm')),
    h('h3', {}, head, sel ? h('span', { class: 'kbd' }, 'Esc') : null),
    !sel && TOOL_INFO[ed.tool] ? h('div', { class: 'tip' }, TOOL_INFO[ed.tool][1]) : null,
    body)
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

