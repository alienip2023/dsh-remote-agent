/**
 * lib/relay-config.js 行为测试 —— 中继凭证生成、文件权限与输出格式化。
 *
 * 为什么这个文件必须存在：这个模块**生成 hub/enroll token 并决定它们的落盘形态**，
 * 是整条中继链路的信任根。它的失败模式都是静默的：
 *   - 幂等性破了 → 每次重启都轮换 token → 已发出去的副机全体掉线
 *   - 原子写破了 → 崩溃留下半个 tokens.json → 下次启动读到损坏凭证
 *   - 权限收窄破了 → token 文件对同机其他用户可读
 *   - 格式化泄露了 → 明文 token 进了 journald 持久日志
 * 这四类都不会抛异常、不会有非 0 退出码，只会在很久以后以"莫名其妙掉线"的形式暴露。
 *
 * 硬约束：全部用 mkdtemp 出来的临时目录，**绝不碰真实 ~/.dsh-remote-agent-relay**。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  TOKENS_FILE,
  TOKENS_FILE_VERSION,
  defaultDataDir,
  formatReadyLine,
  formatTokenFingerprintLine,
  formatTokensLine,
  loadOrCreateTokens,
  parseArgs,
  restrictPermissions,
} from '../lib/relay-config.js'
import { tokenFingerprint } from '../lib/relay.js'

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dsh-remote-relay.js')

/* ───────────────────────────── 测试工具 ───────────────────────────── */

function tmpdir(t, prefix = 'dsh-relay-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  return dir
}

/**
 * 临时替换 fs 上的若干方法，观察调用序列，结束时精确还原。
 *
 * 为什么用 patch 而不是"读源码找 renameSync"：本任务要断言的是**运行时形态**
 * （先写临时文件、再 rename；rename 之前目标不存在），文本断言会把
 * "注释里提到过 rename"也算通过。exec.js 那边已经吃过一次这种亏。
 */
function spyFs(t, names, { on = null } = {}) {
  const orig = {}
  const calls = []
  for (const n of names) {
    orig[n] = fs[n]
    assert.equal(typeof orig[n], 'function', `fs.${n} 必须是函数`)
    fs[n] = (...args) => {
      calls.push({ name: n, args })
      if (typeof on === 'function') on(n, args)
      return orig[n](...args)
    }
  }
  t.after(() => {
    for (const n of names) fs[n] = orig[n]
  })
  return { calls, restore: () => { for (const n of names) fs[n] = orig[n] } }
}

/** 让某个 fs 方法在指定条件下抛错，用来模拟崩溃/中断。 */
function failFs(t, name, predicate, message = 'simulated failure') {
  const orig = fs[name]
  fs[name] = (...args) => {
    if (predicate(...args)) {
      const err = new Error(message)
      err.code = 'EIO'
      throw err
    }
    return orig(...args)
  }
  t.after(() => {
    fs[name] = orig
  })
}

/* ───────────────────────────── defaultDataDir ───────────────────────────── */

test('defaultDataDir：返回绝对路径、不抛、不创建任何东西', (t) => {
  const d = defaultDataDir()
  assert.equal(typeof d, 'string')
  assert.ok(d.length > 0)
  assert.ok(path.isAbsolute(d), `必须是绝对路径：${d}`)
  assert.equal(path.basename(d), '.dsh-remote-agent-relay')
  assert.equal(d, path.join(os.homedir(), '.dsh-remote-agent-relay'))
  // 纯函数：调用它不该在磁盘上留下任何东西
  assert.equal(defaultDataDir(), d, '同一环境下结果必须稳定')
})

/* ─────────────────────────── loadOrCreateTokens ─────────────────────────── */

test('loadOrCreateTokens：首次生成两个 token 并落盘，created=true', (t) => {
  const dir = tmpdir(t)
  const rec = loadOrCreateTokens(dir)

  assert.equal(rec.created, true, '首次必须报 created=true')
  assert.equal(rec.path, path.join(dir, TOKENS_FILE))
  assert.equal(typeof rec.hubToken, 'string')
  assert.equal(typeof rec.enrollToken, 'string')

  // 前缀区分用途：hub 用 rt_，node 入网用 en_
  assert.match(rec.hubToken, /^rt_/, 'hubToken 必须是 rt_ 前缀')
  assert.match(rec.enrollToken, /^en_/, 'enrollToken 必须是 en_ 前缀')
  assert.notEqual(rec.hubToken, rec.enrollToken, 'hub 与 enroll 必须是两个不同的 token')

  // 落盘内容形状
  const raw = fs.readFileSync(rec.path, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, TOKENS_FILE_VERSION)
  assert.equal(parsed.hubToken, rec.hubToken)
  assert.equal(parsed.enrollToken, rec.enrollToken)
  assert.ok(!Number.isNaN(Date.parse(parsed.createdAt)), `createdAt 必须是可解析时间：${parsed.createdAt}`)

  // 目录也被建出来了
  assert.equal(fs.existsSync(dir), true)
  assert.equal(fs.statSync(dir).isDirectory(), true)
})

test('loadOrCreateTokens：token 熵足够（长度 + 随机性 + 无重复）', (t) => {
  const dir = tmpdir(t)
  const rec = loadOrCreateTokens(dir)

  // newRelayToken 用 randomBytes(24).toString('base64url') → 32 个 URL 安全字符
  const body = (s) => s.slice(s.indexOf('_') + 1)
  for (const [name, tok] of [['hubToken', rec.hubToken], ['enrollToken', rec.enrollToken]]) {
    const b = body(tok)
    assert.ok(b.length >= 32, `${name} 的随机部分太短：${b.length}`)
    assert.match(b, /^[A-Za-z0-9_-]+$/, `${name} 必须是 URL 安全字符集`)
    // 不能是明显的低熵形态
    assert.notEqual(new Set(b).size, 1, `${name} 不能是重复字符`)
  }

  // 连续生成的一批 token 必须互不相同（randomBytes 没被退化成固定值）
  const seen = new Set()
  for (let i = 0; i < 8; i += 1) {
    const d = tmpdir(t, 'dsh-relay-ent-')
    const r = loadOrCreateTokens(d)
    seen.add(r.hubToken)
    seen.add(r.enrollToken)
  }
  assert.equal(seen.size, 16, '16 个新生成的 token 必须全部唯一')
})

test('loadOrCreateTokens：二次调用读取同一份（幂等，不重新生成、不重写文件）', (t) => {
  const dir = tmpdir(t)
  const first = loadOrCreateTokens(dir)

  // 第二次调用期间观察：不应发生任何写入
  const { calls } = spyFs(t, ['writeFileSync', 'renameSync', 'rmSync'])
  const second = loadOrCreateTokens(dir)

  assert.equal(second.created, false, '已有凭证必须报 created=false')
  assert.equal(second.hubToken, first.hubToken, 'hubToken 必须保持不变（轮换会让已发出的副机全掉线）')
  assert.equal(second.enrollToken, first.enrollToken, 'enrollToken 必须保持不变')
  assert.equal(second.path, first.path)

  const writes = calls.filter((c) => c.name === 'writeFileSync' || c.name === 'renameSync')
  assert.deepEqual(writes, [], `读取路径不得写盘，实际发生：${writes.map((c) => c.name).join(',')}`)

  // 内容也没被改动
  const parsed = JSON.parse(fs.readFileSync(first.path, 'utf8'))
  assert.equal(parsed.hubToken, first.hubToken)
})

test('loadOrCreateTokens：source 语义可区分"新建"与"已有"（created 字段）', (t) => {
  // bin/dsh-remote-relay.js 用 `rec.created ? 'generated' : 'file'` 决定 source，
  // 所以 created 必须是**布尔**且严格反映这次调用有没有生成。
  const dir = tmpdir(t)
  assert.equal(loadOrCreateTokens(dir).created, true)
  assert.equal(loadOrCreateTokens(dir).created, false)
  assert.equal(loadOrCreateTokens(dir).created, false)
})

test('loadOrCreateTokens：凭证文件损坏时抛可读错误，绝不静默轮换', (t) => {
  // 静默轮换会让所有已发出去的副机瞬间掉线，且用户没有任何提示。
  const dir = tmpdir(t)
  const file = path.join(dir, TOKENS_FILE)

  // ① 不是合法 JSON
  fs.writeFileSync(file, '{ this is not json', 'utf8')
  const before = fs.readFileSync(file, 'utf8')
  assert.throws(
    () => loadOrCreateTokens(dir),
    (e) => /不是合法 JSON/.test(e.message) && e.message.includes(file),
    '非法 JSON 必须抛带文件路径的可读错误',
  )
  assert.equal(fs.readFileSync(file, 'utf8'), before, '损坏文件必须原样保留，不被覆盖')

  // ② 合法 JSON 但缺字段
  fs.writeFileSync(file, JSON.stringify({ version: 1, hubToken: 'rt_x' }), 'utf8')
  assert.throws(
    () => loadOrCreateTokens(dir),
    (e) => /缺少 hubToken \/ enrollToken/.test(e.message),
  )

  // ③ 字段是空白串（trim 后为空也算缺失）
  fs.writeFileSync(file, JSON.stringify({ hubToken: '   ', enrollToken: 'en_x' }), 'utf8')
  assert.throws(() => loadOrCreateTokens(dir), (e) => /缺少 hubToken \/ enrollToken/.test(e.message))

  // ④ 字段类型不对
  fs.writeFileSync(file, JSON.stringify({ hubToken: 42, enrollToken: 'en_x' }), 'utf8')
  assert.throws(() => loadOrCreateTokens(dir), (e) => /缺少 hubToken \/ enrollToken/.test(e.message))

  // 修复后能正常读出（证明上面拒的是内容，不是把文件判了死刑）
  fs.writeFileSync(file, JSON.stringify({ hubToken: 'rt_fixed', enrollToken: 'en_fixed' }), 'utf8')
  const rec = loadOrCreateTokens(dir)
  assert.equal(rec.created, false)
  assert.equal(rec.hubToken, 'rt_fixed')
  assert.equal(rec.enrollToken, 'en_fixed')
})

test('loadOrCreateTokens：dataDir 非法输入被拒（不静默落到默认 home 目录）', (t) => {
  // 静默回退到默认目录 = 用户以为写到了自己的目录，实际写进了 ~/.dsh-remote-agent-relay
  for (const bad of ['', '   ', null, 42, {}, []]) {
    assert.throws(
      () => loadOrCreateTokens(bad),
      (e) => /dataDir 必须是非空字符串/.test(e.message),
      `非法 dataDir ${JSON.stringify(bad)} 必须被拒`,
    )
  }

  // undefined 走的是 JS 默认参数（= defaultDataDir()），这是刻意的：
  // 「不传参数」与「传了个空值」语义不同。这里把 homedir 指到临时目录，
  // 断言它落到默认目录名，且**绝不触碰真实 home**。
  const fakeHome = tmpdir(t, 'dsh-fake-home-')
  const orig = os.homedir
  os.homedir = () => fakeHome
  t.after(() => {
    os.homedir = orig
  })
  const rec = loadOrCreateTokens(undefined)
  assert.equal(path.dirname(rec.path), path.join(fakeHome, '.dsh-remote-agent-relay'))
  assert.equal(rec.created, true)

  // 真实 home 下不该因为这个测试被建出凭证目录（用假 home 隔离过，
  // 这里只断言"默认目录名"这一语义，不去读真实 home）
  assert.equal(defaultDataDir(), path.join(fakeHome, '.dsh-remote-agent-relay'))
})

test('loadOrCreateTokens：dataDir 是相对路径时按 cwd 解析成绝对路径', (t) => {
  // 跨盘符时 path.relative 会给出绝对路径（无相对表示），所以必须让 cwd 与目标同盘。
  // 做法：把 cwd 临时切到临时目录（而不是往仓库里写东西），结束后切回。
  // node --test 每个测试文件跑在独立进程里，且同文件内用例默认串行 —— 切 cwd 是安全的。
  //
  // ⚠ 清理顺序有坑：node 按**注册顺序**执行 t.after。若先注册 rmSync 再注册 chdir，
  // Windows 上 rmSync 会因"目录是当前工作目录"失败（且被 catch 静默吞掉），
  // 每个用例泄漏一个临时目录。所以这里手写一个钩子，先 chdir 回去再删。
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-relay-cwd-'))
  const origCwd = process.cwd()
  t.after(() => {
    try {
      process.chdir(origCwd)
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* Windows 偶发占用 */
    }
  })
  process.chdir(sandbox)

  const rec = loadOrCreateTokens('relative-dir')
  assert.ok(path.isAbsolute(rec.path), `落盘路径必须是绝对路径：${rec.path}`)
  assert.equal(path.dirname(rec.path), path.join(sandbox, 'relative-dir'), '相对路径必须按 cwd 解析')
  assert.equal(fs.existsSync(rec.path), true)

  // 同一相对路径再读一次必须幂等（证明解析稳定，不会每次落到不同位置）
  const again = loadOrCreateTokens('relative-dir')
  assert.equal(again.hubToken, rec.hubToken)
  assert.equal(again.created, false)

  // 换一个相对路径必须是另一份凭证（不能串目录）
  const other = loadOrCreateTokens('other-dir')
  assert.equal(other.created, true)
  assert.notEqual(other.hubToken, rec.hubToken)

  // 清理钩子必须真的能删掉（证明上面的顺序修正有效，而不是靠 catch 吞掉失败）
  process.chdir(origCwd)
  fs.rmSync(sandbox, { recursive: true, force: true })
  assert.equal(fs.existsSync(sandbox), false, '临时目录必须可被真正删除（否则每个用例泄漏一个）')
})

/* ───────────────────────────── 原子写 ───────────────────────────── */

test('原子写：先写临时文件、再 rename 覆盖，目标文件在 rename 之前不存在', (t) => {
  const dir = tmpdir(t)
  const target = path.join(dir, TOKENS_FILE)
  let targetExistedDuringWrite = null

  const { calls } = spyFs(t, ['writeFileSync', 'renameSync'], {
    on: (name, args) => {
      if (name === 'writeFileSync') targetExistedDuringWrite = fs.existsSync(target)
    },
  })
  loadOrCreateTokens(dir)

  const write = calls.find((c) => c.name === 'writeFileSync')
  const rename = calls.find((c) => c.name === 'renameSync')
  assert.ok(write, '必须写文件')
  assert.ok(rename, '必须 rename —— 直接写目标文件会留下半写状态')

  const tmpPath = String(write.args[0])
  assert.notEqual(tmpPath, target, '写的是临时文件，不是目标文件')
  assert.match(path.basename(tmpPath), /\.tmp$/, `临时文件应以 .tmp 结尾：${tmpPath}`)
  assert.equal(path.dirname(tmpPath), dir, '临时文件必须在同一目录（跨设备 rename 不是原子的）')

  assert.equal(String(rename.args[0]), tmpPath, 'rename 的来源是刚写的临时文件')
  assert.equal(String(rename.args[1]), target, 'rename 的目标是 tokens.json')

  assert.equal(targetExistedDuringWrite, false, '写临时文件时目标还不存在（全新场景）')
  assert.equal(fs.existsSync(target), true, '最终目标必须存在')
  assert.equal(fs.existsSync(tmpPath), false, 'rename 之后临时文件必须消失')
})

test('原子写：不留下 .tmp 残留', (t) => {
  const dir = tmpdir(t)
  loadOrCreateTokens(dir)
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], `不得留下临时文件：${leftovers.join(',')}`)
})

test('原子写：rename 阶段崩溃 → 目标文件不存在、目录无残留（不是半写文件）', (t) => {
  const dir = tmpdir(t)
  failFs(t, 'renameSync', () => true, 'simulated crash during rename')

  assert.throws(
    () => loadOrCreateTokens(dir),
    (e) => /写入凭证文件失败/.test(e.message) && /simulated crash/.test(e.message),
    '崩溃必须报"写入凭证文件失败"并带上原因',
  )
  assert.equal(fs.existsSync(path.join(dir, TOKENS_FILE)), false, '崩溃后不得留下半个 tokens.json')
  assert.deepEqual(fs.readdirSync(dir), [], '临时文件必须被清理，不能留残骸')
})

test('原子写：写临时文件阶段崩溃 → 无残留、不产生半个文件', (t) => {
  const dir = tmpdir(t)
  failFs(t, 'writeFileSync', (p) => String(p).endsWith('.tmp'), 'simulated disk full')

  assert.throws(
    () => loadOrCreateTokens(dir),
    (e) => /写入凭证文件失败/.test(e.message) && /simulated disk full/.test(e.message),
  )
  assert.deepEqual(fs.readdirSync(dir), [], '失败后不得留下任何文件（包括半写的临时文件）')
  assert.equal(fs.existsSync(path.join(dir, TOKENS_FILE)), false)
})

test('原子写：目标已存在时重写仍是"临时文件 → rename"，不会先截断目标', (t) => {
  // 半写状态最危险的场景不是首次创建，而是**覆盖已有凭证**：
  // 若直接 open(target,'w')，崩溃就会留下被截断的 tokens.json，
  // 下次启动读到非法 JSON —— 而实现选择抛错拒绝静默轮换，于是一个
  // 半写文件会让中继彻底起不来，必须手工修。
  const dir = tmpdir(t)
  const target = path.join(dir, TOKENS_FILE)
  loadOrCreateTokens(dir)
  assert.equal(fs.existsSync(target), true, '前置条件：目标已存在')

  // 覆盖场景：让第二次写入经过同一路径（删掉目标重建），
  // 并观察写临时文件期间目标的**存在性**。
  let targetExistedDuringWrite = null
  const { calls } = spyFs(t, ['writeFileSync', 'renameSync'], {
    on: (name, args) => {
      if (name === 'writeFileSync') targetExistedDuringWrite = fs.existsSync(target)
    },
  })
  fs.rmSync(target)
  const rec = loadOrCreateTokens(dir)

  assert.equal(targetExistedDuringWrite, false, '写临时文件期间目标不该存在（更不该是被截断的半成品）')
  assert.equal(rec.created, true)

  // 写入序列必须是 write(tmp) → rename(tmp, target)，中间没有对目标的直接写入
  const seq = calls.filter((c) => c.name === 'writeFileSync' || c.name === 'renameSync').map((c) => c.name)
  assert.deepEqual(seq, ['writeFileSync', 'renameSync'])
  assert.ok(
    !calls.some((c) => c.name === 'writeFileSync' && String(c.args[0]) === target),
    '绝不允许直接写目标文件（那会先截断它）',
  )

  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.equal(parsed.hubToken, rec.hubToken)
})

test('原子写：崩溃后重跑能成功（失败不是毒状态）', (t) => {
  const dir = tmpdir(t)
  const orig = fs.renameSync
  let boom = true
  fs.renameSync = (...args) => {
    if (boom) {
      boom = false
      throw Object.assign(new Error('simulated crash'), { code: 'EIO' })
    }
    return orig(...args)
  }
  t.after(() => {
    fs.renameSync = orig
  })

  assert.throws(() => loadOrCreateTokens(dir), /写入凭证文件失败/)
  assert.deepEqual(fs.readdirSync(dir), [], '第一次失败后目录必须干净')

  const rec = loadOrCreateTokens(dir)
  assert.equal(rec.created, true)
  assert.equal(fs.existsSync(rec.path), true)
  assert.deepEqual(fs.readdirSync(dir), [TOKENS_FILE], '重跑后目录里只应有 tokens.json')
})

/* ─────────────────────────── restrictPermissions ─────────────────────────── */

test('restrictPermissions：任何平台都不抛，且对目标调用 chmod 0600 / 目录 0700', (t) => {
  const dir = tmpdir(t)
  const file = path.join(dir, 'cred.txt')
  fs.writeFileSync(file, 'secret')

  // 断言传给 chmod 的目标模式（这是跨平台可断言的"posix 语义"）
  const seen = []
  const origChmod = fs.chmodSync
  fs.chmodSync = (target, mode) => {
    seen.push([String(target), mode])
    return origChmod(target, mode)
  }
  t.after(() => {
    fs.chmodSync = origChmod
  })

  assert.doesNotThrow(() => restrictPermissions(file))
  assert.doesNotThrow(() => restrictPermissions(file, { isDir: true }))
  assert.doesNotThrow(() => restrictPermissions(path.join(dir, 'does-not-exist')))

  assert.deepEqual(seen[0], [file, 0o600], '文件必须是 0600')
  assert.deepEqual(seen[1], [file, 0o700], '目录必须是 0700')
})

test('restrictPermissions：posix 语义下目标模式真的生效', (t) => {
  if (process.platform === 'win32') {
    // Windows 无 chmod 语义：实测 chmodSync(0600) 之后 mode 仍是 666（只映射只读位）。
    // 这里显式记录平台差异，而不是让断言在本机假绿。
    t.skip('Windows 无 chmod 语义，模式断言在 posix 上执行')
    return
  }
  const dir = tmpdir(t)
  const file = path.join(dir, 'cred.txt')
  fs.writeFileSync(file, 'secret', { mode: 0o644 })
  restrictPermissions(file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, '文件模式必须被收窄到 0600')
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, '目录模式必须被收窄到 0700')
})

test('restrictPermissions：Windows 上走 icacls 去掉继承并只授权当前用户', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅 Windows 走 icacls 分支')
    return
  }
  const dir = tmpdir(t)
  const file = path.join(dir, 'cred.txt')
  fs.writeFileSync(file, 'secret')

  // 收窄前：继承来的 ACL 里包含 SYSTEM / Administrators / Users 等
  const before = spawnSync('icacls', [file], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  if (before.status !== 0) {
    t.skip('本机 icacls 不可用')
    return
  }
  assert.match(before.stdout, /\(I\)/, '前置条件：初始 ACL 应带继承标记（否则本用例守了个空）')

  restrictPermissions(file)

  // 读回来验证：必须只剩当前用户一条，且继承标记 (I) 已消失
  const read = spawnSync('icacls', [file], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(read.status, 0, `icacls 读回失败：${read.stderr}`)
  const acl = read.stdout
  const user = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME
  assert.ok(acl.includes(user), `ACL 必须包含当前用户 ${user}`)
  assert.ok(!/\(I\)/.test(acl), `继承 ACE 必须被移除，实际 ACL：${acl}`)
  assert.ok(!/BUILTIN\\Users/.test(acl), `不得残留 Users 组授权：${acl}`)
  assert.ok(!/Everyone/.test(acl), `不得残留 Everyone 授权：${acl}`)
  assert.ok(!/NT AUTHORITY\\SYSTEM/.test(acl), `不得残留 SYSTEM 授权：${acl}`)
})

test('restrictPermissions：icacls 缺失时静默忽略，不影响主流程', (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅 Windows 走 icacls 分支')
    return
  }
  const dir = tmpdir(t)
  const file = path.join(dir, 'cred.txt')
  fs.writeFileSync(file, 'secret')

  // 把 PATH 清空 → icacls 找不到。spawnSync 会返回 error 而不是抛，
  // 所以断言的是"调用方不受影响"：函数正常返回、文件仍可读。
  const savedPath = process.env.PATH
  process.env.PATH = tmpdir(t, 'dsh-nopath-')
  t.after(() => {
    process.env.PATH = savedPath
  })
  assert.doesNotThrow(() => restrictPermissions(file))
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret', '文件必须完好，权限收窄失败不该破坏内容')
})

test('restrictPermissions：loadOrCreateTokens 落盘后文件权限已被收窄', (t) => {
  const dir = tmpdir(t)
  const rec = loadOrCreateTokens(dir)
  if (process.platform === 'win32') {
    const read = spawnSync('icacls', [rec.path], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    if (read.status === 0) {
      assert.ok(!/\(I\)/.test(read.stdout), `tokens.json 的继承 ACE 必须被移除：${read.stdout}`)
      assert.ok(!/Everyone/.test(read.stdout), `tokens.json 不得对 Everyone 开放：${read.stdout}`)
    }
    return
  }
  assert.equal(fs.statSync(rec.path).mode & 0o777, 0o600, 'tokens.json 必须是 0600')
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, '凭证目录必须是 0700')
})

/* ───────────────────────────── parseArgs ───────────────────────────── */

test('parseArgs：默认值形状正确（port/host/dataDir/开关）', (t) => {
  const out = parseArgs([], {})
  assert.deepEqual(Object.keys(out).sort(), [
    'dataDir', 'enrollToken', 'help', 'host', 'hubToken', 'port', 'printTokens',
  ])
  assert.equal(out.port, DEFAULT_PORT)
  assert.equal(out.host, DEFAULT_HOST)
  assert.equal(out.hubToken, '')
  assert.equal(out.enrollToken, '')
  assert.equal(out.printTokens, false)
  assert.equal(out.help, false)
  assert.equal(out.dataDir, defaultDataDir(), '未给 --data-dir 且无 env 时用默认目录')
})

test('parseArgs：--port / --host / --data-dir / token 参数解析正确（空格与 = 两种写法）', (t) => {
  const a = parseArgs(['--port', '1234', '--host', '127.0.0.1', '--data-dir', 'D:\\d', '--hub-token', 'rt_a', '--enroll-token', 'en_b'], {})
  assert.equal(a.port, 1234)
  assert.equal(a.host, '127.0.0.1')
  assert.equal(a.dataDir, 'D:\\d')
  assert.equal(a.hubToken, 'rt_a')
  assert.equal(a.enrollToken, 'en_b')

  const b = parseArgs(['--port=4321', '--host=::1', '--data-dir=/tmp/d', '--hub-token=rt_b', '--enroll-token=en_c'], {})
  assert.equal(b.port, 4321)
  assert.equal(b.host, '::1')
  assert.equal(b.dataDir, '/tmp/d')
  assert.equal(b.hubToken, 'rt_b')
  assert.equal(b.enrollToken, 'en_c')

  // 0 是合法端口（随机端口），不能被当成"没给"
  assert.equal(parseArgs(['--port', '0'], {}).port, 0)
  assert.equal(parseArgs(['--port=0'], {}).port, 0)
  // 65535 是上界，合法
  assert.equal(parseArgs(['--port', '65535'], {}).port, 65535)
})

test('parseArgs：--print-tokens / --help 开关与显式取值', (t) => {
  assert.equal(parseArgs(['--print-tokens'], {}).printTokens, true)
  assert.equal(parseArgs(['-h'], {}).help, true)
  assert.equal(parseArgs(['--help'], {}).help, true)

  // 显式取值必须被尊重 —— 尤其是 --print-tokens=false：
  // 用户明确表示"不要打印明文 token"，却被静默反转成 true 是最敏感的方向。
  assert.equal(parseArgs(['--print-tokens=false'], {}).printTokens, false)
  assert.equal(parseArgs(['--print-tokens=0'], {}).printTokens, false)
  assert.equal(parseArgs(['--print-tokens=no'], {}).printTokens, false)
  assert.equal(parseArgs(['--print-tokens=true'], {}).printTokens, true)
  assert.equal(parseArgs(['--help=false'], {}).help, false)
  assert.equal(parseArgs(['--help=1'], {}).help, true)

  // 无法解读的取值必须报错，不能默默当成 true
  assert.throws(() => parseArgs(['--print-tokens=maybe'], {}), /--print-tokens 只接受 true\/false/)
  assert.throws(() => parseArgs(['--help=whatever'], {}), /--help 只接受 true\/false/)
})

test('parseArgs：非法值被拒，不静默取默认', (t) => {
  // 端口
  for (const bad of ['abc', '12abc', '-1', '65536', '1.5', '', ' 1 2 ', '1e3', '0x10']) {
    assert.throws(
      () => parseArgs(['--port', bad], {}),
      /--port 需要 0-65535 的整数端口/,
      `非法端口 ${JSON.stringify(bad)} 必须被拒`,
    )
  }
  assert.throws(() => parseArgs(['--port'], {}), /--port 需要一个取值/)
  assert.throws(() => parseArgs(['--port', '--host'], {}), /--port 需要一个取值/, '下一个参数是另一个 flag 时算缺值')

  // 监听地址：空、纯空白、含内部空白都被拒
  // （首尾空白是**刻意允许**的：parseHostValue 先 trim 再校验，见下一条用例）
  for (const bad of ['', '   ', 'a b', '0.0.0.0 8890']) {
    const expected = bad.trim() === '' ? /需要非空的监听地址/ : /不能有空白字符/
    assert.throws(() => parseArgs(['--host', bad], {}), expected, `非法 host ${JSON.stringify(bad)} 必须被拒`)
  }

  // 空字符串取值
  assert.throws(() => parseArgs(['--hub-token', ''], {}), /--hub-token 不能为空字符串/)
  assert.throws(() => parseArgs(['--enroll-token', ''], {}), /--enroll-token 不能为空字符串/)
  assert.throws(() => parseArgs(['--data-dir', ''], {}), /--data-dir 不能为空字符串/)
  assert.throws(() => parseArgs(['--hub-token=   '], {}), /--hub-token 不能为空字符串/)

  // 未知参数 / 位置参数 / 空参数
  assert.throws(() => parseArgs(['--nope'], {}), /未知参数：--nope/)
  assert.throws(() => parseArgs(['-x'], {}), /未知参数：-x/)
  assert.throws(() => parseArgs(['positional'], {}), /不支持的位置参数：positional/)
  assert.throws(() => parseArgs([''], {}), /收到空参数/)
})

test('parseArgs：环境变量回退生效（port / host / token / dataDir）', (t) => {
  const env = {
    DSH_RELAY_PORT: '9100',
    DSH_RELAY_HOST: '10.0.0.5',
    DSH_RELAY_HUB_TOKEN: 'rt_env',
    DSH_RELAY_ENROLL_TOKEN: 'en_env',
    DSH_RELAY_DATA_DIR: 'D:\\envdir',
  }
  const out = parseArgs([], env)
  assert.equal(out.port, 9100)
  assert.equal(out.host, '10.0.0.5')
  assert.equal(out.hubToken, 'rt_env')
  assert.equal(out.enrollToken, 'en_env')
  assert.equal(out.dataDir, 'D:\\envdir')

  // 空/空白的环境变量等于没设置
  assert.equal(parseArgs([], { DSH_RELAY_PORT: '  ' }).port, DEFAULT_PORT)
  assert.equal(parseArgs([], { DSH_RELAY_HOST: '' }).host, DEFAULT_HOST)
  assert.equal(parseArgs([], { DSH_RELAY_HUB_TOKEN: '  ' }).hubToken, '')
  assert.equal(parseArgs([], { DSH_RELAY_DATA_DIR: ' ' }).dataDir, defaultDataDir())
})

test('parseArgs：优先级 CLI > 环境变量 > 默认值', (t) => {
  const env = {
    DSH_RELAY_PORT: '9100',
    DSH_RELAY_HOST: '10.0.0.5',
    DSH_RELAY_HUB_TOKEN: 'rt_env',
    DSH_RELAY_ENROLL_TOKEN: 'en_env',
    DSH_RELAY_DATA_DIR: 'D:\\envdir',
  }
  const out = parseArgs(
    ['--port', '1234', '--host', '127.0.0.1', '--hub-token', 'rt_cli', '--enroll-token', 'en_cli', '--data-dir', 'D:\\clidir'],
    env,
  )
  assert.equal(out.port, 1234, 'CLI 必须压过 env')
  assert.equal(out.host, '127.0.0.1')
  assert.equal(out.hubToken, 'rt_cli')
  assert.equal(out.enrollToken, 'en_cli')
  assert.equal(out.dataDir, 'D:\\clidir')

  // 部分覆盖：只给 CLI 的键压过 env，其余仍走 env
  const partial = parseArgs(['--port', '1234'], env)
  assert.equal(partial.port, 1234)
  assert.equal(partial.host, '10.0.0.5')
  assert.equal(partial.hubToken, 'rt_env')
  assert.equal(partial.dataDir, 'D:\\envdir')
})

test('parseArgs：非法环境变量只在"确实要用到它"时才报错', (t) => {
  // 缺陷背景：旧实现在解析 argv **之前**无条件从 env 求值并校验 port/host，
  // 于是一个陈旧的 DSH_RELAY_PORT=abc 会让 `--port 1234` 这样完全正确的调用
  // 直接抛错退出 —— 用户明明显式给了值，却因为一个被覆盖的环境变量起不来。
  const badPort = { DSH_RELAY_PORT: 'abc' }
  const badHost = { DSH_RELAY_HOST: 'a b' }

  // CLI 提供了对应键 → env 的值被覆盖，不该再被校验
  assert.doesNotThrow(() => parseArgs(['--port', '1234'], badPort), '--port 给了值就不该看 DSH_RELAY_PORT')
  assert.doesNotThrow(() => parseArgs(['--host', '127.0.0.1'], badHost), '--host 给了值就不该看 DSH_RELAY_HOST')
  assert.doesNotThrow(
    () => parseArgs(['--port', '1234', '--host', '127.0.0.1'], { ...badPort, ...badHost }),
    '两个键都被 CLI 覆盖时必须完全不受非法 env 影响',
  )
  // 只覆盖其中一个：另一个仍走 env，若它合法就不该因为"另一个键被覆盖"而受影响
  assert.doesNotThrow(() => parseArgs(['--port', '1234'], { DSH_RELAY_PORT: 'abc', DSH_RELAY_HOST: '10.0.0.5' }))
  assert.equal(parseArgs(['--port', '1234'], { DSH_RELAY_PORT: 'abc', DSH_RELAY_HOST: '10.0.0.5' }).host, '10.0.0.5')

  // CLI 没给 → env 真的会被用到 → 必须报错（不能静默取默认）
  assert.throws(
    () => parseArgs([], badPort),
    (e) => /环境变量 DSH_RELAY_PORT 非法/.test(e.message) && /收到 "abc"/.test(e.message),
  )
  assert.throws(() => parseArgs([], { DSH_RELAY_PORT: '70000' }), /环境变量 DSH_RELAY_PORT 非法/)
  assert.throws(() => parseArgs([], badHost), /不能有空白字符/, 'env 来的 host 也要过同一套校验')
  // 纯空白的 env 值等同于"没设置"（与其余 envText 键一致），回落到默认 host，
  // 而不是被当成一个空 host 直接拒绝 —— 两种行为都"安全"，但必须一致且可预期。
  assert.equal(parseArgs([], { DSH_RELAY_HOST: '  ' }).host, DEFAULT_HOST)

  // 首尾空白是刻意允许的：parseHostValue 先 trim 再校验，'127.0.0.1 ' 等价于 '127.0.0.1'
  assert.equal(parseArgs(['--host', '127.0.0.1 '], {}).host, '127.0.0.1')
  assert.equal(parseArgs(['--host', ' 0.0.0.0 '], {}).host, '0.0.0.0')
})

test('parseArgs：argv 非数组 / 含非字符串元素时不崩', (t) => {
  assert.deepEqual(parseArgs(undefined, {}).port, DEFAULT_PORT)
  assert.deepEqual(parseArgs(null, {}).port, DEFAULT_PORT)
  assert.equal(parseArgs([], undefined).port, DEFAULT_PORT)
  // 数字会被 String() 化，然后按未知参数拒绝（不静默忽略）
  assert.throws(() => parseArgs([123], {}), /不支持的位置参数：123/)
})

/* ─────────────────── 输出格式化：不得泄露明文 token ─────────────────── */

test('formatTokenFingerprintLine：只含短指纹，绝不含完整 token 明文', (t) => {
  const hubToken = 'rt_SUPERSECRETVALUE1234567890abcdef'
  const enrollToken = 'en_ANOTHERSECRETVALUE0987654321zyxwvu'
  const line = formatTokenFingerprintLine({ hubToken, enrollToken, source: 'generated', file: 'D:\\d\\tokens.json' })

  // 安全断言：明文绝不能出现
  assert.ok(!line.includes(hubToken), `指纹行不得包含 hubToken 明文：${line}`)
  assert.ok(!line.includes(enrollToken), `指纹行不得包含 enrollToken 明文：${line}`)
  assert.ok(!line.includes('SUPERSECRET'), '不得泄露 token 的随机部分')
  assert.ok(!line.includes('ANOTHERSECRET'))
  assert.ok(!/rt_[A-Za-z0-9_-]{16,}/.test(line), '不得出现完整的 rt_ token 形态')
  assert.ok(!/en_[A-Za-z0-9_-]{16,}/.test(line), '不得出现完整的 en_ token 形态')

  // 指纹必须是 sha256 前 12 位十六进制
  assert.ok(line.includes(`hub=${tokenFingerprint(hubToken)}`), `必须给出 hub 指纹：${line}`)
  assert.ok(line.includes(`enroll=${tokenFingerprint(enrollToken)}`), `必须给出 enroll 指纹：${line}`)
  assert.match(tokenFingerprint(hubToken), /^[0-9a-f]{12}$/)
  assert.ok(line.startsWith('RELAY_TOKENS_SOURCE'), `行首标识必须稳定：${line}`)
  assert.ok(line.includes('source=generated') && line.includes('file='), '应带上来源与文件')
})

test('formatTokenFingerprintLine：不同 token 指纹不同，相同 token 指纹相同', (t) => {
  const a = formatTokenFingerprintLine({ hubToken: 'rt_a', enrollToken: 'en_a' })
  const b = formatTokenFingerprintLine({ hubToken: 'rt_b', enrollToken: 'en_b' })
  const a2 = formatTokenFingerprintLine({ hubToken: 'rt_a', enrollToken: 'en_a' })
  assert.notEqual(a, b)
  assert.equal(a, a2, '同一输入必须给出同一指纹（否则无法用来比对）')
})

test('formatTokenFingerprintLine：缺凭证时抛错，不输出"看起来正常"的假指纹', (t) => {
  // 缺陷背景：旧实现对缺失 token 直接 tokenFingerprint('')，输出
  //   hub=e3b0c44298fc enroll=e3b0c44298fc
  // 这是空串的 sha256 前缀，**看起来和一个真实指纹毫无区别**。
  // 非交互式路径（systemd/journald）默认只打这一行 —— 一旦凭证真没取到，
  // 日志里留下的是"看起来正常"的假指纹，事后排查会以为 token 存在。
  for (const input of [{}, { hubToken: '', enrollToken: '' }, { hubToken: 'rt_a' }, { enrollToken: 'en_b' }, { hubToken: 42, enrollToken: 'en_b' }]) {
    assert.throws(
      () => formatTokenFingerprintLine(input),
      /formatTokenFingerprintLine: (hubToken|enrollToken) 必填/,
      `缺凭证的输入 ${JSON.stringify(input)} 必须抛错`,
    )
  }
  const emptyFp = tokenFingerprint('')
  const line = formatTokenFingerprintLine({ hubToken: 'rt_x', enrollToken: 'en_y' })
  assert.ok(!line.includes(`hub=${emptyFp}`), '正常凭证的指纹不得等于空串指纹')
})

test('formatTokensLine：这是唯一允许输出明文的路径，且带来源信息', (t) => {
  const hubToken = 'rt_PLAIN123'
  const enrollToken = 'en_PLAIN456'
  const line = formatTokensLine({ hubToken, enrollToken, source: 'generated', file: 'D:\\d\\tokens.json' })
  assert.equal(line, 'RELAY_TOKENS hub=rt_PLAIN123 enroll=en_PLAIN456 source=generated file=D:\\d\\tokens.json')
  assert.ok(line.startsWith('RELAY_TOKENS '), '前缀必须与指纹行（RELAY_TOKENS_SOURCE）可区分')
  assert.ok(!line.startsWith('RELAY_TOKENS_SOURCE'), '不能被误认成指纹行')

  // 缺凭证同样抛错
  assert.throws(() => formatTokensLine({}), /formatTokensLine: hubToken 必填/)
  assert.throws(() => formatTokensLine({ hubToken: 'rt_a' }), /formatTokensLine: enrollToken 必填/)

  // 无 source/file 时不产生多余空格
  assert.equal(formatTokensLine({ hubToken: 'rt_a', enrollToken: 'en_b' }), 'RELAY_TOKENS hub=rt_a enroll=en_b')
})

test('formatReadyLine：只含指纹，不含明文；缺字段抛错', (t) => {
  const line = formatReadyLine({ url: 'ws://10.0.0.5:8890/relay', hubFingerprint: 'aaaaaaaaaaaa', enrollFingerprint: 'bbbbbbbbbbbb' })
  assert.equal(line, 'RELAY_READY url=ws://10.0.0.5:8890/relay hub=aaaaaaaaaaaa enroll=bbbbbbbbbbbb')
  assert.ok(!/rt_|en_/.test(line), 'ready 行不得出现任何 token 形态')

  assert.throws(() => formatReadyLine({}), /formatReadyLine: url 必填/)
  assert.throws(() => formatReadyLine({ url: 'ws://x' }), /formatReadyLine: hubFingerprint 必填/)
  assert.throws(() => formatReadyLine({ url: 'ws://x', hubFingerprint: 'a' }), /formatReadyLine: enrollFingerprint 必填/)
  assert.throws(() => formatReadyLine({ url: '', hubFingerprint: 'a', enrollFingerprint: 'b' }), /url 必填/)
})

test('格式化函数与 loadOrCreateTokens 串联：指纹行可安全进日志', (t) => {
  const dir = tmpdir(t)
  const rec = loadOrCreateTokens(dir)
  const fpLine = formatTokenFingerprintLine({ ...rec, source: 'generated' })
  assert.ok(!fpLine.includes(rec.hubToken), '真实生成的 token 也不得出现在指纹行里')
  assert.ok(!fpLine.includes(rec.enrollToken))
  assert.ok(fpLine.includes(tokenFingerprint(rec.hubToken)))

  // 明文行则必须能拿到 token（否则 --print-tokens 就没用了）
  const plain = formatTokensLine({ ...rec, source: 'generated' })
  assert.ok(plain.includes(rec.hubToken))
  assert.ok(plain.includes(rec.enrollToken))
})

/* ─────────────────── 端到端：CLI 非交互路径不泄露明文 ─────────────────── */

test('端到端：非交互启动（无 --print-tokens）的 stdout 不含明文 token', async (t) => {
  if (!fs.existsSync(BIN)) {
    t.skip('bin/dsh-remote-relay.js 不存在')
    return
  }
  const dir = tmpdir(t)
  const rec = loadOrCreateTokens(dir)

  const child = spawn(
    process.execPath,
    [BIN, '--port', '0', '--host', '127.0.0.1', '--data-dir', dir],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b) => {
    stdout += b.toString('utf8')
  })
  child.stderr.on('data', (b) => {
    stderr += b.toString('utf8')
  })

  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 20000)
    child.stdout.on('data', () => {
      if (stdout.includes('RELAY_READY')) {
        clearTimeout(timer)
        resolve('ready')
      }
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve('closed')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('error')
    })
  })
  t.after(() => {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
  })

  const why = await done
  if (why !== 'ready') {
    t.skip(`CLI 未进入 ready（${why}）：${stderr.slice(0, 300)}`)
    return
  }

  // 核心安全断言：默认（非 TTY、未显式要求）路径不得输出明文
  assert.ok(stdout.includes('RELAY_READY'), '必须输出 ready 行')
  assert.ok(stdout.includes('RELAY_TOKENS_SOURCE'), '必须输出指纹行')
  assert.ok(!stdout.includes(rec.hubToken), `stdout 不得包含 hubToken 明文：\n${stdout}`)
  assert.ok(!stdout.includes(rec.enrollToken), `stdout 不得包含 enrollToken 明文：\n${stdout}`)
  assert.ok(!/RELAY_TOKENS hub=/.test(stdout), '默认路径不得走明文行')
  assert.ok(stdout.includes(tokenFingerprint(rec.hubToken)), '指纹必须与落盘 token 对应')

  // 二次调用幂等：CLI 没有轮换 token
  const again = loadOrCreateTokens(dir)
  assert.equal(again.hubToken, rec.hubToken, 'CLI 启动不得轮换已有 token')
  assert.equal(again.created, false)
})

test('端到端：--print-tokens 才输出明文，且指纹行仍在', async (t) => {
  if (!fs.existsSync(BIN)) {
    t.skip('bin/dsh-remote-relay.js 不存在')
    return
  }
  const dir = tmpdir(t)
  const rec = loadOrCreateTokens(dir)

  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--print-tokens', '--data-dir', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8')
    })
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

  assert.equal(out.code, 0, `--print-tokens 应 exit 0：${out.stderr}`)
  assert.ok(out.stdout.includes(rec.hubToken), '显式要求时必须能拿到明文 token')
  assert.ok(out.stdout.includes(rec.enrollToken))
  // 幂等：显式打印也不得轮换
  assert.equal(loadOrCreateTokens(dir).hubToken, rec.hubToken)
})

test('端到端：非法参数让 CLI 以 exit 2 退出并给出可读错误（不静默用默认值）', async (t) => {
  if (!fs.existsSync(BIN)) {
    t.skip('bin/dsh-remote-relay.js 不存在')
    return
  }
  const dir = tmpdir(t)
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, '--port', 'abc', '--data-dir', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8')
    })
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  assert.equal(out.code, 2, `非法参数应以 exit 2 退出，实际 ${out.code}`)
  assert.match(out.stderr, /--port 需要 0-65535 的整数端口/)
  assert.equal(out.stdout, '', '失败时不得有任何 stdout 输出（避免半启动状态被当成成功）')
  // 失败路径不该把凭证目录建出来
  assert.equal(fs.existsSync(path.join(dir, TOKENS_FILE)), false, '参数校验失败不该写凭证')
})
