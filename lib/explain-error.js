/**
 * 错误翻译层（2026-10-20，用户体验提升 ④）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 实测用户反馈：**出了问题不知道原因**。而原始错误长这样：
 *
 *     connect timeout after 15000ms
 *     ECONNREFUSED 100.86.48.54:19387
 *     HTTP 401 {"error":"unauthorized"}
 *     task t-mvc2qkfcgo32w terminal: timeout after 40000ms
 *     EPERM: operation not permitted, rename 'C:\Users\...\templates.json.tmp-...'
 *
 * 用户看到这些只能猜。而本项目**已经**在 `lib/setup.js` 里有一份
 * `friendlyConnectError` —— 但它只覆盖 5 类网络错误，且没用到协议错误码。
 *
 * 本模块把翻译**统一到一处**：
 *   · 网络层（Node errno）
 *   · 协议层（ERROR_CODE 的 17 个码）
 *   · 面板层（HTTP 状态码）
 *   · 文件系统（EPERM/ENOENT 等）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计原则
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   · **每条都带"下一步做什么"** —— 只说"连接失败"等于没说
 *   · **保留原始信息**（`raw` 字段）—— 翻译不能丢排查线索
 *   · **绝不抛**：任何输入都返回一个结构，最差也回退到原始 message
 *   · **不猜**：拿不准的不编造原因，如实说"未知，请附上原始错误"
 */

import { ERROR_CODE } from './protocol.js'

/** 统一的翻译结果。 */
function result({ title, detail = '', hint = '', raw = '', level = 'error' }) {
  return { title, detail, hint, raw, level }
}

/**
 * 网络层错误（Node errno）→ 人话。
 *
 * @param {string} code errno，如 ECONNREFUSED
 * @param {object} [o]
 * @param {string} [o.where] 目标地址（host:port）
 * @param {boolean} [o.isHub] 出错方是不是主机侧（影响措辞）
 */
function translateErrno(code, { where = '', isHub = false } = {}) {
  const at = where !== '' ? where : (isHub ? '副机' : '主机')
  const other = isHub ? '副机' : '主机'

  switch (code) {
    case 'ECONNREFUSED':
      return result({
        title: `${at} 上没有服务在监听`,
        detail: '连接被主动拒绝 —— 对端机器在，但那个端口没程序在听。',
        hint: isHub
          ? `检查：① 副机的 DSH 是否在跑；② 副机配置的 hubUrl 端口是否与主机的 listenPort 一致（默认 19387）；③ 副机是否已设 role: worker。`
          : `检查：① 主机的 DSH 是否在跑；② 主机插件是否成功监听（看面板「环境体检」）；③ IP/端口是否写对。`,
      })

    case 'ETIMEDOUT':
    case 'ETIMEDOUT_':
      return result({
        title: `${at} 连不上（超时）`,
        detail: '数据包发出去了但没回应 —— 通常是网络不通或防火墙拦截。',
        hint: '检查：① 两台机器能否互 ping（Tailscale 用 tailscale status 看是否 online）；'
          + '② 主机防火墙是否放行该端口；③ 是否在同一局域网但路由器开了 AP 隔离。',
      })

    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return result({
        title: `到 ${at} 的网络不可达`,
        detail: '本机没有到那个地址的路由 —— 地址可能不在任何已连接的网段。',
        hint: `检查：① Tailscale 是否已连接（tailscale status）；② 是否两台机器在同一局域网；`
          + `③ IP 是否写错（Tailscale IP 形如 100.x.x.x）。`,
      })

    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return result({
        title: `解析不了 ${at} 的主机名`,
        detail: 'DNS 查不到这个名字。',
        hint: 'hubUrl 里建议直接写 **IP**（如 100.86.48.54 或 192.168.1.10），不要写主机名。',
      })

    case 'EACCES':
    case 'EPERM':
      return result({
        title: '系统拒绝了这次操作（权限不足）',
        detail: '不是网络问题 —— 是操作系统层面的权限拦截。',
        hint: '如果是文件操作：检查目录权限、文件是否被别的程序占用；'
          + '如果是端口：换一个端口（<1024 需要管理员）。',
      })

    case 'ECONNRESET':
      return result({
        title: `${at} 主动断开了连接`,
        detail: '连接建立后又被对方关闭 —— 可能是对端重启、崩溃，或协议不匹配。',
        hint: `检查：① ${other}的 DSH 是否刚重启过（重连通常会自动恢复）；`
          + '② 两端插件版本是否一致（版本差太多会握手失败）。',
      })

    case 'EPIPE':
      return result({
        title: '连接已断开，写入失败',
        detail: '对端已经关闭，还在往管道里写。',
        hint: '通常会自动重连。若持续出现，检查对端进程是否在崩溃重启。',
      })

    case 'ENOENT':
      return result({
        title: '找不到这个文件或目录',
        detail: '路径不存在 —— 可能是拼写错误，或那个目录被删了。',
        hint: '检查配置里的路径（尤其 roots / uiPullRoot）是否真实存在。',
      })

    case 'EADDRINUSE':
      return result({
        title: '端口已被占用',
        detail: '这个端口已经有别的程序在监听了。',
        hint: '换一个端口（配置里改 listenPort），或先关掉占用它的程序。'
          + '查占用：netstat -ano | findstr :19387',
      })

    case 'EADDRNOTAVAIL':
      return result({
        title: '这个 IP 不属于本机',
        detail: '想绑的地址在本机网卡上不存在（IP 变了，或写错了）。',
        hint: '检查配置里的 listenHost。留空则自动选择（推荐）—— '
          + '会自动挑 Tailscale IP 或局域网 IP。',
      })

    default:
      return null
  }
}

/**
 * 协议错误码 → 人话。
 *
 * @param {string} code ERROR_CODE 的值
 * @param {object} [o]
 * @param {boolean} [o.isHub] 保留参数（协议错误码的文案对两端通用，暂未分支）
 */
function translateProtocolCode(code, { isHub: _isHub = false } = {}) {
  switch (code) {
    case ERROR_CODE.PROTOCOL_MISMATCH:
      return result({
        title: '两端插件版本不兼容',
        detail: '协议版本号对不上 —— 一端太旧或太新。',
        hint: '把**两台机器**的 dsh-remote-agent 升级到同一版本（npm i -g dsh-remote-agent@latest）。',
      })

    case ERROR_CODE.UNAUTHORIZED:
      return result({
        title: '鉴权失败（token 不对）',
        detail: '主机拒绝了副机的凭证。',
        hint: '重新生成配对码：主机面板「副机接入」→ 复制新的 dshra1:// 整行 → '
          + '在副机重新粘贴 → 重启副机 DSH。',
      })

    case ERROR_CODE.DUPLICATE_NODE:
      return result({
        title: '节点 ID 重复',
        detail: '已经有一台同 ID 的副机在线 —— 两台机器用了同一个 nodeId。',
        hint: '在副机面板「本机标识」里改一个不同的节点 ID（或留空自动用主机名），然后重启。',
      })

    case ERROR_CODE.HUB_IDENTITY_MISMATCH:
      return result({
        title: '主机身份指纹变了',
        detail: '副机之前钉住过这台主机，但现在的指纹对不上 —— 可能是换了主机，或主机身份文件被重建。',
        hint: '如果确实是同一台主机（身份文件被删过）：在副机删掉 '
          + '~/.dsh-remote-agent/hub-pin.json 后重启。如果是换了主机：重新生成配对码。',
      })

    case ERROR_CODE.HUB_IDENTITY_PENDING:
      return result({
        title: '主机身份待确认',
        detail: '首次连接，副机在等主机出示身份证明。',
        hint: '正常流程会自动完成。若卡住：检查主机是否是较新版本（旧版没有身份签名）。',
      })

    case ERROR_CODE.E2E_RESET:
      return result({
        title: '加密会话已重置',
        detail: '主机重启过，之前的密钥失效了。',
        hint: '自动重新握手，通常无需操作。若持续出现，检查两端版本是否一致。',
      })

    case ERROR_CODE.E2E_REQUIRED:
      return result({
        title: '要求加密但握手没完成',
        detail: '业务帧必须以密文发送，但当前连接还没有加密会话。',
        hint: '通常是中继模式下的临时状态。若持续：重启两端 DSH。',
      })

    case ERROR_CODE.WORKSPACE_DENIED:
      return result({
        title: '工作区被拒绝（路径越界）',
        detail: '请求的路径不在该副机允许的 roots 范围内。',
        hint: '在副机配置里把该目录加进 roots（必须是绝对路径、必须真实存在），然后重启副机。',
      })

    case ERROR_CODE.ARTIFACT_DENIED:
      return result({
        title: '产物被拒绝',
        detail: '该文件不在可拉取的产物清单里（可能被判为 intermediate 或 other）。',
        hint: '只有 role:final 的文件能拉。用 remote_manifest 看清单；'
          + '如需放宽，用 artifactRules 配置调整分类规则。',
      })

    case ERROR_CODE.ARTIFACT_MISSING:
      return result({
        title: '产物文件不见了',
        detail: '清单里有，但副机上那个文件已经被删或改名。',
        hint: '重新跑一次任务，或让副机确认该文件还在原路径。',
      })

    case ERROR_CODE.ARTIFACT_TOO_LARGE:
      return result({
        title: '产物超过大小上限',
        detail: '单个文件太大，超出协议允许的单帧/单文件上限。',
        hint: '在副机上压缩后再拉，或直接用面板的「工作区共享（SMB）」映射目录访问。',
      })

    case ERROR_CODE.HASH_MISMATCH:
      return result({
        title: '文件校验失败（内容不一致）',
        detail: '传输过程中内容变了 —— 通常是文件在传的时候被修改，或断点续传的偏移算错了。',
        hint: '重试一次（会自动从头传）。若持续：确认副机上那个文件没有被其它程序正在写。',
      })

    case ERROR_CODE.FS_TIMEOUT:
      return result({
        title: '文件操作超时',
        detail: '副机在时限内没返回结果 —— 可能它正忙，或那个目录特别大。',
        hint: '稍后重试。若是 grep 大目录，缩小 path 范围或用更精确的 pattern。',
      })

    case ERROR_CODE.TASK_UNKNOWN:
      return result({
        title: '找不到这个任务',
        detail: '任务 ID 不存在 —— 可能已被清理，或副机重启后丢了记录。',
        hint: '用 remote_nodes 看当前任务列表。若任务确实该在，检查副机是否重启过。',
      })

    case ERROR_CODE.TASK_DUPLICATE:
      return result({
        title: '任务 ID 重复',
        detail: '这个 taskId 已经存在了。',
        hint: '通常是重试逻辑的问题 —— 换一个新的 taskId，或先查 remote_status。',
      })

    case ERROR_CODE.INTERNAL:
      return result({
        title: '内部错误',
        detail: '插件内部出了意外。',
        hint: '这通常是 bug。请附上原始错误信息提 issue：'
          + 'https://github.com/zbzbhs/dsh-remote-agent/issues',
      })

    default:
      return null
  }
}

/** HTTP 状态码 → 人话（面板/路由层）。 */
function translateHttp(status) {
  const n = Number(status)
  if (!Number.isFinite(n)) return null
  switch (n) {
    case 401:
      return result({
        title: '面板鉴权失败',
        detail: 'DSH 的连接围栏拒绝了这次请求（Host/Origin 校验或 cookie 失效）。',
        hint: '刷新页面。若持续：确认你是从 DSH 桌面窗口打开面板，而不是别的浏览器标签。',
      })
    case 403:
      return result({
        title: '没有权限',
        detail: '服务端明确拒绝了这次操作。',
        hint: '检查当前 DSH 会话的权限设置。',
      })
    case 404:
      return result({
        title: '接口不存在',
        detail: '请求的路径没注册 —— 通常是**插件没被加载**，或版本太旧没有这个接口。',
        hint: '检查：① 插件是否已安装并启用；② 版本是否过旧（面板底部有版本号）。',
      })
    case 405:
      return result({
        title: '请求方法不对',
        detail: '这个接口不接受该 HTTP 方法。',
        hint: '通常是面板与插件版本不匹配 —— 升级插件后刷新页面。',
      })
    case 409:
      return result({
        title: '冲突',
        detail: '目标状态已被别人改过（例如同时两个人改配置）。',
        hint: '刷新页面看最新状态，再重试。',
      })
    case 500:
      return result({
        title: '服务端出错',
        detail: '插件内部抛了异常。',
        hint: '看 DSH 日志里的 [remote-agent] 行。这通常是 bug，欢迎提 issue。',
      })
    case 502:
    case 503:
    case 504:
      return result({
        title: '副机暂时不可用',
        detail: '主机连不上副机，或副机正在重启。',
        hint: '稍后重试。检查副机是否在线（面板「节点」区）。',
      })
    default:
      return null
  }
}

/**
 * 主入口：把任意错误翻译成人话。
 *
 * 识别顺序：errno 码 → 协议错误码 → HTTP 状态码 → 已知文案特征 → 兜底。
 *
 * @param {any} err 错误对象 / 字符串 / {code, message}
 * @param {object} [o]
 * @param {string} [o.where] 目标地址（host:port），用于措辞
 * @param {boolean} [o.isHub] 出错方是不是主机侧
 * @param {string} [o.context] 上下文（"连接副机" / "拉取产物" 等），用于兜底文案
 * @returns {{title:string, detail:string, hint:string, raw:string, level:string}}
 */
export function explainError(err, { where = '', isHub = false, context = '' } = {}) {
  // 提取原始信息（尽量不丢线索）
  //
  // ⚠ 这里必须**逐层 try**（2026-10-20 测试抓到的真 bug）：
  // `String(err)` 会调用 err.toString()，而它可能是被用户/第三方对象覆盖的
  // 会抛错的实现。原写法 `String(err.message ?? err)` 在 message 为 undefined
  // 时退化成 `String(err)` → 整个翻译层崩掉。
  // 翻译层的职责是"绝不抛"，所以每个可能抛的取值都单独兜住。
  let raw = ''
  let code = ''
  let message = ''
  const safeString = (v) => {
    try {
      if (typeof v === 'string') return v
      if (v === null || v === undefined) return ''
      return String(v)
    } catch {
      return '(无法转成字符串)'
    }
  }
  try {
    if (typeof err === 'string') {
      raw = err
      message = err
    } else if (err && typeof err === 'object') {
      // message 优先；取不到再退回整个对象（但用 safeString 包住）
      let m = ''
      try {
        m = typeof err.message === 'string' ? err.message : ''
      } catch {
        /* message getter 抛错 */
      }
      raw = m !== '' ? m : safeString(err)
      message = m
      try {
        code = typeof err.code === 'string' ? err.code : ''
      } catch {
        /* code getter 抛错 */
      }
    }
  } catch {
    raw = '(无法读取错误对象)'
  }

  // 1. errno（Node 网络/文件系统错误）
  if (code !== '') {
    const t = translateErrno(code, { where, isHub })
    if (t) return { ...t, raw }
  }

  // 2. 协议错误码
  if (code !== '') {
    const t = translateProtocolCode(code, { isHub })
    if (t) return { ...t, raw }
  }

  // 3. 从 message 里捞协议错误码（很多地方只把 code 拼进文案）
  for (const c of Object.values(ERROR_CODE)) {
    if (typeof c === 'string' && c !== '' && message.includes(c)) {
      const t = translateProtocolCode(c, { isHub })
      if (t) return { ...t, raw }
    }
  }

  // 4. HTTP 状态码（message 形如 "HTTP 401" 或 "401 Unauthorized"）
  const httpMatch = /\b(4\d\d|5\d\d)\b/.exec(message)
  if (httpMatch) {
    const t = translateHttp(httpMatch[1])
    if (t) return { ...t, raw }
  }

  // 5. 常见文案特征（Node/我们自己的实现里的固定串）
  if (/timeout after \d+ms/i.test(message) || /timed out after \d+ms/i.test(message)) {
    const ms = /after (\d+)ms/i.exec(message)
    const sec = ms ? Math.round(Number(ms[1]) / 1000) : null
    return {
      ...result({
        title: '操作超时',
        detail: sec !== null ? `等了 ${sec} 秒没收到回应。` : '等待回应超时。',
        hint: isHub
          ? '检查副机是否在线、是否正忙。若是长任务，用更长的 timeoutMs 重派。'
          : '检查主机是否在线、网络是否稳定。',
      }),
      raw,
    }
  }

  if (/handshake timeout/i.test(message)) {
    return {
      ...result({
        title: '握手超时',
        detail: 'TCP 连上了，但 WebSocket/协议握手没在时限内完成。',
        hint: '通常是**两端版本差异太大**，或对端那个端口上跑的不是本插件。'
          + '确认：① 端口号是否写对（默认 19387）；② 两端插件版本是否一致。',
      }),
      raw,
    }
  }

  if (/not lossless JSON|invalid output/i.test(message)) {
    return {
      ...result({
        title: '数据格式异常',
        detail: '插件返回的数据里有无法序列化的值（这通常是 bug）。',
        hint: '请附上原始错误提 issue。',
      }),
      raw,
    }
  }

  // 6. 兜底：不编造原因，如实说
  return {
    ...result({
      title: context !== '' ? `${context}失败` : '出错了',
      detail: message !== '' ? message : '没有更多信息。',
      hint: '如果看不懂这条错误，请把**原始错误**整段附上提 issue：'
        + 'https://github.com/zbzbhs/dsh-remote-agent/issues',
      level: 'warn',
    }),
    raw,
  }
}

/**
 * 把翻译结果渲染成一行可读文本（日志/CLI 用；面板自己排版）。
 *
 * @param {ReturnType<typeof explainError>} t
 * @returns {string}
 */
export function formatExplained(t) {
  const lines = [t.title]
  if (t.detail) lines.push(`  ${t.detail}`)
  if (t.hint) lines.push(`  → ${t.hint}`)
  return lines.join('\n')
}
