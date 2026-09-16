import { h, readBytes, saveBlob, setKids } from '../ui/dom.js'
import { Btn, Card, DropZone, ErrorText } from '../ui/widgets.js'
import { parsePdf } from '../pdf/parse.js'
import { decryptPdf, protectPdf } from '../pdf/ops.js'

export function Protect() {
  let file = null
  let bytes = null
  let encrypted = false
  let pwd = ''
  let pwd2 = ''
  let busy = false
  let error = ''
  let ok = ''
  let loadGen = 0
  const root = h('div', { class: 'tool' })

  const load = async ([f]) => {
    const my = ++loadGen
    error = ''
    ok = ''
    file = f
    bytes = null
    encrypted = false
    pwd = pwd2 = ''
    try {
      const b = await readBytes(f)
      if (my !== loadGen) return
      bytes = b
      try {
        await parsePdf(b)
      } catch (e) {
        if (!/password-protected/.test(e.message)) throw e
        encrypted = true
      }
    } catch (e) {
      if (my !== loadGen) return
      error = e.message || 'could not read that file'
      file = null
      bytes = null
    }
    render()
  }

  const lock = async () => {
    if (!pwd) { error = 'enter a password first'; render(); return }
    busy = true
    error = ''
    render()
    try {
      const out = await protectPdf(bytes, pwd, { ownerPwd: pwd2 || undefined })
      saveBlob(new Blob([out], { type: 'application/pdf' }),
        `${file.name.replace(/\.pdf$/i, '')}-protected.pdf`)
    } catch (e) {
      error = e.message || 'failed'
    } finally {
      busy = false
      render()
    }
  }

  const unlock = async () => {
    if (!pwd) { error = 'enter a password first'; render(); return }
    busy = true
    error = ''
    ok = ''
    render()
    try {
      const out = await decryptPdf(bytes, pwd)
      saveBlob(new Blob([out], { type: 'application/pdf' }),
        `${file.name.replace(/\.pdf$/i, '')}-unlocked.pdf`)
      ok = 'Unlocked — the download has no password.'
    } catch (e) {
      error = /wrong password/.test(e.message) ? 'Wrong password — try again.' : e.message
    } finally {
      busy = false
      render()
    }
  }

  const pwdInput = (label, val, onset, ph = '••••••••') =>
    h('div', {},
      h('label', { class: 'lbl' }, label),
      h('input', {
        class: 'textin', type: 'password', placeholder: ph, value: val,
        oninput: (e) => onset(e.target.value),
        onkeydown: (e) => { if (e.key === 'Enter' && pwd) (encrypted ? unlock : lock)() },
      }))

  function render() {
    setKids(root,
      DropZone({ accept: 'application/pdf', onFiles: load }),
      file && !encrypted
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name), ' — not protected yet'),
            h('div', { class: 'optrow' },
              pwdInput('Password (required to open)', pwd, (v) => (pwd = v)),
              pwdInput('Owner password (optional)', pwd2, (v) => (pwd2 = v), 'same as above if blank')),
            h('p', { class: 'meta dim' },
              'RC4-128 Standard handler — every real PDF reader will ask for the password before opening.'),
            h('div', { class: 'btnrow' },
              Btn(busy ? 'Locking…' : 'Protect PDF', { onclick: lock, disabled: busy })),
          )
        : null,
      file && encrypted
        ? Card(
            h('p', { class: 'meta' }, h('b', {}, file.name), ' — password-protected'),
            h('div', { class: 'optrow' },
              pwdInput('Password (user or owner)', pwd, (v) => (pwd = v))),
            h('div', { class: 'btnrow' },
              Btn(busy ? 'Unlocking…' : 'Unlock PDF', { onclick: unlock, disabled: busy })),
            ok ? h('p', { class: 'meta ok' }, ok) : null,
          )
        : null,
      ErrorText(error),
    )
  }
  render()
  return root
}
