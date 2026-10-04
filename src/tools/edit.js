// Edit PDF — full-screen workspace: tool rail, page thumbnails, continuous
// page scroll, contextual properties, undo/redo, forms, signatures, redaction.
import { h, icon, setKids, saveBlob, fmtBytes, stem, rafThrottle } from '../ui/dom.js'
import { Button, Dropzone, TextInput, Field, toast, modal, menu, confirmDialog, pickFiles, sortable, thumbQueue } from '../ui/kit.js'
import { openPdf, takeHandoff, friendly } from '../ui/tool.js'
import { rotatedCanvas } from '../ui/pages.js'
import { renderPage } from '../pdf/render.js'
import { readFields } from '../pdf/forms.js'
import { findText } from '../pdf/redact.js'
import { createPageView, rotPt } from '../editor/view.js'
import { renderProps, TOOL_INFO } from '../editor/props.js'
import { annClone, annRotate90 } from '../editor/annots.js'
import { exportEdited } from '../editor/export.js'
import { signatureDialog, sigFromUrl } from '../editor/signature.js'

const TOOLS = [
  ['select', 'cursor', 'V'], ['edittext', 'editText', 'E'], ['text', 'type', 'T'], '|',
  ['draw', 'pencil', 'P'], ['highlight', 'highlight', 'H'], ['shape', 'shapes', 'R'], '|',
  ['whiteout', 'whiteout', 'W'], ['redact', 'redact', 'X'], '|',
  ['image', 'image', 'I'], ['signature', 'signature', 'S'], ['stamp', 'stamp', 'K'], ['note', 'note', 'N'], ['link', 'link', 'L'],
]
const STYLE_KEY = 'pdfsuite-editor-style'
const DEFAULT_STYLE = {
  penColor: '#1971c2', penWidth: 2.5, penAlpha: 1, hlColor: '#ffe066', hlWidth: 14,
  textColor: '#111111', textSize: 14, font: 'helv', bold: false, italic: false, underline: false, align: 'left',
  shapeStroke: '#e03131', shapeFill: null, shapeWidth: 2, shapeAlpha: 1, shapeDash: false,
  redactColor: '#000000', stampSize: 18, stampColor: '#e03131', markColor: '#111111', noteColor: '#ffd43b',
}
let uidSeq = 0
const uid = () => `a${++uidSeq}`

function loadStyle() {
  try { return { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') } } catch { return { ...DEFAULT_STYLE } }
}

export function Edit(params = {}) {
  const root = h('div', { class: 'ed-root' })
  const ed = {
    info: null, doc: null, pages: [], views: [], zoom: 1, tool: 'select',
    sub: { shape: 'rect', hl: 'text', stamp: 'check' },
    style: loadStyle(), sel: null, editing: null, fields: [], values: {}, dirty: false,
    imgCache: new Map(), bitmaps: new WeakMap(), clipboard: null, fileName: '',
    history: [], future: [], current: null,
  }
  let els = {}
  let thumbs = null
  let io = null
  let farIo = null
  let last = null // current history snapshot

  // ---------- loading ----------
  const load = async ([f]) => {
    try {
      const info = await openPdf(f)
      if (!info) return
      ed.info = info
      ed.doc = info.doc
      ed.fileName = stem(info.name)
      ed.imgCache = new Map()
      ed.pages = info.leaves.map((_, i) => {
        const d = info.dims[i]
        const w = d.rotate % 180 === 0 ? d.w : d.h, hh = d.rotate % 180 === 0 ? d.h : d.w
        return { id: uid(), src: i, rot: 0, w, h: hh, annots: [], ops: null }
      })
      try { ed.fields = readFields(ed.doc).filter((x) => x.type !== 'button' && x.widgets.length) } catch { ed.fields = [] }
      ed.values = {}
      ed.history = []
      ed.future = []
      ed.dirty = false
      ed.sel = null
      ed.current = ed.pages[0]
      build()
      last = snapshot()
      updateChrome()
      if (params.mode === 'sign') ed.setTool('signature')
      else if (params.mode === 'redact') ed.setTool('redact')
      else if (params.mode === 'fill') {
        ed.setTool('select')
        ed.hint(ed.fields.length ? `This form has ${ed.fields.length} field${ed.fields.length === 1 ? '' : 's'} — click into them to type` : 'No fillable fields found — use the Text tool to type anywhere')
      } else if (ed.fields.length) ed.hint(`This PDF has ${ed.fields.length} form field${ed.fields.length === 1 ? '' : 's'} you can fill in`)
    } catch (e) { toast(friendly(e, f.name), { type: 'error' }) }
  }

  // ---------- shell ----------
  function empty() {
    const titles = { sign: ['Sign PDF', 'signature', 'sign'], fill: ['Fill forms', 'form', 'fill in'], redact: ['Redact PDF', 'redact', 'redact'] }
    const [t, ic, verb] = titles[params.mode] ?? ['Edit PDF', 'pencil', 'edit']
    setKids(root,
      h('div', { class: 'ed-top' },
        h('a', { class: 'btn btn-ghost btn-icon', href: '#/', 'data-tip': 'All tools', 'aria-label': 'All tools' }, icon('left')),
        h('span', { class: 'ed-name' }, t)),
      h('div', { style: { overflow: 'auto', display: 'grid', placeItems: 'center', padding: '24px 16px' } },
        h('div', { style: { width: 'min(640px, 100%)' } },
          Dropzone({ onFiles: load, title: `Drop the PDF you want to ${verb}`, tc: 'var(--c-edit)', icon: ic }))))
  }

  function build() {
    thumbs?.disconnect()
    io?.disconnect()
    farIo?.disconnect()
    els.ro?.disconnect()
    ed.views = []
    els = {}
    els.name = h('input', {
      class: 'ed-name', value: ed.fileName, 'aria-label': 'File name', spellcheck: 'false',
      onchange: (e) => { ed.fileName = e.target.value.trim() || stem(ed.info.name) },
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur() },
    })
    els.undo = Button({ icon: 'undo', size: 'sm', variant: 'ghost', tip: 'Undo (Ctrl+Z)', onClick: () => ed.undo() })
    els.redo = Button({ icon: 'redo', size: 'sm', variant: 'ghost', tip: 'Redo (Ctrl+Shift+Z)', onClick: () => ed.redo() })
    els.zoomLbl = h('button', {
      type: 'button', 'data-tip': 'Zoom options',
      onclick: (e) => menu(e.currentTarget, [
        { label: 'Fit width', icon: 'fitW', kbd: 'Ctrl+0', onClick: () => ed.fit('width') },
        { label: 'Fit page', icon: 'fit', onClick: () => ed.fit('page') },
        'sep', ...[50, 75, 100, 125, 150, 200, 300].map((z) => ({ label: `${z}%`, onClick: () => ed.setZoom(z / 100, { commit: true }) })),
      ]),
    }, '100%')
    els.pageInput = h('input', {
      value: '1', 'aria-label': 'Page number',
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { const n = parseInt(e.target.value, 10); if (n >= 1 && n <= ed.pages.length) ed.scrollToPage(ed.pages[n - 1]) } },
    })
    els.pageCount = h('span', {}, `/ ${ed.pages.length}`)
    els.download = Button({ label: 'Download', icon: 'download', variant: 'primary', size: 'sm', onClick: () => doExport({}) })
    const more = Button({
      icon: 'chevDown', variant: 'primary', size: 'sm', tip: 'More options',
      onClick: (e) => menu(e.currentTarget, [
        { label: 'Download PDF', icon: 'download', kbd: 'Ctrl+S', onClick: () => doExport({}) },
        ed.fields.length ? { label: 'Download with flattened form', icon: 'form', onClick: () => doExport({ flatten: true }) } : null,
        'sep',
        { label: 'Open another PDF', icon: 'files', onClick: async () => { if (await confirmLeave()) { const [f] = await pickFiles(); if (f) load([f]) } } },
        { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', onClick: () => ed.showShortcuts() },
      ], { align: 'right' }),
    })
    Object.assign(more.style, { borderTopLeftRadius: '0', borderBottomLeftRadius: '0', borderLeft: '1px solid rgba(0,0,0,.15)' })
    Object.assign(els.download.style, { borderTopRightRadius: '0', borderBottomRightRadius: '0' })
    const top = h('div', { class: 'ed-top' },
      h('div', { class: 'ed-title' },
        h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'data-tip': 'All tools', 'aria-label': 'Back to all tools', onclick: async () => { if (await confirmLeave()) { ed.dirty = false; location.hash = '#/' } } }, icon('left')),
        h('button', { class: 'btn btn-ghost btn-icon btn-sm ed-hide-m', 'data-tip': 'Pages panel', 'aria-label': 'Toggle pages panel', onclick: () => { els.body.classList.toggle('no-thumbs'); els.body.classList.toggle('thumbs-open') } }, icon('sidebar')),
        els.name),
      h('div', { class: 'ed-mid' },
        els.undo, els.redo, h('span', { class: 'ed-sep' }),
        h('div', { class: 'ed-zoom ed-hide-m' },
          h('button', { type: 'button', 'data-tip': 'Zoom out', 'aria-label': 'Zoom out', onclick: () => ed.setZoom(ed.zoom / 1.2, { commit: true }) }, icon('minus', 'icon-sm')),
          els.zoomLbl,
          h('button', { type: 'button', 'data-tip': 'Zoom in', 'aria-label': 'Zoom in', onclick: () => ed.setZoom(ed.zoom * 1.2, { commit: true }) }, icon('plus', 'icon-sm'))),
        h('span', { class: 'ed-sep ed-hide-m' }),
        h('span', { class: 'ed-pageind ed-hide-m' }, els.pageInput, els.pageCount)),
      h('div', { class: 'row', style: { gap: '0', flexWrap: 'nowrap' } }, els.download, more))

    els.rail = h('nav', { class: 'ed-rail', 'aria-label': 'Tools' }, TOOLS.map((t) => {
      if (t === '|') return h('span', { class: 'sep' })
      const [id, ic, key] = t
      return h('button', { type: 'button', class: 'ed-tool', 'data-tool': id, 'data-tip': `${TOOL_INFO[id][0]} (${key})`, 'data-tip-side': 'right', 'aria-label': TOOL_INFO[id][0], onclick: () => ed.setTool(id) }, icon(ic), h('span', { class: 'ed-key' }, key))
    }))
    els.thumbs = h('div', { class: 'ed-thumbs', 'aria-label': 'Pages' })
    els.pages = h('div', { class: 'ed-pages' })
    els.scroll = h('div', { class: 'ed-scroll' }, els.pages)
    els.props = h('aside', { class: 'ed-props', 'aria-label': 'Properties' })
    els.body = h('div', { class: 'ed-body' }, els.rail, els.thumbs, els.scroll, els.props)
    setKids(root, top, els.body)

    io = new IntersectionObserver((ents) => {
      for (const en of ents) {
        const v = ed.views.find((x) => x.el === en.target)
        if (!v) continue
        v.near = en.isIntersecting
        if (en.isIntersecting && v.rendered !== ed.zoom) v.render()
      }
    }, { root: els.scroll, rootMargin: '120% 0px' })
    farIo = new IntersectionObserver((ents) => {
      for (const en of ents) {
        const v = ed.views.find((x) => x.el === en.target)
        if (v && !en.isIntersecting && v.rendered) v.release()
      }
    }, { root: els.scroll, rootMargin: '450% 0px' })
    rebuildViews()
    els.scroll.addEventListener('scroll', rafThrottle(trackCurrent))
    els.scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      ed.setZoom(ed.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * 0.0022), { cx: e.clientX, cy: e.clientY, live: true })
      clearTimeout(ed._zt)
      ed._zt = setTimeout(() => ed.setZoom(ed.zoom, { commit: true }), 160)
    }, { passive: false })
    // fit as soon as the page area has a real size (it can be 0 for a frame
    // while the layout settles) and keep fitting on resize until the user zooms
    ed.userZoomed = false
    const ro = new ResizeObserver(() => {
      if (!els.scroll.clientWidth) return
      if (!ed.userZoomed) ed.fit('width', { max: 1.5, auto: true })
    })
    ro.observe(els.scroll)
    els.ro = ro
    ed.setTool(ed.tool)
    // insurance: the first pages render even if visibility notifications are late
    setTimeout(() => { for (const v of ed.views.slice(0, 2)) if (!v.rendered) v.render() }, 500)
  }

  function rebuildViews() {
    const keep = new Map(ed.views.map((v) => [v.page, v]))
    ed.views = ed.pages.map((p) => keep.get(p) ?? createPageView(ed, p))
    for (const v of keep.values()) if (!ed.views.includes(v)) { io?.unobserve(v.el); farIo?.unobserve(v.el) }
    setKids(els.pages, ed.views.map((v) => v.el))
    for (const v of ed.views) { v.layout(); io.observe(v.el); farIo.observe(v.el) }
    ed.current = ed.pages.includes(ed.current) ? ed.current : ed.pages[0]
    buildThumbs()
    if (els.pageCount) els.pageCount.textContent = `/ ${ed.pages.length}`
    trackCurrent()
  }

  function buildThumbs() {
    thumbs?.disconnect()
    const cache = new Map()
    thumbs = thumbQueue((src) => renderPage(ed.doc, ed.info.leaves[src], { width: 240, cache }), { root: els.thumbs })
    setKids(els.thumbs,
      ed.pages.map((p, i) => {
        const tw = h('div', { class: 'tw' }, h('div', { class: 'tskel', style: { aspectRatio: `${p.w} / ${p.h}` } }))
        if (p.src !== null) thumbs.attach(tw, p.src, (cv) => { if (cv) tw.replaceChildren(rotatedCanvas(cv, p.rot)) })
        else tw.replaceChildren(h('canvas', { width: Math.round(120 * (p.w / p.h)), height: 120, style: { width: '100%' } }))
        const op = (ic, tip, fn, cls = '') => h('span', { class: cls, role: 'button', 'data-tip': tip, 'aria-label': tip, onclick: (e) => { e.stopPropagation(); fn() } }, icon(ic, 'icon-sm'))
        return h('button', { type: 'button', class: 'ed-thumb' + (p === ed.current ? ' cur' : ''), 'data-id': p.id, onclick: () => ed.scrollToPage(p) },
          h('div', { class: 'tops' },
            op('rotate', 'Rotate', () => ed.rotatePage(p)),
            op('copy', 'Duplicate', () => ed.duplicatePage(p)),
            ed.pages.length > 1 ? op('trash', 'Delete page', () => ed.deletePage(p), 'danger') : null),
          tw, `${i + 1}`)
      }),
      h('button', { class: 'ed-addpage', onclick: () => ed.insertBlank(ed.pages[ed.pages.length - 1]) }, icon('plus', 'icon-sm'), 'Blank page'))
    sortable(els.thumbs, '.ed-thumb', (from, to) => {
      const [p] = ed.pages.splice(from, 1)
      ed.pages.splice(to, 0, p)
      rebuildViews()
      ed.commit('Move page')
    }, { horizontal: false })
  }

  function trackCurrent() {
    if (!els.scroll) return
    const mid = els.scroll.getBoundingClientRect().top + els.scroll.clientHeight * 0.35
    let best = null, bd = Infinity
    for (const v of ed.views) {
      const r = v.el.getBoundingClientRect()
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid))
      if (d < bd) { bd = d; best = v }
    }
    if (best && best.page !== ed.current) ed.setCurrentPage(best.page, true)
    else if (best && els.pageInput && document.activeElement !== els.pageInput) els.pageInput.value = String(ed.pages.indexOf(best.page) + 1)
  }

  // ---------- API used by views / props ----------
  ed.setCurrentPage = (p, fromScroll = false) => {
    if (ed.current === p && !fromScroll) return
    ed.current = p
    for (const v of ed.views) v.el.classList.toggle('cur', v.page === p)
    els.thumbs?.querySelectorAll('.ed-thumb').forEach((t) => t.classList.toggle('cur', t.dataset.id === p.id))
    if (els.pageInput && document.activeElement !== els.pageInput) els.pageInput.value = String(ed.pages.indexOf(p) + 1)
    if (fromScroll) els.thumbs?.querySelector('.ed-thumb.cur')?.scrollIntoView({ block: 'nearest' })
    if (ed.tool === 'select' && !ed.sel) ed.refreshProps()
  }
  ed.currentPage = () => ed.current
  ed.scrollToPage = (p) => {
    const v = ed.views.find((x) => x.page === p)
    if (!v) return
    els.scroll.scrollTo({ top: v.el.offsetTop - 24, behavior: 'smooth' })
    ed.setCurrentPage(p)
  }
  ed.viewOf = (p) => ed.views.find((v) => v.page === p)
  ed.redrawCurrent = () => ed.viewOf(ed.sel ? ed.sel.page : ed.current)?.redraw()
  ed.redrawAll = () => ed.views.forEach((v) => v.redraw())
  ed.dirtyChrome = () => { ed.dirty = true }

  ed.setTool = (t) => {
    ed.closeEditor(true)
    if (t === 'image') { ed.insertImage(); return }
    ed.tool = t
    els.rail?.querySelectorAll('.ed-tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t))
    for (const v of ed.views) {
      v.over.style.cursor = t === 'select' ? 'default' : t === 'edittext' || t === 'text' ? 'text' : 'crosshair'
      v.over.style.touchAction = t === 'select' ? 'pan-x pan-y' : 'none'
      if ((t === 'edittext' || t === 'redact' || t === 'highlight') && v.near) v.getRuns().then(() => v.redraw())
    }
    if (t !== 'select') ed.select(null)
    ed.refreshProps()
    ed.hintTool()
  }
  ed.hintTool = () => {
    const tips = {
      edittext: 'Click any text to change it', text: 'Click to add text — drag sideways for a wrapping box',
      highlight: ed.sub.hl === 'text' ? 'Drag across text to highlight it' : 'Draw to highlight',
      redact: 'Drag boxes over sensitive content — or search on the right', stamp: 'Click to place the mark',
      note: 'Click to add a comment', link: 'Drag over the area to make clickable', signature: 'Create or pick a signature on the right',
    }
    if (tips[ed.tool]) ed.hint(tips[ed.tool])
  }
  let hintEl = null
  let hintT = 0
  ed.hint = (msg) => {
    hintEl?.remove()
    hintEl = h('div', { class: 'ed-hint', role: 'status' }, msg)
    root.append(hintEl)
    if (els.scroll) {
      const r = els.scroll.getBoundingClientRect()
      hintEl.style.position = 'fixed'
      hintEl.style.left = `${r.left + r.width / 2}px`
    }
    clearTimeout(hintT)
    hintT = setTimeout(() => hintEl?.remove(), 2800)
  }

  ed.select = (page, a) => {
    if (!page) {
      if (!ed.sel) return
      const old = ed.sel
      ed.sel = null
      ed.viewOf(old.page)?.redraw()
      ed.refreshProps()
      return
    }
    const prev = ed.sel
    ed.sel = { page, a }
    if (prev && prev.page !== page) ed.viewOf(prev.page)?.redraw()
    ed.viewOf(page)?.redraw()
    ed.refreshProps()
  }
  let propsT = 0
  ed.refreshProps = (soft = false) => {
    if (!els.props) return
    clearTimeout(propsT)
    if (soft) { propsT = setTimeout(() => renderProps(ed, els.props), 150); return }
    renderProps(ed, els.props)
  }

  ed.add = (page, a, { select = true, silent = false } = {}) => {
    a.id = uid()
    page.annots.push(a)
    if (select) ed.select(page, a); else ed.viewOf(page)?.redraw()
    if (!silent) ed.commit('Add')
    return a
  }
  ed.deleteSel = () => {
    if (!ed.sel) return
    const { page, a } = ed.sel
    page.annots = page.annots.filter((x) => x !== a)
    ed.sel = null
    if (a.t === 'textedit') ed.viewOf(page)?.render() // bring the original text back
    else ed.viewOf(page)?.redraw()
    ed.refreshProps()
    ed.commit('Delete')
  }
  const move = (a, dx, dy) => {
    if (a.pts) a.pts = a.pts.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)])
    if (a.rects) a.rects = a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }))
    if (a.x1 !== undefined) { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy }
    if (a.x !== undefined) { a.x += dx; a.y += dy }
  }
  ed.duplicate = () => {
    if (!ed.sel) return
    const { page, a } = ed.sel
    if (a.t === 'textedit') { toast('Edited text can’t be duplicated — use the Text tool instead', { type: 'info' }); return }
    const c = annClone(a)
    move(c, 12, 12)
    ed.add(page, c)
  }
  ed.reorder = (where) => {
    if (!ed.sel) return
    const { page, a } = ed.sel
    page.annots = page.annots.filter((x) => x !== a)
    if (where === 'front') page.annots.push(a); else page.annots.unshift(a)
    ed.viewOf(page)?.redraw()
    ed.commit('Arrange')
  }
  ed.editSelected = () => { if (ed.sel && (ed.sel.a.t === 'text' || ed.sel.a.t === 'textedit')) ed.viewOf(ed.sel.page)?.editText(ed.sel.a) }
  ed.dblClick = (page, a) => {
    if (a.t === 'text' || a.t === 'textedit') ed.viewOf(page)?.editText(a)
    else if (a.t === 'note') ed.editNote(page, a)
    else if (a.t === 'link') ed.editLink(page, a)
  }
  ed.closeEditor = (commit) => {
    const e = ed.editing
    if (!e) return
    ed.editing = null
    e.el.remove()
    const { a, page } = e
    if (a.t === 'text' && !a.text.trim()) {
      page.annots = page.annots.filter((x) => x !== a)
      if (ed.sel?.a === a) ed.sel = null
    } else if (a.t === 'textedit' && a.text === a.origText && e.before === a.origText) {
      // untouched: drop the edit and bring the original back
      page.annots = page.annots.filter((x) => x !== a)
      if (ed.sel?.a === a) ed.sel = null
      ed.viewOf(page)?.render()
      ed.viewOf(page)?.redraw()
      ed.refreshProps()
      return
    }
    ed.viewOf(page)?.redraw()
    ed.refreshProps()
    if (commit && (a.text !== e.before || a.t === 'textedit')) ed.commit('Text')
  }

  ed.editNote = (page, a, isNew = false) => {
    let text = a.text
    const ta = h('textarea', { class: 'textarea', rows: '5', placeholder: 'Write a comment…', oninput: (e) => (text = e.target.value) })
    ta.value = a.text
    modal({
      title: isNew ? 'Add a comment' : 'Edit comment', body: [ta],
      onClose: () => { if (isNew && !a.text) { page.annots = page.annots.filter((x) => x !== a); ed.sel = null; ed.viewOf(page)?.redraw(); ed.refreshProps() } },
      actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'primary', onClick: () => { a.text = text; isNew = false; ed.commit('Comment'); ed.refreshProps(); ed.viewOf(page)?.redraw() } }],
    })
  }
  ed.editLink = (page, a, isNew = false) => {
    let url = a.url
    const input = TextInput(a.url, (v) => (url = v), { placeholder: 'https://example.com', type: 'url' })
    modal({
      title: isNew ? 'Link to a web address' : 'Edit link', body: [Field('Web address', input)],
      onClose: () => { if (isNew && !a.url) { page.annots = page.annots.filter((x) => x !== a); ed.sel = null; ed.viewOf(page)?.redraw(); ed.refreshProps() } },
      actions: [{ label: 'Cancel' }, { label: 'Save link', variant: 'primary', onClick: () => {
        if (!url.trim()) { toast('Enter a web address', { type: 'error' }); return false }
        a.url = url.trim(); isNew = false; ed.commit('Link'); ed.refreshProps()
      } }],
    })
  }
  ed.contextMenu = (e, page, a) => {
    const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }
    menu(anchor, [
      a.t === 'text' || a.t === 'textedit' ? { label: 'Edit text', icon: 'pencil', kbd: 'Enter', onClick: () => ed.dblClick(page, a) } : null,
      { label: 'Duplicate', icon: 'copy', kbd: 'Ctrl+D', onClick: () => ed.duplicate() },
      { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', onClick: () => copySel() },
      { label: 'Bring to front', icon: 'front', onClick: () => ed.reorder('front') },
      { label: 'Send to back', icon: 'back', onClick: () => ed.reorder('back') },
      'sep',
      { label: 'Delete', icon: 'trash', danger: true, kbd: 'Del', onClick: () => ed.deleteSel() },
    ])
  }

  // ---------- images & signatures ----------
  ed.bitmap = (a) => {
    if (a.t !== 'image') return null
    const key = a.srcKey ?? a
    const b = ed.bitmaps.get(key)
    if (b !== undefined) return b
    ed.bitmaps.set(key, null)
    ;(async () => {
      if (a.rgba) {
        const c = document.createElement('canvas')
        c.width = a.iw
        c.height = a.ih
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(a.rgba), a.iw, a.ih), 0, 0)
        return c
      }
      return createImageBitmap(new Blob([a.jpeg], { type: 'image/jpeg' }))
    })().then((bm) => {
      ed.bitmaps.set(key, bm)
      for (const v of ed.views) if (v.page.annots.some((x) => (x.srcKey ?? x) === key)) v.redraw()
    }).catch(() => {})
    return null
  }
  const placeOnPage = (img, opts = {}) => {
    const p = ed.current ?? ed.pages[0]
    let w = opts.w ?? Math.min(p.w * 0.4, img.iw * 0.75)
    let hh = (w * img.ih) / img.iw
    if (hh > p.h * 0.6) { hh = p.h * 0.6; w = (hh * img.iw) / img.ih }
    const v = ed.viewOf(p)
    const sr = els.scroll.getBoundingClientRect(), pr = v.el.getBoundingClientRect()
    const cy = Math.min(p.h - hh / 2, Math.max(hh / 2, ((sr.top + sr.height / 2 - pr.top) / pr.height) * p.h))
    const a = { t: 'image', x: opts.x ?? (p.w - w) / 2, y: opts.y ?? cy - hh / 2, w, h: hh, ...img, alpha: 1 }
    if (ed.tool !== 'select') ed.setTool('select')
    ed.add(p, a)
    return a
  }
  ed.insertImage = async () => {
    const [f] = await pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp' })
    if (!f) return
    try {
      const bmp = await createImageBitmap(f)
      const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height))
      const c = document.createElement('canvas')
      c.width = Math.round(bmp.width * k)
      c.height = Math.round(bmp.height * k)
      const x = c.getContext('2d')
      x.drawImage(bmp, 0, 0, c.width, c.height)
      bmp.close?.()
      let img
      if (/jpe?g/i.test(f.type)) {
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
        img = { jpeg: new Uint8Array(await blob.arrayBuffer()), iw: c.width, ih: c.height }
      } else img = { rgba: x.getImageData(0, 0, c.width, c.height).data, iw: c.width, ih: c.height }
      img.srcKey = {}
      placeOnPage(img)
    } catch { toast('Couldn’t read that image', { type: 'error' }) }
  }
  ed.newSignature = async () => {
    const sig = await signatureDialog()
    if (sig) { await ed.placeSignature(sig); ed.refreshProps() }
  }
  ed.placeSignature = async (sigOrUrl, box = null) => {
    const sig = typeof sigOrUrl === 'string' ? await sigFromUrl(sigOrUrl) : sigOrUrl
    const img = { rgba: sig.rgba, iw: sig.iw, ih: sig.ih, srcKey: {} }
    if (box) {
      const k = Math.min(box.w / img.iw, box.h / img.ih)
      const w = img.iw * k, hh = img.ih * k
      return placeOnPage(img, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - hh) / 2, w })
    }
    return placeOnPage(img, { w: Math.min(ed.current.w * 0.32, 200) })
  }
  ed.signField = async (page, rect) => {
    ed.setCurrentPage(page)
    const sig = await signatureDialog()
    if (sig) ed.placeSignature(sig, rect)
  }

  ed.setField = (name, value) => { ed.values[name] = value; ed.dirty = true }

  // ---------- search & redact ----------
  ed.searchAll = async (query, opts) => {
    const out = []
    for (const p of ed.pages) {
      if (p.src === null) continue
      const hits = await findText(ed.doc, ed.info.leaves[p.src], query, opts).catch(() => [])
      const W0 = p.rot % 180 ? p.h : p.w, H0 = p.rot % 180 ? p.w : p.h
      for (const r of hits) {
        const [x1, y1] = rotPt(r.x, r.y, p.rot, W0, H0), [x2, y2] = rotPt(r.x + r.w, r.y + r.h, p.rot, W0, H0)
        out.push({ page: p, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), text: r.text })
      }
    }
    return out
  }
  ed.flashHit = (m) => {
    ed.scrollToPage(m.page)
    const a = { t: 'rect', x: m.x - 2, y: m.y - 2, w: m.w + 4, h: m.h + 4, stroke: '#e03131', lw: 2, id: 'flash' }
    m.page.annots.push(a)
    ed.viewOf(m.page)?.redraw()
    setTimeout(() => { m.page.annots = m.page.annots.filter((x) => x !== a); ed.viewOf(m.page)?.redraw() }, 1300)
  }
  ed.redactHits = (hits) => {
    for (const m of hits) m.page.annots.push({ id: uid(), t: 'redact', x: m.x, y: m.y, w: m.w, h: m.h, fill: ed.style.redactColor })
    ed.redrawAll()
    ed.commit('Redact')
    toast(`${hits.length} area${hits.length === 1 ? '' : 's'} marked — permanently removed when you download`)
  }

  // ---------- pages ----------
  ed.rotatePage = (p) => {
    const W = p.w, H = p.h
    for (const a of p.annots) annRotate90(a, W, H)
    p.rot = (p.rot + 90) % 360
    p.w = H
    p.h = W
    const v = ed.viewOf(p)
    v.invalidateRuns()
    v.layout()
    v.render()
    buildThumbs()
    ed.commit('Rotate page')
  }
  ed.deletePage = async (p) => {
    if (ed.pages.length < 2) return
    if (p.annots.length && !(await confirmDialog('Delete this page?', 'It has edits on it. You can undo this.', { ok: 'Delete page', danger: true }))) return
    ed.pages = ed.pages.filter((x) => x !== p)
    if (ed.sel?.page === p) ed.sel = null
    rebuildViews()
    ed.commit('Delete page')
  }
  ed.duplicatePage = (p) => {
    const c = { ...p, id: uid(), annots: p.annots.filter((a) => a.t !== 'textedit').map((a) => ({ ...annClone(a), id: uid() })) }
    ed.pages.splice(ed.pages.indexOf(p) + 1, 0, c)
    rebuildViews()
    ed.commit('Duplicate page')
  }
  ed.insertBlank = (after) => {
    const p = { id: uid(), src: null, rot: 0, w: after?.w ?? 612, h: after?.h ?? 792, annots: [] }
    ed.pages.splice(after ? ed.pages.indexOf(after) + 1 : ed.pages.length, 0, p)
    rebuildViews()
    ed.scrollToPage(p)
    ed.commit('Blank page')
  }

  // ---------- zoom ----------
  ed.setZoom = (z, { cx, cy, live = false, commit = false, auto = false } = {}) => {
    if (!auto) ed.userZoomed = true
    const nz = Math.max(0.2, Math.min(5, z))
    const sc = els.scroll
    const r = sc.getBoundingClientRect()
    const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top
    const ax = px + sc.scrollLeft, ay = py + sc.scrollTop
    const k = nz / ed.zoom
    ed.zoom = nz
    if (ed.editing) ed.closeEditor(true)
    for (const v of ed.views) v.layout()
    sc.scrollLeft = ax * k - px
    sc.scrollTop = ay * k - py
    els.zoomLbl.textContent = `${Math.round(nz * 100)}%`
    if (!live || commit) {
      clearTimeout(ed._rz)
      ed._rz = setTimeout(() => { for (const v of ed.views) if (v.near) v.render() }, 40)
    }
  }
  ed.fit = (mode, { max = 5, auto = false } = {}) => {
    const sc = els.scroll
    if (!sc.clientWidth) return
    if (!auto) ed.userZoomed = true
    const maxW = Math.max(...ed.pages.map((p) => p.w))
    const cur = ed.current ?? ed.pages[0]
    const z = mode === 'page' ? Math.min((sc.clientWidth - 48) / cur.w, (sc.clientHeight - 60) / cur.h) : (sc.clientWidth - 48) / maxW
    ed.setZoom(Math.min(max, z), { commit: true, auto })
    if (mode === 'page') ed.scrollToPage(cur)
  }

  // ---------- history ----------
  function snapshot() {
    return { pages: ed.pages.map((p) => ({ ...p, annots: p.annots.map((a) => annClone(a)) })), values: { ...ed.values } }
  }
  ed.commit = () => {
    if (last) { ed.history.push(last); if (ed.history.length > 80) ed.history.shift() }
    last = snapshot()
    ed.future = []
    ed.dirty = true
    updateChrome()
  }
  const restore = (s) => {
    const structural = s.pages.length !== ed.pages.length || s.pages.some((p, i) => p.id !== ed.pages[i].id || p.rot !== ed.pages[i].rot)
    const prevById = new Map(ed.pages.map((p) => [p.id, p]))
    ed.pages = s.pages.map((sp) => {
      const live = prevById.get(sp.id)
      if (live && live.rot === sp.rot) { live.annots = sp.annots.map((a) => annClone(a)); return live }
      return { ...sp, annots: sp.annots.map((a) => annClone(a)) }
    })
    ed.values = { ...s.values }
    ed.sel = null
    if (structural) rebuildViews()
    for (const v of ed.views) { v.invalidateRuns(); if (v.near || v.rendered) v.render(); v.layoutFields() }
    ed.refreshProps()
    updateChrome()
  }
  ed.undo = () => {
    ed.closeEditor(true)
    if (!ed.history.length) return
    ed.future.push(last)
    last = ed.history.pop()
    restore(last)
  }
  ed.redo = () => {
    if (!ed.future.length) return
    ed.history.push(last)
    last = ed.future.pop()
    restore(last)
  }
  function updateChrome() {
    if (!els.undo) return
    els.undo.disabled = !ed.history.length
    els.redo.disabled = !ed.future.length
  }

  // ---------- clipboard ----------
  const copySel = () => {
    if (ed.sel && ed.sel.a.t !== 'textedit') { ed.clipboard = annClone(ed.sel.a); toast('Copied', { type: 'info', timeout: 1200 }) }
  }
  const paste = () => {
    if (!ed.clipboard) return
    const c = annClone(ed.clipboard)
    move(c, 14, 14)
    ed.clipboard = annClone(c)
    ed.add(ed.current, c)
  }

  // ---------- export ----------
  async function doExport({ flatten = false }) {
    ed.closeEditor(true)
    const btn = els.download
    btn.disabled = true
    const label = btn.lastChild
    const orig = label.textContent
    try {
      const anyField = Object.keys(ed.values).length > 0
      const out = await exportEdited(ed.info, ed.pages, {
        forms: anyField || flatten ? { values: ed.values, flatten } : null,
        onStep: (s) => { label.textContent = `${s}…` },
      })
      const baseName = (ed.fileName || stem(ed.info.name)).replace(/\.pdf$/i, '')
      const name = `${baseName}${baseName === stem(ed.info.name) ? '-edited' : ''}.pdf`
      saveBlob(new Blob([out], { type: 'application/pdf' }), name)
      ed.dirty = false
      toast(`Saved ${name} · ${fmtBytes(out.length)}`)
    } catch (e) {
      console.error(e)
      toast(`Couldn’t save: ${friendly(e)}`, { type: 'error' })
    } finally {
      btn.disabled = false
      label.textContent = orig
    }
  }
  ed._export = doExport // test hook

  const confirmLeave = async () => !ed.dirty || confirmDialog('Leave without saving?', 'Your edits haven’t been downloaded yet. They’ll be lost if you leave.', { ok: 'Leave', danger: true, cancel: 'Stay' })
  const onBeforeUnload = (e) => { if (ed.dirty && root.isConnected) { e.preventDefault(); e.returnValue = '' } }
  addEventListener('beforeunload', onBeforeUnload)

  ed.showShortcuts = () => {
    const rows = [['V', 'Select'], ['E', 'Edit existing text'], ['T', 'Add text'], ['P', 'Draw'], ['H', 'Highlight'], ['R', 'Shapes'], ['W', 'Whiteout'], ['X', 'Redact'], ['I', 'Image'], ['S', 'Signature'], ['K', 'Stamps'], ['N', 'Comment'], ['L', 'Link'],
      ['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'], ['Ctrl+C / Ctrl+V', 'Copy / paste'], ['Ctrl+D', 'Duplicate'], ['Del', 'Delete selection'], ['Arrows', 'Nudge (Shift = 10pt)'], ['Enter', 'Edit selected text'], ['Esc', 'Deselect / back to Select'],
      ['Ctrl + / Ctrl −', 'Zoom'], ['Ctrl+0', 'Fit width'], ['Ctrl+wheel / pinch', 'Zoom at cursor'], ['Ctrl+S', 'Download'], ['PgUp / PgDn', 'Previous / next page'], ['Shift while drawing', 'Squares, circles, 45° lines']]
    modal({ title: 'Keyboard shortcuts', wide: true, body: h('div', { class: 'kbgrid' }, rows.map(([k, d]) => h('div', {}, h('span', {}, d), h('span', { class: 'kbd' }, k)))) })
  }
  ed.saveStyle = () => { try { localStorage.setItem(STYLE_KEY, JSON.stringify(ed.style)) } catch { /* private mode */ } }

  // ---------- keyboard ----------
  const KEYMAP = Object.fromEntries(TOOLS.filter((t) => t !== '|').map(([id, , k]) => [k.toLowerCase(), id]))
  const onKey = (e) => {
    if (!root.isConnected) { cleanup(); return }
    if (!ed.info || document.querySelector('.modal-back, .menu')) return
    if (/input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); ed.undo() }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); ed.redo() }
    else if (mod && k === 's') { e.preventDefault(); doExport({}) }
    else if (mod && k === 'c') copySel()
    else if (mod && k === 'v') { e.preventDefault(); paste() }
    else if (mod && k === 'd') { e.preventDefault(); ed.duplicate() }
    else if (mod && (k === '=' || k === '+')) { e.preventDefault(); ed.setZoom(ed.zoom * 1.2, { commit: true }) }
    else if (mod && k === '-') { e.preventDefault(); ed.setZoom(ed.zoom / 1.2, { commit: true }) }
    else if (mod && k === '0') { e.preventDefault(); ed.fit('width') }
    else if (mod && ['b', 'i', 'u'].includes(k) && ed.sel && /text/.test(ed.sel.a.t)) {
      e.preventDefault()
      const key = { b: 'bold', i: 'italic', u: 'underline' }[k]
      ed.sel.a[key] = !ed.sel.a[key]
      ed.redrawCurrent(); ed.refreshProps(); ed.commit('Style')
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && ed.sel) { e.preventDefault(); ed.deleteSel() }
    else if (e.key === 'Escape') { if (ed.sel) ed.select(null); else if (ed.tool !== 'select') ed.setTool('select') }
    else if (e.key.startsWith('Arrow') && ed.sel) {
      e.preventDefault()
      const d = e.shiftKey ? 10 : 1
      move(ed.sel.a, e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)
      ed.redrawCurrent()
      clearTimeout(ed._nt)
      ed._nt = setTimeout(() => ed.commit('Nudge'), 400)
    } else if (e.key === 'Enter' && ed.sel && /text/.test(ed.sel.a.t)) { e.preventDefault(); ed.editSelected() }
    else if (e.key === '?') ed.showShortcuts()
    else if (!mod && !e.altKey && KEYMAP[k]) { e.preventDefault(); ed.setTool(KEYMAP[k]) }
    else if (e.key === 'PageDown' || e.key === 'PageUp') {
      const i = ed.pages.indexOf(ed.current) + (e.key === 'PageDown' ? 1 : -1)
      if (ed.pages[i]) { e.preventDefault(); ed.scrollToPage(ed.pages[i]) }
    }
  }
  document.addEventListener('keydown', onKey)
  function cleanup() {
    document.removeEventListener('keydown', onKey)
    removeEventListener('beforeunload', onBeforeUnload)
    io?.disconnect()
    farIo?.disconnect()
    thumbs?.disconnect()
    els.ro?.disconnect()
  }
  // the router swaps the whole app on navigation: notice when we're detached
  const mo = new MutationObserver(() => { if (!root.isConnected) { cleanup(); mo.disconnect() } })
  requestAnimationFrame(() => mo.observe(document.getElementById('app') ?? document.body, { childList: true }))

  window.__pdfsuiteEditor = ed // devtools / automated tests
  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else empty()
  return root
}
