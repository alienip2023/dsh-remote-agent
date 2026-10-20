/**
 * 托管块「字段保留」与「口令轮换」的行为级回归（v0.9.3 审查 H2 / H3）。
 *
 * 为什么单独一个文件：`test/setup-flow.test.js` 是**源码文本断言**（查
 * `assert.match(src, /.../)`），它能证明"代码里有那行"，但证明不了"行为对"。
 * 而 H2 这个 bug 的性质恰恰是——代码看起来在写配置，实际把用户的凭证
 * 整块删掉了。所以这里直接调函数、看输出。
 *
 * 被钉住的契约：
 *   · 表单只管 6 个键；其余字段（nodeToken / uiPullRoot / listenHost /
 *     listenPort / relay …）在重写托管块时必须原样搬回来
 *   · 嵌套结构（列表项、子对象）跟着它的父键一起搬，不能被拆散
 *   · 换口令只改 `nodeToken` 那一行，别的字节不动
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FORM_OWNED_KEYS,
  MANAGED_BEGIN,
  MANAGED_END,
  extractPreservedConfig,
  readManagedBlockBody,
  upsertTokenInBlock,
} from '../lib/setup.js'

/** 一个"用户已经配好了"的托管块（含表单管不到的那些字段）。 */
const BLOCK = [
  '- id: remote-agent',
  '  name: dsh-remote-agent',
  "  inject: ['webServer', 'tools', 'systemPrompt']",
  '  config:',
  '    role: hub',
  "    nodeToken: 'nt_old_token_value'",
  '    nodeId: my-host',
  "    uiPullRoot: 'D:\\remote-works'",
  "    listenHost: '100.86.48.54'",
  '    listenPort: 19387',
  '    relay:',
  "      url: 'wss://relay.example.com/relay'",
  "      token: 'relay_enroll_xxx'",
  '    roots:',
  '      - D:\\work',
  '      - D:\\proj',
  '',
].join('\n')

/** 面板表单这次提交的"新值"块（只有它管辖的键）。 */
const FORM_BLOCK = [
  '- id: remote-agent',
  '  name: dsh-remote-agent',
  "  inject: ['webServer', 'tools', 'systemPrompt']",
  '  config:',
  '    role: hub',
  '    nodeId: my-host',
  '    roots:',
  '      - D:\\work2',
  '',
].join('\n')

test('H2：表单重写托管块后，nodeToken / uiPullRoot / listen* 必须还在', () => {
  const preserved = extractPreservedConfig(BLOCK, FORM_OWNED_KEYS)
  const merged = `${FORM_BLOCK.replace(/\s+$/, '')}\n${preserved.join('\n')}\n`

  assert.match(merged, /nodeToken: 'nt_old_token_value'/, '口令不能丢')
  assert.match(merged, /uiPullRoot: 'D:\\remote-works'/, 'uiPullRoot 不能丢')
  assert.match(merged, /listenHost: '100\.86\.48\.54'/, 'listenHost 不能丢')
  assert.match(merged, /listenPort: 19387/, 'listenPort 不能丢')
  // 表单管辖的键必须被**新值**覆盖，不是被保留
  assert.match(merged, /- D:\\work2/, 'roots 应取表单的新值')
  assert.doesNotMatch(merged, /- D:\\proj/, '旧的 roots 列表项必须被替换掉')
})

test('H2：嵌套结构跟着父键一起保留（relay 的 url/token 不能被拆散）', () => {
  const preserved = extractPreservedConfig(BLOCK, FORM_OWNED_KEYS)
  const text = preserved.join('\n')
  assert.match(text, / {4}relay:/, 'relay 键本身要保留')
  assert.match(text, / {6}url: 'wss:\/\/relay\.example\.com\/relay'/, 'relay.url 要保留')
  assert.match(text, / {6}token: 'relay_enroll_xxx'/, 'relay.token 要保留')
})

test('H2：没有任何可保留字段时返回空数组（首次写入路径不受影响）', () => {
  const onlyFormKeys = [
    '- id: remote-agent',
    '  config:',
    '    role: hub',
    '    roots:',
    '      - D:\\work',
    '',
  ].join('\n')
  assert.deepEqual(extractPreservedConfig(onlyFormKeys, FORM_OWNED_KEYS), [])
  // 没有 config 段 / 空文本 → 也不能抛
  assert.deepEqual(extractPreservedConfig('', FORM_OWNED_KEYS), [])
  assert.deepEqual(extractPreservedConfig(undefined, FORM_OWNED_KEYS), [])
})

test('H3：换口令只改 nodeToken 那一行，别的字节不动', () => {
  const out = upsertTokenInBlock(BLOCK, 'nt_new_token_value')
  assert.match(out, /nodeToken: 'nt_new_token_value'/, '应写入新口令')
  assert.doesNotMatch(out, /nt_old_token_value/, '旧口令必须被替换（不能两行并存）')

  // 逐行比对：除 nodeToken 那一行外，其余行完全一致
  const before = BLOCK.split('\n')
  const after = out.split('\n')
  assert.equal(after.length, before.length, '不得增删行（否则是重写而非就地改）')
  let changed = 0
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) {
      changed += 1
      assert.match(after[i], /^\s*nodeToken: /, `第 ${i + 1} 行不该被改动：${after[i]}`)
    }
  }
  assert.equal(changed, 1, '只应有一行发生变化（nodeToken）')
})

test('H3：块里还没有 nodeToken 时，插入而不是覆盖其它字段', () => {
  const noToken = [
    '- id: remote-agent',
    '  config:',
    '    role: hub',
    '    listenPort: 19387',
    '',
  ].join('\n')
  const out = upsertTokenInBlock(noToken, 'nt_added')
  assert.match(out, /nodeToken: 'nt_added'/, '应追加口令')
  assert.match(out, /listenPort: 19387/, '已有字段不得丢')
  assert.match(out, /role: hub/, '已有字段不得丢')
})

test('H2/H3：托管块标记能被正确定位（readManagedBlockBody 只取正文）', () => {
  const file = [
    '# 用户自己的其它配置',
    '- id: some-other-plugin',
    '  config:',
    '    x: 1',
    '',
    MANAGED_BEGIN,
    BLOCK.trimEnd(),
    MANAGED_END,
    '',
    '# 尾部其它配置',
  ].join('\n')

  const body = readManagedBlockBody(file)
  assert.ok(body.includes('nodeToken'), '正文应含 nodeToken')
  assert.equal(body.includes(MANAGED_BEGIN), false, '不得包含起始标记行')
  assert.equal(body.includes(MANAGED_END), false, '不得包含结束标记行')
  assert.equal(body.includes('some-other-plugin'), false, '不得越界到用户自己的配置')

  // 没有托管块 → 空串（首次写入路径）
  assert.equal(readManagedBlockBody('# 空文件\n'), '')
})
