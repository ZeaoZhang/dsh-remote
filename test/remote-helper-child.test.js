import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { bwrapProfileArgs, buildBashArgv, openValidatedFile, safeRemoteEnv } = require('../lib/remote-helper-child.cjs')
const helper = fileURLToPath(new URL('../lib/remote-helper-child.cjs', import.meta.url))

test('remote bwrap profiles expose only runtime paths and the selected workspace', () => {
  const readOnly = bwrapProfileArgs('read-only', '/srv/project')
  const workspaceWrite = bwrapProfileArgs('workspace-write', '/srv/project')
  assert.ok(!readOnly.some((value, index) => value === '/' && readOnly[index + 1] === '/'))
  assert.ok(readOnly.includes('--unshare-net'))
  assert.ok(readOnly.includes('--tmpfs') && readOnly.includes('/tmp'))
  assert.ok(readOnly.includes('--ro-bind') && readOnly.includes('/srv/project'))
  assert.ok(!readOnly.includes('/root'))
  assert.ok(workspaceWrite.includes('--bind'))
  assert.ok(workspaceWrite.includes('/srv/project'))
  assert.ok(!workspaceWrite.some((value, index) => value === '/' && workspaceWrite[index + 1] === '/'))
  assert.deepEqual(buildBashArgv({ mode: 'danger-full-access', command: 'pwd' }), ['bash', '-c', 'pwd'])
  assert.deepEqual(buildBashArgv({ mode: 'workspace-write', workspaceRoot: '/srv/project', cwd: '/srv/project/src', command: 'pwd' }), [
    'bwrap', ...workspaceWrite, '--chdir', '/srv/project/src', '--', 'bash', '-c', 'pwd',
  ])
  assert.throws(() => bwrapProfileArgs('danger-full-access', '/srv/project'), /unsupported remote sandbox mode/)
  assert.throws(() => bwrapProfileArgs('read-only', 'relative'), /requires an absolute remote workspace root/)
})

test('remote shell env does not forward unapproved secrets or local PATH overrides', () => {
  const env = safeRemoteEnv({ TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: '/untrusted/local/bin', API_TOKEN: 'secret' })
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.LANG, 'C.UTF-8')
  assert.notEqual(env.PATH, '/untrusted/local/bin')
  assert.equal(env.API_TOKEN, undefined)
})

function startHelper(root, env = {}) {
  const child = spawn(process.execPath, [helper, '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: path.join(root, '.test-user-home'), DSH_HOME: '', AGENTS_HOME: '', ...env },
  })
  const waiting = new Map()
  const diagnostics = []
  let buffer = Buffer.alloc(0)
  let nextId = 0
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const end = buffer.indexOf(10)
      if (end < 0) break
      const frame = JSON.parse(buffer.subarray(0, end).toString('utf8'))
      buffer = buffer.subarray(end + 1)
      const entry = waiting.get(String(frame.id))
      if (frame.type === 'response' && entry) {
        waiting.delete(String(frame.id))
        if (frame.ok) entry.resolve(frame.result)
        else {
          const error = new Error(frame.error?.message || 'remote helper request failed')
          error.code = frame.error?.code
          error.name = frame.error?.name || 'Error'
          entry.reject(error)
        }
      }
    }
  })
  child.stderr.on('data', (chunk) => diagnostics.push(chunk.toString()))
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  return {
    child,
    closed,
    diagnostics,
    request(op, payload = {}, protocol = 1) {
      const id = String(++nextId)
      const response = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
      response.cancel = () => child.stdin.write(JSON.stringify({ type: 'cancel', id }) + '\n')
      child.stdin.write(JSON.stringify({ type: 'request', id, op, payload, protocol }) + '\n')
      return response
    },
    async shutdown() {
      child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      child.stdin.end()
      return closed
    },
  }
}

test('remote helper negotiates protocol and reads a bounded line window', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-helper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const hello = await instance.request('hello')
  assert.equal(hello.protocol, 1)
  assert.equal(hello.root, realpathSync(root))
  assert.equal(typeof hello.dependencies?.rg?.available, 'boolean')
  assert.equal(typeof hello.dependencies?.bwrap?.available, 'boolean')
  assert.equal(typeof hello.dependencies?.bwrap?.usable, 'boolean')
  assert.equal(hello.capabilities.includes('search.rg'), hello.dependencies.rg.available)
  assert.equal(hello.capabilities.includes('sandbox.bwrap'), hello.dependencies.bwrap.usable)
  const read = await instance.request('read', { path: 'notes.txt', offset: 2, limit: 2 })
  assert.equal(read.path, path.join(realpathSync(root), 'notes.txt'))
  assert.equal(read.offset, 2)
  assert.deepEqual(read.lines, [{ number: 2, text: 'beta' }, { number: 3, text: 'gamma' }])
  assert.equal(read.totalLines, 3)
  assert.deepEqual(await instance.shutdown(), { code: 0, signal: null })
})

test('remote helper matches DSH read truncation and offset behavior', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-helper-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'long.txt'), 'x'.repeat(2200))
  writeFileSync(path.join(root, 'large.txt'), Array.from({ length: 70 }, () => 'y'.repeat(1000)).join('\n'))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const long = await instance.request('read', { path: 'long.txt' })
  assert.equal(long.lines[0].text, 'x'.repeat(2000) + '... (line truncated to 2000 chars)')
  assert.equal(long.truncatedByBytes, false)
  const large = await instance.request('read', { path: 'large.txt', limit: 100 })
  assert.equal(large.truncatedByBytes, true)
  assert.ok(large.lines.length < 70)
  await assert.rejects(instance.request('read', { path: 'large.txt', offset: 71 }), (error) => error.code === 'REMOTE_INVALID_OFFSET')
  await instance.shutdown()
})

test('remote helper writes and edits only observed, in-root files', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-remote-mutation-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  const outside = path.join(parent, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(path.join(root, 'notes.txt'), 'before text\n')
  writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))
  symlinkSync(outside, path.join(root, 'outside-dir'))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const first = await instance.request('read', { path: 'notes.txt' })
  assert.match(first.version, /^[a-f0-9]{64}$/)
  const written = await instance.request('write', {
    path: 'notes.txt', content: 'updated text\n', expectedVersion: first.version, expectedPath: first.path,
  })
  assert.equal(written.operation, 'update')
  assert.equal(written.before, 'before text\n')
  assert.equal(written.after, 'updated text\n')
  assert.match(written.version, /^[a-f0-9]{64}$/)
  await assert.rejects(
    instance.request('write', { path: 'notes.txt', content: 'stale\n', expectedVersion: first.version }),
    (error) => error.code === 'FS_STALE_VERSION',
  )

  const second = await instance.request('read', { path: 'notes.txt' })
  const edited = await instance.request('edit', {
    path: 'notes.txt', oldString: 'updated', newString: 'edited', expectedVersion: second.version, expectedPath: second.path,
  })
  assert.equal(edited.before, 'updated text\n')
  assert.equal(edited.after, 'edited text\n')
  assert.equal(readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'edited text\n')

  const created = await instance.request('write', {
    path: 'new.txt', content: 'new file\n', expectedVersion: null,
  })
  assert.equal(created.operation, 'create')
  assert.equal(created.before, null)
  await assert.rejects(
    instance.request('write', { path: 'escape.txt', content: 'overwrite', expectedVersion: null }),
    (error) => error.code === 'REMOTE_PATH_DENIED',
  )
  await assert.rejects(
    instance.request('write', { path: 'outside-dir/new.txt', content: 'escape', expectedVersion: null }),
    (error) => error.code === 'REMOTE_PATH_DENIED',
  )
  await instance.shutdown()
})

test('mutation CAS rejects a symlink retarget even when the new file has identical content', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-symlink-cas-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const firstPath = path.join(root, 'first.txt')
  const secondPath = path.join(root, 'second.txt')
  const linkPath = path.join(root, 'link.txt')
  writeFileSync(firstPath, 'same text\n')
  writeFileSync(secondPath, 'same text\n')
  symlinkSync(firstPath, linkPath)
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const observed = await instance.request('read', { path: 'link.txt' })
  assert.equal(observed.path, realpathSync(firstPath))
  rmSync(linkPath)
  symlinkSync(secondPath, linkPath)
  await assert.rejects(instance.request('edit', {
    path: 'link.txt', oldString: 'same', newString: 'changed',
    expectedVersion: observed.version, expectedPath: observed.path,
  }), (error) => error.code === 'FS_STALE_VERSION')
  assert.equal(readFileSync(secondPath, 'utf8'), 'same text\n')

  await instance.shutdown()
})
test('descriptor-bound reads reject a parent replaced with an outside symlink', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-open-beneath-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  const nested = path.join(root, 'nested')
  mkdirSync(nested, { recursive: true })
  const targetPath = path.join(nested, 'secret.txt')
  writeFileSync(targetPath, 'workspace content')
  const target = { path: targetPath, info: statSync(targetPath) }
  const outside = path.join(parent, 'outside')
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), 'outside credential')

  rmSync(nested, { recursive: true })
  symlinkSync(outside, nested)
  await assert.rejects(
    openValidatedFile(target, new AbortController().signal, 'test file', root),
    (error) => ['REMOTE_PATH_CHANGED', 'REMOTE_PATH_DENIED'].includes(error.code),
  )
  assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside credential')
})


test('instruction reads return bounded full text and follow in-workspace symlinks', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-remote-instructions-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  const outside = path.join(parent, 'outside')
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(root, 'docs', 'AGENTS.md'), '# remote rules\n')
  writeFileSync(path.join(root, 'AGENTS.md'), '# root rules\n')
  writeFileSync(path.join(root, 'large.md'), 'x'.repeat(300 * 1024))
  writeFileSync(path.join(outside, 'AGENTS.md'), '# outside\n')
  symlinkSync(path.join(root, 'docs', 'AGENTS.md'), path.join(root, 'linked.md'))
  // The convention that used to abort whole sessions: the local rules alias.
  symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md'))
  symlinkSync(path.join(parent, 'outside', 'AGENTS.md'), path.join(root, 'escaped.md'))
  symlinkSync(path.join(root, 'missing-target.md'), path.join(root, 'broken.md'))
  symlinkSync(outside, path.join(root, 'linked-dir'))

  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const full = await instance.request('instruction_read', { path: 'docs/AGENTS.md' })
  assert.equal(full.content, '# remote rules\n')
  assert.equal(full.size, Buffer.byteLength(full.content))
  assert.equal(full.version.length, 64)
  assert.match(full.path, /docs[\\/]AGENTS\.md$/)

  const large = await instance.request('instruction_read', { path: 'large.md' })
  assert.equal(large.oversizeBytes, 300 * 1024)
  assert.equal(large.content, undefined)

  const linked = await instance.request('instruction_read', { path: 'linked.md' })
  assert.equal(linked.content, '# remote rules\n', 'a link inside the workspace still delivers its rules')
  assert.match(linked.path, /docs[\\/]AGENTS\.md$/, 'and reports the resolved canonical path')

  const alias = await instance.request('instruction_read', { path: 'CLAUDE.md' })
  assert.equal(alias.content, '# root rules\n')
  assert.match(alias.path, /[\\/]AGENTS\.md$/)

  await assert.rejects(instance.request('instruction_read', { path: 'escaped.md' }), (error) => error.code === 'REMOTE_CONFIG_SYMLINK')
  await assert.rejects(instance.request('instruction_read', { path: 'linked-dir/AGENTS.md' }), (error) => error.code === 'REMOTE_CONFIG_SYMLINK')
  await assert.rejects(instance.request('instruction_read', { path: 'broken.md' }), (error) => error.code === 'REMOTE_NOT_FOUND')
  await assert.rejects(instance.request('instruction_read', { path: 'missing/AGENTS.md' }), (error) => error.code === 'REMOTE_NOT_FOUND')
  await instance.shutdown()
})

test('remote helper transfers bounded image chunks and releases snapshot state', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-image-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('image-payload')])
  writeFileSync(path.join(root, 'diagram.png'), image)
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const transfer = await instance.request('image_begin', { path: 'diagram.png', maxBytes: 1024 })
  assert.equal(transfer.path, path.join(realpathSync(root), 'diagram.png'))
  assert.equal(transfer.bytes, image.length)
  assert.match(transfer.version, /^[a-f0-9]{64}$/)
  assert.ok(transfer.chunkSize <= 1024 * 1024)
  const chunks = []
  for (let offset = 0; offset < transfer.bytes; offset += transfer.chunkSize) {
    const chunk = await instance.request('image_chunk', {
      transferId: transfer.transferId,
      offset,
      length: Math.min(transfer.chunkSize, transfer.bytes - offset),
    })
    chunks.push(Buffer.from(chunk.data, 'base64'))
  }
  assert.deepEqual(Buffer.concat(chunks), image)
  assert.deepEqual(await instance.request('image_release', { transferId: transfer.transferId }), { released: true })
  await assert.rejects(instance.request('image_chunk', {
    transferId: transfer.transferId, offset: 0, length: 1,
  }), (error) => error.code === 'REMOTE_TRANSFER_EXPIRED')
  await assert.rejects(instance.request('image_begin', { path: 'diagram.png', maxBytes: 1 }), (error) => error.code === 'REMOTE_CONTENT_TOO_LARGE')
  await instance.shutdown()
})

test('remote helper runs bounded no-shell ripgrep and transfers collected output', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-remote-search-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  const bin = path.join(parent, 'bin')
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(bin)
  const capture = path.join(parent, 'argv.json')
  const terminated = path.join(parent, 'rg.terminated')
  const rg = path.join(bin, 'rg')
  writeFileSync(rg, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args));\nif (args.includes('--glob=wait')) { process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(terminated)}, 'yes'); process.exit(0); }); setInterval(() => {}, 1000); }\nelse if (args.includes('--regexp=invalid')) { process.stderr.write('regex parse error\\n'); process.exitCode = 2; }\nelse if (args.includes('--regexp=no-match')) process.exitCode = 1;\nelse if (args.includes('--glob=large')) process.stdout.write('0123456789abcdef');\nelse process.stdout.write('src/a.js\\n');\n`)
  chmodSync(rg, 0o755)
  const instance = startHelper(root, { PATH: `${bin}:${process.env.PATH || ''}` })
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const transfer = await instance.request('search_begin', {
    kind: 'glob',
    cwd: realpathSync(root),
    argv: ['--no-config', '--files', '--glob=**/*.js', '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--glob=!**/.git/**', '--', 'src'],
    stdoutMaxBytes: 1024,
    stderrMaxBytes: 1024,
    graceMs: 3000,
  })
  assert.equal(transfer.exitCode, 0)
  assert.equal(transfer.stdoutLossy, false)
  const args = JSON.parse(readFileSync(capture, 'utf8'))
  assert.deepEqual(args, ['--no-config', '--files', '--glob=**/*.js', '--sort=modified', '--no-ignore', '--hidden', '--glob=!**/.git', '--glob=!**/.git/**', '--', 'src'])
  const chunk = await instance.request('search_chunk', {
    transferId: transfer.transferId, stream: 'stdout', offset: 0, length: transfer.stdoutBytes,
  })
  assert.equal(Buffer.from(chunk.data, 'base64').toString('utf8'), 'src/a.js\n')
  assert.deepEqual(await instance.request('search_release', { transferId: transfer.transferId }), { released: true })

  const noMatches = await instance.request('search_begin', {
    kind: 'grep', cwd: realpathSync(root),
    argv: ['--no-config', '--json', '--regexp=no-match', '--', 'src'],
    stdoutMaxBytes: 1024, stderrMaxBytes: 1024, graceMs: 3000,
  })
  assert.equal(noMatches.exitCode, 1)
  await instance.request('search_release', { transferId: noMatches.transferId })

  const invalid = await instance.request('search_begin', {
    kind: 'grep', cwd: realpathSync(root),
    argv: ['--no-config', '--json', '--regexp=invalid', '--', 'src'],
    stdoutMaxBytes: 1024, stderrMaxBytes: 1024, graceMs: 3000,
  })
  assert.equal(invalid.exitCode, 2)
  assert.equal(invalid.stderrLossy, false)
  await instance.request('search_release', { transferId: invalid.transferId })

  const capped = await instance.request('search_begin', {
    kind: 'glob', cwd: realpathSync(root),
    argv: ['--no-config', '--files', '--glob=large', '--sort=modified', '--no-ignore', '--hidden', '--', 'src'],
    stdoutMaxBytes: 8, stderrMaxBytes: 1024, graceMs: 3000,
  })
  assert.equal(capped.stdoutLossy, true)
  assert.equal(capped.stdoutBytes, 8)
  const cappedChunk = await instance.request('search_chunk', {
    transferId: capped.transferId, stream: 'stdout', offset: 0, length: 8,
  })
  assert.equal(Buffer.from(cappedChunk.data, 'base64').toString('utf8'), '01234567')
  await instance.request('search_release', { transferId: capped.transferId })

  const pending = instance.request('search_begin', {
    kind: 'glob', cwd: realpathSync(root),
    argv: ['--no-config', '--files', '--glob=wait', '--sort=modified', '--no-ignore', '--hidden', '--', 'src'],
    stdoutMaxBytes: 1024, stderrMaxBytes: 1024, graceMs: 3000,
  })
  const startedBy = Date.now() + 3000
  while (Date.now() < startedBy) {
    if (existsSync(capture) && JSON.parse(readFileSync(capture, 'utf8')).includes('--glob=wait')) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(existsSync(capture) && JSON.parse(readFileSync(capture, 'utf8')).includes('--glob=wait'))
  pending.cancel()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(readFileSync(terminated, 'utf8'), 'yes')
  await instance.shutdown()
})



test('remote Bash returns bounded foreground status and timeout facts', async (t) => {
  if (process.platform === 'win32') return t.skip('requires a POSIX bash executable')
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bash-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  const result = await instance.request('bash_exec', {
    taskId: randomUUID(),
    command: 'printf stdout; printf stderr >&2; exit 7',
    cwd: realpathSync(root),
    workspaceRoot: realpathSync(root),
    mode: 'danger-full-access',
    timeoutMs: 2000,
    graceMs: 50,
    stdoutMaxBytes: 32,
    stderrMaxBytes: 32,
    env: {},
    dshEnv: {},
  })
  assert.equal(result.cwd, realpathSync(root))
  assert.equal(result.exitCode, 7)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.equal(result.stdout.text, 'stdout')
  assert.equal(result.stderr.text, 'stderr')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })

  const timedOut = await instance.request('bash_exec', {
    taskId: randomUUID(),
    command: 'sleep 10',
    cwd: realpathSync(root),
    workspaceRoot: realpathSync(root),
    mode: 'danger-full-access',
    timeoutMs: 100,
    graceMs: 50,
    stdoutMaxBytes: 32,
    stderrMaxBytes: 32,
  })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.aborted, false)
  await instance.shutdown()
})

test('confined remote Bash fails closed on hosts without Linux bwrap', async (t) => {
  if (process.platform === 'linux') return t.skip('Linux confinement is probed separately on remote hosts')
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bash-sandbox-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  await assert.rejects(instance.request('bash_exec', {
    taskId: randomUUID(),
    command: 'touch should-not-run',
    cwd: realpathSync(root),
    workspaceRoot: realpathSync(root),
    mode: 'workspace-write',
    timeoutMs: 2000,
    graceMs: 50,
    stdoutMaxBytes: 32,
    stderrMaxBytes: 32,
  }), (error) => error.code === 'REMOTE_SANDBOX_UNSUPPORTED')
  await instance.shutdown()
})


test('Linux bwrap confines reads and writes to the selected workspace', async (t) => {
  if (process.platform !== 'linux') return t.skip('requires Linux bwrap')
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bwrap-boundary-'))
  const root = path.join(parent, 'workspace')
  mkdirSync(root)
  const secretPath = path.join(parent, 'host-secret.txt')
  const outsideWrite = path.join(parent, 'outside-write.txt')
  writeFileSync(secretPath, 'host-secret-must-not-be-visible')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })
  const hello = await instance.request('hello')
  if (!hello.dependencies?.bwrap?.usable) {
    await instance.shutdown()
    return t.skip('Linux user namespaces or bwrap are unavailable')
  }

  const run = (mode, command) => instance.request('bash_exec', {
    taskId: randomUUID(), command, cwd: realpathSync(root), workspaceRoot: realpathSync(root), mode,
    timeoutMs: 5000, graceMs: 50, stdoutMaxBytes: 4096, stderrMaxBytes: 4096,
  })
  const read = await run('read-only', `cat ${JSON.stringify(secretPath)} 2>/dev/null || echo HIDDEN`)
  assert.doesNotMatch(read.stdout.text, /host-secret-must-not-be-visible/)
  assert.match(read.stdout.text, /HIDDEN/)
  const readonlyWrite = await run('read-only', 'touch forbidden.txt 2>/dev/null && echo WRITE_OK || echo WRITE_BLOCKED')
  assert.match(readonlyWrite.stdout.text, /WRITE_BLOCKED/)
  assert.equal(existsSync(path.join(root, 'forbidden.txt')), false)
  const workspaceWrite = await run('workspace-write', 'printf allowed > allowed.txt; touch ' + JSON.stringify(outsideWrite))
  assert.equal(workspaceWrite.exitCode, 0)
  assert.equal(readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'allowed')
  assert.equal(existsSync(outsideWrite), false)
  await instance.shutdown()
})


test('remote Bash cancellation targets one task and rejects out-of-root workdirs', async (t) => {
  if (process.platform === 'win32') return t.skip('requires a POSIX bash executable')
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bash-cancel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  // Confined modes still refuse a cwd outside the workspace.
  await assert.rejects(instance.request('bash_exec', {
    taskId: randomUUID(), command: 'pwd', cwd: '/tmp', workspaceRoot: realpathSync(root),
    mode: 'workspace-write', timeoutMs: 2000, graceMs: 50, stdoutMaxBytes: 32, stderrMaxBytes: 32,
  }), (error) => error.code === 'REMOTE_PATH_DENIED')

  // danger-full-access deliberately escapes the workspace: a host path outside
  // the mirror is a valid cwd there, so the command must run.
  const outside = realpathSync(tmpdir())
  const escaped = await instance.request('bash_exec', {
    taskId: randomUUID(), command: 'pwd', cwd: outside,
    mode: 'danger-full-access', timeoutMs: 5000, graceMs: 50, stdoutMaxBytes: 512, stderrMaxBytes: 512,
  })
  assert.equal(escaped.exitCode, 0)
  assert.equal(escaped.stdout.text.trim(), outside)

  const taskId = randomUUID()
  const started = path.join(root, 'started')
  const pending = instance.request('bash_exec', {
    taskId,
    command: 'printf before; : > started; sleep 10; printf after',
    cwd: realpathSync(root),
    workspaceRoot: realpathSync(root),
    mode: 'danger-full-access',
    timeoutMs: 15000,
    graceMs: 50,
    stdoutMaxBytes: 32,
    stderrMaxBytes: 32,
  })
  const deadline = Date.now() + 2000
  while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(existsSync(started), true, 'remote process should start before cancellation')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const cancelled = await instance.request('bash_cancel', { taskId, reason: 'aborted' })
  assert.equal(cancelled.accepted, true)
  const result = await pending
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.match(result.stdout.text, /before/)
  assert.doesNotMatch(result.stdout.text, /after/)
  await instance.shutdown()
})

test('project skill manifest is bounded, scoped, credential-aware, and version-checked', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-project-skills-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  const dshSkills = path.join(root, '.dsh', 'skills')
  const agentsSkills = path.join(root, '.agents', 'skills')
  mkdirSync(path.join(dshSkills, 'review'), { recursive: true })
  mkdirSync(agentsSkills, { recursive: true })
  writeFileSync(path.join(dshSkills, 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nUse remote files only.\n')
  writeFileSync(path.join(agentsSkills, 'flat.md'), '---\nname: flat\ndescription: Flat skill\n---\nRead project files.\n')
  writeFileSync(path.join(dshSkills, '.env.md'), '---\nname: secret\ndescription: Must be excluded\n---\nsecret\n')
  for (const fileName of ['private.pem.md', 'id_rsa.key.md', 'credentials.json.md']) {
    writeFileSync(path.join(agentsSkills, fileName), '---\nname: leaked\ndescription: Must be excluded\n---\ncredential\n')
  }
  writeFileSync(path.join(agentsSkills, 'large.md'), 'x'.repeat(128 * 1024 + 1))
  const outside = path.join(parent, 'outside')
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'SKILL.md'), 'outside')
  // A symlinked skill entry that is a skill IN ITS OWN RIGHT (own SKILL.md) is
  // discovered: host machines install skills exactly this way. A link onto a
  // bare directory is still skipped and reported.
  symlinkSync(outside, path.join(dshSkills, 'linked'))
  const bare = path.join(parent, 'bare')
  mkdirSync(bare)
  writeFileSync(path.join(bare, 'notes.txt'), 'not a skill')
  symlinkSync(bare, path.join(dshSkills, 'barelinked'))

  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })
  const manifest = await instance.request('project_skills_manifest')
  assert.equal(manifest.root, realpathSync(root))
  assert.equal(manifest.complete, false)
  assert.deepEqual(manifest.entries.map(({ source, relative }) => [source, relative]), [
    ['project-agents', '.agents/skills/flat.md'],
    ['project-dsh', '.dsh/skills/review/SKILL.md'],
  ])
  assert.ok(manifest.diagnostics.some(({ code }) => code === 'REMOTE_CONFIG_FILE_TOO_LARGE'))
  assert.ok(manifest.diagnostics.some(({ code }) => code === 'REMOTE_CONFIG_SYMLINK'))

  const skill = manifest.entries.find((entry) => entry.relative === '.dsh/skills/review/SKILL.md')
  assert.ok(skill)
  const body = await instance.request('project_skill_read', { path: skill.path, expectedVersion: skill.version })
  assert.match(body.text, /name: review/)
  assert.equal(body.version, skill.version)
  writeFileSync(skill.path, 'changed')
  await assert.rejects(instance.request('project_skill_read', { path: skill.path, expectedVersion: skill.version }), (error) => error.code === 'REMOTE_STALE_CONFIG')
  await assert.rejects(instance.request('project_skill_read', { path: '../outside/SKILL.md' }), (error) => error.code === 'REMOTE_PATH_DENIED')
  await instance.shutdown()
})


test('server user skills use remote homes and permit only bounded read-only skill resources', async (t) => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'dsh-user-skills-')))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  const home = path.join(parent, 'home')
  const dshHome = path.join(home, 'custom-dsh')
  const agentsHome = path.join(home, 'custom-agents')
  mkdirSync(root)
  const review = path.join(dshHome, 'skills', 'review')
  mkdirSync(path.join(review, 'references'), { recursive: true })
  mkdirSync(path.join(agentsHome, 'skills'), { recursive: true })
  writeFileSync(path.join(review, 'SKILL.md'), '---\nname: review\ndescription: Server review\n---\nRead references/guide.txt.\n')
  writeFileSync(path.join(review, 'references', 'guide.txt'), 'server resource\n')
  writeFileSync(path.join(review, 'references', 'large.txt'), 'x'.repeat(128 * 1024 + 1))
  writeFileSync(path.join(review, 'references', 'binary.txt'), Buffer.from([0xff, 0xfe]))
  writeFileSync(path.join(review, '.env'), 'secret')
  writeFileSync(path.join(agentsHome, 'skills', 'flat.md'), '---\nname: flat\ndescription: Server agents skill\n---\nServer text.\n')
  writeFileSync(path.join(dshHome, 'credentials.json'), 'host secret')
  symlinkSync(path.join(dshHome, 'credentials.json'), path.join(review, 'linked.txt'))
  const instance = startHelper(root, { HOME: home, DSH_HOME: dshHome, AGENTS_HOME: agentsHome })
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })
  const manifest = await instance.request('project_skills_manifest')
  assert.equal(manifest.complete, true)
  assert.deepEqual(manifest.entries.map((item) => [item.source, item.rank]).sort(), [['user-agents', 400], ['user-dsh', 300]])
  const skill = manifest.entries.find((item) => item.source === 'user-dsh')
  assert.equal(skill.path, path.join(review, 'SKILL.md'))
  assert.match((await instance.request('project_skill_read', { path: skill.path, expectedVersion: skill.version })).text, /Server review/)
  const resource = await instance.request('project_skill_read', { path: path.join(review, 'references', 'guide.txt'), resource: true })
  assert.equal(resource.text, 'server resource\n')
  await assert.rejects(instance.request('project_skill_read', { path: path.join(review, 'references', 'guide.txt') }), (error) => error.code === 'REMOTE_CONFIG_PATH_DENIED')
  await assert.rejects(instance.request('project_skill_read', { path: path.join(review, '.env'), resource: true }), (error) => error.code === 'REMOTE_CONFIG_PATH_DENIED')
  await assert.rejects(instance.request('project_skill_read', { path: path.join(review, 'linked.txt'), resource: true }), (error) => error.code === 'REMOTE_CONFIG_SYMLINK')
  await assert.rejects(instance.request('project_skill_read', { path: path.join(dshHome, 'credentials.json'), resource: true }), (error) => error.code === 'REMOTE_PATH_DENIED')
  await assert.rejects(instance.request('project_skill_read', { path: path.join(review, 'references', 'large.txt'), resource: true }), (error) => error.code === 'REMOTE_CONTENT_TOO_LARGE')
  await assert.rejects(instance.request('project_skill_read', { path: path.join(review, 'references', 'binary.txt'), resource: true }), (error) => error.code === 'REMOTE_CONFIG_NOT_UTF8')
  await assert.rejects(instance.request('read', { path: skill.path }), (error) => error.code === 'REMOTE_PATH_DENIED')
  await assert.rejects(instance.request('write', { path: skill.path, content: 'overwrite' }), (error) => error.code === 'REMOTE_PATH_DENIED')
  await instance.shutdown()

  const defaultSkill = path.join(home, '.dsh', 'skills', 'default.md')
  const defaultAgentsSkill = path.join(home, '.agents', 'skills', 'default-agents.md')
  mkdirSync(path.dirname(defaultSkill), { recursive: true })
  mkdirSync(path.dirname(defaultAgentsSkill), { recursive: true })
  writeFileSync(defaultSkill, '---\nname: default\ndescription: Default user skill\n---\nDefault.\n')
  writeFileSync(defaultAgentsSkill, '---\nname: default-agents\ndescription: Default agents skill\n---\nDefault.\n')
  const defaults = startHelper(root, { HOME: home, DSH_HOME: '', AGENTS_HOME: '' })
  t.after(() => { if (defaults.child.exitCode === null) defaults.child.kill() })
  assert.deepEqual((await defaults.request('project_skills_manifest')).entries.map((item) => item.path).sort(), [defaultAgentsSkill, defaultSkill].sort())
  await defaults.shutdown()
})

test('remote helper rejects traversal, symlink escape, and protocol mismatch', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-remote-helper-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  mkdirSync(root)
  const outside = path.join(parent, 'secret.txt')
  writeFileSync(outside, 'secret')
  symlinkSync(outside, path.join(root, 'escape.txt'))
  const instance = startHelper(root)
  t.after(() => { if (instance.child.exitCode === null) instance.child.kill() })

  await assert.rejects(instance.request('read', { path: '../secret.txt' }), (error) => error.code === 'REMOTE_PATH_DENIED')
  await assert.rejects(instance.request('read', { path: 'escape.txt' }), (error) => error.code === 'REMOTE_PATH_DENIED')
  await assert.rejects(instance.request('hello', {}, 99), (error) => error.code === 'REMOTE_PROTOCOL_MISMATCH')
  await instance.shutdown()
})
