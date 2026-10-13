/**
 * 主机侧 subagent provider（零外部依赖）。
 *
 * 定位：把"远程副机"接成 DSH 的一个**委派目标**。主 agent 用普通的
 * subagent 工具派活，实际上任务跑在另一台电脑上；主 agent 拿到的是
 * 一张交接卡，而不是副机的原始日志。
 *
 * 三条刻意的设计取舍：
 *
 *   1. `inheritsParentContext: false` —— 副机 agent 有独立的模型上下文，
 *      不继承主机会话。这也意味着主机侧不需要（也不应该）把会话内容送出去。
 *
 *   2. `capabilities` 全 false —— provider 不实现 agentOptions / outputSchema /
 *      depthLimit / toolFilter / persona。声称支持却忽略参数，比明确不支持更糟：
 *      上层会以为限制生效了。深度与并发由副机自己的 agent 循环负责。
 *
 *   3. **start() 不等待任务被接受** —— 只做同步可判定的拒绝（无在线节点、
 *      多节点且未指定、节点不可达），然后立刻把 SubagentRun 交给持有者。
 *      等 accept 是 result 的事：否则持有者在最长 ackTimeoutMs 内拿不到
 *      dispose 句柄，也就无法取消一条刚派出去的任务。
 *
 * 节点选择：request.label 里出现节点 id 或主机名就用它，否则要求恰好一个在线节点。
 */
import { ERROR_CODE, TERMINAL_STATUS, TASK_MODE, TASK_STATUS, newTaskId, validateTaskStart } from '../protocol.js'
import { handoffSummaryText } from './tools.js'

/** 从 label 里认出节点名。label 形如 "build on DESKTOP-01" / "node:DESKTOP-01"。 */
export function nodeHintFromLabel(label, registry) {
  const text = String(label ?? '').trim()
  if (text === '') return ''
  for (const rec of registry.nodes.values()) {
    const id = rec.nodeId
    const host = String(rec.hello?.hostname ?? '')
    for (const token of [id, host]) {
      if (token && text.toLowerCase().includes(token.toLowerCase())) return id
    }
  }
  return ''
}

/** request.prompt（ContentBlock[]）里的文本拼成 goal。非文本块如实标注，不静默丢弃。 */
export function promptToGoal(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : []
  const parts = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
      continue
    }
    if (typeof b.type === 'string') parts.push(`[${b.type} block omitted]`)
  }
  return parts.join('\n\n').trim()
}

/** 任务状态 → SubagentStopReason。 */
export function stopReasonOf(status) {
  switch (status) {
    case TASK_STATUS.COMPLETED:
      return 'completed'
    case TASK_STATUS.ABORTED:
      return 'aborted'
    case TASK_STATUS.FAILED:
    case TASK_STATUS.INTERRUPTED:
      return 'error'
    default:
      return 'error'
  }
}

/**
 * @param {object} o
 * @param {import('./node-registry.js').NodeRegistry} o.registry
 * @param {import('./pull-manager.js').PullManager} o.pulls
 * @param {(level:string,msg:string,extra?:object)=>void} o.log
 * @param {object} [o.defaults]
 * @returns {object} SubagentProvider
 */
export function createRemoteAgentProvider({ registry, pulls, log, defaults = {} }) {
  const defaultTimeoutMs = Number.isFinite(defaults.timeoutMs) ? defaults.timeoutMs : 60 * 60 * 1000
  const ackTimeoutMs = registry?.limits?.ackTimeoutMs ?? 60_000

  return {
    name: 'remote-agent',
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,

    async start(request) {
      const label = typeof request?.label === 'string' ? request.label : ''
      const goal = promptToGoal(request?.prompt)
      const hint = nodeHintFromLabel(label, registry)

      let nodeId
      if (hint !== '') {
        nodeId = hint
      } else {
        const online = registry.onlineNodes()
        if (online.length === 0) throw new Error('remote-agent: 没有在线节点，先让副机接入')
        if (online.length > 1) {
          throw new Error(
            `remote-agent: 有多个在线节点（${online.map((n) => n.nodeId).join(', ')}），请在 label 里写明节点名`,
          )
        }
        nodeId = online[0].nodeId
      }

      const taskId = newTaskId()
      const v = validateTaskStart({
        taskId,
        goal: goal === '' ? label || '(empty prompt)' : goal,
        mode: TASK_MODE.AGENT,
        constraints: { timeoutMs: defaultTimeoutMs },
        origin: 'subagent',
      })
      if (!v.ok) throw new Error(`remote-agent: invalid task (${v.error})`)

      // 同步可判定的失败在这里抛出：框架约定"start 拒绝 ⇒ 没有 run 需要释放"。
      registry.createTask({ nodeId, spec: v.spec })
      log('info', 'subagent run dispatched', { taskId, nodeId, label })

      let cancelled = false
      let resolveCancel
      const cancelPromise = new Promise((r) => {
        resolveCancel = r
      })
      const cancel = () => {
        if (cancelled) return
        cancelled = true
        pulls.cancelTask(taskId)
        registry.cancelTask(taskId)
        resolveCancel()
      }

      const result = (async () => {
        const signal = request?.signal
        const onAbort = () => cancel()
        try {
          if (signal) {
            if (signal.aborted) cancel()
            else signal.addEventListener('abort', onAbort, { once: true })
          }

          // 两条路竞争：任务真的跑到终态，或持有者放弃了这次运行。
          //
          // 为什么取消要单独成一条路：dispose() / signal abort 的语义是
          // "持有者不再要这次运行"，result 必须**及时**落定。若只等副机的终态帧，
          // 一条刚派出去、副机还没回话的任务会把 result 挂到 ackTimeout 之后。
          // 取消请求照发不误 —— 副机侧的任务该停还是要停。
          const work = (async () => {
            // 等 accept：节点拒绝工作区时会立刻回终态，所以两条路一起等。
            await registry.awaitAccepted(taskId, { timeoutMs: ackTimeoutMs })
            // 等终态。任务超时由副机自己执行并如实上报；这里的上界只是兜底，
            // 防止节点中途彻底失联时把 subagent 永久挂住。
            return registry.awaitTerminal(taskId, { timeoutMs: defaultTimeoutMs + ackTimeoutMs * 2 })
          })()
          work.catch(() => {}) // 竞争失败的那条不产生未处理 rejection

          const raced = await Promise.race([
            work.then(
              (terminal) => ({ kind: 'terminal', terminal }),
              (err) => ({ kind: 'error', err }),
            ),
            cancelPromise.then(() => ({ kind: 'cancelled' })),
          ])

          if (raced.kind === 'cancelled') {
            const task = registry.getTask(taskId)
            return {
              output: [
                {
                  type: 'text',
                  text: `远程任务 ${taskId} 已请求取消（节点 ${nodeId}，最后一次状态 ${task?.status ?? 'unknown'}）。`,
                },
              ],
              structured: { taskId, nodeId, status: task?.status ?? 'unknown', cancelled: true },
              stopReason: 'aborted',
              diagnostic: 'run cancelled by the holder',
            }
          }

          if (raced.kind === 'error') {
            cancel()
            const task = registry.getTask(taskId)
            return {
              output: [{ type: 'text', text: `远程任务 ${taskId} 未完成：${String(raced.err?.message ?? raced.err)}` }],
              structured: { taskId, nodeId, status: task?.status ?? 'unknown' },
              stopReason: String(raced.err?.code ?? '') === 'aborted' ? 'aborted' : 'error',
              diagnostic: String(raced.err?.message ?? raced.err),
            }
          }

          const terminal = raced.terminal
          const handoff = terminal.handoff
          const body = handoff ? handoffSummaryText(terminal) : fallbackText(terminal)
          return {
            output: [{ type: 'text', text: body }],
            structured: handoff ?? { taskId, nodeId, status: terminal.status },
            stopReason: stopReasonOf(terminal.status),
            diagnostic:
              terminal.status === TASK_STATUS.COMPLETED
                ? undefined
                : `${terminal.error?.code ?? terminal.status}: ${terminal.error?.message ?? 'remote task did not complete'}`,
          }
        } catch (err) {
          // 兜底：任何意外都要落成一个 SubagentResult，绝不让 result 悬挂。
          cancel()
          const task = registry.getTask(taskId)
          return {
            output: [{ type: 'text', text: `远程任务 ${taskId} 未完成：${String(err?.message ?? err)}` }],
            structured: { taskId, nodeId, status: task?.status ?? 'unknown' },
            stopReason: String(err?.code ?? '') === 'aborted' ? 'aborted' : 'error',
            diagnostic: String(err?.message ?? err),
          }
        } finally {
          if (signal) {
            try {
              signal.removeEventListener('abort', onAbort)
            } catch {
              /* signal 已失效 */
            }
          }
        }
      })()
      // result 的拒绝已在内部全部转成 SubagentResult，这里再兜一层，
      // 避免一个未处理的 rejection 打挂 host。
      result.catch(() => {})

      return {
        id: taskId,
        localAgent: undefined,
        result,
        async dispose() {
          cancel()
        },
      }
    },
  }
}

function fallbackText(task) {
  const lines = [
    `# 远程任务 ${task.taskId}`,
    '',
    `- 节点：${task.nodeId}`,
    `- 状态：${task.status}`,
    `- 工作区：${task.workspace ?? '(未知)'}`,
  ]
  if (task.error) lines.push(`- 错误：${task.error.code}: ${task.error.message}`)
  const progress = Array.isArray(task.progressTail) ? task.progressTail : []
  if (progress.length > 0) {
    lines.push('', '进度尾巴：')
    for (const p of progress.slice(-10)) lines.push(`- ${p.phase}${p.detail ? `: ${String(p.detail).slice(0, 200)}` : ''}`)
  }
  const logs = Array.isArray(task.logTail) ? task.logTail : []
  if (logs.length > 0) {
    lines.push('', '日志尾巴：')
    for (const l of logs.slice(-15)) lines.push(`> ${String(l).slice(0, 300)}`)
  }
  if (!TERMINAL_STATUS.has(task.status)) lines.push('', '（任务尚未结束，副机仍在本地运行。）')
  return lines.join('\n')
}

export { ERROR_CODE }
