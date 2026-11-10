/**
 * fork.59：节点 patch 里合法的 YAML 折行不再被当成「文件被截断」。
 *
 *  事故（s44）：节点的 cordis.patch.yml 被 js-yaml 风格的工具整份重写过（长字符串折行、`\` 续行），
 *  ra 的 validatePatchYaml 把「双引号在行尾没闭合」当成截断 → 每次推送都 ack `patch-existing-invalid`，
 *  节点配置从那以后再没更新（xai 一直直连）。
 *
 *  F  折行 / 续行 / 块标量 / 纯文本续行 / 真截断 的逐条表；同一张表在 DSH 真实 loader（js-yaml `load`）上核对
 *  Z  差分 fuzz：用 js-yaml `dump` 生成真实的折行输出（合法 → 必须放行）；随机截断（js-yaml 报
 *     「unexpected end of the stream within a … quoted scalar」→ 必须拒绝）
 *  N  节点 patch 的脱敏副本（test/fixtures/node-patch-js-yaml-folded.yml）：原样推送 xai 直连 / 网关化两种载荷都成功
 *  T  到文件末尾仍未闭合的折行：推送被拒，文件原样，没有写 key
 *
 * 全部行为断言：真实 handleConfigPush / 真实文件；loader 一致性用 DSH 自带的 js-yaml 与 `loadOptionalPatches`
 * （DSH_NODE_MODULES 缺省 /tmp/dsh-asar/node_modules；没有就只跑硬编码期望那一半）。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { handleConfigPush } from '../lib/node/config-sync.js'
import { validatePatchYaml } from '../lib/node/config-managed.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const NM = process.env.DSH_NODE_MODULES || '/tmp/dsh-asar/node_modules'
const LOADER = join(NM, '@deepseek-ai/dsh-app-boot/lib/index.js')
const FIXTURE = join(HERE, 'fixtures', 'node-patch-js-yaml-folded.yml')
const KEY = 'sk-fork59-SECRET-0123456789'

let yaml = null
let loadOptionalPatches = null
before(async () => {
  try { yaml = createRequire(NM.endsWith('/') ? NM : NM + '/')('js-yaml') } catch { yaml = null }
  if (!existsSync(LOADER)) return
  try { ({ loadOptionalPatches } = await import(pathToFileURL(LOADER).href)) } catch { loadOptionalPatches = null }
})
// text → does js-yaml read it as a list of mappings (what a patch has to be)?
const yamlLoads = (text) => { try { const v = yaml.load(text); return Array.isArray(v) && v.every((e) => e && typeof e === 'object' && !Array.isArray(e)) } catch { return false } }
const loaderLoads = (file) => { try { return Array.isArray(loadOptionalPatches('fork59', file)) } catch { return false } }

function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cfg-fork59-'))
  const dshHome = join(base, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir, cred: join(dshHome, '.credentials.yaml'), patch: join(profileDir, 'cordis.patch.yml'), state: join(dshHome, 'config-sync.json') }
}
const E = '- id: a\n  name: b\n'

const FOLD_CASES = [
  ['dq-fold', E + '  description: "Stronger agentic coding;\n    suited to complex tasks."\n  x: 1\n', true],
  ['dq-fold-three-lines', E + '  d: "one\n    two\n    three"\n', true],
  ['dq-fold-in-entry-head', '- id: "a\n    b"\n  name: c\n', true],
  ['dq-backslash-continuation', E + '  id2: "/models/Hereti\\\n      c-MLX"\n', true],
  ['dq-escaped-quote-then-fold', E + '  d: "say \\"hi\\" and\n    go"\n', true],
  ['dq-fold-continuation-has-structure-chars', E + '  d: "see [a, {b\n    c]: x # not a comment"\n  z: 1\n', true],
  ['dq-fold-then-tail-comment', E + '  d: "a\n    b" # trailing\n  z: 1\n', true],
  ['sq-fold', E + "  d: 'one\n    two'\n  z: 1\n", true],
  ['sq-doubled-quote-fold', E + "  d: 'it''s\n    fine'\n  z: 1\n", true],
  ['dq-fold-in-flow-seq', E + '  l: ["a\n    b", "c"]\n  z: 1\n', true],
  ['plain-continuation-starts-with-quote', E + '  note: said it loudly\n    "hello there now\n  z: 1\n', true],
  ['plain-apostrophe-continuation', E + "  note: one\n    'tis two\n  z: 1\n", true],
  ['block-literal-unbalanced-quotes', E + '  note: |\n    it\'s "unbalanced\n    still text\n  z: 1\n', true],
  ['block-literal-line-starts-with-quote', E + '  note: |\n    "unbalanced\n    still text\n  z: 1\n', true],
  ['block-folded-strip', E + '  note: >-\n    a "b\n    c\n  z: 1\n', true],
  ['dq-fold-then-more-entries', E + '  d: "x\n    y"\n- id: c\n  name: d\n', true],
  ['truncated-mid-string', E + '  d: "abc', false],
  ['truncated-mid-fold', E + '  d: "abc\n    def', false],
  ['truncated-after-backslash', E + '  d: "abc\\\n', false],
  ['truncated-after-escaped-quote', E + '  d: "abc \\"', false],
  ['truncated-sq-doubled-quote', E + "  d: 'it''s", false],
  ['truncated-sq', E + "  d: 'abc", false],
  ['truncated-sq-fold', E + "  d: 'abc\n    def", false],
  ['fold-ok-then-truncated', E + '  d: "x\n    y"\n- id: c\n  name: "cut', false],
  ['doc-marker-inside-quote', E + '  d: "x\n---\n    y"\n', false],
]

describe('F: a folded quoted scalar is not a truncated file; a quote still open at the end of the file is', () => {
  for (const [name, text, ok] of FOLD_CASES) {
    test(`F59-table ${name}: ${ok ? 'accepted' : 'refused'}`, () => {
      assert.equal(validatePatchYaml(text) === null, ok, `validatePatchYaml(${JSON.stringify(text)})`)
    })
  }

  test('F59-loader: every row of the table is what js-yaml and DSH\'s real loader do with the same text (a loader that is not installed here skips this one)', { skip: !existsSync(LOADER) }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-fork59-loader-'))
    try {
      for (const [name, text, ok] of FOLD_CASES) {
        assert.equal(yamlLoads(text), ok, `js-yaml on ${name}`)
        const file = join(dir, `${name}.yml`)
        writeFileSync(file, text)
        assert.equal(loaderLoads(file), ok, `loader on ${name}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// seeded generator: the same documents on every run
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 } }
const WORDS = ['suited', 'to', 'complex', 'tasks', '"quoted"', "it's", 'a:b', 'x # y', '[z]', '{k}', 'back\\slash', '-dash', '100%', '#hash', '@at', 'é', '中文', 'plain', 'text', 'long', 'agentic', 'coding,', 'knowledge,']
function makeDocs(seed, count) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const str = () => { const n = 1 + Math.floor(r() * 25); const w = []; for (let i = 0; i < n; i++) w.push(pick(WORDS)); let t = w.join(' '); if (r() < 0.15) t += '\nsecond line "x'; return t }
  const entry = () => ({ id: 'e' + Math.floor(r() * 99), name: str(), config: { models: [{ id: pick(['a', 'b/c d']) + str().slice(0, 8), name: str(), description: str(), input: ['text', 'image'] }], note: str(), nested: { list: [str(), str()], flag: r() < 0.5, n: Math.floor(r() * 1e6) } } })
  const out = []
  for (let k = 0; k < count; k++) {
    const doc = Array.from({ length: 1 + Math.floor(r() * 3) }, entry)
    out.push(yaml.dump(doc, { lineWidth: pick([20, 30, 40, 60, 80, -1]), quotingType: pick(['"', "'"]), forceQuotes: r() < 0.4, noRefs: true }))
  }
  return { docs: out, r, pick }
}
const FOLDED = /(["'])[^"'\n]*\\?\n\s+[^"'\n]*\1/   // a quoted scalar that runs over a line break

describe('Z: differential fuzz against js-yaml', { skip: !existsSync(join(NM, 'js-yaml')) }, () => {
  test('F59-fuzz-dump: whatever js-yaml dumps (folded, backslash-continued, block scalars, plain continuations) is accepted', () => {
    let folded = 0
    let blocks = 0
    for (const seed of [11, 12, 13]) {
      const { docs } = makeDocs(seed, 300)
      for (const text of docs) {
        assert.equal(yamlLoads(text), true, 'the generator only makes loadable documents')
        if (FOLDED.test(text)) folded++
        if (/: [|>][-+]?\n/.test(text)) blocks++
        assert.equal(validatePatchYaml(text), null, `refused a document js-yaml dumped:\n${text}`)
      }
    }
    assert.ok(folded >= 100, `the fuzz must really contain folded quoted scalars (got ${folded})`)
    assert.ok(blocks >= 20, `... and block scalars (got ${blocks})`)
  })

  test('F59-fuzz-truncate: cut a dump anywhere — js-yaml says "within a quoted scalar" → refused; js-yaml loads it as mappings → accepted', () => {
    let quoteCuts = 0
    let loadedCuts = 0
    for (const seed of [21, 22, 23]) {
      const { docs, r } = makeDocs(seed, 120)
      for (const text of docs) {
        for (let c = 0; c < 12; c++) {
          const cut = text.slice(0, 1 + Math.floor(r() * (text.length - 1)))
          let err = null
          try { yaml.load(cut) } catch (e) { err = String(e.message) }
          if (err === null) {
            if (yamlLoads(cut)) { loadedCuts++; assert.equal(validatePatchYaml(cut), null, `refused a loadable cut: ${JSON.stringify(cut.slice(-80))}`) }
          } else if (/within a (double|single) quoted scalar/.test(err)) {
            quoteCuts++
            assert.notEqual(validatePatchYaml(cut), null, `accepted a cut inside a quoted scalar: ${JSON.stringify(cut.slice(-80))}`)
          }
        }
      }
    }
    assert.ok(quoteCuts >= 200 && loadedCuts >= 200, `the fuzz must exercise both classes (quote cuts ${quoteCuts}, loadable cuts ${loadedCuts})`)
  })
})

describe('Y: the writer that produced the incident — DSH plugin-manager rewrites cordis.patch.yml with the `yaml` package', { skip: !existsSync(join(NM, 'yaml')) }, () => {
  // dsh-plugin-manager/lib/index.js writePluginEnabled: parseDocument(text) … writeFileAtomic(String(document))
  const requireYaml = () => createRequire(NM.endsWith('/') ? NM : NM + '/')('yaml')

  test('F59-yaml-roundtrip: the incident patch is exactly what that writer emits for it (this is where the folding comes from)', () => {
    const Y = requireYaml()
    const text = readFileSync(FIXTURE, 'utf-8')
    assert.equal(String(Y.parseDocument(text)), text)
  })

  test('F59-yaml-fuzz: documents written by that writer, folded at line widths 20 / 40 / 80, are accepted', () => {
    const Y = requireYaml()
    const { r } = makeDocs(31, 1)
    const word = () => pickWord(r)
    const str = () => { const n = 1 + Math.floor(r() * 25); return Array.from({ length: n }, word).join(' ') + (r() < 0.15 ? '\nsecond "x' : '') }
    let folded = 0
    for (let k = 0; k < 300; k++) {
      const doc = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ id: 'e' + k, config: { d: str(), l: [str(), str()], m: { a: str() } } }))
      const text = new Y.Document(doc).toString({ lineWidth: [20, 40, 80][k % 3] })
      if (FOLDED.test(text)) folded++
      assert.equal(validatePatchYaml(text), null, `refused a document the plugin manager's writer made:\n${text}`)
    }
    assert.ok(folded >= 100, `the fuzz must really contain folded quoted scalars (got ${folded})`)
  })
})
const pickWord = (r) => WORDS[Math.floor(r() * WORDS.length)]

const deepseek = () => ({
  entryId: 'llm-deepseek',
  config: { thinking: 'enabled', reasoningEffort: 'high', models: [{ id: 'deepseek-flash', name: 'Flash', contextWindow: 1000000 }] },
  credentialRefs: [{ ref: 'DEEPSEEK_API_KEY', apiKey: KEY }],
})
const xai = (gateway) => ({
  id: 'xai', api: gateway ? 'openai-completions' : 'openai-responses',
  baseURL: gateway ? 'http://hub.example:4387/gw/xai/v1' : 'https://api.x.ai/v1',
  apiKeyEnv: gateway ? 'GATEWAY_TOKEN_dshtest_1' : 'XAI_API_KEY', apiKey: KEY,
  models: [{ id: 'grok-4.3', name: 'Grok 4.3' }],
})
const payload = (revision, gateway) => ({
  schema: 2, revision, cliExpect: [], plugins: [deepseek()],
  providers: [
    xai(gateway),
    { id: 'piion', api: 'openai-completions', baseURL: 'http://hub.example:4387/gw/piion/v1', apiKeyEnv: 'GATEWAY_TOKEN_dshtest_1', apiKey: KEY, models: [{ id: 'q', name: 'q' }] },
    { id: 'ccmax', api: 'anthropic-messages', baseURL: 'https://relay.example', apiKeyEnv: 'CCMAX_API_KEY', apiKey: KEY, models: [{ id: 'claude-sonnet-5-5', name: 's' }] },
  ],
})
function push(home, data) {
  const acks = []
  const result = handleConfigPush({ data, dshHome: home.dshHome, profileDir: home.profileDir, send: (type, d) => acks.push(d), logger() {}, _restartFn() {}, _systemd: true })
  return { result, acks }
}

describe('N: the node patch from the incident (redacted copy)', () => {
  test('F59-fixture: the copy is what it claims to be — js-yaml reads it, it carries the folded description and the backslash-continued id', () => {
    const text = readFileSync(FIXTURE, 'utf-8')
    assert.match(text, /description: "Stronger agentic coding, knowledge, and difficult reasoning;\n\s+suited to complex/)
    assert.match(text, /Hereti\\\n\s+c-MLX-4bit"/)
    assert.doesNotMatch(text, /sk-|\d+\.\d+\.\d+\.\d+/, 'no key, no address')
    if (yaml) assert.equal(yamlLoads(text), true)
    assert.equal(validatePatchYaml(text), null, 'ra reads it as a patch')
  })

  test('F59-push: pushing onto that patch succeeds for the direct payload and then for the gateway payload — xai ends up behind the gateway', () => {
    const home = makeHome()
    try {
      copyFileSync(FIXTURE, home.patch)
      const a = push(home, payload(101, false))
      assert.equal(a.result.ok, true, JSON.stringify(a.acks))
      assert.equal(a.acks.at(-1).ok, true)
      const b = push(home, payload(102, true))
      assert.equal(b.result.ok, true, JSON.stringify(b.acks))
      const patch = readFileSync(home.patch, 'utf-8')
      assert.match(patch, /baseURL: "http:\/\/hub\.example:4387\/gw\/xai\/v1"/, 'xai goes through the gateway')
      assert.match(patch, /apiKeyEnv: "GATEWAY_TOKEN_dshtest_1"/)
      assert.equal(JSON.parse(readFileSync(home.state, 'utf-8')).appliedRevision, 102)
      assert.equal(validatePatchYaml(patch), null)
      if (yaml) assert.equal(yamlLoads(patch), true, 'js-yaml still reads what we wrote')
      if (loadOptionalPatches) assert.equal(loaderLoads(home.patch), true, 'the real loader still reads it')
      assert.ok(!patch.includes(KEY) && !JSON.stringify(a.acks).includes(KEY) && !JSON.stringify(b.acks).includes(KEY), 'the key is nowhere but the credentials file')
    } finally { rmSync(home.base, { recursive: true, force: true }) }
  })
})

describe('T: a quote still open at the end of the file is still a truncated file', () => {
  const cut = (tail) => readFileSync(FIXTURE, 'utf-8') + tail
  for (const [name, tail] of [['dq-mid-fold', '- id: tail\n  name: "cut off\n    in the middle'], ['dq-after-backslash', '- id: tail\n  name: "cut off\\\n'], ['sq-mid-fold', "- id: tail\n  name: 'cut off\n    in the middle"]]) {
    test(`F59-refused ${name}: the push is refused, the patch stays as it is, no key is written`, () => {
      const home = makeHome()
      try {
        const text = cut(tail)
        writeFileSync(home.patch, text)
        const { result, acks } = push(home, payload(201, true))
        assert.equal(result.ok, false)
        assert.equal(acks[0].error, 'patch-existing-invalid')
        assert.equal(readFileSync(home.patch, 'utf-8'), text, 'untouched')
        assert.equal(existsSync(home.cred), false, 'no key written')
        assert.equal(existsSync(home.state), false, 'no revision recorded')
      } finally { rmSync(home.base, { recursive: true, force: true }) }
    })
  }
})
