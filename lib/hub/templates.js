/**
 * 任务模板库（配方）—— hub 本地 JSON 存储，零外部依赖。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么模板要"存 hub 本地文件"，而不是别的任何地方
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 模板的全部内容是**任务参数的预设**（goal / workspace / model / outputs…），
 * 其中 workspace 是副机上的绝对路径、model 是"副机该用哪个模型"。这两样都属于
 * **本机部署信息**：
 *   - 送上云 = 把用户的目录结构与模型选择交给第三方（与"无运营方"的定位相反）
 *   - 存副机 = 换一台副机模板就废了（模板描述的是"hub 想怎么派活"）
 * 所以它跟 hub 身份文件一样，落在 hub 的状态目录下，路径可配置。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须白名单 + 校验（这不是"防御性编程"，是边界本身）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 模板会被面板表单**直接回填**成 `/dispatch` 的请求体 —— 也就是说，一条模板
 * 等价于一份"预置好的 remote_task 参数"。如果模板能带任意字段，它就绕过了
 * `/dispatch` 与 `validateTaskStart` 那道收口，成为**往任务规格里注入字段的
 * 通道**（今天注入一个被忽略的字段，明天协议新增一个字段就自动生效）。
 *
 * 所以本文件的策略是：
 *   - **写入严格**：出现未知字段直接拒绝（不静默丢弃 —— 静默丢弃会让"我明明
 *     存了 denyPaths"这种误解一直存在，直到某天真的用错）。
 *   - **读取宽容**：手工编辑过的文件里，未知键**忽略**、坏条目**丢弃**。
 *     理由不对称是刻意的：读路径的失败模式是"一个手滑的键让整个库消失"，
 *     那比"少一条模板"严重得多。
 *   - 长度/数量/枚举/数值范围全部有上限，且**每一条都对应一个消费方**：
 *     goal 进任务书、workspace 进 roots 校验、timeoutMs 进约束、outputs 进 glob。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 三类必须处理的文件状态（实测都会遇到）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. **文件不存在** —— 首次使用的正常状态。list() 回空数组，且**不创建**文件
 *      （不因为"面板打开过"就在用户磁盘上留东西）。
 *   2. **内容损坏** —— 断电、手工编辑写坏、磁盘满写了一半。降级为空库 +
 *      `degraded` 标记，**绝不抛**：模板库坏掉不该让面板的派发功能一起坏。
 *      恢复路径是下一次 save 就地覆盖（写的是完整新内容）。
 *   3. **并发写** —— 面板可以连点两下"保存"。所有写操作走同一条 Promise 队列
 *      串行化，且落盘用**原子写**（写临时文件 → rename）。rename 在同一文件系统
 *      内是原子的，所以任何时刻读到的都是"完整的旧内容"或"完整的新内容"，
 *      不存在半截 JSON。这也让**读操作不必排队**（见 list()）。
 *
 * ── 与别处的口径对齐 ────────────────────────────────────────────────────
 *   · 目录/文件名与 hub 身份文件同目录同风格（见 lib/hub/index.js 的 stateDir）
 *   · 文件模式 0600、原子写 tmp→rename 与 lib/node/task-store.js 同一套做法
 *   · mode 与 model 的归一化**复用 lib/protocol.js**，不另起一套 —— 否则
 *     "模板里合法的 model"与"派发时合法的 model"会漂移成两个定义
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { TASK_MODE, normalizeModelSelection } from '../protocol.js'

/** 默认文件名。与 hub-identity.json 同目录（hub 的状态目录）。 */
export const TEMPLATES_FILE_NAME = 'templates.json'

/** 文件格式版本。写成对象而不是裸数组，是为了将来加字段时不用改解析分支。 */
export const TEMPLATES_FORMAT_VERSION = 1

/**
 * 模板数量上限。
 *
 * 为什么是 50：面板是一个下拉框，超过几十条就不可能有"一键选到常用那条"的
 * 体验了；而每条模板的 goal 上限 2000 字符，50 条最多 100KB —— 一次读写的
 * 开销可控。上限的存在同时也是**磁盘配额**意义上的收口：没有它，一个脚本
 * 循环 save 就能把 hub 状态目录填满。
 */
export const MAX_TEMPLATES = 50

/**
 * 各字段上限。
 *
 * 每个数字都对应一个真实消费方，不是随手取的"看起来合理"：
 *   - MAX_GOAL_LEN 2000：面板的 textarea 是给人手写的，超过它就该拆成模板
 *   - MAX_WORKSPACE_LEN 500：Windows 的 MAX_PATH 是 260，但长路径（\\?\）
 *     与深层 node_modules 路径会远超它；500 是"能装下真实路径又不至于被
 *     塞进一整段文本"
 *   - MAX_OUTPUTS 32：一条任务的产物 glob 超过 32 个说明该用 `**` 收敛，
 *     而不是列清单（列清单的维护成本远高于通配）
 *   - MAX_MODEL_FIELD_LEN 128：与 lib/protocol.js 的 normalizeModelSelection
 *     同口径（那里 model 截到 128、provider 截到 64）
 */
export const MAX_ID_LEN = 64
export const MAX_NAME_LEN = 60
export const MAX_GOAL_LEN = 2000
export const MAX_WORKSPACE_LEN = 500
export const MAX_MODEL_LEN = 160
export const MAX_MODEL_FIELD_LEN = 128
export const MAX_OUTPUTS = 32
export const MAX_OUTPUT_LEN = 200
/** 最小/最大超时。下限与 validateTaskStart 的夹取下限一致（1000ms）。 */
export const MIN_TIMEOUT_MS = 1000
/** 24 小时。比它更长就不是"任务"，而是常驻进程了（该用别的手段）。 */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * 原子写的 rename 重试参数（**Windows 专用路径**，见 atomicWriteJson 的说明）。
 *
 * 指数退避 10/20/40/80/160/200… 封顶 200ms，10 次 ≈ 总等待 1.3s。
 * 最初是 6 次 × 10ms 线性（总 210ms），本地与常规 CI 都绿，但 GitHub 的
 * windows-latest runner 在高峰期调度抖动大：测试里的紧循环读者可以近乎
 * 连续地占着目标文件，rename 被饿过整个 210ms 窗口 → EPERM 逃逸
 * （run 38894088627 实录）。生产读者的读窗口同样是几毫秒级，加宽到
 * ~1.3s 只影响"目标文件被别人持续锁死"这种异常场景，正常路径仍然
 * 前两次短退避就成功。仍是有界的：超时即抛，让上层报错而不是无限转圈。
 *
 * ── 2026-10-17 第二次加宽（run 39012045381，第 5 次 EPERM）──────────────
 *
 * 1.3s 仍不够。那个 run 的失败形态是：**测试自身在并发写同一个文件**
 * （`原子写：并发写 + 并发读` 用例），多个 rename 互相争抢目标 ——
 * 而 Windows 的 rename 覆盖"正被另一个 rename 短暂锁住"的目标时给 EPERM。
 * CI runner 的磁盘在高峰期延迟抖动可以到秒级。
 *
 * 所以：
 *   · 总窗口拉到 **~6s**（16 次，封顶 500ms）—— 仍是有界的，且只在
 *     "目标被持续锁死"的异常路径上才会走满；正常路径第 1 次就成功。
 *   · 最后一次尝试前做一次 **unlink 兜底**：Windows 上"删掉目标再 rename"
 *     能绕开"目标存在且被锁"的 EPERM（POSIX 上 rename 本来就覆盖，
 *     这一步只在 Windows 且前面的重试全失败时才走，不影响原子性语义 ——
 *     删除与 rename 之间读方会看到 ENOENT，所以**只在前 15 次全失败后**
 *     才做，把它当最后手段而不是常规路径）。
 */
const RENAME_RETRIES = 16
const RENAME_BACKOFF_MS = 10
const RENAME_BACKOFF_MAX_MS = 500
/** 第几次尝试开始走 unlink 兜底（0 基；= RENAME_RETRIES - 1 即最后一次）。 */
const RENAME_UNLINK_FALLBACK_AT = RENAME_RETRIES - 1

/**
 * 可写字段白名单。
 *
 * `id` 在列表里但语义不同：它是**更新已有模板**的寻址键（见 save），
 * 不存在时由服务端生成，客户端不能自定义一个任意 id（那会让"删除"变成
 * 可以猜的地址）。
 */
export const TEMPLATE_FIELDS = Object.freeze([
  'id',
  'name',
  'goal',
  'mode',
  'workspace',
  'model',
  'outputs',
  'timeoutMs',
])

/**
 * 可选字段：坏值只丢该字段，不牵连整条记录（见 projectRecord）。
 *
 * 这三个之外的字段都是**必需**的（id / name / goal / mode）—— 缺了它们
 * 记录就没有意义，所以读路径直接丢弃整条。
 */
const TEMPLATE_OPTIONAL_FIELDS = Object.freeze(['workspace', 'model', 'outputs', 'timeoutMs'])

const ALLOWED_FIELD_SET = new Set(TEMPLATE_FIELDS)
const MODEL_FIELD_SET = new Set(['provider', 'model', 'reasoningEffort'])

/**
 * hub 状态目录的默认值。
 *
 * 与 `lib/hub/index.js` 的 `defaultHubStateDir()` 同口径（homedir 不可用退 tmp）。
 * 为什么不反向 import：那个函数是 index.js 的私有实现，而 index.js 是 hub 的
 * 装配入口（import 它会成环，且把"叶子"绑死在装配层上）。本包对这种"必须持
 * 一份拷贝"的情况有先例（见 hub-util.js 的 numOr 说明）——这里把差异点写在
 * 注释里，比制造一个环更安全。
 */
function defaultStateDir() {
  try {
    return path.join(os.homedir(), '.dsh-remote-agent')
  } catch {
    return path.join(os.tmpdir(), '.dsh-remote-agent')
  }
}

/**
 * 解析模板文件的绝对路径。
 *
 * @param {string} [stateDir] hub 的状态目录（config.stateDir）。空则用默认目录。
 * @returns {string} 绝对路径
 */
export function defaultTemplatesFile(stateDir) {
  const dir = typeof stateDir === 'string' && stateDir.trim() !== ''
    ? path.resolve(stateDir.trim())
    : defaultStateDir()
  return path.join(dir, TEMPLATES_FILE_NAME)
}

/** 生成模板 id。前缀 + 时间戳 + 随机段：可读、单调、不可猜。 */
export function newTemplateId() {
  return `tpl_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
}

/** 错误文本（与 hub-util.js 的 errText 同义；叶子不反向 import）。 */
function errText(err) {
  return String(err?.message ?? err ?? 'unknown error')
}

/** 丢掉 undefined 的字段：模板 JSON 该是"人可读的配方"，不是一堆空占位。 */
function compact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 校验 + 归一化一条**来自外部**（面板 / 手写文件）的模板输入。
 *
 * 严格模式：未知字段、类型不对、超长、越界一律返回错误对象，**不静默修正**。
 * 静默修正的代价是"用户以为存进去了"——例如把 denyPaths 悄悄丢掉，
 * 用户会一直以为这条模板带着那个限制。
 *
 * @param {unknown} raw
 * @returns {{ok:true, value:object} | {ok:false, error:string, message:string}}
 */
export function normalizeTemplateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'template-invalid', message: '模板必须是一个对象' }
  }

  // ── ① 未知字段：直接拒绝（见文件头的"写入严格"） ───────────────────
  const unknown = Object.keys(raw).filter((k) => !ALLOWED_FIELD_SET.has(k))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: 'template-unknown-field',
      message: `模板不接受字段：${unknown.join(', ')}`,
    }
  }

  // ── ② id（可选，仅用于更新已有模板；格式与生成器一致才收） ──────────
  let id
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id.trim() === '') {
      return { ok: false, error: 'template-id-invalid', message: 'id 必须是非空字符串' }
    }
    id = raw.id.trim()
    if (id.length > MAX_ID_LEN || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return { ok: false, error: 'template-id-invalid', message: `id 只能是字母数字与 _-，且不超过 ${MAX_ID_LEN} 字符` }
    }
  }

  // ── ③ name / goal：模板的"人读"部分，都是必填 ───────────────────────
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    return { ok: false, error: 'template-name-required', message: '模板名不能为空' }
  }
  const name = raw.name.trim()
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: 'template-name-too-long', message: `模板名最长 ${MAX_NAME_LEN} 字符` }
  }

  if (typeof raw.goal !== 'string' || raw.goal.trim() === '') {
    return { ok: false, error: 'template-goal-required', message: '模板必须带任务目标（goal）' }
  }
  const goal = raw.goal.trim()
  if (goal.length > MAX_GOAL_LEN) {
    return { ok: false, error: 'template-goal-too-long', message: `任务目标最长 ${MAX_GOAL_LEN} 字符` }
  }

  // ── ④ mode：只认协议里那两个值。写错就报错，不"默认成 agent" —— ────
  // 一条 exec 模板被静默当成 agent 模板派出去，是"命令变成了任务书"这种
  // 后果完全不同的错派，必须让人看见。
  let mode = TASK_MODE.AGENT
  if (raw.mode !== undefined) {
    if (raw.mode !== TASK_MODE.AGENT && raw.mode !== TASK_MODE.EXEC) {
      return { ok: false, error: 'template-mode-invalid', message: 'mode 只能是 agent 或 exec' }
    }
    mode = raw.mode
  }

  // ── ⑤ workspace：副机上的绝对路径（仍会在派发时过 roots 校验） ──────
  let workspace
  if (raw.workspace !== undefined && raw.workspace !== '') {
    if (typeof raw.workspace !== 'string') {
      return { ok: false, error: 'template-workspace-invalid', message: 'workspace 必须是字符串' }
    }
    workspace = raw.workspace.trim()
    if (workspace.length > MAX_WORKSPACE_LEN) {
      return { ok: false, error: 'template-workspace-too-long', message: `workspace 最长 ${MAX_WORKSPACE_LEN} 字符` }
    }
    if (workspace === '') workspace = undefined
  }

  // ── ⑥ model：复用协议层归一化，保证"模板里的 model"与"派发时的 model" ──
  // 是**同一个定义**（否则两处漂移，模板能存下派发必拒的形状）。
  let model
  if (raw.model !== undefined && raw.model !== null && raw.model !== '') {
    if (typeof raw.model === 'string') {
      if (raw.model.length > MAX_MODEL_LEN) {
        return { ok: false, error: 'template-model-too-long', message: `model 最长 ${MAX_MODEL_LEN} 字符` }
      }
    } else if (typeof raw.model === 'object' && !Array.isArray(raw.model)) {
      const badKey = Object.keys(raw.model).filter((k) => !MODEL_FIELD_SET.has(k))
      if (badKey.length > 0) {
        return { ok: false, error: 'template-model-invalid', message: `model 不接受字段：${badKey.join(', ')}` }
      }
      for (const k of MODEL_FIELD_SET) {
        const v = raw.model[k]
        if (v === undefined) continue
        if (typeof v !== 'string' || v.length > MAX_MODEL_FIELD_LEN) {
          return { ok: false, error: 'template-model-invalid', message: `model.${k} 必须是长度 ≤ ${MAX_MODEL_FIELD_LEN} 的字符串` }
        }
      }
    } else {
      return { ok: false, error: 'template-model-invalid', message: 'model 必须是字符串或 {provider, model, reasoningEffort}' }
    }
    model = normalizeModelSelection(raw.model)
    // 归一化后为空说明它本来就不是一个有效选择（例如只给了 provider）。
    // 宁可报错，也不要存一条"看起来有模型、派发时却回落默认"的模板。
    if (model === undefined) {
      return { ok: false, error: 'template-model-invalid', message: 'model 不是一个有效的模型选择（至少要给 model 名）' }
    }
  }

  // ── ⑦ outputs：glob 数组。元素类型错就报错，不 filter 掉 ────────────
  // （派发路径对 outputs 是宽容过滤的；模板是**存档**，存档里静默丢元素
  //   等于把用户的意图改掉，之后每次用这条模板都少收一个产物。）
  let outputs
  if (raw.outputs !== undefined) {
    if (!Array.isArray(raw.outputs)) {
      return { ok: false, error: 'template-outputs-invalid', message: 'outputs 必须是数组' }
    }
    if (raw.outputs.length > MAX_OUTPUTS) {
      return { ok: false, error: 'template-outputs-too-many', message: `outputs 最多 ${MAX_OUTPUTS} 条` }
    }
    const out = []
    for (const o of raw.outputs) {
      if (typeof o !== 'string' || o.trim() === '') {
        return { ok: false, error: 'template-outputs-invalid', message: 'outputs 的元素必须是非空字符串' }
      }
      const s = o.trim()
      if (s.length > MAX_OUTPUT_LEN) {
        return { ok: false, error: 'template-outputs-too-long', message: `单个 glob 最长 ${MAX_OUTPUT_LEN} 字符` }
      }
      out.push(s)
    }
    if (out.length > 0) outputs = out
  }

  // ── ⑧ timeoutMs：与 validateTaskStart 的下限（1000ms）对齐 ───────────
  let timeoutMs
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs)) {
      return { ok: false, error: 'template-timeout-invalid', message: 'timeoutMs 必须是数字' }
    }
    if (raw.timeoutMs < MIN_TIMEOUT_MS || raw.timeoutMs > MAX_TIMEOUT_MS) {
      return {
        ok: false,
        error: 'template-timeout-out-of-range',
        message: `timeoutMs 必须在 ${MIN_TIMEOUT_MS} ~ ${MAX_TIMEOUT_MS} 之间`,
      }
    }
    timeoutMs = Math.trunc(raw.timeoutMs)
  }

  return { ok: true, value: compact({ id, name, goal, mode, workspace, model, outputs, timeoutMs }) }
}

/**
 * 把**文件里的一条记录**投影成可信记录。
 *
 * 与 normalizeTemplateInput 的差别（刻意的，见文件头"读宽容/写严格"）：
 *   - 只挑白名单字段后再校验 → 手工加的一个未知键不会毁掉整条记录
 *   - **必需字段**（id / name / goal）不合格 → 回 null（调用方丢弃该条）。
 *     没有 id 的记录无法寻址删除，没有 goal 的记录填不出表单，留着只会让
 *     用户点一下才发现是坏的。
 *   - **可选字段**不合格 → **只丢那一个字段**，记录本身保留。
 *     这是本函数最容易被写错的一处：若把可选字段的校验失败也升级成"丢整条"，
 *     一个手滑的 `model: {apiKey:...}` 就能让一条好好的模板从面板上消失 ——
 *     而用户完全不知道发生了什么（文件里明明有）。
 *   - 未知键一律忽略（写路径拒绝它们，读路径没这个权力 —— 磁盘上的文件
 *     可能是别的版本、别的工具、或用户手写的）
 *
 * 实现上不重写一套校验：把字段逐个喂给 normalizeTemplateInput，借它同一份
 * 规则。这样"读"与"写"对同一个字段的判定永远一致。
 */
function projectRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '' || id.length > MAX_ID_LEN || !/^[A-Za-z0-9_-]+$/.test(id)) return null

  // 必需字段：用同一份校验（name / goal 的长度与类型规则不在这里重抄一遍）
  const core = normalizeTemplateInput({
    name: raw.name,
    goal: raw.goal,
    ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
  })
  if (!core.ok) return null

  const out = { ...core.value }
  // 可选字段逐个试：坏的丢掉那一个，不牵连整条记录
  for (const key of TEMPLATE_OPTIONAL_FIELDS) {
    if (raw[key] === undefined) continue
    const single = normalizeTemplateInput({ name: core.value.name, goal: core.value.goal, [key]: raw[key] })
    if (single.ok && single.value[key] !== undefined) out[key] = single.value[key]
  }

  const createdAt = numOr(raw.createdAt, 0)
  return compact({
    id,
    ...out,
    createdAt,
    // updatedAt 缺失时退成 createdAt（手写文件的常见形态），而不是 0
    updatedAt: numOr(raw.updatedAt, createdAt),
  })
}

/**
 * 原子写 JSON。
 *
 * 顺序是硬要求：**先写临时文件，再 rename 覆盖目标**。
 *   - 直接 writeFile 目标：进程在写到一半时挂掉 → 文件是半截 JSON，
 *     下次启动整库降级为空（用户看到"模板全没了"）
 *   - tmp → rename：POSIX 上 rename 是原子的，读方要么看到完整旧文件、
 *     要么看到完整新文件，**不存在第三种状态**
 *
 * ── Windows 上的例外：rename 会被并发的读者挡住 ──────────────────────────
 *
 * 实测（本机 Node 24 / NTFS）：目标文件**正被另一个句柄读着**时，
 * `rename(tmp, target)` 会失败 `EPERM`。这不是本实现的问题，是 Windows 的
 * 文件共享语义 —— MoveFileEx 替换目标需要目标以 FILE_SHARE_DELETE 打开，
 * 而 Node 的 `fs.readFile` 默认不带这个共享位；POSIX 则完全不关心目标是否
 * 被打开（旧 inode 继续为读者服务）。
 *
 * 后果很具体：面板每打开一次派发表单就 GET 一次 /templates，恰好撞上一次
 * 保存 → 保存报错，而用户看到的只是"保存失败"，无从知道重试就能成功。
 *
 * 所以这里对**瞬态锁**做有界重试（EPERM / EBUSY / EACCES）。三条边界：
 *   - 有界：最多 RETRY 次，总等待 ~1.3s（指数退避封顶 200ms）—— 不把一次
 *     保存变成无限等待
 *   - 只重试这三类码：真错误（ENOSPC / EROFS）立即抛出，重试只是浪费时间
 *   - 退避递增：读者通常几毫秒就结束，前两次短等待就能成功
 *
 * 失败时**清理临时文件**再抛出：留下残骸会污染状态目录，也会让
 * "目录里只应有 templates.json"这类断言（本包已有同款测试）失效。
 *
 * mode 0o600：模板里有 workspace 绝对路径（主机目录结构），按本包对
 * "本机部署信息"的一贯口径收窄权限。注意 mode 只在**创建**时生效，
 * 目标已存在时由 rename 保留原 inode 的权限位。
 *
 * @param {string} file 目标绝对路径
 * @param {unknown} value 可 JSON 序列化的值
 */
export async function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  await fs.promises.mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  try {
    await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(tmp, file)
        return
      } catch (err) {
        const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES'
        if (!transient || attempt >= RENAME_RETRIES) throw err
        // 最后一次尝试前走 unlink 兜底（见 RENAME_UNLINK_FALLBACK_AT 的说明）。
        // 只在"前面所有退避都失败"时执行 —— 那个时点目标文件本来就被
        // 别人长期锁着，删掉它换来一次成功的 rename 比继续等更划算。
        if (attempt === RENAME_UNLINK_FALLBACK_AT) {
          try {
            await fs.promises.rm(file, { force: true })
          } catch {
            /* 删不掉就继续等下一轮 —— 失败会由最后的 throw 反映 */
          }
        }
        await new Promise((r) => setTimeout(r, Math.min(RENAME_BACKOFF_MAX_MS, RENAME_BACKOFF_MS * 2 ** attempt)))
      }
    }
  } catch (err) {
    try {
      await fs.promises.rm(tmp, { force: true })
    } catch {
      /* 清理失败不能掩盖原始错误 —— 原错误才是根因 */
    }
    throw err
  }
}

/**
 * 建一个模板库读写器。
 *
 * @param {object} o
 * @param {string} o.file 模板 JSON 的绝对路径（见 defaultTemplatesFile）
 * @param {(level:string,msg:string,extra?:object)=>void} [o.log] 插件日志器（可选）
 * @param {number} [o.max] 数量上限，默认 MAX_TEMPLATES
 */
export function createTemplateStore({ file, log, max } = {}) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('createTemplateStore: file is required')
  }
  const target = path.resolve(file.trim())
  const limit = Number.isFinite(max) && max > 0 ? Math.trunc(max) : MAX_TEMPLATES
  const warn = typeof log === 'function' ? log : () => {}

  /**
   * 写队列。所有**写**操作串行化。
   *
   * 为什么需要：读-改-写之间有 await（读文件、写文件都是异步的），两个并发
   * save 会各自读到同一份旧列表，各自加一条再写回 → 后写的把先写的覆盖掉
   * （经典的 lost update）。面板上"连点两下保存"就能触发。
   *
   * 读**不排队**：原子写保证了读到的永远是完整的旧/新内容，而排队只会让
   * 面板的列表刷新被一次慢写拖住。
   *
   * 前一个任务失败时后续任务仍要跑（chain 上挂的是吞掉错误的版本），
   * 否则一次失败会把队列永久卡死。
   */
  let chain = Promise.resolve()
  const serialize = (fn) => {
    const next = chain.then(fn)
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * 降级告警去重：同一个原因只打一次。
   *
   * 为什么：面板会周期性地拉列表，一个损坏的文件会把日志刷满 ——
   * 而日志刷满的后果是"真正的错误被淹掉"。
   */
  let lastWarnKey = ''
  const warnOnce = (key, msg, extra) => {
    if (key === lastWarnKey) return
    lastWarnKey = key
    warn('warn', msg, extra)
  }

  /**
   * 读全量。
   *
   * 三类失败都**降级为空库**而不是抛：
   *   - ENOENT：首次使用的正常状态（也不创建文件）
   *   - 读失败（EISDIR/权限）：当成空库，面板仍可用（只是看不到模板）
   *   - JSON 坏 / 形状不对：同上
   * 调用方拿 `degraded` 决定要不要提示用户（面板据此显示一行提示）。
   *
   * 形状兼容：接受 `{ version, templates: [] }`（本文件写出的形态）与裸数组
   * （手写文件的常见形态）。版本号只记录不校验 —— 将来真需要迁移时，
   * 读路径已经有地方做分支了。
   *
   * @returns {Promise<{templates:object[], degraded:boolean, reason:string, dropped:number}>}
   */
  async function readAll() {
    let text
    try {
      text = await fs.promises.readFile(target, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return { templates: [], degraded: false, reason: '', dropped: 0 }
      }
      warnOnce(`unreadable:${err?.code ?? 'unknown'}`, 'templates unreadable; treating as empty', {
        file: target,
        error: errText(err),
      })
      return { templates: [], degraded: true, reason: 'unreadable', dropped: 0 }
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      warnOnce('corrupt:json', 'templates file is not valid JSON; degrading to empty', {
        file: target,
        error: errText(err),
      })
      return { templates: [], degraded: true, reason: 'invalid-json', dropped: 0 }
    }

    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray(parsed.templates) ? parsed.templates : null)
    if (list === null) {
      warnOnce('corrupt:shape', 'templates file has unexpected shape; degrading to empty', { file: target })
      return { templates: [], degraded: true, reason: 'bad-shape', dropped: 0 }
    }

    const templates = []
    let dropped = 0
    for (const item of list.slice(0, limit)) {
      const rec = projectRecord(item)
      if (rec === null) dropped += 1
      else templates.push(rec)
    }
    if (dropped > 0) {
      // 坏条目只在**数量变化**时告警一次：手工编辑过的文件不该刷满日志，
      // 但"悄悄少了几条模板"必须留痕。
      warnOnce(`dropped:${dropped}`, 'templates: some entries were dropped (invalid)', { file: target, dropped })
    }
    return { templates, degraded: false, reason: '', dropped }
  }

  /** 落盘。写的是本文件自己的格式（带版本号的对象）。 */
  function writeAll(templates) {
    return atomicWriteJson(target, {
      version: TEMPLATES_FORMAT_VERSION,
      updatedAt: Date.now(),
      templates,
    })
  }

  return {
    /** 模板文件的绝对路径（面板用它显示"存在哪"）。 */
    file: target,
    /** 数量上限。 */
    max: limit,

    /**
     * 列全部模板（读路径，不排队 —— 见 chain 的说明）。
     * @returns {Promise<{templates:object[], degraded:boolean, reason:string, count:number}>}
     */
    async list() {
      const r = await readAll()
      return {
        templates: r.templates.map((t) => ({ ...t })),
        degraded: r.degraded,
        reason: r.reason,
        count: r.templates.length,
      }
    },

    /**
     * 保存（新建或更新）。
     *
     * `id` 命中已有模板 → **就地更新**（保留 createdAt），否则新建。
     * `id` 给了但不存在 → 404 语义的 `template-unknown`：**不静默新建** ——
     * 否则"面板上选中的模板被别的会话删了"会变成"凭空多出一条同名模板"。
     *
     * @param {unknown} raw 面板传来的模板对象
     * @returns {Promise<{ok:true, template:object, count:number, updated:boolean, recovered:boolean}
     *   | {ok:false, error:string, message:string, status:number}>}
     */
    async save(raw) {
      return serialize(async () => {
        const input = normalizeTemplateInput(raw)
        if (!input.ok) return { ok: false, error: input.error, message: input.message, status: 400 }

        const state = await readAll()
        const templates = state.templates
        const wanted = input.value.id ?? ''
        const index = wanted === '' ? -1 : templates.findIndex((t) => t.id === wanted)
        if (wanted !== '' && index === -1) {
          return {
            ok: false,
            error: 'template-unknown',
            message: '模板不存在（可能已被删除或来自另一台机器）',
            status: 404,
          }
        }
        if (index === -1 && templates.length >= limit) {
          return {
            ok: false,
            error: 'template-limit',
            message: `模板数量已达上限 ${limit}，先删掉不用的`,
            status: 409,
          }
        }

        const now = Date.now()
        const prev = index === -1 ? null : templates[index]
        const record = compact({
          id: prev ? prev.id : newTemplateId(),
          name: input.value.name,
          goal: input.value.goal,
          mode: input.value.mode,
          workspace: input.value.workspace,
          model: input.value.model,
          outputs: input.value.outputs,
          timeoutMs: input.value.timeoutMs,
          createdAt: prev ? numOr(prev.createdAt, now) : now,
          updatedAt: now,
        })

        const next = templates.slice()
        if (index === -1) next.push(record)
        else next[index] = record

        await writeAll(next)
        return {
          ok: true,
          template: { ...record },
          count: next.length,
          updated: prev !== null,
          // 之前是坏文件 / 空文件，这次写入把库恢复了 —— 面板据此提示
          recovered: state.degraded,
        }
      })
    },

    /**
     * 删除。
     * @param {string} id
     * @returns {Promise<{ok:true, removed:number, count:number} | {ok:false, error:string, message:string, status:number}>}
     */
    async remove(id) {
      return serialize(async () => {
        const wanted = typeof id === 'string' ? id.trim() : ''
        if (wanted === '') {
          return { ok: false, error: 'template-id-required', message: '缺少模板 id', status: 400 }
        }
        const state = await readAll()
        const next = state.templates.filter((t) => t.id !== wanted)
        if (next.length === state.templates.length) {
          return { ok: false, error: 'template-unknown', message: '模板不存在', status: 404 }
        }
        await writeAll(next)
        return { ok: true, removed: state.templates.length - next.length, count: next.length }
      })
    },
  }
}
