/**
 * M3: hub->node bot/history — return a page of the remote Bot's conversation.
 *
 * The remote ds-bot registers remote-agent:bot-page; this module validates the
 * request, calls the receiver, and sends back bot/history-result.
 */
import { NODE_TO_HUB, validateBotHistory } from './protocol.js'

export const BOT_PAGE_RECEIVER = 'remote-agent:bot-page'

export async function handleBotHistoryFrame({ frame, data, ctx, send, sendError }) {
  const v = validateBotHistory(data)
  if (!v.ok) {
    sendError?.(frame?.id, v.error, 'invalid bot/history: ' + v.error)
    return { accepted: false, error: v.error }
  }
  let receiver
  try { receiver = ctx?.get?.(BOT_PAGE_RECEIVER) } catch { receiver = undefined }
  const reply = (payload) => {
    send?.(NODE_TO_HUB.BOT_HISTORY_RESULT, {
      requestId: v.hist.requestId,
      ok: payload.ok !== false,
      ...(payload.ok !== false
        ? {
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
            items: Array.isArray(payload.items) ? payload.items : [],
            cursor: payload.cursor ?? null,
          }
        : { error: payload.error ?? 'bot-history-failed' }),
    })
  }
  if (typeof receiver !== 'function') {
    reply({ ok: false, error: 'bot-history-no-receiver' })
    return { accepted: false, error: 'bot-history-no-receiver' }
  }
  try {
    const result = await receiver({ remoteBotId: v.hist.remoteBotId, cursor: v.hist.cursor })
    const ok = result?.ok !== false
    reply({
      ok,
      sessionId: ok ? result?.sessionId : undefined,
      items: ok ? result?.items : undefined,
      cursor: ok ? result?.cursor : undefined,
      error: ok ? undefined : (typeof result?.error === 'string' ? result.error : 'bot-history-failed'),
    })
    return { accepted: ok }
  } catch (err) {
    reply({ ok: false, error: 'bot-history-failed' })
    return { accepted: false, error: 'bot-history-failed' }
  }
}
