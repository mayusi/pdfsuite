// Live, exact preview: run the real engine on a 1–2 page excerpt and render
// it. What you see is precisely what the download will contain.
import { h } from './dom.js'
import { extractPages } from '../pdf/ops.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves } from '../pdf/ops.js'
import { renderPage } from '../pdf/render.js'

/**
 * livePreview(info, pages[0-based], apply(bytes) → Promise<bytes>)
 * Returns {el, update()} — call update() after option changes (debounced).
 */
export function livePreview(info, pages, apply, { width = 300 } = {}) {
  const el = h('div', { class: 'pv' })
  const slots = pages.map((p) => h('div', { class: 'pv-page' }, h('div', { class: 'pskel', style: { aspectRatio: aspect(info, p) } }), h('div', { class: 'pv-cap' }, `Page ${p + 1}`)))
  el.append(...slots)
  let excerpt = null
  let gen = 0
  let timer = 0
  const px = Math.round(width * Math.min(2, self.devicePixelRatio || 1))
  const run = async () => {
    const my = ++gen
    try {
      excerpt ??= await extractPages(info.bytes, pages.map((p) => ({ from: p + 1, to: p + 1 })))
      const out = await apply(excerpt)
      if (my !== gen) return
      const doc = await parsePdf(out)
      const leaves = pageLeaves(doc)
      const cache = new Map()
      for (let k = 0; k < slots.length; k++) {
        const cv = await renderPage(doc, leaves[k], { width: px, cache })
        if (my !== gen) return
        slots[k].firstChild.replaceWith(cv)
      }
    } catch (e) { console.warn('preview failed', e) }
  }
  run()
  return { el, update: () => { clearTimeout(timer); timer = setTimeout(run, 180) } }
}

const aspect = (info, p) => {
  const d = info.dims[p]
  const w = d.rotate % 180 === 0 ? d.w : d.h, hh = d.rotate % 180 === 0 ? d.h : d.w
  return `${w} / ${hh}`
}
