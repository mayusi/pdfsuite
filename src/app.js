import { h, icon, setKids } from './ui/dom.js'
import { modal, toast, filterAccept } from './ui/kit.js'
import { CATALOG, CATS, byId } from './ui/catalog.js'
import { handoff, catColor } from './ui/tool.js'
import { Merge } from './tools/merge.js'
import { Split } from './tools/split.js'
import { Organize } from './tools/organize.js'
import { Rotate } from './tools/rotate.js'
import { Crop } from './tools/crop.js'
import { ImgToPdf } from './tools/img2pdf.js'
import { ExtractImgs } from './tools/extract.js'
import { PageNums } from './tools/pagenum.js'
import { Metadata } from './tools/metadata.js'
import { PdfToImg } from './tools/pdf2img.js'
import { PdfToText } from './tools/pdftext.js'
import { Compress } from './tools/compress.js'
import { Watermark } from './tools/watermark.js'
import { Protect, Unlock } from './tools/protect.js'
import { Edit } from './tools/edit.js'

const VIEWS = {
  edit: Edit, merge: Merge, split: Split, organize: Organize, rotate: Rotate, crop: Crop, img2pdf: ImgToPdf,
  extract: ExtractImgs, pagenum: PageNums, metadata: Metadata, pdf2img: PdfToImg, pdftext: PdfToText,
  compress: Compress, watermark: Watermark, protect: Protect, unlock: Unlock,
}
// old links keep working
const ALIASES = { scrub: 'metadata', pdf2png: 'pdf2img' }

const app = document.getElementById('app')
let cleanup = null

// ---------- theme ----------
const THEME_KEY = 'pdfsuite-theme'
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY) } catch { return null } }
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
}
applyTheme(storedTheme())
const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'
function toggleTheme() {
  const next = isDark() ? 'light' : 'dark'
  applyTheme(next)
  try { localStorage.setItem(THEME_KEY, next) } catch { /* private mode */ }
  render()
}

// ---------- routing ----------
function route() {
  const raw = location.hash.replace(/^#\/?/, '')
  const [path, q = ''] = raw.split('?')
  const params = Object.fromEntries(new URLSearchParams(q))
  return { id: ALIASES[path] ?? path, params }
}

function topbar() {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, icon('file', 'icon-sm')), h('span', {}, 'PDF', h('span', { class: 'accent' }, 'Suite'))),
    h('span', { class: 'topbar-tag' }, icon('shield', 'icon-sm'), 'Free · no uploads · no account'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-ghost btn-icon', 'data-tip': isDark() ? 'Light mode' : 'Dark mode', 'aria-label': 'Toggle theme', onclick: toggleTheme }, icon(isDark() ? 'sun' : 'moon')),
    h('a', { class: 'btn btn-ghost btn-icon', href: 'https://github.com/mayusi/pdfsuite', 'data-tip': 'Source code', 'aria-label': 'Source on GitHub', target: '_blank', rel: 'noopener' }, icon('github')))
}

function footer() {
  return h('footer', { class: 'footer' },
    h('p', {}, 'Smallpdf charges $12/month and iLovePDF $9/month to process ', h('em', {}, 'your'), ' documents on ', h('em', {}, 'their'), ' servers. PDFSuite does it on your own device for $0 — no uploads, no account, no limits. Every line is hand-written, dependency-free JavaScript you can read. MIT licensed.'),
    h('p', {}, 'Want it offline? ', h('a', { href: './pdfsuite.html', download: 'pdfsuite.html' }, 'Download the whole app as one HTML file'), ' — it works from a double-click, no internet needed.'))
}

function toolCard(t) {
  const href = `#/${t.route ?? t.id}`
  return h('a', { class: 'toolcard', href, style: { '--tc': catColor(t.cat) } },
    h('div', { class: 'ticon' }, icon(t.icon, 'icon-lg')),
    h('div', {}, h('h3', {}, t.name, t.isNew ? h('span', { class: 'new' }, 'New') : null), h('p', {}, t.desc)))
}

function home() {
  let q = ''
  const results = h('div')
  const paint = () => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const match = (t) => terms.every((w) => `${t.name} ${t.desc} ${t.kw}`.toLowerCase().includes(w))
    if (terms.length) {
      const hits = CATALOG.filter(match)
      setKids(results, hits.length
        ? h('div', { class: 'cat' }, h('div', { class: 'tgrid' }, hits.map(toolCard)))
        : h('p', { class: 'empty-search' }, `No tool matches “${q}”.`))
    } else {
      setKids(results, CATS.map((c) => h('section', { class: 'cat' },
        h('h2', {}, h('i', { style: { background: c.color } }), c.name),
        h('div', { class: 'tgrid' }, CATALOG.filter((t) => t.cat === c.id).map(toolCard)))))
    }
  }
  const search = h('input', {
    class: 'input', type: 'search', placeholder: 'Search tools — try “sign” or “smaller”', 'aria-label': 'Search tools',
    oninput: (e) => { q = e.target.value; paint() },
    onkeydown: (e) => {
      if (e.key === 'Enter') { const first = results.querySelector('.toolcard'); if (first) location.hash = first.getAttribute('href') }
    },
  })
  paint()
  const onKey = (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); search.focus() }
  }
  document.addEventListener('keydown', onKey)
  cleanup = () => document.removeEventListener('keydown', onKey)
  return h('main', { class: 'content' },
    h('section', { class: 'hero' },
      h('h1', {}, 'Every PDF tool you need. ', h('span', { class: 'accent' }, 'Free, private, no uploads.')),
      h('p', {}, 'Edit, sign, merge, split, compress and convert PDFs right in your browser. Your files never leave your device.'),
      h('div', { class: 'search' }, icon('search'), search, h('span', { class: 'kbd' }, '/')),
      h('div', { class: 'trust' },
        h('span', {}, icon('shield', 'icon-sm'), 'Files stay on your device'),
        h('span', {}, icon('check', 'icon-sm'), 'No sign-up, no limits'),
        h('span', {}, icon('download', 'icon-sm'), 'Works offline'),
        h('span', {}, icon('sparkles', 'icon-sm'), 'Open source'))),
    results,
    h('section', { class: 'compare' },
      h('h2', {}, 'Why pay for this?'),
      h('table', { class: 'ctable' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Smallpdf / iLovePDF'), h('th', {}, 'PDFSuite'))),
        h('tbody', {},
          [['Price', '$108–144 per year', '$0, forever'], ['Your files', 'Uploaded to their servers', 'Never leave your device'],
            ['Account', 'Required past the free tier', 'Never'], ['Limits', '2 tasks/day on free plans', 'Unlimited'],
            ['Offline', 'No', 'Yes — even as a single file']].map(([a, b, c]) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', {}, c)))))),
    h('p', { class: 'muted small', style: { textAlign: 'center', marginTop: '28px' } }, 'Tip: drop a PDF anywhere on this page to pick a tool for it.'))
}

function notFound() {
  return h('main', { class: 'content' }, h('section', { class: 'hero' }, h('h1', {}, 'Page not found'), h('p', {}, h('a', { href: '#/' }, 'Back to all tools'))))
}

function render() {
  cleanup?.()
  cleanup = null
  const { id, params } = route()
  const view = VIEWS[id]
  if (id === 'edit') {
    // the editor is a full-screen workspace: no site chrome
    setKids(app, view(params))
  } else if (view) {
    setKids(app, h('div', { class: 'shell' }, topbar(), h('main', { class: 'content' }, view(params)), footer()))
  } else {
    setKids(app, h('div', { class: 'shell' }, topbar(), id ? notFound() : home(), footer()))
  }
  scrollTo(0, 0)
  const t = byId(Object.keys(VIEWS).includes(id) ? id : '')
  document.title = t ? `${t.name} — PDFSuite` : 'PDFSuite — free PDF tools, no uploads'
}

// ---------- global drag & drop ----------
// Dropping a file anywhere other than a drop zone must never navigate away
// (the browser would open the PDF and wipe the app). On the home page a
// dropped PDF opens a "what do you want to do?" picker.
addEventListener('dragover', (e) => e.preventDefault())
addEventListener('drop', (e) => {
  if (e.target.closest?.('.dz')) return
  e.preventDefault()
  const files = [...(e.dataTransfer?.files ?? [])]
  if (!files.length) return
  const { id } = route()
  if (id) { toast('Drop files onto the drop area', { type: 'info' }); return }
  const pdfs = filterAccept(files, 'application/pdf')
  const imgs = filterAccept(files, 'image/*')
  if (imgs.length && !pdfs.length) { handoff(imgs); location.hash = '#/img2pdf'; return }
  if (!pdfs.length) { toast('That isn’t a PDF', { type: 'error' }); return }
  if (pdfs.length > 1) { handoff(pdfs); location.hash = '#/merge'; return }
  const m = modal({
    title: `What do you want to do with “${pdfs[0].name}”?`, wide: true,
    body: h('div', { class: 'tgrid' }, CATALOG.filter((t) => t.id !== 'img2pdf').map((t) => {
      const card = toolCard(t)
      card.addEventListener('click', () => { handoff(pdfs[0]); m.close() })
      return card
    })),
  })
})

addEventListener('hashchange', render)
render()

// offline support: cache the app shell (skipped for file:// and dev servers that disable it)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
