/**
 * 仓库感知调度测试（提案 #13）。
 *
 * 三层覆盖：
 *   - repos.js 纯函数：url 凭证打码 / .git/config 解析 / 扫描深度与跳过规则
 *   - hub 摄入：REPOS 帧整帧替换 rec.repos，畸形帧不抛不脏
 *   - 路由：pickNodeByRepo 的三种匹配口径、精确优先、负载感知、指定节点
 *     时 findRepoOn 只兜 workspace 不改路由
 *
 * 节点记录直接摆进 registry.nodes（与 auto-routing.test.js 同款手法），
 * 不需要真连接。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { NodeRegistry } from '../lib/hub/node-registry.js'
import { sanitizeRepoUrl, readGitRemote, scanRepos } from '../lib/node/repos.js'
import { NODE_TO_HUB } from '../lib/protocol.js'

/* ══════════════════════════════════════════════════════════════════
 * 1. sanitizeRepoUrl：凭证不离开副机
 * ══════════════════════════════════════════════════════════════════ */

test('sanitizeRepoUrl：https 里的 user:token 被剥掉', () => {
  assert.equal(sanitizeRepoUrl('https://user:ghp_token123@github.com/me/my-app.git'), 'https://github.com/me/my-app.git')
})

test('sanitizeRepoUrl：只带用户名的 url（OAuth 用户名形态）同样剥掉', () => {
  assert.equal(sanitizeRepoUrl('https://x-access-token@github.com/me/my-app.git'), 'https://github.com/me/my-app.git')
})

test('sanitizeRepoUrl：无凭证 url 与 scp 形态原样保留', () => {
  assert.equal(sanitizeRepoUrl('https://github.com/me/my-app.git'), 'https://github.com/me/my-app.git')
  // scp 形态不是合法 URL，解析失败走"原样返回"——@ 前是公开用户名，不是凭证
  assert.equal(sanitizeRepoUrl('git@github.com:me/my-app.git'), 'git@github.com:me/my-app.git')
})

test('sanitizeRepoUrl：空串与垃圾输入不抛', () => {
  assert.equal(sanitizeRepoUrl(''), '')
  assert.equal(sanitizeRepoUrl(undefined), '')
  assert.equal(sanitizeRepoUrl('not a url at all'), 'not a url at all')
})

/* ══════════════════════════════════════════════════════════════════
 * 2. readGitRemote：.git/config 文本解析（零子进程）
 * ══════════════════════════════════════════════════════════════════ */

function tmpRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-repos-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('readGitRemote：origin 优先于其他 remote', async (t) => {
  const root = tmpRoot(t)
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(
    path.join(root, '.git', 'config'),
    [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "fork"]',
      '\turl = https://github.com/me/fork.git',
      '[remote "origin"]',
      '\turl = https://github.com/me/real.git',
    ].join('\n'),
  )
  assert.equal(await readGitRemote(root), 'https://github.com/me/real.git')
})

test('readGitRemote：没有 origin 时取第一个 remote；没有 remote 为空串', async (t) => {
  const root = tmpRoot(t)
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "fork"]\n\turl = https://gitlab.com/me/fork.git\n')
  assert.equal(await readGitRemote(root), 'https://gitlab.com/me/fork.git')

  const root2 = tmpRoot(t)
  fs.mkdirSync(path.join(root2, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root2, '.git', 'config'), '[core]\n\tbare = false\n')
  assert.equal(await readGitRemote(root2), '')

  // .git/config 读不到（裸目录）也是 ''，不抛
  const root3 = tmpRoot(t)
  assert.equal(await readGitRemote(root3), '')
})

test('readGitRemote：config 里的凭证在上报前被打码', async (t) => {
  const root = tmpRoot(t)
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://ci:secret@corp.example/team/repo.git\n')
  const url = await readGitRemote(root)
  assert.equal(url, 'https://corp.example/team/repo.git')
  assert.ok(!url.includes('secret'), '凭证不能出现在上报内容里')
})

/* ══════════════════════════════════════════════════════════════════
 * 3. scanRepos：深度 / 跳过 / 上限
 * ══════════════════════════════════════════════════════════════════ */

function makeRepo(t, dir, url) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`)
}

test('scanRepos：root 本身、下钻 3 层内的仓库都能找到', async (t) => {
  const root = tmpRoot(t)
  makeRepo(t, path.join(root, 'self'), 'https://github.com/me/self-repo.git') // 浅层仓库（root 下一级）
  const depth3 = path.join(root, 'a', 'b', 'c')
  makeRepo(t, depth3, 'https://github.com/me/deep.git')

  const repos = await scanRepos([root])
  const names = repos.map((r) => r.name).sort()
  assert.deepEqual(names, ['c', 'self'])
  const deep = repos.find((r) => r.name === 'c')
  assert.equal(deep.url, 'https://github.com/me/deep.git')
  assert.equal(deep.path, depth3)
})

test('scanRepos：第 4 层的仓库不收（深度有界）', async (t) => {
  const root = tmpRoot(t)
  const tooDeep = path.join(root, 'a', 'b', 'c', 'd')
  makeRepo(t, tooDeep, 'https://github.com/me/too-deep.git')
  const repos = await scanRepos([root])
  assert.equal(repos.length, 0)
})

test('scanRepos：node_modules 与点目录不下钻；仓库内不再下钻', async (t) => {
  const root = tmpRoot(t)
  makeRepo(t, path.join(root, 'node_modules', 'pkg'), 'https://github.com/x/pkg.git')
  makeRepo(t, path.join(root, '.hidden', 'repo'), 'https://github.com/x/h.git')
  const outer = path.join(root, 'outer')
  makeRepo(t, outer, 'https://github.com/me/outer.git')
  makeRepo(t, path.join(outer, 'nested'), 'https://github.com/me/nested.git') // 仓库内的嵌套 clone

  const repos = await scanRepos([root])
  assert.deepEqual(repos.map((r) => r.name), ['outer'])
})

test('scanRepos：数量封顶 50；单目录读失败静默跳过', async (t) => {
  const root = tmpRoot(t)
  for (let i = 0; i < 60; i += 1) makeRepo(t, path.join(root, `r${String(i).padStart(2, '0')}`), `https://github.com/me/r${i}.git`)
  const repos = await scanRepos([root])
  assert.equal(repos.length, 50)
  // 不存在的 root 不抛
  assert.deepEqual(await scanRepos([path.join(root, 'nope')]), [])
})

/* ══════════════════════════════════════════════════════════════════
 * 4. hub 摄入：REPOS 帧
 * ══════════════════════════════════════════════════════════════════ */

function setupRegistry(t) {
  const registry = new NodeRegistry({ log: () => {} })
  registry.nodes.set('n1', {
    nodeId: 'n1',
    online: true,
    hello: { agentMode: true },
    resource: null,
    tasks: new Map(),
    conn: null,
  })
  t.after(() => registry.dispose())
  return registry
}

test('REPOS 帧：整帧替换 rec.repos，带时间戳', () => {
  const t = { after: () => {} }
  const registry = setupRegistry(t)
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.REPOS, d: { repos: [{ name: 'my-app', url: 'https://github.com/me/my-app.git', path: 'D:\\code\\my-app' }] } })
  const rec = registry.nodes.get('n1')
  assert.equal(rec.repos.length, 1)
  assert.equal(rec.repos[0].name, 'my-app')
  assert.ok(Number.isFinite(rec.reposAt))
})

test('REPOS 帧：二次上报是替换不是追加', () => {
  const t = { after: () => {} }
  const registry = setupRegistry(t)
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.REPOS, d: { repos: [{ name: 'a', url: '', path: '/a' }] } })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.REPOS, d: { repos: [{ name: 'b', url: '', path: '/b' }] } })
  assert.deepEqual(registry.nodes.get('n1').repos.map((r) => r.name), ['b'])
})

test('REPOS 帧：畸形条目被清洗（非对象 / 全空 / 字段截断），数量封顶 50', () => {
  const t = { after: () => {} }
  const registry = setupRegistry(t)
  const repos = [{ name: 'x', url: '', path: '/x' }, null, 42, {}, { name: 'y'.repeat(500), url: '', path: '/y' }]
  for (let i = 0; i < 60; i += 1) repos.push({ name: `f${i}`, url: '', path: `/f${i}` })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.REPOS, d: { repos } })
  const rec = registry.nodes.get('n1')
  assert.equal(rec.repos.length, 50, '超过 50 条的丢弃')
  const long = rec.repos.find((r) => r.name.startsWith('yyy'))
  assert.ok(long && long.name.length === 200, '超长字段截断到 200')
  assert.ok(!rec.repos.some((r) => r.name === '' && r.url === '' && r.path === ''), '全空条目不进清单')
})

test('REPOS 帧：repos 字段缺失 / 不是数组 → 清成空表，不抛', () => {
  const t = { after: () => {} }
  const registry = setupRegistry(t)
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.REPOS, d: {} })
  registry.handleFrameFor('n1', { t: NODE_TO_HUB.REPOS, d: { repos: 'oops' } })
  assert.deepEqual(registry.nodes.get('n1').repos, [])
})

/* ══════════════════════════════════════════════════════════════════
 * 5. 路由：pickNodeByRepo / findRepoOn / knownRepoNames
 * ══════════════════════════════════════════════════════════════════ */

function setupRouted(t, nodes) {
  const registry = new NodeRegistry({ log: () => {} })
  for (const n of nodes) {
    registry.nodes.set(n.nodeId, {
      nodeId: n.nodeId,
      online: n.online !== false,
      hello: { agentMode: n.agentMode !== false },
      resource: n.resource ?? null,
      repos: n.repos ?? [],
      reposAt: n.repos ? Date.now() : null,
      tasks: new Map(),
      conn: null,
    })
  }
  t.after(() => registry.dispose())
  return registry
}

test('pickNodeByRepo：名字精确匹配（大小写不敏感）', (t) => {
  const registry = setupRouted(t, [{ nodeId: 'a', repos: [{ name: 'My-App', url: '', path: 'D:\\a' }] }])
  const hit = registry.pickNodeByRepo('my-app')
  assert.equal(hit.nodeId, 'a')
  assert.equal(hit.repo.path, 'D:\\a')
})

test('pickNodeByRepo：url / 本机路径片段都能命中', (t) => {
  const registry = setupRouted(t, [
    { nodeId: 'a', repos: [{ name: 'other', url: 'https://github.com/me/alpha.git', path: '/x' }] },
    { nodeId: 'b', repos: [{ name: 'other', url: '', path: 'D:\\code\\beta' }] },
  ])
  assert.equal(registry.pickNodeByRepo('github.com/me/alpha').nodeId, 'a')
  assert.equal(registry.pickNodeByRepo('code\\beta').nodeId, 'b')
})

test('pickNodeByRepo：多节点持有时按负载选（在跑任务数第一级）', (t) => {
  const registry = setupRouted(t, [
    { nodeId: 'busy', repos: [{ name: 'my-app', url: '', path: '/busy' }], resource: { cpuPct: 1 } },
    { nodeId: 'idle', repos: [{ name: 'my-app', url: '', path: '/idle' }], resource: { cpuPct: 99 } },
  ])
  registry.nodes.get('busy').tasks.set('t1', { status: 'running' })
  const hit = registry.pickNodeByRepo('my-app')
  assert.equal(hit.nodeId, 'idle')
  assert.equal(hit.repo.path, '/idle')
})

test('pickNodeByRepo：名字精确匹配优先于包含匹配（跨节点）', (t) => {
  const registry = setupRouted(t, [
    // node-a 持有一个 url 里包含 "my-app" 的仓库（包含匹配）
    { nodeId: 'a', repos: [{ name: 'wrapper', url: 'https://github.com/me/my-app-docs.git', path: '/a' }], resource: { cpuPct: 0 } },
    // node-b 持有名字精确叫 my-app 的仓库，但负载更差
    { nodeId: 'b', repos: [{ name: 'my-app', url: '', path: '/b' }], resource: { cpuPct: 99 } },
  ])
  const hit = registry.pickNodeByRepo('my-app')
  assert.equal(hit.nodeId, 'b', '精确命中必须赢过负载更好的包含命中')
})

test('pickNodeByRepo：离线节点不参与；agent 模式过滤 agentMode', (t) => {
  const registry = setupRouted(t, [
    { nodeId: 'off', online: false, repos: [{ name: 'my-app', url: '', path: '/off' }] },
    { nodeId: 'exec-only', agentMode: false, repos: [{ name: 'my-app', url: '', path: '/exec' }] },
    { nodeId: 'agent-ok', repos: [{ name: 'my-app', url: '', path: '/ok' }] },
  ])
  assert.equal(registry.pickNodeByRepo('my-app', { mode: 'agent' }).nodeId, 'agent-ok')
  assert.equal(registry.pickNodeByRepo('my-app', { mode: 'exec' }).nodeId !== 'off', true)
})

test('pickNodeByRepo：无匹配返回 null', (t) => {
  const registry = setupRouted(t, [{ nodeId: 'a', repos: [{ name: 'x', url: '', path: '/x' }] }])
  assert.equal(registry.pickNodeByRepo('nope'), null)
  assert.equal(registry.pickNodeByRepo(''), null)
  assert.equal(registry.pickNodeByRepo(undefined), null)
})

test('findRepoOn：只在指定节点上找，不跨节点', (t) => {
  const registry = setupRouted(t, [
    { nodeId: 'a', repos: [{ name: 'my-app', url: '', path: '/on-a' }] },
    { nodeId: 'b', repos: [{ name: 'my-app', url: '', path: '/on-b' }] },
  ])
  assert.equal(registry.findRepoOn('b', 'my-app').path, '/on-b')
  assert.equal(registry.findRepoOn('nope', 'my-app'), null)
  assert.equal(registry.findRepoOn('a', 'other'), null)
})

test('knownRepoNames：在线节点的仓库名去重集合；离线节点不算', (t) => {
  const registry = setupRouted(t, [
    { nodeId: 'a', repos: [{ name: 'my-app', url: '', path: '/a' }, { name: 'lib', url: '', path: '/l' }] },
    { nodeId: 'b', repos: [{ name: 'my-app', url: '', path: '/b' }] },
    { nodeId: 'c', online: false, repos: [{ name: 'ghost', url: '', path: '/g' }] },
  ])
  assert.deepEqual(registry.knownRepoNames().sort(), ['lib', 'my-app'])
})
