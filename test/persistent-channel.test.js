import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'

import { openSsh2ExecChannel, wrapSshChildChannel } from '../lib/persistent-channel.js'

function fakeSsh2Stream() {
  const writes = []
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { writes.push(Buffer.from(chunk)); callback() },
    destroy(error, callback) { callback(error) },
  })
  let closed = false
  stream.close = () => {
    if (closed) return
    closed = true
    stream.emit('exit', 0, null)
    stream.destroy()
  }
  stream.stderr = new PassThrough()
  return { stream, writes }
}

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killed = false
    this.stdinData = []
    this.stdin.on('data', (chunk) => this.stdinData.push(Buffer.from(chunk)))
  }
  kill() {
    if (this.killed) return
    this.killed = true
    this.stdin.end()
    this.stdout.end()
    this.stderr.end()
    this.emit('close', null, 'SIGTERM')
  }
}

test('opens a native ssh2 channel without closing stdin or collecting output', async () => {
  const { stream, writes } = fakeSsh2Stream()
  const calls = []
  const client = { exec: (command, options, callback) => { calls.push({ command, options }); callback(null, stream) } }
  const channel = await openSsh2ExecChannel(client, 'node helper.js')
  assert.deepEqual(calls, [{ command: 'node helper.js', options: {} }])
  assert.equal(channel.readable, stream)
  assert.equal(channel.writable, stream)
  assert.equal(channel.stderr, stream.stderr)
  channel.writable.write(Buffer.from('frame\n'))
  assert.equal(Buffer.concat(writes).toString(), 'frame\n')
  channel.close()
  assert.deepEqual(await channel.done, { code: 0, signal: null, error: null })
})

test('refuses to publish a channel after its target generation changes', async () => {
  const { stream } = fakeSsh2Stream()
  const client = { exec: (_command, _options, callback) => callback(null, stream) }
  await assert.rejects(
    openSsh2ExecChannel(client, 'node helper.js', { isCurrent: () => false }),
    /target changed/,
  )
  assert.equal(stream.destroyed, true)
})

test('wraps OpenSSH child stdio as one duplex channel and reports process exit', async () => {
  const child = new FakeChild()
  const channel = wrapSshChildChannel(child)
  let output = ''
  channel.on('data', (chunk) => { output += chunk.toString() })
  channel.write('request\n')
  child.stdout.write('response\n')
  child.stdout.end()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(Buffer.concat(child.stdinData).toString(), 'request\n')
  assert.equal(output, 'response\n')
  child.emit('close', 0, null)
  assert.deepEqual(await channel.done, { code: 0, signal: null, error: null })
  channel.destroy()
})

test('closing an OpenSSH duplex channel terminates its child process', async () => {
  const child = new FakeChild()
  const channel = wrapSshChildChannel(child)
  channel.close()
  assert.equal(child.killed, true)
  assert.equal((await channel.done).signal, 'SIGTERM')
})
