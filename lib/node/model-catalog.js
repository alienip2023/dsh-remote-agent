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

/**
 * 收集副机可用的模型清单。
 *
 * 实时探测优先（llm.listModels）；探测失败或返回空时，从 settings 声明
 * 里按 listConfigurableProviders 条目的 settingsNs/settingsPath 下钻
 * 读声明模型作兜底。只读模型声明，不碰任何 key 字段。
 *
 * @returns {Promise<{models: Array<{provider:string,id:string,name:string}>, defaultModel: object|null}|null>}
 */
export async function readAvailableModels(ctx) {
  let llm
  try {
    llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    return null
  }
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return null
  }

  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return null
  }
  if (!Array.isArray(providers) || providers.length === 0) return null

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
    const fallbackList = liveList == null ? (settingsFallback?.get(providerId) ?? null) : null
    const effectiveList = liveList ?? fallbackList
    if (!effectiveList) continue
    for (const m of effectiveList.slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (!m || typeof m.id !== 'string' || m.id === '') continue
      const id = m.id.slice(0, 128)
      const name = typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : id
      const efforts = Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0
        ? m.reasoningEfforts.map(e => ({ id: String(e.id ?? '').slice(0, 64), name: String(e.name ?? e.id ?? '').slice(0, 128) })).filter(e => e.id !== '')
        : undefined
      const entry = { provider: providerId.slice(0, 64), id, name }
      if (efforts !== undefined) entry.efforts = efforts
      models.push(entry)
      if (models.length >= MAX_MODELS) break
    }
    if (models.length >= MAX_MODELS) break
  }

  if (models.length === 0) return null
  return { models, defaultModel: readDefaultModel(ctx) }
}


/**
 * Model refresher with shorter retry when catalog is empty.
 * Extracted for testability: tests pass very short intervals.
 *
 * @param {object} ctx - the same ctx passed to readAvailableModels
 * @param {{refreshMs?:number, retryMs?:number, onResult?:function}} [opts]
 * @returns {{refresh:function, getCachedModels:function, REFRESH_MS:number, RETRY_MS:number}}
 */
export function createModelRefresher(ctx, { refreshMs = 10 * 60 * 1000, retryMs = 30 * 1000, onResult } = {}) {
  const REFRESH_MS = refreshMs
  const RETRY_MS = retryMs
  let cachedModels = null
  let modelsTail = Promise.resolve()
  let modelsQueued = false
  let modelsTimer = undefined

  const scheduleRefresh = (ms) => {
    if (modelsTimer) clearTimeout(modelsTimer)
    modelsTimer = setTimeout(() => { modelsTimer = undefined; refresh() }, ms)
    if (modelsTimer?.unref) modelsTimer.unref()
  }

  const refresh = () => {
    if (modelsQueued) return
    modelsQueued = true
    modelsTail = modelsTail.then(async () => {
      modelsQueued = false
      let r = null
      try {
        r = await readAvailableModels(ctx)
        if (r) cachedModels = r
      } catch {
        /* keep last cached result */
      }
      // Schedule next refresh: short retry when still empty, long when we have data.
      scheduleRefresh(cachedModels ? REFRESH_MS : RETRY_MS)
      if (typeof onResult === 'function') onResult(r, cachedModels)
    })
  }

  return { refresh, getCachedModels: () => cachedModels, REFRESH_MS, RETRY_MS }
}
