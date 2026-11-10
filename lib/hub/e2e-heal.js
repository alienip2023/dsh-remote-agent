/**
 * fork.63: the hub starts the e2e handshake itself (pure helpers; the wiring is in
 * registry-handshake.js / registry-ingest.js).
 *
 * Why: the handshake used to be started by the node only (on its own connect, or on an e2e-reset
 * the hub sent in answer to a sealed frame). When the hub restarted while the node kept its relay
 * connection, nothing started it again unless the node happened to send a sealed frame.
 *
 * A node that is online, has no session and can be reached (hub identity available) is sent an
 * e2e-reset, which makes it offer. Attempts follow a backoff and are capped, so a node that does
 * not understand the frame (relayE2E off, an old version) is not reset forever.
 */

export const E2E_HEAL_DEFAULTS = Object.freeze({
  /** First attempt after the node shows up without a session; each further attempt doubles the wait. */
  baseMs: 2_000,
  /** The wait never grows beyond this. */
  maxMs: 30_000,
  /** Attempts that actually left the hub per online period (0 = never). */
  maxAttempts: 10,
  /** After a frame that cannot be opened: at most one e2e-reset per node in this window. */
  resetMinMs: 5_000,
})

const posMs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3_600_000

/** Options → complete settings. Every invalid field falls back to its own default. */
export function resolveE2EHeal(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const d = E2E_HEAL_DEFAULTS
  const baseMs = posMs(o.baseMs) ? o.baseMs : d.baseMs
  const maxMs = posMs(o.maxMs) ? Math.max(o.maxMs, baseMs) : Math.max(d.maxMs, baseMs)
  const maxAttempts = Number.isInteger(o.maxAttempts) && o.maxAttempts >= 0 && o.maxAttempts <= 1000 ? o.maxAttempts : d.maxAttempts
  const resetMinMs = posMs(o.resetMinMs) ? o.resetMinMs : d.resetMinMs
  return { baseMs, maxMs, maxAttempts, resetMinMs }
}

/** Wait before attempt n (1-based): base, 2×base, 4×base … capped. */
export function e2eHealDelayMs(n, cfg) {
  const k = Math.max(1, Math.floor(n))
  return Math.min(cfg.baseMs * 2 ** Math.min(k - 1, 30), cfg.maxMs)
}
