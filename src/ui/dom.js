// Tiny DOM helper — h(tag, attrs, ...children). No framework, no build.

export function h(tag, attrs, ...kids) {
  const el = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.setAttribute('class', v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k === 'style' && typeof v === 'object') {
      // custom properties (--x) only work through setProperty, not assignment
      for (const [sk, sv] of Object.entries(v)) if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'value' && 'value' in el) el.value = v
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'multiple') { el[k] = !!v; if (v) el.setAttribute(k, '') }
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid?.nodeType ? kid : document.createTextNode(String(kid)))
  }
  return el
}

// Hand-drawn stroke icons on a 24 grid — zero icon library.
const ICONS = {
  upload: 'M12 16V4m0 0 4 4m-4-4-4 4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  download: 'M12 4v12m0 0 4-4m-4 4-4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  files: 'M9 7V5a2 2 0 0 1 2-2h5l4 4v10a2 2 0 0 1-2 2h-2M16 3v4h4M4 9a2 2 0 0 1 2-2h5l4 4v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM11 7v4h4',
  merge: 'M7 4v5a5 5 0 0 0 5 5 5 5 0 0 1 5 5v1M17 4v5a5 5 0 0 1-2 4M4 7l3-3 3 3M14 7l3-3 3 3',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M15.5 9a1.5 1.5 0 1 0 0-.01',
  x: 'M6 6l12 12M18 6 6 18',
  rotate: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  rotl: 'M3 12a9 9 0 1 0 3-6.7M3 3v6h6',
  check: 'M4 12.5l5 5L20 6.5',
  checkCircle: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  up: 'M12 19V5m0 0-6 6m6-6 6 6',
  down: 'M12 5v14m0 0 6-6m-6 6-6-6',
  left: 'M19 12H5m0 0 6 6m-6-6 6-6',
  right: 'M5 12h14m0 0-6-6m6 6-6 6',
  chevDown: 'M6 9l6 6 6-6',
  chevRight: 'M9 6l6 6-6 6',
  chevLeft: 'M15 6l-6 6 6 6',
  shield: 'M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6zM9 12l2 2 4-4',
  layers: 'M12 3 2 8.5l10 5.5 10-5.5zM2 13l10 5.5L22 13M2 17.5 12 23l10-5.5',
  hash: 'M9 4 7 20M17 4l-2 16M4 9h17M3 15h17',
  eraser: 'M7 20h13M9.5 19.5 3.6 13.6a2 2 0 0 1 0-2.8L11 3.4a2 2 0 0 1 2.8 0l5.8 5.8a2 2 0 0 1 0 2.8L12 19.6',
  pencil: 'M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21M11 8v6M8 11h6',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5zM12 15v2',
  unlock: 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5zM12 15v2',
  filetext: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6M9 9h1',
  shrink: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  droplet: 'M12 3s6.5 6.6 6.5 11.2A6.5 6.5 0 0 1 5.5 14.2C5.5 9.6 12 3 12 3z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  github: '',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  copy: 'M9 9h10v12H9zM5 15V5a2 2 0 0 1 2-2h8',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  cursor: 'M5 3l14 7.5-6.2 1.7-2.3 6.3z',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  editText: 'M4 7V5h11v2M9.5 5v14M7.5 19h4M15 13l4.5-4.5 2 2L17 15h-2zM14 20h7',
  highlight: 'M9 11l-5 5v4h4l5-5M14 6l4 4M9 11l6.5-6.5a2.1 2.1 0 0 1 3 3L12 14z',
  square: 'M4 4h16v16H4z',
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  line: 'M5 19 19 5',
  arrow: 'M5 19 19 5M10 5h9v9',
  shapes: 'M3 13h8v8H3zM17 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM13 21l4-7 4 7z',
  whiteout: 'M3 6h18v12H3zM7 10h10M7 14h6',
  redact: 'M3 6h18v4H3zM3 14h11v4H3zM17 14h4v4h-4z',
  signature: 'M3 17c3-1 4.5-9 7-9 2 0 0 8 2.5 8 1.6 0 2.5-3 4-3 1.2 0 1.3 2 2.5 2H21M3 21h18',
  stamp: 'M5 21h14M6 17h12v-3a2 2 0 0 0-2-2h-1.5c0-2 1.5-3 1.5-5a4 4 0 0 0-8 0c0 2 1.5 3 1.5 5H8a2 2 0 0 0-2 2z',
  note: 'M5 4h14v11l-5 5H5zM14 20v-5h5',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  fitW: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 5V3.5a1.5 1.5 0 0 1 3 0V11M14 5.5a1.5 1.5 0 0 1 3 0V11M17 8.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.6 15.3a1.6 1.6 0 0 1 2.3-2.2L8 14',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  alert: 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
  sparkles: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z',
  italic: 'M14 4h-4M14 20h-4M15 4 9 20',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 21h14',
  strike: 'M5 12h14M16 6.5C15.3 5 13.8 4 12 4c-2.5 0-4.3 1.6-4 3.6.2 1.5 1.4 2.4 3 3M8 17.5c.7 1.5 2.2 2.5 4 2.5 2.5 0 4.4-1.6 4-3.8',
  alignL: 'M4 6h16M4 10h10M4 14h16M4 18h10',
  alignC: 'M4 6h16M7 10h10M4 14h16M7 18h10',
  alignR: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  form: 'M4 6h16v4H4zM4 14h16v4H4zM7 8h4M7 16h6',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  pageAdd: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6',
  home: 'M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5',
  palette: 'M12 3a9 9 0 0 0 0 18c1.1 0 1.5-.8 1.5-1.6 0-1-.8-1.4-.8-2.3 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.6-4-8.5-9-8.5zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01M17 11h.01',
  bars: 'M4 6h16M4 12h16M4 18h16',
  dash: 'M3 12h4M10 12h4M17 12h4',
  dot: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  wand: 'M4 20 14 10M14 10l2-2M16 4v2M20 8h-2M18.5 5.5 17 7M10 4l.5 1.5L12 6l-1.5.5L10 8l-.5-1.5L8 6l1.5-.5z',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7',
  front: 'M8 8h12v12H8zM4 16V4h12',
  back: 'M4 4h12v12H4zM8 20h12V8',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5',
  crop: 'M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2',
}
const GITHUB = 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z'

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', name === 'github' ? '0 0 16 16' : '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  if (name === 'github') {
    p.setAttribute('d', GITHUB)
    p.setAttribute('fill', 'currentColor')
  } else {
    p.setAttribute('d', ICONS[name] ?? ICONS.file)
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', 'currentColor')
    p.setAttribute('stroke-width', name === 'more' || name === 'grip' ? '3' : '1.8')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
  }
  svg.append(p)
  return svg
}

// replaceChildren converts null/undefined args into literal "null" text nodes —
// always re-render through this instead.
export function setKids(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false))
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: name, style: { display: 'none' } })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export const readBytes = async (file) => new Uint8Array(await file.arrayBuffer())

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10485760 ? 2 : 1)} MB`
}

export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`
export const stem = (filename) => filename.replace(/\.[^.]+$/, '')

/** Run fn on the next animation frame at most once per frame. */
export function rafThrottle(fn) {
  let id = 0
  let args = null
  return (...a) => {
    args = a
    if (id) return
    id = requestAnimationFrame(() => { id = 0; fn(...args) })
  }
}
