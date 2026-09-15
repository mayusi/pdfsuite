import { h, setKids, readBytes, saveBlob } from '../ui/dom.js'
import { Btn, DropZone, ErrorText, PageGrid } from '../ui/widgets.js'
import { get } from '../pdf/types.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves, organizePages } from '../pdf/ops.js'

export function Organize() {
  let file = null
  let bytes = null
  let items = [] // {page, w, h, rotation, deleted}
  let busy = false
  let error = ''
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    error = ''
    items = []
    render()
    try {
      file = f
      bytes = await readBytes(f)
      const doc = await parsePdf(bytes)
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
    setKids(root, 
      DropZone({ accept: 'application/pdf', onFiles: load }),
      items.length
        ? h('p', { class: 'meta dim' }, `Drag to reorder · rotate / delete on hover · ${kept} of ${items.length} pages kept`)
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
            onRotate: (i) => {
              items = items.map((x, j) => (j === i ? { ...x, rotation: (x.rotation + 90) % 360 } : x))
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
