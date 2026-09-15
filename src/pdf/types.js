// PDF value model — tagged constructors + predicates.
// dict = Map<string, value>, array = Array<value>, number/bool/null = raw JS.

export const name = (v) => ({ k: 'n', v })
export const ref = (n, g = 0) => ({ k: 'r', n, g })
export const str = (bytes) => ({ k: 's', bytes }) // literal string, raw bytes
export const hex = (bytes) => ({ k: 'x', bytes }) // hex string
export const stream = (dict, data) => ({ k: 't', dict, data }) // dict: Map

export const isName = (v) => v?.k === 'n'
export const isRef = (v) => v?.k === 'r'
export const isStr = (v) => v?.k === 's'
export const isHex = (v) => v?.k === 'x'
export const isStream = (v) => v?.k === 't'
export const isDict = (v) => v instanceof Map

const te = new TextEncoder()
const td = new TextDecoder('latin1')
export const enc = (s) => te.encode(s)
export const dec = (b) => td.decode(b)

/** Get dict value by key name (with or without leading slash). */
export function get(dict, key) {
  if (!(dict instanceof Map)) return undefined
  return dict.get(key.replace(/^\//, ''))
}

/** Set dict value; returns the dict for chaining. */
export function set(dict, key, value) {
  dict.set(key.replace(/^\//, ''), value)
  return dict
}

/** Type check helper: dict entry /Type matches name. */
export function typeIs(dict, typeName) {
  const t = get(dict, 'Type')
  return isName(t) && t.v === typeName
}

// ---------- serialization ----------

const NAME_SPECIAL = /[^A-Za-z0-9_+\-.]/
function serName(s) {
  let out = '/'
  for (const ch of s) {
    const c = ch.codePointAt(0)
    out += NAME_SPECIAL.test(ch) ? '#' + c.toString(16).toUpperCase().padStart(2, '0') : ch
  }
  return out
}

function serStr(bytes) {
  const parts = []
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) parts.push(0x5c, b) // ( ) \
    else parts.push(b)
  }
  const out = new Uint8Array(parts.length + 2)
  out[0] = 0x28
  out.set(parts, 1)
  out[out.length - 1] = 0x29
  return out
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

function serNum(n) {
  if (Number.isInteger(n)) return String(n)
  let s = n.toFixed(6)
  s = s.replace(/\.?0+$/, '')
  return s === '-0' || s === '' ? '0' : s
}

/** Serialize a value to PDF syntax. Returns Uint8Array[] chunks. */
export function serialize(v) {
  if (v === null || v === undefined) return [enc('null')]
  if (typeof v === 'boolean') return [enc(v ? 'true' : 'false')]
  if (typeof v === 'number') return [enc(serNum(v))]
  if (v instanceof Map) {
    const parts = [enc('<<')]
    for (const [k, val] of v) parts.push(enc(' ' + serName(k) + ' '), ...serialize(val))
    parts.push(enc('>>'))
    return parts
  }
  if (Array.isArray(v)) {
    const parts = [enc('[')]
    v.forEach((item, i) => parts.push(enc(i ? ' ' : ''), ...serialize(item)))
    parts.push(enc(']'))
    return parts
  }
  switch (v.k) {
    case 'n': return [enc(serName(v.v))]
    case 'r': return [enc(`${v.n} ${v.g} R`)]
    case 's': return [serStr(v.bytes)]
    case 'x': return [enc('<' + toHex(v.bytes) + '>')]
    case 't': {
      v.dict.set('Length', v.data.length)
      return [...serialize(v.dict), enc('\nstream\n'), v.data, enc('\nendstream')]
    }
    default:
      throw new Error('cannot serialize value: ' + JSON.stringify(v).slice(0, 80))
  }
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
