/**
 * 并发上限下发（hub → node 的 node/config）。
 *
 * 主控在 ds-bot 的设置页改某台节点的并发上限；这里是节点侧的落点：
 * 校验帧 → 与连接身份比对 nodeId → 运行时改 TaskEngine 的 maxConcurrent
 * （改完立即 pump，排队任务马上起）→ 回 node/config-result。
 *
 * 旧节点没有这个 case，会按未知帧忽略、不回 result；主控等超时后标
 * 「节点版本不支持」，保持 4 —— 这里不做任何兼容伪装。
 */
import { NODE_TO_HUB, validateNodeConfig } from '../protocol.js'

/**
 * @param {object} o
 * @param {object} o.data 帧载荷
 * @param {string} o.nodeId 连接级节点身份（不是载荷自述）
 * @param {import('./task-engine.js').TaskEngine} o.engine
 * @param {(type:string, data:object)=>void} o.send
 * @param {object} [o.logger]
 * @returns {Promise<void>}
 */
export async function handleNodeConfigFrame({ data, nodeId, engine, send, logger }) {
  const checked = validateNodeConfig(data)
  if (!checked.ok) {
    logger?.warn?.('node/config refused', { error: checked.error })
    // 没有可用的 requestId 就对不上回执；有就如实回 ok:false，绝不静默丢弃。
    const requestId = typeof data?.requestId === 'string' && data.requestId.trim() !== '' ? data.requestId.trim() : undefined
    if (requestId !== undefined) {
      send(NODE_TO_HUB.NODE_CONFIG_RESULT, {
        requestId,
        nodeId,
        ok: false,
        maxConcurrent: engine?.maxConcurrent ?? null,
        error: checked.error,
      })
    }
    return
  }
  const { requestId, maxConcurrent } = checked.config
  // 归属只认连接身份：载荷里的 nodeId 与连接不符时整帧拒绝。
  if (checked.config.nodeId !== nodeId) {
    logger?.warn?.('node/config nodeId mismatch', { claimed: checked.config.nodeId, connection: nodeId })
    send(NODE_TO_HUB.NODE_CONFIG_RESULT, {
      requestId,
      nodeId,
      ok: false,
      maxConcurrent: engine?.maxConcurrent ?? null,
      error: 'node-config-node-mismatch',
    })
    return
  }
  const applied = engine?.setMaxConcurrent?.(maxConcurrent)
  if (applied === undefined) {
    send(NODE_TO_HUB.NODE_CONFIG_RESULT, {
      requestId,
      nodeId,
      ok: false,
      maxConcurrent: engine?.maxConcurrent ?? null,
      error: 'node-config-maxConcurrent-invalid',
    })
    return
  }
  logger?.info?.('node/config applied', { maxConcurrent: applied })
  send(NODE_TO_HUB.NODE_CONFIG_RESULT, { requestId, nodeId, ok: true, maxConcurrent: applied })
}
