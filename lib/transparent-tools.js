import path from 'node:path'
import { ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const TOOL_NAMES = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash']
const REQUIRED_TOOL_NAMES = new Set(['read', 'write', 'edit'])
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
    throw new Error('absolute path is outside the remote mirror and workspace')
  }

  const cwd = await remoteCwd(exec, roots, resolveWorkingDirectory)
  const remotePath = path.posix.resolve(cwd, rawPath)
  if (!withinRemote(roots.ws, remotePath)) {
    throw new Error('relative path resolves outside the remote workspace')
  }
  return remotePath
}

function standardResult(result, fields, name) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`remote ${name} returned an invalid result`)
  }
  return Object.fromEntries(fields.map((field) => [field, result[field]]))
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

function unsupportedExecute(name) {
  return async function executeUnsupportedRemotely() {
    throw new Error(`tool "${name}" is not supported in transparent remote mode; local execution is disabled`)
  }
}

function foregroundBashTool(original, execute) {
  const parameters = original.parameters && typeof original.parameters === 'object'
    ? { ...original.parameters }
    : original.parameters
  if (parameters?.properties && typeof parameters.properties === 'object') {
    parameters.properties = { ...parameters.properties }
    delete parameters.properties.run_in_background
    delete parameters.properties.sandbox_permissions
    delete parameters.properties.justification
  }
  if (Array.isArray(parameters?.required)) {
    parameters.required = parameters.required.filter((name) => !['run_in_background', 'sandbox_permissions', 'justification'].includes(name))
  }
  return {
    ...original,
    description: `${original.description || 'Execute a Bash command.'} Transparent remote mode is foreground-only; background jobs and per-call sandbox escalation are unavailable.`,
    parameters,
    isConcurrencySafe: () => false,
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
 * `assertMutationAllowed(exec,args,name)` may throw or return `false`. The wrappers never call a
 * local tool implementation; paths must resolve inside the bound mirror and remote workspace.
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
      if (!visible && !REQUIRED_TOOL_NAMES.has(name)) continue
      if (!visible && REQUIRED_TOOL_NAMES.has(name)) {
        throw new Error(`cannot install transparent override: standard tool "${name}" is unavailable or restricted for this agent`)
      }
      if (SEARCH_TOOL_NAMES.has(name) && isSearchToolWrapped(name, visible)) continue
      // Standard tools can be provided by an inherited preset scope, with
      // no global registration. Preserve the exact definition this agent sees.
      const original = visible
      if (!original || typeof original !== 'object' || typeof original.execute !== 'function') {
        if (REQUIRED_TOOL_NAMES.has(name)) {
          throw new Error(`cannot install transparent override: standard tool "${name}" is not registered for this agent`)
        }
        continue
      }

      let execute
      if (UNSUPPORTED_TOOLS.has(name)
        || (SEARCH_TOOL_NAMES.has(name) && !isSearchToolWrapped(name, visible))
        || (name === 'read_image' && typeof readImage !== 'function')
        || (name === 'bash' && !supportsRemoteBash)) {
        execute = unsupportedExecute(name)
      } else {
        execute = async function executeRemotely(args, exec) {
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
          const remotePath = await resolveRemotePath(args?.file_path, exec, binding, resolveWorkingDirectory)
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
              if (error?.code === 'ENOENT') {
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
              if (error?.code === 'ENOENT') {
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

          const expectedVersion = observedVersions.get(remotePath) ?? null
          const expectedPath = observedCanonicalPaths.get(remotePath) ?? null
          if (name === 'edit' && expectedVersion === null) {
            throw new Error('transparent remote edit requires a prior read of the same file')
          }
          const intent = await runFsIntent(name === 'write' ? 'fs/write-intent' : 'fs/edit-intent', target, exec)
          if (intent !== undefined) {
            throw new Error(`transparent remote ${name} cannot honor a non-empty local filesystem intent`)
          }
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
      }

      const registeredTool = name === 'read_image'
        ? { ...original, isConcurrencySafe: () => false, execute }
        : name === 'bash' && supportsRemoteBash
          ? foregroundBashTool(original, execute)
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
