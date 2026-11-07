import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bindRosterReport } from '../lib/roster-report.js'
import { withIngest } from '../lib/hub/registry-ingest.js'
import { NODE_TO_HUB } from '../lib/protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function dsBotRoster() {
  const env = process.env.DS_BOT_REPO
  if (typeof env === 'string' && env.trim() !== '') {
    const file = join(resolve(env.trim()), 'src/host/roster-join.js')
    if (!existsSync(file)) return { error: `DS_BOT_REPO=${resolve(env.trim())} 没有 src/host/roster-join.js，影子断言跳过` }
    return { file }
  }
  const candidates = [
    resolve(HERE, '../../ds-bot-roster-join/ds-bot/src/host/roster-join.js'),
    resolve(HERE, '../ds-bot/src/host/roster-join.js'),
    resolve(HERE, '../../ds-bot/ds-bot/src/host/roster-join.js'),
  ]
  const file = candidates.find((item) => existsSync(item))
  if (!file) return { error: `未设置 DS_BOT_REPO，相对路径也没有 roster-join.js：${candidates.join(', ')}` }
  return { file }
}

const dsBot = dsBotRoster()
if (dsBot.error) console.error(dsBot.error)

function registryFor(nodeId) {
  const listeners = {}
  class Core {
    constructor() {
      this.nodes = new Map([[nodeId, { nodeId, lastSeen: 0, online: true }]])
      this.tasks = new Map()
    }
    log() {}
    send() {}
    on(name, fn) {
      (listeners[name] ??= []).push(fn)
      return () => {}
    }
    emit(name, payload) {
      for (const fn of listeners[name] ?? []) fn(payload)
    }
  }
  return new (withIngest(Core))()
}

test('roster report becomes stable shadows after ingest', { skip: dsBot.error || false }, async () => {
  const offlineSrc = readFileSync(new URL('../lib/hub/node-registry.js', import.meta.url), 'utf8')
  assert.match(offlineSrc, /this\.emit\('nodeOffline'/, '断连必须发出 nodeOffline，否则影子行无法标离线')

  const { applyRosterReport, markNodeOffline, shadowId } = await import(pathToFileURL(dsBot.file).href)
  const nodeId = 'node-a'
  const registry = registryFor(nodeId)
  const state = { bots: {} }
  registry.on('roster', (report) => applyRosterReport(state, report, 1000))
  registry.on('nodeOffline', ({ nodeId: id }) => markNodeOffline(state, id, 2000))

  const sent = []
  const report = bindRosterReport({ set() {} }, {
    send: (type, data) => { sent.push({ type, data }); return true },
    nodeId,
    hostname: 'desk-1',
  })
  const bots = [
    { id: 'alpha', name: 'Alpha', role: '写' },
    { id: 'beta', name: 'Beta', role: '测' },
    { id: 'skip-me', name: 'Nope', type: 'remote-worker' },
  ]
  assert.equal(report({ bots }), true)
  assert.equal(sent[0].type, NODE_TO_HUB.ROSTER)
  assert.notEqual(sent[0].type, NODE_TO_HUB.HELLO)
  registry.handleFrameFor(nodeId, { t: sent[0].type, d: sent[0].data })

  const alpha = shadowId(nodeId, 'alpha')
  const beta = shadowId(nodeId, 'beta')
  assert.equal(alpha, shadowId(nodeId, 'alpha'))
  assert.equal(state.bots[alpha]?.id, alpha)
  assert.equal(state.bots[alpha].worker.online, true)
  assert.equal(state.bots[alpha].worker.hostname, 'desk-1')
  assert.equal(state.bots[beta].name, 'Beta')
  assert.equal(state.bots[shadowId(nodeId, 'skip-me')], undefined)
  assert.equal(Object.keys(state.bots).length, 2)

  assert.equal(report({ bots }), true)
  registry.handleFrameFor(nodeId, { t: sent[1].type, d: sent[1].data })
  assert.equal(Object.keys(state.bots).length, 2)
  assert.equal(state.bots[alpha].createdAt, 1000)

  registry.emit('nodeOffline', { nodeId })
  assert.equal(state.bots[alpha].worker.online, false)
  assert.equal(state.bots[beta].worker.online, false)
  assert.equal(Object.keys(state.bots).length, 2)
})
