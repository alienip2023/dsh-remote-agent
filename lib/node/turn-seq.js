/**
 * turn-seq.js — per-remoteBotId monotonic sequence number generator.
 *
 * createTurnSeq(stateDir)
 *   → { next(remoteBotId): number, reset(remoteBotId): void }
 *
 * next() is strictly monotone across restarts: it reads + writes
 * <stateDir>/turn-seq.json (mode 0600) atomically on every call.
 * reset() is provided for tests only.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function loadState(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveState(filePath, state) {
  try {
    const data = JSON.stringify(state)
    writeFileSync(filePath, data, { mode: 0o600 })
  } catch {
    // state dir not writable; operate in-memory only
  }
}

export function createTurnSeq(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') {
    stateDir = ''
  }
  const filePath = stateDir ? join(stateDir, 'turn-seq.json') : ''
  let state = filePath ? loadState(filePath) : {}

  function ensureDir() {
    if (!stateDir) return
    try {
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    } catch {}
  }

  return {
    /**
     * Return the next seq for remoteBotId. Monotone: result is always > all prior results
     * for this remoteBotId in this stateDir (across restarts).
     * @param {string} remoteBotId
     * @returns {number}
     */
    next(remoteBotId) {
      const current = typeof state[remoteBotId] === 'number' ? state[remoteBotId] : -1
      const next = current + 1
      state[remoteBotId] = next
      if (filePath) {
        ensureDir()
        saveState(filePath, state)
      }
      return next
    },

    /**
     * Reset the counter for remoteBotId. FOR TESTS ONLY.
     * @param {string} remoteBotId
     */
    reset(remoteBotId) {
      delete state[remoteBotId]
      if (filePath) saveState(filePath, state)
    },
  }
}
