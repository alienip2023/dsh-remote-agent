/**
 * bot/update 帧处理：hub → node，更新节点上某个 Bot 的属性。
 * 接收方由副机 ds-bot 通过 ctx.provide('remote-agent:bot-update', fn) 注册。
 */
import { validateBotUpdate, NODE_TO_HUB } from './protocol.js'

export const BOT_UPDATE_RECEIVER = 'remote-agent:bot-update'

/**
 * @param {{ frame, data, ctx, send, sendError }} opts
 */
export async function handleBotUpdateFrame({ frame, data, ctx, send, sendError }) {
  const checked = validateBotUpdate(data)
  if (!checked.ok) {
    sendError(frame.id, checked.error, `bot/update validation failed: ${checked.error}`)
    return
  }
  const { requestId, remoteBotId, model, effort, instructions, workDir, memoryConfig } = checked.update

  let receiver
  try { receiver = ctx?.get?.(BOT_UPDATE_RECEIVER) } catch { receiver = undefined }
  if (typeof receiver !== 'function') {
    send(NODE_TO_HUB.BOT_UPDATE_RESULT, { requestId, ok: false, error: 'bot-update-no-receiver' }, { replyTo: frame.id })
    return
  }

  try {
    // memoryConfig 原样交给副机 ds-bot 的 receiver：后端枚举由它的 roster 校验，
    // 这里不猜也不改形状（null = 这帧没带，不是「清除」）。
    const result = await receiver({ remoteBotId, model, effort, instructions, workDir, memoryConfig })
    send(
      NODE_TO_HUB.BOT_UPDATE_RESULT,
      {
        requestId,
        ok: result?.ok === true,
        error: result?.ok ? null : (result?.error ?? 'bot-update-failed'),
        model: result?.model ?? null,
        effort: result?.effort ?? null,
        instructions: result?.instructions ?? null,
        workDir: result?.workDir ?? null,
        memoryConfig: result?.memoryConfig ?? null,
      },
      { replyTo: frame.id }
    )
  } catch (err) {
    send(NODE_TO_HUB.BOT_UPDATE_RESULT, { requestId, ok: false, error: `bot-update-failed: ${err?.message ?? String(err)}` }, { replyTo: frame.id })
  }
}
