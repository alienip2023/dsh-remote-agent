import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRosterBots, rosterFrame } from '../lib/roster-report.js'

test('cleanRosterBots and rosterFrame carry a trimmed valid clusterBotId', () => {
  const bots = [{ id: 'a', clusterBotId: '  bot-7  ' }]
  const [entry] = cleanRosterBots(bots)
  assert.equal(entry.clusterBotId, 'bot-7')
  assert.equal(rosterFrame({ bots }).bots[0].clusterBotId, 'bot-7')

  for (const clusterBotId of ['a', '7', 'A0._-z', 'a'.repeat(64)]) {
    const [valid] = cleanRosterBots([{ id: 'a', clusterBotId }])
    assert.equal(valid.clusterBotId, clusterBotId)
  }
})

test('cleanRosterBots keeps a bot without a clusterBotId and omits the key', () => {
  const entries = cleanRosterBots([{ id: 'a' }])
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], { id: 'a', name: '', role: '' })
  assert.equal(Object.hasOwn(entries[0], 'clusterBotId'), false)
})

test('cleanRosterBots drops malformed clusterBotId values and keeps every bot', () => {
  const malformed = ['', '  ', '-bad', 'a b', 'a'.repeat(65), 42, null, '.bad', '_bad', 'a/b', '机器人', {}]
  const bots = malformed.map((clusterBotId, index) => ({ id: `bot-${index}`, clusterBotId }))
  const entries = cleanRosterBots(bots)
  assert.equal(entries.length, bots.length)
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.id, bots[index].id)
    assert.equal(Object.hasOwn(entry, 'clusterBotId'), false, `must drop ${JSON.stringify(malformed[index])}`)
  }
})

test('clusterBotId preserves existing id, name, role, and model handling', () => {
  const bots = [
    { id: ` ${'i'.repeat(81)} `, name: ` ${'n'.repeat(41)} `, role: ` ${'r'.repeat(25)} `, model: ` ${'m'.repeat(129)} `, clusterBotId: 'bot-7' },
    { id: ' b ', name: ' Bot B ', role: ' writer ', model: ' node/model ', clusterBotId: 'bot-8' },
    { id: 'c', name: 42, role: null, model: 42, clusterBotId: 'bot-9' },
    { id: ' ', clusterBotId: 'bot-10' },
    { id: 'worker', type: 'remote-worker', clusterBotId: 'bot-11' },
  ]
  const entries = cleanRosterBots(bots)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(({ clusterBotId, ...entry }) => entry), [
    { id: 'i'.repeat(80), name: 'n'.repeat(40), role: 'r'.repeat(24), model: 'm'.repeat(128) },
    { id: 'b', name: 'Bot B', role: 'writer', model: 'node/model' },
    { id: 'c', name: '', role: '' },
  ])
  assert.deepEqual(entries.map((entry) => entry.clusterBotId), ['bot-7', 'bot-8', 'bot-9'])
})
