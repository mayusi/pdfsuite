// Minimal ZIP writer — STORE method (no compression), enough for download bundles.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data, crc = 0xffffffff) {
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const zte = new TextEncoder() // named uniquely — single-file build shares one scope

/** files: [{name: string, data: Uint8Array}] → zip bytes */
export function zipStore(files) {
  const chunks = []
  const central = []
  let offset = 0

  const u16 = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff])
  const u32 = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff])

  for (const f of files) {
    const nameBytes = zte.encode(f.name)
    const crc = crc32(f.data)
    const local = [
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), // sig, ver, utf8 flag, method, time, date
      u32(crc), u32(f.data.length), u32(f.data.length),
      u16(nameBytes.length), u16(0), nameBytes,
    ]
    chunks.push(...local, f.data)
    central.push({ nameBytes, crc, size: f.data.length, offset })
    offset += local.reduce((n, c) => n + c.length, 0) + f.data.length
  }

  const cdStart = offset
  for (const c of central) {
    const rec = [
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size),
      u16(c.nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(c.offset), c.nameBytes,
    ]
    chunks.push(...rec)
    offset += rec.reduce((n, x) => n + x.length, 0)
  }
  const cdSize = offset - cdStart

  chunks.push(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cdSize), u32(cdStart), u16(0),
  )

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}
