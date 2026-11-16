import { HUB_TO_NODE, RemoteAgentError, validateBotDirectory, validateBotMessage } from '../protocol.js'

/** hub 只转交宿主，不在传输层生成目录或决定 Bot 路由。 */
export function createHubBotNetwork({ registry, ctx, log = () => {} }) {
  let disposed = false
  async function onMessage(payload) {
    if (disposed) return
    try {
      // 每次到达时查找，允许 ds-bot 在 remote-agent 之后加载。
      const handler = ctx?.get?.('remote-agent:bot-message', false)
      if (typeof handler !== 'function') {
        log('debug', 'bot/message dropped: no host handler', { nodeId: payload.from.nodeId })
        return
      }
      await handler(payload)
    } catch {
      log('debug', 'bot/message host handler failed', { nodeId: payload.from.nodeId })
    }
  }
  registry.on('botMessage', onMessage)
  return {
    sendDirectory(nodeId, bots) {
      if (disposed) return false
      const payload = validateBotDirectory({ bots, at: Date.now() })
      return registry.send(nodeId, HUB_TO_NODE.BOT_DIRECTORY, payload)
    },
    sendMessage(nodeId, data) {
      if (disposed) return false
      const payload = validateBotMessage(data)
      if (payload.to.nodeId !== nodeId || !registry.nodes.has(nodeId)) {
        throw new RemoteAgentError('bot/message recipient must match a known destination node', 'bot-message-invalid')
      }
      return registry.send(nodeId, HUB_TO_NODE.BOT_MESSAGE, payload)
    },
    dispose() {
      disposed = true
      registry.off('botMessage', onMessage)
    },
  }
}
