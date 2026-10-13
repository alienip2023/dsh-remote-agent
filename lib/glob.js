/**
 * 跨平台 glob 匹配（零依赖）。
 *
 * Windows 语义是硬需求，所以这里显式处理：
 *   - 分隔符：`/` 与 `\` 等价，匹配前统一成 `/`
 *   - 大小写：Windows / macOS 默认不敏感，Linux 敏感 —— 由 caseInsensitive 决定
 *   - 盘符：`C:\work` 与 `c:/work` 视为同一路径
 *   - `**` 跨目录、`*` 不跨分隔符、`{a,b}` 或、`?` 单字符
 *
 * 只做匹配，不做文件系统枚举（枚举在 artifacts.js 里，用 node:fs）。
 */

const SEP_RE = /[\\/]+/g

/**
 * 归一化为匹配用的规范形式：`/` 分隔、去尾分隔。
 *
 * UNC 处理（D1-1 修复）：`\\server\share\x` 统一折叠成 `/server/share/x`。
 * 早期版本这里写 `if (/^\/\//.test(s)) s = '/' + s.replace(/^\/+/, '')` ——
 * 那是个**空操作**（正则匹配的 `//` 先被 `SEP_RE` 折成 `/`，所以条件永远不成立），
 * 但注释声称"保留 UNC 前缀的双斜杠"，与行为不符。
 *
 * 选择折叠而不是保留，理由是 `isInside` 用在**安全边界**上：
 *   - 折叠后 `/server/share` 与 POSIX 路径同形，前缀比较语义一致且可预测
 *   - 若保留双斜杠，`//server/share` 与 `/server/share` 会成为两个不同的字符串，
 *     同一条路径两种写法可能绕过前缀比较 —— 那才是真正的安全隐患
 * 所以注释改为与行为一致，并明确这是刻意的折叠。
 */
export function normalizePath(p, { caseInsensitive = false } = {}) {
  if (typeof p !== 'string') return ''
  let s = p.replace(SEP_RE, '/')
  // 折叠后可能留下多重前导斜杠（如 `\\?\C:\x` 或 `////x`），统一成一个
  if (s.length > 1 && s.startsWith('/')) s = `/${s.replace(/^\/+/, '')}`
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '')
  if (caseInsensitive) s = s.toLowerCase()
  return s
}

/** 判断是否绝对路径（POSIX / 盘符 / UNC）。 */
export function isAbsolutePath(p) {
  if (typeof p !== 'string' || p === '') return false
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)
}

/**
 * 判断 child 是否在 parent 之内（含相等）。
 * 用于工作区白名单校验 —— 必须是纯字符串判断，不能依赖 fs 真实路径，
 * 否则符号链接会让校验结果和实际写入位置不一致。
 */
export function isInside(parent, child, opts = {}) {
  const a = normalizePath(parent, opts)
  const b = normalizePath(child, opts)
  if (a === '' || b === '') return false
  if (a === b) return true
  return b.startsWith(a.endsWith('/') ? a : `${a}/`)
}

const cache = new Map()

/**
 * 把 glob 编译成正则。
 * 支持：`**` `*` `?` `{a,b,c}` `[abc]`，以及前导 `!`（由调用方处理取反）。
 */
export function globToRegExp(pattern, { caseInsensitive = false } = {}) {
  const key = `${caseInsensitive ? 'i' : 's'}\u0000${pattern}`
  const hit = cache.get(key)
  if (hit) return hit

  const pat = normalizePath(pattern, { caseInsensitive })
  let re = ''
  for (let i = 0; i < pat.length; i += 1) {
    const c = pat[i]
    if (c === '*') {
      const isDouble = pat[i + 1] === '*'
      if (isDouble) {
        // `**/` 吃掉零个或多个目录段；裸 `**` 匹配任意（含分隔符）
        if (pat[i + 2] === '/') {
          re += '(?:[^/]*/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
      continue
    }
    if (c === '?') {
      re += '[^/]'
      continue
    }
    if (c === '{') {
      const close = findClosingBrace(pat, i)
      if (close > i) {
        const body = pat.slice(i + 1, close)
        const alts = splitTopLevel(body)
        re += `(?:${alts.map((a) => escapeRe(a)).join('|')})`
        i = close
        continue
      }
      re += '\\{'
      continue
    }
    if (c === '[') {
      const close = pat.indexOf(']', i + 1)
      if (close > i + 1) {
        const body = pat.slice(i + 1, close)
        re += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        i = close
        continue
      }
      re += '\\['
      continue
    }
    re += escapeRe(c)
  }

  const compiled = new RegExp(`^${re}$`, caseInsensitive ? 'i' : '')
  cache.set(key, compiled)
  return compiled
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findClosingBrace(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1
    else if (s[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevel(body) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of body) {
    if (c === '{') depth += 1
    if (c === '}') depth -= 1
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur !== '') out.push(cur)
  return out.length > 0 ? out : ['']
}

/**
 * 匹配一个路径。
 * pattern 支持：绝对 glob、相对 glob（相对 base）、前导 `!` 取反。
 * @param {string} path 待匹配路径
 * @param {string|string[]} patterns
 */
export function matchGlob(path, patterns, { caseInsensitive = false, base = '' } = {}) {
  const list = Array.isArray(patterns) ? patterns : [patterns]
  let matched = false
  for (const raw of list) {
    if (typeof raw !== 'string' || raw === '') continue
    const negate = raw.startsWith('!')
    const body = negate ? raw.slice(1) : raw
    const absolute = isAbsolutePath(body)
    const pattern = absolute || base === '' ? body : `${normalizePath(base, { caseInsensitive })}/${body}`
    if (globToRegExp(pattern, { caseInsensitive }).test(normalizePath(path, { caseInsensitive }))) {
      if (negate) return false
      matched = true
    }
  }
  return matched
}

/** 编译一组规则，返回判定函数，避免逐文件重复编译。 */
export function compileRules(rules, { caseInsensitive = false, base = '' } = {}) {
  const prepared = []
  for (const raw of rules ?? []) {
    if (typeof raw !== 'string' || raw === '') continue
    const negate = raw.startsWith('!')
    const body = negate ? raw.slice(1) : raw
    const pattern = isAbsolutePath(body) || base === '' ? body : `${normalizePath(base, { caseInsensitive })}/${body}`
    prepared.push({ negate, re: globToRegExp(pattern, { caseInsensitive }) })
  }
  return (path) => {
    const p = normalizePath(path, { caseInsensitive })
    let matched = false
    for (const r of prepared) {
      if (r.re.test(p)) {
        if (r.negate) return false
        matched = true
      }
    }
    return matched
  }
}

/** 从路径取扩展名（小写，含点）。 */
export function extname(p) {
  const s = normalizePath(p)
  const base = s.slice(s.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i).toLowerCase() : ''
}

/** 路径的父目录（规范形式）。 */
export function dirname(p) {
  const s = normalizePath(p)
  const i = s.lastIndexOf('/')
  if (i < 0) return ''
  if (i === 0) return '/'
  return s.slice(0, i)
}

/** 路径最后一段。 */
export function basename(p) {
  const s = normalizePath(p)
  return s.slice(s.lastIndexOf('/') + 1)
}
