import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as views from '../lib/hub/views.js'
import { NodeRegistry } from '../lib/hub/node-registry.js'

const online = (transportMode) => ({ online: true, transportMode })
const summarize = (nodes) => views.summarizeTransportModes(nodes)

test('all-direct: eight online direct nodes display 直连', () => {
  const result = summarize(Array.from({ length: 8 }, () => online('direct')))
  assert.equal(result.mode, 'direct')
  assert.equal(result.label, '直连')
})

test('all-relay: online relay nodes display 中继', () => {
  const result = summarize([online('relay'), online('relay')])
  assert.equal(result.mode, 'relay')
  assert.equal(result.label, '中继')
})

test('mixed: count only online nodes of each mode', () => {
  const result = summarize([
    online('direct'), online('relay'), online('direct'),
    { online: false, transportMode: 'relay' },
  ])
  assert.equal(result.mode, 'mixed')
  assert.equal(result.label, '混合（直连 2 台 / 中继 1 台）')
})

test('no online nodes: unknown must never default to relay', () => {
  for (const nodes of [undefined, null, [], [{ online: false, transportMode: 'relay' }]]) {
    const result = summarize(nodes)
    assert.equal(result.mode, 'unknown')
    assert.notEqual(result.mode, 'relay')
    assert.equal(result.label, '未知（暂无在线节点）')
  }
})

test('missing or unrecognized reports stay unknown, including partially known fleets', () => {
  for (const value of [undefined, null, '', 'other']) {
    const result = summarize([online(value)])
    assert.equal(result.mode, 'unknown')
    assert.equal(result.label, '未知（1 台在线节点未上报有效连接方式）')
  }
  const result = summarize([online('direct'), online('relay'), online(null)])
  assert.equal(result.mode, 'unknown')
  assert.equal(result.label, '未知（直连 1 台 / 中继 1 台 / 未知 1 台）')
})

test('summary is pure and ignores nodes without an explicit online flag', () => {
  const nodes = Object.freeze([
    Object.freeze(online('direct')),
    Object.freeze({ transportMode: 'relay' }),
    null,
  ])
  assert.equal(summarize(nodes).label, '直连')
  assert.equal(nodes.length, 3)
})

test('nodeView preserves reported modes and projects missing fields to null', () => {
  assert.equal(views.nodeView({}).transportMode, null)
  assert.equal(views.nodeView({ transportMode: null }).transportMode, null)
  for (const transportMode of ['direct', 'relay']) {
    assert.equal(views.nodeView({ transportMode }).transportMode, transportMode)
  }
})

test('registry list → nodeView cannot manufacture relay for an old hello', () => {
  const registry = new NodeRegistry({ log() {} })
  registry.nodes.set('old-node', { nodeId: 'old-node', online: true, hello: {}, tasks: new Map() })
  const nodes = registry.list().map(views.nodeView)
  assert.equal(nodes[0].transportMode, null)
  assert.equal(summarize(nodes).mode, 'unknown')
})

// client.js 是宿主直接执行的经典脚本：只在测试 VM 中暴露组件，保留生产加载方式。
function loadComponents(state = {}) {
  let plugin
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(value) {
      const initial = typeof value === 'function' ? value() : value
      return [initial && initial.loading === true ? { ...initial, ...state } : initial, () => {}]
    },
    useEffect() {},
    useRef: (current) => ({ current }),
    useMemo: (fn) => fn(),
  }
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) { plugin = mod.factory(() => react) } } },
    console,
  }
  vm.runInNewContext(source.replace(
    'selectRuntimeView: selectRuntimeView,',
    'selectRuntimeView: selectRuntimeView, components: { ConfigPanel, NodeCard, Panel },',
  ), sandbox)
  return plugin.components
}

function elements(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(elements)
  return [tree, ...elements(tree.children)]
}

function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return text(tree.children)
}

test('hub connection state is read-only and comes from reports, not local config', () => {
  const { ConfigPanel } = loadComponents()
  for (const nodes of [[], [online('direct')], [online('relay')], [online('direct'), online('relay')], [online(null)]]) {
    const summary = summarize(nodes)
    const tree = ConfigPanel({
      mode: 'hub', cfg: { role: 'hub', transportMode: 'relay' },
      edit: { transportMode: 'direct' }, transportSummary: summary,
      onEdit() { assert.fail('a read-only summary cannot edit transportMode') },
    })
    assert.ok(text(tree).includes(summary.label))
    assert.equal(elements(tree).filter((e) => (e.props.className || '').includes('dra-mode-card')).length, 0)
    const template = elements(tree).find((e) => e.props.label === '复制配置模板').props.text
    assert.doesNotMatch(template, /transportMode:/)
    assert.doesNotMatch(template, /hubUrl:/)
  }
  assert.ok(text(ConfigPanel({ mode: 'hub' })).includes('未知（暂无在线节点）'))
})

test('hub template preserves an explicitly configured relayUrl without transportMode', () => {
  const { ConfigPanel } = loadComponents()
  for (const transportMode of ['direct', 'relay', undefined]) {
    const tree = ConfigPanel({ mode: 'hub', cfg: { role: 'hub', transportMode, relayUrl: 'ws://relay.example/relay' } })
    const template = elements(tree).find((e) => e.props.label === '复制配置模板').props.text
    assert.match(template, /role: hub/)
    assert.match(template, /relayUrl: ws:\/\/relay\.example\/relay/)
    assert.doesNotMatch(template, /transportMode:/)
  }
})

test('worker retains editable transport cards, edit precedence and both templates', () => {
  const { ConfigPanel } = loadComponents()
  for (const transportMode of ['direct', 'relay']) {
    const edits = []
    const tree = ConfigPanel({
      mode: 'worker', cfg: { role: 'worker', transportMode: 'relay', enrollToken: 'enr_test' },
      edit: { transportMode }, onEdit: (...args) => edits.push(args),
    })
    const cards = elements(tree).filter((e) => (e.props.className || '').includes('dra-mode-card'))
    assert.equal(cards.length, 2)
    assert.equal(text(cards.find((e) => e.props.className.includes(' active'))), transportMode === 'direct' ? '直连（direct）' : '中继（relay）')
    cards[0].props.onClick()
    cards[1].props.onClick()
    assert.deepEqual(edits, [['transportMode', 'relay'], ['transportMode', 'direct']])
    const template = elements(tree).find((e) => e.props.label === '复制配置模板').props.text
    assert.match(template, new RegExp(`transportMode: ${transportMode}`))
    assert.match(template, transportMode === 'direct' ? /hubUrl:/ : /relayUrl:/)
    assert.match(template, /enrollToken: enr_test/)
  }
})

test('node badges distinguish direct, relay, unknown and offline', () => {
  const { NodeCard } = loadComponents()
  for (const [transportMode, label] of [['direct', '直连'], ['relay', '中继'], [null, '未知'], [undefined, '未知'], ['other', '未知']]) {
    assert.ok(text(NodeCard({ node: { nodeId: 'node001', online: true, transportMode } })).includes(`在线（${label}）`))
  }
  const offline = text(NodeCard({ node: { nodeId: 'node001', online: false, transportMode: 'relay' } }))
  assert.ok(offline.includes('离线'))
  assert.ok(!offline.includes('在线（中继）'))
})

test('hub runtime passes the overview summary into ConfigPanel', () => {
  const summary = summarize(Array.from({ length: 8 }, () => online('direct')))
  const { Panel, ConfigPanel } = loadComponents({ loading: false, role: 'hub', mode: 'hub', transportSummary: summary })
  const panel = elements(Panel()).find((e) => e.type === ConfigPanel)
  assert.ok(panel, 'hub runtime must render its configuration panel')
  assert.equal(panel.props.transportSummary, summary)
  assert.ok(text(ConfigPanel(panel.props)).includes('直连'))
})

test('registry → overview → hub panel displays actual reports through node state changes', async () => {
  const { registerUiRoutes } = await import('../lib/hub/ui-routes.js')
  const registry = new NodeRegistry({ log() {} })
  const routes = new Map()
  const disposers = registerUiRoutes({
    ctx: { webServer: { register(spec) { routes.set(spec.path, spec.handler); return () => {} } } },
    registry, pulls: { activeCount: 0 }, log() {},
    config: { role: 'hub', transportMode: 'relay' },
  })
  try {
    for (const [reports, label] of [
      [Array(8).fill('direct'), '直连'],
      [Array(8).fill('relay'), '中继'],
      [['direct', 'relay', 'direct'], '混合（直连 2 台 / 中继 1 台）'],
      [[undefined], '未知（1 台在线节点未上报有效连接方式）'],
      [[], '未知（暂无在线节点）'],
    ]) {
      registry.nodes.clear()
      reports.forEach((transportMode, i) => registry.nodes.set(`node00${i + 1}`, {
        nodeId: `node00${i + 1}`, online: true, hello: { transportMode }, tasks: new Map(),
      }))
      // 离线历史不能影响当前汇总。
      registry.nodes.set('offline', { nodeId: 'offline', online: false, hello: { transportMode: 'relay' }, tasks: new Map() })
      let response
      let status
      await routes.get('/api/remote-agent/ui/overview')({
        method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' },
      }, {
        writeHead(code) { status = code },
        end(body) { response = JSON.parse(body) },
      })
      assert.equal(status, 200)
      assert.equal(response.transportSummary.label, label)
      const { Panel, ConfigPanel } = loadComponents({
        loading: false, role: 'hub', mode: 'hub', nodes: response.nodes,
        transportSummary: response.transportSummary,
      })
      const panel = elements(Panel()).find((e) => e.type === ConfigPanel)
      assert.ok(text(ConfigPanel(panel.props)).includes(label))
      if (reports.length === 1 && reports[0] === undefined) {
        assert.equal(response.nodes[0].transportMode, null)
      }
    }
  } finally {
    for (const dispose of disposers) dispose()
  }
})
