/**
 * M2：节点自建 Bot 清单上报。
 *
 * 节点每 5 秒读一次 ds-bot 提供的 provider（`remote-agent:node-bots`），变化才发；
 * provider 不存在（旧节点 / ds-bot 未装）就什么都不发，旧 hub 也看不懂这帧。
 * 帧里的 nodeId 只是声明，hub 以认证连接为准并逐帧比对——不一致整帧丢弃。
 *
 * 责任边界：本模块只采集/比较/发送/处理 ack，不认识 ds-bot 的 state.bots。
 */
import { createHash } from 'node:crypto'
import { NODE_TO_HUB } from '../protocol.js'

const MAX_BOTS = 64
// ack ok:false 后的退避；用完后停在最后一档。
const BACKOFF_MS = [5_000, 30_000, 120_000]

function msgOf(err) {
  return err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err)
}

function hashOf(bots) {
  return createHash('sha256').update(JSON.stringify(bots)).digest('hex')
}

/** 只挑行模型需要的字段；顺序按 createdAt 升序（缺省排最后），超 64 置 truncated。 */
function shapeBots(list) {
  const rows = []
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.id !== 'string' || raw.id.trim() === '') continue
    const bot = { id: raw.id.trim(), name: typeof raw.name === 'string' ? raw.name : '', role: typeof raw.role === 'string' ? raw.role : '' }
    if (typeof raw.model === 'string' && raw.model !== '') bot.model = raw.model
    if (typeof raw.main === 'boolean') bot.main = raw.main
    if (Number.isFinite(raw.createdAt)) bot.createdAt = raw.createdAt
    rows.push(bot)
  }
  rows.sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER))
  const truncated = rows.length > MAX_BOTS
  return { bots: rows.slice(0, MAX_BOTS), truncated }
}

export function startBotInventory({ ctx, send, logger, nodeId, hostname, intervalMs = 5_000, keepaliveMs = 60_000, now = () => Date.now(), autoStart = true } = {}) {
  let timer = null
  let stopped = false
  let lastHash = ''
  let acked = true
  let lastSentAt = 0
  let wasEnabled = false
  let failures = 0
  let backoffUntil = 0
  let warned = false
  let providerMissingWarned = false

  const warn = (message, extra) => {
    try { logger?.warn?.(message, extra ?? {}) } catch { /* logging must not break reporting */ }
  }

  const provider = () => {
    try { return ctx?.get?.('remote-agent:node-bots') } catch { return undefined }
  }

  function readProvider(p) {
    let enabled = false
    try { enabled = p?.enabled?.() === true } catch (err) {
      if (!warned) { warned = true; warn('bot-inventory enabled() failed', { error: msgOf(err) }) }
      return { enabled: false, bots: [], truncated: false }
    }
    if (!enabled) return { enabled: false, bots: [], truncated: false }
    let list
    try { list = p?.list?.() } catch (err) {
      if (!warned) { warned = true; warn('bot-inventory list() failed', { error: msgOf(err) }) }
      return { enabled: true, bots: [], truncated: false }
    }
    const shaped = shapeBots(list)
    return { enabled: true, bots: shaped.bots, truncated: shaped.truncated }
  }

  function sendFrame(enabled, bots = [], truncated = false) {
    const at = now()
    const payload = { nodeId, hostname: typeof hostname === 'string' ? hostname : '', enabled, at }
    if (enabled) {
      payload.bots = bots
      if (truncated) payload.truncated = true
    }
    let sent = false
    try { sent = send(NODE_TO_HUB.BOT_INVENTORY, payload) === true } catch (err) {
      warn('bot-inventory send failed', { error: msgOf(err) })
      return false
    }
    if (!sent) return false
    lastSentAt = at
    return true
  }

  function tick() {
    if (stopped) return
    const p = provider()
    if (p === undefined) {
      // 旧节点/未装 ds-bot：没有 provider 就不发，日志只提醒一次。
      if (!providerMissingWarned) providerMissingWarned = true
      return
    }
    const state = readProvider(p)
    if (!state.enabled) {
      if (wasEnabled) {
        wasEnabled = false
        lastHash = ''
        if (sendFrame(false)) acked = true
      }
      return
    }
    if (!wasEnabled) {
      wasEnabled = true
      acked = true
      failures = 0
      backoffUntil = 0
    }
    const at = now()
    if (at < backoffUntil) return
    const hash = hashOf(state.bots)
    // 同一清单、已被接受、且离上次发送未到 keepalive：不必重复发。
    if (hash === lastHash && acked && at - lastSentAt < keepaliveMs) return
    if (!sendFrame(true, state.bots, state.truncated)) return
    lastHash = hash
    acked = true
  }

  function onAck(d) {
    if (stopped) return
    if (!d || typeof d !== 'object' || Array.isArray(d)) return
    if (typeof d.nodeId === 'string' && d.nodeId.trim() !== '' && d.nodeId.trim() !== nodeId) return
    if (typeof d.ok !== 'boolean') return
    if (d.ok) {
      acked = true
      failures = 0
      backoffUntil = 0
      return
    }
    acked = false
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
    failures += 1
    backoffUntil = now() + delay
  }

  function onOnline() {
    if (stopped) return
    // 重连后立刻补发一次，不等下一个 tick。
    if (wasEnabled) { lastHash = ''; acked = true }
    tick()
  }

  function stop() {
    stopped = true
    if (timer !== null) { clearInterval(timer); timer = null }
  }

  if (autoStart) {
    timer = setInterval(tick, intervalMs)
    timer.unref?.()
  }

  return { tick, onAck, onOnline, stop }
}
