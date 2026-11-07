/**
 * 运行界面按已保存的 role 选视图。断言打在 selectRuntimeView 的返回值上，
 * 不扫源码。删掉三个 role 分支后，这两条必须变红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../lib/client.js'), 'utf8')

function loadView() {
  let plugin = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) {
          plugin = mod.factory(function (id) {
            if (id !== 'react') throw new Error('unexpected require ' + id)
            return {
              createElement() { return null },
              useState(v) { return [v, function () {}] },
              useEffect() {},
              useRef(v) { return { current: v } },
              useMemo(fn) { return fn() },
            }
          })
        },
      },
    },
    console,
  }
  vm.runInNewContext(src, sandbox, { filename: 'lib/client.js' })
  if (!plugin || typeof plugin.selectRuntimeView !== 'function') {
    throw new Error('panel factory did not return selectRuntimeView')
  }
  return plugin.selectRuntimeView
}

test('hub 且 overview 失败时，视图不是 worker', () => {
  const select = loadView()
  const result = select('hub', { overviewOk: false, overviewError: 'overview down' })
  assert.notEqual(result.view, 'worker')
  assert.equal(result.showWorker, false)
})

test('worker 时结果里没有派发', () => {
  const select = loadView()
  const result = select('worker', { overviewOk: true })
  assert.equal(result.showDispatch, false)
  assert.equal(result.view, 'worker')
})
