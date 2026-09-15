import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, DropZone, ErrorText, PageGrid, Toolbar, openLightbox } from '../ui/widgets.js'
import { get } from '../pdf/types.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves, organizePages, pagePreview } from '../pdf/ops.js'
import { renderPage } from '../pdf/render.js'

/** Copy a rendered canvas (cloneNode doesn't carry the bitmap). */
const cloneCanvas = (src) => {
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  c.getContext('2d').drawImage(src, 0, 0)
  c.className = src.className
  c.draggable = false
  return c
}

export function Organize() {
  let file = null
  let bytes = null
  let doc = null
  let leaves = []
  let items = [] // {page, w, h, rotation, deleted, canvas, imgUrl, text}
  let sel = new Set() // selected item objects (identity survives reorder)
  let lastIdx = null // shift-click anchor
  let moveTo = 1
  let urls = []
  let history = [] // undo stack of item-list snapshots
  let busy = false
  let error = ''
  let loadGen = 0
  const imgCache = new Map() // shared decode cache across pages of this doc
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    items = []
    sel = new Set()
    lastIdx = null
    history = []
    imgCache.clear()
    for (const u of urls) URL.revokeObjectURL(u)
    urls = []
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const d = await parsePdf(b)
      if (my !== loadGen) return
      bytes = b
      doc = d
      leaves = pageLeaves(d)
      items = leaves.map((leaf, i) => {
        const mb = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox ?? [0, 0, 0, 0]
        return {
          page: i + 1,
          w: Math.round(mb[2] - mb[0]),
          h: Math.round(mb[3] - mb[1]),
          rotation: 0,
          deleted: false,
          canvas: null,
          imgUrl: null,
          text: '',
        }
      })
      render()
      // fill previews progressively: real mini-render first, image/text fallback
      leaves.forEach(async (leaf, i) => {
        try {
          const canvas = await renderPage(d, leaf, { width: 200, cache: imgCache })
          if (my !== loadGen) return
          if (canvas) {
            canvas.className = 'pcanvas'
            canvas.draggable = false
            items[i].canvas = canvas
          } else {
            const pv = await pagePreview(d, leaf)
            if (my !== loadGen) return
            if (pv.img) {
              items[i].imgUrl = URL.createObjectURL(new Blob([pv.img.data], { type: pv.img.mime }))
              urls.push(items[i].imgUrl)
            } else {
              items[i].text = pv.text
            }
          }
          render()
        } catch { /* card keeps dims */ }
      })
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that PDF'
      file = null
      bytes = null
      doc = null
    }
    render()
  }

  const mutate = (fn) => {
    history.push([...items])
    if (history.length > 50) history.shift()
    fn()
    render()
  }

  const undo = () => {
    if (!history.length) return
    items = history.pop()
    sel = new Set([...sel].filter((x) => items.includes(x)))
    render()
  }

  const onSelect = (i, shift) => {
    if (shift && lastIdx !== null) {
      const [a, b] = lastIdx < i ? [lastIdx, i] : [i, lastIdx]
      for (let k = a; k <= b; k++) sel.add(items[k])
    } else {
      sel.has(items[i]) ? sel.delete(items[i]) : sel.add(items[i])
    }
    lastIdx = i
    render()
  }

  const applySel = (fn) => mutate(() => { items = items.map((x) => (sel.has(x) ? fn(x) : x)) })

  const moveSelected = (where) => mutate(() => {
    const picked = items.filter((x) => sel.has(x))
    const rest = items.filter((x) => !sel.has(x))
    if (!picked.length) return
    if (where === 'front') items = [...picked, ...rest]
    else if (where === 'back') items = [...rest, ...picked]
    else {
      const idx = Math.max(0, Math.min(rest.length, moveTo - 1))
      items = [...rest.slice(0, idx), ...picked, ...rest.slice(idx)]
    }
  })

  const dupSelected = () => mutate(() => {
    const picked = items.filter((x) => sel.has(x))
    if (!picked.length) return
    const lastPos = items.lastIndexOf(picked[picked.length - 1])
    // clone canvas nodes — a DOM node can only live in one card at a time
    const dups = picked.map((x) => ({ ...x, canvas: x.canvas ? cloneCanvas(x.canvas) : null }))
    items = [...items.slice(0, lastPos + 1), ...dups, ...items.slice(lastPos + 1)]
  })

  const onZoom = async (i) => {
    const it = items[i]
    const leaf = leaves[it.page - 1]
    try {
      const canvas = await renderPage(doc, leaf, { width: Math.min(860, it.w * 1.5), cache: imgCache })
      if (canvas) openLightbox(canvas, `page ${it.page} · ${it.w}×${it.h}pt${it.rotation ? ` · rotated ${it.rotation}°` : ''}`)
    } catch { /* no preview */ }
  }

  const extractSel = async () => {
    const picked = items.filter((x) => sel.has(x) && !x.deleted)
    if (!picked.length) return
    busy = true
    error = ''
    render()
    try {
      const out = await organizePages(bytes, picked.map((x) => ({ page: x.page, rotation: x.rotation })))
      saveBlob(new Blob([out], { type: 'application/pdf' }), `${file.name.replace(/\.pdf$/i, '')}-extract.pdf`)
    } catch (e) {
      error = e.message || 'failed'
    } finally {
      busy = false
      render()
    }
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const ops = items.filter((it) => !it.deleted).map((it) => ({ page: it.page, rotation: it.rotation }))
      if (!ops.length) throw new Error('all pages deleted')
      const out = await organizePages(bytes, ops)
      saveBlob(
        new Blob([out], { type: 'application/pdf' }),
        `${file.name.replace(/\.pdf$/i, '')}-organized.pdf`,
      )
    } catch (e) {
      error = e.message || 'failed'
    } finally {
      busy = false
      render()
    }
  }

  // keyboard: Ctrl+A select-all, Del delete, Ctrl+Z undo — self-removes when detached
  const onKey = (e) => {
    if (!root.isConnected) return document.removeEventListener('keydown', onKey)
    if (!items.length || /input|textarea|select/i.test(e.target.tagName)) return
    if (e.ctrlKey && e.key === 'a') { e.preventDefault(); sel = new Set(items); render() }
    else if (e.key === 'Delete' && sel.size) applySel((x) => ({ ...x, deleted: true }))
    else if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo() }
  }
  document.addEventListener('keydown', onKey)

  function render() {
    const kept = items.filter((i) => !i.deleted).length
    const n = sel.size
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      items.length
        ? h('p', { class: 'meta dim' },
            `Click to select (shift = range) · drag to reorder · ⌨ Ctrl+A / Del / Ctrl+Z · ${kept} of ${items.length} kept${n ? ` · ${n} selected` : ''}`)
        : null,
      items.length
        ? Toolbar([
            ['Select all', () => { sel = new Set(items); render() }],
            ['Clear', () => { sel = new Set(); render() }, !n],
            ['Invert', () => { sel = new Set(items.filter((x) => !sel.has(x))); render() }],
            ['⇤ To front', () => moveSelected('front'), !n],
            ['To back ⇥', () => moveSelected('back'), !n],
            ['Rotate sel +90°', () => applySel((x) => ({ ...x, rotation: (x.rotation + 90) % 360 })), !n],
            ['Delete sel', () => applySel((x) => ({ ...x, deleted: true })), !n],
            ['Duplicate sel', dupSelected, !n],
            ['↶ Undo', undo, !history.length],
            ['Restore all', () => mutate(() => { items = items.map((x) => ({ ...x, deleted: false })) }), kept === items.length],
            ['Reset all', () => mutate(() => {
              items = items.map((x) => ({ ...x, rotation: 0, deleted: false }))
              items.sort((a, b) => a.page - b.page)
              sel = new Set()
            })],
          ])
        : null,
      items.length
        ? h('div', { class: 'toolbar' },
            h('label', { class: 'lbl', style: { alignSelf: 'center', margin: 0 } }, 'Move selected to position'),
            h('input', {
              class: 'textin num', type: 'number', value: moveTo, min: 1, max: items.length,
              style: { width: '80px', margin: 0 },
              oninput: (e) => (moveTo = parseInt(e.target.value, 10) || 1),
            }),
            h('button', { type: 'button', class: 'tbtn', disabled: !n || undefined, onclick: () => moveSelected('at') }, 'Move'),
            n ? h('button', { type: 'button', class: 'tbtn', onclick: extractSel, disabled: busy || undefined }, 'Download selected as PDF') : null,
          )
        : null,
      items.length
        ? PageGrid({
            items,
            selected: sel,
            onSelect,
            onZoom,
            onReorder: (from, to) => mutate(() => {
              const c = [...items]
              const [x] = c.splice(from, 1)
              c.splice(to, 0, x)
              items = c
            }),
            onRotate: (i, delta) => mutate(() => {
              items = items.map((x, j) => (j === i ? { ...x, rotation: ((x.rotation + delta) % 360 + 360) % 360 } : x))
            }),
            onToggleDelete: (i) => mutate(() => {
              items = items.map((x, j) => (j === i ? { ...x, deleted: !x.deleted } : x))
            }),
          })
        : null,
      ErrorText(error),
      items.length
        ? Btn(busy ? 'Building…' : `Download organized PDF (${kept} pages)`, { onclick: run, disabled: busy || kept === 0 })
        : null,
    )
    // apply rotation to rendered canvases so cards reflect it
    for (const it of items) {
      if (it.canvas) it.canvas.style.transform = it.rotation ? `rotate(${it.rotation}deg)` : ''
    }
  }
  render()
  return root
}
