// Roster report: the remote DS-Bot list rides a frame of its own.
// It is not part of hello. hello stays node identity only.
import { NODE_TO_HUB } from './protocol.js'

export const ROSTER_CAP = 64

export function cleanRosterBots(bots) {
  const out = []
  if (!Array.isArray(bots)) return out
  for (const bot of bots) {
    if (out.length >= ROSTER_CAP) break
    if (!bot || typeof bot !== 'object') continue
    if (bot.type === 'remote-worker') continue
    const id = typeof bot.id === 'string' ? bot.id.trim().slice(0, 80) : ''
    if (id === '') continue
    const entry = {
      id,
      name: typeof bot.name === 'string' ? bot.name.trim().slice(0, 40) : '',
      role: typeof bot.role === 'string' ? bot.role.trim().slice(0, 24) : '',
    }
    // A bad model drops the field, not the bot. Over-long is truncated, not rejected.
    if (typeof bot.model === 'string') {
      const model = bot.model.trim().slice(0, 128)
      if (model !== '') entry.model = model
    }
    out.push(entry)
  }
  return out
}

export function rosterFrame({ nodeId, hostname, bots } = {}) {
  return {
    nodeId: typeof nodeId === 'string' ? nodeId : '',
    hostname: typeof hostname === 'string' ? hostname.slice(0, 80) : '',
    bots: cleanRosterBots(bots),
  }
}

// The node plugin registers this. The remote DS-Bot calls it. It is not hello.
export function bindRosterReport(ctx, { send, nodeId, hostname } = {}) {
  const report = (payload = {}) => {
    const frame = rosterFrame({
      nodeId: payload.nodeId ?? nodeId,
      hostname: payload.hostname ?? hostname,
      bots: payload.bots,
    })
    if (typeof send !== 'function') return false
    return send(NODE_TO_HUB.ROSTER, frame) === true
  }
  try { ctx?.provide?.('remote-agent:roster-report', report) } catch { /* registry is optional */ }
  return report
}
