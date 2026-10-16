/**
 * 纯 JS 行级 unified diff（提案 #21）：零依赖（不 spawn git、不引 npm 包），
 * 输出有界。副机在任务收尾时为 modify/add/delete 的文本文件生成 diff 块，
 * 随 handoff 上报 —— 远程场景下用户没法随手 `git diff`，这个视图就是证据链。
 *
 * 算法与边界：
 *   - 公共前缀/后缀修剪后，中段用经典 DP LCS（每侧 ≤600 行，表 ≤602² × 2B）
 *   - 中段超限（巨型重写）不硬算：退化为"统计式"输出（@@ 头 + 近似增删行数
 *     + 明确标注未逐行展开）—— 宁可粗也不 O(n²) 爆内存
 *   - 输出 3 行上下文，相邻 hunk 间距 ≤6 行则合并；总输出超 maxBytes 截断
 *   - 输入按行数裁剪到 maxLines（超出部分不参与 diff，由 truncated 标注）
 */

/** 每侧进入 LCS 的最大行数（前缀/后缀修剪后的中段）。 */
const MAX_LCS_LINES = 600
/** 单文件 diff 输出字节上限。 */
const MAX_DIFF_BYTES = 16 * 1024

/**
 * 生成一个文件的 unified diff。
 *
 * @param {object} o
 * @param {string} o.path 相对路径（diff 头里的 a/ b/ 用）
 * @param {string} o.beforeText 前像文本（新增文件传 ''）
 * @param {string} o.afterText 后像文本（删除文件传 ''）
 * @param {number} [o.maxBytes] 输出字节上限
 * @returns {{path: string, diff: string, truncated: boolean}|null}
 *   无文本差异返回 null。
 */
export function unifiedDiff({ path: filePath, beforeText, afterText, maxBytes = MAX_DIFF_BYTES }) {
  const aLines = clipLines(String(beforeText ?? ''))
  const bLines = clipLines(String(afterText ?? ''))
  const truncatedInput = aLines.truncated || bLines.truncated

  let out = `--- a/${filePath}\n+++ b/${filePath}\n`

  // 1) 公共前缀/后缀修剪：绝大多数真实编辑只动文件的一小段
  let start = 0
  while (start < aLines.list.length && start < bLines.list.length && aLines.list[start] === bLines.list[start]) start += 1
  let endA = aLines.list.length
  let endB = bLines.list.length
  while (endA > start && endB > start && aLines.list[endA - 1] === bLines.list[endB - 1]) { endA -= 1; endB -= 1 }

  const midA = aLines.list.slice(start, endA)
  const midB = bLines.list.slice(start, endB)
  if (midA.length === 0 && midB.length === 0) return null // 无差异

  // 2) 中段超限：统计式降级（近似按"整段替换"计数）
  if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
    out += `@@ -${start + 1},${midA.length} +${start + 1},${midB.length} @@\n`
    out += `# 内容过长未逐行展开（前像 ${midA.length} 行 / 后像 ${midB.length} 行，按替换近似 +${midB.length} -${midA.length}）\n`
    return { path: filePath, diff: out, truncated: true }
  }

  // 3) DP LCS（0/1 表 + 回溯）
  const n = midA.length
  const m = midB.length
  const w = m + 1
  const table = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] = midA[i] === midB[j]
        ? table[(i + 1) * w + (j + 1)] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)])
    }
  }

  /** 编辑脚本：{ t: ' '|'+'|'-', line }，覆盖整份文件（含未变段，hunk 划分用） */
  const script = []
  for (let k = 0; k < start; k += 1) script.push({ t: ' ', line: aLines.list[k] })
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { script.push({ t: ' ', line: midA[i] }); i += 1; j += 1 } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) { script.push({ t: '-', line: midA[i] }); i += 1 } else { script.push({ t: '+', line: midB[j] }); j += 1 }
  }
  while (i < n) { script.push({ t: '-', line: midA[i] }); i += 1 }
  while (j < m) { script.push({ t: '+', line: midB[j] }); j += 1 }
  for (let k = 0; k < aLines.list.length - endA; k += 1) script.push({ t: ' ', line: aLines.list[endA + k] })

  // 4) hunk 划分：3 行上下文，间隔 ≤6 行合并（窗口 = 3 前缀 + 改动 + 4 截断）
  const changedIdx = []
  for (let k = 0; k < script.length; k += 1) if (script[k].t !== ' ') changedIdx.push(k)
  if (changedIdx.length === 0) return null

  const hunks = []
  let from = Math.max(0, changedIdx[0] - 3)
  let to = Math.min(script.length, changedIdx[0] + 4)
  for (let k = 1; k < changedIdx.length; k += 1) {
    if (changedIdx[k] - to <= 6) {
      to = Math.min(script.length, changedIdx[k] + 4)
    } else {
      hunks.push([from, to])
      from = Math.max(0, changedIdx[k] - 3)
      to = Math.min(script.length, changedIdx[k] + 4)
    }
  }
  hunks.push([from, to])

  for (const [from0, to0] of hunks) {
    const body = script.slice(from0, to0)
    const aStart = body.findIndex((s) => s.t !== '+') // 前像行号从 1 计
    const bStart = body.findIndex((s) => s.t !== '-') // 后像行号从 1 计
    const aCount = body.filter((s) => s.t !== '+').length
    const bCount = body.filter((s) => s.t !== '-').length
    out += `@@ -${from0 + aStart + 1},${aCount} +${from0 + bStart + 1},${bCount} @@\n`
    for (const s of body) out += s.t + s.line + '\n'
  }

  let truncated = truncatedInput
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = `${out.slice(0, maxBytes)}\n# … 已截断（超过 ${maxBytes} 字节）\n`
    truncated = true
  }
  return { path: filePath, diff: out, truncated }
}

/** 按行切分并裁剪到 1500 行（超出部分丢弃并标注）。 */
function clipLines(text, maxLines = 1500) {
  const list = text.split(/\r?\n/)
  // 结尾空行是 split 的尾巴（"a\n" → ['a','']），不算内容行
  if (list.length > 0 && list[list.length - 1] === '') list.pop()
  if (list.length <= maxLines) return { list, truncated: false }
  return { list: list.slice(0, maxLines), truncated: true }
}
