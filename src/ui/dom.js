// Tiny DOM helper — h(tag, attrs, ...children). No framework, no build.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null) continue
    if (k === 'class') el.className = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue
    el.append(kid?.nodeType ? kid : document.createTextNode(String(kid)))
  }
  return el
}

// Hand-drawn SVG icons (stroke style, 24 viewBox) — zero icon library.
const ICONS = {
  upload: 'M12 16V4m0 0 4 4m-4-4-4 4M4 20h16',
  files: 'M8 3h8l4 4v14H8zM16 3v4h4M4 7v14h12v-3',
  scissors: 'M6 6l14 12M6 18 20 6M6 6a2 2 0 1 0 .1 0M6 18a2 2 0 1 0 .1 0',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M9 9.5a1.5 1.5 0 1 0 .1 0',
  download: 'M12 4v12m0 0 4-4m-4 4-4-4M4 20h16',
  x: 'M6 6l12 12M18 6 6 18',
  rotate: 'M20 8A8 8 0 1 0 20 15M20 4v4h-4',
  rotl: 'M4 8A8 8 0 1 1 4 15M4 4v4h4',
  check: 'M4 12l5 5L20 6',
  undo: 'M8 6 4 10l4 4M4 10h10a6 6 0 0 1 0 12h-2',
  up: 'M12 19V5m0 0-5 5m5-5 5 5',
  down: 'M12 5v14m0 0 5-5m-5 5-5-5',
  github:
    'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
  shield: 'M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6zM9 12l2 2 4-4',
  layers: 'M12 3 2 9l10 6 10-6zM4 12.5 12 17l8-4.5M4 16.5 12 21l8-4.5',
  hash: 'M9 4 7 20M17 4l-2 16M4 9h17M3 15h17',
  eraser: 'M7 19h14M9 19 3.5 13.5a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l6 6a2 2 0 0 1 0 2.8L13 19',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16.5 16.5 21 21M11 8v6M8 11h6',
}

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', name === 'github' ? '0 0 16 16' : '0 0 24 24')
  svg.setAttribute('class', cls)
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  p.setAttribute('d', ICONS[name])
  if (name === 'github') p.setAttribute('fill', 'currentColor')
  else {
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', 'currentColor')
    p.setAttribute('stroke-width', '1.8')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
  }
  svg.append(p)
  return svg
}

// replaceChildren converts null/undefined args into literal "null" text nodes —
// always re-render through this instead.
export function setKids(el, ...kids) {
  el.replaceChildren(...kids.filter((k) => k !== null && k !== undefined && k !== false))
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const readBytes = async (file) => new Uint8Array(await file.arrayBuffer())

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
