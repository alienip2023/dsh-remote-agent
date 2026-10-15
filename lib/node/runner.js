/**
 * 副机侧的 agent 会话桥：把一条远程任务变成副机本地的一次真实 DSH agent 运行。
 *
 * 为什么不是"在副机跑一条 shell 命令"：
 *   用户锁定的形态是 **B** —— 副机拥有独立 Agent 循环、独立模型上下文，
 *   任务在副机本地持久运行，断连不终止。所以任务执行者必须是副机自己的 dsh。
 *
 * 两种后端，按可用性自动选择，对上层暴露同一个 run()：
 *
 *   1. **in-process**（首选）：worker 插件运行在副机 dsh 进程里，直接调
 *      `ctx.agentLoop.createAgent()` 起一个独立会话，把任务书 `followup()` 进它的
 *      inbox，`whenIdle()` 等它停稳，再从会话事件里取最终回答。
 *      好处：没有第二个 dsh 进程、共享副机的模型配置与凭证（凭证本就在副机本地，不外传）。
 *
 *   2. **headless**（回退）：worker 以独立进程运行（没有 dsh 上下文）时，spawn
 *      `dsh --profile <p> headless --json "<task>"`，解析 NDJSON 事件流取最终回答。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { PLATFORM, detectPlatform } from './exec.js'

/**
 * 本插件向副机 agent 投递任务书时的**消息来源身份**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ 这个常量曾经写错，导致 agent 模式"假完成"（2026-10-15 定位）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 旧值：`{ kind: 'plugin', plugin: 'dsh-remote-agent' }`
 *
 * DSH 的 `MessageSourceMap` 是一张**封闭的联合类型表**，合法 kind 有 17 种：
 *
 *   user · model · tool · system-prompt · model-selection · user-approval ·
 *   ptc-mode · tool-registry · user-rpc · agent-message · subagent-settled ·
 *   skill-invocation · cordis-host-runner · goal · schedule ·
 *   compact-checkpoint · session-reference · user-question-reply
 *
 * **里面没有 `plugin`。** 传一个不认识的 kind 时，`followup` 表面上成功
 * （消息进 inbox、驱动被唤醒），但 turn 一启动就抛错 —— 而 DSH 的 `kick()`
 * 里是 `catch (_error) {}`，**错误被静默吞掉**。结果：
 *
 *   `whenIdle()` 在 ~20ms 内返回，`liveText` 为空，任务被标成 completed，
 *   产物为 0 —— 而**没有任何错误信息**（连日志都没有）。
 *
 * `cordis-host-runner` 正是为"cordis 宿主里的 runner 主动驱动一个 agent"
 * 这个场景准备的 kind，语义与我们完全对应。
 *
 * ── 教训 ────────────────────────────────────────────────────────────────
 * 往 DSH 的封闭联合类型里塞自造值**不会立刻报错**，而是在某个被
 * `catch {}` 包住的深层位置静默失效。改这类常量前先查 `MessageSourceMap`
 * 的完整声明（用 cordis_inspect 的 `listService` 查 `sessions`）。
 */
const PLUGIN_SOURCE = Object.freeze({ kind: 'cordis-host-runner' })

/**
 * 从 dsh headless 的 NDJSON 事件流里提取最终回答。
 * 只认能确定识别的形状，认不出就保留原始尾部，绝不编造。
 */
export function extractFinalFromNdjson(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  let final = ''
  const toolCalls = []
  for (const line of lines) {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!ev || typeof ev !== 'object') continue
    const t = String(ev.type ?? ev.kind ?? '')
    if (t === 'assistant/message' || t === 'assistant.message' || t === 'message') {
      const blocks = ev.message?.content ?? ev.content ?? ev.blocks
      if (Array.isArray(blocks)) {
        const txt = blocks.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('')
        if (txt) final = txt
      } else if (typeof ev.text === 'string') {
        final = ev.text
      }
    } else if (t === 'tool/call' || t === 'tool.call') {
      toolCalls.push({ name: ev.name ?? ev.toolName ?? 'unknown', at: Date.now() })
    } else if (typeof ev.final === 'string') {
      final = ev.final
    }
  }
  return { final, toolCalls, eventCount: lines.length }
}

/** 在副机 PATH 上找 dsh 可执行文件。 */
export function resolveDshBin(explicit) {
  const candidates = [explicit, process.env.DSH_BIN, process.env.DSH_REMOTE_DSH_BIN].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

/** 从事件流里找 sessionId（记录在任务里，方便人在副机本地回溯这次会话）。 */
export function extractSessionId(text) {
  const m = text.match(/"sessionId"\s*:\s*"([^"]+)"/)
  return m ? m[1] : null
}

/** 从 agent 会话里抽取助手文本与工具调用名。 */
function readSessionOutcome(session) {
  const textParts = []
  const toolCalls = []
  if (!session || typeof session.ownEvents !== 'function') return { textParts, toolCalls }
  let events = []
  try {
    events = session.ownEvents()
  } catch {
    return { textParts, toolCalls }
  }
  for (const ev of events) {
    if (ev.type === 'assistant/message') {
      const blocks = ev.data?.message?.content ?? []
      const txt = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
      if (txt) textParts.push(txt)
    } else if (ev.type === 'tool/call') {
      toolCalls.push({ name: ev.data?.name ?? 'unknown', at: ev.time ?? Date.now() })
    }
  }
  return { textParts, toolCalls }
}

/**
 * headless 后端：spawn 一个副机本地 dsh 进程跑任务。
 */
export class HeadlessRunner {
  constructor({ dshBin, profile, platform = detectPlatform(), extraArgs = [] } = {}) {
    this.dshBin = resolveDshBin(dshBin)
    this.profile = profile
    this.platform = platform
    this.extraArgs = extraArgs
    this.children = new Set()
  }

  get kind() {
    return 'headless'
  }

  /**
   * @param {object} o
   * @param {string} o.goal 任务书
   * @param {string} o.cwd 工作区（副机绝对路径）
   * @param {number} o.timeoutMs
   * @param {AbortSignal} [o.signal]
   * @param {(chunk:string, stream:string)=>void} [o.onData]
   */
  run(o) {
    const { goal, cwd, timeoutMs, signal, onData } = o

    const args = []
    if (this.profile) args.push('--profile', this.profile)
    args.push('headless', '--json', ...this.extraArgs, goal)

    const startedAt = Date.now()
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(this.dshBin, args, {
          cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
          env: { ...process.env },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: this.platform === PLATFORM.WINDOWS,
        })
      } catch (err) {
        resolve({
          ok: false,
          exitCode: null,
          final: '',
          stderr: String(err?.message ?? err),
          toolCalls: [],
          durationMs: 0,
          sessionId: null,
          spawnError: true,
        })
        return
      }

      this.children.add(child)
      const outChunks = []
      const errChunks = []
      let settled = false
      let timedOut = false

      const killTree = () => {
        try {
          if (this.platform === PLATFORM.WINDOWS) {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          } else {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              child.kill('SIGKILL')
            }
          }
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            /* 已退出 */
          }
        }
      }

      const timer = timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true
          killTree()
        }, timeoutMs)
        : undefined
      if (timer?.unref) timer.unref()

      const onAbort = () => killTree()
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      child.stdout?.on('data', (b) => {
        const s = b.toString('utf8')
        outChunks.push(s)
        if (typeof onData === 'function') onData(s, 'stdout')
      })
      child.stderr?.on('data', (b) => {
        const s = b.toString('utf8')
        errChunks.push(s)
        if (typeof onData === 'function') onData(s, 'stderr')
      })

      const finish = (code) => {
        if (settled) return
        settled = true
        this.children.delete(child)
        if (timer) clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        const stdout = outChunks.join('')
        const parsed = extractFinalFromNdjson(stdout)
        resolve({
          ok: code === 0 && !timedOut,
          exitCode: code,
          timedOut,
          final: parsed.final,
          rawTail: stdout.slice(-4000),
          stderr: errChunks.join('').slice(-8000),
          toolCalls: parsed.toolCalls,
          eventCount: parsed.eventCount,
          durationMs: Date.now() - startedAt,
          sessionId: extractSessionId(stdout),
        })
      }

      child.on('error', (err) => {
        errChunks.push(String(err?.message ?? err))
        finish(null)
      })
      child.on('close', (code) => finish(code))
    })
  }

  killAll() {
    for (const c of this.children) {
      try {
        c.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    this.children.clear()
  }
}

/**
 * in-process 后端：在副机 dsh 进程里起一个真实 agent 会话。
 *
 * 用 ctx.agentLoop.createAgent() 创建带独立 id 的会话，把任务书 followup 进 inbox，
 * 用 whenIdle() 等它停稳。这比 headless 少一个进程，且直接复用副机的
 * 模型配置 / 凭证 / 插件 —— 凭证一步都没有离开副机。
 */
export class InProcessRunner {
  /**
   * @param {object} o
   * @param {import('@deepseek-ai/cordis').Context} o.ctx 副机 dsh 的根上下文
   * @param {string} o.nodeId
   * @param {string} [o.preset] 指定 agent preset（可选）
   */
  constructor({ ctx, nodeId, preset }) {
    this.ctx = ctx
    this.nodeId = nodeId
    this.preset = preset
    this.active = new Map() // taskId → { handle, controller }
  }

  get kind() {
    return 'in-process'
  }

  /**
   * 这两个服务是否可用。
   *
   * 必须用 `ctx.get(name)` 而不是 `ctx.agentLoop` —— 在 cordis 里访问一个
   * **未在 inject 中声明**的服务属性会**抛错**（`cannot get property "agentLoop"
   * without inject`），而不是返回 undefined。所以可选链 `ctx?.agentLoop` 挡不住它，
   * 反而让"探测可用性"这一步自己炸掉：实测在 headless profile（无 agentLoop）里
   * 启动 worker 会得到 `worker disabled after startup error cannot get property
   * "agentLoop" without inject` —— 一个本该优雅降级的地方变成了启动失败。
   */
  get available() {
    const ctx = this.ctx
    if (!ctx || typeof ctx.get !== 'function') return false
    try {
      return Boolean(ctx.get('agentLoop') && ctx.get('sessions'))
    } catch {
      // get() 本身在某些组合下也可能抛；探测失败一律当作"不可用"，交给 headless 后端
      return false
    }
  }

  /**
   * @param {object} o
   * @param {string} o.taskId
   * @param {string} o.goal
   * @param {string} o.cwd
   * @param {number} o.timeoutMs
   * @param {AbortSignal} [o.signal]
   * @param {(evt:object)=>void} [o.onEvent] 会话事件回调（用于进度）
   */
  async run(o) {
    const { taskId, goal, cwd, timeoutMs, signal, onEvent } = o
    const startedAt = Date.now()

    if (!this.available) {
      return {
        ok: false,
        exitCode: null,
        final: '',
        stderr: 'agentLoop/sessions service unavailable in this dsh composition',
        toolCalls: [],
        durationMs: 0,
        sessionId: null,
        unavailable: true,
      }
    }

    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onOuterAbort, { once: true })
    }

    let timer
    let timedOut = false
    const timeoutPromise = new Promise((resolve) => {
      if (!(timeoutMs > 0)) return
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        resolve({ timedOut: true })
      }, timeoutMs)
      if (timer.unref) timer.unref()
    })

    const sessionIdFor = `session-remote-${String(taskId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 48)}`
    let handle
    let disposeListener
    let disposeAgentErrorListener
    const liveText = []
    // 诊断（临时）：定位"agent 任务 22ms 就 completed"的问题。
    // 写文件而不是 log —— 副机的启动日志不含插件级详情（主机侧已踩过同样的坑）。
    const dlog = (msg, extra) => {
      try {
        const f = `${process.env.TEMP || process.env.TMP || '/tmp'}/dsh-remote-agent-runner.log`
        fs.appendFileSync(f, `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`, 'utf8')
      } catch {
        /* 诊断不影响主流程 */
      }
    }
    dlog('InProcessRunner.run ENTER', {
      taskId,
      goalLen: String(goal ?? '').length,
      cwd,
      timeoutMs,
      available: this.available,
      hasAgentLoop: Boolean(this.ctx?.get?.('agentLoop')),
      hasSessions: Boolean(this.ctx?.get?.('sessions')),
    })

    try {
      // 用 ctx.get() 取服务，不用属性访问 —— 见 available getter 的说明
      const agentLoop = this.ctx.get('agentLoop')
      const sessions = this.ctx.get('sessions')
      dlog('before createAgent', { sessionIdFor, cwd })
      handle = await agentLoop.createAgent(this.ctx, {
        sessionId: sessionIdFor,
        meta: { cwd },
        signal: controller.signal,
        agentOptions: undefined,
      })
      const agent = handle.agent
      const session = agent.session ?? sessions.get(agent.id)
      dlog('after createAgent', {
        agentId: agent?.id ?? null,
        hasSession: Boolean(session),
        sessionStatus: session?.status ?? null,
        handleKeys: (() => { try { return Object.keys(handle ?? {}).slice(0, 10) } catch { return null } })(),
      })

      this.active.set(taskId, { handle, controller })

      // 观察事件：给 hub 送进度，并在会话日志之外保留一份实时文本（防日志投影差异）
      if (typeof this.ctx.on === 'function') {
        disposeListener = this.ctx.on('session/event', (s, event) => {
          if (!s || s.id !== agent.id) return
          if (event.type === 'assistant/message') {
            const blocks = event.data?.message?.content ?? []
            const txt = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
            if (txt) {
              liveText.push(txt)
              if (typeof onEvent === 'function') onEvent({ kind: 'assistant', text: txt.slice(0, 2000) })
            }
          } else if (event.type === 'tool/call') {
            if (typeof onEvent === 'function') onEvent({ kind: 'tool', name: event.data?.name ?? 'unknown' })
          }
        })
      }
      // ⚠ 必须单独监听 `agent/error` —— 否则 turn 内部的错误**完全不可见**。
      //
      // DSH 的 `kick()` 里是 `try { while (await this.turn()) } catch (_error) {}`：
      // 任何 turn 错误都被吞掉，只通过 `agent/error` 事件暴露（见 Agent 的
      // `throwError()`）。我们曾因为漏了这条监听，把一个"消息 source 类型非法"
      // 的错误查了很久 —— 表现只是"任务 20ms 完成、无输出、无报错"。
      //
      // 这里把错误记进诊断日志，并塞进 liveText，让它在 handoff 摘要里也可见。
      //
      // ⚠ 错误对象的形状不受我们控制：第一版只取 `err?.message`，结果记到的是
      // `[object Object]`（DSH 发的 payload 是嵌套对象，没有顶层 message）。
      // 所以这里做**深度序列化**：先试常见字段，再退到 JSON.stringify，
      // 最后兜底到 String()。任何一步都不能抛。
      const describeError = (e) => {
        if (e === null || e === undefined) return String(e)
        if (typeof e === 'string') return e
        if (typeof e !== 'object') return String(e)
        // 常见字段优先（FiberError / CordisError / LlmFailure 之类）
        for (const k of ['message', 'reason', 'error', 'failure', 'code', 'name']) {
          const v = e[k]
          if (typeof v === 'string' && v !== '') {
            return k === 'message' ? v : `${k}=${v}`
          }
        }
        // 深度：把可枚举字段拼出来（含嵌套一层）
        try {
          const flat = {}
          for (const k of Object.keys(e)) {
            const v = e[k]
            if (v === undefined) continue
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v
            else if (v === null) flat[k] = null
            else if (typeof v === 'object') {
              // 嵌套对象再取一层常见字段，避免无限深
              const inner = {}
              for (const k2 of ['message', 'code', 'name', 'kind', 'status', 'failure']) {
                const v2 = v[k2]
                if (typeof v2 === 'string' || typeof v2 === 'number' || typeof v2 === 'boolean') inner[k2] = v2
              }
              flat[k] = Object.keys(inner).length > 0 ? inner : String(v)
            } else flat[k] = String(v)
          }
          const s = JSON.stringify(flat)
          if (s && s !== '{}') return s
        } catch {
          /* 循环引用等 */
        }
        try {
          return JSON.stringify(e)
        } catch {
          return String(e)
        }
      }

      if (typeof this.ctx.on === 'function') {
        disposeAgentErrorListener = this.ctx.on('agent/error', (err, agentInfo) => {
          try {
            const a = agentInfo?.agent ?? agentInfo
            if (a && a.id !== undefined && agent.id !== undefined && a.id !== agent.id) return
            const msg = describeError(err)
            dlog('agent/error', { msg: msg.slice(0, 1200), rawKeys: (() => { try { return Object.keys(err ?? {}) } catch { return null } })() })
            liveText.push(`[agent 错误] ${msg}`)
            if (typeof onEvent === 'function') onEvent({ kind: 'error', text: msg.slice(0, 2000) })
          } catch {
            /* 诊断不影响主流程 */
          }
        })
      }

      // 投递任务书：followup 排队下一轮并唤醒驱动器。
      // 必须带 plugin source —— 省略 source 会被当成人类输入，这是不能继承的权限。
      dlog('before followup', { hasFollowup: typeof agent.followup === 'function' })
      agent.followup({
        content: [{ type: 'text', text: goal }],
        source: PLUGIN_SOURCE,
      })
      dlog('after followup, before whenIdle', { hasWhenIdle: typeof agent.whenIdle === 'function' })

      const raced = await Promise.race([
        agent.whenIdle().then(() => ({ timedOut: false })),
        timeoutPromise,
      ])
      if (raced.timedOut === true) timedOut = true
      dlog('whenIdle resolved', { timedOut, liveTextLen: liveText.join('').length, elapsedMs: Date.now() - startedAt })

      // 会话日志优先；日志取不到就用实时累积
      const fromLog = readSessionOutcome(session)
      const finalText = fromLog.textParts.length > 0 ? fromLog.textParts.join('\n\n').trim() : liveText.join('\n\n').trim()
      dlog('outcome read', {
        fromLogParts: fromLog.textParts.length,
        fromLogToolCalls: fromLog.toolCalls.length,
        finalLen: finalText.length,
        finalHead: finalText.slice(0, 200),
      })

      return {
        ok: !timedOut,
        exitCode: timedOut ? null : 0,
        timedOut,
        final: finalText,
        stderr: '',
        toolCalls: fromLog.toolCalls,
        durationMs: Date.now() - startedAt,
        sessionId: agent.id,
      }
    } catch (err) {
      return {
        ok: false,
        exitCode: null,
        final: liveText.join('\n\n').trim(),
        stderr: String(err?.message ?? err),
        toolCalls: [],
        durationMs: Date.now() - startedAt,
        sessionId: handle?.agent?.id ?? sessionIdFor,
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
      this.active.delete(taskId)
      try {
        disposeListener?.()
      } catch {
        /* 上下文已卸载 */
      }
      try {
        disposeAgentErrorListener?.()
      } catch {
        /* 同上 */
      }
      try {
        await handle?.dispose()
      } catch {
        /* agent 可能已自行结束 */
      }
    }
  }

  /** 中断一个在跑的任务（hub 发 task/cancel 时调用）。 */
  async cancel(taskId) {
    const rec = this.active.get(taskId)
    if (!rec) return false
    try {
      rec.handle.agent.cancel({ kind: 'user' })
    } catch {
      /* agent 可能已停 */
    }
    try {
      rec.controller.abort()
    } catch {
      /* 已中止 */
    }
    return true
  }

  /** 插件卸载：中断全部在跑任务（任务记录留在磁盘上，重启后可查）。 */
  async disposeAll() {
    for (const [taskId] of this.active) {
      await this.cancel(taskId)
    }
    this.active.clear()
  }
}

/**
 * 按可用性挑一个后端。
 * in-process 优先 —— 少一个进程，且模型凭证不用经过任何额外路径。
 */
export function selectRunner({ ctx, nodeId, profile, dshBin, preferHeadless = false }) {
  const inProc = new InProcessRunner({ ctx, nodeId })
  if (!preferHeadless && inProc.available) return inProc
  return new HeadlessRunner({ dshBin, profile })
}
