// Signature dialog: draw / type / upload → trimmed transparent image.
// Saved signatures live only in this browser (localStorage).
import { h } from '../ui/dom.js'
import { modal, Seg, Swatches, Switch, TextInput, Button, pickFiles, toast } from '../ui/kit.js'

const KEY = 'pdfsuite-signatures'
export function savedSignatures() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]').filter((s) => typeof s === 'string' && s.startsWith('data:image/png')) } catch { return [] }
}
function storeSignatures(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8))) } catch { toast('Couldn’t save the signature in this browser', { type: 'error' }) }
}
export function forgetSignature(url) { storeSignatures(savedSignatures().filter((s) => s !== url)) }

const SCRIPT_FONTS = ['"Segoe Script", "Brush Script MT", cursive', '"Lucida Handwriting", "Apple Chancery", cursive', '"Brush Script MT", "Snell Roundhand", cursive', '"Ink Free", "Bradley Hand", cursive', 'Georgia, "Times New Roman", serif']

/** Crop transparent margins; returns a new canvas (or null if empty). */
function trim(src, pad = 6) {
  const x = src.getContext('2d')
  const { width: w, height: hh } = src
  const d = x.getImageData(0, 0, w, hh).data
  let x0 = w, y0 = hh, x1 = -1, y1 = -1
  for (let y = 0; y < hh; y++) for (let xx = 0; xx < w; xx++) {
    if (d[(y * w + xx) * 4 + 3] > 12) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y }
  }
  if (x1 < 0) return null
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad)
  const c = document.createElement('canvas')
  c.width = x1 - x0 + 1
  c.height = y1 - y0 + 1
  c.getContext('2d').drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height)
  return c
}

/** Canvas → {rgba, iw, ih, url}. */
export function sigFromCanvas(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height)
  return { rgba: d.data, iw: c.width, ih: c.height, url: c.toDataURL('image/png') }
}

/** data URL → signature object (async). */
export async function sigFromUrl(url) {
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d').drawImage(img, 0, 0)
  return sigFromCanvas(c)
}

/** Open the dialog → Promise<signature | null>. */
export function signatureDialog() {
  return new Promise((resolve) => {
    let mode = 'draw'
    let color = '#111111'
    let width = 2.6
    let typed = ''
    let fontIdx = 0
    let upload = null // canvas
    let removeBg = true
    let save = true
    let done = false
    const body = h('div', { class: 'stack' })
    const strokes = []
    let pad = null

    const finish = (v) => { if (!done) { done = true; resolve(v) } }

    function drawPad() {
      const c = h('canvas', { class: 'sigpad' })
      const ctx = c.getContext('2d')
      const fit = () => {
        const r = c.getBoundingClientRect()
        const dpr = Math.min(2, devicePixelRatio || 1)
        c.width = Math.max(10, Math.round(r.width * dpr))
        c.height = Math.max(10, Math.round(r.height * dpr))
        repaint()
      }
      const repaint = () => {
        ctx.clearRect(0, 0, c.width, c.height)
        const k = c.width / 600
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        // guide line
        ctx.strokeStyle = '#d0d4da'
        ctx.lineWidth = 1
        ctx.setLineDash([6, 6])
        ctx.beginPath(); ctx.moveTo(30 * k, c.height * 0.74); ctx.lineTo(c.width - 30 * k, c.height * 0.74); ctx.stroke()
        ctx.setLineDash([])
        ctx.strokeStyle = color
        for (const s of strokes) {
          for (let i = 1; i < s.length; i++) {
            ctx.lineWidth = s[i][2] * k
            ctx.beginPath()
            ctx.moveTo(s[i - 1][0] * k, s[i - 1][1] * k)
            ctx.lineTo(s[i][0] * k, s[i][1] * k)
            ctx.stroke()
          }
          if (s.length === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(s[0][0] * k, s[0][1] * k, s[0][2] * k / 2, 0, 7); ctx.fill() }
        }
      }
      let cur = null
      const pt = (e) => { const r = c.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * 600, ((e.clientY - r.top) / r.width) * 600] }
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId)
        const [x, y] = pt(e)
        cur = [[x, y, width * (e.pointerType === 'pen' ? 0.5 + e.pressure : 1)]]
        strokes.push(cur)
        repaint()
      })
      c.addEventListener('pointermove', (e) => {
        if (!cur) return
        for (const ev of (e.getCoalescedEvents?.()?.length ? e.getCoalescedEvents() : [e])) {
          const [x, y] = pt(ev)
          const last = cur[cur.length - 1]
          const dist = Math.hypot(x - last[0], y - last[1])
          if (dist < 1) continue
          // faster strokes get thinner, like real ink
          const target = width * (ev.pointerType === 'pen' ? 0.5 + ev.pressure : Math.max(0.55, Math.min(1.25, 1.35 - dist / 30)))
          cur.push([x, y, last[2] * 0.6 + target * 0.4])
        }
        repaint()
      })
      const end = () => { cur = null }
      c.addEventListener('pointerup', end)
      c.addEventListener('pointercancel', end)
      requestAnimationFrame(fit)
      pad = { c, repaint }
      return c
    }

    function typedCanvas(fi = fontIdx, text = typed, col = color) {
      const c = document.createElement('canvas')
      c.width = 1400
      c.height = 360
      const x = c.getContext('2d')
      x.fillStyle = col
      let size = 190
      x.font = `${size}px ${SCRIPT_FONTS[fi]}`
      while (size > 40 && x.measureText(text).width > c.width - 80) { size -= 10; x.font = `${size}px ${SCRIPT_FONTS[fi]}` }
      x.textBaseline = 'middle'
      x.fillText(text, 40, c.height / 2)
      return c
    }

    function uploadCanvas() {
      if (!upload) return null
      const c = document.createElement('canvas')
      c.width = upload.width
      c.height = upload.height
      const x = c.getContext('2d')
      x.drawImage(upload, 0, 0)
      if (removeBg) {
        const id = x.getImageData(0, 0, c.width, c.height)
        const d = id.data
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          // paper → transparent, ink keeps its colour with soft edges
          d[i + 3] = Math.max(0, Math.min(255, (225 - lum) * 3.2))
        }
        x.putImageData(id, 0, 0)
      }
      return c
    }

    function paint() {
      body.replaceChildren(
        Seg([['draw', 'Draw', 'pencil'], ['type', 'Type', 'type'], ['upload', 'Upload', 'upload']], mode, (v) => { mode = v; paint() }, { block: true }),
        ...(mode === 'draw' ? [
          drawPad(),
          h('div', { class: 'row between' },
            h('div', { class: 'row' },
              Swatches(color, (v) => { color = v; pad?.repaint() }, { colors: ['#111111', '#1c3faa', '#0b6e4f'] }),
              Seg([[1.6, 'Fine'], [2.6, 'Medium'], [4, 'Bold']], width, (v) => (width = v))),
            Button({ label: 'Clear', icon: 'trash', size: 'sm', onClick: () => { strokes.length = 0; pad?.repaint() } })),
        ] : mode === 'type' ? [
          TextInput(typed, (v) => { typed = v; paintTiles() }, { placeholder: 'Type your name' }),
          h('div', { class: 'sig-typed', id: 'sig-tiles' }),
          Swatches(color, (v) => { color = v; paintTiles() }, { colors: ['#111111', '#1c3faa', '#0b6e4f'] }),
        ] : [
          upload
            ? h('div', { style: { background: 'repeating-conic-gradient(var(--checker) 0% 25%, var(--surface) 0% 50%) 0 0 / 14px 14px', borderRadius: '10px', padding: '8px', display: 'grid', placeItems: 'center' } },
              (() => { const c = uploadCanvas(); c.style.maxWidth = '100%'; c.style.maxHeight = '180px'; return c })())
            : null,
          Button({ label: upload ? 'Choose another image' : 'Choose an image of your signature', icon: 'image', block: true, onClick: async () => {
            const [f] = await pickFiles({ accept: 'image/*' })
            if (!f) return
            try {
              const bmp = await createImageBitmap(f)
              const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
              const c = document.createElement('canvas')
              c.width = Math.round(bmp.width * k)
              c.height = Math.round(bmp.height * k)
              c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
              upload = c
              paint()
            } catch { toast('Couldn’t read that image', { type: 'error' }) }
          } }),
          upload ? Switch('Remove paper background', removeBg, (v) => { removeBg = v; paint() }, { hint: 'Makes white paper transparent' }) : null,
        ]),
        Switch('Save for next time', save, (v) => (save = v), { hint: 'Stored only in this browser' }),
      )
      if (mode === 'type') paintTiles()
    }
    function paintTiles() {
      const tiles = body.querySelector('#sig-tiles')
      if (!tiles) return
      tiles.replaceChildren(...SCRIPT_FONTS.map((f, i) => h('button', {
        type: 'button', class: i === fontIdx ? 'on' : '', style: { fontFamily: f, color },
        onclick: () => { fontIdx = i; paintTiles() },
      }, typed || 'Your name')))
    }

    modal({
      title: 'Add your signature', body,
      onClose: () => finish(null),
      actions: [
        { label: 'Cancel', onClick: () => finish(null) },
        { label: 'Use signature', variant: 'primary', icon: 'check', onClick: () => {
          let src = null
          if (mode === 'draw') {
            if (!strokes.length) { toast('Draw your signature first', { type: 'error' }); return false }
            const c = document.createElement('canvas')
            c.width = 1200
            c.height = 400
            const x = c.getContext('2d')
            x.lineCap = 'round'
            x.lineJoin = 'round'
            x.strokeStyle = color
            x.fillStyle = color
            for (const s of strokes) {
              for (let i = 1; i < s.length; i++) { x.lineWidth = s[i][2] * 2; x.beginPath(); x.moveTo(s[i - 1][0] * 2, s[i - 1][1] * 2); x.lineTo(s[i][0] * 2, s[i][1] * 2); x.stroke() }
              if (s.length === 1) { x.beginPath(); x.arc(s[0][0] * 2, s[0][1] * 2, s[0][2], 0, 7); x.fill() }
            }
            src = c
          } else if (mode === 'type') {
            if (!typed.trim()) { toast('Type your name first', { type: 'error' }); return false }
            src = typedCanvas()
          } else {
            src = uploadCanvas()
            if (!src) { toast('Choose an image first', { type: 'error' }); return false }
          }
          const t = trim(src)
          if (!t) { toast('The signature is empty', { type: 'error' }); return false }
          const sig = sigFromCanvas(t)
          if (save) storeSignatures([sig.url, ...savedSignatures().filter((s) => s !== sig.url)])
          finish(sig)
          return true
        } },
      ],
    })
    paint()
  })
}
