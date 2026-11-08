import test from 'node:test'
import assert from 'node:assert/strict'
import { readAvailableModels } from './read-available-models-helper.mjs'

// ── offline fallback: listModels throws but settings has declared models → produces models ──
// Knife: remove the settingsFallback block → test a must fail (null returned)
test('a. readAvailableModels: listModels throws but settings declares models → still produces models', async () => {
  const fakeSections = [
    {
      ns: 'ns-x',
      value: {
        providers: {
          'prov-x': { models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] },
        },
      },
    },
    {
      ns: 'ns-y',
      value: {
        providers: {
          'prov-y': { models: [{ id: 'model-c', name: 'Model C' }] },
        },
      },
    },
  ]
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-x' }, { id: 'prov-y' }],
        listModels: async () => { throw new Error('402 balance insufficient') },
      }
      if (name === 'settings') return { describe: () => fakeSections }
      return undefined
    },
  }
  const result = await readAvailableModels(ctx)
  assert.ok(result, 'must return non-null when settings has declared models')
  assert.ok(Array.isArray(result.models) && result.models.length >= 3, 'all declared models must be present')
  const ids = result.models.map(m => m.id)
  assert.ok(ids.includes('model-a'), 'model-a must be present via fallback')
  assert.ok(ids.includes('model-b'), 'model-b must be present via fallback')
  assert.ok(ids.includes('model-c'), 'model-c must be present via fallback')
})

// ── both listModels and settings empty → null, no throw ──
test('b. readAvailableModels: listModels throws and settings empty → null without throwing', async () => {
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-z' }],
        listModels: async () => { throw new Error('Connection error') },
      }
      if (name === 'settings') return { describe: () => [{ ns: 'ns-z', value: { providers: { 'prov-z': { models: [] } } } }] }
      return undefined
    },
  }
  const result = await readAvailableModels(ctx)
  assert.equal(result, null, 'must return null when no models from any source')
})

// ── live result takes priority over fallback ──
test('c. readAvailableModels: live listModels result takes priority over settings fallback', async () => {
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-live' }],
        listModels: async () => [{ id: 'live-model-1', name: 'Live Model 1' }],
      }
      if (name === 'settings') return { describe: () => [{ ns: 'ns-live', value: { providers: { 'prov-live': { models: [{ id: 'fallback-only', name: 'Fallback Only' }] } } } }] }
      return undefined
    },
  }
  const result = await readAvailableModels(ctx)
  assert.ok(result, 'must return non-null')
  assert.equal(result.models.length, 1, 'only one model from live probe')
  assert.equal(result.models[0].id, 'live-model-1', 'live model must be returned')
  assert.ok(!result.models.some(m => m.id === 'fallback-only'), 'fallback model must NOT appear when live succeeded')
})
