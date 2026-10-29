// dsh-remote — remote instruction-file index (issue #68).
//
// The core instruction loader (@deepseek-ai/dsh-agent-instructions) discovers
// AGENTS.md through the LOCAL filesystem only: from two user-global roots plus
// the projectRoot→cwd ancestor chain. A remote session's cwd is the local
// MIRROR of the remote workspace, and that mirror stays empty until rw_sync —
// so a 20 KB AGENTS.md that governs the remote repo never enters the model's
// context, while the same file is auto-injected in a local session. File
// ACCESS was never the problem (rw_read_file reads it fine); what is missing
// is the model knowing it should.
//
// This module closes the gap on the plugin side, along the two cheapest axes
// the issue lists (the third — a remote ctx.fs provider — belongs to core):
//
//   1. INDEX in the system prompt: a shallow scan of the remote workspace
//      (root + at most two directory levels down, AGENTS.md / CLAUDE.md only)
//      is rendered into the dsh-remote prompt section as a path list with
//      headings, telling every new session the files exist and to read them
//      with rw_read_file before editing that tree. This is an INDEX, not a
//      second injection pipeline — the full text stays out of the prompt and
//      out of any parallel baseline, exactly as the issue demands.
//   2. MIRROR the found files into the local mirror at their relative paths
//      (three-way safe — a local edit is never clobbered, see below). A
//      root-level AGENTS.md then sits exactly where the CORE loader looks in
//      a local session, so the normal baseline/incremental machinery picks it
//      up unchanged; no plugin-side injection logic runs in parallel with it.
//
// Deliberate non-goals (the issue's "请不要做"):
//   - NO unbounded recursion of the remote root (multi-project roots like
//     /root would scan forever): the walk is depth- and count-capped.
//   - NO full-text injection from the plugin.

import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, closeSync, fstatSync, futimesSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { joinRemotePath, relPathUnder } from './paths.js'
import { loadSyncState, saveSyncState } from './sync.js'

/** File names treated as agent instruction files (compared case-insensitively;
 *  the mirrored copy keeps the remote's exact casing). */
export const INSTRUCTION_NAMES = ['agents.md', 'claude.md']

/** An instruction file bigger than this is indexed (path + note) but not read. */
export const INSTRUCTION_MAX_BYTES = 256 * 1024

/** Caps that keep the shallow scan shallow. */
export const INSTRUCTION_MAX_FILES = 20
export const INSTRUCTION_MAX_DIRS = 60
export const INSTRUCTION_MAX_DEPTH = 2 // 0 = workspace root, 1 = sub/, 2 = sub/sub/

/** Directories that never contain a project's governing instructions. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage', 'target', 'vendor',
])

export const isInstructionName = (name) => INSTRUCTION_NAMES.includes(String(name || '').toLowerCase())

/** Pull the first Markdown headings out of an instruction file, for the index. */
export function extractHeadings(text, max = 8) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    out.push(m[1].slice(0, 60))
    if (out.length >= max) break
  }
  return out
}

/**
 * Shallow-scan a remote workspace for instruction files: the root directory
 * plus up to INSTRUCTION_MAX_DEPTH levels of subdirectories, matching
 * AGENTS.md / CLAUDE.md basenames. Bounded by INSTRUCTION_MAX_DIRS readdirs
 * and INSTRUCTION_MAX_FILES files; anything past the caps is silently
 * skipped (the index is a hint, not an inventory).
 *
 * @param {object} sftp - the promisified sftp surface (readdir/stat/readFile).
 * @param {string} remoteRoot - absolute remote workspace path (normalized).
 * @returns {Promise<Array<{rel: string, remote: string, size: number, mtime: number, content: Buffer|null, headings: string[]}>>}
 *   `content`/`headings` are null/empty for files over INSTRUCTION_MAX_BYTES.
 */
export async function scanInstructionFiles(sftp, remoteRoot, opts = {}) {
  const maxDepth = Math.max(0, Math.min(Number(opts.maxDepth ?? INSTRUCTION_MAX_DEPTH) || 0, 4))
  const maxDirs = Math.max(1, Number(opts.maxDirs ?? INSTRUCTION_MAX_DIRS) || INSTRUCTION_MAX_DIRS)
  const maxFiles = Math.max(1, Number(opts.maxFiles ?? INSTRUCTION_MAX_FILES) || INSTRUCTION_MAX_FILES)
  const files = []
  // Breadth-first so a wide root cannot push the walk deep before the shallow
  // (more commonly governing) files are seen.
  const queue = [{ dir: remoteRoot, depth: 0 }]
  let dirsScanned = 0
  while (queue.length && files.length < maxFiles && dirsScanned < maxDirs) {
    const { dir, depth } = queue.shift()
    dirsScanned++
    let entries = []
    try { entries = (await sftp.readdir(dir)) || [] } catch { continue }
    for (const e of entries) {
      const name = String(e.filename || '')
      if (!name || name === '.' || name === '..' || name.startsWith('.')) {
        // Hidden entries are skipped wholesale EXCEPT the names themselves
        // never start with a dot, so nothing is lost.
        continue
      }
      const isDir = !!(e.attrs && typeof e.attrs.isDirectory === 'function' && e.attrs.isDirectory())
      const isLink = !!(e.attrs && typeof e.attrs.isSymbolicLink === 'function' && e.attrs.isSymbolicLink())
      if (isDir) {
        // Symlinked dirs are not followed: the walk stays inside the workspace
        // tree and cannot loop through a link back to an ancestor.
        if (isLink) continue
        if (depth < maxDepth && !SKIP_DIRS.has(name.toLowerCase()) && queue.length + dirsScanned < maxDirs) {
          queue.push({ dir: joinRemotePath(dir, name), depth: depth + 1 })
        }
        continue
      }
      if (isLink || !isInstructionName(name)) continue
      const remote = joinRemotePath(dir, name)
      const rel = relPathUnder(remoteRoot, remote) || name
      let linkInfo = null
      try { linkInfo = await sftp.lstat(remote) } catch { continue }
      if (!linkInfo || (typeof linkInfo.isSymbolicLink === 'function' && linkInfo.isSymbolicLink())) continue
      if (typeof linkInfo.isDirectory === 'function' && linkInfo.isDirectory()) continue
      let st = null
      try { st = await sftp.stat(remote) } catch { continue }
      const size = st && typeof st.size === 'number' ? st.size : 0
      const mtime = st && typeof st.mtime === 'number' ? st.mtime : 0
      let content = null
      let headings = []
      if (size <= INSTRUCTION_MAX_BYTES) {
        try {
          content = await sftp.readFile(remote)
          headings = extractHeadings(content.toString('utf8'))
        } catch { content = null }
      }
      files.push({ rel, remote, size, mtime, content, headings })
      if (files.length >= maxFiles) break
    }
  }
  return files
}

// The three-way keys mirror lib/sync.js exactly (size + whole-second mtime):
// a file this module places into the mirror must be indistinguishable from
// one rw_sync pulled, or the next sync would report a phantom conflict.
const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`
const localKeyOf = (st) => (st ? keyOf(st.size, st.mtimeMs / 1000) : null)
const instructionHash = (content) => createHash('sha256').update(content).digest('hex')

function readSafeInstructionMirrorFile(safe) {
  if (!safe?.existing) return { content: null, hash: null }
  let fd
  try {
    const parentBefore = lstatSync(safe.parent)
    if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()
      || parentBefore.dev !== safe.parentDev || parentBefore.ino !== safe.parentIno) return null
    const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0
    fd = openSync(safe.target, fsConstants.O_RDONLY | noFollow)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== safe.existing.dev || opened.ino !== safe.existing.ino) return null
    const content = readFileSync(fd)
    const after = fstatSync(fd)
    const current = lstatSync(safe.target)
    const parentAfter = lstatSync(safe.parent)
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || parentAfter.isSymbolicLink() || parentAfter.dev !== safe.parentDev || parentAfter.ino !== safe.parentIno
      || realpathSync(safe.target) !== safe.target) return null
    return { content, hash: instructionHash(content) }
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* best effort */ }
  }
}

function setSafeInstructionMirrorMtime(safe, mtime) {
  let fd
  try {
    const parent = lstatSync(safe.parent)
    if (parent.isSymbolicLink() || parent.dev !== safe.parentDev || parent.ino !== safe.parentIno) return false
    const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0
    fd = openSync(safe.target, fsConstants.O_RDONLY | noFollow)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== safe.existing.dev || opened.ino !== safe.existing.ino) return false
    const date = new Date((mtime || 0) * 1000)
    futimesSync(fd, date, date)
    const after = fstatSync(fd)
    const current = lstatSync(safe.target)
    const parentAfter = lstatSync(safe.parent)
    return after.dev === opened.dev && after.ino === opened.ino
      && !current.isSymbolicLink() && current.dev === opened.dev && current.ino === opened.ino
      && !parentAfter.isSymbolicLink() && parentAfter.dev === safe.parentDev && parentAfter.ino === safe.parentIno
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* best effort */ }
  }
}

export function safeInstructionMirrorTarget(mirrorDir, rel, { createParents = false } = {}) {
  if (typeof rel !== 'string' || !rel || rel.includes(String.fromCharCode(0)) || rel.startsWith('/')) return null
  const parts = rel.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null

  let root
  try { root = realpathSync(mirrorDir) } catch { return null }
  let parent = root
  for (const [index, part] of parts.slice(0, -1).entries()) {
    const next = path.join(parent, part)
    let info
    try { info = lstatSync(next) } catch (error) {
      if (error?.code !== 'ENOENT') return null
      if (!createParents) {
        return { root, missing: true, target: path.join(next, ...parts.slice(index + 1)) }
      }
      try { mkdirSync(next, { mode: 0o700 }); info = lstatSync(next) } catch { return null }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return null
    parent = next
  }

  let parentInfo
  try { parentInfo = lstatSync(parent) } catch { return null }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) return null

  const target = path.join(parent, parts[parts.length - 1])
  let existing = null
  try { existing = lstatSync(target) } catch (error) {
    if (error?.code !== 'ENOENT') return null
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) return null
  return { root, parent, parentDev: parentInfo.dev, parentIno: parentInfo.ino, target, existing }
}

/**
 * Prune only a previously tracked instruction whose local no-follow content hash
 * still matches the stored SHA-256. Untracked, edited, symlinked or hashless files
 * are conflicts and must remain untouched.
 */
function pruneManagedInstruction(rel, mirrorDir, state) {
  const previous = state[rel]
  const safe = safeInstructionMirrorTarget(mirrorDir, rel)
  if (safe?.missing) {
    if (previous) delete state[rel]
    return { removed: false, conflict: false, stateChanged: !!previous }
  }
  if (!safe) return { removed: false, conflict: true, stateChanged: false }
  if (!previous) return { removed: false, conflict: !!safe.existing, stateChanged: false }
  if (!safe.existing) {
    delete state[rel]
    return { removed: false, conflict: false, stateChanged: true }
  }
  const local = readSafeInstructionMirrorFile(safe)
  if (!local || typeof previous.sha256 !== 'string' || local.hash !== previous.sha256) {
    return { removed: false, conflict: true, stateChanged: false }
  }
  try {
    const parentNow = lstatSync(safe.parent)
    const fileNow = lstatSync(safe.target)
    if (parentNow.isSymbolicLink() || !parentNow.isDirectory()
      || parentNow.dev !== safe.parentDev || parentNow.ino !== safe.parentIno
      || fileNow.isSymbolicLink() || !fileNow.isFile()
      || fileNow.dev !== safe.existing.dev || fileNow.ino !== safe.existing.ino) {
      return { removed: false, conflict: true, stateChanged: false }
    }
    unlinkSync(safe.target)
    delete state[rel]
    return { removed: true, conflict: false, stateChanged: true }
  } catch {
    return { removed: false, conflict: true, stateChanged: false }
  }
}

/**
 * Three-way-safe mirror write for instruction files. SHA-256 identifies local
 * content; size/mtime stays aligned with rw_sync. For a missing or oversized
 * remote instruction, a cached copy is removed only when its stored hash matches.
 */
export function syncInstructionsToMirror(files, mirrorDir, { removeMissing = [] } = {}) {
  const written = []
  const removed = []
  const conflicts = []
  const present = new Set()
  if (!mirrorDir || !Array.isArray(files)) return { written, removed, conflicts, present }
  const state = loadSyncState(mirrorDir)
  let stateDirty = false
  for (const f of files) {
    if (!f || !f.rel) continue
    if (f.content === null || f.content === undefined || f.oversizeBytes) {
      const pruned = pruneManagedInstruction(f.rel, mirrorDir, state)
      if (pruned.removed) removed.push(f.rel)
      if (pruned.conflict) conflicts.push(f.rel)
      if (pruned.stateChanged) stateDirty = true
      continue
    }
    const safe = safeInstructionMirrorTarget(mirrorDir, f.rel, { createParents: true })
    if (!safe) { conflicts.push(f.rel); continue }
    const lp = safe.target
    const remoteBytes = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8')
    const remoteSize = Number.isFinite(f.size) ? f.size : remoteBytes.length
    if (remoteSize !== remoteBytes.length) { conflicts.push(f.rel); continue }
    const remoteHash = instructionHash(remoteBytes)
    const rk = keyOf(remoteSize, f.mtime)
    const previous = state[f.rel]
    const sk = previous ? keyOf(previous.size, previous.mtime) : null
    const local = safe.existing ? readSafeInstructionMirrorFile(safe) : null
    if (safe.existing && !local) { conflicts.push(f.rel); continue }
    const lk = safe.existing ? localKeyOf(safe.existing) : null
    if (local?.hash === remoteHash) {
      if (lk !== rk && !setSafeInstructionMirrorMtime(safe, f.mtime)) {
        conflicts.push(f.rel)
        continue
      }
      present.add(f.rel)
      if (!previous || previous.sha256 !== remoteHash || sk !== rk) {
        state[f.rel] = { size: remoteSize, mtime: f.mtime, sha256: remoteHash }
        stateDirty = true
      }
      continue
    }
    const localUnchanged = typeof previous?.sha256 === 'string' && local?.hash === previous.sha256
    const canWrite = lk === null || localUnchanged
    if (!canWrite) { conflicts.push(f.rel); continue }
    try {
      const temp = path.join(safe.parent, `.dsh-instruction-${randomUUID()}.tmp`)
      try {
        writeFileSync(temp, remoteBytes, { flag: 'wx', mode: 0o600 })
        try { utimesSync(temp, new Date(f.mtime * 1000), new Date(f.mtime * 1000)) } catch { /* cosmetic */ }
        const parentNow = lstatSync(safe.parent)
        if (parentNow.isSymbolicLink() || !parentNow.isDirectory()
          || parentNow.dev !== safe.parentDev || parentNow.ino !== safe.parentIno) {
          throw new Error('instruction mirror parent changed during write')
        }
        renameSync(temp, lp)
      } catch (error) {
        try { unlinkSync(temp) } catch { /* best effort */ }
        throw error
      }
      state[f.rel] = { size: remoteSize, mtime: f.mtime, sha256: remoteHash }
      stateDirty = true
      written.push(f.rel)
      present.add(f.rel)
    } catch {
      conflicts.push(f.rel)
    }
  }
  for (const rel of removeMissing) {
    if (!rel || present.has(rel)) continue
    const pruned = pruneManagedInstruction(rel, mirrorDir, state)
    if (pruned.removed) removed.push(rel)
    if (pruned.conflict) conflicts.push(rel)
    if (pruned.stateChanged) stateDirty = true
  }
  if (stateDirty) {
    try { saveSyncState(mirrorDir, state) } catch { /* best effort */ }
  }
  return { written, removed, conflicts: [...new Set(conflicts)], present }
}

/**
 * Render the prompt-section index of remote instruction files. Paths are
 * shown through `display` (the platform-aware display formatter), headings
 * give the model a content hint without injecting the full text.
 */
export function formatInstructionIndex(files, display = (p) => p, readTool = 'rw_read_file') {
  const lines = files.slice(0, 10).map((f) => {
    const h = f.headings && f.headings.length ? ` (headings: ${f.headings.slice(0, 6).join(' / ')})` : ''
    const over = f.size > INSTRUCTION_MAX_BYTES ? ` (${Math.round(f.size / 1024)} KB)` : ''
    const mirrored = f.mirrored ? '; synced into the local mirror' : ''
    return `- ${display(f.remote)}${h}${over}${mirrored}`
  })
  return (
    'Remote instruction files found in this workspace (they govern how to work in their directories; '
    + 'root-level copies were synced into the local mirror, but nested ones are NOT auto-injected — '
    + `read them with ${readTool} before editing that tree):\n`
    + lines.join('\n')
  )
}

/**
 * Per-process index of remote instruction scans, keyed by mirror directory.
 * Deduplicates in-flight scans, negative-caches failures for a minute (an
 * offline machine must not turn every prompt assembly into a connect
 * attempt), and never throws — the index is strictly best-effort.
 */
export function createInstructionIndex() {
  const cache = new Map() // resolvedMirrorDir → { scannedAt, files } | { failedAt }
  const inflight = new Map() // resolvedMirrorDir → Promise
  const revision = new Map()
  const RETRY_AFTER_MS = 60 * 1000

  const keyOfDir = (mirrorDir) => {
    try { return path.resolve(String(mirrorDir)) } catch { return String(mirrorDir || '') }
  }

  /**
   * Scan (or return the cached scan of) one mirror's remote workspace.
   * @param {{pool: {sftp: Function}, ws: string, mirrorDir: string, force?: boolean}} arg
   * @returns {Promise<{scannedAt: number, files: Array}|null>}
   */
  const refresh = ({ pool, ws, mirrorDir, force = false }) => {
    if (!pool || typeof pool.sftp !== 'function' || !ws || !mirrorDir) return Promise.resolve(null)
    const key = keyOfDir(mirrorDir)
    const cur = cache.get(key)
    if (!force && cur && cur.files) return Promise.resolve(cur)
    if (!force && cur && cur.failedAt && Date.now() - cur.failedAt < RETRY_AFTER_MS) return Promise.resolve(null)
    if (inflight.has(key)) return inflight.get(key)
    const startedAtRevision = revision.get(key) || 0
    let job
    job = (async () => {
      try {
        const sftp = await pool.sftp()
        const files = await scanInstructionFiles(sftp, ws)
        if ((revision.get(key) || 0) !== startedAtRevision) return null
        const synced = syncInstructionsToMirror(files, mirrorDir)
        const entry = {
          scannedAt: Date.now(),
          files: files.map((f) => ({
            rel: f.rel,
            remote: f.remote,
            size: f.size,
            headings: f.headings,
            mirrored: synced.present.has(f.rel),
          })),
          conflicts: synced.conflicts,
        }
        if ((revision.get(key) || 0) === startedAtRevision) cache.set(key, entry)
        return entry
      } catch {
        if ((revision.get(key) || 0) === startedAtRevision) cache.set(key, { failedAt: Date.now() })
        return null
      } finally {
        if (inflight.get(key) === job) inflight.delete(key)
      }
    })()
    inflight.set(key, job)
    return job
  }

  /** The cached index for a mirror, or null when unknown/failed. */
  const get = (mirrorDir) => {
    const e = cache.get(keyOfDir(mirrorDir))
    return e && e.files ? e : null
  }

  /** Fire-and-forget refresh for prompt-assembly time: starts a scan only
   *  when nothing is known about the mirror yet (recent failures included). */
  const note = ({ pool, ws, mirrorDir }) => {
    if (cache.has(keyOfDir(mirrorDir))) return
    refresh({ pool, ws, mirrorDir }).catch(() => { /* guarded inside */ })
  }

  /** Invalidate a mirror's cached path/headings index after an external helper refresh. */
  const invalidate = (mirrorDir) => {
    const key = keyOfDir(mirrorDir)
    revision.set(key, (revision.get(key) || 0) + 1)
    cache.delete(key)
    inflight.delete(key)
  }

  return { refresh, get, note, invalidate, _cache: cache }
}
