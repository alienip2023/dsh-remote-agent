/**
 * 产物断点续传（P2）行为测试。
 *
 *   hub 侧（PullManager）：
 *     ① 传输中断类失败（超时 / 掉线 / 调用方 abort）→ 半成品晋升为稳定命名的
 *        resume partial + meta 旁车（全文期望 sha / 前缀 sha / 字节数）；
 *     ② 重试 pull → 下发帧带 startOffset，session 从前缀起步，收尾落盘全文、meta 清除；
 *     ③ 内容级失败（乱序）→ 照旧全删，不保留半成品；
 *     ④ meta/partial 各种不自洽（前缀哈希被篡改、字节数矛盾、清单 sha 换了、TTL=0）
 *        → 弃用从头，绝不带着可疑前缀续传。
 *
 *   副机侧（ArtifactService）：
 *     ⑤ startOffset 中段续流 → chunk offset 从中段起、done 帧全文累计语义；
 *     ⑥ startOffset === size → 零 chunk 直接收尾；越界 / 畸形值 → 明确报错。
 *
 * 协议帧结构零改动（chunk/done 帧与既有字段全同），向后兼容由⑤的 offset/total 断言锁住。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PullManager, resumeKeyOf } from '../lib/hub/pull-manager.js'
import { ArtifactService } from '../lib/node/artifact-service.js'
import { HUB_TO_NODE } from '../lib/protocol.js'

const sha = (s) => createHash('sha256').update(s).digest('hex')

const FULL = 'helloworld' // 10 字节测试产物全文
const FULL_SHA = sha(FULL)

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resume-')) // 交给进程退出清理即可

/** PullManager 依赖桩：一个永远在线的节点 + 记录所有下发的 pull 帧。 */
function stubRegistry() {
  const rec = { nodeId: 'n1', online: true, pendingPulls: new Map() }
  const sent = []
  return {
    rec,
    sent,
    getNode: (id) => (id === 'n1' ? rec : undefined),
    send: (nodeId, type, payload) => {
      sent.push({ nodeId, type, payload })
      return true
    },
  }
}

const chunkHeader = (pullId, offset, extra = {}) => ({ t: 'artifact/chunk', pullId, offset, ...extra })

/** 轮询直到 probeResume（异步）走完、pull 帧真正下发。 */
async function until(fn, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 5))
  }
  return fn()
}

/** 找 dest 里的 resume partial / meta 文件名（按稳定前缀，不硬编码 key）。 */
function resumeFiles(dest) {
  const part = fs.readdirSync(dest).find((f) => f.startsWith('.dsh-remote-agent-resume-') && f.endsWith('.part'))
  const meta = part ? part.replace(/\.part$/, '.json') : undefined
  return { part: part ? path.join(dest, part) : undefined, meta: meta ? path.join(dest, meta) : undefined }
}

/* ══════════════════ hub：传输中断 → 晋升保留 ══════════════════ */

test('pull-manager：空闲超时失败后半成品晋升为 resume partial + meta（内容/前缀哈希/字节数正确）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 1_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId, 0, { sha256: FULL_SHA, total: 10 }), Buffer.from('hello'))
  t.mock.timers.tick(1_000)
  await assert.rejects(promise, /no chunk for 1000ms/)

  const { part, meta } = resumeFiles(dest)
  assert.ok(part, '必须保留 resume partial')
  assert.equal(fs.readFileSync(part, 'utf8'), 'hello')
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
  assert.equal(m.v, 1)
  assert.equal(m.relPath, 'a.txt')
  assert.equal(m.bytes, 5)
  assert.equal(m.prefixSha256, sha('hello'), '前缀哈希必须是已收字节的 sha256')
  assert.equal(m.sha256, FULL_SHA, '全文期望 sha 来自 chunk 帧头')
  assert.ok(Number.isFinite(m.updatedAt))
})

test('pull-manager：节点掉线失败后半成品保留（传输中断类，等节点回来续传）', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(promise, /node offline/)

  const { part } = resumeFiles(dest)
  assert.ok(part, '掉线是传输中断类，必须保留半成品')
})

test('pull-manager：调用方 abort 失败后半成品保留', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()
  const ac = new AbortController()

  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest, signal: ac.signal })
  const pullId = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  ac.abort()
  await assert.rejects(promise, /aborted by caller/)

  assert.ok(resumeFiles(dest).part, 'abort 是传输中断类，必须保留半成品')
})

test('pull-manager：内容级失败（乱序分块）不保留半成品（与既有语义一致）', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const promise = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId, 5), Buffer.from('data')) // 乱序 → hash-mismatch 类失败
  await assert.rejects(promise, /out of order/)

  const { part, meta } = resumeFiles(dest)
  assert.equal(part, undefined, '内容级失败必须全删')
  assert.equal(meta, undefined)
})

/* ══════════════════ hub：重试续传贯通 ══════════════════ */

test('pull-manager：重试 pull 从半成品续传 —— startOffset 下发、前缀起步、收尾落盘全文并清 meta', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  // 第一次 pull：收到 5 字节后节点掉线 → 半成品保留
  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId1 = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId1, 0, { sha256: FULL_SHA, total: 10 }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(p1, /node offline/)

  // 第二次 pull：必须续传
  const p2 = pulls.pull({
    nodeId: 'n1',
    taskId: 't1',
    relPath: 'a.txt',
    dest,
    manifest: { final: [{ path: 'a.txt', sha256: FULL_SHA, bytes: 10 }] },
  })
  const sent = await until(() => registry.sent.find((s) => s.type === HUB_TO_NODE.ARTIFACT_PULL))
  assert.ok(sent, 'pull 帧必须已下发')
  assert.equal(sent.payload.startOffset, 5, '下发帧必须带上已收前缀字节数')
  const pullId2 = sent.payload.pullId

  const s2 = pulls.sessions.get(pullId2)
  assert.ok(s2.isResume, 'session 必须切到续传形态')
  assert.equal(s2.received, 5, '已收计数从前缀起步')

  // 副机从中段续流：offset 5 起，发剩余 5 字节，收尾
  pulls.ingestBinary(chunkHeader(pullId2, 5, { sha256: FULL_SHA, total: 10 }), Buffer.from('world'))
  pulls.ingestDone({ t: 'artifact/done', pullId: pullId2, bytes: 10, sha256: FULL_SHA, expected: FULL_SHA })
  const out = await p2
  assert.equal(out.bytes, 10)
  assert.equal(fs.readFileSync(out.dest, 'utf8'), FULL, '落盘必须是完整全文（前缀 + 续传后缀）')

  const { part, meta } = resumeFiles(dest)
  assert.equal(part, undefined, '成功后 partial 必须消失（rename 成品）')
  assert.equal(meta, undefined, '成功后 meta 旁车必须清掉')
})

test('pull-manager：同一 (dest, relPath) 并发 pull 被拒绝（防两个 session 写同一份 partial）', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  await assert.rejects(
    pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest }),
    /in progress/,
  )
  pulls.cancel([...pulls.sessions.keys()][0]) // 收尾第一条，别让它挂到空闲超时
  await assert.rejects(p1, /cancelled/)
})

/* ══════════════════ hub：半成品不可信时弃用从头 ══════════════════ */

test('pull-manager：partial 前缀哈希被篡改 → 弃用从头（startOffset 0，旧文件清掉）', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId1 = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId1, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(p1)

  // 篡改 partial 内容（等长改写，字节数仍对得上 meta）
  const { part } = resumeFiles(dest)
  fs.writeFileSync(part, 'HELLO')

  const p2 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const sent = await until(() => registry.sent.find((s) => s.type === HUB_TO_NODE.ARTIFACT_PULL))
  assert.equal(sent.payload.startOffset, 0, '前缀校验不过必须从头')
  assert.equal(pulls.sessions.get(sent.payload.pullId).received, 0)
  pulls.cancel(sent.payload.pullId) // 收尾探测完的这条
  await assert.rejects(p2, /cancelled/)

  const { part: part2 } = resumeFiles(dest)
  assert.equal(part2, undefined, '被弃用的半成品必须清掉')
})

test('pull-manager：磁盘上 partial 比 meta.bytes 短（部分写）→ 弃用从头', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId1 = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId1, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(p1)

  fs.truncateSync(resumeFiles(dest).part, 3)

  const p2 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const sent = await until(() => registry.sent.find((s) => s.type === HUB_TO_NODE.ARTIFACT_PULL))
  assert.equal(sent.payload.startOffset, 0)
  pulls.cancel(sent.payload.pullId)
  await assert.rejects(p2, /cancelled/)
})

test('pull-manager：meta.sha256 与清单期望不一致（副机文件重新生成过）→ 弃用从头', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId1 = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId1, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(p1)

  // 清单里的 sha 换了：说明副机上的文件内容已不是半成品所属的那份
  const p2 = pulls.pull({
    nodeId: 'n1',
    taskId: 't1',
    relPath: 'a.txt',
    dest,
    manifest: { final: [{ path: 'a.txt', sha256: sha('different content'), bytes: 16 }] },
  })
  const sent = await until(() => registry.sent.find((s) => s.type === HUB_TO_NODE.ARTIFACT_PULL))
  assert.equal(sent.payload.startOffset, 0)
  pulls.cancel(sent.payload.pullId)
  await assert.rejects(p2, /cancelled/)
})

test('pull-manager：partialTtlMs = 0 整体禁用续传（不探测、不动存量半成品）', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({
    registry,
    log: () => {},
    limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024, partialTtlMs: 0 },
  })
  const dest = tmpdir()

  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId1 = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId1, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(p1)
  assert.ok(resumeFiles(dest).part, '禁用续传不影响已晋升文件的存在')

  const p2 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const sent = await until(() => registry.sent.find((s) => s.type === HUB_TO_NODE.ARTIFACT_PULL))
  assert.equal(sent.payload.startOffset, 0, 'ttl=0 时不探测、从头传')
  pulls.cancel(sent.payload.pullId)
  await assert.rejects(p2, /cancelled/)
})

test('pull-manager：崩溃残留（磁盘 partial 比 meta.bytes 长）→ 信 meta 前缀并截断续传', async () => {
  const registry = stubRegistry()
  const pulls = new PullManager({ registry, log: () => {}, limits: { pullTimeoutMs: 60_000, maxPullBytes: 1024 } })
  const dest = tmpdir()

  const p1 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const pullId1 = [...pulls.sessions.keys()][0]
  pulls.ingestBinary(chunkHeader(pullId1, 0, { sha256: FULL_SHA }), Buffer.from('hello'))
  pulls.onNodeOffline('n1')
  await assert.rejects(p1)

  // 模拟崩溃残留：meta 说 5 字节，磁盘上有 7 字节（最后一块落盘但 meta 没更新）
  fs.writeFileSync(resumeFiles(dest).part, 'helloworld'.slice(0, 7))

  const p2 = pulls.pull({ nodeId: 'n1', taskId: 't1', relPath: 'a.txt', dest })
  const sent = await until(() => registry.sent.find((s) => s.type === HUB_TO_NODE.ARTIFACT_PULL))
  assert.equal(sent.payload.startOffset, 5, '只信 meta.bytes 以内可验证的前缀')

  const s2 = pulls.sessions.get(sent.payload.pullId)
  assert.equal(s2.received, 5)
  pulls.ingestBinary(chunkHeader(sent.payload.pullId, 5, { sha256: FULL_SHA }), Buffer.from('world'))
  pulls.ingestDone({ t: 'artifact/done', pullId: sent.payload.pullId, bytes: 10, sha256: FULL_SHA, expected: FULL_SHA })
  const out = await p2
  assert.equal(fs.readFileSync(out.dest, 'utf8'), FULL, '残留尾部必须被截掉再续')
})

/* ══════════════════ 副机：startOffset 中段续流 ══════════════════ */

function nodeManifest(relPath = 'a.txt', bytes = FULL.length) {
  return {
    workspace: '/ws',
    items: [{ path: relPath, role: 'final', kind: 'file', bytes, mtimeMs: 0, sha256: FULL_SHA }],
  }
}

async function nodePull(t, fileBody, startOffset, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-resume-node-'))
  const ws = path.join(dir, 'ws')
  fs.mkdirSync(ws)
  fs.writeFileSync(path.join(ws, 'a.txt'), fileBody)
  const artifacts = new ArtifactService({ nodeId: 'n1', caseInsensitive: true })

  const frames = []
  const result = await artifacts.pull({
    manifest: opts.manifest ?? nodeManifest(),
    pullId: 'p-test',
    relPath: 'a.txt',
    workspace: ws,
    startOffset,
    emit: async (header, payload) => {
      frames.push({ header, payload })
      return true
    },
    ...opts.extra,
  })
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return { frames, result }
}

test('artifact-service：startOffset 中段续流 —— chunk 从中段起、done 帧全文累计语义', async (t) => {
  const { frames, result } = await nodePull(t, FULL, 4)

  assert.equal(result.ok, true)
  assert.equal(result.sent, 6, '只发后缀')
  assert.equal(result.resumed, true)
  assert.equal(result.sha256, FULL_SHA, 'done 语义是全文 sha')

  const chunks = frames.filter((f) => f.header.t === 'artifact/chunk')
  assert.equal(chunks.length, 1, '10 字节文件、ARTIFACT_CHUNK_BYTES 默认大块 → 后缀单块')
  assert.equal(chunks[0].header.offset, 4, 'chunk offset 必须从 startOffset 起')
  assert.equal(chunks[0].header.total, 10)
  assert.equal(chunks[0].header.sha256, FULL_SHA)
  assert.equal(chunks[0].payload.toString(), FULL.slice(4))

  const done = frames.find((f) => f.header.t === 'artifact/done')
  assert.equal(done.header.bytes, 10, 'done.bytes = startOffset + sent（全文总字节）')
  assert.equal(done.header.sha256, FULL_SHA, 'done.sha256 = 全文哈希（续传用 preHash）')
  assert.equal(done.header.verified, true)
})

test('artifact-service：startOffset === size → 零 chunk 直接收尾（hub 侧已收齐的形态）', async (t) => {
  const { frames, result } = await nodePull(t, FULL, FULL.length)

  assert.equal(result.ok, true)
  assert.equal(result.sent, 0)
  const chunks = frames.filter((f) => f.header.t === 'artifact/chunk')
  assert.equal(chunks.length, 0, '没有 suffix 可发')
  const done = frames.find((f) => f.header.t === 'artifact/done')
  assert.equal(done.header.bytes, FULL.length)
  assert.equal(done.header.sha256, FULL_SHA)
  assert.equal(done.header.verified, true)
})

test('artifact-service：startOffset = 0 行为与旧版完全一致（chunk 从 0 起、done.bytes = 全文）', async (t) => {
  const { frames, result } = await nodePull(t, FULL, 0)

  assert.equal(result.ok, true)
  assert.equal(result.resumed, false)
  const chunks = frames.filter((f) => f.header.t === 'artifact/chunk')
  assert.ok(chunks.length >= 1)
  assert.equal(chunks[0].header.offset, 0)
  const done = frames.find((f) => f.header.t === 'artifact/done')
  assert.equal(done.header.bytes, FULL.length)
  assert.equal(done.header.sha256, FULL_SHA)
})

test('artifact-service：startOffset 越界（> 文件大小）必须报 hash-mismatch', async (t) => {
  await assert.rejects(
    nodePull(t, FULL, FULL.length + 1),
    (err) => err.code === 'hash-mismatch' && /beyond file size/.test(err.message),
  )
})

test('artifact-service：startOffset 畸形值（负数 / 非整数）必须报错，不静默归零', async (t) => {
  await assert.rejects(nodePull(t, FULL, -1), /invalid startOffset/)
  await assert.rejects(nodePull(t, FULL, 1.5), /invalid startOffset/)
})

/* ══════════════════ 键函数契约 ══════════════════ */

test('resumeKeyOf：同一 (dest, relPath) 稳定、分隔符写法归一后一致、不同文件不同键', () => {
  const dest = path.join(os.tmpdir(), 'dsh-key-test')
  assert.equal(resumeKeyOf(dest, 'a.txt'), resumeKeyOf(dest, 'a.txt'))
  // normalizePath 只归一分隔符/大小写（与 manifest 预检同一约定，不解析 ./）
  assert.equal(resumeKeyOf(dest, 'sub/a.txt'), resumeKeyOf(dest, 'sub\\a.txt'), '分隔符写法必须同键')
  assert.notEqual(resumeKeyOf(dest, 'a.txt'), resumeKeyOf(dest, 'b.txt'))
  assert.notEqual(resumeKeyOf(dest, 'a.txt'), resumeKeyOf(path.join(dest, 'x'), 'a.txt'))
})
