#!/usr/bin/env node
/**
 * dsh-remote-worker \u2014 \u72ec\u7acb\u526f\u673a\u5b88\u62a4\u8fdb\u7a0b\u5165\u53e3\u3002
 *
 * \u4e0d\u4f9d\u8d56 DSH Desktop\uff0c\u76f4\u63a5\u8bfb config.json \u8c03 applyWorker\u3002
 * \u96f6\u5916\u90e8\u4f9d\u8d56\uff1a\u53ea\u7528 node: \u5185\u7f6e\u6a21\u5757 + \u5305\u5185\u76f8\u5bf9 import\u3002
 *
 * \u7528\u6cd5\uff1a
 *   node bin/dsh-remote-worker.js                # \u8bfb ../config.json
 *   DRA_CONFIG=/path/to/cfg.json node bin/dsh-remote-worker.js
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyWorker } from '../lib/node/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configPath = process.env.DRA_CONFIG || join(__dirname, '..', 'config.json')

let config = {}
try {
  config = JSON.parse(readFileSync(configPath, 'utf-8'))
} catch (err) {
  console.error('dsh-remote-worker: cannot read config from', configPath, '-', String(err.message || err))
  process.exit(1)
}

// Minimal ctx \u2014 applyWorker only needs logger (falls back to console) and effect (optional).
const ctx = {}

const dispose = applyWorker(ctx, config)

// Keep the process alive for daemon mode.
const keepAlive = setInterval(() => {}, 60000)

process.on('SIGTERM', () => { try { dispose() } catch {} clearInterval(keepAlive); process.exit(0) })
process.on('SIGINT', () => { try { dispose() } catch {} clearInterval(keepAlive); process.exit(0) })
