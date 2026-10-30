import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SshPool } from '../lib/pool.js'

function fakeStream() {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.close = () => {}
  stream.destroy = () => {}
  return stream
}

test('openExecChannel drops a dead client and retries once on a fresh connection', async () => {
  const pool = new SshPool({ host: '127.0.0.1', port: 1, username: 'lucas' })
  const stream = fakeStream()
  const clients = [
    { exec(_command, _opts, callback) { callback(new Error('Channel open failure')) } },
    { exec(_command, _opts, callback) { callback(null, stream) } },
  ]
  let connects = 0
  let invalidations = 0
  pool.connect = async () => clients[connects++]
  pool.invalidate = () => { invalidations += 1 }

  const channel = await pool.openExecChannel('exec node helper.js --root /srv/project')
  assert.equal(connects, 2)
  assert.equal(invalidations, 1)
  assert.equal(channel.readable, stream)
})

test('openExecChannel reports a second failure instead of looping', async () => {
  const pool = new SshPool({ host: '127.0.0.1', port: 1, username: 'lucas' })
  let connects = 0
  let invalidations = 0
  pool.connect = async () => {
    connects += 1
    return { exec(_command, _opts, callback) { callback(new Error('still dead')) } }
  }
  pool.invalidate = () => { invalidations += 1 }

  await assert.rejects(pool.openExecChannel('exec node helper.js'), /ssh helper channel open failed: still dead/)
  assert.equal(connects, 2)
  assert.equal(invalidations, 1)
})
