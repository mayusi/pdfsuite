// PDF function objects (types 0, 2, 3, 4) → plain JS (inputs[]) => outputs[].
// Used by Separation/DeviceN tint transforms and shadings.
import { deref } from './parse.js'
import { decodeChain } from './filters.js'

const clampTo = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const dictOf = (v) => (v?.k === 't' ? v.dict : v)

/** Compile a function object. Returns null when it can't be understood. */
export async function compileFunction(doc, fnObj) {
  if (Array.isArray(fnObj)) { // array of 1-out functions → one n-out function
    const fs = []
    for (const f of fnObj) fs.push(await compileFunction(doc, deref(doc, f)))
    if (fs.some((f) => !f)) return null
    return (x) => fs.map((f) => f(x)[0])
  }
  fnObj = deref(doc, fnObj)
  const d = dictOf(fnObj)
  if (!(d instanceof Map)) return null
  const type = d.get('FunctionType')
  const domain = d.get('Domain') ?? [0, 1]
  const range = d.get('Range') ?? null
  const clampIn = (x) => x.map((v, i) => clampTo(v, domain[2 * i] ?? 0, domain[2 * i + 1] ?? 1))
  const clampOut = (y) => (range ? y.map((v, i) => clampTo(v, range[2 * i], range[2 * i + 1])) : y)

  if (type === 2) {
    const c0 = d.get('C0') ?? [0]
    const c1 = d.get('C1') ?? [1]
    const N = d.get('N') ?? 1
    return (x) => {
      const t = clampIn(x)[0] ** N
      return clampOut(c0.map((a, i) => a + t * ((c1[i] ?? 1) - a)))
    }
  }
  if (type === 3) {
    const fns = []
    for (const f of d.get('Functions') ?? []) fns.push(await compileFunction(doc, deref(doc, f)))
    if (fns.some((f) => !f)) return null
    const bounds = d.get('Bounds') ?? []
    const encode = d.get('Encode') ?? []
    return (x) => {
      const v = clampIn(x)[0]
      let k = 0
      while (k < bounds.length && v >= bounds[k]) k++
      const lo = k === 0 ? domain[0] : bounds[k - 1]
      const hi = k === bounds.length ? domain[1] : bounds[k]
      const e0 = encode[2 * k] ?? 0, e1 = encode[2 * k + 1] ?? 1
      const t = hi === lo ? e0 : e0 + ((v - lo) * (e1 - e0)) / (hi - lo)
      return clampOut(fns[k]([t]))
    }
  }
  if (type === 0 && fnObj.k === 't') {
    const { data } = await decodeChain(d, fnObj.data)
    const size = d.get('Size') ?? [2]
    const bps = d.get('BitsPerSample') ?? 8
    const nOut = (range?.length ?? 2) / 2
    const encode = d.get('Encode') ?? size.flatMap((s) => [0, s - 1])
    const decode = d.get('Decode') ?? range
    const max = 2 ** bps - 1
    const sample = (idx) => { // idx = flat sample index
      const out = []
      for (let o = 0; o < nOut; o++) {
        const bit = (idx * nOut + o) * bps
        let v = 0
        if (bps === 8) v = data[bit >> 3]
        else if (bps === 16) v = (data[bit >> 3] << 8) | data[(bit >> 3) + 1]
        else if (bps === 32) v = ((data[bit >> 3] << 24) | (data[(bit >> 3) + 1] << 16) | (data[(bit >> 3) + 2] << 8) | data[(bit >> 3) + 3]) >>> 0
        else { for (let b = 0; b < bps; b++) v = (v << 1) | ((data[(bit + b) >> 3] >> (7 - ((bit + b) & 7))) & 1) }
        out.push((decode[2 * o] ?? 0) + ((v ?? 0) * ((decode[2 * o + 1] ?? 1) - (decode[2 * o] ?? 0))) / max)
      }
      return out
    }
    return (x) => {
      x = clampIn(x)
      // multilinear would be nicer; nearest-sample is plenty for tints/shading
      let idx = 0, stride = 1
      for (let i = 0; i < size.length; i++) {
        const e = (encode[2 * i] ?? 0) + ((x[i] - (domain[2 * i] ?? 0)) * ((encode[2 * i + 1] ?? size[i] - 1) - (encode[2 * i] ?? 0))) / (((domain[2 * i + 1] ?? 1) - (domain[2 * i] ?? 0)) || 1)
        idx += clampTo(Math.round(e), 0, size[i] - 1) * stride
        stride *= size[i]
      }
      return clampOut(sample(idx))
    }
  }
  if (type === 4 && fnObj.k === 't') {
    const { data } = await decodeChain(d, fnObj.data)
    const prog = parsePostScript(new TextDecoder('latin1').decode(data))
    if (!prog) return null
    return (x) => {
      const st = [...clampIn(x)]
      try { runPS(prog, st) } catch { return range ? range.filter((_, i) => i % 2 === 0) : [0] }
      const n = range ? range.length / 2 : st.length
      return clampOut(st.slice(st.length - n))
    }
  }
  return null
}

/** Tokenise a type-4 calculator program → nested arrays (procs) of tokens. */
function parsePostScript(src) {
  const toks = src.match(/[{}]|[^\s{}]+/g) ?? []
  let i = 0
  const proc = () => {
    const out = []
    while (i < toks.length) {
      const t = toks[i++]
      if (t === '{') out.push(proc())
      else if (t === '}') return out
      else out.push(/^[-+.\d]/.test(t) ? Number(t) : t)
    }
    return out
  }
  if (toks[i] !== '{') return null
  i++
  return proc()
}

function runPS(prog, s) {
  for (let i = 0; i < prog.length; i++) {
    const t = prog[i]
    if (typeof t === 'number' || Array.isArray(t)) { s.push(t); continue }
    let a, b
    switch (t) {
      case 'add': b = s.pop(); a = s.pop(); s.push(a + b); break
      case 'sub': b = s.pop(); a = s.pop(); s.push(a - b); break
      case 'mul': b = s.pop(); a = s.pop(); s.push(a * b); break
      case 'div': b = s.pop(); a = s.pop(); s.push(b ? a / b : 0); break
      case 'idiv': b = s.pop(); a = s.pop(); s.push(b ? Math.trunc(a / b) : 0); break
      case 'mod': b = s.pop(); a = s.pop(); s.push(b ? a % b : 0); break
      case 'neg': s.push(-s.pop()); break
      case 'abs': s.push(Math.abs(s.pop())); break
      case 'sqrt': s.push(Math.sqrt(Math.max(0, s.pop()))); break
      case 'sin': s.push(Math.sin((s.pop() * Math.PI) / 180)); break
      case 'cos': s.push(Math.cos((s.pop() * Math.PI) / 180)); break
      case 'atan': b = s.pop(); a = s.pop(); s.push(((Math.atan2(a, b) * 180) / Math.PI + 360) % 360); break
      case 'exp': b = s.pop(); a = s.pop(); s.push(a ** b); break
      case 'ln': s.push(Math.log(s.pop())); break
      case 'log': s.push(Math.log10(s.pop())); break
      case 'floor': s.push(Math.floor(s.pop())); break
      case 'ceiling': s.push(Math.ceil(s.pop())); break
      case 'round': s.push(Math.round(s.pop())); break
      case 'truncate': s.push(Math.trunc(s.pop())); break
      case 'cvi': s.push(Math.trunc(s.pop())); break
      case 'cvr': break
      case 'dup': s.push(s[s.length - 1]); break
      case 'pop': s.pop(); break
      case 'exch': b = s.pop(); a = s.pop(); s.push(b, a); break
      case 'copy': { const n = s.pop(); s.push(...s.slice(s.length - n)); break }
      case 'index': { const n = s.pop(); s.push(s[s.length - 1 - n]); break }
      case 'roll': {
        let j = s.pop(); const n = s.pop()
        if (n <= 0) break
        const seg = s.splice(s.length - n, n)
        j = ((j % n) + n) % n
        s.push(...seg.slice(n - j), ...seg.slice(0, n - j))
        break
      }
      case 'eq': b = s.pop(); a = s.pop(); s.push(a === b); break
      case 'ne': b = s.pop(); a = s.pop(); s.push(a !== b); break
      case 'gt': b = s.pop(); a = s.pop(); s.push(a > b); break
      case 'ge': b = s.pop(); a = s.pop(); s.push(a >= b); break
      case 'lt': b = s.pop(); a = s.pop(); s.push(a < b); break
      case 'le': b = s.pop(); a = s.pop(); s.push(a <= b); break
      case 'and': b = s.pop(); a = s.pop(); s.push(typeof a === 'boolean' ? a && b : a & b); break
      case 'or': b = s.pop(); a = s.pop(); s.push(typeof a === 'boolean' ? a || b : a | b); break
      case 'xor': b = s.pop(); a = s.pop(); s.push(typeof a === 'boolean' ? a !== b : a ^ b); break
      case 'not': a = s.pop(); s.push(typeof a === 'boolean' ? !a : ~a); break
      case 'bitshift': b = s.pop(); a = s.pop(); s.push(b >= 0 ? a << b : a >> -b); break
      case 'true': s.push(true); break
      case 'false': s.push(false); break
      case 'if': { const p = s.pop(); if (s.pop()) runPS(p, s); break }
      case 'ifelse': { const p2 = s.pop(); const p1 = s.pop(); runPS(s.pop() ? p1 : p2, s); break }
      default: throw new Error(`ps op ${t}`)
    }
  }
}
