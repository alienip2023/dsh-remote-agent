/**
 * `dropNullForSchema` 必须**递归**（2026-10-16 修）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 事故
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原实现遇到数组**直接 return**，也不递归子对象：
 *
 *     function dropNullForSchema(value, schema) {
 *       if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
 *       // ...只处理顶层字段，没有递归
 *     }
 *
 * 于是 `nodes[0].resource = null` 原样出边界，DSH 报
 *
 *     tool "remote_nodes" returned invalid output:
 *     "value.nodes[0].resource" must be an object
 *
 * ── 为什么这个约定会失效 ────────────────────────────────────────────────
 *
 * schema 里 `resource` 只声明 `type: 'object'`（不带 'null'），靠"optional
 * 的 null 字段会被剥掉"这个约定来容错。**但约定只有在递归到那一层时才生效。**
 * 顶层字段能剥、数组元素里的字段剥不到。
 *
 * ── 教训 ────────────────────────────────────────────────────────────────
 *
 * `dropNullForSchema` 是"工具返回值出边界前的最后一道" —— 它必须覆盖
 * **任意嵌套深度**，否则 schema 与实现的契约就在深处悄悄破裂。
 * 这类 bug 的症状特别像"工具坏了"（`returned invalid output`），
 * 但工具其实**执行成功**了（任务派出去了），只是返回值被拒 ——
 * 有副作用却报失败，是最坏的一类失败。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TOOLS = path.join(ROOT, 'lib', 'hub', 'tools.js')

/** 从源码里抠出 dropNullForSchema（内部函数，未导出）并实例化。 */
function loadDropNull() {
  const src = fs.readFileSync(TOOLS, 'utf8')
  const i = src.indexOf('function dropNullForSchema')
  assert.ok(i >= 0, '应存在 dropNullForSchema')
  let depth = 0
  let end = -1
  for (let k = src.indexOf('{', i); k < src.length; k += 1) {
    if (src[k] === '{') depth += 1
    else if (src[k] === '}') {
      depth -= 1
      if (depth === 0) { end = k + 1; break }
    }
  }
  assert.ok(end > 0, '花括号配对失败')
  const fnSrc = src.slice(i, end)
  // eslint-disable-next-line no-new-func
  return { fn: new Function('return ' + fnSrc)(), src: fnSrc }
}

const { fn: dropNull, src: fnSrc } = loadDropNull()

/** remote_nodes 的 schema 形状（简化但保留嵌套与 required）。 */
const NODES_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          online: { type: 'boolean' },
          taskCount: { type: 'number' },
          resource: {
            type: 'object',
            properties: {
              cpuPct: { type: 'number' },
              load1: { type: 'number' },
              at: { type: 'number' },
            },
          },
        },
        required: ['nodeId', 'online'],
      },
    },
  },
  required: ['nodes'],
}

/* ─────────────── 1. 静态：必须递归 ─────────────── */

test('dropNullForSchema 必须处理数组（不能遇到数组就 return）', () => {
  assert.match(fnSrc, /Array\.isArray\(value\)/, '应显式处理数组')
  assert.match(fnSrc, /schema\.items/, '数组应取 items 的 schema')
  // 不能出现"数组直接返回"的老形态
  assert.ok(
    !/typeof value !== 'object' \|\| Array\.isArray\(value\)\) return value/.test(fnSrc),
    "不得保留 'Array.isArray(value)) return value' —— 那正是数组被跳过的原因",
  )
})

test('dropNullForSchema 必须递归子对象', () => {
  // 函数体里至少两处自调用（数组分支 + 子对象分支）
  const calls = (fnSrc.match(/dropNullForSchema\(/g) || []).length
  assert.ok(calls >= 3, `应有多处递归调用（实际 ${calls} 处：函数名 + 至少两个递归点）`)
})

/* ─────────────── 2. 行为：真实的 bug 形态 ─────────────── */

test('回归：数组元素里的 null 字段必须被剥掉', () => {
  const out = dropNull({
    nodes: [{ nodeId: 'n1', online: true, taskCount: 0, resource: null }],
  }, NODES_SCHEMA)
  assert.equal(out.nodes[0].resource, undefined, 'resource: null 应被剥掉')
  assert.ok(!('resource' in out.nodes[0]), '不该留 resource 键')
  // 有值字段必须保留
  assert.equal(out.nodes[0].nodeId, 'n1')
  assert.equal(out.nodes[0].online, true)
})

test('回归：子对象内部的 null 字段也必须被剥掉', () => {
  const out = dropNull({
    nodes: [{ nodeId: 'n1', online: true, resource: { cpuPct: 12.5, load1: null, at: 99 } }],
  }, NODES_SCHEMA)
  assert.equal(out.nodes[0].resource.load1, undefined, '内层 load1: null 应被剥掉')
  assert.equal(out.nodes[0].resource.cpuPct, 12.5, '有值字段应保留')
  assert.equal(out.nodes[0].resource.at, 99)
})

test('required 字段的 null 不该被剥（源头问题不在这里掩盖）', () => {
  const out = dropNull({ nodes: [{ nodeId: null, online: true }] }, NODES_SCHEMA)
  assert.equal(out.nodes[0].nodeId, null, 'required 的 null 应保留，让 schema 校验如实报错')
})

test('数组里的 null 元素原样保留（它不是"字段"）', () => {
  const out = dropNull({ nodes: [null, { nodeId: 'x', online: false }] }, NODES_SCHEMA)
  assert.equal(out.nodes[0], null)
  assert.equal(out.nodes[1].nodeId, 'x')
})

test('深层嵌套（数组 → 对象 → 数组 → 对象）也要剥', () => {
  const schema = {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
  const out = dropNull({
    groups: [{ name: 'g', items: [{ id: 'a', note: null }, { id: 'b', note: 'hi' }] }],
  }, schema)
  assert.equal(out.groups[0].items[0].note, undefined, '四层深处的 null 也要剥')
  assert.equal(out.groups[0].items[1].note, 'hi')
})

test('允许 null 的字段（type 数组含 null）不被剥', () => {
  const schema = {
    type: 'object',
    properties: {
      maybe: { type: ['string', 'null'] },
      notNull: { type: 'string' },
    },
  }
  const out = dropNull({ maybe: null, notNull: null }, schema)
  assert.equal(out.maybe, null, '声明允许 null 时应保留')
  assert.equal(out.notNull, undefined, '未声明 null 时应剥掉')
})

test('标量与 null 原样返回（不该炸）', () => {
  assert.equal(dropNull(null, NODES_SCHEMA), null)
  assert.equal(dropNull(42, NODES_SCHEMA), 42)
  assert.equal(dropNull('s', NODES_SCHEMA), 's')
  assert.equal(dropNull(true, NODES_SCHEMA), true)
})

test('没有 schema 时原样返回（不误删）', () => {
  const v = { a: null, b: 1 }
  assert.deepEqual(dropNull(v, undefined), v)
  assert.deepEqual(dropNull(v, null), v)
  assert.deepEqual(dropNull(v, {}), v)
})
