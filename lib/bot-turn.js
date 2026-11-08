/**
 * 名单第 2 步：hub→node 的 bot/turn 不进任务引擎。
 *
 * 副机 ds-bot 用 ctx.set('remote-agent:bot-turn', receiver) 注册接收方。
 * 本模块只校验、转发、把同一 exchangeId 的 bot/turn-result 送回。
 * 不调用 engine.accept，不调用 runner，不把缺字段改写成 mode:'agent'。
 */
import { NODE_TO_HUB, validateBotTurn } from './protocol.js'

export const BOT_TURN_RECEIVER = 'remote-agent:bot-turn'

export async function handleBotTurnFrame({ frame, data, ctx, send, sendError, engine, turnSeq }) {
  const v = validateBotTurn(data)
  if (!v.ok) {
    sendError?.(frame?.id, v.error, `invalid bot/turn: ${v.error}`)
    return { accepted: false, error: v.error }
  }
  // engine 只是为了让测试能断言它没被调用。这里不读它、不调用它。
  void engine
  let receiver
  try { receiver = ctx?.get?.(BOT_TURN_RECEIVER) } catch { receiver = undefined }
  const seq = typeof turnSeq?.next === 'function' ? turnSeq.next(v.turn.remoteBotId) : 0
  const reply = (payload) => {
    send?.(NODE_TO_HUB.BOT_TURN_RESULT, {
      nodeId: v.turn.nodeId,
      remoteBotId: v.turn.remoteBotId,
      exchangeId: v.turn.exchangeId,
      text: typeof payload.text === 'string' ? payload.text : '',
      ok: payload.ok !== false,
      seq,
      ...(payload.ok === false ? { error: payload.error ?? 'bot-turn-failed' } : {}),
    })
  }
  if (typeof receiver !== 'function') {
    reply({ ok: false, error: 'bot-turn-no-receiver', text: '' })
    return { accepted: false, error: 'bot-turn-no-receiver' }
  }
  try {
    const result = await receiver(v.turn)
    const ok = result?.ok !== false
    reply({
      ok,
      text: typeof result?.text === 'string' ? result.text : '',
      error: ok ? undefined : (typeof result?.error === 'string' && result.error !== '' ? result.error : 'bot-turn-failed'),
    })
    return { accepted: ok, exchangeId: v.turn.exchangeId, ...(ok ? {} : { error: result?.error ?? 'bot-turn-failed' }) }
  } catch {
    reply({ ok: false, error: 'bot-turn-failed', text: '' })
    return { accepted: false, error: 'bot-turn-failed' }
  }
}
