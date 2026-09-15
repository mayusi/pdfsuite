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
      h('span', { class: 'idx' }, String(i + 1)),
      h('span', { class: 'fname' }, f.name, f.meta ? h('span', { class: 'fmeta' }, f.meta) : null),
      f.err ? h('span', { class: 'ferr' }, f.err) : h('span', { class: 'fsize' }, fmtBytes(f.size)),
      iconBtn('up', 'Move up', () => onMove(i, i - 1), i === 0),
      iconBtn('down', 'Move down', () => onMove(i, i + 1), i === files.length - 1),
      iconBtn('x', 'Remove', () => onRemove(i)),
    )
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
 * Page-card grid for Organize — drag-reorder, rotate ±90°, delete/restore.
 * items: [{page, w, h, rotation, deleted}] — cards are proportionally sized
 * to the real MediaBox so portrait/landscape/mixed sizes read at a glance.
 */
export function PageGrid({ items, onReorder, onRotate, onToggleDelete }) {
  let dragIdx = null
  const grid = h('div', { class: 'pgrid' })

  items.forEach((it, i) => {
    const card = h(
      'div',
      {
        class: 'pcard' + (it.deleted ? ' deleted' : ''),
        style: { aspectRatio: it.w && it.h ? `${it.w} / ${it.h}` : '3 / 4' },
        draggable: 'true',
        ondragstart: (e) => {
          dragIdx = i
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', '') // required for drag to fire
        },
        ondragend: () => {
          dragIdx = null
          grid.querySelectorAll('.pcard').forEach((c) => c.classList.remove('target'))
        },
        ondragover: (e) => {
          e.preventDefault()
          card.classList.add('target')
        },
        ondragleave: () => card.classList.remove('target'),
        ondrop: (e) => {
          e.preventDefault()
          card.classList.remove('target')
          if (dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i)
        },
      },
      h('div', { class: 'pbody' },
        h('div', { class: 'pnum' }, `p${it.page}`),
        h('div', { class: 'pdim' }, `${it.w}×${it.h}`),
        it.rotation ? h('div', { class: 'prot' }, `${it.rotation}°`) : null,
      ),
      h(
        'div',
        { class: 'pops' },
        iconBtn('rotl', 'Rotate −90°', () => onRotate(i, -90)),
        iconBtn('rotate', 'Rotate +90°', () => onRotate(i, 90)),
        iconBtn(it.deleted ? 'undo' : 'x', it.deleted ? 'Restore' : 'Delete', () => onToggleDelete(i)),
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
export function SelectGrid({ items, selected, onToggle }) {
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
          h('div', { class: 'pnum' }, `p${it.page}`),
          h('div', { class: 'pdim' }, `${it.w}×${it.h}`),
        ),
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
 * images: [{name, data, w, h, mime}]. onSave(image) downloads one.
 */
export function ImgGrid({ images, onSave }) {
  return h(
    'div',
    { class: 'igrid' },
    images.map((im) => {
      const url = URL.createObjectURL(new Blob([im.data], { type: im.mime }))
      return h(
        'div',
        { class: 'icard' },
        h('img', {
          src: url,
          alt: im.name,
          loading: 'lazy',
          onload: () => URL.revokeObjectURL(url),
          onerror: () => URL.revokeObjectURL(url),
        }),
        h('div', { class: 'imeta' },
          h('span', { class: 'iname' }, im.name),
          h('span', { class: 'idim' }, `${im.w}×${im.h} · ${fmtBytes(im.data.length)}`),
        ),
        h('button', { type: 'button', class: 'isave', title: 'Download', onclick: () => onSave(im) }, icon('download', 'icon-sm')),
      )
    }),
  )
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
