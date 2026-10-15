/**
 * 副机侧 hub 指纹钉住（TOFU）落盘（P2-11）。
 *
 * 首连验证通过后把 hub 指纹写进 `<stateDir>/hub-pin.json`（0600，原子写），
 * 之后每次握手都比对这个值 —— 不匹配 = 有东西在冒充 hub，拒绝并大声报错。
 *
 * 文件同时记录 endpoint（当时拨入的 hubUrl/relayUrl 归一化结果）：用户自己
 * 改了拨入地址属于**本地配置行为**，远程攻击者改不了 —— 此时重新 TOFU 并
 * 提示，而不是逼用户手删文件。这条便利性边界在 SECURITY.md 有明示。
 *
 * 全部函数永不抛：读不到/读坏了按"没有 pin"处理（下次连接重新 TOFU），
 * 写失败返回 false（调用方记 warn）—— 落盘问题不是错误路径，验证逻辑才是。
 */
import fs from 'node:fs'
import path from 'node:path'
import { HUB_PIN_FILE_NAME, normalizeFingerprint, restrictPermissions, writeJsonAtomic } from '../identity.js'

export const HUB_PIN_FILE_VERSION = 1

/**
 * 读 pin。缺失 / 损坏 / 形态不对一律 null（下次连接走 TOFU）。
 * @returns {{ fingerprint: string, endpoint: string, pinnedAt: number } | null}
 */
export function loadHubPin(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return null
  const file = path.join(stateDir, HUB_PIN_FILE_NAME)
  try {
    if (!fs.existsSync(file)) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const fp = normalizeFingerprint(parsed?.fingerprint)
    if (!fp) return null
    restrictPermissions(file)
    return {
      fingerprint: fp,
      endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
      pinnedAt: typeof parsed.pinnedAt === 'number' ? parsed.pinnedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * 写 pin（原子写 + 0600）。指纹形态不对 / 路径不可用返回 false。
 * @returns {boolean}
 */
export function saveHubPin(stateDir, { fingerprint, endpoint = '' } = {}) {
  const fp = normalizeFingerprint(fingerprint)
  if (!fp || typeof stateDir !== 'string' || stateDir === '') return false
  try {
    writeJsonAtomic(path.join(stateDir, HUB_PIN_FILE_NAME), {
      version: HUB_PIN_FILE_VERSION,
      fingerprint: fp,
      endpoint,
      pinnedAt: Date.now(),
    })
    return true
  } catch {
    return false
  }
}

/** 清除 pin（显式重置 / 诊断用）。文件不存在同样算成功；清不掉就留着（方向安全）。 */
export function clearHubPin(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return
  try {
    fs.rmSync(path.join(stateDir, HUB_PIN_FILE_NAME), { force: true })
  } catch {
    /* 清不掉就留着 —— 下次连接继续严格匹配 */
  }
}
