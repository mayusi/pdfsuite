import { h, icon, readBytes, saveBlob, setKids } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { parsePdf } from '../pdf/parse.js'
import { collectDrawOps, pageLeaves } from '../pdf/ops.js'
import { renderPage } from '../pdf/render.js'
import { zipStore } from '../zip.js'

export function PdfToPng() {
  let file = null
  let doc = null
  let pages = [] // {i, leaf, canvas, box}
  let scale = 2
  let busy = false
  let error = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    file = f
    doc = null
    pages = []
    busy = true
    render()
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      const parsed = await parsePdf(b)
      const leaves = pageLeaves(parsed)
      if (my !== loadGen) return
      doc = parsed
      pages = leaves.map((leaf, i) => ({ leaf, i, canvas: null }))
      busy = false
      render()
      const cache = new Map()
      for (const p of pages) {
        if (my !== loadGen) return
        p.canvas = await renderPage(doc, p.leaf, { width: 220 * scale, cache }).catch(() => null)
        render()
      }
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that file'
      file = null
    } finally {
      if (my === loadGen) busy = false
      render()
    }
  }

  const blobOf = (canvas) =>
    new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'))

  const saveAll = async () => {
    busy = true
    render()
    try {
      // export renders at true scale (page-pts × scale), independent of the
      // 220px preview thumbs — scale 3 on a letter page ≈ 1836px ≈ 216 DPI
      const entries = []
      const cache = new Map()
      for (const p of pages) {
        const { box } = await collectDrawOps(doc, p.leaf).catch(() => ({ box: null }))
        if (!box) continue
        const hi = await renderPage(doc, p.leaf, { width: Math.round(box.w * scale), cache }).catch(() => null)
        if (!hi) continue
        const blob = await blobOf(hi)
        entries.push({
          name: `${file.name.replace(/\.pdf$/i, '')}-p${p.i + 1}.png`,
          data: new Uint8Array(await blob.arrayBuffer()),
        })
      }
      if (!entries.length) throw new Error('nothing rendered')
      if (entries.length === 1) saveBlob(new Blob([entries[0].data], { type: 'image/png' }), entries[0].name)
      else saveBlob(new Blob([zipStore(entries)], { type: 'application/zip' }), `${file.name.replace(/\.pdf$/i, '')}-pages.zip`)
    } catch (e) {
      error = e.message || 'export failed'
    } finally {
      busy = false
      render()
    }
  }

  function render() {
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file
        ? Card(
            h('div', { class: 'optrow' },
              h('div', {},
                h('label', { class: 'lbl' }, 'Resolution'),
                h('select', { class: 'textin sel', onchange: (e) => { scale = Number(e.target.value); load([file]) } },
                  [[1, '1× — small'], [2, '2× — crisp'], [3, '3× — print']]
                    .map(([v, l]) => h('option', { value: v, selected: v === scale || undefined }, l)))),
              h('div', {},
                h('label', { class: 'lbl' }, 'Pages'),
                h('p', { class: 'meta dim' }, `${pages.length} page${pages.length === 1 ? '' : 's'} → PNG${pages.length > 1 ? 's in a zip' : ''}`))),
            pages.length
              ? h('div', { class: 'pgrid' },
                  pages.map((p) =>
                    h('div', { class: 'pcard' },
                      p.canvas ?? h('div', { class: 'pthumb dim' }, '…'),
                      h('div', { class: 'plabel' }, `p${p.i + 1}`))))
              : null,
            h('div', { class: 'btnrow' },
              Btn(busy ? 'Encoding…' : pages.length > 1 ? 'Download PNGs (zip)' : 'Download PNG', {
                onclick: saveAll, disabled: busy || !pages.length,
              })),
          )
        : null,
      busy && !pages.length ? h('p', { class: 'meta dim' }, 'Rendering pages…') : null,
      ErrorText(error),
    )
  }
  render()
  return root
}
