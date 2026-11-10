/**
 * fork.61：节点连接生命周期 → stderr（单行）。
 *
 * 为什么：ra 的日志只进 cordis 的内存 buffer，节点 systemd journal 里零线索
 * （中继掉线、重试、致命停止都看不到）。这里把 online / offline / reconnecting /
 * fatal 四类事件额外写一行到 stderr，journalctl 直接可读。
 *
 * 只输出：节点 id（清洗后）、事件名、数字、白名单里的短码。绝不输出 token、
 * URL（含查询串）、密钥、中继回的消息正文、错误详情。不改变 ctx.logger 行为。
 */

const FATAL_CODES = new Set(['duplicate-node', 'node-id-invalid', 'unauthorized', 'revoked'])
const RECONNECT_REASONS = new Set(['duplicate-node'])

function cleanId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  return s === '' ? '-' : s
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

/** 渲染一行；字段只取白名单。导出供测试直接断言。 */
export function renderLifecycleLine(nodeId, event, info) {
  const parts = ['[dsh-remote-agent]', `node=${cleanId(nodeId)}`, `event=${event}`]
  const i = info && typeof info === 'object' ? info : {}
  if (event === 'offline') {
    const m = /^closed (\d{3,4})\b/.exec(typeof i.reason === 'string' ? i.reason : '')
    if (m) parts.push(`closeCode=${m[1]}`)
  } else if (event === 'reconnecting') {
    const a = num(i.attempt)
    const d = num(i.delayMs)
    if (a !== null) parts.push(`attempt=${a}`)
    if (d !== null) parts.push(`delayMs=${d}`)
    if (typeof i.reason === 'string' && RECONNECT_REASONS.has(i.reason)) parts.push(`reason=${i.reason}`)
  } else if (event === 'fatal') {
    if (typeof i.code === 'string' && FATAL_CODES.has(i.code)) parts.push(`code=${i.code}`)
    const a = num(i.attempts)
    if (a !== null) parts.push(`attempts=${a}`)
  }
  return parts.join(' ')
}

function defaultWrite(line) {
  process.stderr.write(`${line}\n`)
}

/**
 * 把四类事件挂到 transport 上。返回解除函数。写失败一律吞掉
 * （没有 stderr 也不能影响连接）。
 */
export function attachLifecycleConsole(transport, nodeId, write = defaultWrite) {
  const emit = (event, info) => {
    try {
      write(renderLifecycleLine(nodeId, event, info))
    } catch {
      /* stderr 不可写：忽略 */
    }
  }
  const handlers = {
    online: () => emit('online'),
    offline: (reason) => emit('offline', { reason }),
    reconnecting: (info) => emit('reconnecting', info),
    fatal: (info) => emit('fatal', info),
  }
  for (const [evt, fn] of Object.entries(handlers)) transport.on(evt, fn)
  return () => {
    for (const [evt, fn] of Object.entries(handlers)) transport.off?.(evt, fn)
  }
}
