/** Shared by hub and peer ingress. Pending turns are registered before execution. */
export function createTurnReplay({ ttlMs = 300_000, maxEntries = 512, now = Date.now } = {}) {
  const entries = new Map()
  return {
    async run(exchangeId, execute, send) {
      const time = now()
      for (const [id, entry] of entries) {
        if (time - entry.at >= ttlMs) entries.delete(id)
      }
      let entry = entries.get(exchangeId)
      if (!entry) {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value)
        entry = { at: time }
        // The microtask also ensures entry.promise exists before execute can reenter.
        entry.promise = Promise.resolve().then(execute)
        entries.set(exchangeId, entry)
        entry.promise.catch(() => { if (entries.get(exchangeId) === entry) entries.delete(exchangeId) })
      }
      const result = await entry.promise
      if (result) send(...result)
    },
    clear() { entries.clear() },
    get size() { return entries.size },
  }
}
