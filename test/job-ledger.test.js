import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function fixture(t, options = {}) {
  const { createJobLedger } = await import('../lib/node/job-ledger.js')
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ra-jobs-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'work')
  const procRoot = path.join(dir, 'proc')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(root)
  fs.mkdirSync(procRoot)
  const boot = 1_800_000_000_000
  let at = boot + 100_000
  fs.writeFileSync(path.join(procRoot, 'stat'), `cpu 0 0 0\nbtime ${boot / 1000}\n`)
  const logs = []
  const config = { stateDir, roots: [root], procRoot, now: () => at, logger: { warn: (...args) => logs.push(args) }, ...options }
  const ledger = createJobLedger(config)
  function proc(pid, { cwd = root, ppid = 1, start = 1000, args = ['python3', '-u', 'openapi_v3.py'], comm = 'python (worker)', status = 'S' } = {}) {
    const base = path.join(procRoot, String(pid))
    fs.mkdirSync(base, { recursive: true })
    const fields = Array(50).fill('0')
    fields[0] = status // field 3
    fields[1] = String(ppid) // field 4
    fields[19] = String(start) // field 22, USER_HZ=100
    fs.writeFileSync(path.join(base, 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`)
    fs.writeFileSync(path.join(base, 'cmdline'), args.join('\0') + '\0')
    fs.symlinkSync(cwd, path.join(base, 'cwd'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return { ledger, config, dir, root, stateDir, procRoot, proc, boot, logs, advance(ms) { at += ms }, at: () => at }
}

test('1 discovers detached long runners with stable IDs and descending start times', async t => {
  const h = await fixture(t)
  h.proc(301)
  h.proc(302, { start: 2000, args: ['bash', 'other.sh'] })
  const jobs = await h.ledger.scan()
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].pid, 302)
  assert.equal(jobs[1].startedAt, h.boot + 10_000)
  assert.equal(jobs[1].name, 'openapi_v3.py')
  assert.equal(jobs[1].status, 'running')
  h.advance(15_000)
  assert.deepEqual((await h.ledger.scan()).map(j => j.id), jobs.map(j => j.id))
  jobs[0].name = 'mutated'
  assert.equal(h.ledger.list()[0].name, 'other.sh')
})

test('2 excludes dsh/remote-agent, outside roots, attached, young and own processes', async t => {
  const h = await fixture(t)
  h.proc(301)
  h.proc(302, { args: ['node', '/opt/dsh/bin/dsh.js'] })
  h.proc(303, { args: ['node', '/opt/dsh-remote-agent/bin/worker.js'] })
  h.proc(304, { cwd: h.dir })
  h.proc(305, { ppid: 99 })
  h.proc(306, { start: 8000 }) // exactly 20s: excluded
  h.proc(process.pid)
  const sibling = `${h.root}-other`
  fs.mkdirSync(sibling)
  h.proc(307, { cwd: sibling })
  h.proc(308, { args: ['node', '--trace-warnings', '/opt/dsh-remote-agent/bin/worker.js'] })
  assert.deepEqual((await h.ledger.scan()).map(j => j.pid), [301])
})

test('3 marks only later same-cwd same-script runners as duplicateOf', async t => {
  const h = await fixture(t)
  h.proc(301)
  h.proc(302, { start: 2000, args: ['python3', '-u', 'openapi_v3.py', '--retry'] })
  h.proc(303, { args: ['python3', 'different.py'] })
  const other = path.join(h.root, 'other')
  fs.mkdirSync(other)
  h.proc(304, { cwd: other })
  const jobs = await h.ledger.scan()
  const first = jobs.find(j => j.pid === 301)
  assert.equal(jobs.find(j => j.pid === 302).duplicateOf, first.id)
  for (const pid of [301, 303, 304]) assert.equal(jobs.find(j => j.pid === pid).duplicateOf, undefined)
  await h.ledger.register({ pid: 302, name: 'retry metadata' })
  assert.equal(h.ledger.list().find(j => j.pid === 302).duplicateOf, first.id)
})

test('4 missing process becomes done, retains endedAt, reloads and expires after seven days', async t => {
  const h = await fixture(t)
  h.proc(301)
  await h.ledger.scan()
  fs.rmSync(path.join(h.procRoot, '301'), { recursive: true })
  h.advance(15_000)
  const [job] = await h.ledger.scan()
  assert.equal(job.status, 'done')
  assert.equal(job.endedAt, h.at())
  const { createJobLedger } = await import('../lib/node/job-ledger.js')
  const restored = createJobLedger(h.config)
  assert.deepEqual(await restored.scan(), [job])
  h.advance(7 * 86400_000 + 1)
  assert.deepEqual(await restored.scan(), [])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'jobs.json'), 'utf8')), [])
})

test('5 reads explicit and inferred progress, including partial lines; missing file is tolerated', async t => {
  const h = await fixture(t)
  h.proc(301)
  const progress = path.join(h.root, 'res_openapi.tsv')
  fs.writeFileSync(progress, 'a\tb\nc\td\ne\tf')
  let [job] = await h.ledger.scan()
  assert.equal(job.progressFile, progress)
  assert.equal(job.progressLines, 3)
  assert.equal(job.progressMtime, fs.statSync(progress).mtimeMs)
  fs.writeFileSync(path.join(h.root, 'custom.tsv'), 'one\n')
  await h.ledger.register({ pid: 301, name: 'custom', progressFile: 'custom.tsv' })
  ;[job] = await h.ledger.scan()
  assert.equal(job.name, 'custom')
  assert.equal(job.progressLines, 1)
  fs.rmSync(path.join(h.root, 'custom.tsv'))
  await assert.doesNotReject(() => h.ledger.scan())
  assert.equal(h.ledger.list()[0].progressLines, undefined)
})

test('6 unwritable stateDir degrades with logging and still returns discovered jobs', async t => {
  const h = await fixture(t)
  fs.writeFileSync(h.stateDir, 'not a directory') // deterministic even under root
  h.proc(301)
  assert.equal((await h.ledger.scan()).length, 1)
  assert.ok(h.logs.length > 0)
})

test('unreadable procRoot preserves previous running records and logs', async t => {
  const h = await fixture(t)
  h.proc(301)
  const jobs = await h.ledger.scan()
  fs.renameSync(h.procRoot, `${h.procRoot}-gone`)
  assert.deepEqual(await h.ledger.scan(), jobs)
  assert.ok(h.logs.length > 0)
})

test('PID reuse creates a new identity, unreadable stat becomes lost, recovered process runs again', async t => {
  const h = await fixture(t)
  h.proc(301)
  const [old] = await h.ledger.scan()
  fs.rmSync(path.join(h.procRoot, '301'), { recursive: true })
  h.proc(301, { start: 2000 })
  let jobs = await h.ledger.scan()
  assert.equal(jobs.length, 2)
  assert.equal(jobs.find(j => j.id === old.id).status, 'done')
  const current = jobs.find(j => j.status === 'running')
  const stat = path.join(h.procRoot, '301', 'stat')
  const source = fs.readFileSync(stat)
  fs.writeFileSync(stat, 'invalid')
  jobs = await h.ledger.scan()
  assert.equal(jobs.find(j => j.id === current.id).status, 'lost')
  fs.writeFileSync(stat, source)
  jobs = await h.ledger.scan()
  assert.equal(jobs.find(j => j.id === current.id).status, 'running')
  assert.equal(jobs.find(j => j.id === current.id).endedAt, undefined)
})

test('symlink roots resolve to the same workspace', async t => {
  const h = await fixture(t)
  const alias = path.join(h.dir, 'alias')
  fs.symlinkSync(h.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const { createJobLedger } = await import('../lib/node/job-ledger.js')
  const ledger = createJobLedger({ ...h.config, roots: [alias] })
  h.proc(301)
  assert.equal((await ledger.scan()).length, 1)
})

test('a still-alive process leaving roots is lost rather than completed', async t => {
  const h = await fixture(t)
  h.proc(301)
  await h.ledger.scan()
  const link = path.join(h.procRoot, '301', 'cwd')
  fs.unlinkSync(link)
  fs.symlinkSync(h.dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await h.ledger.scan())[0].status, 'lost')
})

test('Windows roots use win32 boundaries and case-insensitive duplicate cwd keys', async t => {
  const h = await fixture(t, { roots: ['C:\\Work'] })
  for (const pid of [301, 302, 303, 304]) h.proc(pid, { start: pid === 302 ? 2000 : 1000 })
  const cwds = { 301: 'C:\\WORK\\task', 302: 'c:\\work\\TASK', 303: 'C:\\Work-other', 304: 'D:\\Work' }
  t.mock.method(fs.promises, 'readlink', async file => cwds[path.basename(path.dirname(file))])
  t.mock.method(fs.promises, 'realpath', async value => value)
  const jobs = await h.ledger.scan()
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].pid, 302)
  assert.equal(jobs[0].duplicateOf, jobs[1].id)
})
