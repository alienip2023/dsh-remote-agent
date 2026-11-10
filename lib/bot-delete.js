/**
 * bot/delete 帧处理：hub → node，删除节点上某个本地 Bot。
 * 接收方由副机 ds-bot 通过 ctx.provide('remote-agent:bot-delete', fn) 注册。
 */
import { validateBotDelete, NODE_TO_HUB } from './protocol.js'

export const BOT_DELETE_RECEIVER = 'remote-agent:bot-delete'

/**
 * @param {{ frame, data, ctx, send, sendError }} opts
 */
export async function handleBotDeleteFrame({ frame, data, ctx, send, sendError }) {
  const checked = validateBotDelete(data)
  if (!checked.ok) {
    sendError(frame.id, checked.error, `bot/delete validation failed: ${checked.error}`)
    return
  }
  const { requestId, remoteBotId } = checked.del

  let receiver
  try { receiver = ctx?.get?.(BOT_DELETE_RECEIVER) } catch { receiver = undefined }
  if (typeof receiver !== 'function') {
    send(NODE_TO_HUB.BOT_DELETE_RESULT, { requestId, ok: false, error: 'bot-delete-no-receiver' }, { replyTo: frame.id })
    return
  }

  try {
    const result = await receiver({ remoteBotId })
    send(
      NODE_TO_HUB.BOT_DELETE_RESULT,
      {
        requestId,
        ok: result?.ok === true,
        error: result?.ok ? null : (result?.error ?? 'bot-delete-failed'),
      },
      { replyTo: frame.id }
    )
  } catch (err) {
    send(NODE_TO_HUB.BOT_DELETE_RESULT, { requestId, ok: false, error: `bot-delete-failed: ${err?.message ?? String(err)}` }, { replyTo: frame.id })
  }
}
