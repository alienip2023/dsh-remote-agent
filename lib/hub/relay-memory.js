/**
 * 本进程中继配置覆盖层。
 *
 * 写盘成功后必须立刻让本进程看见 relay.url / relay.token，否则
 * ssh-onboard 与 /ui/config 仍读到空值，用户还得再重启一次。
 * cordis 有时会冻结 config：赋值抛错时只留 overlay，读取口径只有这一份。
 */
import { extractPreservedConfig, readManagedBlockBody } from '../setup.js'

const overlays = new WeakMap()

function slotOf(config) {
  let slot = overlays.get(config)
  if (!slot) {
    slot = { url: '', token: '', transportMode: '' }
    overlays.set(config, slot)
  }
  return slot
}

export function readRelayUrl(config) {
  const slot = overlays.get(config)
  if (slot && typeof slot.url === 'string' && slot.url !== '') return slot.url
  if (typeof config?.relay?.url === 'string' && config.relay.url !== '') return config.relay.url
  if (typeof config?.relayUrl === 'string') return config.relayUrl
  return ''
}

export function readRelayToken(config) {
  const slot = overlays.get(config)
  if (slot && typeof slot.token === 'string' && slot.token !== '') return slot.token
  if (typeof config?.relay?.token === 'string' && config.relay.token !== '') return config.relay.token
  if (typeof config?.relayToken === 'string') return config.relayToken
  return ''
}

export function readRelayTransportMode(config) {
  const slot = overlays.get(config)
  if (slot && typeof slot.transportMode === 'string' && slot.transportMode !== '') return slot.transportMode
  if (typeof config?.transportMode === 'string' && config.transportMode !== '') return config.transportMode
  return 'relay'
}

export function applyRelayMemory(config, { relayUrl = '', token = '' } = {}) {
  if (!config || typeof config !== 'object') return
  const slot = slotOf(config)
  slot.url = String(relayUrl || '')
  slot.token = String(token || '')
  slot.transportMode = 'relay'
  try {
    const prev = config.relay && typeof config.relay === 'object' ? config.relay : {}
    config.relay = { ...prev, url: slot.url, token: slot.token }
    config.relayUrl = slot.url
    config.transportMode = 'relay'
  } catch {
    /* frozen: overlay already holds the values */
  }
}

function q(s) {
  return `'${String(s ?? '').replace(/'/g, "''")}'`
}

function configScalar(body, key, fallback) {
  const re = new RegExp(`^ {4}${key}:\\s*(.*)$`, 'm')
  const m = String(body || '').match(re)
  if (!m) return fallback
  const value = m[1].trim()
  return value === '' ? fallback : value
}

function injectLine(body) {
  const m = String(body || '').match(/^ {2}inject:.*$/m)
  return m ? m[0].trim() : "inject: ['webServer', 'tools', 'systemPrompt']"
}

/** 生成托管块正文（不含标记）。保留 inject/role/transportMode，写入 relayUrl 与 relay.url/token。 */
export function buildRelayAutoconfigYaml(existingText, { relayUrl, hubToken } = {}) {
  const body = readManagedBlockBody(existingText)
  const preserved = extractPreservedConfig(body, ['role', 'transportMode', 'relayUrl', 'relay'])
  const lines = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    `  ${injectLine(body)}`,
    '  config:',
    `    role: ${configScalar(body, 'role', 'hub')}`,
    `    transportMode: ${configScalar(body, 'transportMode', 'relay')}`,
    `    relayUrl: ${q(relayUrl)}`,
    '    relay:',
    `      url: ${q(relayUrl)}`,
    `      token: ${q(hubToken)}`,
  ]
  if (preserved.length > 0) lines.push(...preserved)
  return `${lines.join('\n')}\n`
}
