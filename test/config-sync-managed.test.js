/**
 * P1b-1：受管条目替换 / 插件白名单 / 凭据所有权 / 写盘前后校验。
 *
 * 全部是行为断言：真实 handleConfigPush + 真实文件（临时目录），断言文件字节与回执，
 * 不做源码字符串断言。每条不变量在 PR 说明里配了一把「刀」（改回去必须红在这里）。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleConfigPush } from '../lib/node/config-sync.js'
import { replaceManagedEntry, validatePatchYaml, findEntryRange, checkMergedPatch, ConfigSyncError } from '../lib/node/config-managed.js'

const KEY = 'sk-deepseek-SECRET-0123456789'
const PI_KEY = 'sk-pi-SECRET-abcdef'

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cfg-managed-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir, cred: join(dshHome, '.credentials.yaml'), patch: join(profileDir, 'cordis.patch.yml'), state: join(dshHome, 'config-sync.json') }
}

const deepseek = (over = {}) => ({
  entryId: 'llm-deepseek',
  name: '@deepseek-ai/dsh-llm-deepseek-api-key',
  config: {
    thinking: 'enabled',
    reasoningEffort: 'high',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1000000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Stronger: "quoted" # hash', contextWindow: 1000000, inputModalities: ['text'] },
    ],
  },
  credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: KEY }],
  ...over,
})
const piProvider = () => ({ id: 'jina', api: 'openai-completions', baseURL: 'https://api.jina.ai/v1', apiKeyEnv: 'JINA_API_KEY', apiKey: PI_KEY, models: [{ id: 'jina-x', name: 'Jina X' }] })
const v2 = (revision, { plugins = [deepseek()], providers = [piProvider()] } = {}) => ({ schema: 2, revision, providers, plugins, cliExpect: [] })

const OTHER_ENTRIES = [
  '# Your patch layer — keep this comment',
  '- id: remote-agent',
  '  name: "@x/remote-agent"',
  '  config:',
  '    role: worker',
  '',
  '# hand-written note about permissions',
  '- id: permission',
  '  config:',
  '    mode: "ask"',
  '',
].join('\n')

function push(home, data, extra = {}) {
  const acks = []
  const logs = []
  const restarts = []
  const result = handleConfigPush({
    data, dshHome: home.dshHome, profileDir: home.profileDir,
    send: (type, d) => acks.push({ type, d }),
    logger: (level, msg, meta) => logs.push({ level, msg, meta }),
    _restartFn: () => restarts.push(1),
    ...extra,
  })
  return { result, acks, logs, restarts }
}

describe('P1b-1 plugins[]: replaceManagedEntry on a real patch file', () => {
  let home
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('P1b1-deepseek-entry: llm-deepseek entry written with the node-side package name; other entries and comments byte-identical', () => {
    writeFileSync(home.patch, OTHER_ENTRIES)
    const { result, acks } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    const patch = readFileSync(home.patch, 'utf-8')
    const range = findEntryRange(patch, 'llm-deepseek')
    assert.ok(range, 'llm-deepseek entry exists')
    const entry = range.lines.slice(range.start, range.end).join('\n')
    assert.match(entry, /^- id: llm-deepseek\n {2}name: "@deepseek-ai\/dsh-llm-deepseek-api-key"\n {2}config:\n/)
    assert.match(entry, /thinking: "enabled"/)
    assert.match(entry, /- id: "deepseek-flash"/)
    assert.match(entry, /contextWindow: 1000000/)
    // 特殊字符被引号转义，不会破坏 YAML
    assert.match(entry, /description: "Stronger: \\"quoted\\" # hash"/)
    // 受管条目之外：原样
    assert.ok(patch.startsWith(OTHER_ENTRIES.trimEnd()), 'untouched entries + comments preserved verbatim at the top')
    assert.equal(validatePatchYaml(patch), null)
    // 回执带 schema:2
    assert.equal(acks[0].d.schema, 2)
    assert.equal(acks[0].d.ok, true)
  })

  test('P1b1-deepseek-key: DEEPSEEK_API_KEY lands in .credentials.yaml with mode 0600, never in the patch', () => {
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true)
    const cred = readFileSync(home.cred, 'utf-8')
    assert.match(cred, new RegExp(`\\n {2}DEEPSEEK_API_KEY: ${KEY}\\n`))
    assert.equal((statSync(home.cred).mode & 0o777), 0o600)
    assert.equal(readFileSync(home.patch, 'utf-8').includes(KEY), false, 'plaintext key must not be in the patch')
    assert.equal(readFileSync(home.state, 'utf-8').includes(KEY), false, 'plaintext key must not be in the state file')
  })

  test('P1b1-replace-not-append: pushing again replaces the managed entry in place (still one llm-deepseek, neighbours intact)', () => {
    writeFileSync(home.patch, OTHER_ENTRIES)
    push(home, v2(1))
    const second = deepseek({ config: { thinking: 'disabled', reasoningEffort: 'off' } })
    const { result } = push(home, v2(2, { plugins: [second] }))
    assert.equal(result.ok, true)
    const patch = readFileSync(home.patch, 'utf-8')
    assert.equal((patch.match(/^- id: llm-deepseek$/gm) || []).length, 1)
    assert.match(patch, /thinking: "disabled"/)
    assert.equal(patch.includes('deepseek-flash'), false, 'old models list is gone with the replaced entry')
    assert.ok(patch.includes('- id: remote-agent') && patch.includes('# hand-written note about permissions') && patch.includes('mode: "ask"'))
  })

  test('P1b1-pi-ai-untouched: the llm-pi-ai providers (and their ref) are unaffected by adding a plugin', () => {
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true)
    const patch = readFileSync(home.patch, 'utf-8')
    assert.match(patch, /- id: llm-pi-ai/)
    assert.match(patch, /jina:\n {8}apiKeyEnv: "JINA_API_KEY"/)
    assert.match(readFileSync(home.cred, 'utf-8'), new RegExp(`JINA_API_KEY: ${PI_KEY}`))
  })

  test('P1b1-restart: first plugin push restarts; identical content under a new revision does not', () => {
    const first = push(home, v2(1))
    assert.equal(first.result.shouldRestart, true)
    const same = push(home, v2(2))
    assert.equal(same.result.ok, true)
    assert.equal(same.result.shouldRestart, false)
    const rotated = push(home, v2(3, { plugins: [deepseek({ credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: KEY + '-rotated' }] })] }))
    assert.equal(rotated.result.shouldRestart, true, 'key rotation changes the plugin fingerprint')
  })
})

describe('P1b-1 plugin whitelist: plugin-not-allowed / plugin-config-invalid are rejected before any write', () => {
  let home
  beforeEach(() => { home = makeHome(); writeFileSync(home.patch, OTHER_ENTRIES); writeFileSync(home.cred, 'version: 1\nrefs:\n  KEEP_ME: keep-1\n'); chmodSync(home.cred, 0o600) })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  const untouched = () => {
    assert.equal(readFileSync(home.patch, 'utf-8'), OTHER_ENTRIES)
    assert.equal(readFileSync(home.cred, 'utf-8'), 'version: 1\nrefs:\n  KEEP_ME: keep-1\n')
    assert.equal(existsSync(home.state), false, 'no revision recorded for a rejected push')
    assert.equal(existsSync(join(home.dshHome, 'config-sync.bak')), false, 'rejected before even taking a snapshot')
  }

  for (const entryId of ['remote-agent', 'llm-xdpool', 'permission', 'llm-pi-ai', 'hooks-claude-code', '../evil']) {
    test(`P1b1-not-allowed(${entryId}): ack.error === 'plugin-not-allowed', nothing written`, () => {
      const { result, acks, restarts } = push(home, v2(1, { plugins: [deepseek(), { entryId, config: {}, credentialRefs: [{ ref: 'EVIL_KEY', apiKey: 'sk-evil' }] }] }))
      assert.equal(result.ok, false)
      assert.equal(result.error, 'plugin-not-allowed')
      assert.equal(acks[0].d.error, 'plugin-not-allowed')
      assert.equal(result.rollbackRevision, 0)
      assert.equal(restarts.length, 0)
      untouched()
    })
  }

  const invalid = {
    'unknown config key': deepseek({ config: { thinking: 'enabled', filesApiTimeoutMs: 5 } }),
    'bad baseURL scheme': deepseek({ config: { baseURL: 'file:///etc/passwd' } }),
    'baseURL with credentials': deepseek({ config: { baseURL: 'https://u:p@api.example.com' } }),
    'thinking disabled but effort high': deepseek({ config: { thinking: 'disabled', reasoningEffort: 'high' } }),
    'unknown model key': deepseek({ config: { models: [{ id: 'm', evil: 1 }] } }),
    'duplicate model id': deepseek({ config: { models: [{ id: 'm' }, { id: 'm' }] } }),
    'bad modality': deepseek({ config: { models: [{ id: 'm', inputModalities: ['video'] }] } }),
    'ref outside the plugin allow-list': deepseek({ credentialRefs: [{ ref: 'JINA_API_KEY', apiKey: 'x' }] }),
    'key with a newline (YAML injection)': deepseek({ credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: 'sk-a\nEVIL: pwn' }] }),
    'retryPolicy unknown mode': deepseek({ config: { retryPolicy: { mode: 'sometimes' } } }),
  }
  for (const [name, plugin] of Object.entries(invalid)) {
    test(`P1b1-invalid(${name}): ack.error === 'plugin-config-invalid', nothing written`, () => {
      const { result } = push(home, v2(1, { plugins: [plugin] }))
      assert.equal(result.ok, false)
      assert.equal(result.error, 'plugin-config-invalid')
      untouched()
    })
  }

  test('P1b1-invalid-no-value-leak: the rejection names a field path, never the offending value', () => {
    const { result, acks, logs } = push(home, v2(1, { plugins: [deepseek({ config: { baseURL: 'https://secret-host.example/?token=abc' } })] }))
    assert.equal(result.ok, false)
    const blob = JSON.stringify([acks, logs])
    assert.equal(blob.includes('secret-host'), false)
    assert.equal(blob.includes('token=abc'), false)
    assert.equal(acks[0].d.path, 'config.baseURL')
  })
})

describe('P1b-1 v1 compatibility: a payload that is not schema 2 behaves exactly as before', () => {
  let home
  beforeEach(() => { home = makeHome(); writeFileSync(home.patch, OTHER_ENTRIES) })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('P1b1-v1-ignores-plugins: no schema → plugins[] is ignored, no entry written, no plugin key written', () => {
    const payload = { revision: 1, providers: [piProvider()], plugins: [deepseek()] }
    const { result } = push(home, payload)
    assert.equal(result.ok, true)
    assert.equal(readFileSync(home.patch, 'utf-8').includes('llm-deepseek'), false)
    assert.equal(readFileSync(home.cred, 'utf-8').includes('DEEPSEEK_API_KEY'), false)
    assert.match(readFileSync(home.patch, 'utf-8'), /- id: llm-pi-ai/)
  })

  test('P1b1-v1-no-plugin-validation: a v1 payload with a not-allowed plugin id is NOT rejected (the field does not exist in v1)', () => {
    const { result } = push(home, { revision: 1, providers: [piProvider()], plugins: [{ entryId: 'remote-agent', config: {} }] })
    assert.equal(result.ok, true)
    assert.equal(readFileSync(home.patch, 'utf-8').includes('evil'), false)
  })

  test('P1b1-v1-models-trimmed: model fields beyond {id,name} are not written by this node yet (P1b-2)', () => {
    const p = piProvider()
    p.models = [{ id: 'jina-x', name: 'Jina X', contextWindow: 8192, maxTokens: 1024, input: ['text'], reasoningEfforts: ['low'] }]
    const { result } = push(home, v2(1, { plugins: [], providers: [p] }))
    assert.equal(result.ok, true)
    const patch = readFileSync(home.patch, 'utf-8')
    assert.match(patch, /- id: "jina-x"\n {12}name: "Jina X"/)
    assert.equal(patch.includes('contextWindow'), false)
  })
})

describe('P1b-1 truncated / illegal YAML never reaches disk', () => {
  let home
  beforeEach(() => { home = makeHome(); writeFileSync(home.cred, 'version: 1\nrefs:\n  KEEP_ME: keep-1\n'); chmodSync(home.cred, 0o600) })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('P1b1-truncated-existing: a patch that was cut off mid-string is refused; patch, credentials and state stay byte-identical', () => {
    const truncated = OTHER_ENTRIES + '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-a'
    writeFileSync(home.patch, truncated)
    const { result, acks, restarts } = push(home, v2(1))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'patch-existing-invalid')
    assert.equal(acks[0].d.path, `line ${truncated.split('\n').length}`, 'names the line of the cut-off string, not its content')
    assert.match(result.error, /^patch-existing-invalid/)
    assert.equal(readFileSync(home.patch, 'utf-8'), truncated)
    assert.equal(readFileSync(home.cred, 'utf-8'), 'version: 1\nrefs:\n  KEEP_ME: keep-1\n', 'credentials not written either')
    assert.equal(existsSync(home.state), false)
    assert.equal(restarts.length, 0)
  })

  test('P1b1-not-a-list: a patch whose top level is not a YAML list is refused', () => {
    writeFileSync(home.patch, 'foo: bar\nbaz: 1\n')
    const { result } = push(home, v2(1))
    assert.equal(result.ok, false)
    assert.match(result.error, /^patch-existing-invalid/)
    assert.equal(readFileSync(home.patch, 'utf-8'), 'foo: bar\nbaz: 1\n')
  })

  test('P1b1-duplicate-entry: two entries with the same managed id are refused instead of guessing which to replace', () => {
    const dup = '- id: llm-deepseek\n  config: {}\n- id: llm-deepseek\n  config: {}\n'
    writeFileSync(home.patch, dup)
    const { result } = push(home, v2(1))
    assert.equal(result.ok, false)
    assert.match(result.error, /patch-duplicate-entry/)
    assert.equal(readFileSync(home.patch, 'utf-8'), dup)
  })

  test('P1b1-validate-unit: validatePatchYaml names the line of a cut-off string and accepts a healthy file', () => {
    assert.equal(validatePatchYaml(OTHER_ENTRIES), null)
    assert.deepEqual(validatePatchYaml('- id: a\n  name: "@deep'), { code: 'patch-invalid', line: 2 })
    assert.deepEqual(validatePatchYaml('- name: no-id\n'), { code: 'patch-invalid', line: 1 })
    assert.equal(validatePatchYaml(''), null)
  })
})

describe('P1b-1 write-then-verify: a bad write restores the snapshot', () => {
  let home
  const OLD_CRED = 'version: 1\nrefs:\n  KEEP_ME: keep-1\nrecords:\n  r1:\n    note: preserved\n'
  beforeEach(() => {
    home = makeHome()
    writeFileSync(home.patch, OTHER_ENTRIES)
    writeFileSync(home.cred, OLD_CRED)
    chmodSync(home.cred, 0o600)
    // 先应用一版 revision 1，让状态文件里有 lastPayload / ownedRefs
    const first = push(home, v2(1, { plugins: [], providers: [piProvider()] }))
    assert.equal(first.result.ok, true)
  })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('P1b1-rollback-truncated-patch: patch cut short right after the write → verify fails → credentials, patch and state all restored', () => {
    const credBefore = readFileSync(home.cred, 'utf-8')
    const patchBefore = readFileSync(home.patch, 'utf-8')
    const stateBefore = readFileSync(home.state, 'utf-8')
    const { result, restarts } = push(home, v2(2), {
      _afterWrite: (kind, path) => { if (kind === 'patch') writeFileSync(path, readFileSync(path, 'utf-8').slice(0, 40)) },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'patch-verify-failed')
    assert.equal(result.rollbackRevision, 1)
    assert.equal(readFileSync(home.patch, 'utf-8'), patchBefore, 'patch restored')
    assert.equal(readFileSync(home.cred, 'utf-8'), credBefore, 'credentials restored (the new DEEPSEEK_API_KEY is gone again)')
    assert.equal(readFileSync(home.cred, 'utf-8').includes(KEY), false)
    assert.deepEqual(JSON.parse(readFileSync(home.state, 'utf-8')), JSON.parse(stateBefore), 'state restored including lastPayload / ownedRefs')
    assert.equal(restarts.length, 0)
  })

  test('P1b1-rollback-credentials-write: credentials write throws → nothing else changed', () => {
    const credBefore = readFileSync(home.cred, 'utf-8')
    const patchBefore = readFileSync(home.patch, 'utf-8')
    const { result } = push(home, v2(2), { _afterWrite: (kind) => { if (kind === 'credentials') throw new Error('disk full') } })
    assert.equal(result.ok, false)
    assert.match(result.error, /^credentials-write-failed/)
    assert.equal(readFileSync(home.cred, 'utf-8'), credBefore)
    assert.equal(readFileSync(home.patch, 'utf-8'), patchBefore)
  })

  test('P1b1-rollback-real-fs: patch directory made read-only → the real write fails → credentials restored', { skip: process.getuid?.() === 0 }, () => {
    const credBefore = readFileSync(home.cred, 'utf-8')
    chmodSync(home.profileDir, 0o555)
    try {
      const { result } = push(home, v2(2))
      assert.equal(result.ok, false)
      assert.match(result.error, /^patch-write-failed/)
      assert.equal(readFileSync(home.cred, 'utf-8'), credBefore)
      assert.equal(result.rollbackRevision, 1)
    } finally { chmodSync(home.profileDir, 0o755) }
  })

  test('P1b1-rollback-new-files: files that did not exist before the push are removed again, not left half-written', () => {
    const fresh = makeHome()
    try {
      const { result } = push(fresh, v2(1), { _afterWrite: (kind, path) => { if (kind === 'patch') writeFileSync(path, '') } })
      assert.equal(result.ok, false)
      assert.equal(existsSync(fresh.cred), false, 'credentials file created by the push is removed on rollback')
      assert.equal(existsSync(fresh.patch), false, 'patch file created by the push is removed on rollback')
    } finally { rmSync(fresh.base, { recursive: true, force: true }) }
  })
})

describe('P1b-1 ownedRefs: the hub can revoke what it pushed, and never touches what the node configured itself', () => {
  let home
  beforeEach(() => {
    home = makeHome()
    writeFileSync(home.patch, OTHER_ENTRIES)
    // 节点自配的 ref（不是同步写的）：一个独有，一个与同步载荷同名
    writeFileSync(home.cred, `version: 1\nrefs:\n  NODE_LOCAL_KEY: local-secret\n  JINA_API_KEY: node-own-jina\nrecords:\n  r1:\n    note: preserved\n`)
    chmodSync(home.cred, 0o600)
  })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  const refsOf = () => {
    const out = {}
    for (const m of readFileSync(home.cred, 'utf-8').matchAll(/^ {2}([A-Za-z0-9_]+): (.+)$/gm)) out[m[1]] = m[2]
    return out
  }

  test('P1b1-owned-recorded: refs the push created are recorded as owned; the node-local one with the same name as a pushed ref is overwritten but stays the node\'s', () => {
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true)
    const state = JSON.parse(readFileSync(home.state, 'utf-8'))
    assert.deepEqual(state.ownedRefs, ['DEEPSEEK_API_KEY'], 'JINA_API_KEY already existed on the node → not owned')
    assert.deepEqual(state.ownedEntries, ['llm-deepseek'])
    assert.equal(refsOf().JINA_API_KEY, PI_KEY, 'value was overwritten by the push (same as before this slice)')
  })

  test('P1b1-owned-revoke: the hub drops DEEPSEEK_API_KEY → it is deleted on the node, its patch entry too; node-local refs, records and other entries survive', () => {
    push(home, v2(1))
    assert.equal(refsOf().DEEPSEEK_API_KEY, KEY)
    const { result, restarts } = push(home, v2(2, { plugins: [] }))
    assert.equal(result.ok, true)
    const refs = refsOf()
    assert.equal(Object.hasOwn(refs, 'DEEPSEEK_API_KEY'), false, 'revoked key deleted')
    assert.equal(refs.NODE_LOCAL_KEY, 'local-secret', 'node-local ref never touched')
    assert.equal(refs.JINA_API_KEY, PI_KEY)
    assert.match(readFileSync(home.cred, 'utf-8'), /records:\n {2}r1:\n {4}note: preserved/, 'records section preserved verbatim')
    assert.equal(readFileSync(home.patch, 'utf-8').includes('llm-deepseek'), false, 'managed entry removed too')
    assert.ok(readFileSync(home.patch, 'utf-8').includes('# hand-written note about permissions'))
    assert.equal(result.shouldRestart, true)
    assert.equal(restarts.length >= 1, true)
    assert.deepEqual(JSON.parse(readFileSync(home.state, 'utf-8')).ownedRefs, [])
  })

  test('P1b1-owned-never-delete-local: a ref the node configured itself is never deleted, even if the hub never sent it', () => {
    push(home, v2(1))
    push(home, v2(2, { plugins: [], providers: [] }))
    const refs = refsOf()
    assert.equal(refs.NODE_LOCAL_KEY, 'local-secret')
    assert.equal(refs.JINA_API_KEY, PI_KEY, 'JINA_API_KEY pre-existed on the node, so a revoked provider does not delete it')
  })

  test('P1b1-owned-pi-provider-revoke: a provider-owned ref the hub stops sending is deleted too', () => {
    const fresh = makeHome()
    try {
      writeFileSync(fresh.patch, OTHER_ENTRIES)
      const prov = { id: 'siliconflow', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', apiKeyEnv: 'SILICONFLOW_API_KEY', apiKey: 'sk-sf', models: [] }
      push(fresh, { revision: 1, providers: [prov] })
      assert.match(readFileSync(fresh.cred, 'utf-8'), /SILICONFLOW_API_KEY: sk-sf/)
      push(fresh, { revision: 2, providers: [] })
      assert.equal(readFileSync(fresh.cred, 'utf-8').includes('SILICONFLOW_API_KEY'), false)
    } finally { rmSync(fresh.base, { recursive: true, force: true }) }
  })

  test('P1b1-owned-legacy-state: a node that synced before ownedRefs existed has no ownership record → nothing is deleted on the next push', () => {
    // 模拟旧版本留下的状态：有 lastPayload（schema:2 状态格式），没有 ownedRefs
    writeFileSync(home.cred, 'version: 1\nrefs:\n  OLD_SYNCED_KEY: old\n')
    chmodSync(home.cred, 0o600)
    writeFileSync(home.state, JSON.stringify({ schema: 2, appliedRevision: 5, lastPayload: { providers: [] } }))
    const { result } = push(home, v2(6, { plugins: [], providers: [] }))
    assert.equal(result.ok, true)
    assert.match(readFileSync(home.cred, 'utf-8'), /OLD_SYNCED_KEY: old/)
  })

  test('P1b1-no-secret-in-logs: logs and acks carry provider/plugin ids and counts only', () => {
    const { logs, acks } = push(home, v2(1))
    const blob = JSON.stringify([logs, acks])
    for (const secret of [KEY, PI_KEY, 'api.jina.ai']) assert.equal(blob.includes(secret), false, `leaked: ${secret.slice(0, 8)}`)
    const applied = logs.find((l) => l.msg === 'config-sync: applied')
    assert.deepEqual(applied.meta.pluginIds, ['llm-deepseek'])
    assert.equal(typeof applied.meta.removedRefCount, 'number')
  })
})

describe('replaceManagedEntry: pure behaviour', () => {
  const doc = '# top\n- id: a\n  config:\n    x: 1\n\n# about b\n- id: b\n  config:\n    y: 2\n- id: c\n  v: 3\n'

  test('replaces only the target entry, neighbours and comments byte-identical', () => {
    const out = replaceManagedEntry(doc, 'b', '- id: b\n  config:\n    y: 99')
    assert.equal(out, '# top\n- id: a\n  config:\n    x: 1\n\n# about b\n- id: b\n  config:\n    y: 99\n- id: c\n  v: 3\n')
  })

  test('appends when the entry is absent, separated by a blank line', () => {
    assert.equal(replaceManagedEntry('- id: a\n  v: 1\n', 'z', '- id: z\n  v: 2'), '- id: a\n  v: 1\n\n- id: z\n  v: 2\n')
    assert.equal(replaceManagedEntry('', 'z', '- id: z\n  v: 2'), '- id: z\n  v: 2\n')
  })

  test('matches a quoted id and does not confuse a prefix id', () => {
    const text = '- id: llm-deepseek-extra\n  v: 1\n- id: "llm-deepseek"\n  v: 2\n'
    const out = replaceManagedEntry(text, 'llm-deepseek', '- id: llm-deepseek\n  v: 9')
    assert.equal(out, '- id: llm-deepseek-extra\n  v: 1\n- id: llm-deepseek\n  v: 9\n')
  })

  test('refuses duplicates', () => {
    assert.throws(() => replaceManagedEntry('- id: a\n- id: a\n', 'a', '- id: a'), (e) => e instanceof ConfigSyncError && e.code === 'patch-duplicate-entry')
  })
})

describe('checkMergedPatch: the pre-write self-check on the merged text', () => {
  const before = '# keep\n- id: a\n  v: 1\n- id: b\n  v: 2\n'
  const entry = '- id: b\n  v: 9'
  const good = replaceManagedEntry(before, 'b', entry)

  test('a correct merge passes', () => {
    assert.equal(checkMergedPatch(before, good, ['b'], { b: entry }), null)
  })
  test('a merge whose output was cut off is refused (patch-invalid)', () => {
    const cut = replaceManagedEntry(before, 'b', '- id: b\n  name: "@x/cut')
    assert.equal(checkMergedPatch(before, cut, ['b'], { b: '- id: b\n  name: "@x/cut' }), 'patch-invalid')
  })
  test('a merge that lost the managed entry is refused (patch-entry-missing)', () => {
    assert.equal(checkMergedPatch(before, before, ['b'], { b: entry }), 'patch-entry-missing')
  })
  test('a merge that touched an unmanaged entry is refused (patch-collateral)', () => {
    const tampered = good.replace('v: 1', 'v: 666')
    assert.equal(checkMergedPatch(before, tampered, ['b'], { b: entry }), 'patch-collateral')
  })
})
