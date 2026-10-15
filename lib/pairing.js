/**
 * 配对码（pairing code）：把「副机要抄的连接信息」压缩成一行可粘贴的串。
 *
 * 解决的问题：小白部署时最容易抄错的就是 hubUrl / token 这两行 ——
 * 少半个斜杠、token 尾部多个空格，表现都是"副机永远不上线"且无报错。
 * 配对码让主机向导输出**一行** `dshra1://…`，副机配置里粘一个 `pair:` 字段
 * 就完成连接配置（roots 仍然由副机自己声明 —— 它是副机的安全边界，
 * 不能由主机侧的串决定）。
 *
 * 格式：`dshra1://` + base64url(JSON)。选择理由：
 *   - base64url 字符集（A-Za-z0-9_-）不含 YAML/JSON 特殊字符，粘贴安全；
 *   - 带 `://` 看起来像一个链接，用户知道"这是一整段，别抄一半"；
 *   - 版本号 v 在载荷里，未来改格式能平滑识别旧码。
 *
 * 安全注意：**配对码里含 token，等同凭证**。文档要求只通过可信渠道
 * （当面/加密聊天）传给副机，不要贴公开群里。
 *
 * 纯函数、零依赖、永不抛 —— 解析失败一律返回结构化错误，让人话修法
 * 能一路带到向导 / doctor / worker 日志三个出口。
 */

export const PAIR_SCHEME = 'dshra1://'
/** 配对码长度上限：正常载荷 <300 字符，上限只防病态粘贴。 */
const MAX_PAIR_LENGTH = 4096
/** 载荷里允许出现的字段（多余字段忽略，防止未来字段变成注入面）。 */
const PAYLOAD_KEYS = ['v', 'transportMode', 'hubUrl', 'relayUrl', 'token', 'nodeId', 'hubFingerprint']
/**
 * hub 指纹（P2-11）。与 lib/identity.js 的 normalizeFingerprint 同形 ——
 * 刻意不 import：pairing 必须保持零 Node 内置模块依赖（client 的 web 包
 * 也走这里，identity.js 里的 fs/child_process 进不了浏览器）。两处改一处必同步。
 */
const HUB_FINGERPRINT_RE = /^hubfp1-[A-Za-z0-9_-]{22}$/
/** 与 protocol.validateHello / lib/setup.js NODE_ID_RE 一致。 */
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 生成配对码。输入任意垃圾字段都安全（非法值直接不放进载荷）。
 * @param {object} o
 * @param {string} [o.hubUrl] direct 模式拨入地址（与 relayUrl 至少给一个）
 * @param {string} [o.relayUrl] relay 模式会合地址
 * @param {string} [o.token] 入网 token（可空 —— 仅限可信内网）
 * @param {string} [o.nodeId] 建议副机使用的节点 id
 * @returns {string} `dshra1://...`；输入不足（连地址都没有）时返回 ''
 */
export function encodePairCode({ hubUrl = '', relayUrl = '', token = '', nodeId = '', hubFingerprint = '' } = {}) {
  const payload = { v: 1 }
  const mode = relayUrl && !hubUrl ? 'relay' : 'direct'
  if (mode === 'relay' && cleanStr(relayUrl) !== '') {
    payload.transportMode = 'relay'
    payload.relayUrl = cleanStr(relayUrl)
  } else if (cleanStr(hubUrl) !== '') {
    payload.hubUrl = cleanStr(hubUrl)
  } else {
    return '' // 没有任何地址，无法构成有效配对码
  }
  if (cleanStr(token) !== '') payload.token = cleanStr(token)
  if (cleanStr(nodeId) !== '' && NODE_ID_RE.test(cleanStr(nodeId))) payload.nodeId = cleanStr(nodeId)
  // hub 指纹（P2-11）：副机展开配对码时自动变成 pinnedHubFingerprint（TOFU 钉住）。
  // 形态不对就整个不放进去 —— 载荷里永远只有合法字段。
  if (cleanStr(hubFingerprint) !== '' && HUB_FINGERPRINT_RE.test(cleanStr(hubFingerprint))) {
    payload.hubFingerprint = cleanStr(hubFingerprint)
  }
  const json = JSON.stringify(payload)
  return PAIR_SCHEME + Buffer.from(json, 'utf8').toString('base64url')
}

/**
 * 解析配对码。容错：首尾空白、中间换行（终端复制常见）、成对引号。
 * @returns {{ok:true, payload:object}|{ok:false, error:string}}
 *   error 是给人看的中文（向导 / doctor 直接展示）。
 */
export function decodePairCode(raw) {
  let s = cleanStr(raw)
  if (s === '') return { ok: false, error: '配对码为空 —— 请把主机向导输出的 dshra1:// 整行完整粘贴进来' }
  // 去掉粘贴时裹上的成对引号（YAML/聊天软件常见）
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1).trim()
  }
  // 中间的换行/制表是"复制时被折行"的典型形态，拼接回来
  s = s.replace(/[\r\n\t]+/g, '')
  if (s.length > MAX_PAIR_LENGTH) {
    return { ok: false, error: `配对码过长（>${MAX_PAIR_LENGTH} 字符）—— 疑似粘错了内容，请重新复制主机输出的 dshra1:// 整行` }
  }
  if (!s.toLowerCase().startsWith(PAIR_SCHEME)) {
    return { ok: false, error: `不是配对码 —— 配对码以 ${PAIR_SCHEME} 开头（地址请填在 hubUrl 字段，两者别混）` }
  }
  const b64 = s.slice(PAIR_SCHEME.length)
  if (b64 === '' || !/^[A-Za-z0-9_-]+$/.test(b64)) {
    return { ok: false, error: '配对码内容不完整 —— 只含字母数字和 - _ 才是合法的 dshra1 码，请从主机重新完整复制' }
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, error: '配对码解析不了（内容被截断或改过）—— 请回主机向导重新生成，整行复制' }
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: '配对码内容不是有效的 dshra1 载荷 —— 请回主机向导重新生成' }
  }
  if (payload.v !== 1) {
    return { ok: false, error: `配对码版本不受支持（v=${payload.v}）—— 请把两边的 dsh-remote-agent 都升级到同一版本` }
  }
  // 只保留白名单字段（ignore 未来新增字段，保证旧版本可读性）
  const clean = {}
  for (const k of PAYLOAD_KEYS) {
    if (payload[k] !== undefined) clean[k] = payload[k]
  }
  const mode = clean.transportMode === 'relay' ? 'relay' : 'direct'
  if (mode === 'relay') {
    if (cleanStr(clean.relayUrl) === '') {
      return { ok: false, error: '配对码是 relay 模式但缺 relayUrl —— 请回主机向导重新生成' }
    }
    clean.transportMode = 'relay'
    clean.hubUrl = undefined
  } else {
    if (cleanStr(clean.hubUrl) === '') {
      return { ok: false, error: '配对码里没有主机地址 —— 请回主机向导重新生成' }
    }
    clean.transportMode = undefined
    clean.relayUrl = undefined
  }
  if (clean.token !== undefined && typeof clean.token !== 'string') {
    return { ok: false, error: '配对码里的 token 字段损坏 —— 请回主机向导重新生成' }
  }
  if (clean.nodeId !== undefined && (typeof clean.nodeId !== 'string' || !NODE_ID_RE.test(clean.nodeId))) {
    return { ok: false, error: '配对码里的 nodeId 不合法 —— 请回主机向导重新生成' }
  }
  if (clean.hubFingerprint !== undefined) {
    if (typeof clean.hubFingerprint !== 'string' || !HUB_FINGERPRINT_RE.test(clean.hubFingerprint.trim())) {
      return { ok: false, error: '配对码里的 hubFingerprint 不合法 —— 请回主机向导重新生成' }
    }
    clean.hubFingerprint = clean.hubFingerprint.trim()
  }
  // undefined 字段不进最终载荷（JSON.stringify 会丢，这里手动保持一致）
  for (const k of Object.keys(clean)) {
    if (clean[k] === undefined) delete clean[k]
  }
  return { ok: true, payload: clean }
}

/**
 * 把配置里的 `pair` 字段展开成具体的连接字段。
 *
 * 规则：
 *   - **显式配置优先** —— 用户手写了 hubUrl/token/nodeId 就不覆盖（配对码
 *     只是"默认值包"，不是强覆盖；方便临时换地址调试）。
 *   - 展开成功后从结果里删掉 `pair` 键（避免 token 在配置对象里存两份）。
 *   - **永不抛**：pair 缺失/无效时原样返回 config 并给出 error，让调用方
 *     （worker 启动路径）只降级不炸。
 *
 * @param {object} config worker 的原始 config（容错：null/undefined 均可）
 * @returns {{config:object, error:string}} error 为 '' 表示展开成功或本无 pair
 */
export function expandPairConfig(config) {
  const src = isPlainObject(config) ? config : {}
  const pairRaw = cleanStr(src.pair)
  if (pairRaw === '') return { config: { ...src }, error: '' }
  const dec = decodePairCode(pairRaw)
  if (!dec.ok) return { config: { ...src }, error: dec.error }
  const p = dec.payload
  const out = { ...src }
  delete out.pair
  const fill = (key, value) => {
    if (value !== undefined && cleanStr(out[key]) === '') out[key] = value
  }
  if (p.transportMode === 'relay') {
    out.transportMode = out.transportMode === 'relay' ? out.transportMode : (cleanStr(out.transportMode) === '' ? 'relay' : out.transportMode)
    fill('relayUrl', p.relayUrl)
  } else {
    fill('transportMode', 'direct')
    fill('hubUrl', p.hubUrl)
  }
  fill('token', p.token)
  fill('nodeId', p.nodeId)
  // P2-11：指纹随码分发 → 副机零终端完成"连接配置 + hub 身份钉住"两件事。
  fill('pinnedHubFingerprint', p.hubFingerprint)
  return { config: out, error: '' }
}
