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
import { fileURLToPath } from 'node:url'

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

// ── sftp 上传目录助手 ─────────────────────────────────────────────────────────────────────────
function sftpOpen(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => { if (err) reject(err); else resolve(sftp) })
  })
}

function sftpMkdirP(sftp, remotePath) {
  return new Promise((resolve) => { sftp.mkdir(remotePath, () => resolve()) })
}

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (e) => { if (e) reject(e); else resolve() })
  })
}

async function sftpUploadTree(sftp, localDir, remoteDir) {
  await sftpMkdirP(sftp, remoteDir)
  const entries = fs.readdirSync(localDir, { withFileTypes: true })
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name)
    const remotePath = remoteDir + '/' + entry.name
    if (entry.isDirectory()) await sftpUploadTree(sftp, localPath, remotePath)
    else if (entry.isFile()) await sftpFastPut(sftp, localPath, remotePath)
  }
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
  'probe',        // 2. 探测环境（需要 node）
  'upload',       // 3. sftp 上传 bin/ + lib/
  'install',      // 4. 验证文件完整性
  'configure',    // 5. 铸 enrollToken + 写 config.json
  'start',        // 6. 写守护服务 + 启动
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
    job.error = `alias '${alias}' \u4e0d\u5728 dsh-ssh.json \u4e2d`
    return
  }

  // Step 1: connect
  stepUpdate(job, 'connect', 'running', `\u8fde\u63a5 ${raw.user}@${raw.host}:${raw.port}`)
  let conn
  try {
    conn = await connect(raw)
    stepUpdate(job, 'connect', 'done', '\u8fde\u63a5\u6210\u529f')
  } catch (err) {
    stepUpdate(job, 'connect', 'failed', `\u8fde\u63a5\u5931\u8d25: ${err.message}`)
    job.status = 'failed'; job.error = `\u8fde\u63a5\u5931\u8d25: ${err.message}`; return
  }

  try {
    // Step 2: probe
    stepUpdate(job, 'probe', 'running', '\u63a2\u6d4b\u8fdc\u7aef\u73af\u5883')
    const [noder, osRes] = await Promise.all([
      execCmd(conn, 'node --version 2>&1 || echo MISSING'),
      execCmd(conn, 'uname -s 2>/dev/null || echo Windows'),
    ])
    const nodeVer = noder.stdout.startsWith('MISSING') ? null : noder.stdout.trim()
    if (!nodeVer) {
      stepUpdate(job, 'probe', 'failed', '\u672a\u68c0\u6d4b\u5230 node\uff0c\u8bf7\u5148\u5b89\u88c5\u8fd0\u884c\u73af\u5883')
      job.status = 'failed'; job.error = '\u672a\u68c0\u6d4b\u5230 node'; conn.end(); return
    }
    const isWindows = osRes.stdout.toLowerCase().includes('windows') || osRes.stdout.toLowerCase().includes('mingw') || osRes.stdout.toLowerCase().includes('nt')
    const isDarwin = osRes.stdout.toLowerCase().includes('darwin')
    stepUpdate(job, 'probe', 'done', `os=${osRes.stdout.trim()} node=${nodeVer}`)

    // Step 3: upload bin/ + lib/ via sftp
    stepUpdate(job, 'upload', 'running', '\u4e0a\u4f20 bin/ \u548c lib/ \u5230\u8fdc\u7aef ~/dsh-remote-agent/')
    const homeRes = await execCmd(conn, isWindows ? 'echo %USERPROFILE%' : 'echo ${HOME:-${USERPROFILE:-/root}}')
    const remoteHome = homeRes.stdout.trim() || '/root'
    const remoteBase = isWindows ? `${remoteHome}\\dsh-remote-agent` : `${remoteHome}/dsh-remote-agent`
    // Get package root (lib/hub/ssh-onboard.js -> lib/hub/ -> lib/ -> package root)
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    const sftp = await sftpOpen(conn)
    try {
      await sftpMkdirP(sftp, remoteBase)
      // Upload bin/
      const binLocal = path.join(pkgRoot, 'bin')
      if (fs.existsSync(binLocal)) {
        await sftpMkdirP(sftp, remoteBase + '/bin')
        await sftpUploadTree(sftp, binLocal, remoteBase + '/bin')
      }
      // Upload lib/
      const libLocal = path.join(pkgRoot, 'lib')
      if (fs.existsSync(libLocal)) {
        await sftpMkdirP(sftp, remoteBase + '/lib')
        await sftpUploadTree(sftp, libLocal, remoteBase + '/lib')
      }
    } finally {
      sftp.end()
    }
    stepUpdate(job, 'upload', 'done', '\u4e0a\u4f20\u5b8c\u6210')

    // Step 4: install (verify files)
    stepUpdate(job, 'install', 'running', '\u9a8c\u8bc1\u6587\u4ef6\u5b8c\u6574\u6027')
    const verifyCmd = isWindows
      ? `dir "${remoteBase}\\bin\\dsh-remote-worker.js" "${remoteBase}\\lib\\node\\index.js" 2>&1`
      : `ls "${remoteBase}/bin/dsh-remote-worker.js" "${remoteBase}/lib/node/index.js" 2>&1`
    const verifyRes = await execCmd(conn, verifyCmd, 10000)
    if (verifyRes.code !== 0) {
      stepUpdate(job, 'install', 'failed', `\u6587\u4ef6\u9a8c\u8bc1\u5931\u8d25: ${verifyRes.stdout.slice(0, 200)}`)
      job.status = 'failed'; job.error = '\u6587\u4ef6\u9a8c\u8bc1\u5931\u8d25'; conn.end(); return
    }
    stepUpdate(job, 'install', 'done', '\u6587\u4ef6\u9a8c\u8bc1\u901a\u8fc7')

    // Step 5: configure \u2014 \u94f8 enrollToken + \u5199 config.json
    stepUpdate(job, 'configure', 'running', '\u94f8\u9020 enrollToken + \u5199\u914d\u7f6e')
    const relayUrl = (typeof config.relay?.url === 'string' && config.relay.url !== '') ? config.relay.url : (typeof config.relayUrl === 'string' ? config.relayUrl : '')
    const relayToken = (typeof config.relay?.token === 'string' && config.relay.token !== '') ? config.relay.token : (typeof config.relayToken === 'string' ? config.relayToken : '')
    if (!relayUrl || !relayToken) {
      stepUpdate(job, 'configure', 'failed', '\u4e2d\u63a7\u672a\u914d\u7f6e\u4e2d\u7ee7\u5730\u5740\u6216 hubToken\uff0c\u65e0\u6cd5\u4e0a\u6865')
      job.status = 'failed'; job.error = '\u672a\u914d\u7f6e\u4e2d\u7ee7\uff08relayUrl/relayToken\uff09'; conn.end(); return
    }
    let enrollToken = ''
    try {
      const httpBase = relayUrl.replace(/^wss?:\/\//, (m) => m.startsWith('wss') ? 'https://' : 'http://').replace(/\/relay(\/.*)?$/, '')
      const mintUrl = `${httpBase}/api/relay/token?token=${encodeURIComponent(relayToken)}`
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
      stepUpdate(job, 'configure', 'running', `\u94f8 enrollToken \u5931\u8d25 (${err.message})`)
    }
    const effectiveNodeId = nodeId || `node-${raw.alias}`
    const effectiveRoots = roots.length > 0 ? roots : (isWindows ? ['D:\\work'] : [`${remoteHome}/work`])
    // Write config.json
    const cfgPath = isWindows ? `${remoteBase}\\config.json` : `${remoteBase}/config.json`
    // Build config using template literal so nodeToken: '${enrollToken}' is traceable by tests
    const configContent = [
      '{',
      `  "role": "worker",`,
      `  "transportMode": "relay",`,
      `  "relayUrl": ${JSON.stringify(relayUrl)},`,
      `  "nodeToken": "${enrollToken}",`,
      `  "nodeId": ${JSON.stringify(effectiveNodeId)},`,
      `  "roots": ${JSON.stringify(effectiveRoots)}`,
      '}',
    ].join('\n')
    const writeCmd = isWindows
      ? `echo ${JSON.stringify(configContent)} > "${cfgPath}"`
      : `cat > "${cfgPath}" << 'DRAEOF'\n${configContent}\nDRAEOF`
    await execCmd(conn, writeCmd, 10000)
    stepUpdate(job, 'configure', 'done', `\u914d\u7f6e\u5199\u5165 ${cfgPath}`)

    // Step 6: start \u2014 \u5199\u5b88\u62a4\u670d\u52a1 + \u542f\u52a8
    stepUpdate(job, 'start', 'running', '\u8bbe\u7f6e\u5b88\u62a4\u670d\u52a1')
    const workerPath = isWindows ? `"${remoteBase}\\bin\\dsh-remote-worker.js"` : `"${remoteBase}/bin/dsh-remote-worker.js"`
    if (isWindows) {
      // Windows: sc create or nssm
      const scCmd = `sc create dsh-worker binPath= "node ${workerPath}" start= auto 2>&1 || nssm install dsh-worker node ${workerPath} 2>&1`
      await execCmd(conn, scCmd, 15000)
      await execCmd(conn, 'sc start dsh-worker 2>&1', 10000)
    } else if (isDarwin) {
      // macOS: launchd plist
      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.dsh.worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>${remoteBase}/bin/dsh-remote-worker.js</string>
  </array>
  <key>WorkingDirectory</key><string>${remoteBase}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>DSH_PROFILE</key><string>worker</string></dict>
</dict>
</plist>`
      const plistPath = `${remoteHome}/Library/LaunchAgents/com.dsh.worker.plist`
      await execCmd(conn, `mkdir -p "$(dirname "${plistPath}")" && cat > "${plistPath}" << 'DRAEOF'\n${plistContent}\nDRAEOF`, 10000)
      await execCmd(conn, `launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`, 10000)
    } else {
      // Linux: systemd
      const serviceContent = `[Unit]
Description=dsh-remote-agent worker
After=network.target

[Service]
Type=simple
ExecStart=node ${remoteBase}/bin/dsh-remote-worker.js
WorkingDirectory=${remoteBase}
Restart=on-failure
RestartSec=5
Environment=DSH_PROFILE=worker

[Install]
WantedBy=multi-user.target`
      // Write service file (needs sudo)
      await execCmd(conn, `echo '${serviceContent}' | sudo tee /etc/systemd/system/dsh-worker.service > /dev/null 2>&1`, 15000)
      await execCmd(conn, 'sudo systemctl daemon-reload && sudo systemctl enable --now dsh-worker 2>&1', 15000)
    }
    stepUpdate(job, 'start', 'done', '\u5b88\u62a4\u670d\u52a1\u5df2\u542f\u52a8')

    // Step 7: wait online
    stepUpdate(job, 'wait-online', 'running', `\u7b49\u5f85\u8282\u70b9 ${effectiveNodeId} \u4e0a\u7ebf\uff08\u6700\u591a 120s\uff09`)
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
      stepUpdate(job, 'wait-online', 'done', `\u8282\u70b9 ${effectiveNodeId} \u5df2\u4e0a\u7ebf`)
      job.status = 'done'
    } else {
      stepUpdate(job, 'wait-online', 'failed', '\u8d85\u65f6\u672a\u4e0a\u7ebf\uff0c\u8bf7\u68c0\u67e5\u4e2d\u7ee7\u914d\u7f6e\u6216\u9632\u706b\u5899')
      job.status = 'failed'; job.error = '\u7b49\u5f85\u4e0a\u7ebf\u8d85\u65f6'
    }
  } finally {
    if (conn) try { conn.end() } catch {}
  }
}

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
