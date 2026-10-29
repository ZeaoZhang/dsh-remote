const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

const PROTOCOL = 1
const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_IN_FLIGHT = 128
const MAX_READ_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000
const MAX_MUTATION_BYTES = 1024 * 1024
const MAX_IMAGE_TRANSFER_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_CHUNK_BYTES = 1024 * 1024
const MAX_IMAGE_TRANSFERS = 1
const IMAGE_TRANSFER_TTL_MS = 30000
const MAX_SEARCH_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_SEARCH_TRANSFERS = 2
const MAX_SEARCH_CHUNK_BYTES = 1024 * 1024
const MAX_PROJECT_SKILLS = 64
const MAX_PROJECT_SKILL_BYTES = 128 * 1024
const MAX_PROJECT_SKILL_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_INSTRUCTION_BYTES = 256 * 1024
const SEARCH_TRANSFER_TTL_MS = 30000
const MAX_ACTIVE_BASHES = 4
const MAX_BASH_OUTPUT_BYTES = 256 * 1024
const BASH_DEFAULT_TIMEOUT_MS = 120000
const BASH_MAX_TIMEOUT_MS = 600000
const BASH_DEFAULT_GRACE_MS = 3000
const BASH_MAX_GRACE_MS = 10000
const BASH_CANCEL_TTL_MS = 30000
let bwrapProbeResult
const bashTasks = new Map()
const activeBashStarts = new Set()
const pendingBashCancels = new Map()
let root = ''
let buffer = Buffer.alloc(0)
let shuttingDown = false
const controllers = new Map()
const imageTransfers = new Map()
const searchTransfers = new Map()
const activeSearches = new Set()
let outputTail = Promise.resolve()
let shutdownScheduled = false

function stopWhenDrained() {
  if (!shuttingDown || controllers.size > 0 || shutdownScheduled) return
  shutdownScheduled = true
  void outputTail.then(() => process.stdin.destroy(), () => process.stdin.destroy())
}

function within(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function writeFrame(frame) {
  const data = Buffer.from(JSON.stringify(frame) + '\n', 'utf8')
  if (data.length > MAX_FRAME_BYTES) return Promise.reject(new Error('response frame is too large'))
  outputTail = outputTail.then(() => new Promise((resolve, reject) => {
    try { process.stdout.write(data, (error) => error ? reject(error) : resolve()) } catch (error) { reject(error) }
  }))
  return outputTail
}

function protocolError(message, code = 'REMOTE_RPC_PROTOCOL_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

async function resolveFile(rawPath, signal) {
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw protocolError('read requires a non-empty path', 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath))
  if (!within(root, candidate)) throw protocolError('path is outside the remote workspace', 'REMOTE_PATH_DENIED')
  let resolved
  try { resolved = await fs.promises.realpath(candidate) } catch (error) {
    throw protocolError(`cannot resolve remote path: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  }
  if (!within(root, resolved)) throw protocolError('symlink resolves outside the remote workspace', 'REMOTE_PATH_DENIED')
  const info = await fs.promises.stat(resolved)
  if (!info.isFile()) throw protocolError('path is not a regular file', 'REMOTE_NOT_FILE')
  return { path: resolved, info }
}

async function resolveInstructionTarget(rawPath, signal) {
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw protocolError('instruction path must be non-empty', 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath))
  if (!within(root, candidate)) throw protocolError('instruction path is outside the remote workspace', 'REMOTE_PATH_DENIED')
  const relative = path.relative(root, candidate)
  const parts = relative.split(path.sep).filter(Boolean)
  if (!parts.length) throw protocolError('instruction path is not a file', 'REMOTE_NOT_FILE')
  let current = root
  let info
  for (let index = 0; index < parts.length; index += 1) {
    signal.throwIfAborted()
    current = path.join(current, parts[index])
    try { info = await fs.promises.lstat(current) } catch (error) {
      const code = error.code === 'ENOENT' ? 'REMOTE_NOT_FOUND' : (error.code || 'REMOTE_PATH_INSPECT_FAILED')
      throw protocolError(`cannot inspect remote instruction: ${error.message}`, code)
    }
    if (info.isSymbolicLink()) throw protocolError('instruction symlinks are not followed', 'REMOTE_CONFIG_SYMLINK')
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw protocolError('instruction parent is not a directory', 'REMOTE_NOT_DIRECTORY')
    }
  }
  if (!info?.isFile()) throw protocolError('instruction path is not a regular file', 'REMOTE_NOT_FILE')
  const canonical = await fs.promises.realpath(candidate).catch((error) => {
    throw protocolError(`cannot resolve remote instruction: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  if (!within(root, canonical) || path.normalize(canonical) !== path.normalize(candidate)) {
    throw protocolError('instruction path resolves through a symlink', 'REMOTE_CONFIG_SYMLINK')
  }
  return { path: canonical, info }
}

async function readInstructionFile(args, signal) {
  const target = await resolveInstructionTarget(args.path, signal)
  if (target.info.size > MAX_INSTRUCTION_BYTES) {
    return {
      path: target.path,
      size: target.info.size,
      mtime: Math.floor(target.info.mtimeMs / 1000),
      oversizeBytes: target.info.size,
    }
  }
  const data = await readValidatedFile(target, signal, 'remote instruction')
  if (data.length > MAX_INSTRUCTION_BYTES) {
    return {
      path: target.path,
      size: data.length,
      mtime: Math.floor(target.info.mtimeMs / 1000),
      oversizeBytes: data.length,
    }
  }
  const after = await fs.promises.stat(target.path)
  if (data.length !== target.info.size || after.size !== data.length) {
    throw protocolError('remote instruction changed while being read', 'REMOTE_PATH_CHANGED')
  }
  let content
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch {
    throw protocolError('remote instruction is not valid UTF-8', 'REMOTE_INVALID_UTF8')
  }
  return {
    path: target.path,
    size: data.length,
    mtime: Math.floor(target.info.mtimeMs / 1000),
    version: versionOf(data),
    content,
  }
}

function versionOf(data) {
  return createHash('sha256').update(data).digest('hex')
}
function sameFileIdentity(left, right) {
  return Number.isFinite(left?.dev) && Number.isFinite(left?.ino)
    && Number.isFinite(right?.dev) && Number.isFinite(right?.ino)
    && left.dev === right.dev && left.ino === right.ino
}

async function openValidatedFile(target, signal, label = 'remote file', workspaceRoot = root) {
  signal.throwIfAborted()
  const noFollow = fs.constants.O_NOFOLLOW
  if (!Number.isInteger(noFollow)) {
    throw protocolError('this remote platform cannot safely open files without following symlinks', 'REMOTE_SAFE_OPEN_UNAVAILABLE')
  }
  let handle
  try {
    handle = await fs.promises.open(target.path, fs.constants.O_RDONLY | noFollow)
    const openedInfo = await handle.stat()
    if (!openedInfo.isFile() || !sameFileIdentity(openedInfo, target.info)) {
      throw protocolError(`${label} changed during path validation`, 'REMOTE_PATH_CHANGED')
    }
    const canonical = await fs.promises.realpath(target.path)
    if (!within(workspaceRoot, canonical) || path.normalize(canonical) !== path.normalize(target.path)) {
      throw protocolError(`${label} no longer resolves inside the remote workspace`, 'REMOTE_PATH_DENIED')
    }
    const currentInfo = await fs.promises.lstat(target.path)
    if (currentInfo.isSymbolicLink() || !sameFileIdentity(currentInfo, openedInfo)) {
      throw protocolError(`${label} changed during path validation`, 'REMOTE_PATH_CHANGED')
    }
    signal.throwIfAborted()
    return handle
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    throw error
  }
}

async function readValidatedFile(target, signal, label = 'remote file') {
  const handle = await openValidatedFile(target, signal, label)
  try {
    const data = await handle.readFile()
    signal.throwIfAborted()
    const after = await handle.stat()
    if (!sameFileIdentity(target.info, after)) {
      throw protocolError(`${label} changed while being read`, 'REMOTE_PATH_CHANGED')
    }
    return data
  } finally {
    await handle.close().catch(() => {})
  }
}

async function resolveMutationTarget(rawPath, signal) {
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw protocolError('mutation requires a non-empty path', 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath))
  if (!within(root, candidate)) throw protocolError('path is outside the remote workspace', 'REMOTE_PATH_DENIED')
  const parent = await fs.promises.realpath(path.dirname(candidate)).catch((error) => {
    throw protocolError(`cannot resolve remote parent directory: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  if (!within(root, parent)) throw protocolError('parent directory resolves outside the remote workspace', 'REMOTE_PATH_DENIED')
  const parentInfo = await fs.promises.stat(parent)
  const lexicalTarget = path.join(parent, path.basename(candidate))
  try {
    const resolved = await fs.promises.realpath(lexicalTarget)
    if (!within(root, resolved)) throw protocolError('symlink resolves outside the remote workspace', 'REMOTE_PATH_DENIED')
    const info = await fs.promises.stat(resolved)
    if (!info.isFile()) throw protocolError('path is not a regular file', 'REMOTE_NOT_FILE')
    const actualParent = path.dirname(resolved)
    const actualParentInfo = await fs.promises.stat(actualParent)
    return { path: resolved, info, parent: actualParent, parentInfo: actualParentInfo }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { path: lexicalTarget, info: null, parent, parentInfo }
  }
}

async function assertMutationParentStable(target, signal) {
  signal.throwIfAborted()
  if (!target.parent || !target.parentInfo) throw protocolError('mutation parent identity is unavailable', 'REMOTE_PATH_CHANGED')
  const canonical = await fs.promises.realpath(target.parent).catch((error) => {
    throw protocolError(`cannot revalidate remote parent: ${error.message}`, error.code || 'REMOTE_PATH_CHANGED')
  })
  if (!within(root, canonical) || path.normalize(canonical) !== path.normalize(target.parent)) {
    throw protocolError('mutation parent changed during path validation', 'REMOTE_PATH_CHANGED')
  }
  const current = await fs.promises.stat(canonical)
  if (!sameFileIdentity(current, target.parentInfo)) {
    throw protocolError('mutation parent changed during path validation', 'REMOTE_PATH_CHANGED')
  }
}

async function currentVersion(target, signal) {
  signal.throwIfAborted()
  if (target.info) return versionOf(await readValidatedFile(target, signal, 'mutation target'))
  try {
    const current = await resolveFile(target.path, signal)
    return versionOf(await readValidatedFile(current, signal, 'mutation target'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function unlinkTempIfParentStable(target, temp) {
  try {
    const canonical = await fs.promises.realpath(target.parent)
    if (!within(root, canonical) || path.normalize(canonical) !== path.normalize(target.parent)) return
    const current = await fs.promises.stat(canonical)
    if (sameFileIdentity(current, target.parentInfo)) await fs.promises.unlink(temp)
  } catch { /* best effort; never follow a changed parent to clean up */ }
}

async function writeAtomically(target, content, expectedVersion, signal) {
  await assertMutationParentStable(target, signal)
  const beforeVersion = await currentVersion(target, signal)
  if (beforeVersion !== expectedVersion) {
    throw protocolError('file changed since it was last read; read it again before writing', 'FS_STALE_VERSION')
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_MUTATION_BYTES) {
    throw protocolError(`mutation content exceeds ${MAX_MUTATION_BYTES} bytes`, 'REMOTE_CONTENT_TOO_LARGE')
  }
  const temp = path.join(path.dirname(target.path), `.dsh-remote-${process.pid}-${randomUUID()}.tmp`)
  const mode = target.info ? target.info.mode & 0o777 : 0o666
  let handle
  try {
    handle = await fs.promises.open(temp, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    signal.throwIfAborted()
    const finalVersion = await currentVersion(target, signal)
    if (finalVersion !== expectedVersion) {
      throw protocolError('file changed while the mutation was being prepared; read it again before writing', 'FS_STALE_VERSION')
    }
    await assertMutationParentStable(target, signal)
    signal.throwIfAborted()
    await fs.promises.rename(temp, target.path)
    return versionOf(Buffer.from(content, 'utf8'))
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlinkTempIfParentStable(target, temp)
    throw error
  }
}

async function readTextForMutation(target, signal) {
  if (!target.info) return null
  signal.throwIfAborted()
  const data = await readValidatedFile(target, signal, 'mutation target')
  if (data.byteLength > MAX_MUTATION_BYTES) {
    throw protocolError(`existing file exceeds ${MAX_MUTATION_BYTES} bytes`, 'REMOTE_CONTENT_TOO_LARGE')
  }
  return { data, text: data.toString('utf8'), version: versionOf(data) }
}

function assertExpectedPath(target, expectedPath) {
  if (expectedPath === undefined || expectedPath === null) return
  if (typeof expectedPath !== 'string' || expectedPath !== target.path) {
    throw protocolError('file target changed since it was last read; read it again before writing', 'FS_STALE_VERSION')
  }
}

async function writeText(args, signal) {
  if (typeof args.content !== 'string') throw protocolError('write requires string content', 'REMOTE_INVALID_ARGUMENT')
  const target = await resolveMutationTarget(args.path, signal)
  assertExpectedPath(target, args.expectedPath)
  const current = await readTextForMutation(target, signal)
  const expectedVersion = args.expectedVersion ?? null
  if ((current?.version ?? null) !== expectedVersion) {
    throw protocolError('file changed since it was last read; read it again before writing', 'FS_STALE_VERSION')
  }
  const before = current?.text ?? null
  const operation = current ? 'update' : 'create'
  const version = before === args.content
    ? current.version
    : await writeAtomically(target, args.content, expectedVersion, signal)
  return { path: target.path, operation, before, after: args.content, version }
}

async function editText(args, signal) {
  if (typeof args.oldString !== 'string' || args.oldString.length === 0) {
    throw protocolError('old_string must be a non-empty string', 'REMOTE_INVALID_ARGUMENT')
  }
  if (typeof args.newString !== 'string' || args.oldString === args.newString) {
    throw protocolError('old_string and new_string must differ', 'REMOTE_INVALID_ARGUMENT')
  }
  const replaceAll = args.replaceAll ?? false
  if (typeof replaceAll !== 'boolean') throw protocolError('replace_all must be a boolean', 'REMOTE_INVALID_ARGUMENT')
  const target = await resolveMutationTarget(args.path, signal)
  assertExpectedPath(target, args.expectedPath)
  const current = await readTextForMutation(target, signal)
  if (!current) throw protocolError('cannot edit a file that does not exist', 'REMOTE_NOT_FOUND')
  if (current.version !== args.expectedVersion) {
    throw protocolError('file changed since it was last read; read it again before editing', 'FS_STALE_VERSION')
  }
  const first = current.text.indexOf(args.oldString)
  if (first < 0) throw protocolError('old_string was not found in the file', 'REMOTE_EDIT_NO_MATCH')
  if (!replaceAll && current.text.indexOf(args.oldString, first + args.oldString.length) >= 0) {
    throw protocolError('old_string must occur exactly once when replace_all is false', 'REMOTE_EDIT_AMBIGUOUS')
  }
  const after = replaceAll
    ? current.text.split(args.oldString).join(args.newString)
    : current.text.slice(0, first) + args.newString + current.text.slice(first + args.oldString.length)
  const version = after === current.text
    ? current.version
    : await writeAtomically(target, after, current.version, signal)
  return { path: target.path, before: current.text, after, version }
}

async function readBoundedImage(target, byteCap, signal) {
  const handle = await openValidatedFile(target, signal, 'remote image')
  const source = handle.createReadStream({ highWaterMark: MAX_IMAGE_CHUNK_BYTES, signal, autoClose: false })
  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of source) {
      signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > byteCap) {
        throw protocolError(`image exceeds the remote helper transfer limit of ${byteCap} bytes`, 'REMOTE_CONTENT_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } finally {
    source.destroy()
    await handle.close().catch(() => {})
  }
  return Buffer.concat(chunks, bytes)
}

async function beginImageTransfer(args, signal) {
  if (imageTransfers.size >= MAX_IMAGE_TRANSFERS) {
    throw protocolError('too many image transfers are active', 'REMOTE_BUSY')
  }
  const maxBytes = Number(args.maxBytes)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw protocolError('image maxBytes must be a positive integer', 'REMOTE_INVALID_ARGUMENT')
  }
  const target = await resolveFile(args.path, signal)
  const byteCap = Math.min(maxBytes, MAX_IMAGE_TRANSFER_BYTES)
  if (target.info.size > byteCap) {
    throw protocolError(`image exceeds the remote helper transfer limit of ${byteCap} bytes`, 'REMOTE_CONTENT_TOO_LARGE')
  }
  const data = await readBoundedImage(target, byteCap, signal)
  signal.throwIfAborted()
  const transferId = randomUUID()
  const version = versionOf(data)
  const timer = setTimeout(() => releaseImageTransfer(transferId), IMAGE_TRANSFER_TTL_MS)
  timer.unref?.()
  imageTransfers.set(transferId, { data, path: target.path, version, timer })
  return { transferId, path: target.path, version, bytes: data.byteLength, chunkSize: MAX_IMAGE_CHUNK_BYTES }
}

function releaseImageTransfer(transferId) {
  const transfer = imageTransfers.get(transferId)
  if (!transfer) return false
  clearTimeout(transfer.timer)
  imageTransfers.delete(transferId)
  return true
}

function readImageChunk(args, signal) {
  signal.throwIfAborted()
  const transferId = String(args.transferId || '')
  const transfer = imageTransfers.get(transferId)
  if (!transfer) throw protocolError('image transfer is missing or expired', 'REMOTE_TRANSFER_EXPIRED')
  clearTimeout(transfer.timer)
  transfer.timer = setTimeout(() => releaseImageTransfer(transferId), IMAGE_TRANSFER_TTL_MS)
  transfer.timer.unref?.()
  const offset = Number(args.offset)
  const length = Number(args.length)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > transfer.data.byteLength) {
    throw protocolError('image chunk offset is invalid', 'REMOTE_INVALID_ARGUMENT')
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_IMAGE_CHUNK_BYTES) {
    throw protocolError(`image chunk length must be between 1 and ${MAX_IMAGE_CHUNK_BYTES}`, 'REMOTE_INVALID_ARGUMENT')
  }
  const data = transfer.data.subarray(offset, Math.min(offset + length, transfer.data.byteLength))
  signal.throwIfAborted()
  return { transferId, offset, version: transfer.version, data: data.toString('base64') }
}

function captureStream(maxBytes, keepTail = false) {
  const chunks = []
  let storedBytes = 0
  let totalBytes = 0
  let lossy = false
  return {
    append(chunk) {
      totalBytes += chunk.length
      if (maxBytes === 0) {
        if (chunk.length > 0) lossy = true
        return
      }
      if (!keepTail) {
        const remaining = maxBytes - storedBytes
        if (remaining > 0) {
          const part = chunk.subarray(0, remaining)
          chunks.push(part)
          storedBytes += part.length
        }
        if (chunk.length > remaining) lossy = true
        return
      }
      chunks.push(chunk)
      storedBytes += chunk.length
      if (storedBytes > maxBytes) lossy = true
      while (storedBytes > maxBytes) {
        const excess = storedBytes - maxBytes
        const first = chunks[0]
        if (first.length <= excess) {
          chunks.shift()
          storedBytes -= first.length
        } else {
          chunks[0] = first.subarray(excess)
          storedBytes -= excess
        }
      }
    },
    result() { return { data: Buffer.concat(chunks, storedBytes), lossy, totalBytes } },
  }
}

function validateSearchArgv(kind, argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 256 || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw protocolError('search argv is invalid', 'REMOTE_INVALID_ARGUMENT')
  }
  if (argv[0] !== '--no-config') throw protocolError('remote search requires --no-config', 'REMOTE_INVALID_ARGUMENT')
  const separator = argv.indexOf('--')
  if (separator >= 0 && separator !== argv.length - 2) {
    throw protocolError('search accepts one path after --', 'REMOTE_INVALID_ARGUMENT')
  }
  const flags = separator < 0 ? argv : argv.slice(0, separator)
  if (kind === 'glob') {
    if (!flags.includes('--files') || !flags.includes('--sort=modified') || !flags.includes('--no-ignore') || !flags.includes('--hidden')
      || flags.some((flag) => !['--no-config', '--files', '--sort=modified', '--no-ignore', '--hidden'].includes(flag) && !flag.startsWith('--glob='))) {
      throw protocolError('glob argv does not match the supported DSH template', 'REMOTE_INVALID_ARGUMENT')
    }
  } else if (kind === 'grep') {
    if (!flags.includes('--json') || !flags.some((flag) => flag.startsWith('--regexp='))
      || flags.some((flag) => !['--no-config', '--json'].includes(flag) && !flag.startsWith('--regexp=') && !flag.startsWith('--glob='))) {
      throw protocolError('grep argv does not match the supported DSH template', 'REMOTE_INVALID_ARGUMENT')
    }
  } else {
    throw protocolError('remote search kind must be glob or grep', 'REMOTE_INVALID_ARGUMENT')
  }
  return separator >= 0 ? argv[separator + 1] : undefined
}

async function resolveSearchCwd(rawCwd, signal) {
  signal.throwIfAborted()
  if (typeof rawCwd !== 'string' || !path.isAbsolute(rawCwd) || rawCwd.includes('\0')) {
    throw protocolError('search cwd must be an absolute remote path', 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(rawCwd)
  if (!within(root, candidate)) throw protocolError('search cwd is outside the remote workspace', 'REMOTE_PATH_DENIED')
  const resolved = await fs.promises.realpath(candidate).catch((error) => {
    throw protocolError(`cannot resolve search cwd: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  if (!within(root, resolved)) throw protocolError('search cwd symlink resolves outside the remote workspace', 'REMOTE_PATH_DENIED')
  if (!(await fs.promises.stat(resolved)).isDirectory()) throw protocolError('search cwd is not a directory', 'REMOTE_NOT_DIRECTORY')
  return resolved
}

async function resolveSearchTarget(rawPath, cwd, signal) {
  if (rawPath === undefined) return undefined
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw protocolError('search path must be a non-empty path without NUL bytes', 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath))
  if (!within(root, candidate)) throw protocolError('search path is outside the remote workspace', 'REMOTE_PATH_DENIED')
  const resolved = await fs.promises.realpath(candidate).catch((error) => {
    throw protocolError(`cannot resolve search path: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  if (!within(root, resolved)) throw protocolError('search path symlink resolves outside the remote workspace', 'REMOTE_PATH_DENIED')
  const info = await fs.promises.stat(resolved)
  if (!info.isDirectory() && !info.isFile()) throw protocolError('search path is not a regular file or directory', 'REMOTE_INVALID_PATH')
  return resolved
}

function releaseSearchTransfer(transferId) {
  const transfer = searchTransfers.get(transferId)
  if (!transfer) return false
  clearTimeout(transfer.timer)
  searchTransfers.delete(transferId)
  return true
}

async function beginSearch(args, signal) {
  const cwd = await resolveSearchCwd(args.cwd, signal)
  const rawPath = validateSearchArgv(args.kind, args.argv)
  await resolveSearchTarget(rawPath, cwd, signal)
  const stdoutMaxBytes = Number(args.stdoutMaxBytes)
  const stderrMaxBytes = Number(args.stderrMaxBytes)
  const graceMs = Number(args.graceMs)
  if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1 || stdoutMaxBytes > MAX_SEARCH_OUTPUT_BYTES) {
    throw protocolError(`stdout cap must be between 1 and ${MAX_SEARCH_OUTPUT_BYTES} bytes`, 'REMOTE_INVALID_ARGUMENT')
  }
  if (!Number.isSafeInteger(stderrMaxBytes) || stderrMaxBytes < 0 || stderrMaxBytes > 1024 * 1024) {
    throw protocolError('stderr cap must be between 0 and 1048576 bytes', 'REMOTE_INVALID_ARGUMENT')
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 10000) {
    throw protocolError('search graceMs must be between 0 and 10000', 'REMOTE_INVALID_ARGUMENT')
  }
  if (searchTransfers.size + activeSearches.size >= MAX_SEARCH_TRANSFERS) {
    throw protocolError('too many remote search operations are active', 'REMOTE_BUSY')
  }

  const transferId = randomUUID()
  activeSearches.add(transferId)
  const stdout = captureStream(stdoutMaxBytes)
  const stderr = captureStream(stderrMaxBytes, true)
  let child
  let killTimer
  let abortPending = false
  const sendSignal = (signalName) => {
    if (!child) return
    try {
      if (child.pid) process.kill(-child.pid, signalName)
      else child.kill(signalName)
    } catch {
      try { child.kill(signalName) } catch { /* process already exited */ }
    }
  }
  const abort = () => {
    abortPending = true
    sendSignal('SIGTERM')
    if (!killTimer) {
      killTimer = setTimeout(() => sendSignal('SIGKILL'), graceMs)
      killTimer.unref?.()
    }
  }
  let outcome
  try {
    signal.throwIfAborted()
    const argv = rawPath === undefined ? args.argv : [...args.argv.slice(0, -1), rawPath]
    child = spawn('rg', argv, {
      cwd,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '',
        LC_ALL: 'C',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => stdout.append(chunk))
    child.stderr.on('data', (chunk) => stderr.append(chunk))
    if (abortPending) abort()
    signal.addEventListener('abort', abort, { once: true })
    outcome = await new Promise((resolve, reject) => {
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      child.once('close', (exitCode, exitSignal) => {
        if (settled) return
        settled = true
        resolve({ exitCode, signal: exitSignal })
      })
    })
    signal.removeEventListener('abort', abort)
    clearTimeout(killTimer)
    signal.throwIfAborted()
  } catch (error) {
    signal.removeEventListener('abort', abort)
    clearTimeout(killTimer)
    if (signal.aborted) throw error
    throw protocolError(`remote ripgrep could not complete: ${error.message || String(error)}`, 'SEARCH_FAILED')
  } finally {
    activeSearches.delete(transferId)
  }

  const stdoutResult = stdout.result()
  const stderrResult = stderr.result()
  const timer = setTimeout(() => releaseSearchTransfer(transferId), SEARCH_TRANSFER_TTL_MS)
  timer.unref?.()
  searchTransfers.set(transferId, {
    stdout: stdoutResult.data,
    stderr: stderrResult.data,
    stdoutLossy: stdoutResult.lossy,
    stderrLossy: stderrResult.lossy,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdoutHash: versionOf(stdoutResult.data),
    stderrHash: versionOf(stderrResult.data),
    timer,
  })
  return {
    transferId,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdoutBytes: stdoutResult.data.byteLength,
    stderrBytes: stderrResult.data.byteLength,
    stdoutLossy: stdoutResult.lossy,
    stderrLossy: stderrResult.lossy,
    stdoutHash: versionOf(stdoutResult.data),
    stderrHash: versionOf(stderrResult.data),
    chunkSize: MAX_SEARCH_CHUNK_BYTES,
  }
}

function readSearchChunk(args, signal) {
  signal.throwIfAborted()
  const transferId = String(args.transferId || '')
  const transfer = searchTransfers.get(transferId)
  if (!transfer) throw protocolError('search transfer is missing or expired', 'REMOTE_TRANSFER_EXPIRED')
  clearTimeout(transfer.timer)
  transfer.timer = setTimeout(() => releaseSearchTransfer(transferId), SEARCH_TRANSFER_TTL_MS)
  transfer.timer.unref?.()
  const stream = args.stream === 'stdout' ? transfer.stdout : args.stream === 'stderr' ? transfer.stderr : null
  const hash = args.stream === 'stdout' ? transfer.stdoutHash : args.stream === 'stderr' ? transfer.stderrHash : null
  if (!stream || !hash) {
    if (stream?.length === 0 && hash) return { transferId, stream: args.stream, offset: 0, hash, data: '' }
    throw protocolError('search stream must be stdout or stderr', 'REMOTE_INVALID_ARGUMENT')
  }
  const offset = Number(args.offset)
  const length = Number(args.length)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > stream.length) {
    throw protocolError('search chunk offset is invalid', 'REMOTE_INVALID_ARGUMENT')
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_SEARCH_CHUNK_BYTES) {
    throw protocolError(`search chunk length must be between 1 and ${MAX_SEARCH_CHUNK_BYTES}`, 'REMOTE_INVALID_ARGUMENT')
  }
  const data = stream.subarray(offset, Math.min(offset + length, stream.length))
  signal.throwIfAborted()
  return { transferId, stream: args.stream, offset, hash, data: data.toString('base64') }
}

async function readWindow(args, signal) {
  const offset = Number(args.offset ?? 1)
  const limit = Number(args.limit ?? 2000)
  if (!Number.isInteger(offset) || offset < 1) throw protocolError('offset must be a positive integer', 'REMOTE_INVALID_ARGUMENT')
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw protocolError('limit must be between 1 and 10000', 'REMOTE_INVALID_ARGUMENT')
  const targetFile = await resolveFile(args.path, signal)
  const target = targetFile.path
  signal.throwIfAborted()
  const fileHandle = await openValidatedFile(targetFile, signal, 'remote read target')
  const source = fileHandle.createReadStream({ autoClose: false })
  let lineNumber = 0
  let bytes = 0
  let truncatedByBytes = false
  const lines = []
  let lineBuffer = ''
  const decoder = new StringDecoder('utf8')
  const hash = createHash('sha256')
  const appendToLineBuffer = (segment) => {
    const cap = MAX_LINE_LENGTH + 1
    if (lineBuffer.length >= cap) return
    lineBuffer += segment
    if (lineBuffer.length > cap) lineBuffer = lineBuffer.slice(0, cap)
  }
  const consume = () => {
    let line = lineBuffer
    lineBuffer = ''
    lineNumber += 1
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (lineNumber < offset || lines.length >= limit || truncatedByBytes) return
    const text = line.length > MAX_LINE_LENGTH
      ? `${line.substring(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`
      : line
    const lineBytes = Buffer.byteLength(text, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (bytes + lineBytes > MAX_READ_BYTES) {
      truncatedByBytes = true
      return
    }
    bytes += lineBytes
    lines.push({ number: lineNumber, text })
  }
  try {
    for await (const chunk of source) {
      signal.throwIfAborted()
      hash.update(chunk)
      const decoded = decoder.write(chunk)
      let start = 0
      let newline
      while ((newline = decoded.indexOf('\n', start)) >= 0) {
        appendToLineBuffer(decoded.slice(start, newline))
        consume()
        start = newline + 1
      }
      appendToLineBuffer(decoded.slice(start))
    }
    appendToLineBuffer(decoder.end())
    if (lineBuffer.length > 0) consume()
  } finally {
    source.destroy()
    await fileHandle.close().catch(() => {})
  }
  if (offset > lineNumber && !(lineNumber === 0 && offset === 1)) {
    throw protocolError(`offset ${offset} is out of range (${lineNumber} lines)`, 'REMOTE_INVALID_OFFSET')
  }
  return { path: target, offset, lines, totalLines: lineNumber, truncatedByBytes, version: hash.digest('hex') }
}

async function resolveProjectConfigPath(rawPath, signal) {
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw protocolError('project skill path must be non-empty', 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath))
  if (!within(root, candidate)) throw protocolError('project skill path is outside the remote workspace', 'REMOTE_PATH_DENIED')
  const relative = path.relative(root, candidate).split(path.sep).join('/')
  const parts = relative.split('/')
  const underSkills = (parts[0] === '.dsh' || parts[0] === '.agents') && parts[1] === 'skills'
  const validShape = underSkills && (
    parts.length === 3 && parts[2].toLowerCase().endsWith('.md')
    || parts.length === 4 && parts[2] !== '.' && parts[2] !== '..' && parts[3] === 'SKILL.md'
  )
  if (!validShape || isSensitiveProjectConfigPath(relative)) {
    throw protocolError('project skill path is not an allowed skill document', 'REMOTE_CONFIG_PATH_DENIED')
  }

  let current = root
  let info
  for (let index = 0; index < parts.length; index += 1) {
    signal.throwIfAborted()
    current = path.join(current, parts[index])
    try { info = await fs.promises.lstat(current) } catch (error) {
      throw protocolError(`cannot inspect project skill path: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
    }
    if (info.isSymbolicLink()) throw protocolError('project skill symlinks are not followed', 'REMOTE_CONFIG_SYMLINK')
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw protocolError('project skill parent is not a directory', 'REMOTE_NOT_DIRECTORY')
    }
  }
  if (!info?.isFile()) throw protocolError('project skill path is not a regular file', 'REMOTE_NOT_FILE')
  const canonical = await fs.promises.realpath(candidate).catch((error) => {
    throw protocolError(`cannot resolve project skill path: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  if (!within(root, canonical) || path.normalize(canonical) !== path.normalize(candidate)) {
    throw protocolError('project skill path resolves through a symlink', 'REMOTE_CONFIG_SYMLINK')
  }
  return { path: canonical, relative, info }
}

function isSensitiveProjectConfigPath(relative) {
  const parts = String(relative || '').toLowerCase().split('/')
  const basename = parts[parts.length - 1] || ''
  let base = basename
  while (base.endsWith('.md')) base = base.slice(0, -3)
  const deniedDirs = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.terraform'])
  const deniedNames = new Set([
    '.env', '.envrc', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
    '.vault-token', 'credentials.json', 'secrets.json', 'terraform.tfstate',
  ])
  const deniedExts = new Set(['.pem', '.key', '.p8', '.p12', '.pfx', '.jks', '.keystore'])
  return parts.some((part) => deniedDirs.has(part))
    || deniedDirs.has(base)
    || base.startsWith('.env.')
    || base.startsWith('service-account') && base.endsWith('.json')
    || deniedNames.has(base)
    || [...deniedExts].some((ext) => base.endsWith(ext))
}

async function projectSkillsManifest(_args, signal) {
  const roots = [
    { relative: '.dsh/skills', source: 'project-dsh', rank: 100 },
    { relative: '.agents/skills', source: 'project-agents', rank: 200 },
  ]
  const entries = []
  const diagnostics = []
  let complete = true
  let totalBytes = 0

  for (const sourceRoot of roots) {
    signal.throwIfAborted()
    const rootPath = path.join(root, sourceRoot.relative)
    let rootInfo
    try {
      let current = root
      for (const segment of sourceRoot.relative.split('/')) {
        current = path.join(current, segment)
        rootInfo = await fs.promises.lstat(current)
        if (rootInfo.isSymbolicLink()) throw protocolError('project skill root symlink skipped', 'REMOTE_CONFIG_SYMLINK')
        if (!rootInfo.isDirectory()) throw protocolError('project skill root is not a directory', 'REMOTE_NOT_DIRECTORY')
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue
      complete = false
      diagnostics.push({ path: sourceRoot.relative, code: error.code || 'REMOTE_CONFIG_SCAN_FAILED' })
      continue
    }
    const canonicalRoot = await fs.promises.realpath(rootPath).catch(() => '')
    if (!canonicalRoot || !within(root, canonicalRoot) || path.normalize(canonicalRoot) !== path.normalize(rootPath)) {
      complete = false
      diagnostics.push({ path: sourceRoot.relative, code: 'REMOTE_CONFIG_SYMLINK' })
      continue
    }

    let children
    try { children = await fs.promises.readdir(rootPath, { withFileTypes: true }) } catch (error) {
      complete = false
      diagnostics.push({ path: sourceRoot.relative, code: error.code || 'REMOTE_CONFIG_SCAN_FAILED' })
      continue
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted()
      if (child.name === '.' || child.name === '..' || child.isSymbolicLink()) {
        if (child.isSymbolicLink()) {
          complete = false
          diagnostics.push({ path: `${sourceRoot.relative}/${child.name}`, code: 'REMOTE_CONFIG_SYMLINK' })
        }
        continue
      }
      let skillPath
      let skillDirectory
      if (child.isDirectory()) {
        skillPath = path.join(rootPath, child.name, 'SKILL.md')
        skillDirectory = path.join(rootPath, child.name)
      } else if (child.isFile() && child.name.toLowerCase().endsWith('.md')) {
        skillPath = path.join(rootPath, child.name)
        skillDirectory = rootPath
      } else continue

      const relative = path.relative(root, skillPath).split(path.sep).join('/')
      if (isSensitiveProjectConfigPath(relative)) continue
      if (entries.length >= MAX_PROJECT_SKILLS) {
        complete = false
        diagnostics.push({ path: sourceRoot.relative, code: 'REMOTE_CONFIG_ENTRY_LIMIT' })
        break
      }
      let target
      try { target = await resolveProjectConfigPath(skillPath, signal) } catch (error) {
        if (error.code === 'ENOENT') continue
        complete = false
        diagnostics.push({ path: relative, code: error.code || 'REMOTE_CONFIG_SCAN_FAILED' })
        continue
      }
      if (target.info.size > MAX_PROJECT_SKILL_BYTES) {
        complete = false
        diagnostics.push({ path: relative, code: 'REMOTE_CONFIG_FILE_TOO_LARGE' })
        continue
      }
      if (totalBytes + target.info.size > MAX_PROJECT_SKILL_TOTAL_BYTES) {
        complete = false
        diagnostics.push({ path: relative, code: 'REMOTE_CONFIG_TOTAL_LIMIT' })
        break
      }
      let data
      try { data = await readValidatedFile(target, signal, 'project skill manifest file') } catch (error) {
        complete = false
        diagnostics.push({ path: relative, code: error.code || 'REMOTE_CONFIG_READ_FAILED' })
        continue
      }
      signal.throwIfAborted()
      if (data.length > MAX_PROJECT_SKILL_BYTES || totalBytes + data.length > MAX_PROJECT_SKILL_TOTAL_BYTES) {
        complete = false
        diagnostics.push({ path: relative, code: 'REMOTE_CONFIG_TOTAL_LIMIT' })
        continue
      }
      const text = data.toString('utf8')
      if (!Buffer.from(text, 'utf8').equals(data)) {
        complete = false
        diagnostics.push({ path: relative, code: 'REMOTE_CONFIG_NOT_UTF8' })
        continue
      }
      totalBytes += data.length
      entries.push({
        path: target.path,
        directory: skillDirectory,
        relative,
        source: sourceRoot.source,
        rank: sourceRoot.rank,
        size: data.length,
        mtimeMs: target.info.mtimeMs,
        version: versionOf(data),
        content: text,
      })
    }
    if (entries.length >= MAX_PROJECT_SKILLS || totalBytes >= MAX_PROJECT_SKILL_TOTAL_BYTES) break
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))
  const snapshotVersion = versionOf(Buffer.from(JSON.stringify(entries.map(({ path: skillPath, source, size, mtimeMs, version }) => ({ path: skillPath, source, size, mtimeMs, version }))), 'utf8'))
  return { root, snapshotVersion, complete, entries, diagnostics }
}

async function readProjectSkill(args, signal) {
  const target = await resolveProjectConfigPath(args.path, signal)
  const maxBytes = Number(args.maxBytes ?? MAX_PROJECT_SKILL_BYTES)
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PROJECT_SKILL_BYTES) {
    throw protocolError(`maxBytes must be between 1 and ${MAX_PROJECT_SKILL_BYTES}`, 'REMOTE_INVALID_ARGUMENT')
  }
  if (target.info.size > maxBytes) throw protocolError('project skill file exceeds its byte limit', 'REMOTE_CONTENT_TOO_LARGE')
  const data = await readValidatedFile(target, signal, 'project skill file')
  signal.throwIfAborted()
  if (data.length > maxBytes) throw protocolError('project skill file exceeds its byte limit', 'REMOTE_CONTENT_TOO_LARGE')
  const version = versionOf(data)
  if (args.expectedVersion !== undefined && args.expectedVersion !== version) {
    throw protocolError('project skill changed after manifest creation', 'REMOTE_STALE_CONFIG')
  }
  const text = data.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(data)) throw protocolError('project skill is not valid UTF-8', 'REMOTE_CONFIG_NOT_UTF8')
  return {
    path: target.path,
    directory: path.dirname(target.path),
    relative: target.relative,
    size: data.length,
    mtimeMs: target.info.mtimeMs,
    version,
    text,
  }
}


function bwrapProfileArgs(mode, workspaceRoot) {
  if (mode !== 'read-only' && mode !== 'workspace-write') {
    throw protocolError(`unsupported remote sandbox mode ${JSON.stringify(mode)}`, 'REMOTE_SANDBOX_UNSUPPORTED')
  }
  const argv = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--tmpfs', '/etc',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind-try', '/etc/passwd', '/etc/passwd',
    '--ro-bind-try', '/etc/group', '/etc/group',
    '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind-try', '/etc/hosts', '/etc/hosts',
    '--ro-bind-try', '/etc/hostname', '/etc/hostname',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
    '--remount-ro', '/etc',
    '--dev', '/dev', '--tmpfs', '/tmp', '--unshare-pid', '--unshare-net',
    '--proc', '/proc', '--die-with-parent',
  ]
  if (typeof workspaceRoot !== 'string' || !path.posix.isAbsolute(workspaceRoot)) {
    throw protocolError(`${mode} requires an absolute remote workspace root`, 'REMOTE_INVALID_PATH')
  }
  if (mode === 'workspace-write') argv.push('--bind', workspaceRoot, workspaceRoot)
  else argv.push('--ro-bind', workspaceRoot, workspaceRoot)
  return argv
}

function buildBashArgv({ mode, workspaceRoot, cwd, command }) {
  if (mode === 'danger-full-access') return ['bash', '-c', command]
  return ['bwrap', ...bwrapProfileArgs(mode, workspaceRoot), '--chdir', cwd, '--', 'bash', '-c', command]
}

function safeRemoteEnv(...sources) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'PAGER', 'GIT_PAGER', 'TMPDIR']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length <= 8192) env[key] = value
  }
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin'
  env.SHELL = '/bin/bash'
  const allowed = /^(?:LANG|LC_[A-Z0-9_]+|TERM|NO_COLOR|PAGER|GIT_PAGER|TMPDIR)$/
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (allowed.test(key) && typeof value === 'string' && value.length <= 8192 && !value.includes('\0')) env[key] = value
    }
  }
  return env
}

function probeBwrap() {
  if (bwrapProbeResult !== undefined) return bwrapProbeResult
  if (process.platform !== 'linux') return (bwrapProbeResult = false)
  try {
    const probe = spawnSync('bwrap', [...bwrapProfileArgs('read-only', '/usr'), '--', 'true'], {
      timeout: 5000,
      stdio: 'ignore',
      env: safeRemoteEnv(),
    })
    bwrapProbeResult = !probe.error && probe.status === 0
  } catch {
    bwrapProbeResult = false
  }
  return bwrapProbeResult
}

function probeRemoteDependencies() {
  let rg = { available: false, version: '' }
  try {
    const result = spawnSync('rg', ['--version'], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: safeRemoteEnv() })
    if (!result.error && result.status === 0) {
      rg = { available: true, version: String(result.stdout || '').split(/\r?\n/, 1)[0].slice(0, 120) }
    }
  } catch { /* report unavailable */ }
  let bwrapAvailable = false
  try {
    const result = spawnSync('bwrap', ['--version'], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: safeRemoteEnv() })
    bwrapAvailable = !result.error && result.status === 0
  } catch { /* report unavailable */ }
  return {
    rg,
    bwrap: { available: bwrapAvailable, usable: bwrapAvailable && probeBwrap() },
  }
}

async function resolveBashDirectory(rawPath, label, signal) {
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || !path.posix.isAbsolute(rawPath) || rawPath.includes('\0')) {
    throw protocolError(`${label} must be an absolute POSIX path`, 'REMOTE_INVALID_PATH')
  }
  const candidate = path.resolve(rawPath)
  if (!within(root, candidate)) throw protocolError(`${label} is outside the remote workspace`, 'REMOTE_PATH_DENIED')
  const resolved = await fs.promises.realpath(candidate).catch((error) => {
    throw protocolError(`cannot resolve ${label}: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  if (!within(root, resolved)) throw protocolError(`${label} symlink resolves outside the remote workspace`, 'REMOTE_PATH_DENIED')
  const info = await fs.promises.stat(resolved)
  if (!info.isDirectory()) throw protocolError(`${label} is not a directory`, 'REMOTE_NOT_DIRECTORY')
  return resolved
}

// danger-full-access intentionally escapes the workspace: the effective DSH
// session policy already grants the whole remote host, so confining cwd to the
// mirror would make the mode a lie. Only shape is validated here — the path
// must be absolute, NUL-free, and an existing directory.
async function resolveUnconfinedBashDirectory(rawPath, label, signal) {
  signal.throwIfAborted()
  if (typeof rawPath !== 'string' || !path.posix.isAbsolute(rawPath) || rawPath.includes('\0')) {
    throw protocolError(`${label} must be an absolute POSIX path`, 'REMOTE_INVALID_PATH')
  }
  const resolved = await fs.promises.realpath(path.resolve(rawPath)).catch((error) => {
    throw protocolError(`cannot resolve ${label}: ${error.message}`, error.code || 'REMOTE_NOT_FOUND')
  })
  const info = await fs.promises.stat(resolved)
  if (!info.isDirectory()) throw protocolError(`${label} is not a directory`, 'REMOTE_NOT_DIRECTORY')
  return resolved
}

function signalBashTask(task, signalName) {
  if (!task.child || task.settled) return
  try {
    if (task.child.pid) process.kill(-task.child.pid, signalName)
    else task.child.kill(signalName)
  } catch {
    try { task.child.kill(signalName) } catch { /* process already exited */ }
  }
}

function cancelBashTask(task, reason) {
  if (task.settled) return false
  if (reason === 'timeout') task.timedOut = true
  else task.aborted = true
  if (!task.child) {
    task.cancelBeforeSpawn = true
    return true
  }
  signalBashTask(task, 'SIGTERM')
  if (!task.killTimer) {
    task.killTimer = setTimeout(() => signalBashTask(task, 'SIGKILL'), task.graceMs)
    task.killTimer.unref?.()
  }
  return true
}

function createBashTask(args) {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  return {
    ...args,
    child: null,
    done,
    settled: false,
    exitCode: null,
    signal: null,
    spawnError: null,
    timedOut: false,
    aborted: false,
    cancelBeforeSpawn: false,
    killTimer: null,
    timeoutTimer: null,
    stdout: captureStream(args.stdoutMaxBytes, true),
    stderr: captureStream(args.stderrMaxBytes, true),
    finish(exitCode, signal) {
      if (this.settled) return
      this.settled = true
      this.exitCode = exitCode
      this.signal = signal
      clearTimeout(this.killTimer)
      clearTimeout(this.timeoutTimer)
      settle()
    },
  }
}

function rememberPendingBashCancel(taskId, reason) {
  const now = Date.now()
  for (const [id, value] of pendingBashCancels) {
    if (value.expiresAt <= now) pendingBashCancels.delete(id)
  }
  if (pendingBashCancels.size >= 32 && !pendingBashCancels.has(taskId)) {
    throw protocolError('too many pending remote Bash cancellations', 'REMOTE_BUSY')
  }
  pendingBashCancels.set(taskId, { reason, expiresAt: now + BASH_CANCEL_TTL_MS })
}

function cancelBash(taskId, reason = 'aborted') {
  const task = bashTasks.get(taskId)
  if (task) return { accepted: cancelBashTask(task, reason), pending: false }
  if (activeBashStarts.has(taskId)) {
    rememberPendingBashCancel(taskId, reason)
    return { accepted: true, pending: true }
  }
  return { accepted: false, pending: false }
}

async function runBash(args, signal) {
  const taskId = String(args.taskId || '')
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw protocolError('Bash taskId must be a UUID', 'REMOTE_INVALID_ARGUMENT')
  if (bashTasks.has(taskId) || activeBashStarts.has(taskId)) throw protocolError('Bash taskId is already active', 'REMOTE_DUPLICATE_TASK')
  if (bashTasks.size + activeBashStarts.size >= MAX_ACTIVE_BASHES) throw protocolError('too many remote Bash commands are active', 'REMOTE_BUSY')
  activeBashStarts.add(taskId)
  const onAbort = () => cancelBash(taskId, 'aborted')
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  let task
  try {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 1024 * 1024 || args.command.includes('\0')) {
      throw protocolError('Bash command must be non-empty, NUL-free, and at most 1 MiB', 'REMOTE_INVALID_ARGUMENT')
    }
    const mode = String(args.mode || '')
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) {
      throw protocolError('Bash requires a resolved sandbox policy', 'REMOTE_SANDBOX_UNAVAILABLE')
    }
    const cwd = mode === 'danger-full-access'
      ? await resolveUnconfinedBashDirectory(args.cwd, 'Bash cwd', signal)
      : await resolveBashDirectory(args.cwd, 'Bash cwd', signal)
    const workspaceRoot = mode === 'danger-full-access'
      ? undefined
      : await resolveBashDirectory(args.workspaceRoot, 'sandbox workspace root', signal)
    const timeoutMs = Number(args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS)
    const graceMs = Number(args.graceMs ?? BASH_DEFAULT_GRACE_MS)
    const stdoutMaxBytes = Number(args.stdoutMaxBytes ?? 64 * 1024)
    const stderrMaxBytes = Number(args.stderrMaxBytes ?? 64 * 1024)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > BASH_MAX_TIMEOUT_MS) {
      throw protocolError(`timeoutMs must be between 1 and ${BASH_MAX_TIMEOUT_MS}`, 'REMOTE_INVALID_ARGUMENT')
    }
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > BASH_MAX_GRACE_MS) {
      throw protocolError(`graceMs must be between 0 and ${BASH_MAX_GRACE_MS}`, 'REMOTE_INVALID_ARGUMENT')
    }
    for (const [name, cap] of [['stdoutMaxBytes', stdoutMaxBytes], ['stderrMaxBytes', stderrMaxBytes]]) {
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_BASH_OUTPUT_BYTES) {
        throw protocolError(`${name} must be between 1 and ${MAX_BASH_OUTPUT_BYTES}`, 'REMOTE_INVALID_ARGUMENT')
      }
    }
    if (mode !== 'danger-full-access') {
      if (process.platform !== 'linux') throw protocolError('remote Bash confinement currently requires Linux bwrap', 'REMOTE_SANDBOX_UNSUPPORTED')
      if (!probeBwrap()) throw protocolError('no usable remote bwrap sandbox is available; command was not run', 'SANDBOX_UNAVAILABLE')
    }
    signal.throwIfAborted()

    task = createBashTask({ taskId, mode, cwd, workspaceRoot, timeoutMs, graceMs, stdoutMaxBytes, stderrMaxBytes })
    bashTasks.set(taskId, task)
    const pending = pendingBashCancels.get(taskId)
    if (pending) {
      pendingBashCancels.delete(taskId)
      cancelBashTask(task, pending.reason)
    }
    if (signal.aborted) cancelBashTask(task, 'aborted')
    if (task.cancelBeforeSpawn) {
      task.finish(null, null)
    } else {
      const argv = buildBashArgv({ mode, workspaceRoot, cwd, command: args.command })
      task.child = spawn(argv[0], argv.slice(1), {
        cwd: mode === 'danger-full-access' ? cwd : root,
        env: safeRemoteEnv(args.env, args.dshEnv, mode === 'workspace-write' ? { TMPDIR: '/tmp' } : {}),
        detached: true,
        stdio: [args.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      task.child.stdout.on('data', (chunk) => task.stdout.append(chunk))
      task.child.stderr.on('data', (chunk) => task.stderr.append(chunk))
      task.child.once('error', (error) => {
        task.spawnError = error
        task.finish(null, null)
      })
      task.child.once('close', (exitCode, exitSignal) => task.finish(exitCode, exitSignal))
      if (args.stdin !== undefined) {
        task.child.stdin.end(String(args.stdin))
      }
      if (task.cancelBeforeSpawn || signal.aborted) cancelBashTask(task, signal.aborted ? 'aborted' : 'timeout')
      task.timeoutTimer = setTimeout(() => cancelBashTask(task, 'timeout'), timeoutMs)
      task.timeoutTimer.unref?.()
    }
    await task.done
    const stdout = task.stdout.result()
    const stderr = task.stderr.result()
    const stderrText = stderr.data.toString('utf8')
    if (mode !== 'danger-full-access' && task.exitCode !== 0 && /^bwrap:\s/m.test(stderrText)) {
      throw protocolError(`remote bwrap failed before the command completed: ${stderrText.trim()}`, 'SANDBOX_UNAVAILABLE')
    }
    const denied = mode !== 'danger-full-access' && task.exitCode !== 0
      && /read-only file system|permission denied|operation not permitted/i.test(stderrText)
    if (task.spawnError) {
      const code = mode !== 'danger-full-access' && task.spawnError.code === 'ENOENT' ? 'SANDBOX_UNAVAILABLE' : 'REMOTE_EXEC_FAILED'
      throw protocolError(`remote Bash could not start: ${task.spawnError.message || String(task.spawnError)}`, code)
    }
    return {
      taskId,
      cwd,
      exitCode: task.exitCode,
      signal: task.signal,
      timedOut: task.timedOut,
      aborted: task.aborted,
      timeoutMs,
      stdout: { text: stdout.data.toString('utf8'), truncated: stdout.lossy },
      stderr: { text: stderrText, truncated: stderr.lossy },
      sandbox: mode === 'danger-full-access'
        ? { mode, denied: false }
        : { mode, denied, enforcement: 'full' },
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    activeBashStarts.delete(taskId)
    pendingBashCancels.delete(taskId)
    if (bashTasks.get(taskId) === task) bashTasks.delete(taskId)
  }
}

async function handle(frame) {

  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw protocolError('request frame must be an object')
  if (frame.type === 'ping') return writeFrame({ type: 'pong', at: frame.at, protocol: PROTOCOL })
  if (frame.type === 'cancel') {
    const controller = controllers.get(String(frame.id || ''))
    if (controller) {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      controller.abort(error)
    }
    return
  }
  if (frame.type === 'shutdown') {
    shuttingDown = true
    for (const controller of controllers.values()) controller.abort('helper shutdown')
    stopWhenDrained()
    return
  }
  if (frame.type !== 'request') throw protocolError(`unsupported request type ${JSON.stringify(frame.type)}`)
  const id = String(frame.id || '')
  if (!id) throw protocolError('request id is required')
  if (controllers.has(id)) {
    return writeFrame({ type: 'response', id, ok: false, error: { code: 'REMOTE_DUPLICATE_REQUEST', message: 'request id is already active' } })
  }
  if (frame.protocol !== PROTOCOL) {
    return writeFrame({ type: 'response', id, ok: false, error: { code: 'REMOTE_PROTOCOL_MISMATCH', message: `protocol ${PROTOCOL} required` } })
  }
  if (controllers.size >= MAX_IN_FLIGHT) {
    return writeFrame({ type: 'response', id, ok: false, error: { code: 'REMOTE_BUSY', message: 'too many concurrent requests' } })
  }
  const controller = new AbortController()
  controllers.set(id, controller)
  try {
    let result
    if (frame.op === 'hello') {
      const dependencies = probeRemoteDependencies()
      const capabilities = ['fs.read', 'fs.write', 'fs.edit', 'fs.read_image', 'instructions.read', 'project.skills', 'bash.exec']
      if (dependencies.rg.available) capabilities.push('search.rg')
      if (dependencies.bwrap.usable) capabilities.push('sandbox.bwrap')
      result = { protocol: PROTOCOL, platform: process.platform, root, capabilities, dependencies }
    }
    else if (frame.op === 'read') result = await readWindow(frame.payload || {}, controller.signal)
    else if (frame.op === 'instruction_read') result = await readInstructionFile(frame.payload || {}, controller.signal)
    else if (frame.op === 'write') result = await writeText(frame.payload || {}, controller.signal)
    else if (frame.op === 'edit') result = await editText(frame.payload || {}, controller.signal)
    else if (frame.op === 'image_begin') result = await beginImageTransfer(frame.payload || {}, controller.signal)
    else if (frame.op === 'image_chunk') result = readImageChunk(frame.payload || {}, controller.signal)
    else if (frame.op === 'image_release') result = { released: releaseImageTransfer(String(frame.payload?.transferId || '')) }
    else if (frame.op === 'search_begin') result = await beginSearch(frame.payload || {}, controller.signal)
    else if (frame.op === 'search_chunk') result = readSearchChunk(frame.payload || {}, controller.signal)
    else if (frame.op === 'search_release') result = { released: releaseSearchTransfer(String(frame.payload?.transferId || '')) }
    else if (frame.op === 'project_skills_manifest') result = await projectSkillsManifest(frame.payload || {}, controller.signal)
    else if (frame.op === 'project_skill_read') result = await readProjectSkill(frame.payload || {}, controller.signal)
    else if (frame.op === 'bash_exec') result = await runBash(frame.payload || {}, controller.signal)
    else if (frame.op === 'bash_cancel') {
      const taskId = String(frame.payload?.taskId || '')
      if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw protocolError('Bash taskId must be a UUID', 'REMOTE_INVALID_ARGUMENT')
      result = cancelBash(taskId, frame.payload?.reason === 'timeout' ? 'timeout' : 'aborted')
    }
    else throw protocolError(`unsupported operation ${JSON.stringify(frame.op)}`, 'REMOTE_UNSUPPORTED_OPERATION')
    await writeFrame({ type: 'response', id, ok: true, result })
  } catch (error) {
    await writeFrame({ type: 'response', id, ok: false, error: { code: error.code || 'REMOTE_OPERATION_FAILED', message: error.message || String(error), name: error.name } })
  } finally {
    controllers.delete(id)
    stopWhenDrained()
  }
}

async function main() {
  const rootIndex = process.argv.indexOf('--root')
  if (rootIndex < 0 || !process.argv[rootIndex + 1]) throw new Error('helper requires --root <workspace>')
  root = await fs.promises.realpath(path.resolve(process.argv[rootIndex + 1]))
  if (!(await fs.promises.stat(root)).isDirectory()) throw new Error('remote workspace root is not a directory')
  process.stdin.on('data', (chunk) => {
    if (shuttingDown) return
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    let start = 0
    for (;;) {
      const end = buffer.indexOf(10, start)
      if (end < 0) break
      const frameBytes = buffer.subarray(start, end)
      start = end + 1
      if (frameBytes.length === 0) continue
      if (frameBytes.length > MAX_FRAME_BYTES) {
        process.stderr.write('remote helper rejected an oversized frame\n')
        process.exitCode = 1
        shuttingDown = true
        for (const controller of controllers.values()) controller.abort('invalid protocol input')
        stopWhenDrained()
        return
      }
      let frame
      try { frame = JSON.parse(frameBytes.toString('utf8')) } catch (error) {
        process.stderr.write(`remote helper rejected malformed JSON: ${error.message}\n`)
        process.exitCode = 1
        shuttingDown = true
        for (const controller of controllers.values()) controller.abort('invalid protocol input')
        stopWhenDrained()
        return
      }
      void handle(frame).catch((error) => {
        process.stderr.write(`remote helper protocol failed: ${error.message || error}\n`)
        process.exitCode = 1
        shuttingDown = true
        for (const controller of controllers.values()) controller.abort('protocol failure')
        stopWhenDrained()
      })
    }
    buffer = buffer.subarray(start)
    if (buffer.length > MAX_FRAME_BYTES) {
      process.stderr.write('remote helper rejected an oversized frame\n')
      process.exitCode = 1
      shuttingDown = true
      for (const controller of controllers.values()) controller.abort('invalid protocol input')
      stopWhenDrained()
    }
  })
  process.stdin.on('end', () => {
    shuttingDown = true
    for (const controller of controllers.values()) controller.abort('SSH channel closed')
    stopWhenDrained()
  })
  const heartbeat = setInterval(() => { if (!shuttingDown) void writeFrame({ type: 'heartbeat', at: Date.now(), protocol: PROTOCOL }) }, 15000)
  heartbeat.unref()
}

module.exports = { bwrapProfileArgs, buildBashArgv, openValidatedFile, probeRemoteDependencies, readValidatedFile, safeRemoteEnv }

if (require.main === module) module.exports = { bwrapProfileArgs, buildBashArgv, openValidatedFile, probeRemoteDependencies, readValidatedFile, safeRemoteEnv }

if (require.main === module) main().catch((error) => {
  process.stderr.write(`remote helper startup failed: ${error.message || error}\n`)
  process.exitCode = 1
})
