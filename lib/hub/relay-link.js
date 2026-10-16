/**
 * hub 侧中继链路（零外部依赖）。
 *
 * 从 node-registry.js 拆出（P1-4）：CHANGELOG/KNOWN-ISSUES 早已记着
 * 「node-registry 集多职责于一身，建议把 RelayLink 拆出去」—— 它与注册表
 * 之间唯一的联系是 registry.relay 持有一个实例，本身完全自包含。
 *
 * 中继链路：hub 拨入中继，之后所有下行帧带 `to`，中继负责投递。
 *
 * 断线自动重连（指数退避 + 抖动，封顶 60s）。断连期间 hub 侧任务记录不动 ——
 * 副机那边任务照跑，重连后副机 task/sync 会把视图补回来。
 *
 * ── 两条并发不变式（t1 动态测试查出，此前无护栏）────────────────────
 *
 * 1. **同时只允许一条在途连接**。`start()` 与退避 timer 都会调 `connectOnce()`，
 *    而 `connect()` 要等 101 响应才 resolve —— 这个窗口里 `this.conn` 还是
 *    undefined，任何一次重入都会再开一条 TCP 连接。实测（真中继）：连调两次
 *    `start()` → 中继侧 `hubs.size === 2`；`stop()` 只关得掉 `this.conn` 那一条，
 *    另一条变成**无人引用的孤儿连接**，永久占着中继的 hub 槽位，且 `stop()`
 *    之后再无任何路径能关掉它。用 `connecting` 闸门 + `start()` 幂等堵住。
 *
 * 2. **close 处理器必须确认自己就是当前连接**。真正的问题在**陈旧连接**：
 *    若它已被新连接取代（`this.conn` 指向新的），旧连接的 'close' 仍会把
 *    `this.conn` 清成 undefined 并排重连 —— 于是「已连上的新连接」被一条早就
 *    死掉的旧连接伪造成「掉线」。实测：造出两条连接、断开其中陈旧的那条，
 *    `ready` 由 true 翻成 false、`attempt` 涨到 1、还排了一个多余的 timer。
 *    修复即比较 `this.conn === conn` 再动手。
 */
import { decodeBinaryFrame, decodeFrame, encodeFrame, envelope, RELAY_FRAME } from '../protocol.js'
import { connect } from '../ws.js'
import { errText } from './hub-util.js'

export class RelayLink {
  constructor({ url, token = '', log, onFrame, onBinary, reconnectMs = 5000, name = 'hub-relay' } = {}) {
    this.url = url
    this.token = token
    this.log = log ?? (() => {})
    this.onFrame = onFrame ?? (() => {})
    this.onBinary = onBinary ?? (() => {})
    this.reconnectMs = reconnectMs
    this.name = name
    this.conn = undefined
    this.timer = undefined
    /** 有一次 connectOnce() 正在 await 中（见上面不变式 1）。 */
    this.connecting = false
    this.attempt = 0
    this.stopped = true
  }

  get ready() {
    return Boolean(this.conn && !this.conn.closed)
  }

  /**
   * 启动链路。**幂等**：已连接或已有在途连接时直接返回。
   *
   * 为什么必须幂等：hub/index.js 在 `ctx.effect` 里调它，而 Cordis 的 effect
   * 可能因配置热重载而重跑 —— 不幂等就会每次多开一条连接，且旧的那条再无人
   * 引用（见类注释不变式 1）。
   *
   * 注意 `stopped = false` 必须在闸门**之前**：`start() → stop() → start()`
   * 的快速序列里，第二次 start() 会因 `connecting` 仍为 true 而提前返回；
   * 若此时 stopped 还是 true，那条在途连接 resolve 后会走 `if (this.stopped)`
   * 分支把自己关掉 —— 调用方调了 start() 却永远连不上。先置 false 则那条
   * 在途连接会被正常采纳，语义与「重启」一致。
   */
  start() {
    this.stopped = false
    if (this.ready || this.connecting) return
    void this.connectOnce()
  }

  /** 中继 URL（不带 token），用于日志。 */
  describe() {
    try {
      const u = new URL(this.url)
      return `${u.origin}${u.pathname}`
    } catch {
      return '(invalid-relay-url)'
    }
  }

  async connectOnce() {
    if (this.stopped) return
    // 并发闸门：await connect() 期间 this.conn 仍为 undefined，不设这道闸门
    // 就会再开一条 TCP 连接（见类注释不变式 1）。
    if (this.connecting || this.ready) return
    let target
    try {
      target = new URL(this.url)
    } catch {
      this.log('error', 'relay url invalid', { url: this.describe() })
      return
    }
    target.searchParams.set('role', 'hub')
    // ⚠ token 走 header，**不进 URL query** —— URL 会进中继的 access log、
    // 反向代理日志、CDN 日志。中继侧本来就 header 优先：
    //   `url.searchParams.get('token') ?? req.headers['x-relay-token']`
    // 副机侧的 RelayTransport 也做了同样的改动（lib/node/transport.js）。

    this.connecting = true
    try {
      const headers = this.token ? { 'x-relay-token': this.token } : {}
      const conn = await connect(target.toString(), { name: this.name, headers })
      if (this.stopped) {
        conn.close(1000, 'stopped')
        return
      }
      this.conn = conn
      this.attempt = 0
      conn.on('message', (payload, isBinary) => {
        try {
          if (isBinary) {
            const dec = decodeBinaryFrame(payload)
            if (!dec.ok) {
              this.log('warn', 'relay binary frame undecodable', { error: dec.error })
              return
            }
            this.onBinary(dec.header, dec.payload)
            return
          }
          const dec = decodeFrame(payload)
          if (!dec.ok) {
            this.log('warn', 'relay frame undecodable', { error: dec.error })
            return
          }
          this.onFrame(dec.frame)
        } catch (err) {
          this.log('error', 'relay frame handler failed', { error: errText(err) })
        }
      })
      conn.on('close', (code) => {
        // 只有「当前生效的那条连接」断开才算掉线。
        // 陈旧连接的 close 若不校验身份，会把已被新连接顶替的状态清成「掉线」
        // （见类注释不变式 2）。
        if (this.conn !== conn) {
          this.log('info', 'stale relay connection closed', { code })
          return
        }
        this.conn = undefined
        this.log('warn', 'relay link closed', { code })
        this.schedule()
      })
      conn.on('error', (err) => this.log('warn', 'relay link error', { error: errText(err) }))
      this.log('info', 'hub attached to relay', { relay: this.describe() })

      // 主动拉一次节点目录。
      //
      // 为什么不能只等中继的 hello/hub：中继在 acceptUpgrade 之后立刻发这一帧，
      // 而它可能和 101 响应挤在同一个 TCP 段里 —— 那时 ws.js 的 connect() 还没
      // resolve，'message' 监听器尚未挂上，帧就丢了。同理，重连时中继也不会为
      // 已连着的节点重播 node/online。显式请求是唯一可靠的对齐方式。
      //
      // 实测（真中继，10 次连接）：hello/hub 到达 0 次、node/list 到达 10 次 ——
      // 该帧确实 100% 丢在 head 里，上面的理由不是推测。
      this.requestNodeList()
    } catch (err) {
      this.log('warn', 'relay connect failed', { relay: this.describe(), error: errText(err) })
      this.schedule()
    } finally {
      this.connecting = false
    }
  }

  /** 请求中继回一份当前节点目录（幂等，可随时调用）。 */
  requestNodeList() {
    if (!this.ready) return false
    try {
      this.conn.send(encodeFrame(envelope(RELAY_FRAME.NODE_LIST, {})))
      return true
    } catch {
      return false
    }
  }

  schedule() {
    if (this.stopped || this.timer) return
    const base = Math.min(this.reconnectMs * 2 ** Math.min(this.attempt, 4), 60_000)
    const delay = base + Math.floor(base * 0.2 * Math.random())
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.connectOnce()
    }, delay)
    if (this.timer.unref) this.timer.unref()
  }

  /** 文本下行帧：text 里已带 `to`，中继靠它路由。 */
  send(_nodeId, text) {
    if (!this.ready) return false
    try {
      this.conn.send(text)
      return true
    } catch {
      return false
    }
  }

  /** 二进制下行帧：buf 头部已带 `to`。 */
  sendBinary(_nodeId, buf) {
    if (!this.ready) return false
    try {
      this.conn.sendBinary(buf)
      return true
    } catch {
      return false
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const conn = this.conn
    this.conn = undefined
    if (conn && !conn.closed) {
      try {
        conn.close(1000, 'hub stopping')
      } catch {
        /* 已断 */
      }
    }
    // connecting 不清：connectOnce 的 finally 会清，且它 resolve 后走
    // `if (this.stopped)` 分支把刚建好的连接关掉（不留半开）。
  }
}
