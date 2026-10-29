import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { executeRemoteBash } from '../lib/remote-bash.js'

function fixture(t, options = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bash-client-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const mirrorDir = path.join(temp, 'mirror')
  mkdirSync(path.join(mirrorDir, 'src'), { recursive: true })
  const binding = { ws: '/srv/project', mirrorDir }
  const requests = []
  const helper = {
    root: '/srv/project',
    rpc: {
      request(op, payload, requestOptions) {
        requests.push({ op, payload, requestOptions })
        if (options.request) return options.request(op, payload, requestOptions)
        return Promise.resolve({
          taskId: payload.taskId,
          cwd: '/srv/project/src',
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 2000,
          stdout: { text: 'ok\n', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        })
      },
    },
  }
  const controller = options.controller || new AbortController()
  const exec = { signal: controller.signal }
  const policy = { mode: 'workspace-write', workspaceRoot: mirrorDir }
  const prepared = {
    policy,
    spec: {
      command: 'pwd',
      workdir: path.join(mirrorDir, 'src'),
      timeoutMs: 2000,
      onExpiry: 'kill',
      stdoutMaxBytes: 600000,
      signal: controller.signal,
      env: { PATH: '/local/bin', TERM: 'xterm-256color', TMPDIR: '/local/tmp', API_TOKEN: 'secret' },
      dshEnv: { NO_COLOR: '1', AWS_SECRET_ACCESS_KEY: 'secret' },
      sandboxPolicy: policy,
    },
  }
  return { binding, controller, exec, helper, mirrorDir, prepared, requests }
}

test('maps resolved Bash cwd and policy root, forwards safe env only, preserves DSH result', async (t) => {
  const state = fixture(t)
  const result = await executeRemoteBash({
    args: { command: 'pwd' },
    exec: state.exec,
    binding: state.binding,
    helper: state.helper,
    prepared: state.prepared,
    graceMs: 3000,
    stderrMaxBytes: 64000,
  })

  const request = state.requests.find(({ op }) => op === 'bash_exec')
  assert.ok(request)
  assert.equal(request.payload.cwd, '/srv/project/src')
  assert.equal(request.payload.workspaceRoot, '/srv/project')
  assert.equal(request.payload.mode, 'workspace-write')
  assert.equal(request.payload.stdoutMaxBytes, 256 * 1024)
  assert.equal(request.payload.stderrMaxBytes, 64000)
  assert.equal(request.payload.env.TERM, 'xterm-256color')
  assert.equal(request.payload.dshEnv.NO_COLOR, '1')
  assert.equal(request.payload.env.API_TOKEN, undefined)
  assert.equal(request.payload.dshEnv.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(request.payload.env.PATH, undefined)
  assert.equal(request.payload.env.TMPDIR, undefined)
  assert.equal(result.kind, 'foreground')
  assert.equal(result.cwd, '/srv/project/src')
  assert.deepEqual(result.stdout, { text: 'ok\n', truncated: false })
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'full' })
})

test('remote Bash rejects per-call sandbox escalation before helper dispatch', async (t) => {
  const state = fixture(t)
  await assert.rejects(executeRemoteBash({
    args: { command: 'id', sandbox_permissions: 'danger-full-access', justification: 'test' },
    exec: state.exec,
    binding: state.binding,
    helper: state.helper,
    prepared: state.prepared,
  }), /does not accept per-call sandbox escalation/)
  assert.equal(state.requests.length, 0)
})


test('remote Bash rejects workdirs and policy roots outside the mirror before RPC', async (t) => {
  const state = fixture(t)
  state.prepared.spec.workdir = path.dirname(state.mirrorDir)
  await assert.rejects(executeRemoteBash({
    args: { command: 'pwd' }, exec: state.exec, binding: state.binding,
    helper: state.helper, prepared: state.prepared,
  }), /outside the remote workspace/)
  assert.equal(state.requests.length, 0)

  state.prepared.spec.workdir = path.join(state.mirrorDir, 'src')
  state.prepared.spec.sandboxPolicy.workspaceRoot = path.dirname(state.mirrorDir)
  await assert.rejects(executeRemoteBash({
    args: { command: 'pwd' }, exec: state.exec, binding: state.binding,
    helper: state.helper, prepared: state.prepared,
  }), /outside the remote workspace/)
  assert.equal(state.requests.length, 0)
})

test('danger-full-access forwards a remote-native cwd outside the mirror', async (t) => {
  const state = fixture(t, {
    request(op, payload) {
      if (op !== 'bash_exec') return Promise.resolve({ accepted: true })
      return Promise.resolve({
        taskId: payload.taskId,
        cwd: payload.cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 2000,
        stdout: { text: 'ok\n', truncated: false },
        stderr: { text: '', truncated: false },
        sandbox: { mode: 'danger-full-access', denied: false, enforcement: 'none' },
      })
    },
  })
  state.prepared.policy.mode = 'danger-full-access'
  state.prepared.spec.sandboxPolicy.mode = 'danger-full-access'
  state.prepared.policy.workspaceRoot = undefined
  state.prepared.spec.workdir = '/var/log'

  const result = await executeRemoteBash({
    args: { command: 'pwd' }, exec: state.exec, binding: state.binding,
    helper: state.helper, prepared: state.prepared,
  })

  const request = state.requests.find(({ op }) => op === 'bash_exec')
  assert.equal(request.payload.mode, 'danger-full-access')
  assert.equal(request.payload.cwd, '/var/log')
  assert.equal(request.payload.workspaceRoot, undefined)
  assert.equal(result.cwd, '/var/log')
})

test('danger-full-access still requires an absolute POSIX cwd', async (t) => {
  const state = fixture(t)
  state.prepared.policy.mode = 'danger-full-access'
  state.prepared.spec.sandboxPolicy.mode = 'danger-full-access'
  state.prepared.spec.workdir = 'relative/dir'
  await assert.rejects(executeRemoteBash({
    args: { command: 'pwd' }, exec: state.exec, binding: state.binding,
    helper: state.helper, prepared: state.prepared,
  }), /must be an absolute POSIX path under danger-full-access/)
  assert.equal(state.requests.length, 0)
})

test('caller abort cancels only the matching remote Bash task', async (t) => {
  const controller = new AbortController()
  let releaseExec
  const state = fixture(t, {
    controller,
    request(op, payload) {
      if (op === 'bash_exec') {
        return new Promise((resolve) => { releaseExec = () => resolve({
          taskId: payload.taskId,
          cwd: '/srv/project/src',
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: false,
          aborted: true,
          timeoutMs: 2000,
          stdout: { text: 'partial', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' },
        }) })
      }
      return Promise.resolve({ accepted: true })
    },
  })

  const pending = executeRemoteBash({
    args: { command: 'long-command' }, exec: state.exec, binding: state.binding,
    helper: state.helper, prepared: state.prepared, graceMs: 100,
  })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(releaseExec)
  const bashRequest = state.requests.find(({ op }) => op === 'bash_exec')
  const cancelRequest = state.requests.find(({ op }) => op === 'bash_cancel')
  assert.ok(bashRequest)
  assert.equal(cancelRequest.payload.taskId, bashRequest.payload.taskId)
  releaseExec()
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'TOOL_ABORTED')
})
