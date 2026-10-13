#!/usr/bin/env node
/**
 * dsh-remote-relay —— dsh-remote-agent 的中继 CLI（零外部依赖，ESM）。
 *
 * 用法：
 *   dsh-remote-relay [--port 8890] [--host 0.0.0.0] [--hub-token T] [--enroll-token T]
 *                    [--data-dir DIR] [--print-tokens] [--help]
 *
 * 环境变量回退：DSH_RELAY_PORT / DSH_RELAY_HOST / DSH_RELAY_HUB_TOKEN / DSH_RELAY_ENROLL_TOKEN
 * 数据目录回退：DSH_RELAY_DATA_DIR（默认 ~/.dsh-remote-agent-relay）
 *
 * 设计约束（与 v0.1 契约一致）：
 *   - 明文 token 绝不进持久日志：ready 行只给指纹；stdout 不是 TTY（例如 systemd/journald）
 *     时默认不打印明文，只给指纹行 + 提示行。
 *   - SIGINT / SIGTERM 优雅关闭：await relay.close() 之后 exit 0。
 *   - onEvent 观测钩子逐行 JSON 输出，交给 journald / 文件收集器。
 */
import os from 'node:os'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createRelay, tokenFingerprint } from '../lib/relay.js'
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  formatReadyLine,
  formatTokenFingerprintLine,
  formatTokensLine,
  loadOrCreateTokens,
  parseArgs,
} from '../lib/relay-config.js'

const USAGE = `dsh-remote-relay —— dsh-remote-agent 中继服务

用法:
  dsh-remote-relay [options]

选项:
  --port <n>            监听端口（默认 ${DEFAULT_PORT}，0 = 随机端口）
  --host <addr>         监听地址（默认 ${DEFAULT_HOST}）
  --hub-token <token>   hub 端凭证；不提供则读/建 <data-dir>/tokens.json
  --enroll-token <tok>  node 入网凭证；不提供则读/建 <data-dir>/tokens.json
  --data-dir <dir>      凭证目录（默认 ~/.dsh-remote-agent-relay）
  --print-tokens        只打印 token 后退出，不启动服务
  --help, -h            显示本帮助

环境变量回退:
  DSH_RELAY_PORT / DSH_RELAY_HOST / DSH_RELAY_HUB_TOKEN / DSH_RELAY_ENROLL_TOKEN
  DSH_RELAY_DATA_DIR / DSH_RELAY_PRINT_TOKENS=1

输出（stdout，每行一条）:
  RELAY_READY url=ws://<host>:<port>/relay hub=<fp> enroll=<fp>
  RELAY_TOKENS hub=<token> enroll=<token> ...     (仅 --print-tokens / 交互式终端)
  RELAY_TOKENS_SOURCE hub=<fp> enroll=<fp> ...    (非交互式，只有指纹)
  {"ts":...,"level":"info","msg":"node online","nodeId":"..."}   (事件日志)

说明: ready 行里的 host 是「客户端可用的地址」——监听 0.0.0.0/:: 时自动换成
      本机对外 IPv4（真实监听地址见 relay listening 事件里的 bind 字段）。

HTTP 端点:
  GET  /healthz                    健康检查
  GET  /api/relay/nodes?token=...  节点目录（需 hub token）
  POST /api/relay/token?token=...  铸造一次性入网 token（需 hub token）
`

/** 事件日志：一行 JSON，不落明文 token。 */
function makeEventSink(stream) {
  return (evt) => {
    if (!evt || typeof evt !== 'object') return
    const { level = 'info', msg = '', time, ...rest } = evt
    let line
    try {
      line = JSON.stringify({ ts: time ?? Date.now(), level, msg, ...rest })
    } catch {
      line = JSON.stringify({ ts: time ?? Date.now(), level, msg, note: 'unserializable-event' })
    }
    stream.write(`${line}\n`)
  }
}

/** 通配地址对客户端没意义，换成主机的对外 IPv4；找不到就原样返回。 */
function displayHost(host) {
  if (host !== '0.0.0.0' && host !== '::' && host !== '*') return host
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni && ni.family === 'IPv4' && ni.internal === false) return ni.address
      }
    }
  } catch {
    /* 忽略：退回原 host */
  }
  return host
}

function fail(message, code = 2) {
  process.stderr.write(`dsh-remote-relay: ${message}\n`)
  process.stderr.write('用 --help 查看用法。\n')
  process.exit(code)
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2), process.env)
  } catch (err) {
    fail(err.message)
  }

  if (opts.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const wantPlainTokens =
    opts.printTokens || process.stdout.isTTY === true || process.env.DSH_RELAY_PRINT_TOKENS === '1'

  /** 解析凭证：显式给全了就用显式的；否则读/建 tokens.json。 */
  function resolveTokens() {
    const bothGiven = opts.hubToken !== '' && opts.enrollToken !== ''
    if (bothGiven) {
      return {
        hubToken: opts.hubToken,
        enrollToken: opts.enrollToken,
        created: false,
        path: '',
        source: 'args-or-env',
      }
    }
    const rec = loadOrCreateTokens(opts.dataDir)
    return {
      hubToken: opts.hubToken !== '' ? opts.hubToken : rec.hubToken,
      enrollToken: opts.enrollToken !== '' ? opts.enrollToken : rec.enrollToken,
      created: rec.created,
      path: rec.path,
      source: rec.created ? 'generated' : 'file',
    }
  }

  let creds
  try {
    creds = resolveTokens()
  } catch (err) {
    fail(err.message, 1)
  }

  if (opts.printTokens) {
    process.stdout.write(`${formatTokensLine(creds)}\n`)
    return 0
  }

  // 凭证来源始终给指纹（可安全进日志）；明文只在交互式/显式要求时打。
  process.stdout.write(`${formatTokenFingerprintLine(creds)}\n`)
  if (creds.created || wantPlainTokens) {
    process.stdout.write(`${formatTokensLine(creds)}\n`)
  } else {
    process.stdout.write(
      `RELAY_TOKENS_HINT file=${creds.path} note=plaintext-hidden(run --print-tokens to display)\n`,
    )
  }

  const relay = createRelay({
    port: opts.port,
    host: opts.host,
    hubToken: creds.hubToken,
    enrollToken: creds.enrollToken,
    onEvent: makeEventSink(process.stdout),
  })

  await new Promise((resolve, reject) => {
    relay.server.once('error', reject)
    relay.listen(() => {
      relay.server.removeListener('error', reject)
      resolve()
    })
  }).catch((err) => {
    fail(`监听 ${opts.host}:${opts.port} 失败：${err.message}`, 1)
  })

  const addr = relay.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port
  const url = `ws://${displayHost(opts.host)}:${port}/relay`
  process.stdout.write(
    `${formatReadyLine({
      url,
      hubFingerprint: tokenFingerprint(creds.hubToken),
      enrollFingerprint: tokenFingerprint(creds.enrollToken),
    })}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({
      ts: Date.now(),
      level: 'info',
      msg: 'relay listening',
      bind: `${opts.host}:${port}`,
      healthz: `http://127.0.0.1:${port}/healthz`,
    })}\n`,
  )

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    process.stdout.write(`${JSON.stringify({ ts: Date.now(), level: 'info', msg: 'shutting down', signal })}\n`)
    try {
      await relay.close()
    } catch (err) {
      process.stderr.write(`dsh-remote-relay: 关闭失败：${err?.message ?? err}\n`)
      process.exit(1)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`dsh-remote-relay: unhandledRejection: ${err?.stack ?? err}\n`)
  })

  return null // 常驻：交给信号处理收尾
}

/**
 * main-module 守卫（F2-1 修复）。
 *
 * 此前 `main()` 在模块顶层无条件调用，于是**仅仅 import 这个文件**就会：
 *   - 占用默认端口 8890
 *   - 读写 ~/.dsh-remote-agent-relay/tokens.json（创建目录并生成 token）
 *   - 注册进程级 SIGINT/SIGTERM/unhandledRejection 处理器 —— 后者会吞掉
 *     宿主进程（例如测试运行器）本来要报告的 rejection
 *
 * 作为 CLI 直接运行时行为不变；被 import 时只导出纯函数，零副作用。
 */
function isMainModule() {
  if (typeof process.argv[1] !== 'string' || process.argv[1] === '') return false
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      if (code !== null) process.exit(code)
    },
    (err) => {
      process.stderr.write(`dsh-remote-relay: 启动失败：${err?.stack ?? err}\n`)
      process.exit(1)
    },
  )
}

export { main }
