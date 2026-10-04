// Shared tool scaffolding: header, file intake (with password prompt for
// encrypted PDFs), workspace layout, busy/error handling, result card and the
// in-memory hand-off that lets one tool's output open in the next.
import { h, icon, setKids, saveBlob, readBytes, fmtBytes, plural } from './dom.js'
import { Button, modal, toast, TextInput, Field, Callout } from './kit.js'
import { byId, NEXT, CATS } from './catalog.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves, pageDims } from '../pdf/ops.js'
import { decryptPdf, isEncrypted } from '../pdf/security.js'

// ---------- hand-off between tools ----------
let pending = null
/** Leave a file for the next tool to pick up (consumed once). */
export function handoff(file) { pending = file }
/** Take the handed-off file, if any (a File object). */
export function takeHandoff() { const f = pending; pending = null; return f }

export const catColor = (catId) => CATS.find((c) => c.id === catId)?.color ?? 'var(--accent)'

/** Page header for a tool. */
export function ToolHead(toolId, extra = null) {
  const t = byId(toolId)
  return h('div', { class: 'tool-head' },
    h('a', { class: 'btn btn-ghost btn-icon back', href: '#/', 'data-tip': 'All tools', 'aria-label': 'All tools' }, icon('left')),
    h('div', { class: 'ticon', style: { '--tc': catColor(t.cat) } }, icon(t.icon, 'icon-lg')),
    h('div', { style: { flex: 1, minWidth: 0 } }, h('h1', {}, t.name), h('p', {}, t.desc)),
    extra)
}

/** Two-column workspace: main area + sticky options sidebar. */
export function Workspace(main, side) {
  return h('div', { class: 'workspace' + (side ? '' : ' single') }, h('div', { class: 'ws-main' }, main), side ? h('aside', { class: 'ws-side' }, side) : null)
}

/** Ask for a PDF password. Resolves to the string or null when cancelled. */
export function askPassword(fileName, { wrong = false } = {}) {
  return new Promise((resolve) => {
    let val = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const input = TextInput('', (v) => (val = v), { type: 'password', placeholder: 'Password', onEnter: () => { finish(val); m.close() } })
    const m = modal({
      title: 'This PDF is password-protected',
      body: [
        h('p', { style: { margin: 0, color: 'var(--text-2)' } }, h('b', {}, fileName), ' needs a password to open. It is unlocked here in your browser — the password never leaves this device.'),
        wrong ? Callout('That password didn’t work — try again.', { type: 'danger' }) : null,
        Field('Password', input),
      ],
      onClose: () => finish(null),
      actions: [{ label: 'Cancel', onClick: () => finish(null) }, { label: 'Unlock', variant: 'primary', onClick: () => finish(val) }],
    })
  })
}

/**
 * Read + parse a PDF File, prompting for a password when it's encrypted.
 * Returns {file, name, size, bytes, doc, leaves, dims, wasEncrypted} or null if cancelled.
 * Throws a friendly Error for unreadable files.
 */
export async function openPdf(file, { allowEncrypted = false } = {}) {
  let bytes = await readBytes(file)
  let wasEncrypted = false
  if (!isPdfHeader(bytes)) throw new Error(`“${file.name}” doesn’t look like a PDF`)
  if (!allowEncrypted && await isEncrypted(bytes).catch(() => false)) {
    wasEncrypted = true
    let wrong = false
    // owner-password-only files (open freely, restricted) unlock with an empty password
    try { bytes = await decryptPdf(bytes, ''); wrong = null } catch { /* needs a real password */ }
    while (wrong !== null) {
      const pwd = await askPassword(file.name, { wrong })
      if (pwd === null) return null
      try { bytes = await decryptPdf(bytes, pwd); wrong = null } catch (e) {
        if (/wrong password/.test(e.message)) wrong = true
        else throw e
      }
    }
  }
  let doc
  try { doc = await parsePdf(bytes, [], allowEncrypted) } catch (e) { throw new Error(friendly(e, file.name)) }
  const leaves = pageLeaves(doc)
  if (!leaves.length) throw new Error(`“${file.name}” has no pages we can read`)
  return { file, name: file.name, size: file.size, bytes, doc, leaves, dims: pageDims(doc), wasEncrypted }
}

const isPdfHeader = (b) => {
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024))
  return head.includes('%PDF')
}

export function friendly(e, name = 'this file') {
  const m = e?.message || String(e)
  if (/password|encrypt/i.test(m)) return m
  if (/no trailer|not a PDF/i.test(m)) return `“${name}” isn’t a readable PDF (it may be damaged)`
  return m || 'Something went wrong'
}

/**
 * Run an async task with a busy button + error toast.
 * Returns the task result or undefined on failure.
 */
export async function runTask(setBusy, fn) {
  setBusy(true)
  try {
    return await fn()
  } catch (e) {
    console.error(e)
    toast(friendly(e), { type: 'error' })
    return undefined
  } finally {
    setBusy(false)
  }
}

/**
 * Result card after a successful run.
 * {title, sub, blob, filename, toolId, onAgain, extra}
 * Auto-downloads once; offers download again, "continue with" chips and start over.
 */
export function ResultCard({ title = 'Done!', sub, blob, filename, toolId, onAgain, extra, autoDownload = true }) {
  if (autoDownload && blob) saveBlob(blob, filename)
  const next = (NEXT[toolId] ?? []).map(byId).filter(Boolean)
  const isPdf = blob && /pdf$/i.test(filename)
  return h('div', { class: 'result' },
    h('div', { class: 'r-head' },
      h('div', { class: 'r-ok' }, icon('check', 'icon')),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('h3', {}, title),
        h('div', { class: 'r-sub' }, sub ?? [filename, blob ? fmtBytes(blob.size) : null].filter(Boolean).join(' · '))),
    ),
    extra ?? null,
    h('div', { class: 'row' },
      blob ? Button({ label: 'Download again', icon: 'download', variant: 'primary', onClick: () => saveBlob(blob, filename) }) : null,
      onAgain ? Button({ label: 'Start over', icon: 'refresh', onClick: onAgain }) : null),
    isPdf && next.length ? h('div', { class: 'r-next' }, 'Continue with',
      next.map((t) => h('a', {
        class: 'chip', href: `#/${t.route ?? t.id}`,
        onclick: () => handoff(new File([blob], filename, { type: 'application/pdf' })),
      }, icon(t.icon, 'icon-sm'), t.name))) : null)
}

/** Simple "N pages · X MB" meta string. */
export const docMeta = (info) => [plural(info.leaves.length, 'page'), info.wasEncrypted ? 'unlocked' : null].filter(Boolean).join(' · ')

/** Mount helper for tools: root element + render(...) that swaps contents. */
export function mount() {
  const root = h('div', { class: 'tool' })
  return { root, render: (...kids) => setKids(root, ...kids) }
}

