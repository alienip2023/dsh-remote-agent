/**
 * 模型自述（提案 #27）单测：readDefaultModel 的归一与容错。
 *
 * 设计约束：副机对"默认模型"的探测是尽力而为的遥测 —— 服务缺失、
 * 抛错、字段形态不对，一律 null，绝不影响资源帧与任务链路。
 * 只报 provider 键名 + model id，不碰任何凭证。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readDefaultModel } from '../lib/node/index.js'

const ctxWith = (value) => ({ get: (name) => (name === 'agentDefaultModel' ? value : undefined) })

test('#27 readDefaultModel：正常选择 → {provider, model}', () => {
  const ctx = ctxWith({ currentSelection: () => ({ provider: 'official', model: 'deepseek-chat', reasoning: 'high' }) })
  assert.deepEqual(readDefaultModel(ctx), { provider: 'official', model: 'deepseek-chat' })
})

test('#27 readDefaultModel：无 provider 只有 model → provider 空串兜底', () => {
  const ctx = ctxWith({ currentSelection: () => ({ model: 'deepseek-chat' }) })
  assert.deepEqual(readDefaultModel(ctx), { provider: '', model: 'deepseek-chat' })
})

test('#27 readDefaultModel：服务缺失 / 形态不对 / 抛错 → null', () => {
  assert.equal(readDefaultModel({ get: () => undefined }), null, '服务缺失')
  assert.equal(readDefaultModel(ctxWith({})), null, '无 currentSelection 方法')
  assert.equal(readDefaultModel(ctxWith({ currentSelection: () => ({ model: '' }) })), null, 'model 为空')
  assert.equal(readDefaultModel(ctxWith({ currentSelection: () => null })), null, '选择为 null')
  assert.equal(
    readDefaultModel(ctxWith({ get currentSelection() { throw new Error('boom') } })),
    null,
    '服务抛错 → null（探测绝不炸资源帧）',
  )
  assert.equal(readDefaultModel(undefined), null, 'ctx 本身缺失')
})
