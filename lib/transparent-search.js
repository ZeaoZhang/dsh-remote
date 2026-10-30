import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { isRemoteTransportClosed } from './remote-rpc.js'

const SEARCH_NAMES = new Set(['glob', 'grep'])
const MAX_CHUNK_BYTES = 1024 * 1024
const SEARCH_ERROR = 'transparent remote subprocess refused local execution'

function withinLocal(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function withinRemote(root, candidate) {
  const relative = path.posix.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
}

function resolveAlias(raw, binding, helperRoot) {
  const candidate = path.posix.resolve(raw)
  const roots = [helperRoot, binding.ws, ...(Array.isArray(binding.wsAliases) ? binding.wsAliases : [])]
    .filter((value) => typeof value === 'string' && path.posix.isAbsolute(value))
    .map((value) => path.posix.resolve(value))
  for (const root of roots) {
    if (withinRemote(root, candidate)) {
      return path.posix.resolve(helperRoot, path.posix.relative(root, candidate))
    }
  }
  return null
}

function parseSearchSpec(spec, store) {
  const argv = spec?.argv
  if (!Array.isArray(argv) || argv.length < 2 || typeof argv[0] !== 'string') {
    throw new Error(`${SEARCH_ERROR}: subprocess argv is missing`)
  }
  const args = argv.slice(1)
  if (args[0] !== '--no-config') throw new Error(`${SEARCH_ERROR}: search must use --no-config`)
  const kind = store.toolName
  if (!SEARCH_NAMES.has(kind)) throw new Error(`${SEARCH_ERROR}: only native glob/grep are supported`)
  if (kind === 'glob' && !args.includes('--files')) throw new Error(`${SEARCH_ERROR}: argv does not match native glob`)
  if (kind === 'grep' && (!args.includes('--json') || !args.some((arg) => arg.startsWith('--regexp=')))) {
    throw new Error(`${SEARCH_ERROR}: argv does not match native grep`)
  }
  const separator = args.indexOf('--')
  const inputPath = store.args?.path
  if (inputPath === undefined && separator >= 0) throw new Error(`${SEARCH_ERROR}: unexpected native search path argument`)
  if (inputPath !== undefined && (separator < 0 || separator !== args.length - 2 || args[separator + 1] !== inputPath)) {
    throw new Error(`${SEARCH_ERROR}: native search path argv changed`)
  }
  return { kind, args, separator, inputPath }
}

function mapSearchPath(inputPath, binding, helperRoot, remoteCwd) {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.includes('\0')) {
    throw new Error(`${SEARCH_ERROR}: search path must be a non-empty string`)
  }
  if (path.isAbsolute(inputPath)) {
    const localPath = path.resolve(inputPath)
    if (withinLocal(path.resolve(binding.mirrorDir), localPath)) {
      const relativeFromMirror = path.relative(path.resolve(binding.mirrorDir), localPath)
      const target = path.posix.resolve(helperRoot, relativeFromMirror.split(path.sep).join('/'))
      if (!withinRemote(helperRoot, target)) throw new Error(`${SEARCH_ERROR}: local search path maps outside the remote workspace`)
      return path.posix.relative(remoteCwd, target) || '.'
    }
  }
  if (path.posix.isAbsolute(inputPath)) {
    const canonical = resolveAlias(inputPath, binding, helperRoot)
    if (!canonical) throw new Error(`${SEARCH_ERROR}: absolute search path is outside the remote workspace`)
    return canonical
  }
  const candidate = path.posix.resolve(remoteCwd, inputPath)
  if (!withinRemote(helperRoot, candidate)) throw new Error(`${SEARCH_ERROR}: relative search path escapes the remote workspace`)
  return inputPath
}

function remoteWorkingDirectory(specCwd, binding, helperRoot) {
  if (typeof specCwd !== 'string' || !path.isAbsolute(specCwd)) {
    throw new Error(`${SEARCH_ERROR}: native search has no absolute cwd`)
  }
  const localCwd = path.resolve(specCwd)
  const mirrorDir = path.resolve(binding.mirrorDir)
  if (!withinLocal(mirrorDir, localCwd)) throw new Error(`${SEARCH_ERROR}: subprocess cwd is outside the bound local mirror`)
  const relative = path.relative(mirrorDir, localCwd).split(path.sep).join('/')
  const remoteCwd = path.posix.resolve(helperRoot, relative)
  if (!withinRemote(helperRoot, remoteCwd)) throw new Error(`${SEARCH_ERROR}: subprocess cwd maps outside the remote workspace`)
  return { localCwd, remoteCwd }
}

function validateLimits(spec) {
  const stdoutMaxBytes = Number(spec?.stdio?.stdout?.maxBytes)
  const stderrMaxBytes = Number(spec?.stdio?.stderr?.maxBytes)
  const graceMs = Number(spec?.graceMs)
  if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes < 1) {
    throw new Error(`${SEARCH_ERROR}: native stdout byte cap is unavailable`)
  }
  if (!Number.isSafeInteger(stderrMaxBytes) || stderrMaxBytes < 0) {
    throw new Error(`${SEARCH_ERROR}: native stderr byte cap is unavailable`)
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error(`${SEARCH_ERROR}: native process termination grace is unavailable`)
  }
  return { stdoutMaxBytes, stderrMaxBytes, graceMs }
}

async function readRemoteStream(rpc, transfer, stream, signal) {
  const length = Number(transfer[`${stream}Bytes`])
  const expectedHash = transfer[`${stream}Hash`]
  if (!Number.isSafeInteger(length) || length < 0 || typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw new Error(`remote search returned invalid ${stream} metadata`)
  }
  const chunks = []
  for (let offset = 0; offset < length; offset += transfer.chunkSize) {
    const chunk = await rpc.request('search_chunk', {
      transferId: transfer.transferId,
      stream,
      offset,
      length: Math.min(transfer.chunkSize, length - offset),
    }, { signal })
    if (chunk?.transferId !== transfer.transferId || chunk.stream !== stream || chunk.offset !== offset || chunk.hash !== expectedHash || typeof chunk.data !== 'string') {
      throw new Error(`remote search returned an invalid ${stream} chunk`)
    }
    const data = Buffer.from(chunk.data, 'base64')
    if (data.length !== Math.min(transfer.chunkSize, length - offset)) {
      throw new Error(`remote search returned a truncated ${stream} chunk`)
    }
    chunks.push(data)
  }
  const output = Buffer.concat(chunks, length)
  const actualHash = createHash('sha256').update(output).digest('hex')
  if (actualHash !== expectedHash) throw new Error(`remote search ${stream} changed or was corrupted during transfer`)
  return output
}

function makeReader(getOutput, streamName) {
  return {
    readFrom(offset = 0) {
      const output = getOutput()
      if (!output) return { text: '', lossy: false }
      const data = output[streamName]
      const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
      return {
        text: data.subarray(start).toString('utf8'),
        lossy: output[`${streamName}Lossy`],
      }
    },
  }
}

function makeRemoteHandle(spec, store, binding, deps) {
  const controller = new AbortController()
  const externalSignal = spec.signal ?? store.exec?.signal
  const forwardAbort = () => controller.abort(externalSignal.reason || 'cancelled')
  if (externalSignal?.aborted) forwardAbort()
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true })
  let output
  let transferId
  let helper
  const readOnce = async () => {
    helper = await deps.getHelper(binding, store.exec)
    if (typeof helper?.rpc?.request !== 'function') throw new Error('remote helper is unavailable')
    const helperRoot = helper.root || binding.ws
    if (typeof helperRoot !== 'string' || !path.posix.isAbsolute(helperRoot)) throw new Error('remote helper root is invalid')
    const { localCwd, remoteCwd } = remoteWorkingDirectory(spec.cwd, binding, helperRoot)
    const parsed = parseSearchSpec(spec, store)
    const argv = parsed.args.slice()
    if (parsed.separator >= 0) {
      argv[parsed.separator + 1] = mapSearchPath(parsed.inputPath, binding, helperRoot, remoteCwd)
    }
    const limits = validateLimits(spec)
    const transfer = await helper.rpc.request('search_begin', {
      kind: parsed.kind,
      cwd: remoteCwd,
      argv,
      ...limits,
    }, { signal: controller.signal })
    transferId = transfer?.transferId
    if (typeof transferId !== 'string' || !transferId) throw new Error('remote helper returned an invalid search transfer id')
    if (!Number.isSafeInteger(transfer.chunkSize) || transfer.chunkSize < 1 || transfer.chunkSize > MAX_CHUNK_BYTES) {
      throw new Error('remote helper returned an invalid search chunk size')
    }
    const [stdout, stderr] = await Promise.all([
      readRemoteStream(helper.rpc, transfer, 'stdout', controller.signal),
      readRemoteStream(helper.rpc, transfer, 'stderr', controller.signal),
    ])
    output = {
      stdout,
      stderr,
      stdoutLossy: transfer.stdoutLossy === true,
      stderrLossy: transfer.stderrLossy === true,
    }
    return { exitCode: transfer.exitCode ?? null, signal: transfer.signal ?? null }
  }
  const done = (async () => {
    try {
      try {
        return await readOnce()
      } catch (error) {
        if (controller.signal.aborted || externalSignal?.aborted) {
          output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutLossy: false, stderrLossy: false }
          return { exitCode: null, signal: 'SIGTERM' }
        }
        // A dropped SSH channel loses the in-flight search transfer. Search is
        // read-only, so retry once against a freshly opened helper; user
        // cancellation and real failures are never retried.
        if (!isRemoteTransportClosed(error)) throw error
        try { binding?.pool?.invalidate?.() } catch { /* best effort */ }
        transferId = undefined
        return await readOnce()
      }
    } finally {
      externalSignal?.removeEventListener('abort', forwardAbort)
      if (transferId && helper?.rpc?.request) {
        await helper.rpc.request('search_release', { transferId }, { timeoutMs: 5000 }).catch(() => {})
      }
    }
  })()

  return {
    done,
    collected: {
      stdout: makeReader(() => output, 'stdout'),
      stderr: makeReader(() => output, 'stderr'),
    },
    async terminate() {
      if (!controller.signal.aborted) controller.abort('terminated')
      await done.catch(() => {})
    },
    async waitForExit() {
      return done
    },
  }
}

export function installTransparentSearchBridge({
  tools,
  subprocess,
  resolveBinding,
  resolveBindingForCwd,
  getHelper,
  onToolsChange,
}) {
  if (!tools || typeof tools.get !== 'function' || !subprocess || typeof subprocess.spawn !== 'function'
    || typeof resolveBinding !== 'function' || typeof resolveBindingForCwd !== 'function'
    || typeof getHelper !== 'function') return null

  const searchContext = new AsyncLocalStorage()
  const originalSpawn = subprocess.spawn
  const spawnDescriptor = Object.getOwnPropertyDescriptor(subprocess, 'spawn')
  const originalSpawnTerminal = typeof subprocess.spawnTerminal === 'function' ? subprocess.spawnTerminal : null
  const terminalDescriptor = Object.getOwnPropertyDescriptor(subprocess, 'spawnTerminal')
  let active = true
  let disposeToolsChange

  /** One wrappable definition per object, so a preset-scoped tool and a global
   *  tool of the same name never clobber each other's restore state. */
  const wrappedByTool = new Map()

  /** Wrap the exact definition object that some scope resolves. `scope` is the
   *  agent (or undefined for the global view): standard tool plugins register
   *  inside an isolated preset scope, so `tools.get(name)` — the GLOBAL view —
   *  usually returns nothing while the agent still sees the tool. */
  const wrapSearchTool = (name, scope) => {
    if (!active || !SEARCH_NAMES.has(name)) return false
    let tool
    try { tool = scope === undefined ? tools.get(name) : tools.get(name, scope) } catch { return false }
    if (!tool || typeof tool.execute !== 'function') return false
    const existing = wrappedByTool.get(tool)
    if (existing && tool.execute === existing.wrapped) return true
    // An externally replaced execute is no longer ours: drop the stale entry
    // rather than restoring a wrapper somebody else already overwrote.
    if (existing) {
      if (tool.execute === existing.original) tool.execute = existing.original
      wrappedByTool.delete(tool)
    }
    const original = tool.execute
    const wrapped = function executeWithRemoteSearchContext(args, exec) {
      return searchContext.run({ toolName: name, args, exec }, () => original.call(this, args, exec))
    }
    try { tool.execute = wrapped } catch { return false }
    if (tool.execute !== wrapped) return false
    wrappedByTool.set(tool, { original, wrapped })
    return true
  }
  const wrapSearchTools = (scope) => {
    wrapSearchTool('glob', scope)
    wrapSearchTool('grep', scope)
  }

  const wrappedSpawn = function transparentSearchSpawn(spec) {
    if (!active) {
      const binding = resolveBindingForCwd(spec?.cwd)
      if (binding?.bound || binding?.invalid) throw new Error(`${SEARCH_ERROR}: remote subprocess bridge is inactive`)
      return originalSpawn.call(this, spec)
    }
    const store = searchContext.getStore()
    const binding = store ? resolveBinding(store.exec) : resolveBindingForCwd(spec?.cwd)
    if (!binding?.bound) {
      if (binding?.invalid) throw new Error(`${SEARCH_ERROR}: remote cwd has no valid workspace binding`)
      return originalSpawn.call(this, spec)
    }
    if (!store || !SEARCH_NAMES.has(store.toolName)) {
      throw new Error(`${SEARCH_ERROR}: subprocess from a remote workspace is disabled outside native glob/grep`)
    }
    return makeRemoteHandle(spec, store, binding, { getHelper })
  }
  const wrappedSpawnTerminal = originalSpawnTerminal && function transparentSearchTerminal(spec) {
    if (!active) {
      const binding = resolveBindingForCwd(spec?.cwd)
      if (binding?.bound || binding?.invalid) throw new Error(`${SEARCH_ERROR}: local PTY execution is disabled for a remote workspace`)
      return originalSpawnTerminal.call(this, spec)
    }
    const store = searchContext.getStore()
    const binding = store ? resolveBinding(store.exec) : resolveBindingForCwd(spec?.cwd)
    if (binding?.bound || binding?.invalid) {
      throw new Error(`${SEARCH_ERROR}: local PTY execution is disabled for a remote workspace`)
    }
    return originalSpawnTerminal.call(this, spec)
  }

  try {
    subprocess.spawn = wrappedSpawn
    if (Object.getOwnPropertyDescriptor(subprocess, 'spawn')?.value !== wrappedSpawn) throw new Error('cannot install remote subprocess bridge')
    if (originalSpawnTerminal) {
      subprocess.spawnTerminal = wrappedSpawnTerminal
      if (Object.getOwnPropertyDescriptor(subprocess, 'spawnTerminal')?.value !== wrappedSpawnTerminal) throw new Error('cannot guard local terminal execution')
    }
  } catch {
    active = false
    try {
      if (spawnDescriptor) Object.defineProperty(subprocess, 'spawn', spawnDescriptor)
      else delete subprocess.spawn
      if (originalSpawnTerminal) {
        if (terminalDescriptor) Object.defineProperty(subprocess, 'spawnTerminal', terminalDescriptor)
        else delete subprocess.spawnTerminal
      }
    } catch { /* leave the provider untouched if its surface is immutable */ }
    return null
  }

  wrapSearchTools()
  // Only the global view is reachable here. Per-scope definitions (preset
  // scopes included) are wrapped lazily by isSearchToolWrapped once a caller
  // hands us the exact object its scope resolves.
  disposeToolsChange = onToolsChange?.(() => wrapSearchTools())

  const isSearchToolWrapped = (name, visibleTool, scope) => {
    if (!active || !SEARCH_NAMES.has(name) || !visibleTool || typeof visibleTool.execute !== 'function') return false
    // `visibleTool` is the definition the caller's scope resolves (for an agent
    // that is the preset-scoped one). Wrap THAT object: comparing it against the
    // global `tools.get(name)` is what used to fail for every real preset host.
    if (!wrapSearchTool(name, scope)) return false
    const entry = wrappedByTool.get(visibleTool)
    return entry !== undefined && visibleTool.execute === entry.wrapped
  }
  const dispose = () => {
    if (!active) return
    active = false
    try { disposeToolsChange?.() } catch { /* best effort during plugin unload */ }
    for (const [tool, entry] of wrappedByTool) {
      if (tool.execute === entry.wrapped) tool.execute = entry.original
    }
    wrappedByTool.clear()
    try {
      if (subprocess.spawn === wrappedSpawn || Object.getOwnPropertyDescriptor(subprocess, 'spawn')?.value === wrappedSpawn) {
        if (spawnDescriptor) Object.defineProperty(subprocess, 'spawn', spawnDescriptor)
        else delete subprocess.spawn
      }
      if (originalSpawnTerminal && (subprocess.spawnTerminal === wrappedSpawnTerminal || Object.getOwnPropertyDescriptor(subprocess, 'spawnTerminal')?.value === wrappedSpawnTerminal)) {
        if (terminalDescriptor) Object.defineProperty(subprocess, 'spawnTerminal', terminalDescriptor)
        else delete subprocess.spawnTerminal
      }
    } catch { /* do not overwrite a newer provider wrapper */ }
  }

  return { dispose, isSearchToolWrapped }
}
