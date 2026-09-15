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

/** Ordered file list with move-up/down + remove. Merge / Images→PDF. */
export function FileList({ files, onMove, onRemove }) {
  return h(
    'ul',
    { class: 'filelist' },
    files.map((f, i) =>
      h(
        'li',
        {},
        h('span', { class: 'idx' }, String(i + 1)),
        h('span', { class: 'fname' }, f.name),
        h('span', { class: 'fsize' }, fmtBytes(f.size)),
        iconBtn('up', 'Move up', () => onMove(i, i - 1), i === 0),
        iconBtn('down', 'Move down', () => onMove(i, i + 1), i === files.length - 1),
        iconBtn('x', 'Remove', () => onRemove(i)),
      ),
    ),
  )
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
 * Page-card grid for Organize — drag-reorder, rotate, delete.
 * items: [{page, w, h, rotation, deleted}] — no renderer needed, cards show real metadata.
 */
export function PageGrid({ items, onReorder, onRotate, onToggleDelete }) {
  let dragIdx = null
  const grid = h('div', { class: 'pgrid' })

  items.forEach((it, i) => {
    const card = h(
      'div',
      {
        class: 'pcard' + (it.deleted ? ' deleted' : ''),
        draggable: 'true',
        ondragstart: () => (dragIdx = i),
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
      h('div', { class: 'pnum' }, `p${it.page}`),
      h('div', { class: 'pdim' }, `${it.w}×${it.h}`),
      it.rotation ? h('div', { class: 'prot' }, `${it.rotation}°`) : null,
      h(
        'div',
        { class: 'pops' },
        iconBtn('rotate', 'Rotate +90°', () => onRotate(i)),
        iconBtn(it.deleted ? 'undo' : 'x', it.deleted ? 'Restore' : 'Delete', () => onToggleDelete(i)),
      ),
    )
    grid.append(card)
  })
  return grid
}
