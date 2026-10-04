import { h, icon, plural, readBytes, fmtBytes } from '../ui/dom.js'
import { Button, Dropzone, Field, Seg, Select, Switch, TextInput, sortable } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, runTask, takeHandoff, mount } from '../ui/tool.js'
import { rotatedCanvas } from '../ui/pages.js'
import { imagesToPdf, jpegInfo, exifRotation } from '../pdf/ops.js'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif'

/** Decode an image file for the PDF: JPEG passthrough (lossless) or RGBA pixels. */
async function prepare(file, { shrink }) {
  const isJpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name)
  const bmp = await createImageBitmap(file, { imageOrientation: 'none' })
  try {
    const big = Math.max(bmp.width, bmp.height) > 2600
    if (isJpeg && !(shrink && big)) return { jpeg: await readBytes(file) }
    const k = shrink && big ? 2600 / Math.max(bmp.width, bmp.height) : 1
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * k))
    c.height = Math.max(1, Math.round(bmp.height * k))
    const x = c.getContext('2d')
    x.drawImage(bmp, 0, 0, c.width, c.height)
    if (isJpeg || (shrink && big)) { // photo → JPEG keeps the PDF small
      let exif = 0
      if (isJpeg) { try { exif = exifRotation(jpegInfo(await readBytes(file)).orientation) } catch { /* not a parseable jpeg */ } }
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88))
      return { jpeg: new Uint8Array(await blob.arrayBuffer()), extraRot: exif }
    }
    return { rgba: x.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height }
  } finally { bmp.close?.() }
}

export function ImgToPdf() {
  const { root, render } = mount()
  let items = [] // {id, file, thumb, w, h, rotate, err}
  let size = 'fit'
  let orient = 'auto'
  let margin = 0
  let fit = 'contain'
  let shrink = true
  let outName = 'images'
  let busy = false
  let result = null
  let uid = 0

  const add = async (files) => {
    result = null
    for (const f of files) {
      const it = { id: ++uid, file: f, thumb: null, w: 0, h: 0, rotate: 0, err: null }
      items.push(it)
      paint()
      try {
        // thumbnail with EXIF orientation applied (what the PDF will show)
        const bmp = await createImageBitmap(f)
        it.w = bmp.width
        it.h = bmp.height
        const k = 260 / Math.max(bmp.width, bmp.height)
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(bmp.width * k))
        c.height = Math.max(1, Math.round(bmp.height * k))
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
        bmp.close?.()
        it.thumb = c
      } catch { it.err = 'Can’t read this image' }
      paint()
    }
  }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const good = items.filter((x) => !x.err)
    const images = []
    for (const it of good) {
      const p = await prepare(it.file, { shrink })
      images.push({ ...p, rotate: (it.rotate + (p.extraRot ?? 0)) % 360 })
    }
    const out = await imagesToPdf(images, { size, orient, margin, fit })
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${(outName.trim() || 'images').replace(/\.pdf$/i, '')}.pdf`, n: good.length }
  })

  const move = (from, to) => { const [x] = items.splice(from, 1); items.splice(to, 0, x); paint() }

  function card(it, k) {
    const thumb = it.thumb ? rotatedCanvas(it.thumb, it.rotate) : null
    return h('div', { class: 'pcard draggable' },
      h('div', { class: 'pops' },
        h('button', { type: 'button', 'data-tip': 'Rotate', onclick: (e) => { e.stopPropagation(); it.rotate = (it.rotate + 90) % 360; paint() } }, icon('rotate', 'icon-sm')),
        h('button', { type: 'button', class: 'danger', 'data-tip': 'Remove', onclick: (e) => { e.stopPropagation(); items = items.filter((x) => x !== it); paint() } }, icon('x', 'icon-sm'))),
      h('div', { class: 'pthumbw' }, thumb ?? (it.err ? h('span', { class: 'ferr small' }, it.err) : h('div', { class: 'pskel' }))),
      h('div', { class: 'plabel', title: it.file.name }, h('b', {}, `${k + 1}`), h('span', {}, it.w ? `${it.w}×${it.h}` : fmtBytes(it.file.size))))
  }

  function paint() {
    if (!items.length) {
      render(ToolHead('img2pdf'), Dropzone({ accept: ACCEPT, multiple: true, onFiles: add, title: 'Drop your images here', subtitle: 'JPG, PNG, WebP, GIF, BMP — as many as you like', label: 'Choose images', tc: 'var(--c-convert)', icon: 'image' }))
      return
    }
    if (result) {
      render(ToolHead('img2pdf'), ResultCard({ title: 'Your PDF is ready', blob: result.blob, filename: result.name, toolId: 'img2pdf', sub: `${result.name} · ${plural(result.n, 'page')} · ${fmtBytes(result.blob.size)}`, onAgain: () => { items = []; result = null; paint() } }))
      return
    }
    const grid = h('div', { class: 'pgrid' }, items.map(card))
    sortable(grid, '.pcard', move)
    const fixed = size !== 'fit'
    render(
      ToolHead('img2pdf'),
      Workspace(
        [
          h('div', { class: 'row between' },
            h('span', { class: 'muted small' }, 'Drag to reorder · each image becomes one page'),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: 'A → Z', size: 'sm', onClick: () => { items.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true })); paint() } }),
              Button({ label: 'Reverse', size: 'sm', onClick: () => { items.reverse(); paint() } }))),
          grid,
          Dropzone({ accept: ACCEPT, multiple: true, onFiles: add, compact: true, title: 'Add more images', icon: 'image' }),
        ],
        [
          h('div', { class: 'card stack' },
            Field('Page size', Select([['fit', 'Same as image'], ['a4', 'A4'], ['letter', 'US Letter'], ['legal', 'US Legal'], ['a3', 'A3'], ['a5', 'A5']], size, (v) => { size = v; paint() })),
            fixed ? Field('Orientation', Seg([['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], orient, (v) => (orient = v), { block: true })) : null,
            fixed ? Field('Fit', Seg([['contain', 'Fit'], ['cover', 'Fill'], ['stretch', 'Stretch']], fit, (v) => (fit = v), { block: true })) : null,
            Field('Margin', Seg([[0, 'None'], [18, 'Small'], [36, 'Medium'], [54, 'Large']], margin, (v) => (margin = v), { block: true })),
            Switch('Shrink large photos', shrink, (v) => (shrink = v), { hint: 'Scales images over 2600px down — much smaller files' }),
            Field('File name', TextInput(outName, (v) => (outName = v)), { hint: '.pdf' })),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Building PDF…' : 'Create PDF', icon: 'file', variant: 'primary', size: 'lg', block: true, busy, disabled: !items.some((x) => !x.err), onClick: run }),
            h('div', { class: 'summary' }, plural(items.filter((x) => !x.err).length, 'image'))),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) add(Array.isArray(ho) ? ho : [ho])
  else paint()
  return root
}
