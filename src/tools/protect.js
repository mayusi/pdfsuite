import { h, icon, stem, readBytes } from '../ui/dom.js'
import { Button, Dropzone, Field, Seg, Switch, TextInput, FileChip, pickFiles, toast, Callout } from '../ui/kit.js'
import { ToolHead, Workspace, ResultCard, openPdf, runTask, takeHandoff, mount, docMeta } from '../ui/tool.js'
import { protectPdf, decryptPdf, isEncrypted } from '../pdf/security.js'
import { parsePdf } from '../pdf/parse.js'
import { pageLeaves } from '../pdf/ops.js'

/** Password field with show/hide toggle. */
function PwdInput(value, onInput, placeholder = 'Password') {
  const input = TextInput(value, onInput, { type: 'password', placeholder, autocomplete: 'new-password' })
  const eye = h('button', { type: 'button', 'aria-label': 'Show password', onclick: () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', 'icon-sm'))
  } }, icon('eye', 'icon-sm'))
  return h('div', { class: 'input-suffix' }, input, eye)
}

/** 0–4 rough strength score + label. */
function strength(p) {
  if (!p) return [0, '']
  let s = 0
  if (p.length >= 8) s++
  if (p.length >= 12) s++
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++
  if (p.length < 6) s = 0
  return [s, ['Very weak', 'Weak', 'Okay', 'Strong', 'Very strong'][s]]
}

export function Protect() {
  const { root, render } = mount()
  let info = null
  let pwd = ''
  let pwd2 = ''
  let method = 'aes256'
  let requireOpen = true
  let owner = ''
  let advanced = false
  const perms = { print: true, copy: true, modify: true, annotate: true, fill: true }
  let busy = false
  let result = null

  const load = async ([f]) => {
    try {
      const i = await openPdf(f)
      if (!i) return
      info = i
      result = null
      paint()
    } catch (e) { toast(e.message, { type: 'error' }) }
  }

  const problems = () => {
    if (requireOpen && !pwd) return 'Enter a password'
    if (requireOpen && pwd !== pwd2) return 'Passwords don’t match'
    if (!requireOpen && !owner) return 'Set an owner password to lock the restrictions'
    if (method !== 'aes256' && /[^\x00-\xff]/.test(pwd + owner)) return 'Only AES-256 supports non-Latin characters in passwords'
    return null
  }

  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    const err = problems()
    if (err) throw new Error(err)
    const out = await protectPdf(info.bytes, requireOpen ? pwd : '', { ownerPwd: owner || undefined, method, perms })
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(info.name)}-protected.pdf` }
  })

  function paint() {
    if (!info) { render(ToolHead('protect'), Dropzone({ onFiles: load, title: 'Drop a PDF to password-protect', tc: 'var(--c-secure)', icon: 'lock' })); return }
    if (result) {
      render(ToolHead('protect'), ResultCard({
        title: 'Your PDF is protected', blob: result.blob, filename: result.name, toolId: 'protect',
        extra: Callout(requireOpen ? 'Keep the password safe — without it the file can’t be opened, and nobody (including us) can recover it.' : 'Anyone can open it; the restrictions need the owner password to lift.', { type: 'warn' }),
        onAgain: () => { result = null; pwd = pwd2 = ''; paint() },
      }))
      return
    }
    const [sc, sl] = strength(pwd)
    const err = problems()
    const meter = h('div', { id: 'pw-meter', style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px' } },
      [1, 2, 3, 4].map((k) => h('i', { style: { height: '4px', borderRadius: '2px', background: k <= sc ? (sc <= 1 ? 'var(--danger)' : sc === 2 ? 'var(--warn)' : 'var(--accent)') : 'var(--surface-3)' } })))
    const perm = (k, label) => Switch(label, perms[k], (v) => { perms[k] = v })
    render(
      ToolHead('protect'),
      Workspace(
        [
          FileChip({ name: info.name, size: info.size, meta: docMeta(info), onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          h('div', { class: 'card card-pad stack' },
            Switch('Require a password to open', requireOpen, (v) => { requireOpen = v; paint() }, { hint: requireOpen ? 'Nobody can view the file without it' : 'Anyone can open it — only the restrictions below are locked' }),
            requireOpen ? [
              Field('Password', PwdInput(pwd, (v) => { pwd = v; updateBtn() }), { right: h('span', { class: 'hint', id: 'pw-label' }, sl) }),
              meter,
              Field('Confirm password', PwdInput(pwd2, (v) => { pwd2 = v; updateBtn() }, 'Type it again')),
            ] : null),
          h('div', { class: 'card card-pad stack' },
            h('div', { class: 'card-title' }, 'What can people do after opening it?'),
            perm('print', 'Print'), perm('copy', 'Copy text and images'), perm('modify', 'Edit the document'),
            perm('annotate', 'Add comments'), perm('fill', 'Fill in forms')),
        ],
        [
          h('div', { class: 'card stack' },
            Field('Encryption', Seg([['aes256', 'AES-256'], ['aes128', 'AES-128'], ['rc4', 'RC4']], method, (v) => { method = v; paint() }, { block: true }), { hint: method === 'aes256' ? 'recommended' : 'for very old readers' }),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: { justifySelf: 'start', paddingLeft: '0' }, onclick: () => { advanced = !advanced; paint() } }, icon(advanced ? 'chevDown' : 'chevRight', 'icon-sm'), 'Separate owner password'),
            advanced || !requireOpen ? Field('Owner password', PwdInput(owner, (v) => { owner = v; updateBtn() }, 'Lifts the restrictions'), { hint: 'optional' }) : null,
            h('p', { class: 'muted small', style: { margin: 0 } }, 'Restrictions are honoured by standard PDF readers; the open password is real encryption.')),
          h('div', { class: 'action-bar sticky-m' },
            Button({ label: busy ? 'Encrypting…' : 'Protect PDF', icon: 'lock', variant: 'primary', size: 'lg', block: true, busy, disabled: !!err, onClick: run }),
            h('div', { class: 'summary', id: 'pw-err' }, err ?? '')),
        ]),
    )
  }
  function updateBtn() {
    const [sc, sl] = strength(pwd)
    const lab = root.querySelector('#pw-label')
    if (lab) lab.textContent = sl
    root.querySelectorAll('#pw-meter i').forEach((el, k) => {
      el.style.background = k + 1 <= sc ? (sc <= 1 ? 'var(--danger)' : sc === 2 ? 'var(--warn)' : 'var(--accent)') : 'var(--surface-3)'
    })
    const err = problems()
    const btn = root.querySelector('.action-bar .btn')
    if (btn && !busy) btn.disabled = !!err
    const s = root.querySelector('#pw-err')
    if (s) s.textContent = err ?? ''
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}

export function Unlock() {
  const { root, render } = mount()
  let file = null
  let bytes = null
  let pwd = ''
  let wrong = false
  let busy = false
  let result = null
  let notLocked = false

  const load = async ([f]) => {
    try {
      file = f
      bytes = await readBytes(f)
      result = null
      wrong = false
      pwd = ''
      notLocked = !(await isEncrypted(bytes).catch(() => false))
      if (!notLocked) {
        // restriction-only files open with an empty password: unlock right away
        try { await finish(await decryptPdf(bytes, '')); return } catch { /* needs a password */ }
      }
      paint()
    } catch { toast('That file isn’t a readable PDF', { type: 'error' }) }
  }
  const finish = async (out) => {
    const pages = pageLeaves(await parsePdf(out)).length
    result = { blob: new Blob([out], { type: 'application/pdf' }), name: `${stem(file.name)}-unlocked.pdf`, pages }
    paint()
  }
  const run = () => runTask((b) => { busy = b; paint() }, async () => {
    try { await finish(await decryptPdf(bytes, pwd)) } catch (e) {
      if (/wrong password/.test(e.message)) { wrong = true; paint(); return }
      throw e
    }
  })

  function paint() {
    if (!file) { render(ToolHead('unlock'), Dropzone({ onFiles: load, title: 'Drop a password-protected PDF', tc: 'var(--c-secure)', icon: 'unlock' })); return }
    if (result) { render(ToolHead('unlock'), ResultCard({ title: 'Password removed', blob: result.blob, filename: result.name, toolId: 'unlock', onAgain: () => { file = null; result = null; paint() } })); return }
    const input = PwdInput(pwd, (v) => { pwd = v }, 'Password')
    input.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
    render(
      ToolHead('unlock'),
      Workspace(
        [
          FileChip({ name: file.name, size: file.size, meta: notLocked ? 'not protected' : 'password-protected', onReplace: async () => { const [f] = await pickFiles(); if (f) load([f]) } }),
          notLocked
            ? Callout('This PDF isn’t password-protected — there’s nothing to unlock.', { type: 'ok' })
            : h('div', { class: 'card card-pad stack' },
                Field('Password', input),
                wrong ? Callout('That password didn’t work. Passwords are case-sensitive.', { type: 'danger' }) : null,
                h('p', { class: 'muted small', style: { margin: 0 } }, 'Works with the open password or the owner password. Supports RC4, AES-128 and AES-256 encryption.')),
        ],
        [h('div', { class: 'action-bar sticky-m' },
          Button({ label: busy ? 'Unlocking…' : 'Unlock PDF', icon: 'unlock', variant: 'primary', size: 'lg', block: true, busy, disabled: notLocked, onClick: run }))]),
    )
    if (!notLocked) requestAnimationFrame(() => input.querySelector('input')?.focus())
  }

  const ho = takeHandoff()
  if (ho) load([Array.isArray(ho) ? ho[0] : ho])
  else paint()
  return root
}
