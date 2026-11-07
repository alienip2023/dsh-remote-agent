/**
 * 名单第 3 步：hub→node 的 bot/create 不进任务引擎。
 *
 * 副机 ds-bot 用 ctx.set('remote-agent:bot-create', receiver) 注册接收方。
 * 本模块只校验、转发、把同一 requestId 的 bot/create-result 送回。
 * 不调用 engine.accept，不调用 runner，不把缺字段改写成 mode:'agent'。
 */
import { NODE_TO_HUB, validateBotCreate } from './protocol.js'

export const BOT_CREATE_RECEIVER = 'remote-agent:bot-create'

export async function handleBotCreateFrame({ frame, data, ctx, send, sendError, engine }) {
  const v = validateBotCreate(data)
  if (!v.ok) {
    sendError?.(frame?.id, v.error, `invalid bot/create: ${v.error}`)
    return { accepted: false, error: v.error }
  }
  // engine 只是为了让测试能断言它没被调用。这里不读它、不调用它。
  void engine
  let receiver
  try { receiver = ctx?.get?.(BOT_CREATE_RECEIVER) } catch { receiver = undefined }
  const reply = (payload) => {
    send?.(NODE_TO_HUB.BOT_CREATE_RESULT, {
      requestId: v.create.requestId,
      ok: payload.ok !== false,
      ...(payload.ok !== false
        ? {
            remoteBotId: payload.remoteBotId,
            name: typeof payload.name === 'string' ? payload.name : '',
            role: typeof payload.role === 'string' ? payload.role : '',
          }
        : { error: payload.error ?? 'bot-create-failed' }),
    })
  }
  if (typeof receiver !== 'function') {
    reply({ ok: false, error: 'bot-create-no-receiver' })
    return { accepted: false, error: 'bot-create-no-receiver' }
  }
  try {
    const result = await receiver(v.create)
    const ok = result?.ok !== false
    reply({
      ok,
      remoteBotId: ok ? result?.remoteBotId : undefined,
      name: ok ? result?.name : undefined,
      role: ok ? result?.role : undefined,
      error: ok ? undefined : (typeof result?.error === 'string' && result.error !== '' ? result.error : 'bot-create-failed'),
    })
    return { accepted: ok, requestId: v.create.requestId, ...(ok ? { remoteBotId: result?.remoteBotId } : { error: result?.error ?? 'bot-create-failed' }) }
  } catch {
    reply({ ok: false, error: 'bot-create-failed' })
    return { accepted: false, error: 'bot-create-failed' }
  }
}
