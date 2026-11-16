import { timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { startListenServer, resolveListenHost } from '../listen-server.js'
import { PEER, PROTOCOL_VERSION, ERROR_CODE, decodeFrame, encodeFrame, envelope } from '../protocol.js'
import { createSession, generateEphemeral } from '../e2e.js'
import { isPeerBotType, sendPeerFrame } from './peer-link.js'

export function validPeerSecret(expected, received) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)
    || typeof received !== 'string' || !/^[0-9a-f]{64}$/.test(received)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
}

export function attachPeerConnection(conn, { nodeId, getSecret, onFrame, onReady, remote = '', log = () => {}, helloTimeoutMs = 5000, heartbeatMs = 15_000 }) {
  let session
  let peerId
  let rejected = false
  let managed = false
  let heartbeat
  let lastPong = Date.now()
  let pingAt
  const channel = new EventEmitter()
  channel.state = 'connecting'
  channel.rttMs = null
  channel.send = (type, data, opts) => isPeerBotType(type) && sendPeerFrame(conn, session, type, data, opts)
  channel.stop = () => conn.destroy()
  const reject = code => {
    if (rejected) return
    rejected = true
    log('warn', code, { remote })
    conn.send(encodeFrame(envelope('error', { code })))
    conn.close(1008, code)
  }
  const timer = setTimeout(() => reject(ERROR_CODE.PEER_AUTH_FAILED), helloTimeoutMs)
  timer.unref?.()
  conn.on('close', () => {
    clearTimeout(timer)
    clearInterval(heartbeat)
    session?.destroy()
    channel.state = 'failed'
    channel.emit('disconnect')
  })
  conn.on('error', () => { clearTimeout(timer); conn.destroy() })
  conn.on('pong', () => { lastPong = Date.now(); if (pingAt !== undefined) channel.rttMs = Math.max(0, lastPong - pingAt) })
  conn.on('message', (raw, binary) => {
    if (rejected) return
    try {
      const decoded = binary ? null : decodeFrame(raw)
      if (!decoded?.ok) { reject('peer-frame-forbidden'); return }
      let frame = decoded.frame
      if (!session) {
        if (frame.t !== PEER.HELLO || frame.d?.protocol !== PROTOCOL_VERSION
          || typeof frame.d.nodeId !== 'string' || !frame.d.nodeId
          || !(frame.d.nodeId === '@hub' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(frame.d.nodeId))
          || !Number.isFinite(frame.d.time)
          || !validPeerSecret(getSecret(), frame.d.secret)) { reject(ERROR_CODE.PEER_AUTH_FAILED); return }
        const eph = generateEphemeral()
        session = createSession({ role: 'hub', ownPrivB64: eph.privateKeyB64,
          peerPubB64: frame.d.pub, nodePubB64: frame.d.pub, hubPubB64: eph.publicKeyB64 })
        peerId = frame.d.nodeId
        clearTimeout(timer)
        conn.send(encodeFrame(envelope(PEER.WELCOME, { nodeId, time: Date.now(), pub: eph.publicKeyB64 })))
        channel.state = 'connected'
        channel.rttMs = 0
        managed = onReady?.(peerId, channel) === true
        if (conn.closed) return
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > heartbeatMs * 3) { conn.destroy(); return }
          pingAt = Date.now()
          if (!conn.ping()) conn.destroy()
        }, heartbeatMs)
        heartbeat.unref?.()
        return
      }
      if (!isPeerBotType(frame.t)) { reject('peer-frame-forbidden'); return }
      frame = { ...frame, d: session.openFrame(frame.t, frame.id, frame.d) }
      if (managed) channel.emit('frame', frame)
      else onFrame(frame, channel.send, peerId)
    } catch { reject(session ? 'peer-frame-forbidden' : ERROR_CODE.PEER_AUTH_FAILED) }
  })
}

export async function startPeerListener({ nodeId, host = '', port = 19388, getSecret, onFrame, onReady, log }) {
  const listener = await startListenServer({ host: resolveListenHost({ listenHost: host }).host, port,
    path: '/api/remote-agent/peer', log,
    onUpgrade: (conn, req) => attachPeerConnection(conn, { nodeId, getSecret, onFrame, onReady, log, remote: req.socket.remoteAddress ?? '' }),
  })
  const authority = listener.host.includes(':') ? `[${listener.host}]` : listener.host
  return { ...listener, url: `ws://${authority}:${listener.port}/api/remote-agent/peer`, listening: `${authority}:${listener.port}` }
}
