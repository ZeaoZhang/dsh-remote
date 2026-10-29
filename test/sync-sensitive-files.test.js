import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { compileIgnore, DEFAULT_IGNORE } from '../lib/ignore.js'
import { pushOneFile, pushTree, syncTree } from '../lib/sync.js'
import { MemFs, makeSftp, seed } from './helpers.js'

function localMirror(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-sensitive-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('rw_sync defaults do not download credential-bearing files', async (t) => {
  const remote = new MemFs()
  seed(remote, {
    '/repo/README.md': 'docs',
    '/repo/.env': 'API_TOKEN=secret',
    '/repo/.env.example': 'API_TOKEN=replace-me',
    '/repo/.ssh/id_ed25519': 'private key',
    '/repo/.aws/credentials': 'access_key=secret',
    '/repo/certs/server.pem': 'private cert',
    '/repo/terraform.tfstate': 'state secret',
  })
  const local = localMirror(t)

  await syncTree(makeSftp(remote), '/repo', local, { isIgnored: compileIgnore(DEFAULT_IGNORE) })

  assert.equal(existsSync(path.join(local, 'README.md')), true)
  for (const rel of ['.env', '.env.example', '.ssh', '.aws', 'certs/server.pem', 'terraform.tfstate']) {
    assert.equal(existsSync(path.join(local, rel)), false, `${rel} must not be downloaded`)
  }
})

test('rw_push and auto-push defaults do not upload credential-bearing files', async (t) => {
  const local = localMirror(t)
  mkdirSync(path.join(local, '.ssh'), { recursive: true })
  mkdirSync(path.join(local, 'certs'), { recursive: true })
  writeFileSync(path.join(local, 'README.md'), 'docs')
  writeFileSync(path.join(local, '.env'), 'API_TOKEN=secret')
  writeFileSync(path.join(local, '.env.example'), 'API_TOKEN=replace-me')
  writeFileSync(path.join(local, '.ssh', 'id_ed25519'), 'private key')
  writeFileSync(path.join(local, 'certs', 'server.pem'), 'private cert')
  const remote = new MemFs()
  remote.mkdirSync('/repo')
  const sftp = makeSftp(remote)
  const isIgnored = compileIgnore(DEFAULT_IGNORE)

  await pushTree(sftp, local, '/repo', { isIgnored })
  const one = await pushOneFile(sftp, local, '/repo', '.env', { isIgnored })

  assert.equal(remote.existsSync('/repo/README.md'), true)
  for (const rel of ['.env', '.env.example', '.ssh/id_ed25519', 'certs/server.pem']) {
    assert.equal(remote.existsSync(`/repo/${rel}`), false, `${rel} must not be uploaded`)
  }
  assert.equal(one.status, 'skipped')
})
