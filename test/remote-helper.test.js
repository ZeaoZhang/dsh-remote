import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { RemoteHelperBroker, collectStaleHelperVersions } from '../lib/remote-helper.js'
import { wrapSshChildChannel } from '../lib/persistent-channel.js'

const helper = fileURLToPath(new URL('../lib/remote-helper-child.cjs', import.meta.url))

function fakePool(root, options = {}) {
  const canonicalRoot = realpathSync(root)
  const remoteHome = options.remoteHome || '/remote-home'
  const nodePath = options.nodePath || process.execPath
  const staged = new Map()
  const directoryModes = new Map([[path.posix.resolve(remoteHome), 0o040755]])
  const symlinkPaths = new Set(options.symlinkPaths || [])
  let opens = 0
  return {
    staged,
    get opens() { return opens },
    async detect() { this.platform = 'posix' },
    async exec(command) {
      if (command.startsWith('cd "$HOME"')) return { code: 0, stdout: remoteHome, stderr: '' }
      if (command.startsWith('cd ')) return { code: 0, stdout: canonicalRoot, stderr: '' }
      if (command.startsWith('command -v node')) return { code: 0, stdout: nodePath, stderr: '' }
      throw new Error('unexpected setup command: ' + command)
    },
    async sftp() {
      const normalize = (value) => path.posix.normalize(value)
      return {
        async readdir(target) {
          const parent = normalize(target)
          const directories = [...directoryModes.entries()]
            .filter(([candidate]) => path.posix.dirname(candidate) === parent)
            .map(([candidate, mode]) => ({ filename: path.posix.basename(candidate), attrs: { mode, mtime: Math.floor(Date.now() / 1000) } }))
          const files = [...staged.entries()]
            .filter(([candidate]) => path.posix.dirname(candidate) === parent)
            .map(([candidate]) => ({ filename: path.posix.basename(candidate), attrs: { mode: 0o100600, mtime: Math.floor(Date.now() / 1000) } }))
          return [...directories, ...files]
        },
        async rmdir(target) { directoryModes.delete(normalize(target)) },
        async realpath(target) {
          const value = normalize(target)
          if (directoryModes.has(value) || staged.has(value)) return value
          try { return realpathSync(target) } catch { return path.posix.resolve(value) }
        },
        lstat: async (target) => {
          const value = normalize(target)
          if (symlinkPaths.has(value)) return { mode: 0o120777 }
          if (directoryModes.has(value)) return { mode: directoryModes.get(value) }
          if (staged.has(value)) return { mode: 0o100600 }
          try { return { mode: realpathSync(target) && 0o100600 } } catch { throw new Error('no such file: ' + target) }
        },
        mkdir: async (target) => {
          const value = normalize(target)
          if (directoryModes.has(value)) throw new Error('Failure: already exists')
          directoryModes.set(value, 0o040755)
        },
        setstat: async (target, attrs) => {
          const value = normalize(target)
          if (directoryModes.has(value)) directoryModes.set(value, (0o040000 | attrs.mode))
        },
        readFile: async (file) => {
          const value = normalize(file)
          if (!staged.has(value)) throw new Error('no such file: ' + file)
          return staged.get(value)
        },
        writeFile: async (file, content) => { staged.set(normalize(file), Buffer.from(content)) },
        renameOverwrite: async (from, to) => { staged.set(normalize(to), staged.get(normalize(from))); staged.delete(normalize(from)) },
        rename: async (from, to) => { staged.set(normalize(to), staged.get(normalize(from))); staged.delete(normalize(from)) },
        unlink: async (file) => { staged.delete(normalize(file)) },
      }
    },
    async openExecChannel() {
      opens += 1
      return wrapSshChildChannel(spawn(process.execPath, [helper, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] }))
    },
  }
}

test('broker stages the helper once and reuses one negotiated channel per root', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-helper-broker-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'hello.txt'), 'remote data\n')
  const pool = fakePool(root)
  const preflights = []
  const broker = new RemoteHelperBroker({ onCapabilities: (status) => preflights.push(status) })
  t.after(() => broker.close())

  const [first, second] = await Promise.all([broker.get(pool, root), broker.get(pool, root)])
  assert.equal(first, second)
  assert.equal(pool.opens, 1)
  assert.equal(preflights.length, 1)
  assert.equal(typeof preflights[0].dependencies.rg.available, 'boolean')
  assert.equal(typeof preflights[0].dependencies.bwrap.usable, 'boolean')
  assert.equal(pool.staged.size, 1)
  const reads = await Promise.all(Array.from({ length: 100 }, () => first.rpc.request('read', { path: path.join(realpathSync(root), 'hello.txt'), offset: 1, limit: 10 })))
  assert.equal(reads.length, 100)
  assert.ok(reads.every((read) => read.lines[0].text === 'remote data'))
  assert.equal(pool.opens, 1)
  await broker.close()
  assert.equal(first.rpc.closed, true)
})

test('broker refuses a Node runtime inside the workspace before starting the helper', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-helper-node-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const nodePath = path.join(root, 'node')
  writeFileSync(nodePath, 'not a runtime')
  const pool = fakePool(root, { nodePath })
  const broker = new RemoteHelperBroker()
  t.after(() => broker.close())

  await assert.rejects(broker.get(pool, root), /Node.js resolves inside the writable workspace/)
  assert.equal(pool.opens, 0)
})

test('broker rejects a Node symlink whose canonical target is inside the workspace', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-helper-node-link-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'workspace')
  mkdirSync(root)
  const workspaceNode = path.join(root, 'node')
  writeFileSync(workspaceNode, 'not a runtime')
  const nodeLink = path.join(parent, 'node')
  symlinkSync(workspaceNode, nodeLink)
  const pool = fakePool(root, { nodePath: nodeLink })
  const broker = new RemoteHelperBroker()
  t.after(() => broker.close())

  await assert.rejects(broker.get(pool, root), /Node.js resolves inside the writable workspace/)
  assert.equal(pool.opens, 0)
})


test('broker rejects a helper directory symlink into the workspace', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-helper-dir-link-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const alias = '/remote-home/.dsh-remote'
  const pool = fakePool(root, { symlinkPaths: [alias] })
  const broker = new RemoteHelperBroker()
  t.after(() => broker.close())

  await assert.rejects(broker.get(pool, root), /path component is not a directory/)
  assert.equal(pool.opens, 0)
})


test('broker refuses to stage helper code inside the workspace-write root', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-helper-dir-root-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pool = fakePool(root, { remoteHome: realpathSync(root) })
  const broker = new RemoteHelperBroker()
  t.after(() => broker.close())

  await assert.rejects(broker.get(pool, root), /helper directory is inside the writable workspace/)
  assert.equal(pool.opens, 0)
})


test('broker does not share helper channels across workspace roots', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-helper-roots-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const leftRoot = path.join(parent, 'left')
  const rightRoot = path.join(parent, 'right')
  mkdirSync(leftRoot)
  mkdirSync(rightRoot)
  const pool = fakePool(leftRoot)
  const broker = new RemoteHelperBroker()
  t.after(() => broker.close())

  const left = await broker.get(pool, leftRoot)
  const right = await broker.get(pool, rightRoot)
  assert.notEqual(left, right)
  assert.equal(pool.opens, 2)
})


test('helper GC removes only old, content-shaped, inactive hash directories', async () => {
  const root = '/remote-home/.dsh-remote/helpers'
  const currentHash = 'c'.repeat(20)
  const oldHash = 'a'.repeat(20)
  const recentHash = 'b'.repeat(20)
  const malformedHash = 'd'.repeat(20)
  const linkedHash = 'e'.repeat(20)
  const unknownTimeHash = 'f'.repeat(20)
  const now = Math.floor(Date.now() / 1000)
  const oldTime = now - 40 * 24 * 60 * 60
  const dirs = new Map()
  const files = new Map()
  const removed = []
  const addVersion = (hash, { mtime = oldTime, child = 'remote-helper-child.cjs', linked = false } = {}) => {
    const dir = `${root}/${hash}`
    dirs.set(dir, { mode: 0o040700, mtime, linked })
    files.set(`${dir}/${child}`, { mode: 0o100600, mtime })
  }
  addVersion(currentHash)
  addVersion(oldHash)
  addVersion(recentHash, { mtime: now })
  addVersion(malformedHash, { child: 'user-data.txt' })
  addVersion(linkedHash, { linked: true })
  addVersion(unknownTimeHash, { mtime: Number.NaN })
  const sftp = {
    async readdir(target) {
      if (target === root) return [...dirs.entries()].filter(([dir]) => path.posix.dirname(dir) === root)
        .map(([dir, attrs]) => ({ filename: path.posix.basename(dir), attrs }))
      const entries = [...files.entries()].filter(([file]) => path.posix.dirname(file) === target)
      return entries.map(([file, attrs]) => ({ filename: path.posix.basename(file), attrs }))
    },
    async realpath(target) {
      const dir = dirs.get(target)
      return dir?.linked ? '/outside/linked-helper' : target
    },
    async unlink(target) { removed.push(target); files.delete(target) },
    async rmdir(target) { removed.push(target); dirs.delete(target) },
  }
  await collectStaleHelperVersions(sftp, { dir: `${root}/${currentHash}` })
  assert.deepEqual(removed, [`${root}/${oldHash}/remote-helper-child.cjs`, `${root}/${oldHash}`])
  assert.ok(dirs.has(`${root}/${currentHash}`))
  assert.ok(dirs.has(`${root}/${recentHash}`))
  assert.ok(dirs.has(`${root}/${malformedHash}`))
  assert.ok(dirs.has(`${root}/${linkedHash}`))
})

test('broker reopens a fresh helper channel after the cached one closes', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-helper-reopen-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'hello.txt'), 'remote data\n')
  const pool = fakePool(root)
  const broker = new RemoteHelperBroker()
  t.after(() => broker.close())

  const first = await broker.get(pool, root)
  first.rpc.close()
  assert.equal(first.rpc.closed, true)

  const second = await broker.get(pool, root)
  assert.notEqual(second, first)
  assert.notEqual(second.rpc, first.rpc)
  assert.equal(pool.opens, 2)
  const read = await second.rpc.request('read', { path: path.join(realpathSync(root), 'hello.txt'), offset: 1, limit: 10 })
  assert.equal(read.lines[0].text, 'remote data')
})
