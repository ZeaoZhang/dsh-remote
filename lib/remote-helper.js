import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { joinRemotePath, shq } from './paths.js'
import { RemoteRpcChannel, REMOTE_RPC_PROTOCOL_VERSION } from './remote-rpc.js'

const HELPER_FILE = fileURLToPath(new URL('./remote-helper-child.cjs', import.meta.url))
const HELPER_SOURCE = readFileSync(HELPER_FILE)
const HELPER_HASH = createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 20)
const STALE_HELPER_AGE_SECONDS = 30 * 24 * 60 * 60

function commandResult(result, subject) {
  if (!result || Number(result.code) !== 0) {
    const detail = String(result?.stderr || result?.stdout || '').trim()
    throw new Error(`${subject}${detail ? ': ' + detail : ''}`)
  }
  return String(result.stdout || '').trim()
}

function missingFile(error) {
  return /no such file|not found|does not exist|ENOENT/i.test(String(error?.message || error))
}

function withinRemoteRoot(root, candidate) {
  const relative = path.posix.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
}

async function sftpRealpath(sftp, target) {
  if (typeof sftp?.realpath !== 'function') {
    throw new Error('transparent remote execution requires SFTP realpath support to protect helper integrity')
  }
  return String(await sftp.realpath(target) || '')
}

async function remoteHelperPath(pool, workspaceRoot) {
  await pool.detect()
  if (pool.platform !== 'posix') throw new Error('transparent remote execution currently requires a POSIX remote host')
  const nodeResult = await pool.exec('command -v node || command -v nodejs', { timeoutMs: 8000 })
  const nodeCandidate = commandResult(nodeResult, 'remote helper requires Node.js on PATH')
  if (!path.posix.isAbsolute(nodeCandidate) || /[\r\n\0]/.test(nodeCandidate)) {
    throw new Error('remote Node.js must resolve to one absolute executable path')
  }
  const sftp = await pool.sftp()
  const nodePath = await sftpRealpath(sftp, nodeCandidate)
  if (!path.posix.isAbsolute(nodePath) || /[\r\n\0]/.test(nodePath)) {
    throw new Error('remote Node.js realpath is invalid')
  }
  if (withinRemoteRoot(workspaceRoot, nodePath)) {
    throw new Error('remote Node.js resolves inside the writable workspace; refusing to launch a mutable helper runtime')
  }
  const homeResult = await pool.exec('cd "$HOME" && pwd -P', { timeoutMs: 8000 })
  const home = commandResult(homeResult, 'cannot determine the remote home directory')
  if (!home.startsWith('/') || /[\r\n\0]/.test(home)) throw new Error('remote HOME did not resolve to an absolute POSIX path')
  const dir = joinRemotePath(joinRemotePath(home, '.dsh-remote'), `helpers/${HELPER_HASH}`)
  if (withinRemoteRoot(workspaceRoot, dir)) {
    throw new Error('remote helper directory is inside the writable workspace; refusing to weaken helper integrity')
  }
  const file = joinRemotePath(dir, 'remote-helper-child.cjs')
  return { nodePath, home, dir, file }
}

async function lstatOptional(sftp, target) {
  try { return await sftp.lstat(target) } catch (error) {
    if (missingFile(error)) return null
    throw error
  }
}

function assertRemoteDirectoryAttributes(attrs, target, newlyCreated) {
  if (!attrs || (Number(attrs.mode) & 0o170000) !== 0o040000) {
    throw new Error(`remote helper path component is not a directory: ${target}`)
  }
  if (!newlyCreated && (Number(attrs.mode) & 0o022) !== 0) {
    throw new Error(`remote helper parent directory is group/world writable: ${target}`)
  }
}

function assertRemoteRegularFileAttributes(attrs, target) {
  if (!attrs || (Number(attrs.mode) & 0o170000) !== 0o100000) {
    throw new Error(`remote helper file is not a regular file: ${target}`)
  }
  if ((Number(attrs.mode) & 0o022) !== 0) {
    throw new Error(`remote helper file is group/world writable: ${target}`)
  }
}

async function ensureHelperDirectory(sftp, target, workspaceRoot) {
  const relative = path.posix.relative(target.home, target.dir)
  if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error('remote helper directory must be below the remote home directory')
  }
  let current = target.home
  for (const segment of relative.split('/').filter(Boolean)) {
    current = joinRemotePath(current, segment)
    let attrs = await lstatOptional(sftp, current)
    const newlyCreated = attrs === null
    if (newlyCreated) {
      try { await sftp.mkdir(current) } catch (error) {
        if (!/exist/i.test(String(error?.message || error))) throw error
      }
      attrs = await sftp.lstat(current)
    }
    assertRemoteDirectoryAttributes(attrs, current, newlyCreated)
    const canonical = await sftp.realpath(current)
    if (path.posix.normalize(canonical) !== path.posix.normalize(current)) {
      throw new Error(`remote helper directory contains a symlink: ${current}`)
    }
    if (withinRemoteRoot(workspaceRoot, canonical)) {
      throw new Error('remote helper directory is inside the writable workspace; refusing to weaken helper integrity')
    }
    if (newlyCreated) await sftp.setstat(current, { mode: 0o700 })
  }
  return { ...target, dir: current, file: joinRemotePath(current, path.posix.basename(target.file)) }
}

export async function collectStaleHelperVersions(sftp, target) {
  const versionsDir = path.posix.dirname(target.dir)
  let entries
  try { entries = await sftp.readdir(versionsDir) } catch { return }
  const cutoff = Math.floor(Date.now() / 1000) - STALE_HELPER_AGE_SECONDS
  for (const entry of entries) {
    try {
      const name = String(entry.filename || entry.name || '')
      if (!/^[a-f0-9]{20}$/i.test(name) || name === path.posix.basename(target.dir)) continue
      const dir = joinRemotePath(versionsDir, name)
      const attrs = entry.attrs || await lstatOptional(sftp, dir)
      const modifiedAt = Number(attrs?.mtime)
      if (!attrs || !Number.isFinite(modifiedAt) || modifiedAt > cutoff || (Number(attrs.mode) & 0o170000) !== 0o040000) continue
      assertRemoteDirectoryAttributes(attrs, dir, false)
      const canonical = await sftp.realpath(dir)
      if (path.posix.normalize(canonical) !== path.posix.normalize(dir)) continue
      const children = await sftp.readdir(dir)
      if (children.length !== 1 || String(children[0].filename || children[0].name || '') !== 'remote-helper-child.cjs') continue
      const helperFile = joinRemotePath(dir, 'remote-helper-child.cjs')
      const fileAttrs = children[0].attrs || await lstatOptional(sftp, helperFile)
      assertRemoteRegularFileAttributes(fileAttrs, helperFile)
      if (path.posix.normalize(await sftp.realpath(helperFile)) !== path.posix.normalize(helperFile)) continue
      await sftp.unlink(helperFile)
      await sftp.rmdir(dir)
    } catch { /* GC is best-effort; staging the active helper must still succeed. */ }
  }
}

async function stageHelper(pool, target, workspaceRoot) {
  const sftp = await pool.sftp()
  let canonicalTarget
  canonicalTarget = await ensureHelperDirectory(sftp, target, workspaceRoot)
    const existingAttrs = await lstatOptional(sftp, canonicalTarget.file)
    if (existingAttrs) {
      assertRemoteRegularFileAttributes(existingAttrs, canonicalTarget.file)
      const actualPath = await sftp.realpath(canonicalTarget.file)
      if (path.posix.normalize(actualPath) !== path.posix.normalize(canonicalTarget.file)) {
        throw new Error('remote helper file resolves through a symlink')
      }
      const existing = await sftp.readFile(canonicalTarget.file)
      if (Buffer.compare(Buffer.from(existing), HELPER_SOURCE) !== 0) {
        throw new Error('remote helper content does not match its content-addressed path')
      }
      await collectStaleHelperVersions(sftp, canonicalTarget)
      return canonicalTarget
    }

    const temp = canonicalTarget.file + '.tmp-' + randomUUID()
    try {
      await sftp.writeFile(temp, HELPER_SOURCE)
      await sftp.setstat(temp, { mode: 0o600 })
      if (typeof sftp.renameOverwrite === 'function') await sftp.renameOverwrite(temp, canonicalTarget.file)
      else await sftp.rename(temp, canonicalTarget.file)
    } catch (error) {
      try { await sftp.unlink(temp) } catch { /* best effort */ }
      throw new Error('cannot stage the remote helper: ' + String(error?.message || error))
    }
    const attrs = await sftp.lstat(canonicalTarget.file)
    assertRemoteRegularFileAttributes(attrs, canonicalTarget.file)
    const actualPath = await sftp.realpath(canonicalTarget.file)
    if (path.posix.normalize(actualPath) !== path.posix.normalize(canonicalTarget.file)) {
      throw new Error('staged remote helper resolves through a symlink')
    }
    const installed = await sftp.readFile(canonicalTarget.file)
    if (Buffer.compare(Buffer.from(installed), HELPER_SOURCE) !== 0) {
      throw new Error('staged remote helper failed content verification')
    }
    await collectStaleHelperVersions(sftp, canonicalTarget)
    return canonicalTarget
}

/** Shares one negotiated helper RPC channel per SSH pool and remote workspace. */
export class RemoteHelperBroker {
  constructor({ onCapabilities } = {}) {
    this.onCapabilities = typeof onCapabilities === 'function' ? onCapabilities : null
    this.byPool = new WeakMap()
    this.sessions = new Set()
    this.closed = false
  }

  async get(pool, remoteRoot) {
    if (this.closed) throw new Error('remote helper broker is closed')
    if (!pool || typeof pool.openExecChannel !== 'function') throw new Error('SSH pool does not support persistent helper channels')
    const root = String(remoteRoot || '').trim()
    if (!root.startsWith('/')) throw new Error('remote helper requires an absolute POSIX workspace root')
    let roots = this.byPool.get(pool)
    if (!roots) {
      roots = new Map()
      this.byPool.set(pool, roots)
    }
    const previous = roots.get(root)
    if (previous?.rpc && !previous.rpc.closed) return previous
    if (previous?.opening) return previous.opening

    const record = { pool, keyRoot: root, root, rpc: null, opening: null }
    roots.set(root, record)
    record.opening = this.#open(record)
    try {
      return await record.opening
    } catch (error) {
      if (roots.get(root) === record) roots.delete(root)
      this.sessions.delete(record)
      throw error
    } finally {
      record.opening = null
    }
  }

  async #open(record) {
    const rootResult = await record.pool.exec(`cd ${shq(record.root)} && pwd -P`, { timeoutMs: 8000 })
    record.root = commandResult(rootResult, 'cannot resolve the remote workspace root')
    if (!record.root.startsWith('/')) throw new Error('remote workspace did not resolve to an absolute POSIX path')
    const candidate = await remoteHelperPath(record.pool, record.root)
    const target = await stageHelper(record.pool, candidate, record.root)
    const command = `exec ${shq(target.nodePath)} ${shq(target.file)} --root ${shq(record.root)}`
    const transport = await record.pool.openExecChannel(command)
    const rpc = new RemoteRpcChannel(transport)
    record.rpc = rpc
    record.helper = target
    this.sessions.add(record)
    rpc.once('close', () => {
      const roots = this.byPool.get(record.pool)
      if (roots?.get(record.keyRoot) === record) roots.delete(record.keyRoot)
      this.sessions.delete(record)
    })
    try {
      const hello = await rpc.request('hello', {}, { timeoutMs: 10000 })
      if (Number(hello?.protocol) !== REMOTE_RPC_PROTOCOL_VERSION) throw new Error(`remote helper protocol mismatch: expected ${REMOTE_RPC_PROTOCOL_VERSION}`)
      if (String(hello?.root || '') !== record.root) throw new Error(`remote helper opened unexpected workspace root: ${String(hello?.root || '')}`)
      record.platform = String(hello.platform || '')
      record.dependencies = hello.dependencies && typeof hello.dependencies === 'object' ? hello.dependencies : {}
      try { this.onCapabilities?.({ root: record.root, dependencies: record.dependencies, capabilities: hello.capabilities || [] }) } catch { /* diagnostics must not fail helper startup */ }
      return record
    } catch (error) {
      await rpc.close()
      throw error
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    const records = [...this.sessions]
    this.sessions.clear()
    await Promise.all(records.map((record) => record.rpc?.close({ shutdown: true }).catch(() => {})))
    this.byPool = new WeakMap()
  }
}
