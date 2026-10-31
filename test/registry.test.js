// Registry semantics for issue #13: "Saved Connections != Active Remote
// Context". A saved machine must never silently become the active remote
// context; `currentId` is an explicit user choice and nothing else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadMachines, saveMachines, sanitizeMachine, applyMachine, machineId, hasStoredPassword, resolveProbeCredentials } from '../lib/registry.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'dsh-remote-reg-'))
const file = (dir) => path.join(dir, 'machines.json')
const machine = (id, host) => ({ id, name: host, host, port: 22, username: 'root', password: 'secret', workspace: '/home/root/proj', proxy: { host: 'jump', password: 'pp' } })

test('loadMachines: empty / missing file → { list: [], currentId: null }', () => {
  const d = tmp()
  assert.deepEqual(loadMachines(file(d)), { list: [], currentId: null, explicitNone: false })
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: currentId NEVER falls back to the first saved machine (issue #13)', () => {
  const d = tmp()
  // Old behavior: `currentId || list[0].id` made the first saved machine the
  // active remote context. Saving a machine must stay a pure standby.
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1'), machine('b', 'h2')] }))
  const { list, currentId, explicitNone } = loadMachines(file(d))
  assert.equal(list.length, 2)
  assert.equal(currentId, null)
  assert.equal(explicitNone, false) // no currentId key at all → not an explicit "none"
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: explicit currentId survives', () => {
  const d = tmp()
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1'), machine('b', 'h2')], currentId: 'b' }))
  assert.equal(loadMachines(file(d)).currentId, 'b')
  assert.equal(loadMachines(file(d)).explicitNone, false)
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: stale currentId (deleted machine) resolves to null — no auto-promotion of a sibling (issue #13)', () => {
  const d = tmp()
  writeFileSync(file(d), JSON.stringify({ list: [machine('b', 'h2')], currentId: 'a' }))
  const { list, currentId } = loadMachines(file(d))
  assert.equal(list.length, 1)
  assert.equal(currentId, null)
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: persisted currentId:null is an explicit "active remote = none" (issue #13)', () => {
  const d = tmp()
  // After the user clears the current machine the registry persists
  // `currentId: null`. On restart this MUST stay inert — a config-level default
  // host must not silently reactivate a context the user turned off.
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1')], currentId: null }))
  const { currentId, explicitNone } = loadMachines(file(d))
  assert.equal(currentId, null)
  assert.equal(explicitNone, true)
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines(…, null) persists an explicit "active remote = none"', () => {
  const d = tmp()
  saveMachines(file(d), [machine('a', 'h1')], null)
  const j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal(j.currentId, null)
  assert.equal(j.list.length, 1)
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines keepCurrentKey:false leaves currentId untouched (add/update must not flip explicitNone)', () => {
  const d = tmp()
  // Registry that has never had a currentId: adding a machine must NOT write
  // `currentId: null` (which would read back as an explicit "none" and block
  // the config-default bootstrap). The key simply stays absent.
  saveMachines(file(d), [machine('a', 'h1')], null, false)
  let j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal('currentId' in j, false)
  assert.equal(loadMachines(file(d)).explicitNone, false)
  // Registry where the user explicitly cleared current: adding another machine
  // must preserve the explicit-none state (still an explicit choice).
  saveMachines(file(d), [machine('a', 'h1')], null, true)
  saveMachines(file(d), [machine('a', 'h1'), machine('b', 'h2')], null, false)
  j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal(j.currentId, null)
  assert.equal(loadMachines(file(d)).explicitNone, true)
  rmSync(d, { recursive: true, force: true })
})

test('sanitizeMachine strips passwords but reports passwordSet', () => {
  const s = sanitizeMachine(machine('a', 'h1'))
  assert.equal(s.password, undefined)
  assert.equal(s.passwordSet, true)
  // proxy password is blanked ('' — matches the pre-existing sanitize contract)
  assert.equal(s.proxy.password, '')
  assert.equal(s.proxy.passwordSet, true)
  assert.equal(s.host, 'h1')
})

// A keychain machine stores `password: ''` by design, so `!!m.password` reported
// passwordSet:false and the settings page looked like the plugin had lost the
// credential it was holding.
test('hasStoredPassword counts keychain secrets, not only plaintext', () => {
  assert.equal(hasStoredPassword({ password: 'pw' }), true)
  assert.equal(hasStoredPassword({ password: '', secretStored: true }), true)
  assert.equal(hasStoredPassword({ password: '', secretStored: false, credentialBackend: 'keychain' }), false)
  // Records written before `secretStored` existed: the backend is the evidence.
  assert.equal(hasStoredPassword({ password: '', credentialBackend: 'keychain' }), true)
  assert.equal(hasStoredPassword({ password: '', credentialBackend: 'plain' }), false)
  assert.equal(hasStoredPassword(null), false)
})

test('sanitizeMachine never round-trips the private-key passphrase', () => {
  const s = sanitizeMachine({ id: 'a', host: 'h1', password: '', secretStored: true, passphrase: 'secret-phrase' })
  assert.equal(s.passphrase, undefined, 'the passphrase must not reach the browser')
  assert.equal(s.passphraseSet, true)
  assert.equal(s.passwordSet, true)
  assert.equal(sanitizeMachine({ id: 'b', host: 'h2', passphrase: '' }).passphraseSet, false)
})

test('resolveProbeCredentials lets the form override and falls back to the saved record', () => {
  const saved = {
    password: '',
    passphrase: 'key-pass',
    privateKeyPath: '/keys/id_ed25519',
    useAgent: true,
    keyboardInteractive: true,
    backend: 'openssh',
    proxy: { host: 'jump', port: 2222, username: 'ops', password: 'jump-pw', privateKeyPath: '/keys/jump' },
  }
  // An edit-then-test form: everything blank except the host it is about to dial.
  const merged = resolveProbeCredentials({ host: 'h1', password: '', passphrase: '' }, saved, 'from-keychain')
  assert.equal(merged.password, 'from-keychain', 'the keychain secret is used when the form is blank')
  assert.equal(merged.usedSavedCredential, true)
  assert.equal(merged.passphrase, 'key-pass')
  assert.equal(merged.privateKeyPath, '/keys/id_ed25519')
  assert.equal(merged.useAgent, true)
  assert.equal(merged.keyboardInteractive, true)
  assert.equal(merged.backend, 'openssh')
  assert.equal(merged.proxy.password, 'jump-pw', 'the bastion password is carried over')
  assert.equal(merged.proxy.port, 2222)

  // A form value always wins; booleans are only taken when actually supplied.
  const overridden = resolveProbeCredentials(
    { password: 'typed', passphrase: 'new-pass', useAgent: false, proxy: { host: 'jump2', password: '' } },
    saved,
    'from-keychain',
  )
  assert.equal(overridden.password, 'typed')
  assert.equal(overridden.usedSavedCredential, false)
  assert.equal(overridden.passphrase, 'new-pass')
  assert.equal(overridden.useAgent, false)
  assert.equal(overridden.proxy.host, 'jump2')
  assert.equal(overridden.proxy.password, 'jump-pw', 'a blank form bastion password keeps the saved one')
})

test('resolveProbeCredentials with no saved record behaves like a plain form probe', () => {
  const cred = resolveProbeCredentials({ host: 'h', password: 'pw', useAgent: 'yes' }, null, '')
  assert.equal(cred.password, 'pw')
  assert.equal(cred.usedSavedCredential, false)
  assert.equal(cred.useAgent, false, 'a non-boolean form value must not enable agent auth')
  assert.equal(cred.backend, 'native')
  assert.equal(cred.proxy, undefined)
})

test('applyMachine overrides the live config fields', () => {
  const cfg = { host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false, proxy: undefined }
  applyMachine(cfg, machine('a', 'h1'))
  assert.equal(cfg.host, 'h1')
  assert.equal(cfg.username, 'root')
  assert.equal(cfg.workspace, '/home/root/proj')
  assert.equal(cfg.proxy.host, 'jump')
})

test('applyMachine keeps existing workspace when machine has none', () => {
  const cfg = { host: '', workspace: '/keep' }
  applyMachine(cfg, { host: 'h1', username: 'u', port: 22, password: '' })
  assert.equal(cfg.workspace, '/keep')
})

test('machineId mints unique ids', () => {
  const a = machineId()
  const b = machineId()
  assert.match(a, /^m-/)
  assert.notEqual(a, b)
})
