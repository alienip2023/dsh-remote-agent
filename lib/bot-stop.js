/**
 * bot/stop 帧处理：hub → node，停掉节点上某个 Bot 正在跑的回合。
 *
 * 接收方由副机 ds-bot 通过 ctx.provide('remote-agent:bot-stop', fn) 注册，
 * 返回 { ok, stopped, error? }：ok=true + stopped=false 表示「本来就没在跑」，
 * 不是失败；ok=false 才是没停成（接收方缺失 / 抛错）。
 */
import { validateBotStop, NODE_TO_HUB } from './protocol.js'

export const BOT_STOP_RECEIVER = 'remote-agent:bot-stop'

/**
 * @param {{ frame, data, ctx, send, sendError }} opts
 */
export async function handleBotStopFrame({ frame, data, ctx, send, sendError }) {
  const checked = validateBotStop(data)
  if (!checked.ok) {
    sendError(frame.id, checked.error, `bot/stop validation failed: ${checked.error}`)
    return
  }
  const { requestId, remoteBotId } = checked.stop

  let receiver
  try { receiver = ctx?.get?.(BOT_STOP_RECEIVER) } catch { receiver = undefined }
  if (typeof receiver !== 'function') {
    send(
      NODE_TO_HUB.BOT_STOP_RESULT,
      { requestId, ok: false, stopped: false, error: 'bot-stop-no-receiver' },
      { replyTo: frame.id }
    )
    return
  }

  try {
    const result = await receiver({ remoteBotId })
    const failed = result?.ok === false
    send(
      NODE_TO_HUB.BOT_STOP_RESULT,
      {
        requestId,
        ok: !failed,
        stopped: result?.stopped === true,
        error: failed ? (result?.error ?? 'bot-stop-failed') : null,
      },
      { replyTo: frame.id }
    )
  } catch (err) {
    send(
      NODE_TO_HUB.BOT_STOP_RESULT,
      { requestId, ok: false, stopped: false, error: `bot-stop-failed: ${err?.message ?? String(err)}` },
      { replyTo: frame.id }
    )
  }
}
