/**
 * hub 身份：持久 ed25519 密钥对 + 指纹 + 身份帧签名（零外部依赖，node:crypto）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 这个模块解决什么问题（评审报告 P2-11）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 协议此前只有**单向认证**：副机拿 token 向 hub 证明"我是被允许接入的节点"，
 * 但 hub 从不需要向副机证明"我就是你知道的那个 hub"。于是：
 *
 *   - direct 模式：任何能 accept upgrade 的端点（假 hub / 中间人）回一帧
 *     welcome，副机就上线 —— 之后的 task/start（mode:"exec" = 副机任意代码
 *     执行）照单全收。token 是副机交出去的东西，假 hub 根本不验。
 *   - relay 模式更糟：副机的"在线"信号来自中继的 hello/node accepted，
 *     hub 在握手期对副机完全静默 —— 假中继接受 hello 后可以直接冒充 hub
 *     下发任务。SECURITY.md 里"中继可见明文帧"只是机密性问题，这一条是
 *     **身份 + 完整性**问题，且直接通向副机任意代码执行。
 *
 * 修法（本模块 + 协议扩展 + 副机验证，三处一起才闭环）：
 *   1. hub 生成持久 ed25519 身份密钥对，首次启动落盘（0600）；
 *   2. 握手时 hub 用私钥签一帧身份证明：指纹 + 公钥 + 签名 + 时间戳 +
 *      本次连接 nonce。direct 模式放进 welcome，relay 模式用
 *      hub/identity 帧主动补（上线信号不归 hub 发，只能追发）；
 *   3. 副机侧验签 + 指纹比对。指纹经配对码零终端分发，首连自动钉住
 *      （TOFU），之后不匹配即拒绝上线并大声报错。
 *
 * 为什么是 ed25519 而不是 HMAC / 预共享密钥：
 *   - 指纹必须能公开分发（配对码里人眼可见），公钥验证不需要副机持有
 *     任何秘密 —— 泄一个配对码不等于泄一把能冒充 hub 的钥匙；
 *   - hub 侧一把私钥对所有副机通用，不需要 per-node 预共享表；
 *   - node:crypto 原生支持，保持零外部依赖；
 *   - 签名确定性（RFC 8032）让黄金向量可以跨 Node 版本锁定字节。
 *
 * 指纹格式：`hubfp1-` + base64url(sha256(SPKI DER)[0:16])，共 22 字符。
 * 16 字节（128 bit）抗碰撞余量对"人眼核对 + 机器比对"双重场景足够，
 * 又短到能塞进配对码和终端里显示。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 签名载荷的上下文前缀。改它 = 协议变更，旧签名全部作废（有意为之）。 */
export const IDENTITY_CONTEXT = 'dsh-remote-agent/hub-identity/v1'
export const FINGERPRINT_PREFIX = 'hubfp1-'
/** 指纹取 sha256 的前 16 字节 → base64url 恰好 22 字符（无填充）。 */
const FP_BYTES = 16
/** hello/welcome 里 nonce 的字节数（hex 后 32 字符）。 */
export const NONCE_BYTES = 16
/** 身份文件格式版本。 */
export const IDENTITY_FILE_VERSION = 1
/** 身份文件名（落在 hub stateDir 下）。 */
export const IDENTITY_FILE_NAME = 'hub-identity.json'
/** 副机 TOFU 钉住文件名（落在副机 stateDir 下）。 */
export const HUB_PIN_FILE_NAME = 'hub-pin.json'

/* ───────────────────────────── 指纹 ───────────────────────────── */

/** 由 SPKI DER 公钥字节算指纹。 */
export function fingerprintOf(publicKeyDer) {
  const buf = Buffer.isBuffer(publicKeyDer) ? publicKeyDer : Buffer.from(publicKeyDer ?? '')
  if (buf.length === 0) return ''
  const digest = createHash('sha256').update(buf).digest()
  return FINGERPRINT_PREFIX + digest.subarray(0, FP_BYTES).toString('base64url')
}

/**
 * 归一化指纹：形态不对一律返回 ''（调用方按"没有指纹"处理）。
 * base64url 大小写敏感，不做大小写折叠 —— 折叠会让两个不同指纹相等。
 */
export function normalizeFingerprint(raw) {
  if (typeof raw !== 'string') return ''
  const s = raw.trim()
  if (!s.startsWith(FINGERPRINT_PREFIX)) return ''
  const body = s.slice(FINGERPRINT_PREFIX.length)
  if (!/^[A-Za-z0-9_-]{22}$/.test(body)) return ''
  return FINGERPRINT_PREFIX + body
}

/* ───────────────────────────── 密钥对 ───────────────────────────── */

/**
 * 生成一把新身份。返回 Base64url（DER）形态的持久化表示 + KeyObject。
 * KeyObject 只在内存里用；落盘的永远是可以 JSON 序列化的字符串。
 */
export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicDer = publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKeyB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKeyB64: publicDer.toString('base64url'),
    fingerprint: fingerprintOf(publicDer),
  }
}

/**
 * 把持久化表示还原成可签/可验的身份。
 * 任何字段缺失/损坏/指纹与公钥不符 → 返回 null（调用方决定重建还是报错）。
 */
export function importIdentity(stored) {
  if (!stored || typeof stored !== 'object') return null
  const priv = typeof stored.privateKeyB64 === 'string' ? stored.privateKeyB64 : ''
  const pub = typeof stored.publicKeyB64 === 'string' ? stored.publicKeyB64 : ''
  if (priv === '' || pub === '') return null
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(priv, 'base64url'), format: 'der', type: 'pkcs8' })
    const publicKey = createPublicKey({ key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' })
    const fp = fingerprintOf(publicKey.export({ format: 'der', type: 'spki' }))
    if (normalizeFingerprint(stored.fingerprint) !== fp) return null
    return { privateKey, publicKey, privateKeyB64: priv, publicKeyB64: pub, fingerprint: fp }
  } catch {
    return null
  }
}

/* ───────────────────────────── 签名 / 验签 ───────────────────────────── */

/** 每次连接一个新 nonce（hex）。副机放 hello 里，hub 签进身份帧。 */
export function newNonce() {
  return randomBytes(NONCE_BYTES).toString('hex')
}

/**
 * 签名载荷的规范化序列化。字段序固定 —— 换行分隔、无转义，
 * 任何一字段漂移都会让验签失败（fail-closed 方向，安全）。
 */
export function identitySignPayload({ fingerprint, nodeId, nonce, at }) {
  return [IDENTITY_CONTEXT, String(fingerprint ?? ''), String(nodeId ?? ''), String(nonce ?? ''), String(at ?? '')].join('\n')
}

/**
 * hub 侧：签一帧身份证明。返回 base64url 签名（ed25519 = 64 字节 → 86 字符）。
 * 抛错只可能是私钥形态坏了 —— 调用方（hub）按"身份不可用"降级。
 */
export function signIdentity(privateKeyB64, { fingerprint, nodeId, nonce, at }) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64url'), format: 'der', type: 'pkcs8' })
  const sig = edSign(undefined, Buffer.from(identitySignPayload({ fingerprint, nodeId, nonce, at }), 'utf8'), key)
  return sig.toString('base64url')
}

/**
 * 副机侧：验签。任何异常（公钥坏/签名坏/字段缺）一律 false，绝不抛。
 */
export function verifyIdentity(publicKeyB64, fields, sigB64) {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64 === '') return false
  if (typeof sigB64 !== 'string' || sigB64 === '') return false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64url'), format: 'der', type: 'spki' })
    return edVerify(
      undefined,
      Buffer.from(identitySignPayload(fields), 'utf8'),
      key,
      Buffer.from(sigB64, 'base64url'),
    )
  } catch {
    return false
  }
}

/* ───────────────────────────── 落盘 ───────────────────────────── */

/**
 * 收窄文件权限到「只有本人可读写」。
 *
 * 与 lib/relay-config.js 的同名函数同构（chmod 0600 + Windows icacls），
 * 这里不放公共模块是因为 relay-config.js 会拖进整条 relay 依赖链，
 * 而 hub/副机两侧只需要这 15 行。改动务必两边同步。
 */
export function restrictPermissions(target, { isDir = false } = {}) {
  try {
    fs.chmodSync(target, isDir ? 0o700 : 0o600)
  } catch {
    /* FAT/网络盘不支持 mode，忽略 */
  }
  if (process.platform !== 'win32') return
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME
  if (!user) return
  try {
    spawnSync(
      'icacls',
      [target, '/inheritance:r', '/grant:r', isDir ? `${user}:(OI)(CI)F` : `${user}:F`],
      { stdio: 'ignore', timeout: 5000, windowsHide: true },
    )
  } catch {
    /* icacls 不存在或被策略拦住：保持默认 ACL */
  }
}

/**
 * 原子写一个 JSON（tmp + rename，0600）。失败抛可读错误。
 * 导出给 lib/node/hub-pin.js 复用（副机 TOFU 钉住文件同一手法、同一口径）。
 */
export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  restrictPermissions(dir, { isDir: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 })
    restrictPermissions(tmp)
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不影响报错 */
    }
    throw new Error(`写入身份文件失败：${file}（${err.message}）`)
  }
  restrictPermissions(file)
}

/**
 * hub 侧：读身份文件，没有/损坏就地重建。
 *
 * 三条语义：
 *   1. 合法 → 原样返回（含 KeyObject），`created:false`；
 *   2. 不存在 → 生成新的并落盘，`created:true`；
 *   3. 存在但损坏 → **重建并覆盖**。这与 relay 的 tokens.json（损坏就抛错
 *      等人修）不同，是刻意的：hub 身份重建后，所有已钉住指纹的副机会在
 *      下次握手时**大声失败**——安全方向是 fail-closed，不会静默接受一个
 *      新身份。而"hub 因为一个磁盘坏字节起不来"的可用性代价不可接受。
 *
 * 磁盘完全不可写时不抛：返回纯内存身份（hub 本次运行仍可认证，重启后
 * 换身份 —— 副机会再次大声失败，可感知）。
 */
export function loadOrCreateHubIdentity(file) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('loadOrCreateHubIdentity: file 必须是非空路径')
  }
  const target = path.resolve(file)
  if (fs.existsSync(target)) {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch {
      parsed = null
    }
    const imported = importIdentity(parsed)
    if (imported) {
      restrictPermissions(target)
      return { ...imported, file: target, created: false }
    }
  }
  const fresh = generateIdentity()
  try {
    writeJsonAtomic(target, {
      version: IDENTITY_FILE_VERSION,
      ...fresh,
      createdAt: new Date().toISOString(),
    })
  } catch {
    /* 落盘失败见上：内存身份照用 */
  }
  const imported = importIdentity(fresh)
  return { ...imported, file: target, created: true }
}

/** 只读身份（setup 向导/探活用）：不创建、不写盘。损坏或缺失 → null。 */
export function readHubIdentity(file) {
  if (typeof file !== 'string' || file.trim() === '') return null
  try {
    if (!fs.existsSync(file)) return null
    const imported = importIdentity(JSON.parse(fs.readFileSync(file, 'utf8')))
    return imported ? { ...imported, file: path.resolve(file) } : null
  } catch {
    return null
  }
}
