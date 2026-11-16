/**
 * createFrameDispatcher: extracts the "ds-bot receiver" cases from the big dispatch switch in
 * lib/node/index.js, making them importable and testable independently.
 *
 * Bot receivers and the Bot/memory transport services are handled here;
 * all other cases stay in index.js dispatch.
 */
import { HUB_TO_NODE, MEMORY, NODE_TO_HUB, validateBotTurn } from '../protocol.js'
import { handleBotTurnFrame } from '../bot-turn.js'
import { handleBotCreateFrame } from '../bot-create.js'
import { handleBotHistoryFrame } from '../bot-history.js'
import { handleBotUpdateFrame } from '../bot-update.js'
import { handleBotDeleteFrame } from '../bot-delete.js'
import { handleBotStopFrame } from '../bot-stop.js'
import { createTurnSeq } from './turn-seq.js'
import { createTurnReplay } from './turn-replay.js'

/** isPlainObject helper (same as index.js) */
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function swallow(p) { Promise.resolve(p).catch(() => {}) }

/**
 * Returns a dispatch(frame, d?) function for Bot receivers and transport services.
 * Returns `true` if the frame was handled, `false` if it should fall through to index.js default.
 */
export function createFrameDispatcher({ ctx, send, sendError, engine, logger, stateDir, memory, network, peerDirect = false }) {
  const turnSeq = createTurnSeq(stateDir)
  const replay = peerDirect ? createTurnReplay() : null
  return function dispatchReceiverFrame(frame, d, reply = send) {
    const data = d ?? (isPlainObject(frame?.d) ? frame.d : {})
    switch (frame?.t) {
      case HUB_TO_NODE.BOT_DIRECTORY:
        network?.receiveDirectory(data)
        return true
      case HUB_TO_NODE.BOT_MESSAGE:
        swallow(network?.receiveMessage(data))
        return true
      case HUB_TO_NODE.BOT_TURN:
        if (replay && validateBotTurn(data).ok) {
          swallow(replay.run(data.exchangeId.trim(), async () => {
            let result
            await handleBotTurnFrame({ frame, data, ctx, send: (...args) => { result = args }, sendError, engine, turnSeq })
            return result
          }, reply))
        } else {
          swallow(handleBotTurnFrame({ frame, data, ctx, send: reply, sendError, engine, turnSeq }))
        }
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
