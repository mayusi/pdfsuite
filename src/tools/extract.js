import { h, icon, plural, stem, saveBlob, fmtBytes, yieldUI } from '../ui/dom.js'
import { Button, Dropzone, Switch, FileChip, Progress, pickFiles, toast, Callout } from '../ui/kit.js'
import { ToolHead, Workspace, openPdf, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { decodeImageStream } from '../pdf/ops.js'
import { isStream, get } from '../pdf/types.js'
import { crc32, zipStore } from '../zip.js'

/** Browser re-encode: the engine's PNG writer is uncompressed (zero-dep), canvas isn't. */
async function compressPng(im) {
  if (!im.rgba) return im.data
  const c = document.createElement('canvas')
  c.width = im.w
  c.height = im.h
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(im.rgba), im.w, im.h), 0, 0)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : im.data
}

export function ExtractImgs() {
  const { root, render } = mount()
  let info = null
  let images = [] // {name, data, mime, w, h, hash, count, url}
  let skipped = 0
  let sel = new Set()
  let hideSmall = true
  let loading = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      for (const im of images) URL.revokeObjectURL(im.url)
      info = i
      images = []
      skipped = 0
      loading = Progress(null)
      paint()
      const byHash = new Map()
      let n = 0
      const streams = [...info.doc.objects.values()].map((e) => e.v).filter((v) => isStream(v) && get(v.dict, 'Subtype')?.v === 'Image' && !get(v.dict, 'ImageMask'))
      // skip soft masks — they're alpha channels of other images, not pictures
      const smasks = new Set(streams.map((v) => get(v.dict, 'SMask')).filter(Boolean).map((r) => `${r.n} ${r.g}`))
      for (const [key, e] of info.doc.objects) {
        const v = e.v
        if (!streams.includes(v) || smasks.has(key)) continue
        const im = await decodeImageStream(info.doc, v).catch(() => null)
        if (!im) { skipped++; continue }
        const data = im.mime === 'image/png' ? await compressPng(im) : im.data
        const hash = crc32(data) >>> 0
        const w = get(v.dict, 'Width') ?? 0, hh = get(v.dict, 'Height') ?? 0
        if (byHash.has(hash)) { byHash.get(hash).count++; continue }
        const rec = { name: `${stem(info.name)}-image-${++n}${im.ext}`, data, mime: im.mime, w, h: hh, hash, count: 1, url: im.mime === 'image/jp2' ? null : URL.createObjectURL(new Blob([data], { type: im.mime })) }
        byHash.set(hash, rec)
        images.push(rec)
        if (n % 4 === 0) await yieldUI()
      }
      sel = new Set(visible())
      loading = null
      paint()
    } catch (e) { loading = null; toast(e.message, { type: 'error' }); paint() }
  }

  const visible = () => images.filter((im) => !hideSmall || (im.w >= 48 && im.h >= 48))

  const download = () => {
    const picks = visible().filter((im) => sel.has(im))
    if (picks.length === 1) { saveBlob(new Blob([picks[0].data], { type: picks[0].mime }), picks[0].name); return }
    saveBlob(new Blob([zipStore(picks.map((im) => ({ name: im.name, data: im.data })))], { type: 'application/zip' }), `${stem(info.name)}-images.zip`)
    toast(`Saved ${plural(picks.length, 'image')}`)
  }

  function paint() {
    if (!info) { render(ToolHead('extract'), Dropzone({ onFiles: load, title: 'Drop a PDF to pull out its images', tc: 'var(--c-convert)', icon: 'layers' })); return }
    const vis = visible()
    const picked = vis.filter((im) => sel.has(im))
    const total = picked.reduce((n, im) => n + im.data.length, 0)
    render(
      ToolHead('extract'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          loading ? h('div', { class: 'card card-pad stack-sm' }, h('span', { class: 'muted small' }, 'Finding images…'), loading) : null,
          !loading && !vis.length ? Callout(images.length ? 'Only tiny images (icons, bullets) were found — turn off “Hide tiny images” to see them.' : 'This PDF has no embedded images we can extract.', { type: 'warn' }) : null,
          vis.length ? h('div', { class: 'row between' },
            h('span', { class: 'muted small' }, `${vis.length} unique image${vis.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} in unsupported formats skipped` : ''}`),
            h('div', { class: 'row', style: { gap: '6px' } },
              Button({ label: 'All', size: 'sm', onClick: () => { sel = new Set(vis); paint() } }),
              Button({ label: 'None', size: 'sm', onClick: () => { sel = new Set(); paint() } }))) : null,
          h('div', { class: 'igrid' }, vis.map((im) => h('div', {
            class: 'icard' + (sel.has(im) ? ' sel' : ''), tabindex: '0',
            onclick: () => { sel.has(im) ? sel.delete(im) : sel.add(im); paint() },
          },
          h('span', { class: 'pcheck' }, icon('check', 'icon-sm')),
          h('button', { class: 'btn btn-sm btn-icon isave', 'data-tip': 'Download', onclick: (e) => { e.stopPropagation(); saveBlob(new Blob([im.data], { type: im.mime }), im.name) } }, icon('download', 'icon-sm')),
          h('div', { class: 'iprev' }, im.url ? h('img', { src: im.url, alt: im.name, loading: 'lazy' }) : h('span', { class: 'muted small' }, 'JPEG 2000')),
          h('div', {}, h('div', { class: 'iname' }, im.name.replace(/^.*-image-/, 'Image ')),
            h('div', { class: 'idim' }, `${im.w}×${im.h} · ${im.mime.split('/')[1].toUpperCase().replace('JPEG', 'JPG')} · ${fmtBytes(im.data.length)}${im.count > 1 ? ` · used ×${im.count}` : ''}`))))),
        ],
        [
          h('div', { class: 'card stack' },
            Switch('Hide tiny images', hideSmall, (v) => { hideSmall = v; sel = new Set(visible()); paint() }, { hint: 'Icons and bullets under 48px' }),
            h('p', { class: 'muted small', style: { margin: 0 } }, 'Photos come out exactly as stored in the PDF (no re-compression). Repeated images, like logos on every page, appear once.')),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: picked.length > 1 ? `Download ${picked.length} images` : 'Download image', icon: 'download', variant: 'primary', size: 'lg', block: true, disabled: !picked.length, onClick: download }),
            h('div', { class: 'summary' }, picked.length ? `${fmtBytes(total)}${picked.length > 1 ? ' · as a ZIP' : ''}` : 'Select images to download')),
        ]),
    )
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
