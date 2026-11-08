/**
 * Hub-side config-sync: source function + revision + push, in one place so it can be
 * tested through the real send path (the registry's `configSyncRequest` listener).
 *
 * Everything here fails closed and never throws out of an event callback: a throw from
 * a registry listener is swallowed by the emitter, which once meant a missing import
 * (`HUB_TO_NODE`) left the node with no frame, no log and no receipt.
 */
import { HUB_TO_NODE } from '../protocol.js'
import { computeRevision } from './stable-hash.js'

const errText = (err) => String(err?.message ?? err)

/**
 * @param {{ registry: { send(nodeId: string, type: string, data: object): boolean, hasE2E(nodeId: string): boolean },
 *           source?: () => (object|null), log: (level: string, msg: string, meta?: object) => void }} deps
 */
export function createConfigSync({ registry, source = null, log }) {
  let sourceFn = typeof source === 'function' ? source : null
  let currentRevision = 0

  // The payload from the source, or null (and a warn) when there is none / it throws /
  // it is not a plain object (an async source would hand back a Promise).
  function readSource(nodeId) {
    if (!sourceFn) {
      log('info', 'config-sync: no source, skip push', { nodeId })
      return null
    }
    let payload
    try {
      payload = sourceFn(nodeId)
    } catch (err) {
      log('warn', 'config-sync: source threw, skip push', { nodeId, error: errText(err) })
      return null
    }
    if (payload === null || payload === undefined) {
      log('info', 'config-sync: source returned nothing, skip push', { nodeId })
      return null
    }
    if (typeof payload !== 'object' || Array.isArray(payload) || typeof payload.then === 'function') {
      log('warn', 'config-sync: source must return a plain object synchronously, skip push', { nodeId })
      return null
    }
    return payload
  }

  function push(nodeId, payload, reason) {
    // The payload carries real API keys. NodeRegistry.send seals a frame only when the
    // node has an e2e session, and sends clear text otherwise, so no session → no send.
    let sealed = false
    try { sealed = typeof registry.hasE2E === 'function' && registry.hasE2E(nodeId) === true } catch { sealed = false }
    if (!sealed) {
      log('warn', 'config-sync: no e2e session, refuse to push (payload contains apiKey)', { nodeId, revision: payload.revision })
      return false
    }
    try {
      const sent = registry.send(nodeId, HUB_TO_NODE.CONFIG_PUSH, payload)
      if (sent === false) {
        log('warn', 'config-sync: push not delivered', { nodeId, revision: payload.revision, reason })
        return false
      }
      log('info', 'config-sync: pushed', { nodeId, revision: payload.revision, reason })
      return true
    } catch (err) {
      log('warn', 'config-sync: push threw', { nodeId, revision: payload.revision, reason, error: errText(err) })
      return false
    }
  }

  return {
    /** The payload generator (`() => { providers, defaultModel } | null`, no revision field). */
    setSource(fn) {
      if (typeof fn === 'function') sourceFn = fn
    },

    /** Push the current config (or `payload`) to one node. Returns whether a frame went out. */
    sendPush(nodeId, payload) {
      try {
        const p = payload ?? readSource(nodeId)
        if (!p) return false
        const revision = computeRevision(p)
        currentRevision = revision
        return push(nodeId, { ...p, revision }, 'push')
      } catch (err) {
        log('warn', 'config-sync: sendPush failed', { nodeId, error: errText(err) })
        return false
      }
    },

    /** A node reconnected and reports the revision it applied; push when it is behind. */
    handleSyncRequest({ nodeId, appliedRevision } = {}) {
      try {
        const payload = readSource(nodeId)
        if (!payload) return
        const revision = computeRevision(payload)
        currentRevision = revision
        if (Number.isInteger(appliedRevision) && appliedRevision >= revision) {
          log('info', 'config-sync: node up-to-date', { nodeId, appliedRevision, currentRevision: revision })
          return
        }
        push(nodeId, { ...payload, revision }, 'reconnect')
      } catch (err) {
        log('warn', 'config-sync: sync request failed', { nodeId, error: errText(err) })
      }
    },

    get currentRevision() { return currentRevision },
  }
}
