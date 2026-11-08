import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTurnSeq } from '../lib/node/turn-seq.js'

describe('turn-seq', () => {
  let tmpDir

  function makeTurnSeq() {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-seq-test-'))
    return createTurnSeq(tmpDir)
  }

  test('S21-seq-monotone: monotone across calls', () => {
    const ts = makeTurnSeq()
    try {
      const s0 = ts.next('bot-a')
      const s1 = ts.next('bot-a')
      const s2 = ts.next('bot-a')
      assert.equal(s0, 0)
      assert.equal(s1, 1)
      assert.equal(s2, 2)
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  })

  test('S21-seq-dedup: different botIds get independent counters', () => {
    const ts = makeTurnSeq()
    try {
      assert.equal(ts.next('bot-a'), 0)
      assert.equal(ts.next('bot-b'), 0)
      assert.equal(ts.next('bot-a'), 1)
      assert.equal(ts.next('bot-b'), 1)
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  })

  test('cross-restart: second createTurnSeq on same dir does not go back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-seq-restart-'))
    try {
      const ts1 = createTurnSeq(dir)
      ts1.next('bot-r')  // 0
      ts1.next('bot-r')  // 1

      const ts2 = createTurnSeq(dir)
      const s = ts2.next('bot-r')
      assert.ok(s >= 2, `expected seq >= 2 after restart, got ${s}`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('reset (test-only): allows counter to restart', () => {
    const ts = makeTurnSeq()
    try {
      ts.next('bot-x')  // 0
      ts.next('bot-x')  // 1
      ts.reset('bot-x')
      assert.equal(ts.next('bot-x'), 0)
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  })
})

// ---- S21-seq-missing-unit: validateBotTurnResult seq validation ----
import { validateBotTurnResult } from '../lib/protocol.js'
import { test as t, describe as d } from 'node:test'
import assert2 from 'node:assert/strict'

d('S21-seq-missing-unit: validateBotTurnResult seq field', () => {
  const base = { nodeId: 'n1', remoteBotId: 'rb1', exchangeId: 'e1', text: 'ok', ok: true }

  t('seq missing -> bot-turn-result-seq-missing', () => {
    const r = validateBotTurnResult({ ...base })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-missing')
  })

  t('seq is string -> bot-turn-result-seq-missing', () => {
    const r = validateBotTurnResult({ ...base, seq: '7' })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-missing')
  })

  t('seq is float -> bot-turn-result-seq-missing', () => {
    const r = validateBotTurnResult({ ...base, seq: 3.5 })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-missing')
  })

  t('seq is negative -> bot-turn-result-seq-invalid', () => {
    const r = validateBotTurnResult({ ...base, seq: -1 })
    assert2.equal(r.ok, false)
    assert2.equal(r.error, 'bot-turn-result-seq-invalid')
  })

  t('seq is 0 -> ok', () => {
    const r = validateBotTurnResult({ ...base, seq: 0 })
    assert2.equal(r.ok, true)
    assert2.equal(r.result.seq, 0)
  })

  t('seq is positive integer -> ok', () => {
    const r = validateBotTurnResult({ ...base, seq: 42 })
    assert2.equal(r.ok, true)
    assert2.equal(r.result.seq, 42)
  })
})
