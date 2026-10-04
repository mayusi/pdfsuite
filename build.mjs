// Zero-dep build. Produces two artifacts in dist/:
//   1. the normal site (index.html + styles.css + src/ modules) for GitHub Pages
//   2. pdfsuite.html — the ENTIRE app inlined into one file. Double-click it and
//      it runs with no server, no network, no modules — works over file://.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })
for (const p of ['index.html', 'styles.css', 'favicon.svg', 'src']) cpSync(p, `dist/${p}`, { recursive: true })

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
  'src/zip.js',
  'src/png.js',
  'src/pdf/ops.js',
  'src/pdf/security.js',
  'src/pdf/render.js',
  'src/ui/dom.js',
  'src/ui/widgets.js',
  'src/tools/merge.js',
  'src/tools/split.js',
  'src/tools/organize.js',
  'src/tools/edit.js',
  'src/tools/img2pdf.js',
  'src/tools/extract.js',
  'src/tools/pagenum.js',
  'src/tools/watermark.js',
  'src/tools/pdf2png.js',
  'src/tools/pdftext.js',
  'src/tools/compress.js',
  'src/tools/protect.js',
  'src/tools/scrub.js',
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
