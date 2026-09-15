// Environment-neutral inflate (FlateDecode). Node → zlib; browser → DecompressionStream.

export async function inflate(data) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { inflateSync } = await import('node:zlib')
    return new Uint8Array(inflateSync(data))
  }
  const out = await inflateRaw(data, 'deflate').catch(() => inflateRaw(data, 'deflate-raw'))
  if (!out) throw new Error('inflate failed')
  return out
}

async function inflateRaw(data, format) {
  const ds = new DecompressionStream(format)
  const stream = new Blob([data]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
