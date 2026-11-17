import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFinalFromNdjson, extractSessionId } from '../lib/node/runner.js'

const ndjson = (events) => events.map((ev) => JSON.stringify(ev)).join('\n')

// The reported six-line stream, with the abbreviated usage object expanded to {}.
const currentCliOutput = `{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"text","text":"ARGV95 OK"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","sessionId":"session-…","reason":{"kind":"completed"},"text":"ARGV95 OK"}`

test('current CLI six-line stream returns the final reply', () => {
  assert.deepEqual(extractFinalFromNdjson(currentCliOutput), {
    final: 'ARGV95 OK',
    toolCalls: [],
    eventCount: 6,
  })
})

test('sessionId is extracted from the final line', () => {
  assert.equal(extractSessionId(currentCliOutput), 'session-…')
})

test('text-only stream concatenates chunks and preserves existing newlines', () => {
  const output = ndjson([
    { type: 'text', text: 'AR' },
    { type: 'text', text: 'GV95 ' },
    { type: 'status', phase: 'step_end' },
    { type: 'text', text: 'OK\n' },
    { type: 'text', text: 'next' },
    { type: 'text', text: '\nline' },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'ARGV95 OK\nnext\nline')
})

test('a later final text replaces accumulated text', () => {
  const output = ndjson([
    { type: 'text', text: 'partial reply' },
    { type: 'final', text: 'authoritative reply' },
    { type: 'text', text: 'trailing chunk' },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'authoritative reply')
})

test('an empty final text overrides streamed text and the legacy final field', () => {
  const output = ndjson([
    { type: 'text', text: 'partial reply' },
    { type: 'final', text: '', final: 'legacy reply' },
  ])
  assert.equal(extractFinalFromNdjson(output).final, '')
})

test('legacy final strings are still parsed', () => {
  assert.equal(extractFinalFromNdjson('{"type":"final","final":"x"}').final, 'x')
  assert.equal(extractFinalFromNdjson('{"final":"untyped legacy"}').final, 'untyped legacy')
})

for (const type of ['assistant/message', 'assistant.message', 'message']) {
  test(`${type} blocks are still parsed`, () => {
    const output = ndjson([{ type, message: { content: [
      { type: 'text', text: 'hello ' },
      null,
      { type: 'image', text: 'ignored' },
      { type: 'text', text: 'world' },
    ] } }])
    assert.equal(extractFinalFromNdjson(output).final, 'hello world')
  })
}

test('message content, blocks, and direct text remain supported', () => {
  for (const fields of [
    { content: [{ type: 'text', text: 'reply' }] },
    { blocks: [{ type: 'text', text: 'reply' }] },
    { text: 'reply' },
  ]) {
    assert.equal(extractFinalFromNdjson(ndjson([{ type: 'message', ...fields }])).final, 'reply')
  }
})

test('malformed lines and non-object events are skipped', () => {
  const output = 'not json\r\n{"type":\r\nnull\r\n42\r\n\r\n'
    + ndjson([{ type: 'text', text: 'valid reply' }])
  assert.deepEqual(extractFinalFromNdjson(output), {
    final: 'valid reply',
    toolCalls: [],
    eventCount: 5,
  })
})

test('non-string text fields are ignored', () => {
  const output = ndjson([
    { type: 'text', text: 'valid reply' },
    { type: 'text', text: 42 },
    { type: 'final', text: null },
  ])
  assert.equal(extractFinalFromNdjson(output).final, 'valid reply')
})

test('empty input returns an empty final reply', () => {
  for (const output of ['', ' \r\n\n']) {
    assert.deepEqual(extractFinalFromNdjson(output), { final: '', toolCalls: [], eventCount: 0 })
  }
})

test('tool calls and kind aliases remain supported', () => {
  const output = ndjson([
    { kind: 'tool/call', name: 'first' },
    { type: 'tool.call', toolName: 'second' },
    { type: 'tool/call' },
    { kind: 'message', text: 'reply' },
  ])
  const result = extractFinalFromNdjson(output)
  assert.equal(result.final, 'reply')
  assert.equal(result.eventCount, 4)
  assert.deepEqual(result.toolCalls.map((call) => call.name), ['first', 'second', 'unknown'])
  assert.ok(result.toolCalls.every((call) => Number.isFinite(call.at)))
})
