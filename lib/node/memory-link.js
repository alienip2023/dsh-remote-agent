/**
 * M4 S2：节点侧 `mem/*` 通道。
 *
 * 只做「连接绑定 + 发送闸门 + 分派」三件事；缓存/outbox/注入是 S4，hub 落盘是 S3。
 * 这里是节点唯一的发送入口，四条闸门必须按顺序全部通过：
 *
 *   1. **只发 mem/***：别的类型从这里发不出去，避免被当成通用发送器。
 *   2. **在线且已绑定连接**：nodeId 只取连接身份，绝不从调用方参数里拿；
 *      payload 里的 `nodeId` 永远被覆盖成本连接的值。
 *   3. **hub 声明了 memory-sync/1**：hub 在 welcome 里带 caps；缺这条就
 *      一个帧都不发（旧 hub 不会懂这些帧）。
 *   4. **正文帧要求 E2E 会话语义就绪**：read/write 走密文；hello/ack 是
 *      控制帧，可以在加密会话建立前通过（它们不带用户正文）。
 *
 * 另有一条大小闸：整帧 JSON 超过 MAX_MEMORY_FRAME_BYTES 就丢弃并计数。
 * 丢弃只记 warn，不抛 —— 记忆同步不能把节点的回合拖死。
 */
import {
  MAX_MEMORY_FRAME_BYTES,
  MEMORY,
  MEMORY_CAPS,
  MEMORY_NODE_BODY,
  isMemoryFrameType,
} from '../protocol.js'

const NODE_BODY = new Set(MEMORY_NODE_BODY)

function cleanId(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (t === '' || t.length > 128) return null
  return t
}

function safeSeq(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function frameBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return Infinity
  }
}

/**
 * @param {object} o
 * @param {(type:string, data:object)=>boolean} o.send 底层 transport.send
 * @param {string} [o.nodeId] 连接级节点身份；连上后由 bind() 再确认一次
 * @param {()=>string[]} [o.hubCaps] hub 在 welcome 里宣告的能力
 * @param {()=>number} [o.appliedSeq] 已应用快照的 seq（S4 从缓存读，S2 恒 0）
 * @param {()=>boolean} [o.e2eReady] E2E 会话是否就绪；正文帧要求 true
 * @param {{warn?:Function}} [o.logger]
 * @param {number} [o.maxBytes]
 */
export function createMemoryLink(o = {}) {
  const sendRaw = typeof o.send === 'function' ? o.send : () => false
  const hubCaps = typeof o.hubCaps === 'function' ? o.hubCaps : () => []
  const appliedSeq = typeof o.appliedSeq === 'function' ? o.appliedSeq : () => 0
  const e2eReady = typeof o.e2eReady === 'function' ? o.e2eReady : () => false
  const logger = o.logger ?? null
  const maxBytes = Number.isFinite(o.maxBytes) && o.maxBytes > 0 ? o.maxBytes : MAX_MEMORY_FRAME_BYTES

  let bound = cleanId(o.nodeId)
  let isOnline = false
  const handlers = new Map()
  const stats = { sent: 0, failed: 0, blocked: 0, oversize: 0, e2eBlocked: 0, dispatched: 0 }

  function hubSupportsMemory() {
    try {
      const caps = hubCaps()
      return Array.isArray(caps) && caps.includes(MEMORY_CAPS)
    } catch {
      return false
    }
  }

  function bind(nodeId) {
    bound = cleanId(nodeId)
    return bound
  }

  function on(type, fn) {
    if (!isMemoryFrameType(type) || typeof fn !== 'function') return () => {}
    let set = handlers.get(type)
    if (!set) {
      set = new Set()
      handlers.set(type, set)
    }
    set.add(fn)
    return () => { set.delete(fn) }
  }

  function send(type, data) {
    if (!isMemoryFrameType(type)) return false
    if (bound === null || !isOnline) {
      stats.blocked += 1
      return false
    }
    if (!hubSupportsMemory()) {
      stats.blocked += 1
      return false
    }
    if (NODE_BODY.has(type) && !e2eReady()) {
      stats.e2eBlocked += 1
      return false
    }
    // 连接身份永远覆盖调用方给的 nodeId —— 节点不能自证来源。
    const payload = { ...(data ?? {}), nodeId: bound }
    if (frameBytes(payload) > maxBytes) {
      stats.oversize += 1
      logger?.warn?.('memory frame dropped: too large', { type, nodeId: bound })
      return false
    }
    let ok = false
    try {
      ok = sendRaw(type, payload) === true
    } catch (err) {
      logger?.warn?.('memory frame send failed', { type, nodeId: bound, error: String(err?.message ?? err) })
      ok = false
    }
    if (ok) stats.sent += 1
    else stats.failed += 1
    return ok
  }

  /** 连接上线：绑定连接 id，并在 hub 支持时发 mem/hello。 */
  function online() {
    isOnline = true
    if (bound === null) return false
    if (!hubSupportsMemory()) {
      stats.blocked += 1
      return false
    }
    return send(MEMORY.HELLO, { appliedSeq: safeSeq(appliedSeq()) })
  }

  function offline() {
    isOnline = false
  }

  /** 把 hub 下行帧交给已注册的处理器；S2 没有消费者时返回 false。 */
  function dispatch(type, data) {
    if (!isMemoryFrameType(type)) return false
    const set = handlers.get(type)
    if (!set || set.size === 0) return false
    let handled = false
    for (const fn of [...set]) {
      try {
        fn(data)
        handled = true
      } catch (err) {
        logger?.warn?.('memory frame handler failed', { type, error: String(err?.message ?? err) })
      }
    }
    if (handled) stats.dispatched += 1
    return handled
  }

  return {
    get nodeId() { return bound },
    get isOnline() { return isOnline },
    get stats() { return { ...stats } },
    bind,
    on,
    send,
    online,
    offline,
    dispatch,
    hubSupportsMemory,
  }
}
