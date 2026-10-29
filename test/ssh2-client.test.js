import assert from 'node:assert/strict'
import { test } from 'node:test'
import ssh2 from 'ssh2'
import { resolveSsh2Client } from '../lib/pool.js'

class TestClient {}

test('resolveSsh2Client preserves the current ssh2 namespace export', () => {
  assert.equal(resolveSsh2Client(ssh2), ssh2.Client)
  assert.ok(new (resolveSsh2Client(ssh2))() instanceof ssh2.Client)
})

test('resolveSsh2Client accepts a CommonJS default namespace containing Client', () => {
  const Client = resolveSsh2Client({ default: { Client: TestClient } })
  assert.equal(Client, TestClient)
  assert.ok(new Client() instanceof TestClient)
})

test('resolveSsh2Client accepts direct/default constructors used by older interop', () => {
  assert.equal(resolveSsh2Client(TestClient), TestClient)
  assert.equal(resolveSsh2Client({ default: TestClient }), TestClient)
})

test('resolveSsh2Client reports unsupported module shapes clearly', () => {
  assert.throws(() => resolveSsh2Client({ default: {} }), /ssh2 module does not expose a Client constructor/)
})
