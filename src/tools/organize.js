import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, DropZone, ErrorText, PageGrid, Toolbar } from '../ui/widgets.js'
import { get } from '../pdf/types.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves, organizePages, pagePreview } from '../pdf/ops.js'

export function Organize() {
  let file = null
  let bytes = null
  let items = [] // {page, w, h, rotation, deleted, imgUrl, text}
  let sel = new Set() // selected item objects (identity survives reorder)
  let lastIdx = null // shift-click anchor
  let moveTo = 1
  let urls = [] // object URLs to revoke on reload
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    items = []
    sel = new Set()
    lastIdx = null
    for (const u of urls) URL.revokeObjectURL(u)
    urls = []
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const doc = await parsePdf(b)
      if (my !== loadGen) return
      bytes = b
      const leaves = pageLeaves(doc)
      items = leaves.map((leaf, i) => {
        const mb = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox ?? [0, 0, 0, 0]
        return {
          page: i + 1,
          w: Math.round(mb[2] - mb[0]),
          h: Math.round(mb[3] - mb[1]),
          rotation: 0,
          deleted: false,
          imgUrl: null,
          text: '',
        }
      })
      render()
      // fill previews progressively (real image thumb, else the page's own text)
      leaves.forEach(async (leaf, i) => {
        try {
          const pv = await pagePreview(doc, leaf)
          if (my !== loadGen) return
          if (pv.img) {
            items[i].imgUrl = URL.createObjectURL(new Blob([pv.img.data], { type: pv.img.mime }))
            urls.push(items[i].imgUrl)
          } else {
            items[i].text = pv.text
          }
          render()
        } catch { /* no preview — card keeps dims */ }
      })
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that PDF'
      file = null
      bytes = null
    }
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

  const applySel = (fn) => {
    items = items.map((x) => (sel.has(x) ? fn(x) : x))
    render()
  }

  const moveSelected = (where) => {
    const picked = items.filter((x) => sel.has(x))
    const rest = items.filter((x) => !sel.has(x))
    if (!picked.length) return
    if (where === 'front') items = [...picked, ...rest]
    else if (where === 'back') items = [...rest, ...picked]
    else {
      const idx = Math.max(0, Math.min(rest.length, moveTo - 1))
      items = [...rest.slice(0, idx), ...picked, ...rest.slice(idx)]
    }
    render()
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

  function render() {
    const kept = items.filter((i) => !i.deleted).length
    const n = sel.size
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      items.length
        ? h('p', { class: 'meta dim' },
            `Click to select (shift = range) · drag to reorder · rotate / delete on hover · ${kept} of ${items.length} kept${n ? ` · ${n} selected` : ''}`)
        : null,
      items.length
        ? Toolbar([
            ['Select all', () => { sel = new Set(items); render() }],
            ['Clear', () => { sel = new Set(); render() }, !n],
            ['⇤ To front', () => moveSelected('front'), !n],
            ['To back ⇥', () => moveSelected('back'), !n],
            ['Rotate sel +90°', () => applySel((x) => ({ ...x, rotation: (x.rotation + 90) % 360 })), !n],
            ['Delete sel', () => applySel((x) => ({ ...x, deleted: true })), !n],
            ['Restore all', () => { items = items.map((x) => ({ ...x, deleted: false })); render() }, kept === items.length],
            ['Reset all', () => {
              items = items.map((x) => ({ ...x, rotation: 0, deleted: false }))
              items.sort((a, b) => a.page - b.page)
              sel = new Set()
              render()
            }],
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
          )
        : null,
      items.length
        ? PageGrid({
            items,
            selected: sel,
            onSelect,
            onReorder: (from, to) => {
              const c = [...items]
              const [x] = c.splice(from, 1)
              c.splice(to, 0, x)
              items = c
              render()
            },
            onRotate: (i, delta) => {
              items = items.map((x, j) => (j === i ? { ...x, rotation: ((x.rotation + delta) % 360 + 360) % 360 } : x))
              render()
            },
            onToggleDelete: (i) => {
              items = items.map((x, j) => (j === i ? { ...x, deleted: !x.deleted } : x))
              render()
            },
          })
        : null,
      ErrorText(error),
      items.length
        ? Btn(busy ? 'Building…' : `Download organized PDF (${kept} pages)`, { onclick: run, disabled: busy || kept === 0 })
        : null,
    )
  }
  render()
  return root
}
