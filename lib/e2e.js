/**
 * 中继链路端到端加密（提案 #1，零外部依赖，node:crypto）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 解决什么问题
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * relay 模式下中继是 hub 与副机之间的全部流量路径，而中继部署在 VPS 上 ——
 * VPS 提供商（以及任何拿到中继机器权限的人）默认能看到**全部明文业务帧**：
 * 任务目标（goal 常含仓库/路径/命令）、handoff 摘要、产物分块字节。
 * wss:// 只保护 hub/副机到中继的两跳，中继本身终结 TLS。
 *
 * 修法：hub 与副机在业务层自己协商一把对称会话密钥，中继只转发密文。
 * 密钥交换复用 P2-11 已建立的身份链：
 *   - hub 用持久 ed25519 身份**签名**自己的 X25519 临时公钥（副机按钉住的
 *     指纹验证 —— 假 hub 签不出来）；
 *   - 签名同时绑定副机的临时公钥哈希（hub 没和"副机以为的那把钥匙"做交换
 *     时，副机立刻拒收 —— 中继偷换公钥只会得到一条死连接）；
 *   - 双方各出一把**一次性** X25519 密钥 → ECDH → HKDF → AES-256-GCM。
 *     会话结束密钥即弃，ed25519 身份永远不参与对称密钥推导
 *     （身份钥日后泄露也解不开历史流量，前向保密）。
 *
 * ── 中继零改动 ────────────────────────────────────────────────────────────
 *
 * 密文只藏在帧的 `d` 字段（文本帧）或净荷（二进制帧）里，信封的
 * `t / id / to / from` 全部保持明文 —— 中继的路由逻辑一行不改：
 * 它本来就不解密业务帧。旧中继 / 旧对端收不到自己不认识的帧类型时按
 * 未知帧忽略（混跑安全），协商不成就自动退回明文（见各端兼容矩阵）。
 *
 * ── 已知边界（诚实披露，详见 SECURITY.md）────────────────────────────────
 *
 *   - **主动降级**：恶意中继扣下 node/e2e 握手帧可以让链路退回明文。
 *     副机会在超时后打一条警告日志（这是 v1 的已知局限，彻底关闭需要
 *     副机持久身份 + hub 侧强制策略，是另一个提案的体量）。
 *   - **副机到 hub 的认证仍靠 enrollToken**：中继运营者本就持有 enrollToken
 *     （它部署在中继配置里），可以伪造一个假 nodeId 向 hub 上线 —— 这不是
 *     E2E 要解的问题，E2E 解的是"它看不见流量"。
 *
 * 帧格式：
 *   文本帧   frame.d = { e2e:1, seq, iv, ct }      （t/id/v/to/from 保持明文）
 *   二进制帧 header = { t, e2e:1, seq, iv }        （净荷 = GCM(inner frame)）
 * AAD 绑定 [context, 方向, t, id, seq] —— 偷换帧类型 / 重放旧帧 / 乱序注入
 * 都会在 GCM 校验或序号检查处失败（fail-closed）。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto'
import { decodeBinaryFrame, encodeBinaryFrame } from './protocol.js'

/** 签名载荷与 HKDF info 共用的上下文前缀。改动 = 协议变更，旧会话全部作废。 */
export const E2E_CONTEXT = 'dsh-remote-agent/relay-e2e/v1'
/** 加密帧的标记值（frame.d.e2e / header.e2e）。 */
export const E2E_MARKER = 1
/** GCM IV 字节数（96 bit，NIST 对 AES-GCM 的推荐值）。 */
const IV_BYTES = 12
/** 会话密钥字节数（AES-256）。 */
const KEY_BYTES = 32
/** X25519 原始公钥字节数。 */
const X2_PUB_BYTES = 32

/** 帧方向标签：进 AAD，防两个方向的密文互换使用。 */
const DIR_N2H = 'n2h'
const DIR_H2N = 'h2n'

/* ─────────────────────────── 临时密钥对 ─────────────────────────── */

/**
 * 生成一把一次性 X25519 密钥对。
 * 返回 base64url（原始 32 字节）形态 —— 线上传输与签名的都是这个形态；
 * KeyObject 只在内存里短暂存在，会话建立即弃。
 */
export function generateEphemeral() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const pubJwk = publicKey.export({ format: 'jwk' })
  const privJwk = privateKey.export({ format: 'jwk' })
  return {
    privateKeyB64: String(privJwk.d),
    publicKeyB64: String(pubJwk.x),
  }
}

/** 校验一个线上 X25519 公钥（43 字符 base64url = 32 字节）。失败返回 ''。 */
export function normalizeE2EPub(raw) {
  if (typeof raw !== 'string') return ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return ''
  if (Buffer.from(raw, 'base64url').length !== X2_PUB_BYTES) return ''
  return raw
}

/**
 * X25519 PKCS#8 私钥的 DER 前缀（16 字节）。
 *
 * 结构：SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 (X25519) },
 *                OCTET STRING { OCTET STRING(32 字节原始标量) } }
 * 后接 32 字节标量即完整私钥。
 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

/**
 * 由 base64url 的 32 字节标量构造 X25519 私钥。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠ 为什么用 DER 而不是 JWK（2026-10-20 CI 抓到的真实缺陷）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原实现：`createPrivateKey({ key: { kty:'OKP', crv:'X25519', d: b64, x: '' }, format:'jwk' })`
 *
 * 在本地 Node 24.18 上能过，但在 GitHub Actions 的 `ubuntu-latest / node 24.x`
 * 上抛 **`ERR_CRYPTO_INVALID_JWK`** —— 那个版本对 JWK 的 `x` 校验更严
 * （空串不是合法 base64url；省略 `x` 同样被拒）。
 *
 * 后果很隐蔽：E2E 握手失败 → 测试只看到
 * `timeout waiting for e2e session on test-worker`，**真因被完全掩盖**。
 *
 * ── 修法 ────────────────────────────────────────────────────────────────
 *
 * 直接用 **DER** 构造：X25519 私钥的 PKCS#8 就是固定 16 字节前缀 + 32 字节
 * 标量。这条路径**不经过 JWK 校验**，跨 Node 小版本稳定。
 *
 * 实测验证：DER 构造出的私钥导出的公钥 `x` 与原始 JWK 完全一致，
 * 且 DH 协商结果与正常生成的密钥对一致。
 */
function x2PrivateKeyFromB64(b64) {
  const raw = Buffer.from(String(b64), 'base64url')
  if (raw.length !== X2_PUB_BYTES) {
    throw new Error(`bad x25519 private key length: ${raw.length} (expect ${X2_PUB_BYTES})`)
  }
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}

function x2PublicKeyFromB64(b64) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64 }, format: 'jwk' })
}

/* ─────────────────────────── 密钥协商 ─────────────────────────── */

/**
 * 由双方临时公钥 + 本方私钥派生 AES-256-GCM 会话密钥。
 *
 * salt 绑定双方公钥（域分离：同一把私钥和不同对端协商出不同密钥）；
 * info 绑定上下文前缀。nodePub / hubPub 的顺序由角色决定，双方必然一致。
 *
 * @param {object} o
 * @param {'node'|'hub'} o.role 本方角色（决定 AAD 方向标签）
 * @param {string} o.ownPrivB64 本方 X25519 私钥（base64url 原始 32 字节）
 * @param {string} o.peerPubB64 对方 X25519 公钥
 * @param {string} o.nodePubB64 副机侧公钥（salt 用）
 * @param {string} o.hubPubB64 hub 侧公钥（salt 用）
 * @returns {{key: Buffer, dir: {send: string, recv: string}}}
 */
export function deriveSessionKey({ role, ownPrivB64, peerPubB64, nodePubB64, hubPubB64 }) {
  const shared = diffieHellman({
    privateKey: x2PrivateKeyFromB64(ownPrivB64),
    publicKey: x2PublicKeyFromB64(peerPubB64),
  })
  // 全零共享密钥（X25519 小子群/低阶点输入）按约定丢弃 —— RFC 7748 §6.1。
  if (shared.every((b) => b === 0)) {
    throw new Error('e2e key agreement produced all-zero shared secret (low-order peer key?)')
  }
  const salt = createHash('sha256')
    .update(Buffer.from(nodePubB64, 'base64url'))
    .update(Buffer.from(hubPubB64, 'base64url'))
    .digest()
  const key = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(E2E_CONTEXT, 'utf8'), KEY_BYTES))
  const dir = role === 'node' ? { send: DIR_N2H, recv: DIR_H2N } : { send: DIR_H2N, recv: DIR_N2H }
  return { key, dir }
}

/* ─────────────────────────── 交换帧签名 ─────────────────────────── */

/**
 * hub/identity 链对密钥交换帧的签名载荷。字段序固定（与 identity.js 同风格），
 * 任何漂移都会让验签失败（fail-closed 方向）。
 *
 * peerHash 绑定**对端**的临时公钥：hub 签的是"我确实和这把副机公钥做了交换"，
 * 中继偷换任意一侧公钥都会让另一端验签失败。
 */
export function exchangeSignPayload({ fingerprint, nodeId, nonce, pub, peerPub, at }) {
  return [
    E2E_CONTEXT,
    String(fingerprint ?? ''),
    String(nodeId ?? ''),
    String(nonce ?? ''),
    String(pub ?? ''),
    createHash('sha256').update(Buffer.from(String(peerPub ?? ''), 'base64url')).digest('base64url'),
    String(at ?? ''),
  ].join('\n')
}

/** hub 侧：签一帧密钥交换证明（ed25519，身份钥与 identity.js 同一把）。 */
export function signExchange(privateKeyB64, fields) {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64url'), format: 'der', type: 'pkcs8' })
  const sig = edSign(undefined, Buffer.from(exchangeSignPayload(fields), 'utf8'), key)
  return sig.toString('base64url')
}

/** 副机侧：验签。任何异常一律 false，绝不抛。 */
export function verifyExchange(publicKeyB64, fields, sigB64) {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64 === '') return false
  if (typeof sigB64 !== 'string' || sigB64 === '') return false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64url'), format: 'der', type: 'spki' })
    return edVerify(
      undefined,
      Buffer.from(exchangeSignPayload(fields), 'utf8'),
      key,
      Buffer.from(sigB64, 'base64url'),
    )
  } catch {
    return false
  }
}

/* ─────────────────────────── 会话 ─────────────────────────── */

/** b64url 便捷封装。 */
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => (Buffer.isBuffer(s) ? Buffer.from(s) : Buffer.from(String(s), 'base64url'))

/**
 * 一条已协商的加密会话。双向独立序号， seal/open 都是有状态的。
 *
 * 序号语义：发送侧每封一帧 ++sendSeq；接收侧要求帧内 seq === recvSeq+1
 * （WS 是有序可靠传输，任何跳跃/重放/乱序都是伪造或实现 bug —— 一律拒绝）。
 * 会话随连接生死：重连 = 新临时密钥 = 新会话（序号从 0 重新计）。
 */
export class E2ESession {
  /** @param {{key: Buffer, dir: {send: string, recv: string}}} d deriveSessionKey 的返回值 */
  constructor(d) {
    this.key = d.key
    this.dir = d.dir
    this.sendSeq = 0
    this.recvSeq = 0
    this.destroyed = false
  }

  _aad(dir, type, id, seq) {
    return Buffer.from([E2E_CONTEXT, dir, String(type), String(id), String(seq)].join('\n'), 'utf8')
  }

  _seal(dir, type, id, seq, plaintext) {
    if (this.destroyed) throw new Error('e2e session destroyed')
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 })
    cipher.setAAD(this._aad(dir, type, id, seq))
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    return { iv: b64u(iv), ct: b64u(ct) }
  }

  _open(dir, type, id, seq, ivB64, ctB64) {
    if (this.destroyed) throw new Error('e2e session destroyed')
    if (!Number.isInteger(seq) || seq <= this.recvSeq) {
      throw new Error(`e2e sequence mismatch: got ${seq}, expected ${this.recvSeq + 1} (replay or desync?)`)
    }
    const iv = unb64u(ivB64)
    const body = unb64u(ctB64)
    if (iv.length !== IV_BYTES || body.length < 16) throw new Error('e2e frame malformed')
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 })
    decipher.setAAD(this._aad(dir, type, id, seq))
    decipher.setAuthTag(body.subarray(body.length - 16))
    const pt = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
    this.recvSeq = seq
    return pt
  }

  /**
   * 封一个文本业务帧的 d 字段。
   * @returns {{e2e: number, seq: number, iv: string, ct: string}}
   */
  sealFrame(type, id, data) {
    this.sendSeq += 1
    const { iv, ct } = this._seal(this.dir.send, type, id, this.sendSeq, Buffer.from(JSON.stringify(data ?? {}), 'utf8'))
    return { e2e: E2E_MARKER, seq: this.sendSeq, iv, ct }
  }

  /**
   * 拆一个文本业务帧的 d 字段。认证/序号失败抛错 —— 调用方丢帧并记日志。
   * @returns {object} 原始 d
   */
  openFrame(type, id, env) {
    if (!env || env.e2e !== E2E_MARKER) throw new Error('not an e2e frame')
    const pt = this._open(this.dir.recv, type, id, env.seq, env.iv, env.ct)
    const d = JSON.parse(pt.toString('utf8'))
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('e2e payload not an object')
    return d
  }

  /**
   * 封一个二进制帧：内层完整帧（header+payload）整体作为明文，
   * 外层 header 只留路由必需的 t 与加密标记。
   * @returns {{header: object, payload: Buffer}}
   */
  sealBinary(type, header, payload) {
    this.sendSeq += 1
    const inner = encodeBinaryFrame(header ?? {}, payload ?? Buffer.alloc(0))
    const { iv, ct } = this._seal(this.dir.send, type, '', this.sendSeq, inner)
    return { header: { t: type, e2e: E2E_MARKER, seq: this.sendSeq, iv }, payload: Buffer.from(ct, 'base64url') }
  }

  /**
   * 拆一个二进制帧。返回内层 {header, payload}。
   * @returns {{header: object, payload: Buffer}}
   */
  openBinary(type, header, payload) {
    if (!header || header.e2e !== E2E_MARKER) throw new Error('not an e2e binary frame')
    const inner = this._open(this.dir.recv, type, '', header.seq, header.iv, payload)
    const dec = decodeBinaryFrame(inner)
    if (!dec.ok) throw new Error(`e2e inner binary frame malformed: ${dec.error}`)
    return { header: dec.header, payload: dec.payload }
  }

  /** 丢弃密钥材料（重连/卸载时调用）。调用后本会话不可再用。 */
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.key.fill(0)
  }
}

/**
 * 便捷构造：由本方私钥 + 对端公钥建会话。
 * @param {object} o
 * @param {'node'|'hub'} o.role
 * @param {string} o.ownPrivB64
 * @param {string} o.peerPubB64
 * @param {string} o.nodePubB64 副机侧公钥
 * @param {string} o.hubPubB64 hub 侧公钥
 */
export function createSession({ role, ownPrivB64, peerPubB64, nodePubB64, hubPubB64 }) {
  return new E2ESession(deriveSessionKey({ role, ownPrivB64, peerPubB64, nodePubB64, hubPubB64 }))
}
