import { EventEmitter } from 'node:events'

export const REMOTE_RPC_PROTOCOL_VERSION = 1
export const DEFAULT_MAX_RPC_FRAME_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_RPC_IN_FLIGHT = 128

/** True when an RPC failed because the SSH channel or its remote helper went
 *  away. Read-only work may be retried once after invalidating the SSH pool;
 *  mutations and Bash must not be replayed (their outcome is unknown). */
export function isRemoteTransportClosed(error) {
  return error?.code === 'REMOTE_CHANNEL_CLOSED'
}

function asError(value, fallbackCode = 'REMOTE_RPC_ERROR') {
  const error = new Error(String(value?.message || value || 'remote RPC failed'))
  error.code = String(value?.code || fallbackCode)
  if (value?.name) error.name = String(value.name)
  return error
}

function abortError(reason) {
  const error = new Error(reason ? String(reason) : 'remote RPC request aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** Multiplexes framed JSON requests over one persistent SSH duplex channel. */
export class RemoteRpcChannel extends EventEmitter {
  constructor(channel, opts = {}) {
    super()
    const readable = channel?.readable && typeof channel.readable.on === 'function' ? channel.readable : channel
    const writable = channel?.writable && typeof channel.writable.write === 'function' ? channel.writable : channel
    if (!readable || typeof readable.on !== 'function' || !writable || typeof writable.write !== 'function') {
      throw new TypeError('RemoteRpcChannel requires readable and writable streams')
    }

    this.readable = readable
    this.writable = writable
    this.transport = channel
    this.maxFrameBytes = Math.max(1024, Number(opts.maxFrameBytes) || DEFAULT_MAX_RPC_FRAME_BYTES)
    this.maxInFlight = Math.max(1, Number(opts.maxInFlight) || DEFAULT_MAX_RPC_IN_FLIGHT)
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.sequence = 0
    this.closed = false
    this.closeReason = null

    this.onData = (chunk) => this.#read(chunk)
    this.onEnd = () => this.#fail(this.#closedError('remote RPC stream ended'))
    this.onClose = () => this.#fail(this.#closedError('remote RPC stream closed'))
    this.onError = (error) => this.#fail(this.#closedError(`remote RPC stream error: ${error?.message || error}`))
    this.stderr = channel?.stderr || null
    this.onStderr = (chunk) => this.emit('diagnostic', Buffer.from(chunk))
    this.onTransportDone = (result) => {
      if (result?.code === 0) this.#fail(this.#closedError('remote helper exited'))
      else this.#fail(this.#closedError(`remote helper exited${result?.code == null ? '' : ` with code ${result.code}`}`))
    }

    readable.on('data', this.onData)
    readable.once('end', this.onEnd)
    readable.once('close', this.onClose)
    readable.once('error', this.onError)
    writable.on('error', this.onError)
    if (this.stderr?.on) this.stderr.on('data', this.onStderr)
    if (channel?.done && typeof channel.done.then === 'function') {
      channel.done.then(this.onTransportDone, (error) => this.#fail(this.#closedError(`remote helper transport failed: ${error?.message || error}`)))
    }
  }

  get inFlight() {
    return this.pending.size
  }

  async request(op, payload = {}, opts = {}) {
    if (this.closed) throw this.closeReason || this.#closedError('remote RPC channel is closed')
    if (this.pending.size >= this.maxInFlight) {
      const error = new Error(`remote RPC channel is at its ${this.maxInFlight}-request limit`)
      error.code = 'REMOTE_RPC_BUSY'
      throw error
    }
    if (opts.signal?.aborted) throw abortError(opts.signal.reason)

    const id = String(++this.sequence)
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, signal: opts.signal, onEvent: opts.onEvent, timer: null, onAbort: null }
      const finish = (fn, value) => {
        if (!this.pending.delete(id)) return
        if (pending.timer) clearTimeout(pending.timer)
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
        fn(value)
      }
      pending.finish = finish
      this.pending.set(id, pending)

      const timeoutMs = Number(opts.timeoutMs)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          void this.#send({ type: 'cancel', id, reason: 'timeout' }).catch(() => {})
          const error = new Error(`remote RPC request timed out after ${timeoutMs}ms`)
          error.code = 'ETIMEDOUT'
          finish(reject, error)
        }, timeoutMs)
      }
      if (pending.signal) {
        pending.onAbort = () => {
          void this.#send({ type: 'cancel', id, reason: 'aborted' }).catch(() => {})
          finish(reject, abortError(pending.signal.reason))
        }
        pending.signal.addEventListener('abort', pending.onAbort, { once: true })
      }

      this.#send({ type: 'request', id, op: String(op), payload, protocol: REMOTE_RPC_PROTOCOL_VERSION })
        .catch((error) => finish(reject, error))
    })
  }

  async ping() {
    if (this.closed) throw this.closeReason || this.#closedError('remote RPC channel is closed')
    await this.#send({ type: 'ping', at: Date.now(), protocol: REMOTE_RPC_PROTOCOL_VERSION })
  }

  async close(opts = {}) {
    if (this.closed) return
    if (opts.shutdown === true) {
      try { await this.#send({ type: 'shutdown', protocol: REMOTE_RPC_PROTOCOL_VERSION }) } catch { /* channel is already failing */ }
    }
    this.#fail(this.#closedError('remote RPC channel closed locally'))
  }

  async #send(message) {
    if (this.closed) throw this.closeReason || this.#closedError('remote RPC channel is closed')
    let frame
    try {
      frame = Buffer.from(JSON.stringify(message) + '\n', 'utf8')
    } catch (error) {
      throw asError({ message: `remote RPC request is not JSON serializable: ${error?.message || error}`, code: 'REMOTE_RPC_INVALID_REQUEST' })
    }
    if (frame.byteLength > this.maxFrameBytes) {
      throw asError({ message: `remote RPC frame exceeds ${this.maxFrameBytes} bytes`, code: 'REMOTE_RPC_FRAME_TOO_LARGE' })
    }
    await new Promise((resolve, reject) => {
      try {
        this.writable.write(frame, (error) => error ? reject(this.#closedError(`remote RPC write failed: ${error.message || error}`)) : resolve())
      } catch (error) {
        reject(this.#closedError(`remote RPC write failed: ${error?.message || error}`))
      }
    })
  }

  #read(chunk) {
    if (this.closed) return
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let rest = this.buffer.length ? Buffer.concat([this.buffer, incoming]) : incoming
    let start = 0
    for (;;) {
      const end = rest.indexOf(10, start)
      if (end < 0) break
      const size = end - start
      if (size > this.maxFrameBytes) {
        this.#fail(this.#closedError(`remote RPC frame exceeds ${this.maxFrameBytes} bytes`, 'REMOTE_RPC_FRAME_TOO_LARGE'))
        return
      }
      if (size > 0) {
        try {
          this.#receive(JSON.parse(rest.subarray(start, end).toString('utf8')))
        } catch (error) {
          this.#fail(this.#closedError(`invalid remote RPC frame: ${error?.message || error}`, 'REMOTE_RPC_PROTOCOL_ERROR'))
          return
        }
      }
      start = end + 1
    }
    this.buffer = Buffer.from(rest.subarray(start))
    if (this.buffer.byteLength > this.maxFrameBytes) {
      this.#fail(this.#closedError(`remote RPC frame exceeds ${this.maxFrameBytes} bytes`, 'REMOTE_RPC_FRAME_TOO_LARGE'))
    }
  }

  #receive(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
      throw new Error('expected an object with a frame type')
    }
    if (frame.type === 'pong' || frame.type === 'heartbeat') {
      this.emit(frame.type, frame)
      return
    }
    if (frame.type === 'event') {
      const pending = this.pending.get(String(frame.id || ''))
      if (pending?.onEvent) {
        try { pending.onEvent(frame.event, frame.data) } catch (error) { this.emit('listenerError', error) }
      }
      this.emit('event', frame)
      return
    }
    if (frame.type !== 'response') throw new Error(`unsupported frame type ${JSON.stringify(frame.type)}`)
    const pending = this.pending.get(String(frame.id || ''))
    if (!pending) return
    if (frame.ok === true) pending.finish(pending.resolve, frame.result)
    else pending.finish(pending.reject, asError(frame.error, 'REMOTE_RPC_ERROR'))
  }

  #closedError(message, code = 'REMOTE_CHANNEL_CLOSED') {
    const error = new Error(message)
    error.code = code
    return error
  }

  #fail(error) {
    if (this.closed) return
    this.closed = true
    this.closeReason = error
    this.readable.removeListener('data', this.onData)
    this.readable.removeListener('end', this.onEnd)
    this.readable.removeListener('close', this.onClose)
    this.readable.removeListener('error', this.onError)
    this.writable.removeListener('error', this.onError)
    this.stderr?.removeListener?.('data', this.onStderr)
    for (const pending of this.pending.values()) pending.finish(pending.reject, error)
    this.pending.clear()
    try { this.transport?.close?.() } catch { /* best effort */ }
    try { this.transport?.destroy?.() } catch { /* best effort */ }
    if (this.transport === this.readable) {
      try { this.readable.destroy?.() } catch { /* best effort */ }
    } else {
      try { this.readable.destroy?.() } catch { /* best effort */ }
      try { this.writable.destroy?.() } catch { /* best effort */ }
    }
    this.emit('close', error)
  }
}
