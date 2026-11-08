// Standalone copy of readAvailableModels for testing — DO NOT import from production.
const MAX_MODELS = 64
const MAX_MODELS_PER_PROVIDER = 24
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

  // Read settings-declared models as offline fallback when live probe fails or returns empty.
  // Keys are provider id, value is array of {id, name} from the settings declaration.
  let settingsFallback = null
  try {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    if (settings && typeof settings.describe === 'function') {
      const sections = settings.describe({ redactSecrets: true })
      if (Array.isArray(sections)) {
        settingsFallback = new Map()
        for (const section of sections) {
          const ps = section?.value?.providers
          if (!ps || typeof ps !== 'object') continue
          for (const [pid, pcfg] of Object.entries(ps)) {
            if (!Array.isArray(pcfg?.models) || pcfg.models.length === 0) continue
            const existing = settingsFallback.get(pid) ?? []
            for (const m of pcfg.models) {
              if (m && typeof m.id === 'string' && m.id !== '') {
                existing.push({ id: m.id.slice(0, 128), name: typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : m.id.slice(0, 128) })
              }
            }
            if (existing.length > 0) settingsFallback.set(pid, existing)
          }
        }
      }
    }
  } catch {
    settingsFallback = null
  }

  const models = []
  // 逐个 provider 探测；单个失败静默跳过（不打断其它）。
  for (const p of providers.slice(0, MAX_MODEL_PROVIDERS)) {
    const providerId = p && typeof p.id === 'string' ? p.id.trim() : ''
    if (providerId === '') continue
    let list
    try {
      // 逐个探测是刻意的：并发打满会把副机的出站连接占住，
      // 而这里只是低频遥测（RESOURCE 帧 30s 一次）。
      list = await llm.listModels(providerId)
    } catch {
      list = null
    }
    // If live probe failed or returned empty, fall back to settings-declared models.
    const liveList = Array.isArray(list) && list.length > 0 ? list : null
    const fallbackList = liveList == null ? (settingsFallback?.get(providerId) ?? null) : null
    const effectiveList = liveList ?? fallbackList
    if (!effectiveList) continue
    for (const m of effectiveList.slice(0, MAX_MODELS_PER_PROVIDER)) {
      if (!m || typeof m.id !== 'string' || m.id === '') continue
      const id = m.id.slice(0, 128)
      const name = typeof m.name === 'string' && m.name !== '' ? m.name.slice(0, 128) : id
      models.push({ provider: providerId.slice(0, 64), id, name })
      if (models.length >= MAX_MODELS) break
    }
    if (models.length >= MAX_MODELS) break
  }

  if (models.length === 0) return null
  return { models, defaultModel: readDefaultModel(ctx) }
}
