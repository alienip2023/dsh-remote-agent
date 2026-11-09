// fork.58: the node's own policy service (what dsh-remote-agent hands to ds-bot in the same process)
// carries the node's id besides its roots, read-only. ds-bot's host-context writes
// "Node: <nodeId> (hostname …)" from it. Old callers read `policy.roots` only and must not notice.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyWorker, sanitizeNodeId } from '../lib/node/index.js'

function start(config, { existing } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-node-policy-id-'))
  const provided = {}
  const fakeCtx = {
    effect: (fn) => { fn() },
    provide: (name, value) => { provided[name] = value },
    get: (name) => (name === 'remote-agent:node-policy' ? existing : undefined),
  }
  const dispose = applyWorker(fakeCtx, { hubUrl: 'ws://127.0.0.1:1', token: 'tk', stateDir: dir, ...config })
  const stop = () => { if (typeof dispose === 'function') dispose(); else dispose?.dispose?.() }
  return { dir, provided, policy: provided['remote-agent:node-policy'], stop }
}

test('P58-nodeid: the policy carries the node id from the node config', () => {
  const w = start({ nodeId: 'dshtest-1', roots: [os.tmpdir()] })
  try {
    assert.equal(w.policy.nodeId, 'dshtest-1')
    assert.deepEqual(w.policy.roots, [os.tmpdir()])
  } finally { w.stop() }
})

test('P58-nodeid-sanitized: it is the id the node uses on the wire (sanitized), not the raw config text', () => {
  const w = start({ nodeId: 'My Node 1', roots: [os.tmpdir()] })
  try {
    assert.equal(w.policy.nodeId, sanitizeNodeId('My Node 1'))
    assert.notEqual(w.policy.nodeId, 'My Node 1')
  } finally { w.stop() }
})

test('P58-nodeid-default: with no nodeId configured it is the (sanitized) hostname, the id hello would carry', () => {
  const w = start({ roots: [os.tmpdir()] })
  try {
    assert.equal(w.policy.nodeId, sanitizeNodeId(os.hostname()))
    assert.match(w.policy.nodeId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  } finally { w.stop() }
})

test('P58-old-caller: a reader that only knows { roots } (ds-bot checkWorkDirRoots before this) still works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-node-policy-old-'))
  const w = start({ nodeId: 'n1', roots: [dir] })
  try {
    const policy = w.policy
    const roots = Array.isArray(policy.roots) ? policy.roots : []
    assert.equal(roots.length, 1)
    assert.equal(roots.some(root => path.resolve(path.join(dir, 'sub')).startsWith(path.resolve(root))), true)
    assert.deepEqual(roots.map(root => root), [dir])
    assert.deepEqual([...roots], [dir])
    assert.deepEqual(JSON.parse(JSON.stringify(policy)), { roots: [dir], nodeId: 'n1' })
  } finally { w.stop() }
})

test('P58-readonly: neither field can be changed by a reader, and the node\'s own boundary is a separate array', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-node-policy-ro-'))
  const w = start({ nodeId: 'n1', roots: [dir] })
  try {
    assert.throws(() => { w.policy.nodeId = 'other' }, TypeError)
    assert.throws(() => { w.policy.roots = [] }, TypeError)
    assert.throws(() => { w.policy.roots.push('/') }, TypeError)
    assert.throws(() => { w.policy.roots[0] = '/' }, TypeError)
    assert.equal(w.policy.nodeId, 'n1')
    assert.deepEqual(w.policy.roots, [dir])
  } finally { w.stop() }
})

test('P58-empty-roots: a node without roots (none configured and no usable home for the default) still registers the policy — only a warning', (t) => {
  // resolveRoots falls back to ~/dsh-remote-work; it is empty only when that fallback itself cannot be computed.
  t.mock.method(os, 'homedir', () => { throw new Error('no home') })
  const w = start({ nodeId: 'n1' })
  try {
    assert.ok(w.policy, 'registered although the roots are empty')
    assert.deepEqual(w.policy.roots, [])
    assert.equal(w.policy.nodeId, 'n1')
  } finally { t.mock.restoreAll(); w.stop() }
})

test('P58-existing: a policy someone else already registered is left alone', () => {
  const existing = { roots: ['/x'], nodeId: 'theirs' }
  const w = start({ nodeId: 'n1', roots: [os.tmpdir()] }, { existing })
  try {
    assert.equal(w.policy, undefined, 'not provided again')
  } finally { w.stop() }
})
