/**
 * createFrameDispatcher: extracts the "ds-bot receiver" cases from the big dispatch switch in
 * lib/node/index.js, making them importable and testable independently.
 *
 * Only the four cases that delegate to ds-bot receivers (BOT_TURN, BOT_CREATE, BOT_HISTORY,
 * CONFIG_PUSH) are extracted here; all other cases stay in index.js dispatch.
 */
import { HUB_TO_NODE, NODE_TO_HUB } from '../protocol.js'
import { handleBotTurnFrame } from '../bot-turn.js'
import { handleBotCreateFrame } from '../bot-create.js'
import { handleBotHistoryFrame } from '../bot-history.js'
import { handleBotUpdateFrame } from '../bot-update.js'
import { createTurnSeq } from './turn-seq.js'

/** isPlainObject helper (same as index.js) */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function swallow(p) { Promise.resolve(p).catch(() => {}) }

/**
 * Returns a dispatch(frame, d?) function that handles the four ds-bot-receiver frame types.
 * Returns `true` if the frame was handled, `false` if it should fall through to index.js default.
 */
export function createFrameDispatcher({ ctx, send, sendError, engine, logger, stateDir }) {
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
      default:
        return false
    }
  }
}
