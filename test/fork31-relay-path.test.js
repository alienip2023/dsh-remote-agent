import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { currentPatchFile } from '../lib/setup-routes.js'
import { applyRelayMemory, buildRelayAutoconfigYaml, readRelayToken, readRelayUrl } from '../lib/hub/relay-memory.js'
import { MANAGED_BEGIN, MANAGED_END, writePatchBlock } from '../lib/setup.js'

const setupRoutesPath = fileFrom('../lib/setup-routes.js')
const uiRoutesPath = fileFrom('../lib/hub/ui-routes.js')
const relayMemoryPath = fileFrom('../lib/hub/relay-memory.js')

function fileFrom(rel) {
  return path.join(path.dirname(new URL(import.meta.url).pathname), rel)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function forbiddenDesktopPatch() {
  return path.join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
}

/** 同一条路径断言：临时 DSH_HOME 只有 profiles/web 时，必须命中该文件。 */
function assertResolvesWebProfile(resolvePatchFile) {
  const root = mkdtempSync(path.join(tmpdir(), 'fork31-dsh-home-'))
  const webFile = path.join(root, 'profiles', 'web', 'cordis.patch.yml')
  mkdirSync(path.dirname(webFile), { recursive: true })
  writeFileSync(webFile, 'plugins: []\n')
  const prevHome = process.env.DSH_HOME
  const prevProfile = process.env.DSH_PROFILE
  try {
    process.env.DSH_HOME = root
    delete process.env.DSH_PROFILE
    const got = resolvePatchFile()
    assert.strictEqual(got, webFile, '必须解析到 DSH_HOME/profiles/web/cordis.patch.yml')
    assert.notStrictEqual(got, forbiddenDesktopPatch(), '不得回落到 ~/.dsh/profiles/desktop/cordis.patch.yml')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = prevProfile
    rmSync(root, { recursive: true, force: true })
  }
}

function autoconfigBlock(source) {
  const idx = source.indexOf('/relay-autoconfig')
  assert.ok(idx >= 0, '必须有 /relay-autoconfig 路由')
  return source.slice(idx)
}

/** 同一条写盘断言：autoconfig 必须调用 writePatchBlock，且不得再用错误标记。 */
function assertAutoconfigWrites(source) {
  const block = autoconfigBlock(source)
  assert.ok(block.includes('writePatchBlock('), 'relay-autoconfig 必须调用 writePatchBlock')
  assert.equal(source.includes('# BEGIN dsh-remote-agent managed'), false, '不得再出现 # BEGIN dsh-remote-agent managed')
}

/** 同一条内存断言：写盘后的 token 必须能从 ssh-onboard 的读取口径看见。 */
function assertRelayMemoryVisible(api) {
  const config = {}
  api.applyRelayMemory(config, { relayUrl: 'ws://relay.example/relay', token: 'rt_fork31_mem' })
  const token = api.readRelayToken(config)
  assert.notStrictEqual(token, '', '写盘成功后内存 token 必须非空')
  assert.strictEqual(token, 'rt_fork31_mem')
  assert.strictEqual(api.readRelayUrl(config), 'ws://relay.example/relay')
  assert.strictEqual(config.relay && config.relay.token, token, 'config.relay.token 必须与读取口径一致')
  assert.strictEqual(config.transportMode, 'relay')

  const frozen = Object.freeze({})
  api.applyRelayMemory(frozen, { relayUrl: 'ws://relay.example/relay', token: 'rt_fork31_frozen' })
  assert.strictEqual(api.readRelayToken(frozen), 'rt_fork31_frozen', '冻结 config 也必须从同一读取口径看见 token')
  assert.strictEqual(api.readRelayUrl(frozen), 'ws://relay.example/relay')
}

function withDiskMutation(filePath, mutate, predicate) {
  const original = readFileSync(filePath)
  const originalSha = sha256(original)
  try {
    writeFileSync(filePath, mutate(original.toString('utf8')))
    const reread = readFileSync(filePath, 'utf8')
    assert.throws(() => predicate(reread), '变异后主断言必须失败')
  } finally {
    writeFileSync(filePath, original)
    assert.strictEqual(sha256(readFileSync(filePath)), originalSha)
  }
}

async function withDiskMutationModule(filePath, mutate, run) {
  const original = readFileSync(filePath)
  const originalSha = sha256(original)
  try {
    writeFileSync(filePath, mutate(original.toString('utf8')))
    const reread = readFileSync(filePath, 'utf8')
    const mod = await import(pathToFileURL(filePath).href + '?fork31=' + Date.now() + Math.random())
    await assert.rejects(async () => { await run(mod, reread) }, '变异后主断言必须失败')
  } finally {
    writeFileSync(filePath, original)
    assert.strictEqual(sha256(readFileSync(filePath)), originalSha)
  }
}

test('T1: 临时 DSH_HOME 只有 profiles/web 时解析到该文件', () => {
  assertResolvesWebProfile(currentPatchFile)
})

test('M1: 关掉 DSH_HOME 分支后同一条路径断言必须红', async () => {
  await withDiskMutationModule(
    setupRoutesPath,
    (source) => source.replace(
      "  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {",
      '  if (false) { // MUTATION DSH_HOME branch removed',
    ),
    (mod) => assertResolvesWebProfile(mod.currentPatchFile),
  )
})

test('T2: relay-autoconfig 调用 writePatchBlock 且不用错误标记', () => {
  assertAutoconfigWrites(readFileSync(uiRoutesPath, 'utf8'))
})

test('M2: 删掉 writePatchBlock 调用后同一条断言必须红', () => {
  withDiskMutation(
    uiRoutesPath,
    (source) => source.replace(
      'const result = writePatchBlock({ file: patchFile, blockYaml })',
      'const result = { ok: true, error: "" } // MUTATION removed write call',
    ),
    assertAutoconfigWrites,
  )
})

test('T3: 写盘后内存 token 与 readRelayToken 口径一致', () => {
  assertRelayMemoryVisible({ applyRelayMemory, readRelayToken, readRelayUrl })
})

test('M3: 删掉 slot.token 赋值后同一条断言必须红', async () => {
  await withDiskMutationModule(
    relayMemoryPath,
    (source) => source.replace(
      "  slot.token = String(token || '')",
      '  // MUTATION removed token assign',
    ),
    (mod) => assertRelayMemoryVisible(mod),
  )
})

test('T4: writePatchBlock 替换托管块，不碰 mcp-geelark，不追加第二个 id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fork31-patch-'))
  const file = path.join(dir, 'cordis.patch.yml')
  const before = [
    'plugins:',
    '  - id: mcp-geelark',
    '    disabled: true',
    '  - id: other-plugin',
    '    config:',
    '      keep: 1',
    '',
  ].join('\n')
  const oldBlock = [
    '- id: remote-agent',
    '  name: dsh-remote-agent',
    "  inject: ['webServer', 'tools', 'systemPrompt']",
    '  config:',
    '    role: hub',
    '    transportMode: relay',
    "    relayUrl: 'ws://old.example/relay'",
    '    listenPort: 19387',
    '',
  ].join('\n')
  const original = `${before}${MANAGED_BEGIN}\n${oldBlock}${MANAGED_END}\n`
  writeFileSync(file, original)
  try {
    const blockYaml = buildRelayAutoconfigYaml(original, {
      relayUrl: 'ws://relay.example/relay',
      hubToken: 'rt_fork31_disk',
    })
    const result = writePatchBlock({ file, blockYaml })
    assert.equal(result.ok, true, result.error)
    const written = readFileSync(file, 'utf8')
    assert.ok(written.startsWith(before), '托管块之前的其它插件必须原样保留')
    assert.ok(written.includes('  - id: mcp-geelark\n    disabled: true'), 'mcp-geelark disabled: true 不能删')
    assert.equal((written.match(/^\s*-\s+id:\s*remote-agent\b/gm) || []).length, 1, '不得追加第二个 remote-agent')
    assert.equal(written.includes('# BEGIN dsh-remote-agent managed'), false)
    assert.ok(written.includes("token: 'rt_fork31_disk'"), '必须写入 relay.token')
    assert.ok(written.includes('listenPort: 19387'), '托管块里未管辖的字段必须保留')
    assert.ok(written.includes("inject: ['webServer', 'tools', 'systemPrompt']"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
