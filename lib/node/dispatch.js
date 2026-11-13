/**
 * createFrameDispatcher: extracts the "ds-bot receiver" cases from the big dispatch switch in
 * lib/node/index.js, making them importable and testable independently.
 *
 * Only the four cases that delegate to ds-bot receivers (BOT_TURN, BOT_CREATE, BOT_HISTORY,
 * CONFIG_PUSH) are extracted here; all other cases stay in index.js dispatch.
 */
import { HUB_TO_NODE, MEMORY, NODE_TO_HUB } from '../protocol.js'
import { handleBotTurnFrame } from '../bot-turn.js'
import { handleBotCreateFrame } from '../bot-create.js'
import { handleBotHistoryFrame } from '../bot-history.js'
import { handleBotUpdateFrame } from '../bot-update.js'
import { handleBotDeleteFrame } from '../bot-delete.js'
import { handleBotStopFrame } from '../bot-stop.js'
import { createTurnSeq } from './turn-seq.js'

/** isPlainObject helper (same as index.js) */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function swallow(p) { Promise.resolve(p).catch(() => {}) }

/**
 * Returns a dispatch(frame, d?) function that handles the four ds-bot-receiver frame types.
 * Returns `true` if the frame was handled, `false` if it should fall through to index.js default.
 */
export function createFrameDispatcher({ ctx, send, sendError, engine, logger, stateDir, memory }) {
  const turnSeq = createTurnSeq(stateDir)
  return function dispatchReceiverFrame(frame, d) {
    const data = d ?? (isPlainObject(frame?.d) ? frame.d : {})
    switch (frame?.t) {
      case HUB_TO_NODE.BOT_TURN:
        swallow(handleBotTurnFrame({ frame, data, ctx, send, sendError, engine, turnSeq }))
        return true
      case HUB_TO_NODE.BOT_CREATE:
        swallow(handleBotCreateFrame({ frame, data, ctx, send, sendError, engine }))
        return true
      case HUB_TO_NODE.BOT_HISTORY:
        swallow(handleBotHistoryFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_UPDATE:
        swallow(handleBotUpdateFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_DELETE:
        swallow(handleBotDeleteFrame({ frame, data, ctx, send, sendError }))
        return true
      case HUB_TO_NODE.BOT_STOP:
        swallow(handleBotStopFrame({ frame, data, ctx, send, sendError }))
        return true
      // M4：记忆通道的下行三类。真正的读写在 S4 的 outbox/inject 里，
      // 这里只负责把帧交给 memory-link，不让它落进未知帧的告警里。
      case MEMORY.SNAPSHOT:
      case MEMORY.READ_RESULT:
      case MEMORY.WRITE_RESULT:
        if (!memory) return false
        memory.dispatch(frame.t, data)
        return true
      default:
        return false
    }
  }
}
