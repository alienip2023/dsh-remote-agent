/**
 * fork.57：验收官对 fork.56 的三项建议。
 *
 *  U  从 fork.54/55 的状态升级：adopted-<id>.yml 备份已经在 → 早已接管过，静默记为「已接管」，
 *     不再存 -r<revision> 备份，不再回执 adoptedEntries
 *  B  validatePatchYaml 的缺口：块条目后接 `[]`、重复 `[]`；与真实 loader（js-yaml）逐条核对
 *     文档结束标记 `...`（结尾合法、后面还有内容不合法）与缩进里的 tab
 *  D  往以 `...` 结尾的 patch 追加条目时先拿掉 `...`（否则追加内容落在文档之外，loader 拒绝启动）
 *
 * 全部行为断言：真实 handleConfigPush / 真实文件；loader 一致性用 DSH 自己的 `loadOptionalPatches`
 * （DSH_NODE_MODULES 缺省 /tmp/dsh-asar/node_modules；没有就只跑硬编码期望那一半）。
 */
import { test, describe, beforeEach, afterEach, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { handleConfigPush } from '../lib/node/config-sync.js'
import { validatePatchYaml, replaceManagedEntry, withoutDocEnd } from '../lib/node/config-managed.js'

const KEY = 'sk-deepseek-SECRET-0123456789'
const NM = process.env.DSH_NODE_MODULES || '/tmp/dsh-asar/node_modules'
const LOADER = join(NM, '@deepseek-ai/dsh-app-boot/lib/index.js')
let loadOptionalPatches = null
before(async () => {
  if (!existsSync(LOADER)) return
  try { ({ loadOptionalPatches } = await import(pathToFileURL(LOADER).href)) } catch { loadOptionalPatches = null }
})

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cfg-fork57-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir, cred: join(dshHome, '.credentials.yaml'), patch: join(profileDir, 'cordis.patch.yml'), state: join(dshHome, 'config-sync.json'), bak: join(dshHome, 'config-sync.bak') }
}
const deepseek = () => ({
  entryId: 'llm-deepseek',
  config: { thinking: 'enabled', reasoningEffort: 'high', models: [{ id: 'deepseek-flash', name: 'Flash', contextWindow: 1000000 }] },
  credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: KEY }],
})
const v2 = (revision, { plugins = [deepseek()] } = {}) => ({ schema: 2, revision, providers: [], plugins, cliExpect: [] })
function push(home, data) {
  const acks = []
  const result = handleConfigPush({ data, dshHome: home.dshHome, profileDir: home.profileDir, send: (type, d) => acks.push(d), logger() {}, _restartFn() {}, _systemd: true })
  return { result, acks }
}
const patchOf = (home) => readFileSync(home.patch, 'utf-8')
const stateOf = (home) => JSON.parse(readFileSync(home.state, 'utf-8'))
const loaderLoads = (file) => { try { return Array.isArray(loadOptionalPatches('fork57', file)) } catch { return false } }

describe('U: upgrading from a fork.54/55 state — the takeover that already happened is not repeated', () => {
  let home
  const ORIGINAL = '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    reasoningEffort: low\n'
  const PUSHED = '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    thinking: enabled\n    reasoningEffort: high\n'
  // what fork.55 leaves: the hub's content in the patch, the hand-written original in the backup, a state without adoptedEntries
  const legacy55 = (h, { withBackup = true } = {}) => {
    writeFileSync(h.patch, '- id: remote-agent\n  name: "@x/remote-agent"\n\n' + PUSHED)
    writeFileSync(h.cred, 'refs:\n  DEEPSEEK_API_KEY: ' + KEY + '\n')
    writeFileSync(h.state, JSON.stringify({ schema: 2, appliedRevision: 1, lastPayload: { providers: [], plugins: [] }, ownedRefs: ['DEEPSEEK_API_KEY'], ownedEntries: [] }))
    if (withBackup) { mkdirSync(h.bak, { recursive: true }); writeFileSync(join(h.bak, 'adopted-llm-deepseek.yml'), ORIGINAL) }
  }
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))
  const backups = () => (existsSync(home.bak) ? readdirSync(home.bak).filter((f) => f.startsWith('adopted-')).sort() : [])

  test('U-a: the backup file is there, the state has no adoptedEntries → no -r2 copy, no adoptedEntries receipt, the original stays byte for byte, the state now remembers the adoption', () => {
    legacy55(home)
    const { result, acks } = push(home, v2(2))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal('adoptedEntries' in acks[0], false, 'no second notice for the same takeover')
    assert.deepEqual(backups(), ['adopted-llm-deepseek.yml'], 'no -r<revision> file')
    assert.equal(readFileSync(join(home.bak, 'adopted-llm-deepseek.yml'), 'utf-8'), ORIGINAL, 'the node\'s own text is still what the backup holds')
    assert.deepEqual(stateOf(home).adoptedEntries, ['llm-deepseek'])
    assert.deepEqual(stateOf(home).ownedEntries, [], 'still not the hub\'s to delete')
  })

  test('U-b: and so a later revoke leaves the entry in place (it is the node\'s), and a later push is quiet as well', () => {
    legacy55(home)
    push(home, v2(2))
    const again = push(home, v2(3))
    assert.equal('adoptedEntries' in again.acks[0], false)
    assert.deepEqual(backups(), ['adopted-llm-deepseek.yml'])
    const revoked = push(home, v2(4, { plugins: [] }))
    assert.equal(revoked.result.ok, true)
    assert.match(patchOf(home), /- id: llm-deepseek/, 'not deleted')
  })

  test('U-c: contrast — the same old state WITHOUT a saved original is a first takeover: backup written, receipt raised', () => {
    legacy55(home, { withBackup: false })
    const { acks } = push(home, v2(2))
    assert.deepEqual(acks[0].adoptedEntries, ['llm-deepseek'])
    assert.deepEqual(backups(), ['adopted-llm-deepseek.yml'])
  })

  test('U-d: no state at all (a node that never synced) with a stray backup file is not "already adopted" — the new takeover is saved next to the old file', () => {
    writeFileSync(home.patch, ORIGINAL)
    mkdirSync(home.bak, { recursive: true })
    writeFileSync(join(home.bak, 'adopted-llm-deepseek.yml'), 'stray\n')
    const { acks } = push(home, v2(1))
    assert.deepEqual(acks[0].adoptedEntries, ['llm-deepseek'])
    assert.equal(readFileSync(join(home.bak, 'adopted-llm-deepseek.yml'), 'utf-8'), 'stray\n', 'the old file is never overwritten')
    assert.equal(readFileSync(join(home.bak, 'adopted-llm-deepseek-r1.yml'), 'utf-8'), ORIGINAL)
  })

  test('U-e: a fork.56 state (adoptedEntries present) keeps the fork.56 rule — an entry that is not in it and has a backup file is adopted again into -r<revision>', () => {
    writeFileSync(home.patch, ORIGINAL)
    writeFileSync(home.state, JSON.stringify({ schema: 2, appliedRevision: 1, lastPayload: { providers: [], plugins: [] }, ownedRefs: [], ownedEntries: [], adoptedEntries: [] }))
    mkdirSync(home.bak, { recursive: true })
    writeFileSync(join(home.bak, 'adopted-llm-deepseek.yml'), 'first original\n')
    const { acks } = push(home, v2(2))
    assert.deepEqual(acks[0].adoptedEntries, ['llm-deepseek'])
    assert.equal(readFileSync(join(home.bak, 'adopted-llm-deepseek.yml'), 'utf-8'), 'first original\n')
    assert.equal(readFileSync(join(home.bak, 'adopted-llm-deepseek-r2.yml'), 'utf-8'), ORIGINAL)
  })
})

// text → does DSH's loader (js-yaml `load`) read it as one document? (null/non-array results are not listed)
const CASES = [
  ['block-then-[]', '- id: a\n  name: b\n[]\n', false],
  ['[]-then-[]', '[]\n[]\n', false],
  ['[]-comment-[]', '[]\n# c\n[]\n', false],
  ['[]-then-block', '[]\n- id: a\n', false],
  ['template', '# top\n[]\n', true],
  ['doc-end-last', '- id: a\n  name: b\n...\n', true],
  ['doc-end-no-newline', '- id: a\n  name: b\n...', true],
  ['doc-end-then-comment', '- id: a\n  name: b\n...\n# c\n', true],
  ['doc-end-then-blank', '- id: a\n  name: b\n...\n\n', true],
  ['doc-end-with-comment', '- id: a\n  name: b\n... # c\n', true],
  ['doc-start', '---\n- id: a\n  name: b\n', true],
  ['doc-start-with-comment', '--- # c\n- id: a\n  name: b\n', true],
  ['doc-start-end', '---\n- id: a\n  name: b\n...\n', true],
  ['comment-doc-start', '# c\n---\n- id: a\n  name: b\n', true],
  ['doc-end-then-entry', '- id: a\n  name: b\n...\n- id: c\n  name: d\n', false],
  ['doc-end-then-entry-flow', '- {id: a}\n...\n- {id: c}\n', false],
  ['doc-end-doc-end', '- id: a\n  name: b\n...\n...\n', false],
  ['doc-sep-mid', '- id: a\n  name: b\n---\n- id: c\n  name: d\n', false],
  ['doc-sep-twice', '---\n---\n- id: a\n  name: b\n', false],
  ['doc-end-then-doc-start', '- id: a\n  name: b\n...\n---\n- id: c\n  name: d\n', false],
  ['tab-indent-key', '- id: a\n\tname: b\n', false],
  ['tab-after-spaces', '- id: a\n  \tname: b\n', false],
  ['tab-leading-dash', '\t- id: a\n', false],
  ['tab-after-dash', '-\tid: a\n', false],
  ['tab-block-scalar', '- id: a\n  note: |\n    x\n\ty\n', false],
  ['tab-plain-continuation', '- id: a\n  note: one\n\ttwo\n', false],
  ['tab-after-colon', '- id:\ta\n  name: b\n', true],
  ['tab-trailing', '- id: a\t\n  name: b\n', true],
  ['tab-comment-line', '\t# hi\n- id: a\n  name: b\n', true],
  ['tab-blank-line', '- id: a\n\t\n  name: b\n', true],
  ['tab-in-string', '- id: a\n  name: "x\ty"\n', true],
  ['tab-in-flow', '- id: a\n  m: {\n\tx: 1}\n  n: 1\n', true],
]

describe('B: validatePatchYaml agrees with the loader on structure the old scan let through', () => {
  for (const [name, text, ok] of CASES) {
    test(`B-table ${name}: ${ok ? 'accepted' : 'refused'}`, () => {
      assert.equal(validatePatchYaml(text) === null, ok, `validatePatchYaml(${JSON.stringify(text)})`)
    })
  }

  test('B-loader: every row of the table is what DSH\'s real loader does with the same file (a loader that is not installed here skips this one)', { skip: !existsSync(LOADER) }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-fork57-loader-'))
    try {
      for (const [name, text, ok] of CASES) {
        const file = join(dir, `${name}.yml`)
        writeFileSync(file, text)
        // a template is `[]`: loaded as an array too
        assert.equal(loaderLoads(file), ok, `loader on ${name}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('B-push: a broken existing patch refuses the push and stays as it is — block entry then [], twice [], a second document, an entry after `...`, tab indentation', () => {
    for (const [name, text, ok] of CASES.filter(([, , okay]) => !okay)) {
      const h = makeHome()
      try {
        writeFileSync(h.patch, text)
        const { result, acks } = push(h, v2(1))
        assert.equal(result.ok, false, name)
        assert.equal(acks[0].error, 'patch-existing-invalid', name)
        assert.equal(patchOf(h), text, `${name}: untouched`)
        assert.equal(existsSync(h.cred), false, `${name}: no key written`)
      } finally { rmSync(h.base, { recursive: true, force: true }) }
    }
  })
})

describe('D: a patch that ends with `...` takes the new entry inside the document', () => {
  let home
  beforeEach(() => { home = makeHome() })
  afterEach(() => rmSync(home.base, { recursive: true, force: true }))

  test('D-a: append to `...`-terminated patch — the marker is dropped, the neighbour is byte for byte, the loader reads the result', () => {
    const neighbour = '- id: remote-agent\n  name: "@x/remote-agent"\n'
    writeFileSync(home.patch, neighbour + '...\n')
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = patchOf(home)
    assert.ok(text.startsWith(neighbour), 'neighbour untouched')
    assert.match(text, /- id: llm-deepseek/)
    assert.equal(/^\.\.\.\s*$/m.test(text), false, 'no stray marker in the middle')
    if (loadOptionalPatches) assert.equal(loaderLoads(home.patch), true, 'the real loader reads it')
  })

  test('D-b: with a `---` header and a trailing comment after the marker too', () => {
    writeFileSync(home.patch, '---\n- id: remote-agent\n  name: "@x/remote-agent"\n...\n# end\n')
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(patchOf(home), /^---\n- id: remote-agent/)
    if (loadOptionalPatches) assert.equal(loaderLoads(home.patch), true)
  })

  test('D-c: replacing an entry that already exists keeps the marker where it was (nothing is appended)', () => {
    const existing = '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek-api-key"\n  config:\n    reasoningEffort: low\n...\n'
    writeFileSync(home.patch, existing)
    const { result } = push(home, v2(1))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(patchOf(home), /reasoningEffort: "?high"?/)
    assert.match(patchOf(home), /\n\.\.\.\n$/, 'the marker stays at the end')
    if (loadOptionalPatches) assert.equal(loaderLoads(home.patch), true)
  })

  test('D-d: units — withoutDocEnd drops only a final marker; replaceManagedEntry appends inside the document', () => {
    assert.equal(withoutDocEnd('- id: a\n...\n'), '- id: a\n')
    assert.equal(withoutDocEnd('- id: a\n...\n# c\n\n'), '- id: a\n# c\n\n')
    assert.equal(withoutDocEnd('- id: a\n...\n- id: b\n'), '- id: a\n...\n- id: b\n', 'a marker with content after it is not final — left to the validator')
    assert.equal(withoutDocEnd('- id: a\n  note: "...\n'), '- id: a\n  note: "...\n')
    const out = replaceManagedEntry('- id: a\n  name: b\n...\n', 'x', '- id: x\n  name: y')
    assert.equal(out, '- id: a\n  name: b\n\n- id: x\n  name: y\n')
  })
})
