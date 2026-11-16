import { EventEmitter } from 'node:events'
import { NODE_TO_HUB, RemoteAgentError, validateBotDirectory, validateBotMessage } from '../protocol.js'

const REPLAY_MS = 60_000
const MAX_DEPTH = 3

/**
 * 节点 Bot 网络传输层。目录生成、目标路由及 Bot 身份选择由宿主负责。
 * send({ from, to, exchangeId, kind, text, depth }) 的 from 标识本机发送 Bot；
 * nodeId 必须匹配本连接，不能凭节点目录猜测多 Bot 节点上的发送者。
 * directory 事件载荷是目录数组的快照，可通过 on('directory', handler) 订阅。
 */
export function createBotNetwork({ nodeId, send: sendRaw = () => false, logger } = {}) {
  const network = new EventEmitter()
  const handlers = new Set()
  const seen = new Map()
  let bots = []
  let disposed = false
  const snapshot = () => bots.map(bot => ({ ...bot }))
  const warn = code => logger?.warn?.('bot network frame dropped', { code })
  const exceedsDepth = payload => {
    if (!(payload?.depth > MAX_DEPTH)) return false
    logger?.warn?.('bot network frame dropped', {
      code: 'bot-message-depth-exceeded', exchangeId: payload.exchangeId,
      from: payload.from, to: payload.to,
    })
    return true
  }

  function cleanSeen() {
    const now = Date.now()
    for (const [id, expires] of seen) {
      if (expires <= now) seen.delete(id)
    }
  }
  const timer = setInterval(cleanSeen, REPLAY_MS)
  timer.unref?.()

  network.directory = snapshot
  network.send = input => {
    if (disposed) return false
    if (exceedsDepth(input)) return false
    const payload = validateBotMessage({ ...input, depth: input?.depth === undefined ? 0 : input.depth })
    if (payload.from.nodeId !== nodeId) {
      throw new RemoteAgentError('bot/message sender must belong to this node', 'bot-message-invalid')
    }
    try { return sendRaw(NODE_TO_HUB.BOT_MESSAGE, payload) === true } catch { return false }
  }
  network.onMessage = handler => {
    if (typeof handler !== 'function') throw new TypeError('bot message handler must be a function')
    if (disposed) return () => {}
    handlers.add(handler)
    return () => { handlers.delete(handler) }
  }
  network.receiveDirectory = data => {
    if (disposed) return
    try { bots = validateBotDirectory(data).bots } catch (err) { warn(err.code); return }
    network.emit('directory', snapshot())
  }
  network.receiveMessage = async data => {
    if (disposed) return
    if (exceedsDepth(data)) return
    let payload
    try { payload = validateBotMessage(data) } catch (err) { warn(err.code); return }
    if (payload.to.nodeId !== nodeId) { warn('bot-message-node-mismatch'); return }
    cleanSeen()
    const replayKey = JSON.stringify([payload.exchangeId, payload.kind])
    if (seen.has(replayKey)) return
    // ask/reply 分别在首个 await 之前登记，阻止在途及已完成消息的重放。
    seen.set(replayKey, Date.now() + REPLAY_MS)
    for (const handler of [...handlers]) {
      if (disposed) break
      try {
        // 每个 handler 拿独立副本，不能改写后续 handler 或自动回复的署名。
        const text = await handler(validateBotMessage(payload))
        if (payload.kind === 'ask' && typeof text === 'string') {
          network.send({ ...payload, kind: 'reply', from: payload.to, to: payload.from,
            text: text.slice(0, 65536), depth: payload.depth + 1 })
        }
      } catch { /* 单个 handler 失败时不回复，也不阻止其他订阅者。 */ }
    }
  }
  network.dispose = () => {
    disposed = true
    clearInterval(timer)
    seen.clear()
    handlers.clear()
    bots = []
    network.removeAllListeners()
  }
  return network
}
