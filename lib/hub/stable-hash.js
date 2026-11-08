/**
 * Stable canonical serialization + CRC-32 for content hashing.
 * Objects have keys sorted at every level; arrays preserve order; undefined values skipped.
 * Exported so tests can import directly without pulling in hub/index.js's full dependency graph.
 */

export function stableSerialize(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableSerialize(value[k])).join(',') + '}'
  }
  return 'null'
}

/** CRC-32 (IEEE 802.3 / Java polynomial 0xEDB88320), returns 32-bit unsigned non-zero. */
export function crc32(str) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < str.length; i++) {
    let byte = str.charCodeAt(i)
    for (let j = 0; j < 8; j++) {
      if ((crc ^ byte) & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320
      } else {
        crc >>>= 1
      }
      byte >>>= 1
    }
  }
  const unsigned = (crc ^ 0xFFFFFFFF) >>> 0
  return unsigned || 1
}

/**
 * Compute a stable revision hash from a config payload.
 * The `revision` field itself is excluded before hashing so the hash is content-only.
 */
export function computeRevision(payload) {
  const { revision: _r, ...rest } = payload ?? {}
  return crc32(stableSerialize(rest))
}
