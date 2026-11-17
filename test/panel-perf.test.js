import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const cssStart = code.indexOf('const CSS = [')
const cssEnd = code.indexOf('\n    ]', cssStart)
assert.ok(cssStart >= 0 && cssEnd > cssStart, 'CSS array must exist')
const css = code.slice(cssStart, cssEnd)

function loadPanel(doc) {
  let plugin
  let Panel
  const effects = []
  const timers = []
  const cleared = []
  const requests = []
  const sandbox = {
    window: { __ModuleLoader__: { load(mod) {
      plugin = mod.factory(id => {
        assert.equal(id, 'react')
        return {
          createElement(type, props, ...children) { return { type, props: props || {}, children } },
          useState(value) {
            if (value && value.loading === true && value.mode === '') {
              value = { ...value, loading: false, mode: 'hub', role: 'hub' }
            }
            return [typeof value === 'function' ? value() : value, () => {}]
          },
          useEffect(fn) { effects.push(fn) },
          useRef(value) { return { current: value } },
          useMemo(fn) { return fn() },
        }
      })
    } } },
    console,
    fetch(url) {
      requests.push(url)
      return Promise.resolve({ ok: true, json: async () => ({ configured: false }) })
    },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length },
    clearInterval(id) { cleared.push(id) },
  }
  if (doc !== undefined) sandbox.document = doc
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  plugin.apply({ slots: {
    inject(_name, register) { register() },
    register(slot, component) { if (slot.name === 'main') Panel = component },
  } })
  return { plugin, Panel, effects, timers, cleared, requests }
}

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...elements(tree.children)]
}

function cssRule(selector) {
  const start = css.indexOf(selector + '{')
  assert.notEqual(start, -1, 'missing CSS rule ' + selector)
  return css.slice(start, css.indexOf('}', start) + 1)
}

test('P1 shouldPoll: only hidden === true suppresses polling', () => {
  const { shouldPoll } = loadPanel().plugin
  assert.equal(shouldPoll({ hidden: true }), false)
  assert.equal(shouldPoll({ hidden: false }), true)
  assert.equal(shouldPoll(undefined), true)
  assert.equal(shouldPoll(null), true)
  assert.equal(shouldPoll({ hidden: 1 }), true)
})

test('P2 topoActivity: running tasks enable at most two pulses', () => {
  const { topoActivity } = loadPanel().plugin
  for (const tasks of [[], [{ status: 'done' }], null, [null, { status: 'queued' }]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(topoActivity(tasks))), { running: false, pulseCount: 0 })
  }
  for (const tasks of [[{ status: 'running' }], [null, { status: 'done' }, { status: 'running' }]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(topoActivity(tasks))), { running: true, pulseCount: 2 })
  }
})

test('P3 CSS: brand dot keeps static glow without animation', () => {
  assert.doesNotMatch(cssRule('.dra-brand-dot'), /animation\s*:/)
  assert.match(cssRule('.dra-brand-dot'), /box-shadow\s*:/)
})

test('P3 CSS: active links and hub have no drop-shadow filters', () => {
  assert.doesNotMatch(cssRule('.dra-topo-line.active'), /filter\s*:\s*drop-shadow/)
  assert.doesNotMatch(cssRule('.dra-topo-line.active'), /animation\s*:/)
  assert.match(cssRule('.dra-topo-line.flow'), /animation:dra-flow \.8s linear infinite/)
  assert.doesNotMatch(cssRule('.dra-topo-node.hub'), /filter\s*:\s*drop-shadow/)
  assert.match(cssRule('.dra-topo-node.hub'), /stroke-width:1\.6/)
})

test('P3 polling source: exported 8000ms interval guards load with shouldPoll', () => {
  assert.equal(loadPanel().plugin.POLL_MS, 8000)
  assert.match(code, /const POLL_MS = 8000\b/)
  assert.match(code, /setInterval\(function\s*\(\)\s*\{\s*if\s*\(!shouldPoll\(typeof document !== 'undefined' \? document : undefined\)\) return\s+load\(\)\s*\}, POLL_MS\)/)
})

test('polling runtime: hidden ticks make no requests; visible ticks resume and cleanup clears timer', async () => {
  const doc = { hidden: false }
  const panel = loadPanel(doc)
  panel.Panel()
  const cleanup = panel.effects[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.requests.length, 1, 'initial load stays immediate')
  assert.equal(panel.timers.length, 1)
  assert.equal(panel.timers[0].ms, 8000)
  doc.hidden = true
  panel.timers[0].fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.requests.length, 1, 'hidden tick must not request')
  doc.hidden = false
  panel.timers[0].fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.requests.length, 2, 'visible tick must resume loading')
  doc.hidden = true
  panel.timers[0].fn()
  assert.equal(panel.requests.length, 2)
  cleanup()
  assert.deepEqual(panel.cleared, [1])
})

test('polling runtime: absent document still allows polling', async () => {
  const panel = loadPanel()
  panel.Panel()
  const cleanup = panel.effects[0]()
  await new Promise(resolve => setImmediate(resolve))
  panel.timers[0].fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(panel.requests.length, 2)
  cleanup()
})

test('topology runtime: idle has no flow, pulses or SVG filters; running pulses use first two sorted online nodes', () => {
  const panel = loadPanel()
  const topology = elements(panel.Panel()).find(el => el.type.name === 'TopologyMap')
  assert.ok(topology, 'hub panel must render TopologyMap')
  const nodes = [
    { nodeId: 'd', online: true, transport: 'relay' },
    { nodeId: 'a', online: false },
    { nodeId: 'c', online: true, transport: 'direct' },
    { nodeId: 'b', online: true },
  ]
  const render = (tasks, input = nodes) => elements(topology.type({ nodes: input, tasks }))
  const pulses = tree => tree.filter(el => el.props.className === 'dra-topo-pulse')
  for (const tasks of [[], null, [{ status: 'done', nodeId: 'd' }]]) {
    const idle = render(tasks)
    assert.equal(pulses(idle).length, 0)
    assert.ok(idle.every(el => !/\bflow\b/.test(el.props.className || '')))
    assert.ok(idle.every(el => el.type !== 'filter' && !el.props.filter))
  }
  const running = render([{ status: 'running', nodeId: 'd' }])
  const flowing = running.filter(el => /\bflow\b/.test(el.props.className || ''))
  assert.equal(flowing.length, 1)
  assert.equal(flowing[0].props.className, 'dra-topo-line active flow')
  assert.equal(flowing[0].props.key, 'l-d')
  assert.deepEqual({ ...flowing[0].props.style }, { stroke: 'var(--dra-warn)', strokeDasharray: '6 4' })
  const pulseGroups = running.filter(el => el.type === 'g' && pulses(elements(el)).length)
  assert.deepEqual(pulseGroups.map(el => el.props.key), ['n-b', 'n-c'])
  assert.equal(pulses(render([{ status: 'running' }], [{ nodeId: 'x', online: true }])).length, 1)
  assert.equal(pulses(render([{ status: 'running' }], [{ nodeId: 'x', online: false }])).length, 0)
})
