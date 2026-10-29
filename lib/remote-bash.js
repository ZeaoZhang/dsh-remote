import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mapLocalPathToRemote } from './transparent-tools.js'

function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  error.code = 'TOOL_ABORTED'
  return error
}

function safeDshEnvironment(source) {
  const env = {}
  if (!source || typeof source !== 'object' || Array.isArray(source)) return env
  const allowed = /^(?:LANG|LC_[A-Z0-9_]+|TERM|NO_COLOR|PAGER|GIT_PAGER)$/
  for (const [key, value] of Object.entries(source)) {
    if (allowed.test(key) && typeof value === 'string' && value.length <= 8192 && !value.includes('\0')) env[key] = value
  }
  return env
}

function streamResult(value, name) {
  if (!value || typeof value.text !== 'string' || typeof value.truncated !== 'boolean') {
    throw new Error(`remote Bash returned an invalid ${name} stream`)
  }
  return { text: value.text, truncated: value.truncated }
}

// danger-full-access paths stay remote-native: the local mirror mapping is
// meaningless for a host-wide grant, so only the POSIX shape is enforced here
// and the helper re-validates existence and directory type remotely.
function remoteAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`remote Bash ${label} must be an absolute POSIX path under danger-full-access`)
  }
  return path.posix.resolve(value)
}

// Single source of truth for turning the locally resolved DSH workdir into the
// remote cwd. Confined modes map through the mirror; danger-full-access keeps
// a remote-native absolute path. Shared so the instruction-refresh hooks and
// the executor can never disagree about where the command runs.
export function remoteBashCwd(binding, workdir, mode) {
  if (typeof workdir !== 'string') throw new Error('transparent Bash has no resolved working directory')
  return mode === 'danger-full-access'
    ? remoteAbsolutePath(workdir, 'cwd')
    : mapLocalPathToRemote(binding, workdir)
}

export async function executeRemoteBash({ args, exec, binding, helper, prepared, graceMs, stderrMaxBytes }) {
  if (!prepared || typeof prepared !== 'object' || !prepared.spec) {
    throw new Error('transparent remote Bash could not resolve the DSH shell spec')
  }
  const spec = prepared.spec
  const policy = prepared.policy || spec.sandboxPolicy
  if (args.sandbox_permissions !== undefined || String(args.justification || '').trim()) {
    throw new Error('transparent remote Bash does not accept per-call sandbox escalation')
  }
  if (!policy || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) {
    throw new Error('transparent remote Bash requires a resolved DSH sandbox policy; refusing unconfined execution')
  }
  if (args.run_in_background === true || spec.onExpiry !== 'kill') {
    throw new Error('transparent remote Bash currently supports foreground commands only')
  }
  if (typeof spec.command !== 'string' || !spec.command.trim()) throw new Error('invalid command: expected a non-empty string')
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > 600000) {
    throw new Error('transparent remote Bash received an invalid resolved timeout')
  }
  if (!Number.isInteger(spec.stdoutMaxBytes) || spec.stdoutMaxBytes < 1) {
    throw new Error('transparent remote Bash could not resolve the DSH stdout cap')
  }

  const unconfined = policy.mode === 'danger-full-access'
  const remoteCwd = remoteBashCwd(binding, spec.workdir, policy.mode)
  // danger-full-access grants the whole remote host: the policy root is not
  // confined to the mirror (or may be absent), so it must not be mapped into
  // the workspace. The helper validates an absolute POSIX path only.
  const remoteWorkspaceRoot = unconfined
    ? (typeof policy.workspaceRoot === 'string' ? remoteAbsolutePath(policy.workspaceRoot, 'sandbox workspace root') : undefined)
    : mapLocalPathToRemote(binding, policy.workspaceRoot)
  const taskId = randomUUID()
  const signal = spec.signal || exec?.signal
  if (signal?.aborted) throw abortError()

  const helperGraceMs = Number.isInteger(graceMs) && graceMs >= 0 ? Math.min(graceMs, 10000) : 3000
  const stdoutMaxBytes = Math.min(spec.stdoutMaxBytes, 256 * 1024)
  const stderrLimit = Number.isInteger(stderrMaxBytes) && stderrMaxBytes > 0 ? stderrMaxBytes : 64 * 1024
  const stderrCap = Math.min(stderrLimit, 256 * 1024)
  const payload = {
    taskId,
    command: spec.command,
    cwd: remoteCwd,
    workspaceRoot: remoteWorkspaceRoot,
    mode: policy.mode,
    timeoutMs: spec.timeoutMs,
    graceMs: helperGraceMs,
    stdoutMaxBytes,
    stderrMaxBytes: stderrCap,
    env: safeDshEnvironment(spec.env),
    dshEnv: safeDshEnvironment(spec.dshEnv),
    ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
  }

  let cancelPromise
  const cancel = () => {
    if (cancelPromise) return cancelPromise
    cancelPromise = helper.rpc.request('bash_cancel', {
      taskId,
      reason: 'aborted',
    }, { timeoutMs: helperGraceMs + 5000 }).catch(() => null)
    return cancelPromise
  }
  const requestPromise = helper.rpc.request('bash_exec', payload, {
    timeoutMs: spec.timeoutMs + helperGraceMs + 10000,
  })
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  let result
  try {
    result = await requestPromise
    if (cancelPromise) await cancelPromise
    if (signal?.aborted || result?.aborted === true) throw abortError()
  } catch (error) {
    if (signal?.aborted) throw abortError()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }

  const returnedCwd = typeof result?.cwd === 'string' ? path.posix.resolve(result.cwd) : ''
  const cwdRelative = returnedCwd && path.posix.relative(binding.ws, returnedCwd)
  const escapedRoot = !unconfined
    && cwdRelative !== ''
    && (cwdRelative === '..' || cwdRelative.startsWith('../') || path.posix.isAbsolute(cwdRelative))
  const cwdOutsideRoot = !returnedCwd || !path.posix.isAbsolute(result.cwd) || escapedRoot
  if (!result || typeof result !== 'object' || cwdOutsideRoot
    || (result.exitCode !== null && !Number.isInteger(result.exitCode))
    || (result.signal !== null && typeof result.signal !== 'string')
    || typeof result.timedOut !== 'boolean' || typeof result.aborted !== 'boolean'
    || !Number.isFinite(result.timeoutMs) || !result.sandbox || result.sandbox.mode !== policy.mode) {
    throw new Error('remote Bash returned an invalid execution result')
  }

  return {
    kind: 'foreground',
    cwd: result.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: streamResult(result.stdout, 'stdout'),
    stderr: streamResult(result.stderr, 'stderr'),
    sandbox: result.sandbox,
  }
}
