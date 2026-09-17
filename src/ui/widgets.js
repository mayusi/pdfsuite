import { fmtBytes, h, icon } from './dom.js'

/**
 * File drop zone — a <label> wrapping a hidden input, so clicking it opens the
 * file dialog NATIVELY. Zero JS involved in opening the picker (no recursion
 * bugs possible). Drag & drop handled separately.
 */
export function DropZone({ accept, multiple = false, onFiles, label }) {
  const input = h('input', {
    type: 'file',
    accept,
    multiple: multiple || undefined,
    class: 'hidden-input',
    onchange: (e) => {
      const files = [...e.target.files]
      if (files.length) onFiles(files)
      e.target.value = ''
    },
  })

  const zone = h(
    'label',
    {
      class: 'dropzone',
      tabindex: '0',
      role: 'button',
      onclick: (e) => {
        if (e.target === input) return // our own input.click() bubbling up — don't loop
        e.preventDefault() // kill native label forwarding; JS path opens exactly one dialog
        input.click()
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          input.click()
        }
      },
    },
    input,
    icon('upload', 'icon-lg dim'),
    h('span', { class: 'dz-text' }, label ?? `Drop ${multiple ? 'files' : 'a file'} here or `, h('em', {}, 'browse')),
  )

  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    zone.classList.add('over')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('over')
    const files = [...e.dataTransfer.files]
    if (files.length) onFiles(files)
  })
  return zone
}

/**
 * Shared pointer-drag reorder — grab an item, a ghost follows the pointer, the
 * sibling under it highlights, drop fires onDrop(from, to). Mouse/pen grabs after
 * 5px; touch grabs after a 180ms hold — moving earlier means the user is scrolling,
 * so the gesture drives window.scrollBy by hand (touch-action:none killed native).
 */
function attachPtrDrag(container, itemSel, { onDrop, targetCls }) {
  let st = null // live gesture: {pid, touch, x0, y0, x, y, lastY, el, mode, ...}
  let eatClick = false // a completed drag/scroll swallows the trailing click

  const rectsOf = () => st.nodes.map((n) => ({ n, r: n.getBoundingClientRect() }))

  const mark = (n) => {
    if (n === st.target) return
    st.target?.classList.remove(targetCls)
    st.target = n
    n?.classList.add(targetCls)
  }

  const hitTest = () => {
    if (!st.el.isConnected) return stop(false)
    const hit = st.rects.find(
      ({ n, r }) => n !== st.el && st.x >= r.left && st.x <= r.right && st.y >= r.top && st.y <= r.bottom,
    )
    mark(hit?.n ?? null)
  }

  const moveGhost = () => {
    st.ghost.style.transform = `translate(${st.x - st.offX}px, ${st.y - st.offY}px) scale(1.04)`
  }

  // edge auto-scroll: ~8px/frame scaled by proximity to viewport top/bottom
  const scrollTick = () => {
    if (!st) return
    st.raf = 0
    if (st.mode !== 'drag' || !st.vy) return
    window.scrollBy(0, st.vy)
    st.rects = rectsOf()
    hitTest()
    if (st) st.raf = requestAnimationFrame(scrollTick)
  }

  const onScroll = () => {
    if (st?.mode !== 'drag') return
    st.rects = rectsOf()
    hitTest()
  }

  const onEsc = (e) => {
    if (e.key === 'Escape' && st) stop(false)
  }

  // safety net for gestures orphaned mid-flight (container re-rendered, capture
  // stolen): a pointerup anywhere in the doc ends a drag whose card is gone
  const onDocUp = (e) => {
    if (st && e.pointerId === st.pid && st.mode === 'drag' && !st.el.isConnected) stop(false)
  }

  const activate = () => {
    st.mode = 'drag'
    st.nodes = [...container.querySelectorAll(itemSel)]
    st.rects = rectsOf()
    const r = st.el.getBoundingClientRect()
    st.offX = st.x0 - r.left
    st.offY = st.y0 - r.top
    const clone = st.el.cloneNode(true)
    const srcCv = st.el.querySelectorAll('canvas')
    clone.querySelectorAll('canvas').forEach((c, i) => {
      const s = srcCv[i]
      if (!s) return
      c.width = s.width
      c.height = s.height
      c.getContext('2d').drawImage(s, 0, 0) // cloneNode doesn't carry the bitmap
    })
    clone.style.width = '100%'
    // same-class empty shell so class-scoped styles (.filelist li) still hit the clone
    const ghost = container.cloneNode(false)
    ghost.classList.add('drag-ghost')
    ghost.removeAttribute('id')
    Object.assign(ghost.style, {
      display: 'block',
      left: '0',
      top: '0',
      width: `${r.width}px`,
      transformOrigin: `${st.offX}px ${st.offY}px`,
    })
    ghost.append(clone)
    document.body.append(ghost)
    st.ghost = ghost
    st.el.classList.add('drag-src')
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onEsc)
    document.addEventListener('pointerup', onDocUp, true)
    moveGhost()
    hitTest()
  }

  const stop = (snap) => {
    const { el, ghost, mode, timer, raf, target } = st
    if (mode !== 'pre') eatClick = true
    clearTimeout(timer)
    if (raf) cancelAnimationFrame(raf)
    window.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('keydown', onEsc)
    document.removeEventListener('pointerup', onDocUp, true)
    target?.classList.remove(targetCls)
    st = null
    if (ghost && snap && el.isConnected) {
      const r = el.getBoundingClientRect()
      ghost.style.transition = 'transform .12s ease'
      ghost.style.transform = `translate(${r.left}px, ${r.top}px) scale(1)`
      setTimeout(() => {
        ghost.remove()
        el.classList.remove('drag-src')
      }, 140)
    } else {
      ghost?.remove()
      el.classList.remove('drag-src')
    }
  }

  container.addEventListener('pointerdown', (e) => {
    if (st) {
      if (st.el.isConnected) return // one gesture at a time
      stop(false) // container was re-rendered mid-gesture — drop the stale state
    }
    eatClick = false
    if (e.button) return
    if (e.target.closest('button, .pops')) return
    const el = e.target.closest(itemSel)
    if (!el || el.parentElement !== container) return
    st = {
      pid: e.pointerId, touch: e.pointerType === 'touch',
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, lastY: e.clientY,
      el, mode: 'pre', vy: 0, raf: 0, target: null, ghost: null, timer: 0,
    }
    el.setPointerCapture(e.pointerId)
    if (st.touch) st.timer = setTimeout(() => st?.mode === 'pre' && activate(), 180)
  })

  container.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.pid) return
    st.x = e.clientX
    st.y = e.clientY
    const dx = e.clientX - st.x0
    const dy = e.clientY - st.y0
    if (st.mode === 'pre') {
      if (st.touch) {
        if (dx * dx + dy * dy > 100) {
          clearTimeout(st.timer)
          st.mode = 'scroll' // moved before the hold fired — hand-scroll instead
          window.scrollBy(0, st.lastY - e.clientY)
        }
      } else if (dx * dx + dy * dy > 25) activate()
    } else if (st.mode === 'scroll') {
      window.scrollBy(0, st.lastY - e.clientY)
    } else {
      moveGhost()
      hitTest()
      if (!st) return
      const z = 48
      st.vy = st.y < z ? -8 * (1 - st.y / z) : innerHeight - st.y < z ? 8 * (1 - (innerHeight - st.y) / z) : 0
      if (st.vy && !st.raf) st.raf = requestAnimationFrame(scrollTick)
    }
    st.lastY = e.clientY
  })

  container.addEventListener('pointerup', (e) => {
    if (!st || e.pointerId !== st.pid) return
    if (st.mode !== 'drag') {
      if (st.mode === 'scroll') eatClick = true
      clearTimeout(st.timer)
      st = null
      return
    }
    const from = st.nodes.indexOf(st.el)
    const to = st.target ? st.nodes.indexOf(st.target) : -1
    stop(to < 0)
    if (to >= 0 && to !== from) onDrop?.(from, to)
  })

  container.addEventListener('pointercancel', (e) => {
    if (!st || e.pointerId !== st.pid) return
    if (st.mode === 'drag') stop(true)
    else {
      clearTimeout(st.timer)
      st = null
    }
  })

  // capture phase beats the card's own onclick — eat the click a drag leaves behind
  container.addEventListener('click', (e) => {
    if (!eatClick) return
    eatClick = false
    e.preventDefault()
    e.stopPropagation()
  }, true)

  // kill stray native drags (images are draggable by default)
  container.addEventListener('dragstart', (e) => e.preventDefault())

  // Android fires contextmenu ~500ms into a held touch → pointercancel would
  // snap a live drag back. Only suppressed mid-gesture; normal right-click stays.
  container.addEventListener('contextmenu', (e) => { if (st) e.preventDefault() })

  // if the browser drops capture mid-gesture, release the state — otherwise st
  // wedges and every later pointerdown early-returns (dead drag until re-render)
  container.addEventListener('lostpointercapture', (e) => {
    if (!st || e.pointerId !== st.pid) return
    if (st.mode === 'drag') stop(false)
    else {
      if (st.mode === 'scroll') eatClick = true
      clearTimeout(st.timer)
      st = null
    }
  })
}

/**
 * Ordered file list — drag-to-reorder + move-up/down + remove.
 * Each item may carry .meta (extra info line, e.g. page count) and .err.
 */
export function FileList({ files, onMove, onRemove }) {
  const list = h('ul', { class: 'filelist' })
  files.forEach((f, i) => {
    const li = h(
      'li',
      {},
      f.thumbNode
        ? f.thumbNode
        : f.thumb
          ? h('img', { class: 'thumb', src: f.thumb, alt: '' })
          : h('span', { class: 'idx' }, String(i + 1)),
      h('span', { class: 'fname' }, f.name, f.meta ? h('span', { class: 'fmeta' }, f.meta) : null),
      f.err ? h('span', { class: 'ferr' }, f.err) : h('span', { class: 'fsize' }, fmtBytes(f.size)),
      f.onExpand ? iconBtn('grid', 'Show pages', (e) => { e.stopPropagation(); f.onExpand() }) : null,
      iconBtn('up', 'Move up', () => onMove(i, i - 1), i === 0),
      iconBtn('down', 'Move down', () => onMove(i, i + 1), i === files.length - 1),
      iconBtn('x', 'Remove', () => onRemove(i)),
    )
    if (f.detail) li.append(h('div', { class: 'fdetail' }, f.detail))
    list.append(li)
  })
  attachPtrDrag(list, 'li', { targetCls: 'target', onDrop: onMove })
  return list
}

export function iconBtn(iconName, title, onclick, disabled = false) {
  return h(
    'button',
    { type: 'button', class: 'iconbtn', title, onclick, disabled: disabled || undefined },
    icon(iconName, 'icon-sm'),
  )
}

/** Primary action button. */
export function Btn(label, { onclick, disabled } = {}) {
  return h('button', { type: 'button', class: 'btn', onclick, disabled: disabled || undefined }, label)
}

export function Card(...kids) {
  return h('div', { class: 'card' }, kids)
}

export function ErrorText(msg) {
  return msg ? h('p', { class: 'error' }, msg) : null
}

/**
 * Page-card grid for Organize — grab & swap drag-reorder, rotate ±90°,
 * delete/restore, click/shift select, zoom on demand.
 * items: [{page, w, h, rotation, deleted, canvas?, imgUrl?, text?}]
 * onDrop(dragIdx, targetIdx) — the card the pointer was released over.
 */
export function PageGrid({ items, onDrop, onRotate, onToggleDelete, selected, onSelect, onZoom }) {
  const grid = h('div', { class: 'pgrid' })

  items.forEach((it, i) => {
    const card = h(
      'div',
      {
        class: 'pcard' + (it.deleted ? ' deleted' : '') + (selected?.has(it) ? ' sel' : ''),
        style: { aspectRatio: it.w && it.h ? `${it.w} / ${it.h}` : '3 / 4' },
        onclick: onSelect ? (e) => onSelect(i, e.shiftKey) : undefined,
      },
      h('div', { class: 'pbody' },
        it.canvas ?? (it.imgUrl
          ? h('img', { class: 'pthumb', src: it.imgUrl, alt: '', draggable: 'false' })
          : it.text
            ? h('div', { class: 'ptext' }, it.text)
            : null),
        h('div', { class: 'pnum' }, `p${it.page}`),
        h('div', { class: 'pdim' }, `${it.w}×${it.h}`),
        it.rotation ? h('div', { class: 'prot' }, `${it.rotation}°`) : null,
      ),
      onSelect && selected?.has(it) ? h('div', { class: 'pchk' }, icon('check', 'icon-sm')) : null,
      h(
        'div',
        { class: 'pops' },
        onZoom ? iconBtn('zoom', 'View page', (e) => { e.stopPropagation(); onZoom(i) }) : null,
        iconBtn('rotl', 'Rotate −90°', (e) => { e.stopPropagation(); onRotate(i, -90) }),
        iconBtn('rotate', 'Rotate +90°', (e) => { e.stopPropagation(); onRotate(i, 90) }),
        iconBtn(it.deleted ? 'undo' : 'x', it.deleted ? 'Restore' : 'Delete', (e) => { e.stopPropagation(); onToggleDelete(i) }),
      ),
    )
    grid.append(card)
  })
  attachPtrDrag(grid, '.pcard', { targetCls: 'swap-target', onDrop })
  return grid
}

/**
 * Click-to-select page picker for Split — cards proportioned to MediaBox.
 * Click toggles; shift+click selects the range from the last click.
 * selected = Set of 1-based page numbers; onToggle(page, shiftKey).
 */
export function SelectGrid({ items, selected, onToggle, onZoom }) {
  return h(
    'div',
    { class: 'pgrid sel' },
    items.map((it) =>
      h(
        'div',
        {
          class: 'pcard pick' + (selected.has(it.page) ? ' sel' : ''),
          style: { aspectRatio: it.w && it.h ? `${it.w} / ${it.h}` : '3 / 4' },
          role: 'checkbox',
          'aria-checked': selected.has(it.page) ? 'true' : 'false',
          tabindex: '0',
          onclick: (e) => onToggle(it.page, e.shiftKey),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onToggle(it.page, e.shiftKey)
            }
          },
        },
        h('div', { class: 'pbody' },
          it.canvas ?? (it.imgUrl
            ? h('img', { class: 'pthumb', src: it.imgUrl, alt: '', draggable: 'false' })
            : it.text
              ? h('div', { class: 'ptext' }, it.text)
              : null),
          h('div', { class: 'pnum' }, `p${it.page}`),
          h('div', { class: 'pdim' }, `${it.w}×${it.h}`),
        ),
        onZoom
          ? h('button', { type: 'button', class: 'pzoom', title: 'View page', onclick: (e) => { e.stopPropagation(); onZoom(it.page) } }, icon('zoom', 'icon-sm'))
          : null,
        h('div', { class: 'pchk' }, icon('check', 'icon-sm')),
      ),
    ),
  )
}

/**
 * Image file list for Images→PDF — real thumbnails via object URLs.
 * files: [{file, url}] — caller owns URL.createObjectURL / revoke.
 */
export function ThumbList({ files, onMove, onRemove }) {
  const list = h('ul', { class: 'filelist thumbs' })
  files.forEach((f, i) => {
    const li = h(
      'li',
      {},
      h('img', { class: 'thumb', src: f.url, alt: '' }),
      h('span', { class: 'fname' }, f.file.name),
      h('span', { class: 'fsize' }, f.dims ?? fmtBytes(f.file.size)),
      iconBtn('up', 'Move up', () => onMove(i, i - 1), i === 0),
      iconBtn('down', 'Move down', () => onMove(i, i + 1), i === files.length - 1),
      iconBtn('x', 'Remove', () => onRemove(i)),
    )
    list.append(li)
  })
  attachPtrDrag(list, 'li', { targetCls: 'target', onDrop: onMove })
  return list
}

/**
 * Extracted-image results grid — real previews + per-image download.
 * images: [{name, data, w, h, mime, hash, dupCount?}]. onSave(image) downloads one.
 * Pass selected (Set) + onToggle to enable click-select.
 */
export function ImgGrid({ images, onSave, selected, onToggle }) {
  return h(
    'div',
    { class: 'igrid' },
    images.map((im) => {
      const url = URL.createObjectURL(new Blob([im.data], { type: im.mime }))
      return h(
        'div',
        {
          class: 'icard' + (selected?.has(im) ? ' sel' : ''),
          onclick: onToggle ? () => onToggle(im) : undefined,
        },
        h('img', {
          src: url,
          alt: im.name,
          loading: 'lazy',
          onload: () => URL.revokeObjectURL(url),
          onerror: () => URL.revokeObjectURL(url),
        }),
        h('div', { class: 'imeta' },
          h('span', { class: 'iname' }, im.name),
          h('span', { class: 'idim' }, `${im.w}×${im.h} · ${fmtBytes(im.data.length)}${im.dupCount > 1 ? ` · ×${im.dupCount}` : ''}`),
        ),
        onToggle && selected?.has(im) ? h('div', { class: 'pchk' }, icon('check', 'icon-sm')) : null,
        h('button', { type: 'button', class: 'isave', title: 'Download', onclick: (e) => { e.stopPropagation(); onSave(im) } }, icon('download', 'icon-sm')),
      )
    }),
  )
}

/**
 * Modal page zoom — show a canvas (or any node) large, Esc/click-out to close.
 */
export function openLightbox(node, caption = '') {
  const onKey = (e) => { if (e.key === 'Escape') close() }
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey) }
  const ov = h(
    'div',
    { class: 'lightbox', onclick: (e) => { if (e.target === ov) close() } },
    h('div', { class: 'lb-box' }, node, caption ? h('div', { class: 'lb-cap' }, caption) : null),
  )
  document.addEventListener('keydown', onKey)
  document.body.append(ov)
  return close
}

/**
 * Metadata preview table for Scrub — shows exactly what will be wiped.
 * meta: {fields: [{key, value}], xmp, id}
 */
export function MetaTable({ fields, xmp, id }) {
  const rows = fields.map((f) =>
    h('tr', {}, h('td', { class: 'mkey' }, f.key), h('td', { class: 'mval' }, f.value)),
  )
  if (xmp) rows.push(h('tr', {}, h('td', { class: 'mkey' }, 'XMP stream'), h('td', { class: 'mval' }, 'embedded metadata packet')))
  if (id) rows.push(h('tr', {}, h('td', { class: 'mkey' }, 'Document ID'), h('td', { class: 'mval' }, 'unique fingerprint in trailer')))
  if (!rows.length) return h('p', { class: 'meta dim' }, 'No metadata found — this file is already clean.')
  return h('table', { class: 'mtable' }, h('tbody', {}, rows))
}

/** Small text-button toolbar row (Organize bulk actions). */
export function Toolbar(actions) {
  return h(
    'div',
    { class: 'toolbar' },
    actions.map(([label, onclick, disabled]) =>
      h('button', { type: 'button', class: 'tbtn', onclick, disabled: disabled || undefined }, label),
    ),
  )
}
