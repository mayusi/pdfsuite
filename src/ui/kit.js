// UI kit — buttons, inputs, dialogs, toasts, drop zones, sortable lists and
// lazy page thumbnails. Plain DOM; every component returns an element.
import { h, icon, setKids, fmtBytes } from './dom.js'

// ---------- buttons ----------

/** Button({label, icon, variant: primary|danger|ghost, size: sm|lg, block, busy, disabled, tip, onClick}) */
export function Button({ label = '', icon: ic, variant, size, block, busy, disabled, tip, onClick, type = 'button', cls = '', kbd } = {}) {
  return h('button', {
    type, disabled: disabled || busy,
    class: ['btn', variant && `btn-${variant}`, size && `btn-${size}`, block && 'btn-block', !label && 'btn-icon', cls].filter(Boolean).join(' '),
    'data-tip': tip, 'aria-label': tip || label || undefined, onclick: onClick,
  }, busy ? h('span', { class: 'spin' }) : ic ? icon(ic, size === 'sm' ? 'icon-sm' : 'icon') : null, label, kbd ? h('span', { class: 'kbd' }, kbd) : null)
}

export const IconButton = (ic, tip, onClick, opts = {}) => Button({ icon: ic, tip, onClick, variant: opts.variant ?? 'ghost', size: opts.size ?? 'sm', disabled: opts.disabled, cls: opts.active ? 'on' : '' })

// ---------- inputs ----------

/** Segmented control. options: [[value, label, icon?, tip?]] */
export function Seg(options, value, onChange, { block = false } = {}) {
  const el = h('div', { class: 'seg' + (block ? ' block' : ''), role: 'radiogroup' })
  const paint = (v) => {
    setKids(el, options.map(([val, label, ic, tip]) => h('button', {
      type: 'button', class: val === v ? 'on' : '', role: 'radio', 'aria-checked': String(val === v), 'data-tip': tip,
      onclick: () => { paint(val); onChange(val) },
    }, ic ? icon(ic, 'icon-sm') : null, label)))
  }
  paint(value)
  el.set = paint
  return el
}

export function Switch(label, checked, onChange, { hint } = {}) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) })
  return h('label', { class: 'switch' }, h('span', { class: 'sw-text' }, label, hint ? h('small', {}, hint) : null), input, h('span', { class: 'track' }))
}

/** Range slider with live value label. fmt(v) → string. */
export function Range(value, { min = 0, max = 100, step = 1, fmt = (v) => String(v) } = {}, onInput) {
  const val = h('span', { class: 'val' }, fmt(value))
  const input = h('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    oninput: (e) => { const v = +e.target.value; val.textContent = fmt(v); onInput(v) },
  })
  const el = h('div', { class: 'range' }, input, val)
  el.set = (v) => { input.value = String(v); val.textContent = fmt(v) }
  return el
}

export function Select(options, value, onChange) {
  return h('select', { class: 'select', onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)))
}

export function TextInput(value, onInput, { placeholder = '', type = 'text', maxlength, autocomplete = 'off', onEnter } = {}) {
  return h('input', {
    class: 'input', type, value, placeholder, maxlength, autocomplete, spellcheck: 'false',
    oninput: (e) => onInput(e.target.value),
    onkeydown: onEnter ? (e) => { if (e.key === 'Enter') onEnter() } : undefined,
  })
}

export function Field(label, control, { hint, right } = {}) {
  return h('div', { class: 'field' }, h('label', {}, h('span', {}, label), right ?? (hint ? h('span', { class: 'hint' }, hint) : null)), control)
}

export function Stepper(value, { min = -Infinity, max = Infinity, step = 1 } = {}, onChange) {
  let v = value
  const input = h('input', { value: String(v), inputmode: 'numeric', onchange: (e) => set(parseFloat(e.target.value)) })
  const set = (nv) => {
    if (!Number.isFinite(nv)) nv = v
    v = Math.min(max, Math.max(min, Math.round(nv / step) * step))
    input.value = String(+v.toFixed(2))
    onChange(v)
  }
  return h('div', { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => set(v - step) }, '−'), input,
    h('button', { type: 'button', 'aria-label': 'Increase', onclick: () => set(v + step) }, '+'))
}

export const COLORS = ['#111111', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff']
/** Colour swatches + custom picker. allowNone adds a "no colour" swatch (value null). */
export function Swatches(value, onChange, { colors = COLORS, allowNone = false } = {}) {
  const el = h('div', { class: 'swatches' })
  const paint = (v) => {
    const custom = v && !colors.includes(v)
    setKids(el,
      allowNone ? h('button', { type: 'button', class: 'swatch none' + (v === null ? ' on' : ''), title: 'None', onclick: () => { paint(null); onChange(null) } }) : null,
      colors.map((c) => h('button', { type: 'button', class: 'swatch' + (c === v ? ' on' : ''), title: c, style: { background: c }, onclick: () => { paint(c); onChange(c) } })),
      h('label', { class: 'swatch swatch-custom' + (custom ? ' on' : ''), title: 'Custom colour', style: custom ? { background: v } : {} },
        h('input', { type: 'color', value: v || '#000000', oninput: (e) => { onChange(e.target.value) }, onchange: (e) => paint(e.target.value) })))
  }
  paint(value)
  el.set = paint
  return el
}

// ---------- drop zone ----------

/**
 * Big drop target / browse button. onFiles(File[]).
 * opts: accept, multiple, title, subtitle, compact, tc (tool colour), icon, label (button)
 */
export function Dropzone({ accept = 'application/pdf', multiple = false, onFiles, title, subtitle, compact = false, tc, icon: ic = 'upload', label } = {}) {
  const input = h('input', {
    type: 'file', accept, multiple, class: 'hidden-input', tabindex: '-1',
    onchange: (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) onFiles(filterAccept(fs, accept)) },
  })
  const zone = h('div', {
    class: 'dz' + (compact ? ' compact' : ''), role: 'button', tabindex: '0', style: tc ? { '--tc': tc } : {},
    onclick: () => input.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click() } },
  },
  input,
  h('div', { class: 'dz-icon' }, icon(ic, compact ? 'icon' : 'icon-xl')),
  compact
    ? h('h2', {}, title ?? `Add ${multiple ? 'files' : 'a file'}`)
    : [h('h2', {}, title ?? `Drop your ${multiple ? 'files' : 'file'} here`),
        h('p', {}, subtitle ?? 'or'),
        h('span', { class: 'btn btn-primary btn-lg' }, icon('file', 'icon'), label ?? `Choose ${multiple ? 'files' : 'file'}`),
        h('span', { class: 'privacy' }, icon('shield', 'icon-sm'), 'Processed on your device — nothing is uploaded')])
  let depth = 0
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('over') })
  zone.addEventListener('dragover', (e) => e.preventDefault())
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over') } })
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    depth = 0
    zone.classList.remove('over')
    const fs = filterAccept([...e.dataTransfer.files], accept)
    if (fs.length) onFiles(multiple ? fs : fs.slice(0, 1))
    else if (e.dataTransfer.files.length) toast(`That file type isn't supported here`, { type: 'error' })
  })
  return zone
}

/** Keep files matching an accept string (by MIME or extension). */
export function filterAccept(files, accept) {
  const pats = accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!pats.length) return files
  return files.filter((f) => {
    const name = f.name.toLowerCase(), type = (f.type || '').toLowerCase()
    return pats.some((p) => (p.startsWith('.') ? name.endsWith(p) : p.endsWith('/*') ? type.startsWith(p.slice(0, -1)) : type === p || (p === 'application/pdf' && name.endsWith('.pdf'))))
  })
}

export function FileChip({ name, size, meta, thumb, onReplace, onRemove, extra }) {
  return h('div', { class: 'filechip' },
    thumb ?? h('div', { class: 'fc-icon' }, 'PDF'),
    h('div', { class: 'fc-main' }, h('div', { class: 'fc-name', title: name }, name), h('div', { class: 'fc-meta' }, [fmtBytes(size), meta].filter(Boolean).join(' · '))),
    extra ?? null,
    onReplace ? Button({ label: 'Replace', size: 'sm', onClick: onReplace }) : null,
    onRemove ? IconButton('x', 'Remove', onRemove) : null)
}

/** Ask for a file via a hidden input (for "Replace" / "Add" buttons). */
export function pickFiles({ accept = 'application/pdf', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, class: 'hidden-input' })
    input.addEventListener('change', () => { resolve(filterAccept([...input.files], accept)); input.remove() })
    input.addEventListener('cancel', () => { resolve([]); input.remove() })
    document.body.append(input)
    input.click()
  })
}

// ---------- feedback ----------

let toastHost = null
/** toast(msg, {type: 'ok'|'error'|'info', action: [label, fn], timeout}) */
export function toast(msg, { type = 'ok', action, timeout = type === 'error' ? 6000 : 3500 } = {}) {
  if (!toastHost || !toastHost.isConnected) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost) }
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200) }
  const el = h('div', { class: 'toast' + (type === 'error' ? ' error' : '') },
    icon(type === 'error' ? 'alert' : type === 'info' ? 'info' : 'checkCircle', 'icon-sm'),
    h('span', { class: 't-msg' }, msg),
    action ? h('button', { onclick: () => { action[1](); close() } }, action[0]) : null,
    h('button', { 'aria-label': 'Dismiss', onclick: close }, '✕'))
  toastHost.append(el)
  if (timeout) setTimeout(close, timeout)
  return close
}

/** Modal dialog. Returns {close, el}. actions: [{label, variant, onClick, keep}] */
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const prevFocus = document.activeElement
  const close = () => {
    back.remove()
    document.removeEventListener('keydown', onKey, true)
    onClose?.()
    prevFocus?.focus?.()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), IconButton('x', 'Close', close)),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => Button({ ...a, onClick: async () => { const r = await a.onClick?.(); if (!a.keep && r !== false) close() } }))) : null)
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close() } }, box)
  document.addEventListener('keydown', onKey, true)
  document.body.append(back)
  requestAnimationFrame(() => (box.querySelector('input, textarea, select, .btn-primary') ?? box).focus?.())
  return { close, el: box }
}

export function confirmDialog(title, message, { ok = 'OK', danger = false, cancel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    modal({
      title, body: h('p', { style: { margin: 0, color: 'var(--text-2)' } }, message), onClose: () => finish(false),
      actions: [{ label: cancel, onClick: () => finish(false) }, { label: ok, variant: danger ? 'danger' : 'primary', onClick: () => finish(true) }],
    })
  })
}

/** Popup menu anchored to an element. items: [{label, icon, kbd, danger, onClick} | 'sep'] */
export function menu(anchor, items, { align = 'left' } = {}) {
  const r = anchor.getBoundingClientRect()
  const close = () => { el.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true) }
  const outside = (e) => { if (!el.contains(e.target)) close() }
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => it === 'sep'
    ? h('div', { class: 'sep' })
    : h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', disabled: it.disabled, onclick: () => { close(); it.onClick() } },
      it.icon ? icon(it.icon, 'icon-sm') : null, it.label, it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null)))
  document.body.append(el)
  const mw = el.offsetWidth, mh = el.offsetHeight
  let left = align === 'right' ? r.right - mw : r.left
  let top = r.bottom + 6
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6)
  left = Math.max(8, Math.min(left, innerWidth - mw - 8))
  Object.assign(el.style, { left: `${left}px`, top: `${top}px` })
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true) })
  return close
}

export const Spinner = () => h('span', { class: 'spin' })

export function Progress(frac = null) {
  const bar = h('i', { style: { width: `${Math.round((frac ?? 0) * 100)}%` } })
  const el = h('div', { class: 'progress' + (frac === null ? ' indet' : '') }, bar)
  el.set = (f) => { el.classList.toggle('indet', f === null); bar.style.width = `${Math.round((f ?? 0) * 100)}%` }
  return el
}

export function Callout(text, { type, icon: ic } = {}) {
  return h('div', { class: 'callout' + (type ? ` ${type}` : '') }, icon(ic ?? (type === 'warn' || type === 'danger' ? 'alert' : type === 'ok' ? 'checkCircle' : 'info'), 'icon-sm'), h('div', {}, text))
}

// ---------- sortable (insert-between drag) ----------

/**
 * Drag-to-reorder for a container's direct children matching itemSel.
 * Mouse/pen start after 5px; touch after a 220ms hold (scrolling stays native).
 * onMove(from, to) — `to` is the index the item should end up at.
 * horizontal: true for grids (decides before/after by x), false for lists (by y).
 */
export function sortable(container, itemSel, onMove, { horizontal = true, handle = null } = {}) {
  let st = null
  let eat = false
  const items = () => [...container.children].filter((c) => c.matches(itemSel))
  const clearMarks = () => items().forEach((n) => n.classList.remove('drop-before', 'drop-after'))
  const start = () => {
    st.mode = 'drag'
    const r = st.el.getBoundingClientRect()
    st.offX = st.x0 - r.left
    st.offY = st.y0 - r.top
    const ghost = st.el.cloneNode(true)
    st.el.querySelectorAll('canvas').forEach((c, i) => {
      const g = ghost.querySelectorAll('canvas')[i]
      if (g) { g.width = c.width; g.height = c.height; g.getContext('2d').drawImage(c, 0, 0) }
    })
    ghost.classList.add('drag-ghost')
    Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: '0', top: '0', margin: '0' })
    document.body.append(ghost)
    st.ghost = ghost
    st.el.classList.add('drag-src')
    navigator.vibrate?.(10)
    move()
  }
  const move = () => {
    st.ghost.style.transform = `translate(${st.x - st.offX}px, ${st.y - st.offY}px)`
    clearMarks()
    const list = items()
    let target = null, after = false
    for (const n of list) {
      if (n === st.el) continue
      const r = n.getBoundingClientRect()
      if (st.x >= r.left - 8 && st.x <= r.right + 8 && st.y >= r.top - 8 && st.y <= r.bottom + 8) {
        target = n
        after = horizontal ? st.x > r.left + r.width / 2 : st.y > r.top + r.height / 2
        break
      }
    }
    st.target = target
    st.after = after
    if (target) target.classList.add(after ? 'drop-after' : 'drop-before')
    // edge auto-scroll
    const z = 60
    const sc = container.closest('.ed-scroll, .ed-thumbs') ?? null
    const vy = st.y < z ? -12 : innerHeight - st.y < z ? 12 : 0
    if (vy) (sc ?? window).scrollBy(0, vy)
  }
  const end = (commit) => {
    const { el, ghost, target, after } = st
    ghost?.remove()
    el.classList.remove('drag-src')
    clearMarks()
    const list = items()
    const from = list.indexOf(el)
    st = null
    eat = true
    if (!commit || !target) return
    let to = list.indexOf(target) + (after ? 1 : 0)
    if (to > from) to--
    if (to !== from) onMove(from, to)
  }
  container.addEventListener('pointerdown', (e) => {
    if (st || e.button) return
    const el = e.target.closest(itemSel)
    if (!el || el.parentElement !== container) return
    if (handle ? !e.target.closest(handle) : e.target.closest('button, input, select, textarea, a, .pops')) return
    eat = false
    st = { pid: e.pointerId, touch: e.pointerType === 'touch', x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, el, mode: 'pre' }
    if (st.touch) st.timer = setTimeout(() => { if (st?.mode === 'pre') { el.setPointerCapture?.(st.pid); start() } }, 220)
  })
  container.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return
    st.x = e.clientX
    st.y = e.clientY
    const d2 = (st.x - st.x0) ** 2 + (st.y - st.y0) ** 2
    if (st.mode === 'pre') {
      if (st.touch) { if (d2 > 100) { clearTimeout(st.timer); st = null } } // finger moved first → it's a scroll
      else if (d2 > 25) { st.el.setPointerCapture?.(st.pid); start() }
    } else if (st.mode === 'drag') { e.preventDefault(); move() }
  })
  const up = (e) => {
    if (!st || e.pointerId !== st.pid) return
    clearTimeout(st.timer)
    if (st.mode === 'drag') end(e.type === 'pointerup')
    else st = null
  }
  container.addEventListener('pointerup', up)
  container.addEventListener('pointercancel', up)
  container.addEventListener('lostpointercapture', (e) => { if (st && st.mode === 'drag' && e.pointerId === st.pid) end(true) })
  container.addEventListener('touchmove', (e) => { if (st?.mode === 'drag') e.preventDefault() }, { passive: false })
  container.addEventListener('click', (e) => { if (eat) { eat = false; e.preventDefault(); e.stopPropagation() } }, true)
  container.addEventListener('dragstart', (e) => e.preventDefault())
  container.addEventListener('contextmenu', (e) => { if (st) e.preventDefault() })
}

// ---------- lazy thumbnails ----------

/**
 * Renders page thumbnails on demand (when scrolled into view), a couple at a
 * time so a 300-page file doesn't freeze the tab. render(i) → Promise<canvas>.
 */
export function thumbQueue(render, { concurrency = 2, root = null } = {}) {
  const queue = []
  let active = 0
  const done = new Map()
  const pump = () => {
    while (active < concurrency && queue.length) {
      const { i, cb } = queue.shift()
      if (done.has(i)) { cb(done.get(i)); continue }
      active++
      Promise.resolve(render(i)).catch(() => null).then((cv) => {
        active--
        done.set(i, cv)
        cb(cv)
        pump()
      })
    }
  }
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (!en.isIntersecting) continue
      io.unobserve(en.target)
      en.target._thumbReq?.()
    }
  }, { root, rootMargin: '300px' }) : null
  return {
    /** Attach a lazy thumbnail for page i into `slot` (an element to fill). */
    attach(slot, i, place) {
      const req = () => {
        if (done.has(i)) { place(done.get(i)); return }
        queue.push({ i, cb: (cv) => { if (slot.isConnected) place(cv) } })
        pump()
      }
      if (done.has(i)) { place(done.get(i)); return }
      if (io) { slot._thumbReq = req; io.observe(slot) } else req()
    },
    get: (i) => done.get(i),
    invalidate(i) { if (i === undefined) done.clear(); else done.delete(i) },
    disconnect() { io?.disconnect(); queue.length = 0 },
  }
}

/** Clone a rendered canvas (DOM nodes can only live in one place). */
export function cloneCanvas(src) {
  if (!src) return null
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  c.getContext('2d').drawImage(src, 0, 0)
  return c
}

/** Show any node large in a modal (page zoom). */
export function lightbox(node, caption = '') {
  return modal({ title: caption || 'Preview', wide: true, body: node })
}
