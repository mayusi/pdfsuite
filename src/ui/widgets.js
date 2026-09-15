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
 * Ordered file list — drag-to-reorder + move-up/down + remove.
 * Each item may carry .meta (extra info line, e.g. page count) and .err.
 */
export function FileList({ files, onMove, onRemove }) {
  let dragIdx = null
  const list = h('ul', { class: 'filelist' })
  files.forEach((f, i) => {
    const li = h(
      'li',
      {
        draggable: 'true',
        ondragstart: (e) => {
          dragIdx = i
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', '') // required for drag to fire
        },
        ondragend: () => {
          dragIdx = null
          list.querySelectorAll('li').forEach((x) => x.classList.remove('target'))
        },
        ondragover: (e) => {
          e.preventDefault()
          li.classList.add('target')
        },
        ondragleave: () => li.classList.remove('target'),
        ondrop: (e) => {
          e.preventDefault()
          li.classList.remove('target')
          if (dragIdx !== null && dragIdx !== i) onMove(dragIdx, i)
        },
      },
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
 * Page-card grid for Organize — drag-reorder, rotate ±90°, delete/restore,
 * click/shift select, insertion-line drop indicator, zoom on demand.
 * items: [{page, w, h, rotation, deleted, canvas?, imgUrl?, text?}]
 */
export function PageGrid({ items, onReorder, onRotate, onToggleDelete, selected, onSelect, onZoom }) {
  let dragIdx = null
  const grid = h('div', { class: 'pgrid' })

  const clearMarks = () => grid.querySelectorAll('.pcard').forEach((c) => c.classList.remove('target', 'drop-before', 'drop-after'))

  items.forEach((it, i) => {
    const card = h(
      'div',
      {
        class: 'pcard' + (it.deleted ? ' deleted' : '') + (selected?.has(it) ? ' sel' : ''),
        style: { aspectRatio: it.w && it.h ? `${it.w} / ${it.h}` : '3 / 4' },
        draggable: 'true',
        onclick: onSelect ? (e) => onSelect(i, e.shiftKey) : undefined,
        ondragstart: (e) => {
          dragIdx = i
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', '') // required for drag to fire
        },
        ondragend: () => {
          dragIdx = null
          clearMarks()
        },
        ondragover: (e) => {
          e.preventDefault()
          clearMarks()
          const r = card.getBoundingClientRect()
          const after = e.clientX > r.left + r.width / 2
          card.classList.add(after ? 'drop-after' : 'drop-before')
        },
        ondragleave: () => card.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          e.preventDefault()
          const r = card.getBoundingClientRect()
          const after = e.clientX > r.left + r.width / 2
          clearMarks()
          if (dragIdx === null) return
          let to = after ? i + 1 : i
          if (dragIdx < to) to--
          if (to !== dragIdx) onReorder(dragIdx, to)
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
  let dragIdx = null
  const list = h('ul', { class: 'filelist thumbs' })
  files.forEach((f, i) => {
    const li = h(
      'li',
      {
        draggable: 'true',
        ondragstart: (e) => {
          dragIdx = i
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', '')
        },
        ondragend: () => {
          dragIdx = null
          list.querySelectorAll('li').forEach((x) => x.classList.remove('target'))
        },
        ondragover: (e) => {
          e.preventDefault()
          li.classList.add('target')
        },
        ondragleave: () => li.classList.remove('target'),
        ondrop: (e) => {
          e.preventDefault()
          li.classList.remove('target')
          if (dragIdx !== null && dragIdx !== i) onMove(dragIdx, i)
        },
      },
      h('img', { class: 'thumb', src: f.url, alt: '' }),
      h('span', { class: 'fname' }, f.file.name),
      h('span', { class: 'fsize' }, f.dims ?? fmtBytes(f.file.size)),
      iconBtn('up', 'Move up', () => onMove(i, i - 1), i === 0),
      iconBtn('down', 'Move down', () => onMove(i, i + 1), i === files.length - 1),
      iconBtn('x', 'Remove', () => onRemove(i)),
    )
    list.append(li)
  })
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
