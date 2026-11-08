import test from 'node:test'
import assert from 'node:assert/strict'
import { readAvailableModels, createModelRefresher } from '../lib/node/model-catalog.js'

// ── offline fallback: listModels throws but settings declares models via listConfigurableProviders ──
// Knife: remove settingsFallback block in model-catalog.js → test a must fail
test('a. readAvailableModels: listModels throws but settings declares models → still produces models', async () => {
  // Mirrors ds-bot config-source.js pattern: entries have {provider, settingsNs, settingsPath}
  const entries = [
    { provider: 'prov-x', settingsNs: 'ns-x', settingsPath: ['providers', 'prov-x'] },
    { provider: 'prov-y', settingsNs: 'ns-y', settingsPath: ['providers', 'prov-y'] },
  ]
  const sections = [
    { ns: 'ns-x', value: { providers: { 'prov-x': { models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] } } } },
    { ns: 'ns-y', value: { providers: { 'prov-y': { models: [{ id: 'model-c', name: 'Model C' }] } } } },
  ]
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => entries.map(e => ({ id: e.provider })),
        listModels: async () => { throw new Error('402 balance insufficient') },
        listConfigurableProviders: () => entries,
      }
      if (name === 'settings') return { describe: () => sections }
      return undefined
    },
  }
  const result = await readAvailableModels(ctx)
  assert.ok(result, 'must return non-null when settings has declared models')
  assert.ok(Array.isArray(result.models) && result.models.length >= 3, 'all declared models must be present')
  const ids = result.models.map(m => m.id)
  assert.ok(ids.includes('model-a'), 'model-a from prov-x via fallback')
  assert.ok(ids.includes('model-b'), 'model-b from prov-x via fallback')
  assert.ok(ids.includes('model-c'), 'model-c from prov-y via fallback')
})

// ── both listModels and settings empty → null, no throw ──
test('b. readAvailableModels: listModels throws and settings empty → null without throwing', async () => {
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-z' }],
        listModels: async () => { throw new Error('Connection error') },
        listConfigurableProviders: () => [{ provider: 'prov-z', settingsNs: 'ns-z', settingsPath: ['providers', 'prov-z'] }],
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
        listConfigurableProviders: () => [{ provider: 'prov-live', settingsNs: 'ns-live', settingsPath: ['providers', 'prov-live'] }],
      }
      if (name === 'settings') return { describe: () => [{ ns: 'ns-live', value: { providers: { 'prov-live': { models: [{ id: 'fallback-only', name: 'Fallback Only' }] } } } }] }
      return undefined
    },
  }
  const result = await readAvailableModels(ctx)
  assert.ok(result, 'must return non-null')
  assert.equal(result.models.length, 1, 'only one model from live probe')
  assert.equal(result.models[0].id, 'live-model-1', 'live model must be returned')
  assert.ok(!result.models.some(m => m.id === 'fallback-only'), 'fallback must NOT appear when live succeeded')
})

// ── retry behavior: first null, second has values → cache filled (short retry) ──
// Knife: remove short-retry path in createModelRefresher → test must time out or fail
test('d. createModelRefresher: first call returns null, retry fills cache', async () => {
  let callCount = 0
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-retry' }],
        listModels: async () => {
          callCount++
          if (callCount === 1) throw new Error('first call fails')
          return [{ id: 'retry-model', name: 'Retry Model' }]
        },
        listConfigurableProviders: () => [],
      }
      if (name === 'settings') return { describe: () => [] }
      return undefined
    },
  }

  let resultHistory = []
  const refresher = createModelRefresher(ctx, {
    refreshMs: 200,   // long interval: retry should NOT happen within test timeout
    retryMs: 20,      // short retry: happens quickly when cache is empty
    onResult: (r, cached) => resultHistory.push({ r, cached }),
  })

  refresher.refresh()
  // Wait for first probe (fails → cache null) and retry (succeeds → cache filled)
  // With retryMs=20ms, the retry fires ~20ms after the first null result.
  await new Promise(resolve => setTimeout(resolve, 150))

  assert.equal(callCount >= 2, true, 'must have retried at least once')
  const cached = refresher.getCachedModels()
  assert.ok(cached, 'cache must be filled after successful retry')
  assert.equal(cached.models[0].id, 'retry-model', 'cached model must be retry-model')
})
