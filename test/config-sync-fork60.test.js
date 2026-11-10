/**
 * fork.60：fork.59 验收放行后留下的收口（s47）。
 *
 *  C  flow 集合里的折行引号项：引号在续行上闭合之后，`,` / `[` 决定下一行是不是标量起始（lex.carry 必须写回）。
 *     缺陷：不写回 → 「第一项折行并以 `,` 结尾，截断落在第二个折行引号项里」被放行（真 loader：within a double quoted scalar）。
 *  S2 到文件末尾仍未闭合的引号：报的行号是引号打开的那一行（不是 0，也不是最后一行）
 *  S6 引号在续行上闭合之后，这一行的余下部分仍要词法扫描（再开引号、`]` 收 flow、注释）
 *  S11 多行 flow 里 carry 要随每一行更新
 *  Z  小 fuzz：用 `yaml` 包（插件管理器同款）以 80/40/20/0/120/60 列重序列化真实形状的 patch（含 flow 集合里的折行引号项），
 *     判定用 DSH 真实 loadOptionalPatches：loader 收 → 校验必须放行；loader 因「引号标量里到流结束」拒 → 校验必须拒
 *
 * 全部行为断言（真实 validatePatchYaml / 真实 handleConfigPush 的入口）；loader 一致性用 DSH 自带的 js-yaml、yaml 与
 * `loadOptionalPatches`（DSH_NODE_MODULES 缺省 /tmp/dsh-asar/node_modules；没有就只跑硬编码期望那一半）。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { validatePatchYaml } from '../lib/node/config-managed.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const NM = process.env.DSH_NODE_MODULES || '/tmp/dsh-asar/node_modules'
const LOADER = join(NM, '@deepseek-ai/dsh-app-boot/lib/index.js')
const FIXTURE = join(HERE, 'fixtures', 'node-patch-js-yaml-folded.yml')

let yaml = null
let Y = null
let loadOptionalPatches = null
before(async () => {
  const req = createRequire(NM.endsWith('/') ? NM : NM + '/')
  try { yaml = req('js-yaml') } catch { yaml = null }
  try { Y = req('yaml') } catch { Y = null }
  if (!existsSync(LOADER)) return
  try { ({ loadOptionalPatches } = await import(pathToFileURL(LOADER).href)) } catch { loadOptionalPatches = null }
})
const loaderLoads = (file) => { try { return Array.isArray(loadOptionalPatches('fork60', file)) } catch { return false } }
const yamlLoads = (text) => { try { const v = yaml.load(text); return Array.isArray(v) && v.every((e) => e && typeof e === 'object' && !Array.isArray(e)) } catch { return false } }

const E = '- id: a\n  name: b\n'

// [name, text, accepted, line of the quote that is still open at the end (refused rows only)]
const CARRY_CASES = [
  // C: two or more folded quoted items in one flow collection
  ['c-two-folded-complete', E + '  l: ["aa\n    bb",\n    "cc\n    dd"]\n  z: 1\n', true],
  ['c-three-folded-complete', E + '  l: ["aa\n    bb",\n    "cc\n    dd",\n    "ee\n    ff"]\n  z: 1\n', true],
  ['c-sq-two-folded-complete', E + "  l: ['aa\n    bb',\n    'cc\n    dd']\n  z: 1\n", true],
  ['c-cut-inside-second-fold', E + '  l: ["aa\n    bb",\n    "cc\n    dd', false, 5],
  ['c-cut-at-open-of-second', E + '  l: ["aa\n    bb",\n    "cc', false, 5],
  ['c-cut-inside-third-fold', E + '  l: ["aa\n    bb",\n    "cc\n    dd",\n    "ee\n    ff', false, 7],
  ['c-sq-cut-inside-second-fold', E + "  l: ['aa\n    bb',\n    'cc\n    dd", false, 5],
  ['c-cut-after-backslash-in-second', E + '  l: ["aa\n    bb",\n    "cc\\\n', false, 5],
  ['c-map-in-flow', E + '  m: {a: "aa\n    bb",\n    b: "cc\n    dd"}\n  z: 1\n', true],
  ['c-map-in-flow-cut', E + '  m: {a: "aa\n    bb",\n    b: "cc\n    dd', false, 5],
  // S6: what follows the closing quote on the same line is still read
  ['s6-reopen-same-line-cut', E + '  l: ["aa\n    bb", "cc', false, 4],
  ['s6-reopen-same-line-complete', E + '  l: ["aa\n    bb", "cc"]\n  z: 1\n', true],
  ['s6-close-flow-then-cut', E + '  l: ["aa\n    bb"]\n  z: "cut', false, 5],
  ['s6-close-flow-then-complete', E + '  l: ["aa\n    bb"]\n  z: "ok"\n', true],
  ['s6-comment-after-close', E + '  d: "aa\n    bb" # it\'s a "q\n  z: 1\n', true],
  ['s6-colon-after-close-opens-value', E + '  "aa\n    bb": "cut', false, 4],
  // S11: carry follows every line of a multi-line flow collection
  ['s11-plain-then-comma-then-quote', E + '  l: [x\n    y,\n    "cc"]\n  z: 1\n', true],
  ['s11-plain-then-comma-then-quote-cut', E + '  l: [x\n    y,\n    "cc', false, 5],
  ['s11-plain-continuation-with-quote-char', E + '  l: [a,\n    b\n    "x,\n    c]\n  z: 1\n', true],
  ['s11-quote-first-in-flow-cut', E + '  l: [\n    "aa",\n    "cc', false, 5],
]

describe('C / S6 / S11: quoted scalars folded inside flow collections', () => {
  for (const [name, text, ok] of CARRY_CASES) {
    test(`F60-table ${name}: ${ok ? 'accepted' : 'refused'}`, () => {
      assert.equal(validatePatchYaml(text) === null, ok, `validatePatchYaml(${JSON.stringify(text)})`)
    })
  }

  test('F60-loader: every row is what js-yaml and DSH\'s real loader do with the same text (a loader that is not installed here skips this one)', { skip: !existsSync(LOADER) || !existsSync(join(NM, 'js-yaml')) }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-fork60-loader-'))
    try {
      for (const [name, text, ok] of CARRY_CASES) {
        assert.equal(yamlLoads(text), ok, `js-yaml on ${name}`)
        const file = join(dir, `${name}.yml`)
        writeFileSync(file, text)
        assert.equal(loaderLoads(file), ok, `loader on ${name}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('S2: the line reported for a quote that is still open at the end of the file is the line it was opened on', () => {
  const ROWS = [
    ['dq-at-eof', E + '  d: "abc', 3],
    ['dq-after-fold', E + '  d: "abc\n    def', 3],
    ['dq-three-lines-and-newline', E + '  d: "abc\n    def\n    ghi\n', 3],
    ['sq-after-fold', E + "  d: 'abc\n    def", 3],
    ['after-a-complete-fold', E + '  d: "x\n    y"\n- id: c\n  name: "cut', 6],
    ['after-a-block-scalar', E + '  note: |\n    text\n    more\n  d: "cut\n    off', 6],
    ['in-flow-second-item', E + '  l: ["aa\n    bb",\n    "cc\n    dd', 5],
  ]
  for (const [name, text, line] of ROWS) {
    test(`F60-line ${name}: refused as patch-invalid at line ${line}`, () => {
      assert.deepEqual(validatePatchYaml(text), { code: 'patch-invalid', line })
    })
  }
})

// seeded generator: the same documents on every run
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 } }
const WORDS = ['suited', 'to', 'complex', 'tasks', '"quoted"', "it's", 'a:b', 'x # y', '[z]', '{k}', 'back\\slash', '-dash', '100%', '#hash', 'é', '中文', 'plain', 'text', 'long', 'agentic', 'coding,', 'knowledge,']

describe('Z: the real-shaped patch, re-serialised by the plugin manager\'s writer at several widths', { skip: !existsSync(join(NM, 'yaml')) || !existsSync(join(NM, 'js-yaml')) || !existsSync(LOADER) }, () => {
  const WIDTHS = [80, 40, 20, 0, 120, 60]

  test('F60-fuzz-shape: the incident patch at every width — accepted, and the loader reads it too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-fork60-shape-'))
    try {
      const base = Y.parseDocument(readFileSync(FIXTURE, 'utf-8'))
      for (const lineWidth of WIDTHS) {
        const text = base.toString({ lineWidth })
        const file = join(dir, `w${lineWidth}.yml`)
        writeFileSync(file, text)
        assert.equal(loaderLoads(file), true, `the loader reads the patch at width ${lineWidth}`)
        assert.equal(validatePatchYaml(text), null, `refused the patch at width ${lineWidth}`)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('F60-fuzz-flow-cuts: folded quoted items inside flow collections, cut anywhere — the real loader decides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-fork60-fuzz-'))
    try {
      const r = rng(60)
      const str = () => { const n = 2 + Math.floor(r() * 22); const w = []; for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(r() * WORDS.length)]); return w.join(' ') }
      let acceptedFlowDocs = 0
      let quoteCuts = 0
      let flowQuoteCuts = 0
      let loadedCuts = 0
      let n = 0
      for (let k = 0; k < 120; k++) {
        const entries = Array.from({ length: 1 + Math.floor(r() * 2) }, (_, i) => ({ id: `e${k}-${i}`, config: { l: [str(), str(), str()], m: { a: str(), b: str() }, note: str() } }))
        const doc = new Y.Document(entries)
        for (const entry of doc.contents.items) {
          entry.get('config', true).get('l', true).flow = true
          entry.get('config', true).get('m', true).flow = true
        }
        const text = doc.toString({ lineWidth: WIDTHS[k % WIDTHS.length], defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' })
        const whole = join(dir, `d${k}.yml`)
        writeFileSync(whole, text)
        assert.equal(loaderLoads(whole), true, 'the generator only makes loadable documents')
        assert.equal(validatePatchYaml(text), null, `refused a loadable document:\n${text}`)
        if (/^\s+"[^"\n]*\n\s+[^"\n]*",?$/m.test(text)) acceptedFlowDocs++
        for (let c = 0; c < 14; c++) {
          const cut = text.slice(0, 1 + Math.floor(r() * (text.length - 1)))
          const file = join(dir, `c${n++}.yml`)
          writeFileSync(file, cut)
          let msg = ''
          try { yaml.load(cut) } catch (e) { msg = String(e.message) }
          const loads = loaderLoads(file)
          if (loads) {
            if (yamlLoads(cut)) { loadedCuts++; assert.equal(validatePatchYaml(cut), null, `refused a cut the loader reads: ${JSON.stringify(cut.slice(-80))}`) }
          } else if (/within a (double|single) quoted scalar/.test(msg)) {
            quoteCuts++
            if (/\[[^\]]*"[^"]*\n[^\]]*$/.test(cut) || /\{[^}]*"[^"]*\n[^}]*$/.test(cut)) flowQuoteCuts++
            assert.notEqual(validatePatchYaml(cut), null, `accepted a cut the loader refuses (inside a quoted scalar): ${JSON.stringify(cut.slice(-100))}`)
          }
        }
      }
      assert.ok(acceptedFlowDocs >= 40, `the fuzz must really fold quoted items inside flow collections (got ${acceptedFlowDocs})`)
      assert.ok(quoteCuts >= 100 && loadedCuts >= 50, `both classes of cut must be exercised (quote cuts ${quoteCuts}, loadable cuts ${loadedCuts})`)
      assert.ok(flowQuoteCuts >= 30, `... including cuts inside a quote of an open flow collection (got ${flowQuoteCuts})`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
