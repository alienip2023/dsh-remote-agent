/**
 * 视图投影层：把**副机上报的数据**投影成"可以安全交给宿主"的形状。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 副机是一个独立的、可被攻陷的远端。它上报的 handoff / changed / exit / error /
 * manifest 全部是**不可信输入**：字段集由它决定，它可以往里面塞绝对路径
 * （回显主机目录结构）、环境变量、诊断信息、甚至凭证片段。
 *
 * 宿主有两种消费方，两边的要求一致：**只拿它真正需要的字段**。
 *   1. 工具返回值 → 进入会话日志 → 后续每个请求都带上（泄漏会被持久化）
 *   2. Web 面板   → 进入浏览器 → 可能被扩展/调试工具/截图带走
 *
 * ── 为什么集中在这一个文件 ────────────────────────────────────────
 * 曾经散在三处：`node-registry.taskView`、`tools.buildManifestView`、
 * `ui-routes.*View`。结果 `remote_handoff` 因为"没有对应的 View 函数"就
 * 裸直出了 `t.handoff` —— 加固做了一半，且是最该加固的那一半（工具路径
 * 会被写进会话日志）。集中后新增消费方无处可"绕开"投影。
 *
 * ── 一条硬规则 ───────────────────────────────────────────────────
 * 本文件的函数**只做逐字段构造**，永不 spread 输入对象。所有字符串截断，
 * 所有数字做类型检查，缺失一律给安全默认值。这样副机怎么改它的上报形状，
 * 都不可能让宿主这边出现"没预料到的字段"。
 */

/** 单个 changed 条目：只保留客户端/模型真正会读的四个字段。 */
export function changedItemView(c) {
  if (!c || typeof c !== 'object') return null
  return {
    op: typeof c.op === 'string' ? c.op : 'unknown',
    path: typeof c.path === 'string' ? c.path.slice(0, 500) : '',
    bytes: Number.isFinite(c.bytes) ? c.bytes : 0,
    deltaBytes: Number.isFinite(c.deltaBytes) ? c.deltaBytes : 0,
  }
}

/** changed 数组：投影 + 丢弃非对象元素（否则消费方解引用 c.op 会抛）。 */
export function changedView(list, { max = 50 } = {}) {
  if (!Array.isArray(list)) return []
  return list.slice(0, max).map(changedItemView).filter(Boolean)
}

/** exit 摘要：副机可能往里塞诊断字段，只留可执行的语义。 */
export function exitView(e) {
  if (!e || typeof e !== 'object') return null
  return {
    code: Number.isFinite(e.code) ? e.code : null,
    timedOut: e.timedOut === true,
    aborted: e.aborted === true,
    runner: typeof e.runner === 'string' ? e.runner : '',
    toolCalls: Number.isFinite(e.toolCalls) ? e.toolCalls : 0,
  }
}

/** error：只留稳定 code 与截断后的消息。 */
export function errorView(e) {
  if (!e || typeof e !== 'object') return null
  return {
    code: typeof e.code === 'string' ? e.code : '',
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : '',
  }
}

/** 节点：不含 hello / conn 等内部对象。 */
export function nodeView(n) {
  if (!n || typeof n !== 'object') return null
  return {
    nodeId: typeof n.nodeId === 'string' ? n.nodeId : '',
    online: n.online === true,
    os: typeof n.os === 'string' ? n.os : 'unknown',
    arch: typeof n.arch === 'string' ? n.arch : 'unknown',
    agentMode: n.agentMode === true,
    roots: Array.isArray(n.roots) ? n.roots.filter((r) => typeof r === 'string') : [],
    caps: Array.isArray(n.caps) ? n.caps.filter((c) => typeof c === 'string') : [],
    since: Number.isFinite(n.since) ? n.since : null,
    lastSeen: Number.isFinite(n.lastSeen) ? n.lastSeen : null,
    taskCount: Number.isFinite(n.taskCount) ? n.taskCount : 0,
  }
}

/** manifest 的 final 条目。 */
export function finalItemView(f) {
  if (!f || typeof f !== 'object') return null
  return {
    path: typeof f.path === 'string' ? f.path.slice(0, 500) : '',
    kind: typeof f.kind === 'string' ? f.kind : 'file',
    bytes: Number.isFinite(f.bytes) ? f.bytes : 0,
    sha256: typeof f.sha256 === 'string' ? f.sha256 : null,
  }
}

/** manifest：计数 + final 清单（不传字节）。 */
export function manifestView(m, { max = 200 } = {}) {
  if (!m || typeof m !== 'object') return null
  const counts = m.counts && typeof m.counts === 'object' ? m.counts : null
  return {
    counts: counts
      ? {
        total: Number.isFinite(counts.total) ? counts.total : 0,
        final: Number.isFinite(counts.final) ? counts.final : 0,
        intermediate: Number.isFinite(counts.intermediate) ? counts.intermediate : 0,
        other: Number.isFinite(counts.other) ? counts.other : 0,
      }
      : null,
    bytesFinal: Number.isFinite(m.bytesFinal) ? m.bytesFinal : 0,
    final: Array.isArray(m.items)
      ? m.items
        .filter((i) => i && i.role === 'final')
        .slice(0, max)
        .map(finalItemView)
        .filter(Boolean)
      : [],
  }
}

/**
 * handoff 里的 `artifacts` 段。
 *
 * ⚠ 形状与 `manifestView` **不同**，不要混用：
 *   - `manifestView` 吃的是**副机的清单对象**（`items: [{role, path, ...}]`），
 *     需要按 `role === 'final'` 筛。
 *   - handoff 里的 `artifacts.final` 是**副机已经筛好的数组**（见
 *     lib/node/task-engine.js 的 buildHandoff），只有 `{path, kind, bytes, sha256}`。
 * 我第一版把两者当成一个形状，导致 final 恒为空数组（e2e 断言 `final 应含 产物.txt` 失败）。
 */
export function artifactsView(a, { max = 200 } = {}) {
  if (!a || typeof a !== 'object') return null
  const counts = a.counts && typeof a.counts === 'object' ? a.counts : null
  return {
    counts: counts
      ? {
        total: Number.isFinite(counts.total) ? counts.total : 0,
        final: Number.isFinite(counts.final) ? counts.final : 0,
        intermediate: Number.isFinite(counts.intermediate) ? counts.intermediate : 0,
        other: Number.isFinite(counts.other) ? counts.other : 0,
      }
      : null,
    bytesFinal: Number.isFinite(a.bytesFinal) ? a.bytesFinal : 0,
    final: Array.isArray(a.final)
      ? a.final.slice(0, max).map(finalItemView).filter(Boolean)
      : [],
    intermediateCount: Number.isFinite(a.intermediateCount) ? a.intermediateCount : 0,
    note: typeof a.note === 'string' ? a.note.slice(0, 500) : '',
  }
}

/**
 * handoff 卡片：**投影最严的一处**。
 *
 * 副机的 buildHandoff() 会带上 workspace（绝对路径）、logs（可能含环境变量）、
 * 以及它版本的任何新字段。这里逐字段挑出消费方要用的部分，其余一律丢弃。
 */
export function handoffView(h) {
  if (!h || typeof h !== 'object') return null
  const summary = h.summary && typeof h.summary === 'object' ? h.summary : null
  return {
    taskId: typeof h.taskId === 'string' ? h.taskId : null,
    nodeId: typeof h.nodeId === 'string' ? h.nodeId : null,
    status: typeof h.status === 'string' ? h.status : null,
    mode: typeof h.mode === 'string' ? h.mode : null,
    runner: typeof h.runner === 'string' ? h.runner : null,
    durationMs: Number.isFinite(h.durationMs) ? h.durationMs : null,
    startedAt: Number.isFinite(h.startedAt) ? h.startedAt : null,
    endedAt: Number.isFinite(h.endedAt) ? h.endedAt : null,
    exit: exitView(h.exit),
    // **两个形状都提供**，因为两条消费路径的历史契约不同：
    //   - 工具路径（remote_handoff）的既有契约是嵌套 `summary.text`，
    //     已被测试与下游依赖（e2e 断言 `card.summary.text` 是字符串）。
    //   - UI 路径读的是扁平 `summaryText`。
    // 统一投影时若只留一个形状，就会静默破坏另一条路径 —— 这正是我第一版
    // 改动造成的回归（9 个测试失败）。两个都给，各有明确来源。
    summary: summary
      ? { text: typeof summary.text === 'string' ? summary.text.slice(0, 4000) : '' }
      : null,
    summaryText: summary && typeof summary.text === 'string' ? summary.text.slice(0, 4000) : '',
    changed: changedView(h.changed, { max: 50 }),
    // handoff 里的 artifacts 走**专用**投影（它的 final 已是筛好的数组）
    artifacts: artifactsView(h.artifacts, { max: 200 }),
    pullHint: typeof h.pullHint === 'string' ? h.pullHint.slice(0, 1000) : '',
    // 刻意**不含**：workspace（绝对路径，回显主机目录）、logs（可能带环境变量）、
    // goal（原文已在任务投影里）、sessionId（副机内部标识）
  }
}

/**
 * 任务投影：工具与 UI 共用的"一条任务长什么样"。
 *
 * @param {object} t 节点注册表里的任务对象（含 nodeId/status/changed/manifest/…）
 * @param {object} [o]
 * @param {number} [o.tail] 日志/进度尾部保留几条
 * @param {boolean} [o.includeLogs] 是否带日志尾部（UI 要，工具的轻量视图可省）
 */
export function taskView(t, { tail = 6, includeLogs = true } = {}) {
  if (!t || typeof t !== 'object') return null
  const out = {
    taskId: typeof t.taskId === 'string' ? t.taskId : '',
    nodeId: typeof t.nodeId === 'string' ? t.nodeId : '',
    nodeOnline: t.nodeOnline === true,
    status: typeof t.status === 'string' ? t.status : 'unknown',
    mode: typeof t.mode === 'string' ? t.mode : '',
    goal: typeof t.goal === 'string' ? t.goal.slice(0, 500) : '',
    createdAt: Number.isFinite(t.createdAt) ? t.createdAt : null,
    updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : null,
    startedAt: Number.isFinite(t.startedAt) ? t.startedAt : null,
    endedAt: Number.isFinite(t.endedAt) ? t.endedAt : null,
    durationMs: Number.isFinite(t.durationMs) ? t.durationMs : null,
    exit: exitView(t.exit),
    error: errorView(t.error),
    summaryText: t.summary && typeof t.summary.text === 'string' ? t.summary.text.slice(0, 2000) : '',
    changedCount: Array.isArray(t.changed) ? t.changed.length : 0,
    changed: changedView(t.changed, { max: 50 }),
    manifestCounts: manifestView(t.manifest)?.counts ?? null,
    // workspace 刻意不回传：绝对路径会回显主机目录结构，而两个消费方都不读它。
  }
  if (includeLogs) {
    out.progressTail = Array.isArray(t.progressTail) ? t.progressTail.slice(-tail) : []
    out.logTail = Array.isArray(t.logTail)
      ? t.logTail.slice(-tail).map((l) => (typeof l === 'string' ? l.slice(0, 2000) : String(l).slice(0, 2000)))
      : []
  }
  return out
}
