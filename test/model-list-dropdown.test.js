/**
 * 提案 #27 完整版：副机上报可用模型清单 → hub 摄入 → 节点视图透出 → 面板下拉。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么 v0.7.0 只做了一半
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 当时的判断是"in-process 后端没有稳定的清单 API（DSH 内部的 `model/list`
 * 走 app-server 协议面，fiber 服务摸不到）"。**那个判断已经过时** ——
 * `ctx.llm` 现在直接暴露：
 *
 *     listProviders(): LlmProviderInfo[]                     // {id, name}
 *     async listModels(provider): Promise<LlmModelInfo[]>    // {provider, id, name}
 *
 * 所以面板可以真的渲染下拉，而不是让用户猜 provider/model 名、填错了等任务
 * 跑到副机才失败（浪费一轮往返 + 烧一个 taskId）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 链路（四段，任一断掉面板就退回自由文本）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. 副机 `readAvailableModels(ctx)` —— 探测 + 缓存 + 上限
 *   2. RESOURCE 帧带 `models`（**缓存值**，因为 interval 回调是同步的）
 *   3. hub `registry-ingest` 字段级清洗 → `rec.models`
 *   4. `registry.list()` → `nodeView()` → 面板 `<select>`
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 安全边界（硬要求，逐段钉住）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **只上报 provider 键名 + model id + 显示名。**
 * 绝不上报 apiKeyEnv 的值、baseURL、任何凭证、未注册的 provider。
 * `listProviders()` 只返回已注册（有 adapter）的 route —— 天然满足"不泄露
 * 这台机器配了哪些渠道"，只有真能用的才会出现。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const nodeIndex = read('lib/node/index.js')
const ingest = read('lib/hub/registry-ingest.js')
const registry = read('lib/hub/node-registry.js')
const views = read('lib/hub/views.js')
const tools = read('lib/hub/tools.js')
const client = read('lib/client.js')

/* ═══════════════ 段 1：副机侧探测 ═══════════════ */

test('#27-1：副机用 ctx.llm 的 listProviders + listModels 探测（不是猜配置结构）', () => {
  const code = stripComments(nodeIndex)
  const i = code.indexOf('export async function readAvailableModels')
  assert.ok(i >= 0, '应存在 readAvailableModels')
  const seg = code.slice(i, i + 2600)

  assert.match(seg, /ctx\.get\('llm'\)/, '应通过 ctx.get("llm") 拿服务')
  assert.match(seg, /llm\.listProviders\(\)/, '应调 listProviders()')
  assert.match(seg, /llm\.listModels\(/, '应调 listModels(provider)')
  // 不应探测 llm-pi-ai 的内部结构（脆弱）
  assert.ok(!/llm-pi-ai/.test(seg), '不得探测 llm-pi-ai 内部配置结构（脆弱，且可能带凭证）')
})

test('#27-1：只上报 provider/id/name —— 绝不带 apiKeyEnv / baseURL / 凭证', () => {
  const code = stripComments(nodeIndex)
  const i = code.indexOf('export async function readAvailableModels')
  const seg = code.slice(i, i + 2600)

  // 构造的对象只能有这三个键。注意源码用的是**简写属性**
  // （`{ provider: ..., id, name }`），所以既要抓 `key:` 也要抓裸标识符。
  const pushLine = seg.match(/models\.push\(\{([^}]*)\}\)/)
  assert.ok(pushLine, '应有 models.push({...})')
  const inner = pushLine[1]
  const keys = new Set()
  for (const m of inner.matchAll(/(\w+)\s*:/g)) keys.add(m[1])
  // 简写属性：逗号分隔的裸标识符（不含冒号的那些）
  for (const part of inner.split(',')) {
    const t = part.trim()
    if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t)
  }
  assert.deepEqual(
    [...keys].sort(),
    ['id', 'name', 'provider'],
    `上报字段必须恰好是 provider/id/name，实际：${[...keys].join(', ')}`,
  )
  // 明确禁止的字段
  for (const forbidden of ['apiKey', 'baseURL', 'token', 'secret']) {
    assert.ok(!new RegExp(forbidden, 'i').test(inner), `上报对象不得含 ${forbidden}`)
  }
})

test('#27-1：单个 provider 探测失败不影响其它（尽力而为）', () => {
  const code = stripComments(nodeIndex)
  const i = code.indexOf('export async function readAvailableModels')
  const seg = code.slice(i, i + 2600)
  // listModels 的调用必须在 try/catch 里，失败 continue
  assert.match(seg, /try\s*\{[\s\S]*?llm\.listModels\([\s\S]*?\}\s*catch\s*\{\s*continue\s*\}/, '单个 provider 失败应 continue 而非中断')
})

test('#27-1：全部失败时返回 null（面板退回自由文本，不是空数组）', () => {
  const code = stripComments(nodeIndex)
  const i = code.indexOf('export async function readAvailableModels')
  const seg = code.slice(i, i + 2600)
  assert.match(seg, /if\s*\(models\.length === 0\)\s*return null/, '空结果应返回 null（语义：没探测到，不是"一个都没有"）')
})

test('#27-1：有数量上限（不让 RESOURCE 帧膨胀）', () => {
  const code = stripComments(nodeIndex)
  for (const c of ['MAX_MODELS', 'MAX_MODELS_PER_PROVIDER', 'MAX_MODEL_PROVIDERS']) {
    assert.match(code, new RegExp(`const ${c}\\s*=\\s*\\d+`), `应有 ${c} 常量`)
  }
})

/* ═══════════════ 段 2：RESOURCE 帧带缓存 ═══════════════ */

test('#27-2：RESOURCE 帧带 models，且来自缓存（同步 interval 不能 await）', () => {
  const code = stripComments(nodeIndex)
  const i = code.indexOf('NODE_TO_HUB.RESOURCE')
  assert.ok(i >= 0, '应发送 RESOURCE 帧')
  const seg = code.slice(i, i + 500)
  assert.match(seg, /models:\s*cachedModels/, '帧里应带 cachedModels（不是 await 探测）')

  // 缓存刷新必须是串行链 + fire-and-forget，不能在 interval 里 await
  const ri = code.indexOf('const refreshModels')
  assert.ok(ri >= 0, '应有 refreshModels')
  const rseg = code.slice(ri, ri + 900)
  assert.match(rseg, /modelsTail\s*=\s*modelsTail\.then/, '刷新应用串行链（防探测堆积）')
  assert.match(rseg, /modelsQueued/, '应有 in-flight 标志')
  // 探测失败保留旧值（一次网络抖动不该让面板下拉消失）
  assert.match(rseg, /catch\s*\{[\s\S]*?\}/, '探测失败应被吞掉并保留缓存')
})

/* ═══════════════ 段 3：hub 摄入 ═══════════════ */

test('#27-3：hub 摄入 models 做字段级清洗 + 独立封顶', () => {
  const code = stripComments(ingest)
  const i = code.indexOf('const rawModels')
  assert.ok(i >= 0, '应摄入 models')
  const seg = code.slice(i, i + 1400)

  assert.match(seg, /MAX_NODE_MODELS/, 'hub 侧必须**独立封顶**（不能信任对端遵守了自己的上限）')
  assert.match(seg, /typeof m\.id === 'string'/, 'id 必须类型校验')
  assert.match(seg, /cleaned\.push\(\{/, '应逐条构造（不 spread）')
})

test('#27-3：models 为 null 时**保留旧值**（一次抖动不清空面板下拉）', () => {
  const code = stripComments(ingest)
  const i = code.indexOf('const rawModels')
  const seg = code.slice(i, i + 1400)
  // 只有 rawModels 为对象时才替换 —— null/缺失走不到赋值
  assert.match(seg, /if\s*\(rawModels\)\s*\{/, '只有对象才替换（null 保留旧值）')
  // 对比：defaultModel 的 null 是"清空"语义，两者刻意不同
  assert.match(code, /if \(d\.defaultModel === null\) rec\.defaultModel = null/, 'defaultModel 的 null 是清空语义（与 models 不同）')
})

/* ═══════════════ 段 4：投影与面板 ═══════════════ */

test('#27-4：registry.list() 透出 models（null 与 [] 语义不同）', () => {
  const code = stripComments(registry)
  const i = code.indexOf('models: Array.isArray(r.models)')
  assert.ok(i >= 0, 'list() 应透出 models')
  const seg = code.slice(i, i + 200)
  assert.match(seg, /:\s*null/, '非数组时给 null（不是 []）—— 两者语义不同')
})

test('#27-4：nodeView 逐条投影 models（不 spread）', () => {
  const code = stripComments(views)
  const i = code.indexOf('models: Array.isArray(n.models)')
  assert.ok(i >= 0, 'nodeView 应投影 models')
  const seg = code.slice(i, i + 800)
  assert.match(seg, /\.map\(\(m\) => \(\{/, '应逐条构造')
  assert.match(seg, /provider:/, '应有 provider 字段')
  assert.match(seg, /id:/, '应有 id 字段')
  assert.match(seg, /name:/, '应有 name 字段')
  assert.match(seg, /filter\(\(m\) => m\.id !== ''\)/, '应过滤掉空 id')
})

test('#27-4：remote_nodes 的 output schema 声明了 models', () => {
  const i = tools.indexOf("name: 'remote_nodes'")
  assert.ok(i >= 0)
  const seg = tools.slice(i, i + 4000)
  assert.match(seg, /models:\s*\{/, 'schema 应声明 models')
  assert.match(seg, /required: \['id'\]/, 'models 的 items 应 required id')
})

test('#27-4：面板渲染 <select>，含"跟随副机默认"与"自定义"回退', () => {
  const i = client.indexOf('提案 #27')
  assert.ok(i >= 0, '面板应有 #27 的注释块')
  const seg = client.slice(i, i + 4200)

  assert.match(seg, /h\('select'/, '应有 <select>')
  assert.match(seg, /跟随副机默认/, '第一项应是"跟随副机默认"')
  assert.match(seg, /__custom__/, '应有"自定义"选项')
  assert.match(seg, /hasList/, '应区分"有清单"与"没清单"')
  // 没清单时退回文本框
  assert.match(seg, /没有清单|hasList\s*\n?\s*\?/, '没清单应退回文本框（向后兼容旧副机）')
  // 多节点时带节点名后缀
  assert.match(seg, /· ' \+ o\.nodeId|' · ' \+ o\.nodeId/, '多节点时选项应带节点名')
})

/* ═══════════════ 安全：不得泄露凭证 ═══════════════ */

test('#27 安全：全链路不得出现 apiKeyEnv / baseURL 的上报', () => {
  // 副机侧
  const ni = stripComments(nodeIndex)
  const ri = ni.indexOf('export async function readAvailableModels')
  const rseg = ni.slice(ri, ri + 2600)
  assert.ok(!/apiKeyEnv/.test(rseg), '副机侧不得读 apiKeyEnv')
  assert.ok(!/baseURL/.test(rseg), '副机侧不得读 baseURL')

  // hub 摄入侧
  const ig = stripComments(ingest)
  const ii = ig.indexOf('const rawModels')
  const iseg = ig.slice(ii, ii + 1400)
  assert.ok(!/apiKeyEnv/.test(iseg), 'hub 侧不得接收 apiKeyEnv')
  assert.ok(!/baseURL/.test(iseg), 'hub 侧不得接收 baseURL')
})
