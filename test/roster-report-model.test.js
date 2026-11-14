import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRosterBots, rosterFrame } from '../lib/roster-report.js'

test('cleanRosterBots passes a trimmed model, truncates over-long, and drops a bad field', () => {
  // Knife: delete the model pass-through in cleanRosterBots → model is absent and this fails.
  const [kept] = cleanRosterBots([{ id: 'a', name: 'A', role: 'r', model: '  node/only  ' }])
  assert.equal(kept.id, 'a')
  assert.equal(kept.name, 'A')
  assert.equal(kept.model, 'node/only')

  const exact = 'm'.repeat(128)
  const [full] = cleanRosterBots([{ id: 'e', name: 'E', role: 'r', model: exact }])
  assert.equal(full.model, exact)

  const [cut] = cleanRosterBots([{ id: 'b', name: 'B', role: 'r', model: ` ${'m'.repeat(129)} ` }])
  assert.equal(cut.id, 'b')
  assert.equal(cut.model, 'm'.repeat(128))
  assert.equal(cut.model.length, 128)

  for (const model of [7, null, {}, '   ', '']) {
    const [bad] = cleanRosterBots([{ id: 'c', name: 'C', role: 'r', model }])
    assert.equal(bad.id, 'c', 'a bad model must not drop the bot')
    assert.equal(bad.name, 'C')
    assert.equal(Object.hasOwn(bad, 'model'), false, `model ${JSON.stringify(model)} must be dropped`)
  }

  const frame = rosterFrame({
    nodeId: 'n1',
    hostname: 'desk',
    bots: [{ id: 'a', name: 'A', role: 'r', model: 'node/only' }],
  })
  assert.equal(frame.nodeId, 'n1')
  assert.equal(frame.hostname, 'desk')
  assert.equal(frame.bots[0].model, 'node/only')
  assert.equal(frame.bots[0].id, 'a')
})
