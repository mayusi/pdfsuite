import { concat, enc, ref, serialize } from './types.js'

/** A document under construction: numbered objects + allocator. */
export function newDoc() {
  return {
    objects: new Map(), // num → value
    _next: 1,
    alloc() {
      return this._next++
    },
    set(num, v) {
      this.objects.set(num, v)
    },
  }
}

/** Serialize a built doc to PDF bytes: header, objects, classic xref, trailer.
 *  trailerExtra: Map merged into the trailer dict (/Encrypt, /ID, ...). */
export function writeDoc(doc, rootNum, trailerExtra) {
  const parts = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')]
  const offsets = new Map()

  const nums = [...doc.objects.keys()].sort((a, b) => a - b)
  for (const n of nums) {
    offsets.set(n, parts.reduce((s, p) => s + p.length, 0))
    parts.push(enc(`${n} 0 obj\n`), ...serialize(doc.objects.get(n)), enc('\nendobj\n'))
  }

  const xrefAt = parts.reduce((s, p) => s + p.length, 0)
  const count = nums.length ? nums[nums.length - 1] + 1 : 1
  let xref = 'xref\n0 ' + count + '\n0000000000 65535 f \r\n'
  for (let n = 1; n < count; n++) {
    const off = offsets.get(n)
    xref += off === undefined ? '0000000000 65535 f \r\n' : String(off).padStart(10, '0') + ' 00000 n \r\n'
  }
  const trailer = new Map([
    ['Size', count],
    ['Root', ref(rootNum, 0)],
  ])
  if (trailerExtra instanceof Map) for (const [k, v] of trailerExtra) trailer.set(k, v)
  parts.push(
    enc(xref),
    enc('trailer\n'),
    ...serialize(trailer),
    enc(`\nstartxref\n${xrefAt}\n%%EOF\n`),
  )
  return concat(parts)
}
