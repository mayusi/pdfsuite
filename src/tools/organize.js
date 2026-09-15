import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, DropZone, ErrorText, PageGrid, Toolbar } from '../ui/widgets.js'
import { get } from '../pdf/types.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves, organizePages } from '../pdf/ops.js'

export function Organize() {
  let file = null
  let bytes = null
  let items = [] // {page, w, h, rotation, deleted}
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    items = []
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const doc = await parsePdf(b)
      if (my !== loadGen) return
      bytes = b
      items = pageLeaves(doc).map((leaf, i) => {
        const mb = get(leaf.dict, 'MediaBox') ?? leaf.inh.MediaBox ?? [0, 0, 0, 0]
        return {
          page: i + 1,
          w: Math.round(mb[2] - mb[0]),
          h: Math.round(mb[3] - mb[1]),
          rotation: 0,
          deleted: false,
        }
      })
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that PDF'
      file = null
      bytes = null
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
    const deleted = items.length - kept
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      items.length
        ? h('p', { class: 'meta dim' }, `Drag to reorder · rotate / delete on hover · ${kept} of ${items.length} pages kept`)
        : null,
      items.length
        ? Toolbar([
            ['Rotate all +90°', () => { items = items.map((x) => ({ ...x, rotation: (x.rotation + 90) % 360 })); render() }],
            ['Reverse order', () => { items = [...items].reverse(); render() }],
            ['Restore deleted', () => { items = items.map((x) => ({ ...x, deleted: false })); render() }, !deleted],
            ['Reset all', () => { items = items.map((x) => ({ ...x, rotation: 0, deleted: false })); items.sort((a, b) => a.page - b.page); render() }],
          ])
        : null,
      items.length
        ? PageGrid({
            items,
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
