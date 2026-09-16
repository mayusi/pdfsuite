import { h, icon } from './ui/dom.js'
import { Merge } from './tools/merge.js'
import { Split } from './tools/split.js'
import { Organize } from './tools/organize.js'
import { ImgToPdf } from './tools/img2pdf.js'
import { ExtractImgs } from './tools/extract.js'
import { PageNums } from './tools/pagenum.js'
import { Scrub } from './tools/scrub.js'
import { PdfToPng } from './tools/pdf2png.js'
import { PdfToText } from './tools/pdftext.js'
import { Compress } from './tools/compress.js'
import { Watermark } from './tools/watermark.js'
import { Protect } from './tools/protect.js'

const TOOLS = [
  { id: 'merge', name: 'Merge PDF', desc: 'Combine PDFs into one, in your order', icon: 'files', view: Merge },
  { id: 'split', name: 'Split PDF', desc: 'Pull out page ranges — one file or a zip', icon: 'scissors', view: Split },
  { id: 'organize', name: 'Organize pages', desc: 'Reorder, rotate and delete pages visually', icon: 'grid', view: Organize },
  { id: 'img2pdf', name: 'Images to PDF', desc: 'JPG/PNG/WebP pages into a single PDF', icon: 'image', view: ImgToPdf },
  { id: 'extract', name: 'Extract images', desc: 'Pull embedded images out — JPG/PNG in a zip', icon: 'layers', view: ExtractImgs },
  { id: 'pagenum', name: 'Page numbers', desc: 'Stamp "N / total" on every page', icon: 'hash', view: PageNums },
  { id: 'watermark', name: 'Watermark', desc: 'Diagonal translucent text on every page', icon: 'droplet', view: Watermark },
  { id: 'pdf2png', name: 'PDF to PNG', desc: 'Render every page to images, in a zip', icon: 'download', view: PdfToPng },
  { id: 'pdftext', name: 'PDF to text', desc: 'Pull the text out, pages in order', icon: 'filetext', view: PdfToText },
  { id: 'compress', name: 'Compress PDF', desc: 'Recompress streams + re-encode images', icon: 'shrink', view: Compress },
  { id: 'protect', name: 'Protect / Unlock', desc: 'Password-protect or unlock a PDF', icon: 'lock', view: Protect },
  { id: 'scrub', name: 'Scrub metadata', desc: 'Strip author, producer, XMP and doc IDs', icon: 'eraser', view: Scrub },
]

const app = document.getElementById('app')

function route() {
  return location.hash.replace(/^#\/?/, '')
}

function header() {
  return h(
    'header',
    {},
    h('a', { class: 'brand', href: '#/' }, h('b', {}, 'PDF', h('span', { class: 'accent' }, 'Suite')),
      h('span', { class: 'tagline' }, 'free forever · no account · no uploads · zero dependencies')),
    h('a', { class: 'gh', href: 'https://github.com/mayusi/pdfsuite', title: 'Source on GitHub' },
      icon('github', 'icon')),
  )
}

function footer() {
  return h(
    'footer',
    {},
    h(
      'p',
      {},
      'Smallpdf charges $12/mo · iLovePDF $9/mo — to upload ',
      h('em', {}, 'your'),
      ' documents to ',
      h('em', {}, 'their'),
      ' servers for work your own browser can do. PDFSuite does the same job for $0, your files never leave the machine, and the entire app is hand-written JavaScript you can read end-to-end. MIT licensed. ',
    ),
    h(
      'p',
      {},
      'Want it offline? ',
      h('a', { href: './pdfsuite.html', download: 'pdfsuite.html' }, 'Download the whole app as one HTML file'),
      ' — same code, works from a double-click.',
    ),
  )
}

function home() {
  return h(
    'main',
    {},
    h('h1', {}, "Every PDF tool you'd pay Smallpdf $12/mo for. ", h('span', { class: 'accent' }, 'Free.')),
    h('p', { class: 'sub' }, icon('shield', 'icon-sm accent'),
      'Files never leave your browser — every tool runs 100% client-side with zero dependencies. Check the network tab, then check the source.'),
    h(
      'div',
      { class: 'grid' },
      TOOLS.map((t) =>
        h('a', { class: 'toolcard', href: `#/${t.id}` },
          icon(t.icon, 'icon-lg accent'),
          h('h2', {}, t.name),
          h('p', {}, t.desc)),
      ),
    ),
  )
}

function toolView(tool) {
  return h(
    'main',
    {},
    h('a', { class: 'back', href: '#/' }, '← all tools'),
    h('h1', {}, tool.name),
    h('p', { class: 'sub' }, tool.desc),
    tool.view(),
  )
}

function render() {
  const tool = TOOLS.find((t) => t.id === route())
  app.replaceChildren(header(), tool ? toolView(tool) : home(), footer())
  scrollTo(0, 0)
}

// Dropping a file anywhere EXCEPT a dropzone must not navigate away and nuke the app.
addEventListener('dragover', (e) => e.preventDefault())
addEventListener('drop', (e) => {
  if (!e.target.closest?.('.dropzone')) e.preventDefault()
})

addEventListener('hashchange', render)
render()
