// dsh-remote — dynamic remote instruction refresh (issue #71).
//
// Legacy rw_* tools are not recognized by DSH's built-in agent-instructions
// incremental path, so they use a plugin-owned message with a distinct source.
// Transparent standard tools instead use `readInstruction` to refresh the local
// mirror BEFORE the DSH core `tools/result` hook runs; the core remains the sole
// injector for those calls, avoiding duplicate or conflicting messages.
//
// Both paths keep root instructions as the core baseline, bound nested refreshes
// to touched ancestors, scope removal notices, and never treat a transport error
// as a remote deletion.

import { statSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { joinRemotePath, relPathUnder } from './paths.js'
import { INSTRUCTION_MAX_BYTES, syncInstructionsToMirror } from './instructions.js'

/** The message source kind this plugin owns. Deliberately NOT the core's
 *  `agent-instructions`: consumers fall through unknown kinds, and the core's
 *  reconcile only claims messages carrying its own kind. */
export const REMOTE_INSTRUCTIONS_KIND = 'dsh-remote-instructions'

/** Total byte budget for one injected batch (the core's own budget is similar). */
export const INSTRUCTION_MESSAGE_MAX_BYTES = 16 * 1024

/** Per-session throttle for the stat-and-refresh sweep, in milliseconds. */
export const REFRESH_THROTTLE_MS = 30 * 1000

const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`

/**
 * Split a remote path into the ancestor directories strictly BELOW `root`,
 * root-excluded — the core's `ancestorChain(cwd, dir).slice(1)` shape.
 *
 * Reading `<root>/a/b/c.ts` yields `['a', 'a/b']`, so `a/AGENTS.md` and
 * `a/b/AGENTS.md` are both in scope while `<root>/AGENTS.md` (the baseline
 * layer) is not re-scanned. A path at or above the root yields `[]`.
 *
 * @param {string} root - the workspace root (remote absolute path).
 * @param {string} touched - the touched remote path.
 * @returns {string[]} workspace-relative directory prefixes, shallow → deep.
 */
export function descendantDirs(root, touched) {
  const rootRel = relPathUnder(String(root || ''), String(touched || ''))
  if (!rootRel) return []
  const parts = rootRel.split('/').filter(Boolean)
  // The last part is the file itself; the chain stops at its directory.
  parts.pop()
  const out = []
  let cur = ''
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part
    out.push(cur)
  }
  return out
}

/**
 * Which instruction files a touch puts in scope, as workspace-relative paths:
 * each directory in the chain contributes `AGENTS.md` and `CLAUDE.md`.
 *
 * @param {string} root - workspace root.
 * @param {string} touched - touched path.
 * @param {number} depth - how many trailing chain levels to include (0 = none,
 *   which is what "touched a file directly in the root" means).
 * @returns {string[]} candidate relative paths.
 */
export function instructionCandidates(root, touched, depth = Infinity) {
  const dirs = descendantDirs(root, touched)
  // `depth: 0` means "no chain level" (the touched file sits directly in the
  // root): `slice(-0)` would return the WHOLE array, so this needs its own branch.
  const chain = depth === 0 ? [] : (Number.isFinite(depth) ? dirs.slice(-depth) : dirs)
  const out = []
  for (const dir of chain) {
    out.push(`${dir}/AGENTS.md`, `${dir}/CLAUDE.md`)
  }
  return out
}

/**
 * A digest of an instruction's content, used to inject a given version once.
 * Size + mtime is not enough: a same-size edit inside one second would slip
 * through, and a spurious re-injection costs prompt budget.
 *
 * @param {Buffer|string} content
 * @returns {string}
 */
export function contentDigest(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  // A 16-char prefix is plenty for "did this text change" within one session,
  // and keeps the tracker's maps small.
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/**
 * Per-session injection state: which (remote path → digest) pairs have already
 * been delivered, plus the last sweep time for throttling.
 *
 * @returns {object} a tracker with `shouldInject`, `markInjected`, `removed`, and `throttled`.
 */
export function createInjectionTracker({ throttleMs = REFRESH_THROTTLE_MS } = {}) {
  /** sessionId → { injected: Map<relPath, digest>, lastSweep: number } */
  const sessions = new Map()
  const stateFor = (sessionId) => {
    const key = String(sessionId || 'unscoped')
    let s = sessions.get(key)
    if (!s) { s = { injected: new Map(), lastSweep: 0 }; sessions.set(key, s) }
    return s
  }
  return {
    /** Whether a sweep may run now (the throttle gate). */
    throttled(sessionId, now = Date.now()) {
      const s = stateFor(sessionId)
      return now - s.lastSweep < throttleMs
    },
    /** Record that a sweep happened now. */
    swept(sessionId, now = Date.now()) {
      stateFor(sessionId).lastSweep = now
    },
    /** Whether this exact content has NOT been delivered to this session yet. */
    shouldInject(sessionId, rel, digest) {
      return stateFor(sessionId).injected.get(rel) !== digest
    },
    /** Mark one file's content as delivered. */
    markInjected(sessionId, rel, digest) {
      stateFor(sessionId).injected.set(rel, digest)
    },
    /** Every rel path this session has been given, for scoped reconciliation. */
    injectedRels(sessionId) {
      return stateFor(sessionId).injected.keys()
    },
    /**
     * Files injected before that are gone from a sweep LIMITED to `covers`.
     *
     * Scoping matters in both directions: a file outside the swept chain was
     * never examined, so it must keep its record (dropping it would re-inject
     * live rules later and, worse, could report a live rule as removed).
     *
     * @param {string} sessionId
     * @param {Set<string>} present - rel paths the sweep actually found.
     * @param {(rel: string) => boolean} covers - whether the sweep covered a rel.
     * @returns {string[]} rel paths to report as removed.
     */
    removedInScope(sessionId, present, covers) {
      const s = stateFor(sessionId)
      const out = []
      for (const rel of [...s.injected.keys()]) {
        if (typeof covers === 'function' && !covers(rel)) continue
        if (present.has(rel)) continue
        out.push(rel)
        s.injected.delete(rel)
      }
      return out
    },
    /**
     * Files that were injected before but no longer exist remotely — the model
     * must be told, or it keeps following rules that were deleted.
     * @returns {string[]} rel paths to report as removed.
     */
    removed(sessionId, stillPresent) {
      return this.removedInScope(sessionId, stillPresent, null)
    },
    /** Forget a session entirely (its cwd changed, or it went away). */
    reset(sessionId) {
      sessions.delete(String(sessionId || 'unscoped'))
    },
    /** Every session currently tracked (diagnostics/tests). */
    sessions() {
      return [...sessions.keys()]
    },
  }
}

/**
 * Fetch the CURRENT content of one instruction candidate from the remote and
 * mirror it locally, three-way safe (a local edit is never clobbered).
 *
 * Returns null when the file does not exist remotely — that is a normal answer,
 * not an error, since most directories carry no instruction file.
 *
 * @param {object} sftp - promisified sftp surface.
 * @param {string} remoteRoot - workspace root.
 * @param {string} rel - workspace-relative candidate path.
 * @param {string} mirrorDir - local mirror root.
 * @returns {Promise<{rel: string, remote: string, content: string, digest: string, mirrored: boolean}|null>}
 */
export async function fetchInstruction(sftp, remoteRoot, rel, mirrorDir) {
  const parts = String(rel || '').split('/')
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) return null
  let canonicalRoot = remoteRoot
  try { if (typeof sftp.realpath === 'function') canonicalRoot = await sftp.realpath(remoteRoot) } catch { return null }
  let current = canonicalRoot
  let st
  for (let index = 0; index < parts.length; index += 1) {
    current = joinRemotePath(current, parts[index])
    try { st = await sftp.lstat(current) } catch { return null }
    const symlink = typeof st?.isSymbolicLink === 'function'
      ? st.isSymbolicLink()
      : (Number(st?.mode) & 0o170000) === 0o120000
    const directory = typeof st?.isDirectory === 'function'
      ? st.isDirectory()
      : (Number(st?.mode) & 0o170000) === 0o040000
    if (symlink || (index < parts.length - 1 && !directory)) return null
  }
  const remote = current
  if (!st || (typeof st.isDirectory === 'function' && st.isDirectory())) return null
  const size = typeof st.size === 'number' ? st.size : 0
  if (size > INSTRUCTION_MAX_BYTES) {
    return { rel, remote, content: '', digest: `oversize:${size}`, mirrored: false, oversizeBytes: size }
  }
  let buf
  try { buf = await sftp.readFile(remote) } catch { return null }
  const digest = contentDigest(buf)
  let mirrored = false
  if (mirrorDir) {
    try {
      const lp = path.join(mirrorDir, ...String(rel).split('/'))
      let same = false
      try {
        const lst = statSync(lp)
        same = lst.size === size && keyOf(lst.size, lst.mtimeMs / 1000) === keyOf(size, st.mtime)
      } catch { same = false }
      if (!same) {
        mkdirSync(path.dirname(lp), { recursive: true })
        writeFileSync(lp, buf)
        try { utimesSync(lp, new Date((st.mtime || 0) * 1000), new Date((st.mtime || 0) * 1000)) } catch { /* cosmetic */ }
      }
      mirrored = true
    } catch { /* a mirror failure must not lose the instruction itself */ }
  }
  return { rel, remote, content: buf.toString('utf8'), digest, mirrored }
}

export async function fetchInstructionWithReader(readInstruction, remoteRoot, rel) {
  const requestedPath = joinRemotePath(remoteRoot, rel)
  let snapshot
  try { snapshot = await readInstruction(requestedPath) } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'REMOTE_NOT_FOUND') return null
    throw error
  }
  if (!snapshot) return null
  const remote = snapshot.path || requestedPath
  if (!relPathUnder(remoteRoot, remote)) throw new Error('instruction path escaped the remote workspace')
  const size = Number(snapshot.size) || 0
  const oversizeBytes = Number(snapshot.oversizeBytes) || (size > INSTRUCTION_MAX_BYTES ? size : 0)
  if (oversizeBytes) {
    return { rel, remote, size: oversizeBytes, mtime: Number(snapshot.mtime) || 0, content: '', digest: `oversize:${oversizeBytes}`, mirrored: false, oversizeBytes }
  }
  const content = String(snapshot.content ?? '')
  const contentBytes = Buffer.byteLength(content, 'utf8')
  if (contentBytes > INSTRUCTION_MAX_BYTES) {
    return { rel, remote, size: contentBytes, mtime: Number(snapshot.mtime) || 0, content: '', digest: `oversize:${contentBytes}`, mirrored: false, oversizeBytes: contentBytes }
  }
  const version = String(snapshot.version || '')
  const actualVersion = createHash('sha256').update(content, 'utf8').digest('hex')
  if (!/^[a-f0-9]{64}$/i.test(version) || version.toLowerCase() !== actualVersion) {
    const error = new Error('remote instruction content does not match its SHA-256 version')
    error.code = 'REMOTE_INSTRUCTION_VERSION_MISMATCH'
    throw error
  }
  return {
    rel,
    remote,
    size: contentBytes,
    mtime: Number(snapshot.mtime) || 0,
    content,
    digest: contentDigest(content),
    version: snapshot.version,
    mirrored: false,
  }
}

/**
 * Sweep the ancestor chain of a touched path and return the instructions that
 * should enter the context now.
 *
 * @param {object} arg
 * @param {object} arg.sftp
 * @param {string} arg.remoteRoot - workspace root.
 * @param {string} arg.touched - the touched remote path.
 * @param {string} arg.mirrorDir - local mirror.
 * @param {object} arg.tracker - from {@link createInjectionTracker}.
 * @param {string} arg.sessionId
 * @param {number} [arg.depth] - chain depth to consider (default: whole chain).
 * @param {Function} [arg.readInstruction] - full-content helper reader for transparent mode.
 * @param {boolean} [arg.includeRoot] - include root AGENTS/CLAUDE candidates.
 * @returns {Promise<{items: Array, removed: string[], conflicts: string[], checked: string[], truncated: boolean}>}
 *   scoped instruction changes and the mirror refresh outcome.
 */
export async function refreshTouched({ sftp, readInstruction, remoteRoot, touched, mirrorDir, tracker, sessionId, depth, includeRoot = false }) {
  const chainDirs = descendantDirs(remoteRoot, touched)
  const truncated = Number.isFinite(depth) && chainDirs.length > depth
  const chainCandidates = instructionCandidates(remoteRoot, touched, depth)
  const rootCandidates = includeRoot ? ['AGENTS.md', 'CLAUDE.md'] : []
  const candidates = [...new Set([...rootCandidates, ...chainCandidates])]
  if (!candidates.length) return { items: [], removed: [], conflicts: [], checked: [], truncated }
  const found = []
  const present = new Set()
  for (const rel of candidates) {
    const got = typeof readInstruction === 'function'
      ? await fetchInstructionWithReader(readInstruction, remoteRoot, rel)
      : await fetchInstruction(sftp, remoteRoot, rel, mirrorDir)
    if (!got) continue
    found.push(got)
    present.add(got.rel)
  }
  let mirrorResult = { written: [], removed: [], conflicts: [], present: new Set() }
  if (typeof readInstruction === 'function' && mirrorDir) {
    mirrorResult = syncInstructionsToMirror(found, mirrorDir, {
      removeMissing: candidates.filter((rel) => !present.has(rel)),
    })
    for (const file of found) file.mirrored = mirrorResult.present.has(file.rel)
  }
  const items = found.filter((f) => tracker.shouldInject(sessionId, f.rel, f.digest))
  for (const f of items) tracker.markInjected(sessionId, f.rel, f.digest)
  // Removal notices are scoped to the directories THIS touch covers. The
  // transparent reader additionally checks root candidates when includeRoot is set.
  const dirs = depth === 0 ? [] : (Number.isFinite(depth) ? chainDirs.slice(-depth) : chainDirs)
  if (!dirs.length && !includeRoot) {
    return { items, removed: [], conflicts: mirrorResult.conflicts, checked: candidates, mirror: mirrorResult, truncated }
  }
  const prefixes = dirs.map((d) => d + '/')
  const rootSet = new Set(rootCandidates)
  const covers = (rel) => rootSet.has(rel) || prefixes.includes(rel.slice(0, rel.lastIndexOf('/') + 1))
  const removed = tracker.removedInScope(sessionId, present, covers)
  return { items, removed, conflicts: mirrorResult.conflicts, checked: candidates, mirror: mirrorResult, truncated }
}

/**
 * Render the injection batch into ONE user message.
 *
 * The shape mirrors what the core produces for its own incremental batches —
 * a system-reminder-framed body with per-file sections — so the model reads the
 * two identically while the SOURCE kind keeps them distinguishable.
 *
 * @param {Array} items - from {@link refreshTouched}.
 * @param {string[]} removed - rel paths that no longer exist.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {(p: string) => string} [opts.display] - path formatter for sections.
 * @param {(text: string, source: object) => object} [opts.createUserMessage] -
 *   the core message factory when available.
 * @returns {object|null} a user message, or null when there is nothing to say.
 */
export function buildInstructionMessage(items, removed, opts = {}) {
  const maxBytes = Number(opts.maxBytes) || INSTRUCTION_MESSAGE_MAX_BYTES
  const display = typeof opts.display === 'function' ? opts.display : (p) => p
  const factory = typeof opts.createUserMessage === 'function' ? opts.createUserMessage : null
  if ((!items || !items.length) && (!removed || !removed.length)) return null
  const blocks = []
  let used = 0
  const sent = []
  const truncated = []
  for (const item of items || []) {
    const head = item.oversizeBytes
      ? `### ${display(item.remote)}\n(too large to inject: ${item.oversizeBytes} bytes — read it with rw_read_file if you need its rules)`
      : `### ${display(item.remote)}\n${item.content}`
    const bytes = Buffer.byteLength(head, 'utf8')
    if (used + bytes > maxBytes) { truncated.push(display(item.remote)); continue }
    used += bytes
    blocks.push(head)
    sent.push(item.rel)
  }
  if (removed && removed.length) {
    const line = `Removed on the remote host (no longer in effect): ${removed.map((r) => display(r)).join(', ')}`
    if (used + Buffer.byteLength(line, 'utf8') <= maxBytes) blocks.push(line)
  }
  if (truncated.length) {
    blocks.push(`Workspace instruction budget ${maxBytes} bytes: truncated ${truncated.join(', ')}`)
  }
  if (!blocks.length) return null
  const text = [
    '<system-reminder>',
    'Remote workspace instructions for the directories you just touched. These are the CURRENT contents from the remote host, delivered because you accessed files under them.',
    '',
    blocks.join('\n\n'),
    '</system-reminder>',
  ].join('\n')
  const source = { kind: REMOTE_INSTRUCTIONS_KIND, form: 'instructions', changes: sent.map((rel) => ({ path: rel, change: 'changed' })) }
  const content = [{ type: 'text', text }]
  return factory ? factory({ content, source }) : { role: 'user', content, source }
}
