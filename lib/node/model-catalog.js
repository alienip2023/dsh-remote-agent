// Model catalog: readAvailableModels + readDefaultModel.
// Extracted from index.js so tests can import without the schemastery dependency chain.
// index.js re-exports these for existing callers.

/** 模型清单上限：够面板下拉用，又不让 RESOURCE 帧膨胀。 */
const MAX_MODELS = 64
/** 单个 provider 的模型上限（防止某个聚合 provider 一次吐几百个）。 */
const MAX_MODELS_PER_PROVIDER = 24
/** provider 数量上限。 */
const MAX_MODEL_PROVIDERS = 8

export function readDefaultModel(ctx) {
  try {
    const dm = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : undefined
    if (!sel || typeof sel !== 'object') return null
    const provider = typeof sel.provider === 'string' && sel.provider !== '' ? sel.provider.slice(0, 64) : ''
    const model = typeof sel.model === 'string' && sel.model !== '' ? sel.model.slice(0, 128) : ''
    if (model === '') return null
    return { provider, model }
  } catch {
    return null
  }
}

/** 连续这么多次「有 provider 但 live 全空」后，接受结果并回到长周期。 */
const ALL_EMPTY_RETRY_LIMIT = 6

/**
 * 收集副机可用的模型清单，并把这次探测的形状一并交回。
 *
 * 实时探测优先（llm.listModels）；探测失败或返回空时，从 settings 声明
 * 里按 listConfigurableProviders 条目的 settingsNs/settingsPath 下钻
 * 读声明模型作兜底。只读模型声明，不碰任何 key 字段。
 *
 * `providers` 是配置里 provider 的个数，`liveCount` 是这次 live 探测到的
 * 模型条数。刷新器靠这两个数区分「没有配 provider」（稳态，不重试）与
 * 「配了 provider 但 live 一条都没有」（可能是 adapter 还没注册的启动竞态）。
 *
 * @returns {Promise<{providers:number, liveCount:number, result:{models:Array<{provider:string,id:string,name:string}>, defaultModel:object|null}|null}>}
 */
export async function probeAvailableModels(ctx) {
  let llm
  try {
    llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    return { providers: 0, liveCount: 0, result: null, unavailable: true }
  }
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { providers: 0, liveCount: 0, result: null, unavailable: true }
  }

  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return { providers: 0, liveCount: 0, result: null, unavailable: true }
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    return { providers: 0, liveCount: 0, result: null, unavailable: false }
  }

  // Build offline fallback from settings declarations via listConfigurableProviders.
  // This mirrors ds-bot config-source.js buildConfigPayload: entries have
  // {provider, settingsNs, settingsPath}; settings.describe({redactSecrets:true})
  // returns sections keyed by ns; settingsPath is a path array into section.value.
  let settingsFallback = null
  try {
    const entries = typeof llm.listConfigurableProviders === 'function'
      ? llm.listConfigurableProviders()
      : (Array.isArray(llm.listConfigurableProviders) ? llm.listConfigurableProviders : [])
    if (Array.isArray(entries) && entries.length > 0) {
      const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
      if (settings && typeof settings.describe === 'function') {
        const sections = new Map(
          settings.describe({ redactSecrets: true }).map(s => [s.ns, s])
        )
        settingsFallback = new Map()
        for (const entry of entries) {
          const pid = typeof entry.provider === 'string' ? entry.provider : ''
          if (pid === '') continue
          const ns = entry.settingsNs
          const path = Array.isArray(entry.settingsPath) ? entry.settingsPath : []
          const profile = path.reduce((value, key) => value?.[key], sections.get(ns)?.value)
          if (!profile || typeof profile !== 'object') continue
          const declared = Array.isArray(profile.models) ? profile.models : []
          if (declared.length === 0) continue
          const existing = settingsFallback.get(pid) ?? []
          for (const m of declared) {
            if (m && typeof m.id === 'string' && m.id !== '') {
              existing.push({
                id: m.id.slice(0, 128),
                name: typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : m.id.slice(0, 128),
              })
            }
          }
          if (existing.length > 0) settingsFallback.set(pid, existing)
        }
      }
    }
  } catch {
    settingsFallback = null
  }

  const models = []
  let liveCount = 0
  for (const p of providers.slice(0, MAX_MODEL_PROVIDERS)) {
    const providerId = p && typeof p.id === 'string' ? p.id.trim() : ''
    if (providerId === '') continue
    let list
    try {
      list = await llm.listModels(providerId)
    } catch {
      list = null
    }
    const liveList = Array.isArray(list) && list.length > 0 ? list : null
    if (liveList) liveCount += liveList.length
    const fallbackList = liveList == null ? (settingsFallback?.get(providerId) ?? null) : null
    const effectiveList = liveList ?? fallbackList
    if (!effectiveList) continue
    for (const m of effectiveList.slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (!m || typeof m.id !== 'string' || m.id === '') continue
      const id = m.id.slice(0, 128)
      const name = typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : id
      // 空/空白 effort id 不是一级等级：过滤掉（trim 后再判空，避免 '   ' 混过去）。
      const efforts = Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0
        ? m.reasoningEfforts
          .map(e => ({ id: String(e?.id ?? '').trim().slice(0, 64), name: String(e?.name ?? e?.id ?? '').slice(0, 128) }))
          .filter(e => e.id !== '')
        : undefined
      const entry = { provider: providerId.slice(0, 64), id, name }
      if (efforts !== undefined) entry.efforts = efforts
      models.push(entry)
      if (models.length >= MAX_MODELS) break
    }
    if (models.length >= MAX_MODELS) break
  }

  return {
    providers: providers.length,
    liveCount,
    result: models.length === 0 ? null : { models, defaultModel: readDefaultModel(ctx) },
    unavailable: false,
  }
}

/**
 * 只取模型清单的旧入口：调用方不关心这次探测的形状。
 *
 * @returns {Promise<{models: Array<{provider:string,id:string,name:string}>, defaultModel: object|null}|null>}
 */
export async function readAvailableModels(ctx) {
  return (await probeAvailableModels(ctx)).result
}


/**
 * Model refresher with shorter retry when catalog is empty.
 * Extracted for testability: tests pass very short intervals.
 *
 * @param {object} ctx - the same ctx passed to readAvailableModels
 * @param {{refreshMs?:number, retryMs?:number, onResult?:function}} [opts]
 * @returns {{refresh:function, getCachedModels:function, REFRESH_MS:number, RETRY_MS:number}}
 */
export function createModelRefresher(ctx, { refreshMs = 10 * 60 * 1000, retryMs = 30 * 1000, onResult, allEmptyRetryLimit = ALL_EMPTY_RETRY_LIMIT } = {}) {
  const REFRESH_MS = refreshMs
  const RETRY_MS = retryMs
  let cachedModels = null
  let modelsTail = Promise.resolve()
  let modelsQueued = false
  let modelsTimer = undefined
  let emptyRuns = 0
  let warnedAllEmpty = false

  const scheduleRefresh = (ms) => {
    if (modelsTimer) clearTimeout(modelsTimer)
    modelsTimer = setTimeout(() => { modelsTimer = undefined; refresh() }, ms)
    if (modelsTimer?.unref) modelsTimer.unref()
  }

  const warnAllEmpty = () => {
    if (warnedAllEmpty) return
    warnedAllEmpty = true
    const message = `[model-catalog] ${emptyRuns} probes in a row saw providers but no live models; treating the empty catalog as settled and returning to the ${Math.round(REFRESH_MS / 1000)}s cycle`
    try {
      const logger = ctx?.logger ?? (typeof ctx?.get === 'function' ? ctx.get('logger') : undefined)
      if (logger && typeof logger.warn === 'function') {
        logger.warn(message)
        return
      }
    } catch {
      /* fall through to console */
    }
    console.warn(message)
  }

  const refresh = () => {
    if (modelsQueued) return
    modelsQueued = true
    modelsTail = modelsTail.then(async () => {
      modelsQueued = false
      let probed = { providers: 0, liveCount: 0, result: null, unavailable: true }
      try {
        probed = await probeAvailableModels(ctx)
      } catch {
        /* keep last cached result */
      }
      let r = probed.result
      let delay = REFRESH_MS
      if (probed.unavailable) {
        // The llm service is not ready yet. This is the same startup window as an empty
        // live catalog, so retry on the short interval under the same cap.
        emptyRuns += 1
        if (emptyRuns >= allEmptyRetryLimit) {
          cachedModels = null
          warnAllEmpty()
          emptyRuns = 0
        } else {
          r = null
          delay = RETRY_MS
        }
      } else if (probed.providers === 0) {
        // Nothing is configured: null is the answer, and there is nothing to retry.
        cachedModels = null
        emptyRuns = 0
      } else if (probed.liveCount === 0) {
        emptyRuns += 1
        if (emptyRuns >= allEmptyRetryLimit) {
          // A catalog-only deployment has routes but no declared models, so an empty
          // live catalog is its steady state, not a startup race. Accept it once,
          // warn once, and stop probing every 30 seconds.
          cachedModels = r
          warnAllEmpty()
          emptyRuns = 0
        } else {
          // A declared-model fallback may be shown by a direct caller, but it is not
          // evidence that the live catalog is ready — never cache it here.
          r = null
          delay = RETRY_MS
        }
      } else {
        emptyRuns = 0
        warnedAllEmpty = false
        if (r) cachedModels = r
        delay = cachedModels ? REFRESH_MS : RETRY_MS
      }
      scheduleRefresh(delay)
      if (typeof onResult === 'function') onResult(r, cachedModels)
    })
  }

  // A model list changes when a provider's models are refreshed or an adapter is
  // installed/removed; both are exactly the moment a stuck empty catalog can fill.
  if (typeof ctx?.on === 'function') {
    for (const event of ['llm/models-updated', 'llm/adapters-updated']) {
      try {
        ctx.on(event, () => refresh())
      } catch {
        /* older harnesses may not expose the event */
      }
    }
  }

  return { refresh, getCachedModels: () => cachedModels, REFRESH_MS, RETRY_MS }
}
