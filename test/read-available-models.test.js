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

// ── an empty live catalog with providers configured is a probe that has to be repeated ──
// Knife: cache the all-empty result (or fall back to declarations) → e must fail
test('e. an all-empty live probe with providers is not cached and is retried', async () => {
  let probes = 0
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-empty' }],
        listModels: async () => { probes++; return [] },
        listConfigurableProviders: () => [{ provider: 'prov-empty', settingsNs: 'ns-e', settingsPath: ['providers', 'prov-empty'] }],
      }
      if (name === 'settings') return {
        describe: () => [{ ns: 'ns-e', value: { providers: { 'prov-empty': { models: [{ id: 'stale-model' }] } } } }],
      }
      return undefined
    },
  }
  const seen = []
  const refresher = createModelRefresher(ctx, {
    refreshMs: 10_000,
    retryMs: 15,
    onResult: (r, cached) => seen.push({ r, cached }),
  })
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.ok(probes >= 2, 'the empty live catalog must be probed again on the retry interval')
  assert.equal(refresher.getCachedModels(), null, 'an all-empty probe is never cached, not even from declarations')
  assert.ok(seen.every(entry => entry.r === null), 'an all-empty probe reports null, never a fallback as truth')
})

// ── once the live catalog has models the long cycle takes over ──
test('f. a later probe with models fills the cache and a long cycle follows', async () => {
  let probes = 0
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-late' }],
        listModels: async () => {
          probes++
          if (probes === 1) return []
          return [{ id: 'late-model', name: 'Late Model' }]
        },
        listConfigurableProviders: () => [{ provider: 'prov-late', settingsNs: 'ns-late', settingsPath: ['providers', 'prov-late'] }],
      }
      if (name === 'settings') return {
        describe: () => [{ ns: 'ns-late', value: { providers: { 'prov-late': { models: [{ id: 'stale-model' }] } } } }],
      }
      return undefined
    },
  }
  const refresher = createModelRefresher(ctx, { refreshMs: 10_000, retryMs: 15 })
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.ok(refresher.getCachedModels(), 'the second probe must fill the cache')
  assert.equal(refresher.getCachedModels().models[0].id, 'late-model')
  const settled = probes
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(probes, settled, 'after a hit the next probe waits for the long cycle, not the retry interval')
})

// ── six all-empty probes in a row are accepted, with one warning ──
// Knife: remove the retry limit → g never settles (probes keep coming, no warning)
test('g. six all-empty probes in a row settle the catalog and warn once', async () => {
  let probes = 0
  const warns = []
  const ctx = {
    logger: { warn: (message) => warns.push(message) },
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-settled' }],
        listModels: async () => { probes++; return [] },
        listConfigurableProviders: () => [],
      }
      if (name === 'settings') return { describe: () => [] }
      if (name === 'logger') return ctx.logger
      return undefined
    },
  }
  const refresher = createModelRefresher(ctx, { refreshMs: 10_000, retryMs: 5 })
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(probes, 6, 'the sixth empty probe is the last one on the retry interval')
  assert.equal(warns.length, 1, 'the settled empty catalog warns exactly once')
  const settled = probes
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(probes, settled, 'after settling there is no 30s loop any more')
})

// ── no providers at all is a settled null, not a retry ──
test('h. no providers at all caches null and does not retry', async () => {
  let modelsCalls = 0
  const ctx = {
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [],
        listModels: async () => { modelsCalls++; return [] },
        listConfigurableProviders: () => [],
      }
      if (name === 'settings') return { describe: () => [] }
      return undefined
    },
  }
  const refresher = createModelRefresher(ctx, { refreshMs: 10_000, retryMs: 5 })
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(modelsCalls, 0, 'no provider means nothing to list')
  assert.equal(refresher.getCachedModels(), null)
  const seen = modelsCalls
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(modelsCalls, seen, 'a provider-less catalog is not retried on the short interval')
})

// ── a model list update wakes the refresher immediately ──
test('i. an llm models-updated event refreshes the catalog at once', async () => {
  let probes = 0
  const listeners = new Map()
  const ctx = {
    on: (event, listener) => { listeners.set(event, listener) },
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-event' }],
        listModels: async () => { probes++; return [{ id: 'event-model', name: 'Event Model' }] },
        listConfigurableProviders: () => [],
      }
      if (name === 'settings') return { describe: () => [] }
      return undefined
    },
  }
  const refresher = createModelRefresher(ctx, { refreshMs: 10_000, retryMs: 10_000 })
  assert.equal(typeof listeners.get('llm/models-updated'), 'function', 'the refresher subscribes to llm/models-updated')
  assert.equal(typeof listeners.get('llm/adapters-updated'), 'function', 'the refresher subscribes to llm/adapters-updated')
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(probes, 1)
  listeners.get('llm/models-updated')()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(probes, 2, 'the event probes without waiting for the cycle')
})

// ── an llm that is not there yet is retried, then accepted once after the cap ──
// Knife: treat unavailable as "no providers" → j never retries (one access, no warn)
test('j. an unavailable llm is retried and then accepted once, caching nothing', async () => {
  let accesses = 0
  const warns = []
  const ctx = {
    logger: { warn: (message) => warns.push(message) },
    get: (name) => {
      if (name === 'llm') { accesses++; return undefined }
      if (name === 'settings') return { describe: () => [] }
      if (name === 'logger') return ctx.logger
      return undefined
    },
  }
  const refresher = createModelRefresher(ctx, { refreshMs: 10_000, retryMs: 5 })
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(accesses, 6, 'an unready llm is retried until the sixth probe')
  assert.equal(warns.length, 1, 'the settled unavailable catalog warns exactly once')
  assert.equal(refresher.getCachedModels(), null, 'nothing is cached while the llm is unavailable')
  const settled = accesses
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(accesses, settled, 'after settling there is no 30s loop any more')
})

// ── a live catalog resets the warning, so a later empty streak warns again ──
test('k. a successful probe resets the warning for a later empty streak', async () => {
  let mode = 'empty'
  const warns = []
  const ctx = {
    logger: { warn: (message) => warns.push(message) },
    get: (name) => {
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov-cycle' }],
        listModels: async () => (mode === 'live' ? [{ id: 'recovered', name: 'Recovered' }] : []),
        listConfigurableProviders: () => [],
      }
      if (name === 'settings') return { describe: () => [] }
      if (name === 'logger') return ctx.logger
      return undefined
    },
  }
  const refresher = createModelRefresher(ctx, { refreshMs: 10_000, retryMs: 5 })
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(warns.length, 1, 'the first empty streak warns once')
  assert.equal(refresher.getCachedModels(), null)

  mode = 'live'
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(refresher.getCachedModels()?.models?.[0]?.id, 'recovered', 'a live probe fills the cache again')

  mode = 'empty'
  refresher.refresh()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(warns.length, 2, 'a later empty streak warns again after the reset')
})
