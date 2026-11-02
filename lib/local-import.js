// dsh-remote — import local-machine files into the remote workspace on demand.
//
// Transparent mode runs the standard tools on the SSH host, so a path that the
// model received from the LOCAL side — a chat attachment, a browser screenshot
// — cannot be read at all. Instead of teaching the tools to read local files
// (bash/glob/grep/edit would still run remotely and break the moment the model
// builds on the content), the first `read`/`read_image` that targets such a
// path copies the file onto the host and then serves the operation from the
// remote copy. Everything downstream — bash, edit, glob, grep — works on the
// imported path without special cases.
//
// Imports are content-addressed (<ws>/.dsh-remote/imports/<sha256>/<basename>)
// and recorded in a per-mirror ledger so a repeated read of the same local
// path costs one stat instead of another upload.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const IMPORT_DIR = ['.dsh-remote', 'imports']
const DEFAULT_MAX_IMPORT_BYTES = 52428800

function harnessHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

/** Directories whose local files may be imported when a tool reads them. */
export function defaultImportRoots() {
  const home = harnessHome()
  return [path.join(home, 'attachments'), path.join(home, 'browser-control')]
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~' + path.sep)) return path.join(os.homedir(), value.slice(2))
  return value
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function sanitizeBasename(value) {
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f\\/]/g, '_').trim()
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : 'import.bin'
}

async function sha256File(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

/**
 * Decide whether a local path may be imported.
 *
 * Returns `{ ok: true, realPath, size, mtimeNs }` for a regular file that lives
 * under one of the roots (after symlink resolution), or
 * `{ ok: false, reason }` with a message meant for the model.
 */
export async function inspectLocalFile(localPath, { roots, maxBytes }) {
  if (typeof localPath !== 'string' || localPath.length === 0) {
    return { ok: false, reason: 'the path is empty' }
  }
  if (localPath.includes('\0')) return { ok: false, reason: 'the path contains a NUL byte' }
  if (!path.isAbsolute(localPath)) return { ok: false, reason: 'the path is not absolute' }

  let stats
  try {
    stats = await stat(localPath, { bigint: true })
  } catch (error) {
    return { ok: false, reason: `it does not exist on this machine (${error?.code || 'stat failed'})` }
  }
  if (typeof stats.isFile === 'function' && !stats.isFile()) {
    return { ok: false, reason: 'it is not a regular file' }
  }
  const size = Number(stats.size)
  if (maxBytes > 0 && size > maxBytes) {
    return { ok: false, reason: `it is ${size} bytes, above the local import limit of ${maxBytes} bytes` }
  }

  let resolved
  try {
    resolved = await realpath(localPath)
  } catch (error) {
    return { ok: false, reason: `its real path cannot be resolved (${error?.code || 'realpath failed'})` }
  }
  if (!roots.some((root) => withinRoot(root, resolved))) {
    return {
      ok: false,
      reason: `it is outside the local import roots (${roots.length > 0 ? roots.join(', ') : 'none configured'})`,
    }
  }
  return { ok: true, realPath: resolved, size, mtimeNs: String(stats.mtimeNs) }
}

function importRejected(localPath, reason) {
  const error = new Error(`local file ${localPath} cannot be imported onto the remote host: ${reason}`)
  error.code = 'LOCAL_IMPORT_REJECTED'
  return error
}

async function resolveRoots(configuredRoots) {
  const expanded = configuredRoots.map(expandHome).filter((root) => root.length > 0)
  const roots = []
  for (const root of expanded) {
    try {
      const resolved = await realpath(root)
      if (!roots.includes(resolved)) roots.push(resolved)
    } catch { /* a missing import root simply admits nothing */ }
  }
  return roots
}

/**
 * Build the importer the transparent tools call.
 *
 * @param {object} options
 * @param {object} options.config - resolved plugin config.
 * @returns {{ isImportable: (p: string) => Promise<boolean>, importFile: (r: object) => Promise<object> }}
 */
export function createLocalImporter({ config = {} } = {}) {
  const enabled = config.localImport !== false
  const configuredRoots = Array.isArray(config.localImportRoots) && config.localImportRoots.length > 0
    ? config.localImportRoots.filter((root) => typeof root === 'string' && root.trim().length > 0)
    : defaultImportRoots()
  const maxBytes = Number.isFinite(config.maxImportBytes) && config.maxImportBytes >= 0
    ? Math.floor(config.maxImportBytes)
    : DEFAULT_MAX_IMPORT_BYTES

  // mirrorDir -> parsed ledger; the object is mutated in place under the queue.
  const ledgers = new Map()
  // mirrorDir -> serialised ledger writes (imports can run concurrently).
  const queues = new Map()
  // "mirrorDir\0localPath" -> in-flight import.
  const inflight = new Map()

  async function inspect(localPath) {
    const roots = await resolveRoots(configuredRoots)
    return inspectLocalFile(localPath, { roots, maxBytes })
  }

  async function isImportable(localPath) {
    if (!enabled) return false
    const inspected = await inspect(localPath)
    return inspected.ok === true
  }

  function ledgerPath(mirrorDir) {
    return path.join(mirrorDir, '.dsh-remote-imports.json')
  }

  async function loadLedger(mirrorDir) {
    const cached = ledgers.get(mirrorDir)
    if (cached) return cached
    let entries = {}
    try {
      const raw = await readFile(ledgerPath(mirrorDir), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') entries = parsed.entries
    } catch { /* a missing or corrupt ledger is simply empty */ }
    const ledger = { entries }
    ledgers.set(mirrorDir, ledger)
    return ledger
  }

  async function saveLedger(mirrorDir, ledger) {
    const target = ledgerPath(mirrorDir)
    const body = `${JSON.stringify({ version: 1, entries: ledger.entries }, null, 2)}\n`
    const temp = `${target}.tmp-${randomUUID()}`
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await writeFile(temp, body, 'utf8')
      await rename(temp, target)
    } catch (error) {
      try { await unlink(temp) } catch { /* best effort */ }
      throw error
    }
  }

  function mutateLedger(mirrorDir, mutate) {
    const previous = queues.get(mirrorDir) || Promise.resolve()
    const job = async () => {
      const ledger = await loadLedger(mirrorDir)
      // Another importer (a different agent) may have appended since we read;
      // ledger entries are a cache, so merging keeps both instead of the last
      // writer silently dropping the other's.
      try {
        const parsed = JSON.parse(await readFile(ledgerPath(mirrorDir), 'utf8'))
        if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
          Object.assign(ledger.entries, parsed.entries)
        }
      } catch { /* first write, or a corrupt ledger */ }
      const result = mutate(ledger)
      await saveLedger(mirrorDir, ledger)
      return result
    }
    const next = previous.then(job, job)
    queues.set(mirrorDir, next.then(() => undefined, () => undefined))
    return next
  }

  async function ensureRemoteDir(sftp, dir, workspace) {
    const parts = path.posix.relative(workspace, dir).split('/').filter((part) => part.length > 0)
    let current = workspace
    for (const part of parts) {
      current = path.posix.join(current, part)
      try {
        await sftp.stat(current)
        continue
      } catch { /* create it */ }
      try {
        await sftp.mkdir(current)
      } catch (error) {
        // Another importer may have won the race; only fail if it is still absent.
        try {
          await sftp.stat(current)
        } catch {
          throw new Error(`local import cannot create remote directory ${current}: ${error?.message || error}`)
        }
      }
    }
  }

  async function upload(sftp, { localFile, remotePath, size, workspace }) {
    await ensureRemoteDir(sftp, path.posix.dirname(remotePath), workspace)
    try {
      const existing = await sftp.stat(remotePath)
      if (Number(existing.size) === size) return
    } catch { /* absent */ }
    const temp = `${remotePath}.incoming-${randomUUID()}`
    await sftp.fastPut(localFile, temp)
    try {
      // renameOverwrite gives POSIX replace semantics on the OpenSSH backend
      // too; a plain rename fails when the destination exists on many servers.
      await sftp.renameOverwrite(temp, remotePath)
    } catch (error) {
      try { await sftp.unlink(temp) } catch { /* best effort cleanup */ }
      throw error
    }
  }

  async function runImport({ localPath, binding }) {
    const workspace = binding?.ws
    const mirrorDir = binding?.mirrorDir
    if (typeof workspace !== 'string' || !path.posix.isAbsolute(workspace)) {
      throw new Error('local import requires a POSIX remote workspace path')
    }
    if (typeof mirrorDir !== 'string' || mirrorDir.length === 0) {
      throw new Error('local import requires a session mirror directory')
    }
    const sftp = await binding.pool?.sftp?.()
    if (!sftp || typeof sftp.fastPut !== 'function') {
      throw new Error('local import requires an SFTP-capable SSH connection')
    }

    const inspected = await inspect(localPath)
    if (!inspected.ok) throw importRejected(localPath, inspected.reason)

    const ledger = await loadLedger(mirrorDir)
    const cached = ledger.entries[inspected.realPath]
    if (cached && typeof cached.remotePath === 'string'
      && cached.size === inspected.size && cached.mtimeNs === inspected.mtimeNs) {
      // Trust the ledger only while the staged copy still exists: a cleaned
      // workspace must re-import instead of failing the read with ENOENT.
      try {
        const staged = await sftp.stat(cached.remotePath)
        if (Number(staged.size) === cached.size) {
          return { remotePath: cached.remotePath, sha256: cached.sha256, size: inspected.size, reused: true }
        }
      } catch { /* re-import below */ }
    }

    const sha256 = await sha256File(inspected.realPath)
    const remotePath = path.posix.join(workspace, ...IMPORT_DIR, sha256, sanitizeBasename(path.basename(inspected.realPath)))
    await upload(sftp, { localFile: inspected.realPath, remotePath, size: inspected.size, workspace })
    const entry = {
      remotePath,
      sha256,
      size: inspected.size,
      mtimeNs: inspected.mtimeNs,
      importedAt: new Date().toISOString(),
    }
    await mutateLedger(mirrorDir, (current) => { current.entries[inspected.realPath] = entry })
    return { remotePath, sha256, size: inspected.size, reused: false }
  }

  return {
    isImportable,
    async importFile({ localPath, binding, exec }) {
      if (!enabled) throw importRejected(localPath, 'local imports are disabled in this deployment')
      const key = `${binding?.mirrorDir ?? ''}\0${localPath}`
      const running = inflight.get(key)
      if (running) return running
      const job = runImport({ localPath, binding, exec })
      inflight.set(key, job)
      try {
        return await job
      } finally {
        inflight.delete(key)
      }
    },
  }
}
