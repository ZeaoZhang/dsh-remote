import path from 'node:path'
import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { isRemoteTransportClosed } from './remote-rpc.js'

export const TOOL_NAMES = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash']
const SEARCH_TOOL_NAMES = new Set(['glob', 'grep'])
const UNSUPPORTED_TOOLS = new Set()
const MUTATION_RESULT_FIELDS = {
  write: ['path', 'operation', 'before', 'after'],
  edit: ['path', 'before', 'after'],
}

function withinLocal(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function withinRemote(root, candidate) {
  const relative = path.posix.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
}

function workspaceRoots(binding) {
  if (!binding || typeof binding !== 'object') {
    throw new Error('transparent remote binding is unavailable')
  }
  const remoteAliases = [binding.ws, ...(Array.isArray(binding.wsAliases) ? binding.wsAliases : [])]
  if (remoteAliases.some((remotePath) => typeof remotePath !== 'string' || !path.posix.isAbsolute(remotePath) || remotePath.includes('\0'))) {
    throw new Error('transparent remote binding requires absolute POSIX workspace paths')
  }
  if (typeof binding.mirrorDir !== 'string' || !path.isAbsolute(binding.mirrorDir) || binding.mirrorDir.includes('\0')) {
    throw new Error('transparent remote binding requires an absolute local mirrorDir path')
  }
  return {
    ws: path.posix.resolve(binding.ws),
    wsAliases: [...new Set(remoteAliases.map((remotePath) => path.posix.resolve(remotePath)))],
    mirrorDir: path.resolve(binding.mirrorDir),
  }
}

function canonicalRemotePath(rawPath, roots) {
  const candidate = path.posix.resolve(rawPath)
  if (withinRemote(roots.ws, candidate)) return candidate
  for (const alias of roots.wsAliases) {
    if (withinRemote(alias, candidate)) {
      return path.posix.resolve(roots.ws, path.posix.relative(alias, candidate))
    }
  }
  return null
}

function remoteFromLocal(localPath, roots) {
  const relative = path.relative(roots.mirrorDir, localPath)
  const candidate = path.posix.resolve(roots.ws, relative.split(path.sep).join('/'))
  if (!withinRemote(roots.ws, candidate)) {
    throw new Error('path resolves outside the remote workspace')
  }
  return candidate
}

export function mapLocalPathToRemote(binding, localPath) {
  const roots = workspaceRoots(binding)
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || localPath.includes('\0')) {
    throw new Error('local sandbox path must be absolute before remote mapping')
  }
  return remoteFromLocal(path.resolve(localPath), roots)
}

export function mirrorPathForRemote(binding, remotePath) {
  const roots = workspaceRoots(binding)
  if (typeof remotePath !== 'string' || !path.posix.isAbsolute(remotePath) || remotePath.includes('\0')) {
    throw new Error('remote filesystem target must be an absolute POSIX path')
  }
  const canonical = path.posix.resolve(remotePath)
  if (!withinRemote(roots.ws, canonical)) {
    throw new Error('remote filesystem target is outside the workspace')
  }
  const relative = path.posix.relative(roots.ws, canonical)
  const localPath = path.resolve(roots.mirrorDir, relative.split('/').join(path.sep))
  if (!withinLocal(roots.mirrorDir, localPath)) {
    throw new Error('remote filesystem target maps outside the local mirror')
  }
  return localPath
}

async function remoteCwd(exec, roots, resolveWorkingDirectory) {
  const cwd = await resolveWorkingDirectory(exec)
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    throw new Error('current DSH working directory is unavailable for remote path resolution')
  }

  if (path.isAbsolute(cwd)) {
    const localCwd = path.resolve(cwd)
    if (withinLocal(roots.mirrorDir, localCwd)) return remoteFromLocal(localCwd, roots)
  }

  if (path.posix.isAbsolute(cwd)) {
    const remoteCwdPath = canonicalRemotePath(cwd, roots)
    if (remoteCwdPath) return remoteCwdPath
  }

  throw new Error('session cwd is outside the remote mirror and workspace')
}

async function resolveRemotePath(rawPath, exec, binding, resolveWorkingDirectory) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
    throw new Error('file_path must be a non-empty path without NUL bytes')
  }

  const roots = workspaceRoots(binding)
  const isAbsolute = path.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)
  if (isAbsolute) {
    const localPath = path.resolve(rawPath)
    if (withinLocal(roots.mirrorDir, localPath)) return remoteFromLocal(localPath, roots)

    if (path.posix.isAbsolute(rawPath)) {
      const remotePath = canonicalRemotePath(rawPath, roots)
      if (remotePath) return remotePath
    }
    const outside = new Error('absolute path is outside the remote mirror and workspace')
    outside.code = 'REMOTE_PATH_OUTSIDE'
    throw outside
  }

  const cwd = await remoteCwd(exec, roots, resolveWorkingDirectory)
  const remotePath = path.posix.resolve(cwd, rawPath)
  if (!withinRemote(roots.ws, remotePath)) {
    throw new Error('relative path resolves outside the remote workspace')
  }
  return remotePath
}

/**
 * Resolve a tool path, importing a file that only exists on the local machine.
 *
 * `read`/`read_image` import such a file into `<ws>/.dsh-remote/imports/…` and
 * then act on the remote copy; `write`/`edit` point the model at the import
 * instead of silently editing a local file that every other tool cannot see.
 */
async function resolveRemoteFilePath({ rawPath, name, exec, binding, resolveWorkingDirectory, localImport }) {
  try {
    return await resolveRemotePath(rawPath, exec, binding, resolveWorkingDirectory)
  } catch (error) {
    if (error?.code !== 'REMOTE_PATH_OUTSIDE') throw error
    if (name === 'read' || name === 'read_image') {
      if (typeof localImport?.importFile !== 'function') throw error
      const imported = await localImport.importFile({ localPath: rawPath, binding, exec })
      if (!imported || typeof imported.remotePath !== 'string' || imported.remotePath.length === 0) throw error
      return imported.remotePath
    }
    const importable = typeof localImport?.isImportable === 'function' && await localImport.isImportable(rawPath)
    if (importable) {
      throw new Error(`transparent remote ${name} cannot change a file that only exists on the local machine (${rawPath}): read it first — the import copies it onto this host and read reports the imported path`)
    }
    throw error
  }
}

function standardResult(result, fields, name) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`remote ${name} returned an invalid result`)
  }
  return Object.fromEntries(fields.map((field) => [field, result[field]]))
}

// The remote helper reports a missing file as REMOTE_NOT_FOUND (its protocol
// error code), never as ENOENT — the ENOENT checks below would therefore never
// fire and a read/read_image of a path that does not exist left a STALE
// observation behind: `emitFsObserved(target, { kind: 'absent' })` is what tells
// DSH's filesystem layer the path is gone, and skipping it made an edit of a
// since-deleted file look like it still had the last-read version.
function isRemoteNotFound(error) {
  return error?.code === 'ENOENT' || error?.code === 'REMOTE_NOT_FOUND'
}

function rejectSandboxEscalation(args, name) {
  if (args && (args.sandbox_permissions !== undefined || String(args.justification || '').trim())) {
    throw new Error(`transparent remote ${name} does not accept sandbox_permissions or justification`)
  }
}

function remoteVersion(result, name) {
  if (typeof result?.version !== 'string' || !/^[a-f0-9]{64}$/i.test(result.version)) {
    throw new Error(`remote ${name} returned an invalid content version`)
  }
  return result.version
}

function rememberObservedVersion(versions, canonicalPaths, requestedPath, canonicalPath, version) {
  for (const [alias, target] of canonicalPaths) {
    if (target === canonicalPath) versions.set(alias, version)
  }
  versions.set(requestedPath, version)
  versions.set(canonicalPath, version)
  canonicalPaths.set(requestedPath, canonicalPath)
  canonicalPaths.set(canonicalPath, canonicalPath)
}

function forgetObservedVersion(versions, canonicalPaths, remotePath) {
  const canonicalPath = canonicalPaths.get(remotePath) ?? remotePath
  for (const [alias, target] of canonicalPaths) {
    if (alias === canonicalPath || target === canonicalPath) {
      canonicalPaths.delete(alias)
      versions.delete(alias)
    }
  }
  canonicalPaths.delete(canonicalPath)
  versions.delete(canonicalPath)
}

// DSH's default preset mounts `fs-observation-policy`, so `fs/write-intent` and
// `fs/edit-intent` always answer: `undefined` only means no policy is listening.
// The intent is scoped to the local mirror target, so its version is not
// comparable with a remote version — but the shipped policy's guarantees
// (write may create only an unobserved path, edit must follow a read) are the
// same ones the remote `expectedVersion` guard enforces (`null` = create only).
// Translate the known shapes onto that guard, keep unknown policies fail-closed,
// and refuse an intent that contradicts the remote observation ledger (a stale
// or resumed session writing over a file it no longer guards).
function mutationIntentVersion(name, intent, expectedVersion) {
  if (intent === undefined) return expectedVersion
  if (name === 'write' && intent?.kind === 'createIfAbsent') {
    if (expectedVersion !== null) {
      throw new Error('transparent remote write cannot honor a create-only local intent: the remote file still has an observed version; read it again before writing')
    }
    return null
  }
  if (name === 'write' && intent?.kind === 'replaceIfVersion') {
    if (expectedVersion === null) {
      throw new Error('transparent remote write cannot honor a version-guarded local intent: the remote file has no observed version; read it again before writing')
    }
    return expectedVersion
  }
  if (name === 'edit' && typeof intent?.version === 'string') {
    if (expectedVersion === null) {
      throw new Error('transparent remote edit cannot honor a version-guarded local intent: the remote file has no observed version; read it again before editing')
    }
    return expectedVersion
  }
  throw new Error(`transparent remote ${name} cannot honor a non-empty local filesystem intent`)
}

function unsupportedExecute(name) {
  return async function executeUnsupportedRemotely() {
    throw new Error(`tool "${name}" is not supported in transparent remote mode; local execution is disabled`)
  }
}

// DSH standard tools that carry the local approval surface. Transparent mode
// runs on the SSH host, where a local sandbox decision means nothing, so the
// parameters must not be ADVERTISED: a model that sees them fills them in and
// `rejectSandboxEscalation` then fails a call whose only problem was that the
// tool declaration offered an argument the override refuses.
const LOCAL_APPROVAL_PARAMETERS = ['run_in_background', 'sandbox_permissions', 'justification']

/** Drop the local approval surface from a standard tool's declared parameters. */
function withoutLocalApprovalParameters(original, extra = []) {
  const dropped = LOCAL_APPROVAL_PARAMETERS.concat(extra)
  const parameters = original.parameters && typeof original.parameters === 'object'
    ? { ...original.parameters }
    : original.parameters
  if (parameters?.properties && typeof parameters.properties === 'object') {
    parameters.properties = { ...parameters.properties }
    for (const name of dropped) delete parameters.properties[name]
  }
  if (Array.isArray(parameters?.required)) {
    parameters.required = parameters.required.filter((name) => !dropped.includes(name))
  }
  return parameters
}

function foregroundBashTool(original, execute) {
  return {
    ...original,
    description: `${original.description || 'Execute a Bash command.'} Transparent remote mode is foreground-only; background jobs and per-call sandbox escalation are unavailable.`,
    parameters: withoutLocalApprovalParameters(original),
    isConcurrencySafe: () => false,
    execute,
  }
}

/** `write`/`edit` keep their schema except the local approval surface, which
 *  the remote override rejects (the local approval cannot authorize a remote
 *  operation). */
function remoteMutationTool(original, execute) {
  return {
    ...original,
    description: `${original.description || ''} Transparent remote mode applies this change on the SSH host; per-call sandbox escalation is unavailable.`.trim(),
    parameters: withoutLocalApprovalParameters(original),
    execute,
  }
}

/**
 * Install per-agent replacements for DSH's standard tool definitions.
 *
 * `resolveBinding(exec)` returns `{ ws, mirrorDir }`; `resolveWorkingDirectory(exec)` returns DSH's
 * dynamic local working directory. `resolveFsTarget(path,binding,exec)` creates the local DSH Target
 * used only for sandbox and observation hooks. `runFsIntent` and `emitFsObserved` bridge DSH's
 * mutation and observation events; `getHelper(binding,exec)` returns `{ rpc }`.
 * `assertMutationAllowed(exec,args,name)` may throw or return `false`. `localImport({isImportable,
 * importFile})` may copy a file that exists only on the local machine (a chat attachment, a browser
 * screenshot) onto the host when `read`/`read_image` targets it. The wrappers never call a local tool
 * implementation; other paths must resolve inside the bound mirror and remote workspace.
 */
export function installTransparentToolOverrides({
  agent,
  resolveBinding,
  resolveWorkingDirectory,
  resolveFsTarget,
  runFsIntent,
  emitFsObserved,
  getHelper,
  readImage,
  resolveBashSpec,
  executeBash,
  isSearchToolWrapped = () => false,
  assertMutationAllowed,
  onRemoteMutation,
  beforeRemoteFileAccess,
  beforeRemoteBash,
  readOpaqueResource,
  localImport,
}) {
  const tools = agent?.ctx?.tools
  if (!tools || typeof tools.get !== 'function' || typeof tools.register !== 'function') {
    throw new TypeError('transparent tool overrides require agent.ctx.tools.get/register')
  }
  if (typeof resolveBinding !== 'function' || typeof resolveWorkingDirectory !== 'function'
    || typeof resolveFsTarget !== 'function' || typeof runFsIntent !== 'function'
    || typeof emitFsObserved !== 'function' || typeof getHelper !== 'function'
    || typeof assertMutationAllowed !== 'function') {
    throw new TypeError('transparent tool overrides require binding, working directory, filesystem target, intent, observation, helper, and mutation-policy functions')
  }

  const observedVersions = new Map()
  const observedCanonicalPaths = new Map()
  const disposers = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const unregister of disposers.reverse()) {
      try { unregister() } catch { /* the agent scope may already be disposed */ }
    }
    observedVersions.clear()
    observedCanonicalPaths.clear()
  }

  try {
    for (const name of TOOL_NAMES) {
      const supportsRemoteBash = name === 'bash'
        && typeof resolveBashSpec === 'function'
        && typeof executeBash === 'function'
      const visible = tools.get(name, agent)
      // A preset may hide a standard tool from this Agent. Hiding is safe: the
      // model cannot call a tool it cannot see, so a hidden tool must never
      // abort the whole install (that used to skip every other override and
      // leave the local implementations executable for the rest of the session).
      if (!visible) continue
      if (SEARCH_TOOL_NAMES.has(name) && isSearchToolWrapped(name, visible)) continue
      // Standard tools can be provided by an inherited preset scope, with
      // no global registration. Preserve the exact definition this agent sees.
      const original = visible
      if (!original || typeof original !== 'object' || typeof original.execute !== 'function') {
        // Visible but not executable by us: keep its schema and fail closed so
        // the model can never reach the local implementation by accident.
        const fallback = original && typeof original === 'object' ? { ...original, name } : { name }
        const unregister = tools.register({ ...fallback, execute: unsupportedExecute(name) })
        if (typeof unregister === 'function') disposers.push(unregister)
        continue
      }

      let execute
      if (UNSUPPORTED_TOOLS.has(name)
        || (SEARCH_TOOL_NAMES.has(name) && !isSearchToolWrapped(name, visible))
        || (name === 'read_image' && typeof readImage !== 'function')
        || (name === 'bash' && !supportsRemoteBash)) {
        execute = unsupportedExecute(name)
      } else {
        const runRemotely = async function executeRemotely(args, exec) {
          if (name === 'read' && typeof readOpaqueResource === 'function') {
            const violations = validateJsonSchemaValue(original.parameters, args, '')
            if (violations.length > 0) throw new ToolArgsError(violations)
            const outside = await readOpaqueResource(args, exec)
            if (outside !== undefined) {
              if (!outside || typeof outside !== 'object' || typeof outside.path !== 'string'
                || !Array.isArray(outside.lines) || typeof outside.totalLines !== 'number') {
                throw new Error('remote skill read returned an invalid DSH result')
              }
              return outside
            }
          }
          if (name === 'bash') {
            const violations = validateJsonSchemaValue(original.parameters, args, '')
            if (violations.length > 0) throw new ToolArgsError(violations)
            if (args.run_in_background === true) {
              throw new Error('transparent remote Bash is foreground-only; background jobs are not enabled')
            }
            rejectSandboxEscalation(args, name)
            const prepared = await resolveBashSpec(args, exec)
            const originalBinding = await resolveBinding(exec)
            const helper = await getHelper(originalBinding, exec)
            if (typeof helper?.rpc?.request !== 'function') throw new Error('transparent remote helper is unavailable')
            const binding = helper.root
              ? { ...originalBinding, ws: helper.root, wsAliases: [...(originalBinding.wsAliases || []), originalBinding.ws] }
              : originalBinding
            if (typeof beforeRemoteBash === 'function') {
              await beforeRemoteBash({ args, exec, binding, helper, prepared })
            }
            let result
            try {
              result = await executeBash({ args, exec, binding, helper, prepared })
            } finally {
              try { await onRemoteMutation?.({ name, binding, exec, helper, prepared }) } catch { /* refreshing project metadata is best effort */ }
            }
            const outputViolations = validateJsonSchemaValue(original.output.schema, result, '')
            if (outputViolations.length > 0) throw new Error(`remote Bash returned an invalid DSH result: ${outputViolations.join('; ')}`)
            return result
          }
          if (name === 'write' || name === 'edit') rejectSandboxEscalation(args, name)

          const originalBinding = await resolveBinding(exec)
          if (name === 'write' || name === 'edit') {
            const allowed = await assertMutationAllowed(exec, args, name)
            if (allowed === false) throw new Error(`transparent remote ${name} is not authorized`)
          }

          const helper = await getHelper(originalBinding, exec)
          if (typeof helper?.rpc?.request !== 'function') {
            throw new Error('transparent remote helper is unavailable')
          }
          const binding = helper.root
            ? { ...originalBinding, ws: helper.root, wsAliases: [...(originalBinding.wsAliases || []), originalBinding.ws] }
            : originalBinding
          const remotePath = await resolveRemoteFilePath({
            rawPath: args?.file_path,
            name,
            exec,
            binding,
            resolveWorkingDirectory,
            localImport,
          })
          const targetPath = name === 'read' ? remotePath : (observedCanonicalPaths.get(remotePath) ?? remotePath)
          const target = await resolveFsTarget(targetPath, binding, exec)
          if (typeof beforeRemoteFileAccess === 'function') {
            await beforeRemoteFileAccess({ name, args, exec, binding, helper, remotePath, target })
          }

          if (name === 'read') {
            let result
            try {
              result = await helper.rpc.request('read', {
                path: remotePath,
                offset: args.offset,
                limit: args.limit,
              }, { signal: exec?.signal })
            } catch (error) {
              if (isRemoteNotFound(error)) {
                forgetObservedVersion(observedVersions, observedCanonicalPaths, remotePath)
                emitFsObserved(target, { kind: 'absent' }, exec)
              }
              throw error
            }
            const version = remoteVersion(result, name)
            rememberObservedVersion(observedVersions, observedCanonicalPaths, remotePath, result.path, version)
            emitFsObserved(await resolveFsTarget(result.path, binding, exec), { kind: 'present', version }, exec)
            return standardResult(result, ['path', 'offset', 'lines', 'totalLines'], name)
          }

          if (name === 'read_image') {
            let result
            try {
              result = await readImage({ args, exec, binding, helper, remotePath, target })
            } catch (error) {
              if (isRemoteNotFound(error)) {
                forgetObservedVersion(observedVersions, observedCanonicalPaths, remotePath)
                emitFsObserved(target, { kind: 'absent' }, exec)
              }
              throw error
            }
            const version = remoteVersion(result, name)
            rememberObservedVersion(observedVersions, observedCanonicalPaths, remotePath, result.path, version)
            emitFsObserved(await resolveFsTarget(result.path, binding, exec), { kind: 'present', version }, exec)
            return standardResult(result, ['path', 'image'], name)
          }

          let expectedVersion = observedVersions.get(remotePath) ?? null
          const expectedPath = observedCanonicalPaths.get(remotePath) ?? null
          if (name === 'edit' && expectedVersion === null) {
            throw new Error('transparent remote edit requires a prior read of the same file')
          }
          const intent = await runFsIntent(name === 'write' ? 'fs/write-intent' : 'fs/edit-intent', target, exec)
          expectedVersion = mutationIntentVersion(name, intent, expectedVersion)
          try {
            const result = name === 'write'
              ? await helper.rpc.request('write', {
                path: remotePath,
                content: args.content,
                expectedVersion,
                expectedPath,
              }, { signal: exec?.signal })
              : await helper.rpc.request('edit', {
                path: remotePath,
                oldString: args.old_string,
                newString: args.new_string,
                replaceAll: args.replace_all ?? false,
                expectedVersion,
                expectedPath,
              }, { signal: exec?.signal })
            const version = remoteVersion(result, name)
            rememberObservedVersion(observedVersions, observedCanonicalPaths, remotePath, result.path, version)
            emitFsObserved(await resolveFsTarget(result.path, binding, exec), { kind: 'present', version }, exec)
            try { await onRemoteMutation?.({ name, remotePath: result.path, binding, exec, helper }) } catch { /* refreshing project metadata is best effort */ }
            return standardResult(result, MUTATION_RESULT_FIELDS[name], name)
          } catch (error) {
            if (error?.code === 'FS_STALE_VERSION') forgetObservedVersion(observedVersions, observedCanonicalPaths, remotePath)
            throw error
          }
        }
        // One retry for read-only RPCs: a dropped SSH channel destroys the
        // cached remote helper, and the retry opens a fresh one. Mutations and
        // Bash are never replayed because their remote outcome is unknown.
        execute = (name === 'read' || name === 'read_image')
          ? async function executeReadWithRetry(args, exec) {
            try {
              return await runRemotely(args, exec)
            } catch (error) {
              if (!isRemoteTransportClosed(error) || exec?.signal?.aborted) throw error
              try {
                const binding = await resolveBinding(exec)
                binding?.pool?.invalidate?.()
              } catch { /* best effort: the retry still opens a fresh helper */ }
              return runRemotely(args, exec)
            }
          }
          : runRemotely
      }

      const registeredTool = name === 'read_image'
        ? { ...original, isConcurrencySafe: () => false, execute }
        : name === 'bash' && supportsRemoteBash
          ? foregroundBashTool(original, execute)
          : (name === 'write' || name === 'edit')
            ? remoteMutationTool(original, execute)
            : { ...original, execute }
      const unregister = tools.register(registeredTool)
      if (typeof unregister === 'function') disposers.push(unregister)
    }
  } catch (error) {
    dispose()
    throw error
  }

  return dispose
}
