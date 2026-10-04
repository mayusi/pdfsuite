// Page thumbnail cards shared by Split / Organize / Rotate / Merge previews.
import { h, icon } from './dom.js'
import { thumbQueue, cloneCanvas, modal } from './kit.js'
import { renderPage } from '../pdf/render.js'

/** Lazy, cached thumbnail renderer for one opened PDF (see tool.openPdf). */
export function pageThumbs(info, { width = 220 } = {}) {
  const cache = new Map()
  const px = Math.round(width * Math.min(2, self.devicePixelRatio || 1))
  return thumbQueue((i) => renderPage(info.doc, info.leaves[i], { width: px, cache }), { concurrency: 2 })
}

/** Copy of `src` rotated by deg (multiple of 90). */
export function rotatedCanvas(src, deg) {
  deg = ((deg % 360) + 360) % 360
  if (!src || !deg) return cloneCanvas(src)
  const c = document.createElement('canvas')
  const swap = deg % 180 !== 0
  c.width = swap ? src.height : src.width
  c.height = swap ? src.width : src.height
  const x = c.getContext('2d')
  x.translate(c.width / 2, c.height / 2)
  x.rotate((deg * Math.PI) / 180)
  x.drawImage(src, -src.width / 2, -src.height / 2)
  return c
}

/**
 * One page card. opts:
 *  thumbs (pageThumbs), src (0-based source page), rotation, label, sub,
 *  dims ({w,h,rotate}), selected (bool|undefined → no checkbox), off (dimmed),
 *  ops [{icon, tip, onClick, danger}], onClick(e), draggable
 */
export function PageCard({ thumbs, src, rotation = 0, label, sub, dims, selected, off, ops = [], onClick, draggable, blank }) {
  const baseRot = dims?.rotate ?? 0
  const w0 = dims ? (baseRot % 180 === 0 ? dims.w : dims.h) : 612
  const h0 = dims ? (baseRot % 180 === 0 ? dims.h : dims.w) : 792
  const swap = rotation % 180 !== 0
  const ar = swap ? h0 / w0 : w0 / h0
  const slot = h('div', { class: 'pthumbw', style: { '--ar': String(ar) } }, h('div', { class: 'pskel', style: { aspectRatio: String(ar) } }))
  if (blank) slot.replaceChildren(h('canvas', { width: Math.round(120 * ar), height: 120, style: { aspectRatio: String(ar) } }))
  else if (thumbs) {
    thumbs.attach(slot, src, (cv) => {
      if (!cv) { slot.replaceChildren(h('div', { class: 'muted small' }, 'No preview')); return }
      const c = rotatedCanvas(cv, rotation)
      slot.replaceChildren(c)
    })
  }
  const card = h('div', {
    class: ['pcard', selected ? 'sel' : '', off ? 'off' : '', onClick ? 'clickable' : '', draggable ? 'draggable' : ''].filter(Boolean).join(' '),
    tabindex: onClick ? '0' : undefined,
    role: selected !== undefined ? 'checkbox' : undefined,
    'aria-checked': selected !== undefined ? String(!!selected) : undefined,
    onclick: onClick,
    onkeydown: onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } } : undefined,
  },
  selected !== undefined ? h('span', { class: 'pcheck' }, icon('check', 'icon-sm')) : null,
  ops.length ? h('div', { class: 'pops' }, ops.map((o) => h('button', {
    type: 'button', class: o.danger ? 'danger' : '', 'data-tip': o.tip, 'aria-label': o.tip,
    onclick: (e) => { e.stopPropagation(); o.onClick() },
  }, icon(o.icon, 'icon-sm')))) : null,
  slot,
  h('div', { class: 'plabel' }, h('b', {}, label), sub ? h('span', {}, sub) : null))
  return card
}

/** Large preview of one page in a modal. */
export async function zoomPage(info, i, rotation = 0) {
  const width = Math.min(1400, Math.round(900 * Math.min(2, self.devicePixelRatio || 1)))
  const cv = await renderPage(info.doc, info.leaves[i], { width })
  const c = rotatedCanvas(cv, rotation)
  c.className = 'lightbox-img'
  modal({ title: `Page ${i + 1}`, wide: true, body: c })
}
