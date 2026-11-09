/**
 * fork.56：节点配置落盘校验器的缺口（真实 DSH 加载器冒烟 + 验收官 Q0）。
 *
 *  B1  `- insert:` 等「没有 id 的合法条目」不得让整次推送被拒；真正非法的结构仍拒收
 *  B2  落盘前后结果都必须是 loader 认的顶层数组：DSH 新 profile 的模板是 `# 注释\n[]`，纯注释文件 loader 拒绝启动
 *  B3  撤销后受管条目变空要移除（llm-pi-ai 不留 `providers: null` 空壳）；接管而不拥有的不删
 *  Q0  已接管的条目第二次推送不得覆盖备份原文、不得再回执 adoptedEntries；备份写失败整次回滚
 *
 * 全部行为断言：真实 handleConfigPush / 真实文件；「结果能不能被 loader 加载」用 DSH 自己的
 * `loadOptionalPatches`（dsh-app-boot，DSH_NODE_MODULES 缺省 /tmp/dsh-asar/node_modules；没有就跳过那一句断言，
 * 纯函数断言仍然跑）。
 */
import { test, describe, beforeEach, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { handleConfigPush } from '../lib/node/config-sync.js'
import { validatePatchYaml, isLoaderArray, checkMergedPatch, ensureLoaderArray, isEmptyProvidersShell } from '../lib/node/config-managed.js'

const KEY = 'sk-deepseek-SECRET-0123456789'
const PI_KEY = 'pi-key-SECRET-9876543210'
const NM = process.env.DSH_NODE_MODULES || '/tmp/dsh-asar/node_modules'
const LOADER = join(NM, '@deepseek-ai/dsh-app-boot/lib/index.js')
let loadOptionalPatches = null

before(async () => {
  if (!existsSync(LOADER)) return
  try { ({ loadOptionalPatches } = await import(pathToFileURL(LOADER).href)) } catch { loadOptionalPatches = null }
})

/** 真实 loader 能加载这份文件吗？返回解析后的数组；没有 loader 时退回本包的 isLoaderArray。 */
function loaded(file) {
  const text = readFileSync(file, 'utf-8')
  if (loadOptionalPatches === null) { assert.equal(isLoaderArray(text), true, 'no DSH loader here: structural check only'); return null }
  const patches = loadOptionalPatches('fork56', file)
  assert.ok(Array.isArray(patches), 'the real loader must get a top-level array')
  return patches
}

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cfg-fork56-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir, cred: join(dshHome, '.credentials.yaml'), patch: join(profileDir, 'cordis.patch.yml'), state: join(dshHome, 'config-sync.json'), bak: join(dshHome, 'config-sync.bak') }
}
const deepseek = (config = {}) => ({
  entryId: 'llm-deepseek',
  config: { thinking: 'enabled', reasoningEffort: 'high', models: [{ id: 'deepseek-flash', name: 'Flash', contextWindow: 1000000 }], ...config },
  credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: KEY }],
})
const piProvider = () => ({ id: 'jina', api: 'openai-completions', baseURL: 'https://api.jina.ai/v1', apiKeyEnv: 'JINA_API_KEY', apiKey: PI_KEY, models: [{ id: 'jina-x', name: 'Jina X' }] })
const v2 = (revision, { plugins = [deepseek()], providers = [] } = {}) => ({ schema: 2, revision, providers, plugins, cliExpect: [] })
function push(home, data, extra = {}) {
  const acks = []
  const result = handleConfigPush({ data, dshHome: home.dshHome, profileDir: home.profileDir, send: (type, d) => acks.push(d), logger() {}, _restartFn() {}, _systemd: true, ...extra })
  return { result, acks }
}
const patchOf = (home) => readFileSync(home.patch, 'utf-8')
const stateOf = (home) => JSON.parse(readFileSync(home.state, 'utf-8'))
const idsOf = (patches) => (patches ?? []).flatMap((p) => [p.id, ...(p.insert ?? []).map((e) => e.id)]).filter(Boolean)

const TEMPLATE = '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n'

describe('B1: entries without an `id:` are legal loader forms and are not ours to reject', () => {
  let home
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  const INSERT = '- insert:\n    - id: probe-plugin\n      name: "@x/probe"\n      config:\n        a: 1\n'.replace(/^- insert:\n {4}/, '- insert:\n  ')

  test('B1-a: a patch with a `- insert:` entry next to hand-written entries is accepted; the insert entry survives byte-for-byte, the real loader reads the result', () => {
    const existing = '- id: remote-agent\n  name: "@x/remote-agent"\n\n- insert:\n  - id: probe-plugin\n    name: "@x/probe"\n    config:\n      a: 1\n'
    writeFileSync(home.patch, existing)
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = patchOf(home)
    assert.ok(text.includes('- insert:\n  - id: probe-plugin\n    name: "@x/probe"\n    config:\n      a: 1\n'), 'the insert entry is untouched')
    assert.match(text, /- id: llm-deepseek/)
    const ids = idsOf(loaded(home.patch))
    if (loadOptionalPatches) assert.deepEqual([...ids].sort(), ['llm-deepseek', 'probe-plugin', 'remote-agent'])
  })

  test('B1-b: a file that is nothing but an `- insert:` entry is accepted too', () => {
    writeFileSync(home.patch, '- insert:\n  - id: only-one\n    name: "@x/one"\n')
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(patchOf(home).startsWith('- insert:\n  - id: only-one\n    name: "@x/one"\n'))
    loaded(home.patch)
  })

  test('B1-c: a non-insert entry without an id (the loader warns and skips it) is kept as it is and does not block the push', () => {
    writeFileSync(home.patch, '- name: "@x/dangling"\n  config:\n    k: v\n')
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(patchOf(home).startsWith('- name: "@x/dangling"\n  config:\n    k: v\n'))
    loaded(home.patch)
  })

  test('B1-d: what is really broken is still refused and the files stay as they were: not an array, a bare scalar entry, a cut-off string', () => {
    for (const [name, broken] of [
      ['not-an-array', 'id: a\nname: b\n'],
      ['scalar-entry', '- id: a\n  name: b\n- foo\n'],
      ['cut-off', '- id: a\n  name: "@deep'],
      ['flow-and-block', '[]\n- id: a\n'],
    ]) {
      const h = makeHome()
      try {
        writeFileSync(h.patch, broken)
        const { result, acks } = push(h, v2(1))
        assert.equal(result.ok, false, name)
        assert.equal(acks[0].error, 'patch-existing-invalid', name)
        assert.equal(patchOf(h), broken, `${name}: the broken file is not touched`)
        assert.equal(existsSync(h.cred), false, `${name}: no credentials written either`)
      } finally { rmSync(h.base, { recursive: true, force: true }) }
    }
  })

  test('B1-e: validatePatchYaml unit — insert / id-less mapping / flow mapping / quoted key pass; scalar and truncation fail with the line', () => {
    for (const ok of ['- insert:\n  - id: x\n', '- name: x\n', '- {id: a}\n', '- "id": a\n', '-\n  id: a\n', '- id: a\n- insert:\n  - id: b\n']) assert.equal(validatePatchYaml(ok), null, ok)
    assert.deepEqual(validatePatchYaml('- id: a\n- foo\n'), { code: 'patch-invalid', line: 2 })
    assert.deepEqual(validatePatchYaml('- id: a\n  name: "cut'), { code: 'patch-invalid', line: 2 })
    void INSERT
  })
})

describe('B2: the file we leave behind is always a top-level array the loader accepts', () => {
  let home
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('B2-a: the new-profile template (`# comments` + `[]`) takes our entries: comments kept, `[]` gone, the real loader loads it', () => {
    writeFileSync(home.patch, TEMPLATE)
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = patchOf(home)
    assert.ok(text.startsWith('# Your patch layer for this dsh profile'), 'comments kept')
    assert.ok(text.includes('# overrides, disables, and insert lists; `!!js` expressions allowed).\n'))
    assert.equal(/^\[\]\s*$/m.test(text), false, '`[]` followed by block entries is not valid YAML')
    const patches = loaded(home.patch)
    if (loadOptionalPatches) assert.deepEqual(idsOf(patches), ['llm-deepseek'])
  })

  test('B2-b: a comments-only file takes our entries and keeps its comments', () => {
    writeFileSync(home.patch, '# note one\n# note two\n')
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(patchOf(home).startsWith('# note one\n# note two\n'))
    loaded(home.patch)
  })

  test('B2-c: revoking the last entry out of a comments file leaves `[]` and the comments — the loader still boots (not a comments-only file)', () => {
    writeFileSync(home.patch, '# keep me\n')
    assert.equal(push(home, v2(1)).result.ok, true)
    const { result } = push(home, v2(2, { plugins: [] }))
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = patchOf(home)
    assert.ok(text.includes('# keep me'), 'comment kept')
    assert.equal(text.includes('llm-deepseek'), false)
    const patches = loaded(home.patch)
    if (loadOptionalPatches) assert.deepEqual(patches, [], 'an empty array, not an error')
  })

  test('B2-d: the template survives a full round trip (push, revoke, push again) and the loader reads every stage', () => {
    writeFileSync(home.patch, TEMPLATE)
    assert.equal(push(home, v2(1)).result.ok, true); loaded(home.patch)
    assert.equal(push(home, v2(2, { plugins: [] })).result.ok, true); loaded(home.patch)
    assert.equal(push(home, v2(3)).result.ok, true); loaded(home.patch)
    assert.ok(patchOf(home).includes('# a top-level YAML array of loader patch entries'))
  })

  test('B2-e: unit — a comments-only result is refused before it is written (patch-not-array), `[]` and entries are arrays', () => {
    assert.equal(isLoaderArray('# c\n'), false)
    assert.equal(isLoaderArray(''), false)
    assert.equal(isLoaderArray('# c\n[]\n'), true)
    assert.equal(isLoaderArray('- id: a\n'), true)
    assert.equal(checkMergedPatch('- id: llm-deepseek\n  name: "x"\n', '# c\n', ['llm-deepseek'], {}), 'patch-not-array')
    assert.equal(checkMergedPatch('# c\n[]\n', '# c\n- id: llm-deepseek\n  name: "x"\n', ['llm-deepseek'], { 'llm-deepseek': '- id: llm-deepseek\n  name: "x"' }), null, 'dropping `[]` is not collateral damage')
    assert.equal(ensureLoaderArray('# c\n'), '# c\n[]\n')
    assert.equal(ensureLoaderArray(''), '[]\n')
  })
})

describe('B3: an entry the hub emptied is removed by the ownership rule, never left as a `providers: null` shell', () => {
  let home
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))
  const pi = () => v2(1, { plugins: [], providers: [piProvider()] })

  test('B3-a: the hub created llm-pi-ai, then revokes every provider → the entry is gone, the key is gone, neighbours stay, the loader reads the file', () => {
    writeFileSync(home.patch, '- id: remote-agent\n  name: "@x/remote-agent"\n')
    assert.equal(push(home, pi()).result.ok, true)
    assert.match(patchOf(home), /- id: llm-pi-ai/)
    assert.deepEqual(stateOf(home).ownedEntries, ['llm-pi-ai'])
    const { result } = push(home, v2(2, { plugins: [], providers: [] }))
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = patchOf(home)
    assert.equal(text.includes('llm-pi-ai'), false)
    assert.equal(isEmptyProvidersShell(text), false)
    assert.match(text, /- id: remote-agent/)
    assert.equal(/JINA_API_KEY/.test(readFileSync(home.cred, 'utf-8')), false)
    const ids = idsOf(loaded(home.patch))
    if (loadOptionalPatches) assert.deepEqual(ids, ['remote-agent'])
  })

  test('B3-b: a hand-written llm-pi-ai the hub took over is NOT removed when the hub revokes (it was the node\'s), and no shell is left in it', () => {
    writeFileSync(home.patch, '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      mine:\n        api: "openai-completions"\n        apiKeyEnv: "MINE_KEY"\n')
    const first = push(home, pi())
    assert.deepEqual(first.acks[0].adoptedEntries, ['llm-pi-ai'], 'the take-over is announced like any other')
    assert.match(readFileSync(join(home.bak, 'adopted-llm-pi-ai.yml'), 'utf-8'), /mine:/, 'original saved')
    assert.deepEqual(stateOf(home).ownedEntries, [])
    const { result } = push(home, v2(2, { plugins: [], providers: [] }))
    assert.equal(result.ok, true)
    const text = patchOf(home)
    assert.match(text, /- id: llm-pi-ai/, 'not ours to delete')
    assert.equal(isEmptyProvidersShell(text.slice(text.indexOf('- id: llm-pi-ai'))), false, 'what stays is the last pushed content, not a `providers:` shell')
    loaded(home.patch)
  })

  test('B3-c: state from fork.54/55 (no adoptedEntries; llm-pi-ai was always written by the sync) → revoking removes it', () => {
    writeFileSync(home.patch, '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      jina:\n        api: "openai-completions"\n        apiKeyEnv: "JINA_API_KEY"\n- id: permission\n  config:\n    mode: "ask"\n')
    writeFileSync(home.state, JSON.stringify({ schema: 2, appliedRevision: 1, lastPayload: { providers: [{ id: 'jina', baseURL: '', apiKeyEnv: 'JINA_API_KEY', keyDigest: 'x' }], plugins: [] }, ownedRefs: [], ownedEntries: [] }))
    const { result } = push(home, v2(2, { plugins: [], providers: [] }))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(patchOf(home).includes('llm-pi-ai'), false, 'the sync wrote it before, the sync takes it away')
    assert.match(patchOf(home), /- id: permission/)
  })

  test('B3-d: the shell fork.55 left behind (`providers:` with nothing under it) is cleaned up even though nobody owns it; a real hand-written provider list is not', () => {
    const shell = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n'
    writeFileSync(home.patch, shell + '- id: permission\n  config:\n    mode: "ask"\n')
    assert.equal(push(home, v2(1, { plugins: [], providers: [] })).result.ok, true)
    assert.equal(patchOf(home).includes('llm-pi-ai'), false, 'empty shell removed')
    assert.match(patchOf(home), /- id: permission/)
    const h2 = makeHome()
    try {
      const real = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      mine:\n        api: "openai-completions"\n'
      writeFileSync(h2.patch, real)
      assert.equal(push(h2, v2(1, { plugins: [], providers: [] })).result.ok, true)
      assert.equal(patchOf(h2), real, 'a node\'s own provider list is left alone')
    } finally { rmSync(h2.base, { recursive: true, force: true }) }
  })

  test('B3-e: a push with plugins only and no providers (the usual v2 deepseek push) writes no llm-pi-ai entry at all', () => {
    assert.equal(push(home, v2(1)).result.ok, true)
    const text = patchOf(home)
    assert.equal(text.includes('llm-pi-ai'), false)
    assert.match(text, /- id: llm-deepseek/)
    assert.deepEqual(stateOf(home).ownedEntries, ['llm-deepseek'])
    loaded(home.patch)
  })

  test('B3-f: unit — isEmptyProvidersShell tells a shell from a provider list', () => {
    const head = '- id: llm-pi-ai\n  name: "x"\n  config:\n    providers:'
    assert.equal(isEmptyProvidersShell(head), true)
    assert.equal(isEmptyProvidersShell(head + ' null'), true)
    assert.equal(isEmptyProvidersShell(head + '\n    defaultModel: "a/b"'), true)
    assert.equal(isEmptyProvidersShell(head + '\n      jina:\n        api: "x"'), false)
    assert.equal(isEmptyProvidersShell('- id: other\n  name: "x"'), false)
  })
})

describe('Q0: an adopted entry stays adopted — the saved original and the receipt are stable', () => {
  let home
  const HAND = '- id: remote-agent\n  name: "@x/remote-agent"\n\n- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    reasoningEffort: low\n\n- id: permission\n  config:\n    mode: "ask"\n'
  const ORIGINAL = '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    reasoningEffort: low\n'
  beforeEach(() => { home = makeHome(); writeFileSync(home.patch, HAND) })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))
  const saved = () => readFileSync(join(home.bak, 'adopted-llm-deepseek.yml'), 'utf-8')

  test('Q0-a: the second push keeps the hand-written original in the backup and raises no second adoptedEntries; the state remembers the adoption', () => {
    const first = push(home, v2(1))
    assert.deepEqual(first.acks[0].adoptedEntries, ['llm-deepseek'])
    assert.equal(saved(), ORIGINAL)
    assert.deepEqual(stateOf(home).adoptedEntries, ['llm-deepseek'])
    assert.deepEqual(stateOf(home).ownedEntries, [])

    const second = push(home, { ...v2(2), plugins: [deepseek({ reasoningEffort: 'low', thinking: 'enabled' })] })
    assert.equal(second.result.ok, true)
    assert.equal('adoptedEntries' in second.acks[0], false, 'no repeated notice')
    assert.equal(saved(), ORIGINAL, 'the node\'s own text is still what the backup holds')
    assert.deepEqual(stateOf(home).adoptedEntries, ['llm-deepseek'])
    assert.deepEqual(stateOf(home).ownedEntries, [], 'still not owned')
    assert.match(patchOf(home), /reasoningEffort: "?low"?/, 'the hub\'s newer content is what is applied')
  })

  test('Q0-b: dropping the plugin forgets the adoption but never deletes the entry; adopting it again does not overwrite the first backup', () => {
    push(home, v2(1))
    push(home, v2(2, { plugins: [] }))
    assert.match(patchOf(home), /- id: llm-deepseek/, 'the node\'s entry stays')
    assert.deepEqual(stateOf(home).adoptedEntries, [], 'the adoption record is dropped with the plugin')
    const again = push(home, v2(3))
    assert.deepEqual(again.acks[0].adoptedEntries, ['llm-deepseek'], 'it is in the file when the hub comes back: announced again')
    assert.equal(saved(), ORIGINAL, 'the hand-written original survives')
    const names = readdirSync(home.bak).filter((n) => n.startsWith('adopted-llm-deepseek'))
    assert.equal(names.length, 2, 'the second take-over got its own file: ' + names)
    assert.ok(names.includes('adopted-llm-deepseek-r3.yml'))
  })

  test('Q0-c: an entry the node deleted by hand while the hub still wants it is simply created again — and becomes the hub\'s (owned), not adopted', () => {
    push(home, v2(1))
    writeFileSync(home.patch, '- id: remote-agent\n  name: "@x/remote-agent"\n')
    const { result, acks } = push(home, { ...v2(2), plugins: [deepseek({ reasoningEffort: 'low' })] })
    assert.equal(result.ok, true)
    assert.equal('adoptedEntries' in acks[0], false)
    assert.deepEqual(stateOf(home).ownedEntries, ['llm-deepseek'])
    assert.deepEqual(stateOf(home).adoptedEntries, [])
  })

  test('Q0-d: a state file without adoptedEntries (written before fork.56) is read as "none adopted" and the push still works', () => {
    writeFileSync(home.patch, '- id: permission\n  config:\n    mode: "ask"\n')
    writeFileSync(home.state, JSON.stringify({ schema: 2, appliedRevision: 1, lastPayload: { providers: [], plugins: [] }, ownedRefs: [], ownedEntries: [] }))
    const { result } = push(home, v2(2))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(stateOf(home).adoptedEntries, [])
    assert.deepEqual(stateOf(home).ownedEntries, ['llm-deepseek'])
  })

  test('Q0-e (G5): when the original cannot be saved the whole push is rolled back — nothing written, revision not advanced, no key on disk', () => {
    // Both the plain name and the revision-suffixed name are directories: writing the backup must fail.
    mkdirSync(join(home.bak, 'adopted-llm-deepseek.yml'), { recursive: true })
    mkdirSync(join(home.bak, 'adopted-llm-deepseek-r1.yml'), { recursive: true })
    const { result, acks } = push(home, v2(1))
    assert.equal(result.ok, false)
    assert.match(acks[0].error, /^adopted-backup-failed/)
    assert.equal(acks[0].rollbackRevision, 0)
    assert.equal(patchOf(home), HAND, 'patch untouched')
    assert.equal(existsSync(home.cred), false, 'no key written')
    assert.equal(stateOf(home).appliedRevision ?? 0, 0, 'revision rolled back, so the hub pushes it again')
    // and the node recovers once the obstacle is gone
    rmSync(join(home.bak, 'adopted-llm-deepseek.yml'), { recursive: true })
    rmSync(join(home.bak, 'adopted-llm-deepseek-r1.yml'), { recursive: true })
    const retry = push(home, v2(1))
    assert.equal(retry.result.ok, true, JSON.stringify(retry.result))
    assert.equal(saved(), ORIGINAL)
  })
})
