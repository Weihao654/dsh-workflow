// Tool output must be lossless JSON: the Host rejects values that JSON cannot
// round-trip (undefined in arrays, NaN/Infinity, BigInt, functions, cycles).
// `chain_status({detail:"full"})` used to fail with
// "tool \"chain_status\" returned invalid output: value is not lossless JSON"
// when a board field held a non-JSON value, which blocked plan's very first call.
export function lossless(value) {
  const seen = new WeakSet()
  const walk = (input) => {
    if (input === null) return null
    const type = typeof input
    if (type === 'bigint') return String(input)
    if (type === 'function' || type === 'symbol' || type === 'undefined') return undefined
    if (type === 'number') return Number.isFinite(input) ? input : null
    if (type !== 'object') return input
    if (input instanceof Date) return input.toISOString()
    if (Buffer.isBuffer(input)) return input.toString('base64')
    if (seen.has(input)) return null
    seen.add(input)
    if (Array.isArray(input)) return input.map(v => { const out = walk(v); return out === undefined ? null : out })
    const out = {}
    for (const [key, val] of Object.entries(input)) {
      const next = walk(val)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  const walked = walk(value)
  if (walked === undefined) return null
  // Final round-trip guarantees the exact shape the Host will serialize.
  return JSON.parse(JSON.stringify(walked))
}
