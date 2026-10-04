// Bookmarks (document outline): read into a plain tree, write back against a
// new page numbering. Lets merge / split / organize keep navigation intact.
import { get, isRef, isStream, name, ref, str } from './types.js'
import { deref } from './parse.js'

const MAX_NODES = 20000

/** PDF text string → JS string (UTF-16BE BOM or PDFDocEncoding≈Latin-1). */
export function pdfString(v) {
  const b = v?.bytes
  if (!b) return ''
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
    return s
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3))
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return s
}

/** JS string → PDF text string (Latin-1 when possible, else UTF-16BE). */
export function textString(s) {
  if (/^[\x20-\x7e\xa0-\xff]*$/.test(s)) return str(Uint8Array.from(s, (c) => c.charCodeAt(0)))
  const out = [0xfe, 0xff]
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c >> 8, c & 255) }
  return str(new Uint8Array(out))
}

/** Look up a named destination (catalog /Dests dict or /Names /Dests tree). */
function namedDest(doc, cat, key) {
  const dd = (v) => deref(doc, v)
  const old = dd(get(cat, 'Dests'))
  if (old instanceof Map && old.has(key)) return dd(old.get(key))
  const tree = dd(get(dd(get(cat, 'Names')), 'Dests'))
  let guard = 0
  const search = (node) => {
    if (!(node instanceof Map) || guard++ > 5000) return undefined
    const names = dd(get(node, 'Names'))
    if (Array.isArray(names)) {
      for (let i = 0; i + 1 < names.length; i += 2) if (pdfString(dd(names[i])) === key) return dd(names[i + 1])
    }
    const kids = dd(get(node, 'Kids'))
    if (Array.isArray(kids)) for (const k of kids) { const r = search(dd(k)); if (r !== undefined) return r }
    return undefined
  }
  return search(tree)
}

/** Destination value → {page: srcPageKey, view: [...rest]} or null. */
function resolveDest(doc, cat, d) {
  d = deref(doc, d)
  if (d?.k === 'n') d = namedDest(doc, cat, d.v)
  else if (d?.bytes) d = namedDest(doc, cat, pdfString(d))
  if (d instanceof Map) d = deref(doc, get(d, 'D')) // dest dict form
  if (!Array.isArray(d) || !d.length) return null
  const p = d[0]
  if (isRef(p)) return { page: `${p.n} ${p.g}`, view: d.slice(1) }
  if (typeof p === 'number') return { pageIndex: p, view: d.slice(1) } // remote-style index
  return null
}

/**
 * Read the outline → [{title, page: srcPageKey|null, view, open, children}].
 * Entries whose action isn't an internal GoTo keep page:null (title-only).
 */
export function readOutline(doc) {
  const dd = (v) => deref(doc, v)
  const root = dd(get(doc.trailer, 'Root'))
  const cat = isStream(root) ? root.dict : root
  const outlines = dd(get(cat, 'Outlines'))
  if (!(outlines instanceof Map)) return []
  let count = 0
  const seen = new Set()
  const walk = (firstRef) => {
    const out = []
    let cur = firstRef
    while (cur && count < MAX_NODES) {
      const key = isRef(cur) ? `${cur.n} ${cur.g}` : null
      if (key && seen.has(key)) break // cycle guard
      if (key) seen.add(key)
      const node = dd(cur)
      if (!(node instanceof Map)) break
      count++
      let dest = get(node, 'Dest')
      if (dest === undefined) {
        const a = dd(get(node, 'A'))
        if (a instanceof Map && get(a, 'S')?.v === 'GoTo') dest = get(a, 'D')
      }
      const r = dest !== undefined ? resolveDest(doc, cat, dest) : null
      const c = get(node, 'Count')
      out.push({
        title: pdfString(dd(get(node, 'Title'))),
        page: r?.page ?? null,
        pageIndex: r?.pageIndex,
        view: r?.view ?? [name('Fit')],
        open: typeof c === 'number' ? c > 0 : false,
        children: walk(get(node, 'First')),
      })
      cur = get(node, 'Next')
    }
    return out
  }
  return walk(get(outlines, 'First'))
}

/**
 * Re-target a tree: mapPage(srcPageKey) → new page ref | null. Entries whose
 * page vanished are dropped, but their surviving children are promoted.
 */
export function remapOutline(tree, mapPage) {
  const out = []
  for (const n of tree) {
    const kids = remapOutline(n.children, mapPage)
    const target = n.page ? mapPage(n.page) : null
    if (target || (!n.page && kids.length)) out.push({ ...n, target, children: kids })
    else out.push(...kids)
  }
  return out
}

/**
 * Write a remapped tree (nodes carry .target page ref or null) into dst →
 * ref to the /Outlines dict, or null for an empty tree.
 */
export function writeOutline(dst, tree) {
  if (!tree.length) return null
  const rootNum = dst.alloc()
  const level = (nodes, parentNum) => {
    const nums = nodes.map(() => dst.alloc())
    let visible = 0
    nodes.forEach((n, i) => {
      const d = new Map([['Title', textString(n.title || 'Untitled')], ['Parent', ref(parentNum, 0)]])
      if (i > 0) d.set('Prev', ref(nums[i - 1], 0))
      if (i < nodes.length - 1) d.set('Next', ref(nums[i + 1], 0))
      if (n.target) d.set('Dest', [n.target, ...(n.view?.length ? n.view.map(cloneView) : [name('Fit')])])
      if (n.children?.length) {
        const sub = level(n.children, nums[i])
        d.set('First', ref(sub.first, 0))
        d.set('Last', ref(sub.last, 0))
        d.set('Count', n.open ? sub.visible : -sub.visible)
        if (n.open) visible += sub.visible
      }
      visible++
      dst.set(nums[i], d)
    })
    return { first: nums[0], last: nums[nums.length - 1], visible }
  }
  const top = level(tree, rootNum)
  dst.set(rootNum, new Map([['Type', name('Outlines')], ['First', ref(top.first, 0)], ['Last', ref(top.last, 0)], ['Count', top.visible]]))
  return ref(rootNum, 0)
}

// view operands are plain values (names/numbers/null) — copy defensively
const cloneView = (v) => (v && typeof v === 'object' && !isRef(v) ? { ...v } : isRef(v) ? null : v)

