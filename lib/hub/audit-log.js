/**
 * hub 审计日志（提案 #19）。
 *
 * 回答一个问题：**这台 hub 替谁在别的电脑上跑过什么**。JSONL 追加写，
 * 每行一条事件：`task.dispatch`（谁派了什么）/ `task.cancel` / `pull.start` /
 * `pull.end`。写入点在 NodeRegistry / PullManager 的关键方法里（单一咽喉），
 * 不在 tools.js / ui-routes.js —— 这样无论调用方是工具、面板还是 subagent
 * provider，审计都不漏。
 *
 * 设计约束（按优先级）：
 *   1. **审计绝不影响任务链路** —— record() 同步段只做字符串拼接，磁盘写入
 *      异步 fire-and-forget；写失败只限频告警，绝不向上抛。
 *   2. **不含凭证** —— 所有字段过 sanitizeExtra（REDACT_KEY_RE 打码 +
 *      400 字符截断），token/密码类键值永远不落盘。
 *   3. **体积有上限** —— 按 maxBytes 轮转（audit.jsonl → .1 → .2），最多
 *      maxFiles 份，超出的最旧一份直接删。默认 8MB × 3 ≈ 24MB 封顶。
 *   4. **默认开启** —— 这是安全特性，写的是本地 stateDir、无凭证、有轮转；
 *      `audit: false` 或 `audit.enabled: false` 显式关闭。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeExtra } from './hub-util.js'

/** 审计文件名（固定落在 hub stateDir 下）。 */
export const AUDIT_FILE_NAME = 'audit.jsonl'

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FILES = 3
/** 连续写失败后告警的最小间隔（毫秒）—— 审计挂了不该刷爆主日志。 */
const WARN_INTERVAL_MS = 30_000

/**
 * 创建审计写入器。
 *
 * @param {object} o
 * @param {string} o.dir 落盘目录（hub stateDir）
 * @param {boolean} [o.enabled=true]
 * @param {number} [o.maxBytes] 单文件上限，超过即轮转
 * @param {number} [o.maxFiles] 轮转保留份数（含当前文件）
 * @param {(level:string,msg:string,extra?:object)=>void} [o.log] hub 日志（限频告警用）
 * @returns {{ record: (event:string, fields?:object)=>void, dispose: ()=>Promise<void>, path: string }}
 */
export function createAuditLog({
  dir,
  enabled = true,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  log = () => {},
} = {}) {
  const file = path.join(dir, AUDIT_FILE_NAME)
  const cap = {
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
    maxFiles: Number.isInteger(maxFiles) && maxFiles >= 1 ? maxFiles : DEFAULT_MAX_FILES,
  }

  if (!enabled) {
    // 关闭时也返回同形对象：调用方（registry / pull-manager）不需要判空。
    return { record: () => {}, dispose: async () => {}, path: file }
  }

  // 目录不存在的时机：stateDir 由身份/工具层创建，但审计可能先于它们写第一行。
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    log('warn', 'audit dir creation failed; audit disabled', { dir, error: String(err?.message ?? err) })
    return { record: () => {}, dispose: async () => {}, path: file }
  }

  /** 当前文件已写字节数（轮转判断用）。启动时对齐磁盘现状。 */
  let bytes = 0
  try {
    bytes = fs.statSync(file).size
  } catch {
    /* 首次启动无文件 */
  }

  let lastWarnAt = 0
  /** 串行链：append 与 rotation 全部过同一条 promise 链，杜绝并发交错。 */
  let chain = Promise.resolve()

  const rotate = () => {
    // maxFiles=1 表示不保留历史：当前文件直接清空重写。
    if (cap.maxFiles <= 1) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* 下次 append 自会重建 */
      }
      return
    }
    // audit.jsonl.{maxFiles-1} 最旧，直接删；其余依次后移，当前文件改名 .1。
    try {
      const oldest = `${file}.${cap.maxFiles - 1}`
      fs.rmSync(oldest, { force: true })
      for (let i = cap.maxFiles - 2; i >= 1; i -= 1) {
        const from = `${file}.${i}`
        try {
          fs.renameSync(from, `${file}.${i + 1}`)
        } catch {
          /* 该档位不存在，跳过 */
        }
      }
      fs.renameSync(file, `${file}.1`)
    } catch {
      /* 当前文件不存在（首轮）或改名失败——失败后下次 stat 会重新对齐 */
    }
  }

  const write = (line) => {
    // 先查轮转再写：新行导致超限时，把旧文件整体让位，本行写进全新文件。
    if (bytes >= cap.maxBytes) {
      rotate()
      bytes = 0
    }
    return fs.promises
      .appendFile(file, line)
      .then(() => {
        bytes += Buffer.byteLength(line)
      })
      .catch((err) => {
        const now = Date.now()
        if (now - lastWarnAt >= WARN_INTERVAL_MS) {
          lastWarnAt = now
          log('warn', 'audit write failed (task flow unaffected)', { file, error: String(err?.message ?? err) })
        }
        // 失败后重新对齐磁盘现状（文件可能被外部删掉/移动）
        try {
          bytes = fs.statSync(file).size
        } catch {
          bytes = 0
        }
      })
  }

  return {
    path: file,
    /**
     * 记一条事件。同步段只做拼接（绝不抛），磁盘写入走串行链。
     * @param {string} event 事件名，如 'task.dispatch'
     * @param {object} [fields] 扁平字段；过 sanitizeExtra（打码 + 截断）
     */
    record(event, fields = {}) {
      let line
      try {
        const entry = { ts: new Date().toISOString(), event, ...sanitizeExtra(fields ?? {}) }
        line = `${JSON.stringify(entry)}\n`
      } catch {
        /* 字段序列化失败不该影响任何调用方 */
        return
      }
      chain = chain.then(() => write(line))
    },
    /** 等待在途写入全部落盘（teardown 用）。 */
    dispose() {
      return chain.then(
        () => undefined,
        () => undefined,
      )
    },
  }
}
