import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { validateBotDirectory } from '../lib/protocol.js'
import { createBotNetwork } from '../lib/node/bot-network.js'
import { createHubBotNetwork } from '../lib/hub/bot-network.js'

const room = { id: 'r1', name: '二开收口', members: 3 }
const bot = { id: 'b1', name: 'Bot', nodeId: 'node-a', role: '' }

test('1 validateBotDirectory keeps room names and integer member counts without unknown fields', () => {
  const input = { bots: [], rooms: [{ ...room, extra: true }], at: 1, extra: true }
  const checked = validateBotDirectory(input)
  assert.deepEqual(checked, { bots: [], rooms: [room], at: 1 })
  assert.notEqual(checked.rooms[0], input.rooms[0])
})

test('2 validateBotDirectory defaults missing rooms to an empty array for legacy hubs', () => {
  assert.deepEqual(validateBotDirectory({ bots: [], at: 1 }), { bots: [], rooms: [], at: 1 })
})

test('3 validateBotDirectory drops invalid rooms including names longer than 80 characters (no truncation)', () => {
  const invalid = [null, [], {}, { name: room.name, members: 3 },
    { ...room, id: '' }, { ...room, id: '   ' }, { ...room, id: 1 }, { ...room, id: 'r'.repeat(201) },
    { ...room, members: -1 }, { ...room, members: '3' }, { ...room, members: 0.5 },
    { ...room, members: Infinity }, { id: room.id, name: room.name },
    { ...room, name: 'n'.repeat(81) }, { ...room, name: null }]
  assert.deepEqual(validateBotDirectory({ bots: [], rooms: [...invalid, room] }).rooms, [room])
  for (const rooms of [null, {}, 'rooms', 3]) {
    assert.deepEqual(validateBotDirectory({ bots: [], rooms }).rooms, [])
  }
})

test('validateBotDirectory trims room names and accepts empty names, zero members and boundary lengths', () => {
  const rooms = [room, { id: 'r2', name: '', members: 0 },
    { id: 'r3', name: '   ', members: 0 }, { id: 'r'.repeat(200), name: 'n'.repeat(80), members: 1 }]
  assert.deepEqual(validateBotDirectory({ bots: [], rooms: [
    { ...room, name: `  ${room.name}  ` }, ...rooms.slice(1),
  ] }).rooms, rooms.map(r => ({ ...r, name: r.name.trim() })))
})

test('4 validateBotDirectory caps rooms at the first 100 entries', () => {
  const rooms = Array.from({ length: 105 }, (_, i) => ({ ...room, id: `r${i}` }))
  assert.deepEqual(validateBotDirectory({ bots: [], rooms }).rooms, rooms.slice(0, 100))
})

test('5 receiveDirectory emits a bots and rooms object and keeps the bots directory API', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  let emitted
  network.on('directory', value => { emitted = value })
  network.receiveDirectory({ bots: [bot], rooms: [room], at: 1 })
  assert.equal(network.rooms()[0]?.name, '二开收口')
  assert.equal(emitted.rooms[0].name, '二开收口')
  assert.deepEqual(emitted, { bots: [bot], rooms: [room] })
  assert.deepEqual(network.rooms(), emitted.rooms)
  assert.deepEqual(network.directory(), [bot])
})

test('6 malformed directory frames do not throw or change the previous rooms and warn with the stable code', t => {
  const warnings = []
  const network = createBotNetwork({ nodeId: 'node-a', logger: { warn: (...args) => warnings.push(args) } })
  t.after(() => network.dispose())
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  let events = 0
  network.on('directory', () => { events++ })
  for (const frame of [null, [], {}, { bots: 'invalid', rooms: [] }, { bots: Array(501).fill(bot), rooms: [] }]) {
    assert.doesNotThrow(() => network.receiveDirectory(frame))
    assert.deepEqual(network.rooms(), [room])
    assert.deepEqual(network.directory(), [bot])
  }
  assert.equal(events, 0)
  assert.equal(warnings.length, 5)
  assert.ok(warnings.every(([, context]) => context.code === 'bot-directory-invalid'))
})

test('directory events and rooms snapshots cannot mutate the cached directory', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  const input = { bots: [{ ...bot }], rooms: [{ ...room }] }
  network.on('directory', value => {
    value.bots[0].name = 'changed'
    value.rooms[0].name = 'changed'
    value.rooms.pop()
  })
  network.receiveDirectory(input)
  input.rooms[0].name = 'changed'
  const snapshot = network.rooms()
  snapshot[0].members = 99
  snapshot.pop()
  assert.deepEqual(network.rooms(), [room])
  assert.deepEqual(network.directory(), [bot])
})

test('legacy replacement and disposal clear the cached rooms', t => {
  const network = createBotNetwork({ nodeId: 'node-a' })
  t.after(() => network.dispose())
  assert.deepEqual(network.rooms(), [])
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  network.receiveDirectory({ bots: [bot] })
  assert.deepEqual(network.rooms(), [])
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  network.dispose()
  assert.deepEqual(network.rooms(), [])
  assert.deepEqual(network.directory(), [])
  network.receiveDirectory({ bots: [bot], rooms: [room] })
  assert.deepEqual(network.rooms(), [])
})

test('hub sendDirectory carries validated rooms to the node and supports the two-argument call', t => {
  const node = createBotNetwork({ nodeId: 'node-a' })
  const registry = new EventEmitter()
  const sent = []
  registry.send = (nodeId, type, data) => {
    sent.push({ nodeId, type, data })
    node.receiveDirectory(JSON.parse(JSON.stringify(data)))
    return true
  }
  const hub = createHubBotNetwork({ registry })
  t.after(() => { hub.dispose(); node.dispose() })
  assert.equal(hub.sendDirectory('node-a', [bot], [{ ...room, extra: true }, {}]), true)
  assert.deepEqual(sent[0], { nodeId: 'node-a', type: 'bot/directory',
    data: { bots: [bot], rooms: [room], at: sent[0].data.at } })
  assert.equal(typeof sent[0].data.at, 'number')
  assert.deepEqual(node.rooms(), [room])
  assert.equal(hub.sendDirectory('node-a', [bot]), true)
  assert.deepEqual(sent[1].data.rooms, [])
  assert.deepEqual(node.rooms(), [])
  assert.deepEqual(node.directory(), [bot])
})
