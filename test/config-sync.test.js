/**
 * M2 config-sync 测试。
 *
 * 测试覆盖（合同 m2-contract.md §44-53 验收口径）：
 *  1. 推 revision=1 → 节点 appliedRevision=1，回执 ok:true
 *  2. 重发 revision=1 → 节点丢弃，无回执
 *  3. provider id 含特殊字符 → merge-failed, invalid-provider-id
 *  4. 应用中途失败（写盘失败）→ 回滚，appliedRevision 不变，rollbackRevision 正确
 *  5. 合并后其他 ref 仍在
 *  6. 合并后其他 patch 条目仍在
 *  7. patch 无明文密钥（只有 apiKeyEnv ref 名）
 *  8. provider 集合没变 → shouldRestart=false
 *  9. provider 集合变了 → shouldRestart=true
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleConfigPush, handleConfigSyncRequest, sendConfigSyncRequest } from '../lib/node/config-sync.js'
import { createConfigSync } from '../lib/hub/config-sync.js'
import { computeRevision } from '../lib/hub/stable-hash.js'

function makeTmpHome() {
  const base = mkdtempSync(join(tmpdir(), 'config-sync-test-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir }
}

function makePayload(revision, providers) {
  return { revision, providers: providers || [] }
}

describe('config-sync: handleConfigPush', () => {
  let tmp
  beforeEach(() => { tmp = makeTmpHome() })
  afterEach(() => { rmSync(tmp.base, { recursive: true, force: true }) })

  test('1. push revision=1 → appliedRevision=1, ack ok:true', () => {
    let ackData = null
    const send = (type, data) => { ackData = { type, data } }
    const result = handleConfigPush({
      data: makePayload(1, [{ id: 'test-provider', baseURL: 'https://api.test.com/v1', apiKey: 'sk-test-key', apiKeyEnv: 'TEST_API_KEY', models: [{ id: 'test-model', name: 'Test' }] }]),
      dshHome: tmp.dshHome,
      profileDir: tmp.profileDir,
      e2e: true,
      wasEncrypted: true,
      send,
      logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.appliedRevision, 1)
    assert.equal(ackData.type, 'hub/config-ack')
    assert.equal(ackData.data.ok, true)
    assert.equal(ackData.data.appliedRevision, 1)
  })

  test('2. stale revision → discarded, no ack', () => {
    let ackCount = 0
    const send = () => { ackCount++ }
    // 先推 revision=1
    handleConfigPush({
      data: makePayload(1, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir, send, logger: () => {},
      _restartFn: () => {},
    })
    // 重发 revision=1
    const result = handleConfigPush({
      data: makePayload(1, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir, send, logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.stale, true)
    assert.equal(ackCount, 1) // 只有第一次有 ack
  })

  test('3. invalid provider id → merge-failed error returned', () => {
    let ackData = null
    const send = (type, data) => { ackData = { type, data } }
    // Provider id with special chars that would break YAML
    const result = handleConfigPush({
      data: makePayload(1, [{ id: 'bad id: #danger', baseURL: 'https://a.com', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send, logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /merge-failed/)
    assert.match(result.error, /invalid-provider-id/)
  })

  test('4. write failure → rollback, appliedRevision unchanged', () => {
    // 先写一个初始 revision=1
    handleConfigPush({
      data: makePayload(1, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })
    // 验证 revision=1 已落盘
    const syncPath = join(tmp.dshHome, 'config-sync.json')
    const state1 = JSON.parse(readFileSync(syncPath, 'utf-8'))
    assert.equal(state1.appliedRevision, 1)

    // 制造写盘失败：把 profileDir 设为不存在的只读路径
    let ackData = null
    const send = (type, data) => { ackData = { type, data } }
    const result = handleConfigPush({
      data: makePayload(2, [{ id: 'p2', baseURL: 'https://b.com', apiKey: 'sk-2', apiKeyEnv: 'P2_KEY', models: [] }]),
      dshHome: tmp.dshHome,
      profileDir: '/nonexistent-dir-12345',
      send, logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.ok, false)
    assert.equal(result.rollbackRevision, 1)
    // 验证 revision 回滚到 1
    const state2 = JSON.parse(readFileSync(syncPath, 'utf-8'))
    assert.equal(state2.appliedRevision, 1)
  })

  test('5. merge: existing credentials refs preserved', () => {
    // 先写已有 credentials
    const credPath = join(tmp.dshHome, '.credentials.yaml')
    writeFileSync(credPath, 'version: 1\nrefs:\n  EXISTING_KEY: sk-existing-value\nrecords:\n', 'utf-8')
    chmodSync(credPath, 0o600)

    // 推新配置
    handleConfigPush({
      data: makePayload(1, [{ id: 'new-prov', baseURL: 'https://c.com', apiKey: 'sk-new', apiKeyEnv: 'NEW_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })

    // 验证 credentials 里新旧 ref 都在
    const credContent = readFileSync(credPath, 'utf-8')
    assert.match(credContent, /EXISTING_KEY/)
    assert.match(credContent, /NEW_KEY/)
    assert.match(credContent, /sk-new/)
  })

  test('6. merge: existing patch entries preserved', () => {
    // 先写已有 patch
    const patchPath = join(tmp.profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, [
      '- id: remote-agent',
      '  name: dsh-remote-agent',
      '  inject: [\'tools\', \'agentLoop\', \'sessions\']',
      '  config:',
      '    role: worker',
      '',
      '- id: agent-preset-registry',
      '  disabled: true',
      '',
    ].join('\n'), 'utf-8')

    // 推新配置
    handleConfigPush({
      data: makePayload(1, [{ id: 'test-prov', baseURL: 'https://d.com', apiKey: 'sk-d', apiKeyEnv: 'TEST_PROV_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })

    // 验证 patch 里新旧条目都在
    const patchContent = readFileSync(patchPath, 'utf-8')
    assert.match(patchContent, /remote-agent/)
    assert.match(patchContent, /agent-preset-registry/)
    assert.match(patchContent, /llm-pi-ai/)
    assert.match(patchContent, /test-prov/)
  })

  test('7. patch has no plaintext apiKey', () => {
    const patchPath = join(tmp.profileDir, 'cordis.patch.yml')
    handleConfigPush({
      data: makePayload(1, [{ id: 'secret-prov', baseURL: 'https://e.com', apiKey: 'sk-super-secret-key', apiKeyEnv: 'SECRET_PROV_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })

    const patchContent = readFileSync(patchPath, 'utf-8')
    assert.doesNotMatch(patchContent, /sk-super-secret-key/)
    assert.match(patchContent, /SECRET_PROV_KEY/)
  })

  test('8. same provider set → shouldRestart=false', () => {
    // 先推一次
    handleConfigPush({
      data: makePayload(1, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })
    // 推同样 provider 集合 + revision=2
    const result = handleConfigPush({
      data: makePayload(2, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-1b', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.shouldRestart, false)
  })

  test('9. changed provider set → shouldRestart=true', () => {
    // 先推一次
    handleConfigPush({
      data: makePayload(1, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })
    // 推新 provider 集合
    const result = handleConfigPush({
      data: makePayload(2, [{ id: 'p2', baseURL: 'https://b.com', apiKey: 'sk-2', apiKeyEnv: 'P2_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.ok, true)
    assert.equal(result.shouldRestart, true)
  })
  test('10. records section preserved verbatim when adding refs', () => {
    const credPath = join(tmp.dshHome, '.credentials.yaml')
    // Write credentials with records but no refs (mirrors real副机 state)
    const originalContent = [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      '      secret: some-secret-value',
      '',
    ].join('\n')
    writeFileSync(credPath, originalContent, 'utf-8')
    chmodSync(credPath, 0o600)

    handleConfigPush({
      data: makePayload(1, [{ id: 'p1', baseURL: 'https://a.com', apiKey: 'sk-abc', apiKeyEnv: 'P1_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {}, _restartFn: () => {},
    })

    const result = readFileSync(credPath, 'utf-8')
    // refs added
    assert.match(result, /P1_KEY/)
    assert.match(result, /sk-abc/)
    // records preserved verbatim (all key lines still present)
    assert.match(result, /client-connection\/browser-session/)
    assert.match(result, /kind: grant/)
    assert.match(result, /some-secret-value/)
  })

  test('11. existing refs merged: new key added, old key preserved', () => {
    const credPath = join(tmp.dshHome, '.credentials.yaml')
    writeFileSync(credPath, [
      'version: 1',
      'refs:',
      '  EXISTING_OLD_KEY: sk-old-value',
      'records:',
      '  browser-session:',
      '    kind: grant',
      '',
    ].join('\n'), 'utf-8')
    chmodSync(credPath, 0o600)

    handleConfigPush({
      data: makePayload(1, [{ id: 'p2', baseURL: 'https://b.com', apiKey: 'sk-new-value', apiKeyEnv: 'NEW_KEY', models: [] }]),
      dshHome: tmp.dshHome, profileDir: tmp.profileDir,
      send: () => {}, logger: () => {}, _restartFn: () => {},
    })

    const result = readFileSync(credPath, 'utf-8')
    assert.match(result, /EXISTING_OLD_KEY/)
    assert.match(result, /sk-old-value/)
    assert.match(result, /NEW_KEY/)
    assert.match(result, /sk-new-value/)
    assert.match(result, /browser-session/)
  })

})

describe('config-sync: handleConfigSyncRequest', () => {
  test('node revision < currentRevision → push sent', () => {
    let pushed = null
    const result = handleConfigSyncRequest({
      data: { appliedRevision: 0 },
      currentRevision: 5,
      getPayload: () => ({ providers: [{ id: 'p1' }] }),
      sendPush: (nodeId, payload) => { pushed = { nodeId, payload } },
      nodeId: 'test-node',
    })
    assert.equal(result.ok, true)
    assert.equal(result.pushed, true)
    assert.equal(pushed.nodeId, 'test-node')
    assert.equal(pushed.payload.revision, 5)
  })

  test('node revision >= currentRevision → skip', () => {
    let pushed = null
    const result = handleConfigSyncRequest({
      data: { appliedRevision: 5 },
      currentRevision: 5,
      getPayload: () => ({ providers: [] }),
      sendPush: (nodeId, payload) => { pushed = { nodeId, payload } },
      nodeId: 'test-node',
    })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, true)
    assert.equal(pushed, null)
  })

  test('no payload source → ok:false', () => {
    const result = handleConfigSyncRequest({
      data: { appliedRevision: 0 },
      currentRevision: 1,
      getPayload: () => null,
      sendPush: () => {},
      nodeId: 'test-node',
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-payload')
  })
})

describe('config-sync: invalid revision', () => {
  test('non-integer revision → reject', () => {
    let ackData = null
    const send = (type, data) => { ackData = { type, data } }
    const result = handleConfigPush({
      data: { revision: 'abc', providers: [] },
      dshHome: '/tmp/test-nonexistent',
      profileDir: '/tmp/test-nonexistent',
      send, logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'invalid-revision')
  })
})

describe('config-sync: sendConfigSyncRequest', () => {
  test('sends appliedRevision from config-sync.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sync-req-test-'))
    const dshHome = join(tmpDir, '.dsh')
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(join(dshHome, 'config-sync.json'), JSON.stringify({ appliedRevision: 42 }), 'utf-8')

    let sentData = null
    sendConfigSyncRequest({
      dshHome,
      send: (type, data) => { sentData = { type, data } },
      logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(sentData.type, 'hub/config-sync-request')
    assert.equal(sentData.data.appliedRevision, 42)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('no config-sync.json → sends revision=0', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sync-req-test2-'))
    const dshHome = join(tmpDir, '.dsh')
    mkdirSync(dshHome, { recursive: true })

    let sentData = null
    sendConfigSyncRequest({
      dshHome,
      send: (type, data) => { sentData = { type, data } },
      logger: () => {},
      _restartFn: () => {},
    })
    assert.equal(sentData.type, 'hub/config-sync-request')
    assert.equal(sentData.data.appliedRevision, 0)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})


describe('config-sync: computeRevision (stable serialization)', () => {
  test('1. only apiKey changed → revision must change', () => {
    const r1 = computeRevision({ providers: [{ id: 'p1', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', baseURL: 'https://a.com', models: [] }] })
    const r2 = computeRevision({ providers: [{ id: 'p1', apiKey: 'sk-2', apiKeyEnv: 'P1_KEY', baseURL: 'https://a.com', models: [] }] })
    assert.notEqual(r1, r2, 'changing apiKey must produce a different revision hash')
  })

  test('2. same content, provider order reversed → revision unchanged', () => {
    const pa = { id: 'aaa', apiKey: 'sk-x', apiKeyEnv: 'AAA_KEY', baseURL: 'https://a.com', models: [{ id: 'm1', name: 'M1' }] }
    const pz = { id: 'zzz', apiKey: 'sk-y', apiKeyEnv: 'ZZZ_KEY', baseURL: 'https://z.com', models: [{ id: 'm2', name: 'M2' }] }
    const r1 = computeRevision({ providers: [pa, pz], defaultModel: 'aaa/m1' })
    const r2 = computeRevision({ providers: [pz, pa], defaultModel: 'aaa/m1' })
    assert.equal(r1, r2, 'reversed provider order must not change revision')
    // 同时对象内 key 顺序也不影响
    const r3 = computeRevision({ defaultModel: 'aaa/m1', providers: [{ models: pa.models, id: 'aaa', baseURL: pa.baseURL, apiKeyEnv: pa.apiKeyEnv, apiKey: pa.apiKey }, pz] })
    assert.equal(r1, r3, 'object key order must not change revision')
    // 防恒等函数自证：内容真变了必须不同
    const r4 = computeRevision({ providers: [pa, { ...pz, apiKey: 'sk-changed' }], defaultModel: 'aaa/m1' })
    assert.notEqual(r1, r4, 'different content must produce different revision')
  })

  test('3. add a model → revision must change', () => {
    const r1 = computeRevision({ providers: [{ id: 'p1', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', baseURL: 'https://a.com', models: [{ id: 'm1', name: 'M1' }] }] })
    const r2 = computeRevision({ providers: [{ id: 'p1', apiKey: 'sk-1', apiKeyEnv: 'P1_KEY', baseURL: 'https://a.com', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }] })
    assert.notEqual(r1, r2, 'adding a model must produce a different revision hash')
  })
})

describe('config-sync: hub source receives nodeId', () => {
  test('sourceFn receives the nodeId of each pushed node', () => {
    const calls = []
    const source = (nodeId) => {
      calls.push(nodeId)
      return { providers: [{ id: 'p1', baseURL: 'https://api.test.com/v1', apiKey: 'sk-x', apiKeyEnv: 'P1_KEY', models: [{ id: 'm1', name: 'M1' }] }] }
    }
    const sent = []
    const registry = {
      hasE2E: () => true,
      send: (nodeId, _type, _data) => { sent.push(nodeId); return true },
    }
    const sync = createConfigSync({ registry, source, log: () => {} })
    sync.sendPush('node-alpha')
    sync.sendPush('node-beta')
    assert.deepEqual(calls, ['node-alpha', 'node-beta'], 'source must receive the nodeId for each push')
    assert.deepEqual(sent, ['node-alpha', 'node-beta'])
  })
})

