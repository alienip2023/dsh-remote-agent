/** Detached Linux processes are observations, independent of TaskEngine scheduling. */
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from '../identity.js'

const RETENTION_MS = 7 * 86400_000
// Linux /proc/<pid>/stat exports starttime in USER_HZ (100 ticks/s).
const TICK_MS = 10

function pathsFor(value) {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value) ? path.win32 : path.posix
}

function directoryKey(value) {
  const paths = pathsFor(value)
  const normalized = paths.normalize(value)
  return paths === path.win32 ? normalized.toLowerCase() : normalized
}

function inside(cwd, root) {
  const paths = pathsFor(root)
  if (!paths.isAbsolute(cwd)) return false
  const relative = paths.relative(root, cwd)
  return relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
}

function scriptName(argv) {
  const executable = path.posix.basename((argv[0] ?? '').replaceAll('\\', '/'))
  if (/^(?:python[\d.]*|node|nodejs|bash|sh|zsh|perl|ruby)(?:\.exe)?$/i.test(executable)) {
    // -m/-c/-e identify modules or inline programs, rather than script files.
    const option = argv.findIndex(arg => ['-m', '-c', '-e'].includes(arg))
    if (option > 0) return `${executable} ${argv[option]} ${argv[option + 1] ?? ''}`
    const script = argv.slice(1).find(arg => !arg.startsWith('-'))
    if (script) return path.posix.basename(script.replaceAll('\\', '/'))
  }
  return executable
}

function isAgent(argv) {
  // Inspect executable/script positions, not arbitrary task arguments or cwd names.
  const script = argv.slice(1).find(arg => !arg.startsWith('-')) ?? ''
  const command = `${argv[0]}/${script}`.replaceAll('\\', '/')
  return /(?:^|\/)(?:dsh(?:\.cmd|\.exe|\.js)?|(?:dsh-)?remote-agent(?:[/.]|$))(?:\/|$)?/i.test(command)
}

export function createJobLedger({ stateDir, roots = [], procRoot = '/proc', now = Date.now, logger } = {}) {
  const records = new Map()
  const file = typeof stateDir === 'string' && stateDir ? path.join(stateDir, 'jobs.json') : ''
  const warn = (message, error) => {
    try { logger?.warn?.(message, { error: String(error?.message ?? error ?? '') }) } catch { /* logger is optional */ }
  }
  const clock = () => {
    try { const value = now(); if (Number.isFinite(value)) return value } catch { /* use wall clock */ }
    return Date.now()
  }
  const allowed = []
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !pathsFor(root).isAbsolute(root)) continue
    try { allowed.push(fs.realpathSync(root)) } catch { allowed.push(pathsFor(root).normalize(root)) }
  }
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(saved)) throw new Error('jobs.json must contain an array')
      for (const rec of saved) {
        if (!rec || typeof rec.id !== 'string' || typeof rec.name !== 'string' || typeof rec.cmd !== 'string' ||
            typeof rec.cwd !== 'string' || !Number.isSafeInteger(rec.pid) || rec.pid < 1 ||
            !Number.isFinite(rec.startedAt) || !['running', 'done', 'lost'].includes(rec.status)) continue
        const copy = { id: rec.id, name: rec.name, cmd: rec.cmd, cwd: rec.cwd, pid: rec.pid, startedAt: rec.startedAt, status: rec.status }
        for (const key of ['progressFile', 'script']) if (typeof rec[key] === 'string') copy[key] = rec[key]
        for (const key of ['progressLines', 'progressMtime', 'endedAt']) if (Number.isFinite(rec[key]) && rec[key] >= 0) copy[key] = rec[key]
        if (copy.status !== 'running') copy.endedAt ??= clock()
        records.set(copy.id, copy)
      }
    } catch (err) { if (err.code !== 'ENOENT') warn('job ledger load failed', err) }
  }

  function list() {
    return [...records.values()].sort((a, b) => b.startedAt - a.startedAt || b.pid - a.pid).map(rec => {
      const view = { ...rec }
      delete view.script
      return view
    })
  }

  function duplicates() {
    const first = new Map()
    for (const rec of [...records.values()].sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)) {
      delete rec.duplicateOf
      if (rec.status !== 'running') continue
      const key = JSON.stringify([directoryKey(rec.cwd), rec.script ?? scriptName(rec.cmd.split(' '))])
      if (first.has(key)) rec.duplicateOf = first.get(key)
      else first.set(key, rec.id)
    }
  }

  function persist() {
    if (!file) { warn('job ledger persistence disabled', 'stateDir unavailable'); return }
    try { writeJsonAtomic(file, [...records.values()]) } catch (err) { warn('job ledger save failed', err) }
  }

  async function progress(rec) {
    try {
      if (!rec.progressFile) {
        const files = (await fs.promises.readdir(rec.cwd)).filter(name => /^res.*\.tsv$/i.test(name)).sort()
        if (files.length) rec.progressFile = path.join(rec.cwd, files[0])
      }
      if (!rec.progressFile) return
      const target = path.isAbsolute(rec.progressFile) ? rec.progressFile : path.resolve(rec.cwd, rec.progressFile)
      const stat = await fs.promises.stat(target)
      if (!stat.isFile()) { delete rec.progressLines; delete rec.progressMtime; return }
      if (rec.progressMtime === stat.mtimeMs && Number.isSafeInteger(rec.progressLines)) return
      let lines = 0
      let last = 10
      let bytes = 0
      for await (const chunk of stat.size ? fs.createReadStream(target, { end: stat.size - 1 }) : []) {
        bytes += chunk.length
        for (const byte of chunk) if (byte === 10) lines++
        if (chunk.length) last = chunk[chunk.length - 1]
      }
      rec.progressLines = lines + (bytes > 0 && last !== 10 ? 1 : 0)
      rec.progressMtime = stat.mtimeMs
    } catch (err) {
      delete rec.progressLines
      delete rec.progressMtime
      if (err.code !== 'ENOENT') warn('job progress unavailable', err)
    }
  }

  async function scanOnce() {
    const at = clock()
    let entries
    let boot
    try {
      entries = await fs.promises.readdir(procRoot)
      const stat = await fs.promises.readFile(path.join(procRoot, 'stat'), 'utf8')
      const match = stat.match(/^btime (\d+)$/m)
      if (!match) throw new Error('proc stat btime missing')
      boot = Number(match[1]) * 1000
    } catch (err) { warn('job process scan unavailable', err); return list() }

    const seen = new Set()
    const uncertain = new Set()
    const alive = new Set()
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue
      try {
        const base = path.join(procRoot, entry)
        const stat = await fs.promises.readFile(path.join(base, 'stat'), 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
        const ppid = Number(fields[1])
        const ticks = Number(fields[19])
        if (!Number.isSafeInteger(ticks) || ticks < 0 || !Number.isSafeInteger(ppid)) throw new Error(`invalid proc stat for ${pid}`)
        const startedAt = boot + ticks * TICK_MS
        const id = `${pid}-${startedAt}`
        if (['Z', 'X'].includes(fields[0])) continue
        alive.add(id)
        const linkedCwd = await fs.promises.readlink(path.join(base, 'cwd'))
        const cwd = await fs.promises.realpath(linkedCwd)
        const raw = await fs.promises.readFile(path.join(base, 'cmdline'), 'utf8')
        const argv = raw.split('\0').filter(Boolean)
        if (ppid !== 1 || !allowed.some(root => inside(cwd, root))) continue
        if (at - startedAt <= 20_000 || !argv.length || isAgent(argv)) continue
        const script = scriptName(argv)
        const rec = records.get(id) ?? { id, name: script, cmd: argv.join(' '), cwd, pid, startedAt, status: 'running' }
        rec.cmd = argv.join(' ')
        rec.cwd = cwd
        rec.script = script
        rec.status = 'running'
        delete rec.endedAt
        records.set(id, rec)
        seen.add(id)
      } catch (err) {
        // Only absence proves completion; permissions, malformed stat and races are uncertain.
        let exists = true
        try { await fs.promises.stat(path.join(procRoot, entry)) } catch (checkErr) {
          exists = checkErr.code !== 'ENOENT' && checkErr.code !== 'ESRCH'
        }
        if (exists) { uncertain.add(pid); warn('job process unreadable', err) }
      }
    }
    for (const rec of records.values()) {
      if (!seen.has(rec.id) && ['running', 'lost'].includes(rec.status)) {
        rec.status = uncertain.has(rec.pid) || alive.has(rec.id) ? 'lost' : 'done'
        rec.endedAt ??= at
      }
      if (rec.status !== 'running' && at - rec.endedAt > RETENTION_MS) { records.delete(rec.id); continue }
      await progress(rec)
    }
    duplicates()
    persist()
    return list()
  }

  // Serialize scans and metadata updates, including disk writes and large progress reads.
  let tail = Promise.resolve()
  const enqueue = action => {
    tail = tail.then(action).catch(err => { warn('job ledger operation failed', err); return list() })
    return tail
  }
  duplicates()
  return {
    scan: () => enqueue(scanOnce),
    list,
    register: (metadata = {}) => enqueue(async () => {
      const rec = [...records.values()].find(item => item.pid === metadata?.pid && item.status === 'running')
      if (!rec) return list()
      if (typeof metadata.name === 'string' && metadata.name.trim()) rec.name = metadata.name.trim()
      if (typeof metadata.progressFile === 'string' && metadata.progressFile) {
        rec.progressFile = metadata.progressFile
        delete rec.progressMtime
        delete rec.progressLines
      }
      await progress(rec)
      duplicates()
      persist()
      return list()
    }),
  }
}
