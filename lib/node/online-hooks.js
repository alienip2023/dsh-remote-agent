/**
 * Node-side online hooks: wired by lib/node/index.js on transport 'online'.
 * Extracted here so that integration tests can fire the real transport online path
 * without spinning up a full node session.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { sendConfigSyncRequest } from './config-sync.js'

/** Resolve the node's DSH home directory from the environment. */
export function resolveNodeDshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Attach transport 'online' hooks that should fire on every connect/reconnect.
 * @param {object} transport  - EventEmitter with .on(event, fn)
 * @param {object} opts
 * @param {function} opts.send  - (type, data) => void
 * @param {object} [opts.env]   - process.env substitute (default: real process.env)
 * @param {function} [opts.logger]
 */
export function attachOnlineHooks(transport, { send, env = process.env, logger }) {
  const log = logger || (() => {})
  transport.on('online', () => {
    const dshHome = resolveNodeDshHome(env)
    sendConfigSyncRequest({ dshHome, send, logger: log })
  })
}
