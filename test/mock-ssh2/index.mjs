// Mock ssh2 for testing — Client that immediately "connects"
export class Client {
  constructor() {
    this._handlers = {}
  }
  on(ev, fn) { this._handlers[ev] = fn; return this }
  once(ev, fn) { this._handlers[ev] = fn; return this }
  connect(opts) {
    // Simulate successful connection after a tiny delay
    setTimeout(() => {
      if (this._handlers.ready) this._handlers.ready()
    }, 10)
    return this
  }
  exec(cmd, opts, cb) {
    // Return mock stream with predefined output
    const stream = {
      stdout: { on(ev, fn) { if (ev === 'data') fn('mock-output\n') } },
      stderr: { on() {} },
      on(ev, fn) { if (ev === 'close') setTimeout(() => fn(0), 5); return stream },
      once() { return stream },
    }
    cb(null, stream)
    return stream
  }
  sftp(cb) {
    cb(null, { fastPut: (l, r, cb2) => cb2(null) })
    return this
  }
  end() {}
}
