import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText, SelectGrid, Toolbar } from '../ui/widgets.js'
import { parsePdf } from '../pdf/parse.js'
import { extractPages, pageDims, pageLeaves, pagePreview, parseRanges, splitPdf } from '../pdf/ops.js'
import { zipStore } from '../zip.js'

/** Selected set → "1-3, 5" spec string. */
const selToSpec = (sel) => {
  const pgs = [...sel].sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < pgs.length; i++) {
    let j = i
    while (j + 1 < pgs.length && pgs[j + 1] === pgs[j] + 1) j++
    parts.push(pgs[i] === pgs[j] ? `${pgs[i]}` : `${pgs[i]}-${pgs[j]}`)
    i = j
  }
  return parts.join(', ')
}

export function Split() {
  let file = null
  let bytes = null
  let items = [] // {page, w, h}
  let selected = new Set()
  let lastPick = null // for shift-click ranges
  let spec = ''
  let specOK = true
  let mode = 'one'
  let busy = false
  let error = ''
  let loadGen = 0
  let urls = []
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    items = []
    selected = new Set()
    lastPick = null
    spec = ''
    specOK = true
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
      const dims = pageDims(doc)
      items = dims.map((d, i) => ({ page: i + 1, w: d.w, h: d.h, imgUrl: null, text: '' }))
      selected = new Set(items.map((i) => i.page))
      spec = selToSpec(selected)
      render()
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
        } catch { /* card keeps dims */ }
      })
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that PDF'
      file = null
      bytes = null
    }
    render()
  }

  const toggle = (page, shift) => {
    if (shift && lastPick !== null) {
      const [a, b] = lastPick < page ? [lastPick, page] : [page, lastPick]
      for (let p = a; p <= b; p++) selected.add(p)
    } else {
      selected.has(page) ? selected.delete(page) : selected.add(page)
    }
    lastPick = page
    spec = selToSpec(selected)
    specOK = true
    render()
  }

  const preset = (kind) => {
    selected = new Set(
      kind === 'all' ? items.map((i) => i.page)
      : kind === 'none' ? []
      : items.filter((i) => (kind === 'odd') === (i.page % 2 === 1)).map((i) => i.page),
    )
    lastPick = null
    spec = selToSpec(selected)
    specOK = true
    render()
  }

  let gridEl = null
  let btnEl = null

  const onSpec = (v) => {
    spec = v
    try {
      selected = new Set(parseRanges(v, items.length).flatMap(({ from, to }) =>
        Array.from({ length: to - from + 1 }, (_, i) => from + i)))
      specOK = true
    } catch {
      specOK = false // leave cards as-is until the spec parses
    }
    if (btnEl) btnEl.disabled = busy || !specOK || !selected.size
    // hot-swap only the grid — full render() would nuke input focus mid-typing
    if (specOK && gridEl) {
      const fresh = SelectGrid({ items, selected, onToggle: toggle })
      gridEl.replaceWith(fresh)
      gridEl = fresh
    }
  }

  const run = async () => {
    busy = true
    error = ''
    render()
    try {
      const ranges = parseRanges(spec, items.length)
      const stem = file.name.replace(/\.pdf$/i, '')
      if (mode === 'one') {
        const out = await extractPages(bytes, ranges)
        saveBlob(new Blob([out], { type: 'application/pdf' }), `${stem}-pages.pdf`)
      } else {
        const outs = await splitPdf(bytes, ranges)
        saveBlob(
          new Blob([zipStore(outs.map((out, i) => ({
            name: `${stem}-${ranges[i].from}-${ranges[i].to}.pdf`,
            data: out,
          })))], { type: 'application/zip' }),
          `${stem}-split.zip`,
        )
      }
    } catch (e) {
      error = e.message || 'split failed'
    } finally {
      busy = false
      render()
    }
  }

  const radio = (val, text) =>
    h(
      'label',
      { class: 'radio' },
      h('input', {
        type: 'radio',
        name: 'splitmode',
        checked: mode === val || undefined,
        onchange: () => { mode = val; render() },
      }),
      text,
    )

  function render() {
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name), ` — ${items.length} pages`),
            h('p', { class: 'meta dim' }, 'Click pages to pick them · shift-click selects a range'),
            Toolbar([
              ['All', () => preset('all')],
              ['None', () => preset('none')],
              ['Odd pages', () => preset('odd')],
              ['Even pages', () => preset('even')],
            ]),
          )
        : null,
      items.length ? (gridEl = SelectGrid({ items, selected, onToggle: toggle })) : null,
      file
        ? Card(
            h('label', { class: 'lbl' }, 'Ranges (synced with your picks — edit either)'),
            h('input', {
              class: 'textin',
              value: spec,
              oninput: (e) => onSpec(e.target.value),
            }),
            h(
              'div',
              { class: 'radio-row' },
              radio('one', 'One PDF with those pages'),
              radio('zip', 'Separate PDF per range (zip)'),
            ),
          )
        : null,
      ErrorText(error),
      file
        ? (btnEl = Btn(
            busy ? 'Working…' : `Extract ${selected.size} page${selected.size === 1 ? '' : 's'}`,
            { onclick: run, disabled: busy || !specOK || !selected.size },
          ))
        : (btnEl = null),
    )
  }
  render()
  return root
}
