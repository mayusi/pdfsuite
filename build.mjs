// Zero-dep build. Produces two artifacts in dist/:
//   1. the normal site (index.html + styles.css + src/ modules) for GitHub Pages
//   2. pdfsuite.html — the ENTIRE app inlined into one file. Double-click it and
//      it runs with no server, no network, no modules — works over file://.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { crc32 } from './src/zip.js'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })


// --- single-file bundle -----------------------------------------------------
// Dependency order matters: everything is concatenated into ONE <script>, so
// every top-level name must be unique across modules (verified: they are).
const MODULES = [
  'src/pdf/types.js',
  'src/pdf/env.js',
  'src/pdf/crypto.js',
  'src/pdf/filters.js',
  'src/pdf/parse.js',
  'src/pdf/write.js',
  'src/pdf/encodings.js',
  'src/pdf/functions.js',
  'src/pdf/image.js',
  'src/pdf/outline.js',
  'src/pdf/metrics.js',
  'src/zip.js',
  'src/png.js',
  'src/pdf/content.js',
  'src/pdf/ops.js',
  'src/pdf/security.js',
  'src/pdf/stamp.js',
  'src/pdf/redact.js',
  'src/pdf/forms.js',
  'src/pdf/render.js',
  'src/ui/dom.js',
  'src/ui/kit.js',
  'src/ui/catalog.js',
  'src/ui/tool.js',
  'src/ui/pages.js',
  'src/ui/preview.js',
  'src/editor/annots.js',
  'src/editor/view.js',
  'src/editor/signature.js',
  'src/editor/props.js',
  'src/editor/export.js',
  'src/tools/merge.js',
  'src/tools/split.js',
  'src/tools/organize.js',
  'src/tools/rotate.js',
  'src/tools/edit.js',
  'src/tools/img2pdf.js',
  'src/tools/extract.js',
  'src/tools/pagenum.js',
  'src/tools/watermark.js',
  'src/tools/pdf2img.js',
  'src/tools/pdftext.js',
  'src/tools/compress.js',
  'src/tools/protect.js',
  'src/tools/metadata.js',
  'src/app.js',
]

// every src module must be listed — a forgotten one fails at runtime, not here
const listed = new Set(MODULES)
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.js') ? [`${d}/${e.name}`] : []))
for (const f of walk('src')) if (!listed.has(f)) throw new Error(`${f} is not in build.mjs MODULES`)

let bundle = ''
const seen = new Map() // top-level name → module (one shared scope in the bundle)
for (const m of MODULES) {
  const src = readFileSync(m, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('import '))
    .map((l) => (l.startsWith('export ') ? l.slice(7) : l))
    .join('\n')
  if (/^import /m.test(src)) throw new Error(`multi-line import in ${m} — bundler can't handle it`)
  if (src.includes('</script>')) throw new Error(`literal </script> in ${m} would break inline bundle`)
  for (const [, nm] of src.matchAll(/^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(nm)) throw new Error(`top-level name "${nm}" in ${m} collides with ${seen.get(nm)}`)
    seen.set(nm, m)
  }
  bundle += `\n// ---- ${m} ----\n${src}`
}

const css = readFileSync('styles.css', 'utf8')
const html = readFileSync('index.html', 'utf8')
  .replace('<link rel="stylesheet" href="./styles.css" />', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="./src/app.js"></script>', () => `<script>\n${bundle}</script>`)

writeFileSync('dist/pdfsuite.html', html)
// Also write to repo root: it is committed so GitHub Pages serves it and the
// footer link (./pdfsuite.html) resolves on the live site.
writeFileSync('pdfsuite.html', html)
console.log('dist/ + pdfsuite.html ready — static site + single-file app (works offline from double-click)')

// --- PWA: icons, manifest, service worker ---------------------------------
// Icons are drawn here (no image tools needed): accent rounded square + page.
function drawIcon(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 4)
  const SS = 4 // supersampling for smooth edges
  const inside = (x, y) => {
    const u = x / size, v = y / size
    // background: rounded square (maskable icons fill the whole tile)
    const r = maskable ? 0 : 0.234, pad = 0
    const bx = Math.max(Math.abs(u - 0.5) - (0.5 - pad - r), 0), by = Math.max(Math.abs(v - 0.5) - (0.5 - pad - r), 0)
    const bg = maskable || Math.hypot(bx, by) <= r
    if (!bg) return 0
    // page: rect with folded corner, scaled down for maskable safe zone
    const k = maskable ? 0.72 : 1
    const pu = (u - 0.5) / k + 0.5, pv = (v - 0.5) / k + 0.5
    const inPage = pu >= 0.297 && pu <= 0.719 && pv >= 0.203 && pv <= 0.813 && !(pu > 0.563 && pv < 0.359 && pu - 0.563 > pv - 0.203)
    if (!inPage) return 1
    const lines = [0.5, 0.594, 0.688]
    for (const [i, ly] of lines.entries()) {
      const x1 = i === 2 ? 0.53 : 0.61
      if (Math.abs(pv - ly) < 0.024 && pu > 0.39 && pu < x1) return 1
    }
    return 2
  }
  const colors = [[0, 0, 0, 0], [14, 159, 110, 255], [255, 255, 255, 255]]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = colors[inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)]
        for (let k = 0; k < 4; k++) acc[k] += c[k] * (k === 3 ? 1 : c[3] / 255)
      }
      const o = (y * size + x) * 4
      const a = acc[3] / (SS * SS)
      for (let k = 0; k < 3; k++) px[o + k] = a ? Math.round(acc[k] / (SS * SS) / (a / 255)) : 0
      px[o + 3] = Math.round(a)
    }
  }
  return pngDeflated(size, size, px)
}

/** RGBA → PNG with real zlib compression (build-time only; the browser encoder stays dependency-free). */
function pngDeflated(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
const icons = { 'icon-192.png': drawIcon(192), 'icon-512.png': drawIcon(512), 'icon-maskable-512.png': drawIcon(512, { maskable: true }) }
const manifest = {
  name: 'PDFSuite — free PDF tools', short_name: 'PDFSuite',
  description: 'Edit, sign, merge, split, compress and convert PDFs — privately, in your browser.',
  start_url: './', scope: './', display: 'standalone', background_color: '#0c0d10', theme_color: '#0e9f6e',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
}
for (const [name, data] of Object.entries(icons)) writeFileSync(name, data)
writeFileSync('manifest.webmanifest', JSON.stringify(manifest, null, 2))

// service worker: cache-first app shell, versioned by a hash of every file it serves
const SHELL = ['./', 'index.html', 'styles.css', 'favicon.svg', 'manifest.webmanifest', 'pdfsuite.html', ...Object.keys(icons), ...MODULES]
const hash = createHash('sha256')
for (const f of SHELL) if (f !== './') hash.update(readFileSync(f))
const version = hash.digest('hex').slice(0, 12)
const sw = `// Generated by build.mjs — offline support. Version changes whenever any file does.
const CACHE = 'pdfsuite-${version}'
const SHELL = ${JSON.stringify(SHELL)}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('pdfsuite-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
    return res
  }).catch(() => caches.match('index.html'))))
})
`
writeFileSync('sw.js', sw)

// static site for Pages / any host
for (const p of ['index.html', 'styles.css', 'favicon.svg', 'src', 'sw.js', 'manifest.webmanifest', 'pdfsuite.html', ...Object.keys(icons)]) cpSync(p, `dist/${p}`, { recursive: true })
console.log(`PWA: sw.js (cache ${version}), manifest, ${Object.keys(icons).length} icons`)
