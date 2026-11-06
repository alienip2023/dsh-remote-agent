/**
 * ssh-onboard.js
 * SSH 一键上桥：从本机读取 dsh-ssh.json，通过 ssh2 连接远端副机，
 * 完成探测 → 上传 tgz → 安装 → 写配置 → 启动的全流程。
 *
 * 安全原则：
 *   1. readSshHosts() 只返回脱敏字段（alias/host/port/user/authKind/tags/description），
 *      绝不返回 password、keyPath 内容、私钥内容。
 *   2. 所有 SSH 操作通过 ssh2 Client，禁止 shell 调 ssh/scp（Windows 无法用）。
 *   3. deploy 进度存储在内存 Map，密码/token 一律打码后再写入步骤日志。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ── DSH_HOME 解析（与 setup-routes.js 保持一致） ────────────────────────
function resolveDshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return process.env.DSH_HOME.trim()
  }
  // 自动探测常见安装路径
  const bases = []
  if (process.platform === 'darwin') {
    bases.push(path.join(os.homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness'))
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'))
    if (process.env.LOCALAPPDATA) bases.push(path.join(process.env.LOCALAPPDATA, 'dsh-desktop', 'harness'))
  } else {
    if (process.env.XDG_CONFIG_HOME) bases.push(path.join(process.env.XDG_CONFIG_HOME, 'dsh-desktop', 'harness'))
    bases.push(path.join(os.homedir(), '.config', 'dsh-desktop', 'harness'))
    bases.push(path.join(os.homedir(), '.local', 'share', 'dsh-desktop', 'harness'))
  }
  for (const b of bases) {
    if (fs.existsSync(b)) return b
  }
  return path.join(os.homedir(), '.dsh')
}

function sshJsonPath() {
  return path.join(resolveDshHome(), 'dsh-ssh.json')
}

// ── 脱敏：只暴露安全字段 ─────────────────────────────────────────────────
/**
 * 从 dsh-ssh.json 读取主机列表，返回脱敏后的对象数组。
 * 原始结构中的 password、keyPath 内容、私钥字节一律不返回。
 */
export function readSshHosts() {
  const file = sshJsonPath()
  if (!fs.existsSync(file)) return { ok: true, hosts: [], file }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, error: 'parse-error', message: String(err.message), file }
  }
  const list = Array.isArray(raw) ? raw : (raw.hosts ?? [])
  // ⚠ 脱敏：绝不在 authKind 之外透露任何认证细节
  const hosts = list.map((h) => ({
    alias: String(h.alias ?? ''),
    host: String(h.host ?? ''),
    port: typeof h.port === 'number' ? h.port : 22,
    user: String(h.user ?? 'root'),
    authKind: h.auth?.kind === 'password' ? 'password' : 'key',
    tags: Array.isArray(h.tags) ? h.tags.map(String) : [],
    description: typeof h.description === 'string' ? h.description : '',
  }))
  return { ok: true, hosts, file }
}

// ── 内部：按 alias 查找原始主机配置 ──────────────────────────────────────
function findRawHost(alias) {
  const file = sshJsonPath()
  if (!fs.existsSync(file)) return null
  let raw
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  const list = Array.isArray(raw) ? raw : (raw.hosts ?? [])
  return list.find((h) => h.alias === alias) ?? null
}

// ── ssh2 连接工厂 ─────────────────────────────────────────────────────────
async function connect(host) {
  const _require = createRequire(import.meta.url)
  const { Client } = _require('ssh2')
  const { host: hostname, port = 22, user = 'root', auth = {} } = host
  const connOpts = { host: hostname, port, username: user, readyTimeout: 20000, timeout: 20000 }
  if (auth.kind === 'password') {
    connOpts.password = String(auth.password ?? '')
  } else if (auth.kind === 'key' && auth.keyPath) {
    try {
      connOpts.privateKey = fs.readFileSync(auth.keyPath)
      if (auth.passphrase) connOpts.passphrase = String(auth.passphrase)
    } catch (err) {
      throw new Error(`无法读取密钥文件（路径已隐藏）: ${err.message}`)
    }
  } else {
    // 尝试 agent 或 default key
    const defKey = path.join(os.homedir(), '.ssh', 'id_rsa')
    if (fs.existsSync(defKey)) connOpts.privateKey = fs.readFileSync(defKey)
  }
  const conn = new Client()
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect(connOpts)
  })
  return conn
}

// ── exec helper ─────────────────────────────────────────────────────────
function execCmd(conn, cmd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`命令超时: ${cmd.slice(0, 60)}`)), timeoutMs)
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err) }
      let stdout = '', stderr = ''
      stream.on('data', (d) => { stdout += d })
      stream.stderr.on('data', (d) => { stderr += d })
      stream.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
      })
    })
  })
}

// ── sftp put helper ──────────────────────────────────────────────────────
function sftpPut(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      sftp.fastPut(localPath, remotePath, (e) => {
        sftp.end()
        if (e) return reject(e)
        resolve()
      })
    })
  })
}

// ── 探测 ─────────────────────────────────────────────────────────────────
/**
 * 连接到 alias 指向的主机，运行只读探测命令，返回环境信息。
 */
export async function probeHost(alias) {
  const raw = findRawHost(alias)
  if (!raw) return { ok: false, error: 'host-not-found', message: `alias '${alias}' 不在 dsh-ssh.json 中` }
  let conn
  try {
    conn = await connect(raw)
    const [osr, noder, npmr, dshr, homer] = await Promise.all([
      execCmd(conn, 'uname -s 2>/dev/null || cmd /c "echo %OS%"'),
      execCmd(conn, 'node --version 2>&1 || node -v 2>&1 || echo MISSING'),
      execCmd(conn, 'npm --version 2>&1 || echo MISSING'),
      execCmd(conn, 'dsh --version 2>&1 || dsh-desktop --version 2>&1 || echo MISSING'),
      execCmd(conn, 'echo "${DSH_HOME:-}" && echo "${HOME:-}" && echo "${USERPROFILE:-}"'),
    ])
    const nodeVer = noder.stdout.startsWith('MISSING') ? null : noder.stdout
    const npmVer = npmr.stdout.startsWith('MISSING') ? null : npmr.stdout
    const dshVer = dshr.stdout.startsWith('MISSING') ? null : dshr.stdout
    const osType = osr.stdout || 'unknown'
    const missing = []
    if (!nodeVer) missing.push('node')
    if (!npmVer) missing.push('npm')
    if (!dshVer) missing.push('dsh')
    const homeParts = homer.stdout.split('\n').filter(Boolean)
    const dshHome = homeParts[0] || homeParts[1] || homeParts[2] || ''
    return { ok: true, os: osType, node: nodeVer, npm: npmVer, dsh: dshVer, dshHome, missing }
  } catch (err) {
    return { ok: false, error: 'probe-failed', message: String(err.message) }
  } finally {
    if (conn) try { conn.end() } catch {}
  }
}

// ── 部署进度状态 ─────────────────────────────────────────────────────────
export const deployJobs = new Map()
let jobSeq = 0

const STEPS = [
  'connect',      // 1. 连接 SSH
  'probe',        // 2. 探测环境
  'upload',       // 3. 上传 tgz
  'install',      // 4. 安装到 node_modules
  'configure',    // 5. 写 worker 配置
  'start',        // 6. 启动/重启 DSH
  'wait-online',  // 7. 等节点上线
]

function maskSecret(s) {
  if (typeof s !== 'string' || s.length < 4) return '***'
  return s.slice(0, 3) + '***' + s.slice(-2)
}

// ── 主部署流程 ────────────────────────────────────────────────────────────
/**
 * 在远端副机上完整部署 dsh-remote-agent 并配置为 worker 模式。
 * 返回 jobId；进度可通过 getDeployJob(jobId) 查询。
 */
export function startDeploy({ alias, nodeId, roots = [], config = {}, registry, log }) {
  const jobId = `deploy-${++jobSeq}-${Date.now()}`
  const job = {
    id: jobId,
    alias,
    status: 'running',
    steps: STEPS.map((name) => ({ name, status: 'pending', log: '' })),
    createdAt: Date.now(),
    error: null,
  }
  deployJobs.set(jobId, job)

  // 异步执行，不阻塞调用方
  runDeploy(job, { alias, nodeId, roots, config, registry, log }).catch((err) => {
    job.status = 'failed'
    job.error = String(err.message ?? err)
    log('warn', 'ssh-deploy failed', { alias, error: job.error })
  })

  return jobId
}

async function stepUpdate(job, stepName, status, logLine) {
  const s = job.steps.find((x) => x.name === stepName)
  if (s) { s.status = status; if (logLine) s.log += logLine + '\n' }
}

async function runDeploy(job, { alias, nodeId, roots, config, registry, log }) {
  const raw = findRawHost(alias)
  if (!raw) {
    job.status = 'failed'
    job.error = `alias '${alias}' 不在 dsh-ssh.json 中`
    return
  }

  // Step 1: connect
  stepUpdate(job, 'connect', 'running', `连接 ${raw.user}@${raw.host}:${raw.port}`)
  let conn
  try {
    conn = await connect(raw)
    stepUpdate(job, 'connect', 'done', '连接成功')
  } catch (err) {
    stepUpdate(job, 'connect', 'failed', `连接失败: ${err.message}`)
    job.status = 'failed'; job.error = `连接失败: ${err.message}`; return
  }

  try {
    // Step 2: probe
    stepUpdate(job, 'probe', 'running', '探测远端环境')
    const [noder, osRes] = await Promise.all([
      execCmd(conn, 'node --version 2>&1 || echo MISSING'),
      execCmd(conn, 'uname -s 2>/dev/null || echo Windows'),
    ])
    const nodeVer = noder.stdout.startsWith('MISSING') ? null : noder.stdout
    if (!nodeVer) {
      stepUpdate(job, 'probe', 'failed', '未检测到 node，请先安装运行环境（使用「安装运行环境」功能）')
      job.status = 'failed'; job.error = '未检测到 node'; conn.end(); return
    }
    const isWindows = osRes.stdout.toLowerCase().includes('windows') || osRes.stdout.toLowerCase().includes('mingw') || osRes.stdout.toLowerCase().includes('nt')
    const pathSep = isWindows ? '\\' : '/'
    stepUpdate(job, 'probe', 'done', `os=${osRes.stdout} node=${nodeVer}`)

    // Step 3: upload tgz
    stepUpdate(job, 'upload', 'running', '查找本机 tgz 包')
    // 跨平台 tgz 目录（避免硬编码 /Users/kjclaw）
    const _home = process.env.HOME || process.env.USERPROFILE || os.homedir()
    const tgzDir = path.join(_home, 'Documents', 'dsh')
    // 数值排序 fork 号：避免字典序 fork.9 > fork.25
    function _numSort(files) {
      return files.slice().sort((a, b) => {
        const ma = a.match(/-fork\.(\d+)\.tgz$/)
        const mb = b.match(/-fork\.(\d+)\.tgz$/)
        if (ma && mb) return Number(mb[1]) - Number(ma[1])
        return b.localeCompare(a)
      })
    }
    const tgzFiles = fs.existsSync(tgzDir)
      ? _numSort(fs.readdirSync(tgzDir).filter((f) => f.startsWith('dsh-remote-agent-') && f.endsWith('.tgz')))
      : []
    if (tgzFiles.length === 0) {
      stepUpdate(job, 'upload', 'failed', '未找到 dsh-remote-agent-*.tgz，请先 pack')
      job.status = 'failed'; job.error = '未找到 tgz'; conn.end(); return
    }
    const tgzLocal = path.join(tgzDir, tgzFiles[0])
    const tgzRemote = isWindows ? `C:/Users/Public/dsh-remote-agent-latest.tgz` : `/tmp/dsh-remote-agent-latest.tgz`
    stepUpdate(job, 'upload', 'running', `上传 ${tgzFiles[0]} → ${tgzRemote}`)
    await sftpPut(conn, tgzLocal, tgzRemote)
    stepUpdate(job, 'upload', 'done', `上传完成 (${Math.round(fs.statSync(tgzLocal).size / 1024)} KB)`)

    // Step 4: install
    stepUpdate(job, 'install', 'running', '安装到远端 DSH profile node_modules')
    // 找远端 DSH_HOME
    const homeRes = await execCmd(conn, 'echo "${DSH_HOME:-}" && echo "${HOME:-}"')
    const homeParts = homeRes.stdout.split('\n').filter(Boolean)
    const remoteHome = homeParts[0] || homeParts[1] || '/root'
    // macOS: ~/Library/Application Support/dsh-desktop/harness; Linux: ~/.config/dsh-desktop/harness
    const profileBase = isWindows
      ? `${remoteHome}\\AppData\\Roaming\\dsh-desktop\\harness\\profiles\\web\\node_modules`
      : `${remoteHome}/.config/dsh-desktop/harness/profiles/web/node_modules`
    const macAlt = `${remoteHome}/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules`
    // Try detecting the profile dir
    const findRes = await execCmd(conn,
      `ls "${profileBase}/dsh-remote-agent" 2>/dev/null || ls "${macAlt}/dsh-remote-agent" 2>/dev/null || echo NOTFOUND`)
    const nmDir = findRes.stdout.includes('NOTFOUND')
      ? (isWindows ? profileBase : profileBase) // fallback
      : (findRes.stdout.includes('Library') ? macAlt : profileBase)
    const installDir = `${nmDir}/dsh-remote-agent`
    const extractCmd = isWindows
      ? `mkdir -p "${installDir}" && tar -xzf "${tgzRemote}" -C "${installDir}" --strip-components=1 2>&1`
      : `mkdir -p "${installDir}" && tar -xzf "${tgzRemote}" -C "${installDir}" --strip-components=1 2>&1`
    const instRes = await execCmd(conn, extractCmd, 60000)
    if (instRes.code !== 0 && instRes.stderr) {
      stepUpdate(job, 'install', 'failed', `安装失败: ${instRes.stderr.slice(0, 200)}`)
      job.status = 'failed'; job.error = `安装失败: ${instRes.stderr.slice(0, 200)}`; conn.end(); return
    }
    stepUpdate(job, 'install', 'done', `安装到 ${installDir}`)

    // Step 5: configure — 写 worker 配置到 cordis.patch.yml
    stepUpdate(job, 'configure', 'running', '写 worker 配置')
    // 铸 enrollToken
    const relayUrl = typeof config.relayUrl === 'string' ? config.relayUrl : (typeof config.relay?.url === 'string' ? config.relay.url : '')
    const relayToken = typeof config.relayToken === 'string' ? config.relayToken : (typeof config.relay?.token === 'string' ? config.relay.token : '')
    if (!relayUrl || !relayToken) {
      stepUpdate(job, 'configure', 'failed', '中控未配置中继地址或 hubToken，无法上桥——请先在面板完成中继配置')
      job.status = 'failed'; job.error = '未配置中继（relayUrl/relayToken）'; conn.end(); return
    }
    let enrollToken = ''
    if (relayUrl && relayToken) {
      try {
        const httpBase = relayUrl.replace(/^wss?:\/\//, (m) => m.startsWith('wss') ? 'https://' : 'http://')
          .replace(/\/relay(\/.*)?$/, '')
        const mintUrl = `${httpBase}/api/relay/token?token=${encodeURIComponent(relayToken)}`
        // 用 node http/https 铸 token
        const { default: https } = await import('node:https')
        const { default: http } = await import('node:http')
        const parsed = new URL(mintUrl)
        const mod = parsed.protocol === 'https:' ? https : http
        const data = await new Promise((resolve, reject) => {
          const reqOut = mod.request(mintUrl, { method: 'POST', headers: { 'content-length': '0' } }, (r) => {
            let body = ''
            r.on('data', (c) => { body += c })
            r.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error('invalid JSON')) } })
          })
          reqOut.on('error', reject)
          reqOut.end()
        })
        if (data && data.token) enrollToken = data.token
      } catch (err) {
        stepUpdate(job, 'configure', 'running', `铸 enrollToken 失败 (${err.message})，将跳过中继配置`)
      }
    }
    const effectiveNodeId = nodeId || `node-${raw.alias}`
    const effectiveRoots = roots.length > 0 ? roots : (isWindows ? ['D:\\work'] : [`${remoteHome}/work`])
    // 写 cordis.patch.yml patch block
    const profileDir = nmDir.replace(/[\\/]node_modules$/, '')
    const patchFile = `${profileDir}/cordis.patch.yml`
    const patchContent = [
      '',
      '# dsh-remote-agent worker config (written by SSH deploy)',
      'plugins:',
      '  dsh-remote-agent:',
      `    role: 'worker'`,
      `    transportMode: 'relay'`,
      relayUrl ? `    relayUrl: '${relayUrl.replace(/'/g, "'\"'\"'")}'` : '',
      enrollToken ? `    nodeToken: '${enrollToken}'` : '',
      `    nodeId: '${effectiveNodeId}'`,
      `    roots:`,
      ...effectiveRoots.map((r) => `      - '${r}'`),
    ].filter((l) => l !== '').join('\n')
    const cfgCmd = isWindows
      ? `echo "" >> "${patchFile}" && echo "${patchContent.replace(/\n/g, ' && echo ')}" >> "${patchFile}" 2>&1`
      : `printf '%s\\n' ${JSON.stringify(patchContent)} >> "${patchFile}" 2>&1`
    await execCmd(conn, cfgCmd, 10000)
    stepUpdate(job, 'configure', 'done', `配置写入 ${patchFile}（token 已打码）`)

    // Step 6: start/restart DSH
    stepUpdate(job, 'start', 'running', '启动/重启 DSH')
    const startCmds = [
      'dsh restart 2>&1 || dsh-desktop restart 2>&1 || killall "DSH Desktop" 2>/dev/null; sleep 2',
      'open -a "DSH Desktop" 2>/dev/null || dsh-desktop &',
    ]
    for (const cmd of startCmds) {
      const r = await execCmd(conn, cmd, 15000).catch(() => ({ code: 1, stdout: '', stderr: '' }))
      if (r.code === 0) break
    }
    stepUpdate(job, 'start', 'done', 'DSH 已发送重启指令')

    // Step 7: wait online
    stepUpdate(job, 'wait-online', 'running', `等待节点 ${effectiveNodeId} 上线（最多 120s）`)
    const deadline = Date.now() + 120000
    let online = false
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      if (registry) {
        const nodes = registry.list()
        if (nodes.some((n) => n.nodeId === effectiveNodeId && n.online)) {
          online = true; break
        }
      }
    }
    if (online) {
      stepUpdate(job, 'wait-online', 'done', `节点 ${effectiveNodeId} 已上线`)
      job.status = 'done'
    } else {
      stepUpdate(job, 'wait-online', 'failed', '超时未上线，请检查中继配置或防火墙')
      job.status = 'failed'; job.error = '等待上线超时'
    }
  } finally {
    if (conn) try { conn.end() } catch {}
  }
}

// ── 查询部署进度 ─────────────────────────────────────────────────────────
export function getDeployJob(id) {
  return deployJobs.get(id) ?? null
}

// ── 安装运行环境（空机装 Node LTS + DSH） ────────────────────────────────
/**
 * 在远端空机上安装 Node LTS 和 @deepseek-ai/dsh@0.2.2-rc.1。
 * ⚠ 必须传 confirm: 'yes'，否则拒绝执行（防止误操作）。
 */
export async function installRuntime({ alias, confirm }) {
  // ⚠ 无 confirm 必须拒绝，绝不静默执行
  if (confirm !== 'yes') {
    return { ok: false, error: 'confirm-required', message: '必须传 confirm: "yes" 才能执行安装运行环境（此操作会在副机上执行 npm install 等命令）' }
  }
  const raw = findRawHost(alias)
  if (!raw) return { ok: false, error: 'host-not-found', message: `alias '${alias}' 不在 dsh-ssh.json 中` }
  let conn
  try {
    conn = await connect(raw)
    const steps = []

    // 检测是否有 node
    const nodeRes = await execCmd(conn, 'node --version 2>&1 || echo MISSING', 10000)
    if (!nodeRes.stdout.startsWith('MISSING') && !nodeRes.stdout.startsWith('v0.') && !nodeRes.stdout.startsWith('v1.')) {
      steps.push({ cmd: 'node-check', result: 'already installed: ' + nodeRes.stdout })
    } else {
      // 安装 Node LTS via nvm 或 apt/brew
      const osRes = await execCmd(conn, 'uname -s 2>/dev/null || echo Windows')
      const isWindows = osRes.stdout.toLowerCase().includes('windows')
      let installNode
      if (isWindows) {
        installNode = 'winget install OpenJS.NodeJS.LTS 2>&1 || choco install nodejs-lts -y 2>&1'
      } else {
        installNode = [
          'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash 2>&1',
          'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install --lts 2>&1',
        ].join(' && ')
      }
      const r = await execCmd(conn, installNode, 120000)
      steps.push({ cmd: 'install-node', code: r.code, stdout: r.stdout.slice(0, 300) })
    }

    // 安装 DSH
    const dshVer = '0.2.2-rc.1'
    const installDsh = `npm install -g "@deepseek-ai/dsh@${dshVer}" 2>&1 || npx --yes "@deepseek-ai/dsh@${dshVer}" --version 2>&1`
    const dshRes = await execCmd(conn, installDsh, 120000)
    steps.push({ cmd: 'install-dsh', code: dshRes.code, stdout: dshRes.stdout.slice(0, 300) })

    return { ok: true, steps }
  } catch (err) {
    return { ok: false, error: 'ssh-error', message: String(err.message) }
  } finally {
    if (conn) try { conn.end() } catch {}
  }
}
