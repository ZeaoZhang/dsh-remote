import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'

import { RemoteRpcChannel } from '../lib/remote-rpc.js'

function createPair() {
  class Peer extends Duplex {
    constructor() {
      super()
      this.other = null
    }
    _read() {}
    _write(chunk, _encoding, callback) {
      if (this.other.destroyed) return callback(new Error('peer is closed'))
      this.other.push(Buffer.from(chunk))
      callback()
    }
  }
  const left = new Peer()
  const right = new Peer()
  left.other = right
  right.other = left
  return { left, right }
}

function parseFrames() {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)])
    const out = []
    for (;;) {
      const index = pending.indexOf(10)
      if (index < 0) break
      const frame = pending.subarray(0, index)
      pending = pending.subarray(index + 1)
      if (frame.length) out.push(JSON.parse(frame.toString('utf8')))
    }
    return out
  }
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('timed out waiting for the test event')
}

test('multiplexes concurrent requests and correlates out-of-order replies', async () => {
  const { left, right } = createPair()
  const channel = new RemoteRpcChannel(left)
  const parse = parseFrames()
  const requests = []
  right.on('data', (chunk) => requests.push(...parse(chunk)))

  const a = channel.request('stat', { path: '/a' })
  const b = channel.request('read', { path: '/b' })
  await until(() => requests.length === 2)
  assert.notEqual(requests[0].id, requests[1].id)

  right.write(JSON.stringify({ type: 'response', id: requests[1].id, ok: true, result: 'B' }) + '\n')
  right.write(JSON.stringify({ type: 'response', id: requests[0].id, ok: true, result: 'A' }) + '\n')
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
  await channel.close()
  right.destroy()
})

test('parses frames split across arbitrary transport chunks', async () => {
  const { left, right } = createPair()
  const channel = new RemoteRpcChannel(left)
  const parse = parseFrames()
  let request
  right.on('data', (chunk) => { request = parse(chunk)[0] || request })
  const result = channel.request('ping')
  await until(() => request !== undefined)
  const frame = Buffer.from(JSON.stringify({ type: 'response', id: request.id, ok: true, result: 'ok' }) + '\n')
  right.write(frame.subarray(0, 7))
  right.write(frame.subarray(7, 19))
  right.write(frame.subarray(19))
  assert.equal(await result, 'ok')
  await channel.close()
  right.destroy()
})

test('sends a targeted cancellation and rejects with AbortError', async () => {
  const { left, right } = createPair()
  const channel = new RemoteRpcChannel(left)
  const parse = parseFrames()
  const messages = []
  right.on('data', (chunk) => messages.push(...parse(chunk)))
  const controller = new AbortController()
  const result = channel.request('exec', { command: 'sleep 30' }, { signal: controller.signal })
  await until(() => messages.some((frame) => frame.type === 'request'))
  controller.abort('user cancelled')
  await assert.rejects(result, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR')
  await until(() => messages.some((frame) => frame.type === 'cancel'))
  assert.equal(messages.find((frame) => frame.type === 'cancel').id, messages.find((frame) => frame.type === 'request').id)
  await channel.close()
  right.destroy()
})

test('times out one request without closing the reusable channel', async () => {
  const { left, right } = createPair()
  const channel = new RemoteRpcChannel(left)
  const parse = parseFrames()
  let requests = 0
  right.on('data', (chunk) => { requests += parse(chunk).filter((frame) => frame.type === 'request').length })
  await assert.rejects(channel.request('slow', {}, { timeoutMs: 10 }), (error) => error.code === 'ETIMEDOUT')
  assert.equal(channel.closed, false)
  assert.equal(requests, 1)
  await channel.close()
  right.destroy()
})

test('fails in-flight work once on disconnect and never replays it', async () => {
  const { left, right } = createPair()
  const channel = new RemoteRpcChannel(left)
  const parse = parseFrames()
  let requests = 0
  right.on('data', (chunk) => { requests += parse(chunk).filter((frame) => frame.type === 'request').length })
  const result = channel.request('write', { path: '/file', content: 'once' })
  await until(() => requests === 1)
  left.push(null)
  await assert.rejects(result, (error) => error.code === 'REMOTE_CHANNEL_CLOSED')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 1)
  right.destroy()
})

test('rejects malformed protocol data and closes the channel', async () => {
  const { left, right } = createPair()
  const channel = new RemoteRpcChannel(left)
  const closed = new Promise((resolve) => channel.once('close', resolve))
  right.write('not-json\n')
  const error = await closed
  assert.equal(error.code, 'REMOTE_RPC_PROTOCOL_ERROR')
  assert.equal(channel.closed, true)
  right.destroy()
})
