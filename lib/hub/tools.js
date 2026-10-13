/**
 * 主机侧 remote_* 工具集（零外部依赖）。
 *
 * 设计原则：**主电脑只消费 handoff，不消费副机的原始日志。**
 * 七个工具的职责边界刻意切得很窄：
 *
 *   remote_nodes    看有哪些副机在线（信息汇聚的入口）
 *   remote_task     派一条任务（幂等 taskId，立即返回，不阻塞等结果）
 *   remote_status   看一条任务现在到哪了（进度尾巴 + 日志尾巴）
 *   remote_handoff  取完整交接卡（决策所需的一切都在这一张卡里）
 *   remote_manifest 取产物清单（先看清单，再决定拉什么）
 *   remote_pull     显式拉取成品（只有 role:final 能过河）
 *   remote_cancel   打断一条任务
 *
 * 所有 execute 都返回普通 JSON（output.schema 描述它），错误以
 * RemoteAgentError 抛出，由框架统一materialize 成错误结果。
 */
import os from 'node:os'
import path from 'node:path'
import {
  ERROR_CODE,
  PROTOCOL_VERSION,
  RemoteAgentError,
  TASK_MODE,
  TERMINAL_STATUS,
  newTaskId,
  validateTaskStart,
} from '../protocol.js'

/** 渲染文本上限：工具结果进模型上下文，别把整份清单灌进去。 */
const RENDER_LIMIT = 6000

function text(value) {
  let s
  if (typeof value === 'string') s = value
  else {
    try {
      s = JSON.stringify(value, null, 2)
    } catch {
      s = undefined
    }
  }
  // JSON.stringify(undefined) / 循环引用都返回 undefined：展示层退化成占位文本。
  if (typeof s !== 'string') return '(no value)'
  return s.length > RENDER_LIMIT ? `${s.slice(0, RENDER_LIMIT)}\n… (truncated)` : s
}

/**
 * 包一层 render。
 *
 * render 是"展示层"，它绝不该把一次成功的工具调用变成失败：值形状意外
 * （例如被裁剪、被旧版投影喂进来）时退回 JSON 文本，而不是抛出去。
 */
function renderText(fn) {
  return (args, value) => {
    try {
      const out = fn(args, value)
      return [{ type: 'text', text: typeof out === 'string' ? text(out) : text(out ?? value) }]
    } catch {
      return [{ type: 'text', text: text(value) }]
    }
  }
}

/** 安全的数组读取：值缺失时给空数组，而不是 undefined.length。 */
function arr(v) {
  return Array.isArray(v) ? v : []
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function human(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}

/** 从任务视图挑出可 pull 的成品路径。 */
export function finalPaths(task) {
  const fromManifest = task?.manifest?.final
  if (Array.isArray(fromManifest)) return fromManifest.map((i) => i.path)
  const fromHandoff = task?.handoff?.artifacts?.final
  if (Array.isArray(fromHandoff)) return fromHandoff.map((i) => i.path)
  return []
}

export function buildManifestView(task) {
  const m = task?.manifest ?? null
  const a = task?.handoff?.artifacts ?? null
  const counts = m?.counts ?? a?.counts ?? null
  const bytesFinal = num(m?.bytesFinal) ?? num(a?.bytesFinal) ?? 0
  const finalList = Array.isArray(m?.final) ? m.final : Array.isArray(a?.final) ? a.final : []
  return {
    taskId: task?.taskId ?? null,
    status: task?.status ?? 'unknown',
    counts: counts ?? null,
    bytesFinal,
    final: finalList.map((i) => ({
      path: i.path,
      kind: i.kind ?? 'file',
      bytes: num(i.bytes) ?? 0,
      sha256: i.sha256 ?? null,
    })),
    intermediateCount: num(m?.intermediateCount) ?? num(a?.intermediateCount) ?? 0,
    note:
      (typeof m?.note === 'string' && m.note) ||
      (typeof a?.note === 'string' && a.note) ||
      (finalList.length === 0
        ? '还没有清单：任务未结束，或本次没有 role:final 产物。'
        : '只有 role:final 可以 pull；intermediate 仅上报元数据，留在副机。'),
  }
}

/** 从 handoff 生成一段人/模型都能直接读的摘要文本。 */
export function handoffSummaryText(task) {
  const h = task?.handoff
  if (!h) {
    return `任务 ${task?.taskId ?? '(unknown)'} 尚无交接卡（status=${task?.status ?? 'unknown'}）。`
  }
  const lines = []
  lines.push(`# 远程任务交接 ${h.taskId}`)
  lines.push('')
  lines.push(`- 节点：${h.nodeId}`)
  lines.push(`- 状态：${h.status}${h.exit?.timedOut ? '（超时）' : ''}`)
  lines.push(`- 模式：${h.mode}  运行器：${h.runner ?? 'unknown'}`)
  if (typeof h.durationMs === 'number') lines.push(`- 耗时：${Math.round(h.durationMs / 1000)}s`)
  lines.push(`- 工作区：${h.workspace}`)
  lines.push('')
  lines.push('## 摘要')
  lines.push('')
  lines.push(String(h.summary?.text ?? '(无摘要)'))
  const changed = Array.isArray(h.changed) ? h.changed : []
  if (changed.length > 0) {
    lines.push('')
    lines.push(`## 工作区变更（${changed.length} 条）`)
    lines.push('')
    for (const c of changed.slice(0, 40)) {
      lines.push(`- ${c.op} ${c.path}${typeof c.bytes === 'number' ? ` (${human(c.bytes)})` : ''}`)
    }
    if (changed.length > 40) lines.push(`- … 另有 ${changed.length - 40} 条`)
  }
  const artifacts = h.artifacts
  if (artifacts) {
    lines.push('')
    lines.push(`## 产物清单（final ${artifacts.counts?.final ?? 0} / intermediate ${artifacts.intermediateCount ?? 0}）`)
    lines.push('')
    for (const f of (artifacts.final ?? []).slice(0, 40)) {
      lines.push(`- ${f.path} — ${f.kind}, ${human(f.bytes)}, sha256=${String(f.sha256 ?? 'n/a').slice(0, 12)}…`)
    }
    lines.push('')
    lines.push(String(artifacts.note ?? ''))
    if (typeof h.pullHint === 'string') lines.push('', `拉取提示：${h.pullHint}`)
  }
  const logs = h.logs?.tail
  if (Array.isArray(logs) && logs.length > 0) {
    lines.push('')
    lines.push('## 日志尾巴')
    lines.push('')
    for (const l of logs.slice(-10)) lines.push(`> ${String(l).slice(0, 300)}`)
  }
  return lines.join('\n')
}

/**
 * 注册七个工具。
 * @returns {Array<() => void>} disposers
 */
export function registerRemoteTools({ ctx, registry, pulls, log, defaults = {} }) {
  const disposers = []
  const defaultTimeoutMs = num(defaults.timeoutMs) ?? 60 * 60 * 1000

  const reg = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  // ── remote_nodes ───────────────────────────────────────────────
  reg({
    name: 'remote_nodes',
    description:
      '列出所有已注册的远程副机节点（在线与离线都列出）。这是信息汇聚的入口：先看有哪些机器可用、各自的操作系统与允许的工作区根，再决定把任务派给谁。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                nodeId: { type: 'string' },
                os: { type: 'string' },
                arch: { type: 'string' },
                hostname: { type: 'string' },
                online: { type: 'boolean' },
                roots: { type: 'array', items: { type: 'string' } },
                caps: { type: 'array', items: { type: 'string' } },
                agentMode: { type: 'boolean' },
                since: { type: 'number' },
                lastSeen: { type: 'number' },
                taskCount: { type: 'number' },
              },
              required: ['nodeId', 'online'],
            },
          },
          protocol: { type: 'number' },
        },
        required: ['nodes'],
      },
      render: renderText((_args, value) => {
        const nodes = arr(value?.nodes)
        if (nodes.length === 0) return '当前没有任何远程节点接入。'
        const lines = [`远程节点（${nodes.filter((n) => n.online).length}/${nodes.length} 在线）：`, '']
        for (const n of nodes) {
          lines.push(
            `- ${n.nodeId} [${n.online ? 'online' : 'offline'}] ${n.os}/${n.arch} host=${n.hostname} agentMode=${n.agentMode} tasks=${n.taskCount}`,
          )
          if (n.roots?.length) lines.push(`  roots: ${n.roots.join(', ')}`)
          if (n.caps?.length) lines.push(`  caps: ${n.caps.join(', ')}`)
        }
        return lines.join('\n')
      }),
    },
    async execute() {
      return { protocol: PROTOCOL_VERSION, nodes: registry.list() }
    },
  })

  // ── remote_task ────────────────────────────────────────────────
  reg({
    name: 'remote_task',
    description:
      '把一条任务派给远程副机执行。副机在自己的机器上本地跑（默认起一个独立 agent 会话，mode=exec 则直接跑一段命令），任务在副机持久运行、断连不终止。本工具只等到副机"接受任务"就返回，不等结果；之后用 remote_status / remote_handoff 跟进。',
    parameters: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '目标节点 id（或主机名）。省略时要求恰好只有一个在线节点。' },
        goal: { type: 'string', description: '任务目标。mode=agent 时是给副机 agent 的任务书；mode=exec 时是要执行的命令。' },
        workspace: { type: 'string', description: '副机上的绝对工作区路径，必须落在该节点允许的 roots 之内。省略则用节点默认工作区。' },
        mode: { type: 'string', enum: ['agent', 'exec'], description: 'agent=副机起独立 agent 会话（默认）；exec=直接执行命令。' },
        outputs: { type: 'array', items: { type: 'string' }, description: '期望产出物的 glob（相对工作区），用于产物清单筛选。' },
        timeoutMs: { type: 'number', description: `副机侧任务超时（毫秒），默认 ${defaultTimeoutMs}。` },
        denyPaths: { type: 'array', items: { type: 'string' }, description: '副机侧额外禁止访问的路径（绝对路径）。' },
        artifactRules: {
          type: 'object',
          description:
            '覆盖内置的产物角色判定。final=强制判为成品（可 pull）；intermediate=强制判为中间产物（不过河）。'
            + '用于内置表不适配的仓库，例如把 build/ 当源码目录时传 { intermediate: ["build/**"] }。',
          properties: {
            final: { type: 'array', items: { type: 'string' }, description: 'glob 列表，命中即判为 role:final。' },
            intermediate: { type: 'array', items: { type: 'string' }, description: 'glob 列表，命中即判为 role:intermediate（优先于 final）。' },
          },
          additionalProperties: false,
        },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          node: { type: 'string' },
          accepted: { type: 'boolean' },
          workspace: { type: ['string', 'null'] },
          runner: { type: ['string', 'null'] },
          status: { type: 'string' },
          duplicate: { type: 'boolean' },
          error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
          hint: { type: 'string' },
        },
        required: ['taskId', 'node', 'accepted'],
      },
      render: renderText((_args, value) => {
        if (!value) return 'remote_task: 无返回'
        const head = value.accepted
          ? `已派单 ${value.taskId} → ${value.node}（status=${value.status}）`
          : `派单未被接受 ${value.taskId} → ${value.node}：${value.error?.code ?? 'unknown'} ${value.error?.message ?? ''}`
        return [head, `workspace: ${value.workspace ?? '(节点默认)'}`, `runner: ${value.runner ?? '(未知)'}`, value.hint ?? '']
          .filter((l) => l !== '')
          .join('\n')
      }),
    },
    async execute(args, exec) {
      const nodeId = resolveNodeId(registry, args?.node)
      const taskId = newTaskId()
      const v = validateTaskStart({
        taskId,
        goal: String(args?.goal ?? ''),
        workspace: args?.workspace,
        mode: args?.mode === TASK_MODE.EXEC ? TASK_MODE.EXEC : TASK_MODE.AGENT,
        outputs: args?.outputs,
        // artifactRules 从工具参数透传到任务规格（F3-1 修复：此前该字段
        // 只有消费者没有生产者，用户无法覆盖内置的产物角色判定）
        artifactRules: args?.artifactRules,
        constraints: {
          timeoutMs: num(args?.timeoutMs) ?? defaultTimeoutMs,
          denyPaths: Array.isArray(args?.denyPaths) ? args.denyPaths : [],
        },
        origin: 'hub',
      })
      if (!v.ok) throw new RemoteAgentError(`invalid task: ${v.error}`, ERROR_CODE.INTERNAL)

      const task = registry.createTask({ nodeId, spec: v.spec })
      const accepted = await registry.awaitAccepted(taskId, { signal: exec?.signal })
      const rec = registry.getNode(nodeId)
      return {
        taskId,
        node: nodeId,
        accepted: accepted.accepted === true,
        workspace: accepted.workspace ?? rec?.hello?.roots?.[0] ?? null,
        runner: accepted.runner ?? null,
        status: accepted.status,
        duplicate: accepted.duplicate === true,
        error: accepted.error ?? undefined,
        hint:
          accepted.accepted === true
            ? '用 remote_status 跟进进度；结束后用 remote_handoff 取交接卡。'
            : '副机未接受这条任务，检查 workspace 是否在节点允许的 roots 内。',
      }
    },
  })

  // ── remote_status ──────────────────────────────────────────────
  reg({
    name: 'remote_status',
    description: '查询一条远程任务的当前视图：状态、进度尾巴、日志尾巴、退出码、工作区变更、摘要。任务状态的真身在副机，这里读的是 hub 侧投影（断连不会丢，重连后由副机 task/sync 重建）。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          nodeId: { type: 'string' },
          nodeOnline: { type: 'boolean' },
          status: { type: 'string' },
          mode: { type: ['string', 'null'] },
          goal: { type: ['string', 'null'] },
          workspace: { type: ['string', 'null'] },
          accepted: { type: 'boolean' },
          createdAt: { type: 'number' },
          updatedAt: { type: 'number' },
          startedAt: { type: ['number', 'null'] },
          endedAt: { type: ['number', 'null'] },
          durationMs: { type: ['number', 'null'] },
          exit: { type: ['object', 'null'] },
          changed: { type: 'array', items: { type: 'object' } },
          summary: { type: ['object', 'null'] },
          error: { type: ['object', 'null'] },
          manifestCounts: { type: ['object', 'null'] },
          progressTail: { type: 'array', items: { type: 'object' } },
          logTail: { type: 'array', items: { type: 'string' } },
          handoffAvailable: { type: 'boolean' },
        },
        required: ['taskId', 'status'],
      },
      render: renderText((_args, value) => {
        const lines = [
          `任务 ${value.taskId} @ ${value.nodeId} [${value.status}]${value.nodeOnline ? '' : ' (节点离线)'}`,
          `mode=${value.mode ?? '?'} accepted=${value.accepted} 耗时=${value.durationMs ?? '?'}ms`,
          `goal: ${String(value.goal ?? '').slice(0, 400)}`,
        ]
        if (value.error) lines.push(`error: ${value.error.code}: ${value.error.message}`)
        if (value.exit) lines.push(`exit: code=${value.exit.code} timedOut=${value.exit.timedOut}`)
        const progress = arr(value.progressTail)
        if (progress.length) {
          lines.push('', '进度尾巴：')
          for (const p of progress.slice(-10)) lines.push(`- ${p.phase}${p.detail ? `: ${String(p.detail).slice(0, 200)}` : ''}`)
        }
        const logs = arr(value.logTail)
        if (logs.length) {
          lines.push('', '日志尾巴：')
          for (const l of logs.slice(-15)) lines.push(`> ${String(l).slice(0, 300)}`)
        }
        if (value.handoffAvailable) lines.push('', '交接卡已就绪：用 remote_handoff 取完整卡片。')
        return lines.join('\n')
      }),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      return registry.taskView(t)
    },
  })

  // ── remote_handoff ─────────────────────────────────────────────
  reg({
    name: 'remote_handoff',
    description: '取一条远程任务的完整交接卡：状态、退出码、摘要文本、工作区变更、产物清单、日志尾巴、拉取提示。这张卡的设计目标是让主电脑在不看副机任何原始日志的情况下做决策。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          available: { type: 'boolean' },
          status: { type: 'string' },
          handoff: { type: ['object', 'null'] },
          note: { type: 'string' },
        },
        required: ['taskId', 'available'],
      },
      render: renderText((_args, value) => (value?.handoff ? handoffSummaryText({ taskId: value.taskId, handoff: value.handoff }) : value?.note ?? '')),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      if (!t.handoff) {
        return {
          taskId: t.taskId,
          available: false,
          status: t.status,
          handoff: null,
          note: TERMINAL_STATUS.has(t.status)
            ? '任务已结束但副机尚未上报交接卡（可能在上报途中）。稍后用 remote_status 复查。'
            : `任务还在 ${t.status}，交接卡要等任务结束后才有。用 remote_status 跟进。`,
        }
      }
      return { taskId: t.taskId, available: true, status: t.status, handoff: t.handoff, note: '' }
    },
  })

  // ── remote_manifest ────────────────────────────────────────────
  reg({
    name: 'remote_manifest',
    description: '取一条远程任务的产物清单（不含文件字节）。清单先于字节：只有 role:final 的条目可以 pull；intermediate（日志、缓存、中间构建文件）只在副机留存，这里只给计数。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: ['string', 'null'] },
          status: { type: 'string' },
          counts: { type: ['object', 'null'] },
          bytesFinal: { type: 'number' },
          final: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                bytes: { type: 'number' },
                sha256: { type: ['string', 'null'] },
              },
              required: ['path'],
            },
          },
          intermediateCount: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['final'],
      },
      render: renderText((_args, value) => {
        const finalList = arr(value.final)
        const lines = [`产物清单 ${value.taskId} [${value.status}] final=${finalList.length} intermediate=${value.intermediateCount} 共 ${human(value.bytesFinal)}`]
        for (const f of finalList.slice(0, 60)) {
          lines.push(`- ${f.path} — ${f.kind}, ${human(f.bytes)}, sha256=${String(f.sha256 ?? 'n/a').slice(0, 12)}`)
        }
        lines.push('', value.note ?? '')
        return lines.join('\n')
      }),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      return buildManifestView(t)
    },
  })

  // ── remote_pull ────────────────────────────────────────────────
  reg({
    name: 'remote_pull',
    description:
      '把副机上的成品拉到本机。只有清单里 role:final 的文件可以拉；传输按块进行，落地前校验 sha256，不一致就丢弃并报 hash-mismatch。dest 是本机目标目录，文件名取产物路径的最后一段。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'remote_task 返回的 taskId。' },
        paths: { type: 'array', items: { type: 'string' }, description: '清单内的相对路径（可多个）。' },
        dest: { type: 'string', description: '本机目标目录（绝对路径）。省略则落到系统临时目录下的 dsh-remote-agent/<taskId>。' },
      },
      required: ['taskId', 'paths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          dest: { type: 'string' },
          pulled: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                bytes: { type: 'number' },
                sha256: { type: ['string', 'null'] },
                dest: { type: 'string' },
              },
              required: ['path', 'dest'],
            },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, reason: { type: 'string' } },
              required: ['path', 'reason'],
            },
          },
        },
        required: ['pulled', 'skipped'],
      },
      render: renderText((_args, value) => {
        const pulled = arr(value.pulled)
        const skipped = arr(value.skipped)
        const lines = [`拉取完成：成功 ${pulled.length}，跳过 ${skipped.length}（目标目录 ${value.dest}）`]
        for (const p of pulled) lines.push(`- OK ${p.path} → ${p.dest} (${human(p.bytes)})`)
        for (const s of skipped) lines.push(`- SKIP ${s.path}: ${s.reason}`)
        return lines.join('\n')
      }),
    },
    async execute(args, exec) {
      const t = requireTask(registry, args?.taskId)
      const paths = Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === 'string' && p !== '') : []
      if (paths.length === 0) throw new RemoteAgentError('paths must contain at least one entry', ERROR_CODE.INTERNAL)
      const destDir = typeof args?.dest === 'string' && args.dest !== ''
        ? path.resolve(args.dest)
        : path.join(os.tmpdir(), 'dsh-remote-agent', t.taskId)

      const pulled = []
      const skipped = []
      for (const relPath of paths) {
        try {
          const out = await pulls.pull({
            nodeId: t.nodeId,
            taskId: t.taskId,
            relPath,
            dest: destDir,
            manifest: t.manifest,
            signal: exec?.signal,
          })
          pulled.push({ path: out.path, bytes: out.bytes, sha256: out.sha256, dest: out.dest })
        } catch (err) {
          skipped.push({ path: relPath, reason: `${err?.code ?? 'error'}: ${String(err?.message ?? err)}` })
        }
      }
      return { taskId: t.taskId, dest: destDir, pulled, skipped }
    },
  })

  // ── remote_cancel ──────────────────────────────────────────────
  reg({
    name: 'remote_cancel',
    description: '请求副机中断一条正在跑的任务。请求是尽力而为的：副机会打断 agent 或杀掉进程树，并把状态落成 aborted。已在途的产物拉取会一并取消并清理临时文件。',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'remote_task 返回的 taskId。' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          requested: { type: 'boolean' },
          status: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['taskId', 'requested'],
      },
      render: renderText((_args, value) => `${value.requested ? '已发送取消请求' : '取消请求未能送达'} ${value.taskId}（当前 status=${value.status}）${value.note ? `\n${value.note}` : ''}`),
    },
    async execute(args) {
      const t = requireTask(registry, args?.taskId)
      pulls.cancelTask(t.taskId)
      const requested = registry.cancelTask(t.taskId)
      return {
        taskId: t.taskId,
        requested,
        status: t.status,
        note: requested
          ? '副机侧任务会在下一个检查点停下；用 remote_status 确认最终状态。'
          : '节点当前不可达或任务已结束，取消请求没有送出。',
      }
    },
  })

  return disposers
}

/** 解析目标节点：显式 id/主机名，或"恰好一个在线节点"。 */
export function resolveNodeId(registry, wanted) {
  if (typeof wanted === 'string' && wanted.trim() !== '') {
    const rec = registry.pickNode(wanted)
    if (!rec) throw new RemoteAgentError(`unknown node: ${wanted}`, ERROR_CODE.TASK_UNKNOWN)
    if (!rec.online) throw new RemoteAgentError(`node offline: ${rec.nodeId}`, ERROR_CODE.INTERNAL)
    return rec.nodeId
  }
  const online = registry.onlineNodes()
  if (online.length === 0) {
    throw new RemoteAgentError('no online node: 先让副机接入（remote_nodes 可看当前状态）', ERROR_CODE.INTERNAL)
  }
  if (online.length > 1) {
    throw new RemoteAgentError(
      `multiple online nodes (${online.map((n) => n.nodeId).join(', ')}); 请显式指定 node`,
      ERROR_CODE.INTERNAL,
    )
  }
  return online[0].nodeId
}

function requireTask(registry, taskId) {
  if (typeof taskId !== 'string' || taskId === '') {
    throw new RemoteAgentError('taskId is required', ERROR_CODE.TASK_UNKNOWN)
  }
  const t = registry.getTask(taskId)
  if (!t) throw new RemoteAgentError(`unknown taskId: ${taskId}`, ERROR_CODE.TASK_UNKNOWN)
  return t
}
